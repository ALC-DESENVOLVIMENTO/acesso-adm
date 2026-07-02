import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { ensureDriverRegistryColumns } from "../src/lib/driver-registry-schema.js";
import { prisma } from "../src/lib/prisma.js";

type ExcelRow = Record<string, unknown>;

type NormalizedDriverRegistryRow = {
  base: string | null;
  displayName: string;
  normalizedName: string;
  cpf: string;
  cpfDigits: string;
  rg: string | null;
  dataNascimento: string | null;
  driverType: string | null;
  sexo: string | null;
  telefone: string | null;
  email: string | null;
  placa: string | null;
  nomeFavorecido: string | null;
  cnpj: string | null;
  cnpjDigits: string;
  cpfFavorecido: string | null;
  cpfFavorecidoDigits: string | null;
  emailFavorecido: string | null;
  telefoneFavorecido: string | null;
  validadeGr: string | null;
  signupPolicy: string;
  active: boolean;
};

const DEFAULT_XLSX_PATH = "C:/Users/Wesley/Downloads/Dados Motoristas GR.xlsx";

function toText(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const text = String(value).trim();
  return text ? text : null;
}

function digitsOnly(value: unknown) {
  const text = toText(value);
  return text ? text.replace(/\D/g, "") : "";
}

function normalizeName(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
}

function formatCpfDigits(value: string) {
  if (value.length !== 11) {
    return value;
  }

  return `${value.slice(0, 3)}.${value.slice(3, 6)}.${value.slice(6, 9)}-${value.slice(9)}`;
}

function formatCnpjDigits(value: string) {
  if (value.length !== 14) {
    return value;
  }

  return `${value.slice(0, 2)}.${value.slice(2, 5)}.${value.slice(5, 8)}/${value.slice(8, 12)}-${value.slice(12)}`;
}

function normalizeSignupPolicy(driverType: string | null, currentValue: string | null) {
  if (currentValue) {
    return currentValue;
  }

  if (!driverType) {
    return "favored_only";
  }

  const normalized = driverType.normalize("NFD").replace(/\p{Diacritic}/gu, "").trim().toLowerCase();
  if (normalized.includes("rental")) {
    return "rental_company";
  }

  return "favored_only";
}

function toBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const text = toText(value)?.toLowerCase();
  if (!text) {
    return true;
  }

  if (["0", "false", "nao", "não", "inactive", "inativo", "bloqueado"].includes(text)) {
    return false;
  }

  return true;
}

function normalizeDateOnly(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = new Date(value as string | number | Date);
  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function buildPythonExtractor() {
  return `
import json
import sys
from datetime import date, datetime

import openpyxl

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

def serialize(value):
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value

path = sys.argv[1]
wb = openpyxl.load_workbook(path, data_only=True)
ws = wb[wb.sheetnames[0]]
headers = [
    str(ws.cell(1, c).value).strip() if ws.cell(1, c).value is not None else f"col_{c}"
    for c in range(1, ws.max_column + 1)
]
rows = []
for r in range(2, ws.max_row + 1):
    row = {}
    for c in range(1, ws.max_column + 1):
        row[headers[c - 1]] = serialize(ws.cell(r, c).value)
    rows.append(row)

print(json.dumps(rows, ensure_ascii=False))
`;
}

async function fetchExistingRows() {
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      normalized_name: string;
      cpf_digits: string;
      cnpj_digits: string;
      updated_at: Date;
    }>
  >`SELECT id, normalized_name, cpf_digits, cnpj_digits, updated_at FROM public.driver_registry_entities ORDER BY updated_at DESC`;

  const map = new Map<string, { id: string; normalizedName: string; cpfDigits: string; cnpjDigits: string }>();

  for (const row of rows) {
    const key = `${row.normalized_name || ""}:${row.cnpj_digits || ""}`;
    if (!map.has(key)) {
      map.set(key, {
        id: row.id,
        normalizedName: row.normalized_name || "",
        cpfDigits: row.cpf_digits || "",
        cnpjDigits: row.cnpj_digits || ""
      });
    }
  }

  return map;
}

function normalizeRow(row: ExcelRow, existing?: { active: boolean; signup_policy: string | null }) {
  const displayName = toText(row["Nome"]) || "SEM NOME";
  const cpfDigits = digitsOnly(row["CPF"]);
  const cnpjDigits = digitsOnly(row["CNPJ favorecido"]);
  const driverType = toText(row["Tipo de Motorista"]) || "DESCONHECIDO";
  const cpfFavorecido = toText(row["CPF do favorecido"]);

  return {
    base: toText(row["Base"]),
    displayName,
    normalizedName: normalizeName(displayName),
    cpf: formatCpfDigits(cpfDigits),
    cpfDigits,
    rg: toText(row["RG"]),
    dataNascimento: normalizeDateOnly(row["Data de Nascimento"]),
    driverType,
    sexo: toText(row["Sexo"]),
    telefone: toText(row["Telefone"]),
    email: toText(row["E-mail"]),
    placa: toText(row["Placa"]),
    nomeFavorecido: toText(row["Favorecido"]),
    cnpj: formatCnpjDigits(cnpjDigits),
    cnpjDigits,
    cpfFavorecido: cpfFavorecido,
    cpfFavorecidoDigits: digitsOnly(cpfFavorecido) || null,
    emailFavorecido: toText(row["E-mail do favorecido"]),
    telefoneFavorecido: toText(row["Telefone do favorecido"]),
    validadeGr: normalizeDateOnly(row["VALIDADE GR"]),
    signupPolicy: normalizeSignupPolicy(driverType, existing?.signup_policy || null),
    active: existing ? existing.active : true
  } satisfies NormalizedDriverRegistryRow;
}

