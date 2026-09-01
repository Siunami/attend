import { atlasPackageToRenderModel, isAtlasPackage } from "./package-model.js";
import { atlasSelectionSummary, atlasTargetSummary, renderAtlasPackage } from "./package-renderer.js";

const basePath = `${window.location.pathname.replace(/[^/]*$/, "").replace(/\/+$/, "")}/`;
const libraryBasePath = basePath.replace(/s\/[^/]+\/$/u, "");
const chatStorageKey = `attend:active-chat-thread:${libraryBasePath}`;
const hostAttachmentRoute = (() => {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const attachmentId = params.get("attend-host");
  const generation = Number(params.get("attend-generation"));
  if (
    !/^host_[a-f0-9]{16}$/u.test(attachmentId ?? "") ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    return null;
  }
  return { kind: "host", attachmentId, generation };
})();

function hostBoundHref(href) {
  const url = new URL(href, window.location.href);
  if (hostAttachmentRoute) {
    url.hash = new URLSearchParams({
      "attend-host": hostAttachmentRoute.attachmentId,
      "attend-generation": String(hostAttachmentRoute.generation),
    }).toString();
  }
  return url.href;
}

// A workspace gallery embed asks for the visualization alone; the shell
// chrome, question header, chat, and ledger stay hidden.
if (new URLSearchParams(window.location.hash.slice(1)).get("attend-preview") === "1") {
  document.documentElement.setAttribute("data-attend-preview", "true");
}

const libraryReturn = document.querySelector(".library-return");
if (libraryReturn) libraryReturn.href = hostBoundHref(libraryReturn.href);

const elements = {
  workspace: document.getElementById("workspace"),
  map: document.getElementById("map-pane"),
  chat: document.getElementById("chat-pane"),
  chatToggle: document.getElementById("chat-toggle"),
  chatHistory: document.getElementById("chat-history"),
  chatNew: document.getElementById("chat-new"),
  chatClose: document.getElementById("chat-close"),
  chatScroll: document.getElementById("chat-scroll"),
  chatHistoryPanel: document.getElementById("chat-history-panel"),
  chatThreadList: document.getElementById("chat-thread-list"),
  corpusMeta: document.getElementById("corpus-meta"),
  question: document.getElementById("question-heading"),
  target: document.getElementById("question-target"),
  phraseList: document.getElementById("phrase-list"),
  empty: document.getElementById("empty-state"),
  eyebrow: document.getElementById("visualization-kind"),
  atlasView: document.getElementById("atlas-view"),
  atlasVisual: document.getElementById("atlas-visual"),
  atlasAbstention: document.getElementById("atlas-abstention"),
  selection: document.getElementById("selection-panel"),
  conversation: document.getElementById("conversation"),
  form: document.getElementById("chat-form"),
  input: document.getElementById("chat-input"),
  submit: document.getElementById("chat-submit"),
  areaSelect: document.getElementById("chat-area-select"),
  suggestion: document.getElementById("suggested-question"),
  suggestionText: document.getElementById("suggested-question-text"),
  status: document.getElementById("status"),
};

let dataPackage;
let session;
let chat;
let activeThread;
let chatThreads = [];
let pending = false;
let chatOpen = false;
let viewingHistory = false;
let chatPinned = true;
let draftSelectionKey = null;
let atlasRenderRevision = 0;
let areaSelectMode = false;
const OPTIMISTIC_TURN_ID = "optimistic";
const POLL_INTERVAL_MS = 1500;
const STREAMED_POLL_BEATS = 3;
const STATE_REFRESH_DEBOUNCE_MS = 60;
let optimisticTurn = null;
let questionPreview = null;
let eventStreamHealthy = false;
let stateRefreshTimer = null;
let areaDrag = null;
const MAX_AREA_SELECTION = 50;
const AREA_DRAG_THRESHOLD = 4;
const TARGET_MEMBER_PAGE_LIMIT = 12;
let targetMemberLoadRevision = 0;
let targetMemberPage = {
  targetId: null,
  status: "idle",
  offset: 0,
  count: 0,
  markIds: [],
  evidenceRefIds: [],
  nextOffset: null,
  error: null,
};

function apiUrl(path) {
  const url = new URL(`${basePath}api/${path}`, window.location.origin);
  if (hostAttachmentRoute) {
    url.searchParams.set("attend-host", hostAttachmentRoute.attachmentId);
    url.searchParams.set("attend-generation", String(hostAttachmentRoute.generation));
  }
  return url.href;
}

async function request(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      payload.error?.message || payload.error || `Request failed (${response.status})`,
    );
    error.status = response.status;
    error.details = payload.error?.details;
    throw error;
  }
  return payload;
}

function unwrapSession(payload) {
  return payload.session || payload;
}

function unwrapArtifact(payload) {
  return payload.package || payload.artifact || payload.dataPackage || payload;
}

function chatProjection(payload) {
  return payload?.chat ?? payload?.session?.chat ?? null;
}

function acceptChatProjection(payload) {
  const next = chatProjection(payload);
  if (!next) return false;
  const changed = JSON.stringify(next) !== JSON.stringify(chat);
  chat = next;
  return changed;
}

function threadProjection(payload) {
  const source = payload?.thread ?? payload?.session?.conversation ?? payload?.conversation;
  if (
    !source ||
    (typeof source.id !== "string" && typeof source.threadId !== "string") ||
    !Array.isArray(source.turns) ||
    !Array.isArray(source.events)
  ) {
    return null;
  }
  return {
    ...source,
    id: source.id ?? source.threadId,
  };
}

function acceptThreadProjection(payload) {
  const next = threadProjection(payload);
  if (!next) return false;
  optimisticTurn = null;
  const changed = next.revision !== activeThread?.revision;
  activeThread = next;
  try {
    localStorage.setItem(chatStorageKey, activeThread.id);
  } catch {
    // Private browsing or a full quota must not make local chat unusable.
  }
  return changed;
}

function storedThreadId() {
  try {
    const threadId = localStorage.getItem(chatStorageKey);
    return /^(?:thread|legacy)_[a-f0-9]{24}$/u.test(threadId ?? "")
      ? threadId
      : null;
  } catch {
    return null;
  }
}

function activeChatRoute() {
  const active = chat?.active;
  if (active?.kind === "local" && active.model === "gpt-oss-20b") {
    return active;
  }
  if (
    active?.kind === "detached" &&
    (active.adapter === "codex-cli" || active.adapter === "claude-cli")
  ) {
    return active;
  }
  if (active?.kind === "host") return active;
  return {
    kind: "local",
    model: "gpt-oss-20b",
    label: "Private AI on this Mac",
    available: false,
    disclosure: "Checking the private local model.",
  };
}

function detachedProviderLabel(adapter) {
  return adapter === "claude-cli" ? "Claude CLI" : "Codex CLI";
}

function countLabel(count) {
  return count === 1 ? "occurrence" : "occurrences";
}

function sourceLabel(count) {
  return count === 1 ? "source" : "sources";
}

function atlasMode() {
  return dataPackage?.schemaVersion === 2 && isAtlasPackage(dataPackage);
}

function sessionRevision(value = session) {
  return value?.state?.revision ?? value?.revision ?? 0;
}

function atlasSessionId(value = session) {
  return value?.id ?? value?.sessionId ?? value?.analysisId ?? dataPackage?.packageId ?? dataPackage?.id;
}

function atlasSelectedMarkIds(value = session) {
  const selection = value?.selection ?? {};
  const state = value?.state ?? {};
  const candidates = selection.selectedMarkIds
    ?? selection.markIds
    ?? state.selectedMarkIds
    ?? state.markIds
    ?? (Array.isArray(selection.marks) ? selection.marks.map((mark) => mark.id ?? mark.markId) : []);
  if (!Array.isArray(candidates)) return [];
  let allowed = null;
  try {
    allowed = new Set(atlasPackageToRenderModel(dataPackage).selectableMarkIds);
  } catch {
    allowed = null;
  }
  return [...new Set(candidates.map(String).filter((id) => !allowed || allowed.has(id)))];
}

