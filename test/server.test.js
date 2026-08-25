import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createLibraryServer,
  createViewerServer,
  VIEWER_JSON_LIMIT,
} from "../src/server.js";
import {
  createSession,
  loadSession,
  markQuestionResponseFailed,
} from "../src/session-store.js";

const TEST_TOKEN = "viewer-test-token-0123456789";
const TEST_INSTANCE_ID = "instance-test-0123456789";

function dataPackage() {
  return {
    schemaVersion: 1,
    kind: "attend-data-package",
    id: "data_0123456789abcdef",
    question: {
      text: "Which phrases recur in these notes?",
      target: "fixture notes",
    },
    hashes: {
      corpus: "a".repeat(64),
      config: "b".repeat(64),
      data: "c".repeat(64),
    },
    config: {
      minWords: 2,
      maxWords: 3,
      minCount: 2,
      minSources: 2,
      limit: 50,
      maxFileBytes: 100_000,
      ranking: [
        { field: "distinctSourceCount", direction: "desc" },
        { field: "occurrenceCount", direction: "desc" },
        { field: "phrase", direction: "asc" },
      ],
    },
    sources: [
      {
        id: "source_alpha",
        displayPath: "notes/alpha.md",
        sha256: "d".repeat(64),
        kind: "markdown",
        title: "Alpha",
      },
      {
        id: "source_beta",
        displayPath: "notes/beta.txt",
        sha256: "e".repeat(64),
        kind: "text",
        title: "Beta",
      },
    ],
    rows: [
      {
        id: "phrase_design_system",
        phrase: "design system",
        wordCount: 2,
        occurrenceCount: 3,
        distinctSourceCount: 2,
        occurrences: [
          { sourceId: "source_alpha", line: 4, excerpt: "The design system should stay quiet." },
          { sourceId: "source_alpha", line: 9, excerpt: "A design system can expose structure." },
          { sourceId: "source_beta", line: 2, excerpt: "Return to the design system." },
        ],
      },
      {
        id: "phrase_local_context",
        phrase: "local context",
        wordCount: 2,
        occurrenceCount: 2,
        distinctSourceCount: 1,
        occurrences: [
          { sourceId: "source_beta", line: 6, excerpt: "Keep local context close." },
          { sourceId: "source_beta", line: 11, excerpt: "The local context remains private." },
        ],
      },
    ],
    map: {
      id: "phrase-list",
      version: 1,
      labelField: "phrase",
      valueField: "occurrenceCount",
    },
    transformations: ["Unicode case-fold", "contiguous n-grams"],
    knownOmissions: ["No semantic paraphrase grouping"],
  };
}

function secondDataPackage() {
  const value = dataPackage();
  value.id = "data_fedcba9876543210";
  value.question = {
    text: "Where does shared language appear?",
    target: "second fixture corpus",
  };
  value.rows = [value.rows[0]];
  return value;
}

async function fixture(t, options = {}) {
  const token = Object.hasOwn(options, "token") ? options.token : TEST_TOKEN;
  const root = await mkdtemp(join(tmpdir(), "attend-viewer-test-"));
  const assetsDir = join(root, "viewer assets");
  await mkdir(assetsDir, { recursive: true });
  await Promise.all([
    writeFile(join(assetsDir, "index.html"), "<!doctype html><title>Attend fixture</title><script src=\"./app.js\"></script>"),
    writeFile(join(assetsDir, "app.js"), "globalThis.attendFixture = true;\n"),
    writeFile(join(assetsDir, "styles.css"), "body { color: #111; }\n"),
    writeFile(join(assetsDir, "library.html"), "<!doctype html><title>Attend library fixture</title><script src=\"./library.js\"></script>"),
    writeFile(join(assetsDir, "library.js"), "globalThis.attendLibraryFixture = true;\n"),
    writeFile(join(assetsDir, "library.css"), "body { color: #222; }\n"),
    writeFile(join(assetsDir, "secret.txt"), "must not be served\n"),
  ]);

  const analysisId = "session_server_test";
  await createSession({ root, id: analysisId, dataPackage: dataPackage() });
  const viewer = await createViewerServer({
    root,
    analysisId,
    assetsDir,
    instanceId: TEST_INSTANCE_ID,
    ...(options.enqueueQuestion
      ? { enqueueQuestion: options.enqueueQuestion }
      : {}),
    resolveQuestionRoute: options.resolveQuestionRoute ?? (async () => ({
      kind: "detached",
      adapter: "codex-cli",
    })),
    ...(token === undefined ? {} : { token }),
  });
  t.after(async () => {
    await viewer.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, analysisId, assetsDir, ...viewer };
}

function api(url, route) {
  return new URL(`api/${route}`, url);
}

function originOf(url) {
  return new URL(url).origin;
}

async function responseJson(response) {
  const body = await response.json();
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/u);
  return body;
}

