import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { analyzePhrases, analyzePhrasesWithEvidence } from "../src/analyze.js";
import {
  buildEvidencePacket,
  ensureEvidenceStore,
  evidenceStorePath,
  EVIDENCE_LIMITS,
  validateEvidenceStore,
  writeEvidenceStore,
} from "../src/evidence.js";
import { buildSelection } from "../src/selection.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

const analysisOptions = {
  root: FIXTURES,
  inputPaths: ["corpus"],
  question: "Which phrases recur across these notes?",
  target: "fixture notes",
  minWords: 2,
  maxWords: 4,
  minCount: 2,
  minSources: 2,
  limit: 60,
};

function selected(dataPackage, phrase) {
  const row = dataPackage.rows.find((candidate) => candidate.phrase === phrase);
  assert.ok(row, `missing phrase row: ${phrase}`);
  return buildSelection(dataPackage, {
    revision: 1,
    selectedIds: [row.id],
    query: "",
    minCount: dataPackage.config.minCount,
    sort: { by: "distinctSourceCount", direction: "desc" },
    sourceScope: { mode: "all", sourceIds: [] },
  });
}

test("analysis keeps source bodies private while producing a hash-linked evidence store", async () => {
  const plain = await analyzePhrases(analysisOptions);
  const { dataPackage, evidenceStore } = await analyzePhrasesWithEvidence(analysisOptions);

  assert.deepEqual(dataPackage, plain);
  assert.ok(dataPackage.sources.every((source) => !("text" in source)));
  assert.equal(evidenceStore.kind, "attend-evidence-store");
  assert.equal(evidenceStore.dataPackageId, dataPackage.id);
  assert.equal(evidenceStore.dataHash, dataPackage.hashes.data);
  assert.equal(evidenceStore.corpusHash, dataPackage.hashes.corpus);
  assert.equal(evidenceStore.sources.length, dataPackage.sources.length);
  assert.ok(evidenceStore.sources.every((source) => typeof source.text === "string"));
  assert.equal(
    validateEvidenceStore({ dataPackage, evidenceStore }),
    evidenceStore,
  );
});

test("a packet includes every implicated source body in full when it fits", async () => {
  const { dataPackage, evidenceStore } = await analyzePhrasesWithEvidence(analysisOptions);
  const selection = selected(dataPackage, "apple builds");
  const packet = buildEvidencePacket({ dataPackage, evidenceStore, selection });
  const implicated = new Set(
    dataPackage.rows
      .find((row) => row.phrase === "apple builds")
      .occurrences.map((occurrence) => occurrence.sourceId),
  );

  assert.equal(packet.kind, "attend-evidence-packet");
  assert.equal(packet.selectionId, selection.id);
  assert.equal(packet.coverage.selectedSourceCount, implicated.size);
  assert.equal(packet.coverage.includedSourceCount, implicated.size);
  assert.equal(packet.coverage.complete, true);
  assert.equal(packet.coverage.truncatedSourceCount, 0);
  assert.equal(packet.coverage.sampling, "full-source/v1");
  assert.deepEqual(new Set(packet.sources.map((source) => source.sourceId)), implicated);
  for (const source of packet.sources) {
    assert.equal(source.contentComplete, true);
    assert.equal(source.includedByteLength, source.sourceByteLength);
    assert.equal(source.segments.length, 1);
    const stored = evidenceStore.sources.find((candidate) => candidate.id === source.sourceId);
    assert.equal(source.segments[0].text, stored.text);
    assert.equal(source.sourceSha256, stored.sourceSha256);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(packet), "utf8") <= EVIDENCE_LIMITS.defaultPacketBytes);
});

