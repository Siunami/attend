import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const VIEWER = fileURLToPath(new URL("../viewer/", import.meta.url));

async function readViewerAssets() {
  const [html, app, css] = await Promise.all([
    readFile(`${VIEWER}/index.html`, "utf8"),
    readFile(`${VIEWER}/app.js`, "utf8"),
    readFile(`${VIEWER}/styles.css`, "utf8"),
  ]);
  return { html, app, css };
}

async function readLibraryAssets() {
  const [html, app, css] = await Promise.all([
    readFile(`${VIEWER}/library.html`, "utf8"),
    readFile(`${VIEWER}/library.js`, "utf8"),
    readFile(`${VIEWER}/library.css`, "utf8"),
  ]);
  return { html, app, css };
}

async function readWorkspaceAssets() {
  const [html, app, css] = await Promise.all([
    readFile(`${VIEWER}/workspace.html`, "utf8"),
    readFile(`${VIEWER}/workspace.js`, "utf8"),
    readFile(`${VIEWER}/workspace.css`, "utf8"),
  ]);
  return { html, app, css };
}

function declarationsFor(css, selector) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter(([, selectors]) =>
      selectors
        .split(",")
        .map((candidate) => candidate.trim())
        .includes(selector),
    )
    .map(([, , declarations]) => declarations)
    .join("\n");
}

test("viewer assets match the strict self-only CSP and accessible control contract", async () => {
  const { html, app, css } = await readViewerAssets();

  assert.doesNotMatch(html, /\sstyle=/u);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/u);
  assert.doesNotMatch(app, /\.style\b/u);
  assert.match(css, /\.phrase-button\[data-bar="100"\]::before/u);
  assert.match(html, /<ol id="phrase-list"[^>]*aria-label=/u);
  assert.match(html, /<a class="library-return" href="\.\.\/\.\.\/">All views<\/a>/u);
  assert.match(html, /<textarea\b[^>]*\bid="chat-input"/u);
  assert.match(html, /<button\b[^>]*\btype="submit"[^>]*>\s*Ask\s*<\/button>/u);
  assert.match(html, /id="chat-pane"[^>]*aria-label="Chat"/u);
  assert.match(html, /id="chat-close"[^>]*aria-label="Close chat"[^>]*>×<\/button>/u);
  assert.doesNotMatch(html, /OpenAI|Codex runner|existing Codex sign-in/u);
  assert.doesNotMatch(app, /Answered deterministically/u);
  assert.match(
    app,
    /payload\.error\?\.message \|\| payload\.error \|\|/u,
    "structured server errors must surface their human-readable message",
  );

  const queriedIds = [...app.matchAll(/getElementById\("([^"]+)"\)/gu)].map(
    (match) => match[1],
  );
  for (const id of queriedIds) {
    assert.match(html, new RegExp(`\\bid="${id}"`), `missing #${id}`);
  }
});

test("Atlas component clicks attach node focus and keep one vertical scroll owner", async () => {
  const { app, css } = await readViewerAssets();

  assert.match(app, /target\.kind === "node"/u);
  assert.match(app, /nodeId:\s*target\.nodeId/u);
  assert.match(app, /selectedNodeId:\s*atlasSelectedFocus\(\)\?\.id/u);
  assert.doesNotMatch(app, /Replying to/u);
  assert.match(declarationsFor(css, ".atlas-visual"), /overflow:\s*clip/u);
  assert.match(css, /\.atlas-visual \.mechanism-node:hover \.mechanism-node-card/u);
  assert.match(css, /\.atlas-visual \[data-node-id\]:focus-visible/u);
});