async function post(url, route, body, { origin = originOf(url), contentType = "application/json" } = {}) {
  return fetch(api(url, route), {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      ...(origin === null ? {} : { Origin: origin }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function requestWithHost(url, host) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "GET",
      headers: { Host: host },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response));
    });
    request.once("error", reject);
    request.end();
  });
}

function requestRawPath(url, path) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path,
      method: "GET",
      headers: { Host: target.host },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response));
    });
    request.once("error", reject);
    request.end();
  });
}

function turnsFrom(session) {
  return Array.isArray(session.conversation)
    ? session.conversation
    : session.conversation?.turns ?? [];
}

test("serves only the tokenized viewer and explicit read endpoints", async (t) => {
  const viewer = await fixture(t);
  assert.equal(viewer.token, TEST_TOKEN);
  assert.match(viewer.libraryUrl, /^http:\/\/127\.0\.0\.1:\d+\/v\/viewer-test-token-0123456789\/$/u);
  assert.equal(viewer.url, `${viewer.libraryUrl}s/${viewer.analysisId}/`);
  assert.equal(viewer.viewerUrl, viewer.url);
  assert.equal(viewer.port, Number(new URL(viewer.url).port));

  const index = await fetch(viewer.url);
  assert.equal(index.status, 200);
  assert.match(await index.text(), /Attend fixture/u);
  assert.equal(index.headers.get("cache-control"), "no-store");
  assert.match(index.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
  assert.match(index.headers.get("content-security-policy") ?? "", /connect-src 'self'/u);
  assert.doesNotMatch(index.headers.get("content-security-policy") ?? "", /unsafe-inline/u);
  assert.equal(index.headers.get("x-content-type-options"), "nosniff");
  assert.equal(index.headers.get("referrer-policy"), "no-referrer");
  assert.equal(index.headers.get("cross-origin-resource-policy"), "same-origin");

  const script = await fetch(new URL("app.js", viewer.url));
  assert.equal(script.status, 200);
  assert.match(script.headers.get("content-type") ?? "", /^text\/javascript\b/u);
  assert.match(await script.text(), /attendFixture/u);

  const libraryIndex = await fetch(viewer.libraryUrl);
  assert.equal(libraryIndex.status, 200);
  assert.match(await libraryIndex.text(), /Attend library fixture/u);
  const libraryScript = await fetch(new URL("library.js", viewer.libraryUrl));
  assert.equal(libraryScript.status, 200);
  assert.match(await libraryScript.text(), /attendLibraryFixture/u);

  const libraryHealth = await fetch(api(viewer.libraryUrl, "health"));
  assert.equal(libraryHealth.status, 200);
  assert.deepEqual(await responseJson(libraryHealth), {
    ok: true,
    service: "attend-library",
    protocolVersion: 4,
    packageVersion: "0.4.0",
    instanceId: TEST_INSTANCE_ID,
    sessionCount: 1,
  });

  const healthResponse = await fetch(api(viewer.url, "health"));
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await responseJson(healthResponse), {
    ok: true,
    analysisId: dataPackage().id,
    sessionId: viewer.analysisId,
    revision: 0,
    dataPackageId: dataPackage().id,
  });

  const dataResponse = await fetch(api(viewer.url, "data"));
  assert.equal(dataResponse.status, 200);
  assert.deepEqual(await responseJson(dataResponse), dataPackage());

  const stateResponse = await fetch(api(viewer.url, "state"));
  assert.equal(stateResponse.status, 200);
  const state = await responseJson(stateResponse);
  assert.equal(state.id, viewer.analysisId);
  assert.equal(state.state.revision, 0);
  assert.deepEqual(state.selection.selectedMarkIds, []);
  assert.deepEqual(state.conversation.turns, []);

  const originRoot = `${originOf(viewer.url)}/`;
  assert.equal((await fetch(originRoot)).status, 404);
  assert.equal((await fetch(`${originOf(viewer.url)}/v/not-the-token/`)).status, 404);
  assert.equal((await fetch(new URL("secret.txt", viewer.url))).status, 404);
  assert.equal((await fetch(new URL("secret.txt", viewer.libraryUrl))).status, 404);
  assert.equal((await fetch(`${viewer.url}%2e%2e/secret.txt`)).status, 404);
  assert.equal((await requestWithHost(viewer.url, "attacker.invalid")).statusCode, 421);
});

