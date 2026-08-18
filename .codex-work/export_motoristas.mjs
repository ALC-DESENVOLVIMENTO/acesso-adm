import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("../node_modules/@prisma/client");

const outputDir = path.resolve("outputs/motoristas-2026-08-17");
const outputPath = path.join(outputDir, "motoristas_banco_2026-08-17.xlsx");
const previewDir = path.resolve(".codex-work/previews");

const columnLabels = {
  id: "ID",
  nome: "Nome",
  cpf: "CPF",
  rg: "RG",
  data_nascimento: "Data de nascimento",
  telefone: "Telefone",
  whatsapp: "WhatsApp",
  email: "E-mail",
  endereco: "Endereço",
  cidade: "Cidade",
  estado: "Estado",
  cep: "CEP",
  status_cadastro: "Status do cadastro",
  empresa_vinculada: "Empresa vinculada",
  observacoes_gerais: "Observações gerais",
  criado_em: "Criado em",
  atualizado_em: "Atualizado em",
};

function excelValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value;
  return value;
}

function columnLetter(index) {
  let n = index + 1;
  let result = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

const prisma = new PrismaClient();
try {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT * FROM "portal_administrativo"."motoristas" ORDER BY "nome" ASC',
  );
  const columns = Object.keys(columnLabels).filter((column) =>
    rows.length === 0 ? true : Object.prototype.hasOwnProperty.call(rows[0], column),
  );

  const workbook = Workbook.create();
  const summary = workbook.worksheets.add("Resumo");
  const sheet = workbook.worksheets.add("Motoristas");
  summary.showGridLines = false;
  sheet.showGridLines = false;

  summary.getRange("A1:B1").merge();
  summary.getRange("A1").values = [["Exportação de motoristas"]];
  summary.getRange("A2:B5").values = [
    ["Origem", "portal_administrativo.motoristas"],
    ["Total de motoristas", rows.length],
    ["Gerado em", new Date()],
    ["Observação", "Exportação dos campos escalares da tabela principal de motoristas."],
  ];
  summary.getRange("A1:B5").format.font = { name: "Aptos", size: 11, color: "#172033" };
  summary.getRange("A1").format.font = { name: "Aptos Display", size: 16, bold: true, color: "#FFFFFF" };
  summary.getRange("A1:B1").format.fill = "#EB0000";
  summary.getRange("A2:A5").format.font = { name: "Aptos", size: 11, bold: true, color: "#172033" };
  summary.getRange("A2:B5").format.borders = { preset: "all", style: "thin", color: "#E5E7EB" };
  summary.getRange("B4").setNumberFormat("dd/mm/yyyy hh:mm");
  summary.getRange("A1:B5").format.wrapText = true;
  summary.getRange("A:A").format.columnWidth = 24;
  summary.getRange("B:B").format.columnWidth = 64;
  summary.freezePanes.freezeRows(1);

  const headers = columns.map((column) => columnLabels[column] ?? column);
  const values = [headers, ...rows.map((row) => columns.map((column) => excelValue(row[column])))];
  const endColumn = columnLetter(columns.length - 1);
  const endRow = values.length;
  const dataRange = `A1:${endColumn}${endRow}`;
  sheet.getRange(dataRange).values = values;
  sheet.getRange(dataRange).format.font = { name: "Aptos", size: 10, color: "#172033" };
  sheet.getRange(`A1:${endColumn}1`).format.fill = "#EB0000";
  sheet.getRange(`A1:${endColumn}1`).format.font = { name: "Aptos", size: 10, bold: true, color: "#FFFFFF" };
  sheet.getRange(dataRange).format.borders = {
    insideHorizontal: { style: "thin", color: "#E5E7EB" },
    bottom: { style: "thin", color: "#D1D5DB" },
  };
  sheet.getRange(dataRange).format.wrapText = false;
  sheet.getRange(dataRange).format.rowHeight = 20;
  sheet.getRange(`A1:${endColumn}${endRow}`).format.autofitColumns();
  const widths = {
    id: 38,
    nome: 36,
    cpf: 18,
    rg: 18,
    data_nascimento: 22,
    telefone: 20,
    whatsapp: 20,
    email: 36,
    endereco: 32,
    cidade: 22,
    estado: 16,
    cep: 16,
    status_cadastro: 20,
    empresa_vinculada: 32,
    observacoes_gerais: 58,
    criado_em: 22,
    atualizado_em: 22,
  };
  for (const column of columns) {
    const index = columns.indexOf(column);
    sheet.getRange(`${columnLetter(index)}1:${columnLetter(index)}${endRow}`).format.columnWidth = widths[column] ?? 18;
  }

  for (const column of ["cpf", "rg", "telefone", "whatsapp", "cep", "id"]) {
    const index = columns.indexOf(column);
    if (index >= 0) sheet.getRange(`${columnLetter(index)}2:${columnLetter(index)}${endRow}`).setNumberFormat("@");
  }
  for (const column of ["data_nascimento", "criado_em", "atualizado_em"]) {
    const index = columns.indexOf(column);
    if (index >= 0) sheet.getRange(`${columnLetter(index)}2:${columnLetter(index)}${endRow}`).setNumberFormat("dd/mm/yyyy hh:mm");
  }
  const table = sheet.tables.add(dataRange, true, "MotoristasTable");
  table.showFilterButton = true;
  sheet.freezePanes.freezeRows(1);
  sheet.freezePanes.freezeColumns(2);

  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(previewDir, { recursive: true });
  const summaryPreview = await workbook.render({ sheetName: "Resumo", autoCrop: "all", scale: 1.5, format: "png" });
  await fs.writeFile(path.join(previewDir, "resumo.png"), new Uint8Array(await summaryPreview.arrayBuffer()));
  const motoristasPreview = await workbook.render({ sheetName: "Motoristas", autoCrop: "all", scale: 0.8, format: "png" });
  await fs.writeFile(path.join(previewDir, "motoristas.png"), new Uint8Array(await motoristasPreview.arrayBuffer()));
  const check = await workbook.inspect({ kind: "table", sheetId: "Motoristas", range: dataRange, include: "values", tableMaxRows: 4, tableMaxCols: 8, maxChars: 5000 });
  console.log(check.ndjson);
  const output = await SpreadsheetFile.exportXlsx(workbook);
  await output.save(outputPath);

  const imported = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
  const verification = await imported.inspect({ kind: "sheet", include: "id,name", maxChars: 3000 });
  console.log(verification.ndjson);
  console.log(JSON.stringify({ outputPath, total: rows.length, columns: columns.length }));
} finally {
  await prisma.$disconnect();
}
