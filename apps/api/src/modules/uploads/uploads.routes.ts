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

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, callback) => {
    const isPdf =
      file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf");
    callback(null, isPdf);
  }
});

router.use(requireAuth, requireModuleAccess("pdfs"));

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

async function getUploadHistory(uploadId: string) {
  const uploads = await prisma.uploadPdf.findMany({
    where: {
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
      error: `Nao foi possivel localizar o motorista no pre-cadastro para o arquivo ${file.originalname}.`
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
        error: `Motorista duplicado ou sem identificacao suficiente para o arquivo ${file.originalname}. Informe CPF ou CNPJ para validar o pre-cadastro.`
      } as const;
    }
  }

  if (!match) {
    return {
      error: `Nao foi possivel resolver o motorista do arquivo ${file.originalname}.`
    } as const;
  }

  const motoristaId = await ensureMotoristaFromRegistryMatch(match);

  if (!motoristaId) {
    return {
      error: `Nao foi possivel sincronizar o motorista ${match.nome} no banco de dados.`
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

router.get("/", (_req, res) => {
  void (async () => {
    const uploads = await prisma.uploadPdf.findMany({
      where: {
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

    const childReferences = new Set(
      uploads
        .map((item) => item.substituiUploadId)
        .filter((value): value is string => Boolean(value))
    );

    res.json(
      uploads
        .filter((item) => item.documentType !== DocumentTypeCode.nota_fiscal)
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
    const history = await getUploadHistory(String(req.params.id));

    if (!history) {
      res.status(404).json({
        message: "Historico do PDF nao encontrado."
      });
      return;
    }

    res.json(history);
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao carregar historico do PDF.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/", upload.array("files", 20), (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({
        message: "Sessao invalida."
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
        message: "Selecione um periodo e uma base antes de enviar PDFs."
      });
      return;
    }

    const storageDiagnostics = getStorageDiagnostics();

    if (!storageDiagnostics.configured) {
      res.status(503).json({
        message: "Servico de armazenamento nao configurado.",
        detail: {
          missing: storageDiagnostics.missing,
          bucket: storageDiagnostics.bucket ? "definido" : "nao definido",
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
        message: "Periodo de pagamento nao encontrado."
      });
      return;
    }

    const selectedBase = period.bases.find((item) => item.basePagamentoId === basePaymentId)?.basePagamento;

    if (!selectedBase) {
      res.status(404).json({
        message: "Base selecionada nao encontrada no periodo."
      });
      return;
    }

    const resolvedFiles = await Promise.all(
      files.map(async (file) => {
        const resolved = await resolveUploadMotorista(file, selectedBase.nome, req.body as Record<string, unknown>);

        if ("error" in resolved) {
          return resolved;
        }

        return {
          file,
          ...resolved
        };
      })
    );

    const validationError = resolvedFiles.find((item) => "error" in item);

    if (validationError && "error" in validationError) {
      res.status(400).json({
        message: validationError.error
      });
      return;
    }

    const validFiles = resolvedFiles as Array<
      {
        file: Express.Multer.File;
        motoristaId: string;
        motoristaNome: string;
        motoristaCpf: string;
        motoristaCnpj: string | null;
        baseName: string;
      }
    >;

    const storageFolder = ["uploads", `periodos/${periodId}`, `bases/${basePaymentId}`].join("/");
    const preparedFiles = await Promise.all(
      validFiles.map(async (item) => {
        const { file, motoristaId, motoristaNome, motoristaCpf, baseName } = item;
        const storageKey = assertPaymentMirrorStorageKey(createStorageKey(storageFolder, file.originalname));

        await uploadObject({
          key: storageKey,
          body: file.buffer,
          contentType: file.mimetype
        });

        return {
          file,
          storageKey,
          motoristaId,
          motoristaNome,
          motoristaCpf,
          baseName,
          baseMismatch: normalizeText(baseName || "") !== normalizeText(selectedBase.nome)
        };
      })
    );

    for (const prepared of preparedFiles) {
      await prisma.$executeRaw(Prisma.sql`
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
          "base_pagamento_id"
        ) values (
          cast(${randomUUID()} as uuid),
          ${prepared.file.originalname},
          ${prepared.file.originalname},
          ${prepared.storageKey},
          ${DocumentTypeCode.espelho},
          ${1},
          ${UploadStatus.pendente},
          cast(${auth.userId} as uuid),
          cast(${prepared.motoristaId} as uuid),
          cast(${periodId} as uuid),
          cast(${basePaymentId} as uuid)
        )
      `);
    }

    await prisma.logAuditoria.create({
      data: {
        usuarioId: auth.userId,
        acao: "upload_pdfs",
        entidade: "uploads_pdf",
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null,
        detalhes: {
          quantidade: files.length,
          arquivos: files.map((file) => file.originalname),
          periodId,
          basePaymentId
        }
      }
    });

    res.status(201).json({
      message: "Upload concluido com sucesso."
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
        message: "Sessao invalida."
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
        message: "Upload nao encontrado."
      });
      return;
    }

    if (!isPaymentMirrorUpload(upload)) {
      res.status(404).json({
        message: "Upload nao encontrado."
      });
      return;
    }

    const canDelete =
      auth.level === "N3" ||
      auth.level === "N4" ||
      upload.usuarioId === auth.userId;

    if (!canDelete) {
      res.status(403).json({
        message: "Voce nao possui permissao para remover este PDF."
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
        message: "Sessao invalida."
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
        message: "Upload nao encontrado."
      });
      return;
    }

    if (!isPaymentMirrorUpload(currentUpload)) {
      res.status(404).json({
        message: "Upload nao encontrado."
      });
      return;
    }

    const canReplace =
      auth.level === "N3" ||
      auth.level === "N4" ||
      currentUpload.usuarioId === auth.userId;

    if (!canReplace) {
      res.status(403).json({
        message: "Voce nao possui permissao para substituir este PDF."
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
          ${currentUpload.status},
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
        message: "Arquivo nao encontrado."
      });
      return;
    }

    if (!isPaymentMirrorUpload(upload)) {
      res.status(404).json({
        message: "Arquivo nao encontrado."
      });
      return;
    }

    const downloadUrl = resolvePaymentMirrorUrl(upload);

    if (!downloadUrl) {
      res.status(404).json({
        message: "Arquivo nao encontrado."
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