test("one library discovers multiple sessions with metadata-only stable links", async (t) => {
  const viewer = await fixture(t);

  const initialResponse = await fetch(api(viewer.libraryUrl, "library"));
  assert.equal(initialResponse.status, 200);
  const initial = await responseJson(initialResponse);
  assert.equal(initial.schemaVersion, 1);
  assert.deepEqual(initial.sessions, [{
    sessionId: viewer.analysisId,
    question: dataPackage().question.text,
    target: dataPackage().question.target,
    view: { id: "phrase-list", version: 1 },
    counts: { phrases: 2, sources: 2 },
    updatedAt: initial.sessions[0].updatedAt,
    href: `s/${viewer.analysisId}/`,
  }]);

  const secondSessionId = "session_second_test";
  await createSession({
    root: viewer.root,
    id: secondSessionId,
    dataPackage: secondDataPackage(),
  });

  const refreshedResponse = await fetch(api(viewer.libraryUrl, "library"));
  assert.equal(refreshedResponse.status, 200);
  const refreshedText = await refreshedResponse.text();
  assert.doesNotMatch(refreshedText, /excerpt|displayPath|source_alpha|design system should stay quiet/iu);
  const refreshed = JSON.parse(refreshedText);
  assert.equal(refreshed.sessions.length, 2, "new sessions appear without restarting the service");

  const first = refreshed.sessions.find((entry) => entry.sessionId === viewer.analysisId);
  const second = refreshed.sessions.find((entry) => entry.sessionId === secondSessionId);
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.href, initial.sessions[0].href, "an existing session link remains stable");
  assert.deepEqual(second, {
    sessionId: secondSessionId,
    question: "Where does shared language appear?",
    target: "second fixture corpus",
    view: { id: "phrase-list", version: 1 },
    counts: { phrases: 1, sources: 2 },
    updatedAt: second.updatedAt,
    href: `s/${secondSessionId}/`,
  });
  for (const entry of refreshed.sessions) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "counts",
      "href",
      "question",
      "sessionId",
      "target",
      "updatedAt",
      "view",
    ]);
    const linkedViewer = await fetch(new URL(entry.href, viewer.libraryUrl));
    assert.equal(linkedViewer.status, 200);
    assert.match(await linkedViewer.text(), /Attend fixture/u);
  }

  const health = await responseJson(await fetch(api(viewer.libraryUrl, "health")));
  assert.equal(health.sessionCount, 2);
});

test("session routes are isolated and traversal or unknown ids do not resolve", async (t) => {
  const viewer = await fixture(t);
  const secondSessionId = "session_second_test";
  await createSession({
    root: viewer.root,
    id: secondSessionId,
    dataPackage: secondDataPackage(),
  });
  const secondUrl = new URL(`s/${secondSessionId}/`, viewer.libraryUrl);

  const secondData = await responseJson(await fetch(api(secondUrl, "data")));
  assert.equal(secondData.id, secondDataPackage().id);
  assert.equal((await fetch(api(viewer.libraryUrl, "data"))).status, 404);
  assert.equal((await fetch(new URL("app.js", viewer.libraryUrl))).status, 404);
  assert.equal((await fetch(new URL("s/session_missing/", viewer.libraryUrl))).status, 404);
  assert.equal((await fetch(new URL("s/session_missing/app.js", viewer.libraryUrl))).status, 404);

  const selected = await post(secondUrl, "selection", {
    expectedRevision: 0,
    selectedIds: ["phrase_design_system"],
  });
  assert.equal(selected.status, 200);
  assert.equal((await loadSession({ root: viewer.root, sessionId: secondSessionId })).state.revision, 1);
  assert.equal((await loadSession({ root: viewer.root, sessionId: viewer.analysisId })).state.revision, 0);

  const basePath = new URL(viewer.libraryUrl).pathname;
  for (const path of [
    `${basePath}s/%2e%2e/`,
    `${basePath}s/${viewer.analysisId}/../`,
    `${basePath}s/${viewer.analysisId}/%2e%2e/api/library`,
    `${basePath}s/%2fprivate/`,
  ]) {
    assert.equal((await requestRawPath(viewer.libraryUrl, path)).statusCode, 404, path);
  }
});

