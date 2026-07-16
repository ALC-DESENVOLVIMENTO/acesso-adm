import assert from "node:assert/strict";
import test from "node:test";
import { parsePaymentMirrorIdentity } from "./payment-mirror-pdf.js";

test("extracts CNPJ and driver name from the payment mirror header", () => {
  const identity = parsePaymentMirrorIdentity(`
    RELAÇÃO DE LANÇAMENTOS PARA AGREGADO
    [67.740.491/0001-88] - WELTON GOMES DA SILVA MENDES
    09/07/2026 Crédito 902434 MINUTA 405668243
    Total Geral: 938,20
  `);

  assert.deepEqual(identity, {
    cnpj: "67740491000188",
    name: "WELTON GOMES DA SILVA MENDES"
  });
});

test("returns null when the PDF does not expose a structured identity", () => {
  assert.equal(parsePaymentMirrorIdentity("Documento sem identificação do agregado"), null);
});
