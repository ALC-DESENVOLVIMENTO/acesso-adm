import { prisma } from "./prisma.js";

export const ARCHI_PAYMENT_FREQUENCIES = ["Semanal", "Quinzenal", "Mensal"] as const;
export type ArchiPaymentFrequency = (typeof ARCHI_PAYMENT_FREQUENCIES)[number];

export type ArchiBase = {
  externalId: string;
  code: string;
  name: string;
  baseType: string;
  location: string;
  manager: string;
  operation: string;
  status: "Ativo" | "Inativo";
  paymentFrequencies: ArchiPaymentFrequency[];
  createdAt: string | null;
};

const schema = process.env.DB_SCHEMA || "portal_administrativo";
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
  throw new Error("DB_SCHEMA invalido.");
}
const table = `"${schema}"."archi_bases"`;
let schemaPromise: Promise<void> | undefined;

export function ensureArchiBaseCatalog() {
  schemaPromise ??= prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ${table} (
      external_id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      last_event_id TEXT NOT NULL,
      deleted BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `).then(() => undefined).catch((error) => {
    schemaPromise = undefined;
    throw error;
  });
  return schemaPromise;
}

export async function upsertArchiBase(base: ArchiBase, eventId: string, occurredAt: string, deleted: boolean) {
  await ensureArchiBaseCatalog();
  const result = await prisma.$queryRawUnsafe<Array<{ external_id: string }>>(`
    INSERT INTO ${table} (external_id, payload, occurred_at, last_event_id, deleted)
    VALUES ($1, $2::jsonb, $3::timestamptz, $4, $5)
    ON CONFLICT (external_id) DO UPDATE SET
      payload = EXCLUDED.payload,
      occurred_at = EXCLUDED.occurred_at,
      last_event_id = EXCLUDED.last_event_id,
      deleted = EXCLUDED.deleted,
      updated_at = NOW()
    WHERE archi_bases.occurred_at <= EXCLUDED.occurred_at
      AND archi_bases.last_event_id <> EXCLUDED.last_event_id
    RETURNING external_id;
  `, base.externalId, JSON.stringify(base), occurredAt, eventId, deleted);
  return result.length > 0;
}

export async function listArchiBases() {
  await ensureArchiBaseCatalog();
  const rows = await prisma.$queryRawUnsafe<Array<{
    payload: ArchiBase;
    deleted: boolean;
    occurred_at: Date;
  }>>(`SELECT payload, deleted, occurred_at FROM ${table} ORDER BY payload->>'name' ASC;`);
  return rows.map((row) => ({ ...row.payload, deleted: row.deleted, syncedAt: row.occurred_at.toISOString() }));
}