function atlasSelectedMarks(value = session) {
  if (!atlasMode()) return [];
  try {
    return atlasSelectionSummary(dataPackage, atlasSelectedMarkIds(value));
  } catch {
    return [];
  }
}

function atlasSelectedTargetId(value = session) {
  const candidate = value?.selection?.targetId ?? value?.state?.targetId ?? null;
  if (typeof candidate !== "string" || !candidate) return null;
  try {
    return atlasPackageToRenderModel(dataPackage).selectableTargetIds.includes(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function atlasSelectedTarget(value = session) {
  const targetId = atlasSelectedTargetId(value);
  if (!targetId) return null;
  try {
    return atlasTargetSummary(dataPackage, targetId);
  } catch {
    return null;
  }
}

function resetTargetMemberPage(targetId = null) {
  targetMemberLoadRevision += 1;
  targetMemberPage = {
    targetId,
    status: "idle",
    offset: 0,
    count: 0,
    markIds: [],
    evidenceRefIds: [],
    nextOffset: null,
    error: null,
  };
}

function targetMembersPath(targetId, offset) {
  const query = new URLSearchParams({
    targetId,
    offset: String(offset),
    limit: String(TARGET_MEMBER_PAGE_LIMIT),
  });
  return `target-members?${query}`;
}

async function loadTargetMemberPage(targetId, offset = 0) {
  if (atlasSelectedTargetId() !== targetId) return;
  if (targetMemberPage.targetId !== targetId) resetTargetMemberPage(targetId);
  const requestRevision = ++targetMemberLoadRevision;
  targetMemberPage = { ...targetMemberPage, status: "loading", offset, error: null };
  try {
    const payload = await request(targetMembersPath(targetId, offset));
    if (requestRevision !== targetMemberLoadRevision || atlasSelectedTargetId() !== targetId) return;
    if (
      payload?.target?.id !== targetId
      || !Array.isArray(payload.markIds)
      || !Array.isArray(payload.evidenceRefIds)
      || !Number.isSafeInteger(payload.count)
      || !Number.isSafeInteger(payload.page?.offset)
    ) {
      throw new Error("The aggregate evidence page was malformed.");
    }
    targetMemberPage = {
      targetId,
      status: "ready",
      offset: payload.page.offset,
      count: payload.count,
      markIds: payload.markIds.map(String),
      evidenceRefIds: payload.evidenceRefIds.map(String),
      nextOffset: Number.isSafeInteger(payload.page.nextOffset) ? payload.page.nextOffset : null,
      error: null,
    };
    renderSelection();
  } catch (error) {
    if (requestRevision !== targetMemberLoadRevision || atlasSelectedTargetId() !== targetId) return;
    targetMemberPage = {
      ...targetMemberPage,
      status: "error",
      error: error instanceof Error ? error.message : "The aggregate evidence page could not be loaded.",
    };
    renderSelection();
  }
}

function targetMemberLabel(markId) {
  try {
    return atlasPackageToRenderModel(dataPackage).markById[markId]?.label ?? markId;
  } catch {
    return markId;
  }
}

function renderTargetMembersDrawer(target) {
  if (targetMemberPage.targetId !== target.id) resetTargetMemberPage(target.id);
  const drawer = document.createElement("details");
  drawer.className = "target-members-drawer";
  drawer.open = true;
  const summary = document.createElement("summary");
  summary.textContent = `Evidence members · ${target.count}`;
  drawer.append(summary);

  const body = document.createElement("div");
  body.className = "target-members-body";
  body.setAttribute("aria-live", "polite");
  if (targetMemberPage.status === "ready") {
    const start = targetMemberPage.count === 0 ? 0 : targetMemberPage.offset + 1;
    const end = targetMemberPage.offset + targetMemberPage.markIds.length;
    const status = document.createElement("p");
    status.className = "target-members-status";
    status.textContent = `Showing ${start}–${end} of ${targetMemberPage.count}`;
    const members = document.createElement("ol");
    members.className = "target-members-list";
    members.start = start || 1;
    targetMemberPage.markIds.forEach((markId) => {
      const item = document.createElement("li");
      item.textContent = targetMemberLabel(markId);
      members.append(item);
    });
    const navigation = document.createElement("nav");
    navigation.className = "target-members-navigation";
    navigation.setAttribute("aria-label", "Aggregate evidence pages");
    const previous = document.createElement("button");
    previous.type = "button";
    previous.textContent = "Previous";
    previous.disabled = targetMemberPage.offset === 0;
    previous.addEventListener("click", () => loadTargetMemberPage(
      target.id,
      Math.max(0, targetMemberPage.offset - TARGET_MEMBER_PAGE_LIMIT),
    ));
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "Next";
    next.disabled = targetMemberPage.nextOffset === null;
    next.addEventListener("click", () => loadTargetMemberPage(target.id, targetMemberPage.nextOffset));
    navigation.append(previous, next);
    body.append(status, members, navigation);
  } else if (targetMemberPage.status === "error") {
    const error = document.createElement("p");
    error.className = "target-members-error";
    error.textContent = targetMemberPage.error;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => loadTargetMemberPage(target.id, targetMemberPage.offset));
    body.append(error, retry);
  } else {
    const loading = document.createElement("p");
    loading.className = "target-members-status";
    loading.textContent = "Resolving complete membership…";
    body.append(loading);
  }
  drawer.append(body);
  if (targetMemberPage.status === "idle") loadTargetMemberPage(target.id, 0);
  return drawer;
}

function selectedContactOriginal(marks) {
  if (marks.length !== 1) return null;
  let model;
  try {
    model = atlasPackageToRenderModel(dataPackage);
  } catch {
    return null;
  }
  if (model.familyId !== "collection-atlas" || model.memberId !== "contact-atlas") return null;
  const mark = marks[0];
  const assetId = mark.values?.assetId;
  const route = mark.values?.previewRoute;
  if (!/^asset_[a-f0-9]{32}$/u.test(assetId ?? "") || route !== `assets/${assetId}`) return null;
  if (mark.media?.preview?.src !== route) return null;
  const href = new URL(route, window.location.href);
  const assetRoot = new URL("./assets/", window.location.href);
  if (href.origin !== window.location.origin || !href.pathname.startsWith(assetRoot.pathname)) return null;
  return { href: href.href, label: mark.label };
}

function renderContactOriginalDetail(original) {
  const detail = document.createElement("div");
  detail.className = "contact-original-detail";
  const label = document.createElement("span");
  label.textContent = "Whole-file evidence · staged JPEG";
  const link = document.createElement("a");
  link.href = original.href;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Open staged original";
  link.setAttribute("aria-label", `Open staged original for ${original.label}`);
  detail.append(label, link);
  return detail;
}

function atlasSelectedFocus(value = session) {
  const focus = value?.selection?.focus ?? value?.state?.focus ?? null;
  if (focus?.kind !== "node" || typeof focus.id !== "string" || !focus.id) return null;
  return { kind: "node", id: focus.id, label: focus.label ?? focus.id };
}

function currentMark() {
  return session?.selection?.marks?.length === 1 ? session.selection.marks[0] : null;
}

function currentSuggestedQuestion() {
  if (atlasMode()) {
    const marks = atlasSelectedMarks();
    const target = atlasSelectedTarget();
    if (target) return `What does the selected “${target.label}” aggregate reveal about this view?`;
    if (!marks.length) return "";
    const focus = atlasSelectedFocus();
    if (focus) return `What role does the selected “${focus.label}” component play in this view?`;
    if (marks.length === 1) return `What does the selected “${marks[0].label}” reveal about this view?`;
    return `What patterns connect these ${marks.length} selected marks?`;
  }
  const mark = currentMark();
  if (!mark) return "";
  return mark.distinctSourceCount === 1
    ? `What does this source say about “${mark.phrase}”?`
    : `What themes and changes emerge across the ${mark.distinctSourceCount} sources containing “${mark.phrase}”?`;
}

function semanticAttachmentKey(value = session) {
  const sourceSelection = value?.selection || {};
  const selectedMarkIds = atlasMode() ? atlasSelectedMarkIds(value) : sourceSelection.selectedMarkIds || [];
  const selection = atlasMode()
    ? { ...sourceSelection, selectedMarkIds }
    : sourceSelection;
  const targetId = atlasMode() ? atlasSelectedTargetId(value) : null;
  if (!selection?.selectedMarkIds?.length && !targetId) return null;
  return JSON.stringify({
    dataPackageId: selection.dataPackageId,
    dataHash: selection.dataHash,
    map: selection.map,
    selectedMarkIds: selection.selectedMarkIds,
    targetId,
    focus: selection.focus,
    predicate: selection.predicate,
    filters: selection.filters,
    aggregation: selection.aggregation,
    sort: selection.sort,
  });
}

function pinDraftToCurrentSelection() {
  draftSelectionKey = elements.input.value ? semanticAttachmentKey() : null;
}

function draftNeedsReview() {
  return draftSelectionKey !== null && draftSelectionKey !== semanticAttachmentKey();
}

function hasActiveResponse(value = activeThread) {
  const turns = value?.turns || value?.conversation?.turns || [];
  const answeredQuestionIds = new Set(
    turns
      .filter((turn) => turn.role === "assistant" && turn.replyToTurnId)
      .map((turn) => turn.replyToTurnId),
  );
  return turns.some(
    (turn) =>
      turn.role === "user" &&
      !answeredQuestionIds.has(turn.id) &&
      (turn.response?.status === "queued" || turn.response?.status === "running"),
  );
}

function setStatus(message = "", isError = false) {
  elements.status.textContent = message;
  elements.status.classList.toggle("is-error", isError);
}

function setChatOpen(open) {
  chatOpen = open;
  elements.workspace.dataset.chatOpen = String(open);
  elements.chatToggle.setAttribute("aria-expanded", String(open));
  elements.chat.setAttribute("aria-hidden", String(!open));
  elements.chat.inert = !open;
}

function openChat() {
  setChatOpen(true);
  if (chatPinned) {
    elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight;
  }
}

function closeChat({ restoreFocus = true } = {}) {
  setHistoryOpen(false);
  setChatOpen(false);
  if (restoreFocus) elements.chatToggle.focus();
}

function setHistoryOpen(open) {
  viewingHistory = open;
  elements.chatHistoryPanel.hidden = !open;
  elements.conversation.hidden = open;
  elements.form.hidden = open;
  elements.chatHistory.setAttribute("aria-expanded", String(open));
}

function threadStatePath(threadId) {
  return `state?threadId=${encodeURIComponent(threadId)}`;
}

function renderChatHistory() {
  const visible = chatThreads.filter(
    (thread) => thread.messageCount > 0 || thread.id === activeThread?.id,
  );
  const rows = visible.map((thread) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chat-thread-button";
    button.textContent = thread.title || thread.initialPage?.label || "New chat";
    if (thread.id === activeThread?.id) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => activateChatThread(thread.id));
    item.append(button);
    return item;
  });
  elements.chatThreadList.replaceChildren(...rows);
}

