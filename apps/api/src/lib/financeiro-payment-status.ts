const PAYMENT_PROCESS_STATUS_BY_CODE: Record<string, string> = {
  PAGO: "pago",
  PENDENTE: "pagamento_pendente",
  BLOQUEADO: "pagamento_bloqueado",
  TENTATIVA_FALHA: "tentativa_pagamento_falha",
  REVISAO_MANUAL: "pagamento_em_revisao"
};

function normalize(value: string | null | undefined) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase();
}

export function resolvePaymentProcessStatus(
  status: string | null | undefined,
  origin: string | null | undefined
) {
  const normalizedStatus = normalize(status);

  if (!normalizedStatus) {
    return null;
  }

  if (
    normalizedStatus === "PENDENTE" &&
    normalize(origin).includes("NOTA_FISCAL_PENDENTE")
  ) {
    return "nota_fiscal_pendente";
  }

  return PAYMENT_PROCESS_STATUS_BY_CODE[normalizedStatus] || "pagamento_em_revisao";
}

export const PAYMENT_PROCESS_STATUS_LABELS: Record<string, string> = {
  pago: "Pago",
  pagamento_pendente: "Pagamento Pendente",
  nota_fiscal_pendente: "Nota Fiscal Pendente",
  pagamento_bloqueado: "Pagamento Bloqueado",
  tentativa_pagamento_falha: "Tentativa de Pagamento sem Sucesso",
  pagamento_em_revisao: "Pagamento em Revisão"
};
