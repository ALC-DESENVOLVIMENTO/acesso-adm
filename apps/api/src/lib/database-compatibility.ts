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
    table: "periodos_pagamento",
    column: "ativo",
    typeSql: "BOOLEAN NOT NULL DEFAULT TRUE",
    comment: "Adicionar controle de periodo ativo em periodos_pagamento"
  },
  {
    table: "uploads_pdf",
    column: "document_type",
    typeSql: "TEXT",
    comment: "Adicionar tipo de documento em uploads_pdf"
  },
  {
    table: "uploads_pdf",
    column: "content",
    typeSql: "BYTEA",
    comment: "Adicionar coluna content em uploads_pdf"
  },
  {
    table: "uploads_pdf",
    column: "valor_total_pdf",
    typeSql: "NUMERIC(14,2)",
    comment: "Adicionar coluna valor_total_pdf em uploads_pdf"
  },
  {
    table: "uploads_pdf",
    column: "motorista_nome_extraido",
    typeSql: "VARCHAR(180)",
    comment: "Adicionar nome extraido do espelho em uploads_pdf"
  },
  {
    table: "uploads_pdf",
    column: "motorista_cnpj_extraido",
    typeSql: "VARCHAR(20)",
    comment: "Adicionar CNPJ extraido do espelho em uploads_pdf"
  },
  {
    table: "uploads_pdf",
    column: "motivo_pendencia",
    typeSql: "VARCHAR(80)",
    comment: "Adicionar motivo da pendencia de cadastro em uploads_pdf"
  },
  {
    table: "driver_pdf_received",
    column: "document_type",
    typeSql: "TEXT",
    comment: "Adicionar tipo de documento em driver_pdf_received"
  },
  {
    table: "driver_pdf_received",
    column: "tipo_arquivo",
    typeSql: "VARCHAR(80)",
    comment: "Adicionar tipo do arquivo em driver_pdf_received"
  },
  {
    table: "driver_pdf_received",
    column: "content",
    typeSql: "BYTEA",
    comment: "Adicionar coluna content em driver_pdf_received"
  },
  {
    table: "bases_pagamento",
    column: "sigla",
    typeSql: "VARCHAR(255)",
    comment: "Adicionar sigla oficial às bases de pagamento"
  }
];

async function ensureBaseAcronymCapacity() {
  const result = await prisma.$queryRawUnsafe<{ character_maximum_length: number | null }[]>(
    `SELECT character_maximum_length
       FROM information_schema.columns
      WHERE table_schema = '${DB_SCHEMA}'
        AND table_name = 'bases_pagamento'
        AND column_name = 'sigla'`
  );

  const length = result.at(0)?.character_maximum_length;
  if (length !== null && length !== undefined && length < 255) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${DB_SCHEMA}"."bases_pagamento" ALTER COLUMN "sigla" TYPE VARCHAR(255);`);
    console.log("Compatibilidade: ampliado o campo de siglas das bases.");
  }
}

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
  await ensureBaseAcronymCapacity();
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

