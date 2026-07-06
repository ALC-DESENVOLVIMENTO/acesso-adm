import { Router } from "express";
import { requireAuth, requireModuleAccess } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";

const router = Router();

router.use(requireAuth, requireModuleAccess("dashboard"));

router.get("/summary", (_req, res) => {
  void (async () => {
    const [uploads, processedPdfs, pendingPdfs, pendingInvoices, ticketsWaiting, closedTickets, usersCount] =
      await Promise.all([
        prisma.uploadPdf.count({
          where: {
            status: {
              not: "removido"
            }
          }
        }),
        prisma.uploadPdf.count({ where: { status: "processado" } }),
        prisma.uploadPdf.count({ where: { status: "pendente" } }),
        prisma.driverPdfReceived.count({
          where: {
            status: {
              in: [
                "pdf_aguardando_envio",
                "pdf_enviado_ao_motorista",
                "motorista_visualizou",
                "aguardando_envio_nota_fiscal"
              ]
            }
          }
        }),
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
