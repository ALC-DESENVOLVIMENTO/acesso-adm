import { prisma } from "./prisma.js";

type TimestampSource = Date | null | undefined;

const BACKFILL_PREFIX = "dashboard_backfill_";

function latestDate(...values: TimestampSource[]) {
  let latest: Date | null = null;

  for (const value of values) {
    if (!value) {
      continue;
    }

    if (!latest || value > latest) {
      latest = value;
    }
  }

  return latest;
}

function formatBackfillAction(entity: string) {
  return `${BACKFILL_PREFIX}${entity}`;
}

function buildBackfillKey(action: string, entityId: string | null) {
  return `${action}:${entityId || ""}`;
}

export async function backfillDashboardHistoryRecords() {
  const [periods, uploadGroups, driverGroups, uploads, driverReceipts, existingBackfillLogs] = await Promise.all([
    prisma.periodoPagamento.findMany({
      select: {
        id: true,
        nome: true,
        dataInicio: true,
        dataFim: true,
        criadoEm: true,
        atualizadoEm: true
      }
    }),
    prisma.uploadPdf.groupBy({
      by: ["periodoPagamentoId"],
      where: {
        status: {
          not: "removido"
        },
        periodoPagamentoId: {
          not: null
        }
      },
      _count: {
        _all: true
      },
      _max: {
        criadoEm: true
      }
    }),
    prisma.driverPdfReceived.groupBy({
      by: ["periodoPagamentoId"],
      where: {
        periodoPagamentoId: {
          not: null
        }
      },
      _max: {
        uploadEm: true,
        visualizadoEm: true,
        enviadoAoMotoristaEm: true,
        aprovadoEm: true,
        rejeitadoEm: true,
        sentAt: true,
        openedAt: true,
        atualizadoEm: true
      }
    }),
    prisma.uploadPdf.findMany({
      where: {
        status: {
          not: "removido"
        }
      },
      select: {
        id: true,
        nomeArquivo: true,
        nomeOriginal: true,
        criadoEm: true,
        periodoPagamentoId: true,
        basePagamentoId: true,
        motoristaId: true,
        status: true,
        documentType: true
      }
    }),
    prisma.driverPdfReceived.findMany({
      select: {
        id: true,
        nomeArquivo: true,
        nomeOriginalLegacy: true,
        uploadEm: true,
        visualizadoEm: true,
        enviadoAoMotoristaEm: true,
        aprovadoEm: true,
        rejeitadoEm: true,
        sentAt: true,
        openedAt: true,
        periodoPagamentoId: true,
        basePagamentoId: true,
        motoristaId: true,
        status: true,
        fullName: true,
        motoristaNome: true
      }
    }),
    prisma.logAuditoria.findMany({
      where: {
        acao: {
          startsWith: BACKFILL_PREFIX
        }
      },
      select: {
        acao: true,
        entidadeId: true
      }
    })
  ]);

  const existingKeys = new Set(
    existingBackfillLogs.map((log) => buildBackfillKey(log.acao, log.entidadeId))
  );

  const uploadMaxByPeriod = new Map<string, Date>();
  for (const group of uploadGroups) {
    if (group.periodoPagamentoId && group._max.criadoEm) {
      uploadMaxByPeriod.set(group.periodoPagamentoId, group._max.criadoEm);
    }
  }

  const driverMaxByPeriod = new Map<string, Date>();
  for (const group of driverGroups) {
    if (!group.periodoPagamentoId) {
      continue;
    }

    const latest = latestDate(
      group._max.uploadEm,
      group._max.visualizadoEm,
      group._max.enviadoAoMotoristaEm,
      group._max.aprovadoEm,
      group._max.rejeitadoEm,
      group._max.sentAt,
      group._max.openedAt,
      group._max.atualizadoEm
    );

    if (latest) {
      driverMaxByPeriod.set(group.periodoPagamentoId, latest);
    }
  }

  const periodUpdates = periods.flatMap((period) => {
    const latest = latestDate(period.atualizadoEm, period.criadoEm, uploadMaxByPeriod.get(period.id), driverMaxByPeriod.get(period.id));

    if (!latest || latest <= period.atualizadoEm) {
      return [];
    }

    return [
      prisma.periodoPagamento.update({
        where: {
          id: period.id
        },
        data: {
          atualizadoEm: latest
        }
      })
    ];
  });

  const backfillLogs = [];

  for (const period of periods) {
    const latest = latestDate(period.atualizadoEm, period.criadoEm, uploadMaxByPeriod.get(period.id), driverMaxByPeriod.get(period.id));
    const action = formatBackfillAction("periodo_pagamento");
    const key = buildBackfillKey(action, period.id);

    if (!existingKeys.has(key) && latest) {
      backfillLogs.push({
        acao: action,
        entidade: "periodo_pagamento",
        entidadeId: period.id,
        detalhes: {
          source: "periodo_pagamento",
          backfill: true,
          nome: period.nome,
          dataInicio: period.dataInicio?.toISOString() ?? null,
          dataFim: period.dataFim?.toISOString() ?? null,
          periodoPagamentoId: period.id,
          ultimaAtividadeEm: latest.toISOString()
        },
        criadoEm: latest
      });
    }
  }

  for (const upload of uploads) {
    const action = formatBackfillAction("upload_pdf");
    const key = buildBackfillKey(action, upload.id);

    if (existingKeys.has(key)) {
      continue;
    }

    backfillLogs.push({
      acao: action,
      entidade: "upload_pdf",
      entidadeId: upload.id,
      detalhes: {
        source: "upload_pdf",
        backfill: true,
        nomeArquivo: upload.nomeArquivo,
        nomeOriginal: upload.nomeOriginal,
        periodoPagamentoId: upload.periodoPagamentoId,
        basePagamentoId: upload.basePagamentoId,
        motoristaId: upload.motoristaId,
        status: upload.status,
        documentType: upload.documentType
      },
      criadoEm: upload.criadoEm
    });
  }

  for (const receipt of driverReceipts) {
    const latest = latestDate(
      receipt.uploadEm,
      receipt.visualizadoEm,
      receipt.enviadoAoMotoristaEm,
      receipt.aprovadoEm,
      receipt.rejeitadoEm,
      receipt.sentAt,
      receipt.openedAt
    );

    if (!latest) {
      continue;
    }

    const action = formatBackfillAction("driver_pdf_received");
    const key = buildBackfillKey(action, receipt.id);

    if (existingKeys.has(key)) {
      continue;
    }

    backfillLogs.push({
      acao: action,
      entidade: "driver_pdf_received",
      entidadeId: receipt.id,
      detalhes: {
        source: "driver_pdf_received",
        backfill: true,
        nomeArquivo: receipt.nomeArquivo || receipt.nomeOriginalLegacy,
        periodoPagamentoId: receipt.periodoPagamentoId,
        basePagamentoId: receipt.basePagamentoId,
        motoristaId: receipt.motoristaId,
        nomeMotorista: receipt.fullName || receipt.motoristaNome,
        status: receipt.status,
        ultimaAtividadeEm: latest.toISOString()
      },
      criadoEm: latest
    });
  }

  const insertedBackfillLogs = backfillLogs.length
    ? await prisma.logAuditoria.createMany({
        data: backfillLogs
      })
    : { count: 0 };

  if (periodUpdates.length > 0) {
    await Promise.all(periodUpdates);
  }

  return {
    periodosAtualizados: periodUpdates.length,
    logsInseridos: insertedBackfillLogs.count
  };
}
