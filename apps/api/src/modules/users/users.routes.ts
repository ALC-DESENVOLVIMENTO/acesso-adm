import { Router } from "express";
import { AccessLevelCode } from "@prisma/client";
import { z } from "zod";
import { getUserAccessInclude, resolveEffectiveModules, syncUserModuleOverrides } from "../../lib/access.js";
import { hashPassword } from "../../lib/auth.js";
import { requireAdmin, requireAuth, requireModuleAccess } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";

const router = Router();

const userPayloadSchema = z.object({
  name: z.string().min(3),
  email: z.string().email(),
  level: z.enum(["N1", "N2", "N3", "N4"]),
  modules: z.array(z.string()).default(["dashboard", "pdfs"])
});

router.use(requireAuth, requireModuleAccess("users"), requireAdmin);

router.get("/", (_req, res) => {
  void (async () => {
    const users = await prisma.usuario.findMany({
      include: getUserAccessInclude(),
      orderBy: {
        nome: "asc"
      }
    });

    res.json(
      users.map((user) => ({
        id: user.id,
        name: user.nome,
        email: user.email,
        level: user.nivel.codigo,
        active: user.ativo,
        blocked: user.bloqueado,
        firstAccess: user.primeiroAcesso,
        lastLoginAt: user.ultimoLoginEm,
        modules: resolveEffectiveModules(user)
      }))
    );
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao listar usuários.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/", (req, res) => {
  void (async () => {
    const parsed = userPayloadSchema.safeParse(req.body);

    if (!parsed.success || !req.auth) {
      res.status(400).json({
        message: "Dados inválidos para cadastro de usuário.",
        issues: parsed.success ? undefined : parsed.error.flatten()
      });
      return;
    }

    const level = await prisma.nivel.findUnique({
      where: {
        codigo: parsed.data.level as AccessLevelCode
      }
    });

    if (!level) {
      res.status(404).json({
        message: "Nivel informado nao existe."
      });
      return;
    }

    const passwordHash = await hashPassword("0000");

    const user = await prisma.usuario.create({
      data: {
        nome: parsed.data.name,
        email: parsed.data.email.toLowerCase(),
        senhaHash: passwordHash,
        nivelId: level.id,
        primeiroAcesso: true
      }
    });

    await syncUserModuleOverrides({
      userId: user.id,
      levelId: level.id,
      desiredModules: parsed.data.modules,
      grantedByUserId: req.auth.userId
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: req.auth.userId,
        acao: "criar_usuario",
        entidade: "usuarios",
        entidadeId: user.id,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null,
        detalhes: {
          email: user.email,
          nivel: parsed.data.level
        }
      }
    });

    res.status(201).json({
      message: "Usuario criado com senha temporaria 0000."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao criar usuário.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.patch("/:id", (req, res) => {
  void (async () => {
    const parsed = userPayloadSchema.safeParse(req.body);

    if (!parsed.success || !req.auth) {
      res.status(400).json({
        message: "Dados inválidos para edição de usuário.",
        issues: parsed.success ? undefined : parsed.error.flatten()
      });
      return;
    }

    const level = await prisma.nivel.findUnique({
      where: {
        codigo: parsed.data.level as AccessLevelCode
      }
    });

    if (!level) {
      res.status(404).json({
        message: "Nivel informado nao existe."
      });
      return;
    }

    const user = await prisma.usuario.update({
      where: {
        id: req.params.id
      },
      data: {
        nome: parsed.data.name,
        email: parsed.data.email.toLowerCase(),
        nivelId: level.id
      }
    });

    await syncUserModuleOverrides({
      userId: user.id,
      levelId: level.id,
      desiredModules: parsed.data.modules,
      grantedByUserId: req.auth.userId
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: req.auth.userId,
        acao: "editar_usuario",
        entidade: "usuarios",
        entidadeId: user.id,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null,
        detalhes: {
          email: user.email,
          nivel: parsed.data.level
        }
      }
    });

    res.json({
      message: "Usuario atualizado com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao editar usuário.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.patch("/:id/status", (req, res) => {
  void (async () => {
    const schema = z.object({
      active: z.boolean().optional(),
      blocked: z.boolean().optional()
    });
    const parsed = schema.safeParse(req.body);

    if (!parsed.success || !req.auth) {
      res.status(400).json({
        message: "Dados inválidos para status do usuário.",
        issues: parsed.success ? undefined : parsed.error.flatten()
      });
      return;
    }

    await prisma.usuario.update({
      where: {
        id: req.params.id
      },
      data: {
        ativo: parsed.data.active,
        bloqueado: parsed.data.blocked
      }
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: req.auth.userId,
        acao: "alterar_status_usuario",
        entidade: "usuarios",
        entidadeId: req.params.id,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null,
        detalhes: parsed.data
      }
    });

    res.json({
      message: "Status do usuário atualizado."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao atualizar status do usuário.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.delete("/:id", (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({
        message: "Sessão inválida."
      });
      return;
    }

    const user = await prisma.usuario.findUnique({
      where: {
        id: req.params.id
      }
    });

    if (!user) {
      res.status(404).json({
        message: "Usuario nao encontrado."
      });
      return;
    }

    if (req.auth.userId === user.id) {
      res.status(400).json({
        message: "Não é permitido excluir o próprio usuário."
      });
      return;
    }

    await prisma.$transaction([
      prisma.permissaoPorUsuario.deleteMany({
        where: {
          OR: [{ usuarioId: user.id }, { concedidoPor: user.id }]
        }
      }),
      prisma.sessao.deleteMany({
        where: {
          usuarioId: user.id
        }
      }),
      prisma.uploadPdf.deleteMany({
        where: {
          usuarioId: user.id
        }
      }),
      prisma.chamado.deleteMany({
        where: {
          OR: [{ solicitanteId: user.id }, { responsavelId: user.id }]
        }
      }),
      prisma.logAuditoria.deleteMany({
        where: {
          usuarioId: user.id
        }
      }),
      prisma.usuario.delete({
        where: {
          id: user.id
        }
      }),
      prisma.logAuditoria.create({
        data: {
          usuarioId: req.auth.userId,
          acao: "excluir_usuario",
          entidade: "usuarios",
          entidadeId: user.id,
          ipOrigem: req.ip,
          userAgent: req.get("user-agent") || null,
          detalhes: {
            email: user.email,
            nome: user.nome,
            nivelId: user.nivelId
          }
        }
      })
    ]);

    res.json({
      message: "Usuario excluido permanentemente."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao excluir usuário.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/:id/reset-password", (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({
        message: "Sessão inválida."
      });
      return;
    }

    const passwordHash = await hashPassword("0000");

    await prisma.usuario.update({
      where: {
        id: req.params.id
      },
      data: {
        senhaHash: passwordHash,
        primeiroAcesso: true
      }
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: req.auth.userId,
        acao: "resetar_senha_usuario",
        entidade: "usuarios",
        entidadeId: req.params.id,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null
      }
    });

    res.json({
      message: "Senha redefinida para 0000 e primeiro acesso reativado."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao redefinir senha do usuário.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

export default router;
