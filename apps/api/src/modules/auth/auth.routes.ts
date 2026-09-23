import { Router, type Request } from "express";
import multer from "multer";
import { z } from "zod";
import crypto from "node:crypto";
import { comparePassword, generateSessionToken, hashPassword } from "../../lib/auth.js";
import {
  getUserAccessInclude,
  resolveEffectiveModules,
  resolveEffectivePermissions
} from "../../lib/access.js";
import { requireAuth } from "../../middlewares/auth.middleware.js";
import { prisma } from "../../lib/prisma.js";
import {
  buildStorageObjectUrl,
  createStorageKey,
  deleteObject,
  uploadObject
} from "../../lib/storage.js";

const router = Router();

const profilePhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1
  },
  fileFilter: (_req, file, callback) => {
    const isImage =
      file.mimetype.startsWith("image/") ||
      /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(file.originalname);
    callback(null, isImage);
  }
});

function resolvePhotoUrl(photoPath: string | null) {
  return buildStorageObjectUrl(photoPath);
}

function serializeSessionUser(
  account: Parameters<typeof resolveEffectivePermissions>[0] & {
    id: string;
    nome: string;
    email: string;
    fotoPerfil: string | null;
    nivel: {
      codigo: "N1" | "N2" | "N3" | "N4";
    };
    ativo: boolean;
    bloqueado: boolean;
    primeiroAcesso: boolean;
  },
  modules: string[]
) {
  return {
    id: account.id,
    name: account.nome,
    email: account.email,
    photoUrl: resolvePhotoUrl(account.fotoPerfil),
    level: account.nivel.codigo,
    active: account.ativo,
    blocked: account.bloqueado,
    firstAccess: account.primeiroAcesso,
    permissions: resolveEffectivePermissions(account),
    modules
  };
}

type SsoPayload = {
  iss: "archi";
  aud: "portal-administrativo";
  sub: string;
  name: string;
  email: string;
  role: string;
  base?: string;
  bases?: string[];
  iat: number;
  exp: number;
  jti: string;
};

const usedSsoTokens = new Map<string, number>();

function getSsoSecret() {
  return String(process.env.ARCHI_ADMIN_PORTAL_SSO_SECRET || "").trim();
}

function isSsoOnlyEnabled() {
  const explicitlyEnabled = String(process.env.ADMIN_PORTAL_SSO_ONLY || "").trim().toLowerCase() === "true";
  const productionWithSsoConfigured =
    (process.env.NODE_ENV === "production" || process.env.RAILWAY_ENVIRONMENT_NAME === "production") &&
    Boolean(getSsoSecret());
  return explicitlyEnabled || productionWithSsoConfigured;
}

function verifySsoToken(token: string): SsoPayload | null {
  const secret = getSsoSecret();
  const [encodedPayload, encodedSignature] = token.split(".");
  if (!secret || !encodedPayload || !encodedSignature) return null;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");
  const providedBuffer = Buffer.from(encodedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Partial<SsoPayload>;
    const now = Math.floor(Date.now() / 1000);
    if (
      payload.iss !== "archi" ||
      payload.aud !== "portal-administrativo" ||
      !payload.sub ||
      !payload.email ||
      !["Administrativo", "Administrador", "Fiscal & Financeiro"].includes(payload.role || "") ||
      !payload.jti ||
      !Number.isFinite(payload.iat) ||
      !Number.isFinite(payload.exp) ||
      Number(payload.exp) <= now ||
      Number(payload.iat) > now + 15
    ) {
      return null;
    }

    for (const [jti, expiresAt] of usedSsoTokens) {
      if (expiresAt <= now) usedSsoTokens.delete(jti);
    }
    if (usedSsoTokens.has(payload.jti)) return null;
    usedSsoTokens.set(payload.jti, Number(payload.exp));
    return payload as SsoPayload;
  } catch {
    return null;
  }
}

type PortalAccount = Parameters<typeof serializeSessionUser>[0];

async function issueSessionForAccount(req: Request, account: PortalAccount) {
  const modules = resolveEffectiveModules(account);
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
    data: { ultimoLoginEm: new Date() }
  });

  return {
    token,
    firstAccess: account.primeiroAcesso,
    user: serializeSessionUser(account, modules),
    ipOrigem: req.ip,
    userAgent: req.get("user-agent") || null
  };
}

