import { Router } from "express";
import { requireAuth, requireModuleAccess } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";

const router = Router();

router.use(requireAuth, requireModuleAccess("dashboard"));

function toIso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function readDetails(details: unknown) {
  return details && typeof details === "object" ? (details as Record<string, unknown>) : {};
}

function readDetailString(details: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = details[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

function resolveActivityIcon(entity: string, action: string) {
  const normalized = `${entity} ${action}`.toLowerCase();

  if (normalized.includes("usuario")) {
    return "user";
  }

  if (normalized.includes("visualiz") || normalized.includes("driver_pdf_received")) {
    return "view";
  }

  return "pdf";
}

function resolveActivityTitle(entity: string, action: string, details: unknown) {
  const parsedDetails = readDetails(details);
  const fileName = readDetailString(parsedDetails, "arquivo", "fileName", "nomeArquivo");
  const periodName = readDetailString(parsedDetails, "nome", "periodoNome");
  const motoristaName = readDetailString(parsedDetails, "nomeMotorista", "motoristaNome");

  if (action.startsWith("dashboard_backfill_")) {
    if (entity === "periodo_pagamento" && periodName) {
      return `Histórico do período: ${periodName}`;
    }

    if ((entity === "upload_pdf" || entity === "driver_pdf_received") && fileName) {
      return `Histórico do arquivo: ${fileName}`;
    }

    if (motoristaName) {
      return `Histórico do motorista: ${motoristaName}`;
    }

    return `Histórico ${entity}`;
  }

  if (fileName) {
    return `${action}: ${fileName}`;
  }

  return `${action} em ${entity}`;
}

router.get("/summary", (_req, res) => {
  void (async () => {
    const [uploads, processedPdfs, pendingPdfs, pendingInvoices, ticketsWaiting, closedTickets, usersCount, recentPeriods, recentLogs] =
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
        prisma.usuario.count(),
        prisma.periodoPagamento.findMany({
          orderBy: {
            atualizadoEm: "desc"
          },
          take: 8,
          select: {
            id: true,
            nome: true,
            dataInicio: true,
            dataFim: true,
            status: true
          }
        }),
        prisma.logAuditoria.findMany({
          orderBy: {
            criadoEm: "desc"
          },
          take: 12,
          include: {
            usuario: {
              select: {
                nome: true
              }
            }
          }
        })
      ]);

    const periodSummaries = await Promise.all(
      recentPeriods.map(async (period) => {
        const [pdfsSent, notesReceived] = await Promise.all([
          prisma.uploadPdf.count({
            where: {
              periodoPagamentoId: period.id,
              status: {
                not: "removido"
              },
              OR: [
                {
                  documentType: null
                },
                {
                  documentType: {
                    not: "nota_fiscal"
                  }
                }
              ]
            }
          }),
          prisma.driverPdfReceived.count({
            where: {
              periodoPagamentoId: period.id,
              OR: [
                {
                  documentType: "nota_fiscal"
                },
                {
                  status: {
                    in: [
                      "nota_fiscal_recebida",
                      "nota_fiscal_em_analise",
                      "nota_fiscal_aprovada",
                      "nota_fiscal_rejeitada",
                      "processo_concluido"
                    ]
                  }
                }
              ]
            }
          })
        ]);

        return {
          id: period.id,
          name: period.nome,
          startDate: toIso(period.dataInicio),
          endDate: toIso(period.dataFim),
          status: period.status,
          pdfsSent,
          notesReceived,
          notesPending: Math.max(pdfsSent - notesReceived, 0)
        };
      })
    );

    const recentActivities = recentLogs.map((log) => ({
      id: log.id,
      icon: resolveActivityIcon(log.entidade, log.acao),
      title: resolveActivityTitle(log.entidade, log.acao, log.detalhes),
      subtitle: log.usuario?.nome ? `Executado por ${log.usuario.nome}` : "Registro do sistema",
      occurredAt: toIso(log.criadoEm)
    }));

    res.json({
      pdfsSent: uploads,
      pendingPdfs,
      processedPdfs,
      pendingInvoices,
      ticketsWaiting,
      closedTickets,
      usersCount,
      periodSummaries,
      recentActivities
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao carregar indicadores.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

export default router;
