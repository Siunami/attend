import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadSources,
  MAX_JSONL_CONTAINER_BYTES,
  MAX_SOURCE_CORPUS_BYTES,
} from "../src/sources.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "attend-source-security-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("an explicitly named path cannot traverse an intermediate symbolic link", async (t) => {
  const base = await fixture(t);
  const root = join(base, "root");
  const outside = join(base, "outside");
  await mkdir(root);
  await mkdir(join(outside, "nested"), { recursive: true });
  await writeFile(join(outside, "nested", "secret.txt"), "outside secret repeats outside secret\n");
  await symlink(outside, join(root, "bridge"));

  const loaded = await loadSources({
    root,
    inputPaths: ["bridge/nested/secret.txt"],
  });

  assert.deepEqual(loaded.sources, []);
  assert.deepEqual(loaded.omissions, [{
    id: "symbolic-link",
    path: "bridge/nested/secret.txt",
    skipped: true,
    reason: "Symbolic links are not followed.",
  }]);
});

test("JSONL containers and aggregate source bytes have non-bypassable hard ceilings", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "records.jsonl"), `${JSON.stringify({ text: "small text" })}\n`);
  await writeFile(join(root, "alpha.txt"), "1234567890");
  await writeFile(join(root, "beta.txt"), "abcdefghij");

  await assert.rejects(
    loadSources({
      root,
      inputPaths: ["records.jsonl"],
      maxJsonlContainerBytes: 8,
    }),
    /JSONL container exceeds hard limit/u,
  );
  await assert.rejects(
    loadSources({
      root,
      inputPaths: ["alpha.txt", "beta.txt"],
      maxFileBytes: 100,
      maxCorpusBytes: 15,
    }),
    /source corpus exceeds hard limit/u,
  );
  await assert.rejects(
    loadSources({
      root,
      inputPaths: ["alpha.txt"],
      maxCorpusBytes: MAX_SOURCE_CORPUS_BYTES + 1,
    }),
    /maxCorpusBytes must be an integer between/u,
  );
  await assert.rejects(
    loadSources({
      root,
      inputPaths: ["records.jsonl"],
      maxJsonlContainerBytes: MAX_JSONL_CONTAINER_BYTES + 1,
    }),
    /maxJsonlContainerBytes must be an integer between/u,
  );
});
