import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildArtifactSelection } from "../src/artifacts/index.js";
import { catalogReceiptForMember } from "../src/catalog/index.js";
import {
  buildEvidencePacket,
  buildEvidenceStore,
  writeEvidenceStore,
} from "../src/evidence.js";
import { compileMap, compileMapWithEvidence } from "../src/pipeline/compile.js";
import { createQuestionWorker } from "../src/question-worker.js";
import { createViewerServer } from "../src/server.js";
import {
  appendQueuedQuestion,
  createSession,
  loadSession,
  sessionFilePath,
  updateSession,
} from "../src/session-store.js";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fixturePackage() {
  const sourceText = "Alpha ranks above Beta and Gamma in the verified fixture.\n";
  const quote = sourceText.trim();
  const evidenceRef = (recordId) => ({
    sourceId: "src_fixture",
    recordId,
    locator: {
      kind: "text-range",
      path: "fixtures/records.jsonl",
      startLine: 1,
      endLine: 1,
      startOffset: 0,
      endOffset: quote.length,
    },
    quote,
  });
  return {
    ...(await compileMapWithEvidence({
      familyId: "rank",
      catalog: catalogReceiptForMember("rank", "bar-list"),
      question: { text: "Which items rank highest?", target: "fixture records" },
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
          sha256: sha256(sourceText),
          kind: "normalized-records",
          byteLength: Buffer.byteLength(sourceText),
        }],
        records: [
          { id: "record_alpha", sourceId: "src_fixture", fields: { label: "Alpha", value: 8 }, evidenceRefs: [evidenceRef("record_alpha")] },
          { id: "record_beta", sourceId: "src_fixture", fields: { label: "Beta", value: 5 }, evidenceRefs: [evidenceRef("record_beta")] },
          { id: "record_gamma", sourceId: "src_fixture", fields: { label: "Gamma", value: 3 }, evidenceRefs: [evidenceRef("record_gamma")] },
        ],
      },
    })),
    sources: [{
      id: "src_fixture",
      displayPath: "fixtures/records.jsonl",
      sha256: sha256(sourceText),
      kind: "normalized-records",
      byteLength: Buffer.byteLength(sourceText),
      text: sourceText,
    }],
  };
}

async function fixtureMechanismPackage() {
  return compileMap({
    familyId: "mechanism",
    catalog: catalogReceiptForMember("mechanism", "flowchart"),
    question: { text: "How does Attend turn a request into a view?", target: "fixture system" },
    roleMapping: { source: "source", target: "target", relation: "relation" },
    sourceBundle: {
      kind: "attend-normalized-source-bundle",
      schemaVersion: 1,
      adapter: { id: "evidenced-records-v1", version: 1 },
      medium: "structured",
      requestedInputs: ["fixtures/mechanism.jsonl"],
      sources: [{
        id: "src_mechanism",
        displayPath: "fixtures/mechanism.jsonl",
        sha256: "c".repeat(64),
        kind: "normalized-records",
        byteLength: 600,
      }],
      records: [
        { id: "record_ask", sourceId: "src_mechanism", fields: { source: "host agent", target: "Attend", relation: "asks" } },
        { id: "record_compile", sourceId: "src_mechanism", fields: { source: "Attend", target: "canonical package", relation: "compiles" } },
        { id: "record_verify", sourceId: "src_mechanism", fields: { source: "Attend", target: "exact quotes", relation: "verifies" } },
      ],
    },
  });
}

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "attend-atlas-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const VIEWER_ASSETS = fileURLToPath(new URL("../viewer/", import.meta.url));

function api(viewerUrl, route) {
  return new URL(`api/${route}`, viewerUrl);
}

async function post(viewerUrl, route, body) {
  return fetch(api(viewerUrl, route), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: new URL(viewerUrl).origin,
    },
    body: JSON.stringify(body),
  });
}

