const FEEDBACK_OPTIONS = Object.freeze([
  ["useful", "Useful"],
  ["already-known", "Already known"],
  ["wrong-question", "Wrong question"],
  ["wrong-data", "Wrong data"],
  ["wrong-representation", "Wrong representation"],
  ["weak-evidence", "Weak evidence"],
  ["misleading", "Misleading"],
  ["badly-timed", "Badly timed"],
  ["dismissed", "Dismissed"],
  ["acted-upon", "Acted upon"],
]);

const FEEDBACK_LABELS = new Map(FEEDBACK_OPTIONS);

const elements = {
  chronology: document.getElementById("strict-chronology"),
  counts: document.getElementById("exploration-counts"),
  created: document.getElementById("exploration-created"),
  empty: document.getElementById("empty-state"),
  goal: document.getElementById("exploration-goal"),
  inboxLink: document.getElementById("inbox-link"),
  intent: document.getElementById("analytic-intent"),
  list: document.getElementById("experiment-list"),
  refresh: document.getElementById("refresh"),
  status: document.getElementById("status"),
};

const filterInputs = [...document.querySelectorAll('input[name="experiment-filter"]')];

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
  return { attachmentId, generation };
})();

let exploration = null;
let experiments = [];
let activeFilter = "all";
let strictChronology = false;
let refreshing = false;

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

elements.inboxLink.href = hostBoundHref(elements.inboxLink.href);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function describedText(value, keys = []) {
  const direct = text(value);
  if (direct) return direct;
  if (!isObject(value)) return null;
  for (const key of keys) {
    const candidate = text(value[key]);
    if (candidate) return candidate;
  }
  return null;
}

function textList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => describedText(item, ["text", "label", "summary", "name"]))
      .filter(Boolean);
  }
  const single = describedText(value, ["text", "label", "summary", "name"]);
  return single ? [single] : [];
}

function timestamp(value) {
  const milliseconds = Date.parse(value ?? "");
  return Number.isFinite(milliseconds) ? milliseconds : 0;
}

function formattedDate(value, fallback = "Time unavailable") {
  const milliseconds = timestamp(value);
  if (!milliseconds) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(milliseconds));
}

function executionTimestamp(experiment) {
  const execution = isObject(experiment.execution) ? experiment.execution : {};
  return Math.max(
    timestamp(execution.completedAt),
    timestamp(execution.failedAt),
    timestamp(execution.updatedAt),
    timestamp(execution.startedAt),
    timestamp(experiment.updatedAt),
    timestamp(experiment.createdAt),
  );
}

function experimentTitle(experiment) {
  return text(experiment.hypothesis?.text) ?? `Experiment ${experiment.id}`;
}

function promotedAt(experiment) {
  return text(experiment.promotion?.promotedAt);
}

function starredAt(experiment) {
  return experiment.human?.starred === true
    ? text(experiment.human?.starredAt) ?? experiment.updatedAt ?? experiment.createdAt
    : null;
}

function defaultOrder(left, right) {
  const leftTier = starredAt(left) ? 0 : promotedAt(left) ? 1 : 2;
  const rightTier = starredAt(right) ? 0 : promotedAt(right) ? 1 : 2;
  if (leftTier !== rightTier) return leftTier - rightTier;

  const leftTime = leftTier === 0
    ? timestamp(starredAt(left))
    : leftTier === 1
      ? timestamp(promotedAt(left))
      : executionTimestamp(left);
  const rightTime = rightTier === 0
    ? timestamp(starredAt(right))
    : rightTier === 1
      ? timestamp(promotedAt(right))
      : executionTimestamp(right);
  return rightTime - leftTime || String(left.id).localeCompare(String(right.id));
}

function chronologicalOrder(left, right) {
  return executionTimestamp(right) - executionTimestamp(left)
    || String(left.id).localeCompare(String(right.id));
}

function matchesFilter(experiment) {
  if (activeFilter === "promoted") return Boolean(promotedAt(experiment));
  if (activeFilter === "starred") return experiment.human?.starred === true;
  return true;
}

function visibleExperiments() {
  return experiments
    .filter(matchesFilter)
    .sort(strictChronology ? chronologicalOrder : defaultOrder);
}

function canonicalExperiments(values) {
  const byId = new Map();
  for (const candidate of Array.isArray(values) ? values : []) {
    if (!isObject(candidate) || !text(candidate.id)) continue;
    byId.set(candidate.id, candidate);
  }
  return [...byId.values()];
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function makeElement(tagName, className, content) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (content !== undefined && content !== null) element.textContent = String(content);
  return element;
}

