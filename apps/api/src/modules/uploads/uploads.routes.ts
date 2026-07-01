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

router.get("/", (_req, res) => {
  void (async () => {
    const uploads = await prisma.uploadPdf.findMany({
      include: {
        usuario: true
      },
      orderBy: {
        criadoEm: "desc"
      }
    });

    res.json(
      uploads.map((upload) => ({
        id: upload.id,
        fileName: upload.nomeOriginal,
        storageFileName: upload.nomeArquivo,
        status: upload.status,
        sentAt: upload.criadoEm,
        version: upload.versao,
        owner: upload.usuario.nome
      }))
    );
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao listar uploads.",
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