test("createLibraryServer returns the library as its primary stable URL", async (t) => {
  const viewer = await fixture(t);
  const library = await createLibraryServer({
    root: viewer.root,
    assetsDir: viewer.assetsDir,
    token: "library-alias-token-0123456789",
    instanceId: "library-alias-instance-012345",
  });
  t.after(() => library.close());

  assert.equal(library.url, library.libraryUrl);
  assert.equal(library.viewerUrl, undefined);
  assert.equal(library.port, Number(new URL(library.url).port));
  const health = await responseJson(await fetch(api(library.url, "health")));
  assert.equal(health.instanceId, "library-alias-instance-012345");
  assert.equal(health.service, "attend-library");
});

test("selection and view mutations require same-origin JSON and optimistic revisions", async (t) => {
  const viewer = await fixture(t);

  const noOrigin = await post(viewer.url, "selection", {
    expectedRevision: 0,
    selectedIds: ["phrase_design_system"],
  }, { origin: null });
  assert.equal(noOrigin.status, 403);
  assert.equal((await loadSession({ root: viewer.root, sessionId: viewer.analysisId })).state.revision, 0);

  const crossOrigin = await post(viewer.url, "selection", {
    expectedRevision: 0,
    selectedIds: ["phrase_design_system"],
  }, { origin: "http://127.0.0.1:1" });
  assert.equal(crossOrigin.status, 403);

  const selectedResponse = await post(viewer.url, "selection", {
    expectedRevision: 0,
    selectedIds: ["phrase_design_system", "phrase_design_system"],
  });
  assert.equal(selectedResponse.status, 200);
  const selected = await responseJson(selectedResponse);
  assert.equal(selected.state.revision, 1);
  assert.deepEqual(selected.state.selectedIds, ["phrase_design_system"]);
  assert.deepEqual(selected.selection.predicate, {
    field: "phrase",
    operator: "equals",
    value: "design system",
  });
  assert.deepEqual(selected.selection.marks, [{
    id: "phrase_design_system",
    phrase: "design system",
    occurrenceCount: 3,
    distinctSourceCount: 2,
  }]);
  assert.deepEqual(
    [...new Set(selected.selection.sourceRefs.map((reference) => reference.sourceId))],
    ["source_alpha", "source_beta"],
  );

  const staleResponse = await post(viewer.url, "selection", {
    expectedRevision: 0,
    selectedIds: ["phrase_local_context"],
  });
  assert.equal(staleResponse.status, 409);
  const stale = await responseJson(staleResponse);
  assert.equal(stale.error.code, "revision_conflict");
  assert.equal(stale.error.details.current.state.revision, 1);
  assert.deepEqual(stale.error.details.current.state.selectedIds, ["phrase_design_system"]);

  const badId = await post(viewer.url, "selection", {
    expectedRevision: 1,
    selectedIds: ["phrase_missing"],
  });
  assert.equal(badId.status, 400);
  assert.equal((await responseJson(badId)).error.code, "invalid_selection");

  const beforeView = await loadSession({ root: viewer.root, sessionId: viewer.analysisId });
  const sortKey = Object.hasOwn(beforeView.state.sort, "by") ? "by" : "field";
  const viewResponse = await post(viewer.url, "view-state", {
    expectedRevision: 1,
    query: "design",
    minCount: 3,
    sort: { [sortKey]: "phrase", direction: "asc" },
    sourceScope: { mode: "include", sourceIds: ["source_alpha"] },
  });
  assert.equal(viewResponse.status, 200);
  const viewState = await responseJson(viewResponse);
  assert.equal(viewState.state.revision, 2);
  assert.equal(viewState.state.query, "design");
  assert.equal(viewState.state.minCount, 3);
  assert.deepEqual(viewState.state.sort, { [sortKey]: "phrase", direction: "asc" });
  assert.deepEqual(viewState.state.sourceScope, { mode: "include", sourceIds: ["source_alpha"] });
  assert.deepEqual(viewState.state.selectedIds, ["phrase_design_system"]);

  const allSourcesResponse = await post(viewer.url, "view-state", {
    expectedRevision: 2,
    sourceScope: { mode: "all", sourceIds: [] },
  });
  assert.equal(allSourcesResponse.status, 200);
  const allSources = await responseJson(allSourcesResponse);
  assert.equal(allSources.state.revision, 3);
  assert.deepEqual(allSources.state.sourceScope, { mode: "all", sourceIds: [] });

  const enumeratedAllResponse = await post(viewer.url, "view-state", {
    expectedRevision: 3,
    sourceScope: {
      mode: "all",
      sourceIds: ["source_alpha", "source_beta"],
    },
  });
  assert.equal(enumeratedAllResponse.status, 400);
  assert.equal(
    (await responseJson(enumeratedAllResponse)).error.code,
    "invalid_view_state",
  );
  const afterRejectedAll = await loadSession({
    root: viewer.root,
    sessionId: viewer.analysisId,
  });
  assert.equal(afterRejectedAll.state.revision, 3);
  assert.deepEqual(afterRejectedAll.state.sourceScope, {
    mode: "all",
    sourceIds: [],
  });
});

