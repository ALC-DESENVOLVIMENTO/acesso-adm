import { PrismaClient } from "@prisma/client";
import { resolveDatabaseUrlWithSchema } from "../src/lib/database-url.js";
const prisma = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrlWithSchema() } } });
async function main() {
  const updated = await prisma.$queryRawUnsafe<Array<{ id: string; upload_pdf_id: string; nome_arquivo: string | null }>>(`
    WITH candidates AS (
      SELECT r.id, r.upload_pdf_id, r.nome_arquivo,
        u.motorista_id AS source_motorista_id, u.periodo_pagamento_id AS source_periodo_id,
        u.base_pagamento_id AS source_base_id
      FROM "portal_administrativo"."driver_pdf_received" r
      JOIN "portal_administrativo"."uploads_pdf" u ON u.id = r.upload_pdf_id
      WHERE r.document_type <> 'espelho' AND u.document_type <> 'espelho'
        AND u.motorista_id IS NOT NULL AND u.periodo_pagamento_id IS NOT NULL AND u.base_pagamento_id IS NOT NULL
        AND (r.motorista_id IS NULL OR r.motorista_id = u.motorista_id)
        AND (r.motorista_id IS DISTINCT FROM u.motorista_id
          OR r.periodo_pagamento_id IS DISTINCT FROM u.periodo_pagamento_id
          OR r.base_pagamento_id IS DISTINCT FROM u.base_pagamento_id)
    )
    UPDATE "portal_administrativo"."driver_pdf_received" r
    SET motorista_id = c.source_motorista_id,
        periodo_pagamento_id = c.source_periodo_id,
        base_pagamento_id = c.source_base_id,
        atualizado_em = now()
    FROM candidates c
    WHERE r.id = c.id
    RETURNING r.id, r.upload_pdf_id, r.nome_arquivo
  `);
  const conflicts = await prisma.$queryRawUnsafe<Array<{ total: bigint }>>(`
    SELECT count(*)::bigint AS total
    FROM "portal_administrativo"."driver_pdf_received" r
    JOIN "portal_administrativo"."uploads_pdf" u ON u.id = r.upload_pdf_id
    WHERE r.document_type <> 'espelho' AND u.document_type <> 'espelho'
      AND r.motorista_id IS NOT NULL AND u.motorista_id IS NOT NULL AND r.motorista_id <> u.motorista_id
  `);
  await prisma.logAuditoria.create({
    data: {
      acao: "backfill_escopo_nf_lote",
      entidade: "driver_pdf_received",
      entidadeId: null,
      detalhes: {
        origem: "upload_pdf_original",
        totalCorrigido: updated.length,
        conflitosNaoAlterados: Number(conflicts[0]?.total || 0),
        registros: updated.map((item) => ({ id: item.id, uploadPdfId: item.upload_pdf_id, arquivo: item.nome_arquivo }))
      }
    }
  });
  console.log(JSON.stringify({ totalCorrigido: updated.length, conflitosNaoAlterados: Number(conflicts[0]?.total || 0), ids: updated.map((item) => item.id) }, null, 2));
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>prisma.$disconnect());
