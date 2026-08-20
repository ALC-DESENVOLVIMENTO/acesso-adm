import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parsePreFatura } from "./faturamento-parser.js";

test("interpreta todas as categorias da pré-fatura e o número do arquivo", () => {
  const workbook = XLSX.utils.book_new();
  const add = (name: string, rows: unknown[][]) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  add("Detalhes da pré-fatura #123", [["Veículos/Modal", "Sigla Base", "ID da rota", "Motorista", "Quantidade", " Preço unitário ", " TOTAL "], ["VUC", "SSP10", "R1", "João", 2, "1.234,50", "R$ 2.469,00"]]);
  add("10%", [["Descrição", "ID da rota", "Motorista", "Total"], ["Desconto", "R2", "João", "10,00"]]);
  add("PNR´S", [["Descrição", "ID da rota", "Motorista", "Total"], ["PNR", "R3", "Maria", "5,50"]]);
  add("PERDIDOS", [["Descrição", "ID da rota", "Motorista", "Total"], ["Pacote", "R4", "Maria", "1,00"]]);
  add("PNR´S BUGADAS", [["Descrição", "ID da rota", "Motorista", "Total"], ["Bug", "R5", "", "2,00"]]);
  const parsed = parsePreFatura(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }), "pre-fatura #123.xlsx");
  assert.equal(parsed.numero, "123");
  assert.equal(parsed.items.length, 5);
  assert.equal(parsed.items[0].total, 2469);
  assert.equal(parsed.resumo.porCategoria.principal.linhas, 1);
  assert.equal(parsed.resumo.porCategoria["pnrs_bugadas"].linhas, 1);
});

test("rejeita arquivo sem identificação de pré-fatura", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Motorista"], ["João"]]), "Detalhes");
  assert.throws(() => parsePreFatura(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }), "arquivo.xlsx"), /número da pré-fatura/);
});
