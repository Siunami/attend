import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { analyzePhrases, analyzePhrasesWithEvidence } from "../src/analyze.js";
import {
  buildEvidencePacket,
  ensureEvidenceStore,
  evidencePacketForSelection,
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

function selected(dataPackage, ...phrases) {
  const rows = phrases.map((phrase) => {
    const row = dataPackage.rows.find((candidate) => candidate.phrase === phrase);
    assert.ok(row, `missing phrase row: ${phrase}`);
    return row;
  });
  return buildSelection(dataPackage, {
    revision: 1,
    selectedIds: rows.map((row) => row.id),
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

test("a store mutated after a successful load is re-verified and rejected", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "attend-evidence-reload-"));
  await writeFile(join(root, "note.md"), "Stable phrase repeats. Stable phrase repeats.\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  const { dataPackage, evidenceStore } = await analyzePhrasesWithEvidence({
    root,
    inputPaths: ["note.md"],
    question: "What recurs?",
    minSources: 1,
  });
  const path = await writeEvidenceStore({ root, dataPackage, evidenceStore });
  assert.equal((await ensureEvidenceStore({ root, dataPackage })).id, evidenceStore.id);
  const loadedSize = (await stat(path)).size;

  const stored = JSON.parse(await readFile(path, "utf8"));
  stored.sources[0].text = `${stored.sources[0].text}Smuggled sentence appended after the first load.\n`;
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`);
  assert.notEqual((await stat(path)).size, loadedSize);

  await assert.rejects(
    ensureEvidenceStore({ root, dataPackage }),
    (error) => error.code === "EVIDENCE_STORE_INVALID",
  );
});

test("a loaded packet honours an explicit byte budget below the default", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "attend-evidence-budget-"));
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
  await writeEvidenceStore({ root, dataPackage, evidenceStore });
  const packet = await evidencePacketForSelection({
    root,
    dataPackage,
    selection: selected(dataPackage, "shared thread"),
    maxBytes: 64 * 1024,
  });

  assert.equal(packet.kind, "attend-evidence-packet");
  assert.ok(Buffer.byteLength(JSON.stringify(packet), "utf8") <= 64 * 1024);
  assert.equal(packet.sources.length, 2);
  assert.equal(packet.coverage.includedSourceCount, 2);
  assert.equal(packet.coverage.complete, false);
  assert.equal(packet.coverage.sampling, "head-middle-tail/v1");
});

test("a two-mark selection covers the deduplicated union of both marks' sources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "attend-evidence-union-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines = (prefix) => Array.from(
    { length: 40 },
    (_, index) => `${prefix} entry ${index}.`,
  ).join("\n");
  await Promise.all([
    writeFile(join(root, "alpha.md"), `${lines("Shared thread")}\n`),
    writeFile(join(root, "beta.md"), `${lines("Shared thread")}\n${lines("Distinct signal")}\n`),
    writeFile(join(root, "gamma.md"), `${lines("Distinct signal")}\n`),
  ]);
  const { dataPackage, evidenceStore } = await analyzePhrasesWithEvidence({
    root,
    inputPaths: ["alpha.md", "beta.md", "gamma.md"],
    question: "What recurs?",
    minWords: 2,
    maxWords: 2,
    minSources: 2,
    limit: 60,
  });
  const idFor = (displayPath) =>
    dataPackage.sources.find((source) => source.displayPath === displayPath).id;
  const packet = buildEvidencePacket({
    dataPackage,
    evidenceStore,
    selection: selected(dataPackage, "shared thread", "distinct signal"),
  });
  const sourceIds = packet.sources.map((source) => source.sourceId);

  assert.equal(packet.coverage.selectedSourceCount, 3);
  assert.equal(sourceIds.length, 3);
  assert.equal(new Set(sourceIds).size, 3);
  assert.deepEqual(
    new Set(sourceIds),
    new Set([idFor("alpha.md"), idFor("beta.md"), idFor("gamma.md")]),
  );
});

test("an unchanged store is served without reopening its file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "attend-evidence-reuse-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "note.md"), "Stable phrase repeats. Stable phrase repeats.\n");
  const { dataPackage, evidenceStore } = await analyzePhrasesWithEvidence({
    root,
    inputPaths: ["note.md"],
    question: "What recurs?",
    minSources: 1,
  });
  const path = await writeEvidenceStore({ root, dataPackage, evidenceStore });
  await ensureEvidenceStore({ root, dataPackage });
  // An unreadable file is the only way to observe that the second load skipped
  // the read and the source-body rebuild behind it.
  await chmod(path, 0o000);

  assert.equal((await ensureEvidenceStore({ root, dataPackage })).id, evidenceStore.id);
});

test("a warm packet matches the caller-supplied one it skips a verification to produce", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "attend-evidence-verify-count-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repeated = Array.from(
    { length: 3_000 },
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
  await writeEvidenceStore({ root, dataPackage, evidenceStore });
  const selection = selected(dataPackage, "shared thread");
  const request = { root, dataPackage, selection, maxBytes: 64 * 1024 };

  assert.deepEqual(
    await evidencePacketForSelection(request),
    buildEvidencePacket({ dataPackage, evidenceStore, selection, maxBytes: 64 * 1024 }),
  );

  // The warm path skips the verification the caller-supplied path still runs.
  // That is purely a cost difference, so the only thing a test can assert is
  // that both still produce the same packet. Asserting the saving itself needs
  // wall-clock timing, which a shared CI runner cannot hold steady.
  assert.equal(
    (await evidencePacketForSelection(request)).hashes.packet,
    buildEvidencePacket({ dataPackage, evidenceStore, selection, maxBytes: 64 * 1024 }).hashes.packet,
  );
});
