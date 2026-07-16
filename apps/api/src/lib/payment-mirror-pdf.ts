import { extractPdfText } from "./pdf-text.js";

export type PaymentMirrorIdentity = {
  cnpj: string;
  name: string;
};

const CNPJ_PATTERN = String.raw`(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2})`;
const IDENTITY_END_PATTERN = String.raw`(?=\s+\d{2}\/\d{2}\/\d{4}\b|\s+Total\s+Geral\b|$)`;

export function parsePaymentMirrorIdentity(text: string | null | undefined): PaymentMirrorIdentity | null {
  if (!text) {
    return null;
  }

  const normalizedText = text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const bracketMatch = new RegExp(
    String.raw`\[\s*${CNPJ_PATTERN}\s*\]\s*[-–—]\s*(.+?)${IDENTITY_END_PATTERN}`,
    "iu"
  ).exec(normalizedText);
  const labeledMatch = new RegExp(
    String.raw`\bCNPJ(?:\s+do\s+cadastro)?\s*[:\-]?\s*${CNPJ_PATTERN}\s*(?:[-–—]|Nome\s*[:\-])\s*(.+?)${IDENTITY_END_PATTERN}`,
    "iu"
  ).exec(normalizedText);
  const match = bracketMatch || labeledMatch;
  const cnpj = String(match?.[1] || "").replace(/\D/g, "");
  const name = String(match?.[2] || "").trim();

  if (cnpj.length !== 14 || !name) {
    return null;
  }

  return { cnpj, name };
}

export async function extractPaymentMirrorIdentity(buffer: Buffer) {
  const text = await extractPdfText(buffer);
  return parsePaymentMirrorIdentity(text);
}
