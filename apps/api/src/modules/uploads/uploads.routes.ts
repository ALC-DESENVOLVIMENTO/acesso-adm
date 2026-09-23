import { Prisma, UploadStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { requireAuth, requireModuleAccess } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";
import {
  buildStorageObjectUrl,
  assertPaymentMirrorStorageKey,
  createStorageKey,
  getStorageDiagnostics,
  deleteObject,
  uploadObject
} from "../../lib/storage.js";
import {
  deriveRegistrySearchFromFileName,
  digitsOnly,
  ensureMotoristaFromRegistryMatch,
  normalizeText,
  resolveDriverRegistryByIdentity
} from "../../lib/driver-registry.js";
import { upsertDriverPdfReceivedFromUpload } from "../../lib/driver-pdf-received.js";
import { notifyPdfOnline } from "../../lib/pdfonline-bridge.js";
import { DocumentTypeCode, type DocumentTypeCode as DocumentTypeCodeValue } from "../../lib/document-types.js";
import { extractPaymentMirrorMetadata, type PaymentMirrorPeriodRange } from "../../lib/payment-mirror-pdf.js";
import { extractTotalGeralValueFromSource } from "../../lib/financeiro-total-backfill.js";

const router = Router();
const MAX_UPLOAD_FILES_PER_REQUEST = 100;
const STORAGE_UPLOAD_CONCURRENCY = 5;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: MAX_UPLOAD_FILES_PER_REQUEST
  },
  fileFilter: (_req, file, callback) => {
    const isPdf =
      file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf");
    callback(null, isPdf);
  }
});

router.use(requireAuth, requireModuleAccess("pdfs"));

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

function canSeeAllUploads(auth: NonNullable<Express.Request["auth"]>) {
  return auth.level === "N3" || auth.level === "N4";
}

function uploadOwnerScope(auth: NonNullable<Express.Request["auth"]>) {
  return canSeeAllUploads(auth) ? {} : { usuarioId: auth.userId };
}

function isPaymentMirrorUpload(upload: { documentType?: DocumentTypeCodeValue | string | null; status: UploadStatus | string }) {
  if (upload.documentType === DocumentTypeCode.nota_fiscal) {
    return false;
  }

  return upload.status !== UploadStatus.removido && upload.status !== UploadStatus.substituido;
}

function resolvePaymentMirrorUrl(upload: { caminhoArquivo: string | null | undefined }) {
  try {
    return buildStorageObjectUrl(assertPaymentMirrorStorageKey(upload.caminhoArquivo));
  } catch {
    return null;
  }
}

type UploadHistoryItem = Awaited<ReturnType<typeof prisma.uploadPdf.findMany>>[number] & {
  usuario: {
    nome: string;
  };
  periodoPagamento: {
    nome: string;
  } | null;
  basePagamento: {
    nome: string;
  } | null;
};

function serializeUpload(upload: UploadHistoryItem) {
  const storageUrl = resolvePaymentMirrorUrl(upload);
  const pendingReason = upload.motivoPendencia || (upload.motoristaId ? null : "pre_cadastro_nao_encontrado");

  return {
    id: upload.id,
    fileName: upload.nomeOriginal,
    storageFileName: upload.nomeArquivo,
    status: upload.status,
    sentAt: upload.criadoEm,
    version: upload.versao,
    owner: upload.usuario.nome,
    periodId: upload.periodoPagamentoId,
    periodName: upload.periodoPagamento?.nome || null,
    baseId: upload.basePagamentoId,
    baseName: upload.basePagamento?.nome || null,
    motoristaId: upload.motoristaId,
    motoristaName: upload.motoristaNomeExtraido,
    pendingReason,
    replacedUploadId: upload.substituiUploadId,
    downloadUrl: storageUrl
  };
}

async function getUploadHistory(uploadId: string, auth: NonNullable<Express.Request["auth"]>) {
  const uploads = await prisma.uploadPdf.findMany({
    where: {
      ...uploadOwnerScope(auth),
      status: {
        not: UploadStatus.removido
      }
    },
    include: {
      usuario: {
        select: {
          nome: true
        }
      },
      periodoPagamento: {
        select: {
          nome: true
        }
      },
      basePagamento: {
        select: {
          nome: true
        }
      }
    },
    orderBy: {
      criadoEm: "asc"
    }
  });

  const paymentUploads = uploads.filter((item) => item.documentType !== DocumentTypeCode.nota_fiscal);
  const target = paymentUploads.find((item) => item.id === uploadId);

  if (!target) {
    return null;
  }

  const byId = new Map(paymentUploads.map((item) => [item.id, item]));
  let cursor: UploadHistoryItem | undefined = target;
  let rootId = target.id;

  while (cursor?.substituiUploadId) {
    const parent = byId.get(cursor.substituiUploadId);

    if (!parent) {
      break;
    }

    rootId = parent.id;
    cursor = parent;
  }

  return paymentUploads
    .filter((item) => {
      let current: UploadHistoryItem | undefined = item;

      while (current) {
        if (current.id === rootId) {
          return true;
        }

        current = current.substituiUploadId ? byId.get(current.substituiUploadId) : undefined;
      }

      return false;
    })
    .sort((a, b) => a.versao - b.versao)
    .map(serializeUpload);
}