test("selected context copies the minimal OpenAI reply strip inside the composer", async () => {
  const { html, app, css } = await readViewerAssets();

  const fieldStart = html.indexOf('class="composer-field"');
  const selectionStart = html.indexOf('id="selection-panel"');
  const inputStart = html.indexOf('class="composer-input"');
  assert.ok(
    fieldStart >= 0 && selectionStart > fieldStart && inputStart > selectionStart,
    "the reply context must share the input container",
  );

  const renderStart = app.indexOf("function renderSelection");
  const renderEnd = app.indexOf("function isLegacyContextReceipt", renderStart);
  const renderSource = app.slice(renderStart, renderEnd);
  assert.match(renderSource, /appendReplyAttachment\(attachment,/u);
  assert.match(app, /function createReplyArrow\(\)/u);
  assert.match(app, /phrase\.textContent = `“\$\{label\}”`/u);
  assert.doesNotMatch(renderSource, /Replying to/u);
  assert.doesNotMatch(renderSource, /Copy selection|Attach [^"\n]*next message/u);
  assert.doesNotMatch(renderSource, /attachment-meta/u);

  assert.match(declarationsFor(css, ".selection-panel"), /grid-column:\s*1\s*\/\s*-1/u);
  const attachment = declarationsFor(css, ".selection-attachment");
  assert.match(attachment, /display:\s*flex/u);
  assert.doesNotMatch(attachment, /\bborder\s*:/u);
  assert.match(declarationsFor(css, ".attachment-copy"), /flex:\s*1\s+1\s+auto/u);
  assert.match(declarationsFor(css, ".reply-arrow"), /stroke:\s*currentColor/u);
});

test("chat chrome is only history, new chat, and a small close control", async () => {
  const { html, app, css } = await readViewerAssets();

  assert.match(html, /<aside[^>]*id="chat-pane"[^>]*aria-label="Chat"/u);
  assert.match(
    html,
    /<header class="chat-header">[\s\S]*id="chat-history"[\s\S]*aria-label="Chat history"[\s\S]*id="chat-new"[\s\S]*aria-label="New chat"[\s\S]*id="chat-close"[^>]*aria-label="Close chat"[^>]*>×<\/button>[\s\S]*<\/header>/u,
  );
  assert.doesNotMatch(html, /chat-heading|chat-route|state-revision/u);
  assert.doesNotMatch(app, /renderChatRoute|chatRouteDisclosure|elements\.revision/u);

  const header = declarationsFor(css, ".chat-header");
  assert.match(header, /justify-content:\s*space-between/u);
  assert.doesNotMatch(header, /border-bottom/u);
  const headerHeight = Number(header.match(/min-height:\s*([\d.]+)px/u)?.[1]);
  assert.ok(headerHeight > 0 && headerHeight <= 44, "the close row must stay compact");

  const close = declarationsFor(css, ".chat-close");
  assert.match(close, /width:\s*32px/u);
  assert.match(close, /height:\s*32px/u);
  assert.match(close, /border:\s*0/u);
  assert.match(close, /background:\s*transparent/u);
});

test("new chat and history keep one active project thread across page navigation", async () => {
  const { html, app } = await readViewerAssets();

  assert.match(html, /id="chat-history-panel"[^>]*hidden/u);
  assert.match(html, /id="chat-thread-list"[^>]*aria-label="Chat history"/u);
  assert.match(app, /const chatStorageKey = `attend:active-chat-thread:\$\{libraryBasePath\}`/u);
  assert.match(app, /localStorage\.getItem\(chatStorageKey\)/u);
  assert.match(app, /localStorage\.setItem\(chatStorageKey, activeThread\.id\)/u);
  assert.match(app, /await request\("chat\/threads"/u);
  assert.match(app, /method:\s*"POST"[\s\S]*body:\s*JSON\.stringify\(\{\}\)/u);
  assert.match(app, /state\?threadId=\$\{encodeURIComponent\(threadId\)\}/u);
  assert.match(app, /function renderChatHistory/u);
  assert.match(app, /elements\.chatHistory\.addEventListener/u);
  assert.match(app, /elements\.chatNew\.addEventListener/u);
});

test("chat has no explanatory empty state and the composer uses one quiet focus treatment", async () => {
  const { app, css } = await readViewerAssets();

  const conversationStart = app.indexOf("function renderConversation");
  const conversationEnd = app.indexOf("function renderState", conversationStart);
  const conversationSource = app.slice(conversationStart, conversationEnd);
  assert.doesNotMatch(conversationSource, /conversation-empty|Select a (?:mark|phrase), then ask/u);
  assert.match(conversationSource, /event\.type === "page-context"/u);

  assert.match(declarationsFor(css, ".composer textarea"), /outline:\s*none/u);
  const focusedComposer = declarationsFor(css, ".composer-field:focus-within");
  assert.match(focusedComposer, /border-color:\s*var\(--accent\)/u);
  assert.doesNotMatch(focusedComposer, /\boutline\s*:/u);
});

test("library assets render only API metadata with safe accessible links", async () => {
  const { html, app, css } = await readLibraryAssets();

  assert.doesNotMatch(html, /\sstyle=/u);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/u);
  assert.doesNotMatch(app, /\.style\b|\.innerHTML\b|insertAdjacentHTML/u);
  assert.match(html, /<main class="library-shell">/u);
  assert.match(html, /<ol id="session-list"[^>]*aria-label=/u);
  assert.match(html, /id="status"[^>]*role="status"/u);
  assert.match(app, /fetch\("\.\/api\/library"/u);
  assert.match(app, /link\.href\s*=\s*hostBoundHref\(entry\.href\)/u);
  assert.match(app, /question\.textContent\s*=/u);
  assert.match(app, /target\.textContent\s*=/u);
  assert.match(app, /entry\.view\?\.id/u);
  assert.match(app, /entry\.counts\?\.phrases/u);
  assert.match(app, /entry\.counts\?\.sources/u);
  assert.doesNotMatch(app, /excerpt|sourceRefs|displayPath/u);
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/u);
  assert.match(css, /:focus-visible/u);
  assert.match(css, /@media\s*\(max-width:\s*680px\)/u);

  const queriedIds = [...app.matchAll(/getElementById\("([^"]+)"\)/gu)].map(
    (match) => match[1],
  );
  for (const id of queriedIds) {
    assert.match(html, new RegExp(`\\bid="${id}"`), `missing #${id}`);
  }
});

test("host binding survives navigation through the visualization library", async () => {
  const viewer = await readViewerAssets();
  const library = await readLibraryAssets();

  assert.match(
    viewer.app,
    /libraryReturn\.href = hostBoundHref\(libraryReturn\.href\)/u,
    "the All views link must retain the current host attachment",
  );
  assert.match(
    library.app,
    /link\.href = hostBoundHref\(entry\.href\)/u,
    "saved-view links must retain the host attachment inherited by the library",
  );
  assert.match(viewer.app, /params\.get\("attend-host"\)/u);
  assert.match(library.app, /params\.get\("attend-host"\)/u);
});

test("experiment workspace renders one canonical, filterable exploration trail", async () => {
  const { html, app, css } = await readWorkspaceAssets();

  assert.doesNotMatch(html, /\sstyle=/u);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/u);
  assert.doesNotMatch(app, /\.style\b|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|DOMParser/u);
  assert.match(html, /<main class="workspace-shell">/u);
  assert.match(html, /<ol id="experiment-list"[^>]*aria-label=/u);
  assert.equal((html.match(/<ol\b/gu) ?? []).length, 1, "one list must own every experiment");
  assert.match(html, /id="status"[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.match(html, /name="experiment-filter" value="all" checked/u);
  assert.match(html, /name="experiment-filter" value="promoted"/u);
  assert.match(html, /name="experiment-filter" value="starred"/u);
  assert.match(html, /<input id="strict-chronology" type="checkbox">/u);

  assert.match(app, /fetch\("\.\/api\/exploration"/u);
  assert.match(app, /payload\.schemaVersion !== 1/u);
  assert.match(app, /function canonicalExperiments\(values\)[\s\S]*const byId = new Map\(\)/u);
  assert.match(app, /elements\.list\.replaceChildren\(\.\.\.visible\.map\(renderExperiment\)\)/u);
  assert.doesNotMatch(app, /promotionQuota|MAX_PROMOT|promotedList|starredList/iu);

  const orderStart = app.indexOf("function defaultOrder");
  const orderEnd = app.indexOf("function chronologicalOrder", orderStart);
  const orderSource = app.slice(orderStart, orderEnd);
  assert.ok(orderStart >= 0 && orderEnd > orderStart, "default ordering must remain inspectable");
  assert.match(orderSource, /starredAt\(left\) \? 0 : promotedAt\(left\) \? 1 : 2/u);
  assert.match(orderSource, /timestamp\(starredAt\(left\)\)/u);
  assert.match(orderSource, /timestamp\(promotedAt\(left\)\)/u);
  assert.match(orderSource, /executionTimestamp\(left\)/u);
  assert.match(app, /sort\(strictChronology \? chronologicalOrder : defaultOrder\)/u);

  const renderStart = app.indexOf("function renderExperiment");
  const renderEnd = app.indexOf("function renderHeader", renderStart);
  const renderSource = app.slice(renderStart, renderEnd);
  assert.ok(renderStart >= 0 && renderEnd > renderStart, "experiment rendering must remain inspectable");
  assert.ok(
    renderSource.indexOf("hypothesisPanel(experiment, position)") <
      renderSource.indexOf("resultPanel(experiment)"),
    "the hypothesis and its reason must precede the result",
  );
  for (const copy of [
    "Why test this",
    "Branch of ",
    "attempt",
    "What failed",
    "What surfaced",
    "Outcome",
    "Why promoted",
    "Limitations",
    "Factors",
  ]) {
    assert.match(app, new RegExp(copy), `workspace must render ${copy.trim()}`);
  }

  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/u);
  assert.match(css, /:focus-visible/u);
  assert.match(css, /@media\s*\(max-width:\s*620px\)/u);

  const queriedIds = [...app.matchAll(/getElementById\("([^"]+)"\)/gu)].map(
    (match) => match[1],
  );
  for (const id of queriedIds) {
    assert.match(html, new RegExp(`\\bid="${id}"`), `missing #${id}`);
  }
});

test("experiment workspace keeps stars, feedback, branches, and artifact links safe", async () => {
  const { html, app, css } = await readWorkspaceAssets();

  assert.match(app, /star\.setAttribute\("aria-pressed", String\(experiment\.human\?\.starred === true\)\)/u);
  assert.match(app, /star\.setAttribute\([\s\S]*"aria-label"/u);
  assert.match(
    app,
    /`\.\/api\/experiments\/\$\{encodeURIComponent\(experiment\.id\)\}\/star`[\s\S]*starred,[\s\S]*mutationId: mutationId\(\),[\s\S]*expectedRevision: experimentRevision\(experiment\)/u,
  );
  assert.match(
    app,
    /`\.\/api\/experiments\/\$\{encodeURIComponent\(experiment\.id\)\}\/feedback`[\s\S]*kind,[\s\S]*mutationId: mutationId\(\),[\s\S]*expectedRevision: experimentRevision\(experiment\)/u,
  );
  assert.match(app, /crypto\.randomUUID\(\)/u);
  assert.match(app, /counts\?\.attempted/u);
  assert.match(app, /counts\?\.comparisonsAttempted/u);
  assert.match(app, /Promotion means worth attention, not proven true\./u);
  for (const kind of [
    "useful",
    "already-known",
    "wrong-question",
    "wrong-data",
    "wrong-representation",
    "weak-evidence",
    "misleading",
    "badly-timed",
    "dismissed",
    "acted-upon",
  ]) {
    assert.match(app, new RegExp(`\\["${kind}",`), `missing ${kind} feedback`);
  }
  assert.match(app, /const label = makeElement\("label", null, "Your feedback"\)/u);
  assert.match(app, /label\.htmlFor = selectId/u);
  assert.match(app, /select\.required = true/u);

  assert.match(app, /url\.origin !== window\.location\.origin/u);
  assert.match(app, /url\.pathname\.endsWith\(expectedSuffix\)/u);
  assert.match(app, /link\.href = href/u);
  assert.match(app, /parentHref = safeArtifactHref\(parent\?\.artifact\)/u);
  assert.match(app, /params\.get\("attend-host"\)/u);
  assert.match(app, /params\.get\("attend-generation"\)/u);
  assert.match(app, /return hostBoundHref\(url\.href\)/u);
  assert.match(app, /No artifact was produced because the attempt failed\./u);
  assert.match(app, /No artifact is available for this experiment\./u);

  assert.match(declarationsFor(css, ".star-button"), /min-height:\s*42px/u);
  assert.match(css, /\.star-button\[aria-pressed="true"\]/u);
  assert.match(declarationsFor(css, ".feedback-form"), /display:\s*grid/u);
  assert.match(html, /<fieldset class="filter-group">[\s\S]*<legend>Show<\/legend>/u);
});

test("viewer is a viewport-bound artifact with an accessible slide-out chat drawer", async () => {
  const { html, app, css } = await readViewerAssets();

  assert.match(html, /<main id="workspace" class="workspace"/u);
  assert.match(html, /<section id="map-pane" class="map-pane"/u);
  assert.match(html, /<aside\b[^>]*\bid="chat-pane"[^>]*\bclass="chat-pane"/u);
  assert.match(
    html,
    /<button[^>]*id="chat-toggle"[^>]*aria-controls="chat-pane"[^>]*aria-expanded="false"/u,
  );
  assert.match(html, /<button[^>]*id="chat-close"[^>]*aria-label="Close chat"/u);
  assert.match(html, /<div id="chat-scroll" class="chat-scroll"/u);
  assert.match(html, /<div id="conversation" class="conversation"/u);

  const scrollStart = html.indexOf('id="chat-scroll"');
  const conversationStart = html.indexOf('id="conversation"');
  const composerStart = html.indexOf('id="chat-form"');
  const selectionStart = html.indexOf('id="selection-panel"');
  const suggestedStart = html.indexOf('id="suggested-question"');
  const composerEnd = html.indexOf("</form>", composerStart);
  assert.ok(scrollStart >= 0 && conversationStart > scrollStart && conversationStart < composerStart);
  assert.ok(
    composerStart >= 0 &&
      selectionStart > composerStart &&
      suggestedStart > selectionStart &&
      suggestedStart < composerEnd,
    "the selected mark and suggested question must be attached to the composer",
  );

  const documentRules = `${declarationsFor(css, "html")}\n${declarationsFor(css, "body")}`;
  assert.match(documentRules, /height:\s*100%/u);
  assert.match(documentRules, /overflow:\s*hidden/u);
  assert.match(declarationsFor(css, ".shell"), /height:\s*100dvh/u);

  for (const selector of [".workspace", ".map-pane", ".chat-pane"]) {
    assert.match(
      declarationsFor(css, selector),
      /min-height:\s*0/u,
      `${selector} must be allowed to shrink inside the viewport shell`,
    );
  }
  assert.match(declarationsFor(css, ".workspace"), /overflow:\s*hidden/u);
  assert.match(declarationsFor(css, ".map-pane"), /overflow-y:\s*auto/u);
  assert.match(declarationsFor(css, ".chat-scroll"), /overflow-y:\s*auto/u);
  assert.match(declarationsFor(css, ".composer"), /flex:\s*(?:none|0\s+0\s+auto)/u);

  const drawer = declarationsFor(css, ".chat-pane");
  assert.match(drawer, /position:\s*absolute/u);
  assert.match(drawer, /inset-inline-end:\s*0/u);
  assert.match(drawer, /width:\s*min\(var\(--drawer-width\),\s*100%\)/u);
  assert.match(drawer, /height:\s*100%/u);
  assert.match(drawer, /transform:\s*translate3d\(100%,\s*0,\s*0\)/u);
  assert.match(drawer, /transition:\s*transform/u);
  assert.match(drawer, /will-change:\s*transform/u);
  assert.doesNotMatch(drawer, /margin-inline-end/u, "opening chat must not resize the artifact");
  assert.match(
    declarationsFor(css, '.workspace[data-chat-open="true"] .chat-pane'),
    /transform:\s*translate3d\(0,\s*0,\s*0\)/u,
  );
  assert.match(app, /elements\.question\.textContent\s*=\s*model\.title/u);
  assert.match(app, /elements\.target\.textContent\s*=\s*model\.question/u);
});

test("drawer, attachment, and suggested-question interactions preserve exact chat state", async () => {
  const { html, app, css } = await readViewerAssets();

  assert.match(app, /\.setAttribute\("aria-expanded",/u);
  assert.match(app, /\.setAttribute\("aria-hidden",/u);
  assert.match(app, /\.inert\s*=/u);
  assert.match(app, /event\.key\s*===\s*"Escape"/u);
  assert.match(app, /event\.key\s*===\s*"\/"/u);
  assert.match(app, /event\.metaKey\s*\|\|\s*event\.ctrlKey/u);

  const selectStart = app.indexOf("async function selectRow");
  const selectEnd = app.indexOf("async function sendMessage", selectStart);
  const selectSource = app.slice(selectStart, selectEnd);
  assert.ok(selectStart >= 0 && selectEnd > selectStart, "selectRow must remain inspectable");
  assert.match(selectSource, /await request\("selection"/u);
  assert.match(selectSource, /openChat\(\)/u);
  assert.match(selectSource, /elements\.input\.focus\(\)/u);

  assert.match(app, /selection-remove/u);
  assert.match(app, /Remove attached phrase/u);
  assert.doesNotMatch(app, /Replying to|From visualization/u);
  assert.doesNotMatch(app, /markContextSummary\(mark\)/u);
  assert.match(app, /turn\.role === "user"[\s\S]*historicalAttachment\(turn\)/u);
  assert.doesNotMatch(app, /evidence-list/u);
  assert.doesNotMatch(app, /row\.occurrences\.slice/u);
  assert.doesNotMatch(html, /id="thread-context"|Conversation context/u);
  assert.doesNotMatch(app, /threadContext|Conversation context ·/u);
  assert.doesNotMatch(app, /Using [^\n]* context/u);
  assert.match(app, /What themes and changes emerge across/u);

  const fieldStart = html.indexOf('class="composer-field"');
  const inputStart = html.indexOf('id="chat-input"');
  const inlineSuggestionStart = html.indexOf('id="suggested-question"');
  const submitStart = html.indexOf('id="chat-submit"');
  assert.ok(
    fieldStart >= 0 &&
      inputStart > fieldStart &&
      inlineSuggestionStart > inputStart &&
      submitStart > inlineSuggestionStart,
    "the Tab suggestion must live inside the input area rather than above the composer",
  );
  assert.match(app, /elements\.input\.placeholder = hostUnattached/u);
  assert.match(app, /Sidebar chat is unavailable from this library link\./u);
  assert.match(declarationsFor(css, ".composer-input"), /position:\s*relative/u);
  assert.match(declarationsFor(css, ".suggested-question"), /position:\s*absolute/u);
  assert.match(declarationsFor(css, ".suggested-question"), /inset:\s*0/u);
  assert.match(declarationsFor(css, ".suggested-question"), /pointer-events:\s*none/u);
  assert.doesNotMatch(app, /elements\.suggestion\.addEventListener/u);

  const keydownStart = app.indexOf('elements.input.addEventListener("keydown"');
  const keydownEnd = app.indexOf("\n});", keydownStart);
  const keydownSource = app.slice(keydownStart, keydownEnd);
  assert.ok(keydownStart >= 0 && keydownEnd > keydownStart, "composer key handling must remain inspectable");
  assert.match(keydownSource, /event\.key\s*===\s*"Tab"/u);
  assert.match(keydownSource, /!event\.isComposing/u);
  for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
    assert.match(
      keydownSource,
      new RegExp(`!event\\.${modifier}`),
      `Tab completion must ignore ${modifier} chords`,
    );
  }
  assert.match(keydownSource, /!elements\.input\.value(?:\.trim\(\))?/u);
  assert.match(keydownSource, /elements\.input\.value\s*=\s*suggestedQuestion/u);

  const tabStart = keydownSource.indexOf('event.key === "Tab"');
  const tabEnd = keydownSource.indexOf("return;", tabStart);
  const tabSource = keydownSource.slice(tabStart, tabEnd);
  assert.ok(tabStart >= 0 && tabEnd > tabStart, "the Tab completion branch must return explicitly");
  assert.match(
    tabSource,
    /event\.preventDefault\(\)/u,
    "Tab completion must keep focus in the textarea",
  );
  assert.ok(
    tabSource.indexOf("event.preventDefault()") <
      tabSource.indexOf("elements.input.value = suggestedQuestion"),
    "Tab completion must prevent native focus movement before populating the textarea",
  );
  assert.doesNotMatch(
    tabSource,
    /requestSubmit|sendMessage/u,
    "accepting a suggestion must populate the composer without sending it",
  );

  const sendStart = app.indexOf("async function sendMessage");
  const sendEnd = app.indexOf("async function refreshState", sendStart);
  const sendSource = app.slice(sendStart, sendEnd);
  assert.ok(sendStart >= 0 && sendEnd > sendStart, "sendMessage must remain inspectable");
  assert.match(sendSource, /expectedRevision:\s*session\.state\.revision/u);
  assert.match(sendSource, /selectionId:\s*session\.selection\.id/u);
  assert.match(sendSource, /threadId:\s*activeThread\.id/u);
  assert.doesNotMatch(sendSource, /hostNotification|notification|wake|host chat/iu);
  const requestStart = sendSource.indexOf('await request("chat"');
  const clearDraft = sendSource.indexOf('elements.input.value = ""');
  const catchStart = sendSource.indexOf("} catch", requestStart);
  assert.ok(
    requestStart >= 0 && clearDraft > requestStart && clearDraft < catchStart,
    "the draft must only clear after the chat request succeeds",
  );
  assert.doesNotMatch(
    sendSource.slice(catchStart),
    /elements\.input\.value\s*=\s*""/u,
    "a stale-state conflict must retain the draft",
  );
  assert.doesNotMatch(
    sendSource,
    /request\("selection"/u,
    "the successful chat response owns the atomic detach; the viewer must not issue a second mutation",
  );
  const acceptSession = sendSource.indexOf("session = unwrapSession(payload)", requestStart);
  const renderAcceptedState = sendSource.indexOf("renderState({ followConversation: true })", acceptSession);
  assert.ok(
    acceptSession > requestStart && renderAcceptedState > acceptSession && renderAcceptedState < catchStart,
    "the viewer must render the authoritative post-send session, including its cleared live selection",
  );

  assert.doesNotMatch(declarationsFor(css, ".turn-attachment"), /turn-attachment-meta/u);

  const refreshStart = app.indexOf("async function refreshState");
  const refreshEnd = app.indexOf('elements.chatToggle.addEventListener', refreshStart);
  const refreshSource = app.slice(refreshStart, refreshEnd);
  assert.match(
    refreshSource,
    /next\.state\.revision\s*>\s*session\.state\.revision/u,
    "an older polling response must never replace newer client state",
  );
  assert.match(refreshSource, /next\.conversation\?\.revision\s*!==\s*activeThread\?\.revision/u);
  assert.match(app, /function draftNeedsReview\(\)/u);
  assert.match(sendSource, /if \(draftNeedsReview\(\)\)/u);
  assert.match(app, /draftSelectionKey\s*!==\s*semanticAttachmentKey\(\)/u);
  const attachmentKeyStart = app.indexOf("function semanticAttachmentKey");
  const attachmentKeyEnd = app.indexOf("function pinDraftToCurrentSelection", attachmentKeyStart);
  const attachmentKeySource = app.slice(attachmentKeyStart, attachmentKeyEnd);
  assert.ok(
    attachmentKeyStart >= 0 && attachmentKeyEnd > attachmentKeyStart,
    "semantic attachment key must remain inspectable",
  );
  for (const field of [
    "dataPackageId",
    "dataHash",
    "map",
    "selectedMarkIds",
    "predicate",
    "filters",
    "aggregation",
    "sort",
  ]) {
    assert.match(
      attachmentKeySource,
      new RegExp(`${field}:\\s*selection\\.${field}`),
      `the draft pin must include selection.${field}`,
    );
  }
  assert.match(
    attachmentKeySource,
    /if \(!selection\?\.selectedMarkIds\?\.length\) return null/u,
    "an unattached follow-up draft must not be pinned to unrelated view filters",
  );
  assert.doesNotMatch(
    attachmentKeySource,
    /\bid:\s*selection\.id|stateRevision/u,
    "opaque ids and revision-only chat updates must not invalidate a semantically unchanged draft",
  );
  assert.match(app, /turn\.replyToTurnId/u);
  assert.match(app, /status === "queued" \|\| status === "running"/u);
  assert.doesNotMatch(app, /Thinking…/u);
  assert.match(app, /status === "failed"/u);
  assert.match(app, /retry\.textContent = "Retry"/u);
  assert.match(app, /retry\.addEventListener\("click", \(\) => retryQuestion\(turn\.id\)\)/u);
  assert.match(app, /await request\("chat\/retry"/u);
  assert.match(app, /body: JSON\.stringify\(\{ threadId:\s*activeThread\.id, questionId \}\)/u);
  assert.match(app, /function hasActiveResponse\(value = activeThread\)/u);
  assert.match(app, /turn\.response\?\.status === "queued" \|\| turn\.response\?\.status === "running"/u);
  assert.match(app, /!answeredQuestionIds\.has\(turn\.id\)/u);
  assert.match(app, /const hostUnattached =\s*route\.kind === "host" && route\.registered === false/u);
  assert.match(app, /elements\.input\.disabled = responseActive \|\| hostUnattached/u);
  assert.match(
    app,
    /elements\.submit\.disabled =\s*pending \|\| responseActive \|\| hostUnattached \|\|/u,
  );
  assert.match(sendSource, /if \(pending \|\| hasActiveResponse\(\)\) return/u);
  assert.match(app, /retry\.disabled = hasActiveResponse\(\)/u);
  assert.match(
    app,
    /wrap\.className = "turn-wrap turn-wrap-assistant turn-wrap-transient"/u,
    "pending and failed response state must render as an assistant-side turn",
  );
  const conversationStart = app.indexOf("function renderConversation");
  const conversationEnd = app.indexOf("function renderState", conversationStart);
  const conversationSource = app.slice(conversationStart, conversationEnd);
  const appendUserTurn = conversationSource.indexOf("elements.conversation.append(wrap)");
  const createResponseTurn = conversationSource.indexOf(
    "const response = responseState(turn, answeredQuestionIds)",
  );
  const appendResponseTurn = conversationSource.indexOf(
    "if (response) elements.conversation.append(response)",
  );
  assert.ok(
    appendUserTurn >= 0 &&
      createResponseTurn > appendUserTurn &&
      appendResponseTurn > createResponseTurn,
    "the assistant-side response state must be appended after the complete user turn",
  );
  assert.doesNotMatch(
    conversationSource,
    /wrap\.append\(response\)/u,
    "response state must never be nested inside the right-aligned user wrapper",
  );
  assert.match(declarationsFor(css, ".turn-wrap-transient"), /color:\s*var\(--muted\)/u);
  assert.doesNotMatch(app, /Ready for a coding agent|hostNotification|notification_failed|open host chat/iu);
  assert.doesNotMatch((await readLibraryAssets()).html, /coding agent|configured provider route|open host chat|wake agent/iu);
});

test("chat behavior distinguishes private local chat from explicit fallbacks", async () => {
  const { app } = await readViewerAssets();

  assert.match(app, /payload\?\.chat \?\? payload\?\.session\?\.chat/u);
  assert.match(app, /turn\.response\?\.route/u);
  assert.match(app, /route\.kind === "local"/u);
  assert.match(app, /Waiting for the private local model\./u);
  assert.match(app, /Detached fallback: \$\{provider\}/u);
  assert.match(app, /Waiting for the coding agent that opened this view\./u);
  assert.match(app, /Another coding agent owns this queued question\./u);
  assert.match(app, /Sidebar chat is unavailable from this library link\./u);
  assert.match(app, /Saved locally\. Attend cannot wake an inactive agent\./u);
  assert.match(app, /Question delivered to the coding agent that opened this view; waiting for its guarded reply\./u);
  assert.match(app, /Detached fallback: \$\{provider\} is answering\./u);
  assert.match(app, /Detached fallback: \$\{provider\}\. Waiting for the provider\./u);
  assert.doesNotMatch(app, /Thinking/u);
  assert.match(app, /else if \(chatChanged\) \{\s*renderConversation\(\);/u);

  const composerStart = app.indexOf("function syncComposer");
  const composerEnd = app.indexOf("function renderHeader", composerStart);
  const composerSource = app.slice(composerStart, composerEnd);
  assert.doesNotMatch(composerSource, /listener|authenticated|route\.available/u);
  assert.match(
    composerSource,
    /route\.kind === "host" && route\.registered === false/u,
    "an unbound library URL must disable chat without treating listener absence as failure",
  );
});

test("assistant answers render as safe, readable rich text without flattening conversation data", async () => {
  const { app, css } = await readViewerAssets();

  assert.match(app, /function renderAssistantMessage\(value\)/u);
  assert.match(app, /function appendInlineFormatting\(parent, value\)/u);
  for (const tag of ["li", "strong", "em", "code", "blockquote"]) {
    assert.match(
      app,
      new RegExp(`createElement\\(\\"${tag}\\"\\)`),
      `assistant renderer should construct <${tag}> safely`,
    );
  }
  assert.match(app, /const tagName = ordered \? "ol" : "ul"/u);
  assert.match(app, /appendTextBlock\("p",/u);
  assert.match(app, /appendTextBlock\(heading\[1\]\.length <= 2 \? "h3" : "h4"/u);
  assert.match(app, /url\.protocol === "http:" \|\| url\.protocol === "https:"/u);
  assert.match(app, /element\.rel = "noopener noreferrer"/u);
  assert.match(app, /turn\.role === "assistant"\s*\? renderAssistantMessage\(content\)/u);
  assert.match(app, /message\.textContent = content/u, "non-assistant turns remain plain text");
  assert.doesNotMatch(
    app,
    /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|DOMParser/u,
    "model and conversation content must never enter an HTML parsing sink",
  );

  const drawer = declarationsFor(css, ".chat-pane");
  const drawerClamp = drawer.match(
    /--drawer-width:\s*clamp\((\d+)px,\s*(\d+)vw,\s*(\d+)px\)/u,
  );
  assert.ok(drawerClamp, "desktop chat width must remain fluid and capped");
  const [, drawerMin, drawerFluid, drawerMax] = drawerClamp.map(Number);
  assert.ok(drawerMin >= 400 && drawerFluid >= 35 && drawerMax >= 520 && drawerMax <= 680);
  assert.match(drawer, /position:\s*absolute/u);
  assert.match(drawer, /width:\s*min\(var\(--drawer-width\),\s*100%\)/u);
  assert.doesNotMatch(drawer, /flex:\s*0 0 var\(--drawer-width\)/u);

  const assistant = declarationsFor(css, ".turn-assistant");
  const assistantFont = Number(assistant.match(/font-size:\s*([\d.]+)px/u)?.[1]);
  const assistantLeading = Number(assistant.match(/line-height:\s*([\d.]+)/u)?.[1]);
  assert.ok(
    assistantFont >= 15.5 && assistantFont <= 18,
    "assistant copy must stay readable without overwhelming the drawer",
  );
  assert.ok(assistantLeading >= 1.5 && assistantLeading <= 1.75);
  const turnFont = Number(
    declarationsFor(css, ".turn").match(/font-size:\s*([\d.]+)px/u)?.[1],
  );
  assert.ok(turnFont >= 15, "user turns must not be left at utility-text scale");
  assert.match(declarationsFor(css, ".turn-wrap-assistant"), /width:\s*100%/u);
  assert.match(declarationsFor(css, ".turn-wrap-assistant"), /max-width:\s*100%/u);
  assert.match(css, /\.turn-assistant\s*>\s*\*\s*\+\s*\*\s*\{[^}]*margin-block-start:\s*(?:1[2-9]|2\d)px/u);
  assert.match(css, /\.turn-assistant li\s*\+\s*li\s*\{[^}]*margin-block-start:\s*(?:[6-9]|1\d)px/u);
  assert.match(declarationsFor(css, ".turn-user"), /white-space:\s*pre-wrap/u);
  assert.match(declarationsFor(css, ".turn-user"), /background:\s*var\(--chat-user\)/u);
  assert.match(declarationsFor(css, ".composer textarea"), /font-size:\s*16px/u);
  assert.match(declarationsFor(css, ".chat-scroll"), /scroll-padding-block:\s*\d+px \d+px/u);
  assert.match(app, /focusTurnId = null/u);
  assert.match(app, /turn\.id === focusTurnId/u);
  assert.match(app, /findLast\(\(turn\) => turn\.role === "assistant"/u);
  assert.match(app, /focusConversationTurnId = chatPinned \? newAssistant\?\.id \?\? null : null/u);
  assert.match(app, /turnRect\.top - scrollRect\.top - 18/u);
});
