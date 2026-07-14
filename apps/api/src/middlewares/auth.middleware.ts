import crypto from "node:crypto";
import { NextFunction, Request, Response } from "express";
import {
  getUserAccessInclude,
  resolveEffectiveModules,
  resolveEffectivePermissions
} from "../lib/access.js";
import { prisma } from "../lib/prisma.js";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        token: string;
        userId: string;
      level: "N1" | "N2" | "N3" | "N4";
      modules: string[];
      permissions: string[];
      firstAccess: boolean;
      name: string;
      email: string;
      };
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authorization = req.get("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    res.status(401).json({
      message: "Sessao nao informada."
    });
    return;
  }

  const token = authorization.slice("Bearer ".length).trim();
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const session = await prisma.sessao.findFirst({
    where: {
      tokenHash,
      revogadaEm: null,
      expiraEm: {
        gt: new Date()
      }
    },
    include: {
      usuario: {
        include: getUserAccessInclude()
      }
    }
  });

  if (!session || !session.usuario.ativo || session.usuario.bloqueado) {
    res.status(401).json({
      message: "Sessao invalida ou expirada."
    });
    return;
  }

  req.auth = {
    token,
    userId: session.usuario.id,
    level: session.usuario.nivel.codigo,
    modules: resolveEffectiveModules(session.usuario),
    permissions: resolveEffectivePermissions(session.usuario),
    firstAccess: session.usuario.primeiroAcesso,
    name: session.usuario.nome,
    email: session.usuario.email
  };

  next();
}

export function requirePermission(permissionCode: string) {
  return (req: Request, res: Response, next: NextFunction) => {
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

    if (!req.auth.permissions.includes(permissionCode)) {
      res.status(403).json({
        message: "Voce nao possui permissao para executar esta acao."
      });
      return;
    }

    next();
  };
}

export function requireModuleAccess(moduleCode: string) {
  return (req: Request, res: Response, next: NextFunction) => {
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

    if (!req.auth.modules.includes(moduleCode)) {
      res.status(403).json({
        message: "Voce nao possui permissao para acessar este modulo."
      });
      return;
    }

    next();
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.auth) {
    res.status(401).json({
      message: "Sessao nao autenticada."
    });
    return;
  }

  if (!["N3", "N4"].includes(req.auth.level)) {
    res.status(403).json({
      message: "Acesso restrito a administradores."
    });
    return;
  }

  next();
}