function normalizeFileIdentityOptions(body: Record<string, unknown>, fileName: string) {
  const rawName = String(body?.motoristaNome || "").trim();
  const rawCpf = String(body?.motoristaCpf || "").trim();
  const rawCnpj = String(body?.motoristaCnpj || "").trim();

  return {
    fileName,
    name: rawName || undefined,
    cpf: rawCpf || undefined,
    cnpj: rawCnpj || undefined
  };
}

function normalizeIdentityNameForBase(value: string | null | undefined, selectedBaseName: string) {
  const normalizedName = normalizeText(value || "");
  const normalizedBase = normalizeText(selectedBaseName);

  if (!normalizedName || !normalizedBase) {
    return normalizedName;
  }

  const baseSuffix = ` ${normalizedBase}`;
  return normalizedName.endsWith(baseSuffix)
    ? normalizedName.slice(0, -baseSuffix.length).trim()
    : normalizedName;
}

function describeUploadPendingReason(reason?: string) {
  switch (reason) {
    case "pre_cadastro_nao_encontrado":
      return "Arquivo armazenado, mas o motorista não foi localizado como aprovado no ARCHI.";
    case "pre_cadastro_ambiguo":
      return "Arquivo armazenado, mas há mais de um cadastro compatível; confira nome, CNPJ e base.";
    case "pre_cadastro_cnpj_divergente":
      return "Arquivo armazenado, mas o CNPJ do espelho diverge do cadastro no ARCHI.";
    case "pre_cadastro_cpf_confirmacao_divergente":
      return "Arquivo armazenado, mas o CPF informado não confirmou o cadastro localizado.";
    case "pre_cadastro_incompleto":
      return "Arquivo armazenado, mas faltam dados para criar ou localizar o vínculo interno do motorista.";
    case "pre_cadastro_inconsistente":
      return "Arquivo armazenado, mas nome ou base diverge do cadastro no ARCHI.";
    default:
      return "Arquivo armazenado na fila, aguardando conferência do vínculo com o motorista.";
  }
}

async function resolveUploadMotorista(file: Express.Multer.File, selectedBaseName: string, body: Record<string, unknown>) {
  const providedIdentity = normalizeFileIdentityOptions(body, file.originalname);
  const pdfMetadata = await extractPaymentMirrorMetadata(file.buffer);
  const pdfIdentity = pdfMetadata.identity;
  const fallbackName = deriveRegistrySearchFromFileName(file.originalname).name || file.originalname;
  const identity = {
    ...providedIdentity,
    name: pdfIdentity?.name || providedIdentity.name,
    cnpj: pdfIdentity?.cnpj || providedIdentity.cnpj
  };
  const resolved = await resolveDriverRegistryByIdentity({
    ...identity,
    uploadIdentity: true,
    base: selectedBaseName
  });

  if (!resolved) {
    return {
      pending: true,
      motoristaNome: identity.name || fallbackName,
      motoristaCpf: identity.cpf || "",
      motoristaCnpj: identity.cnpj || null,
      baseName: selectedBaseName,
      pendingReason: "pre_cadastro_nao_encontrado",
      mirrorPeriodRange: pdfMetadata.periodRange
    } as const;
  }

  let match = "ambiguous" in resolved ? null : resolved;

  if (!match && "ambiguous" in resolved) {
    const normalizedBase = normalizeText(selectedBaseName);
    const baseMatches = resolved.matches.filter((item) => normalizeText(item.base || "") === normalizedBase);

    if (baseMatches.length === 1) {
      match = baseMatches[0];
    } else if (baseMatches.length > 1) {
      match =
        baseMatches.find((item) => item.cnpj && identity.cnpj && item.cnpj.replace(/\D/g, "") === identity.cnpj.replace(/\D/g, "")) ||
        null;
    }

    if (!match) {
      return {
        pending: true,
        motoristaNome: identity.name || fallbackName,
        motoristaCpf: identity.cpf || "",
        motoristaCnpj: identity.cnpj || null,
        baseName: selectedBaseName,
        pendingReason: "pre_cadastro_ambiguo",
        mirrorPeriodRange: pdfMetadata.periodRange
      } as const;
    }
  }

  if (!match) {
    return {
      error: `Não foi possível resolver o motorista do arquivo ${file.originalname}.`
    } as const;
  }

  if (match.base && normalizeText(match.base) !== normalizeText(selectedBaseName)) {
    return {
      pending: true,
      motoristaNome: identity.name || fallbackName,
      motoristaCpf: identity.cpf || "",
      motoristaCnpj: identity.cnpj || null,
      baseName: selectedBaseName,
      pendingReason: "pre_cadastro_inconsistente",
      mirrorPeriodRange: pdfMetadata.periodRange
    } as const;
  }

  const expectedCnpj = digitsOnly(identity.cnpj || "");
  const archiCnpj = digitsOnly(match.cnpj || "");
  if (expectedCnpj && archiCnpj && expectedCnpj !== archiCnpj) {
    return {
      pending: true,
      motoristaNome: identity.name || fallbackName,
      motoristaCpf: identity.cpf || "",
      motoristaCnpj: identity.cnpj || null,
      baseName: selectedBaseName,
      pendingReason: "pre_cadastro_cnpj_divergente",
      mirrorPeriodRange: pdfMetadata.periodRange
    } as const;
  }

  // CPF is only a final cross-check when the upload explicitly provides it.
  // Its absence never prevents an otherwise valid name/CNPJ/base match.
  const providedCpf = digitsOnly(identity.cpf || "");
  const archiCpf = digitsOnly(match.cpfDigits || match.cpf || "");
  if (providedCpf && archiCpf && providedCpf !== archiCpf) {
    return {
      pending: true,
      motoristaNome: identity.name || fallbackName,
      motoristaCpf: identity.cpf || "",
      motoristaCnpj: identity.cnpj || null,
      baseName: selectedBaseName,
      pendingReason: "pre_cadastro_cpf_confirmacao_divergente",
      mirrorPeriodRange: pdfMetadata.periodRange
    } as const;
  }

  // A payment mirror may be named after the beneficiary rather than the
  // driver. Accept that only when ARCHI explicitly confirms the beneficiary;
  // never attach a file merely because another record happened to match its CNPJ.
  const cnpjMatches = Boolean(
    identity.cnpj &&
    match.cnpj &&
    digitsOnly(identity.cnpj) === digitsOnly(match.cnpj)
  );
  // DDS has one known collision format where it appends the selected base to
  // Rogério da Silva's name. Strip that suffix only after the exact base and
  // CNPJ have already identified the same ARCHI record. Name-only uploads
  // remain strict and never receive this normalization.
  const identityName = cnpjMatches
    ? normalizeIdentityNameForBase(identity.name, selectedBaseName)
    : normalizeText(identity.name || "");
  const driverName = normalizeText(match.nome || "");
  const beneficiaryName = normalizeText(match.nomeFavorecido || "");
  if (identityName && identityName !== driverName && identityName !== beneficiaryName) {
    return {
      pending: true,
      motoristaNome: identity.name || fallbackName,
      motoristaCpf: identity.cpf || "",
      motoristaCnpj: identity.cnpj || null,
      baseName: selectedBaseName,
      pendingReason: "pre_cadastro_inconsistente",
      mirrorPeriodRange: pdfMetadata.periodRange
    } as const;
  }

  const motoristaId = await ensureMotoristaFromRegistryMatch(match);

  if (!motoristaId) {
    return {
      pending: true,
      motoristaNome: match.nome,
      motoristaCpf: match.cpfDigits || match.cpf || "",
      motoristaCnpj: match.cnpj || null,
      baseName: match.base || selectedBaseName,
      pendingReason: "pre_cadastro_incompleto",
      mirrorPeriodRange: pdfMetadata.periodRange
    } as const;
  }

  return {
    motoristaId,
    motoristaNome: match.nome,
    motoristaCpf: match.cpfDigits || match.cpf,
    // Keep the CNPJ extracted from the mirror as the persisted document
    // identity. ARCHI is used to validate it, while its beneficiary CNPJ is
    // the authoritative value shown by Financeiro. Persisting only
    // `match.cnpj` allowed an older registry value to overwrite a correct PDF
    // value and later raised a false divergence warning.
    motoristaCnpj: identity.cnpj || match.cnpj || null,
    baseName: match.base || selectedBaseName,
    mirrorPeriodRange: pdfMetadata.periodRange
  } as const;
}

function dateKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

function mirrorMatchesPeriod(range: PaymentMirrorPeriodRange | null | undefined, start: Date, end: Date) {
  return !range || (range.startDate === dateKey(start) && range.endDate === dateKey(end));
}

function mirrorDuplicateKey(input: {
  periodId: string;
  basePaymentId: string;
  motoristaId?: string | null;
  fileName: string;
}) {
  const identity = input.motoristaId || normalizeText(input.fileName);
  return `${input.periodId}|${input.basePaymentId}|${identity}`;
}

async function publishApprovedUpload(input: {
  uploadPdfId: string;
  motoristaId: string;
  periodId: string;
  basePaymentId: string;
  fileName: string;
  storageKey: string;
  createdByUserId?: string | null;
  version?: number;
}) {
  await upsertDriverPdfReceivedFromUpload({
    uploadPdfId: input.uploadPdfId,
    motoristaId: input.motoristaId,
    periodId: input.periodId,
    basePaymentId: input.basePaymentId,
    fileName: input.fileName,
    storageKey: input.storageKey,
    createdByUserId: input.createdByUserId ?? null
  });

  await notifyPdfOnline(
    "portal.upload.created",
    {
      id: input.uploadPdfId,
      uploadId: input.uploadPdfId,
      uploadPdfId: input.uploadPdfId,
      periodId: input.periodId,
      periodoPagamentoId: input.periodId,
      basePaymentId: input.basePaymentId,
      basePagamentoId: input.basePaymentId,
      motoristaId: input.motoristaId,
      nomeArquivo: input.fileName,
      nomeOriginal: input.fileName,
      caminhoArquivo: input.storageKey,
      storageKey: input.storageKey,
      status: "processado",
      tipoArquivo: "application/pdf",
      versao: input.version || 1
    },
    {
      userId: input.createdByUserId || undefined,
      periodId: input.periodId,
      basePaymentId: input.basePaymentId
    }
  ).catch((error) => {
    console.warn(
      "PDF Online bridge upload-created failed:",
      error instanceof Error ? error.message : error
    );
  });
}

