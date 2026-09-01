import assert from "node:assert/strict";
import test from "node:test";

import {
  catalogReceiptForMember,
  historicalCatalogReceiptForMember,
} from "../src/catalog/index.js";
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
      adapter: { id: "evidenced-records-v1", version: 1 },
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
        { id: "record_gamma", sourceId: "src_fixture", fields: { label: "Gamma", value: 3 } },
      ],
    },
  };
}

function trendFixture() {
  return {
    catalog: catalogReceiptForMember("trend", "line"),
    familyId: "trend",
    question: { text: "How did the values change?", target: "Fixture records" },
    roleMapping: { time: "time", value: "value" },
    sourceBundle: {
      kind: "attend-normalized-source-bundle",
      schemaVersion: 1,
      adapter: { id: "evidenced-records-v1", version: 1 },
      medium: "structured",
      requestedInputs: ["fixtures/trend.jsonl"],
      sources: [{
        id: "src_trend_fixture",
        displayPath: "fixtures/trend.jsonl",
        sha256: "d".repeat(64),
        kind: "normalized-records",
        byteLength: 1_200,
      }],
      records: Array.from({ length: 12 }, (_, index) => ({
        id: `record_trend_${String(index + 1).padStart(2, "0")}`,
        sourceId: "src_trend_fixture",
        fields: { time: `2026-${String(index + 1).padStart(2, "0")}-01`, value: index + 1 },
      })),
    },
  };
}

