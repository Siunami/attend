import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OPPORTUNITY_COUNT_MAX,
  OPPORTUNITY_REASONS,
  createOpportunityCheck,
  listOpportunityChecks,
  loadOpportunityCheck,
  opportunityPaths,
  publicOpportunityCheck,
} from "../src/opportunity-store.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-opportunity-"));
  await mkdir(join(root, ".git"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function request(overrides = {}) {
  const base = {
    boundary: {
      kind: "before-final-answer",
      id: "turn-01:final",
    },
    host: {
      kind: "codex",
      skillVersion: "attend-visualize/0.5.5",
    },
    taskShape: {
      action: "review",
      evidenceState: "scoped-sources",
      resultShape: "network",
      visualJobs: ["relationship", "network"],
    },
    sourceShape: {
      origin: "self-report",
      sourceCount: 8,
      recordCount: 42,
      numericTokenCount: 6,
      isoDateCount: 2,
      omissionCount: 0,
    },
    decision: {
      kind: "abstain",
      reason: "text-suffices",
      confidence: 0.84,
      interruptionCost: 0.15,
    },
  };
  return {
    ...base,
    ...overrides,
    boundary: { ...base.boundary, ...overrides.boundary },
    host: { ...base.host, ...overrides.host },
    taskShape: { ...base.taskShape, ...overrides.taskShape },
    sourceShape: { ...base.sourceShape, ...overrides.sourceShape },
    decision: { ...base.decision, ...overrides.decision },
  };
}

function clock(value) {
  return () => new Date(value);
}

test("abstain and proceed decisions create strict immutable receipts", async (t) => {
  const root = await fixture(t);
  const abstain = await createOpportunityCheck({
    root,
    request: request(),
    now: clock("2026-08-25T20:00:00.000Z"),
  });
  const proceed = await createOpportunityCheck({
    root,
    request: request({
      boundary: { id: "turn-02:final" },
      decision: {
        kind: "proceed",
        reason: "visual-worth-testing",
        confidence: 0.91,
        interruptionCost: 0.12,
      },
      inspectionHash: "a".repeat(64),
    }),
    now: clock("2026-08-25T20:01:00.000Z"),
  });

  assert.match(abstain.id, /^checkpoint_[a-f0-9]{24}$/u);
  assert.equal(abstain.decision.kind, "abstain");
  assert.equal(proceed.decision.kind, "proceed");
  assert.equal(proceed.inspectionHash, "a".repeat(64));
  assert.match(abstain.boundary.idempotencyDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    await loadOpportunityCheck({ root, checkpointId: abstain.id }),
    abstain,
  );
  assert.deepEqual(
    (await listOpportunityChecks({ root })).map((record) => record.id),
    [proceed.id, abstain.id],
  );

  const publicRecord = publicOpportunityCheck(abstain);
  assert.deepEqual(publicRecord.boundary, { kind: "before-final-answer" });
  assert.equal(JSON.stringify(publicRecord).includes("idempotencyDigest"), false);
});

test("unknown and content-bearing fields are rejected at every object boundary", async (t) => {
  const root = await fixture(t);
  const cases = [
    request({ prompt: "chart this" }),
    request({ boundary: { message: "the user message" } }),
    request({ host: { ticket: "opaque-host-ticket" } }),
    request({ taskShape: { content: "source body" } }),
    request({ sourceShape: { sourceText: "private source text" } }),
    request({ decision: { rationale: "free-form model rationale" } }),
  ];
  for (const value of cases) {
    await assert.rejects(
      createOpportunityCheck({ root, request: value }),
      (error) => error?.code === "INVALID_OPPORTUNITY_REQUEST",
    );
  }
  await assert.rejects(
    stat(opportunityPaths(root).salt),
    (error) => error?.code === "ENOENT",
  );
});

test("absolute paths, host tickets, content ids, and credentials cannot cross the boundary", async (t) => {
  const root = await fixture(t);
  for (const id of [
    "/Users/alice/private",
    "C:\\Users\\alice\\private",
    "ticket_opaque123",
    "host-ticket:opaque123",
    "codex-ticket-opaque123",
    "prompt:private-message",
    "api-key-privatevalue",
    "sk-proj-0123456789abcdef",
  ]) {
    await assert.rejects(
      createOpportunityCheck({ root, request: request({ boundary: { id } }) }),
      (error) => error?.code === "INVALID_OPPORTUNITY_REQUEST",
      id,
    );
  }
  await assert.rejects(
    createOpportunityCheck({
      root,
      request: request({ host: { skillVersion: "Bearer abcdefghijklmnop" } }),
    }),
    (error) => error?.code === "INVALID_OPPORTUNITY_REQUEST",
  );
});

test("the project salt is private and raw boundary ids never reach stored state", async (t) => {
  const root = await fixture(t);
  const rawBoundaryId = "turn-private-6f15d0:final";
  const record = await createOpportunityCheck({
    root,
    request: request({ boundary: { id: rawBoundaryId } }),
  });
  const paths = opportunityPaths(root, record.id);
  const saltInfo = await stat(paths.salt);
  assert.equal(saltInfo.mode & 0o777, 0o600);
  assert.equal((await readFile(paths.salt)).length, 32);
  assert.equal((await readFile(paths.salt)).includes(Buffer.from(rawBoundaryId)), false);
  assert.equal((await readFile(paths.checkpoint, "utf8")).includes(rawBoundaryId), false);

  await chmod(paths.salt, 0o644);
  await assert.rejects(
    createOpportunityCheck({
      root,
      request: request({ boundary: { id: "turn-next:final" } }),
    }),
    (error) => error?.code === "UNSAFE_CHECKPOINT_SALT",
  );
});

test("exact retries converge and changed same-boundary requests conflict", async (t) => {
  const root = await fixture(t);
  const value = request();
  const first = await createOpportunityCheck({
    root,
    request: value,
    now: clock("2026-08-25T20:00:00.000Z"),
  });
  const retry = await createOpportunityCheck({
    root,
    request: structuredClone(value),
    now: clock("2026-08-25T21:00:00.000Z"),
  });
  assert.deepEqual(retry, first);
  assert.equal((await readdir(opportunityPaths(root).directory)).length, 1);

  await assert.rejects(
    createOpportunityCheck({
      root,
      request: request({ decision: { confidence: 0.83 } }),
    }),
    (error) => error?.code === "OPPORTUNITY_IDEMPOTENCY_CONFLICT",
  );
  assert.deepEqual(
    await loadOpportunityCheck({ root, checkpointId: first.id }),
    first,
  );
});

test("concurrent exact retries create one salt and one checkpoint", async (t) => {
  const root = await fixture(t);
  const records = await Promise.all(
    Array.from({ length: 24 }, () => createOpportunityCheck({
      root,
      request: request(),
      now: clock("2026-08-25T20:00:00.000Z"),
    })),
  );
  assert.equal(new Set(records.map((record) => record.id)).size, 1);
  assert.equal((await listOpportunityChecks({ root })).length, 1);
  assert.equal((await readFile(opportunityPaths(root).salt)).length, 32);
});

test("concurrent differing payloads cannot claim the same boundary", async (t) => {
  const root = await fixture(t);
  const results = await Promise.allSettled([
    createOpportunityCheck({ root, request: request() }),
    createOpportunityCheck({
      root,
      request: request({
        decision: {
          kind: "proceed",
          reason: "visual-worth-testing",
          confidence: 0.9,
          interruptionCost: 0.1,
        },
      }),
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(
    results.find((result) => result.status === "rejected").reason.code,
    "OPPORTUNITY_IDEMPOTENCY_CONFLICT",
  );
  assert.equal((await listOpportunityChecks({ root })).length, 1);
});

test("source shape, task shape, decision, and hash remain bounded enums and counters", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(OPPORTUNITY_REASONS, [
    "evidence-not-bounded",
    "no-bounded-evidence",
    "no-analytic-job",
    "no-executable-family",
    "source-not-authorized",
    "task-incomplete",
    "text-suffices",
    "too-few-records",
    "weak-hypothesis",
    "interruption-cost",
    "visual-worth-testing",
  ]);
  const invalid = [
    request({ sourceShape: { origin: "inspection" } }),
    request({ sourceShape: { recordCount: OPPORTUNITY_COUNT_MAX + 1 } }),
    request({ sourceShape: { sourceCount: -1 } }),
    request({ taskShape: { action: "browse" } }),
    request({ taskShape: { visualJobs: ["relationship", "relationship"] } }),
    request({ decision: { confidence: 1.01 } }),
    request({ decision: { reason: "too-small" } }),
    request({ decision: { kind: "proceed", reason: "text-suffices" } }),
    request({ inspectionHash: "A".repeat(64) }),
  ];
  for (const value of invalid) {
    await assert.rejects(
      createOpportunityCheck({ root, request: value }),
      (error) => error?.code === "INVALID_OPPORTUNITY_REQUEST",
    );
  }
});

test("load rejects a stored record with fields outside the schema", async (t) => {
  const root = await fixture(t);
  const record = await createOpportunityCheck({ root, request: request() });
  const path = opportunityPaths(root, record.id).checkpoint;
  const tampered = { ...record, transcript: "must not survive" };
  await writeFile(path, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
  await assert.rejects(
    loadOpportunityCheck({ root, checkpointId: record.id }),
    (error) => error?.code === "INVALID_OPPORTUNITY_RECORD",
  );
});
