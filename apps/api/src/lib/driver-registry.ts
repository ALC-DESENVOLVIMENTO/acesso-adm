import { prisma } from "./prisma.js";

const DRIVER_REGISTRY_TABLE = "driver_registry_entities";
const DRIVER_REGISTRY_SEARCH_NAME_CANDIDATES = [
  "normalized_name",
  "display_name",
  "nome",
  "name",
  "full_name",
  "nome_completo",
  "driver_name",
  "razao_social"
];
const DRIVER_REGISTRY_DISPLAY_NAME_CANDIDATES = [
  "display_name",
  "nome",
  "name",
  "full_name",
  "nome_completo",
  "driver_name",
  "razao_social",
  "normalized_name"
];
const DRIVER_REGISTRY_CPF_CANDIDATES = [
  "cpf_digits",
  "cpf",
  "document_number",
  "documento",
  "documento_numero",
  "cpf_numero",
  "cpf_cnpj"
];
const DRIVER_REGISTRY_CNPJ_CANDIDATES = [
  "cnpj_digits",
  "cnpj",
  "cnpj_favorecido",
  "cnpj_do_favorecido",
  "favorecido_cnpj",
  "beneficiary_cnpj"
];
const DRIVER_REGISTRY_BASE_CANDIDATES = ["base", "unidade", "filial", "base_operacional"];

type DriverRegistryMetadata = {
  schema: string;
  columns: Set<string>;
};

export type DriverRegistryRow = Record<string, unknown>;

export type DriverRegistryMatch = {
  externalId: string;
  nome: string;
  cpf: string;
  cpfDigits: string;
  cnpj: string | null;
  base: string | null;
  raw: DriverRegistryRow;
};

let driverRegistryMetadata: DriverRegistryMetadata | null | undefined;

function isSafeIdentifier(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function quoteIdentifier(value: string) {
  if (!isSafeIdentifier(value)) {
    throw new Error(`Identificador invalido para driver_registry_entities: ${value}`);
  }

  return `"${value}"`;
}

function stripDiacritics(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export function normalizeText(value: string) {
  return stripDiacritics(value)
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function digitsOnly(value: string | null | undefined) {
  return String(value || "").replace(/\D/g, "");
}

function firstNonEmpty(values: Array<unknown>) {
  for (const value of values) {
    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized) {
        return normalized;
      }
      continue;
    }

    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
      return String(value);
    }

    if (value instanceof Date) {
      return value.toISOString();
    }
  }

  return null;
}

function getRecordValue(row: DriverRegistryRow, candidates: string[]) {
  const normalized = new Map<string, unknown>();

  for (const [key, value] of Object.entries(row)) {
    normalized.set(key.toLowerCase(), value);
  }

  return firstNonEmpty(
    candidates.flatMap((key) => {
      const value = normalized.get(key.toLowerCase());
      return value === undefined ? [] : [value];
    })
  );
}

