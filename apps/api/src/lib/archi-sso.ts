const ARCHI_SSO_ALLOWED_ROLES = new Set([
  "Administrativo",
  "Administrador",
  "Fiscal & Financeiro",
  "Analista de Risco"
]);

export function isAllowedArchiSsoRole(role: unknown): role is string {
  return typeof role === "string" && ARCHI_SSO_ALLOWED_ROLES.has(role);
}
