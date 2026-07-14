import archiver from "archiver";
import crypto from "node:crypto";
import { FinanceiroImportacaoItemResultado, FinanceiroImportacaoStatus, FinanceiroStatusPagamento, UploadStatus } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { requireAuth, requireModuleAccess } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";
import { buildStorageObjectUrl, fetchObjectBuffer, isPaymentMirrorStorageKey } from "../../lib/storage.js";
import { loadDriverPdfReceivedContent } from "../../lib/driver-pdf-received-content.js";
import {
  isDriverPdfMirrorStatus,
  isDriverPdfNoteStatus,
  upsertDriverPdfReceivedFromUpload
} from "../../lib/driver-pdf-received.js";
import {
  confirmFinanceiroImport,
  createFinanceiroImportPreview,
  listFinanceiroHistorico,
  listFinanceiroImportacoes
} from "./financeiro-import.js";
import { notifyPaymentStatusToPdfOnline } from "../../lib/pdfonline-bridge.js";

const router = Router();
const financeImportUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, callback) => {
    const lower = file.originalname.toLowerCase();
    const isExcel =
      lower.endsWith(".xlsx") ||
      lower.endsWith(".xls") ||
      file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel";
    callback(null, isExcel);
  }
});

router.use(requireAuth, requireModuleAccess("financeiro"));

const listFiltersSchema = z.object({
  periodId: z.string().uuid().optional(),
  baseId: z.string().trim().min(1).optional(),
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
      "pago",
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
    pdf_aprovado: "PDF aprovado",
    pdf_aguardando_envio: "PDF aguardando envio ao motorista",
    pdf_enviado_ao_motorista: "PDF enviado ao motorista",
    motorista_visualizou: "PDF visualizado",
    aguardando_envio_nota_fiscal: "Aguardando envio da Nota Fiscal",
    pago: "Pago",
    nota_fiscal_recebida: "Nota Fiscal recebida",
    nota_fiscal_em_analise: "Nota Fiscal em an?lise",
    nota_fiscal_aprovada: "Nota Fiscal aprovada",
    nota_fiscal_rejeitada: "Nota Fiscal recusada",
    em_atendimento: "Em atendimento",
    chamado_aberto: "Chamado aberto",
    processo_concluido: "Processo conclu?do"
  };

  return labels[value] || value;
}

function toDateOnlyString(value: Date) {
  return new Date(value.getTime() + value.getTimezoneOffset() * 60_000).toISOString().split("T")[0];
}

function countUnique(values: Array<string | null | undefined>) {
  return new Set(values.filter((item): item is string => Boolean(item))).size;
}

function isNoteStatus(status: string | null | undefined) {
  return Boolean(
    status &&
      new Set([
        "nota_fiscal_recebida",
        "nota_fiscal_em_analise",
        "nota_fiscal_aprovada",
        "nota_fiscal_rejeitada",
        "processo_concluido"
      ]).has(status)
  );
}

function isMirrorUploadStatus(status: string | null | undefined) {
  return isDriverPdfMirrorStatus(status);
}

function isNoteReceiptStatus(status: string | null | undefined) {
  return isDriverPdfNoteStatus(status);
}

function resolvePdfStatus(periodStatus: string | null | undefined, uploadStatus: string | null | undefined) {
  if (uploadStatus === "removido") {
    return "pdf_aguardando_envio";
  }

  if (periodStatus === "aprovado") {
    return "pdf_enviado_ao_motorista";
  }

  if (uploadStatus === "processado") {
    return "pdf_enviado_ao_motorista";
  }

  return "pdf_aguardando_envio";
}

function normalizeScopeBaseId(baseId: string | null | undefined) {
  const value = String(baseId || "").trim();

  if (!value || value === "all") {
    return null;
  }

  return value;
}

function sanitizeArchiveSegment(value: string) {
  return (
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_{2,}/g, "_") || "sem-nome"
  );
}

function buildExportPath(periodName: string, baseName: string, motoristaName: string) {
  return [
    sanitizeArchiveSegment(periodName),
    sanitizeArchiveSegment(baseName),
    sanitizeArchiveSegment(motoristaName),
    "NotaFiscal.pdf"
  ].join("/");
}

