const ARCHI_SSO_ALLOWED_ROLES = new Set([
  "Administrativo",
  "Administrador",
  "Fiscal & Financeiro",
  "Analista de Risco"
]);

export function isAllowedArchiSsoRole(role: unknown): role is string {
  return typeof role === "string" && ARCHI_SSO_ALLOWED_ROLES.has(role);
}

export function createArchiSsoExchangeCache<T>() {
  const exchanges = new Map<string, { expiresAt: number; result: Promise<T> }>();

  return async (jti: string, expiresAt: number, exchange: () => Promise<T>): Promise<T> => {
    const now = Math.floor(Date.now() / 1000);
    for (const [key, value] of exchanges) {
      if (value.expiresAt <= now) exchanges.delete(key);
    }

    const existing = exchanges.get(jti);
    if (existing) return existing.result;

    const result = Promise.resolve().then(exchange);
    exchanges.set(jti, { expiresAt, result });
    try {
      return await result;
    } catch (error) {
      if (exchanges.get(jti)?.result === result) exchanges.delete(jti);
      throw error;
    }
  };
}
