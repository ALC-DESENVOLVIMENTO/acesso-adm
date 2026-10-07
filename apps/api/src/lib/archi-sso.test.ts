import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedArchiSsoRole } from "./archi-sso.js";

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