test("oversized selections retain every source with deterministic bounded segments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "attend-evidence-packet-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repeated = Array.from(
    { length: 2_000 },
    (_, index) => `Shared thread entry ${index}. Detail ${index} remains inspectable.`,
  ).join("\n");
  await Promise.all([
    writeFile(join(root, "alpha.md"), `# Alpha\n${repeated}\nAlpha ending.`),
    writeFile(join(root, "beta.md"), `# Beta\n${repeated}\nBeta ending.`),
  ]);
  const { dataPackage, evidenceStore } = await analyzePhrasesWithEvidence({
    root,
    inputPaths: ["alpha.md", "beta.md"],
    question: "What recurs?",
    minWords: 2,
    maxWords: 2,
    minSources: 2,
    limit: 10,
  });
  const selection = selected(dataPackage, "shared thread");
  const packet = buildEvidencePacket({
    dataPackage,
    evidenceStore,
    selection,
    maxBytes: 16 * 1024,
  });
  const again = buildEvidencePacket({
    dataPackage,
    evidenceStore,
    selection,
    maxBytes: 16 * 1024,
  });

  assert.deepEqual(again, packet);
  assert.equal(Buffer.byteLength(JSON.stringify(packet), "utf8") <= 16 * 1024, true);
  assert.equal(packet.coverage.selectedSourceCount, 2);
  assert.equal(packet.coverage.includedSourceCount, 2);
  assert.equal(packet.coverage.complete, false);
  assert.equal(packet.coverage.truncatedSourceCount, 2);
  assert.equal(packet.coverage.sampling, "head-middle-tail/v1");
  for (const source of packet.sources) {
    assert.equal(source.contentComplete, false);
    assert.ok(source.includedByteLength > 0);
    const original = evidenceStore.sources.find((candidate) => candidate.id === source.sourceId).text;
    for (const segment of source.segments) {
      assert.equal(
        original.slice(segment.startCharacter, segment.endCharacter),
        segment.text,
      );
    }
  }
});

test("an empty selection returns a small explicit complete packet", async () => {
  const { dataPackage, evidenceStore } = await analyzePhrasesWithEvidence(analysisOptions);
  const packet = buildEvidencePacket({
    dataPackage,
    evidenceStore,
    selection: null,
  });
  assert.deepEqual(packet.sources, []);
  assert.deepEqual(packet.coverage, {
    selectedSourceCount: 0,
    includedSourceCount: 0,
    selectedByteCount: 0,
    includedByteCount: 0,
    complete: true,
    truncatedSourceCount: 0,
    sampling: "full-source/v1",
  });
});

test("legacy analysis migration re-reads recorded inputs and verifies every hash", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "attend-evidence-migration-"));
  await mkdir(join(root, "notes"));
  await Promise.all([
    writeFile(join(root, "notes", "one.md"), "Shared signal appears.\n"),
    writeFile(join(root, "notes", "two.md"), "Shared signal remains.\n"),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataPackage = await analyzePhrases({
    root,
    inputPaths: ["notes"],
    question: "What recurs?",
    minWords: 2,
    maxWords: 2,
    minSources: 2,
  });

  const migrated = await ensureEvidenceStore({ root, dataPackage });
  assert.equal(migrated.sources.length, 2);
  assert.equal(
    JSON.parse(await readFile(evidenceStorePath({ root, dataPackageId: dataPackage.id }), "utf8")).id,
    migrated.id,
  );
});

test("legacy migration fails closed after source mutation or a symlink substitution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "attend-evidence-stale-"));
  const outside = await mkdtemp(join(tmpdir(), "attend-evidence-outside-"));
  await writeFile(join(root, "note.md"), "Stable phrase repeats. Stable phrase repeats.\n");
  await writeFile(join(outside, "note.md"), "Changed private content.\n");
  t.after(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });
  const dataPackage = await analyzePhrases({
    root,
    inputPaths: ["note.md"],
    question: "What recurs?",
    minSources: 1,
  });
  await unlink(join(root, "note.md"));
  await symlink(join(outside, "note.md"), join(root, "note.md"));

  await assert.rejects(
    ensureEvidenceStore({ root, dataPackage }),
    (error) => error.code === "EVIDENCE_REGENERATION_REQUIRED" && /Rerun `attend phrases`/u.test(error.message),
  );
});

test("new stores can be persisted privately and loaded without source re-reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "attend-evidence-write-"));
  await writeFile(join(root, "note.md"), "Stable phrase repeats. Stable phrase repeats.\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  const { dataPackage, evidenceStore } = await analyzePhrasesWithEvidence({
    root,
    inputPaths: ["note.md"],
    question: "What recurs?",
    minSources: 1,
  });
  const path = await writeEvidenceStore({ root, dataPackage, evidenceStore });
  await unlink(join(root, "note.md"));

  assert.equal(path, evidenceStorePath({ root, dataPackageId: dataPackage.id }));
  assert.equal((await ensureEvidenceStore({ root, dataPackage })).id, evidenceStore.id);
});