function appendTime(parent, value, prefix = "") {
  const time = document.createElement("time");
  time.dateTime = text(value) ?? "";
  time.textContent = `${prefix}${formattedDate(value)}`;
  parent.append(time);
}

function executionStatus(experiment) {
  return text(experiment.execution?.status) ?? "not-run";
}

function statusLabel(status) {
  const labels = {
    abstained: "Abstained",
    completed: "Completed",
    failed: "Failed",
    pending: "Pending",
    queued: "Queued",
    running: "Running",
    skipped: "Skipped",
    succeeded: "Completed",
    "no-result": "Null result",
    "not-run": "Not run",
    "null-result": "Null result",
  };
  return labels[status] ?? status.replaceAll("-", " ");
}

function attemptCount(experiment) {
  const execution = isObject(experiment.execution) ? experiment.execution : {};
  for (const value of [execution.attemptCount, execution.attemptsCount]) {
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  if (Array.isArray(execution.attempts)) return execution.attempts.length;
  if (Number.isSafeInteger(execution.attempts) && execution.attempts >= 0) {
    return execution.attempts;
  }
  return execution.status ? 1 : 0;
}

function outcomeText(experiment) {
  return describedText(experiment.outcome, [
    "text",
    "summary",
    "result",
    "description",
    "message",
  ]);
}

function outcomeKind(experiment) {
  return text(experiment.outcome?.kind) ?? text(experiment.outcome?.status);
}

function failureText(experiment) {
  return describedText(experiment.execution?.error, ["message", "summary", "detail"])
    ?? text(experiment.execution?.failureReason)
    ?? text(experiment.execution?.message);
}

function isNullResult(experiment) {
  const status = executionStatus(experiment);
  const kind = outcomeKind(experiment);
  return ["abstained", "no-result", "null-result"].includes(status)
    || ["abstained", "no-result", "null-result", "null"].includes(kind);
}

function safeArtifactHref(artifact) {
  if (!isObject(artifact) || !text(artifact.href) || !text(artifact.sessionId)) return null;
  try {
    const url = new URL(artifact.href, window.location.href);
    const expectedSuffix = `/s/${encodeURIComponent(artifact.sessionId)}/`;
    if (url.origin !== window.location.origin || !url.pathname.endsWith(expectedSuffix)) {
      return null;
    }
    return hostBoundHref(url.href);
  } catch {
    return null;
  }
}

function detailList(rows, className = "detail-list") {
  const list = makeElement("dl", className);
  for (const [label, value] of rows) {
    if (!text(String(value ?? ""))) continue;
    list.append(makeElement("dt", null, label), makeElement("dd", null, value));
  }
  return list;
}

function badgesFor(experiment) {
  const badges = makeElement("div", "experiment-badges");
  if (experiment.human?.starred === true) {
    badges.append(makeElement("span", "badge badge-starred", "Starred by you"));
  }
  if (promotedAt(experiment)) {
    badges.append(makeElement("span", "badge badge-promoted", "Agent promoted"));
  }
  const status = executionStatus(experiment);
  const executionBadge = makeElement("span", "badge badge-status", statusLabel(status));
  executionBadge.dataset.status = status;
  badges.append(executionBadge);
  return badges;
}

function branchLine(experiment) {
  const parentId = text(experiment.parentExperimentId);
  if (!parentId) return null;
  const line = makeElement("p", "branch-line");
  line.append(makeElement("span", "branch-label", "Branch of "));
  const parent = experiments.find((candidate) => candidate.id === parentId);
  const parentLabel = parent ? experimentTitle(parent) : parentId;
  const parentHref = safeArtifactHref(parent?.artifact);
  if (parentHref) {
    const link = makeElement("a", "branch-link", parentLabel);
    link.href = parentHref;
    line.append(link);
  } else {
    line.append(makeElement("span", "branch-parent", parentLabel));
  }
  return line;
}

function hypothesisPanel(experiment, position) {
  const panel = makeElement("section", "hypothesis-panel");
  panel.setAttribute("aria-labelledby", `experiment-heading-${position}`);

  const top = makeElement("div", "experiment-topline");
  top.append(makeElement("span", "experiment-number", `Experiment ${position + 1}`));
  top.append(badgesFor(experiment));

  const star = makeElement(
    "button",
    "star-button",
    experiment.human?.starred === true ? "Starred" : "Star",
  );
  star.type = "button";
  star.dataset.starExperiment = experiment.id;
  star.setAttribute("aria-pressed", String(experiment.human?.starred === true));
  star.setAttribute(
    "aria-label",
    `${experiment.human?.starred === true ? "Remove star from" : "Star"} experiment: ${experimentTitle(experiment)}`,
  );
  star.addEventListener("click", () => setStar(experiment, star));

  const headingRow = makeElement("div", "hypothesis-heading-row");
  const heading = makeElement("h3", "hypothesis", experimentTitle(experiment));
  heading.id = `experiment-heading-${position}`;
  headingRow.append(heading, star);

  const reason = makeElement("div", "hypothesis-reason");
  reason.append(makeElement("h4", null, "Why test this"));
  reason.append(makeElement(
    "p",
    null,
    text(experiment.hypothesis?.whyUseful) ?? "No reason was recorded for this experiment.",
  ));

  const branch = branchLine(experiment);
  const representation = [
    text(experiment.representation?.family),
    text(experiment.representation?.member),
  ].filter(Boolean).join(" / ") || "Not selected";
  const details = detailList([
    ["Representation", representation],
    ["Baseline", describedText(experiment.hypothesis?.baseline, ["text", "label", "summary"])],
    ["Origin", describedText(experiment.hypothesis?.origin, ["text", "label", "name", "kind"])],
    ["Analysis mode", describedText(experiment.hypothesis?.analysisMode, ["text", "label", "summary"])],
    ["Timing", describedText(experiment.hypothesis?.timing, ["text", "label", "summary"])],
    ["Comparisons declared", experiment.comparisonCount],
  ], "hypothesis-details");

  panel.append(top, headingRow, reason);
  if (branch) panel.append(branch);
  panel.append(details);
  return panel;
}

function appendNamedText(parent, heading, value, className = "result-block") {
  const content = text(value);
  if (!content) return;
  const block = makeElement("div", className);
  block.append(makeElement("h5", null, heading), makeElement("p", null, content));
  parent.append(block);
}

function appendNamedList(parent, heading, values) {
  if (!values.length) return;
  const block = makeElement("div", "result-block");
  block.append(makeElement("h5", null, heading));
  const list = makeElement("ul", "result-list");
  list.append(...values.map((value) => makeElement("li", null, value)));
  block.append(list);
  parent.append(block);
}

function feedbackSummary(experiment) {
  if (!isObject(experiment.feedbackSummary)) return null;
  const values = FEEDBACK_OPTIONS.flatMap(([kind, label]) => {
    const count = experiment.feedbackSummary[kind];
    return Number.isSafeInteger(count) && count > 0 ? [`${label} ${count}`] : [];
  });
  if (!values.length) return null;
  const summary = makeElement("p", "feedback-summary");
  summary.append(makeElement("strong", null, "Feedback "));
  summary.append(document.createTextNode(values.join(" · ")));
  return summary;
}

function interestingnessSummary(experiment) {
  const vector = experiment.assessment?.interestingness;
  if (!isObject(vector)) return null;
  const labels = {
    taskRelevance: "Task relevance",
    evidenceSufficiency: "Evidence sufficiency",
    surprise: "Surprise vs. baseline",
    novelty: "Novelty",
    actionability: "Actionability",
    representationalDiversity: "Representational diversity",
    uncertainty: "Uncertainty",
    interruptionCost: "Interruption cost",
  };
  const rows = Object.entries(labels).map(([key, label]) => {
    const score = vector[key];
    return [label, Number.isFinite(score) ? score.toFixed(2) : "Not recorded"];
  });
  const block = makeElement("div", "result-block interestingness-block");
  block.append(makeElement("h5", null, "Interestingness assessment"));
  block.append(detailList(rows, "interestingness-vector"));
  return block;
}

function eventDescription(event) {
  if (!isObject(event)) return "Unknown event";
  const labels = {
    "execution-started": "Execution started",
    "execution-completed": "Execution completed",
    "execution-failed": "Execution failed",
    "assessment-recorded": "Assessment recorded",
    "agent-promoted": "Agent promoted",
    "human-star-changed": event.payload?.starred === true ? "Human star added" : "Human star removed",
    "feedback-recorded": `Feedback: ${FEEDBACK_LABELS.get(event.payload?.kind) ?? event.payload?.kind ?? "recorded"}`,
    "human-disposition-recorded": `Disposition: ${FEEDBACK_LABELS.get(event.payload?.disposition) ?? event.payload?.disposition ?? "recorded"}`,
  };
  return labels[event.kind] ?? String(event.kind ?? "Unknown event").replaceAll("-", " ");
}

function historyPanel(experiment) {
  const history = Array.isArray(experiment.history) ? experiment.history : [];
  if (!history.length) return null;
  const details = document.createElement("details");
  details.className = "history-panel";
  const summary = makeElement(
    "summary",
    null,
    `Complete history · ${history.length} ${plural(history.length, "event")}`,
  );
  const list = makeElement("ol", "history-list");
  for (const event of history) {
    const item = makeElement("li", null);
    item.append(makeElement("strong", null, eventDescription(event)));
    if (timestamp(event.at)) appendTime(item, event.at, " · ");
    list.append(item);
  }
  details.append(summary, list);
  return details;
}

function resultPanel(experiment) {
  const panel = makeElement("section", "result-panel");
  const titleRow = makeElement("div", "result-title-row");
  titleRow.append(makeElement("h4", null, "Result"));
  const attempts = attemptCount(experiment);
  titleRow.append(makeElement(
    "span",
    "attempt-count",
    `${attempts} ${plural(attempts, "attempt")}`,
  ));
  panel.append(titleRow);

  const status = executionStatus(experiment);
  const statusLine = makeElement("p", "execution-status");
  statusLine.dataset.status = status;
  statusLine.append(makeElement("strong", null, statusLabel(status)));
  const executedAt = experiment.execution?.completedAt
    ?? experiment.execution?.failedAt
    ?? experiment.execution?.updatedAt
    ?? experiment.execution?.startedAt
    ?? experiment.updatedAt;
  if (timestamp(executedAt)) appendTime(statusLine, executedAt, " · ");
  panel.append(statusLine);

  const outcome = outcomeText(experiment);
  const failure = failureText(experiment);
  const nullResult = isNullResult(experiment);
  if (status === "failed") {
    appendNamedText(panel, "What failed", failure ?? "The attempt failed without a recorded reason.", "result-block result-failure");
  } else if (nullResult) {
    appendNamedText(
      panel,
      "What surfaced",
      outcome ?? experiment.assessment?.whatSurfaced ?? "The evidence did not support a result worth presenting.",
      "result-block result-null",
    );
  } else if (["pending", "queued", "running", "not-run"].includes(status)) {
    appendNamedText(panel, "Current state", outcome ?? "This experiment has not produced a result yet.");
  } else {
    appendNamedText(panel, "Outcome", outcome ?? "No outcome was recorded.");
  }

  if (!nullResult) appendNamedText(panel, "What surfaced", experiment.assessment?.whatSurfaced);
  appendNamedText(panel, "Assessment", experiment.assessment?.rationale);

  if (text(experiment.assessment?.evidenceStrength)) {
    const strength = makeElement("p", "evidence-strength");
    strength.append(
      makeElement("span", null, "Evidence strength"),
      makeElement("strong", null, experiment.assessment.evidenceStrength),
    );
    panel.append(strength);
  }

  if (experiment.promotion) {
    appendNamedText(
      panel,
      "Why promoted",
      text(experiment.promotion.rationale) ?? "The agent marked this experiment worth seeing.",
      "result-block promotion-rationale",
    );
    const admitted = exploration?.counts?.experiments ?? experiments.length;
    const attempted = exploration?.counts?.attempted
      ?? experiments.filter((candidate) => executionStatus(candidate) !== "queued").length;
    const comparisons = exploration?.counts?.comparisonsAttempted
      ?? experiments
        .filter((candidate) => executionStatus(candidate) !== "queued")
        .reduce((total, candidate) => total + (candidate.comparisonCount ?? 0), 0);
    appendNamedText(
      panel,
      "Exploratory selection",
      `Selected after ${attempted} of ${admitted} admitted ${plural(admitted, "experiment")} were attempted across ${comparisons} declared ${plural(comparisons, "comparison")}. Promotion means worth attention, not proven true.`,
      "result-block promotion-context",
    );
  }

  appendNamedList(panel, "Limitations", textList(experiment.assessment?.limitations));
  appendNamedList(panel, "Factors", textList(experiment.assessment?.factors));
  const interestingness = interestingnessSummary(experiment);
  if (interestingness) panel.append(interestingness);
  const summary = feedbackSummary(experiment);
  if (summary) panel.append(summary);
  const history = historyPanel(experiment);
  if (history) panel.append(history);
  return panel;
}

function feedbackForm(experiment, position) {
  const form = makeElement("form", "feedback-form");
  const selectId = `feedback-${position}`;
  const label = makeElement("label", null, "Your feedback");
  label.htmlFor = selectId;
  const select = document.createElement("select");
  select.id = selectId;
  select.name = "kind";
  select.required = true;
  select.dataset.feedbackExperiment = experiment.id;

  const placeholder = makeElement("option", null, "Choose a response");
  placeholder.value = "";
  select.append(placeholder);
  const disposition = text(experiment.human?.disposition);
  for (const [value, optionLabel] of FEEDBACK_OPTIONS) {
    const option = makeElement("option", null, optionLabel);
    option.value = value;
    option.selected = disposition === value;
    select.append(option);
  }

  const button = makeElement("button", null, "Send feedback");
  button.type = "submit";
  form.append(label, select, button);
  form.addEventListener("submit", (event) => submitFeedback(event, experiment, select, button));
  return form;
}

function experimentFooter(experiment, position) {
  const footer = makeElement("footer", "experiment-footer");
  const artifactArea = makeElement("div", "artifact-area");
  const href = safeArtifactHref(experiment.artifact);
  if (href) {
    const link = makeElement("a", "artifact-link", "Open artifact");
    link.href = href;
    artifactArea.append(link);
  } else {
    const message = executionStatus(experiment) === "failed"
      ? "No artifact was produced because the attempt failed."
      : "No artifact is available for this experiment.";
    artifactArea.append(makeElement("span", "artifact-unavailable", message));
  }
  footer.append(artifactArea, feedbackForm(experiment, position));
  return footer;
}

function renderExperiment(experiment, position) {
  const item = makeElement("li", "experiment-item");
  item.dataset.experimentId = experiment.id;
  item.dataset.promoted = String(Boolean(promotedAt(experiment)));
  item.dataset.starred = String(experiment.human?.starred === true);
  item.dataset.status = executionStatus(experiment);

  const article = makeElement("article", "experiment-card");
  article.append(
    hypothesisPanel(experiment, position),
    resultPanel(experiment),
    experimentFooter(experiment, position),
  );
  item.append(article);
  return item;
}

function renderHeader() {
  if (!exploration) return;
  const goal = text(exploration.goal) ?? "Untitled exploration";
  elements.goal.textContent = goal;
  document.title = `${goal} · Attend`;
  elements.intent.textContent = text(exploration.analyticIntent)
    ?? "No analytic intent was recorded.";
  elements.created.replaceChildren();
  if (timestamp(exploration.createdAt)) {
    appendTime(elements.created, exploration.createdAt, "Started ");
  }

  const suppliedCounts = isObject(exploration.counts) ? exploration.counts : {};
  const total = Number.isSafeInteger(suppliedCounts.experiments)
    ? suppliedCounts.experiments
    : experiments.length;
  const promoted = Number.isSafeInteger(suppliedCounts.promoted)
    ? suppliedCounts.promoted
    : experiments.filter((experiment) => promotedAt(experiment)).length;
  const starred = Number.isSafeInteger(suppliedCounts.starred)
    ? suppliedCounts.starred
    : experiments.filter((experiment) => experiment.human?.starred === true).length;
  elements.counts.replaceChildren(
    makeElement("span", null, `${total} ${plural(total, "experiment")}`),
    makeElement("span", null, `${promoted} promoted`),
    makeElement("span", null, `${starred} starred`),
  );
}

function focusControl(kind, experimentId) {
  const attribute = kind === "star" ? "starExperiment" : "feedbackExperiment";
  const controls = elements.list.querySelectorAll(
    kind === "star" ? "[data-star-experiment]" : "[data-feedback-experiment]",
  );
  const control = [...controls].find((candidate) => candidate.dataset[attribute] === experimentId);
  if (control) {
    control.focus();
    return;
  }
  filterInputs.find((input) => input.checked)?.focus();
}

function render({ focus = null } = {}) {
  renderHeader();
  const visible = visibleExperiments();
  elements.list.replaceChildren(...visible.map(renderExperiment));
  elements.empty.hidden = visible.length !== 0;
  const filterLabel = activeFilter === "promoted"
    ? "agent-promoted"
    : activeFilter === "starred"
      ? "starred"
      : "total";
  const orderLabel = strictChronology ? " in strict chronology" : "";
  elements.status.textContent = `${visible.length} ${filterLabel} ${plural(visible.length, "experiment")}${orderLabel}`;
  if (focus) focusControl(focus.kind, focus.experimentId);
}

function replaceExperiment(experiment) {
  const index = experiments.findIndex((candidate) => candidate.id === experiment.id);
  if (index >= 0) experiments[index] = experiment;
}

function experimentFromResponse(payload, experimentId) {
  const direct = payload?.experiment;
  if (isObject(direct) && direct.id === experimentId) return direct;
  if (Array.isArray(payload?.experiments)) {
    return payload.experiments.find((candidate) => candidate?.id === experimentId) ?? null;
  }
  return isObject(payload) && payload.id === experimentId ? payload : null;
}

async function request(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      "content-type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      text(payload.error?.message)
        ?? text(payload.error)
        ?? `Request failed (${response.status})`,
    );
  }
  return payload;
}

