export type PdfSource = {
  caminhoArquivo?: string | null;
  content?: Buffer | Uint8Array | null;
};

type PdfParserConstructor = new (params: { data: Buffer }) => {
  getText: () => Promise<{ text: string }>;
  destroy?: () => Promise<void>;
};

export async function extractPdfText(buffer: Buffer) {
  try {
    const pdfParseModule = await import("pdf-parse");
    const legacyParser = (pdfParseModule as unknown as { default?: unknown }).default;
    const modernParser = (pdfParseModule as unknown as { PDFParse?: PdfParserConstructor }).PDFParse;
    const parsed =
      typeof legacyParser === "function"
        ? await (legacyParser as (input: Buffer) => Promise<{ text: string }>)(buffer)
        : modernParser
          ? await parseWithModernPdfParser(modernParser, buffer)
          : null;

    return parsed ? String(parsed.text || "").replace(/\s+/g, " ") : null;
  } catch {
    return null;
  }
}

async function parseWithModernPdfParser(PDFParse: PdfParserConstructor, buffer: Buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    return await parser.getText();
  } finally {
    await parser.destroy?.();
  }
}