test("atlas-v2 sessions persist mark ids, freeze server-derived attachments, and fail closed on a tampered package", async (t) => {
  const root = await project(t);
  const { dataPackage } = await fixturePackage();
  const created = await createSession({ root, dataPackage, id: "atlas_session" });
  assert.deepEqual(created.state, { revision: 0, markIds: [] });
  assert.deepEqual(created.view, {
    id: "rank",
    version: dataPackage.family.version,
    rendererId: dataPackage.presentation.renderer.id,
    rendererVersion: dataPackage.presentation.renderer.version,
  });

  const markId = dataPackage.marks[0].id;
  const selected = await updateSession({
    root,
    sessionId: created.id,
    expectedRevision: 0,
    patch: { markIds: [markId] },
  });
  assert.deepEqual(selected.state, { revision: 1, markIds: [markId] });
  await assert.rejects(
    updateSession({
      root,
      sessionId: created.id,
      expectedRevision: 0,
      patch: { markIds: [] },
    }),
    { code: "CONFLICT" },
  );

  const liveSelection = buildArtifactSelection(selected.dataPackage, selected.state);
  const queued = await appendQueuedQuestion({
    root,
    sessionId: created.id,
    expectedRevision: 1,
    turn: {
      id: "turn_atlas_question",
      role: "user",
      content: "What supports this rank?",
      selection: {
        id: liveSelection.id,
        sourceRefs: [{ sourceId: "agent_invented" }],
      },
    },
  });
  const stored = queued.conversation.turns.at(-1);
  assert.deepEqual(stored.selection.selectedMarkIds, [markId]);
  assert.deepEqual(stored.selection.evidenceRefIds, dataPackage.marks[0].evidenceRefs);
  assert.equal("sourceRefs" in stored.selection, false);
  assert.equal("recordId" in stored.selection.marks[0], false);
  assert.equal(JSON.stringify(stored.selection).includes("src_fixture"), false);
  assert.equal(JSON.stringify(stored.selection).includes("locator"), false);
  assert.equal(JSON.stringify(stored.selection).includes("agent_invented"), false);
  assert.deepEqual(queued.state.markIds, []);

  const path = sessionFilePath({ root, sessionId: created.id });
  // Warm the load cache first. Atlas packages are the only ones whose verify
  // step recomputes hashes, so this is where a cache could hide a tamper.
  await loadSession({ root, sessionId: created.id });
  const tampered = JSON.parse(await readFile(path, "utf8"));
  tampered.dataPackage.question.text = "tampered after canonical compilation";
  await writeFile(path, `${JSON.stringify(tampered)}\n`);
  await assert.rejects(loadSession({ root, sessionId: created.id }), { code: "HASH_MISMATCH" });
  await assert.rejects(
    updateSession({
      root,
      sessionId: created.id,
      expectedRevision: 2,
      patch: { markIds: [] },
    }),
    { code: "HASH_MISMATCH" },
  );
  assert.equal(
    JSON.parse(await readFile(path, "utf8")).dataPackage.question.text,
    "tampered after canonical compilation",
    "a failed integrity check must not rewrite the session",
  );
});

test("atlas-v2 evidence packets derive selected source bodies from private opaque-reference linkage", async () => {
  const { dataPackage, sources, evidenceReferences } = await fixturePackage();
  const evidenceStore = buildEvidenceStore({ dataPackage, sources, evidenceReferences });
  const selection = buildArtifactSelection(dataPackage, {
    revision: 3,
    markIds: [dataPackage.marks[0].id],
  });
  const packet = buildEvidencePacket({ dataPackage, evidenceStore, selection });
  assert.equal(packet.dataPackageId, dataPackage.id);
  assert.deepEqual(packet.sources.map((source) => source.sourceId), ["src_fixture"]);
  assert.match(packet.sources[0].segments[0].text, /Alpha ranks above Beta/u);
});

test("atlas-v2 evidence stores reject a private link whose opaque id no longer matches its verified quote locator", async () => {
  const { dataPackage, sources, evidenceReferences } = await fixturePackage();
  const tampered = structuredClone(evidenceReferences);
  tampered[0].locator.startOffset = 1;
  assert.throws(
    () => buildEvidenceStore({ dataPackage, sources, evidenceReferences: tampered }),
    { code: "EVIDENCE_REFERENCE_INVALID" },
  );
});

