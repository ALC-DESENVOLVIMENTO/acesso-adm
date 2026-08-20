import * as XLSX from "xlsx";

export type FaturamentoTipo = "lastmile" | "linehaul" | "melione";
export type FaturamentoCategoria = "principal" | "10pct" | "pnrs" | "perdidos" | "pnrs_bugadas";

export type FaturamentoItem = {
  aba: string;
  linhaExcel: number;
  categoria: FaturamentoCategoria;
  descricao: string | null;
  veiculoModal: string | null;
  svcContinuacao: string | null;
  svc: string | null;
  siglaBase: string | null;
  nomeBase: string | null;
  kmRange: string | null;
  kmRanger: string | null;
  idRota: string | null;
  dataInicio: string | null;
  dataFim: string | null;
  placa: string | null;
  motorista: string | null;
  quantidade: number | null;
  precoUnitario: number | null;
  total: number | null;
  tipoFrota: string | null;
  raw: Record<string, unknown>;
};

export type ParsedPreFatura = {
  numero: string;
  nomeAbaPrincipal: string;
  items: FaturamentoItem[];
  resumo: { porCategoria: Record<string, { linhas: number; total: number }>; porBase: Record<string, { linhas: number; total: number }> };
};

export type FaturamentoReferences = { bases: Record<string, string>; fleets: Record<string, string> };

export function parseFaturamentoReferences(baseBuffer?: Buffer, vehicleBuffer?: Buffer): FaturamentoReferences {
  const references: FaturamentoReferences = { bases: {}, fleets: {} };
  const read = (buffer: Buffer | undefined) => buffer ? XLSX.read(buffer, { type: "buffer", raw: false }) : null;
  const baseWorkbook = read(baseBuffer);
  const baseSheet = baseWorkbook?.Sheets[baseWorkbook.SheetNames.find((name) => key(name).includes("resp")) || baseWorkbook.SheetNames[0] || ""];
  if (baseSheet) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(baseSheet, { header: 1, defval: null, blankrows: false, raw: false });
    for (const row of rows.slice(1)) { const base = text(row[0]); const sigla = text(row[1]); if (base && sigla) references.bases[key(sigla).replace(/ /g, "")] = base; }
  }
  const vehicleWorkbook = read(vehicleBuffer);
  const vehicleSheet = vehicleWorkbook?.Sheets[vehicleWorkbook.SheetNames[0] || ""];
  if (vehicleSheet) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(vehicleSheet, { header: 1, defval: null, blankrows: false, raw: false });
    for (const row of rows.slice(1)) { const classification = text(row[0]); const fleet = text(row[1]); if (classification && fleet) references.fleets[key(classification)] = fleet; }
  }
  return references;
}

function text(value: unknown) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function repairEncoding(value: unknown) {
  let current = text(value);
  for (let attempt = 0; attempt < 2 && /[ÃÂ]/.test(current); attempt += 1) {
    const repaired = Buffer.from(current, "latin1").toString("utf8");
    if (!repaired || repaired.includes("�") || repaired === current) break;
    current = repaired;
  }
  return current;
}

