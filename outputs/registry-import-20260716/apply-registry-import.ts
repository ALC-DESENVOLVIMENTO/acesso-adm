import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const planPath = "C:/Users/Wesley/Documents/Dev Alc/Projetos/acesso-adm/outputs/registry-import-20260716/normalized-sheet.json";
const backupPath = "C:/Users/Wesley/Documents/Dev Alc/Projetos/acesso-adm/outputs/registry-import-20260716/database-before.json";
const reportPath = "C:/Users/Wesley/Documents/Dev Alc/Projetos/acesso-adm/outputs/registry-import-20260716/operation-report.json";

type RawRecord = Record<string, unknown>;
type ImportPlan = {
  excelRow: number;
  sourceCount: number;
  sourceRows: number[];
  base: string | null;
  displayName: string;
  normalizedName: string;
  dataNascimento: string | null;
  cpf: string;
  cpfDigits: string;
  rg: string | null;
  driverType: string | null;
  sexo: string | null;
  phone: string | null;
  email: string | null;
  placa: string | null;
  nomeFavorecido: string | null;
  cnpj: string;
  cnpjDigits: string;
  cpfFavorecido: string | null;
  cpfFavorecidoDigits: string | null;
  emailFavorecido: string | null;
  telefoneFavorecido: string | null;
  validadeGr: string | null;
  targetId: string | null;
  matchType: string;
};

type MergePair = { duplicateId: string; targetId: string; reason: string };

function json(value: unknown) {
  return JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item), 2);
}