async function refreshChatHistory() {
  const payload = await request("chat/threads");
  chatThreads = Array.isArray(payload.threads) ? payload.threads : [];
  renderChatHistory();
  return chatThreads;
}

function clearChatDraft() {
  elements.input.value = "";
  draftSelectionKey = null;
}

async function activateChatThread(threadId, { follow = true } = {}) {
  if (pending || (threadId === activeThread?.id && !viewingHistory)) return;
  pending = true;
  syncComposer();
  try {
    const payload = await request(threadStatePath(threadId));
    acceptChatProjection(payload);
    acceptThreadProjection(payload);
    session = unwrapSession(payload);
    clearChatDraft();
    setHistoryOpen(false);
    chatPinned = true;
    renderState({ followConversation: follow });
    setStatus("");
    elements.input.focus();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    pending = false;
    syncComposer();
  }
}

async function createNewChat() {
  if (pending) return;
  pending = true;
  syncComposer();
  try {
    const created = await request("chat/threads", {
      method: "POST",
      body: JSON.stringify({}),
    });
    acceptThreadProjection(created);
    const payload = await request(threadStatePath(activeThread.id));
    acceptChatProjection(payload);
    acceptThreadProjection(payload);
    session = unwrapSession(payload);
    clearChatDraft();
    setHistoryOpen(false);
    chatPinned = true;
    await refreshChatHistory();
    renderState({ followConversation: true });
    setStatus("");
    elements.input.focus();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    pending = false;
    syncComposer();
  }
}

function syncComposer() {
  const suggestedQuestion = currentSuggestedQuestion();
  const responseActive = hasActiveResponse();
  const route = activeChatRoute();
  const hostUnattached = route.kind === "host" && route.registered === false;
  const showSuggestion = Boolean(
    suggestedQuestion && elements.input.value === "" && !responseActive && !hostUnattached,
  );
  elements.suggestion.hidden = !showSuggestion;
  elements.suggestionText.textContent = showSuggestion ? suggestedQuestion : "";
  elements.input.placeholder = hostUnattached
    ? "Sidebar chat is unavailable from this library link."
    : showSuggestion
      ? ""
      : "Ask about this view";
  if (showSuggestion) {
    elements.input.setAttribute("aria-describedby", "suggested-question");
  } else {
    elements.input.removeAttribute("aria-describedby");
  }
  elements.input.disabled = responseActive || hostUnattached;
  elements.areaSelect.hidden = !atlasMode();
  elements.submit.disabled =
    pending || responseActive || hostUnattached || !elements.input.value.trim() || draftNeedsReview();
}

function renderHeader() {
  if (atlasMode()) {
    const model = atlasPackageToRenderModel(dataPackage);
    elements.eyebrow.textContent = `Family Atlas · ${model.catalog.family.replaceAll("-", " ")} / ${model.catalog.member.replaceAll("-", " ")}`;
    elements.question.textContent = model.title;
    elements.target.textContent = model.question;
    elements.corpusMeta.textContent = `${model.records.length} marks · ${model.evidence.length} evidence references · package ${model.packageId}`;
    return;
  }
  elements.eyebrow.textContent = "Phrase recurrence";
  const sourceCount = dataPackage.sources.length;
  const phraseCount = dataPackage.rows.length;
  const skippedInputCount = (dataPackage.knownOmissions || []).filter(
    (omission) => omission.skipped === true,
  ).length;
  elements.question.textContent = dataPackage.question.text;
  elements.target.textContent = dataPackage.question.target
    ? `Corpus: ${dataPackage.question.target}`
    : "";
  elements.corpusMeta.textContent = `${phraseCount} recurring phrases · ${sourceCount} ${sourceLabel(sourceCount)}${
    skippedInputCount ? ` · ${skippedInputCount} skipped input${skippedInputCount === 1 ? "" : "s"}` : ""
  }`;
}

