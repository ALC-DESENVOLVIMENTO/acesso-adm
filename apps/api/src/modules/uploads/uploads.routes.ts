import { DocumentTypeCode, Prisma, UploadStatus } from "@prisma/client";
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
  ensureMotoristaFromRegistryMatch,
  normalizeText,
  resolveDriverRegistryByIdentity
} from "../../lib/driver-registry.js";
import { upsertDriverPdfReceivedFromUpload } from "../../lib/driver-pdf-received.js";

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

function isPaymentMirrorUpload(upload: { documentType?: DocumentTypeCode | null; status: UploadStatus | string }) {
  if (upload.documentType === DocumentTypeCode.nota_fiscal) {
    return false;
  }

  return upload.status !== UploadStatus.removido;
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

async function resolveUploadMotorista(file: Express.Multer.File, selectedBaseName: string, body: Record<string, unknown>) {
  const identity = normalizeFileIdentityOptions(body, file.originalname);
  const resolved = await resolveDriverRegistryByIdentity(identity);

  if (!resolved) {
    return {
      pending: true,
      motoristaNome: identity.name || file.originalname,
      motoristaCpf: identity.cpf || "",
      motoristaCnpj: identity.cnpj || null,
      baseName: selectedBaseName
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
        baseMatches.find((item) => item.cpfDigits && identity.cpf && item.cpfDigits === identity.cpf.replace(/\D/g, "")) ||
        baseMatches.find((item) => item.cnpj && identity.cnpj && item.cnpj.replace(/\D/g, "") === identity.cnpj.replace(/\D/g, "")) ||
        null;
    }

    if (!match) {
      return {
        pending: true,
        motoristaNome: identity.name || file.originalname,
        motoristaCpf: identity.cpf || "",
        motoristaCnpj: identity.cnpj || null,
        baseName: selectedBaseName
      } as const;
    }
  }

  if (!match) {
    return {
      error: `Não foi possível resolver o motorista do arquivo ${file.originalname}.`
    } as const;
  }

  const motoristaId = await ensureMotoristaFromRegistryMatch(match);

  if (!motoristaId) {
    return {
      pending: true,
      motoristaNome: match.nome,
      motoristaCpf: match.cpfDigits || match.cpf || "",
      motoristaCnpj: match.cnpj || null,
      baseName: match.base || selectedBaseName
    } as const;
  }

  return {
    motoristaId,
    motoristaNome: match.nome,
    motoristaCpf: match.cpfDigits || match.cpf,
    motoristaCnpj: match.cnpj || null,
    baseName: match.base || selectedBaseName
  } as const;
}

async function reconcilePendingUploadsFromRegistry() {
  const pendingUploads = await prisma.uploadPdf.findMany({
    where: {
      status: UploadStatus.pendente,
      documentType: {
        not: DocumentTypeCode.nota_fiscal
      },
      motoristaId: null,
      periodoPagamentoId: {
        not: null
      },
      basePagamentoId: {
        not: null
      }
    },
    select: {
      id: true,
      nomeOriginal: true,
      caminhoArquivo: true,
      periodoPagamentoId: true,
      basePagamentoId: true,
      status: true,
      motoristaId: true,
      periodoPagamento: {
        select: {
          status: true
        }
      }
    },
    orderBy: {
      criadoEm: "asc"
    },
    take: 100
  });

  for (const upload of pendingUploads) {
    const resolved = await resolveDriverRegistryByIdentity({
      fileName: upload.nomeOriginal
    });

    if (!resolved || "ambiguous" in resolved) {
      continue;
    }

    const motoristaId = await ensureMotoristaFromRegistryMatch(resolved);

    if (!motoristaId) {
      continue;
    }

    const updated = await prisma.uploadPdf.update({
      where: {
        id: upload.id
      },
      data: {
        motoristaId,
        status: UploadStatus.processado
      },
      select: {
        id: true,
        motoristaId: true,
        periodoPagamentoId: true,
        basePagamentoId: true,
        nomeOriginal: true,
        caminhoArquivo: true
      }
    });

    if (upload.periodoPagamento?.status === "aprovado") {
      await upsertDriverPdfReceivedFromUpload({
        uploadPdfId: updated.id,
        motoristaId: updated.motoristaId || motoristaId,
        periodId: updated.periodoPagamentoId || "",
        basePaymentId: updated.basePagamentoId || "",
        fileName: updated.nomeOriginal,
        storageKey: updated.caminhoArquivo,
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
    const childReferences = new Set(
      paymentUploads
        .map((item) => item.substituiUploadId)
        .filter((value): value is string => Boolean(value))
    );

    res.json(
      paymentUploads
        .filter((item) => !childReferences.has(item.id) && isPaymentMirrorUpload(item))
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

    const resolvedFiles = await Promise.all(
      files.map(async (file) => {
        const resolved = await resolveUploadMotorista(file, selectedBase.nome, req.body as Record<string, unknown>);

        return {
          file,
          ...resolved
        };
      })
    );

    const validationErrors = resolvedFiles.flatMap((item) =>
      "error" in item
        ? [
            {
              fileName: item.file.originalname,
              message: item.error
            }
          ]
        : []
    );

    const validFiles = resolvedFiles.filter((item) => !("error" in item)) as Array<
      {
        file: Express.Multer.File;
        motoristaId?: string | null;
        motoristaNome: string;
        motoristaCpf: string;
        motoristaCnpj: string | null;
        baseName: string;
        pending?: boolean;
      }
    >;

    if (validFiles.length === 0) {
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
        const { file, motoristaId, motoristaNome, motoristaCpf, baseName } = item;
        const storageKey = assertPaymentMirrorStorageKey(createStorageKey(storageFolder, file.originalname));

        try {
          await uploadObject({
            key: storageKey,
            body: file.buffer,
            contentType: file.mimetype
          });

          const created = await prisma.uploadPdf.create({
            data: {
              id: randomUUID(),
              nomeArquivo: file.originalname,
              nomeOriginal: file.originalname,
              caminhoArquivo: storageKey,
              documentType: DocumentTypeCode.espelho,
              versao: 1,
              status: UploadStatus.pendente,
              usuarioId: auth.userId,
              motoristaId: motoristaId || null,
              periodoPagamentoId: periodId,
              basePagamentoId: basePaymentId
            },
            select: {
              id: true
            }
          });

          return {
            ok: true as const,
            id: created.id,
            fileName: file.originalname,
            motoristaNome,
            motoristaCpf,
            baseName,
            baseMismatch: normalizeText(baseName || "") !== normalizeText(selectedBase.nome)
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
    const failedFiles = [
      ...validationErrors,
      ...processedFiles
        .filter((item) => !item.ok)
        .map((item) => ({
          fileName: item.fileName,
          message: item.message
        }))
    ];

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

    res.status(failedFiles.length > 0 ? 207 : 201).json({
      message:
        failedFiles.length > 0
          ? `${uploadedFiles.length} PDF(s) enviado(s). ${failedFiles.length} arquivo(s) precisam de revisao.`
          : "Upload concluido com sucesso.",
      uploaded: uploadedFiles.length,
      failed: failedFiles
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
      res.status(404).json({
        message: "Upload não encontrado."
      });
      return;
    }

    if (!req.auth || (!canSeeAllUploads(req.auth) && upload.usuarioId !== req.auth.userId)) {
      res.status(404).json({
        message: "Arquivo não encontrado."
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

    void deleteObject(upload.caminhoArquivo);
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
        periodoPagamentoId: true,
        basePagamentoId: true
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

    const [_updatedUpload, newUpload] = await prisma.$transaction([
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
          "periodo_pagamento_id",
          "base_pagamento_id",
          "substitui_upload_id"
        ) values (
          cast(${randomUUID()} as uuid),
          ${file.originalname},
          ${file.originalname},
          ${key},
          ${DocumentTypeCode.espelho},
          ${currentUpload.versao + 1},
          cast(${currentUpload.status} as "UploadStatus"),
          cast(${auth.userId} as uuid),
          cast(${currentUpload.motoristaId} as uuid),
          cast(${currentUpload.periodoPagamentoId} as uuid),
          cast(${currentUpload.basePagamentoId} as uuid),
          cast(${currentUpload.id} as uuid)
        )
      `)
    ]);

    void deleteObject(currentUpload.caminhoArquivo);

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
