import { Router } from "express";
import { z } from "zod";
import { requireAdmin, requireAuth } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";
import { upsertDriverPdfReceivedFromUpload } from "../../lib/driver-pdf-received.js";
import { notifyPdfOnline } from "../../lib/pdfonline-bridge.js";

const router = Router();

router.use(requireAuth, (req, res, next) => {
  if (!req.auth) {
    res.status(401).json({
      message: "Sessao nao autenticada."
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
      message: "Voce nao possui permissao para acessar este modulo."
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

const basePayloadSchema = z.object({
  name: z.string().min(3),
  paymentType: z.enum(["semanal", "quinzenal", "mensal"]),
  active: z.boolean().optional().default(true)
});

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
    createdAt: period.criadoEm,
    updatedAt: period.atualizadoEm,
    createdBy: period.criadoPor.nome,
    bases: period.bases.map((item) => serializeBase(item.basePagamento)),
    uploadedTotal,
    uploadedByBase
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
        message: "Dados invalidos para criacao da base.",
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
        message: "Dados invalidos para edicao da base.",
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
        message: "Base nao encontrada."
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
        message: "Sessao nao autenticada."
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
        message: "Base nao encontrada."
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
      message: "Periodo criado com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao criar periodo.",
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
        message: "Dados invalidos para edicao do periodo.",
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
        message: "Periodo nao encontrado."
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
      message: "Periodo atualizado com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao atualizar periodo.",
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
        message: "Dados invalidos para status do periodo.",
        issues: parsed.success ? undefined : parsed.error.flatten()
      });
      return;
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
        approvedPeriod?.uploads.filter((item) => !childReferences.has(item.id) && item.status !== "removido") || [];
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
                observacoes: `PDF liberado no periodo ${approvedPeriod?.nome || updated.id}`
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
      message: "Status do periodo atualizado com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao alterar status do periodo.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.delete("/:id", requireAdmin, (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({
        message: "Sessao nao autenticada."
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
        message: "Periodo nao encontrado."
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