export async function reconcilePendingUploadsFromRegistry() {
  const pendingUploads = await prisma.uploadPdf.findMany({
    where: {
      status: {
        in: [UploadStatus.pendente, UploadStatus.processado]
      },
      documentType: {
        not: DocumentTypeCode.nota_fiscal
      },
      periodoPagamentoId: {
        not: null
      },
      basePagamentoId: {
        not: null
      },
      OR: [
        { motoristaId: null },
        { status: UploadStatus.pendente }
      ]
    },
    select: {
      id: true,
      nomeOriginal: true,
      caminhoArquivo: true,
      motoristaNomeExtraido: true,
      motoristaCnpjExtraido: true,
      periodoPagamentoId: true,
      basePagamentoId: true,
      status: true,
      motoristaId: true,
      periodoPagamento: {
        select: {
          status: true
        }
      },
      basePagamento: {
        select: {
          nome: true
        }
      }
    },
    orderBy: {
      criadoEm: "asc"
    },
    take: 100
  });

  for (const upload of pendingUploads) {
    const resolved = upload.motoristaId
      ? null
      : await resolveDriverRegistryByIdentity({
          fileName: upload.nomeOriginal,
          name: upload.motoristaNomeExtraido || undefined,
          cnpj: upload.motoristaCnpjExtraido || undefined,
          uploadIdentity: true,
          base: upload.basePagamento?.nome || undefined
        });

    if (!upload.motoristaId && (!resolved || "ambiguous" in resolved)) {
      continue;
    }

    const selectedBaseName = upload.basePagamento?.nome || "";
    const resolvedMatch = resolved && !("ambiguous" in resolved) ? resolved : null;
    if (
      !upload.motoristaId &&
      resolvedMatch?.base &&
      normalizeText(resolvedMatch.base) !== normalizeText(selectedBaseName)
    ) {
      await prisma.uploadPdf.updateMany({
        where: { id: upload.id, motoristaId: null },
        data: { motivoPendencia: "pre_cadastro_inconsistente" }
      });
      continue;
    }

    if (
      !upload.motoristaId &&
      upload.motoristaCnpjExtraido &&
      resolvedMatch?.cnpj &&
      digitsOnly(upload.motoristaCnpjExtraido) !== digitsOnly(resolvedMatch.cnpj)
    ) {
      await prisma.uploadPdf.updateMany({
        where: { id: upload.id, motoristaId: null },
        data: { motivoPendencia: "pre_cadastro_cnpj_divergente" }
      });
      continue;
    }

    const cnpjMatches = Boolean(
      upload.motoristaCnpjExtraido &&
      resolvedMatch?.cnpj &&
      digitsOnly(upload.motoristaCnpjExtraido) === digitsOnly(resolvedMatch.cnpj)
    );
    const extractedName = cnpjMatches
      ? normalizeIdentityNameForBase(upload.motoristaNomeExtraido, selectedBaseName)
      : normalizeText(upload.motoristaNomeExtraido || "");

    if (
      !upload.motoristaId &&
      resolvedMatch &&
      extractedName &&
      extractedName !== normalizeText(resolvedMatch.nome || "") &&
      extractedName !== normalizeText(resolvedMatch.nomeFavorecido || "")
    ) {
      await prisma.uploadPdf.updateMany({
        where: { id: upload.id, motoristaId: null },
        data: { motivoPendencia: "pre_cadastro_inconsistente" }
      });
      continue;
    }

    const motoristaId = upload.motoristaId || (
      resolvedMatch
        ? await ensureMotoristaFromRegistryMatch(resolvedMatch)
        : null
    );

    if (!motoristaId) {
      continue;
    }

    const claimed = await prisma.uploadPdf.updateMany({
      where: {
        id: upload.id,
        status: {
          in: [UploadStatus.pendente, UploadStatus.processado]
        }
      },
      data: {
        motoristaId,
        motoristaNomeExtraido: resolvedMatch?.nome || upload.motoristaNomeExtraido,
        motoristaCnpjExtraido: resolvedMatch?.cnpj || upload.motoristaCnpjExtraido,
        status: UploadStatus.processado,
        motivoPendencia: null
      }
    });

    if (claimed.count === 0) {
      continue;
    }

    if (upload.periodoPagamento?.status === "aprovado") {
      await publishApprovedUpload({
        uploadPdfId: upload.id,
        motoristaId,
        periodId: upload.periodoPagamentoId || "",
        basePaymentId: upload.basePagamentoId || "",
        fileName: upload.nomeOriginal,
        storageKey: upload.caminhoArquivo,
        createdByUserId: null
      });
    }
  }
}

