import { Router } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth, requireModuleAccess } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";

const router = Router();

router.use(requireAuth, requireModuleAccess("pdfs"));

const periodPayloadSchema = z.object({
  name: z.string().min(3),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  paymentType: z.enum(["semanal", "quinzenal", "mensal"])
});

function serializeBase(base: { id: string; nome: string; tipoPadrao: string }) {
  return {
    id: base.id,
    name: base.nome,
    paymentType: base.tipoPadrao,
    active: true
  };
}

function serializePeriod(period: {
  id: string;
  nome: string;
  dataInicio: Date;
  dataFim: Date;
  tipo: string;
  status: string;
  bases: Array<{
    basePagamento: {
      id: string;
      nome: string;
      tipoPadrao: string;
    };
  }>;
  uploads: Array<{
    id: string;
    basePagamentoId: string | null;
    substituiUploadId: string | null;
  }>;
}) {
  const childReferences = new Set(
    period.uploads
      .map((item) => item.substituiUploadId)
      .filter((value): value is string => Boolean(value))
  );

  const visibleUploads = period.uploads.filter((item) => !childReferences.has(item.id));
  const uploadedByBase: Record<string, number> = {};

  for (const upload of visibleUploads) {
    if (!upload.basePagamentoId) {
      continue;
    }

    uploadedByBase[upload.basePagamentoId] = (uploadedByBase[upload.basePagamentoId] || 0) + 1;
  }

  const uploadedTotal = visibleUploads.length;
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
    startDate: period.dataInicio,
    endDate: period.dataFim,
    paymentType: period.tipo,
    status: derivedStatus,
    bases: period.bases.map((item) => serializeBase(item.basePagamento)),
    uploadedTotal,
    uploadedByBase
  };
}

router.get("/bases", (_req, res) => {
  void (async () => {
    const bases = await prisma.basePagamento.findMany({
      where: {
        ativo: true
      },
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

router.get("/", (_req, res) => {
  void (async () => {
    const periods = await prisma.periodoPagamento.findMany({
      include: {
        bases: {
          include: {
            basePagamento: true
          }
        },
        uploads: {
          select: {
            id: true,
            basePagamentoId: true,
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
        message: "Dados invalidos para criacao do periodo.",
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
        message: "Nao existem bases cadastradas para o tipo selecionado."
      });
      return;
    }

    const period = await prisma.periodoPagamento.create({
      data: {
        nome: parsed.data.name,
        dataInicio: new Date(parsed.data.startDate),
        dataFim: new Date(parsed.data.endDate),
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
            basePagamentoId: true,
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

    res.status(201).json({
      message: "Periodo criado com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao criar periodo.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.delete("/:id", requireAdmin, (req, res) => {
  void (async () => {
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
        message: "Periodo nao encontrado."
      });
      return;
    }

    await prisma.periodoPagamento.delete({
      where: {
        id: periodId
      }
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: req.auth?.userId || "system",
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

    res.json({
      message: "Periodo excluido com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao excluir periodo.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

export default router;