function renderPhrases() {
  if (atlasMode()) {
    elements.phraseList.replaceChildren();
    elements.phraseList.hidden = true;
    elements.empty.hidden = true;
    elements.atlasView.hidden = false;
    return;
  }
  elements.phraseList.hidden = false;
  elements.atlasView.hidden = true;
  elements.phraseList.replaceChildren();
  elements.empty.hidden = dataPackage.rows.length > 0;
  if (dataPackage.rows.length === 0) {
    const minCount = dataPackage.config.minCount;
    const minSources = dataPackage.config.minSources;
    elements.empty.textContent = `No phrases appeared at least ${minCount} time${minCount === 1 ? "" : "s"} across at least ${minSources} ${sourceLabel(minSources)}.`;
  }
  const selected = new Set(session.state.selectedIds || []);
  const maxCount = Math.max(1, ...dataPackage.rows.map((row) => row.occurrenceCount));

  for (const row of dataPackage.rows) {
    const item = document.createElement("li");
    item.className = "phrase-item";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "phrase-button";
    button.dataset.rowId = row.id;
    button.setAttribute("aria-pressed", String(selected.has(row.id)));
    button.setAttribute(
      "aria-label",
      `${row.phrase}: ${row.occurrenceCount} ${countLabel(row.occurrenceCount)} across ${row.distinctSourceCount} ${sourceLabel(row.distinctSourceCount)}`,
    );
    button.dataset.bar = String(
      Math.max(5, Math.ceil((row.occurrenceCount / maxCount) * 20) * 5),
    );

    const copy = document.createElement("span");
    copy.className = "phrase-copy";
    const phrase = document.createElement("span");
    phrase.className = "phrase-text";
    phrase.textContent = row.phrase;
    const sourceLine = document.createElement("span");
    sourceLine.className = "source-line";
    sourceLine.textContent = `${row.distinctSourceCount} ${sourceLabel(row.distinctSourceCount)}`;
    copy.append(phrase, sourceLine);

    const stats = document.createElement("span");
    stats.className = "phrase-stats";
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(row.occurrenceCount);
    const label = document.createElement("span");
    label.className = "count-label";
    label.textContent = countLabel(row.occurrenceCount);
    stats.append(count, label);

    button.append(copy, stats);
    button.addEventListener("click", () => selectRow(row.id));
    item.append(button);
    elements.phraseList.append(item);
  }
}

async function renderAtlasVisualization() {
  if (!atlasMode() || !elements.atlasVisual) return;
  const revision = ++atlasRenderRevision;
  const selectedMarkIds = atlasSelectedMarkIds();
  elements.atlasVisual.setAttribute("aria-busy", "true");
  elements.atlasAbstention.hidden = true;
  try {
    await renderAtlasPackage({
      root: elements.atlasVisual,
      packageValue: dataPackage,
      selectedMarkIds,
      selectedNodeId: atlasSelectedFocus()?.id,
      selectedTargetId: atlasSelectedTargetId(),
      onSelect: (target) => selectAtlasTarget(target),
      onClear: () => clearAtlasSelection(),
      loadTargetMembers: async ({ targetId, offset }) => {
        const payload = await request(targetMembersPath(targetId, offset));
        return {
          markIds: Array.isArray(payload?.markIds) ? payload.markIds.map(String) : [],
          count: Number.isSafeInteger(payload?.count) ? payload.count : 0,
          offset: Number.isSafeInteger(payload?.page?.offset) ? payload.page.offset : offset,
          nextOffset: Number.isSafeInteger(payload?.page?.nextOffset) ? payload.page.nextOffset : null,
          limit: TARGET_MEMBER_PAGE_LIMIT,
        };
      },
    });
    if (revision !== atlasRenderRevision) return;
  } catch (error) {
    if (revision !== atlasRenderRevision) return;
    elements.atlasVisual.replaceChildren();
    elements.atlasAbstention.hidden = false;
    elements.atlasAbstention.textContent = error instanceof Error
      ? `This view abstained: ${error.message}`
      : "This view abstained because its package could not be rendered.";
  } finally {
    if (revision === atlasRenderRevision) elements.atlasVisual.setAttribute("aria-busy", "false");
  }
}

function setAreaSelectMode(on) {
  const next = Boolean(on) && atlasMode();
  if (!next) endAreaDrag();
  if (next === areaSelectMode) return;
  areaSelectMode = next;
  elements.workspace.dataset.areaSelect = String(next);
  elements.areaSelect.setAttribute("aria-pressed", String(next));
  setStatus(next ? "Area select on. Drag across the chart to attach marks. Escape exits." : "");
}

function endAreaDrag() {
  if (!areaDrag) return;
  areaDrag.marquee.remove();
  if (elements.atlasVisual.hasPointerCapture(areaDrag.pointerId)) {
    elements.atlasVisual.releasePointerCapture(areaDrag.pointerId);
  }
  areaDrag = null;
}

function areaSelectViewBox(svg) {
  const numbers = (svg.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/u).map(Number);
  return numbers.length === 4 && numbers.every(Number.isFinite) ? numbers : null;
}

function marksWithinClientRect(bounds) {
  const ids = [];
  const seen = new Set();
  for (const element of elements.atlasVisual.querySelectorAll("[data-mark-id]")) {
    const markId = element.getAttribute("data-mark-id");
    if (!markId || seen.has(markId)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.left > bounds.maxX || rect.right < bounds.minX) continue;
    if (rect.top > bounds.maxY || rect.bottom < bounds.minY) continue;
    seen.add(markId);
    ids.push(markId);
  }
  return ids;
}

function createReplyArrow() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("reply-arrow");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "17");
  svg.setAttribute("height", "17");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M9 7 4 12l5 5M4 12h8a6 6 0 0 1 6 6");
  svg.append(path);
  return svg;
}

function appendReplyAttachment(container, label) {
  const copy = document.createElement("div");
  copy.className = "attachment-copy";
  const phrase = document.createElement("strong");
  phrase.className = "attachment-phrase";
  phrase.textContent = `“${label}”`;
  copy.append(createReplyArrow(), phrase);
  container.append(copy);
}

const SHARED_FACET_KEYS = ["series", "category", "kind", "source", "status"];
const TIME_FACET_KEY_PATTERN = /(?:time|date|start|week)/iu;

function sharedFacetValue(marks) {
  for (const key of SHARED_FACET_KEYS) {
    const rendered = String(marks[0]?.values?.[key] ?? "");
    if (!rendered) continue;
    if (marks.every((mark) => String(mark?.values?.[key] ?? "") === rendered)) return rendered;
  }
  return null;
}

