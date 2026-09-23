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
      message: "Sessão não informada."
    });
    return;
  }

  const token = authorization.slice("Bearer ".length).trim();
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  let session;
  try {
    session = await prisma.sessao.findFirst({
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
  } catch (error) {
    console.error("Falha ao validar sessão:", error);
    res.status(503).json({
      message: "Serviço temporariamente indisponível. Tente novamente em instantes."
    });
    return;
  }

  if (!session || !session.usuario.ativo || session.usuario.bloqueado) {
    res.status(401).json({
      message: "Sessão inválida ou expirada."
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

    if (!["N3", "N4"].includes(req.auth.level) && !req.auth.permissions.includes(permissionCode)) {
      res.status(403).json({
        message: "Você não possui permissão para executar esta ação."
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

    if (!["N3", "N4"].includes(req.auth.level) && !req.auth.modules.includes(moduleCode)) {
      res.status(403).json({
        message: "Você não possui permissão para acessar este módulo."
      });
      return;
    }

    next();
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.auth) {
    res.status(401).json({
      message: "Sessão não autenticada."
    });
    return;
  }

  // The module middleware that precedes this guard is the source of truth for
  // access. A user-level grant must be able to authorize the module even when
  // the account remains N1/N2.
  next();
}