router.get("/", (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({
        message: "Sessão inválida."
      });
      return;
    }

    const uploads = await prisma.uploadPdf.findMany({
      where: {
        ...uploadOwnerScope(req.auth),
        status: {
          not: UploadStatus.removido
        }
      },
      include: {
        usuario: true,
        periodoPagamento: {
          select: {
            nome: true
          }
        },
        basePagamento: {
          select: {
            nome: true
          }
        }
      },
      orderBy: {
        criadoEm: "desc"
      }
    });

    const paymentUploads = uploads.filter((item) => item.documentType !== DocumentTypeCode.nota_fiscal);
    res.json(
      paymentUploads
        // Keep replaced versions visible so the operational queue clearly
        // records that the previous mirror was superseded by a new upload.
        .filter((item) => isPaymentMirrorUpload(item))
        .map(serializeUpload)
    );
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao listar uploads.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/:id/history", (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({
        message: "Sessão inválida."
      });
      return;
    }

    const history = await getUploadHistory(String(req.params.id), req.auth);

    if (!history) {
      res.status(404).json({
        message: "Histórico do PDF não encontrado."
      });
      return;
    }

    res.json(history);
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao carregar histórico do PDF.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/", upload.array("files", MAX_UPLOAD_FILES_PER_REQUEST), (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({
        message: "Sessão inválida."
      });
      return;
    }

    const auth = req.auth;

    const files = (req.files as Express.Multer.File[]) || [];
    const periodId = String(req.body?.periodId || "").trim();
    const basePaymentId = String(req.body?.basePaymentId || "").trim();
    const allowNegativeTotal = String(req.body?.allowNegativeTotal || "").toLowerCase() === "true";

    if (files.length === 0) {
      res.status(400).json({
        message: "Selecione ao menos um PDF para upload."
      });
      return;
    }

    if (!periodId || !basePaymentId) {
      res.status(400).json({
        message: "Selecione um período e uma base antes de enviar PDFs."
      });
      return;
    }

    const storageDiagnostics = getStorageDiagnostics();

    if (!storageDiagnostics.configured) {
      res.status(503).json({
        message: "Serviço de armazenamento não configurado.",
        detail: {
          missing: storageDiagnostics.missing,
          bucket: storageDiagnostics.bucket ? "definido" : "não definido",
          region: storageDiagnostics.region,
          endpoint: storageDiagnostics.endpoint
        }
      });
      return;
    }

    const period = await prisma.periodoPagamento.findUnique({
      where: {
        id: periodId
      },
      include: {
        bases: {
          include: {
            basePagamento: true
          }
        }
      }
    });

    if (!period) {
      res.status(404).json({
        message: "Período de pagamento não encontrado."
      });
      return;
    }

    if (period.ativo === false) {
      res.status(400).json({
        message: "Periodo finalizado no Financeiro. Reative a visibilidade para anexar espelhos de pagamento."
      });
      return;
    }

    const selectedBase = period.bases.find((item) => item.basePagamentoId === basePaymentId)?.basePagamento;

    if (!selectedBase) {
      res.status(404).json({
        message: "Base selecionada não encontrada no período."
      });
      return;
    }

    const resolvedFiles = await mapWithConcurrency(
      files,
      STORAGE_UPLOAD_CONCURRENCY,
      async (file) => {
        const resolved = await resolveUploadMotorista(file, selectedBase.nome, req.body as Record<string, unknown>);
        const totalValue = await extractTotalGeralValueFromSource({ content: file.buffer }).catch(() => null);

        return {
          file,
          ...resolved,
          totalValue
        };
      }
    );

    const existingUploads = await prisma.uploadPdf.findMany({
      where: {
        periodoPagamentoId: periodId,
        basePagamentoId: basePaymentId,
        documentType: { not: DocumentTypeCode.nota_fiscal },
        status: { not: UploadStatus.removido }
      },
      select: {
        motoristaId: true,
        nomeOriginal: true
      }
    });
    const existingDuplicateKeys = new Set(
      existingUploads.map((item) => mirrorDuplicateKey({
        periodId,
        basePaymentId,
        motoristaId: item.motoristaId,
        fileName: item.nomeOriginal
      }))
    );
    const requestDuplicateKeys = new Set<string>();
    const duplicateIndexes = new Set<number>();
    const periodMismatchIndexes = new Set<number>();

    const validationErrors = resolvedFiles.reduce<Array<{ fileName: string; message: string; code?: string }>>((errors, item, index) => {
      if ("error" in item) {
        errors.push({
          fileName: item.file.originalname,
          message: item.error || "Falha na validação do PDF."
        });
        return errors;
      }

      if (!mirrorMatchesPeriod(item.mirrorPeriodRange, period.dataInicio, period.dataFim)) {
        periodMismatchIndexes.add(index);
        errors.push({
          fileName: item.file.originalname,
          message: `Espelho bloqueado: o arquivo pertence ao período ${item.mirrorPeriodRange?.startDate} até ${item.mirrorPeriodRange?.endDate}, diferente do período selecionado.`,
          code: "periodo_espelho_divergente"
        });
        return errors;
      }

      const duplicateKey = mirrorDuplicateKey({
        periodId,
        basePaymentId,
        motoristaId: item.motoristaId,
        fileName: item.file.originalname
      });

      if (existingDuplicateKeys.has(duplicateKey) || requestDuplicateKeys.has(duplicateKey)) {
        duplicateIndexes.add(index);
        errors.push({
          fileName: item.file.originalname,
          message: "Espelho de pagamento duplicado: já existe um espelho deste motorista neste período e base. Use Substituir para trocar o arquivo.",
          code: "espelho_duplicado"
        });
        return errors;
      }

      requestDuplicateKeys.add(duplicateKey);

      if (!allowNegativeTotal && item.totalValue !== null && item.totalValue < 0) {
        errors.push({
          fileName: item.file.originalname,
          message: "Espelho de pagamento bloqueado: o Total Geral está negativo.",
          code: "total_geral_negativo"
        });
      }

      return errors;
    }, []);

    const validFiles = resolvedFiles.filter((item, index) =>
      !("error" in item) &&
      !duplicateIndexes.has(index) &&
      !periodMismatchIndexes.has(index) &&
      (allowNegativeTotal || item.totalValue === null || item.totalValue >= 0)
    ) as Array<
      {
        file: Express.Multer.File;
        motoristaId?: string | null;
        motoristaNome: string;
        motoristaCpf: string;
        motoristaCnpj: string | null;
        baseName: string;
        pending?: boolean;
        pendingReason?: string;
        mirrorPeriodRange?: PaymentMirrorPeriodRange | null;
        totalValue: number | null;
      }
    >;

    if (validFiles.length === 0) {
      await prisma.logAuditoria.create({
        data: {
          usuarioId: auth.userId,
          acao: "upload_pdfs_rejeitado",
          entidade: "uploads_pdf",
          entidadeId: periodId,
          detalhes: {
            periodoPagamentoId: periodId,
            basePagamentoId: basePaymentId,
            quantidadeTentada: files.length,
            quantidadeEnviada: 0,
            arquivos: files.map((file) => file.originalname),
            falhas: validationErrors
          }
        }
      });
      res.status(400).json({
        message: validationErrors[0]?.message || "Nenhum PDF valido para upload.",
        uploaded: 0,
        failed: validationErrors
      });
      return;
    }

    const storageFolder = ["uploads", `periodos/${periodId}`, `bases/${basePaymentId}`].join("/");
    const processedFiles = await mapWithConcurrency(
      validFiles,
      STORAGE_UPLOAD_CONCURRENCY,
      async (item) => {
        const { file, motoristaId, motoristaNome, motoristaCpf, motoristaCnpj, baseName, pendingReason } = item;
        const storageKey = assertPaymentMirrorStorageKey(createStorageKey(storageFolder, file.originalname));

        try {
          await uploadObject({
            key: storageKey,
            body: file.buffer,
            contentType: file.mimetype
          });

          // Persist the amount during upload so the summary and "A pagar"
          // use the same source of truth without waiting for a restart.
          const created = await prisma.uploadPdf.create({
            data: {
              id: randomUUID(),
              nomeArquivo: file.originalname,
              nomeOriginal: file.originalname,
              caminhoArquivo: storageKey,
              documentType: DocumentTypeCode.espelho,
              versao: 1,
              status: motoristaId ? UploadStatus.processado : UploadStatus.pendente,
              usuarioId: auth.userId,
              motoristaId: motoristaId || null,
              motoristaNomeExtraido: motoristaNome,
              motoristaCnpjExtraido: motoristaCnpj,
              motivoPendencia: motoristaId ? null : pendingReason || "pre_cadastro_nao_encontrado",
              periodoPagamentoId: periodId,
              basePagamentoId: basePaymentId,
              valorTotalPdf: item.totalValue === null ? undefined : new Prisma.Decimal(item.totalValue)
            },
            select: {
              id: true
            }
          });

          if (period.status === "aprovado" && motoristaId) {
            await publishApprovedUpload({
              uploadPdfId: created.id,
              motoristaId,
              periodId,
              basePaymentId,
              fileName: file.originalname,
              storageKey,
              createdByUserId: auth.userId,
              version: 1
            });
          }

          return {
            ok: true as const,
            id: created.id,
            fileName: file.originalname,
            motoristaNome,
            motoristaCpf,
            baseName,
            baseMismatch: normalizeText(baseName || "") !== normalizeText(selectedBase.nome),
            pendingReason: motoristaId ? null : pendingReason || "pre_cadastro_nao_encontrado"
          };
        } catch (error) {
          return {
            ok: false as const,
            fileName: file.originalname,
            message: error instanceof Error ? error.message : "Falha desconhecida ao processar arquivo."
          };
        }
      }
    );

    const uploadedFiles = processedFiles.filter((item) => item.ok);
    const failedFiles: Array<{ fileName: string; message: string; code?: string }> = [
      ...validationErrors,
      ...processedFiles
        .filter((item) => item.ok === false)
        .map((item) => ({
          fileName: item.fileName,
          message: item.message
        }))
    ];
    const pendingFiles = processedFiles
      .filter((item) => item.ok && item.pendingReason)
      .map((item) => ({
        fileName: item.fileName,
        message: describeUploadPendingReason(item.pendingReason || undefined),
        code: item.pendingReason || undefined
      }));

    await prisma.logAuditoria.create({
      data: {
        usuarioId: auth.userId,
        acao: "upload_pdfs",
        entidade: "uploads_pdf",
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null,
        detalhes: {
          quantidade: files.length,
          enviados: uploadedFiles.length,
          falhas: failedFiles,
          arquivos: files.map((file) => file.originalname),
          periodId,
          basePaymentId
        }
      }
    });

    res.status(failedFiles.length > 0 || pendingFiles.length > 0 ? 207 : 201).json({
      message:
        failedFiles.length > 0 || pendingFiles.length > 0
          ? `${uploadedFiles.length} PDF(s) armazenado(s). ${failedFiles.length + pendingFiles.length} arquivo(s) precisam de revisao.`
          : "Upload concluido com sucesso.",
      uploaded: uploadedFiles.length,
      failed: failedFiles,
      pending: pendingFiles
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao realizar upload dos PDFs.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.delete("/:id", (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({
        message: "Sessão inválida."
      });
      return;
    }

    const auth = req.auth;

    const upload = await prisma.uploadPdf.findUnique({
      where: {
        id: String(req.params.id)
      },
      select: {
        id: true,
        documentType: true,
        status: true,
        caminhoArquivo: true,
        nomeOriginal: true,
        nomeArquivo: true,
        usuarioId: true,
        versao: true,
        substituiUploadId: true,
        periodoPagamentoId: true,
        basePagamentoId: true
      }
    });

    if (!upload) {
      res.json({
        message: "PDF removido ou não estava mais disponível na fila."
      });
      return;
    }

    if (!req.auth || (!canSeeAllUploads(req.auth) && upload.usuarioId !== req.auth.userId)) {
      res.status(404).json({
        message: "Arquivo não encontrado."
      });
      return;
    }

    if (upload.status === UploadStatus.removido) {
      res.json({
        message: "PDF já estava removido da fila."
      });
      return;
    }

    if (!isPaymentMirrorUpload(upload)) {
      res.status(404).json({
        message: "Upload não encontrado."
      });
      return;
    }

    const canDelete =
      auth.level === "N3" ||
      auth.level === "N4" ||
      upload.usuarioId === auth.userId;

    if (!canDelete) {
      res.status(403).json({
        message: "Você não possui permissão para remover este PDF."
      });
      return;
    }

    await prisma.uploadPdf.update({
      where: {
        id: upload.id
      },
      data: {
        status: UploadStatus.removido
      }
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: auth.userId,
        acao: "remover_pdf_logicamente",
        entidade: "uploads_pdf",
        entidadeId: upload.id,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null,
        detalhes: {
          arquivo: upload.nomeOriginal
        }
      }
    });

    res.json({
      message: "PDF removido logicamente com sucesso."
    });

    // O histórico de pagamentos continua apontando para o arquivo depois que
    // ele sai da fila operacional. Não apague o objeto físico nesses casos,
    // pois o motorista ainda precisa conseguir abrir o espelho do fechamento.
    const historicalReference = await prisma.driverPdfReceived.findFirst({
      where: { uploadPdfId: upload.id },
      select: { id: true }
    });

    if (!historicalReference) {
      void deleteObject(upload.caminhoArquivo);
    }
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao remover PDF.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/:id/replace", upload.single("file"), (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({
        message: "Sessão inválida."
      });
      return;
    }

    const auth = req.auth;

    const file = req.file;

    if (!file) {
      res.status(400).json({
        message: "Selecione um PDF para substituicao."
      });
      return;
    }

    const currentUpload = await prisma.uploadPdf.findUnique({
      where: {
        id: String(req.params.id)
      },
      select: {
        id: true,
        documentType: true,
        nomeArquivo: true,
        nomeOriginal: true,
        caminhoArquivo: true,
        versao: true,
        status: true,
        usuarioId: true,
        motoristaId: true,
        motoristaNomeExtraido: true,
        motoristaCnpjExtraido: true,
        periodoPagamentoId: true,
        basePagamentoId: true,
        motorista: {
          select: {
            nome: true
          }
        },
        periodoPagamento: {
          select: {
            dataInicio: true,
            dataFim: true,
            status: true
          }
        },
        basePagamento: {
          select: {
            nome: true
          }
        }
      }
    });

    if (!currentUpload) {
      res.status(404).json({
        message: "Upload não encontrado."
      });
      return;
    }

    if (!isPaymentMirrorUpload(currentUpload)) {
      res.status(404).json({
        message: "Upload não encontrado."
      });
      return;
    }

    const canReplace =
      auth.level === "N3" ||
      auth.level === "N4" ||
      currentUpload.usuarioId === auth.userId;

    if (!canReplace) {
      res.status(403).json({
        message: "Você não possui permissão para substituir este PDF."
      });
      return;
    }

    const replacementMetadata = await extractPaymentMirrorMetadata(file.buffer);
    if (
      currentUpload.periodoPagamento &&
      !mirrorMatchesPeriod(
        replacementMetadata.periodRange,
        currentUpload.periodoPagamento.dataInicio,
        currentUpload.periodoPagamento.dataFim
      )
    ) {
      res.status(422).json({
        message: "Substituição bloqueada: o período impresso no novo espelho é diferente do período do registro atual.",
        code: "periodo_espelho_divergente"
      });
      return;
    }

    const replacementName = normalizeText(replacementMetadata.identity?.name || "");
    const currentName = normalizeText(currentUpload.motorista?.nome || currentUpload.motoristaNomeExtraido || "");
    const replacementCnpj = replacementMetadata.identity?.cnpj.replace(/\D/g, "") || "";
    const currentCnpj = currentUpload.motoristaCnpjExtraido?.replace(/\D/g, "") || "";
    const hasComparableCnpj = Boolean(replacementCnpj && currentCnpj);
    if (
      (hasComparableCnpj && replacementCnpj !== currentCnpj) ||
      (!hasComparableCnpj && replacementName && currentName && replacementName !== currentName)
    ) {
      res.status(422).json({
        message: "Substituição bloqueada: o novo espelho pertence a outro motorista ou favorecido.",
        code: "motorista_espelho_divergente"
      });
      return;
    }

    // Never inherit a possibly stale motoristaId during substitution. Resolve
    // the replacement against the authoritative ARCHI identity first; this
    // prevents a file for one driver from remaining linked to a previous
    // driver's record after a replacement/reprocess.
    const replacementMatch = await resolveDriverRegistryByIdentity({
      name: replacementMetadata.identity?.name || undefined,
      cnpj: replacementCnpj || undefined,
      cpf: String(req.body?.motoristaCpf || "").trim() || undefined,
      uploadIdentity: true,
      base: currentUpload.basePagamento?.nome || undefined
    });
    if (!replacementMatch || "ambiguous" in replacementMatch) {
      res.status(422).json({
        message: "Substituição bloqueada: não foi possível confirmar o motorista no ARCHI.",
        code: "motorista_archi_nao_confirmado"
      });
      return;
    }
    if (replacementMatch.base && currentUpload.basePagamento?.nome &&
      normalizeText(replacementMatch.base) !== normalizeText(currentUpload.basePagamento.nome)) {
      res.status(422).json({
        message: "Substituição bloqueada: a base do motorista diverge da base do período.",
        code: "base_motorista_divergente"
      });
      return;
    }
    if (
      replacementCnpj &&
      replacementMatch.cnpj &&
      replacementCnpj !== digitsOnly(replacementMatch.cnpj)
    ) {
      res.status(422).json({
        message: "Substituição bloqueada: o CNPJ do espelho diverge do cadastro confirmado no ARCHI.",
        code: "cnpj_motorista_divergente"
      });
      return;
    }
    const replacementCpf = digitsOnly(String(req.body?.motoristaCpf || ""));
    const archiCpf = digitsOnly(replacementMatch.cpfDigits || replacementMatch.cpf || "");
    if (replacementCpf && archiCpf && replacementCpf !== archiCpf) {
      res.status(422).json({
        message: "Substituição bloqueada: o CPF informado não confirma o motorista localizado pelo nome, CNPJ e base.",
        code: "cpf_confirmacao_divergente"
      });
      return;
    }
    const replacementMotoristaId = await ensureMotoristaFromRegistryMatch(replacementMatch);

    const totalValue = await extractTotalGeralValueFromSource({ content: file.buffer }).catch(() => null);

    if (totalValue !== null && totalValue < 0) {
      res.status(422).json({
        message: "Espelho de pagamento bloqueado: o Total Geral está negativo.",
        code: "total_geral_negativo",
        fileName: file.originalname
      });
      return;
    }

    const storageFolder = [
      "uploads",
      `periodos/${currentUpload.periodoPagamentoId || "sem-periodo"}`,
      `bases/${currentUpload.basePagamentoId || "sem-base"}`
    ].join("/");
    const key = assertPaymentMirrorStorageKey(createStorageKey(storageFolder, file.originalname));
    await uploadObject({
      key,
      body: file.buffer,
      contentType: file.mimetype
    });

    const replacementUploadId = randomUUID();
    await prisma.$transaction([
      prisma.uploadPdf.update({
        where: {
          id: currentUpload.id
        },
        data: {
          status: UploadStatus.substituido
        }
      }),
      prisma.$executeRaw(Prisma.sql`
        insert into "uploads_pdf" (
          "id",
          "nome_arquivo",
          "nome_original",
          "caminho_arquivo",
          "document_type",
          "versao",
          "status",
          "usuario_id",
          "motorista_id",
          "motorista_nome_extraido",
          "motorista_cnpj_extraido",
          "periodo_pagamento_id",
          "base_pagamento_id",
          "substitui_upload_id",
          "valor_total_pdf"
        ) values (
          cast(${replacementUploadId} as uuid),
          ${file.originalname},
          ${file.originalname},
          ${key},
          ${DocumentTypeCode.espelho},
          ${currentUpload.versao + 1},
          cast(${currentUpload.status} as "UploadStatus"),
          cast(${auth.userId} as uuid),
          cast(${replacementMotoristaId} as uuid),
          ${replacementMatch.nome || replacementMetadata.identity?.name || currentUpload.motoristaNomeExtraido},
          ${replacementMatch.cnpj || replacementMetadata.identity?.cnpj || currentUpload.motoristaCnpjExtraido},
          cast(${currentUpload.periodoPagamentoId} as uuid),
          cast(${currentUpload.basePagamentoId} as uuid),
          cast(${currentUpload.id} as uuid),
          cast(${totalValue} as numeric)
        )
      `)
    ]);

    if (
      currentUpload.periodoPagamento?.status === "aprovado" &&
      replacementMotoristaId &&
      currentUpload.periodoPagamentoId &&
      currentUpload.basePagamentoId
    ) {
      await publishApprovedUpload({
        uploadPdfId: replacementUploadId,
        motoristaId: replacementMotoristaId,
        periodId: currentUpload.periodoPagamentoId,
        basePaymentId: currentUpload.basePagamentoId,
        fileName: file.originalname,
        storageKey: key,
        createdByUserId: auth.userId,
        version: currentUpload.versao + 1
      });
    }

    // A versão anterior permanece no bucket para que o histórico continue permitindo download.
    // Ela já fica fora da fila operacional pelo status "substituido" e pelo vínculo de versão.

    await prisma.logAuditoria.create({
      data: {
        usuarioId: auth.userId,
        acao: "substituir_pdf",
        entidade: "uploads_pdf",
        entidadeId: currentUpload.id,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null,
        detalhes: {
          antigo: currentUpload.nomeOriginal,
          novo: file.originalname
        }
      }
    });

    res.json({
      message: "PDF substituido com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao substituir PDF.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/:id/download", (req, res) => {
  void (async () => {
    const upload = await prisma.uploadPdf.findUnique({
      where: {
        id: String(req.params.id)
      }
    });

    if (!upload) {
      res.status(404).json({
        message: "Arquivo não encontrado."
      });
      return;
    }

    if (!isPaymentMirrorUpload(upload)) {
      res.status(404).json({
        message: "Arquivo não encontrado."
      });
      return;
    }

    if (!req.auth || (!canSeeAllUploads(req.auth) && upload.usuarioId !== req.auth.userId)) {
      res.status(404).json({
        message: "Arquivo não encontrado."
      });
      return;
    }

    const downloadUrl = resolvePaymentMirrorUrl(upload);

    if (!downloadUrl) {
      res.status(404).json({
        message: "Arquivo não encontrado."
      });
      return;
    }

    res.redirect(downloadUrl);
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao baixar arquivo.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

export default router;