test("atlas-v2 question work uses the frozen mark attachment and its private evidence packet", async (t) => {
  const root = await project(t);
  const { dataPackage, sources, evidenceReferences } = await fixturePackage();
  await writeEvidenceStore({
    root,
    dataPackage,
    evidenceStore: buildEvidenceStore({ dataPackage, sources, evidenceReferences }),
  });
  const session = await createSession({ root, dataPackage, id: "atlas_worker" });
  const marked = await updateSession({
    root,
    sessionId: session.id,
    expectedRevision: 0,
    patch: { markIds: [dataPackage.marks[0].id] },
  });
  const selection = buildArtifactSelection(marked.dataPackage, marked.state);
  const queued = await appendQueuedQuestion({
    root,
    sessionId: session.id,
    expectedRevision: 1,
    turn: {
      id: "turn_atlas_worker",
      role: "user",
      content: "Explain this selected rank.",
      selection: { id: selection.id },
    },
  });
  const questionId = queued.conversation.turns.at(-1).id;
  let request;
  const worker = createQuestionWorker({
    root,
    capability: { available: true, authenticated: true },
    runner: {
      respond: async (value) => {
        request = value;
        return { answer: "Alpha is ranked highest in the verified fixture." };
      },
    },
  });
  t.after(() => worker.close());

  await worker.enqueueQuestion({ sessionId: session.id, questionId });
  await worker.whenIdle();
  assert.deepEqual(request.selection.selectedMarkIds, [dataPackage.marks[0].id]);
  assert.deepEqual(request.evidence.sources.map((source) => source.sourceId), ["src_fixture"]);
  assert.equal(JSON.stringify(request.selection).includes("Alpha ranks above Beta"), false);
  const completed = await loadSession({ root, sessionId: session.id });
  assert.equal(completed.conversation.turns.at(-1).content, "Alpha is ranked highest in the verified fixture.");
});

test("atlas-v2 server routes use a tiny revision-bound mark envelope and expose only bundled render assets", async (t) => {
  const root = await project(t);
  const { dataPackage } = await fixturePackage();
  const session = await createSession({ root, dataPackage, id: "atlas_server" });
  const viewer = await createViewerServer({
    root,
    analysisId: session.id,
    assetsDir: VIEWER_ASSETS,
    token: "atlas-runtime-token-0123456789",
    instanceId: "atlas-runtime-instance-0123456789",
    resolveQuestionRoute: async () => ({
      kind: "detached",
      adapter: "codex-cli",
    }),
  });
  t.after(() => viewer.close());

  const library = await fetch(api(viewer.libraryUrl, "library"));
  assert.equal(library.status, 200);
  assert.deepEqual((await library.json()).sessions[0].counts, {
    marks: dataPackage.marks.length,
    sources: dataPackage.sources.length,
    noun: "mark",
  });

  const renderModel = await fetch(api(viewer.url, "render-model"));
  assert.equal(renderModel.status, 200);
  const model = await renderModel.json();
  assert.equal(model.artifactKind, "atlas-v2");
  assert.equal(model.renderer.rendererId, dataPackage.catalog.rendererId);
  assert.equal("evidenceRefs" in model.marks[0], false);

  const publicPackage = await fetch(api(viewer.url, "data"));
  assert.equal(publicPackage.status, 200);
  const publicJson = await publicPackage.json();
  assert.deepEqual(Object.keys(publicJson).sort(), [
    "catalog",
    "family",
    "hashes",
    "id",
    "kind",
    "marks",
    "payload",
    "question",
    "schemaVersion",
  ]);
  assert.equal(Array.isArray(publicJson.rows), false);
  assert.equal(JSON.stringify(publicJson).includes("Alpha ranks above Beta"), false);
  assert.equal("sources" in publicJson, false);
  assert.equal("scope" in publicJson, false);
  assert.equal("provenance" in publicJson, false);
  assert.equal(JSON.stringify(publicJson).includes("src_fixture"), false);
  assert.equal(JSON.stringify(publicJson).includes("fixtures/records.jsonl"), false);
  assert.match(publicJson.marks[0].evidenceRefs[0], /^evidence_[a-f0-9]{16}$/u);
  assert.equal("recordId" in publicJson.marks[0], false);
  assert.equal(JSON.stringify(publicJson.marks).includes("sourceId"), false);
  assert.equal(JSON.stringify(publicJson.marks).includes("locator"), false);

  for (const asset of ["package-model.js", "package-renderer.js", "family-renderers.js"]) {
    const response = await fetch(new URL(asset, viewer.url));
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get("content-type") ?? "", /^text\/javascript\b/u);
  }
  assert.equal((await fetch(new URL("unapproved-module.js", viewer.url))).status, 404);

  const markId = dataPackage.marks[0].id;
  const missingSessionId = await post(viewer.url, "selection", { revision: 0, markId });
  assert.equal(missingSessionId.status, 400);
  const selected = await post(viewer.url, "selection", {
    sessionId: session.id,
    revision: 0,
    markId,
  });
  assert.equal(selected.status, 200);
  const selectedState = await selected.json();
  assert.deepEqual(selectedState.state, { revision: 1, markIds: [markId] });
  assert.deepEqual(selectedState.selection.selectedMarkIds, [markId]);
  assert.equal(JSON.stringify(selectedState.selection).includes("Alpha ranks above Beta"), false);

  const chat = await post(viewer.url, "chat", {
    expectedRevision: 1,
    selectionId: selectedState.selection.id,
    message: "What supports this selected rank?",
  });
  assert.equal(chat.status, 200);
  const chatState = await chat.json();
  assert.equal(chatState.revision, 2);
  assert.deepEqual(chatState.session.state.markIds, [], "the exact attachment is consumed once");
  assert.deepEqual(chatState.question.selection.selectedMarkIds, [markId]);
  assert.equal(JSON.stringify(chatState.question.selection).includes("Alpha ranks above Beta"), false);

  const stale = await post(viewer.url, "selection", {
    sessionId: session.id,
    revision: 1,
    markId: null,
  });
  assert.equal(stale.status, 409);

  const loaded = await loadSession({ root, sessionId: session.id });
  assert.deepEqual(loaded.state, { revision: 2, markIds: [] });
  assert.deepEqual(loaded.conversation.turns.at(-1).selection.selectedMarkIds, [markId]);
});

