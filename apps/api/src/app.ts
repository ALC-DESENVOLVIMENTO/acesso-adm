import cors from "cors";
import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import authRoutes from "./modules/auth/auth.routes.js";
import atendimentoRoutes from "./modules/atendimento/atendimento.routes.js";
import dashboardRoutes from "./modules/dashboard/dashboard.routes.js";
import financeiroRoutes from "./modules/financeiro/financeiro.routes.js";
import periodsRoutes from "./modules/periods/periods.routes.js";
import webhooksRoutes from "./modules/webhooks/webhooks.routes.js";
import storageRoutes from "./modules/storage/storage.routes.js";
import uploadsRoutes from "./modules/uploads/uploads.routes.js";
import usersRoutes from "./modules/users/users.routes.js";

function parseAllowedOrigins() {
  const configured = [
    process.env.CORS_ORIGINS,
    process.env.CORS_ORIGIN,
    process.env.PORTAL_WEB_ORIGIN,
    process.env.PUBLIC_WEB_URL
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(","))
    .map((value) => value.trim())
    .filter(Boolean);

  return new Set([
    ...configured,
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://portal-administrativo.up.railway.app"
  ]);
}

function isAllowedOrigin(origin: string, allowedOrigins: Set<string>) {
  return allowedOrigins.has(origin);
}

function securityHeaders(_req: express.Request, res: express.Response, next: express.NextFunction) {
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "style-src 'self' 'unsafe-inline' https:",
    "script-src 'self'",
    "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
    "media-src 'self' blob: https:",
    "form-action 'self'"
  ].join("; ");

  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
}

export function createApp() {
  const app = express();
  const allowedOrigins = parseAllowedOrigins();

  app.disable("x-powered-by");
  app.use(securityHeaders);

  // Do not expose database, storage, or implementation details in 5xx JSON responses.
  app.use((_req, res, next) => {
    const sendJson = res.json.bind(res);

    res.json = ((body: unknown) => {
      if (res.statusCode >= 500 && body && typeof body === "object" && !Array.isArray(body)) {
        const { detail: _detail, ...safeBody } = body as Record<string, unknown>;
        return sendJson(safeBody);
      }

      return sendJson(body);
    }) as typeof res.json;

    next();
  });

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || isAllowedOrigin(origin, allowedOrigins)) {
          callback(null, true);
          return;
        }

        callback(new Error("Origem não permitida pelo CORS."));
      },
      credentials: true
    })
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "portal-administrativo-api"
    });
  });

  app.use("/api/auth", authRoutes);
  app.use("/api/atendimento", atendimentoRoutes);
  app.use("/api/dashboard", dashboardRoutes);
  app.use("/api/financeiro", financeiroRoutes);
  app.use("/api/periods", periodsRoutes);
  app.use("/api/storage", storageRoutes);
  app.use("/api/uploads", uploadsRoutes);
  app.use("/api/webhooks", webhooksRoutes);
  app.use("/api/users", usersRoutes);

  app.use("/api", (_req, res) => {
    res.status(404).json({
      message: "Rota da API não encontrada."
    });
  });

  const webDistPath = path.resolve(process.cwd(), "../web/dist");

  if (existsSync(webDistPath)) {
    app.use(express.static(webDistPath));

    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) {
        next();
        return;
      }

      res.sendFile(path.join(webDistPath, "index.html"));
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("Erro não tratado na API:", error instanceof Error ? error.message : error);

    if (res.headersSent) {
      return;
    }

    res.status(500).json({
      message: "Ocorreu um erro interno. Tente novamente."
    });
  });

  return app;
}
