export const DocumentTypeCode = {
  espelho: "espelho",
  nota_fiscal: "nota_fiscal"
} as const;

export type DocumentTypeCode = (typeof DocumentTypeCode)[keyof typeof DocumentTypeCode];
