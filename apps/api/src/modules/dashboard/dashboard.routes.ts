import { Router } from "express";
import { prisma } from "../../lib/prisma.js";

const router = Router();

router.get("/summary", (_req, res) => {
  void (async () => {
    const [uploads, processedPdfs, pendingPdfs, pendingInvoices, ticketsWaiting, closedTickets, usersCount] =
      await Promise.all([
        prisma.uploadPdf.count(),
        prisma.uploadPdf.count({ where: { status: "processado" } }),
        prisma.uploadPdf.count({ where: { status: "pendente" } }),
        prisma.notaFiscal.count({ where: { status: "pendente" } }),
        prisma.chamado.count({ where: { status: "aguardando" } }),
        prisma.chamado.count({ where: { status: "concluido" } }),
        prisma.usuario.count()
      ]);

    res.json({
      pdfsSent: uploads,
      pendingPdfs,
      processedPdfs,
      pendingInvoices,
      ticketsWaiting,
      closedTickets,
      usersCount
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao carregar indicadores.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

export default router;
