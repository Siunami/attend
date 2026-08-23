import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { analyzePhrases } from "../src/analyze.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const JSONL_FIXTURE = fileURLToPath(new URL("./fixtures/corpus/records.jsonl", import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/;

const options = {
  root: FIXTURES,
  inputPaths: ["corpus"],
  question: "Which phrases recur across these notes?",
  target: "Apple notes",
  minWords: 2,
  maxWords: 4,
  minCount: 2,
  minSources: 2,
  limit: 60,
};

function row(packageData, phrase) {
  return packageData.rows.find((candidate) => candidate.phrase === phrase);
}

test("analyzePhrases emits a deterministic, inspectable phrase-list package", async () => {
  const data = await analyzePhrases(options);

  assert.equal(data.schemaVersion, 1);
  assert.equal(data.kind, "attend-data-package");
  assert.match(data.id, /^data_[a-f0-9]{16}$/);
  assert.deepEqual(data.question, {
    text: "Which phrases recur across these notes?",
    target: "Apple notes",
    analysis: "phrase-recurrence",
  });
  assert.deepEqual(data.map, {
    id: "phrase-list",
    version: 1,
    kind: "list",
    rowIdField: "id",
    labelField: "phrase",
    valueField: "occurrenceCount",
    secondaryValueField: "distinctSourceCount",
    evidenceField: "occurrences",
  });
  assert.deepEqual(data.execution, { modelCalls: 0, networkCalls: 0 });
  assert.equal(data.config.minSources, 2);
  assert.deepEqual(data.config.ranking.slice(0, 2), [
    { field: "distinctSourceCount", direction: "desc" },
    { field: "occurrenceCount", direction: "desc" },
  ]);
  assert.match(data.hashes.corpus, SHA256);
  assert.match(data.hashes.config, SHA256);
  assert.match(data.hashes.data, SHA256);
  assert.equal(data.id, `data_${data.hashes.data.slice(0, 16)}`);

  assert.deepEqual(
    data.sources.map((source) => source.displayPath),
    ["corpus/alpha.md", "corpus/nested/beta.txt", "notes/bright.md", "notes/full-width.md"],
  );
  assert.ok(data.sources.every((source) => SHA256.test(source.sha256)));
  assert.ok(data.sources.every((source) => !("text" in source)));
  assert.equal(data.sources.find((source) => source.recordId === "episode-one").hashVerified, true);
  assert.equal(data.sources.some((source) => source.displayPath.endsWith("ignored.csv")), false);

  const appleBuilds = row(data, "apple builds");
  assert.ok(appleBuilds);
  assert.equal(appleBuilds.occurrenceCount, 5);
  assert.equal(appleBuilds.distinctSourceCount, 4);
  assert.equal(appleBuilds.wordCount, 2);
  assert.match(appleBuilds.id, /^phrase_[a-f0-9]{16}$/);
  assert.deepEqual(
    appleBuilds.occurrences.map(({ line, excerpt }) => [line, excerpt]),
    [
      [3, "Apple builds calm tools."],
      [4, "Apple builds calm tools."],
      [1, "APPLE builds calm tools."],
      [1, "Apple builds bright tools."],
      [1, "Ａｐｐｌｅ builds calm tools."],
    ],
  );
  const sourceIds = new Set(data.sources.map((source) => source.id));
  assert.ok(
    data.rows.every((candidate) =>
      candidate.occurrences.every(
        (occurrence) =>
          sourceIds.has(occurrence.sourceId) &&
          Number.isInteger(occurrence.line) &&
          occurrence.line > 0 &&
          Number.isInteger(occurrence.token) &&
          occurrence.token > 0 &&
          occurrence.excerpt,
      ),
    ),
  );

  // NFKC folds full-width Apple into the same row. Inline/fenced code and the
  // URL contain the same words but do not inflate the count above five.
  assert.equal(appleBuilds.occurrenceCount, 5);
  assert.equal(row(data, "calm tools").occurrenceCount, 5);

  // Stopwords are allowed inside a useful phrase, never at its boundaries.
  assert.equal(row(data, "future of work matters").occurrenceCount, 3);
  assert.equal(row(data, "the future"), undefined);
  assert.equal(row(data, "of work"), undefined);

  // Exact shifted occurrence sets let the longer row stand in for redundant
  // overlaps. Shorter phrases with genuinely additional occurrences remain.
  assert.deepEqual(data.rows.map((candidate) => candidate.phrase), [
    "apple builds",
    "calm tools",
    "apple builds calm tools",
    "future of work matters",
  ]);
  assert.equal(row(data, "apple builds calm"), undefined);
  assert.equal(row(data, "builds calm tools"), undefined);
  assert.equal(row(data, "future of work"), undefined);
  assert.ok(data.transformations.some((item) => item.id === "exact-subphrase-suppression"));
});

test("file discovery order and overlapping input scopes do not change the package", async () => {
  const directoryPackage = await analyzePhrases(options);
  const explicitPackage = await analyzePhrases({
    ...options,
    inputPaths: ["corpus/records.jsonl", "corpus/nested", "corpus/alpha.md", "corpus/alpha.md"],
  });

  assert.deepEqual(explicitPackage, directoryPackage);
  assert.equal(JSON.stringify(directoryPackage).includes(FIXTURES), false);
});