function comparable(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function signupPolicy(driverType: string | null) {
  const normalized = String(driverType || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  return normalized.includes("rental") ? "rental_company" : "favored_only";
}

const payload = JSON.parse(await fs.readFile(planPath, "utf8")) as {
  plans: ImportPlan[];
  mergePairs: MergePair[];
  report: RawRecord;
};

function hasValidCpf(plan: ImportPlan) {
  return /^\d{11}$/.test(plan.cpfDigits);
}

function latestSourceRow(plan: ImportPlan) {
  return Math.max(plan.excelRow, ...plan.sourceRows);
}

const plansByDatabaseKey = new Map<string, ImportPlan[]>();
for (const plan of payload.plans) {
  const key = `${plan.normalizedName}|${plan.cnpjDigits}`;
  const plans = plansByDatabaseKey.get(key) || [];
  plans.push(plan);
  plansByDatabaseKey.set(key, plans);
}

const databaseKeyDuplicateGroups = [];
const consolidatedPlans = [...plansByDatabaseKey.entries()].map(([key, plans]) => {
  const sorted = [...plans].sort((left, right) => {
    const validityDifference = Number(hasValidCpf(right)) - Number(hasValidCpf(left));
    if (validityDifference !== 0) return validityDifference;
    return latestSourceRow(right) - latestSourceRow(left);
  });
  const selected = sorted[0];
  const existingTargetId = plans.find((plan) => plan.targetId)?.targetId || null;
  const consolidated = {
    ...selected,
    targetId: selected.targetId || existingTargetId,
    sourceCount: plans.reduce((total, plan) => total + plan.sourceCount, 0),
    sourceRows: [...new Set(plans.flatMap((plan) => plan.sourceRows))].sort((left, right) => left - right),
  };

  if (plans.length > 1) {
    databaseKeyDuplicateGroups.push({
      key,
      sourceRows: consolidated.sourceRows,
      selectedRow: latestSourceRow(selected),
      selectedCpf: selected.cpfDigits,
      discardedCpfs: plans.filter((plan) => plan !== selected).map((plan) => plan.cpfDigits),
      reason: plans.some((plan) => !hasValidCpf(plan))
        ? "CPF valido priorizado; em seguida, linha mais recente"
        : "Linha mais recente da planilha priorizada",
    });
  }

  return consolidated;
});

const beforeEntities = await prisma.$queryRawUnsafe<RawRecord[]>(
  "SELECT * FROM public.driver_registry_entities ORDER BY updated_at DESC",
);
const beforeRecords = await prisma.$queryRawUnsafe<RawRecord[]>(
  "SELECT * FROM public.driver_registry_records ORDER BY source_row_number",
);
const beforeSignupRequests = await prisma.$queryRawUnsafe<RawRecord[]>(
  "SELECT * FROM public.driver_signup_requests ORDER BY created_at",
);

await fs.writeFile(
  backupPath,
  json({
    capturedAt: new Date().toISOString(),
    driverRegistryEntities: beforeEntities,
    driverRegistryRecords: beforeRecords,
    driverSignupRequests: beforeSignupRequests,
  }),
  "utf8",
);

const beforeById = new Map(beforeEntities.map((row) => [String(row.id), row]));
const fieldMap: Array<[keyof ImportPlan, string]> = [
  ["base", "base"],
  ["displayName", "display_name"],
  ["normalizedName", "normalized_name"],
  ["cpf", "cpf"],
  ["cpfDigits", "cpf_digits"],
  ["rg", "rg"],
  ["dataNascimento", "data_nascimento"],
  ["driverType", "driver_type"],
  ["sexo", "sexo"],
  ["phone", "phone"],
  ["email", "email"],
  ["placa", "placa"],
  ["nomeFavorecido", "nome_favorecido"],
  ["cnpj", "cnpj"],
  ["cnpjDigits", "cnpj_digits"],
  ["cpfFavorecido", "cpf_favorecido"],
  ["cpfFavorecidoDigits", "cpf_favorecido_digits"],
  ["emailFavorecido", "email_favorecido"],
  ["telefoneFavorecido", "telefone_favorecido"],
  ["validadeGr", "validade_gr"],
];

const fieldChanges: Record<string, number> = {};
const changedRecords = [];
let accentOrSpellingCorrections = 0;
for (const plan of consolidatedPlans) {
  if (!plan.targetId) continue;
  const before = beforeById.get(plan.targetId);
  if (!before) throw new Error(`Registro alvo nao encontrado antes da importacao: ${plan.targetId}`);
  const changedFields = [];
  for (const [planField, dbField] of fieldMap) {
    if (comparable(plan[planField]) !== comparable(before[dbField])) {
      changedFields.push(dbField);
      fieldChanges[dbField] = (fieldChanges[dbField] || 0) + 1;
    }
  }
  if (comparable(before.display_name) !== comparable(plan.displayName)) accentOrSpellingCorrections += 1;
  if (changedFields.length > 0) {
    changedRecords.push({
      id: plan.targetId,
      excelRows: plan.sourceRows,
      nameBefore: before.display_name,
      nameAfter: plan.displayName,
      changedFields,
    });
  }
}

const stageRows = consolidatedPlans.map((plan) => ({
  row_id: plan.targetId || randomUUID(),
  target_id: plan.targetId,
  base: plan.base,
  display_name: plan.displayName,
  normalized_name: plan.normalizedName,
  cpf: plan.cpf,
  cpf_digits: plan.cpfDigits,
  rg: plan.rg,
  data_nascimento: plan.dataNascimento,
  driver_type: plan.driverType || "DESCONHECIDO",
  sexo: plan.sexo,
  phone: plan.phone,
  email: plan.email,
  placa: plan.placa,
  nome_favorecido: plan.nomeFavorecido,
  cnpj: plan.cnpj,
  cnpj_digits: plan.cnpjDigits,
  cpf_favorecido: plan.cpfFavorecido,
  cpf_favorecido_digits: plan.cpfFavorecidoDigits,
  email_favorecido: plan.emailFavorecido,
  telefone_favorecido: plan.telefoneFavorecido,
  validade_gr: plan.validadeGr,
  signup_policy: signupPolicy(plan.driverType),
  source_count: plan.sourceCount || 1,
}));

if (!process.argv.includes("--apply")) {
  console.log(
    json({
      mode: "dry-run",
      stageRows: stageRows.length,
      updates: stageRows.filter((row) => row.target_id).length,
      inserts: stageRows.filter((row) => !row.target_id).length,
      mergePairs: payload.mergePairs.length,
      backupPath,
      recordsWithChanges: changedRecords.length,
      accentOrSpellingCorrections,
      fieldChanges,
    }),
  );
  await prisma.$disconnect();
  process.exit(0);
}

const transactionResult = await prisma.$transaction(
  async (tx) => {
    await tx.$executeRawUnsafe(`
      CREATE TEMP TABLE temp_driver_registry_import (
        row_id UUID NOT NULL,
        target_id UUID,
        base TEXT,
        display_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        cpf TEXT NOT NULL,
        cpf_digits TEXT NOT NULL,
        rg TEXT,
        data_nascimento DATE,
        driver_type TEXT NOT NULL,
        sexo TEXT,
        phone TEXT,
        email TEXT,
        placa TEXT,
        nome_favorecido TEXT,
        cnpj TEXT NOT NULL,
        cnpj_digits TEXT NOT NULL,
        cpf_favorecido TEXT,
        cpf_favorecido_digits TEXT,
        email_favorecido TEXT,
        telefone_favorecido TEXT,
        validade_gr DATE,
        signup_policy TEXT NOT NULL,
        source_count INTEGER NOT NULL
      ) ON COMMIT DROP
    `);

    await tx.$executeRawUnsafe(
      `
        INSERT INTO temp_driver_registry_import (
          row_id, target_id, base, display_name, normalized_name, cpf, cpf_digits, rg,
          data_nascimento, driver_type, sexo, phone, email, placa, nome_favorecido,
          cnpj, cnpj_digits, cpf_favorecido, cpf_favorecido_digits, email_favorecido,
          telefone_favorecido, validade_gr, signup_policy, source_count
        )
        SELECT
          x.row_id::uuid, NULLIF(x.target_id, '')::uuid, x.base, x.display_name,
          x.normalized_name, x.cpf, x.cpf_digits, x.rg,
          NULLIF(x.data_nascimento, '')::date, x.driver_type, x.sexo, x.phone, x.email,
          x.placa, x.nome_favorecido, x.cnpj, x.cnpj_digits, x.cpf_favorecido,
          x.cpf_favorecido_digits, x.email_favorecido, x.telefone_favorecido,
          NULLIF(x.validade_gr, '')::date, x.signup_policy, x.source_count
        FROM jsonb_to_recordset($1::jsonb) AS x(
          row_id text, target_id text, base text, display_name text, normalized_name text,
          cpf text, cpf_digits text, rg text, data_nascimento text, driver_type text,
          sexo text, phone text, email text, placa text, nome_favorecido text, cnpj text,
          cnpj_digits text, cpf_favorecido text, cpf_favorecido_digits text,
          email_favorecido text, telefone_favorecido text, validade_gr text,
          signup_policy text, source_count integer
        )
      `,
      JSON.stringify(stageRows),
    );

    await tx.$executeRawUnsafe(`
      CREATE TEMP TABLE temp_driver_registry_merge (
        duplicate_id UUID PRIMARY KEY,
        target_id UUID NOT NULL,
        reason TEXT NOT NULL
      ) ON COMMIT DROP
    `);

    if (payload.mergePairs.length > 0) {
      await tx.$executeRawUnsafe(
        `
          INSERT INTO temp_driver_registry_merge (duplicate_id, target_id, reason)
          SELECT x.duplicate_id::uuid, x.target_id::uuid, x.reason
          FROM jsonb_to_recordset($1::jsonb) AS x(duplicate_id text, target_id text, reason text)
        `,
        JSON.stringify(
          payload.mergePairs.map((item) => ({
            duplicate_id: item.duplicateId,
            target_id: item.targetId,
            reason: item.reason,
          })),
        ),
      );
    }

    const movedRecords = await tx.$executeRawUnsafe(`
      UPDATE public.driver_registry_records child
      SET entity_id = merge.target_id
      FROM temp_driver_registry_merge merge
      WHERE child.entity_id = merge.duplicate_id
    `);
    const movedSignupRequests = await tx.$executeRawUnsafe(`
      UPDATE public.driver_signup_requests child
      SET entity_id = merge.target_id
      FROM temp_driver_registry_merge merge
      WHERE child.entity_id = merge.duplicate_id
    `);
    const mergedEntities = await tx.$executeRawUnsafe(`
      DELETE FROM public.driver_registry_entities entity
      USING temp_driver_registry_merge merge
      WHERE entity.id = merge.duplicate_id
    `);

    const updatedEntities = await tx.$executeRawUnsafe(`
      UPDATE public.driver_registry_entities entity
      SET
        base = source.base,
        display_name = source.display_name,
        normalized_name = source.normalized_name,
        cpf = source.cpf,
        cpf_digits = source.cpf_digits,
        rg = source.rg,
        data_nascimento = source.data_nascimento,
        driver_type = source.driver_type,
        sexo = source.sexo,
        phone = source.phone,
        email = source.email,
        placa = source.placa,
        nome_favorecido = source.nome_favorecido,
        cnpj = source.cnpj,
        cnpj_digits = source.cnpj_digits,
        cpf_favorecido = source.cpf_favorecido,
        cpf_favorecido_digits = source.cpf_favorecido_digits,
        email_favorecido = source.email_favorecido,
        telefone_favorecido = source.telefone_favorecido,
        validade_gr = source.validade_gr,
        source_count = source.source_count,
        updated_at = NOW()
      FROM temp_driver_registry_import source
      WHERE source.target_id IS NOT NULL AND entity.id = source.target_id
    `);

    const insertedEntities = await tx.$executeRawUnsafe(`
      INSERT INTO public.driver_registry_entities (
        id, base, display_name, normalized_name, cnpj, cnpj_digits, cpf, cpf_digits,
        email, phone, driver_type, signup_policy, active, source_count, created_at,
        updated_at, rg, data_nascimento, sexo, placa, nome_favorecido, cpf_favorecido,
        cpf_favorecido_digits, email_favorecido, telefone_favorecido, validade_gr
      )
      SELECT
        source.row_id, source.base, source.display_name, source.normalized_name,
        source.cnpj, source.cnpj_digits, source.cpf, source.cpf_digits, source.email,
        source.phone, source.driver_type, source.signup_policy, TRUE, source.source_count,
        NOW(), NOW(), source.rg, source.data_nascimento, source.sexo, source.placa,
        source.nome_favorecido, source.cpf_favorecido, source.cpf_favorecido_digits,
        source.email_favorecido, source.telefone_favorecido, source.validade_gr
      FROM temp_driver_registry_import source
      WHERE source.target_id IS NULL
      ON CONFLICT (normalized_name, cnpj_digits) DO UPDATE SET
        base = EXCLUDED.base,
        display_name = EXCLUDED.display_name,
        cpf = EXCLUDED.cpf,
        cpf_digits = EXCLUDED.cpf_digits,
        email = EXCLUDED.email,
        phone = EXCLUDED.phone,
        driver_type = EXCLUDED.driver_type,
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
    `);

    return {
      movedRecords,
      movedSignupRequests,
      mergedEntities,
      updatedEntities,
      insertedEntities,
    };
  },
  { maxWait: 20000, timeout: 300000 },
);

const afterCount = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
  "SELECT COUNT(*)::bigint AS count FROM public.driver_registry_entities",
);
const remainingExactDuplicates = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(`
  SELECT COUNT(*)::bigint AS count
  FROM (
    SELECT normalized_name, cnpj_digits
    FROM public.driver_registry_entities
    GROUP BY normalized_name, cnpj_digits
    HAVING COUNT(*) > 1
  ) duplicates
`);
const matchedSheetRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
  `
    SELECT COUNT(*)::bigint AS count
    FROM public.driver_registry_entities
    WHERE (normalized_name, cnpj_digits) IN (
      SELECT x.normalized_name, x.cnpj_digits
      FROM jsonb_to_recordset($1::jsonb) AS x(normalized_name text, cnpj_digits text)
    )
  `,
  JSON.stringify(stageRows.map((row) => ({ normalized_name: row.normalized_name, cnpj_digits: row.cnpj_digits }))),
);