async function upsertRow(
  row: NormalizedDriverRegistryRow,
  existingId: string | null,
  currentSourceCount?: number | null
) {
  if (existingId) {
    await prisma.$executeRawUnsafe(
      `
        UPDATE public.driver_registry_entities
        SET
          base = $2,
          display_name = $3,
          normalized_name = $4,
          cpf = $5,
          cpf_digits = $6,
          rg = $7,
          data_nascimento = $8::date,
          driver_type = $9,
          sexo = $10,
          phone = $11,
          email = $12,
          placa = $13,
          nome_favorecido = $14,
          cnpj = $15,
          cnpj_digits = $16,
          cpf_favorecido = $17,
          cpf_favorecido_digits = $18,
          email_favorecido = $19,
          telefone_favorecido = $20,
          validade_gr = $21::date,
          signup_policy = $22,
          active = $23,
          source_count = COALESCE($24, source_count),
          updated_at = NOW()
        WHERE id = $1::uuid
      `,
      existingId,
      row.base,
      row.displayName,
      row.normalizedName,
      row.cpf,
      row.cpfDigits,
      row.rg,
      row.dataNascimento,
      row.driverType,
      row.sexo,
      row.telefone,
      row.email,
      row.placa,
      row.nomeFavorecido,
      row.cnpj,
      row.cnpjDigits,
      row.cpfFavorecido,
      row.cpfFavorecidoDigits,
      row.emailFavorecido,
      row.telefoneFavorecido,
      row.validadeGr,
      row.signupPolicy,
      row.active,
      currentSourceCount ?? null
    );
    return existingId;
  }

  const inserted = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `
      INSERT INTO public.driver_registry_entities (
        id,
        base,
        display_name,
        normalized_name,
        cnpj,
        cnpj_digits,
        cpf,
        cpf_digits,
        email,
        phone,
        driver_type,
        signup_policy,
        active,
        source_count,
        created_at,
        updated_at,
        rg,
        data_nascimento,
        sexo,
        placa,
        nome_favorecido,
        cpf_favorecido,
        cpf_favorecido_digits,
        email_favorecido,
        telefone_favorecido,
        validade_gr
      ) VALUES (
      $1::uuid,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::date,$19,$20,$21,$22,$23,$24,$25,$26::date
      )
      ON CONFLICT (normalized_name, cnpj_digits)
      DO UPDATE SET
        base = EXCLUDED.base,
        display_name = EXCLUDED.display_name,
        cpf = EXCLUDED.cpf,
        cpf_digits = EXCLUDED.cpf_digits,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        driver_type = EXCLUDED.driver_type,
        signup_policy = EXCLUDED.signup_policy,
        active = EXCLUDED.active,
        source_count = EXCLUDED.source_count,
        updated_at = NOW(),
        rg = EXCLUDED.rg,
        data_nascimento = EXCLUDED.data_nascimento,
        sexo = EXCLUDED.sexo,
        placa = EXCLUDED.placa,
        nome_favorecido = EXCLUDED.nome_favorecido,
        cpf_favorecido = EXCLUDED.cpf_favorecido,
        cpf_favorecido_digits = EXCLUDED.cpf_favorecido_digits,
        email_favorecido = EXCLUDED.email_favorecido,
        telefone_favorecido = EXCLUDED.telefone_favorecido,
        validade_gr = EXCLUDED.validade_gr
      RETURNING id
    `,
    randomUUID(),
    row.base,
    row.displayName,
    row.normalizedName,
    row.cnpj,
    row.cnpjDigits,
    row.cpf,
    row.cpfDigits,
    row.email,
    row.telefone,
    row.driverType,
    row.signupPolicy,
    row.active,
    currentSourceCount ?? 1,
    new Date(),
    new Date(),
    row.rg,
    row.dataNascimento || null,
    row.sexo,
    row.placa,
    row.nomeFavorecido,
    row.cpfFavorecido,
    row.cpfFavorecidoDigits,
    row.emailFavorecido,
    row.telefoneFavorecido,
    row.validadeGr || null
  );

  return inserted[0]?.id || null;
}

async function main() {
  const inputPath = path.resolve(process.argv[2] || DEFAULT_XLSX_PATH);
  await ensureDriverRegistryColumns();
  const python = buildPythonExtractor();
  const rawJson = execFileSync("python", ["-c", python, inputPath], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024
  });

  const excelRows = JSON.parse(rawJson) as ExcelRow[];
  const existingRows = await fetchExistingRows();

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const excelRow of excelRows) {
    const normalized = normalizeRow(excelRow);
    if (!normalized.cpfDigits || !normalized.cnpjDigits) {
      skipped += 1;
      continue;
    }

    const key = `${normalized.normalizedName}:${normalized.cnpjDigits}`;
    const existing = existingRows.get(key);
    const rowId = await upsertRow(normalized, existing?.id || null, existing ? null : 1);

    if (existing) {
      updated += 1;
    } else {
      inserted += 1;
      if (rowId) {
        existingRows.set(key, { id: rowId, cpfDigits: normalized.cpfDigits, cnpjDigits: normalized.cnpjDigits });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        file: inputPath,
        total: excelRows.length,
        inserted,
        updated,
        skipped
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
