import { prisma } from "./prisma.js";

const DB_SCHEMA = process.env.DB_SCHEMA || "portal_administrativo";

async function ensureType(typeName: string, values: string[]) {
  const valuesSql = values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");

  await prisma.$executeRawUnsafe(`
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = '${typeName}'
      AND n.nspname = '${DB_SCHEMA}'
  ) THEN
    CREATE TYPE "${DB_SCHEMA}"."${typeName}" AS ENUM (${valuesSql});
  END IF;
END $$;
`);
}

async function ensureColumn(table: string, column: string, sqlType: string, defaultClause = "") {
  const typeName = sqlType;
  await prisma.$executeRawUnsafe(`
ALTER TABLE "${DB_SCHEMA}"."${table}"
  ADD COLUMN IF NOT EXISTS "${column}" ${typeName}${defaultClause};
`);
}

async function ensureTable(sql: string) {
  await prisma.$executeRawUnsafe(sql);
}

async function ensureIndex(sql: string) {
  await prisma.$executeRawUnsafe(sql);
}

export async function ensureFinanceiroCompatibilitySchema() {
  await ensureType("FinanceiroStatusPagamento", [
    "PAGO",
    "TENTATIVA_FALHA",
    "BLOQUEADO",
    "PENDENTE",
    "REVISAO_MANUAL"
  ]);
  await ensureType("FinanceiroImportacaoStatus", [
    "preview",
    "confirmado",
    "processando",
    "concluido",
    "concluido_com_erro",
    "rejeitado"
  ]);
  await ensureType("FinanceiroImportacaoItemResultado", [
    "valido",
    "pagamento_nao_encontrado",
    "correspondencia_ambiguo",
    "linha_duplicada",
    "linha_vazia",
    "linha_inconsistente",
    "cor_nao_reconhecida",
    "sem_identificador",
    "ja_atualizada",
    "conflito_status"
  ]);
  await ensureType("WebhookEventoStatus", ["pendente", "processando", "enviado", "falhou"]);

  await ensureColumn("uploads_pdf", "status_pagamento", `"${DB_SCHEMA}"."FinanceiroStatusPagamento"`);
  await ensureColumn("uploads_pdf", "status_pagamento_atualizado_em", "TIMESTAMPTZ(6)");
  await ensureColumn("uploads_pdf", "status_pagamento_motivo", "TEXT");
  await ensureColumn("uploads_pdf", "status_pagamento_origem", "TEXT");
  await ensureColumn("uploads_pdf", "codigo_obb", "VARCHAR(80)");
  await ensureColumn("uploads_pdf", "usuario_atualizacao_id", "UUID");

  await ensureTable(`
CREATE TABLE IF NOT EXISTS "${DB_SCHEMA}"."importacoes_financeiras" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome_arquivo VARCHAR(255) NOT NULL,
  hash_arquivo VARCHAR(128) NOT NULL UNIQUE,
  nome_aba VARCHAR(80) NOT NULL,
  usuario_id UUID NOT NULL,
  periodo_pagamento_id UUID NULL,
  base_pagamento_id UUID NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmado_em TIMESTAMPTZ NULL,
  total_linhas INTEGER NOT NULL DEFAULT 0,
  total_validas INTEGER NOT NULL DEFAULT 0,
  total_erros INTEGER NOT NULL DEFAULT 0,
  status "${DB_SCHEMA}"."FinanceiroImportacaoStatus" NOT NULL DEFAULT 'preview',
  CONSTRAINT importacoes_financeiras_usuario_fk FOREIGN KEY (usuario_id) REFERENCES "${DB_SCHEMA}"."usuarios"(id) ON DELETE RESTRICT,
  CONSTRAINT importacoes_financeiras_periodo_fk FOREIGN KEY (periodo_pagamento_id) REFERENCES "${DB_SCHEMA}"."periodos_pagamento"(id) ON DELETE SET NULL,
  CONSTRAINT importacoes_financeiras_base_fk FOREIGN KEY (base_pagamento_id) REFERENCES "${DB_SCHEMA}"."bases_pagamento"(id) ON DELETE SET NULL
);
`);

  await ensureTable(`
CREATE TABLE IF NOT EXISTS "${DB_SCHEMA}"."importacoes_financeiras_itens" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  importacao_id UUID NOT NULL,
  numero_linha INTEGER NOT NULL,
  identificador VARCHAR(180) NULL,
  pagamento_id UUID NULL,
  motorista_id UUID NULL,
  periodo_pagamento_id UUID NULL,
  base_pagamento_id UUID NULL,
  codigo_obb VARCHAR(80) NULL,
  cor_identificada VARCHAR(80) NULL,
  regra_aplicada VARCHAR(120) NULL,
  status_anterior "${DB_SCHEMA}"."FinanceiroStatusPagamento" NULL,
  status_novo "${DB_SCHEMA}"."FinanceiroStatusPagamento" NULL,
  resultado "${DB_SCHEMA}"."FinanceiroImportacaoItemResultado" NOT NULL DEFAULT 'valido',
  mensagem TEXT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT importacoes_financeiras_itens_importacao_fk FOREIGN KEY (importacao_id) REFERENCES "${DB_SCHEMA}"."importacoes_financeiras"(id) ON DELETE CASCADE,
  CONSTRAINT importacoes_financeiras_itens_pagamento_fk FOREIGN KEY (pagamento_id) REFERENCES "${DB_SCHEMA}"."uploads_pdf"(id) ON DELETE SET NULL,
  CONSTRAINT importacoes_financeiras_itens_motorista_fk FOREIGN KEY (motorista_id) REFERENCES "${DB_SCHEMA}"."motoristas"(id) ON DELETE SET NULL
);
`);

  await ensureTable(`
CREATE TABLE IF NOT EXISTS "${DB_SCHEMA}"."historico_status_pagamento" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pagamento_id UUID NOT NULL,
  importacao_id UUID NULL,
  item_id UUID NULL,
  status_anterior "${DB_SCHEMA}"."FinanceiroStatusPagamento" NULL,
  status_novo "${DB_SCHEMA}"."FinanceiroStatusPagamento" NOT NULL,
  motivo TEXT NULL,
  codigo_obb VARCHAR(80) NULL,
  cor_identificada VARCHAR(80) NULL,
  regra_aplicada VARCHAR(120) NULL,
  origem VARCHAR(120) NOT NULL,
  usuario_id UUID NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT historico_status_pagamento_pagamento_fk FOREIGN KEY (pagamento_id) REFERENCES "${DB_SCHEMA}"."uploads_pdf"(id) ON DELETE CASCADE,
  CONSTRAINT historico_status_pagamento_importacao_fk FOREIGN KEY (importacao_id) REFERENCES "${DB_SCHEMA}"."importacoes_financeiras"(id) ON DELETE SET NULL,
  CONSTRAINT historico_status_pagamento_item_fk FOREIGN KEY (item_id) REFERENCES "${DB_SCHEMA}"."importacoes_financeiras_itens"(id) ON DELETE SET NULL,
  CONSTRAINT historico_status_pagamento_usuario_fk FOREIGN KEY (usuario_id) REFERENCES "${DB_SCHEMA}"."usuarios"(id) ON DELETE SET NULL
);
`);

  await ensureTable(`
CREATE TABLE IF NOT EXISTS "${DB_SCHEMA}"."webhook_eventos" (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id VARCHAR(120) NOT NULL UNIQUE,
  importacao_id UUID NULL,
  pagamento_id UUID NULL,
  payload JSONB NOT NULL,
  status "${DB_SCHEMA}"."WebhookEventoStatus" NOT NULL DEFAULT 'pendente',
  tentativas INTEGER NOT NULL DEFAULT 0,
  ultima_tentativa_em TIMESTAMPTZ NULL,
  resposta_http INTEGER NULL,
  mensagem_erro TEXT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  usuario_id UUID NULL,
  CONSTRAINT webhook_eventos_importacao_fk FOREIGN KEY (importacao_id) REFERENCES "${DB_SCHEMA}"."importacoes_financeiras"(id) ON DELETE SET NULL,
  CONSTRAINT webhook_eventos_pagamento_fk FOREIGN KEY (pagamento_id) REFERENCES "${DB_SCHEMA}"."uploads_pdf"(id) ON DELETE SET NULL,
  CONSTRAINT webhook_eventos_usuario_fk FOREIGN KEY (usuario_id) REFERENCES "${DB_SCHEMA}"."usuarios"(id) ON DELETE SET NULL
);
`);

  await ensureIndex(`CREATE INDEX IF NOT EXISTS "importacoes_financeiras_usuario_id_idx" ON "${DB_SCHEMA}"."importacoes_financeiras" ("usuario_id");`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS "importacoes_financeiras_periodo_pagamento_id_idx" ON "${DB_SCHEMA}"."importacoes_financeiras" ("periodo_pagamento_id");`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS "importacoes_financeiras_base_pagamento_id_idx" ON "${DB_SCHEMA}"."importacoes_financeiras" ("base_pagamento_id");`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS "importacoes_financeiras_itens_importacao_id_idx" ON "${DB_SCHEMA}"."importacoes_financeiras_itens" ("importacao_id");`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS "importacoes_financeiras_itens_pagamento_id_idx" ON "${DB_SCHEMA}"."importacoes_financeiras_itens" ("pagamento_id");`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS "importacoes_financeiras_itens_motorista_id_idx" ON "${DB_SCHEMA}"."importacoes_financeiras_itens" ("motorista_id");`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS "historico_status_pagamento_pagamento_id_idx" ON "${DB_SCHEMA}"."historico_status_pagamento" ("pagamento_id");`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS "historico_status_pagamento_importacao_id_idx" ON "${DB_SCHEMA}"."historico_status_pagamento" ("importacao_id");`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS "historico_status_pagamento_usuario_id_idx" ON "${DB_SCHEMA}"."historico_status_pagamento" ("usuario_id");`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS "webhook_eventos_importacao_id_idx" ON "${DB_SCHEMA}"."webhook_eventos" ("importacao_id");`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS "webhook_eventos_pagamento_id_idx" ON "${DB_SCHEMA}"."webhook_eventos" ("pagamento_id");`);
  await ensureIndex(`CREATE INDEX IF NOT EXISTS "webhook_eventos_status_idx" ON "${DB_SCHEMA}"."webhook_eventos" ("status");`);
}
