import { prisma } from "./prisma.js";

const DRIVER_REGISTRY_TABLE = "driver_registry_entities";

type DriverRegistryTableMetadata = {
  schema: string;
  columns: Set<string>;
};

function isSafeIdentifier(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function quoteIdentifier(value: string) {
  if (!isSafeIdentifier(value)) {
    throw new Error(`Identificador invalido para driver_registry_entities: ${value}`);
  }

  return `"${value}"`;
}

async function getDriverRegistryTableMetadata(): Promise<DriverRegistryTableMetadata | null> {
  const tables = await prisma.$queryRaw<
    Array<{
      table_schema: string;
      table_type: string;
    }>
  >`SELECT table_schema, table_type FROM information_schema.tables WHERE table_name = ${DRIVER_REGISTRY_TABLE} AND table_type = 'BASE TABLE'`;

  if (tables.length === 0) {
    return null;
  }

  const schema =
    tables.find((row) => row.table_schema === "public")?.table_schema ||
    tables[0]?.table_schema ||
    null;

  if (!schema) {
    return null;
  }

  const columns = await prisma.$queryRaw<
    Array<{
      column_name: string;
    }>
  >`SELECT column_name FROM information_schema.columns WHERE table_schema = ${schema} AND table_name = ${DRIVER_REGISTRY_TABLE}`;

  return {
    schema,
    columns: new Set(columns.map((row) => row.column_name.toLowerCase()))
  };
}

export async function ensureDriverRegistryColumns() {
  const metadata = await getDriverRegistryTableMetadata();

  if (!metadata) {
    return;
  }

  const tableRef = `${quoteIdentifier(metadata.schema)}.${quoteIdentifier(DRIVER_REGISTRY_TABLE)}`;
  const columnsToAdd: Array<{ name: string; type: string }> = [
    { name: "base", type: "TEXT" },
    { name: "data_nascimento", type: "DATE" },
    { name: "rg", type: "TEXT" },
    { name: "sexo", type: "TEXT" },
    { name: "placa", type: "TEXT" },
    { name: "nome_favorecido", type: "TEXT" },
    { name: "cpf_favorecido", type: "TEXT" },
    { name: "cpf_favorecido_digits", type: "TEXT" },
    { name: "email_favorecido", type: "TEXT" },
    { name: "telefone_favorecido", type: "TEXT" },
    { name: "validade_gr", type: "DATE" }
  ];

  for (const column of columnsToAdd) {
    if (metadata.columns.has(column.name)) {
      continue;
    }

    await prisma.$executeRawUnsafe(
      `ALTER TABLE ${tableRef} ADD COLUMN IF NOT EXISTS ${quoteIdentifier(column.name)} ${column.type}`
    );
  }
}
