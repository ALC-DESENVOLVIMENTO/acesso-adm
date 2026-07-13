import { createHmac } from "node:crypto";

type PdfOnlineBridgePayload = {
  event: string;
  data?: unknown;
  meta?: Record<string, unknown>;
};

type PaymentStatusWebhookPayload = {
  event: string;
  event_id: string;
  occurred_at: string;
  pagamento_id: string;
  espelho_pagamento_id?: string | null;
  nota_fiscal_id?: string | null;
  pdfonline_id?: string | null;
  motorista_id?: string | null;
  cpf_cnpj?: string | null;
  periodo_pagamento_id?: string | null;
  lote_id?: string | null;
  status_anterior?: string | null;
  status_atual: string;
  motivo?: string | null;
  codigo_obb?: string | null;
  origem_status?: string | null;
  origem: string;
  importacao_id?: string | null;
  linha_planilha?: number | null;
};

function readBridgeEnv(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();

    if (value && value.toLowerCase() !== "undefined" && value.toLowerCase() !== "null") {
      return value;
    }
  }

  return "";
}

function resolvePdfOnlineWebhookUrl() {
  const directUrl = readBridgeEnv("PDFONLINE_WEBHOOK_URL");

  if (directUrl) {
    return directUrl;
  }

  const baseUrl = readBridgeEnv("PDFONLINE_BASE_URL", "PDFONLINE_URL");

  if (!baseUrl) {
    return "";
  }

  return new URL("/api/webhooks/access-adm", baseUrl).toString();
}

function resolvePdfOnlinePaymentWebhookUrl() {
  const directUrl = readBridgeEnv("PDFONLINE_PAYMENTS_WEBHOOK_URL");

  if (directUrl) {
    return [directUrl];
  }

  const baseUrl = readBridgeEnv("PDFONLINE_BASE_URL", "PDFONLINE_URL");

  if (!baseUrl) {
    return [];
  }

  return [
    new URL("/api/webhooks/pagamentos/status", baseUrl).toString(),
    new URL("/api/webhooks/pagamento/status", baseUrl).toString(),
    new URL("/api/webhook/pagamentos/status", baseUrl).toString(),
    new URL("/api/webhook/pagamento/status", baseUrl).toString()
  ];
}

function buildHeaders(body: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };
  const bridgeToken = readBridgeEnv("PDFONLINE_BRIDGE_TOKEN");
  const webhookSecret = readBridgeEnv("PDFONLINE_WEBHOOK_SECRET", "PDFONLINE_BRIDGE_SECRET");

  if (bridgeToken) {
    headers["x-webhook-token"] = bridgeToken;
    headers["x-bridge-token"] = bridgeToken;
  }

  if (webhookSecret) {
    headers["x-webhook-signature"] = createHmac("sha256", webhookSecret).update(body).digest("hex");
  }

  return headers;
}

async function postJson(url: string, body: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(body),
    body
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      text
    };
  }

  return {
    ok: true,
    status: response.status,
    text: ""
  };
}

async function postJsonWithFallback(urls: string[], body: string) {
  const errors: Array<{ url: string; status: number; text: string }> = [];

  for (const url of urls) {
    const result = await postJson(url, body);

    if (result.ok) {
      return {
        status: result.status,
        url
      };
    }

    errors.push({
      url,
      status: result.status,
      text: result.text
    });

    if (result.status !== 404) {
      break;
    }
  }

  const last = errors[errors.length - 1];
  const urlsText = errors.map((item) => `${item.status} ${item.url}`).join(" | ");
  throw new Error(
    `PDF Online webhook retornou ${last?.status || 0}${last?.text ? `: ${last.text}` : ""}${urlsText ? ` | tentativas: ${urlsText}` : ""}`
  );
}

export async function notifyPdfOnline(event: string, data: unknown = {}, meta: Record<string, unknown> = {}) {
  const webhookUrl = resolvePdfOnlineWebhookUrl();

  if (!webhookUrl) {
    return {
      skipped: true,
      reason: "missing-webhook-url"
    };
  }

  const payload: PdfOnlineBridgePayload = {
    event,
    data,
    meta: {
      source: "acesso-adm",
      ...meta
    }
  };

  const status = await postJson(webhookUrl, JSON.stringify(payload));

  return {
    skipped: false,
    status
  };
}

export async function notifyPaymentStatusToPdfOnline(payload: PaymentStatusWebhookPayload) {
  const webhookUrls = resolvePdfOnlinePaymentWebhookUrl();

  if (!webhookUrls.length) {
    return {
      skipped: true,
      reason: "missing-webhook-url"
    };
  }

  const result = await postJsonWithFallback(webhookUrls, JSON.stringify(payload));

  return {
    skipped: false,
    status: result.status,
    url: result.url
  };
}
