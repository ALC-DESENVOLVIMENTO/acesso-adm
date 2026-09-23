import { prisma } from "./prisma.js";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

const DRIVER_REGISTRY_TABLE = process.env.ARCHI_DRIVER_SOURCE_ENABLED === "true"
  ? "driver_registry_effective"
  : "driver_registry_entities";
const DRIVER_REGISTRY_SEARCH_NAME_CANDIDATES = [
  "display_name",
  "normalized_name",
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
  "mei",
  "cnpjFavorecido",
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
  nomeFavorecido?: string | null;
  statusArchi?: string | null;
  base: string | null;
  bases?: string[];
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

export function getDriverBases(row: DriverRegistryRow) {
  const extraData = decodeExtraData(row.extra_data);
  const formPayload = decodeExtraData(row.form_payload);
  const additionalBases = [
    ...(Array.isArray(extraData.bases) ? extraData.bases : []),
    ...(Array.isArray(formPayload.bases) ? formPayload.bases : []),
    ...(Array.isArray(row.bases) ? row.bases : [])
  ];
  const primaryBase = getRecordValue(row, DRIVER_REGISTRY_BASE_CANDIDATES);
  return Array.from(new Set([primaryBase, ...additionalBases]
    .map((base) => String(base || "").trim())
    .filter(Boolean)));
}

export function driverMatchesBase(row: DriverRegistryRow, base: string) {
  const expected = normalizeText(base);
  return Boolean(expected) && getDriverBases(row).some((candidate) => normalizeText(candidate) === expected);
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

/**
 * ARCHI may persist the complete form payload as `grzjson:<base64-gzip>`.
 * Keep the decoding here, at the integration boundary, so every consumer
 * reads the same authoritative values that ARCHI displays in its form.
 */
function decodeExtraData(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== "string" || !value.startsWith("grzjson:")) {
    return {};
  }

  try {
    const decoded = JSON.parse(gunzipSync(Buffer.from(value.slice("grzjson:".length), "base64")).toString("utf8"));
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : {};
  } catch {
    // A malformed optional payload must not break the whole registry query.
    return {};
  }
}

function isUsableDriverName(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length < 3 || /^\.\.\/?-$/.test(normalized)) return false;
  if (/^[\d\s./()-]+$/.test(normalized)) return false;
  return normalized.split(/\s+/).filter(Boolean).length >= 2;
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
  const extraData = decodeExtraData(row.extra_data);
  const formPayload = decodeExtraData(row.form_payload);
  const values = { ...extraData, ...row };
  const nomeFavorecido =
    getRecordValue(values, ["nome_favorecido", "favored_name", "nomeFavorecido", "favorecido_nome", "beneficiary_name"]) ||
    firstNonEmpty([
      extraData.nome_favorecido,
      extraData.favored_name,
      extraData.nomeFavorecido,
      extraData.favorecido_nome,
      extraData.beneficiary_name
    ]);

  const nameCandidates = [
    extraData.nome,
    extraData.name,
    extraData.display_name,
    extraData.razaoSocial,
    getRecordValue(row, DRIVER_REGISTRY_DISPLAY_NAME_CANDIDATES)
  ].filter(isUsableDriverName).map((value) => String(value).trim());
  const authoritativeName = nameCandidates.sort((left, right) => right.length - left.length)[0] || "Sem nome";
  const bases = getDriverBases({ ...row, extra_data: extraData, form_payload: formPayload });

  return {
    externalId: String(getRecordValue(row, ["id", "uuid", "codigo", "driver_id", "identificador"]) || ""),
    nome: authoritativeName,
    cpf,
    cpfDigits: digitsOnly(cpf),
    cnpj: getRecordValue(values, [...DRIVER_REGISTRY_CNPJ_CANDIDATES, "cnpj"]) || null,
    nomeFavorecido,
    statusArchi: getRecordValue(row, ["status", "status_cadastro", "statusCadastro", "situacao"]),
    base: getRecordValue(row, DRIVER_REGISTRY_BASE_CANDIDATES),
    bases,
    raw: { ...row, extra_data: extraData, form_payload: formPayload, bases }
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

/**
 * ARCHI is the authoritative source. Only records whose overall workflow is
 * approved (including approved with reservation) are exposed to consumers.
 */
export async function searchArchiDriverMatches(options: {
  name?: string;
  cpfDigits?: string;
  cnpjDigits?: string;
  approvedOnly?: boolean;
}) {
  const tables = await prisma.$queryRaw<Array<{ table_schema: string }>>`
    SELECT table_schema FROM information_schema.tables
    WHERE table_name = 'motoristas' AND table_schema = 'public' AND table_type = 'BASE TABLE'
    LIMIT 1
  `;
  if (!tables.length) return [];

  const conditions: string[] = [];
  if (options.approvedOnly !== false) {
    conditions.push(`LOWER(COALESCE(status, '')) IN ('aprovado', 'aprovado com ressalva')`);
  }
  const params: string[] = [];
  if (options.name) {
    conditions.push(`LOWER(COALESCE(name, '')) ILIKE $${params.length + 1}`);
    params.push(`%${options.name}%`);
  }
  if (options.cpfDigits) {
    conditions.push(`regexp_replace(COALESCE(cpf, ''), '\\D', '', 'g') = $${params.length + 1}`);
    params.push(digitsOnly(options.cpfDigits));
  }
  // CNPJ/favorecido can be inside ARCHI's compressed `grzjson` payload, which
  // PostgreSQL cannot inspect with JSON operators. Fetch the identity scope
  // first and validate the document after decoding in mapRegistryRow.
  const whereClause = conditions.length > 0 ? conditions.join(" AND ") : "TRUE";
  const rows = await prisma.$queryRawUnsafe<DriverRegistryRow[]>(`
    SELECT id, name AS display_name, name, cpf, cpf AS cpf_digits,
      COALESCE(NULLIF(BTRIM(extra_data->>'cnpj'), ''), NULLIF(BTRIM(extra_data->>'cnpjProprietario'), ''), NULLIF(BTRIM(extra_data->>'documentoEmpresa'), ''), NULLIF(BTRIM(extra_data->>'mei'), ''), NULLIF(BTRIM(extra_data->>'cnpjFavorecido'), '')) AS cnpj,
      COALESCE(NULLIF(BTRIM(extra_data->>'cnpj'), ''), NULLIF(BTRIM(extra_data->>'cnpjProprietario'), ''), NULLIF(BTRIM(extra_data->>'documentoEmpresa'), ''), NULLIF(BTRIM(extra_data->>'mei'), ''), NULLIF(BTRIM(extra_data->>'cnpjFavorecido'), '')) AS cnpj_digits,
      base, status, status_cadastro, gerenciadora_risco, extra_data, updated_at,
      form.payload AS form_payload
    FROM public.motoristas
    LEFT JOIN LATERAL (
      SELECT payload FROM public.motorista_formularios
      WHERE motorista_id = public.motoristas.id
      LIMIT 1
    ) form ON TRUE
    WHERE ${whereClause}
    ORDER BY CASE
      WHEN LOWER(COALESCE(status, '')) IN ('aprovado', 'aprovado com ressalva') THEN 1
      WHEN LOWER(COALESCE(status, '')) LIKE '%andamento%'
        OR LOWER(COALESCE(status, '')) LIKE '%analise%'
        OR LOWER(COALESCE(status, '')) LIKE '%pré-seleção%'
        OR LOWER(COALESCE(status, '')) LIKE '%pre-selecao%' THEN 2
      WHEN LOWER(COALESCE(status, '')) LIKE '%reprov%'
        OR LOWER(COALESCE(status, '')) LIKE '%rejeit%' THEN 3
      ELSE 4
    END,
    updated_at DESC NULLS LAST,
    id ASC
    LIMIT 1000
  `, ...params);
  const matches = rows.map(mapRegistryRow);
  if (!options.cnpjDigits) {
    return matches;
  }

  const expectedCnpj = digitsOnly(options.cnpjDigits);
  return matches.filter((match) => digitsOnly(match.cnpj) === expectedCnpj);
}

export async function searchArchiDriverMatchesBulk(options: {
  cnpjDigitsList?: string[];
  names?: string[];
  approvedOnly?: boolean;
}) {
  const tables = await prisma.$queryRaw<Array<{ table_schema: string }>>`
    SELECT table_schema FROM information_schema.tables
    WHERE table_name = 'motoristas' AND table_schema = 'public' AND table_type = 'BASE TABLE'
    LIMIT 1
  `;
  if (!tables.length) return [];

  const cnpjDigitsList = Array.from(
    new Set((options.cnpjDigitsList || []).map((value) => digitsOnly(value)).filter((value) => value.length === 14))
  );
  const names = Array.from(
    new Set((options.names || []).map((value) => normalizeText(value)).filter(Boolean))
  );
  const conditions: string[] = [];
  const identityConditions: string[] = [];
  const params: unknown[] = [];

  if (options.approvedOnly !== false) {
    conditions.push(`LOWER(COALESCE(status, '')) IN ('aprovado', 'aprovado com ressalva')`);
  }

  const cnpjExpression = `regexp_replace(COALESCE(NULLIF(BTRIM(extra_data->>'cnpj'), ''), NULLIF(BTRIM(extra_data->>'cnpjProprietario'), ''), NULLIF(BTRIM(extra_data->>'documentoEmpresa'), ''), NULLIF(BTRIM(extra_data->>'mei'), ''), NULLIF(BTRIM(extra_data->>'cnpjFavorecido'), '')), '\\D', '', 'g')`;
  if (cnpjDigitsList.length > 0) {
    identityConditions.push(`${cnpjExpression} = ANY($${params.length + 1}::text[])`);
    params.push(cnpjDigitsList);
  }

  if (names.length > 0) {
    const normalizedNameExpression = `regexp_replace(translate(lower(COALESCE(name, '')), 'áàãâäéèêëíìîïóòõôöúùûüç', 'aaaaaeeeeiiiiooooouuuuc'), '\\s+', ' ', 'g')`;
    identityConditions.push(`${normalizedNameExpression} = ANY($${params.length + 1}::text[])`);
    params.push(names.map((name) => name.toLowerCase()));
  }

  if (identityConditions.length === 0) return [];
  conditions.push(`(${identityConditions.join(" OR ")})`);

  const rows = await prisma.$queryRawUnsafe<DriverRegistryRow[]>(`
    SELECT id, name AS display_name, name, cpf, cpf AS cpf_digits,
      COALESCE(NULLIF(BTRIM(extra_data->>'cnpj'), ''), NULLIF(BTRIM(extra_data->>'cnpjProprietario'), ''), NULLIF(BTRIM(extra_data->>'documentoEmpresa'), ''), NULLIF(BTRIM(extra_data->>'mei'), ''), NULLIF(BTRIM(extra_data->>'cnpjFavorecido'), '')) AS cnpj,
      COALESCE(NULLIF(BTRIM(extra_data->>'cnpj'), ''), NULLIF(BTRIM(extra_data->>'cnpjProprietario'), ''), NULLIF(BTRIM(extra_data->>'documentoEmpresa'), ''), NULLIF(BTRIM(extra_data->>'mei'), ''), NULLIF(BTRIM(extra_data->>'cnpjFavorecido'), '')) AS cnpj_digits,
      base, status, status_cadastro, gerenciadora_risco, extra_data, updated_at,
      form.payload AS form_payload
    FROM public.motoristas
    LEFT JOIN LATERAL (
      SELECT payload FROM public.motorista_formularios
      WHERE motorista_id = public.motoristas.id
      LIMIT 1
    ) form ON TRUE
    WHERE ${conditions.join(' AND ')}
    ORDER BY CASE
      WHEN LOWER(COALESCE(status, '')) IN ('aprovado', 'aprovado com ressalva') THEN 1
      WHEN LOWER(COALESCE(status, '')) LIKE '%andamento%'
        OR LOWER(COALESCE(status, '')) LIKE '%analise%'
        OR LOWER(COALESCE(status, '')) LIKE '%pré-seleção%'
        OR LOWER(COALESCE(status, '')) LIKE '%pre-selecao%' THEN 2
      WHEN LOWER(COALESCE(status, '')) LIKE '%reprov%'
        OR LOWER(COALESCE(status, '')) LIKE '%rejeit%' THEN 3
      ELSE 4
    END,
    updated_at DESC NULLS LAST,
    id ASC
    LIMIT 1000
  `, ...params);

  return rows.map(mapRegistryRow);
}

/** ARCHI is the authoritative source for identity and workflow status. */
export async function searchAuthoritativeArchiDriverMatches(options: {
  name?: string;
  cpfDigits?: string;
  cnpjDigits?: string;
}) {
  return searchArchiDriverMatches({ ...options, approvedOnly: true });
}

export async function searchDriverRegistryMatchesByCpfDigits(cpfDigitsList: string[]) {
  const normalizedDigits = Array.from(
    new Set(cpfDigitsList.map((value) => digitsOnly(value)).filter(Boolean))
  );

  if (normalizedDigits.length === 0) {
    return [];
  }

  // Financial eligibility must never be derived from the stale registry
  // cache. Query ARCHI's approved operational records first and exclusively.
  const authoritativeMatches = (await Promise.all(
    normalizedDigits.map((cpfDigits) => searchAuthoritativeArchiDriverMatches({ cpfDigits }))
  )).flat();
  return authoritativeMatches;
}

export async function resolveDriverRegistryByIdentity(options: {
  fileName?: string;
  name?: string;
  cpf?: string;
  cnpj?: string;
  /** Upload matching must use ARCHI name → CNPJ → base; CPF is confirmation only. */
  uploadIdentity?: boolean;
  base?: string;
}) {
  const fileSearch = options.fileName ? deriveRegistrySearchFromFileName(options.fileName) : null;
  const cpfDigits = digitsOnly(options.cpf || fileSearch?.digits || "");
  const cnpjDigits = digitsOnly(options.cnpj || "");
  const providedName = String(options.name || "").trim();
  const name = normalizeText(
    providedName && !/\.[a-z0-9]{2,5}$/i.test(providedName)
      ? providedName
      : fileSearch?.name || ""
  );

  if (options.uploadIdentity) {
    // Do not query ARCHI by CPF for uploads: many valid mirrors do not contain
    // it, and it must not become a prerequisite or a candidate-selection key.
    let matches = name
      ? await searchArchiDriverMatches({ name })
      : cnpjDigits
        ? await searchArchiDriverMatches({ cnpjDigits })
        : [];

    if (name) {
      const exactNameMatches = matches.filter((item) => {
        const registryName = getRecordValue(item.raw, DRIVER_REGISTRY_SEARCH_NAME_CANDIDATES) || item.nome;
        return normalizeText(registryName) === name;
      });
      if (exactNameMatches.length > 0) matches = exactNameMatches;
    }

    // CNPJ is the next identity check. When name search finds no candidate,
    // allow CNPJ lookup for mirrors named after their beneficiary; route-level
    // name validation still prevents a different person from being attached.
    if (cnpjDigits) {
      const cnpjMatches = matches.filter((item) => digitsOnly(item.cnpj) === cnpjDigits);
      if (cnpjMatches.length > 0) matches = cnpjMatches;
      else if (matches.length === 0) matches = await searchArchiDriverMatches({ cnpjDigits });
    }

    if (matches.length === 0) return null;

    if (options.base) {
      const exactBaseMatches = matches.filter((item) => driverMatchesBase(item.raw, options.base || ""));
      if (exactBaseMatches.length > 0) matches = exactBaseMatches;
    }

    return matches.length === 1
      ? matches[0]
      : { ambiguous: true as const, matches };
  }

  let matches = await searchArchiDriverMatches({
    name: name || undefined,
    cpfDigits: cpfDigits || undefined,
    cnpjDigits: cnpjDigits || undefined
  });

  // A mirror filename may contain the base or a date suffix. An exact
  // document from ARCHI remains the safe fallback when the name differs.
  if (matches.length === 0 && (cpfDigits || cnpjDigits)) {
    matches = await searchArchiDriverMatches({
      cpfDigits: cpfDigits || undefined,
      cnpjDigits: cnpjDigits || undefined
    });
  }

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

  // Existing rows may store formatted CPF while a normalized unique index
  // enforces uniqueness over digits. Match using the same normalization first.
  const existingRows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM motoristas
    WHERE regexp_replace(COALESCE(cpf, ''), '\\D', '', 'g') = ${cpfDigits}
    LIMIT 2
  `;

  if (existingRows.length > 1) {
    throw new Error("Mais de um cadastro local possui o mesmo CPF normalizado; vínculo automático interrompido.");
  }

  if (existingRows[0]?.id) {
    return existingRows[0].id;
  }

  try {
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
  } catch (error) {
    // Concurrent uploads can race between the normalized lookup and create.
    // Re-read by normalized CPF and safely reuse the row if it now exists.
    const racedRows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM motoristas
      WHERE regexp_replace(COALESCE(cpf, ''), '\\D', '', 'g') = ${cpfDigits}
      LIMIT 2
    `;
    if (racedRows.length === 1) return racedRows[0].id;
    throw error;
  }
}

/**
 * ARCHI remains the source of truth after a driver has already been linked.
 * Refresh the local display name by CPF so an old snapshot cannot remain
 * permanently fixed in the administrative portal. Ambiguous or unavailable
 * records are deliberately left untouched.
 */
export async function refreshMotoristaNamesFromAuthoritativeRegistry() {
  const motoristas = await prisma.motorista.findMany({
    select: { id: true, cpf: true, nome: true }
  });
  let updated = 0;

  for (const motorista of motoristas) {
    const matches = await searchAuthoritativeArchiDriverMatches({
      cpfDigits: digitsOnly(motorista.cpf)
    });
    if (matches.length !== 1 || !matches[0]?.nome || matches[0].nome === motorista.nome) {
      continue;
    }

    await prisma.motorista.update({
      where: { id: motorista.id },
      data: { nome: matches[0].nome }
    });
    updated += 1;
  }

  return updated;
}

export type DriverRegistryWebhookPayload = {
  externalId?: string;
  nome?: string;
  name?: string;
  cpf?: string;
  cpfDigits?: string;
  cnpj?: string;
  cnpjDigits?: string;
  base?: string;
  email?: string;
  telefone?: string;
  phone?: string;
  driverType?: string;
  signupPolicy?: string;
  active?: boolean;
  status?: string;
  statusCadastro?: string;
  status_cadastro?: string;
};

function registryStatusToActive(payload: DriverRegistryWebhookPayload) {
  if (typeof payload.active === "boolean") {
    return payload.active;
  }

  const status = normalizeText(String(payload.statusCadastro || payload.status_cadastro || payload.status || ""));
  if (["inativo", "inactive", "bloqueado", "reprovado", "rejeitado"].includes(status)) {
    return false;
  }
  if (["ativo", "active", "aprovado", "finalizado", "cadastro aprovado"].includes(status)) {
    return true;
  }

  return undefined;
}

function webhookValue(payload: DriverRegistryWebhookPayload, ...keys: Array<keyof DriverRegistryWebhookPayload>) {
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

/** Apply one authoritative ARCHI driver snapshot to the shared registry. */
export async function syncDriverRegistryFromWebhook(payload: DriverRegistryWebhookPayload) {
  const metadata = await getDriverRegistryMetadata();
  if (!metadata) {
    throw new Error("Tabela de pre-cadastro não encontrada.");
  }

  const nome = webhookValue(payload, "nome", "name");
  const cpfDigits = digitsOnly(webhookValue(payload, "cpfDigits", "cpf"));
  const cnpjDigits = digitsOnly(webhookValue(payload, "cnpjDigits", "cnpj"));
  const externalId = webhookValue(payload, "externalId");
  const idColumn = getColumn(metadata, ["id", "uuid", "codigo", "driver_id", "identificador"]);
  const nameColumn = getColumn(metadata, DRIVER_REGISTRY_SEARCH_NAME_CANDIDATES);
  const cpfColumn = getColumn(metadata, DRIVER_REGISTRY_CPF_CANDIDATES);
  const cpfDigitsColumn = getColumn(metadata, ["cpf_digits", "cpf_numero"]);
  const cnpjColumn = getColumn(metadata, DRIVER_REGISTRY_CNPJ_CANDIDATES);
  const cnpjDigitsColumn = getColumn(metadata, ["cnpj_digits"]);

  const where: string[] = [];
  const params: unknown[] = [];
  const addWhere = (column: string | null, value: string, cast = "") => {
    if (!column || !value) return;
    params.push(value);
    where.push(`${quoteIdentifier(column)}::text = $${params.length}${cast}`);
  };

  if (externalId) addWhere(idColumn, externalId);
  if (where.length === 0 && cnpjDigits) {
    if (cnpjDigitsColumn) addWhere(cnpjDigitsColumn, cnpjDigits);
    else addWhere(cnpjColumn, cnpjDigits);
  }
  if (where.length === 0 && cpfDigits) {
    if (cpfDigitsColumn) addWhere(cpfDigitsColumn, cpfDigits);
    else addWhere(cpfColumn, cpfDigits);
  }
  if (where.length === 0 && nome && nameColumn) {
    addWhere(nameColumn, nome);
  }

  if (where.length === 0) {
    throw new Error("Evento de motorista sem identificador (id, CPF, CNPJ ou nome).");
  }

  const tableRef = buildTableRef(metadata.schema);
  let rows = await prisma.$queryRawUnsafe<DriverRegistryRow[]>(
    `SELECT * FROM ${tableRef} WHERE ${where.join(" AND ")} LIMIT 2`,
    ...params
  );
  // ARCHI's external identifier is not necessarily the database UUID. If it
  // does not resolve, fall back to the authoritative document before
  // inserting, preventing duplicate registry rows.
  if (rows.length === 0 && externalId && (cnpjDigits || cpfDigits)) {
    const fallbackColumn = cnpjDigits ? (cnpjDigitsColumn || cnpjColumn) : (cpfDigitsColumn || cpfColumn);
    const fallbackValue = cnpjDigits || cpfDigits;
    if (fallbackColumn && fallbackValue) {
      rows = await prisma.$queryRawUnsafe<DriverRegistryRow[]>(
        `SELECT * FROM ${tableRef} WHERE regexp_replace(COALESCE(${quoteIdentifier(fallbackColumn)}, ''), '\\D', '', 'g') = $1 LIMIT 2`,
        fallbackValue
      );
    }
  }
  const row = rows[0] || null;
  if (rows.length > 1 && !externalId && !cpfDigits) {
    throw new Error("Evento de motorista ambíguo; aguardando identificador único.");
  }

  const active = registryStatusToActive(payload);
  const values: Record<string, unknown> = {
    display_name: nome || undefined,
    normalized_name: nome ? normalizeText(nome) : undefined,
    cpf: cpfDigits || undefined,
    cpf_digits: cpfDigits || undefined,
    cnpj: webhookValue(payload, "cnpj") || undefined,
    cnpj_digits: cnpjDigits || undefined,
    base: webhookValue(payload, "base") || undefined,
    email: webhookValue(payload, "email") || undefined,
    phone: webhookValue(payload, "telefone", "phone") || undefined,
    driver_type: webhookValue(payload, "driverType") || undefined,
    signup_policy: webhookValue(payload, "signupPolicy") || undefined,
    active
  };

  if (!row) {
    if (!cpfDigits || !nome) {
      throw new Error("Motorista novo precisa de nome e CPF para ser registrado com segurança.");
    }

    const insertValues: Record<string, unknown> = {
      id: /^[0-9a-f-]{36}$/i.test(externalId) ? externalId : randomUUID(),
      ...values,
      created_at: new Date(),
      updated_at: new Date()
    };
    const entries = Object.entries(insertValues).filter(([column, value]) =>
      metadata.columns.has(column) && value !== undefined
    );
    const placeholders = entries.map(([, value], index) => `$${index + 1}`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${tableRef} (${entries.map(([column]) => quoteIdentifier(column)).join(", ")}) VALUES (${placeholders.join(", ")})`,
      ...entries.map(([, value]) => value)
    );
  } else {
    const rowIdColumn = getColumn(metadata, ["id", "uuid", "codigo", "driver_id", "identificador"]);
    const rowId = rowIdColumn ? getRecordValue(row, [rowIdColumn]) : null;
    if (!rowIdColumn || !rowId) throw new Error("Registro de motorista sem chave primária.");
    const entries = Object.entries(values).filter(([column, value]) =>
      metadata.columns.has(column) && value !== undefined
    );
    if (entries.length) {
      const updateParams = entries.map(([, value]) => value);
      updateParams.push(rowId);
      const assignments = entries.map(([column], index) => `${quoteIdentifier(column)} = $${index + 1}`);
      if (metadata.columns.has("updated_at")) {
        assignments.push(`${quoteIdentifier("updated_at")} = NOW()`);
      }
      await prisma.$executeRawUnsafe(
        `UPDATE ${tableRef} SET ${assignments.join(", ")} WHERE ${quoteIdentifier(rowIdColumn)}::text = $${updateParams.length}`,
        ...updateParams
      );
    }
  }

  const match = await resolveDriverRegistryByIdentity({ name: nome, cpf: cpfDigits, cnpj: cnpjDigits });
  const motoristaId = match && "ambiguous" in match ? null : match ? await ensureMotoristaFromRegistryMatch(match) : null;
  // The webhook payload may contain the previous display name while ARCHI has
  // already persisted the corrected authoritative name. Prefer the unique
  // approved ARCHI record by CPF so local display data cannot remain stale.
  const authoritativeMatches = cpfDigits
    ? await searchAuthoritativeArchiDriverMatches({ cpfDigits })
    : [];
  const canonicalName = authoritativeMatches.length === 1
    ? authoritativeMatches[0]?.nome || nome
    : match && !("ambiguous" in match) ? match.nome || nome : nome;
  if (motoristaId) {
    await prisma.motorista.update({
      where: { id: motoristaId },
      data: {
        nome: canonicalName || undefined,
        ...(active === undefined ? {} : { statusCadastro: active ? "ativo" : "inativo" })
      }
    });
  }

  return { motoristaId, matched: Boolean(match), active, nome: canonicalName, cpfDigits, cnpjDigits };
}