function escapeCsv(value: string) {
  const normalized = String(value || "");

  if (/["\n,;]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }

  return normalized;
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
  status: string;
  substituiUploadId: string | null;
};

type MotoristaUploadRecord = SummaryUploadRecord & {
  motorista: {
    id: string;
    nome: string;
    cpf: string;
    statusCadastro: string;
    cidade: string | null;
    estado: string | null;
    empresaVinculada: string | null;
    atendimentos: Array<{ id: string }>;
    chamados: Array<{ status: string }>;
  } | null;
  periodoPagamento: {
    nome: string;
  } | null;
  basePagamento: {
    nome: string;
  } | null;
  usuario: {
    nome: string;
  };
};

type ReceivedRecord = {
  id?: string;
  uploadPdfId?: string | null;
  motoristaId?: string | null;
  periodoPagamentoId?: string | null;
  basePagamentoId?: string | null;
  status: string;
  uploadEm?: Date;
  enviadoAoMotoristaEm?: Date | null;
  visualizadoEm?: Date | null;
  aprovadoEm?: Date | null;
  rejeitadoEm?: Date | null;
  motivoRejeicao?: string | null;
  observacoes?: string | null;
  caminhoArquivo?: string | null;
  nomeArquivo?: string | null;
};

type ReceivedScopeRecord = {
  id: string;
  motoristaId: string | null;
  periodoPagamentoId?: string | null;
  basePagamentoId: string | null;
};

function resolveReceivedScope(
  receipt: ReceivedRecord,
  uploadById: Map<string, ReceivedScopeRecord>
) {
  const sourceUpload = receipt.uploadPdfId ? uploadById.get(receipt.uploadPdfId) || null : null;

  return {
    motoristaId: receipt.motoristaId ?? sourceUpload?.motoristaId ?? null,
    periodoPagamentoId: receipt.periodoPagamentoId ?? sourceUpload?.periodoPagamentoId ?? null,
    basePagamentoId: receipt.basePagamentoId ?? sourceUpload?.basePagamentoId ?? null
  };
}

function filterVisibleUploads<T extends { id: string; caminhoArquivo: string | null; substituiUploadId: string | null; status?: string }>(uploads: T[]) {
  const mirrorUploads = uploads.filter((item) => isPaymentMirrorStorageKey(item.caminhoArquivo));
  const childReferences = new Set(
    mirrorUploads.map((item) => item.substituiUploadId).filter((value): value is string => Boolean(value))
  );

  return mirrorUploads.filter((item) => !childReferences.has(item.id) && item.status !== "removido");
}

function pickLatestReceived(
  receivedRows: ReceivedRecord[],
  upload: MotoristaUploadRecord,
  uploadById: Map<string, ReceivedScopeRecord> = new Map()
) {
  if (!upload.motoristaId || !upload.periodoPagamentoId || !upload.basePagamentoId) {
    return null;
  }

  const byUpload = receivedRows.find((item) => item.uploadPdfId && item.uploadPdfId === upload.id);

  if (byUpload) {
    return byUpload;
  }

  return (
    receivedRows
      .filter(
        (item) => {
          const scope = resolveReceivedScope(item, uploadById);

          return (
            scope.motoristaId === upload.motoristaId &&
            scope.periodoPagamentoId === upload.periodoPagamentoId &&
            scope.basePagamentoId === upload.basePagamentoId
          );
        }
      )
      .sort(
        (left, right) =>
          (right.uploadEm?.getTime() ?? 0) - (left.uploadEm?.getTime() ?? 0)
      )[0] || null
  );
}

function dedupeLatestUploadsByMotorista<T extends { id: string; caminhoArquivo: string | null; motoristaId: string | null; basePagamentoId?: string | null; criadoEm: Date; substituiUploadId: string | null; status?: string }>(
  uploads: T[]
) {
  const visibleUploads = filterVisibleUploads(uploads);
  const latestByMotorista = new Map<string, T>();

  for (const upload of [...visibleUploads].sort((left, right) => right.criadoEm.getTime() - left.criadoEm.getTime())) {
    if (!upload.motoristaId) {
      continue;
    }

    if (!latestByMotorista.has(upload.motoristaId)) {
      latestByMotorista.set(upload.motoristaId, upload);
    }
  }

  return {
    visibleUploads,
    latestUploads: Array.from(latestByMotorista.values())
  };
}

async function syncApprovedDriverPdfReceipts(
  periods: Array<{ id: string; status: string }>,
  uploads: SummaryUploadRecord[]
) {
  const approvedPeriodIds = new Set(periods.filter((period) => period.status === "aprovado").map((period) => period.id));

  if (approvedPeriodIds.size === 0) {
    return;
  }

  const groupedByPeriod = new Map<string, Map<string, SummaryUploadRecord>>();

  const mirrorUploads = uploads.filter((item) => isPaymentMirrorStorageKey(item.caminhoArquivo));
  const childReferences = new Set(
    mirrorUploads.map((item) => item.substituiUploadId).filter((value): value is string => Boolean(value))
  );

  for (const upload of [...mirrorUploads].sort((left, right) => right.criadoEm.getTime() - left.criadoEm.getTime())) {
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

function readPayloadString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];

  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  return text ? text : null;
}

async function dispatchWebhookEvent(eventId: string) {
  const event = await prisma.webhookEvento.findUnique({
    where: {
      eventId
    }
  });

  if (!event) {
    throw new Error("Evento de webhook nao encontrado.");
  }

  const payload = event.payload as Record<string, unknown>;

  await prisma.webhookEvento.update({
    where: {
      eventId
    },
    data: {
      status: "processando",
      tentativas: {
        increment: 1
      },
      ultimaTentativaEm: new Date()
    }
  });

  try {
    const result = await notifyPaymentStatusToPdfOnline({
      event: readPayloadString(payload, "event") || "pagamento.status_atualizado",
      event_id: readPayloadString(payload, "event_id") || event.eventId,
      occurred_at: readPayloadString(payload, "occurred_at") || new Date().toISOString(),
      pagamento_id: readPayloadString(payload, "pagamento_id") || event.pagamentoId || "",
      espelho_pagamento_id:
        readPayloadString(payload, "espelho_pagamento_id") ||
        readPayloadString(payload, "pagamento_id") ||
        event.pagamentoId ||
        "",
      nota_fiscal_id: readPayloadString(payload, "nota_fiscal_id"),
      pdfonline_id: readPayloadString(payload, "pdfonline_id"),
      motorista_id: readPayloadString(payload, "motorista_id"),
      cpf_cnpj: readPayloadString(payload, "cpf_cnpj"),
      periodo_pagamento_id: readPayloadString(payload, "periodo_pagamento_id"),
      lote_id: readPayloadString(payload, "lote_id"),
      status_anterior: readPayloadString(payload, "status_anterior"),
      status_atual: readPayloadString(payload, "status_atual") || "",
      motivo: readPayloadString(payload, "motivo"),
      codigo_obb: readPayloadString(payload, "codigo_obb"),
      origem_status: readPayloadString(payload, "origem_status"),
      origem: readPayloadString(payload, "origem") || "IMPORTACAO_PLANILHA_FINANCEIRA",
      importacao_id: readPayloadString(payload, "importacao_id") || event.importacaoId || null,
      linha_planilha: Number(readPayloadString(payload, "linha_planilha") || 0) || null
    });

    await prisma.webhookEvento.update({
      where: {
        eventId
      },
      data: {
        status: "enviado",
        respostaHttp: result.skipped ? 202 : result.status,
        mensagemErro: null
      }
    });

    return {
      ok: true,
      skipped: result.skipped
    };
  } catch (error) {
    await prisma.webhookEvento.update({
      where: {
        eventId
      },
      data: {
        status: "falhou",
        mensagemErro: error instanceof Error ? error.message : "Erro desconhecido"
      }
    });

    return {
      ok: false,
      skipped: false,
      error: error instanceof Error ? error.message : "Erro desconhecido"
    };
  }
}

router.post("/importacoes/preview", financeImportUpload.single("file"), (req, res) => {
  void (async () => {
    if (!req.file?.buffer) {
      res.status(400).json({
        message: "Envie um arquivo Excel valido."
      });
      return;
    }

    const parsed = z
      .object({
        periodId: z.string().uuid(),
        baseId: z.string().uuid().optional().nullable()
      })
      .safeParse({
        periodId: req.body.periodId,
        baseId: req.body.baseId || null
      });

    if (!parsed.success) {
      res.status(400).json({
        message: "Periodo ou base invalida.",
        issues: parsed.error.flatten()
      });
      return;
    }

    const preview = await createFinanceiroImportPreview({
      userId: req.auth?.userId || "",
      fileName: req.file.originalname,
      fileBuffer: req.file.buffer,
      periodId: parsed.data.periodId,
      baseId: parsed.data.baseId || null
    });

    res.json(preview);
  })().catch((error) => {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    const status = /ja foi importado/i.test(message) ? 409 : 500;
    res.status(status).json({
      message,
      detail: status === 500 ? message : undefined
    });
  });
});

router.post("/importacoes/:importacaoId/confirmar", (req, res) => {
  void (async () => {
    const importacaoId = String(req.params.importacaoId || "").trim();

    if (!importacaoId) {
      res.status(400).json({
        message: "Importacao invalida."
      });
      return;
    }

    const result = await confirmFinanceiroImport(importacaoId, req.auth?.userId || "");
    const webhooks = await prisma.webhookEvento.findMany({
      where: {
        importacaoId,
        status: "pendente"
      },
      select: {
        eventId: true
      }
    });

    const webhookResults = [];
    for (const webhook of webhooks) {
      webhookResults.push(await dispatchWebhookEvent(webhook.eventId));
    }

    res.json({
      message: "Importacao confirmada.",
      ...result,
      webhookResults
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao confirmar importacao.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/importacoes", (_req, res) => {
  void (async () => {
    const importacoes = await listFinanceiroImportacoes();

    res.json(
      importacoes.map((item) => ({
        id: item.id,
        nomeArquivo: item.nomeArquivo,
        nomeAba: item.nomeAba,
        usuario: item.usuario.nome,
        usuarioEmail: item.usuario.email,
        periodo: item.periodoPagamento?.nome || null,
        base: item.basePagamento?.nome || null,
        status: item.status,
        totalLinhas: item.totalLinhas,
        totalValidas: item.totalValidas,
        totalErros: item.totalErros,
        criadoEm: item.criadoEm,
        confirmadoEm: item.confirmadoEm
      }))
    );
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao listar importacoes.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/importacoes/:importacaoId", (req, res) => {
  void (async () => {
    const importacaoId = String(req.params.importacaoId || "").trim();

    const importacao = await prisma.importacaoFinanceira.findUnique({
      where: {
        id: importacaoId
      },
      include: {
        usuario: {
          select: {
            nome: true,
            email: true
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
        itens: {
          orderBy: {
            numeroLinha: "asc"
          }
        },
        webhookEventos: {
          orderBy: {
            criadoEm: "asc"
          }
        }
      }
    });

    if (!importacao) {
      res.status(404).json({
        message: "Importacao nao encontrada."
      });
      return;
    }

    res.json(importacao);
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao carregar importacao.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/historico-status", (req, res) => {
  void (async () => {
    const periodoId = String(req.query.periodoId || req.query.periodId || "").trim() || undefined;
    const baseId = String(req.query.baseId || "").trim() || undefined;
    const pagamentoId = String(req.query.pagamentoId || "").trim() || undefined;
    const historico = await listFinanceiroHistorico({ periodoId, baseId, pagamentoId });

    res.json(
      historico.map((item) => ({
        id: item.id,
        pagamentoId: item.pagamentoId,
        statusAnterior: item.statusAnterior,
        statusNovo: item.statusNovo,
        motivo: item.motivo,
        codigoObb: item.codigoObb,
        corIdentificada: item.corIdentificada,
        regraAplicada: item.regraAplicada,
        origem: item.origem,
        criadoEm: item.criadoEm,
        usuario: item.usuario?.nome || null,
        motorista: item.pagamento.motorista?.nome || null,
        cpf: item.pagamento.motorista?.cpf || null,
        periodo: item.pagamento.periodoPagamento?.nome || null,
        base: item.pagamento.basePagamento?.nome || null
      }))
    );
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao consultar historico financeiro.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/webhook-eventos/:eventId/reprocessar", (req, res) => {
  void (async () => {
    const eventId = String(req.params.eventId || "").trim();

    if (!eventId) {
      res.status(400).json({
        message: "Evento invalido."
      });
      return;
    }

    const result = await dispatchWebhookEvent(eventId);
    res.json({
      message: result.ok ? "Webhook reprocessado." : "Webhook com falha.",
      ...result
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao reprocessar webhook.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

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
          usuarioId: true,
          status: true
        }
      })
    ]);

    await syncApprovedDriverPdfReceipts(periods, uploads);

    const receivedRowsQuery = await prisma.driverPdfReceived.findMany({
      where: {
        OR: [
          {
            periodoPagamentoId: {
              in: periods.map((period) => period.id)
            }
          },
          {
            uploadPdfId: {
              in: uploads.map((upload) => upload.id)
            }
          }
        ]
      },
      select: {
        uploadPdfId: true,
        motoristaId: true,
        periodoPagamentoId: true,
        basePagamentoId: true,
        status: true
      }
    });

    const { visibleUploads } = dedupeLatestUploadsByMotorista(uploads);
    const espelhoUploads = visibleUploads;
    const uploadById = new Map(uploads.map((upload) => [upload.id, upload] as const));
    const activeMotoristaIds = new Set(
      espelhoUploads.map((item) => item.motoristaId).filter((value): value is string => Boolean(value))
    );
    const filteredReceivedRows = receivedRowsQuery.filter((item) => {
      const scope = resolveReceivedScope(item, uploadById);

      return Boolean(
        scope.motoristaId &&
          activeMotoristaIds.has(scope.motoristaId) &&
          isNoteStatus(item.status)
      );
    });
    const sentMotoristas = countUnique(espelhoUploads.map((item) => item.motoristaId));
    const completedMotoristas = countUnique(
      filteredReceivedRows.filter((item) => receivedNoteStatuses.has(item.status)).map((item) => item.motoristaId)
    );
    const analysisStatuses = new Set(["nota_fiscal_em_analise"]);
    const rejectedStatuses = new Set(["nota_fiscal_rejeitada"]);
    const attendanceStatuses = new Set(["em_atendimento", "chamado_aberto"]);
    const concludedStatuses = new Set(["processo_concluido", "pago"]);

    res.json({
      activePeriods: periods.filter((period) => period.status !== "aprovado").length,
      bases,
      motoristas: countUnique([...visibleUploads.map((item) => item.motoristaId), ...filteredReceivedRows.map((item) => item.motoristaId)]),
      pdfsSent: sentMotoristas,
      notesReceived: completedMotoristas,
      notesPending: Math.max(sentMotoristas - completedMotoristas, 0),
      inAnalysis: countUnique(filteredReceivedRows.filter((item) => analysisStatuses.has(item.status)).map((item) => item.motoristaId)),
      rejected: countUnique(filteredReceivedRows.filter((item) => rejectedStatuses.has(item.status)).map((item) => item.motoristaId)),
      inAttendance: countUnique(filteredReceivedRows.filter((item) => attendanceStatuses.has(item.status)).map((item) => item.motoristaId)),
      concluded: countUnique(filteredReceivedRows.filter((item) => concludedStatuses.has(item.status)).map((item) => item.motoristaId))
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
            caminhoArquivo: true,
            criadoEm: true,
            status: true,
            substituiUploadId: true
          }
        },
        pdfsRecebidos: {
          select: {
            id: true,
            uploadPdfId: true,
            motoristaId: true,
            basePagamentoId: true,
            periodoPagamentoId: true,
            status: true,
            uploadEm: true,
            enviadoAoMotoristaEm: true,
            visualizadoEm: true,
            caminhoArquivo: true,
            nomeArquivo: true
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

    const { visibleUploads } = dedupeLatestUploadsByMotorista(period.uploads);
    const uploadById = new Map(period.uploads.map((upload) => [upload.id, upload] as const));
    const receivedRowsQuery = await prisma.driverPdfReceived.findMany({
      where: {
        OR: [
          {
            periodoPagamentoId: periodId
          },
          {
            uploadPdfId: {
              in: period.uploads.map((upload) => upload.id)
            }
          }
        ]
      },
      select: {
        id: true,
        uploadPdfId: true,
        motoristaId: true,
        periodoPagamentoId: true,
        basePagamentoId: true,
        status: true,
        uploadEm: true,
        enviadoAoMotoristaEm: true,
        visualizadoEm: true,
        caminhoArquivo: true,
        nomeArquivo: true
      }
    });

    const bases = period.bases.map((periodBase) => {
      const baseId = periodBase.basePagamento.id;
      const baseUploads = visibleUploads.filter((item) => item.basePagamentoId === baseId);
      const baseRecebidos = receivedRowsQuery.filter((item) => {
        const scope = resolveReceivedScope(item, uploadById);

        return (
          scope.basePagamentoId === baseId &&
          baseUploads.some((upload) => upload.motoristaId === scope.motoristaId) &&
          isNoteStatus(item.status)
        );
      });
      const completedBaseRecebidos = baseRecebidos.filter((item) => receivedNoteStatuses.has(item.status));
      const motoristas = countUnique([
        ...baseUploads.map((item) => item.motoristaId),
        ...baseRecebidos.map((item) => resolveReceivedScope(item, uploadById).motoristaId)
      ]);
      const pdfsSent = countUnique(baseUploads.map((item) => item.motoristaId));
      const pdfsPending = countUnique(baseUploads.filter((item) => item.status === "pendente").map((item) => item.motoristaId));
      const notesReceived = countUnique(
        completedBaseRecebidos.map((item) => resolveReceivedScope(item, uploadById).motoristaId)
      );

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
    const normalizedSearch = search?.trim();
    const normalizedCpf = cpf?.replace(/\D/g, "") || "";
    const scopeBaseId = normalizeScopeBaseId(baseId);

    if (scopeBaseId && !/^[0-9a-fA-F-]{36}$/.test(scopeBaseId)) {
      res.status(400).json({
        message: "Base invalida para listar motoristas do periodo."
      });
      return;
    }

    const uploads = await prisma.uploadPdf.findMany({
      where: {
        periodoPagamentoId: periodId,
        status: {
          not: UploadStatus.removido
        },
        ...(scopeBaseId
          ? {
              basePagamentoId: scopeBaseId
            }
          : {}),
        ...(normalizedSearch || normalizedCpf
          ? {
              OR: [
                normalizedSearch
                  ? {
                      motorista: {
                        nome: {
                          contains: normalizedSearch,
                          mode: "insensitive"
                        }
                      }
                    }
                  : undefined,
                normalizedSearch
                  ? {
                      motorista: {
                        cpf: {
                          contains: normalizedSearch.replace(/\D/g, "")
                        }
                      }
                    }
                  : undefined,
                normalizedCpf
                  ? {
                      motorista: {
                        cpf: {
                          contains: normalizedCpf
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
            nome: true,
            status: true
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
        }
      },
      orderBy: {
        criadoEm: "desc"
      }
    });

    const receivedRowsQuery = await prisma.driverPdfReceived.findMany({
      where: {
        OR: [
          {
            periodoPagamentoId: periodId,
            ...(scopeBaseId
              ? {
                  basePagamentoId: scopeBaseId
                }
              : {})
          },
          {
            uploadPdfId: {
              in: uploads.map((upload) => upload.id)
            }
          }
        ]
      },
      select: {
        id: true,
        uploadPdfId: true,
        motoristaId: true,
        periodoPagamentoId: true,
        basePagamentoId: true,
        status: true,
        uploadEm: true,
        enviadoAoMotoristaEm: true,
        visualizadoEm: true,
        aprovadoEm: true,
        rejeitadoEm: true,
        motivoRejeicao: true,
        observacoes: true,
        caminhoArquivo: true,
        nomeArquivo: true
      }
    });
    const uploadById = new Map(uploads.map((upload) => [upload.id, upload] as const));
    const latestUploads = new Map<string, (typeof uploads)[number]>();

    const mirrorUploads = uploads.filter((upload) => isPaymentMirrorStorageKey(upload.caminhoArquivo));

    for (const upload of mirrorUploads.sort((left, right) => right.criadoEm.getTime() - left.criadoEm.getTime())) {
      if (!upload.motoristaId || !upload.basePagamentoId) {
        continue;
      }

      const key = `${upload.motoristaId}|${upload.basePagamentoId}`;

      if (!latestUploads.has(key)) {
        latestUploads.set(key, upload);
      }
    }

    const mapped = Array.from(latestUploads.values()).flatMap((upload) => {
      if (!upload.motorista || !upload.basePagamento || !upload.periodoPagamento) {
        return [];
      }

      const mirrorReceipt =
        receivedRowsQuery.find(
          (item) => item.uploadPdfId && item.uploadPdfId === upload.id && isMirrorUploadStatus(item.status)
        ) || null;
      const noteReceiptByUpload =
        receivedRowsQuery.find(
          (item) => item.uploadPdfId && item.uploadPdfId === upload.id && isNoteReceiptStatus(item.status)
        ) || null;
      const noteReceiptByIdentity =
        receivedRowsQuery
          .filter(
            (item) => {
              const scope = resolveReceivedScope(item, uploadById);

              return (
                scope.motoristaId === upload.motoristaId &&
                scope.periodoPagamentoId === upload.periodoPagamentoId &&
                scope.basePagamentoId === upload.basePagamentoId &&
                isNoteReceiptStatus(item.status)
              );
            }
          )
          .sort(
            (left, right) =>
              (right.uploadEm?.getTime() ?? 0) - (left.uploadEm?.getTime() ?? 0)
          )[0] || null;
      const noteReceipt = noteReceiptByUpload || noteReceiptByIdentity;
      const paymentStatus = upload.statusPagamento === FinanceiroStatusPagamento.PAGO ? "pago" : null;

      const ticketStatuses = upload.motorista.chamados.map((item) => item.status);
      const attendanceStatus = computeAttendanceStatus(ticketStatuses, upload.motorista.atendimentos.length);
      const currentStatus = paymentStatus
        ? paymentStatus
        : noteReceipt
        ? noteReceipt.status === "nota_fiscal_aprovada"
          ? "processo_concluido"
          : noteReceipt.status
        : mirrorReceipt
          ? mirrorReceipt.visualizadoEm
            ? "motorista_visualizou"
            : mirrorReceipt.enviadoAoMotoristaEm
              ? "pdf_enviado_ao_motorista"
              : "pdf_aguardando_envio"
          : resolvePdfStatus(upload.periodoPagamento?.status || null, upload.status);
      const pdfSentAt = mirrorReceipt?.enviadoAoMotoristaEm || upload.criadoEm;
      const noteSentAt = noteReceipt?.uploadEm || null;
      const mirrorDownloadUrl = buildStorageObjectUrl(mirrorReceipt?.caminhoArquivo || upload.caminhoArquivo);
      const noteDownloadUrl = buildStorageObjectUrl(noteReceipt?.caminhoArquivo);

      return {
        id: noteReceipt?.id || mirrorReceipt?.id || upload.id,
        motoristaId: upload.motoristaId,
        nome: upload.motorista.nome,
        cpf: upload.motorista.cpf,
        base: upload.basePagamento.nome,
        periodoPagamento: upload.periodoPagamento.nome,
        pdfEnviadoEm: toIso(pdfSentAt),
        pdfVisualizadoEm: toIso(mirrorReceipt?.visualizadoEm || null),
        notaFiscalEnviadaEm: toIso(noteSentAt),
        notaFiscalRecebidaEm: toIso(
          noteReceipt?.aprovadoEm ||
            noteReceipt?.rejeitadoEm ||
            noteReceipt?.uploadEm ||
            null
        ),
        status: currentStatus,
        statusLabel: formatStatusLabel(currentStatus),
        situacaoAtendimento: attendanceStatus,
        ultimaAtualizacao: toIso(
          noteReceipt?.aprovadoEm ||
            noteReceipt?.rejeitadoEm ||
            noteReceipt?.uploadEm ||
            mirrorReceipt?.visualizadoEm ||
            upload.criadoEm
        ),
        atendimentoStatus: attendanceStatus,
        statusNotaFiscal:
          paymentStatus === "pago"
            ? "Pago"
            : noteReceipt?.status === "nota_fiscal_rejeitada"
            ? "Recusada"
            : noteReceipt?.status === "nota_fiscal_aprovada"
              ? "Aprovada"
              : noteReceipt?.status === "nota_fiscal_em_analise"
                ? "Em an?lise"
                : noteReceipt?.status === "nota_fiscal_recebida"
                  ? "Recebida"
                  : currentStatus === "pdf_enviado_ao_motorista"
                    ? "Pendente"
                    : "Pendente",
        caminhoArquivo: mirrorDownloadUrl,
        notaFiscalDownloadUrl: noteDownloadUrl
      };
    });

    const filtered = mapped.filter((row) => {
      if (!status || status === "todos") {
        return true;
      }

      return row.status === status;
    });

    res.json(filtered);
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao listar motoristas do periodo financeiro.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/driver-pdfs/:receivedId/content", (req, res) => {
  void (async () => {
    const receivedId = String(req.params.receivedId || "").trim();

    if (!receivedId) {
      res.status(400).json({
        message: "Nota fiscal invalida."
      });
      return;
    }

    const received = await prisma.driverPdfReceived.findUnique({
      where: {
        id: receivedId
      },
      select: {
        id: true,
        status: true,
        nomeArquivo: true,
        caminhoArquivo: true,
        uploadPdfId: true
      }
    });

    if (!received) {
      res.status(404).json({
        message: "Nota fiscal nao encontrada."
      });
      return;
    }

    const content = await loadDriverPdfReceivedContent(received.id);

    if (!content) {
      res.status(404).json({
        message:
          received.status === "nota_fiscal_recebida" ||
          received.status === "nota_fiscal_em_analise" ||
          received.status === "nota_fiscal_aprovada" ||
          received.status === "nota_fiscal_rejeitada"
            ? "Arquivo da nota fiscal nao encontrado no bucket."
            : "Nota fiscal ainda nao enviada."
      });
      return;
    }

    const filename = String(received.nomeArquivo || "nota-fiscal.pdf").replace(/"/g, "'");
    const shouldDownload = String(req.query.download || "") === "1";
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${shouldDownload ? "attachment" : "inline"}; filename="${filename}"`
    });
    res.end(content);
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao carregar nota fiscal.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/periods/:periodId/export", (req, res) => {
  void (async () => {
    const periodId = String(req.params.periodId || "").trim();
    const baseId = normalizeScopeBaseId(String(req.query.baseId || ""));
    const motoristaIds = String(req.query.motoristaIds || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const selectedMotoristaIds = new Set(motoristaIds);

    if (!periodId) {
      res.status(400).json({
        message: "Periodo invalido para exportacao."
      });
      return;
    }

    if (baseId && !/^[0-9a-fA-F-]{36}$/.test(baseId)) {
      res.status(400).json({
        message: "Base invalida para exportacao."
      });
      return;
    }

    const period = await prisma.periodoPagamento.findUnique({
      where: {
        id: periodId
      },
      select: {
        id: true,
        nome: true,
        bases: {
          select: {
            basePagamento: {
              select: {
                id: true,
                nome: true
              }
            }
          }
        },
        uploads: {
          select: {
            id: true,
            motoristaId: true,
            basePagamentoId: true,
            nomeOriginal: true,
            caminhoArquivo: true,
            criadoEm: true,
            status: true,
            substituiUploadId: true,
            motorista: {
              select: {
                nome: true,
                cpf: true
              }
            },
            basePagamento: {
              select: {
                nome: true
              }
            }
          }
        },
        pdfsRecebidos: {
          select: {
            id: true,
            uploadPdfId: true,
            motoristaId: true,
            basePagamentoId: true,
            status: true,
            uploadEm: true,
            caminhoArquivo: true,
            nomeArquivo: true,
            motorista: {
              select: {
                nome: true,
                cpf: true
              }
            },
            basePagamento: {
              select: {
                nome: true
              }
            }
          }
        }
      }
    });

    if (!period) {
      res.status(404).json({
        message: "Periodo nao encontrado para exportacao."
      });
      return;
    }

    const visibleUploads = filterVisibleUploads(period.uploads);
    const uploadById = new Map(period.uploads.map((upload) => [upload.id, upload] as const));
    const receivedRowsQuery = await prisma.driverPdfReceived.findMany({
      where: {
        OR: [
          {
            periodoPagamentoId: periodId,
            ...(baseId
              ? {
                  basePagamentoId: baseId
                }
              : {})
          },
          {
            uploadPdfId: {
              in: period.uploads.map((upload) => upload.id)
            }
          }
        ]
      },
      select: {
        id: true,
        uploadPdfId: true,
        motoristaId: true,
        basePagamentoId: true,
        periodoPagamentoId: true,
        status: true,
        uploadEm: true,
        caminhoArquivo: true,
        nomeArquivo: true,
        motorista: {
          select: {
            nome: true,
            cpf: true
          }
        },
        basePagamento: {
          select: {
            nome: true
          }
        }
      }
    });
    const latestUploads = new Map<string, (typeof visibleUploads)[number]>();

    for (const upload of [...visibleUploads].sort((left, right) => right.criadoEm.getTime() - left.criadoEm.getTime())) {
      if (!upload.motoristaId || !upload.basePagamentoId) {
        continue;
      }
      if (baseId && upload.basePagamentoId !== baseId) {
        continue;
      }

      if (selectedMotoristaIds.size > 0 && !selectedMotoristaIds.has(upload.motoristaId)) {
        continue;
      }

      const key = `${upload.motoristaId}|${upload.basePagamentoId}`;
      if (!latestUploads.has(key)) {
        latestUploads.set(key, upload);
      }
    }

    const receivedRows = receivedRowsQuery.filter((item) => {
      const scope = resolveReceivedScope(item, uploadById);

      if (baseId && scope.basePagamentoId !== baseId) {
        return false;
      }

      if (selectedMotoristaIds.size > 0 && scope.motoristaId && !selectedMotoristaIds.has(scope.motoristaId)) {
        return false;
      }

      return isNoteStatus(item.status);
    });

    const archive = archiver("zip", {
      zlib: { level: 9 }
    });

    const periodFolder = sanitizeArchiveSegment(period.nome);
    const pendingRows: string[] = ["periodo,base,motorista,cpf,motivo"];

    res.status(200);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${periodFolder}.zip"`);

    archive.on("error", (error) => {
      if (!res.headersSent) {
        res.status(500).json({
          message: "Falha ao gerar exportacao de notas fiscais.",
          detail: error instanceof Error ? error.message : "Erro desconhecido"
        });
        return;
      }

      res.destroy(error as Error);
    });

    archive.pipe(res);

    for (const upload of latestUploads.values()) {
      const baseName = upload.basePagamento?.nome || "Base";
      const motoristaName = upload.motorista?.nome || "Motorista";
      const motoristaCpf = upload.motorista?.cpf || "";
      const receipt =
        receivedRows.find((item) => item.uploadPdfId && item.uploadPdfId === upload.id && isNoteStatus(item.status)) ||
        receivedRows.find((item) => {
          const scope = resolveReceivedScope(item, uploadById);

          return (
            scope.motoristaId === upload.motoristaId &&
            scope.basePagamentoId === upload.basePagamentoId &&
            item.status === "nota_fiscal_recebida"
          );
        }) ||
        receivedRows.find((item) => {
          const scope = resolveReceivedScope(item, uploadById);

          return (
            scope.motoristaId === upload.motoristaId &&
            scope.basePagamentoId === upload.basePagamentoId &&
            (item.status === "nota_fiscal_em_analise" ||
              item.status === "nota_fiscal_aprovada" ||
              item.status === "nota_fiscal_rejeitada" ||
              item.status === "processo_concluido")
          );
        }) ||
        null;

      if (!receipt) {
        pendingRows.push(
          [
            escapeCsv(period.nome),
            escapeCsv(baseName),
            escapeCsv(motoristaName),
            escapeCsv(motoristaCpf),
            escapeCsv("Nota fiscal ainda nao enviada")
          ].join(",")
        );
        continue;
      }

      if (!isNoteStatus(receipt.status)) {
        pendingRows.push(
          [
            escapeCsv(period.nome),
            escapeCsv(baseName),
            escapeCsv(motoristaName),
            escapeCsv(motoristaCpf),
            escapeCsv("Nota fiscal ainda nao enviada")
          ].join(",")
        );
        continue;
      }

      if (!receipt.caminhoArquivo) {
        pendingRows.push(
          [
            escapeCsv(period.nome),
            escapeCsv(baseName),
            escapeCsv(motoristaName),
            escapeCsv(motoristaCpf),
            escapeCsv("Arquivo da nota fiscal nao encontrado no bucket")
          ].join(",")
        );
        continue;
      }

      const file = await fetchObjectBuffer(receipt.caminhoArquivo).catch(() => null);
      if (!file?.body) {
        pendingRows.push(
          [
            escapeCsv(period.nome),
            escapeCsv(baseName),
            escapeCsv(motoristaName),
            escapeCsv(motoristaCpf),
            escapeCsv("Arquivo da nota fiscal nao encontrado no bucket")
          ].join(",")
        );
        continue;
      }

      archive.append(file.body, {
        name: buildExportPath(period.nome, baseName, motoristaName)
      });
    }

    if (pendingRows.length > 1) {
      archive.append(Buffer.from(pendingRows.join("\n"), "utf8"), {
        name: `${periodFolder}/pendencias.csv`
      });
    }

    await archive.finalize();
  })().catch((error) => {
    if (!res.headersSent) {
      res.status(500).json({
        message: "Falha ao exportar notas fiscais.",
        detail: error instanceof Error ? error.message : "Erro desconhecido"
      });
      return;
    }

    res.destroy(error instanceof Error ? error : new Error("Falha ao exportar notas fiscais."));
  });
});

export default router;
