export type RiskReviewCategoriesInput = {
  matched: boolean;
  ambiguous: boolean;
  archiStatus?: string | null;
  uploadedCnpj?: string | null;
  officialCnpj?: string | null;
  uploadedBase?: string | null;
  officialBases?: Array<string | null | undefined>;
};

const digitsOnly = (value: string | null | undefined) => String(value || "").replace(/\D/g, "");
const normalize = (value: string | null | undefined) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const comparable = (value: string | null | undefined) => normalize(value).replace(/[^a-z0-9]/g, "");

export function classifyRiskReview(input: RiskReviewCategoriesInput) {
  if (input.ambiguous) return ["IDENTIFICAÇÃO AMBÍGUA"];
  if (!input.matched) return ["CADASTRO SEM GR"];

  const categories: string[] = [];
  const status = normalize(input.archiStatus);
  if (status.includes("reprov") || status.includes("rejeit")) categories.push("REPROVADO GR");
  else if (status.includes("analise") || status.includes("andamento") || status.includes("pre selecao")) {
    categories.push("EM ANDAMENTO");
  }

  const uploadedCnpj = digitsOnly(input.uploadedCnpj);
  const officialCnpj = digitsOnly(input.officialCnpj);
  if (!officialCnpj) categories.push("CNPJ NÃO INFORMADO");
  else if (uploadedCnpj && uploadedCnpj !== officialCnpj) categories.push("CNPJ DIVERGENTE DO ARCHI");

  const base = comparable(input.uploadedBase);
  const officialBases = (input.officialBases || []).filter(Boolean);
  if (base && officialBases.length && !officialBases.some((item) => comparable(item) === base)) {
    categories.push("BASE DIVERGENTE");
  }
  return categories;
}
