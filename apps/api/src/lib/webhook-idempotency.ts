import { createHash } from "node:crypto";

/**
 * Build an idempotency key from both the supplied event ID and its snapshot.
 * This tolerates upstream systems that accidentally reuse an event ID for a
 * changed record while still suppressing exact retries.
 */
export function buildWebhookDedupeKey(namespace: string, event: string, eventId: string, payload: unknown) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ event, eventId, payload }))
    .digest("hex");
  return `${namespace}:${fingerprint}`;
}