test("chat queues only the user question against the exact selected state", async (t) => {
  const viewer = await fixture(t);
  const selectedResponse = await post(viewer.url, "selection", {
    expectedRevision: 0,
    selectedIds: ["phrase_design_system"],
  });
  const selected = await responseJson(selectedResponse);

  const chatResponse = await post(viewer.url, "chat", {
    expectedRevision: selected.state.revision,
    selectionId: selected.selection.id,
    message: "What is happening here?",
  });
  assert.equal(chatResponse.status, 200);
  const chat = await responseJson(chatResponse);
  assert.equal(chat.ok, true);
  assert.equal(chat.status, "queued");
  assert.equal(Object.hasOwn(chat, "hostNotification"), false);
  assert.equal(chat.selectionId, selected.selection.id);
  assert.equal(chat.question.role, "user");
  assert.equal(chat.question.content, "What is happening here?");
  assert.deepEqual(chat.question.response, {
    status: "queued",
    route: { kind: "detached", adapter: "codex-cli" },
  });
  assert.equal(chat.question.selection.id, selected.selection.id);
  assert.equal(chat.question.selection.stateRevision, selected.state.revision);
  assert.deepEqual(chat.question.selection.selectedMarkIds, ["phrase_design_system"]);

  const stored = await loadSession({ root: viewer.root, sessionId: viewer.analysisId });
  const turns = turnsFrom(stored);
  assert.equal(turns.length, 1, "the viewer must not fabricate an assistant answer");
  assert.deepEqual(turns.map((turn) => turn.role), ["user"]);
  assert.equal(turns[0].id, chat.question.id);
  assert.equal(turns[0].content, chat.question.content);
  assert.equal(turns[0].response.status, "queued");
  assert.ok(turns[0].response.queuedAt, "internal lifecycle timestamps are persisted");
  assert.equal(
    Object.hasOwn(chat.question.response, "queuedAt"),
    false,
    "internal lifecycle metadata is not public",
  );
  assert.deepEqual(turns[0].selection.selectedMarkIds, ["phrase_design_system"]);
  assert.equal(turns[0].selection.stateRevision, 1);
  assert.deepEqual({
    count: turns[0].selection.sourceRefCount,
    truncated: turns[0].selection.sourceRefsTruncated,
    inline: turns[0].selection.sourceRefs.length,
  }, { count: 3, truncated: false, inline: 3 });
  assert.equal(stored.state.revision, 2, "queuing the question increments the revision once");
  assert.equal(chat.revision, 2);
  assert.equal(chat.session.state.revision, 2);
  assert.deepEqual(
    stored.state.selectedIds,
    [],
    "the successfully attached selection is consumed from live state",
  );
  assert.deepEqual(chat.session.state.selectedIds, []);
  assert.deepEqual(chat.session.selection.selectedMarkIds, []);
  assert.notEqual(
    chat.session.selection.id,
    selected.selection.id,
    "the returned live selection is the post-send empty selection",
  );
  assert.deepEqual(chat.session.conversation.turns, [chat.question]);

  const stale = await post(viewer.url, "chat", {
    expectedRevision: 1,
    selectionId: selected.selection.id,
    message: "Answer again",
  });
  assert.equal(stale.status, 409);
  const afterStale = await loadSession({ root: viewer.root, sessionId: viewer.analysisId });
  assert.equal(turnsFrom(afterStale).length, 1);
  assert.deepEqual(afterStale.state.selectedIds, []);
  assert.equal(afterStale.state.revision, 2);
});

