import { Router } from "express";
import { z } from "zod";
import { UploadStatus } from "@prisma/client";
import { requireAdmin, requireAuth } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";
import { deleteObject } from "../../lib/storage.js";
import { upsertDriverPdfReceivedFromUpload } from "../../lib/driver-pdf-received.js";
import { notifyPdfOnline } from "../../lib/pdfonline-bridge.js";
import { normalizeText, resolveDriverRegistryByIdentity } from "../../lib/driver-registry.js";

const router = Router();

router.use(requireAuth, (req, res, next) => {
  if (!req.auth) {
    res.status(401).json({
      message: "Sessão não autenticada."
    });
    return;
  }

  if (req.auth.firstAccess) {
    res.status(403).json({
      message: "Altere a senha inicial antes de acessar outros modulos."
    });
    return;
  }

  if (
    !req.auth.modules.includes("pdfs") &&
    !req.auth.modules.includes("financeiro") &&
    !["N3", "N4"].includes(req.auth.level)
  ) {
    res.status(403).json({
      message: "Você não possui permissão para acessar este módulo."
    });
    return;
  }

  next();
});

const periodPayloadSchema = z.object({
  name: z.string().min(3),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  paymentType: z.enum(["semanal", "quinzenal", "mensal"])
});

const periodUpdateSchema = z.object({
  name: z.string().min(3),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  paymentType: z.enum(["semanal", "quinzenal", "mensal"])
});

const periodStatusSchema = z.object({
  status: z.enum(["disponivel", "aguardando_aprovacao", "aprovado"])
});

const periodLifecycleSchema = z.object({
  active: z.boolean()
});

const basePayloadSchema = z.object({
  name: z.string().min(3),
  paymentType: z.enum(["semanal", "quinzenal", "mensal"]),
  active: z.boolean().optional().default(true)
});

const duplicateReviewActionSchema = z.object({
  action: z.enum(["aprovar", "reprovar", "redirecionar"]),
  targetBaseId: z.string().uuid().optional()
});

type DuplicateReviewCase = {
  id: string;
  fileName: string;
  baseEnviada: string;
  periodId: string | null;
  periodName: string;
  periodStatus: string;
  uploadedAt: Date;
  downloadUrl: string;
};

