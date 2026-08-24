const elements = {
  empty: document.getElementById("empty-state"),
  list: document.getElementById("session-list"),
  refresh: document.getElementById("refresh"),
  status: document.getElementById("status"),
};

let refreshing = false;

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function formattedDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function metadata(entry) {
  const phrases = entry.counts?.phrases;
  const marks = entry.counts?.marks ?? phrases ?? 0;
  const noun = entry.counts?.noun ?? (phrases === undefined ? "mark" : "phrase");
  const sources = entry.counts?.sources ?? 0;
  return `${marks} ${plural(marks, noun)} · ${sources} ${plural(sources, "source")}`;
}

function renderEntry(entry) {
  const item = document.createElement("li");
  const link = document.createElement("a");
  link.className = "session-link";
  link.href = entry.href;

  const copy = document.createElement("span");
  copy.className = "session-copy";
  const question = document.createElement("strong");
  question.className = "session-question";
  question.textContent = entry.question || "Untitled question";
  const target = document.createElement("span");
  target.className = "session-target";
  target.textContent = entry.target ? `Corpus: ${entry.target}` : "Corpus not labeled";
  copy.append(question, target);

  const details = document.createElement("span");
  details.className = "session-details";
  const counts = document.createElement("span");
  counts.textContent = metadata(entry);
  const view = document.createElement("span");
  view.textContent = `${entry.view?.id || "view"} · v${entry.view?.version ?? "—"}`;
  const updated = document.createElement("time");
  updated.dateTime = entry.updatedAt || "";
  updated.textContent = formattedDate(entry.updatedAt);
  details.append(counts, view, updated);

  const arrow = document.createElement("span");
  arrow.className = "session-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "→";

  link.append(copy, details, arrow);
  item.append(link);
  return item;
}

function render(payload) {
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const unavailable = Number.isSafeInteger(payload.unavailableSessionCount)
    ? payload.unavailableSessionCount
    : 0;
  elements.list.replaceChildren(...sessions.map(renderEntry));
  elements.empty.hidden = sessions.length !== 0;
  const availableStatus = sessions.length === 0
    ? "No saved views"
    : `${sessions.length} saved ${plural(sessions.length, "view")}`;
  elements.status.textContent = unavailable > 0
    ? `${availableStatus} · ${unavailable} unavailable after validation`
    : availableStatus;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  elements.refresh.disabled = true;
  try {
    const response = await fetch("./api/library", {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Library request failed (${response.status})`);
    render(await response.json());
  } catch {
    elements.status.textContent = "The local library could not be loaded. Try refreshing.";
  } finally {
    refreshing = false;
    elements.refresh.disabled = false;
  }
}

elements.refresh.addEventListener("click", refresh);
window.addEventListener("focus", refresh);
refresh();
