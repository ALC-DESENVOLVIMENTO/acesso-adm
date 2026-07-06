import { UploadStatus } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import { requireAuth, requireModuleAccess } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";
import { notifyPdfOnline } from "../../lib/pdfonline-bridge.js";
import {
  buildStorageObjectUrl,
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
  const storageUrl = buildStorageObjectUrl(upload.caminhoArquivo) || null;

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

  const target = uploads.find((item) => item.id === uploadId);

  if (!target) {
    return null;
  }

  const byId = new Map(uploads.map((item) => [item.id, item]));
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

  return uploads
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

function formatRegistryMismatchMessage(options: {
  motoristaNome: string;
  expectedBase: string;
  foundBase: string | null;
}) {
  const parts = [`O motorista ${options.motoristaNome}`];

  if (options.foundBase) {
    parts.push(`esta vinculado a ${options.foundBase}`);
  } else {
    parts.push("nao possui base identificada");
  }

  parts.push(`e nao a base selecionada ${options.expectedBase}.`);

  return parts.join(" ");
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

  if (normalizeText(match.base || "") !== normalizeText(selectedBaseName)) {
    return {
      error: formatRegistryMismatchMessage({
        motoristaNome: match.nome,
        expectedBase: selectedBaseName,
        foundBase: match.base
      })
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

    res.json(uploads.filter((item) => !childReferences.has(item.id)).map(serializeUpload));
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

    const shouldBridgeUploadToPdfOnline = period?.status === "aprovado";

    if (!period) {
      res.status(404).json({
        message: "Periodo de pagamento nao encontrado."
      });
      return;
    }

    if (!period.bases.some((item) => item.basePagamentoId === basePaymentId)) {
      res.status(400).json({
        message: "Base invalida para o periodo selecionado."
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
        const storageKey = createStorageKey(storageFolder, file.originalname);

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
          baseName
        };
      })
    );

    const createdUploads: Array<{
      id: string;
      nomeArquivo: string;
      nomeOriginal: string;
      caminhoArquivo: string;
      versao: number;
      status: UploadStatus;
      usuarioId: string;
      motoristaId: string | null;
      periodoPagamentoId: string | null;
      basePagamentoId: string | null;
      motoristaNome: string;
      motoristaCpf: string;
      baseName: string;
      file: Express.Multer.File;
      storageKey: string;
    }> = [];

    for (const prepared of preparedFiles) {
      const createdUpload = await prisma.uploadPdf.create({
        data: {
          nomeArquivo: prepared.file.originalname,
          nomeOriginal: prepared.file.originalname,
          caminhoArquivo: prepared.storageKey,
          versao: 1,
          status: UploadStatus.pendente,
          usuarioId: auth.userId,
          motoristaId: prepared.motoristaId,
          periodoPagamentoId: periodId,
          basePagamentoId: basePaymentId
        }
      });

      createdUploads.push({
        ...createdUpload,
        motoristaNome: prepared.motoristaNome,
        motoristaCpf: prepared.motoristaCpf,
        baseName: prepared.baseName,
        file: prepared.file,
        storageKey: prepared.storageKey
      });
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

    if (shouldBridgeUploadToPdfOnline) {
      void Promise.all(
        createdUploads.map((upload) =>
          notifyPdfOnline(
            "portal.upload.created",
            {
              id: upload.id,
              uploadId: upload.id,
              uploadPdfId: upload.id,
              periodId,
              periodoPagamentoId: periodId,
              basePaymentId,
              basePagamentoId: basePaymentId,
              motoristaId: upload.motoristaId,
              motoristaNome: upload.motoristaNome,
              motoristaCpf: upload.motoristaCpf,
              usuarioId: auth.userId,
              nomeArquivo: upload.nomeArquivo,
              nomeOriginal: upload.nomeOriginal,
              caminhoArquivo: upload.caminhoArquivo,
              storageKey: upload.storageKey,
              versao: upload.versao,
              status: "pendente",
              tipoArquivo: upload.file.mimetype,
              observacoes: `PDF anexado para ${upload.motoristaNome}`
            },
            {
              userId: auth.userId,
              periodId,
              basePaymentId
            }
          ).catch((error) => {
            console.warn("PDF Online bridge upload-created notify failed:", error instanceof Error ? error.message : error);
          })
        )
      );
    }

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
      include: {
        periodoPagamento: {
          select: {
            status: true
          }
        }
      }
    });

    if (!upload) {
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

    if (upload.periodoPagamento?.status === "aprovado") {
      void notifyPdfOnline(
        "portal.upload.removed",
        {
          id: upload.id,
          uploadId: upload.id,
          uploadPdfId: upload.id,
          periodId: upload.periodoPagamentoId,
          periodoPagamentoId: upload.periodoPagamentoId,
          basePaymentId: upload.basePagamentoId,
          basePagamentoId: upload.basePagamentoId,
          motoristaId: upload.motoristaId,
          usuarioId: upload.usuarioId,
          nomeArquivo: upload.nomeArquivo,
          nomeOriginal: upload.nomeOriginal,
          caminhoArquivo: upload.caminhoArquivo,
          storageKey: upload.caminhoArquivo,
          status: "removido",
          tipoArquivo: "application/pdf",
          observacoes: `PDF removido para ${upload.nomeOriginal}`
        },
        {
          userId: auth.userId,
          uploadId: upload.id,
          periodId: upload.periodoPagamentoId,
          basePaymentId: upload.basePagamentoId
        }
      ).catch((error) => {
        console.warn("PDF Online bridge upload-removed notify failed:", error instanceof Error ? error.message : error);
      });
    }

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
      include: {
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
      }
    });

    if (!currentUpload) {
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
    const key = createStorageKey(storageFolder, file.originalname);
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
      prisma.uploadPdf.create({
        data: {
          nomeArquivo: file.originalname,
          nomeOriginal: file.originalname,
          caminhoArquivo: key,
          versao: currentUpload.versao + 1,
          status: UploadStatus.pendente,
          usuarioId: auth.userId,
          motoristaId: currentUpload.motoristaId,
          periodoPagamentoId: currentUpload.periodoPagamentoId,
          basePagamentoId: currentUpload.basePagamentoId,
          substituiUploadId: currentUpload.id
        }
      })
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

    if (currentUpload.periodoPagamento?.status === "aprovado") {
      void notifyPdfOnline(
        "portal.upload.replaced",
        {
          id: newUpload.id,
          uploadId: newUpload.id,
          uploadPdfId: newUpload.id,
          periodId: newUpload.periodoPagamentoId,
          periodoPagamentoId: newUpload.periodoPagamentoId,
          basePaymentId: newUpload.basePagamentoId,
          basePagamentoId: newUpload.basePagamentoId,
          motoristaId: newUpload.motoristaId,
          usuarioId: newUpload.usuarioId,
          nomeArquivo: newUpload.nomeArquivo,
          nomeOriginal: newUpload.nomeOriginal,
          caminhoArquivo: newUpload.caminhoArquivo,
          storageKey: newUpload.caminhoArquivo,
          versao: newUpload.versao,
          status: "pendente",
          tipoArquivo: file.mimetype,
          substituiUploadId: currentUpload.id,
          observacoes: `PDF substituido para ${currentUpload.nomeOriginal}`
        },
        {
          userId: auth.userId,
          uploadId: newUpload.id,
          periodId: newUpload.periodoPagamentoId,
          basePaymentId: newUpload.basePagamentoId
        }
      ).catch((error) => {
        console.warn("PDF Online bridge upload-replaced notify failed:", error instanceof Error ? error.message : error);
      });
    }

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

    const downloadUrl = buildStorageObjectUrl(upload.caminhoArquivo);

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
