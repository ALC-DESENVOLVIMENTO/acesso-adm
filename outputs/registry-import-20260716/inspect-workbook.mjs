import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "C:/Users/Wesley/Downloads/Dados Motoristas GR.xlsx";
const outputDir = "C:/Users/Wesley/Documents/Dev Alc/Projetos/acesso-adm/outputs/registry-import-20260716";

const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);
const sheetSummary = await workbook.inspect({
  kind: "sheet,table",
  include: "id,name,range",
  maxChars: 12000,
  tableMaxRows: 5,
  tableMaxCols: 30,
});

const sheets = [];
const rawSheets = [];
for (const sheet of workbook.worksheets.items) {
  const used = sheet.getUsedRange(true);
  const values = used?.values || [];
  rawSheets.push({ name: sheet.name, values });
  sheets.push({
    name: sheet.name,
    rowCount: values.length,
    columnCount: values.reduce((max, row) => Math.max(max, row.length), 0),
    headers: values[0] || [],
    sample: values.slice(1, 6),
  });
}

await fs.writeFile(
  `${outputDir}/workbook-audit.json`,
  JSON.stringify({ inspect: sheetSummary.ndjson, sheets }, null, 2),
  "utf8",
);
await fs.writeFile(`${outputDir}/workbook-rows.json`, JSON.stringify(rawSheets), "utf8");

if (sheets[0]) {
  const preview = await workbook.render({
    sheetName: sheets[0].name,
    range: "A1:Z20",
    scale: 1.5,
    format: "png",
  });
  await fs.writeFile(`${outputDir}/workbook-preview.png`, new Uint8Array(await preview.arrayBuffer()));
}

console.log(JSON.stringify(sheets, null, 2));
