import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";

export async function backfillPaidStatusesFromExistingGroups() {
  const updatedRows = await prisma.$queryRaw<Array<{ updated_count: number }>>(Prisma.sql`
    WITH updated AS (
      UPDATE "uploads_pdf" AS u
         SET "status_pagamento" = 'PAGO',
             "status_pagamento_atualizado_em" = COALESCE(u."status_pagamento_atualizado_em", now()),
             "status_pagamento_origem" = COALESCE(u."status_pagamento_origem", 'BACKFILL_FINANCEIRO_PAGAMENTO'),
             "status_pagamento_motivo" = COALESCE(u."status_pagamento_motivo", 'Backfill automatico de status pago'),
             "usuario_atualizacao_id" = COALESCE(u."usuario_atualizacao_id", u."usuario_id")
       WHERE u."status" <> 'removido'
         AND u."motorista_id" IS NOT NULL
         AND u."periodo_pagamento_id" IS NOT NULL
         AND u."base_pagamento_id" IS NOT NULL
         AND u."status_pagamento" IS DISTINCT FROM 'PAGO'
         AND EXISTS (
           SELECT 1
             FROM "uploads_pdf" AS paid
            WHERE paid."status_pagamento" = 'PAGO'
              AND paid."motorista_id" = u."motorista_id"
              AND paid."periodo_pagamento_id" = u."periodo_pagamento_id"
              AND paid."base_pagamento_id" = u."base_pagamento_id"
         )
       RETURNING 1
    )
    SELECT count(*)::int AS updated_count
      FROM updated;
  `);

  return updatedRows[0]?.updated_count ?? 0;
}