function key(value: unknown) {
  return repairEncoding(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}

function referenceKey(value: unknown) {
  return key(value).replace(/ /g, "");
}

function resolveFleet(fleets: Record<string, string>, ...values: unknown[]) {
  for (const value of values) {
    const resolved = fleets[referenceKey(value)] || fleets[key(value)];
    if (resolved) return repairEncoding(resolved);
  }
  return null;
}

function findIndex(headers: string[], ...aliases: string[]) {
  return headers.findIndex((header) => aliases.some((alias) => header === alias || header.includes(alias)));
}

function parseNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = text(value).replace(/R\$\s*/gi, "").replace(/\s/g, "").replace(/[^0-9,.-]/g, "");
  if (!raw) return null;
  const comma = raw.lastIndexOf(",");
  const dot = raw.lastIndexOf(".");
  let normalized = raw;
  if (comma >= 0 && dot >= 0) {
    const decimalIndex = Math.max(comma, dot);
    normalized = `${raw.slice(0, decimalIndex).replace(/[.,]/g, "")}.${raw.slice(decimalIndex + 1).replace(/[.,]/g, "")}`;
  } else if (comma >= 0) {
    normalized = `${raw.slice(0, comma).replace(/\./g, "")}.${raw.slice(comma + 1).replace(/\./g, "")}`;
  } else if ((raw.match(/\./g) || []).length > 1) {
    const parts = raw.split(".");
    const decimal = parts.pop() || "";
    normalized = decimal.length <= 2 ? `${parts.join("")}.${decimal}` : parts.join("") + decimal;
  } else if (dot >= 0 && raw.length - dot - 1 === 3) {
    normalized = raw.replace(".", "");
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function sheetCategory(name: string, main: boolean): FaturamentoCategoria {
  if (main) return "principal";
  const normalized = key(name);
  if (normalized.startsWith("10")) return "10pct";
  if (normalized.includes("bugada")) return "pnrs_bugadas";
  if (normalized.includes("perdido")) return "perdidos";
  return "pnrs";
}

function findNumber(value: string) {
  return value.match(/[＃#]\s*(\d+)/)?.[1] || null;
}

function getValue(row: unknown[], index: number) {
  return index >= 0 ? row[index] : null;
}

export function parsePreFatura(buffer: Buffer, originalName: string, references: FaturamentoReferences = { bases: {}, fleets: {} }): ParsedPreFatura {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true, raw: false });
  const mainSheet = workbook.SheetNames.find((name) => key(name).includes("detalhes")) || workbook.SheetNames[0];
  const preInvoiceNumber = findNumber(originalName) || findNumber(mainSheet || "");
  if (!preInvoiceNumber) throw new Error("Não foi possível identificar o número da pré-fatura. Use o padrão #número no arquivo ou na aba principal.");

  const items: FaturamentoItem[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, blankrows: false, raw: false });
    if (!matrix.length) continue;
    const headers = (matrix[0] || []).map(key);
    const main = sheetName === mainSheet;
    const category = sheetCategory(sheetName, main);
    const indexes = {
      descricao: findIndex(headers, "descricao"), vehicle: findIndex(headers, "veiculos modal", "veiculos", "modal"),
      svcCont: findIndex(headers, "svc continuacao"), svc: headers.findIndex((header) => header === "svc"), sigla: findIndex(headers, "sigla base"),
      kmRange: findIndex(headers, "kms range ciclo rota", "kms range"), kmRanger: findIndex(headers, "kmranger"), route: findIndex(headers, "id da rota"),
      start: findIndex(headers, "data de inicio", "data inicio"), end: findIndex(headers, "data de termino", "data termino"), plate: findIndex(headers, "placa"),
      driver: findIndex(headers, "motorista"), quantity: findIndex(headers, "quantidade"), unit: findIndex(headers, "preco unitario"),
      total: headers.findIndex((header) => header === "total")
    };
    for (let rowIndex = 1; rowIndex < matrix.length; rowIndex += 1) {
      const row = matrix[rowIndex] || [];
      if (!row.some((value) => text(value))) continue;
      const raw: Record<string, unknown> = {};
      headers.forEach((header, index) => { if (header) raw[header] = row[index]; });
      const veiculoModal = repairEncoding(getValue(row, indexes.vehicle)) || null;
      const kmRange = repairEncoding(getValue(row, indexes.kmRange)) || null;
      const kmRanger = repairEncoding(getValue(row, indexes.kmRanger)) || null;
      const svc = repairEncoding(getValue(row, indexes.svc)) || null;
      const item: FaturamentoItem = {
        aba: sheetName, linhaExcel: rowIndex + 1, categoria: category,
        descricao: repairEncoding(getValue(row, indexes.descricao)) || null, veiculoModal,
        svcContinuacao: repairEncoding(getValue(row, indexes.svcCont)) || null, svc,
        siglaBase: repairEncoding(getValue(row, indexes.sigla)) || null, nomeBase: references.bases[referenceKey(getValue(row, indexes.sigla))] || repairEncoding(getValue(row, indexes.sigla)) || null,
        kmRange, kmRanger,
        idRota: repairEncoding(getValue(row, indexes.route)) || null, dataInicio: repairEncoding(getValue(row, indexes.start)) || null,
        dataFim: repairEncoding(getValue(row, indexes.end)) || null, placa: repairEncoding(getValue(row, indexes.plate)) || null,
        motorista: repairEncoding(getValue(row, indexes.driver)) || null, quantidade: parseNumber(getValue(row, indexes.quantity)),
        precoUnitario: parseNumber(getValue(row, indexes.unit)), total: parseNumber(getValue(row, indexes.total)), tipoFrota: resolveFleet(references.fleets, veiculoModal, kmRange, kmRanger, svc) || null, raw
      };
      items.push(item);
    }
  }
  const porCategoria: ParsedPreFatura["resumo"]["porCategoria"] = {};
  const porBase: ParsedPreFatura["resumo"]["porBase"] = {};
  for (const item of items) {
    const category = porCategoria[item.categoria] ||= { linhas: 0, total: 0 }; category.linhas += 1; category.total += item.total || 0;
    const base = item.siglaBase || "Sem base"; const baseSummary = porBase[base] ||= { linhas: 0, total: 0 }; baseSummary.linhas += 1; baseSummary.total += item.total || 0;
  }
  return { numero: preInvoiceNumber, nomeAbaPrincipal: mainSheet, items, resumo: { porCategoria, porBase } };
}
