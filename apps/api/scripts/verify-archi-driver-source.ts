import { ensureArchiDriverSourceViews } from "../src/lib/driver-registry-schema.js";
import { prisma } from "../src/lib/prisma.js";

await ensureArchiDriverSourceViews();

const counts = await prisma.$queryRaw<
  Array<{
    approved_archi: number;
    effective_total: number;
    effective_archi: number;
    effective_legacy: number;
    duplicate_cpfs: number;
    rejected_leaks: number;
  }>
>`
  SELECT
    (SELECT COUNT(*)::integer FROM public.archi_motoristas_aprovados) AS approved_archi,
    (SELECT COUNT(*)::integer FROM public.driver_registry_effective) AS effective_total,
    (SELECT COUNT(*)::integer FROM public.driver_registry_effective WHERE _source = 'archi') AS effective_archi,
    (SELECT COUNT(*)::integer FROM public.driver_registry_effective WHERE _source = 'legacy') AS effective_legacy,
    (
      SELECT COUNT(*)::integer FROM (
        SELECT cpf_digits FROM public.driver_registry_effective
        GROUP BY cpf_digits HAVING COUNT(*) > 1
      ) duplicates
    ) AS duplicate_cpfs,
    (
      SELECT COUNT(*)::integer
      FROM public.driver_registry_effective effective
      JOIN public.motoristas motorista
        ON regexp_replace(motorista.cpf, '\\D', '', 'g') = effective.cpf_digits
      WHERE lower(btrim(COALESCE(motorista.extra_data ->> 'gerencialGrStatus', ''))) NOT IN (
        'aprovado', 'aprovado com ressalva', 'aprovado com resalva'
      )
    ) AS rejected_leaks
`;

console.log(JSON.stringify(counts[0], null, 2));
await prisma.$disconnect();
