import archiver from "archiver";
import { UploadStatus } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireModuleAccess } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";
import { buildStorageObjectUrl, fetchObjectBuffer } from "../../lib/storage.js";
import { loadDriverPdfReceivedContent } from "../../lib/driver-pdf-received-content.js";
import { upsertDriverPdfReceivedFromUpload } from "../../lib/driver-pdf-received.js";

const router = Router();

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

function filterVisibleUploads<T extends { id: string; substituiUploadId: string | null; status?: string }>(uploads: T[]) {
  const childReferences = new Set(
    uploads.map((item) => item.substituiUploadId).filter((value): value is string => Boolean(value))
  );

  return uploads.filter((item) => !childReferences.has(item.id) && item.status !== "removido");
}

function pickLatestReceived(
  receivedRows: ReceivedRecord[],
  upload: MotoristaUploadRecord
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
        (item) =>
          item.motoristaId === upload.motoristaId &&
          item.periodoPagamentoId === upload.periodoPagamentoId &&
          item.basePagamentoId === upload.basePagamentoId
      )
      .sort(
        (left, right) =>
          (right.uploadEm?.getTime() ?? 0) - (left.uploadEm?.getTime() ?? 0)
      )[0] || null
  );
}

function dedupeLatestUploadsByMotorista<T extends { id: string; motoristaId: string | null; criadoEm: Date; substituiUploadId: string | null; status?: string }>(
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
          usuarioId: true,
          status: true
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

    const { visibleUploads } = dedupeLatestUploadsByMotorista(uploads);
    const espelhoUploads = visibleUploads;
    const activeMotoristaIds = new Set(
      espelhoUploads.map((item) => item.motoristaId).filter((value): value is string => Boolean(value))
    );
    const filteredReceivedRows = receivedRows.filter(
      (item) =>
        item.motoristaId &&
        activeMotoristaIds.has(item.motoristaId) &&
        isNoteStatus(item.status)
    );
    const sentMotoristas = countUnique(espelhoUploads.map((item) => item.motoristaId));
    const completedMotoristas = countUnique(
      filteredReceivedRows.filter((item) => receivedNoteStatuses.has(item.status)).map((item) => item.motoristaId)
    );
    const analysisStatuses = new Set(["nota_fiscal_em_analise"]);
    const rejectedStatuses = new Set(["nota_fiscal_rejeitada"]);
    const attendanceStatuses = new Set(["em_atendimento", "chamado_aberto"]);
    const concludedStatuses = new Set(["processo_concluido"]);

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

    const bases = period.bases.map((periodBase) => {
      const baseId = periodBase.basePagamento.id;
      const baseUploads = visibleUploads.filter((item) => item.basePagamentoId === baseId);
      const baseRecebidos = period.pdfsRecebidos.filter(
        (item) =>
          item.basePagamentoId === baseId &&
          baseUploads.some((upload) => upload.motoristaId === item.motoristaId) &&
          isNoteStatus(item.status)
      );
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
        }
      },
      orderBy: {
        criadoEm: "desc"
      }
    });

    const receivedRows = await prisma.driverPdfReceived.findMany({
      where: {
        periodoPagamentoId: periodId,
        ...(scopeBaseId
          ? {
              basePagamentoId: scopeBaseId
            }
          : {})
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
    const latestUploads = new Map<string, (typeof uploads)[number]>();

    for (const upload of uploads.sort((left, right) => right.criadoEm.getTime() - left.criadoEm.getTime())) {
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

      const receipt =
        receivedRows.find(
          (item) =>
            item.uploadPdfId &&
            item.uploadPdfId === upload.id &&
            isNoteStatus(item.status)
        ) ||
        receivedRows
          .filter(
            (item) =>
              item.motoristaId === upload.motoristaId &&
              item.periodoPagamentoId === upload.periodoPagamentoId &&
              item.basePagamentoId === upload.basePagamentoId &&
              isNoteStatus(item.status)
          )
          .sort(
            (left, right) =>
              (right.uploadEm?.getTime() ?? 0) - (left.uploadEm?.getTime() ?? 0)
          )[0] ||
        null;

      const ticketStatuses = upload.motorista.chamados.map((item) => item.status);
      const attendanceStatus = computeAttendanceStatus(ticketStatuses, upload.motorista.atendimentos.length);
      const currentStatus = isNoteStatus(receipt?.status) ? receipt?.status : receipt?.status || "pdf_aguardando_envio";
      const pdfSentAt = receipt?.enviadoAoMotoristaEm || upload.criadoEm;
      const noteSentAt = isNoteStatus(receipt?.status) ? receipt?.uploadEm : null;
      const noteDownloadUrl =
        isNoteStatus(receipt?.status) && receipt?.caminhoArquivo
          ? buildStorageObjectUrl(receipt.caminhoArquivo)
          : null;

      return {
        id: receipt?.id || upload.id,
        motoristaId: upload.motoristaId,
        nome: upload.motorista.nome,
        cpf: upload.motorista.cpf,
        base: upload.basePagamento.nome,
        periodoPagamento: upload.periodoPagamento.nome,
        pdfEnviadoEm: toIso(pdfSentAt),
        pdfVisualizadoEm: toIso(receipt?.visualizadoEm || (receipt?.status === "motorista_visualizou" ? receipt.uploadEm : null)),
        notaFiscalEnviadaEm: toIso(noteSentAt),
        notaFiscalRecebidaEm: toIso(
          receipt?.aprovadoEm ||
            receipt?.rejeitadoEm ||
            (isNoteStatus(receipt?.status) ? receipt.uploadEm : null)
        ),
        status: currentStatus,
        statusLabel: formatStatusLabel(currentStatus),
        situacaoAtendimento: attendanceStatus,
        ultimaAtualizacao: toIso(
          receipt?.aprovadoEm || receipt?.rejeitadoEm || receipt?.uploadEm || upload.criadoEm
        ),
        atendimentoStatus: attendanceStatus,
        statusNotaFiscal:
          currentStatus === "nota_fiscal_rejeitada"
            ? "Recusada"
            : currentStatus === "nota_fiscal_aprovada"
              ? "Aprovada"
              : currentStatus === "nota_fiscal_em_analise"
                ? "Em an?lise"
                : currentStatus === "nota_fiscal_recebida"
                  ? "Recebida"
                  : currentStatus === "aguardando_envio_nota_fiscal"
                    ? "Pendente"
                    : "Pendente",
        caminhoArquivo: buildStorageObjectUrl(upload.caminhoArquivo),
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

    const visibleUploads = period.uploads.filter((upload) => upload.status !== "removido");
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

    const receivedRows = period.pdfsRecebidos.filter((item) => {
      if (baseId && item.basePagamentoId !== baseId) {
        return false;
      }

      if (selectedMotoristaIds.size > 0 && item.motoristaId && !selectedMotoristaIds.has(item.motoristaId)) {
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
        receivedRows.find((item) => item.uploadPdfId && item.uploadPdfId === upload.id) ||
        receivedRows.find(
          (item) =>
            item.motoristaId === upload.motoristaId &&
            item.basePagamentoId === upload.basePagamentoId &&
            item.status === "nota_fiscal_recebida"
        ) ||
        receivedRows.find(
          (item) =>
            item.motoristaId === upload.motoristaId &&
            item.basePagamentoId === upload.basePagamentoId &&
            (item.status === "nota_fiscal_em_analise" ||
              item.status === "nota_fiscal_aprovada" ||
              item.status === "nota_fiscal_rejeitada" ||
              item.status === "processo_concluido")
        ) ||
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
