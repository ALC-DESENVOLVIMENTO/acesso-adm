import { prisma } from "./prisma.js";

const DB_SCHEMA = process.env.DB_SCHEMA || "portal_administrativo";

type CompatibilityColumn = {
  table: string;
  column: string;
  typeSql: string;
  comment: string;
};

const REQUIRED_UPLOAD_TABLE_COLUMNS: CompatibilityColumn[] = [
  {
    table: "uploads_pdf",
    column: "content",
    typeSql: "BYTEA",
    comment: "Adicionar coluna content em uploads_pdf"
  },
  {
    table: "uploads_pdf",
    column: "base_identificada",
    typeSql: "VARCHAR(150)",
    comment: "Adicionar coluna base_identificada em uploads_pdf"
  },
  {
    table: "driver_pdf_received",
    column: "content",
    typeSql: "BYTEA",
    comment: "Adicionar coluna content em driver_pdf_received"
  }
];

async function hasColumn(table: string, column: string) {
  const result = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = '${DB_SCHEMA}'
        AND table_name = '${table}'
        AND column_name = '${column}'
    ) AS exists;`
  );

  return Boolean(result.at(0)?.exists);
}

export async function ensureDatabaseCompatibilityColumns() {
  for (const item of REQUIRED_UPLOAD_TABLE_COLUMNS) {
    const exists = await hasColumn(item.table, item.column);

    if (exists) {
      continue;
    }

    const alterSql =
      `ALTER TABLE "${DB_SCHEMA}"."${item.table}" ADD COLUMN IF NOT EXISTS "${item.column}" ${item.typeSql};`;

    try {
      await prisma.$executeRawUnsafe(alterSql);
      console.log(`Compatibilidade: ${item.comment}.`);
    } catch (error) {
      console.error(`Falha ao ajustar coluna de compatibilidade em ${item.table}.${item.column}:`, error);
      throw error;
    }
  }
}