function getColumn(metadata: DriverRegistryMetadata, candidates: string[]) {
  for (const candidate of candidates) {
    if (metadata.columns.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  return null;
}

async function getDriverRegistryMetadata() {
  if (driverRegistryMetadata !== undefined) {
    return driverRegistryMetadata;
  }

  const tables = await prisma.$queryRaw<
    Array<{
      table_schema: string;
      table_type: string;
    }>
  >`SELECT table_schema, table_type FROM information_schema.tables WHERE table_name = ${DRIVER_REGISTRY_TABLE} AND table_type IN ('BASE TABLE', 'VIEW', 'MATERIALIZED VIEW')`;

  if (tables.length === 0) {
    driverRegistryMetadata = null;
    return null;
  }

  const targetSchema =
    tables.find((row) => row.table_schema === "public")?.table_schema ||
    tables.find((row) => row.table_schema === "portal_administrativo")?.table_schema ||
    tables[0]?.table_schema ||
    null;

  if (!targetSchema) {
    driverRegistryMetadata = null;
    return null;
  }

  const columns = await prisma.$queryRaw<
    Array<{
      column_name: string;
    }>
  >`SELECT column_name FROM information_schema.columns WHERE table_schema = ${targetSchema} AND table_name = ${DRIVER_REGISTRY_TABLE}`;

  driverRegistryMetadata = {
    schema: targetSchema,
    columns: new Set(columns.map((row) => row.column_name.toLowerCase()))
  };

  return driverRegistryMetadata;
}

function buildTableRef(schema: string) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(DRIVER_REGISTRY_TABLE)}`;
}

function mapRegistryRow(row: DriverRegistryRow): DriverRegistryMatch {
  const cpf = getRecordValue(row, [...DRIVER_REGISTRY_CPF_CANDIDATES, "documento", "document_number", "documento_numero"]) || "";

  return {
    externalId: String(getRecordValue(row, ["id", "uuid", "codigo", "driver_id", "identificador"]) || ""),
    nome: getRecordValue(row, DRIVER_REGISTRY_DISPLAY_NAME_CANDIDATES) || "Sem nome",
    cpf,
    cpfDigits: digitsOnly(cpf),
    cnpj: getRecordValue(row, [...DRIVER_REGISTRY_CNPJ_CANDIDATES, "cnpj"]) || null,
    base: getRecordValue(row, DRIVER_REGISTRY_BASE_CANDIDATES),
    raw: row
  };
}

function normalizeFilenameBase(fileName: string) {
  const withoutExt = fileName.replace(/\.[^.]+$/, "");
  return normalizeText(
    withoutExt
      .replace(/[_-]\d{2}[-/]\d{2}[-/]\d{2,4}$/g, "")
      .replace(/[_-]+/g, " ")
  );
}

function extractCandidateDigits(fileName: string) {
  const digits = digitsOnly(fileName);

  if (digits.length >= 11) {
    return digits.slice(0, 14);
  }

  return "";
}

export function deriveRegistrySearchFromFileName(fileName: string) {
  return {
    name: normalizeFilenameBase(fileName),
    digits: extractCandidateDigits(fileName)
  };
}

export async function searchDriverRegistryMatches(options: {
  name?: string;
  cpfDigits?: string;
  cnpjDigits?: string;
}) {
  const metadata = await getDriverRegistryMetadata();
  if (!metadata) {
    return [];
  }

  const nameColumn = getColumn(metadata, DRIVER_REGISTRY_SEARCH_NAME_CANDIDATES);
  const cpfColumn = getColumn(metadata, [...DRIVER_REGISTRY_CPF_CANDIDATES, "cpf_numero", "cpf_cnpj"]);
  const cnpjColumn = getColumn(metadata, DRIVER_REGISTRY_CNPJ_CANDIDATES);

  const conditions: string[] = [];
  const params: string[] = [];

  if (options.name && nameColumn) {
    conditions.push(`COALESCE(${quoteIdentifier(nameColumn)}, '') ILIKE $${params.length + 1}`);
    params.push(`%${normalizeText(options.name)}%`);
  }

  if (options.cpfDigits && cpfColumn) {
    conditions.push(
      `regexp_replace(COALESCE(${quoteIdentifier(cpfColumn)}, ''), '\\D', '', 'g') = $${params.length + 1}`
    );
    params.push(digitsOnly(options.cpfDigits));
  }

  if (options.cnpjDigits && cnpjColumn) {
    conditions.push(
      `regexp_replace(COALESCE(${quoteIdentifier(cnpjColumn)}, ''), '\\D', '', 'g') = $${params.length + 1}`
    );
    params.push(digitsOnly(options.cnpjDigits));
  }

  if (conditions.length === 0) {
    return [];
  }

  const tableRef = buildTableRef(metadata.schema);
  const orderBy = nameColumn ? quoteIdentifier(nameColumn) : quoteIdentifier("id");
  const sql = `SELECT * FROM ${tableRef} WHERE ${conditions.join(" AND ")} ORDER BY ${orderBy} ASC LIMIT 20`;
  const rows = await prisma.$queryRawUnsafe<DriverRegistryRow[]>(sql, ...params);

  return rows.map(mapRegistryRow);
}

export async function searchDriverRegistryMatchesByCpfDigits(cpfDigitsList: string[]) {
  const normalizedDigits = Array.from(
    new Set(cpfDigitsList.map((value) => digitsOnly(value)).filter(Boolean))
  );

  if (normalizedDigits.length === 0) {
    return [];
  }

  const metadata = await getDriverRegistryMetadata();
  if (!metadata) {
    return [];
  }

  const cpfColumn = getColumn(metadata, [...DRIVER_REGISTRY_CPF_CANDIDATES, "cpf_numero", "cpf_cnpj"]);

  if (!cpfColumn) {
    return [];
  }

  const tableRef = buildTableRef(metadata.schema);
  const sql = `SELECT * FROM ${tableRef} WHERE regexp_replace(COALESCE(${quoteIdentifier(cpfColumn)}, ''), '\\D', '', 'g') = ANY($1)`;
  const rows = await prisma.$queryRawUnsafe<DriverRegistryRow[]>(sql, normalizedDigits);

  return rows.map(mapRegistryRow);
}

export async function resolveDriverRegistryByIdentity(options: {
  fileName?: string;
  name?: string;
  cpf?: string;
  cnpj?: string;
}) {
  const fileSearch = options.fileName ? deriveRegistrySearchFromFileName(options.fileName) : null;
  const cpfDigits = digitsOnly(options.cpf || fileSearch?.digits || "");
  const cnpjDigits = digitsOnly(options.cnpj || "");
  const name = normalizeText(options.name || fileSearch?.name || "");

  const matches = await searchDriverRegistryMatches({
    name: name || undefined,
    cpfDigits: cpfDigits || undefined,
    cnpjDigits: cnpjDigits || undefined
  });

  if (matches.length === 0) {
    return null;
  }

  let candidates = matches;

  if (name) {
    const exactNameMatches = candidates.filter((item) => {
      const registryName =
        getRecordValue(item.raw, DRIVER_REGISTRY_SEARCH_NAME_CANDIDATES) || item.nome;
      return normalizeText(registryName) === name;
    });

    if (exactNameMatches.length === 1) {
      return exactNameMatches[0];
    }

    if (exactNameMatches.length > 1) {
      candidates = exactNameMatches;
    }
  }

  if (cpfDigits || cnpjDigits) {
    const exactDocumentMatches = candidates.filter(
      (item) =>
        (cpfDigits && item.cpfDigits === cpfDigits) ||
        (cnpjDigits && digitsOnly(item.cnpj) === cnpjDigits)
    );

    if (exactDocumentMatches.length === 1) {
      return exactDocumentMatches[0];
    }

    if (exactDocumentMatches.length > 1) {
      candidates = exactDocumentMatches;
    }
  }

  if (candidates.length === 1) {
    return candidates[0];
  }

  return { ambiguous: true as const, matches: candidates };
}

export async function ensureMotoristaFromRegistryMatch(match: DriverRegistryMatch) {
  const cpfDigits = digitsOnly(match.cpfDigits || match.cpf);

  if (!cpfDigits) {
    return null;
  }

  const existing = await prisma.motorista.findUnique({
    where: {
      cpf: cpfDigits
    },
    select: {
      id: true
    }
  });

  if (existing?.id) {
    return existing.id;
  }

  const created = await prisma.motorista.create({
    data: {
      nome: match.nome,
      cpf: cpfDigits
    },
    select: {
      id: true
    }
  });

  return created.id;
}