function mutationId() {
  return `mutation_${crypto.randomUUID()}`;
}

function experimentRevision(experiment) {
  if (Number.isSafeInteger(experiment.revision) && experiment.revision >= 0) {
    return experiment.revision;
  }
  return Array.isArray(experiment.history) ? experiment.history.length : 0;
}

async function setStar(experiment, button) {
  const starred = experiment.human?.starred !== true;
  button.disabled = true;
  elements.status.textContent = starred ? "Adding star…" : "Removing star…";
  try {
    const payload = await request(
      `./api/experiments/${encodeURIComponent(experiment.id)}/star`,
      {
        method: "POST",
        body: JSON.stringify({
          starred,
          mutationId: mutationId(),
          expectedRevision: experimentRevision(experiment),
        }),
      },
    );
    const fallback = {
      ...experiment,
      revision: experimentRevision(experiment) + 1,
      human: {
        ...(isObject(experiment.human) ? experiment.human : {}),
        starred,
        starredAt: starred ? new Date().toISOString() : null,
      },
    };
    replaceExperiment(experimentFromResponse(payload, experiment.id) ?? fallback);
    render({ focus: { kind: "star", experimentId: experiment.id } });
  } catch (error) {
    elements.status.textContent = error instanceof Error
      ? error.message
      : "The star could not be saved.";
    button.disabled = false;
    button.focus();
  }
}

