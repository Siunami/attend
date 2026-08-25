import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectSources } from "../src/inspect.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-inspect-"));
  await mkdir(join(root, "notes"));
  await Promise.all([
    writeFile(join(root, "notes", "a.md"), "# Launch\n\n2026-08-20: 12 teams.\n2026-08-25: 18 teams.\n"),
    writeFile(join(root, "notes", "b.txt"), "No dated figure here.\n"),
    writeFile(join(root, "notes", "ignored.csv"), "date,value\n2026-08-25,99\n"),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("inspect returns deterministic source-shape observations without source text", async (t) => {
  const root = await fixture(t);
  const request = {
    version: 1,
    goal: "Find structures worth testing",
    sources: [{ path: "notes" }, { path: "notes" }],
  };
  const first = await inspectSources({ root, request });
  const second = await inspectSources({ root, request });

  assert.deepEqual(second, first);
  assert.equal(first.kind, "attend-inspection");
  assert.equal(first.summary.sourceCount, 2);
  assert.equal(first.summary.isoDateCount, 2);
  assert.equal(first.summary.uniqueIsoDateCount, 2);
  assert.deepEqual(first.summary.dateRange, {
    first: "2026-08-20",
    last: "2026-08-25",
  });
  assert.equal(first.summary.omissionCount, 1);
  assert.ok(first.sources.every((source) => !("text" in source)));
  assert.match(first.inspectionHash, /^[a-f0-9]{64}$/u);
});

test("inspect rejects broad or ambiguous source scope at its boundary", async (t) => {
  const root = await fixture(t);
  await assert.rejects(
    inspectSources({
      root,
      request: {
        version: 1,
        goal: "Escape",
        sources: [{ path: "../elsewhere" }],
      },
    }),
    (error) => error?.code === "UNSAFE_INSPECTION_SOURCE",
  );
  await assert.rejects(
    inspectSources({
      root,
      request: {
        version: 1,
        goal: "Unknown",
        sources: [{ path: "notes" }],
        surpriseMe: true,
      },
    }),
    (error) => error?.code === "UNKNOWN_INSPECTION_FIELD",
  );
});
