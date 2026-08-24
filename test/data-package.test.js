import assert from "node:assert/strict";
import test from "node:test";

import { catalogReceiptForMember } from "../src/catalog/index.js";
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
    catalog: catalogReceiptForMember("rank", "bar-list"),
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

async function rehash(value) {
  const { id: _id, hashes: _hashes, ...base } = clone(value);
  const hashes = {
    algorithm: "sha256",
    corpus: await sha256Hex(canonicalJson({
      scope: base.scope,
      sources: base.sources,
      inputs: base.provenance.inputs,
    })),
    config: await sha256Hex(canonicalJson({
      family: base.family,
      question: base.question,
      roleMapping: base.roleMapping,
      presentation: base.presentation,
      pipeline: base.provenance.pipeline,
      transformations: base.provenance.transformations,
    })),
    data: await sha256Hex(canonicalJson({ marks: base.marks, payload: base.payload })),
  };
  hashes.package = await sha256Hex(canonicalJson({ ...base, hashes }));
  return canonicalize({ ...base, id: `data_${hashes.package.slice(0, 16)}`, hashes });
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
  assert.ok(dataPackage.marks.every((mark) => mark.evidenceRefs.every((reference) => /^evidence_[a-f0-9]{16}$/u.test(reference))));
  assert.ok(dataPackage.marks.every((mark) => !("recordId" in mark)));
  assert.equal(JSON.stringify(dataPackage).includes("\"recordId\""), false);
  assert.equal(JSON.stringify(dataPackage.marks).includes("sourceId"), false);
  assert.equal(JSON.stringify(dataPackage.marks).includes("locator"), false);
  assert.equal(JSON.stringify(dataPackage.marks).includes("excerpt"), false);
  assert.equal(JSON.stringify(dataPackage.marks).includes("quote"), false);
});

test("structural validation rejects duplicate marks, dangling evidence, and mismatched family payloads", async () => {
  const original = await compileMap(fixture());

  const duplicate = clone(original);
  duplicate.marks.push(clone(duplicate.marks[0]));
  assert.throws(
    () => validateDataPackage(duplicate),
    (error) => error instanceof DataPackageContractError && error.code === "DUPLICATE_MARK",
  );

  const nonOpaqueEvidence = clone(original);
  nonOpaqueEvidence.marks[0].evidenceRefs[0] = {
    sourceId: "src_fixture",
    locator: { kind: "row", index: 1 },
  };
  assert.throws(() => validateDataPackage(nonOpaqueEvidence), { code: "INVALID_EVIDENCE_REF" });

  const wrongPayload = clone(original);
  wrongPayload.payload.kind = "attend-trend-payload";
  assert.throws(() => validateDataPackage(wrongPayload), { code: "INVALID_PAYLOAD" });

  const leakedSource = clone(original);
  leakedSource.sources[0].text = "raw private source body";
  assert.throws(() => validateDataPackage(leakedSource), { code: "PUBLIC_SOURCE_CONTENT" });

  const leakedPreviewEvidence = clone(original);
  leakedPreviewEvidence.marks[0].media = {
    type: "text",
    preview: { kind: "text", excerpt: "raw private evidence quote" },
  };
  assert.throws(() => validateDataPackage(leakedPreviewEvidence), { code: "PUBLIC_EVIDENCE_LINK" });

  const leakedPayloadEvidence = clone(original);
  leakedPayloadEvidence.payload.items[0].recordId = "private-record-link";
  assert.throws(() => validateDataPackage(leakedPayloadEvidence), { code: "PUBLIC_EVIDENCE_LINK" });

  const unknownTopLevel = clone(original);
  unknownTopLevel.privateEvidence = {
    quote: "TOP SECRET QUOTE",
    sourceId: "src_private",
    locator: { path: "secret.md" },
  };
  assert.throws(() => validateDataPackage(unknownTopLevel), { code: "UNKNOWN_FIELD" });

  const unknownSourceField = clone(original);
  unknownSourceField.sources[0].privateNote = "not part of the canonical source receipt";
  assert.throws(() => validateDataPackage(unknownSourceField), { code: "UNKNOWN_FIELD" });

  const leakedPresentationEvidence = clone(original);
  leakedPresentationEvidence.presentation.audit = { quote: "private quote" };
  assert.throws(() => validateDataPackage(leakedPresentationEvidence), { code: "UNKNOWN_FIELD" });

  const leakedProvenanceEvidence = clone(original);
  leakedProvenanceEvidence.provenance.audit = { locator: { path: "private.md" } };
  assert.throws(() => validateDataPackage(leakedProvenanceEvidence), { code: "UNKNOWN_FIELD" });
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

test("a correctly rehashed package cannot add nested private metadata to a fixed schema object", async () => {
  const original = await compileMap(fixture());
  const injected = clone(original);
  injected.presentation.audit = { secret: "TOP SECRET QUOTE" };
  const rehashed = await rehash(injected);
  assert.notEqual(rehashed.hashes.package, original.hashes.package);
  assert.throws(() => validateDataPackage(rehashed), { code: "UNKNOWN_FIELD" });
  await assert.rejects(verifyDataPackageHashes(rehashed), { code: "UNKNOWN_FIELD" });
});