router.post("/login", (req, res) => {
  void (async () => {
    if (isSsoOnlyEnabled()) {
      res.status(403).json({
        message: "Acesse o Portal Administrativo pelo menu Administrativo do Archi."
      });
      return;
    }

    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(1)
    });

    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: "Dados de login inválidos.",
        issues: parsed.error.flatten()
      });
      return;
    }

    const account = await prisma.usuario.findUnique({
      where: {
        email: parsed.data.email.toLowerCase()
      },
      include: getUserAccessInclude()
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
        message: "Usuário sem acesso liberado."
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
        message: "Credenciais inválidas."
      });
      return;
    }

    const modules = resolveEffectiveModules(account);

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
      user: serializeSessionUser(account, modules)
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao autenticar usuário.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/sso/exchange", (req, res) => {
  void (async () => {
    const parsed = z.object({ token: z.string().min(1).max(4096) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "Código de acesso inválido." });
      return;
    }

    const payload = verifySsoToken(parsed.data.token);
    if (!payload) {
      res.status(401).json({ message: "A autorização do Archi é inválida, expirada ou já foi utilizada." });
      return;
    }

    let account = await prisma.usuario.findUnique({
      where: { email: payload.email.toLowerCase() },
      include: getUserAccessInclude()
    });

    if (account && (account.bloqueado || !account.ativo)) {
      res.status(403).json({ message: "Usuário bloqueado ou inativo no Portal Administrativo." });
      return;
    }

    if (!account) {
      const level = await prisma.nivel.findUnique({ where: { codigo: "N1" } });
      if (!level) {
        res.status(503).json({ message: "Níveis de acesso do Portal Administrativo ainda não foram configurados." });
        return;
      }

      const passwordHash = await hashPassword(crypto.randomBytes(32).toString("hex"));
      account = await prisma.usuario.create({
        data: {
          nome: payload.name.trim().slice(0, 150) || payload.email,
          email: payload.email.toLowerCase(),
          senhaHash: passwordHash,
          nivelId: level.id,
          primeiroAcesso: false
        },
        include: getUserAccessInclude()
      });
    } else if (payload.name.trim() && account.nome !== payload.name.trim().slice(0, 150)) {
      account = await prisma.usuario.update({
        where: { id: account.id },
        data: { nome: payload.name.trim().slice(0, 150) },
        include: getUserAccessInclude()
      });
    }

    const session = await issueSessionForAccount(req, account);
    await prisma.logAuditoria.create({
      data: {
        usuarioId: account.id,
        acao: "login_sso_archi",
        entidade: "usuarios",
        entidadeId: account.id,
        ipOrigem: session.ipOrigem,
        userAgent: session.userAgent,
        detalhes: {
          archiUserId: payload.sub,
          archiRole: payload.role,
          archiBases: payload.bases || []
        }
      }
    });

    res.json({
      token: session.token,
      firstAccess: session.firstAccess,
      user: session.user
    });
  })().catch((error) => {
    console.error("Falha ao trocar autorização SSO do Archi:", error);
    res.status(500).json({ message: "Falha ao autenticar pelo Archi." });
  });
});

