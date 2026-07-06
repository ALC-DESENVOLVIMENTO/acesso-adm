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

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin: true,
      credentials: true
    })
  );
  app.use(express.json());

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

  return app;
}