test("chat returns immediately, then enqueues the exact committed question once", async (t) => {
  const jobs = [];
  let releaseEnqueue;
  const enqueueBlocked = new Promise((resolve) => {
    releaseEnqueue = resolve;
  });
  let viewer;
  viewer = await fixture(t, {
    enqueueQuestion: async (job) => {
      const stored = await loadSession({ root: viewer.root, sessionId: viewer.analysisId });
      jobs.push({ job, persisted: turnsFrom(stored).some((turn) => turn.id === job.questionId) });
      await enqueueBlocked;
    },
  });

  const selected = await responseJson(await post(viewer.url, "selection", {
    expectedRevision: 0,
    selectedIds: ["phrase_design_system"],
  }));
  assert.equal(jobs.length, 0, "selection alone must not enqueue a response");

  const body = {
    expectedRevision: selected.state.revision,
    selectionId: selected.selection.id,
    message: "How does this phrase differ across the notes?",
  };
  const response = await post(viewer.url, "chat", body);
  assert.equal(response.status, 200);
  const chat = await responseJson(response);
  for (let attempt = 0; attempt < 20 && jobs.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(jobs, [{
    job: {
      root: viewer.root,
      sessionId: viewer.analysisId,
      questionId: chat.question.id,
      route: { kind: "detached", adapter: "codex-cli" },
    },
    persisted: true,
  }]);
  releaseEnqueue();

  const stale = await post(viewer.url, "chat", body);
  assert.equal(stale.status, 409);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.length, 1, "a stale retry must not enqueue duplicate work");
});