async function getDuplicateReviewQueue(periodId?: string | null) {
  const uploads = await prisma.uploadPdf.findMany({
    where: {
      status: UploadStatus.pendente,
      ...(periodId ? { periodoPagamentoId: periodId } : {})
    },
    select: {
      id: true,
      nomeOriginal: true,
      criadoEm: true,
      status: true,
      motoristaId: true,
      periodoPagamentoId: true,
      basePagamentoId: true,
      caminhoArquivo: true,
      motorista: {
        select: {
          nome: true,
          cpf: true,
          empresaVinculada: true
        }
      },
      periodoPagamento: {
        select: {
          id: true,
          nome: true,
          status: true
        }
      },
      basePagamento: {
        select: {
          id: true,
          nome: true
        }
      }
    },
    orderBy: {
      criadoEm: "desc"
    }
  });

  const reviewActions = await prisma.logAuditoria.findMany({
    where: {
      entidade: "uploads_pdf",
      entidadeId: { in: uploads.map((upload) => upload.id) },
      acao: {
        in: ["aprovar_pdf_base", "redirecionar_pdf_base", "reprovar_pdf_base"]
      }
    },
    select: {
      entidadeId: true
    }
  });

  const reviewedIds = new Set(reviewActions.map((item) => item.entidadeId).filter((value): value is string => Boolean(value)));
  const registryBaseCache = new Map<
    string,
    {
      base: string | null;
    }
  >();

  const getRegistryBase = async (cpf: string, name: string) => {
    const cacheKey = `${cpf}|${name}`;
    const cached = registryBaseCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const registry = await resolveDriverRegistryByIdentity({
      cpf,
      name
    });

    const resolved =
      registry && "ambiguous" in registry
        ? {
            base: null
          }
        : {
            base: registry?.base || null
          };

    registryBaseCache.set(cacheKey, resolved);
    return resolved;
  };

  const grouped = new Map<
    string,
    {
      id: string;
      motoristaNome: string;
      motoristaCpf: string;
      baseRegistrada: string;
      baseCadastrada: string;
      cases: DuplicateReviewCase[];
    }
  >();

  const preparedUploads = await Promise.all(
    uploads.map(async (upload) => {
      const motoristaCpf = upload.motorista?.cpf || "Não informado";
      const motoristaNome = upload.motorista?.nome || "Não informado";
      const registryBase = await getRegistryBase(motoristaCpf, motoristaNome);

      return {
        upload,
        motoristaCpf,
        motoristaNome,
        registryBase: registryBase.base
      };
    })
  );

  for (const prepared of preparedUploads) {
    const { upload, motoristaCpf, motoristaNome, registryBase } = prepared;

    if (reviewedIds.has(upload.id)) {
      continue;
    }

    const baseRegistrada = normalizeText(registryBase || "");
    const baseEnviada = normalizeText(upload.basePagamento?.nome || "");

    if (!baseRegistrada || baseRegistrada === baseEnviada) {
      continue;
    }

    const baseCadastrada = registryBase || "Não informada";
    const groupKey = `${motoristaCpf}|${motoristaNome}|${baseCadastrada}`;
    const entry = grouped.get(groupKey) || {
      id: groupKey,
      motoristaNome,
      motoristaCpf,
      baseRegistrada: baseCadastrada,
      baseCadastrada,
      cases: []
    };

    entry.cases.push({
      id: upload.id,
      fileName: upload.nomeOriginal,
      baseEnviada: upload.basePagamento?.nome || "Não informada",
      periodId: upload.periodoPagamentoId,
      periodName: upload.periodoPagamento?.nome || "Não informado",
      periodStatus: upload.periodoPagamento?.status || "disponivel",
      uploadedAt: upload.criadoEm,
      downloadUrl: upload.caminhoArquivo
    });

    grouped.set(groupKey, entry);
  }

  return Array.from(grouped.values()).map((item) => ({
    id: item.id,
    motoristaNome: item.motoristaNome,
    motoristaCpf: item.motoristaCpf,
    baseRegistrada: item.baseRegistrada,
    baseCadastrada: item.baseCadastrada,
    cases: item.cases.sort((left, right) => right.uploadedAt.getTime() - left.uploadedAt.getTime())
  }));
}

function parseDateOnly(input: string) {
  const [yearText, monthText, dayText] = input.split("-");

  return new Date(
    Date.UTC(
      Number(yearText),
      Number(monthText) - 1,
      Number(dayText)
    )
  );
}

function toDateOnlyString(value: Date) {
  return new Date(value.getTime() + value.getTimezoneOffset() * 60_000)
    .toISOString()
    .split("T")[0];
}

function serializeBase(base: { id: string; nome: string; tipoPadrao: string; ativo: boolean }) {
  return {
    id: base.id,
    name: base.nome,
    paymentType: base.tipoPadrao,
    active: base.ativo
  };
}

