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

function humanizeAction(action: string) {
  const labels: Record<string, string> = {
    criar_periodo_pagamento: "Período criado",
    editar_periodo_pagamento: "Período alterado",
    alterar_status_periodo_pagamento: "Status do período alterado",
    finalizar_periodo_pagamento: "Período finalizado",
    reativar_periodo_pagamento: "Período reativado",
    excluir_periodo_pagamento: "Período excluído",
    upload_pdf: "Espelho enviado",
    substituir_pdf: "Espelho substituído",
    excluir_pdf: "Espelho removido",
    review_period_base_upload: "Base do período revisada"
  };

  return (
    labels[action] ||
    action
      .split("_")
      .filter(Boolean)
      .map((part, index) => (index === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
      .join(" ")
  );
}

function resolveActivityTitle(entity: string, action: string, details: unknown) {
  const parsedDetails = readDetails(details);
  const fileName = readDetailString(parsedDetails, "arquivo", "fileName", "nomeArquivo");
  const periodName = readDetailString(parsedDetails, "nome", "periodoNome");
  const motoristaName = readDetailString(parsedDetails, "nomeMotorista", "motoristaNome");

  if (action === "criar_periodo_pagamento") {
    return periodName ? `Período criado: ${periodName}` : "Período de pagamento criado";
  }

  if (action === "editar_periodo_pagamento") {
    return periodName ? `Período alterado: ${periodName}` : "Período de pagamento alterado";
  }

  if (action === "alterar_status_periodo_pagamento") {
    return periodName ? `Status do período alterado: ${periodName}` : "Status do período alterado";
  }

  if (action === "finalizar_periodo_pagamento") {
    return periodName ? `Período finalizado: ${periodName}` : "Período finalizado";
  }

  if (action === "reativar_periodo_pagamento") {
    return periodName ? `Período reativado: ${periodName}` : "Período reativado";
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
      return `Histórico do período: ${periodName}`;
    }

    if ((entity === "upload_pdf" || entity === "driver_pdf_received") && fileName) {
      return `Histórico do arquivo: ${fileName}`;
    }

    if (motoristaName) {
      return `Histórico do motorista: ${motoristaName}`;
    }

    return `Histórico ${entity.replace(/_/g, " ")}`;
  }

  if (fileName) {
    return `${humanizeAction(action)}: ${fileName}`;
  }

  return `${humanizeAction(action)} em ${entity.replace(/_/g, " ")}`;
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

function buildUploadScopeKeyFromReceipt(
  upload: { id: string; motoristaId: string | null; basePagamentoId: string | null },
  receiptsByUploadId: Map<string, Array<{ motoristaId: string | null; basePagamentoId: string | null }>>
) {
  const receipt = receiptsByUploadId.get(upload.id)?.find((item) => item.motoristaId || item.basePagamentoId);

  return `${upload.motoristaId || receipt?.motoristaId || upload.id}|${
    upload.basePagamentoId || receipt?.basePagamentoId || "sem-base"
  }`;
}

function buildReceiptScopeKey(
  receipt: { id: string; motoristaId: string | null; basePagamentoId: string | null; uploadPdfId: string | null },
  uploadById: Map<string, { id: string; motoristaId: string | null; basePagamentoId: string | null }>
) {
  const upload = receipt.uploadPdfId ? uploadById.get(receipt.uploadPdfId) : null;

  return `${receipt.motoristaId || upload?.motoristaId || receipt.uploadPdfId || receipt.id}|${
    receipt.basePagamentoId || upload?.basePagamentoId || "sem-base"
  }`;
}

function isNotaFiscalReceipt(receipt: { status: string; documentType: string | null; tipoArquivo: string | null }) {
  const type = `${receipt.documentType || ""} ${receipt.tipoArquivo || ""}`.toLowerCase();

  if (type.includes("nota")) {
    return true;
  }

  return ["nota_fiscal_recebida", "nota_fiscal_em_analise", "nota_fiscal_aprovada", "nota_fiscal_rejeitada"].includes(
    receipt.status
  );
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

    const periodIds = recentPeriods.map((period) => period.id);
    const directPeriodReceipts = await prisma.driverPdfReceived.findMany({
      where: {
        periodoPagamentoId: { in: periodIds }
      },
      select: {
        id: true,
        periodoPagamentoId: true,
        uploadPdfId: true,
        motoristaId: true,
        basePagamentoId: true,
        status: true,
        documentType: true,
        tipoArquivo: true
      }
    });
    const directReceiptUploadIds = Array.from(
      new Set(directPeriodReceipts.map((receipt) => receipt.uploadPdfId).filter((value): value is string => Boolean(value)))
    );
    const periodUploads = await prisma.uploadPdf.findMany({
      where: {
        OR: [{ periodoPagamentoId: { in: periodIds } }, { id: { in: directReceiptUploadIds } }],
        status: { not: "removido" }
      },
      select: {
        id: true,
        periodoPagamentoId: true,
        motoristaId: true,
        basePagamentoId: true,
        substituiUploadId: true,
        statusPagamento: true,
        documentType: true
      }
    });
    const uploadById = new Map(periodUploads.map((upload) => [upload.id, upload] as const));
    const uploadIds = periodUploads.map((upload) => upload.id);
    const periodReceipts = await prisma.driverPdfReceived.findMany({
      where: {
        OR: [{ periodoPagamentoId: { in: periodIds } }, { uploadPdfId: { in: uploadIds } }]
      },
      select: {
        id: true,
        periodoPagamentoId: true,
        uploadPdfId: true,
        motoristaId: true,
        basePagamentoId: true,
        status: true,
        documentType: true,
        tipoArquivo: true
      }
    });
    const childUploadIds = new Set(
      periodUploads.map((upload) => upload.substituiUploadId).filter((value): value is string => Boolean(value))
    );
    const periodIdByUploadId = new Map<string, string>();
    const receiptsByUploadId = new Map<string, Array<(typeof periodReceipts)[number]>>();

    for (const receipt of periodReceipts) {
      if (!receipt.uploadPdfId) {
        continue;
      }

      const current = receiptsByUploadId.get(receipt.uploadPdfId) || [];
      current.push(receipt);
      receiptsByUploadId.set(receipt.uploadPdfId, current);

      if (receipt.periodoPagamentoId && periodIds.includes(receipt.periodoPagamentoId)) {
        periodIdByUploadId.set(receipt.uploadPdfId, receipt.periodoPagamentoId);
      }
    }

    const latestUploadsByPeriod = new Map<string, Map<string, (typeof periodUploads)[number]>>();

    for (const upload of periodUploads) {
      if (childUploadIds.has(upload.id) || upload.documentType === "nota_fiscal") {
        continue;
      }

      const periodId = upload.periodoPagamentoId || periodIdByUploadId.get(upload.id);
      if (!periodId) {
        continue;
      }

      const current = latestUploadsByPeriod.get(periodId) || new Map<string, (typeof periodUploads)[number]>();
      current.set(buildUploadScopeKeyFromReceipt(upload, receiptsByUploadId), upload);
      latestUploadsByPeriod.set(periodId, current);
    }

    const notesByPeriodId = new Map<string, Set<string>>();

    for (const receipt of periodReceipts) {
      if (!isNotaFiscalReceipt(receipt)) {
        continue;
      }

      const upload = receipt.uploadPdfId ? uploadById.get(receipt.uploadPdfId) : null;
      const periodId = receipt.periodoPagamentoId || upload?.periodoPagamentoId;

      if (!periodId) {
        continue;
      }

      const current = notesByPeriodId.get(periodId) || new Set<string>();
      current.add(buildReceiptScopeKey(receipt, uploadById));
      notesByPeriodId.set(periodId, current);
    }

    const periodSummaries = recentPeriods.map((period) => {
      const periodUploadMap = latestUploadsByPeriod.get(period.id) || new Map<string, (typeof periodUploads)[number]>();
      const pdfsSent = periodUploadMap.size;
      const notesReceived = notesByPeriodId.get(period.id)?.size || 0;
      const paidDrivers = Array.from(periodUploadMap.values()).filter((upload) => upload.statusPagamento === "PAGO")
        .length;

      return {
        id: period.id,
        name: period.nome,
        startDate: toIso(period.dataInicio),
        endDate: toIso(period.dataFim),
        status: period.status,
        pdfsSent,
        notesReceived,
        notesPending: Math.max(pdfsSent - notesReceived, 0),
        paidDrivers
      };
    });

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
