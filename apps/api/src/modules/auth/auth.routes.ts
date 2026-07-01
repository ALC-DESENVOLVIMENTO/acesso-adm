import { Router } from "express";
import { z } from "zod";
import { comparePassword, generateSessionToken, hashPassword } from "../../lib/auth.js";
import { prisma } from "../../lib/prisma.js";

const router = Router();

router.post("/login", (req, res) => {
  void (async () => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(1)
    });

    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: "Dados de login invalidos.",
        issues: parsed.error.flatten()
      });
      return;
    }

    const account = await prisma.usuario.findUnique({
      where: {
        email: parsed.data.email.toLowerCase()
      },
      include: {
        nivel: true
      }
    });

    if (!account || account.bloqueado || !account.ativo) {
      await prisma.logAuditoria.create({
        data: {
          acao: "login_falhou",
          entidade: "usuarios",
          ipOrigem: req.ip,
          userAgent: req.get("user-agent") || null,
          detalhes: {
            email: parsed.data.email.toLowerCase(),
            motivo: "usuario_invalido_ou_bloqueado"
          }
        }
      });

      res.status(401).json({
        message: "Usuario sem acesso liberado."
      });
      return;
    }

    const passwordMatches = await comparePassword(parsed.data.password, account.senhaHash);

    if (!passwordMatches) {
      await prisma.logAuditoria.create({
        data: {
          usuarioId: account.id,
          acao: "login_falhou",
          entidade: "usuarios",
          entidadeId: account.id,
          ipOrigem: req.ip,
          userAgent: req.get("user-agent") || null,
          detalhes: {
            motivo: "senha_invalida"
          }
        }
      });

      res.status(401).json({
        message: "Credenciais invalidas."
      });
      return;
    }

    const levelPermissions = await prisma.permissaoPorNivel.findMany({
      where: {
        nivelId: account.nivelId
      },
      include: {
        permissao: {
          include: {
            modulo: true
          }
        }
      }
    });

    const userOverrides = await prisma.permissaoPorUsuario.findMany({
      where: {
        usuarioId: account.id
      },
      include: {
        permissao: {
          include: {
            modulo: true
          }
        }
      }
    });

    const modules = new Set(levelPermissions.map((item) => item.permissao.modulo.codigo));

    for (const override of userOverrides) {
      const moduleCode = override.permissao.modulo.codigo;

      if (override.tipo === "grant") {
        modules.add(moduleCode);
      }

      if (override.tipo === "deny") {
        modules.delete(moduleCode);
      }
    }

    const { token, tokenHash } = generateSessionToken();
    await prisma.sessao.create({
      data: {
        usuarioId: account.id,
        tokenHash,
        expiraEm: new Date(Date.now() + 1000 * 60 * 60 * 8)
      }
    });

    await prisma.usuario.update({
      where: { id: account.id },
      data: {
        ultimoLoginEm: new Date()
      }
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: account.id,
        acao: "login",
        entidade: "usuarios",
        entidadeId: account.id,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null,
        detalhes: {
          nivel: account.nivel.codigo
        }
      }
    });

    res.json({
      token,
      firstAccess: account.primeiroAcesso,
      user: {
        id: account.id,
        name: account.nome,
        email: account.email,
        level: account.nivel.codigo,
        active: account.ativo,
        blocked: account.bloqueado,
        firstAccess: account.primeiroAcesso,
        modules: Array.from(modules)
      }
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao autenticar usuario.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/first-access/change-password", (req, res) => {
  void (async () => {
    const schema = z.object({
      email: z.string().email(),
      currentPassword: z.string().min(1),
      newPassword: z.string().min(6)
    });

    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: "Dados invalidos para troca de senha.",
        issues: parsed.error.flatten()
      });
      return;
    }

    const account = await prisma.usuario.findUnique({
      where: {
        email: parsed.data.email.toLowerCase()
      }
    });

    if (!account) {
      res.status(404).json({
        message: "Usuario nao encontrado."
      });
      return;
    }

    const passwordMatches = await comparePassword(parsed.data.currentPassword, account.senhaHash);

    if (!passwordMatches) {
      res.status(401).json({
        message: "Senha atual invalida."
      });
      return;
    }

    const newPasswordHash = await hashPassword(parsed.data.newPassword);

    await prisma.usuario.update({
      where: { id: account.id },
      data: {
        senhaHash: newPasswordHash,
        primeiroAcesso: false
      }
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: account.id,
        acao: "alteracao_senha_primeiro_acesso",
        entidade: "usuarios",
        entidadeId: account.id,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null
      }
    });

    res.json({
      message: "Senha alterada com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao alterar senha.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

export default router;
