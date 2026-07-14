import * as XLSX from "xlsx";
import {
  DriverPdfReceivedStatus,
  FinanceiroStatusPagamento,
  Prisma,
  UploadStatus
} from "@prisma/client";
import { prisma } from "./prisma.js";
import {
  digitsOnly,
  normalizeText,
  searchDriverRegistryMatchesByCpfDigits,
  type DriverRegistryMatch
} from "./driver-registry.js";
import { fetchObjectBuffer, isPaymentMirrorStorageKey } from "./storage.js";

const APPROVED_NOTE_STATUSES: Set<DriverPdfReceivedStatus> = new Set([
  DriverPdfReceivedStatus.nota_fiscal_aprovada,
  DriverPdfReceivedStatus.processo_concluido
]);

type AptoPagamentoUpload = Prisma.UploadPdfGetPayload<{
  include: {
    motorista: {
      select: {
        id: true;
        nome: true;
        cpf: true;
        statusCadastro: true;
      };
    };
    periodoPagamento: {
      select: {
        id: true;
        nome: true;
      };
    };
    basePagamento: {
      select: {
        id: true;
        nome: true;
      };
    };
  };
}>;

type AptoPagamentoReceipt = Prisma.DriverPdfReceivedGetPayload<{
  select: {
    id: true;
    uploadPdfId: true;
    motoristaId: true;
    periodoPagamentoId: true;
    basePagamentoId: true;
    status: true;
    documentType: true;
    uploadEm: true;
    enviadoAoMotoristaEm: true;
    visualizadoEm: true;
    aprovadoEm: true;
    rejeitadoEm: true;
    caminhoArquivo: true;
    nomeArquivo: true;
    motorista: {
      select: {
        nome: true;
        cpf: true;
      };
    };
    basePagamento: {
      select: {
        nome: true;
      };
    };
  };
}>;

export type AptosPagamentoRow = {
  processoId: string;
  motoristaId: string;
  nomeMotorista: string;
  nomeFavorecido: string;
  cpfFavorecido: string;
  valorTotalPdf: number;
  valorTotalPdfFormatado: string;
  baseMotorista: string;
  statusProcesso: string;
  statusNotaFiscal: string;
  statusPagamento: string;
};

export type AptosPagamentoExcluido = {
  processoId: string;
  motoristaId: string | null;
  nomeMotorista: string;
  motivo: string;
};

export type AptosPagamentoInconsistencia = {
  processoId: string;
  motoristaId: string;
  nomeMotorista: string;
  periodo: string;
  motivo: string;
  campo: string;
};

export type AptosPagamentoPreview = {
  periodoId: string;
  periodo: {
    id: string;
    nome: string;
  };
  totalProcessos: number;
  totalAptos: number;
  totalInaptos: number;
  totalInconsistencias: number;
  aptos: AptosPagamentoRow[];
  excluidos: AptosPagamentoExcluido[];
  inconsistencias: AptosPagamentoInconsistencia[];
};

type AptoPagamentoEvaluation = {
  apto: boolean;
  statusProcesso: string;
  statusNotaFiscal: string;
  statusPagamento: string;
  motivoExclusao: string | null;
};

type CandidateRow = {
  upload: AptoPagamentoUpload;
  mirrorReceipt: AptoPagamentoReceipt | null;
  noteReceipt: AptoPagamentoReceipt | null;
  registryMatch: DriverRegistryMatch | null;
  paymentStatus: FinanceiroStatusPagamento | null;
};

function normalizeCpfOrCnpj(value: string | null | undefined) {
  return digitsOnly(value || "");
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(value);
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
    const text = String(parsed.text || "").replace(/\s+/g, " ");
    const match =
      /Total Geral\s*[:\-]?\s*R?\$?\s*([\d.]+,\d{2})/i.exec(text) ||
      /Total\s*[:\-]?\s*R?\$?\s*([\d.]+,\d{2})/i.exec(text);

    return match?.[1] ? parseMoneyNumber(match[1]) : null;
  } catch {
    return null;
  }
}

