import { UploadStatus } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import { requireAuth, requireModuleAccess } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";
import {
  buildStorageObjectUrl,
  createStorageKey,
  getStorageDiagnostics,
  deleteObject,
  uploadObject
} from "../../lib/storage.js";
import { notifyPdfOnline } from "../../lib/pdfonline-bridge.js";

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

    if (!period.bases.some((item) => item.basePagamentoId === basePaymentId)) {
      res.status(400).json({
        message: "Base invalida para o periodo selecionado."
      });
      return;
    }

    const storageFolder = ["uploads", `periodos/${periodId}`, `bases/${basePaymentId}`].join("/");
    const preparedFiles = await Promise.all(
      files.map(async (file) => {
        const storageKey = createStorageKey(storageFolder, file.originalname);

        await uploadObject({
          key: storageKey,
          body: file.buffer,
          contentType: file.mimetype
        });

        return {
          file,
          storageKey
        };
      })
    );

    await prisma.uploadPdf.createMany({
      data: preparedFiles.map(({ file, storageKey }) => ({
        nomeArquivo: file.originalname,
        nomeOriginal: file.originalname,
        caminhoArquivo: storageKey,
        versao: 1,
        status: UploadStatus.pendente,
        usuarioId: req.auth!.userId,
        periodoPagamentoId: periodId,
        basePagamentoId: basePaymentId
      }))
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: req.auth.userId,
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

    void notifyPdfOnline(
      "portal.upload.created",
      {
        periodId,
        basePaymentId,
        uploads: preparedFiles.map(({ file, storageKey }) => ({
          name: file.originalname,
          storageKey,
          type: file.mimetype,
          size: file.size
        }))
      },
      {
        userId: req.auth.userId
      }
    ).catch((error) => {
      console.warn("PDF Online bridge upload notify failed:", error instanceof Error ? error.message : error);
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

    const upload = await prisma.uploadPdf.findUnique({
      where: {
        id: String(req.params.id)
      }
    });

    if (!upload) {
      res.status(404).json({
        message: "Upload nao encontrado."
      });
      return;
    }

    const canDelete =
      req.auth.level === "N3" ||
      req.auth.level === "N4" ||
      upload.usuarioId === req.auth.userId;

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
        usuarioId: req.auth.userId,
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

    void notifyPdfOnline(
      "portal.upload.removed",
      {
        uploadId: upload.id,
        fileName: upload.nomeOriginal,
        storageKey: upload.caminhoArquivo,
        periodId: upload.periodoPagamentoId,
        basePaymentId: upload.basePagamentoId
      },
      {
        userId: req.auth.userId
      }
    ).catch((error) => {
      console.warn("PDF Online bridge removal notify failed:", error instanceof Error ? error.message : error);
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
      }
    });

    if (!currentUpload) {
      res.status(404).json({
        message: "Upload nao encontrado."
      });
      return;
    }

    const canReplace =
      req.auth.level === "N3" ||
      req.auth.level === "N4" ||
      currentUpload.usuarioId === req.auth.userId;

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

    await prisma.$transaction([
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
          usuarioId: req.auth.userId,
          periodoPagamentoId: currentUpload.periodoPagamentoId,
          basePagamentoId: currentUpload.basePagamentoId,
          substituiUploadId: currentUpload.id
        }
      })
    ]);

    void deleteObject(currentUpload.caminhoArquivo);

    await prisma.logAuditoria.create({
      data: {
        usuarioId: req.auth.userId,
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

    void notifyPdfOnline(
      "portal.upload.replaced",
      {
        uploadId: currentUpload.id,
        previousFileName: currentUpload.nomeOriginal,
        nextFileName: file.originalname,
        storageKey: key,
        periodId: currentUpload.periodoPagamentoId,
        basePaymentId: currentUpload.basePagamentoId
      },
      {
        userId: req.auth.userId
      }
    ).catch((error) => {
      console.warn("PDF Online bridge replace notify failed:", error instanceof Error ? error.message : error);
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
