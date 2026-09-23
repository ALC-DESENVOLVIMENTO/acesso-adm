import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { test } from "node:test";

process.env.DATABASE_URL ||= "postgresql://user:password@localhost:5432/test";
const { driverMatchesBase, getDriverBases } = await import("./driver-registry.js");

test("reads primary and additional bases from ARCHI compressed extra data", () => {
  const payload = `grzjson:${gzipSync(Buffer.from(JSON.stringify({ bases: ["CRAVINHOS", "RIBEIRAO PRETO"] }))).toString("base64")}`;
  const row = { base: "CRAVINHOS", extra_data: payload };

  assert.deepEqual(getDriverBases(row), ["CRAVINHOS", "RIBEIRAO PRETO"]);
  assert.equal(driverMatchesBase(row, "RIBEIRAO PRETO"), true);
  assert.equal(driverMatchesBase(row, "RIBEIRAO"), false);
});