function sanitizeFileSegment(value: string) {
  return (
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_{2,}/g, "_") || "sem-nome"
  );
}

function isApprovedMirror(receipt: AptoPagamentoReceipt | null) {
  return Boolean(
    receipt &&
      (receipt.status === DriverPdfReceivedStatus.motorista_visualizou ||
        receipt.status === DriverPdfReceivedStatus.processo_concluido ||
        Boolean(receipt.visualizadoEm))
  );
}

function isApprovedNoteStatus(status: string | null | undefined) {
  return Boolean(status && APPROVED_NOTE_STATUSES.has(status as DriverPdfReceivedStatus));
}

function isBlockedNoteStatus(status: string | null | undefined) {
  return status === DriverPdfReceivedStatus.nota_fiscal_rejeitada;
}

function findRegistryMatch(
  registryMatchesByCpf: Map<string, DriverRegistryMatch[]>,
  motoristaCpf: string,
  baseName: string | null | undefined
) {
  const cpfDigits = normalizeCpfOrCnpj(motoristaCpf);
  const matches = registryMatchesByCpf.get(cpfDigits) || [];

  if (matches.length === 0) {
    return null;
  }

  const normalizedBase = normalizeText(baseName || "");
  const exactBaseMatches = matches.filter((match) => normalizeText(match.base || "") === normalizedBase);

  if (exactBaseMatches.length === 1) {
    return exactBaseMatches[0];
  }

  if (exactBaseMatches.length > 1) {
    return exactBaseMatches[0];
  }

  return matches[0];
}

function deriveMirrorReceipt(
  upload: AptoPagamentoUpload,
  receipts: AptoPagamentoReceipt[],
  uploadById: Map<string, AptoPagamentoUpload>
) {
  return (
    receipts.find((receipt) => receipt.uploadPdfId && receipt.uploadPdfId === upload.id && !isApprovedNoteStatus(receipt.status)) ||
    receipts.find((receipt) => {
      const source = receipt.uploadPdfId ? uploadById.get(receipt.uploadPdfId) || null : null;

      return (
        !isApprovedNoteStatus(receipt.status) &&
        (receipt.motoristaId === upload.motoristaId || source?.motoristaId === upload.motoristaId) &&
        (receipt.periodoPagamentoId === upload.periodoPagamentoId || source?.periodoPagamentoId === upload.periodoPagamentoId) &&
        (receipt.basePagamentoId === upload.basePagamentoId || source?.basePagamentoId === upload.basePagamentoId)
      );
    }) ||
    null
  );
}

function deriveNoteReceipt(
  upload: AptoPagamentoUpload,
  receipts: AptoPagamentoReceipt[],
  uploadById: Map<string, AptoPagamentoUpload>
) {
  return (
    receipts.find((receipt) => receipt.uploadPdfId && receipt.uploadPdfId === upload.id && isApprovedNoteStatus(receipt.status)) ||
    receipts.find((receipt) => {
      const source = receipt.uploadPdfId ? uploadById.get(receipt.uploadPdfId) || null : null;

      return (
        isApprovedNoteStatus(receipt.status) &&
        (receipt.motoristaId === upload.motoristaId || source?.motoristaId === upload.motoristaId) &&
        (receipt.periodoPagamentoId === upload.periodoPagamentoId || source?.periodoPagamentoId === upload.periodoPagamentoId) &&
        (receipt.basePagamentoId === upload.basePagamentoId || source?.basePagamentoId === upload.basePagamentoId)
      );
    }) ||
    receipts.find((receipt) => {
      return (
        receipt.motoristaId === upload.motoristaId &&
        receipt.periodoPagamentoId === upload.periodoPagamentoId &&
        receipt.basePagamentoId === upload.basePagamentoId &&
        (isApprovedNoteStatus(receipt.status) || receipt.status === DriverPdfReceivedStatus.nota_fiscal_recebida)
      );
    }) ||
    null
  );
}