test("an asynchronous enqueue failure marks only the committed question failed", async (t) => {
  let enqueueCount = 0;
  const viewer = await fixture(t, {
    enqueueQuestion: async () => {
      enqueueCount += 1;
      throw new Error("private enqueue detail must not be public");
    },
  });
  const selected = await responseJson(await post(viewer.url, "selection", {
    expectedRevision: 0,
    selectedIds: ["phrase_design_system"],
  }));

  const response = await post(viewer.url, "chat", {
    expectedRevision: selected.state.revision,
    selectionId: selected.selection.id,
    message: "Please answer from this exact mark.",
  });
  assert.equal(response.status, 200);
  const chat = await responseJson(response);
  assert.equal(chat.status, "queued");
  assert.deepEqual(chat.question.response, {
    status: "queued",
    route: { kind: "detached", adapter: "codex-cli" },
  });
  assert.equal(enqueueCount, 1);

  let stored;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    stored = await loadSession({ root: viewer.root, sessionId: viewer.analysisId });
    if (turnsFrom(stored)[0]?.response?.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(turnsFrom(stored).length, 1);
  assert.equal(turnsFrom(stored)[0].content, "Please answer from this exact mark.");
  assert.equal(turnsFrom(stored)[0].response.errorCode, "enqueue_failed");
  assert.deepEqual(stored.state.selectedIds, []);

  const publicState = await responseJson(await fetch(api(viewer.url, "state")));
  assert.deepEqual(publicState.conversation.turns[0].response, {
    status: "failed",
    route: { kind: "detached", adapter: "codex-cli" },
    errorCode: "enqueue_failed",
  });
  assert.doesNotMatch(JSON.stringify(publicState), /private enqueue detail/u);
});

test("chat rejects a second active response without consuming its attachment", async (t) => {
  const viewer = await fixture(t);
  const selectedFirst = await responseJson(await post(viewer.url, "selection", {
    expectedRevision: 0,
    selectedIds: ["phrase_design_system"],
  }));
  const firstChat = await responseJson(await post(viewer.url, "chat", {
    expectedRevision: selectedFirst.state.revision,
    selectionId: selectedFirst.selection.id,
    message: "First response job.",
  }));
  const selectedSecond = await responseJson(await post(viewer.url, "selection", {
    expectedRevision: firstChat.session.state.revision,
    selectedIds: ["phrase_local_context"],
  }));

  const secondResponse = await post(viewer.url, "chat", {
    expectedRevision: selectedSecond.state.revision,
    selectionId: selectedSecond.selection.id,
    message: "This must not spawn another active job.",
  });
  assert.equal(secondResponse.status, 409);
  const conflict = await responseJson(secondResponse);
  assert.equal(conflict.error.code, "active_response_exists");

  const stored = await loadSession({ root: viewer.root, sessionId: viewer.analysisId });
  assert.equal(stored.state.revision, selectedSecond.state.revision);
  assert.deepEqual(stored.state.selectedIds, ["phrase_local_context"]);
  assert.equal(turnsFrom(stored).length, 1);
  assert.equal(turnsFrom(stored)[0].id, firstChat.question.id);
});

test("failed chat responses retry by explicit question id and enqueue after commit", async (t) => {
  const jobs = [];
  let activeRoute = { kind: "detached", adapter: "codex-cli" };
  const viewer = await fixture(t, {
    enqueueQuestion(job) {
      jobs.push(job);
    },
    resolveQuestionRoute() {
      return activeRoute;
    },
  });
  const selected = await responseJson(await post(viewer.url, "selection", {
    expectedRevision: 0,
    selectedIds: ["phrase_design_system"],
  }));
  const chat = await responseJson(await post(viewer.url, "chat", {
    expectedRevision: selected.state.revision,
    selectionId: selected.selection.id,
    message: "Retry this exact question if it fails.",
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(jobs.length, 1);

  const failed = await markQuestionResponseFailed({
    root: viewer.root,
    sessionId: viewer.analysisId,
    questionId: chat.question.id,
    errorCode: "codex_exit",
  });
  assert.equal(failed.question.response.status, "failed");

  activeRoute = { kind: "detached", adapter: "claude-cli" };
  const wrongRouteRetry = await post(viewer.url, "chat/retry", {
    questionId: chat.question.id,
  });
  assert.equal(wrongRouteRetry.status, 409);
  assert.equal(
    (await responseJson(wrongRouteRetry)).error.code,
    "response_route_mismatch",
  );
  assert.equal(
    turnsFrom(await loadSession({ root: viewer.root, sessionId: viewer.analysisId }))[0]
      .response.status,
    "failed",
  );

  activeRoute = { kind: "detached", adapter: "codex-cli" };

  const retriedResponse = await post(viewer.url, "chat/retry", {
    questionId: chat.question.id,
  });
  assert.equal(retriedResponse.status, 200);
  const retried = await responseJson(retriedResponse);
  assert.equal(retried.ok, true);
  assert.equal(retried.status, "queued");
  assert.equal(retried.questionId, chat.question.id);
  assert.deepEqual(
    retried.session.conversation.turns[0].response,
    {
      status: "queued",
      route: { kind: "detached", adapter: "codex-cli" },
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(jobs.at(-1), {
    root: viewer.root,
    sessionId: viewer.analysisId,
    questionId: chat.question.id,
    route: { kind: "detached", adapter: "codex-cli" },
  });
  assert.equal(jobs.length, 2);

  const duplicateRetry = await post(viewer.url, "chat/retry", {
    questionId: chat.question.id,
  });
  assert.equal(duplicateRetry.status, 409);
  assert.equal(
    (await responseJson(duplicateRetry)).error.code,
    "response_not_retryable",
  );

  const unknown = await post(viewer.url, "chat/retry", {
    questionId: "turn_unknown",
  });
  assert.equal(unknown.status, 404);
  assert.equal((await responseJson(unknown)).error.code, "question_not_found");
});

test("retry refuses to create a second active response", async (t) => {
  const viewer = await fixture(t, { enqueueQuestion() {} });
  const selectedFirst = await responseJson(await post(viewer.url, "selection", {
    expectedRevision: 0,
    selectedIds: ["phrase_design_system"],
  }));
  const first = await responseJson(await post(viewer.url, "chat", {
    expectedRevision: selectedFirst.state.revision,
    selectionId: selectedFirst.selection.id,
    message: "This older question will fail.",
  }));
  const failed = await markQuestionResponseFailed({
    root: viewer.root,
    sessionId: viewer.analysisId,
    questionId: first.question.id,
    errorCode: "provider_exit",
  });

  const selectedSecond = await responseJson(await post(viewer.url, "selection", {
    expectedRevision: failed.session.state.revision,
    selectedIds: ["phrase_local_context"],
  }));
  const second = await responseJson(await post(viewer.url, "chat", {
    expectedRevision: selectedSecond.state.revision,
    selectionId: selectedSecond.selection.id,
    message: "This newer question is already queued.",
  }));

  const retry = await post(viewer.url, "chat/retry", {
    questionId: first.question.id,
  });
  assert.equal(retry.status, 409);
  assert.equal((await responseJson(retry)).error.code, "active_response_exists");

  const stored = await loadSession({ root: viewer.root, sessionId: viewer.analysisId });
  const firstStored = turnsFrom(stored).find((turn) => turn.id === first.question.id);
  const secondStored = turnsFrom(stored).find((turn) => turn.id === second.question.id);
  assert.equal(firstStored.response.status, "failed");
  assert.equal(secondStored.response.status, "queued");
});

test("chat rejects a mismatched selection id without writing", async (t) => {
  const viewer = await fixture(t);
  const selectedResponse = await post(viewer.url, "selection", {
    expectedRevision: 0,
    selectedIds: ["phrase_design_system"],
  });
  const selected = await responseJson(selectedResponse);

  const mismatched = await post(viewer.url, "chat", {
    expectedRevision: selected.state.revision,
    selectionId: "selection_0000000000000000",
    message: "This question belongs to a different selection.",
  });
  assert.equal(mismatched.status, 409);
  const conflict = await responseJson(mismatched);
  assert.equal(conflict.error.code, "revision_conflict");
  assert.equal(conflict.error.details.current.state.revision, selected.state.revision);
  assert.equal(conflict.error.details.current.selection.id, selected.selection.id);

  const stored = await loadSession({ root: viewer.root, sessionId: viewer.analysisId });
  assert.equal(stored.state.revision, selected.state.revision);
  assert.deepEqual(turnsFrom(stored), []);
});

test("rejects malformed, oversized, and unsupported mutation requests", async (t) => {
  const viewer = await fixture(t);

  const missingRevision = await post(viewer.url, "chat", {
    selectionId: "selection_0000000000000000",
    message: "A revision is required.",
  });
  assert.equal(missingRevision.status, 400);
  assert.equal((await responseJson(missingRevision)).error.code, "invalid_revision");

  const missingSelectionId = await post(viewer.url, "chat", {
    expectedRevision: 0,
    message: "A selection id is required.",
  });
  assert.equal(missingSelectionId.status, 400);
  assert.equal((await responseJson(missingSelectionId)).error.code, "invalid_selection_id");

  const invalidJson = await post(viewer.url, "selection", "{not json");
  assert.equal(invalidJson.status, 400);
  assert.equal((await responseJson(invalidJson)).error.code, "invalid_json");

  const wrongType = await post(viewer.url, "selection", "hello", { contentType: "text/plain" });
  assert.equal(wrongType.status, 415);
  assert.equal((await responseJson(wrongType)).error.code, "unsupported_media_type");

  const oversized = await post(viewer.url, "chat", JSON.stringify({
    expectedRevision: 0,
    message: "x".repeat(VIEWER_JSON_LIMIT + 1),
  }));
  assert.equal(oversized.status, 413);
  assert.equal((await responseJson(oversized)).error.code, "body_too_large");

  const unexpected = await post(viewer.url, "selection", {
    expectedRevision: 0,
    selectedIds: [],
    root: "/private",
  });
  assert.equal(unexpected.status, 400);
  assert.equal((await responseJson(unexpected)).error.code, "invalid_request");

  const put = await fetch(api(viewer.url, "state"), {
    method: "PUT",
    headers: { Origin: originOf(viewer.url) },
  });
  assert.equal(put.status, 405);
  assert.equal(put.headers.get("allow"), "GET, HEAD, POST");
  assert.equal((await responseJson(put)).error.code, "method_not_allowed");

  const stored = await loadSession({ root: viewer.root, sessionId: viewer.analysisId });
  assert.equal(stored.state.revision, 0);
  assert.equal(turnsFrom(stored).length, 0);
});

test("generates a capability token, rejects non-loopback binds, and closes idempotently", async (t) => {
  const viewer = await fixture(t, { token: undefined });
  assert.match(viewer.token, /^[A-Za-z0-9_-]{32}$/u);
  assert.ok(viewer.url.includes(`/v/${viewer.token}/`));
  await viewer.close();
  await viewer.close();

  await assert.rejects(
    createViewerServer({
      root: viewer.root,
      analysisId: viewer.analysisId,
      assetsDir: viewer.assetsDir,
      host: "0.0.0.0",
    }),
    /loopback-only/u,
  );
});
