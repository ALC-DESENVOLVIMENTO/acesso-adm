type PdfOnlineBridgePayload = {
  event: string;
  data?: unknown;
  meta?: Record<string, unknown>;
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

export async function notifyPdfOnline(event: string, data: unknown = {}, meta: Record<string, unknown> = {}) {
  const webhookUrl = resolvePdfOnlineWebhookUrl();

  if (!webhookUrl) {
    return {
      skipped: true,
      reason: "missing-webhook-url"
    };
  }

  const bridgeToken = readBridgeEnv("PDFONLINE_BRIDGE_TOKEN");
  const payload: PdfOnlineBridgePayload = {
    event,
    data,
    meta: {
      source: "acesso-adm",
      ...meta
    }
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bridgeToken
        ? {
            "x-webhook-token": bridgeToken,
            "x-bridge-token": bridgeToken
          }
        : {})
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `PDF Online webhook retornou ${response.status}${text ? `: ${text}` : ""}`
    );
  }

  return {
    skipped: false,
    status: response.status
  };
}