export function evaluateAptidao(params: {
  upload: AptoPagamentoUpload;
  mirrorReceipt: AptoPagamentoReceipt | null;
  noteReceipt: AptoPagamentoReceipt | null;
  paymentStatus: FinanceiroStatusPagamento | null;
}): AptoPagamentoEvaluation {
  const { upload, mirrorReceipt, noteReceipt, paymentStatus } = params;

  if (upload.status === UploadStatus.removido) {
    return {
      apto: false,
      statusProcesso: "Cancelado",
      statusNotaFiscal: "Cancelada",
      statusPagamento: paymentStatus || FinanceiroStatusPagamento.PENDENTE,
      motivoExclusao: "Processo cancelado"
    };
  }

  if (upload.motorista?.statusCadastro === "bloqueado") {
    return {
      apto: false,
      statusProcesso: "Bloqueado",
      statusNotaFiscal: noteReceipt?.status || "Sem nota",
      statusPagamento: paymentStatus || FinanceiroStatusPagamento.BLOQUEADO,
      motivoExclusao: "Motorista bloqueado"
    };
  }

  if (paymentStatus === FinanceiroStatusPagamento.PAGO) {
    return {
      apto: false,
      statusProcesso: "Pago",
      statusNotaFiscal: noteReceipt?.status || "Sem nota",
      statusPagamento: paymentStatus,
      motivoExclusao: "Pagamento ja realizado"
    };
  }

  if (paymentStatus === FinanceiroStatusPagamento.BLOQUEADO) {
    return {
      apto: false,
      statusProcesso: "Bloqueado",
      statusNotaFiscal: noteReceipt?.status || "Sem nota",
      statusPagamento: paymentStatus,
      motivoExclusao: "Pagamento bloqueado"
    };
  }

  if (paymentStatus === FinanceiroStatusPagamento.TENTATIVA_FALHA) {
    return {
      apto: false,
      statusProcesso: "Tentativa sem sucesso",
      statusNotaFiscal: noteReceipt?.status || "Sem nota",
      statusPagamento: paymentStatus,
      motivoExclusao: "Tentativa de pagamento sem sucesso"
    };
  }

  if (!isApprovedMirror(mirrorReceipt)) {
    return {
      apto: false,
      statusProcesso: mirrorReceipt ? "Espelho pendente" : "Sem espelho",
      statusNotaFiscal: noteReceipt?.status || "Sem nota",
      statusPagamento: paymentStatus || FinanceiroStatusPagamento.PENDENTE,
      motivoExclusao: "Espelho de pagamento nao aprovado"
    };
  }

  if (!noteReceipt) {
    return {
      apto: false,
      statusProcesso: "Aguardando nota fiscal",
      statusNotaFiscal: "Nao enviada",
      statusPagamento: paymentStatus || FinanceiroStatusPagamento.PENDENTE,
      motivoExclusao: "Nota fiscal nao enviada"
    };
  }

  if (isBlockedNoteStatus(noteReceipt.status)) {
    return {
      apto: false,
      statusProcesso: "Nota fiscal rejeitada",
      statusNotaFiscal: "Nota fiscal rejeitada",
      statusPagamento: paymentStatus || FinanceiroStatusPagamento.PENDENTE,
      motivoExclusao: "Nota fiscal rejeitada ou invalida"
    };
  }

  if (!isApprovedNoteStatus(noteReceipt.status)) {
    return {
      apto: false,
      statusProcesso: "Nota fiscal em validacao",
      statusNotaFiscal: noteReceipt.status || "Sem status",
      statusPagamento: paymentStatus || FinanceiroStatusPagamento.PENDENTE,
      motivoExclusao: "Nota fiscal pendente de validacao"
    };
  }

  return {
    apto: true,
    statusProcesso: "Aguardando pagamento",
    statusNotaFiscal: "Nota fiscal aprovada",
    statusPagamento: paymentStatus || FinanceiroStatusPagamento.PENDENTE,
    motivoExclusao: null
  };
}

