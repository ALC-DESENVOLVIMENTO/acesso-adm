import crypto from "node:crypto";
import * as XLSX from "xlsx";
import { FinanceiroImportacaoItemResultado, FinanceiroImportacaoStatus, FinanceiroStatusPagamento, Prisma, UploadStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { fetchObjectBuffer } from "../../lib/storage.js";

const SUPPORTED_SHEETS = ["Resumido"];

const BLOCK_CODES = new Set(["BLOQOXPAY", "BLOQ", "BOLQOXPAY"]);
type ImportContext = {
  userId: string;
  fileName: string;
  fileBuffer: Buffer;
  periodId: string;
  baseId: string | null;
};

type ExcelCellValue = string | number | boolean | Date | null;

type CandidateUpload = Prisma.UploadPdfGetPayload<{
  include: {
    motorista: true;
    periodoPagamento: true;
    basePagamento: true;
    usuario: {
      select: {
        nome: true;
      };
    };
  };
}>;

export type FinanceiroImportPreviewRow = {
  numeroLinha: number;
  identificador: string | null;
  motorista: string | null;
  cpfCnpj: string | null;
  periodo: string | null;
  valor: string | null;
  codigoObb: string | null;
  statusPlanilha: string | null;
  statusAtual: FinanceiroStatusPagamento | null;
  novoStatus: FinanceiroStatusPagamento | null;
  regraAplicada: string;
  situacaoValidacao: FinanceiroImportacaoItemResultado;
  mensagem: string | null;
  pagamentoId: string | null;
  motoristaId: string | null;
  baseId: string | null;
  periodoId: string | null;
  statusAnterior?: FinanceiroStatusPagamento | null;
};

type WorkbookRow = {
  numeroLinha: number;
  cells: string[];
  rowValues: Record<string, string>;
  statusPlanilha: string | null;
  hasData: boolean;
};

function sha256(buffer: Buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeText(value: string | null | undefined) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
}

function normalizeCompact(value: string | null | undefined) {
  return normalizeText(value).replace(/[^A-Z0-9]+/g, "");
}

function normalizeHeader(header: string) {
  switch (normalizeCompact(header)) {
    case "MOTORISTA":
      return "Motorista";
    case "FAVORECIDO":
      return "Favorecido";
    case "CPFDOFAVORECIDO":
      return "CPF do Favorecido";
    case "TOTAL":
      return "Total";
    case "CODOBB":
      return "CodOBB";
    case "TIPODECONTA":
      return "Tipo de Conta";
    case "PROJETO":
      return "Projeto";
    case "EVIDENCIAS":
      return "Evidencias";
    case "DEPARTMENTOFUNCAO":
      return "Departamento/Função";
    default:
      return header.trim();
  }
}

function normalizeDigits(value: string | null | undefined) {
  return String(value || "").replace(/\D/g, "");
}

function toStringValue(value: ExcelCellValue) {
  if (value === null || value === undefined) {
    return "";
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value).trim();
}

function readCellValue(cell: XLSX.CellObject | undefined) {
  if (!cell) {
    return "";
  }

  if (cell.w !== undefined && cell.w !== null) {
    return String(cell.w).trim();
  }

  if (cell.v instanceof Date) {
    return cell.v.toISOString();
  }

  return toStringValue(cell.v as ExcelCellValue);
}

function normalizePlanilhaStatus(raw: unknown) {
  const value = normalizeCompact(String(raw || ""));

  if (!value) {
    return null;
  }

  if (value === "PAGO") {
    return "PAGO";
  }

  if (value === "PENDENTE") {
    return "PENDENTE";
  }

  if (value === "BLOQUEADO") {
    return "BLOQUEADO";
  }

  if (value === "NOTAFISCALPENDENTE") {
    return "NOTA_FISCAL_PENDENTE";
  }

  return null;
}

function resolveStatusFromPlanilha(statusPlanilha: string | null) {
  if (!statusPlanilha) {
    return null;
  }

  if (statusPlanilha === "PAGO") {
    return FinanceiroStatusPagamento.PAGO;
  }

  if (statusPlanilha === "PENDENTE" || statusPlanilha === "NOTA_FISCAL_PENDENTE") {
    return FinanceiroStatusPagamento.PENDENTE;
  }

  if (statusPlanilha === "BLOQUEADO") {
    return FinanceiroStatusPagamento.BLOQUEADO;
  }

  return null;
}

function parseWorkbookRows(buffer: Buffer) {
  const workbook = XLSX.read(buffer, {
    type: "buffer",
    cellStyles: true,
    cellDates: true
  });
  const sheetName = workbook.SheetNames.find((item) => SUPPORTED_SHEETS.includes(item));

  if (!sheetName) {
    throw new Error('A planilha nao possui a aba obrigatoria "Resumido".');
  }

  const sheet = workbook.Sheets[sheetName];
  if (!sheet || !sheet["!ref"]) {
    return { sheetName, rows: [] as WorkbookRow[] };
  }

  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const rows: WorkbookRow[] = [];

  for (let rowNumber = Math.max(2, range.s.r + 1); rowNumber <= range.e.r + 1; rowNumber += 1) {
    const values: string[] = [];
    const rowValues: Record<string, string> = {};

    for (let column = range.s.c + 1; column <= range.e.c + 1; column += 1) {
      const cellAddress = XLSX.utils.encode_cell({ r: rowNumber - 1, c: column - 1 });
      const cell = sheet[cellAddress];
      const headerAddress = XLSX.utils.encode_cell({ r: 0, c: column - 1 });
      const header = normalizeHeader(readCellValue(sheet[headerAddress]).trim());
      const value = readCellValue(cell);

      values.push(value);

      if (header) {
        rowValues[header] = value;
      }
    }

    const statusCellAddress = XLSX.utils.encode_cell({ r: rowNumber - 1, c: 12 });
    const statusPlanilha = normalizePlanilhaStatus(readCellValue(sheet[statusCellAddress]));
    rowValues["Status da planilha"] = readCellValue(sheet[statusCellAddress]);
    const hasData = values.some((value) => Boolean(String(value || "").trim()));

    rows.push({
      numeroLinha: rowNumber,
      cells: values,
      rowValues,
      statusPlanilha,
      hasData
    });
  }

  return { sheetName, rows };
}

function normalizeObbCode(value: string | null | undefined) {
  return normalizeCompact(value);
}

function resolveStatusByObb(value: string | null | undefined) {
  const normalized = normalizeObbCode(value);

  if (!normalized) {
    return null;
  }

  if (BLOCK_CODES.has(normalized)) {
    return FinanceiroStatusPagamento.BLOQUEADO;
  }

  return null;
}

function formatCurrency(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = typeof value === "number" ? value : Number(String(value).replace(/\./g, "").replace(",", "."));

  if (!Number.isFinite(normalized)) {
    return String(value).trim();
  }

  return normalized.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseMoneyNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const normalized = String(value)
    .replace(/[^\d,.-]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function moneyMatches(left: string | number | null | undefined, right: string | number | null | undefined) {
  const leftValue = parseMoneyNumber(left);
  const rightValue = parseMoneyNumber(right);

  if (leftValue === null || rightValue === null) {
    return false;
  }

  return Math.abs(leftValue - rightValue) < 0.01;
}

async function extractPaymentTotalValue(storageKey: string | null | undefined) {
  if (!storageKey) {
    return null;
  }

  const remoteObject = await fetchObjectBuffer(storageKey).catch(() => null);

  if (!remoteObject?.body) {
    return null;
  }

  try {
    const pdfParseModule = await import("pdf-parse");
    const pdfParse =
      (pdfParseModule as unknown as { default?: (buffer: Buffer) => Promise<{ text: string }> }).default ??
      (pdfParseModule as unknown as (buffer: Buffer) => Promise<{ text: string }>);
    const parsed = await pdfParse(Buffer.from(remoteObject.body));
    const text = String(parsed.text || "");
    const normalizedText = text.replace(/\s+/g, " ");
    const match =
      /Total Geral\s*[:\-]?\s*R?\$?\s*([\d.]+,\d{2})/i.exec(normalizedText) ||
      /Total\s*[:\-]?\s*R?\$?\s*([\d.]+,\d{2})/i.exec(normalizedText);

    return match?.[1] ? parseMoneyNumber(match[1]) : null;
  } catch {
    return null;
  }
}

async function loadPaymentCandidates(periodId: string, baseId: string | null) {
  return prisma.uploadPdf.findMany({
    where: {
      periodoPagamentoId: periodId,
      status: {
        not: "removido"
      },
      ...(baseId
        ? {
            basePagamentoId: baseId
          }
        : {})
    },
    include: {
      motorista: true,
      periodoPagamento: true,
      basePagamento: true,
      usuario: {
        select: {
          nome: true
        }
      }
    },
    orderBy: {
      criadoEm: "desc"
    }
  });
}

function dedupeLatestCandidates(candidates: CandidateUpload[]) {
  const latestByMotorista = new Map<string, CandidateUpload>();

  for (const candidate of candidates) {
    if (!candidate.motoristaId) {
      continue;
    }

    const key = `${candidate.motoristaId}|${candidate.periodoPagamentoId}|${candidate.basePagamentoId}`;

    if (!latestByMotorista.has(key)) {
      latestByMotorista.set(key, candidate);
    }
  }

  return Array.from(latestByMotorista.values());
}

async function resolveCandidateMatch(row: WorkbookRow, candidates: CandidateUpload[]) {
  const motorista = row.rowValues["Motorista"] || row.rowValues["Favorecido"] || "";
  const cpf = row.rowValues["CPF do Favorecido"] || "";
  const cpfDigits = normalizeDigits(cpf);
  const normalizedName = normalizeCompact(motorista);
  const rowAmount = parseMoneyNumber(row.rowValues["Total"]);
  const uniqueCandidates = dedupeLatestCandidates(candidates);

  const byCpf = cpfDigits
    ? uniqueCandidates.filter((candidate) => normalizeDigits(candidate.motorista?.cpf || "") === cpfDigits)
    : [];

  if (byCpf.length === 1) {
    return { match: byCpf[0], reason: "CPF ou CNPJ + período" };
  }

  if (byCpf.length > 1) {
    if (rowAmount !== null) {
      const byCpfAndValue = await Promise.all(
        byCpf.map(async (candidate) => ({
          candidate,
          valorTotal: await extractPaymentTotalValue(candidate.caminhoArquivo)
        }))
      );
      const filteredByValue = byCpfAndValue.filter((item) => moneyMatches(item.valorTotal, rowAmount)).map((item) => item.candidate);

      if (filteredByValue.length === 1) {
        return { match: filteredByValue[0], reason: "CPF ou CNPJ + período + valor" };
      }

      if (filteredByValue.length > 1) {
        return { ambiguous: true, matches: filteredByValue, reason: "CPF ou CNPJ + período + valor" };
      }
    }

    return { ambiguous: true, matches: byCpf, reason: "CPF ou CNPJ + período" };
  }

  const byName = normalizedName
    ? uniqueCandidates.filter((candidate) => normalizeCompact(candidate.motorista?.nome || "") === normalizedName)
    : [];

  if (byName.length === 1) {
    return { match: byName[0], reason: rowAmount !== null ? "Motorista + período + valor" : "Motorista + período" };
  }

  if (byName.length > 1) {
    if (rowAmount !== null) {
      const byNameAndValue = await Promise.all(
        byName.map(async (candidate) => ({
          candidate,
          valorTotal: await extractPaymentTotalValue(candidate.caminhoArquivo)
        }))
      );
      const filteredByValue = byNameAndValue.filter((item) => moneyMatches(item.valorTotal, rowAmount)).map((item) => item.candidate);

      if (filteredByValue.length === 1) {
        return { match: filteredByValue[0], reason: "Motorista + período + valor" };
      }

      if (filteredByValue.length > 1) {
        return { ambiguous: true, matches: filteredByValue, reason: "Motorista + período + valor" };
      }
    }

    return { ambiguous: true, matches: byName, reason: rowAmount !== null ? "Motorista + período + valor" : "Motorista + período" };
  }

  return { match: null, reason: "Nenhuma correspondencia segura" };
}

function isDangerousRegression(current: FinanceiroStatusPagamento | null, next: FinanceiroStatusPagamento | null) {
  if (!current || !next) {
    return false;
  }

  if (current === next) {
    return false;
  }

  if (current === FinanceiroStatusPagamento.PAGO && next !== FinanceiroStatusPagamento.PAGO) {
    return true;
  }

  return false;
}

function determineValidation(row: WorkbookRow) {
  const rawStatus = row.statusPlanilha;

  if (!row.hasData) {
    return {
      resultado: FinanceiroImportacaoItemResultado.linha_vazia,
      regraAplicada: "Linha vazia",
      statusNovo: null,
      mensagem: "Linha sem preenchimento."
    } as const;
  }

  if (!row.rowValues["Motorista"] && !row.rowValues["Favorecido"] && !row.rowValues["CPF do Favorecido"]) {
    return {
      resultado: FinanceiroImportacaoItemResultado.sem_identificador,
      regraAplicada: "Sem identificador",
      statusNovo: null,
      mensagem: "Linha sem motorista ou CPF/CNPJ."
    } as const;
  }

  if (!rawStatus) {
    return {
      resultado: FinanceiroImportacaoItemResultado.cor_nao_reconhecida,
      regraAplicada: "Status nao informado",
      statusNovo: null,
      mensagem: "Não foi possível identificar o status na coluna M."
    } as const;
  }

  const statusFromPlanilha = resolveStatusFromPlanilha(rawStatus);

  if (!statusFromPlanilha) {
    return {
      resultado: FinanceiroImportacaoItemResultado.cor_nao_reconhecida,
      regraAplicada: "Status nao reconhecido",
      statusNovo: null,
      mensagem: "Não foi possível reconhecer o status da coluna M."
    } as const;
  }

  return {
    resultado: FinanceiroImportacaoItemResultado.valido,
    regraAplicada: `Status da planilha = ${rawStatus}`,
    statusNovo: statusFromPlanilha,
    mensagem: null
  } as const;
}

function buildAmbiguousMessage(matches: CandidateUpload[], rowAmount: string | number | null | undefined, reason: string) {
  const sample = matches.slice(0, 3).map((candidate) => {
    const motorista = candidate.motorista?.nome || "Não informado";
    const cpf = candidate.motorista?.cpf || "Não informado";
    return `${motorista} (${cpf}) #${candidate.id.slice(0, 8)}`;
  });

  const amountLabel = rowAmount === null || rowAmount === undefined || rowAmount === ""
    ? ""
    : ` Valor da linha: ${formatCurrency(rowAmount)}.`;

  return `Mais de um pagamento correspondente foi encontrado (${matches.length} candidatos). ${reason}.${amountLabel} Candidatos: ${sample.join(", ")}${matches.length > sample.length ? "..." : ""}`;
}

function pickCurrentStatus(upload: Awaited<ReturnType<typeof loadPaymentCandidates>>[number]) {
  return upload.statusPagamento || FinanceiroStatusPagamento.PENDENTE;
}

export async function createFinanceiroImportPreview(context: ImportContext) {
  const fileHash = sha256(context.fileBuffer);

  const { sheetName, rows } = parseWorkbookRows(context.fileBuffer);
  const candidates = await loadPaymentCandidates(context.periodId, context.baseId);
  const period = await prisma.periodoPagamento.findUnique({
    where: { id: context.periodId },
    select: {
      nome: true
    }
  });
  const base = context.baseId
    ? await prisma.basePagamento.findUnique({
        where: { id: context.baseId },
        select: { nome: true }
      })
    : null;

  const previewRows: FinanceiroImportPreviewRow[] = [];
  const seenPaymentIds = new Set<string>();

  for (const row of rows) {
    if (!row.hasData) {
      continue;
    }

    const validation = determineValidation(row);
    const matchResult = await resolveCandidateMatch(row, candidates);
    const current = matchResult.match ? pickCurrentStatus(matchResult.match) : null;
    const candidateStatus = validation.statusNovo;
    const finalStatus = candidateStatus ?? null;
    const dangerous = isDangerousRegression(current, finalStatus);
    const sameStatus = Boolean(current && finalStatus && current === finalStatus);

    if (matchResult.ambiguous) {
      previewRows.push({
        numeroLinha: row.numeroLinha,
        identificador: row.rowValues["Motorista"] || row.rowValues["Favorecido"] || null,
        motorista: row.rowValues["Motorista"] || row.rowValues["Favorecido"] || null,
        cpfCnpj: row.rowValues["CPF do Favorecido"] || null,
        periodo: period?.nome || null,
        valor: formatCurrency(row.rowValues["Total"]),
        codigoObb: row.rowValues["CodOBB"] || null,
        statusPlanilha: row.statusPlanilha,
        statusAtual: current,
        novoStatus: null,
        regraAplicada: matchResult.reason,
        situacaoValidacao: FinanceiroImportacaoItemResultado.correspondencia_ambiguo,
        mensagem: buildAmbiguousMessage(matchResult.matches || [], row.rowValues["Total"], matchResult.reason),
        pagamentoId: null,
        motoristaId: null,
        baseId: context.baseId,
        periodoId: context.periodId,
        statusAnterior: current
      });
      continue;
    }

    if (!matchResult.match) {
      previewRows.push({
        numeroLinha: row.numeroLinha,
        identificador: row.rowValues["Motorista"] || row.rowValues["Favorecido"] || null,
        motorista: row.rowValues["Motorista"] || row.rowValues["Favorecido"] || null,
        cpfCnpj: row.rowValues["CPF do Favorecido"] || null,
        periodo: period?.nome || null,
        valor: formatCurrency(row.rowValues["Total"]),
        codigoObb: row.rowValues["CodOBB"] || null,
        statusPlanilha: row.statusPlanilha,
        statusAtual: null,
        novoStatus: null,
        regraAplicada: matchResult.reason,
        situacaoValidacao: row.hasData
          ? FinanceiroImportacaoItemResultado.pagamento_nao_encontrado
          : FinanceiroImportacaoItemResultado.linha_vazia,
        mensagem: row.hasData ? "Pagamento não encontrado no período selecionado." : "Linha vazia.",
        pagamentoId: null,
        motoristaId: null,
        baseId: context.baseId,
        periodoId: context.periodId,
        statusAnterior: null
      });
      continue;
    }

    if (seenPaymentIds.has(matchResult.match.id)) {
      previewRows.push({
        numeroLinha: row.numeroLinha,
        identificador: row.rowValues["Motorista"] || row.rowValues["Favorecido"] || null,
        motorista: matchResult.match.motorista?.nome || row.rowValues["Motorista"] || row.rowValues["Favorecido"] || null,
        cpfCnpj: matchResult.match.motorista?.cpf || row.rowValues["CPF do Favorecido"] || null,
        periodo: period?.nome || matchResult.match.periodoPagamento?.nome || null,
        valor: formatCurrency(row.rowValues["Total"]),
        codigoObb: row.rowValues["CodOBB"] || null,
        statusPlanilha: row.statusPlanilha,
        statusAtual: current,
        novoStatus: null,
        regraAplicada: "Pagamento duplicado na planilha",
        situacaoValidacao: FinanceiroImportacaoItemResultado.linha_duplicada,
        mensagem: "Este pagamento ja aparece em outra linha desta mesma planilha.",
        pagamentoId: matchResult.match.id,
        motoristaId: matchResult.match.motoristaId,
        baseId: matchResult.match.basePagamentoId,
        periodoId: matchResult.match.periodoPagamentoId,
        statusAnterior: current
      });
      continue;
    }

    seenPaymentIds.add(matchResult.match.id);

    previewRows.push({
      numeroLinha: row.numeroLinha,
      identificador: row.rowValues["Motorista"] || row.rowValues["Favorecido"] || null,
      motorista: matchResult.match.motorista?.nome || row.rowValues["Motorista"] || row.rowValues["Favorecido"] || null,
      cpfCnpj: matchResult.match.motorista?.cpf || row.rowValues["CPF do Favorecido"] || null,
      periodo: period?.nome || matchResult.match.periodoPagamento?.nome || null,
      valor: formatCurrency(row.rowValues["Total"]),
      codigoObb: row.rowValues["CodOBB"] || null,
      statusPlanilha: row.statusPlanilha,
      statusAtual: current,
      novoStatus: dangerous ? null : finalStatus,
      regraAplicada: validation.regraAplicada || matchResult.reason,
      situacaoValidacao: dangerous
        ? FinanceiroImportacaoItemResultado.conflito_status
        : sameStatus
          ? FinanceiroImportacaoItemResultado.ja_atualizada
          : validation.resultado,
      mensagem:
        dangerous
          ? "Transicao perigosa detectada. A confirmacao exige revisao manual."
          : sameStatus
            ? "Linha ja possui o mesmo status."
            : validation.mensagem,
      pagamentoId: matchResult.match.id,
      motoristaId: matchResult.match.motoristaId,
      baseId: matchResult.match.basePagamentoId,
      periodoId: matchResult.match.periodoPagamentoId,
      statusAnterior: current
    });
  }

  const importacao = await prisma.importacaoFinanceira.create({
    data: {
      nomeArquivo: context.fileName,
      hashArquivo: fileHash,
      nomeAba: sheetName,
      usuarioId: context.userId,
      periodoPagamentoId: context.periodId,
      basePagamentoId: context.baseId,
      totalLinhas: previewRows.length,
      totalValidas: previewRows.filter((item) => item.situacaoValidacao === FinanceiroImportacaoItemResultado.valido).length,
      totalErros: previewRows.filter((item) => item.situacaoValidacao !== FinanceiroImportacaoItemResultado.valido).length,
      status: FinanceiroImportacaoStatus.preview,
      itens: {
        createMany: {
          data: previewRows.map((item) => ({
            numeroLinha: item.numeroLinha,
            identificador: item.identificador,
            pagamentoId: item.pagamentoId,
            motoristaId: item.motoristaId,
            periodoPagamentoId: item.periodoId,
            basePagamentoId: item.baseId,
            codigoObb: item.codigoObb,
            corIdentificada: item.statusPlanilha,
            regraAplicada: item.regraAplicada,
            statusAnterior: item.statusAnterior,
            statusNovo: item.novoStatus,
            resultado: item.situacaoValidacao,
            mensagem: item.mensagem
          }))
        }
      }
    },
    include: {
      itens: true
    }
  });

  return {
    importacao: {
      id: importacao.id,
      nomeArquivo: importacao.nomeArquivo,
      nomeAba: importacao.nomeAba,
      status: importacao.status,
      totalLinhas: importacao.totalLinhas,
      totalValidas: importacao.totalValidas,
      totalErros: importacao.totalErros,
      criadoEm: importacao.criadoEm
    },
    previewRows
  };
}

export async function confirmFinanceiroImport(importacaoId: string, userId: string) {
  const importacao = await prisma.importacaoFinanceira.findUnique({
    where: { id: importacaoId },
    include: {
      itens: true
    }
  });

  if (!importacao) {
    throw new Error("Importação financeira não encontrada.");
  }

  const validItems = importacao.itens.filter((item) => item.resultado === FinanceiroImportacaoItemResultado.valido);
  const updatedItems: Array<{ itemId: string; pagamentoId: string; eventId: string }> = [];

  await prisma.$transaction(async (transaction) => {
    await transaction.importacaoFinanceira.update({
      where: { id: importacaoId },
      data: {
        status: FinanceiroImportacaoStatus.processando,
        confirmadoEm: new Date()
      }
    });

    for (const item of validItems) {
      if (!item.pagamentoId || !item.statusNovo) {
        continue;
      }

      const pagamento = await transaction.uploadPdf.findUnique({
        where: { id: item.pagamentoId },
        select: {
          id: true,
          statusPagamento: true,
          motoristaId: true,
          periodoPagamentoId: true,
          basePagamentoId: true,
          motorista: {
            select: {
              cpf: true,
              nome: true
            }
          }
        }
      });

      if (!pagamento) {
        await transaction.importacaoFinanceiraItem.update({
          where: { id: item.id },
          data: {
            resultado: FinanceiroImportacaoItemResultado.pagamento_nao_encontrado,
            mensagem: "Pagamento não encontrado ao confirmar importação."
          }
        });
        continue;
      }

      const currentStatus = pagamento.statusPagamento || FinanceiroStatusPagamento.PENDENTE;
      const relatedUploads = await transaction.uploadPdf.findMany({
        where: {
          motoristaId: pagamento.motoristaId,
          periodoPagamentoId: pagamento.periodoPagamentoId,
          basePagamentoId: pagamento.basePagamentoId,
          status: {
            not: UploadStatus.removido
          }
        },
        select: {
          id: true,
          statusPagamento: true
        }
      });

      if (isDangerousRegression(currentStatus, item.statusNovo)) {
        await transaction.importacaoFinanceiraItem.update({
          where: { id: item.id },
          data: {
            resultado: FinanceiroImportacaoItemResultado.conflito_status,
            mensagem: "Transicao perigosa bloqueada na confirmacao."
          }
        });
        continue;
      }

      await transaction.uploadPdf.updateMany({
        where: {
          id: {
            in: relatedUploads.map((related) => related.id)
          }
        },
        data: {
          statusPagamento: item.statusNovo,
          statusPagamentoAtualizadoEm: new Date(),
          statusPagamentoMotivo: item.mensagem || null,
          statusPagamentoOrigem: item.regraAplicada || null,
          codigoObb: item.codigoObb || null,
          usuarioAtualizacaoId: userId
        }
      });

      await transaction.historicoStatusPagamento.create({
        data: {
          pagamentoId: pagamento.id,
          importacaoId,
          itemId: item.id,
          statusAnterior: currentStatus,
          statusNovo: item.statusNovo,
          motivo: item.mensagem || item.regraAplicada || null,
          codigoObb: item.codigoObb || null,
          corIdentificada: item.corIdentificada || null,
          regraAplicada: item.regraAplicada || null,
          origem: "IMPORTACAO_PLANILHA_FINANCEIRA",
          usuarioId: userId
        }
      });

      const eventId = crypto.randomUUID();
      await transaction.webhookEvento.create({
        data: {
          eventId,
          importacaoId,
          pagamentoId: pagamento.id,
          payload: {
            event: "pagamento.status_atualizado",
            event_id: eventId,
            occurred_at: new Date().toISOString(),
            pagamento_id: pagamento.id,
            espelho_pagamento_id: pagamento.id,
            nota_fiscal_id: null,
            pdfonline_id: null,
            motorista_id: pagamento.motoristaId,
            cpf_cnpj: pagamento.motorista?.cpf || null,
            periodo_pagamento_id: pagamento.periodoPagamentoId,
            lote_id: importacaoId,
            status_anterior: currentStatus,
            status_atual: item.statusNovo,
            motivo: item.mensagem || item.regraAplicada || null,
            codigo_obb: item.codigoObb || null,
            origem_status: item.regraAplicada || null,
            origem: "IMPORTACAO_PLANILHA_FINANCEIRA",
            importacao_id: importacaoId,
            linha_planilha: item.numeroLinha
          },
          status: "pendente",
          usuarioId: userId
        }
      });

      updatedItems.push({
        itemId: item.id,
        pagamentoId: pagamento.id,
        eventId
      });
    }

    await transaction.importacaoFinanceira.update({
      where: { id: importacaoId },
      data: {
        status: updatedItems.length > 0 ? FinanceiroImportacaoStatus.concluido : FinanceiroImportacaoStatus.concluido_com_erro,
        totalValidas: validItems.length,
        totalErros: importacao.itens.length - validItems.length
      }
    });
  });

  return {
    importacaoId,
    updatedItems
  };
}

export async function listFinanceiroImportacoes() {
  return prisma.importacaoFinanceira.findMany({
    orderBy: {
      criadoEm: "desc"
    },
    include: {
      usuario: {
        select: {
          nome: true,
          email: true
        }
      },
      periodoPagamento: {
        select: {
          nome: true
        }
      },
      basePagamento: {
        select: {
          nome: true
        }
      }
    }
  });
}

export async function listFinanceiroHistorico(params: { periodoId?: string; baseId?: string; pagamentoId?: string }) {
  const pagamentoFilters: Prisma.UploadPdfWhereInput = {
    ...(params.periodoId
      ? {
          periodoPagamentoId: params.periodoId
        }
      : {}),
    ...(params.baseId
      ? {
          basePagamentoId: params.baseId
        }
      : {})
  };

  return prisma.historicoStatusPagamento.findMany({
    where: {
      ...(params.pagamentoId ? { pagamentoId: params.pagamentoId } : {}),
      ...(Object.keys(pagamentoFilters).length > 0
        ? {
            pagamento: pagamentoFilters
          }
        : {})
    },
    orderBy: {
      criadoEm: "desc"
    },
    include: {
      pagamento: {
        include: {
          motorista: true,
          periodoPagamento: true,
          basePagamento: true
        }
      },
      importacao: true,
      usuario: {
        select: {
          nome: true
        }
      },
      item: true
    }
  });
}

export async function duplicateFinanceiroImportHash(fileBuffer: Buffer) {
  const fileHash = sha256(fileBuffer);

  return prisma.importacaoFinanceira.findFirst({
    where: {
      hashArquivo: fileHash
    },
    orderBy: {
      criadoEm: "desc"
    }
  });
}

export function parseFinanceiroWorkbookForPreview(buffer: Buffer) {
  return parseWorkbookRows(buffer);
}

