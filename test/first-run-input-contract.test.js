import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { analyzePhrases } from "../src/analyze.js";
import { run } from "../src/cli.js";
import { readJson } from "../src/project.js";

function capture() {
  let contents = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        contents += chunk.toString();
        callback();
      },
    }),
    text: () => contents,
    json: () => JSON.parse(contents.trim()),
  };
}

async function temporaryProject(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-first-run-"));
  await Promise.all([
    mkdir(join(root, ".git")),
    mkdir(join(root, "notes")),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function expectNoSources(action) {
  await assert.rejects(action, (error) => {
    assert.equal(error?.code, "NO_SOURCES");
    assert.match(error.message, /no readable supported sources/iu);
    return true;
  });
}

test("an explicitly named unsupported file is skipped with an inspectable omission", async (t) => {
  const root = await temporaryProject(t);
  await Promise.all([
    writeFile(join(root, "notes", "kept.md"), "Visible signal returns. Visible signal remains.\n"),
    writeFile(join(root, "notes", "skipped.csv"), "Hidden signal,Hidden signal\n"),
  ]);

  const dataPackage = await analyzePhrases({
    root,
    inputPaths: ["notes/kept.md", "notes/skipped.csv"],
    question: "What language repeats?",
    minCount: 1,
    minSources: 1,
  });

  assert.deepEqual(
    dataPackage.sources.map((source) => source.displayPath),
    ["notes/kept.md"],
  );
  assert.equal(dataPackage.rows.some((row) => row.phrase === "hidden signal"), false);

  const unsupported = dataPackage.knownOmissions.filter(
    (omission) => omission.id === "unsupported-file",
  );
  assert.equal(unsupported.length, 1);
  assert.equal(unsupported[0].path, "notes/skipped.csv");
  assert.match(unsupported[0].reason, /not supported|unsupported/iu);
});

test("analysis fails clearly when every explicit input is unsupported", async (t) => {
  const root = await temporaryProject(t);
  await writeFile(join(root, "notes", "only.csv"), "Repeated phrase,Repeated phrase\n");

  await expectNoSources(() =>
    analyzePhrases({
      root,
      inputPaths: ["notes/only.csv"],
      question: "What language repeats?",
    }),
  );
});

test("analysis fails clearly when every supported input exceeds the read ceiling", async (t) => {
  const root = await temporaryProject(t);
  await writeFile(
    join(root, "notes", "only.txt"),
    "This otherwise supported source is intentionally larger than the configured ceiling.\n",
  );

  await expectNoSources(() =>
    analyzePhrases({
      root,
      inputPaths: ["notes/only.txt"],
      question: "What language repeats?",
      maxFileBytes: 16,
    }),
  );
});

test("successful CLI output reports skipped inputs without counting analyzer limitations", async (t) => {
  const root = await temporaryProject(t);
  await Promise.all([
    writeFile(join(root, "notes", "one.md"), "Local context matters. Local context lasts.\n"),
    writeFile(join(root, "notes", "two.txt"), "Local context stays inspectable.\n"),
    writeFile(join(root, "notes", "unsupported.csv"), "Local context,local context\n"),
    writeFile(
      join(root, "notes", "warning.jsonl"),
      `${JSON.stringify({
        id: "hash-warning",
        text: "Local context keeps exact evidence.",
        sourceSha256: "0".repeat(64),
      })}\n`,
    ),
  ]);

  const setupOutput = capture();
  await run(["setup", "--json"], {
    cwd: root,
    stdout: setupOutput.stream,
    stderr: setupOutput.stream,
  });
  assert.equal(setupOutput.json().ok, true);

  const args = [
    "phrases",
    "notes/one.md",
    "notes/two.txt",
    "notes/unsupported.csv",
    "notes/warning.jsonl",
    "--question",
    "What language repeats?",
  ];
  const jsonOutput = capture();
  await run([...args, "--json"], {
    cwd: root,
    stdout: jsonOutput.stream,
    stderr: jsonOutput.stream,
  });
  const result = jsonOutput.json();
  assert.equal(result.ok, true);
  assert.equal(result.sourceCount, 3);
  assert.equal(result.skippedInputCount, 1);
  assert.equal(result.omissionCount, undefined);

  const storedPackage = await readJson(result.analysisPath);
  assert.equal(storedPackage.knownOmissions.length > result.skippedInputCount, true);
  assert.ok(storedPackage.knownOmissions.some((omission) => omission.id === "unsupported-file"));
  assert.ok(storedPackage.knownOmissions.some((omission) => omission.id === "source-hash-mismatch"));

  const humanOutput = capture();
  await run(args, {
    cwd: root,
    stdout: humanOutput.stream,
    stderr: humanOutput.stream,
  });
  assert.match(humanOutput.text(), /skipped 1 input/iu);
  assert.doesNotMatch(humanOutput.text(), /skipped [4-9]|omission(?:s)?:? [4-9]/iu);

  // The repeated run still points at a complete, readable analysis package.
  assert.equal((await readFile(result.analysisPath, "utf8")).includes("unsupported-file"), true);
});
