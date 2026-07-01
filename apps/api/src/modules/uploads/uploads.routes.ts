import { Router } from "express";
import { prisma } from "../../lib/prisma.js";

const router = Router();

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

export default router;
