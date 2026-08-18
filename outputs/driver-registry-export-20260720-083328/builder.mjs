import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Workbook, SpreadsheetFile } from "@oai/artifact-tool";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = "C:\\Users\\Wesley\\Documents\\Dev Alc\\Projetos\\acesso-adm";
const requireRepo = createRequire(path.join(repoRoot, "package.json"));
const { PrismaClient } = requireRepo("@prisma/client");

const outputFile = path.join(__dirname, "driver_registry_entities_completo_2026-07-20.xlsx");
const previewFile = path.join(__dirname, "preview-driver-registry.png");

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: "postgresql://postgres:CWPWQGdzitlKOiAjRltXlVegQGhNmXQn@reseau.proxy.rlwy.net:36787/railway?schema=portal_administrativo"
    }
  }
});

function normalizeCellValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return value;
}

function toColumnLetter(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function inferDateColumns(rows, columns) {
  return columns
    .map((column, index) => ({
      column,
      index,
      isDate:
        rows.some((row) => row[column] instanceof Date) ||
        /(_em|_at|data|date)$/i.test(column)
    }))
    .filter((item) => item.isDate);
}

try {
  const tableMeta = await prisma.$queryRawUnsafe(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_name = 'driver_registry_entities'
    ORDER BY CASE WHEN table_schema = 'public' THEN 0 ELSE 1 END, table_schema
    LIMIT 1
  `);

  if (!Array.isArray(tableMeta) || tableMeta.length === 0) {
    throw new Error("Tabela driver_registry_entities nao encontrada no banco.");
  }

  const schema = tableMeta[0].table_schema;

  const columnsRaw = await prisma.$queryRawUnsafe(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = '${schema}'
      AND table_name = 'driver_registry_entities'
    ORDER BY ordinal_position
  `);

  const columns = columnsRaw.map((item) => item.column_name);
  const rows = await prisma.$queryRawUnsafe(`
    SELECT *
    FROM "${schema}"."driver_registry_entities"
    ORDER BY id
  `);

  const workbook = Workbook.create();
  const summarySheet = workbook.worksheets.add("Resumo");
  const dataSheet = workbook.worksheets.add("Pre Cadastro");

  summarySheet.getRange("A1:B5").values = [
    ["Exportacao", "Base de pre cadastro"],
    ["Tabela", `${schema}.driver_registry_entities`],
    ["Data da exportacao", new Date()],
    ["Total de registros", rows.length],
    ["Total de colunas", columns.length]
  ];
  summarySheet.getRange("A1:B5").format.font = {
    name: "Aptos",
    size: 11,
    color: "#1F2937"
  };
  summarySheet.getRange("A1:B1").format.font = {
    name: "Aptos",
    bold: true,
    size: 13,
    color: "#FFFFFF"
  };
  summarySheet.getRange("A1:B1").format.fill = { color: "#DC2626" };
  summarySheet.getRange("A1:B5").format.borders = { preset: "all", style: "thin", color: "#E5E7EB" };
  summarySheet.getRange("B3").format.numberFormat = [["dd/mm/yyyy hh:mm:ss"]];
  summarySheet.freezePanes.freezeRows(1);
  summarySheet.getRange("A:B").format.autofitColumns();

  const matrix = [
    columns,
    ...rows.map((row) => columns.map((column) => normalizeCellValue(row[column])))
  ];

  const lastColLetter = toColumnLetter(columns.length - 1);
  const lastRowNumber = matrix.length;
  const dataRange = `A1:${lastColLetter}${lastRowNumber}`;
  dataSheet.getRange(dataRange).values = matrix;

  const headerRange = `A1:${lastColLetter}1`;
  dataSheet.getRange(headerRange).format.fill = { color: "#DC2626" };
  dataSheet.getRange(headerRange).format.font = {
    name: "Aptos",
    bold: true,
    size: 11,
    color: "#FFFFFF"
  };
  dataSheet.getRange(dataRange).format.font = {
    name: "Aptos",
    size: 10,
    color: "#111827"
  };
  dataSheet.getRange(dataRange).format.borders = { preset: "all", style: "thin", color: "#E5E7EB" };
  dataSheet.freezePanes.freezeRows(1);
  dataSheet.getRange(dataRange).format.autofitColumns();

  for (const dateColumn of inferDateColumns(rows, columns)) {
    const letter = toColumnLetter(dateColumn.index);
    dataSheet.getRange(`${letter}2:${letter}${lastRowNumber}`).format.numberFormat = [["dd/mm/yyyy hh:mm:ss"]];
  }

  const previewBlob = await workbook.render({
    sheetName: "Pre Cadastro",
    range: `A1:${toColumnLetter(Math.min(columns.length, 10) - 1)}${Math.min(lastRowNumber, 18)}`,
    scale: 2,
    format: "png"
  });
  await fs.writeFile(previewFile, new Uint8Array(await previewBlob.arrayBuffer()));

  const inspection = await workbook.inspect({
    kind: "table",
    sheetId: "Pre Cadastro",
    range: `A1:${toColumnLetter(Math.min(columns.length, 8) - 1)}${Math.min(lastRowNumber, 10)}`,
    include: "values",
    tableMaxRows: 10,
    tableMaxCols: 8,
    maxChars: 5000
  });

  const formulaErrors = await workbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 50 },
    summary: "driver registry formula error scan",
    maxChars: 2000
  });

  const exported = await SpreadsheetFile.exportXlsx(workbook);
  await exported.save(outputFile);

  await fs.writeFile(
    path.join(__dirname, "verification.json"),
    JSON.stringify(
      {
        schema,
        totalRows: rows.length,
        totalColumns: columns.length,
        inspectedPreview: inspection,
        formulaErrors
      },
      null,
      2
    ),
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        outputFile,
        previewFile,
        totalRows: rows.length,
        totalColumns: columns.length,
        schema
      },
      null,
      2
    )
  );
} finally {
  await prisma.$disconnect();
}