test("atlas-v2 multi-mark selection dedupes ids and refuses unknown, oversized, ambiguous, or empty requests", async (t) => {
  const root = await project(t);
  const { dataPackage } = await fixturePackage();
  const session = await createSession({ root, dataPackage, id: "atlas_multi_mark" });
  const viewer = await createViewerServer({
    root,
    analysisId: session.id,
    assetsDir: VIEWER_ASSETS,
    token: "atlas-multi-mark-token-0123456789",
    instanceId: "atlas-multi-mark-instance-0123456789",
  });
  t.after(() => viewer.close());

  const [first, second] = dataPackage.marks;
  const selectedResponse = await post(viewer.url, "selection", {
    sessionId: session.id,
    revision: 0,
    markIds: [first.id, second.id],
  });
  assert.equal(selectedResponse.status, 200);
  const selected = await selectedResponse.json();
  assert.deepEqual(selected.state, { revision: 1, markIds: [first.id, second.id] });
  assert.deepEqual(selected.selection.selectedMarkIds, [first.id, second.id]);
  assert.deepEqual(selected.selection.predicate, {
    field: "markId",
    operator: "in",
    values: [first.id, second.id],
  });
  assert.deepEqual(
    selected.selection.evidenceRefIds,
    [...new Set([...first.evidenceRefs, ...second.evidenceRefs])],
  );

  const deduped = await post(viewer.url, "selection", {
    sessionId: session.id,
    revision: 1,
    markIds: [first.id, first.id, second.id],
  });
  assert.equal(deduped.status, 200);
  assert.deepEqual((await deduped.json()).state, { revision: 2, markIds: [first.id, second.id] });

  const unknown = await post(viewer.url, "selection", {
    sessionId: session.id,
    revision: 2,
    markIds: [first.id, "mark_invented"],
  });
  assert.equal(unknown.status, 400);

  const oversized = await post(viewer.url, "selection", {
    sessionId: session.id,
    revision: 2,
    markIds: Array.from({ length: 51 }, (_value, index) => `mark_${index}`),
  });
  assert.equal(oversized.status, 400);

  const ambiguous = await post(viewer.url, "selection", {
    sessionId: session.id,
    revision: 2,
    markIds: [first.id],
    markId: second.id,
  });
  assert.equal(ambiguous.status, 400);

  const empty = await post(viewer.url, "selection", {
    sessionId: session.id,
    revision: 2,
    markIds: [],
  });
  assert.equal(empty.status, 400);

  assert.deepEqual((await loadSession({ root, sessionId: session.id })).state, {
    revision: 2,
    markIds: [first.id, second.id],
  });
});