async function buildAptosPreviewRows(rows: CandidateRow[]) {
  const aptos: AptosPagamentoRow[] = [];
  const inconsistencias: AptosPagamentoInconsistencia[] = [];
  const excluidos: AptosPagamentoExcluido[] = [];

  for (const row of rows) {
    const { upload, mirrorReceipt, noteReceipt, registryMatch, paymentStatus } = row;
    const evaluation = evaluateAptidao({ upload, mirrorReceipt, noteReceipt, paymentStatus });

    if (!evaluation.apto) {
      excluidos.push({
        processoId: upload.id,
        motoristaId: upload.motoristaId,
        nomeMotorista: upload.motorista?.nome || "Nao informado",
        motivo: evaluation.motivoExclusao || "Nao apto para exportacao"
      });
      continue;
    }

    const nomeFavorecido = String(
      registryMatch?.raw.nome_favorecido ||
        registryMatch?.raw.favorecido_nome ||
        registryMatch?.raw.favorecido ||
        registryMatch?.raw.beneficiario ||
        registryMatch?.nome ||
        ""
    ).trim();
    const cpfFavorecido = normalizeCpfOrCnpj(
      String(
        registryMatch?.raw.cpf_favorecido ||
          registryMatch?.raw.cpf_do_favorecido ||
          registryMatch?.raw.favorecido_cpf ||
          registryMatch?.raw.beneficiary_cpf ||
          registryMatch?.raw.cnpj_favorecido ||
          registryMatch?.raw.favorecido_cnpj ||
          registryMatch?.cpf ||
          ""
      )
    );
    const baseMotorista = upload.basePagamento?.nome?.trim() || registryMatch?.base?.trim() || "";
    const valorTotalPdf = await extractPaymentTotalValue(mirrorReceipt?.caminhoArquivo || upload.caminhoArquivo);

    const missing: Array<{ field: string; reason: string }> = [];

    if (!upload.motoristaId || !upload.motorista?.nome) {
      missing.push({ field: "motorista", reason: "Motorista nao identificado" });
    }

    if (!nomeFavorecido) {
      missing.push({ field: "favorecido", reason: "Favorecido nao identificado" });
    }

    if (!cpfFavorecido || !/^\d{11,14}$/.test(cpfFavorecido)) {
      missing.push({ field: "cpf_favorecido", reason: "CPF do favorecido ausente ou invalido" });
    }

    if (!baseMotorista) {
      missing.push({ field: "base", reason: "Base do motorista nao cadastrada" });
    }

    if (valorTotalPdf === null || valorTotalPdf <= 0) {
      missing.push({ field: "valor_total_pdf", reason: "Valor total nao encontrado" });
    }

    if (missing.length > 0) {
      inconsistencias.push({
        processoId: upload.id,
        motoristaId: upload.motoristaId || "",
        nomeMotorista: upload.motorista?.nome || "Nao informado",
        periodo: upload.periodoPagamento?.nome || "Nao informado",
        motivo: missing.map((item) => item.reason).join("; "),
        campo: missing.map((item) => item.field).join(", ")
      });
      continue;
    }

    const valorTotalPdfNumero = valorTotalPdf as number;

    aptos.push({
      processoId: upload.id,
      motoristaId: upload.motoristaId || "",
      nomeMotorista: upload.motorista?.nome || "Nao informado",
      nomeFavorecido,
      cpfFavorecido,
      valorTotalPdf: valorTotalPdfNumero,
      valorTotalPdfFormatado: formatMoney(valorTotalPdfNumero),
      baseMotorista,
      statusProcesso: evaluation.statusProcesso,
      statusNotaFiscal: evaluation.statusNotaFiscal,
      statusPagamento: evaluation.statusPagamento
    });
  }

  return { aptos, inconsistencias, excluidos };
}

