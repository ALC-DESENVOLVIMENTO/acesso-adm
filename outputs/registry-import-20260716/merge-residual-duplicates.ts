import fs from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const reportPath =
  "C:/Users/Wesley/Documents/Dev Alc/Projetos/acesso-adm/outputs/registry-import-20260716/residual-duplicate-report.json";

type Entity = {
  id: string;
  display_name: string;
  normalized_name: string;
  cpf_digits: string;
  cnpj_digits: string;
  base: string | null;
  source_count: number;
  created_at: Date;
  updated_at: Date;
  registry_refs: number;
  signup_refs: number;
};

function score(entity: Entity) {
  const hasBase = Boolean(entity.base?.trim());
  const startsWithDocument = /^\d/.test(entity.display_name.trim());
  const isUppercase = entity.display_name === entity.display_name.toUpperCase();
  return (
    Number(hasBase) * 1_000_000 +
    entity.source_count * 1_000 +
    Number(!startsWithDocument) * 100 +
    Number(isUppercase) * 10 +
    entity.display_name.length
  );
}

const rows = await prisma.$queryRawUnsafe<Entity[]>(`
  SELECT entity.id, entity.display_name, entity.normalized_name, entity.cpf_digits,
         entity.cnpj_digits, entity.base, entity.source_count, entity.created_at, entity.updated_at,
         (SELECT COUNT(*)::int FROM public.driver_registry_records record WHERE record.entity_id = entity.id) AS registry_refs,
         (SELECT COUNT(*)::int FROM public.driver_signup_requests request WHERE request.entity_id = entity.id) AS signup_refs
  FROM public.driver_registry_entities entity
  JOIN (
    SELECT cpf_digits, cnpj_digits
    FROM public.driver_registry_entities
    WHERE cpf_digits <> '' AND cnpj_digits <> ''
    GROUP BY cpf_digits, cnpj_digits
    HAVING COUNT(*) > 1
  ) duplicates USING (cpf_digits, cnpj_digits)
  ORDER BY entity.cpf_digits, entity.cnpj_digits, entity.updated_at DESC
`);

const groups = new Map<string, Entity[]>();
for (const row of rows) {
  const key = `${row.cpf_digits}|${row.cnpj_digits}`;
  const entries = groups.get(key) || [];
  entries.push(row);
  groups.set(key, entries);
}

const plan = [...groups.entries()].map(([key, entities]) => {
  const ranked = [...entities].sort((left, right) => score(right) - score(left));
  const target = ranked[0];
  const duplicates = ranked.slice(1);
  return {
    key,
    targetId: target.id,
    targetName: target.display_name,
    duplicateIds: duplicates.map((entity) => entity.id),
    duplicateNames: duplicates.map((entity) => entity.display_name),
    sourceCountAfter: entities.reduce((total, entity) => total + entity.source_count, 0),
    registryReferencesToMove: duplicates.reduce((total, entity) => total + entity.registry_refs, 0),
    signupReferencesToMove: duplicates.reduce((total, entity) => total + entity.signup_refs, 0),
  };
});

const pairs = plan.flatMap((group) =>
  group.duplicateIds.map((duplicateId) => ({
    duplicate_id: duplicateId,
    target_id: group.targetId,
    source_count_after: group.sourceCountAfter,
  })),
);

if (!process.argv.includes("--apply")) {
  console.log(
    JSON.stringify(
      {
        mode: "dry-run",
        groups: plan.length,
        duplicateRowsToMerge: pairs.length,
        registryReferencesToMove: plan.reduce(
          (total, group) => total + group.registryReferencesToMove,
          0,
        ),
        signupReferencesToMove: plan.reduce(
          (total, group) => total + group.signupReferencesToMove,
          0,
        ),
        plan,
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();
  process.exit(0);
}

const result = await prisma.$transaction(
  async (tx) => {
    await tx.$executeRawUnsafe(`
      CREATE TEMP TABLE temp_registry_residual_merge (
        duplicate_id UUID PRIMARY KEY,
        target_id UUID NOT NULL,
        source_count_after INTEGER NOT NULL
      ) ON COMMIT DROP
    `);

    if (pairs.length > 0) {
      await tx.$executeRawUnsafe(
        `
          INSERT INTO temp_registry_residual_merge (duplicate_id, target_id, source_count_after)
          SELECT x.duplicate_id::uuid, x.target_id::uuid, x.source_count_after
          FROM jsonb_to_recordset($1::jsonb) AS x(
            duplicate_id text,
            target_id text,
            source_count_after integer
          )
        `,
        JSON.stringify(pairs),
      );
    }

    const movedRecords = await tx.$executeRawUnsafe(`
      UPDATE public.driver_registry_records child
      SET entity_id = merge.target_id
      FROM temp_registry_residual_merge merge
      WHERE child.entity_id = merge.duplicate_id
    `);
    const movedSignupRequests = await tx.$executeRawUnsafe(`
      UPDATE public.driver_signup_requests child
      SET entity_id = merge.target_id
      FROM temp_registry_residual_merge merge
      WHERE child.entity_id = merge.duplicate_id
    `);
    const deletedEntities = await tx.$executeRawUnsafe(`
      DELETE FROM public.driver_registry_entities entity
      USING temp_registry_residual_merge merge
      WHERE entity.id = merge.duplicate_id
    `);
    const updatedTargets = await tx.$executeRawUnsafe(`
      UPDATE public.driver_registry_entities entity
      SET source_count = totals.source_count_after, updated_at = NOW()
      FROM (
        SELECT target_id, MAX(source_count_after) AS source_count_after
        FROM temp_registry_residual_merge
        GROUP BY target_id
      ) totals
      WHERE entity.id = totals.target_id
    `);

    return { movedRecords, movedSignupRequests, deletedEntities, updatedTargets };
  },
  { maxWait: 20_000, timeout: 120_000 },
);

const report = {
  completedAt: new Date().toISOString(),
  groups: plan.length,
  duplicateRowsMerged: pairs.length,
  result,
  plan,
};
await fs.writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(
  JSON.stringify(
    {
      completedAt: report.completedAt,
      reportPath,
      groups: report.groups,
      duplicateRowsMerged: report.duplicateRowsMerged,
      result: report.result,
    },
    null,
    2,
  ),
);
await prisma.$disconnect();
