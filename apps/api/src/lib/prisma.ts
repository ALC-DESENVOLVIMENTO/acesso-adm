import { PrismaClient } from "@prisma/client";
import { withDatabaseSchema } from "./database-url.js";

declare global {
  var __portalPrisma__: PrismaClient | undefined;
}

export const prisma =
  global.__portalPrisma__ ||
  new PrismaClient({
    datasources: {
      db: {
        url: withDatabaseSchema(process.env.DATABASE_URL)
      }
    },
    log: ["warn", "error"]
  });

if (process.env.NODE_ENV !== "production") {
  global.__portalPrisma__ = prisma;
}
