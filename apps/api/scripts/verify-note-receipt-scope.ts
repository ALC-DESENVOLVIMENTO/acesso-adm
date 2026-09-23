import { PrismaClient } from "@prisma/client";
import { resolveDatabaseUrlWithSchema } from "../src/lib/database-url.js";
const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrlWithSchema() } } });
async function main() {
  const result = await prisma.$queryRawUnsafe<Array<{ total: bigint; sample: string }>>(`
    SELECT count(*)::bigint AS total,
      COALESCE(string_agg(r.id::text || '|' || COALESCE(r.nome_arquivo, ''), E'\\n' ORDER BY r.upload_em DESC), '') AS sample
    FROM "portal_administrativo"."driver_pdf_received" r
    JOIN "portal_administrativo"."uploads_pdf" u ON u.id = r.upload_pdf_id
    WHERE r.document_type <> 'espelho'
      AND u.document_type <> 'espelho'
      AND (r.motorista_id IS DISTINCT FROM u.motorista_id
        OR r.periodo_pagamento_id IS DISTINCT FROM u.periodo_pagamento_id
        OR r.base_pagamento_id IS DISTINCT FROM u.base_pagamento_id)
  `);
  const mismatches = await prisma.$queryRawUnsafe<unknown[]>(`SELECT r.id,r.nome_arquivo,r.motorista_id,r.periodo_pagamento_id,r.base_pagamento_id,u.id AS upload_id,u.motorista_id AS upload_motorista_id,u.periodo_pagamento_id AS upload_periodo_id,u.base_pagamento_id AS upload_base_id FROM "portal_administrativo"."driver_pdf_received" r JOIN "portal_administrativo"."uploads_pdf" u ON u.id=r.upload_pdf_id WHERE r.document_type <> 'espelho' AND u.document_type <> 'espelho' AND (r.motorista_id IS DISTINCT FROM u.motorista_id OR r.periodo_pagamento_id IS DISTINCT FROM u.periodo_pagamento_id OR r.base_pagamento_id IS DISTINCT FROM u.base_pagamento_id)`);
  const bruna = await prisma.$queryRawUnsafe<unknown[]>(`
    SELECT r.id, r.motorista_id, r.periodo_pagamento_id, r.base_pagamento_id, u.id AS upload_id,
      u.motorista_id AS upload_motorista_id, u.periodo_pagamento_id AS upload_periodo_id,
      u.base_pagamento_id AS upload_base_id, r.status, r.nome_arquivo
    FROM "portal_administrativo"."driver_pdf_received" r
    JOIN "portal_administrativo"."uploads_pdf" u ON u.id = r.upload_pdf_id
    WHERE lower(coalesce(r.nome_arquivo, '')) LIKE '%bruna%'
    ORDER BY r.upload_em DESC
  `);
  console.log(JSON.stringify({ remainingMismatches: Number(result[0]?.total || 0), mismatches, bruna }, null, 2));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>prisma.$disconnect());