test("corpus, configuration, and data hashes describe different change boundaries", async () => {
  const full = await analyzePhrases(options);
  const limited = await analyzePhrases({ ...options, limit: 3 });

  assert.equal(limited.hashes.corpus, full.hashes.corpus);
  assert.notEqual(limited.hashes.config, full.hashes.config);
  assert.notEqual(limited.hashes.data, full.hashes.data);
  assert.equal(limited.rows.length, 3);
  assert.deepEqual(limited.rows, full.rows.slice(0, 3));
});

test("oversized-only input fails without reading and retains the exact omission", async () => {
  await assert.rejects(
    analyzePhrases({
      root: FIXTURES,
      inputPaths: ["oversize"],
      question: "What repeats?",
      target: "fixture",
      maxFileBytes: 16,
    }),
    (error) => {
      assert.equal(error.code, "NO_SOURCES");
      assert.deepEqual(error.omissions, [{
        id: "file-too-large",
        path: "oversize/large.txt",
        skipped: true,
        byteLength: 79,
        maxFileBytes: 16,
        reason: "The file exceeded maxFileBytes and was not read.",
      }]);
      return true;
    },
  );
});

test("a JSONL container may exceed the ceiling when each logical record fits", async () => {
  assert.ok((await stat(JSONL_FIXTURE)).size > 64);
  const data = await analyzePhrases({
    root: FIXTURES,
    inputPaths: ["corpus/records.jsonl"],
    question: "What phrases appear?",
    target: "JSONL fixture",
    minCount: 1,
    maxFileBytes: 64,
  });

  assert.equal(data.sources.length, 2);
  assert.ok(data.sources.every((source) => source.byteLength <= 64));
  assert.equal(data.knownOmissions.some((item) => item.id === "file-too-large"), false);
  assert.equal(data.knownOmissions.some((item) => item.id === "record-too-large"), false);
});

test("invalid analysis bounds and paths fail closed", async () => {
  await assert.rejects(() => analyzePhrases({ ...options, minWords: 0 }), /minWords/);
  await assert.rejects(() => analyzePhrases({ ...options, minSources: 0 }), /minSources/);
  await assert.rejects(
    () => analyzePhrases({ ...options, minWords: 4, maxWords: 2 }),
    /greater than or equal/,
  );
  await assert.rejects(
    () => analyzePhrases({ ...options, inputPaths: ["../outside"] }),
    /escapes root/,
  );
});

test("recursive discovery excludes hidden and dependency directories unless explicit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "attend-source-scope-"));
  await Promise.all([
    mkdir(join(root, "notes"), { recursive: true }),
    mkdir(join(root, ".private"), { recursive: true }),
    mkdir(join(root, "node_modules", "package"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "notes", "visible.md"), "Quiet maps recur. Quiet maps remain.\n"),
    writeFile(join(root, ".private", "hidden.md"), "Hidden phrase repeats. Hidden phrase repeats.\n"),
    writeFile(
      join(root, "node_modules", "package", "README.md"),
      "Dependency noise repeats. Dependency noise repeats.\n",
    ),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const recursive = await analyzePhrases({
    root,
    inputPaths: ["."],
    question: "What recurs?",
  });
  assert.deepEqual(recursive.sources.map((source) => source.displayPath), ["notes/visible.md"]);
  assert.ok(recursive.knownOmissions.some((item) => item.path === ".private"));
  assert.ok(recursive.knownOmissions.some((item) => item.path === "node_modules"));

  const explicit = await analyzePhrases({
    root,
    inputPaths: [".private"],
    question: "What private phrase recurs?",
  });
  assert.deepEqual(explicit.sources.map((source) => source.displayPath), [".private/hidden.md"]);
});

test("phrases never cross sentence-like punctuation or spaced and unspaced dashes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "attend-phrase-boundary-"));
  await writeFile(
    join(root, "note.txt"),
    "Signal phrase — Boundary word. Signal phrase—Boundary word.\n",
  );
  t.after(() => rm(root, { recursive: true, force: true }));

  const data = await analyzePhrases({
    root,
    inputPaths: ["note.txt"],
    question: "What recurs?",
    minWords: 2,
    maxWords: 2,
    minSources: 1,
  });
  assert.ok(row(data, "signal phrase"));
  assert.ok(row(data, "boundary word"));
  assert.equal(row(data, "phrase boundary"), undefined);
  assert.equal(row(data, "word signal"), undefined);
  assert.equal(row(data, "phrase-boundary"), undefined);
});

test("cross-note breadth is required and ranks before repetition within one note", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "attend-source-breadth-"));
  await Promise.all([
    writeFile(
      join(root, "boilerplate.md"),
      Array.from({ length: 10 }, () => "Meeting boilerplate.").join(" "),
    ),
    ...Array.from({ length: 5 }, (_, index) =>
      writeFile(join(root, `shared-${index}.md`), "Cross note signal."),
    ),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const defaults = await analyzePhrases({
    root,
    inputPaths: ["."],
    question: "Which phrases recur across notes?",
    minWords: 2,
    maxWords: 3,
  });
  assert.deepEqual(defaults.rows.map((candidate) => candidate.phrase), [
    "cross note signal",
  ]);

  const includingOneSource = await analyzePhrases({
    root,
    inputPaths: ["."],
    question: "Which phrases repeat anywhere in the corpus?",
    minWords: 2,
    maxWords: 3,
    minSources: 1,
  });
  assert.deepEqual(
    includingOneSource.rows.slice(0, 2).map(({ phrase, distinctSourceCount }) => ({
      phrase,
      distinctSourceCount,
    })),
    [
      { phrase: "cross note signal", distinctSourceCount: 5 },
      { phrase: "meeting boilerplate", distinctSourceCount: 1 },
    ],
  );
});