async function buildCandidateRows(periodId: string, baseId?: string | null) {
  const period = await prisma.periodoPagamento.findUnique({
    where: { id: periodId },
    select: {
      id: true,
      nome: true,
      uploads: {
        where: {
          status: {
            not: UploadStatus.removido
          },
          ...(baseId ? { basePagamentoId: baseId } : {})
        },
        include: {
          motorista: {
            select: {
              id: true,
              nome: true,
              cpf: true,
              statusCadastro: true
            }
          },
          periodoPagamento: {
            select: {
              id: true,
              nome: true
            }
          },
          basePagamento: {
            select: {
              id: true,
              nome: true
            }
          }
        }
      },
      pdfsRecebidos: {
        where: {
          ...(baseId ? { basePagamentoId: baseId } : {})
        },
        select: {
          id: true,
          uploadPdfId: true,
          motoristaId: true,
          periodoPagamentoId: true,
          basePagamentoId: true,
          status: true,
          documentType: true,
          uploadEm: true,
          enviadoAoMotoristaEm: true,
          visualizadoEm: true,
          aprovadoEm: true,
          rejeitadoEm: true,
          caminhoArquivo: true,
          nomeArquivo: true,
          motorista: {
            select: {
              nome: true,
              cpf: true
            }
          },
          basePagamento: {
            select: {
              nome: true
            }
          }
        }
      }
    }
  });

  if (!period) {
    throw new Error("Periodo nao encontrado para exportacao.");
  }

  const uploadById = new Map(period.uploads.map((upload) => [upload.id, upload] as const));
  const childReferences = new Set(
    period.uploads
      .map((upload) => upload.substituiUploadId)
      .filter((value): value is string => Boolean(value))
  );

  const visibleUploads = period.uploads
    .filter((upload) => isPaymentMirrorStorageKey(upload.caminhoArquivo))
    .filter((upload) => !childReferences.has(upload.id))
    .sort((left, right) => right.criadoEm.getTime() - left.criadoEm.getTime());

  const latestUploads = new Map<string, AptoPagamentoUpload>();
  for (const upload of visibleUploads) {
    if (!upload.motoristaId || !upload.basePagamentoId) {
      continue;
    }

    const key = `${upload.motoristaId}|${upload.basePagamentoId}`;
    if (!latestUploads.has(key)) {
      latestUploads.set(key, upload);
    }
  }

  const cpfDigitsList = Array.from(
    new Set(Array.from(latestUploads.values()).map((upload) => digitsOnly(upload.motorista?.cpf || "")).filter(Boolean))
  );
  const registryMatches =
    cpfDigitsList.length > 0 ? await searchDriverRegistryMatchesByCpfDigits(cpfDigitsList) : [];
  const registryByCpf = new Map<string, DriverRegistryMatch[]>();

  for (const match of registryMatches) {
    const key = digitsOnly(match.cpfDigits || match.cpf);
    const current = registryByCpf.get(key) || [];
    current.push(match);
    registryByCpf.set(key, current);
  }

  const receivedRows = period.pdfsRecebidos.filter((receipt) => (baseId ? receipt.basePagamentoId === baseId : true));

  const evaluations: CandidateRow[] = [];

  for (const upload of latestUploads.values()) {
    const mirrorReceipt = deriveMirrorReceipt(upload, receivedRows, uploadById);
    const noteReceipt = deriveNoteReceipt(upload, receivedRows, uploadById);
    const registryMatch = findRegistryMatch(registryByCpf, upload.motorista?.cpf || "", upload.basePagamento?.nome || null);

    evaluations.push({
      upload,
      mirrorReceipt,
      noteReceipt,
      registryMatch,
      paymentStatus: upload.statusPagamento || null
    });
  }

  const { aptos, inconsistencias, excluidos } = await buildAptosPreviewRows(evaluations);

  return {
    periodoId: period.id,
    periodo: {
      id: period.id,
      nome: period.nome
    },
    totalProcessos: evaluations.length,
    totalAptos: aptos.length,
    totalInaptos: excluidos.length,
    totalInconsistencias: inconsistencias.length,
    aptos,
    excluidos,
    inconsistencias
  } satisfies AptosPagamentoPreview;
}