function serializePeriod(period: {
  id: string;
  nome: string;
  dataInicio: Date;
  dataFim: Date;
  tipo: string;
  status: string;
  ativo: boolean;
  criadoEm: Date;
  atualizadoEm: Date;
  criadoPor: {
    nome: string;
  };
  bases: Array<{
    basePagamento: {
      id: string;
      nome: string;
      tipoPadrao: string;
      ativo: boolean;
    };
  }>;
  uploads: Array<{
    id: string;
    motoristaId: string | null;
    basePagamentoId: string | null;
    criadoEm: Date;
    status: string;
    substituiUploadId: string | null;
  }>;
}) {
  const childReferences = new Set(
    period.uploads
      .map((item) => item.substituiUploadId)
      .filter((value): value is string => Boolean(value))
  );

  const visibleUploads = period.uploads.filter(
    (item) => !childReferences.has(item.id) && item.status !== "removido"
  );
  const uploadedByBase: Record<string, number> = {};
  const uploadedByBaseMotorists = new Map<string, Set<string>>();

  for (const upload of visibleUploads) {
    if (!upload.basePagamentoId || !upload.motoristaId) {
      continue;
    }

    if (!uploadedByBaseMotorists.has(upload.basePagamentoId)) {
      uploadedByBaseMotorists.set(upload.basePagamentoId, new Set());
    }

    uploadedByBaseMotorists.get(upload.basePagamentoId)?.add(upload.motoristaId);
  }

  for (const [baseId, motoristaSet] of uploadedByBaseMotorists.entries()) {
    uploadedByBase[baseId] = motoristaSet.size;
  }

  const uploadedTotal = new Set(
    visibleUploads.map((item) => item.motoristaId).filter((value): value is string => Boolean(value))
  ).size;
  const expectedTotal = period.bases.length;
  const derivedStatus =
    period.status === "aprovado"
      ? period.status
      : uploadedTotal >= expectedTotal && expectedTotal > 0
        ? "aguardando_aprovacao"
        : period.status;

  return {
    id: period.id,
    name: period.nome,
    startDate: toDateOnlyString(period.dataInicio),
    endDate: toDateOnlyString(period.dataFim),
    paymentType: period.tipo,
    status: derivedStatus,
    active: period.ativo,
    createdAt: period.criadoEm,
    updatedAt: period.atualizadoEm,
    createdBy: period.criadoPor.nome,
    bases: period.bases.map((item) => serializeBase(item.basePagamento)),
    uploadedTotal,
    uploadedByBase
  };
}

function buildUploadBridgePayload(input: {
  upload: {
    id: string;
    motoristaId: string | null;
    nomeOriginal: string;
    caminhoArquivo: string;
    basePagamentoId: string | null;
    periodoPagamentoId: string | null;
    versao: number;
  };
  periodId: string;
  basePaymentId: string;
}) {
  return {
    id: input.upload.id,
    uploadId: input.upload.id,
    uploadPdfId: input.upload.id,
    periodId: input.periodId,
    periodoPagamentoId: input.periodId,
    basePaymentId: input.basePaymentId,
    basePagamentoId: input.basePaymentId,
    motoristaId: input.upload.motoristaId,
    nomeArquivo: input.upload.nomeOriginal,
    nomeOriginal: input.upload.nomeOriginal,
    caminhoArquivo: input.upload.caminhoArquivo,
    storageKey: input.upload.caminhoArquivo,
    versao: input.upload.versao,
    status: "pendente",
    tipoArquivo: "application/pdf",
    observacoes: `PDF liberado no período ${input.periodId}`
  };
}