function contactFixture() {
  const records = Array.from({ length: 12 }, (_, index) => {
    const assetId = `asset_${(index + 1).toString(16).padStart(32, "0")}`;
    const previewRoute = `assets/${assetId}`;
    const label = `Image ${index + 1}`;
    return {
      id: `observation_${String(index + 1).padStart(4, "0")}`,
      sourceId: "src_contact_fixture",
      fields: {
        assetId,
        previewRoute,
        label,
        captureTime: `2026-01-${String(index + 1).padStart(2, "0")}T12:00:00`,
        order: index,
        width: 1_200,
        height: 800,
        orientation: 1,
      },
      media: {
        type: "image",
        mimeType: "image/jpeg",
        width: 1_200,
        height: 800,
        preview: {
          kind: "image",
          src: previewRoute,
          label,
          aspectRatio: 1.5,
        },
      },
    };
  });
  return {
    catalog: catalogReceiptForMember("collection-atlas", "contact-atlas"),
    familyId: "collection-atlas",
    question: {
      text: "How did this photo collection unfold?",
      target: "Fixture image set",
      analyticJob: "collection-atlas:contact-atlas",
    },
    roleMapping: {
      assetId: "fields.assetId",
      previewRoute: "fields.previewRoute",
      label: "fields.label",
      captureTime: "fields.captureTime",
      order: "fields.order",
      width: "fields.width",
      height: "fields.height",
      orientation: "fields.orientation",
    },
    sourceBundle: {
      kind: "attend-normalized-source-bundle",
      schemaVersion: 1,
      adapter: { id: "local-image-set-v1", version: 1 },
      medium: "image",
      requestedInputs: ["image-set/fixture"],
      sources: [{
        id: "src_contact_fixture",
        displayPath: "images/source_contact_fixture.jpg",
        sha256: "c".repeat(64),
        kind: "image-file",
        byteLength: 2_048,
        mediaType: "image",
        mimeType: "image/jpeg",
      }],
      records,
    },
    options: { availableWidth: 1_200, mediaType: "image" },
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

test("current and historical packages require typed source-backed mark roles", async () => {
  const current = await compileMap(fixture());
  const historicalVersions = ["3904c28aabcbc405", "3bcb588eaf291763"];
  const bases = [current];
  for (const version of historicalVersions) {
    const historical = clone(current);
    historical.catalog = historicalCatalogReceiptForMember(version, "rank", "bar-list");
    bases.push(await rehash(historical));
  }

  for (const [index, base] of bases.entries()) {
    assert.equal(validateDataPackage(base), base, `baseline ${index}`);

    const missing = clone(base);
    delete missing.marks[0].values.value;
    delete missing.payload.items.find((item) => item.markId === missing.marks[0].id).value;
    missing.payload.valueExtent = null;
    const missingRehashed = await rehash(missing);
    assert.throws(
      () => validateDataPackage(missingRehashed),
      (error) => error.code === "MISSING_REQUIRED_ROLE_VALUE",
      `missing required role ${index}`,
    );

    const wrongType = clone(base);
    wrongType.marks[0].values.value = "8";
    wrongType.payload.items.find((item) => item.markId === wrongType.marks[0].id).value = "8";
    const wrongTypeRehashed = await rehash(wrongType);
    assert.throws(
      () => validateDataPackage(wrongTypeRehashed),
      (error) => error.code === "INVALID_ROLE_VALUE",
      `wrong role type ${index}`,
    );

    const divergentPayload = clone(base);
    const payloadItem = divergentPayload.payload.items.find((item) => item.markId === divergentPayload.marks[0].id);
    delete payloadItem.value;
    const divergentRehashed = await rehash(divergentPayload);
    assert.throws(
      () => validateDataPackage(divergentRehashed),
      (error) => error.code === "PAYLOAD_ROLE_MISMATCH",
      `payload role mismatch ${index}`,
    );

    const injectedOptionalRole = clone(base);
    injectedOptionalRole.payload.items
      .find((item) => item.markId === injectedOptionalRole.marks[0].id)
      .group = "forged payload-only group";
    const injectedOptionalRoleRehashed = await rehash(injectedOptionalRole);
    assert.throws(
      () => validateDataPackage(injectedOptionalRoleRehashed),
      (error) => error.code === "PAYLOAD_ROLE_MISMATCH",
      `payload-only optional role ${index}`,
    );

    const foreignDerivedField = clone(base);
    foreignDerivedField.payload.items[0].share = 0.99;
    const foreignDerivedFieldRehashed = await rehash(foreignDerivedField);
    assert.throws(
      () => validateDataPackage(foreignDerivedFieldRehashed),
      (error) => error.code === "UNKNOWN_FIELD",
      `foreign derived payload field ${index}`,
    );
  }

  const invalidTrend = trendFixture();
  invalidTrend.sourceBundle.records[0].fields.time += " ".repeat(16_384);
  await assert.rejects(
    compileMap(invalidTrend),
    (error) => error.code === "INVALID_ROLE_VALUE",
  );

  const currentTrend = await compileMap(trendFixture());
  const trendBases = [currentTrend];
  for (const version of historicalVersions) {
    const historicalTrend = clone(currentTrend);
    historicalTrend.catalog = historicalCatalogReceiptForMember(version, "trend", "line");
    trendBases.push(await rehash(historicalTrend));
  }
  for (const [index, base] of trendBases.entries()) {
    const overlongTime = clone(base);
    const mark = overlongTime.marks[0];
    const time = `${mark.values.time}${" ".repeat(16_384)}`;
    mark.values.time = time;
    overlongTime.payload.points.find((item) => item.markId === mark.id).time = time;
    const overlongTimeRehashed = await rehash(overlongTime);
    assert.throws(
      () => validateDataPackage(overlongTimeRehashed),
      (error) => error.code === "INVALID_ROLE_VALUE",
      `overlong parseable time ${index}`,
    );
  }
});

test("current and historical packages bind source and transformation receipts across sections", async () => {
  const current = await compileMap(fixture());
  const bases = [current];
  for (const version of ["3904c28aabcbc405", "3bcb588eaf291763"]) {
    const historical = clone(current);
    historical.catalog = historicalCatalogReceiptForMember(version, "rank", "bar-list");
    bases.push(await rehash(historical));
  }

  const attacks = [
    {
      label: "input adapter",
      mutate(value) { value.provenance.inputs.adapter = { id: "forged-adapter", version: 99 }; },
      path: "dataPackage.provenance.inputs.adapter",
    },
    {
      label: "input medium",
      mutate(value) { value.provenance.inputs.medium = "image"; },
      path: "dataPackage.provenance.inputs.medium",
    },
    {
      label: "source ids",
      mutate(value) { value.provenance.inputs.sourceIds = ["src_other"]; },
      path: "dataPackage.provenance.inputs.sourceIds",
    },
    {
      label: "transformation role mapping",
      mutate(value) { value.provenance.transformations[0].roleMapping.label = "fields.forged"; },
      path: "dataPackage.provenance.transformations[0].roleMapping",
    },
    {
      label: "transformation determinism",
      mutate(value) { value.provenance.transformations[0].deterministic = false; },
      path: "dataPackage.provenance.transformations[0].deterministic",
    },
    {
      label: "transformation output count",
      mutate(value) { value.provenance.transformations[0].outputMarkCount += 1; },
      path: "dataPackage.provenance.transformations[0].outputMarkCount",
    },
    {
      label: "quality input medium",
      mutate(value) { value.quality.media.inputMedium = "image"; },
      path: "dataPackage.quality.media",
      code: "INVALID_QUALITY",
    },
  ];

  for (const [baseIndex, base] of bases.entries()) {
    for (const attack of attacks) {
      const forged = clone(base);
      attack.mutate(forged);
      const forgedRehashed = await rehash(forged);
      assert.throws(
        () => validateDataPackage(forgedRehashed),
        (error) => error.code === (attack.code ?? "INVALID_PROVENANCE") && error.path === attack.path,
        `${attack.label} for contract ${baseIndex}`,
      );
    }
  }
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

test("a rehashed contact package cannot redirect staged image assets", async () => {
  const original = await compileMap(contactFixture());
  const assetId = original.payload.items[0].assetId;
  assert.match(assetId, /^asset_[a-f0-9]{32}$/u);
  assert.equal(original.payload.items[0].previewRoute, `assets/${assetId}`);
  assert.equal(original.marks[0].media.preview.src, `assets/${assetId}`);

  const attacks = [
    {
      name: "payload route mismatch",
      mutate(value) {
        value.payload.items[0].previewRoute = `assets/asset_${"f".repeat(32)}`;
      },
    },
    {
      name: "absolute session route",
      mutate(value) {
        const route = `/sessions/session_other/assets/${assetId}`;
        value.payload.items[0].previewRoute = route;
        value.marks[0].values.previewRoute = route;
        value.marks[0].media.preview.src = route;
      },
    },
    {
      name: "cross-session relative route",
      mutate(value) {
        const route = `../session_other/assets/${assetId}`;
        value.payload.items[0].previewRoute = route;
        value.marks[0].values.previewRoute = route;
        value.marks[0].media.preview.src = route;
      },
    },
    {
      name: "non-opaque asset id",
      mutate(value) {
        const injected = "asset_../../session_other";
        value.payload.items[0].assetId = injected;
        value.payload.items[0].previewRoute = `assets/${injected}`;
        value.marks[0].values.assetId = injected;
        value.marks[0].values.previewRoute = `assets/${injected}`;
        value.marks[0].media.preview.src = `assets/${injected}`;
      },
    },
  ];

  for (const attack of attacks) {
    const mutated = clone(original);
    attack.mutate(mutated);
    const forged = await rehash(mutated);
    assert.throws(
      () => validateDataPackage(forged),
      (error) => error.code === "INVALID_CONTACT_ASSET",
      attack.name,
    );
    await assert.rejects(
      verifyDataPackageHashes(forged),
      (error) => error.code === "INVALID_CONTACT_ASSET",
      attack.name,
    );
  }
});

test("contact capture order treats camera-local DST times as lexical values", async () => {
  const input = contactFixture();
  input.sourceBundle.records.forEach((record, index) => {
    record.fields.captureTime = index === 0
      ? "2026-03-08T03:00:00"
      : index === 1
        ? "2026-03-08T02:30:00"
        : `2026-03-08T${String(index + 3).padStart(2, "0")}:00:00`;
  });
  const compiled = await compileMap(input);
  assert.deepEqual(
    compiled.marks.slice(0, 2).map((mark) => mark.values.label),
    ["Image 2", "Image 1"],
  );
  assert.deepEqual(
    compiled.payload.items.slice(0, 2).map((item) => item.label),
    ["Image 2", "Image 1"],
  );
  assert.deepEqual(compiled.payload.captureOrder, compiled.payload.items.map((item) => item.markId));
});

function matrixFixture(options) {
  const rows = ["Wednesday", "Monday", "Tuesday", "Thursday"];
  const columns = ["Morning", "Evening"];
  return {
    catalog: catalogReceiptForMember("matrix", "heatmap"),
    familyId: "matrix",
    question: { text: "When do sessions cluster?", target: "Matrix fixture" },
    roleMapping: { row: "row", column: "column", value: "value" },
    sourceBundle: {
      kind: "attend-normalized-source-bundle",
      schemaVersion: 1,
      adapter: { id: "evidenced-records-v1", version: 1 },
      medium: "structured",
      requestedInputs: ["fixtures/matrix.jsonl"],
      sources: [{
        id: "src_matrix_fixture",
        displayPath: "fixtures/matrix.jsonl",
        sha256: "e".repeat(64),
        kind: "normalized-records",
        byteLength: 900,
      }],
      records: rows.flatMap((row, rowIndex) => columns.map((column, columnIndex) => ({
        id: `record_matrix_${rowIndex + 1}_${columnIndex + 1}`,
        sourceId: "src_matrix_fixture",
        fields: { row, column, value: rowIndex + columnIndex },
      }))),
    },
    ...(options ? { options } : {}),
  };
}

test("a package compiled with a declared category order stays independently verifiable", async () => {
  const dataPackage = await compileMap(matrixFixture({ categoryOrder: { row: ["Thursday", "Wednesday"] } }));

  assert.deepEqual(
    [...new Set(dataPackage.marks.map((mark) => mark.values.row))],
    ["Thursday", "Wednesday", "Monday", "Tuesday"],
  );
  assert.equal(validateDataPackage(dataPackage), dataPackage);
  assert.equal(await verifyDataPackageHashes(dataPackage), true);
});

test("payload category order must stay derivable from the package marks alone", async () => {
  const original = await compileMap(matrixFixture());
  assert.deepEqual(original.payload.rows, ["Monday", "Tuesday", "Wednesday", "Thursday"]);

  const permuted = clone(original);
  permuted.payload.rows = ["Thursday", "Wednesday", "Monday", "Tuesday"];
  assert.throws(() => validateDataPackage(permuted), { code: "INVALID_PAYLOAD" });
});
