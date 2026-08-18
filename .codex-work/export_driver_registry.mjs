import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const require = createRequire(import.meta.url);
const { PrismaClient } = require("../node_modules/@prisma/client");

const outputDir = path.resolve("outputs/driver-registry-2026-08-17");
const outputPath = path.join(outputDir, "driver_registry_entities_2026-08-17.xlsx");
const previewDir = path.resolve(".codex-work/previews-driver-registry");

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
  const rows = await prisma.$queryRawUnsafe(`
    SELECT *
    FROM public."driver_registry_entities"
    ORDER BY lower(COALESCE("display_name", "normalized_name", '')) ASC, id ASC
  `);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const textColumns = new Set([
    "id", "cnpj", "cnpj_digits", "cpf", "cpf_digits", "phone", "rg", "placa",
    "cpf_favorecido", "cpf_favorecido_digits", "telefone_favorecido",
  ]);
  const workbook = Workbook.create();
  const summary = workbook.worksheets.add("Resumo");
  const sheet = workbook.worksheets.add("Pré-cadastros");
  summary.showGridLines = false;
  sheet.showGridLines = false;

  summary.getRange("A1:B1").merge();
  summary.getRange("A1").values = [["Exportação de pré-cadastros"]];
  summary.getRange("A2:B6").values = [
    ["Origem", "public.driver_registry_entities"],
    ["Total de registros", rows.length],
    ["Total de campos", columns.length],
    ["Gerado em", new Date()],
    ["Observação", "Todos os campos escalares disponíveis na tabela foram exportados."],
  ];
  summary.getRange("A1:B6").format.font = { name: "Aptos", size: 11, color: "#172033" };
  summary.getRange("A1").format.font = { name: "Aptos Display", size: 16, bold: true, color: "#FFFFFF" };
  summary.getRange("A1:B1").format.fill = "#EB0000";
  summary.getRange("A2:A6").format.font = { name: "Aptos", size: 11, bold: true, color: "#172033" };
  summary.getRange("A2:B6").format.borders = { preset: "all", style: "thin", color: "#E5E7EB" };
  summary.getRange("B5").setNumberFormat("dd/mm/yyyy hh:mm");
  summary.getRange("A1:B6").format.wrapText = true;
  summary.getRange("A1:A6").format.columnWidth = 24;
  summary.getRange("B1:B6").format.columnWidth = 64;
  summary.freezePanes.freezeRows(1);

  const values = [columns, ...rows.map((row) => columns.map((column) => excelValue(row[column])))];
  const endColumn = columns.length ? columnLetter(columns.length - 1) : "A";
  const endRow = Math.max(values.length, 1);
  const dataRange = `A1:${endColumn}${endRow}`;
  for (const column of textColumns) {
    const index = columns.indexOf(column);
    if (index >= 0 && endRow > 1) sheet.getRange(`${columnLetter(index)}2:${columnLetter(index)}${endRow}`).setNumberFormat("@");
  }
  if (columns.length > 0) sheet.getRange(dataRange).values = values;
  sheet.getRange(dataRange).format.font = { name: "Aptos", size: 9, color: "#172033" };
  sheet.getRange(`A1:${endColumn}1`).format.fill = "#EB0000";
  sheet.getRange(`A1:${endColumn}1`).format.font = { name: "Aptos", size: 9, bold: true, color: "#FFFFFF" };
  sheet.getRange(dataRange).format.borders = {
    insideHorizontal: { style: "thin", color: "#E5E7EB" },
    bottom: { style: "thin", color: "#D1D5DB" },
  };
  sheet.getRange(dataRange).format.rowHeight = 18;
  sheet.getRange(`A1:${endColumn}${endRow}`).format.autofitColumns();

  const widths = {
    id: 38,
    display_name: 34,
    normalized_name: 34,
    cnpj: 20,
    cnpj_digits: 20,
    cpf: 18,
    cpf_digits: 18,
    email: 34,
    phone: 20,
    driver_type: 18,
    signup_policy: 20,
    active: 12,
    source_count: 14,
    created_at: 22,
    updated_at: 22,
    base: 28,
    data_nascimento: 18,
    rg: 18,
    sexo: 12,
    placa: 16,
    nome_favorecido: 34,
    cpf_favorecido: 20,
    cpf_favorecido_digits: 20,
    email_favorecido: 34,
    telefone_favorecido: 22,
    validade_gr: 18,
  };
  for (const column of columns) {
    const index = columns.indexOf(column);
    sheet.getRange(`${columnLetter(index)}1:${columnLetter(index)}${endRow}`).format.columnWidth = widths[column] ?? 18;
  }

  for (const column of textColumns) {
    const index = columns.indexOf(column);
    if (index >= 0 && endRow > 1) sheet.getRange(`${columnLetter(index)}2:${columnLetter(index)}${endRow}`).setNumberFormat("@");
  }
  for (const column of ["created_at", "updated_at"]) {
    const index = columns.indexOf(column);
    if (index >= 0 && endRow > 1) sheet.getRange(`${columnLetter(index)}2:${columnLetter(index)}${endRow}`).setNumberFormat("dd/mm/yyyy hh:mm");
  }
  for (const column of ["data_nascimento", "validade_gr"]) {
    const index = columns.indexOf(column);
    if (index >= 0 && endRow > 1) sheet.getRange(`${columnLetter(index)}2:${columnLetter(index)}${endRow}`).setNumberFormat("dd/mm/yyyy");
  }
  if (columns.length > 0) {
    const table = sheet.tables.add(dataRange, true, "DriverRegistryEntitiesTable");
    table.showFilterButton = true;
  }
  for (const column of textColumns) {
    const index = columns.indexOf(column);
    if (index < 0 || endRow <= 1) continue;
    const formulas = rows.map((row) => {
      const value = excelValue(row[column]);
      if (value === "" || value === null || value === undefined) return [""];
      return [`="${String(value).replaceAll('"', '""')}"`];
    });
    sheet.getRange(`${columnLetter(index)}2:${columnLetter(index)}${endRow}`).formulas = formulas;
  }
  sheet.freezePanes.freezeRows(1);
  sheet.freezePanes.freezeColumns(2);

  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(previewDir, { recursive: true });
  const summaryPreview = await workbook.render({ sheetName: "Resumo", autoCrop: "all", scale: 1.5, format: "png" });
  await fs.writeFile(path.join(previewDir, "resumo.png"), new Uint8Array(await summaryPreview.arrayBuffer()));
  const registryPreview = await workbook.render({ sheetName: "Pré-cadastros", range: "A1:Z22", scale: 0.9, format: "png" });
  await fs.writeFile(path.join(previewDir, "pre-cadastros.png"), new Uint8Array(await registryPreview.arrayBuffer()));
  const check = await workbook.inspect({ kind: "table", sheetId: "Pré-cadastros", range: dataRange, include: "values", tableMaxRows: 4, tableMaxCols: 10, maxChars: 6000 });
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
