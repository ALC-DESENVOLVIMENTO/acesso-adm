import { Router } from "express";
import { requireAuth, requireModuleAccess } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";

const router = Router();

router.use(requireAuth, requireModuleAccess("dashboard"));

const activityPreviewLimit = 5;
const activitySearchLimit = 120;
const operationalActivityWhere = {
  OR: [
    {
      entidade: {
        in: [
          "periodos_pagamento",
          "periodo_pagamento",
          "uploads_pdf",
          "upload_pdf",
          "driver_pdf_received",
          "importacoes_financeiras",
          "historico_status_pagamento",
          "webhook_eventos"
        ]
      }
    },
    { acao: { startsWith: "dashboard_backfill_" } },
    {
      acao: {
        in: [
          "criar_periodo_pagamento",
          "editar_periodo_pagamento",
          "alterar_status_periodo_pagamento",
          "excluir_periodo_pagamento",
          "upload_pdf",
          "substituir_pdf",
          "excluir_pdf",
          "review_period_base_upload"
        ]
      }
    }
  ]
};

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

  if (normalized.includes("periodo")) {
    return "calendar";
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

  if (action === "criar_periodo_pagamento") {
    return periodName ? `Periodo criado: ${periodName}` : "Periodo de pagamento criado";
  }

  if (action === "editar_periodo_pagamento") {
    return periodName ? `Periodo alterado: ${periodName}` : "Periodo de pagamento alterado";
  }

  if (action === "alterar_status_periodo_pagamento") {
    return periodName ? `Status do periodo alterado: ${periodName}` : "Status do periodo alterado";
  }

  if (action === "upload_pdf") {
    return fileName ? `Espelho enviado: ${fileName}` : "Espelho de pagamento enviado";
  }

  if (action === "substituir_pdf") {
    return fileName ? `Espelho substituido: ${fileName}` : "Espelho de pagamento substituido";
  }

  if (action === "excluir_pdf") {
    return fileName ? `Espelho removido: ${fileName}` : "Espelho de pagamento removido";
  }

  if (action.startsWith("dashboard_backfill_")) {
    if (entity === "periodo_pagamento" && periodName) {
      return `Historico do periodo: ${periodName}`;
    }

    if ((entity === "upload_pdf" || entity === "driver_pdf_received") && fileName) {
      return `Historico do arquivo: ${fileName}`;
    }

    if (motoristaName) {
      return `Historico do motorista: ${motoristaName}`;
    }

    return `Historico ${entity}`;
  }

  if (fileName) {
    return `${action}: ${fileName}`;
  }

  return `${action} em ${entity}`;
}

function mapActivity(log: {
  id: string;
  entidade: string;
  acao: string;
  detalhes: unknown;
  criadoEm: Date;
  usuario: { nome: string } | null;
}) {
  return {
    id: log.id,
    icon: resolveActivityIcon(log.entidade, log.acao),
    title: resolveActivityTitle(log.entidade, log.acao, log.detalhes),
    subtitle: log.usuario?.nome ? `Executado por ${log.usuario.nome}` : "Registro do sistema",
    occurredAt: toIso(log.criadoEm)
  };
}

function activityMatchesSearch(activity: ReturnType<typeof mapActivity>, search: string) {
  const normalized = search.trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  return `${activity.title} ${activity.subtitle} ${activity.occurredAt || ""}`.toLowerCase().includes(normalized);
}

async function fetchOperationalActivities() {
  const logs = await prisma.logAuditoria.findMany({
    where: operationalActivityWhere,
    orderBy: {
      criadoEm: "desc"
    },
    take: activitySearchLimit,
    include: {
      usuario: {
        select: {
          nome: true
        }
      }
    }
  });

  return logs.map(mapActivity);
}

router.get("/summary", (_req, res) => {
  void (async () => {
    const [
      uploads,
      processedPdfs,
      pendingPdfs,
      pendingInvoices,
      ticketsWaiting,
      closedTickets,
      usersCount,
      recentPeriods,
      activities
    ] = await Promise.all([
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
      fetchOperationalActivities()
    ]);

    const periodSummaries = await Promise.all(
      recentPeriods.map(async (period) => {
        const [pdfsSent, notesReceived] = await Promise.all([
          prisma.uploadPdf.count({
            where: {
              periodoPagamentoId: period.id,
              status: {
                not: "removido"
              }
            }
          }),
          prisma.driverPdfReceived.count({
            where: {
              periodoPagamentoId: period.id,
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

    res.json({
      pdfsSent: uploads,
      pendingPdfs,
      processedPdfs,
      pendingInvoices,
      ticketsWaiting,
      closedTickets,
      usersCount,
      periodSummaries,
      recentActivities: activities.slice(0, activityPreviewLimit),
      recentActivitiesTotal: activities.length
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao carregar indicadores.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/activities", (req, res) => {
  void (async () => {
    const search = String(req.query.search || "");
    const activities = (await fetchOperationalActivities()).filter((activity) =>
      activityMatchesSearch(activity, search)
    );

    res.json({
      activities,
      total: activities.length
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao carregar atividades.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

export default router;