test("mechanism node selection attaches its server-derived connected evidence to chat", async (t) => {
  const root = await project(t);
  const dataPackage = await fixtureMechanismPackage();
  const session = await createSession({ root, dataPackage, id: "atlas_mechanism_node" });
  const viewer = await createViewerServer({
    root,
    analysisId: session.id,
    assetsDir: VIEWER_ASSETS,
    token: "atlas-mechanism-token-0123456789",
    instanceId: "atlas-mechanism-instance-0123456789",
    resolveQuestionRoute: async () => ({ kind: "detached", adapter: "codex-cli" }),
  });
  t.after(() => viewer.close());

  const selectedResponse = await post(viewer.url, "selection", {
    sessionId: session.id,
    revision: 0,
    nodeId: "Attend",
  });
  assert.equal(selectedResponse.status, 200);
  const selected = await selectedResponse.json();
  const connectedMarkIds = dataPackage.marks
    .filter((mark) => mark.values.source === "Attend" || mark.values.target === "Attend")
    .map((mark) => mark.id);
  assert.deepEqual(selected.state, {
    revision: 1,
    markIds: connectedMarkIds,
    focus: { kind: "node", id: "Attend" },
  });
  assert.deepEqual(selected.selection.selectedMarkIds, connectedMarkIds);
  assert.deepEqual(selected.selection.focus, { kind: "node", id: "Attend", label: "Attend" });

  const unknown = await post(viewer.url, "selection", {
    sessionId: session.id,
    revision: 1,
    nodeId: "invented component",
  });
  assert.equal(unknown.status, 400);

  const chatResponse = await post(viewer.url, "chat", {
    expectedRevision: 1,
    selectionId: selected.selection.id,
    message: "What role does this component play?",
  });
  assert.equal(chatResponse.status, 200);
  const chat = await chatResponse.json();
  assert.deepEqual(chat.question.selection.focus, { kind: "node", id: "Attend", label: "Attend" });
  assert.deepEqual(chat.question.selection.selectedMarkIds, connectedMarkIds);
  assert.deepEqual(chat.session.state, { revision: 2, markIds: [] });
});

test("atlas-v2 library keeps valid sessions available when a stale package fails validation", async (t) => {
  const root = await project(t);
  const { dataPackage } = await fixturePackage();
  const valid = await createSession({ root, dataPackage, id: "atlas_valid" });
  const stale = await createSession({ root, dataPackage, id: "atlas_stale" });
  const stalePath = sessionFilePath({ root, sessionId: stale.id });
  const invalidSession = JSON.parse(await readFile(stalePath, "utf8"));
  invalidSession.dataPackage.catalog.version = "obsolete_catalog";
  invalidSession.dataPackage.question.text = "PRIVATE STALE SESSION TITLE";
  await writeFile(stalePath, `${JSON.stringify(invalidSession)}\n`);

  const viewer = await createViewerServer({
    root,
    analysisId: valid.id,
    assetsDir: VIEWER_ASSETS,
    token: "atlas-stale-token-0123456789",
    instanceId: "atlas-stale-instance-0123456789",
  });
  t.after(() => viewer.close());

  const response = await fetch(api(viewer.libraryUrl, "library"));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /PRIVATE STALE SESSION TITLE|obsolete_catalog/u);
  const library = JSON.parse(body);
  assert.equal(library.unavailableSessionCount, 1);
  assert.deepEqual(library.sessions.map((entry) => entry.sessionId), [valid.id]);

  const staleData = await fetch(new URL(`s/${stale.id}/api/data`, viewer.libraryUrl));
  assert.notEqual(staleData.status, 200, "the invalid session remains unavailable at its direct route");
});
