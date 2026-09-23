import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { extractPdfText, type PdfSource } from "./pdf-text.js";
import { fetchObjectBuffer } from "./storage.js";

export function parseMoneyNumber(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const normalized = String(value).replace(/[^\d,.-]/g, "");
  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  const decimalIndex = Math.max(lastComma, lastDot);
  const canonical = decimalIndex >= 0
    ? `${normalized.slice(0, decimalIndex).replace(/[.,]/g, "")}.${normalized.slice(decimalIndex + 1)}`
    : normalized;

  const parsed = Number(canonical);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function extractPdfTextFromSource(source: PdfSource | null | undefined) {
  if (!source) {
    return null;
  }

  const candidateBuffer =
    source.content && source.content.length > 0
      ? Buffer.from(source.content)
      : source.caminhoArquivo
        ? (await fetchObjectBuffer(source.caminhoArquivo).catch(() => null))?.body || null
        : null;

  if (!candidateBuffer) {
    return null;
  }

  return extractPdfText(candidateBuffer);
}

export async function extractTotalGeralValueFromSource(source: PdfSource | null | undefined) {
  const text = await extractPdfTextFromSource(source);
  if (!text) {
    return null;
  }

  const normalizedText = text.replace(/\u00a0/g, " ").replace(/\s+/g, " ");
  const moneyToken = "(-?(?:\\d{1,3}(?:[.,]\\d{3})+|\\d+)(?:[.,]\\d{2})?)";
  const patterns = [
    new RegExp(`Total\\s*Geral\\s*:?\\s*(?:R?\\$?\\s*)?${moneyToken}`, "i"),
    new RegExp(`Total\\s*(?:Liquido|Líquido|Final)\\s*:?\\s*(?:R?\\$?\\s*)?${moneyToken}`, "i")
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(normalizedText);
    if (match?.[1]) {
      return parseMoneyNumber(match[1]);
    }
  }

  const markerIndex = normalizedText.toLowerCase().lastIndexOf("total geral");
  if (markerIndex >= 0) {
    const excerpt = normalizedText.slice(markerIndex, markerIndex + 240);
    const excerptMatch = /(-?(?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{2})?)/.exec(excerpt);
    if (excerptMatch?.[1]) {
      return parseMoneyNumber(excerptMatch[1]);
    }
  }

  const allAmounts = Array.from(normalizedText.matchAll(/((?:\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,]\d{2})?)/g));
  if (allAmounts.length > 0) {
    return parseMoneyNumber(allAmounts.at(-1)?.[1] || null);
  }

  return null;
}

export async function backfillPaymentTotalsFromMirrorPdfs() {
  const uploads = await prisma.uploadPdf.findMany({
    where: {
      status: {
        not: "removido"
      },
      documentType: "espelho",
      valorTotalPdf: null
    },
    select: {
      id: true,
      caminhoArquivo: true,
      valorTotalPdf: true,
      content: true,
      motoristaId: true,
      periodoPagamentoId: true,
      basePagamentoId: true
    }
  });

  let updated = 0;

  for (const upload of uploads) {
    const total =
      (await extractTotalGeralValueFromSource({
        caminhoArquivo: upload.caminhoArquivo,
        content: upload.content
      })) ??
      (await extractTotalGeralValueFromSource(
        await resolveAdditionalMirrorSource(upload.id, upload.motoristaId, upload.periodoPagamentoId, upload.basePagamentoId)
      ));

    if (total === null) {
      continue;
    }

    await prisma.uploadPdf.update({
      where: { id: upload.id },
      data: {
        valorTotalPdf: new Prisma.Decimal(total)
      }
    });
    updated += 1;
  }

  return updated;
}

async function resolveAdditionalMirrorSource(
  uploadId: string,
  motoristaId: string | null,
  periodoPagamentoId: string | null,
  basePagamentoId: string | null
): Promise<PdfSource | null> {
  const receipt = await prisma.driverPdfReceived.findFirst({
    where: {
      OR: [
        {
          uploadPdfId: uploadId
        },
        ...(motoristaId && periodoPagamentoId && basePagamentoId
          ? [
              {
                motoristaId,
                periodoPagamentoId,
                basePagamentoId,
                documentType: "espelho",
                caminhoArquivo: {
                  startsWith: "uploads/"
                }
              }
            ]
          : [])
      ]
    },
    orderBy: {
      uploadEm: "desc"
    },
    select: {
      caminhoArquivo: true,
      content: true
    }
  });

  return receipt || null;
}
