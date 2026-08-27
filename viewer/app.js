import { atlasPackageToRenderModel, isAtlasPackage } from "./package-model.js";
import { atlasSelectionSummary, renderAtlasPackage } from "./package-renderer.js";

const basePath = `${window.location.pathname.replace(/[^/]*$/, "").replace(/\/+$/, "")}/`;
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

const libraryReturn = document.querySelector(".library-return");
if (libraryReturn) libraryReturn.href = hostBoundHref(libraryReturn.href);

const elements = {
  workspace: document.getElementById("workspace"),
  map: document.getElementById("map-pane"),
  chat: document.getElementById("chat-pane"),
  chatToggle: document.getElementById("chat-toggle"),
  chatClose: document.getElementById("chat-close"),
  chatScroll: document.getElementById("chat-scroll"),
  chatRoute: document.getElementById("chat-route"),
  chatRouteLabel: document.getElementById("chat-route-label"),
  chatRouteState: document.getElementById("chat-route-state"),
  chatRouteDisclosure: document.getElementById("chat-route-disclosure"),
  corpusMeta: document.getElementById("corpus-meta"),
  question: document.getElementById("question-heading"),
  target: document.getElementById("question-target"),
  phraseList: document.getElementById("phrase-list"),
  empty: document.getElementById("empty-state"),
  eyebrow: document.getElementById("visualization-kind"),
  atlasView: document.getElementById("atlas-view"),
  atlasVisual: document.getElementById("atlas-visual"),
  atlasAbstention: document.getElementById("atlas-abstention"),
  revision: document.getElementById("state-revision"),
  selection: document.getElementById("selection-panel"),
  conversation: document.getElementById("conversation"),
  form: document.getElementById("chat-form"),
  input: document.getElementById("chat-input"),
  submit: document.getElementById("chat-submit"),
  suggestion: document.getElementById("suggested-question"),
  suggestionText: document.getElementById("suggested-question-text"),
  status: document.getElementById("status"),
};

let dataPackage;
let session;
let chat;
let pending = false;
let chatOpen = false;
let chatPinned = true;
let draftSelectionKey = null;
let atlasRenderRevision = 0;

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

