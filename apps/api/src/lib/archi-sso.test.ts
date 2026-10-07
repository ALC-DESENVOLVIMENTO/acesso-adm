import assert from "node:assert/strict";
import test from "node:test";
import { createArchiSsoExchangeCache, isAllowedArchiSsoRole } from "./archi-sso.js";

test("allows Analista de Risco to authenticate through ARCHI SSO", () => {
  assert.equal(isAllowedArchiSsoRole("Analista de Risco"), true);
});

test("keeps the existing SSO role allowlist and rejects unrelated profiles", () => {
  for (const role of ["Administrativo", "Administrador", "Fiscal & Financeiro"]) {
    assert.equal(isAllowedArchiSsoRole(role), true);
  }

  for (const role of ["Captação", "Dispatchers", "Gerente", "", null, undefined]) {
    assert.equal(isAllowedArchiSsoRole(role), false);
  }
});

test("reuses the same exchange result for repeated requests with one jti", async () => {
  const exchangeOnce = createArchiSsoExchangeCache<{ session: string }>();
  let executions = 0;
  const exchange = async () => ({ session: `session-${++executions}` });

  const [first, duplicate] = await Promise.all([
    exchangeOnce("jti-1", Math.floor(Date.now() / 1000) + 60, exchange),
    exchangeOnce("jti-1", Math.floor(Date.now() / 1000) + 60, exchange)
  ]);

  assert.deepEqual(duplicate, first);
  assert.equal(executions, 1);
});

test("allows retrying an exchange after a transient failure", async () => {
  const exchangeOnce = createArchiSsoExchangeCache<string>();
  let executions = 0;
  const expiresAt = Math.floor(Date.now() / 1000) + 60;

  await assert.rejects(exchangeOnce("jti-2", expiresAt, async () => {
    executions += 1;
    throw new Error("temporary failure");
  }));
  const retried = await exchangeOnce("jti-2", expiresAt, async () => {
    executions += 1;
    return "authenticated";
  });

  assert.equal(retried, "authenticated");
  assert.equal(executions, 2);
});
