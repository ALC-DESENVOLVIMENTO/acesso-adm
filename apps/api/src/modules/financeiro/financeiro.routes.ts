import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireModuleAccess } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";
import { buildStorageObjectUrl } from "../../lib/storage.js";
import { upsertDriverPdfReceivedFromUpload } from "../../lib/driver-pdf-received.js";

const router = Router();

router.use(requireAuth, requireModuleAccess("financeiro"));

const listFiltersSchema = z.object({
  periodId: z.string().uuid().optional(),
  baseId: z.string().uuid().optional(),
  search: z.string().trim().optional(),
  cpf: z.string().trim().optional(),
  status: z
    .enum([
      "todos",
      "pdf_aguardando_envio",
      "pdf_enviado_ao_motorista",
      "motorista_visualizou",
      "aguardando_envio_nota_fiscal",
      "nota_fiscal_recebida",
      "nota_fiscal_em_analise",
      "nota_fiscal_aprovada",
      "nota_fiscal_rejeitada",
      "em_atendimento",
      "chamado_aberto",
      "processo_concluido"
    ])
    .optional()
});

function toIso(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function formatStatusLabel(value: string) {
  const labels: Record<string, string> = {
    pdf_aguardando_envio: "PDF aguardando envio ao motorista",
    pdf_enviado_ao_motorista: "PDF enviado ao motorista",
    motorista_visualizou: "Motorista visualizou o PDF",
    aguardando_envio_nota_fiscal: "Aguardando envio da Nota Fiscal",
    nota_fiscal_recebida: "Nota Fiscal recebida",
    nota_fiscal_em_analise: "Nota Fiscal em análise",
    nota_fiscal_aprovada: "Nota Fiscal aprovada",
    nota_fiscal_rejeitada: "Nota Fiscal rejeitada",
    em_atendimento: "Em atendimento via Chat",
    chamado_aberto: "Chamado aberto",
    processo_concluido: "Processo concluído"
  };

  return labels[value] || value;
}

function toDateOnlyString(value: Date) {
  return new Date(value.getTime() + value.getTimezoneOffset() * 60_000).toISOString().split("T")[0];
}

function countUnique(values: Array<string | null | undefined>) {
  return new Set(values.filter((item): item is string => Boolean(item))).size;
}

type SummaryUploadRecord = {
  id: string;
  motoristaId: string | null;
  periodoPagamentoId: string | null;
  basePagamentoId: string | null;
  nomeOriginal: string;
  caminhoArquivo: string;
  criadoEm: Date;
  usuarioId: string;
  substituiUploadId: string | null;
};

async function syncApprovedDriverPdfReceipts(
  periods: Array<{ id: string; status: string }>,
  uploads: SummaryUploadRecord[]
) {
  const approvedPeriodIds = new Set(periods.filter((period) => period.status === "aprovado").map((period) => period.id));

  if (approvedPeriodIds.size === 0) {
    return;
  }

  const groupedByPeriod = new Map<string, Map<string, SummaryUploadRecord>>();

  const childReferences = new Set(
    uploads.map((item) => item.substituiUploadId).filter((value): value is string => Boolean(value))
  );

  for (const upload of [...uploads].sort((left, right) => right.criadoEm.getTime() - left.criadoEm.getTime())) {
    if (!upload.periodoPagamentoId || !approvedPeriodIds.has(upload.periodoPagamentoId)) {
      continue;
    }

    if (!upload.motoristaId || !upload.basePagamentoId || childReferences.has(upload.id)) {
      continue;
    }

    const periodMap = groupedByPeriod.get(upload.periodoPagamentoId) || new Map<string, SummaryUploadRecord>();
    const key = `${upload.motoristaId}|${upload.basePagamentoId}`;

    if (!periodMap.has(key)) {
      periodMap.set(key, upload);
    }

    groupedByPeriod.set(upload.periodoPagamentoId, periodMap);
  }

  for (const [periodId, periodUploads] of groupedByPeriod.entries()) {
    await Promise.all(
      Array.from(periodUploads.values()).map((upload) =>
        upsertDriverPdfReceivedFromUpload({
          uploadPdfId: upload.id,
          motoristaId: upload.motoristaId as string,
          periodId,
          basePaymentId: upload.basePagamentoId as string,
          fileName: upload.nomeOriginal,
          storageKey: upload.caminhoArquivo,
          createdByUserId: upload.usuarioId
        })
      )
    );
  }
}

const receivedNoteStatuses = new Set([
  "nota_fiscal_recebida",
  "nota_fiscal_em_analise",
  "nota_fiscal_aprovada",
  "nota_fiscal_rejeitada",
  "processo_concluido"
]);

function computeAttendanceStatus(ticketStatuses: string[], attendanceCount: number) {
  if (ticketStatuses.some((status) => status === "em_andamento")) {
    return "Em atendimento";
  }

  if (ticketStatuses.some((status) => status === "aberto")) {
    return attendanceCount > 0 ? "Em atendimento" : "Chamado aberto";
  }

  if (ticketStatuses.some((status) => status === "aguardando" || status === "aguardando_motorista")) {
    return "Aguardando retorno";
  }

  if (ticketStatuses.some((status) => status === "resolvido" || status === "concluido")) {
    return "Atendimento encerrado";
  }

  return attendanceCount > 0 ? "Atendimento encerrado" : "Aguardando retorno";
}

router.get("/summary", (_req, res) => {
  void (async () => {
    const [periods, bases, uploads] = await Promise.all([
      prisma.periodoPagamento.findMany({
        select: {
          id: true,
          status: true,
          bases: {
            select: {
              id: true
            }
          }
        }
      }),
      prisma.basePagamento.count({
        where: {
          ativo: true
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
          substituiUploadId: true,
          motoristaId: true,
          periodoPagamentoId: true,
          basePagamentoId: true,
          nomeOriginal: true,
          caminhoArquivo: true,
          criadoEm: true,
          usuarioId: true
        }
      })
    ]);

    await syncApprovedDriverPdfReceipts(periods, uploads);

    const receivedRows = await prisma.driverPdfReceived.findMany({
      select: {
        motoristaId: true,
        status: true
      }
    });

    const childReferences = new Set(
      uploads.map((item) => item.substituiUploadId).filter((value): value is string => Boolean(value))
    );
    const visibleUploads = uploads.filter((item) => !childReferences.has(item.id));
    const sentMotoristas = countUnique(visibleUploads.map((item) => item.motoristaId));
    const completedMotoristas = countUnique(
      receivedRows.filter((item) => receivedNoteStatuses.has(item.status)).map((item) => item.motoristaId)
    );
    const analysisStatuses = new Set(["nota_fiscal_em_analise"]);
    const rejectedStatuses = new Set(["nota_fiscal_rejeitada"]);
    const attendanceStatuses = new Set(["em_atendimento", "chamado_aberto"]);
    const concludedStatuses = new Set(["processo_concluido"]);

    res.json({
      activePeriods: periods.filter((period) => period.status !== "aprovado").length,
      bases,
      motoristas: countUnique([...visibleUploads.map((item) => item.motoristaId), ...receivedRows.map((item) => item.motoristaId)]),
      pdfsSent: sentMotoristas,
      notesReceived: completedMotoristas,
      notesPending: Math.max(sentMotoristas - completedMotoristas, 0),
      inAnalysis: countUnique(receivedRows.filter((item) => analysisStatuses.has(item.status)).map((item) => item.motoristaId)),
      rejected: countUnique(receivedRows.filter((item) => rejectedStatuses.has(item.status)).map((item) => item.motoristaId)),
      inAttendance: countUnique(receivedRows.filter((item) => attendanceStatuses.has(item.status)).map((item) => item.motoristaId)),
      concluded: countUnique(receivedRows.filter((item) => concludedStatuses.has(item.status)).map((item) => item.motoristaId))
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao carregar indicadores financeiros.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/periods/:periodId/bases", (req, res) => {
  void (async () => {
    const periodId = String(req.params.periodId || "").trim();

    const period = await prisma.periodoPagamento.findUnique({
      where: {
        id: periodId
      },
      include: {
        bases: {
          include: {
            basePagamento: true
          }
        },
        uploads: {
          select: {
            id: true,
            motoristaId: true,
            basePagamentoId: true,
            status: true,
            substituiUploadId: true
          }
        },
        pdfsRecebidos: {
          select: {
            motoristaId: true,
            basePagamentoId: true,
            status: true
          }
        }
      }
    });

    if (!period) {
      res.status(404).json({
        message: "Periodo nao encontrado."
      });
      return;
    }

    const childReferences = new Set(period.uploads.map((item) => item.substituiUploadId).filter(Boolean) as string[]);
    const visibleUploads = period.uploads.filter((item) => !childReferences.has(item.id));

    const bases = period.bases.map((periodBase) => {
      const baseId = periodBase.basePagamento.id;
      const baseUploads = visibleUploads.filter((item) => item.basePagamentoId === baseId);
      const baseRecebidos = period.pdfsRecebidos.filter((item) => item.basePagamentoId === baseId);
      const completedBaseRecebidos = baseRecebidos.filter((item) => receivedNoteStatuses.has(item.status));
      const motoristas = countUnique([
        ...baseUploads.map((item) => item.motoristaId),
        ...baseRecebidos.map((item) => item.motoristaId)
      ]);
      const pdfsSent = countUnique(baseUploads.map((item) => item.motoristaId));
      const pdfsPending = countUnique(baseUploads.filter((item) => item.status === "pendente").map((item) => item.motoristaId));
      const notesReceived = countUnique(completedBaseRecebidos.map((item) => item.motoristaId));

      return {
        id: baseId,
        name: periodBase.basePagamento.nome,
        paymentType: periodBase.basePagamento.tipoPadrao,
        motoristas,
        pdfsSent,
        pdfsPending,
        notesReceived,
        notesPending: Math.max(pdfsSent - notesReceived, 0)
      };
    });

    res.json(bases);
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao carregar bases do periodo.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/periods/:periodId/bases/:baseId/motoristas", (req, res) => {
  void (async () => {
    const parsed = listFiltersSchema.safeParse({
      periodId: req.params.periodId,
      baseId: req.params.baseId,
      search: req.query.search,
      cpf: req.query.cpf,
      status: req.query.status
    });

    if (!parsed.success) {
      res.status(400).json({
        message: "Parametros invalidos para listar motoristas.",
        issues: parsed.error.flatten()
      });
      return;
    }

    const { periodId, baseId, search, cpf, status } = parsed.data;

    const records = await prisma.driverPdfReceived.findMany({
      where: {
        periodoPagamentoId: periodId,
        basePagamentoId: baseId,
        ...(status && status !== "todos" ? { status } : {}),
        ...(search || cpf
          ? {
              OR: [
                search
                  ? {
                      motorista: {
                        nome: {
                          contains: search,
                          mode: "insensitive"
                        }
                      }
                    }
                  : undefined,
                search
                  ? {
                      motorista: {
                        cpf: {
                          contains: search.replace(/\D/g, "")
                        }
                      }
                    }
                  : undefined,
                cpf
                  ? {
                      motorista: {
                        cpf: {
                          contains: cpf.replace(/\D/g, "")
                        }
                      }
                    }
                  : undefined
              ].filter(Boolean) as Array<Record<string, unknown>>
            }
          : {})
      },
      include: {
        motorista: {
          select: {
            id: true,
            nome: true,
            cpf: true,
            statusCadastro: true,
            cidade: true,
            estado: true,
            empresaVinculada: true,
            atendimentos: {
              select: {
                id: true
              }
            },
            chamados: {
              select: {
                status: true
              }
            }
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
        },
        usuario: {
          select: {
            nome: true
          }
        },
        aprovador: {
          select: {
            nome: true
          }
        },
        rejeitador: {
          select: {
            nome: true
          }
        }
      },
      orderBy: {
        atualizadoEm: "desc"
      }
    });

    const mapped = records.flatMap((row) => {
      if (!row.motorista || !row.basePagamento || !row.periodoPagamento) {
        return [];
      }

      const ticketStatuses = row.motorista.chamados.map((item) => item.status);
      const attendanceStatus = computeAttendanceStatus(ticketStatuses, row.motorista.atendimentos.length);

      return {
        id: row.id,
        motoristaId: row.motoristaId,
        nome: row.motorista.nome,
        cpf: row.motorista.cpf,
        base: row.basePagamento.nome,
        periodoPagamento: row.periodoPagamento.nome,
        pdfEnviadoEm: toIso(row.enviadoAoMotoristaEm || row.uploadEm),
        pdfVisualizadoEm: toIso(row.visualizadoEm),
        notaFiscalEnviadaEm: toIso(row.uploadEm),
        notaFiscalRecebidaEm: row.status === "nota_fiscal_recebida" ? toIso(row.uploadEm) : null,
        status: row.status,
        statusLabel: formatStatusLabel(row.status),
        situacaoAtendimento: attendanceStatus,
        ultimaAtualizacao: toIso(row.atualizadoEm),
        atendimentoStatus: attendanceStatus,
        statusNotaFiscal:
          row.status === "nota_fiscal_rejeitada"
            ? "Rejeitada"
            : row.status === "nota_fiscal_aprovada"
              ? "Aprovada"
              : row.status === "nota_fiscal_em_analise"
                ? "Em análise"
                : row.status === "nota_fiscal_recebida"
                  ? "Recebida"
                  : "Pendente",
        caminhoArquivo: buildStorageObjectUrl(row.caminhoArquivo)
      };
    });

    res.json(mapped);
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao listar motoristas do periodo financeiro.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

export default router;