function renderChatRoute() {
  const route = activeChatRoute();
  elements.chatRoute.dataset.routeKind = route.kind;
  if (route.kind === "local") {
    elements.chatRoute.dataset.capability = route.available === false ? "restarting" : "ready";
    elements.chatRouteLabel.textContent = "Private AI · gpt-oss-20b";
    elements.chatRouteState.textContent = route.available === false ? "Restarting" : "On this Mac";
    elements.chatRouteDisclosure.textContent = route.disclosure
      || "Questions and selected evidence stay on this Mac.";
    return;
  }
  if (route.kind === "detached") {
    const provider = detachedProviderLabel(route.adapter);
    elements.chatRouteLabel.textContent = `Detached fallback: ${provider}`;
    if (route.available === false) {
      elements.chatRoute.dataset.capability = "unavailable";
      elements.chatRouteState.textContent = "Unavailable";
    } else if (route.authenticated === false) {
      elements.chatRoute.dataset.capability = "sign-in-required";
      elements.chatRouteState.textContent = "Sign-in required";
    } else {
      elements.chatRoute.dataset.capability = "ready";
      elements.chatRouteState.textContent = "Ready";
    }
    elements.chatRouteDisclosure.textContent = route.disclosure
      || `Selected evidence is sent to the explicitly selected ${provider} fallback.`;
    return;
  }

  if (route.ownership === "unattached" || route.registered === false) {
    elements.chatRoute.dataset.capability = "unattached";
    elements.chatRouteLabel.textContent = "Host not attached";
    elements.chatRouteState.textContent = "Open from Attend";
    elements.chatRouteDisclosure.textContent = route.disclosure
      || "Sidebar chat is unavailable from this unbound library link.";
    return;
  }
  elements.chatRoute.dataset.capability = route.listener || "not-listening";
  elements.chatRouteLabel.textContent = `Host attached · ${route.label || "Opening coding agent"}`;
  elements.chatRouteState.textContent = route.listener === "delivered"
    ? "Delivered"
    : route.listener === "listening"
      ? "Listening"
      : "No active listener";
  elements.chatRouteDisclosure.textContent = route.disclosure
    || "Questions and selected evidence return to the coding agent that opened this view through that agent's configured provider route.";
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

function atlasSelectedFocus(value = session) {
  const focus = value?.selection?.focus ?? value?.state?.focus ?? null;
  if (focus?.kind !== "node" || typeof focus.id !== "string" || !focus.id) return null;
  return { kind: "node", id: focus.id, label: focus.label ?? focus.id };
}

function markContextSummary(mark) {
  return `${mark.occurrenceCount} ${countLabel(mark.occurrenceCount)} across ${mark.distinctSourceCount} ${sourceLabel(mark.distinctSourceCount)}`;
}

function currentMark() {
  return session?.selection?.marks?.length === 1 ? session.selection.marks[0] : null;
}

function currentSuggestedQuestion() {
  if (atlasMode()) {
    const marks = atlasSelectedMarks();
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
  if (!selection?.selectedMarkIds?.length) return null;
  return JSON.stringify({
    dataPackageId: selection.dataPackageId,
    dataHash: selection.dataHash,
    map: selection.map,
    selectedMarkIds: selection.selectedMarkIds,
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

function hasActiveResponse(value = session) {
  const turns = value?.conversation?.turns || value?.turns || [];
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
  setChatOpen(false);
  if (restoreFocus) elements.chatToggle.focus();
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
      onSelect: (target) => selectAtlasTarget(target),
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

async function copyAtlasSelection(marks, focus = null) {
  const lines = marks.map((mark) => `${mark.id}: ${mark.label}`);
  if (focus) lines.unshift(`component: ${focus.label}`);
  const text = lines.join("\n");
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable");
    await navigator.clipboard.writeText(text);
    setStatus("Selection copied.");
  } catch {
    setStatus("The selection could not be copied.", true);
  }
}

function renderSelection() {
  elements.selection.replaceChildren();
  if (atlasMode()) {
    const marks = atlasSelectedMarks();
    const focus = atlasSelectedFocus();
    elements.selection.hidden = marks.length === 0;
    if (!marks.length) {
      syncComposer();
      return;
    }
    const attachment = document.createElement("div");
    attachment.className = "selection-attachment atlas-selection-attachment";
    const copy = document.createElement("div");
    copy.className = "attachment-copy";
    const label = document.createElement("span");
    label.className = "attachment-label";
    label.textContent = focus
      ? "Attach selected component to next message"
      : "Attach selected marks to next message";
    const names = document.createElement("strong");
    names.className = "attachment-phrase";
    names.textContent = focus?.label ?? marks.map((mark) => mark.label).join(" · ");
    const meta = document.createElement("span");
    meta.className = "attachment-meta";
    meta.textContent = focus
      ? `${marks.length} connected relationship${marks.length === 1 ? "" : "s"} · ${marks.reduce((count, mark) => count + mark.evidenceRefs.length, 0)} evidence references`
      : `${marks.length} selected mark${marks.length === 1 ? "" : "s"} · ${marks.reduce((count, mark) => count + mark.evidenceRefs.length, 0)} evidence references`;
    copy.append(label, names, meta);

    const actions = document.createElement("div");
    actions.className = "selection-actions";
    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "selection-copy";
    copyButton.textContent = "Copy selection";
    copyButton.addEventListener("click", () => copyAtlasSelection(marks, focus));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "selection-remove attachment-remove";
    remove.setAttribute("aria-label", focus ? `Remove attached component ${focus.label}` : "Remove selected marks");
    remove.textContent = "×";
    remove.addEventListener("click", clearSelection);
    actions.append(copyButton, remove);
    attachment.append(copy, actions);
    elements.selection.append(attachment);
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
  const copy = document.createElement("div");
  copy.className = "attachment-copy";
  const label = document.createElement("span");
  label.className = "attachment-label";
  label.textContent = "Attach to next message";
  const phrase = document.createElement("strong");
  phrase.className = "attachment-phrase";
  phrase.textContent = `“${mark.phrase}”`;
  const meta = document.createElement("span");
  meta.className = "attachment-meta";
  meta.textContent = markContextSummary(mark);
  copy.append(label, phrase, meta);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "selection-remove attachment-remove";
  remove.setAttribute("aria-label", `Remove attached phrase “${mark.phrase}”`);
  remove.textContent = "×";
  remove.addEventListener("click", clearSelection);

  attachment.append(copy, remove);
  elements.selection.append(attachment);
  syncComposer();
}

function isLegacyContextReceipt(turn) {
  const text = turn.message || turn.content || "";
  return turn.role === "assistant" && /^Context saved (?:from|with)/u.test(text);
}

function historicalAttachment(turn) {
  if (atlasMode()) {
    const turnMarks = Array.isArray(turn.selection?.marks) ? turn.selection.marks : [];
    const focus = turn.selection?.focus?.kind === "node" ? turn.selection.focus : null;
    const labels = turnMarks.map((mark) => mark.label ?? mark.id ?? mark.markId).filter(Boolean);
    const selectedIds = turn.selection?.selectedMarkIds ?? turn.selection?.markIds ?? [];
    const names = focus
      ? [focus.label ?? focus.id]
      : labels.length ? labels : (Array.isArray(selectedIds) ? selectedIds : []);
    if (!names.length) return null;
    const attachment = document.createElement("div");
    attachment.className = "turn-attachment";
    attachment.setAttribute("aria-label", focus
      ? `Attached visual context for component ${names[0]}`
      : "Attached visual context for selected marks");
    const label = document.createElement("span");
    label.className = "turn-attachment-label";
    label.textContent = "From visualization";
    const selected = document.createElement("strong");
    selected.className = "turn-attachment-phrase";
    selected.textContent = names.join(" · ");
    const meta = document.createElement("span");
    meta.className = "turn-attachment-meta";
    meta.textContent = focus
      ? `${turnMarks.length} connected relationship${turnMarks.length === 1 ? "" : "s"}`
      : `${names.length} selected mark${names.length === 1 ? "" : "s"}`;
    attachment.append(label, selected, meta);
    return attachment;
  }
  const mark = turn.selection?.marks?.[0];
  if (!mark) return null;
  const attachment = document.createElement("div");
  attachment.className = "turn-attachment";
  attachment.setAttribute(
    "aria-label",
    `Attached visual context for phrase “${mark.phrase}”`,
  );
  const label = document.createElement("span");
  label.className = "turn-attachment-label";
  label.textContent = "From visualization";
  const phrase = document.createElement("strong");
  phrase.className = "turn-attachment-phrase";
  phrase.textContent = `“${mark.phrase}”`;
  const meta = document.createElement("span");
  meta.className = "turn-attachment-meta";
  meta.textContent = markContextSummary(mark);
  attachment.append(label, phrase, meta);
  return attachment;
}

function linkedQuestionReference(turn) {
  if (atlasMode()) {
    const marks = Array.isArray(turn.selection?.marks) ? turn.selection.marks : [];
    const focus = turn.selection?.focus?.kind === "node" ? turn.selection.focus : null;
    const ids = turn.selection?.selectedMarkIds ?? turn.selection?.markIds ?? [];
    const names = marks.map((mark) => mark.label ?? mark.id ?? mark.markId).filter(Boolean);
    const selected = focus
      ? [focus.label ?? focus.id]
      : names.length ? names : (Array.isArray(ids) ? ids : []);
    if (!selected.length) return null;
    const reference = document.createElement("div");
    reference.className = "turn-reply-reference";
    const text = document.createElement("span");
    text.textContent = focus
      ? `Using the ${selected[0]} component and ${marks.length} connected relationship${marks.length === 1 ? "" : "s"} as context`
      : `Using ${selected.length} selected mark${selected.length === 1 ? "" : "s"} as context · ${selected.join(" · ")}`;
    reference.append(text);
    return reference;
  }
  const mark = turn.selection?.marks?.[0];
  if (!mark) return null;
  const reference = document.createElement("div");
  reference.className = "turn-reply-reference";
  const phrase = document.createElement("span");
  phrase.textContent = `Using “${mark.phrase}” context · ${mark.distinctSourceCount} ${sourceLabel(mark.distinctSourceCount)}`;
  reference.append(phrase);
  return reference;
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

function responseState(turn, answeredQuestionIds) {
  if (turn.role !== "user" || answeredQuestionIds.has(turn.id)) return null;
  const status = turn.response?.status;
  let response;
  if (status === "queued" || status === "running") {
    const active = document.createElement("span");
    active.className = "turn-response turn-response-active";
    active.setAttribute("role", "status");
    active.textContent = activeResponseMessage(turn);
    response = active;
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
  wrap.append(response);
  return wrap;
}

function renderConversation({ follow = false, focusTurnId = null } = {}) {
  const previousTop = elements.chatScroll.scrollTop;
  const shouldFollow = follow || chatPinned;
  let focusedTurn = null;
  elements.conversation.replaceChildren();
  const rawTurns = session.conversation?.turns || session.turns || [];
  const answeredQuestionIds = new Set(
    rawTurns
      .filter((turn) => turn.role === "assistant" && turn.replyToTurnId)
      .map((turn) => turn.replyToTurnId),
  );
  const turns = rawTurns.filter(
    (turn) => !isLegacyContextReceipt(turn),
  );

  if (turns.length === 0) {
    const empty = document.createElement("p");
    empty.className = "conversation-empty";
    empty.textContent = atlasMode()
      ? "Select a mark, then ask about it. Your question will keep the exact visual state attached."
      : "Select a phrase, then ask about it. Your question will keep the exact visual state attached.";
    elements.conversation.append(empty);
  } else {
    for (const turn of turns) {
      const wrap = document.createElement("article");
      wrap.className = `turn-wrap turn-wrap-${turn.role}`;
      if (turn.id === focusTurnId) focusedTurn = wrap;
      if (turn.role === "user") {
        const attachment = historicalAttachment(turn);
        if (attachment) wrap.append(attachment);
      } else if (turn.replyToTurnId) {
        const reference = linkedQuestionReference(turn);
        if (reference) wrap.append(reference);
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
  elements.revision.textContent = `v${sessionRevision()}`;
  renderChatRoute();
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
  const markId = isNode || typeof target !== "string" ? null : target;
  if ((isNode && (typeof target.nodeId !== "string" || !target.nodeId)) || (!isNode && !markId)) return;
  const selected = atlasSelectedMarkIds();
  const focus = atlasSelectedFocus();
  const alreadySelected = isNode
    ? focus?.id === target.nodeId
    : focus === null && selected.includes(markId);
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
  setStatus(isNode ? "Attaching the selected component…" : "Attaching the selected mark…");
  try {
    const payload = await request("selection", {
      method: "POST",
      // The service re-derives a node's connected marks from the canonical package.
      body: JSON.stringify({
        sessionId: atlasSessionId(),
        revision: sessionRevision(),
        ...(target.kind === "node"
          ? { nodeId: target.nodeId }
          : { markId }),
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
  if (pending || (atlasMode() ? !atlasSelectedMarkIds().length : !session.selection?.selectedMarkIds?.length)) return;
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

async function sendMessage(message) {
  if (pending || hasActiveResponse()) return;
  if (draftNeedsReview()) {
    setStatus(atlasMode()
      ? "The selected marks changed while you were writing. Select them again before asking."
      : "The attached phrase changed while you were writing. Select a phrase again before asking.", true);
    return;
  }
  pending = true;
  syncComposer();
  setStatus("Sending…");
  try {
    const payload = await request("chat", {
      method: "POST",
      body: JSON.stringify({
        expectedRevision: session.state.revision,
        selectionId: session.selection.id,
        message,
      }),
    });
    acceptChatProjection(payload);
    session = unwrapSession(payload);
    elements.input.value = "";
    draftSelectionKey = null;
    chatPinned = true;
    renderState({ followConversation: true });
    setStatus("");
  } catch (error) {
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
      body: JSON.stringify({ questionId }),
    });
    acceptChatProjection(payload);
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
  const payload = await request("state");
  const chatChanged = acceptChatProjection(payload);
  const next = unwrapSession(payload);
  const explicitStateRevisionIsNewer = Boolean(
    next?.state?.revision !== undefined
      && session?.state?.revision !== undefined
      && next.state.revision > session.state.revision,
  );
  const normalizedRevisionIsNewer = sessionRevision(next) > sessionRevision();
  if (!session || explicitStateRevisionIsNewer || normalizedRevisionIsNewer) {
    const priorAssistantIds = new Set(
      (session?.conversation?.turns || session?.turns || [])
        .filter((turn) => turn.role === "assistant")
        .map((turn) => turn.id),
    );
    const newAssistant = (next.conversation?.turns || next.turns || [])
      .findLast((turn) => turn.role === "assistant" && !priorAssistantIds.has(turn.id));
    const focusConversationTurnId = chatPinned ? newAssistant?.id ?? null : null;
    session = next;
    renderState({ focusConversationTurnId });
    if (draftNeedsReview()) {
      setStatus(atlasMode()
        ? "The selected marks changed while you were writing. Select them again before asking."
        : "The attached phrase changed while you were writing. Select a phrase again before asking.", true);
    }
  } else if (chatChanged) {
    renderChatRoute();
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
  if (event.key === "Escape" && chatOpen) {
    event.preventDefault();
    closeChat();
  }
});

async function boot() {
  setChatOpen(false);
  try {
    const [dataPayload, statePayload] = await Promise.all([
      request("data"),
      request("state"),
    ]);
    dataPackage = unwrapArtifact(dataPayload);
    acceptChatProjection(statePayload);
    session = unwrapSession(statePayload);
    renderHeader();
    renderState({ followConversation: true });
    setStatus("");
    window.setInterval(() => {
      if (!pending && document.visibilityState === "visible") {
        refreshState().catch(() => {});
      }
    }, 1500);
  } catch (error) {
    setStatus(error.message, true);
    elements.question.textContent = "This local view could not be opened.";
  }
}

boot();
