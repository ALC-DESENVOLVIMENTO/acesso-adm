import crypto from "node:crypto";
import * as XLSX from "xlsx";
import { FinanceiroImportacaoItemResultado, FinanceiroImportacaoStatus, FinanceiroStatusPagamento, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";

const SUPPORTED_SHEETS = ["Resumido"];
const RECOGNIZED_COLORS = new Map<string, FinanceiroStatusPagamento>([
  ["FF92D050", "PAGO"],
  ["92D050", "PAGO"],
  ["FFFFFF00", "TENTATIVA_FALHA"],
  ["FFFF00", "TENTATIVA_FALHA"],
  ["FFFF0000", "BLOQUEADO"],
  ["FF0000", "BLOQUEADO"]
]);

const BLOCK_CODES = new Set(["BLOQOXPAY", "BLOQ", "BOLQOXPAY"]);
type ImportContext = {
  userId: string;
  fileName: string;
  fileBuffer: Buffer;
  periodId: string;
  baseId: string | null;
};

type ExcelCellValue = string | number | boolean | Date | null;

export type FinanceiroImportPreviewRow = {
  numeroLinha: number;
  identificador: string | null;
  motorista: string | null;
  cpfCnpj: string | null;
  periodo: string | null;
  valor: string | null;
  codigoObb: string | null;
  corIdentificada: string | null;
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
  colorCode: string | null;
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

function normalizeColor(raw: unknown) {
  if (typeof raw !== "string") {
    return null;
  }

  const value = raw.trim().toUpperCase();

  if (!value) {
    return null;
  }

  if (value.length === 8 && value.startsWith("FF")) {
    return value;
  }

  if (value.length === 6) {
    return value;
  }

  return value;
}

function getCellFillColor(cell: XLSX.CellObject | undefined) {
  const fillColor =
    (cell as XLSX.CellObject & { s?: { fill?: { fgColor?: { rgb?: string; argb?: string; indexed?: number; theme?: number } } } })?.s?.fill
      ?.fgColor;

  if (!fillColor) {
    return null;
  }

  return normalizeColor(fillColor.rgb || fillColor.argb || null);
}

function detectRowColor(sheet: XLSX.WorkSheet, rowNumber: number, endColumn = 12) {
  const fillColors = new Set<string>();

  for (let column = 1; column <= endColumn; column += 1) {
    const cellAddress = XLSX.utils.encode_cell({ r: rowNumber - 1, c: column - 1 });
    const cell = sheet[cellAddress];
    const color = getCellFillColor(cell);

    if (color) {
      fillColors.add(color);
    }
  }

  if (fillColors.size === 0) {
    return {
      color: null,
      isInconsistent: false
    };
  }

  if (fillColors.size > 1) {
    return {
      color: Array.from(fillColors).join(","),
      isInconsistent: true
    };
  }

  return {
    color: Array.from(fillColors)[0] || null,
    isInconsistent: false
  };
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

    const { color, isInconsistent } = detectRowColor(sheet, rowNumber, range.e.c + 1);
    const hasData = values.some((value) => Boolean(String(value || "").trim()));

    rows.push({
      numeroLinha: rowNumber,
      cells: values,
      rowValues,
      colorCode: isInconsistent ? `INCONSISTENTE:${color || ""}` : color,
      hasData
    });
  }

  return { sheetName, rows };
}

function resolveRowColorStatus(colorCode: string | null) {
  if (!colorCode) {
    return null;
  }

  if (colorCode.startsWith("INCONSISTENTE:")) {
    return "INCONSISTENTE";
  }

  return RECOGNIZED_COLORS.get(colorCode) || null;
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

function resolveStatusByColor(rowColorStatus: string | null) {
  if (rowColorStatus === "PAGO") {
    return FinanceiroStatusPagamento.PAGO;
  }

  if (rowColorStatus === "TENTATIVA_FALHA") {
    return FinanceiroStatusPagamento.TENTATIVA_FALHA;
  }

  if (rowColorStatus === "BLOQUEADO") {
    return FinanceiroStatusPagamento.BLOQUEADO;
  }

  if (rowColorStatus === "INCONSISTENTE") {
    return FinanceiroStatusPagamento.REVISAO_MANUAL;
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

function resolveCandidateMatch(
  row: WorkbookRow,
  candidates: Awaited<ReturnType<typeof loadPaymentCandidates>>
) {
  const motorista = row.rowValues["Motorista"] || row.rowValues["Favorecido"] || "";
  const cpf = row.rowValues["CPF do Favorecido"] || "";
  const cpfDigits = normalizeDigits(cpf);
  const normalizedName = normalizeCompact(motorista);

  const byCpf = cpfDigits
    ? candidates.filter((candidate) => normalizeDigits(candidate.motorista?.cpf || "") === cpfDigits)
    : [];

  if (byCpf.length === 1) {
    return { match: byCpf[0], reason: "CPF ou CNPJ + periodo" };
  }

  if (byCpf.length > 1) {
    return { ambiguous: true, matches: byCpf, reason: "CPF ou CNPJ + periodo" };
  }

  const byName = normalizedName
    ? candidates.filter((candidate) => normalizeCompact(candidate.motorista?.nome || "") === normalizedName)
    : [];

  if (byName.length === 1) {
    return { match: byName[0], reason: "Motorista + periodo + valor" };
  }

  if (byName.length > 1) {
    return { ambiguous: true, matches: byName, reason: "Motorista + periodo + valor" };
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

function determineValidation(row: WorkbookRow, rowColorStatus: string | null, obbStatus: FinanceiroStatusPagamento | null) {
  const rawObb = row.rowValues["CodOBB"] || "";
  const normalizedObb = normalizeObbCode(rawObb);

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

  if (rowColorStatus === "INCONSISTENTE") {
    return {
      resultado: FinanceiroImportacaoItemResultado.linha_inconsistente,
      regraAplicada: "Cores diferentes na mesma linha",
      statusNovo: null,
      mensagem: "Linha possui preenchimentos conflitantes."
    } as const;
  }

  if (!rowColorStatus && !obbStatus) {
    return {
      resultado: FinanceiroImportacaoItemResultado.valido,
      regraAplicada: "Linha sem preenchimento",
      statusNovo: FinanceiroStatusPagamento.PENDENTE,
      mensagem: null
    } as const;
  }

  if (obbStatus === FinanceiroStatusPagamento.BLOQUEADO) {
    return {
      resultado: FinanceiroImportacaoItemResultado.valido,
      regraAplicada: `Coluna G = ${normalizedObb || "BLOQOXPAY"}`,
      statusNovo: FinanceiroStatusPagamento.BLOQUEADO,
      mensagem: normalizedObb ? `Bloqueio identificado na coluna CodOBB (${normalizedObb}).` : "Bloqueio identificado na coluna CodOBB."
    } as const;
  }

  const statusFromColor = resolveStatusByColor(rowColorStatus);

  if (!statusFromColor) {
    return {
      resultado: FinanceiroImportacaoItemResultado.cor_nao_reconhecida,
      regraAplicada: "Cor nao reconhecida",
      statusNovo: null,
      mensagem: "Nao foi possivel reconhecer a cor da linha."
    } as const;
  }

  return {
    resultado: FinanceiroImportacaoItemResultado.valido,
    regraAplicada:
      statusFromColor === FinanceiroStatusPagamento.PAGO
        ? "Linha verde"
        : statusFromColor === FinanceiroStatusPagamento.TENTATIVA_FALHA
          ? "Linha amarela"
          : "Linha vermelha",
    statusNovo: statusFromColor,
    mensagem: null
  } as const;
}

function pickCurrentStatus(upload: Awaited<ReturnType<typeof loadPaymentCandidates>>[number]) {
  return upload.statusPagamento || FinanceiroStatusPagamento.PENDENTE;
}

export async function createFinanceiroImportPreview(context: ImportContext) {
  const fileHash = sha256(context.fileBuffer);

  const existing = await prisma.importacaoFinanceira.findUnique({
    where: {
      hashArquivo: fileHash
    }
  });

  if (existing) {
    throw new Error("Este arquivo ja foi importado anteriormente. Solicite autorizacao para reprocessar.");
  }

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

  const previewRows: FinanceiroImportPreviewRow[] = rows.map((row) => {
    const rowColorStatus = resolveRowColorStatus(row.colorCode);
    const obbStatus = resolveStatusByObb(row.rowValues["CodOBB"]);
    const validation = determineValidation(row, rowColorStatus, obbStatus);
    const matchResult = resolveCandidateMatch(row, candidates);
    const current = matchResult.match ? pickCurrentStatus(matchResult.match) : null;
    const candidateStatus = validation.statusNovo;
    const finalStatus = candidateStatus ?? obbStatus ?? null;
    const dangerous = isDangerousRegression(current, finalStatus);
    const sameStatus = Boolean(current && finalStatus && current === finalStatus);

    if (matchResult.ambiguous) {
      return {
        numeroLinha: row.numeroLinha,
        identificador: row.rowValues["Motorista"] || row.rowValues["Favorecido"] || null,
        motorista: row.rowValues["Motorista"] || row.rowValues["Favorecido"] || null,
        cpfCnpj: row.rowValues["CPF do Favorecido"] || null,
        periodo: period?.nome || null,
        valor: formatCurrency(row.rowValues["Total"]),
        codigoObb: row.rowValues["CodOBB"] || null,
        corIdentificada: row.colorCode,
        statusAtual: current,
        novoStatus: null,
        regraAplicada: matchResult.reason,
        situacaoValidacao: FinanceiroImportacaoItemResultado.correspondencia_ambiguo,
        mensagem: "Mais de um pagamento correspondente foi encontrado.",
        pagamentoId: null,
        motoristaId: null,
        baseId: context.baseId,
        periodoId: context.periodId,
        statusAnterior: current
      };
    }

    if (!matchResult.match) {
      return {
        numeroLinha: row.numeroLinha,
        identificador: row.rowValues["Motorista"] || row.rowValues["Favorecido"] || null,
        motorista: row.rowValues["Motorista"] || row.rowValues["Favorecido"] || null,
        cpfCnpj: row.rowValues["CPF do Favorecido"] || null,
        periodo: period?.nome || null,
        valor: formatCurrency(row.rowValues["Total"]),
        codigoObb: row.rowValues["CodOBB"] || null,
        corIdentificada: row.colorCode,
        statusAtual: null,
        novoStatus: null,
        regraAplicada: matchResult.reason,
        situacaoValidacao: row.hasData
          ? FinanceiroImportacaoItemResultado.pagamento_nao_encontrado
          : FinanceiroImportacaoItemResultado.linha_vazia,
        mensagem: row.hasData ? "Pagamento nao encontrado no periodo selecionado." : "Linha vazia.",
        pagamentoId: null,
        motoristaId: null,
        baseId: context.baseId,
        periodoId: context.periodId,
        statusAnterior: null
      };
    }

    return {
      numeroLinha: row.numeroLinha,
      identificador: row.rowValues["Motorista"] || row.rowValues["Favorecido"] || null,
      motorista: matchResult.match.motorista?.nome || row.rowValues["Motorista"] || row.rowValues["Favorecido"] || null,
      cpfCnpj: matchResult.match.motorista?.cpf || row.rowValues["CPF do Favorecido"] || null,
      periodo: period?.nome || matchResult.match.periodoPagamento?.nome || null,
      valor: formatCurrency(row.rowValues["Total"]),
      codigoObb: row.rowValues["CodOBB"] || null,
      corIdentificada: row.colorCode,
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
    };
  });

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
            corIdentificada: item.corIdentificada,
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
    throw new Error("Importacao financeira nao encontrada.");
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
            mensagem: "Pagamento nao encontrado ao confirmar importacao."
          }
        });
        continue;
      }

      const currentStatus = pagamento.statusPagamento || FinanceiroStatusPagamento.PENDENTE;

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

      await transaction.uploadPdf.update({
        where: { id: pagamento.id },
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

  return prisma.importacaoFinanceira.findUnique({
    where: {
      hashArquivo: fileHash
    }
  });
}

export function parseFinanceiroWorkbookForPreview(buffer: Buffer) {
  return parseWorkbookRows(buffer);
}

