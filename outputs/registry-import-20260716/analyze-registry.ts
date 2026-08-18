import fs from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const inputPath = "C:/Users/Wesley/Documents/Dev Alc/Projetos/acesso-adm/outputs/registry-import-20260716/workbook-rows.json";
const outputPath = "C:/Users/Wesley/Documents/Dev Alc/Projetos/acesso-adm/outputs/registry-import-20260716/preflight-report.json";
const normalizedPath = "C:/Users/Wesley/Documents/Dev Alc/Projetos/acesso-adm/outputs/registry-import-20260716/normalized-sheet.json";

type SheetPayload = { name: string; values: unknown[][] };
type RawRecord = Record<string, unknown>;

function text(value: unknown) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function digits(value: unknown, expectedLength?: number) {
  const raw = text(value)?.replace(/\D/g, "") || "";
  if (expectedLength && raw !== "0" && raw.length >= expectedLength - 4 && raw.length < expectedLength) {
    return raw.padStart(expectedLength, "0");
  }
  return raw;
}

function canonicalName(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatCpf(value: string) {
  return value.length === 11 ? `${value.slice(0, 3)}.${value.slice(3, 6)}.${value.slice(6, 9)}-${value.slice(9)}` : value;
}

function formatCnpj(value: string) {
  return value.length === 14 ? `${value.slice(0, 2)}.${value.slice(2, 5)}.${value.slice(5, 8)}/${value.slice(8, 12)}-${value.slice(12)}` : value;
}

function excelDate(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(Date.UTC(1899, 11, 30) + Math.round(value * 86400000)).toISOString().slice(0, 10);
  }
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

function score(row: RawRecord) {
  return Object.values(row).filter((value) => value !== null && value !== undefined && value !== "").length;
}

const workbook = JSON.parse(await fs.readFile(inputPath, "utf8")) as SheetPayload[];
const values = workbook[0]?.values || [];
const headers = (values[0] || []).map((value) => String(value || "").trim());
const sourceRows = values.slice(1).map((row, index) => ({
  excelRow: index + 2,
  raw: Object.fromEntries(headers.map((header, column) => [header, row[column] ?? null])) as RawRecord,
}));

const normalizedRows = sourceRows.map(({ excelRow, raw }) => {
  const displayName = text(raw["Nome"]) || "";
  const cpfDigits = digits(raw["CPF"], 11);
  const cnpjDigits = digits(raw["CNPJ favorecido"], 14);
  const cpfFavorecidoDigits = digits(raw["CPF do favorecido"], 11);
  return {
    excelRow,
    base: text(raw["Base"]),
    displayName,
    normalizedName: canonicalName(displayName),
    dataNascimento: excelDate(raw["Data de Nascimento"]),
    cpf: formatCpf(cpfDigits),
    cpfDigits,
    rg: text(raw["RG"]),
    driverType: text(raw["Tipo de Motorista"]),
    sexo: text(raw["Sexo"]),
    phone: text(raw["Telefone"]),
    email: text(raw["E-mail"]),
    placa: text(raw["Placa"]),
    nomeFavorecido: text(raw["Favorecido"]),
    cnpj: formatCnpj(cnpjDigits),
    cnpjDigits,
    cpfFavorecido: formatCpf(cpfFavorecidoDigits),
    cpfFavorecidoDigits,
    emailFavorecido: text(raw["E-mail do favorecido"]),
    telefoneFavorecido: text(raw["Telefone do favorecido"]),
    validadeGr: excelDate(raw["VALIDADE GR"]),
  };
});

const blankRows = normalizedRows.filter((row) => !row.normalizedName);
const invalidCpfRows = normalizedRows.filter((row) => row.normalizedName && row.cpfDigits.length !== 11);
const invalidCnpjRows = normalizedRows.filter((row) => row.normalizedName && row.cnpjDigits.length !== 14);
const groups = new Map<string, typeof normalizedRows>();
for (const row of normalizedRows.filter((item) => item.normalizedName)) {
  const key =
    row.cpfDigits.length === 11 && row.cnpjDigits
      ? `DOC|${row.cpfDigits}|${row.cnpjDigits}`
      : `NAME|${row.normalizedName}|${row.cnpjDigits}`;
  const group = groups.get(key) || [];
  group.push(row);
  groups.set(key, group);
}

const consolidated = [];
const sheetDuplicateGroups = [];
for (const [key, group] of groups) {
  const ranked = [...group].sort((left, right) => score(right) - score(left) || right.excelRow - left.excelRow);
  const chosen = { ...ranked[0] };
  for (const candidate of [...group].sort((a, b) => a.excelRow - b.excelRow)) {
    for (const [field, value] of Object.entries(candidate)) {
      if (field === "excelRow") continue;
      if (value !== null && value !== undefined && value !== "") (chosen as RawRecord)[field] = value;
    }
  }
  (chosen as RawRecord).sourceCount = group.length;
  (chosen as RawRecord).sourceRows = group.map((row) => row.excelRow);
  consolidated.push(chosen);
  if (group.length > 1) {
    sheetDuplicateGroups.push({ key, rows: group.map((row) => row.excelRow), chosenRow: chosen.excelRow });
  }
}

const dbRows = await prisma.$queryRawUnsafe<RawRecord[]>("SELECT * FROM public.driver_registry_entities ORDER BY updated_at DESC");
const dbNormalized = dbRows.map((row) => ({
  ...row,
  id: String(row.id),
  canonicalName: canonicalName(row.display_name || row.normalized_name),
  cpfDigitsCanonical: digits(row.cpf_digits || row.cpf, 11),
  cnpjDigitsCanonical: digits(row.cnpj_digits || row.cnpj, 14),
}));

const byNameCnpj = new Map<string, typeof dbNormalized>();
const byCpfCnpj = new Map<string, typeof dbNormalized>();
const byCpf = new Map<string, typeof dbNormalized>();
const byName = new Map<string, typeof dbNormalized>();
for (const row of dbNormalized) {
  const nameCnpjKey = `${row.canonicalName}|${row.cnpjDigitsCanonical}`;
  byNameCnpj.set(nameCnpjKey, [...(byNameCnpj.get(nameCnpjKey) || []), row]);
  if (row.cpfDigitsCanonical && row.cnpjDigitsCanonical) {
    const cpfCnpjKey = `${row.cpfDigitsCanonical}|${row.cnpjDigitsCanonical}`;
    byCpfCnpj.set(cpfCnpjKey, [...(byCpfCnpj.get(cpfCnpjKey) || []), row]);
  }
  if (row.cpfDigitsCanonical) byCpf.set(row.cpfDigitsCanonical, [...(byCpf.get(row.cpfDigitsCanonical) || []), row]);
  if (row.canonicalName) byName.set(row.canonicalName, [...(byName.get(row.canonicalName) || []), row]);
}

const classifications = { exactNameCnpj: 0, matchedCpf: 0, matchedUniqueName: 0, newRows: 0, ambiguous: 0 };
const plans = [];
const usedTargetIds = new Set<string>();
const mergePairs = new Map<string, { duplicateId: string; targetId: string; reason: string }>();
const ambiguous = [];
const sheetCpfCounts = new Map<string, number>();
const sheetNameCounts = new Map<string, number>();
for (const row of consolidated) {
  if (row.cpfDigits.length === 11) sheetCpfCounts.set(row.cpfDigits, (sheetCpfCounts.get(row.cpfDigits) || 0) + 1);
  sheetNameCounts.set(row.normalizedName, (sheetNameCounts.get(row.normalizedName) || 0) + 1);
}

for (const row of consolidated) {
  const exactByDocument =
    row.cpfDigits.length === 11 && row.cnpjDigits
      ? byCpfCnpj.get(`${row.cpfDigits}|${row.cnpjDigits}`) || []
      : [];
  const exactByName = byNameCnpj.get(`${row.normalizedName}|${row.cnpjDigits}`) || [];
  const exact = [...new Map([...exactByDocument, ...exactByName].map((item) => [item.id, item])).values()];
  const cpfMatches =
    row.cpfDigits.length === 11
      ? (byCpf.get(row.cpfDigits) || []).filter((item) => !usedTargetIds.has(item.id))
      : [];
  const nameMatches = (byName.get(row.normalizedName) || []).filter((item) => !usedTargetIds.has(item.id));
  let candidates = exact.filter((item) => !usedTargetIds.has(item.id));
  let matchType = "exactNameCnpj";
  if (candidates.length === 0 && (sheetCpfCounts.get(row.cpfDigits) || 0) === 1 && cpfMatches.length > 0) {
    candidates = cpfMatches;
    matchType = "matchedCpf";
  }
  if (candidates.length === 0 && (sheetNameCounts.get(row.normalizedName) || 0) === 1 && nameMatches.length === 1) {
    candidates = nameMatches;
    matchType = "matchedUniqueName";
  }

  if (candidates.length === 0) {
    classifications.newRows += 1;
    plans.push({ ...row, targetId: null, matchType: "newRows" });
    continue;
  }

  const sameIdentity = candidates.filter(
    (candidate) =>
      candidate.canonicalName === row.normalizedName ||
      (row.cpfDigits.length === 11 && candidate.cpfDigitsCanonical === row.cpfDigits),
  );
  if (sameIdentity.length === 0) {
    classifications.ambiguous += 1;
    ambiguous.push({ excelRow: row.excelRow, displayName: row.displayName, candidateIds: candidates.map((item) => item.id) });
    continue;
  }

  const chosen = sameIdentity[0];
  usedTargetIds.add(chosen.id);
  classifications[matchType as keyof typeof classifications] += 1;
  for (const duplicate of exact) {
    if (duplicate.id !== chosen.id && !usedTargetIds.has(duplicate.id)) {
      mergePairs.set(duplicate.id, {
        duplicateId: duplicate.id,
        targetId: chosen.id,
        reason: "Mesma identidade por CPF/CNPJ ou nome normalizado/CNPJ",
      });
    }
  }
  plans.push({ ...row, targetId: chosen.id, matchType });
}

const dbDuplicateNameCnpj = [...byNameCnpj.entries()].filter(([, rows]) => rows.length > 1);
const dbDuplicateCpfCnpj = [...byCpfCnpj.entries()].filter(([, rows]) => rows.length > 1);
const dbDuplicateCpf = [...byCpf.entries()].filter(([, rows]) => rows.length > 1);

const report = {
  source: {
    worksheet: workbook[0]?.name || null,
    totalRows: normalizedRows.length,
    nonBlankRows: normalizedRows.length - blankRows.length,
    blankRows: blankRows.map((row) => row.excelRow),
    invalidCpfCount: invalidCpfRows.length,
    invalidCpfRows: invalidCpfRows.slice(0, 100).map((row) => ({ row: row.excelRow, name: row.displayName, value: row.cpfDigits })),
    invalidCnpjCount: invalidCnpjRows.length,
    invalidCnpjRows: invalidCnpjRows.slice(0, 100).map((row) => ({ row: row.excelRow, name: row.displayName, value: row.cnpjDigits })),
    uniqueRowsAfterConsolidation: consolidated.length,
    duplicateGroups: sheetDuplicateGroups.length,
    duplicateRows: sheetDuplicateGroups.reduce((sum, item) => sum + item.rows.length - 1, 0),
    duplicateExamples: sheetDuplicateGroups.slice(0, 50),
  },
  databaseBefore: {
    totalRows: dbRows.length,
    duplicateNameCnpjGroups: dbDuplicateNameCnpj.length,
    duplicateNameCnpjRows: dbDuplicateNameCnpj.reduce((sum, [, rows]) => sum + rows.length - 1, 0),
    duplicateCpfCnpjGroups: dbDuplicateCpfCnpj.length,
    duplicateCpfCnpjRows: dbDuplicateCpfCnpj.reduce((sum, [, rows]) => sum + rows.length - 1, 0),
    duplicateCpfGroups: dbDuplicateCpf.length,
    duplicateCpfRows: dbDuplicateCpf.reduce((sum, [, rows]) => sum + rows.length - 1, 0),
  },
  plan: {
    ...classifications,
    rowsReady: plans.length,
    duplicateDatabaseRowsToMerge: mergePairs.size,
    ambiguousRows: ambiguous,
  },
};

await fs.writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
await fs.writeFile(normalizedPath, JSON.stringify({ plans, mergePairs: [...mergePairs.values()], report }, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
await prisma.$disconnect();
