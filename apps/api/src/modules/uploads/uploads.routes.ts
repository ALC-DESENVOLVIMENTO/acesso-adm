import { UploadStatus } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { requireAuth, requireModuleAccess } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";

const router = Router();
const currentFile = fileURLToPath(import.meta.url);
const uploadRoot = path.resolve(path.dirname(currentFile), "../../../storage/uploads");

mkdirSync(uploadRoot, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => {
    callback(null, uploadRoot);
  },
  filename: (_req, file, callback) => {
    const safeBaseName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
    callback(null, `${Date.now()}-${safeBaseName}`);
  }
});

const upload = multer({
  storage,
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
};

function serializeUpload(upload: UploadHistoryItem) {
  return {
    id: upload.id,
    fileName: upload.nomeOriginal,
    storageFileName: upload.nomeArquivo,
    status: upload.status,
    sentAt: upload.criadoEm,
    version: upload.versao,
    owner: upload.usuario.nome,
    replacedUploadId: upload.substituiUploadId
  };
}

async function getUploadHistory(uploadId: string) {
  const uploads = await prisma.uploadPdf.findMany({
    include: {
      usuario: {
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
        usuario: true
      },
      orderBy: {
        criadoEm: "desc"
      }
    });

    res.json(
      uploads.map(serializeUpload)
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

    const files = (req.files as Express.Multer.File[]) || [];

    if (files.length === 0) {
      res.status(400).json({
        message: "Selecione ao menos um PDF para upload."
      });
      return;
    }

    await prisma.uploadPdf.createMany({
      data: files.map((file) => ({
        nomeArquivo: file.filename,
        nomeOriginal: file.originalname,
        caminhoArquivo: path.relative(process.cwd(), file.path).replace(/\\/g, "/"),
        versao: 1,
        status: UploadStatus.pendente,
        usuarioId: req.auth!.userId
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
          arquivos: files.map((file) => file.originalname)
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

    res.json({
      message: "PDF removido logicamente com sucesso."
    });
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
          nomeArquivo: file.filename,
          nomeOriginal: file.originalname,
          caminhoArquivo: path.relative(process.cwd(), file.path).replace(/\\/g, "/"),
          versao: currentUpload.versao + 1,
          status: UploadStatus.pendente,
          usuarioId: req.auth.userId,
          substituiUploadId: currentUpload.id
        }
      })
    ]);

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

    const filePath = String(upload.caminhoArquivo);
    const downloadName = String(upload.nomeOriginal);
    res.download(path.resolve(process.cwd(), filePath), downloadName);
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao baixar arquivo.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

export default router;
