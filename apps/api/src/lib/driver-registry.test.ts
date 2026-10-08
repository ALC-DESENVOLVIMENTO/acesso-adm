import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

process.env.DATABASE_URL ||= "postgresql://user:password@localhost:5432/test";
const {
  buildDriverRegistryInsertPlaceholders,
  confirmsDriverIdentityAcrossBase,
  driverMatchesBase,
  getDriverBases
} = await import("./driver-registry.js");

test("casts UUID registry IDs when building parameterized insert placeholders", () => {
  assert.deepEqual(
    buildDriverRegistryInsertPlaceholders(["id", "display_name"], new Map([["id", "uuid"], ["display_name", "text"]])),
    ["$1::uuid", "$2"]
  );
});

test("does not cast registry IDs when the source column is text", () => {
  assert.deepEqual(
    buildDriverRegistryInsertPlaceholders(["id", "display_name"], new Map([["id", "text"], ["display_name", "text"]])),
    ["$1", "$2"]
  );
});

test("reads primary and additional bases from ARCHI compressed extra data", () => {
  const payload = `grzjson:${gzipSync(Buffer.from(JSON.stringify({ bases: ["CRAVINHOS", "RIBEIRAO PRETO"] }))).toString("base64")}`;
  const row = { base: "CRAVINHOS", extra_data: payload };

  assert.deepEqual(getDriverBases(row), ["CRAVINHOS", "RIBEIRAO PRETO"]);
  assert.equal(driverMatchesBase(row, "RIBEIRAO PRETO"), true);
  assert.equal(driverMatchesBase(row, "RIBEIRAO"), false);
});

test("reads additional bases from ARCHI compressed driver form payload", () => {
  const payload = `grzjson:${gzipSync(Buffer.from(JSON.stringify({ bases: ["CRAVINHOS", "RIBEIRAO PRETO"] }))).toString("base64")}`;
  const row = { base: "CRAVINHOS", form_payload: payload };

  assert.deepEqual(getDriverBases(row), ["CRAVINHOS", "RIBEIRAO PRETO"]);
  assert.equal(driverMatchesBase(row, "RIBEIRAO PRETO"), true);
});

test("allows a base mismatch only when exact driver name and CNPJ confirm identity", () => {
  const match = {
    nome: "Carlos Augusto Lopes Ferreira",
    cnpj: "12.345.678/0001-90",
    cpf: "123.456.789-00",
    cpfDigits: "12345678900"
  };

  assert.equal(confirmsDriverIdentityAcrossBase(match, {
    name: "CARLOS AUGUSTO LOPES FERREIRA",
    cnpj: "12345678000190"
  }), true);
  assert.equal(confirmsDriverIdentityAcrossBase(match, {
    name: "Carlos Augusto Lopes Ferreira",
    cnpj: "12345678000190",
    cpf: "00000000000"
  }), false);
  assert.equal(confirmsDriverIdentityAcrossBase(match, {
    name: "Carlos Augusto Lopes",
    cnpj: "12345678000190"
  }), false);
  assert.equal(confirmsDriverIdentityAcrossBase(match, {
    name: "Carlos Augusto Lopes Ferreira"
  }), false);
});
