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

export async function ensureArchiDriverSourceViews() {
  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE VIEW public.archi_motoristas_aprovados AS
    SELECT
      (
        substr(md5(motorista.id), 1, 8) || '-' || substr(md5(motorista.id), 9, 4) || '-' ||
        substr(md5(motorista.id), 13, 4) || '-' || substr(md5(motorista.id), 17, 4) || '-' ||
        substr(md5(motorista.id), 21, 12)
      )::uuid AS id,
      motorista.name::text AS display_name,
      lower(btrim(motorista.name))::text AS normalized_name,
      COALESCE(motorista.extra_data ->> 'razaoSocial', '')::text AS cnpj,
      regexp_replace(COALESCE(motorista.extra_data ->> 'razaoSocial', ''), '\\D', '', 'g')::text AS cnpj_digits,
      motorista.cpf::text AS cpf,
      regexp_replace(motorista.cpf, '\\D', '', 'g')::text AS cpf_digits,
      NULLIF(motorista.extra_data ->> 'email', '')::text AS email,
      NULLIF(motorista.phone, '')::text AS phone,
      CASE WHEN upper(COALESCE(motorista.type, '')) LIKE 'RENT%' THEN 'RENTAL' ELSE 'SPOT' END::text AS driver_type,
      CASE WHEN upper(COALESCE(motorista.type, '')) LIKE 'RENT%' THEN 'rental_company' ELSE 'favored_only' END::text AS signup_policy,
      TRUE AS active,
      1::integer AS source_count,
      motorista.created_at AS created_at,
      motorista.updated_at AS updated_at,
      NULLIF(motorista.base, '')::text AS base,
      CASE WHEN COALESCE(motorista.extra_data ->> 'dataNascimento', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
        THEN substr(motorista.extra_data ->> 'dataNascimento', 1, 10)::date ELSE NULL END AS data_nascimento,
      NULLIF(motorista.extra_data ->> 'rg', '')::text AS rg,
      NULLIF(motorista.extra_data ->> 'sexo', '')::text AS sexo,
      NULLIF(motorista.extra_data ->> 'placa', '')::text AS placa,
      NULLIF(motorista.extra_data ->> 'favorecido', '')::text AS nome_favorecido,
      NULLIF(motorista.extra_data ->> 'cpfFavorecido', '')::text AS cpf_favorecido,
      NULLIF(regexp_replace(COALESCE(motorista.extra_data ->> 'cpfFavorecido', ''), '\\D', '', 'g'), '')::text AS cpf_favorecido_digits,
      NULLIF(motorista.extra_data ->> 'emailFavorecido', '')::text AS email_favorecido,
      NULLIF(motorista.extra_data ->> 'telefoneFavorecido', '')::text AS telefone_favorecido,
      CASE WHEN COALESCE(motorista.extra_data ->> 'validadeGR', '') ~ '^\\d{4}-\\d{2}-\\d{2}'
        THEN substr(motorista.extra_data ->> 'validadeGR', 1, 10)::date ELSE NULL END AS validade_gr
    FROM public.motoristas motorista
    WHERE lower(btrim(COALESCE(motorista.extra_data ->> 'gerencialGrStatus', ''))) IN (
      'aprovado', 'aprovado com ressalva', 'aprovado com resalva'
    )
      AND length(regexp_replace(motorista.cpf, '\\D', '', 'g')) = 11
  `);

  await prisma.$executeRawUnsafe(`
    CREATE OR REPLACE VIEW public.driver_registry_effective AS
    SELECT approved.*, 'archi'::text AS _source
    FROM public.archi_motoristas_aprovados approved
    UNION ALL
    SELECT legacy_current.*, 'legacy'::text AS _source
    FROM (
      SELECT DISTINCT ON (legacy.cpf_digits) legacy.*
      FROM public.driver_registry_entities legacy
      WHERE NOT EXISTS (
        SELECT 1 FROM public.motoristas motorista
        WHERE regexp_replace(motorista.cpf, '\\D', '', 'g') = legacy.cpf_digits
      )
      ORDER BY legacy.cpf_digits, legacy.updated_at DESC, legacy.source_count DESC, legacy.id DESC
    ) legacy_current
  `);
}