// A bare series value like "5" parses as a month, so a time facet needs a year in it.
function timeFacetValue(value) {
  return typeof value === "string" && /\d{4}/u.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function sharedTimeExtent(marks) {
  const candidates = [];
  for (const mark of marks) {
    for (const key of Object.keys(mark?.values ?? {})) {
      if (TIME_FACET_KEY_PATTERN.test(key) && !candidates.includes(key)) candidates.push(key);
    }
  }
  for (const key of candidates) {
    const times = marks.map((mark) => timeFacetValue(mark?.values?.[key]));
    if (times.some((value) => value === null)) continue;
    const ordered = times
      .map((value) => ({ value, time: Date.parse(value) }))
      .sort((left, right) => left.time - right.time);
    const min = ordered[0].value;
    const max = ordered[ordered.length - 1].value;
    return min === max ? min : `${min} → ${max}`;
  }
  return null;
}

function atlasMultiSelectionSummary(marks) {
  const facets = [sharedFacetValue(marks), sharedTimeExtent(marks)].filter(Boolean);
  if (!facets.length) return `${marks.length} marks · ${marks[0].label} …`;
  return [`${marks.length} marks`, ...facets].join(" · ");
}

function renderSelection() {
  elements.selection.replaceChildren();
  if (atlasMode()) {
    const marks = atlasSelectedMarks();
    const target = atlasSelectedTarget();
    const focus = atlasSelectedFocus();
    elements.selection.hidden = marks.length === 0 && !target;
    if (!marks.length && !target) {
      if (targetMemberPage.targetId !== null) resetTargetMemberPage();
      syncComposer();
      return;
    }
    const attachment = document.createElement("div");
    attachment.className = "selection-attachment atlas-selection-attachment";
    const name = target?.label
      ?? focus?.label
      ?? (marks.length > 3
        ? atlasMultiSelectionSummary(marks)
        : marks.map((mark) => mark.label).join(" · "));
    appendReplyAttachment(attachment, name);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "selection-remove attachment-remove";
    remove.setAttribute(
      "aria-label",
      target ? `Remove attached aggregate ${target.label}`
        : focus ? `Remove attached component ${focus.label}`
          : marks.length > 1 ? `Remove ${marks.length} selected marks`
            : `Remove attached mark ${marks[0].label}`,
    );
    remove.textContent = "×";
    remove.addEventListener("click", clearSelection);
    attachment.append(remove);
    elements.selection.append(attachment);
    const contactOriginal = selectedContactOriginal(marks);
    if (contactOriginal) elements.selection.append(renderContactOriginalDetail(contactOriginal));
    if (target) elements.selection.append(renderTargetMembersDrawer(target));
    syncComposer();
    return;
  }
  const mark = currentMark();
  elements.selection.hidden = !mark;
  if (!mark) {
    syncComposer();
    return;
  }

  const attachment = document.createElement("div");
  attachment.className = "selection-attachment";
  appendReplyAttachment(attachment, mark.phrase);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "selection-remove attachment-remove";
  remove.setAttribute("aria-label", `Remove attached phrase “${mark.phrase}”`);
  remove.textContent = "×";
  remove.addEventListener("click", clearSelection);

  attachment.append(remove);
  elements.selection.append(attachment);
  syncComposer();
}

function isLegacyContextReceipt(turn) {
  const text = turn.message || turn.content || "";
  return turn.role === "assistant" && /^Context saved (?:from|with)/u.test(text);
}

function historicalAttachment(turn) {
  const marks = Array.isArray(turn.selection?.marks) ? turn.selection.marks : [];
  const focus = turn.selection?.focus?.kind === "node" ? turn.selection.focus : null;
  const names = focus
    ? [focus.label ?? focus.id]
    : marks
        .map((mark) => mark.label ?? mark.phrase ?? mark.id ?? mark.markId)
        .filter(Boolean);
  if (!names.length) return null;
  const attachment = document.createElement("div");
  attachment.className = "turn-attachment";
  attachment.setAttribute("aria-label", `Attached visual context: ${names.join(", ")}`);
  attachment.append(createReplyArrow());
  const phrase = document.createElement("strong");
  phrase.className = "turn-attachment-phrase";
  phrase.textContent = `“${names.join(" · ")}”`;
  attachment.append(phrase);
  return attachment;
}

function safeExternalHref(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function appendInlineFormatting(parent, value) {
  const source = String(value ?? "");
  const tokenPattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/gu;
  let cursor = 0;

  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > cursor) parent.append(document.createTextNode(source.slice(cursor, index)));

    let element;
    if (token.startsWith("`")) {
      element = document.createElement("code");
      element.textContent = token.slice(1, -1);
    } else if (token.startsWith("**")) {
      element = document.createElement("strong");
      element.textContent = token.slice(2, -2);
    } else if (token.startsWith("*")) {
      element = document.createElement("em");
      element.textContent = token.slice(1, -1);
    } else {
      const link = /^\[([^\]\n]+)\]\(([^\s)]+)\)$/u.exec(token);
      const href = link ? safeExternalHref(link[2]) : null;
      if (link && href) {
        element = document.createElement("a");
        element.href = href;
        element.target = "_blank";
        element.rel = "noopener noreferrer";
        element.textContent = link[1];
      } else {
        element = document.createTextNode(token);
      }
    }
    parent.append(element);
    cursor = index + token.length;
  }

  if (cursor < source.length) {
    parent.append(document.createTextNode(source.slice(cursor)));
  }
}

