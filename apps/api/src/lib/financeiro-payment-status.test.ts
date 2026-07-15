import assert from "node:assert/strict";
import test from "node:test";
import { resolvePaymentProcessStatus } from "./financeiro-payment-status.js";

test("maps every persisted financial status to the process status", () => {
  assert.equal(resolvePaymentProcessStatus("PAGO", null), "pago");
  assert.equal(resolvePaymentProcessStatus("PENDENTE", null), "pagamento_pendente");
  assert.equal(resolvePaymentProcessStatus("BLOQUEADO", null), "pagamento_bloqueado");
  assert.equal(resolvePaymentProcessStatus("TENTATIVA_FALHA", null), "tentativa_pagamento_falha");
  assert.equal(resolvePaymentProcessStatus("REVISAO_MANUAL", null), "pagamento_em_revisao");
});

test("preserves the nota fiscal pendente origin", () => {
  assert.equal(
    resolvePaymentProcessStatus("PENDENTE", "Status da planilha = NOTA_FISCAL_PENDENTE"),
    "nota_fiscal_pendente"
  );
});

test("does not override document status before a financial import", () => {
  assert.equal(resolvePaymentProcessStatus(null, null), null);
});