router.get("/bases", (_req, res) => {
  void (async () => {
    const bases = await prisma.basePagamento.findMany({
      orderBy: {
        nome: "asc"
      }
    });

    res.json(bases.map(serializeBase));
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao listar bases de pagamento.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/bases", requireAdmin, (req, res) => {
  void (async () => {
    const parsed = basePayloadSchema.safeParse(req.body);
    const auth = req.auth;

    if (!parsed.success || !auth) {
      res.status(400).json({
        message: "Dados inválidos para criação da base.",
        issues: parsed.success ? undefined : parsed.error.flatten()
      });
      return;
    }

    const created = await prisma.basePagamento.create({
      data: {
        nome: parsed.data.name,
        tipoPadrao: parsed.data.paymentType,
        ativo: parsed.data.active
      }
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: auth.userId,
        acao: "criar_base_pagamento",
        entidade: "bases_pagamento",
        entidadeId: created.id,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null,
        detalhes: {
          nome: created.nome,
          tipoPadrao: created.tipoPadrao,
          ativo: created.ativo
        }
      }
    });

    res.status(201).json({
      message: "Base criada com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao criar base.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.patch("/bases/:id", requireAdmin, (req, res) => {
  void (async () => {
    const parsed = basePayloadSchema.safeParse(req.body);
    const auth = req.auth;
    const baseId = String(req.params.id);

    if (!parsed.success || !auth) {
      res.status(400).json({
        message: "Dados inválidos para edição da base.",
        issues: parsed.success ? undefined : parsed.error.flatten()
      });
      return;
    }

    const existing = await prisma.basePagamento.findUnique({
      where: {
        id: baseId
      }
    });

    if (!existing) {
      res.status(404).json({
        message: "Base não encontrada."
      });
      return;
    }

    const updated = await prisma.basePagamento.update({
      where: {
        id: baseId
      },
      data: {
        nome: parsed.data.name,
        tipoPadrao: parsed.data.paymentType,
        ativo: parsed.data.active
      }
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: auth.userId,
        acao: "editar_base_pagamento",
        entidade: "bases_pagamento",
        entidadeId: updated.id,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null,
        detalhes: {
          nome: updated.nome,
          tipoPadrao: updated.tipoPadrao,
          ativo: updated.ativo
        }
      }
    });

    res.json({
      message: "Base atualizada com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao atualizar base.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.delete("/bases/:id", requireAdmin, (req, res) => {
  void (async () => {
    const auth = req.auth;
    const baseId = String(req.params.id);

    if (!auth) {
      res.status(401).json({
        message: "Sessão não autenticada."
      });
      return;
    }

    const existing = await prisma.basePagamento.findUnique({
      where: {
        id: baseId
      }
    });

    if (!existing) {
      res.status(404).json({
        message: "Base não encontrada."
      });
      return;
    }

    const removed = await prisma.basePagamento.update({
      where: {
        id: baseId
      },
      data: {
        ativo: false
      }
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: auth.userId,
        acao: "excluir_base_pagamento",
        entidade: "bases_pagamento",
        entidadeId: removed.id,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null,
        detalhes: {
          nome: removed.nome,
          tipoPadrao: removed.tipoPadrao,
          ativo: removed.ativo
        }
      }
    });

    res.json({
      message: "Base excluida com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao excluir base.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/", (_req, res) => {
  void (async () => {
    const periods = await prisma.periodoPagamento.findMany({
      include: {
        criadoPor: {
          select: {
            nome: true
          }
        },
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
        }
      },
      orderBy: {
        criadoEm: "desc"
      }
    });

    res.json(periods.map(serializePeriod));
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao listar periodos.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/", requireAdmin, (req, res) => {
  void (async () => {
    const parsed = periodPayloadSchema.safeParse(req.body);

    if (!parsed.success || !req.auth) {
      res.status(400).json({
        message: "Dados inválidos para criação do período.",
        issues: parsed.success ? undefined : parsed.error.flatten()
      });
      return;
    }

    const baseType = parsed.data.paymentType;
    const bases = await prisma.basePagamento.findMany({
      where: {
        ativo: true,
        ...(baseType === "mensal" ? {} : { tipoPadrao: baseType })
      },
      orderBy: {
        nome: "asc"
      }
    });

    if (bases.length === 0) {
      res.status(400).json({
        message: "Não existem bases cadastradas para o tipo selecionado."
      });
      return;
    }

    const period = await prisma.periodoPagamento.create({
      data: {
        nome: parsed.data.name,
        dataInicio: parseDateOnly(parsed.data.startDate),
        dataFim: parseDateOnly(parsed.data.endDate),
        tipo: baseType,
        criadoPorId: req.auth.userId,
        bases: {
          create: bases.map((base) => ({
            basePagamentoId: base.id
          }))
        }
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
        }
      }
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: req.auth.userId,
        acao: "criar_periodo_pagamento",
        entidade: "periodos_pagamento",
        entidadeId: period.id,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null,
        detalhes: {
          nome: period.nome,
          tipo: period.tipo,
          bases: bases.map((base) => base.nome)
        }
      }
    });

    void notifyPdfOnline(
      "portal.period.created",
      {
        periodId: period.id,
        name: period.nome,
        startDate: toDateOnlyString(period.dataInicio),
        endDate: toDateOnlyString(period.dataFim),
        paymentType: period.tipo,
        status: period.status,
        bases: bases.map((base) => base.nome)
      },
      {
        userId: req.auth.userId
      }
    ).catch((error) => {
      console.warn("PDF Online bridge period-create notify failed:", error instanceof Error ? error.message : error);
    });

    res.status(201).json({
      message: "Período criado com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao criar período.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.patch("/:id", requireAdmin, (req, res) => {
  void (async () => {
    const parsed = periodUpdateSchema.safeParse(req.body);
    const auth = req.auth;

    if (!parsed.success || !auth) {
      res.status(400).json({
        message: "Dados inválidos para edição do período.",
        issues: parsed.success ? undefined : parsed.error.flatten()
      });
      return;
    }

    const period = await prisma.periodoPagamento.findUnique({
      where: {
        id: String(req.params.id)
      },
      include: {
        bases: true
      }
    });

    if (!period) {
      res.status(404).json({
        message: "Período não encontrado."
      });
      return;
    }

    const baseType = parsed.data.paymentType;
    const bases = await prisma.basePagamento.findMany({
      where: {
        ativo: true,
        ...(baseType === "mensal" ? {} : { tipoPadrao: baseType })
      },
      orderBy: {
        nome: "asc"
      }
    });

    if (bases.length === 0) {
      res.status(400).json({
        message: "Não existem bases cadastradas para o tipo selecionado."
      });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.periodoPagamento.update({
        where: {
          id: period.id
        },
        data: {
          nome: parsed.data.name,
          dataInicio: parseDateOnly(parsed.data.startDate),
          dataFim: parseDateOnly(parsed.data.endDate),
          tipo: baseType
        }
      });

      await tx.periodoPagamentoBase.deleteMany({
        where: {
          periodoId: period.id
        }
      });

      if (bases.length > 0) {
        await tx.periodoPagamentoBase.createMany({
          data: bases.map((base) => ({
            periodoId: period.id,
            basePagamentoId: base.id
          }))
        });
      }

      await tx.logAuditoria.create({
        data: {
          usuarioId: auth.userId,
          acao: "editar_periodo_pagamento",
          entidade: "periodos_pagamento",
          entidadeId: period.id,
          ipOrigem: req.ip,
          userAgent: req.get("user-agent") || null,
          detalhes: {
            nome: parsed.data.name,
            tipo: baseType,
            bases: bases.map((base) => base.nome)
          }
        }
      });
    });

    void notifyPdfOnline(
      "portal.period.updated",
      {
        periodId: period.id,
        name: parsed.data.name,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        paymentType: baseType,
        bases: bases.map((base) => base.nome)
      },
      {
        userId: auth.userId
      }
    ).catch((error) => {
      console.warn("PDF Online bridge period-update notify failed:", error instanceof Error ? error.message : error);
    });

    res.json({
      message: "Período atualizado com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao atualizar período.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.patch("/:id/lifecycle", requireAdmin, (req, res) => {
  void (async () => {
    const parsed = periodLifecycleSchema.safeParse(req.body);
    const auth = req.auth;
    const periodId = String(req.params.id || "").trim();

    if (!parsed.success || !auth) {
      res.status(400).json({
        message: "Dados invalidos para alterar a situacao do periodo.",
        issues: parsed.success ? undefined : parsed.error.flatten()
      });
      return;
    }

    const existing = await prisma.periodoPagamento.findUnique({
      where: { id: periodId },
      select: { id: true, nome: true, ativo: true }
    });

    if (!existing) {
      res.status(404).json({
        message: "Periodo nao encontrado."
      });
      return;
    }

    if (existing.ativo === parsed.data.active) {
      res.json({
        message: parsed.data.active ? "Periodo ja esta ativo." : "Periodo ja esta finalizado."
      });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const period = await tx.periodoPagamento.update({
        where: { id: periodId },
        data: { ativo: parsed.data.active }
      });

      await tx.logAuditoria.create({
        data: {
          usuarioId: auth.userId,
          acao: parsed.data.active ? "reativar_periodo_pagamento" : "finalizar_periodo_pagamento",
          entidade: "periodos_pagamento",
          entidadeId: period.id,
          ipOrigem: req.ip,
          userAgent: req.get("user-agent") || null,
          detalhes: {
            nome: period.nome,
            ativo: period.ativo
          }
        }
      });

      return period;
    });

    void notifyPdfOnline(
      "portal.period.lifecycle_changed",
      {
        periodId: updated.id,
        name: updated.nome,
        active: updated.ativo
      },
      {
        userId: auth.userId,
        periodId: updated.id
      }
    ).catch((error) => {
      console.warn("PDF Online bridge period-lifecycle notify failed:", error instanceof Error ? error.message : error);
    });

    res.json({
      message: updated.ativo
        ? "Periodo reativado e disponivel no Financeiro."
        : "Periodo finalizado e removido do Financeiro."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao alterar a situacao do periodo.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.patch("/:id/status", requireAdmin, (req, res) => {
  void (async () => {
    const parsed = periodStatusSchema.safeParse(req.body);
    const auth = req.auth;

    if (!parsed.success || !auth) {
      res.status(400).json({
        message: "Dados inválidos para status do período.",
        issues: parsed.success ? undefined : parsed.error.flatten()
      });
      return;
    }

    if (parsed.data.status === "aprovado") {
      const duplicateReviews = await getDuplicateReviewQueue(String(req.params.id));

      if (duplicateReviews.length > 0) {
        res.status(409).json({
          message: "Existem motoristas duplicados pendentes de análise. Aprove, reprove ou redirecione antes de aprovar o período.",
          pendingCount: duplicateReviews.length,
          duplicates: duplicateReviews
        });
        return;
      }
    }

    const updated = await prisma.periodoPagamento.update({
      where: {
        id: String(req.params.id)
      },
      data: {
        status: parsed.data.status
      }
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: auth.userId,
        acao: "alterar_status_periodo_pagamento",
        entidade: "periodos_pagamento",
        entidadeId: updated.id,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null,
        detalhes: {
          status: parsed.data.status
        }
      }
    });

    if (parsed.data.status === "aprovado") {
      const approvedPeriod = await prisma.periodoPagamento.findUnique({
        where: {
          id: updated.id
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
              nomeOriginal: true,
              caminhoArquivo: true,
              basePagamentoId: true,
              criadoEm: true,
              status: true,
              substituiUploadId: true
            }
          }
        }
      });

      const childReferences = new Set(
        approvedPeriod?.uploads.map((item) => item.substituiUploadId).filter((value): value is string => Boolean(value)) || []
      );
      const visibleUploads =
        approvedPeriod?.uploads.filter(
          (item) =>
            !childReferences.has(item.id) &&
            item.status === UploadStatus.pendente
        ) || [];
      const latestVisibleUploads = new Map<string, (typeof visibleUploads)[number]>();

      for (const upload of [...visibleUploads].sort(
        (left, right) => right.criadoEm.getTime() - left.criadoEm.getTime()
      )) {
        if (!upload.motoristaId || !upload.basePagamentoId) {
          continue;
        }

        const key = `${upload.motoristaId}|${upload.basePagamentoId}`;

        if (!latestVisibleUploads.has(key)) {
          latestVisibleUploads.set(key, upload);
        }
      }

      await Promise.all(
        Array.from(latestVisibleUploads.values())
          .filter((item): item is (typeof visibleUploads)[number] & { motoristaId: string; basePagamentoId: string } => Boolean(item.motoristaId && item.basePagamentoId))
          .map((item) =>
            upsertDriverPdfReceivedFromUpload({
              uploadPdfId: item.id,
              motoristaId: item.motoristaId,
              periodId: updated.id,
              basePaymentId: item.basePagamentoId,
              fileName: item.nomeOriginal,
              storageKey: item.caminhoArquivo,
              createdByUserId: auth.userId
            })
          )
      );

      await Promise.all(
        Array.from(latestVisibleUploads.values())
          .filter((item): item is (typeof visibleUploads)[number] & { motoristaId: string; basePagamentoId: string } => Boolean(item.motoristaId && item.basePagamentoId))
          .map((item) =>
            notifyPdfOnline(
              "portal.upload.created",
              {
                id: item.id,
                uploadId: item.id,
                uploadPdfId: item.id,
                periodId: updated.id,
                periodoPagamentoId: updated.id,
                basePaymentId: item.basePagamentoId,
                basePagamentoId: item.basePagamentoId,
                motoristaId: item.motoristaId,
                nomeArquivo: item.nomeOriginal,
                nomeOriginal: item.nomeOriginal,
                caminhoArquivo: item.caminhoArquivo,
                storageKey: item.caminhoArquivo,
                status: "pendente",
                tipoArquivo: "application/pdf",
                versao: 1,
                observacoes: `PDF liberado no período ${approvedPeriod?.nome || updated.id}`
              },
              {
                userId: auth.userId,
                periodId: updated.id,
                basePaymentId: item.basePagamentoId
              }
            ).catch((error) => {
              console.warn("PDF Online bridge upload-created on approval failed:", error instanceof Error ? error.message : error);
            })
          )
      );

      void notifyPdfOnline(
        "portal.period.status_changed",
        {
          periodId: updated.id,
          status: parsed.data.status,
          uploads: Array.from(latestVisibleUploads.values()).map((item) => ({
            uploadId: item.id,
            fileName: item.nomeOriginal,
            storageKey: item.caminhoArquivo,
            basePaymentId: item.basePagamentoId,
            motoristaId: item.motoristaId
          }))
        },
        {
          userId: auth.userId
        }
      ).catch((error) => {
        console.warn("PDF Online bridge period-status notify failed:", error instanceof Error ? error.message : error);
      });
    }

    res.json({
      message: "Status do período atualizado com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao alterar status do período.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/review-queue", requireAdmin, (req, res) => {
  void (async () => {
    const periodId = String(req.query.periodId || "").trim() || null;
    res.json(await getDuplicateReviewQueue(periodId));
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao listar revisoes de base.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.patch("/uploads/:uploadId/review", requireAdmin, (req, res) => {
  void (async () => {
    const parsed = duplicateReviewActionSchema.safeParse(req.body);
    const auth = req.auth;
    const uploadId = String(req.params.uploadId || "").trim();

    if (!parsed.success || !auth) {
      res.status(400).json({
        message: "Dados inválidos para revisão do upload.",
        issues: parsed.success ? undefined : parsed.error.flatten()
      });
      return;
    }

    const upload = await prisma.uploadPdf.findUnique({
      where: {
        id: uploadId
      },
      include: {
        motorista: {
          select: {
            nome: true,
            cpf: true,
            empresaVinculada: true
          }
        },
        periodoPagamento: {
          select: {
            id: true,
            nome: true,
            status: true
          }
        },
        basePagamento: {
          select: {
            id: true,
            nome: true
          }
        }
      }
    });

    if (!upload) {
      res.status(404).json({
        message: "Upload não encontrado."
      });
      return;
    }

    if (parsed.data.action === "reprovar") {
      await prisma.uploadPdf.delete({
        where: {
          id: upload.id
        }
      });

      void deleteObject(upload.caminhoArquivo).catch(() => null);

      await prisma.logAuditoria.create({
        data: {
          usuarioId: auth.userId,
          acao: "reprovar_pdf_base",
          entidade: "uploads_pdf",
          entidadeId: upload.id,
          ipOrigem: req.ip,
          userAgent: req.get("user-agent") || null,
          detalhes: {
            arquivo: upload.nomeOriginal,
            motorista: upload.motorista?.nome || null,
            baseEnviada: upload.basePagamento?.nome || null
          }
        }
      });

      res.json({
        message: "Upload reprovado e removido com sucesso."
      });
      return;
    }

    const resolvedBaseId =
      parsed.data.action === "redirecionar" ? parsed.data.targetBaseId || null : upload.basePagamentoId;

    if (!resolvedBaseId) {
      res.status(400).json({
        message: "Selecione a base de destino para redirecionar o upload."
      });
      return;
    }

    const targetBase = await prisma.basePagamento.findUnique({
      where: {
        id: resolvedBaseId
      }
    });

    if (!targetBase) {
      res.status(404).json({
        message: "Base de destino não encontrada."
      });
      return;
    }

    const updated = await prisma.uploadPdf.update({
      where: {
        id: upload.id
      },
      data: {
        basePagamentoId: targetBase.id,
        status: UploadStatus.processado
      }
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: auth.userId,
        acao: parsed.data.action === "aprovar" ? "aprovar_pdf_base" : "redirecionar_pdf_base",
        entidade: "uploads_pdf",
        entidadeId: updated.id,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null,
        detalhes: {
          arquivo: updated.nomeOriginal,
          motorista: upload.motorista?.nome || null,
          baseAnterior: upload.basePagamento?.nome || null,
          baseDestino: targetBase.nome
        }
      }
    });

    if (upload.periodoPagamento?.status === "aprovado") {
      await upsertDriverPdfReceivedFromUpload({
        uploadPdfId: updated.id,
        motoristaId: updated.motoristaId || upload.motoristaId || "",
        periodId: updated.periodoPagamentoId || upload.periodoPagamentoId || "",
        basePaymentId: targetBase.id,
        fileName: updated.nomeOriginal,
        storageKey: updated.caminhoArquivo,
        createdByUserId: auth.userId
      });

      void notifyPdfOnline(
        "portal.upload.created",
        {
          ...buildUploadBridgePayload({
            upload: {
              id: updated.id,
              motoristaId: updated.motoristaId,
              nomeOriginal: updated.nomeOriginal,
              caminhoArquivo: updated.caminhoArquivo,
              basePagamentoId: updated.basePagamentoId,
              periodoPagamentoId: updated.periodoPagamentoId,
              versao: updated.versao
            },
            periodId: upload.periodoPagamentoId || "",
            basePaymentId: targetBase.id
          }),
          motoristaNome: upload.motorista?.nome || "Motorista",
          motoristaCpf: upload.motorista?.cpf || "",
          usuarioId: auth.userId,
          tipoArquivo: "application/pdf"
        },
        {
          userId: auth.userId,
          periodId: upload.periodoPagamentoId || undefined,
          basePaymentId: targetBase.id
        }
      ).catch((error) => {
        console.warn("PDF Online bridge review notify failed:", error instanceof Error ? error.message : error);
      });
    }

    res.json({
      message: parsed.data.action === "aprovar" ? "Upload aprovado com sucesso." : "Upload redirecionado com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao revisar upload.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.delete("/:id", requireAdmin, (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({
        message: "Sessão não autenticada."
      });
      return;
    }

    const userId = req.auth.userId;
    const periodId = String(req.params.id);
    const existing = await prisma.periodoPagamento.findUnique({
      where: {
        id: periodId
      },
      select: {
        id: true,
        nome: true
      }
    });

    if (!existing) {
      res.status(404).json({
        message: "Período não encontrado."
      });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.uploadPdf.updateMany({
        where: {
          periodoPagamentoId: periodId
        },
        data: {
          periodoPagamentoId: null
        }
      });

      await tx.periodoPagamentoBase.deleteMany({
        where: {
          periodoId: periodId
        }
      });

      await tx.periodoPagamento.delete({
        where: {
          id: periodId
        }
      });

      await tx.logAuditoria.create({
        data: {
          usuarioId: userId,
          acao: "excluir_periodo_pagamento",
          entidade: "periodos_pagamento",
          entidadeId: periodId,
          ipOrigem: req.ip,
          userAgent: req.get("user-agent") || null,
          detalhes: {
            nome: existing.nome
          }
        }
      });
    });

    void notifyPdfOnline(
      "portal.period.deleted",
      {
        periodId: periodId,
        name: existing.nome
      },
      {
        userId
      }
    ).catch((error) => {
      console.warn("PDF Online bridge period-delete notify failed:", error instanceof Error ? error.message : error);
    });

    res.json({
      message: "Período excluído com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao excluir período.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

export default router;
