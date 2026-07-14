import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { fetchObjectBuffer } from "./storage.js";

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

async function extractTotalGeralValue(storageKey: string | null | undefined) {
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
      /Total\s*Geral\s*[:\-]?\s*R?\$?\s*([\d.]+,\d{2})/i.exec(text) ||
      /Total Geral\s*[:\-]?\s*([\d.]+,\d{2})/i.exec(text);

    return match?.[1] ? parseMoneyNumber(match[1]) : null;
  } catch {
    return null;
  }
}

export async function backfillPaymentTotalsFromMirrorPdfs() {
  const uploads = await prisma.uploadPdf.findMany({
    where: {
      status: {
        not: "removido"
      },
      valorTotalPdf: null,
      caminhoArquivo: {
        startsWith: "uploads/"
      }
    },
    select: {
      id: true,
      caminhoArquivo: true,
      valorTotalPdf: true
    }
  });

  let updated = 0;

  for (const upload of uploads) {
    const total = await extractTotalGeralValue(upload.caminhoArquivo);

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