function renderAssistantMessage(value) {
  const message = document.createElement("div");
  message.className = "turn turn-assistant";
  const lines = String(value ?? "").replace(/\r\n?/gu, "\n").split("\n");
  let paragraphLines = [];
  let list = null;
  let quoteLines = [];
  let codeLines = null;

  const appendTextBlock = (tagName, text) => {
    const block = document.createElement(tagName);
    appendInlineFormatting(block, text);
    message.append(block);
  };
  const flushParagraph = () => {
    if (paragraphLines.length) {
      appendTextBlock("p", paragraphLines.join(" ").trim());
      paragraphLines = [];
    }
  };
  const flushList = () => {
    list = null;
  };
  const flushQuote = () => {
    if (quoteLines.length) {
      const quote = document.createElement("blockquote");
      appendInlineFormatting(quote, quoteLines.join(" ").trim());
      message.append(quote);
      quoteLines = [];
    }
  };
  const appendCodeBlock = () => {
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = (codeLines || []).join("\n");
    pre.append(code);
    message.append(pre);
    codeLines = null;
  };
  const flushBlocks = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    if (/^\s*```/u.test(line)) {
      if (codeLines === null) {
        flushBlocks();
        codeLines = [];
      } else {
        appendCodeBlock();
      }
      continue;
    }
    if (codeLines !== null) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushBlocks();
      continue;
    }

    const heading = /^\s{0,3}(#{1,4})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) {
      flushBlocks();
      appendTextBlock(heading[1].length <= 2 ? "h3" : "h4", heading[2]);
      continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
      flushBlocks();
      message.append(document.createElement("hr"));
      continue;
    }

    const unordered = /^\s{0,3}[-+*]\s+(.+)$/u.exec(line);
    const ordered = /^\s{0,3}(\d+)[.)]\s+(.+)$/u.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      const tagName = ordered ? "ol" : "ul";
      if (!list || list.localName !== tagName) {
        list = document.createElement(tagName);
        const start = ordered ? Number(ordered[1]) : 1;
        if (Number.isSafeInteger(start) && start > 1 && start <= 1_000_000) {
          list.start = start;
        }
        message.append(list);
      }
      const item = document.createElement("li");
      appendInlineFormatting(item, unordered ? unordered[1] : ordered[2]);
      list.append(item);
      continue;
    }

    const quote = /^\s{0,3}>\s?(.*)$/u.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      quoteLines.push(quote[1]);
      continue;
    }

    flushList();
    flushQuote();
    paragraphLines.push(line.trim());
  }

  if (codeLines !== null) appendCodeBlock();
  flushBlocks();
  if (!message.childNodes.length) appendTextBlock("p", "");
  return message;
}

function failedResponseMessage(errorCode) {
  if (errorCode === "timeout") return "The answer took too long.";
  if (errorCode === "runner_unavailable") return "Chat is temporarily unavailable.";
  return "The answer could not be generated.";
}

function questionRoute(turn) {
  const route = turn.response?.route;
  if (route?.kind === "local" && route.model === "gpt-oss-20b") {
    return route;
  }
  if (
    route?.kind === "detached" &&
    (route.adapter === "codex-cli" || route.adapter === "claude-cli")
  ) {
    return route;
  }
  return { kind: "host" };
}

function activeResponseMessage(turn) {
  const route = questionRoute(turn);
  if (route.kind === "local") {
    return turn.response?.status === "running"
      ? "Answering privately on this Mac."
      : "Waiting for the private local model.";
  }
  if (route.kind === "detached") {
    const provider = detachedProviderLabel(route.adapter);
    return turn.response?.status === "running"
      ? `Detached fallback: ${provider} is answering.`
      : `Detached fallback: ${provider}. Waiting for the provider.`;
  }

  const activeRoute = activeChatRoute();
  if (activeRoute.kind === "host" && activeRoute.ownership === "another-host") {
    return "Another coding agent owns this queued question.";
  }
  const listener = activeRoute.kind === "host"
    ? activeRoute.listener
    : "not-listening";
  if (listener === "delivered") {
    return "Question delivered to the coding agent that opened this view; waiting for its guarded reply.";
  }
  if (listener === "listening") {
    return "Waiting for the coding agent that opened this view.";
  }
  return "Saved locally. Attend cannot wake an inactive agent.";
}

function questionPreviewFor(questionId) {
  if (!questionPreview || questionPreview.questionId !== questionId || !questionPreview.text) return null;
  const message = renderAssistantMessage(questionPreview.text);
  message.classList.add("turn-stream");
  return message;
}

function paintQuestionPreview() {
  const message = questionPreviewFor(questionPreview?.questionId);
  if (!message) return false;
  for (const wrap of elements.conversation.querySelectorAll(".turn-wrap-transient")) {
    if (wrap.getAttribute("data-question-id") !== questionPreview.questionId) continue;
    wrap.replaceChildren(message);
    if (chatPinned) elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight;
    return true;
  }
  return false;
}

function responseState(turn, answeredQuestionIds) {
  if (turn.role !== "user" || answeredQuestionIds.has(turn.id)) return null;
  const status = turn.response?.status;
  let response;
  if (status === "queued" || status === "running") {
    response = questionPreviewFor(turn.id);
    if (!response) {
      const active = document.createElement("span");
      active.className = "turn-response turn-response-active";
      active.setAttribute("role", "status");
      active.textContent = activeResponseMessage(turn);
      response = active;
    }
  } else if (status === "failed") {
    const failure = document.createElement("div");
    failure.className = "turn-response turn-response-failed";
    failure.setAttribute("role", "alert");
    const message = document.createElement("span");
    message.textContent = failedResponseMessage(turn.response?.errorCode);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "turn-retry";
    retry.textContent = "Retry";
    retry.disabled = hasActiveResponse();
    retry.addEventListener("click", () => retryQuestion(turn.id));
    failure.append(message, retry);
    response = failure;
  } else {
    return null;
  }

  const wrap = document.createElement("article");
  wrap.className = "turn-wrap turn-wrap-assistant turn-wrap-transient";
  wrap.setAttribute("data-question-id", turn.id);
  if (turn.id === OPTIMISTIC_TURN_ID) wrap.setAttribute("data-optimistic", "true");
  wrap.append(response);
  return wrap;
}

function pageContextEvent(event) {
  const row = document.createElement("div");
  row.className = "page-context-event";
  const link = document.createElement("a");
  link.href = hostBoundHref(event.page.href);
  link.textContent = event.page.label;
  link.setAttribute("aria-label", `Open page: ${event.page.label}`);
  row.append(link);
  return row;
}

function renderConversation({ follow = false, focusTurnId = null } = {}) {
  const previousTop = elements.chatScroll.scrollTop;
  const shouldFollow = follow || chatPinned;
  let focusedTurn = null;
  elements.conversation.replaceChildren();
  const rawTurns = activeThread?.turns || session?.conversation?.turns || session?.turns || [];
  const answeredQuestionIds = new Set(
    rawTurns
      .filter((turn) => turn.role === "assistant" && turn.replyToTurnId)
      .map((turn) => turn.replyToTurnId),
  );
  const turns = rawTurns.filter((turn) => !isLegacyContextReceipt(turn));
  const turnsById = new Map(turns.map((turn) => [turn.id, turn]));
  const events = [...(activeThread?.events ?? turns.map((turn) => ({
    type: "message",
    id: `message:${turn.id}`,
    turnId: turn.id,
  })))];
  if (optimisticTurn) {
    turnsById.set(optimisticTurn.id, optimisticTurn);
    events.push({ type: "message", id: `message:${optimisticTurn.id}`, turnId: optimisticTurn.id });
  }

  for (const event of events) {
    if (event.type === "page-context") {
      elements.conversation.append(pageContextEvent(event));
      continue;
    }
    const turn = turnsById.get(event.turnId);
    if (!turn) continue;
    const wrap = document.createElement("article");
    wrap.className = `turn-wrap turn-wrap-${turn.role}`;
    if (turn.id === OPTIMISTIC_TURN_ID) wrap.setAttribute("data-optimistic", "true");
    if (turn.id === focusTurnId) focusedTurn = wrap;
    if (turn.role === "user") {
      const attachment = historicalAttachment(turn);
      if (attachment) wrap.append(attachment);
    }
    const content = turn.message || turn.content || "";
    const message = turn.role === "assistant"
      ? renderAssistantMessage(content)
      : document.createElement("p");
    if (turn.role !== "assistant") {
      message.className = `turn turn-${turn.role}`;
      message.textContent = content;
    }
    wrap.append(message);
    elements.conversation.append(wrap);
    const response = responseState(turn, answeredQuestionIds);
    if (response) elements.conversation.append(response);
  }

  window.requestAnimationFrame(() => {
    if (shouldFollow && focusedTurn) {
      const scrollRect = elements.chatScroll.getBoundingClientRect();
      const turnRect = focusedTurn.getBoundingClientRect();
      elements.chatScroll.scrollTop = Math.max(
        0,
        elements.chatScroll.scrollTop + turnRect.top - scrollRect.top - 18,
      );
      chatPinned = false;
    } else if (shouldFollow) {
      elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight;
    } else {
      elements.chatScroll.scrollTop = previousTop;
    }
  });
}

function renderState({ followConversation = false, focusConversationTurnId = null } = {}) {
  renderPhrases();
  renderSelection();
  renderConversation({
    follow: followConversation,
    focusTurnId: focusConversationTurnId,
  });
  if (atlasMode()) renderAtlasVisualization().catch(() => {});
}

async function selectAtlasTarget(target) {
  if (!atlasMode() || pending) return;
  const isNode = target?.kind === "node";
  const isAggregate = target?.kind === "target";
  const markId = target?.kind === "mark" ? target.markId : (!isNode && !isAggregate && typeof target === "string" ? target : null);
  const targetId = isAggregate ? target.targetId : null;
  if ((isNode && (typeof target.nodeId !== "string" || !target.nodeId)) || (isAggregate && (typeof targetId !== "string" || !targetId)) || (!isNode && !isAggregate && !markId)) return;
  const selected = atlasSelectedMarkIds();
  const selectedTargetId = atlasSelectedTargetId();
  const focus = atlasSelectedFocus();
  const alreadySelected = isNode
    ? focus?.id === target.nodeId
    : isAggregate ? selectedTargetId === targetId : focus === null && selectedTargetId === null && selected.includes(markId);
  if (alreadySelected) {
    // Clicking the selected element again widens the data list back out.
    await clearAtlasSelection();
    return;
  }
  pending = true;
  syncComposer();
  setStatus(isNode ? "Attaching the selected component…" : isAggregate ? "Attaching the selected aggregate…" : "Attaching the selected mark…");
  try {
    const payload = await request("selection", {
      method: "POST",
      // The service re-derives a node's connected marks from the canonical package.
      body: JSON.stringify({
        sessionId: atlasSessionId(),
        revision: sessionRevision(),
        ...(isNode ? { nodeId: target.nodeId } : isAggregate ? { targetId } : { markId }),
      }),
    });
    acceptChatProjection(payload);
    session = unwrapSession(payload);
    pinDraftToCurrentSelection();
    renderState();
    setStatus("");
  } catch (error) {
    if (error.status === 409) await refreshState();
    setStatus(error.message, true);
  } finally {
    pending = false;
    syncComposer();
  }
}

async function selectAtlasMarks(markIds) {
  if (!atlasMode() || pending) return;
  const unique = [...new Set(markIds.map(String))].filter(Boolean);
  if (!unique.length) {
    setStatus("No marks in that area.");
    return;
  }
  const attached = unique.slice(0, MAX_AREA_SELECTION);
  pending = true;
  syncComposer();
  setStatus("Attaching the selected marks…");
  try {
    const payload = await request("selection", {
      method: "POST",
      body: JSON.stringify({
        sessionId: atlasSessionId(),
        revision: sessionRevision(),
        markIds: attached,
      }),
    });
    acceptChatProjection(payload);
    session = unwrapSession(payload);
    pinDraftToCurrentSelection();
    setAreaSelectMode(false);
    renderState();
    elements.input.focus();
    // Leaving the mode clears the status, so the clamp notice has to be written after it.
    setStatus(attached.length < unique.length
      ? `Attached ${attached.length} of ${unique.length} marks (selection limit).`
      : "");
  } catch (error) {
    if (error.status === 409) await refreshState();
    setStatus(error.message, true);
  } finally {
    pending = false;
    syncComposer();
  }
}

async function clearAtlasSelection() {
  if (!atlasMode() || pending) return;
  if (!atlasSelectedMarkIds().length && !atlasSelectedTargetId() && !atlasSelectedFocus()) return;
  pending = true;
  syncComposer();
  setStatus("Clearing the selection…");
  try {
    const payload = await request("selection", {
      method: "POST",
      body: JSON.stringify({
        sessionId: atlasSessionId(),
        revision: sessionRevision(),
        markId: null,
      }),
    });
    acceptChatProjection(payload);
    session = unwrapSession(payload);
    pinDraftToCurrentSelection();
    renderState();
    setStatus("");
  } catch (error) {
    if (error.status === 409) await refreshState();
    setStatus(error.message, true);
  } finally {
    pending = false;
    syncComposer();
  }
}

async function selectRow(rowId) {
  if (pending) return;
  const alreadySelected = session.state.selectedIds?.includes(rowId);
  if (alreadySelected) {
    pinDraftToCurrentSelection();
    syncComposer();
    setStatus("");
    openChat();
    elements.input.focus();
    return;
  }

  pending = true;
  syncComposer();
  setStatus("Attaching the selected phrase…");
  try {
    const payload = await request("selection", {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: session.state.revision,
        selectedIds: [rowId],
      }),
    });
    acceptChatProjection(payload);
    session = unwrapSession(payload);
    pinDraftToCurrentSelection();
    renderState();
    openChat();
    elements.input.focus();
    setStatus("");
  } catch (error) {
    if (error.status === 409) await refreshState();
    setStatus(error.message, true);
  } finally {
    pending = false;
    syncComposer();
  }
}

async function clearSelection() {
  setAreaSelectMode(false);
  if (pending || (atlasMode() ? !atlasSelectedMarkIds().length && !atlasSelectedTargetId() : !session.selection?.selectedMarkIds?.length)) return;
  pending = true;
  syncComposer();
  setStatus(atlasMode() ? "Removing the selected marks…" : "Removing the attached phrase…");
  try {
    const body = atlasMode()
      ? { sessionId: atlasSessionId(), revision: sessionRevision(), markId: null }
      : { expectedRevision: sessionRevision(), selectedIds: [] };
    const payload = await request("selection", {
      method: "POST",
      body: JSON.stringify(body),
    });
    acceptChatProjection(payload);
    session = unwrapSession(payload);
    pinDraftToCurrentSelection();
    renderState();
    elements.input.focus();
    setStatus("");
  } catch (error) {
    if (error.status === 409) await refreshState();
    setStatus(error.message, true);
  } finally {
    pending = false;
    syncComposer();
  }
}

function optimisticSelection() {
  if (atlasMode()) {
    const focus = atlasSelectedFocus();
    if (focus) return { focus };
    const marks = atlasSelectedMarks();
    return marks.length ? { marks } : null;
  }
  const mark = currentMark();
  return mark ? { marks: [mark] } : null;
}

async function sendMessage(message) {
  if (pending || hasActiveResponse()) return;
  if (draftNeedsReview()) {
    setStatus(atlasMode()
      ? "The selected marks changed while you were writing. Select them again before asking."
      : "The attached phrase changed while you were writing. Select a phrase again before asking.", true);
    return;
  }
  pending = true;
  optimisticTurn = {
    id: OPTIMISTIC_TURN_ID,
    role: "user",
    message,
    selection: optimisticSelection(),
    response: { status: "queued", route: activeChatRoute() },
  };
  syncComposer();
  renderConversation({ follow: true });
  setStatus("Sending…");
  try {
    const payload = await request("chat", {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: session.state.revision,
        selectionId: session.selection.id,
        threadId: activeThread.id,
        message,
      }),
    });
    acceptChatProjection(payload);
    acceptThreadProjection(payload);
    session = unwrapSession(payload);
    elements.input.value = "";
    draftSelectionKey = null;
    chatPinned = true;
    renderState({ followConversation: true });
    setStatus("");
  } catch (error) {
    optimisticTurn = null;
    renderConversation();
    if (error.status === 409) {
      await refreshState();
      setStatus(atlasMode()
        ? "The view changed. Review the selected marks, then ask again."
        : "The view changed. Review the attached phrase, then ask again.", true);
    } else {
      setStatus(error.message, true);
    }
  } finally {
    pending = false;
    syncComposer();
  }
}

async function retryQuestion(questionId) {
  if (pending || hasActiveResponse()) return;
  pending = true;
  syncComposer();
  setStatus("Retrying…");
  try {
    const payload = await request("chat/retry", {
      method: "POST",
      body: JSON.stringify({ threadId: activeThread.id, questionId }),
    });
    acceptChatProjection(payload);
    acceptThreadProjection(payload);
    session = unwrapSession(payload);
    chatPinned = true;
    renderState({ followConversation: true });
    setStatus("");
  } catch (error) {
    if (error.status === 409 || error.status === 404) await refreshState();
    setStatus(error.message, true);
  } finally {
    pending = false;
    syncComposer();
  }
}

async function refreshState() {
  const payload = await request(threadStatePath(activeThread.id));
  const chatChanged = acceptChatProjection(payload);
  const next = unwrapSession(payload);
  const conversationChanged = next.conversation?.revision !== activeThread?.revision;
  const explicitStateRevisionIsNewer = Boolean(
    next?.state?.revision !== undefined
      && session?.state?.revision !== undefined
      && next.state.revision > session.state.revision,
  );
  const normalizedRevisionIsNewer = sessionRevision(next) > sessionRevision();
  if (
    !session ||
    explicitStateRevisionIsNewer ||
    normalizedRevisionIsNewer ||
    conversationChanged
  ) {
    const priorAssistantIds = new Set(
      (activeThread?.turns || [])
        .filter((turn) => turn.role === "assistant")
        .map((turn) => turn.id),
    );
    const newAssistant = (next.conversation?.turns || next.turns || [])
      .findLast((turn) => turn.role === "assistant" && !priorAssistantIds.has(turn.id));
    const focusConversationTurnId = chatPinned ? newAssistant?.id ?? null : null;
    session = next;
    acceptThreadProjection(payload);
    renderState({ focusConversationTurnId });
    if (draftNeedsReview()) {
      setStatus(atlasMode()
        ? "The selected marks changed while you were writing. Select them again before asking."
        : "The attached phrase changed while you were writing. Select a phrase again before asking.", true);
    }
  } else if (chatChanged) {
    renderConversation();
  }
}

elements.chatToggle.addEventListener("click", () => {
  if (chatOpen) {
    closeChat();
  } else {
    openChat();
    elements.input.focus();
  }
});

elements.chatClose.addEventListener("click", () => closeChat());

elements.chatHistory.addEventListener("click", async () => {
  if (viewingHistory) {
    setHistoryOpen(false);
    elements.input.focus();
    return;
  }
  try {
    await refreshChatHistory();
    setHistoryOpen(true);
  } catch (error) {
    setStatus(error.message, true);
  }
});

elements.chatNew.addEventListener("click", () => createNewChat());

elements.areaSelect.addEventListener("click", () => setAreaSelectMode(!areaSelectMode));

// renderAtlasPackage replaces the svg on every re-render, so the drag lives on the container.
elements.atlasVisual.addEventListener("pointerdown", (event) => {
  if (!areaSelectMode || !event.isPrimary || event.button !== 0) return;
  const svg = elements.atlasVisual.querySelector("svg");
  if (!svg || !svg.contains(event.target)) return;
  const viewBox = areaSelectViewBox(svg);
  if (!viewBox) return;
  event.preventDefault();
  elements.atlasVisual.setPointerCapture(event.pointerId);
  const marquee = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  marquee.classList.add("area-select-marquee");
  svg.append(marquee);
  areaDrag = {
    pointerId: event.pointerId,
    svg,
    viewBox,
    originX: event.clientX,
    originY: event.clientY,
    marquee,
    dragged: false,
  };
});

elements.atlasVisual.addEventListener("pointermove", (event) => {
  if (!areaDrag || event.pointerId !== areaDrag.pointerId) return;
  if (
    Math.abs(event.clientX - areaDrag.originX) < AREA_DRAG_THRESHOLD &&
    Math.abs(event.clientY - areaDrag.originY) < AREA_DRAG_THRESHOLD
  ) {
    return;
  }
  areaDrag.dragged = true;
  const box = areaDrag.svg.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return;
  const [viewMinX, viewMinY, viewWidth, viewHeight] = areaDrag.viewBox;
  const originX = viewMinX + ((areaDrag.originX - box.left) / box.width) * viewWidth;
  const currentX = viewMinX + ((event.clientX - box.left) / box.width) * viewWidth;
  const originY = viewMinY + ((areaDrag.originY - box.top) / box.height) * viewHeight;
  const currentY = viewMinY + ((event.clientY - box.top) / box.height) * viewHeight;
  areaDrag.marquee.setAttribute("x", String(Math.min(originX, currentX)));
  areaDrag.marquee.setAttribute("y", String(Math.min(originY, currentY)));
  areaDrag.marquee.setAttribute("width", String(Math.abs(currentX - originX)));
  areaDrag.marquee.setAttribute("height", String(Math.abs(currentY - originY)));
});

elements.atlasVisual.addEventListener("pointerup", (event) => {
  if (!areaDrag || event.pointerId !== areaDrag.pointerId) return;
  const dragged = areaDrag.dragged;
  const bounds = {
    minX: Math.min(areaDrag.originX, event.clientX),
    maxX: Math.max(areaDrag.originX, event.clientX),
    minY: Math.min(areaDrag.originY, event.clientY),
    maxY: Math.max(areaDrag.originY, event.clientY),
  };
  endAreaDrag();
  if (dragged) selectAtlasMarks(marksWithinClientRect(bounds));
});

elements.atlasVisual.addEventListener("pointercancel", () => endAreaDrag());

elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = elements.input.value.trim();
  if (message) sendMessage(message);
});

elements.input.addEventListener("input", () => {
  const wasRetargeted = draftNeedsReview();
  if (!elements.input.value) {
    draftSelectionKey = null;
    if (wasRetargeted) setStatus("");
  } else if (draftSelectionKey === null) {
    pinDraftToCurrentSelection();
  }
  syncComposer();
});

elements.input.addEventListener("keydown", (event) => {
  const suggestedQuestion = currentSuggestedQuestion();
  if (
    event.key === "Tab" &&
    !event.isComposing &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !elements.input.value &&
    suggestedQuestion
  ) {
    event.preventDefault();
    elements.input.value = suggestedQuestion;
    pinDraftToCurrentSelection();
    syncComposer();
    return;
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.form.requestSubmit();
  }
});

elements.chatScroll.addEventListener("scroll", () => {
  const remaining =
    elements.chatScroll.scrollHeight - elements.chatScroll.scrollTop - elements.chatScroll.clientHeight;
  chatPinned = remaining < 28;
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    if (chatOpen) {
      closeChat();
    } else {
      openChat();
      elements.input.focus();
    }
    return;
  }
  if (event.key === "Escape" && areaSelectMode) {
    event.preventDefault();
    setAreaSelectMode(false);
    return;
  }
  if (event.key === "Escape" && chatOpen) {
    event.preventDefault();
    if (viewingHistory) {
      setHistoryOpen(false);
      elements.input.focus();
    } else {
      closeChat();
    }
  }
});

const QUESTION_EVENT_HANDLERS = {
  status: () => {},
  delta: (event) => {
    questionPreview.text += typeof event.text === "string" ? event.text : "";
    if (!paintQuestionPreview()) renderConversation();
  },
  answer: () => {
    questionPreview = null;
    refreshState().catch(() => {});
  },
  failed: () => {
    questionPreview = null;
    refreshState().catch(() => {});
  },
};

function handleQuestionEvent(event) {
  if (typeof event?.questionId !== "string") return;
  const handler = QUESTION_EVENT_HANDLERS[event.type];
  if (!handler) return;
  if (questionPreview?.questionId !== event.questionId) {
    questionPreview = { questionId: event.questionId, text: "" };
  }
  handler(event);
}

function scheduleStateRefresh() {
  if (stateRefreshTimer !== null) return;
  stateRefreshTimer = window.setTimeout(() => {
    stateRefreshTimer = null;
    if (!pending) refreshState().catch(() => {});
  }, STATE_REFRESH_DEBOUNCE_MS);
}

function openEventStream() {
  const source = new EventSource(apiUrl("events"));
  source.addEventListener("open", () => {
    eventStreamHealthy = true;
    // The relay replays a live question's buffered events to every new
    // subscriber, so a reconnect has to rebuild the preview from scratch.
    if (!questionPreview) return;
    questionPreview = null;
    renderConversation();
  });
  source.addEventListener("error", () => {
    eventStreamHealthy = false;
  });
  source.addEventListener("state", scheduleStateRefresh);
  source.addEventListener("question", (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    handleQuestionEvent(payload);
  });
}

async function boot() {
  setChatOpen(false);
  try {
    const [dataPayload, historyPayload] = await Promise.all([
      request("data"),
      request("chat/threads"),
    ]);
    dataPackage = unwrapArtifact(dataPayload);
    chatThreads = Array.isArray(historyPayload.threads) ? historyPayload.threads : [];
    const savedThreadId = storedThreadId();
    let threadId = chatThreads.some((thread) => thread.id === savedThreadId)
      ? savedThreadId
      : chatThreads[0]?.id;
    if (!threadId) {
      const created = await request("chat/threads", {
        method: "POST",
        body: JSON.stringify({}),
      });
      threadId = created.thread.id;
    }
    const statePayload = await request(threadStatePath(threadId));
    acceptChatProjection(statePayload);
    acceptThreadProjection(statePayload);
    session = unwrapSession(statePayload);
    renderHeader();
    renderState({ followConversation: true });
    setStatus("");
    openEventStream();
    let pollBeat = 0;
    window.setInterval(() => {
      pollBeat += 1;
      if (pending || document.visibilityState !== "visible") return;
      // A healthy stream already pushes every change; this is only a safety net.
      if (eventStreamHealthy && pollBeat % STREAMED_POLL_BEATS !== 0) return;
      refreshState().catch(() => {});
    }, POLL_INTERVAL_MS);
  } catch (error) {
    setStatus(error.message, true);
    elements.question.textContent = "This local view could not be opened.";
  }
}

boot();