const operationReport = {
  completedAt: new Date().toISOString(),
  sourceReport: payload.report,
  before: {
    entities: beforeEntities.length,
    registryRecords: beforeRecords.length,
    signupRequests: beforeSignupRequests.length,
  },
  operation: transactionResult,
  changes: {
    recordsWithChanges: changedRecords.length,
    accentOrSpellingCorrections,
    fieldChanges,
    examples: changedRecords.slice(0, 100),
  },
  consolidation: {
    spreadsheetRows: Number((payload.report.source as RawRecord | undefined)?.totalRows || 0),
    identitiesBeforeDatabaseKeyConsolidation: payload.plans.length,
    identitiesAfterDatabaseKeyConsolidation: consolidatedPlans.length,
    databaseKeyDuplicateGroups: databaseKeyDuplicateGroups.length,
    databaseKeyDuplicateRows: databaseKeyDuplicateGroups.reduce(
      (total, group) => total + group.sourceRows.length - 1,
      0,
    ),
    groups: databaseKeyDuplicateGroups,
  },
  after: {
    entities: Number(afterCount[0]?.count || 0),
    sheetIdentitiesFound: Number(matchedSheetRows[0]?.count || 0),
    remainingExactDuplicateGroups: Number(remainingExactDuplicates[0]?.count || 0),
  },
};

await fs.writeFile(reportPath, json(operationReport), "utf8");
console.log(
  json({
    completedAt: operationReport.completedAt,
    reportPath,
    before: operationReport.before,
    operation: operationReport.operation,
    changes: {
      recordsWithChanges: operationReport.changes.recordsWithChanges,
      accentOrSpellingCorrections: operationReport.changes.accentOrSpellingCorrections,
      fieldChanges: operationReport.changes.fieldChanges,
    },
    consolidation: {
      spreadsheetRows: operationReport.consolidation.spreadsheetRows,
      identitiesBeforeDatabaseKeyConsolidation:
        operationReport.consolidation.identitiesBeforeDatabaseKeyConsolidation,
      identitiesAfterDatabaseKeyConsolidation:
        operationReport.consolidation.identitiesAfterDatabaseKeyConsolidation,
      databaseKeyDuplicateGroups: operationReport.consolidation.databaseKeyDuplicateGroups,
      databaseKeyDuplicateRows: operationReport.consolidation.databaseKeyDuplicateRows,
    },
    after: operationReport.after,
  }),
);
await prisma.$disconnect();
