import { createHmac } from "node:crypto";

function env(...names: string[]) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function webhookUrl() {
  const configured = env("ARCHI_WEBHOOK_URL");
  if (configured) return configured;

  const base = env("ARCHI_BASE_URL", "RAILWAY_SERVICE_APLICA_O_ARCHI_URL");
  if (!base) return "";
  return new URL("/api/webhooks/access-adm", base.startsWith("http") ? base : `https://${base}`).toString();
}

export async function notifyArchi(event: string, data: Record<string, unknown>) {
  const url = webhookUrl();
  if (!url) return { skipped: true, reason: "missing-archi-webhook-url" };

  const payload = JSON.stringify({
    event,
    eventId: `acesso-adm:${event}:${String(data.externalId || data.motoristaId || Date.now())}`,
    data,
    meta: { source: "acesso-adm", occurredAt: new Date().toISOString() }
  });
  const token = env("ARCHI_WEBHOOK_TOKEN", "ACCESS_ADM_WEBHOOK_TOKEN", "PDFONLINE_BRIDGE_TOKEN");
  const secret = env("ARCHI_WEBHOOK_SECRET", "ACCESS_ADM_WEBHOOK_SECRET", "PDFONLINE_WEBHOOK_SECRET");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-webhook-token"] = token;
  if (secret) headers["x-webhook-signature"] = createHmac("sha256", secret).update(payload).digest("hex");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { method: "POST", headers, body: payload, signal: controller.signal });
    if (!response.ok) {
      return { skipped: false, ok: false, status: response.status };
    }
    return { skipped: false, ok: true, status: response.status };
  } catch (error) {
    console.error("Falha ao notificar o ARCHI:", error instanceof Error ? error.message : error);
    return { skipped: false, ok: false, status: 0 };
  } finally {
    clearTimeout(timeout);
  }
}