router.post("/first-access/change-password", (req, res) => {
  void (async () => {
    if (isSsoOnlyEnabled()) {
      res.status(403).json({ message: "A senha é gerenciada pelo Archi." });
      return;
    }

    const schema = z.object({
      email: z.string().email(),
      currentPassword: z.string().min(1),
      newPassword: z.string().min(6)
    });

    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: "Dados inválidos para troca de senha.",
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
        message: "Usuário não encontrado."
      });
      return;
    }

    const passwordMatches = await comparePassword(parsed.data.currentPassword, account.senhaHash);

    if (!passwordMatches) {
      res.status(401).json({
        message: "Senha atual inválida."
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
      message: "Senha alterada com sucesso.",
      firstAccess: false
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao alterar senha.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.get("/me", requireAuth, (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({
        message: "Sessão inválida."
      });
      return;
    }

    const account = await prisma.usuario.findUnique({
      where: {
        id: req.auth.userId
      },
      include: getUserAccessInclude()
    });

    if (!account) {
      res.status(404).json({
        message: "Usuário não encontrado."
      });
      return;
    }

    const modules = resolveEffectiveModules(account);

    res.json({
      token: req.auth.token,
      firstAccess: account.primeiroAcesso,
      user: serializeSessionUser(account, modules)
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao recuperar sessao.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.post("/logout", requireAuth, (req, res) => {
  void (async () => {
    if (!req.auth) {
      res.status(401).json({
        message: "Sessão inválida."
      });
      return;
    }

    await prisma.sessao.updateMany({
      where: {
        usuarioId: req.auth.userId,
        revogadaEm: null
      },
      data: {
        revogadaEm: new Date()
      }
    });

    await prisma.logAuditoria.create({
      data: {
        usuarioId: req.auth.userId,
        acao: "logout",
        entidade: "usuarios",
        entidadeId: req.auth.userId,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null
      }
    });

    res.json({
      message: "Sessão encerrada com sucesso."
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao encerrar sessao.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

router.patch("/me/profile", requireAuth, profilePhotoUpload.single("photo"), (req, res) => {
  void (async () => {
    if (isSsoOnlyEnabled()) {
      res.status(403).json({ message: "Dados de perfil são administrados pelo Archi." });
      return;
    }

    if (!req.auth) {
      res.status(401).json({
        message: "Sessão inválida."
      });
      return;
    }

    const schema = z.object({
      name: z.string().trim().min(3).optional(),
      currentPassword: z.string().min(1).optional(),
      newPassword: z.string().min(6).optional()
    });

    const parsed = schema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        message: "Dados inválidos para atualização do perfil.",
        issues: parsed.error.flatten()
      });
      return;
    }

    const account = await prisma.usuario.findUnique({
      where: {
        id: req.auth.userId
      }
    });

    if (!account) {
      res.status(404).json({
        message: "Usuário não encontrado."
      });
      return;
    }

    const nextName = parsed.data.name?.trim();
    const nextPassword = parsed.data.newPassword?.trim();
    const currentPassword = parsed.data.currentPassword?.trim();
    const uploadedFile = req.file;
    const updates: {
      nome?: string;
      senhaHash?: string;
      fotoPerfil?: string | null;
      primeiroAcesso?: boolean;
    } = {};

    if (nextName) {
      updates.nome = nextName;
    }

    if (uploadedFile) {
      const nextPhotoPath = createStorageKey("profile-photos", uploadedFile.originalname);
      await uploadObject({
        key: nextPhotoPath,
        body: uploadedFile.buffer,
        contentType: uploadedFile.mimetype
      });
      updates.fotoPerfil = nextPhotoPath;
    }

    if (nextPassword) {
      if (!currentPassword) {
        res.status(400).json({
          message: "Informe a senha atual para alterar a senha."
        });
        return;
      }

      const passwordMatches = await comparePassword(currentPassword, account.senhaHash);

      if (!passwordMatches) {
        res.status(401).json({
          message: "Senha atual inválida."
        });
        return;
      }

      updates.senhaHash = await hashPassword(nextPassword);
      updates.primeiroAcesso = false;
    }

    if (!updates.nome && !updates.senhaHash && updates.fotoPerfil === undefined) {
      res.status(400).json({
        message: "Nenhuma alteração foi enviada."
      });
      return;
    }

    const updatedAccount = await prisma.usuario.update({
      where: {
        id: account.id
      },
      data: updates
    });

    if (account.fotoPerfil && account.fotoPerfil !== updatedAccount.fotoPerfil) {
      void deleteObject(account.fotoPerfil);
    }

    const refreshedAccount = await prisma.usuario.findUniqueOrThrow({
      where: { id: updatedAccount.id },
      include: getUserAccessInclude()
    });
    const modules = resolveEffectiveModules(refreshedAccount);

    await prisma.logAuditoria.create({
      data: {
        usuarioId: account.id,
        acao: "atualizar_perfil",
        entidade: "usuarios",
        entidadeId: account.id,
        ipOrigem: req.ip,
        userAgent: req.get("user-agent") || null,
        detalhes: {
          nomeAlterado: Boolean(updates.nome),
          fotoAlterada: Boolean(updates.fotoPerfil),
          senhaAlterada: Boolean(updates.senhaHash)
        }
      }
    });

    res.json({
      message: "Perfil atualizado com sucesso.",
      user: serializeSessionUser(refreshedAccount, modules)
    });
  })().catch((error) => {
    res.status(500).json({
      message: "Falha ao atualizar perfil.",
      detail: error instanceof Error ? error.message : "Erro desconhecido"
    });
  });
});

export default router;
