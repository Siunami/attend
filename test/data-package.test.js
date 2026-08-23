import assert from "node:assert/strict";
import test from "node:test";

import { compileMap } from "../src/pipeline/compile.js";
import {
  DataPackageContractError,
  canonicalJson,
  canonicalize,
  sha256Hex,
  stableId,
  validateDataPackage,
  verifyDataPackageHashes,
} from "../src/pipeline/data-package.js";

function fixture() {
  return {
    familyId: "rank",
    question: { text: "Which themes recur most?", target: "Fixture notes" },
    roleMapping: { label: "label", value: "value" },
    sourceBundle: {
      kind: "attend-normalized-source-bundle",
      schemaVersion: 1,
      adapter: { id: "fixture-adapter", version: 1 },
      medium: "structured",
      requestedInputs: ["fixtures/records.jsonl"],
      sources: [{
        id: "src_fixture",
        displayPath: "fixtures/records.jsonl",
        sha256: "b".repeat(64),
        kind: "normalized-records",
        byteLength: 800,
      }],
      records: [
        { id: "record_alpha", sourceId: "src_fixture", fields: { label: "Alpha", value: 8 } },
        { id: "record_beta", sourceId: "src_fixture", fields: { label: "Beta", value: 5 } },
      ],
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("canonical JSON, SHA-256, and stable ids are browser-compatible and deterministic", async () => {
  const left = { zebra: 1, alpha: { two: 2, one: 1 }, list: [3, 2, 1] };
  const right = { list: [3, 2, 1], alpha: { one: 1, two: 2 }, zebra: 1 };
  assert.deepEqual(canonicalize(left), canonicalize(right));
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(await sha256Hex("Attend"), await sha256Hex("Attend"));
  assert.match(await sha256Hex("Attend"), /^[a-f0-9]{64}$/);
  assert.equal(await stableId("mark", left), await stableId("mark", right));
  assert.throws(() => canonicalJson({ value: undefined }), { code: "NON_JSON_VALUE" });
  assert.throws(() => canonicalJson({ value: Number.NaN }), { code: "NON_JSON_VALUE" });
});

test("a compiled package has independently verifiable corpus, config, data, and package hashes", async () => {
  const dataPackage = await compileMap(fixture());
  assert.equal(validateDataPackage(dataPackage), dataPackage);
  assert.equal(await verifyDataPackageHashes(dataPackage), true);
  assert.match(dataPackage.id, /^data_[a-f0-9]{16}$/);
  assert.equal(dataPackage.id, `data_${dataPackage.hashes.package.slice(0, 16)}`);
  assert.deepEqual(Object.keys(dataPackage.hashes).sort(), ["algorithm", "config", "corpus", "data", "package"]);
  assert.ok(dataPackage.sources.every((source) => !("text" in source) && !("content" in source)));
  assert.ok(dataPackage.marks.every((mark) => mark.evidenceRefs[0].locator));
});

test("structural validation rejects duplicate marks, dangling evidence, and mismatched family payloads", async () => {
  const original = await compileMap(fixture());

  const duplicate = clone(original);
  duplicate.marks.push(clone(duplicate.marks[0]));
  assert.throws(
    () => validateDataPackage(duplicate),
    (error) => error instanceof DataPackageContractError && error.code === "DUPLICATE_MARK",
  );

  const danglingEvidence = clone(original);
  danglingEvidence.marks[0].evidenceRefs[0].sourceId = "src_missing";
  assert.throws(() => validateDataPackage(danglingEvidence), { code: "DANGLING_EVIDENCE_REF" });

  const wrongPayload = clone(original);
  wrongPayload.payload.kind = "attend-trend-payload";
  assert.throws(() => validateDataPackage(wrongPayload), { code: "INVALID_PAYLOAD" });

  const leakedSource = clone(original);
  leakedSource.sources[0].text = "raw private source body";
  assert.throws(() => validateDataPackage(leakedSource), { code: "PUBLIC_SOURCE_CONTENT" });
});

test("hash verification detects otherwise structurally valid mutation", async () => {
  const original = await compileMap(fixture());
  const mutated = clone(original);
  mutated.question.text = "A different question with stale hashes";
  assert.equal(validateDataPackage(mutated), mutated);
  await assert.rejects(
    verifyDataPackageHashes(mutated),
    (error) => error instanceof DataPackageContractError && error.code === "HASH_MISMATCH" && error.path === "dataPackage.hashes.config",
  );
});