async function submitFeedback(event, experiment, select, button) {
  event.preventDefault();
  const kind = select.value;
  if (!FEEDBACK_LABELS.has(kind)) return;
  select.disabled = true;
  button.disabled = true;
  elements.status.textContent = `Saving ${FEEDBACK_LABELS.get(kind)} feedback…`;
  try {
    const payload = await request(
      `./api/experiments/${encodeURIComponent(experiment.id)}/feedback`,
      {
        method: "POST",
        body: JSON.stringify({
          kind,
          mutationId: mutationId(),
          expectedRevision: experimentRevision(experiment),
        }),
      },
    );
    const fallback = {
      ...experiment,
      revision: experimentRevision(experiment) + 1,
      human: {
        ...(isObject(experiment.human) ? experiment.human : {}),
        disposition: kind,
      },
    };
    replaceExperiment(experimentFromResponse(payload, experiment.id) ?? fallback);
    render({ focus: { kind: "feedback", experimentId: experiment.id } });
  } catch (error) {
    elements.status.textContent = error instanceof Error
      ? error.message
      : "The feedback could not be saved.";
    select.disabled = false;
    button.disabled = false;
    select.focus();
  }
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  elements.refresh.disabled = true;
  elements.status.textContent = "Loading experiments…";
  try {
    const response = await fetch("./api/exploration", {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        text(payload.error?.message)
          ?? text(payload.error)
          ?? `Exploration request failed (${response.status})`,
      );
    }
    if (payload.schemaVersion !== 1 || !isObject(payload.exploration) || !Array.isArray(payload.experiments)) {
      throw new Error("The exploration response has an unsupported shape.");
    }
    exploration = payload.exploration;
    experiments = canonicalExperiments(payload.experiments);
    render();
  } catch (error) {
    elements.status.textContent = error instanceof Error
      ? error.message
      : "The exploration could not be loaded.";
  } finally {
    refreshing = false;
    elements.refresh.disabled = false;
  }
}

for (const input of filterInputs) {
  input.addEventListener("change", () => {
    if (!input.checked) return;
    activeFilter = input.value;
    render();
  });
}

elements.chronology.addEventListener("change", () => {
  strictChronology = elements.chronology.checked;
  render();
});

elements.refresh.addEventListener("click", refresh);
refresh();