export function buildWorkbook(preview: AptosPagamentoPreview) {
  const workbook = XLSX.utils.book_new();
  const headers = [
    "Nome Motorista",
    "Nome Favorecido",
    "CPF do Favorecido",
    "Valor Total do PDF",
    "Base do Motorista"
  ];

  const dataRows = preview.aptos.map((row) => ({
    "Nome Motorista": row.nomeMotorista,
    "Nome Favorecido": row.nomeFavorecido,
    "CPF do Favorecido": row.cpfFavorecido,
    "Valor Total do PDF": row.valorTotalPdf,
    "Base do Motorista": row.baseMotorista
  }));

  const sheet = XLSX.utils.json_to_sheet(dataRows, { header: headers });

  if (dataRows.length === 0) {
    XLSX.utils.sheet_add_aoa(sheet, [headers], { origin: "A1" });
  }

  sheet["!autofilter"] = {
    ref: XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: Math.max(preview.aptos.length, 1), c: 4 }
    })
  };
  sheet["!cols"] = [
    { wch: 28 },
    { wch: 28 },
    { wch: 20 },
    { wch: 18 },
    { wch: 24 }
  ];
  (sheet as XLSX.WorkSheet & { "!freeze"?: unknown })["!freeze"] = {
    xSplit: 0,
    ySplit: 1,
    topLeftCell: "A2",
    activePane: "bottomLeft",
    state: "frozen"
  };

  for (let rowIndex = 1; rowIndex <= preview.aptos.length; rowIndex += 1) {
    const cpfCell = XLSX.utils.encode_cell({ r: rowIndex, c: 2 });
    const valueCell = XLSX.utils.encode_cell({ r: rowIndex, c: 3 });
    const cpfValue = sheet[cpfCell];
    const moneyValue = sheet[valueCell];

    if (cpfValue) {
      cpfValue.t = "s";
      cpfValue.z = "@";
    }

    if (moneyValue) {
      moneyValue.t = "n";
      moneyValue.z = 'R$ #,##0.00';
    }
  }

  for (let col = 0; col <= 4; col += 1) {
    const ref = XLSX.utils.encode_cell({ r: 0, c: col });
    const cell = sheet[ref];

    if (cell) {
      cell.s = {
        font: {
          bold: true
        }
      };
    }
  }

  XLSX.utils.book_append_sheet(workbook, sheet, "Aptos para Pagamento");

  if (preview.inconsistencias.length > 0) {
    const inconsistencyRows = preview.inconsistencias.map((row) => ({
      "ID do processo": row.processoId,
      "ID do motorista": row.motoristaId,
      "Nome do motorista": row.nomeMotorista,
      "Periodo": row.periodo,
      "Motivo da inconsistência": row.motivo,
      "Campo ausente ou inválido": row.campo
    }));

    const inconsistencySheet = XLSX.utils.json_to_sheet(inconsistencyRows);
    inconsistencySheet["!autofilter"] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: Math.max(preview.inconsistencias.length, 1), c: 5 }
      })
    };
    inconsistencySheet["!cols"] = [
      { wch: 36 },
      { wch: 36 },
      { wch: 28 },
      { wch: 20 },
      { wch: 44 },
      { wch: 28 }
    ];
    XLSX.utils.book_append_sheet(workbook, inconsistencySheet, "Inconsistências");
  }

  return XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
    compression: true
  });
}

export async function buildAptosPagamentoPreview(periodId: string, baseId?: string | null) {
  return buildCandidateRows(periodId, baseId || null);
}

export async function buildAptosPagamentoWorkbook(periodId: string, baseId?: string | null) {
  const preview = await buildCandidateRows(periodId, baseId || null);
  const buffer = buildWorkbook(preview);

  return {
    preview,
    buffer
  };
}
