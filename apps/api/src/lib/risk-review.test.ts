import assert from "node:assert/strict";
import test from "node:test";
import { classifyRiskReview } from "./risk-review.js";

test("classifies missing, rejected, and in-analysis ARCHI records", () => {
  assert.deepEqual(classifyRiskReview({ matched: false, ambiguous: false }), ["CADASTRO SEM GR"]);
  assert.deepEqual(classifyRiskReview({ matched: false, ambiguous: true }), ["IDENTIFICAÇÃO AMBÍGUA"]);
  assert.deepEqual(classifyRiskReview({ matched: true, ambiguous: false, archiStatus: "Reprovado" }), ["REPROVADO GR", "CNPJ NÃO INFORMADO"]);
  assert.deepEqual(classifyRiskReview({ matched: true, ambiguous: false, archiStatus: "Em análise", officialCnpj: "12345678000190" }), ["EM ANDAMENTO"]);
});

test("reports only actual CNPJ and base divergences", () => {
  assert.deepEqual(classifyRiskReview({
    matched: true,
    ambiguous: false,
    archiStatus: "Aprovado",
    uploadedCnpj: "12.345.678/0001-91",
    officialCnpj: "12345678000190",
    uploadedBase: "Sao Carlos",
    officialBases: ["São Paulo"]
  }), ["CNPJ DIVERGENTE DO ARCHI", "BASE DIVERGENTE"]);
  assert.deepEqual(classifyRiskReview({
    matched: true,
    ambiguous: false,
    uploadedCnpj: "12345678000190",
    officialCnpj: "12.345.678/0001-90",
    uploadedBase: "Sao Carlos",
    officialBases: ["São Carlos"]
  }), []);
});
