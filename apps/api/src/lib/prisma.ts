import { PrismaClient } from "@prisma/client";
import { resolveDatabaseUrlWithSchema } from "./database-url.js";

declare global {
  var __portalPrisma__: PrismaClient | undefined;
}

const databaseUrl = resolveDatabaseUrlWithSchema();

export const prisma =
  global.__portalPrisma__ ||
  new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl
      }
    },
    log: ["warn", "error"]
  });

if (process.env.NODE_ENV !== "production") {
  global.__portalPrisma__ = prisma;
}
