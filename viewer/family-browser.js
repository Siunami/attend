import { FAMILY_BROWSER_CATALOG } from "./family-catalog.js";

const STATE_VERSION = 1;
const LENSES = Object.freeze(["families", "forms", "constraints"]);
const RELEASE_STATUSES = Object.freeze([
  "executable",
  "documented",
  "unavailable",
  "rejected",
]);

const STATUS_PRESENTATION = Object.freeze({
  executable: {
    label: "Available now",
    consequence: "This exact form is bound to a production renderer in this release.",
  },
  documented: {
    label: "Documented, not executable",
    consequence: "The form is part of the Atlas, but this release cannot run it.",
  },
  unavailable: {
    label: "Unavailable in this release",
    consequence: "The form is governed, but a required capability is missing.",
  },
  rejected: {
    label: "Rejected from the family",
    consequence: "The Atlas records this form as a boundary or caution, not a supported option.",
  },
});

const LENS_LABELS = Object.freeze({
  families: "Families",
  forms: "Forms",
  constraints: "Constraints",
});

const DECISION_LABELS = Object.freeze({
  direct: "Direct",
  deterministic: "Deterministic",
  enrich: "Enrich with review",
  abstain: "Abstain",
});

function text(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized || fallback;
}

function values(value) {
  return Array.isArray(value) ? value : [];
}

function familyGroups(catalog) {
  return values(catalog?.groups).map((group, index) => {
    if (typeof group === "string") return { id: group, label: words(group), order: index };
    return {
      id: text(group?.id),
      label: text(group?.label, words(group?.id)),
      order: Number.isFinite(group?.order) ? group.order : index,
    };
  }).filter((group) => group.id);
}

function catalogFamilies(catalog) {
  return values(catalog?.families).filter((family) => text(family?.id));
}

function catalogMedia(catalog) {
  return values(catalog?.media ?? catalog?.inputMedia ?? catalog?.productionMedia)
    .map((medium) => typeof medium === "string" ? medium : medium?.id)
    .map((medium) => text(medium))
    .filter(Boolean);
}

function memberStatus(member) {
  const status = text(member?.status ?? member?.releaseStatus);
  return RELEASE_STATUSES.includes(status) ? status : null;
}

function memberBand(member) {
  return text(member?.authoredBand ?? member?.bandStatus, memberStatus(member) === "rejected" ? "rejected" : "");
}

function familyMembers(family) {
  return values(family?.members).filter((member) => text(member?.id) && memberStatus(member));
}

function familyById(catalog, id) {
  if (!id) return null;
  return catalogFamilies(catalog).find((family) => family.id === id) ?? null;
}

function memberMatches(catalog, memberId) {
  if (!memberId) return [];
  return catalogFamilies(catalog).flatMap((family) =>
    familyMembers(family)
      .filter((member) => member.id === memberId)
      .map((member) => ({ family, member })),
  );
}

function normalizedSet(value, allowed, defaultValue = []) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const selected = new Set(source.map((item) => text(item)).filter((item) => allowed.has(item)));
  if (selected.size === 0 && (source.length === 0 || defaultValue.length > 0)) return [...defaultValue];
  return [...selected].sort((left, right) => left.localeCompare(right));
}

function orderedStatuses(statuses) {
  const selected = new Set(values(statuses));
  return RELEASE_STATUSES.filter((status) => selected.has(status));
}

function defaultState() {
  return {
    version: STATE_VERSION,
    lens: "families",
    familyId: null,
    memberId: null,
    query: "",
    statuses: [...RELEASE_STATUSES],
    groupIds: [],
    medium: null,
  };
}

function normalizedQuery(value) {
  return text(value).replace(/\s+/gu, " ").slice(0, 240);
}

/**
 * Parse untrusted location state against the supplied catalog. Unknown ids and
 * enum values disappear at this boundary so rendering code can trust state.
 */
export function parseFamilyBrowserState(search, catalog) {
  const defaults = defaultState();
  const parameters = new URLSearchParams(String(search ?? "").replace(/^\?/u, ""));
  const suppliedVersion = parameters.get("v");
  if (suppliedVersion !== null && suppliedVersion !== String(STATE_VERSION)) return defaults;

  const lens = parameters.get("lens");
  const familyIds = new Set(catalogFamilies(catalog).map((family) => family.id));
  const groupIds = new Set(familyGroups(catalog).map((group) => group.id));
  const media = new Set(catalogMedia(catalog));
  const suppliedFamilyId = text(parameters.get("family"));
  const suppliedMemberId = text(parameters.get("member"));
  let familyId = familyIds.has(suppliedFamilyId) ? suppliedFamilyId : null;
  let memberId = null;

  if (suppliedMemberId) {
    const matches = memberMatches(catalog, suppliedMemberId);
    if (familyId) {
      if (matches.some((match) => match.family.id === familyId)) memberId = suppliedMemberId;
    } else if (matches.length === 1) {
      familyId = matches[0].family.id;
      memberId = suppliedMemberId;
    }
  }

  const statusParameter = parameters.get("status");
  const statuses = statusParameter === null
    ? [...RELEASE_STATUSES]
    : statusParameter === "none" || statusParameter === ""
      ? []
      : orderedStatuses(normalizedSet(
          statusParameter,
          new Set(RELEASE_STATUSES),
          RELEASE_STATUSES,
        ));
  const groupParameter = parameters.get("group");
  const selectedGroups = groupParameter === "none"
    ? []
    : normalizedSet(groupParameter, groupIds);
  const suppliedMedium = text(parameters.get("medium"));

  return {
    version: STATE_VERSION,
    lens: LENSES.includes(lens) ? lens : "families",
    familyId,
    memberId,
    query: normalizedQuery(parameters.get("q")),
    statuses,
    groupIds: selectedGroups,
    medium: media.has(suppliedMedium) ? suppliedMedium : null,
  };
}

/** Serialize a trusted state value into one stable, human-readable query. */
export function serializeFamilyBrowserState(state) {
  const parameters = new URLSearchParams();
  parameters.set("v", String(STATE_VERSION));
  const lens = LENSES.includes(state?.lens) ? state.lens : "families";
  if (lens !== "families") parameters.set("lens", lens);
  if (text(state?.familyId)) parameters.set("family", text(state.familyId));
  if (text(state?.memberId)) parameters.set("member", text(state.memberId));
  const query = normalizedQuery(state?.query);
  if (query) parameters.set("q", query);

  const statuses = orderedStatuses(values(state?.statuses));
  if (statuses.length === 0) parameters.set("status", "none");
  else if (statuses.length !== RELEASE_STATUSES.length) parameters.set("status", statuses.join(","));

  const groups = [...new Set(values(state?.groupIds).map((group) => text(group)).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  if (groups.length > 0) parameters.set("group", groups.join(","));
  if (text(state?.medium)) parameters.set("medium", text(state.medium));
  return `?${parameters.toString()}`;
}

function supportedByMedium(family, medium) {
  if (!medium) return true;
  const adapter = values(family?.mediaAdapters).find((candidate) => candidate?.medium === medium);
  return Boolean(adapter && adapter.decision !== "abstain");
}

function searchableFamilyMember(family, member) {
  return [
    family?.id,
    family?.title,
    family?.question,
    family?.oneLine,
    family?.summary,
    member?.id,
    member?.name,
    member?.when,
    member?.rationale,
    member?.band,
    member?.lineage,
    member?.unavailableReason,
    member?.rejectionReason,
  ].map((item) => text(item).toLocaleLowerCase()).filter(Boolean);
}

function searchableFamilyMemberIdentity(family, member) {
  return [family?.id, family?.title, member?.id, member?.name]
    .map((item) => text(item).toLocaleLowerCase())
    .filter(Boolean)
    .join(" ");
}

/**
 * Return catalog references rather than copied member objects. Callers retain
 * access to the owning family's roles and media policy without rebuilding an
 * index or adding family fields to each member.
 */
export function filterFamilyBrowserMembers(catalog, state) {
  const statuses = new Set(values(state?.statuses).filter((status) => RELEASE_STATUSES.includes(status)));
  if (statuses.size === 0) return [];
  const groups = new Set(values(state?.groupIds).map((group) => text(group)).filter(Boolean));
  const tokens = normalizedQuery(state?.query).toLocaleLowerCase().split(" ").filter(Boolean);
  const medium = text(state?.medium);

  const candidates = catalogFamilies(catalog).flatMap((family) => {
    if (groups.size > 0 && !groups.has(family.group)) return [];
    if (!supportedByMedium(family, medium)) return [];
    return familyMembers(family)
      .filter((member) => statuses.has(memberStatus(member)))
      .map((member) => ({ family, member }));
  });
  if (tokens.length === 0) return candidates;

  const indexed = candidates.map((candidate) => ({
    ...candidate,
    searchableFields: searchableFamilyMember(candidate.family, candidate.member),
  }));
  const sameFieldMatches = indexed.filter(({ searchableFields }) => (
    searchableFields.some((field) => tokens.every((token) => field.includes(token)))
  ));
  const matches = indexed.filter(({ family, member, searchableFields }) => {
    const matchesAcrossFields = tokens.every((token) => searchableFields.some((field) => field.includes(token)));
    if (!matchesAcrossFields) return false;
    if (sameFieldMatches.length === 0) return true;
    return searchableFields.some((field) => tokens.every((token) => field.includes(token)))
      || tokens.every((token) => searchableFamilyMemberIdentity(family, member).includes(token));
  });
  return matches.map(({ family, member }) => ({ family, member }));
}

function words(value) {
  return text(value)
    .replace(/[-_]/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function createElement(tagName, className, content) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = String(content);
  return element;
}

function appendText(parent, tagName, className, content) {
  const element = createElement(tagName, className, content);
  parent.append(element);
  return element;
}

function createButton(className, label) {
  const button = createElement("button", className, label);
  button.type = "button";
  return button;
}

function createList(items, className, renderItem) {
  const list = createElement("ul", className);
  items.forEach((item) => {
    const listItem = createElement("li", `${className}__item`);
    renderItem(listItem, item);
    list.append(listItem);
  });
  return list;
}

function statusCount(catalog, status) {
  const supplied = Number(catalog?.counts?.[status]);
  if (Number.isFinite(supplied)) return supplied;
  return catalogFamilies(catalog)
    .flatMap(familyMembers)
    .filter((member) => memberStatus(member) === status)
    .length;
}

function allMemberCount(catalog) {
  return RELEASE_STATUSES.reduce((total, status) => total + statusCount(catalog, status), 0);
}

function statusClass(status) {
  return `family-browser__status family-browser__status--${status}`;
}

function renderStatus(parent, status) {
  const presentation = STATUS_PRESENTATION[status];
  const badge = createElement("span", statusClass(status), presentation?.label ?? words(status));
  badge.dataset.status = status;
  parent.append(badge);
  return badge;
}

function createEditorialUrl(base, familyId) {
  const fallbackBase = globalThis.location?.href ?? "http://localhost/families/";
  const url = new URL(String(base ?? "../../../family-atlas/"), fallbackBase);
  url.hash = `/${encodeURIComponent(familyId)}`;
  return url.href;
}

function roleGroups(family) {
  const roles = family?.roles ?? {};
  return [
    { id: "required", label: "Required roles", roles: values(roles.required ?? family?.requiredRoles) },
    { id: "optional", label: "Optional roles", roles: values(roles.optional ?? family?.optionalRoles) },
  ];
}

function recordBounds(family) {
  const roles = family?.roles ?? {};
  const minimum = Number(roles.minimumRecords ?? family?.minimumRecords);
  const maximum = Number(roles.maximumRecords ?? family?.maximumRecords);
  if (Number.isFinite(minimum) && Number.isFinite(maximum)) {
    return `${minimum.toLocaleString()} to ${maximum.toLocaleString()} records`;
  }
  if (Number.isFinite(minimum)) return `At least ${minimum.toLocaleString()} records`;
  if (Number.isFinite(maximum)) return `At most ${maximum.toLocaleString()} records`;
  return "Record bounds are not declared.";
}

function statusExplanation(member) {
  const status = memberStatus(member);
  if (status === "unavailable") return text(member?.unavailableReason, STATUS_PRESENTATION.unavailable.consequence);
  if (status === "rejected") return text(member?.rejectionReason ?? member?.rationale, STATUS_PRESENTATION.rejected.consequence);
  return STATUS_PRESENTATION[status]?.consequence ?? "";
}

function renderRepresentationCapabilities(parent, member) {
  const capabilities = member?.representationCapabilities;
  const constraints = capabilities?.constraints;
  if (!constraints || typeof constraints !== "object") return;
  const entries = [
    ["dimensionality", "Dimensionality"],
    ["form", "Form"],
    ["interaction", "Interaction"],
    ["motion", "Motion"],
    ["projection", "Projection"],
  ].map(([id, label]) => ({ id, label, values: values(constraints[id]).map((value) => text(value)).filter(Boolean) }))
    .filter((entry) => entry.values.length > 0);
  if (entries.length === 0) return;

  const section = createElement("section", "family-browser__capabilities");
  section.dataset.capabilityVersion = String(capabilities.version ?? "");
  appendText(
    section,
    "h4",
    "family-browser__subheading",
    memberStatus(member) === "executable" ? "Generatable bounds" : "Governed representation bounds",
  );
  appendText(
    section,
    "p",
    "family-browser__capabilities-note",
    memberStatus(member) === "executable"
      ? "These are the exact representation constraints this release can satisfy for this form."
      : "These are the governed representation bounds for this form; the capability named above still blocks it in this release.",
  );
  const list = createElement("dl", "family-browser__capability-list");
  entries.forEach((entry) => {
    appendText(list, "dt", "family-browser__capability-label", entry.label);
    const description = createElement("dd", "family-browser__capability-values");
    entry.values.forEach((value) => {
      const chip = createElement("span", "family-browser__capability-value", words(value));
      chip.dataset.constraint = entry.id;
      chip.dataset.value = value;
      description.append(chip);
    });
    list.append(description);
  });
  section.append(list);
  parent.append(section);
}

function renderMemberDetail(parent, family, member, actions) {
  const section = createElement("section", "family-browser__section family-browser__member-detail");
  section.dataset.memberId = member.id;
  appendText(section, "p", "family-browser__eyebrow", "Selected form");
  appendText(section, "h3", "family-browser__section-title", text(member.name, words(member.id)));
  renderStatus(section, memberStatus(member));
  appendText(section, "p", "family-browser__status-copy", statusExplanation(member));

  const facts = createElement("dl", "family-browser__facts");
  const factRows = [
    ["Authored band", words(memberBand(member))],
    ["Use when", text(member.when, "No selection guidance is recorded.")],
    ["Readable band", text(member.band, "No quantity band is recorded.")],
    ["Why it belongs", text(member.rationale, "No rationale is recorded.")],
    ["Lineage", text(member.lineage, "No lineage note is recorded.")],
  ];
  factRows.forEach(([label, value]) => {
    appendText(facts, "dt", "family-browser__fact-label", label);
    appendText(facts, "dd", "family-browser__fact-value", value);
  });
  section.append(facts);
  renderRepresentationCapabilities(section, member);

  const requirements = values(member.requirements);
  if (requirements.length > 0) {
    appendText(section, "h4", "family-browser__subheading", "Release requirements");
    section.append(createList(requirements, "family-browser__plain-list", (item, requirement) => {
      item.textContent = text(
        requirement?.description ?? requirement?.reason,
        words(requirement?.id ?? requirement?.kind ?? "Requirement"),
      );
    }));
  }

  const buttons = createElement("div", "family-browser__actions");
  if (memberStatus(member) === "executable" && typeof actions.onOpenRuntime === "function") {
    const runtime = createButton("family-browser__action family-browser__action--primary", "Open in Runtime");
    runtime.addEventListener("click", () => actions.openRuntime(family, member));
    buttons.append(runtime);
  }
  const atlas = createElement("a", "family-browser__action", "Read the full Atlas family");
  atlas.href = createEditorialUrl(actions.editorialBaseUrl, family.id);
  buttons.append(atlas);
  section.append(buttons);
  parent.append(section);
}

function renderRoles(parent, family) {
  const section = createElement("section", "family-browser__section");
  appendText(section, "h3", "family-browser__section-title", "Data contract");
  appendText(section, "p", "family-browser__record-bounds", recordBounds(family));
  const roleGrid = createElement("div", "family-browser__role-groups");
  roleGroups(family).forEach((group) => {
    const roleGroup = createElement("section", "family-browser__role-group");
    appendText(roleGroup, "h4", "family-browser__subheading", group.label);
    if (group.roles.length === 0) {
      appendText(roleGroup, "p", "family-browser__empty-note", `No ${group.id} roles.`);
    } else {
      roleGroup.append(createList(group.roles, "family-browser__role-list", (item, role) => {
        appendText(item, "strong", "family-browser__role-name", words(role?.id));
        appendText(item, "span", "family-browser__role-types", values(role?.types).join(" · "));
        appendText(item, "p", "family-browser__role-description", text(role?.description));
      }));
    }
    roleGrid.append(roleGroup);
  });
  section.append(roleGrid);
  parent.append(section);
}

function renderGrammar(parent, family) {
  const grammar = family?.grammar ?? {};
  const section = createElement("section", "family-browser__section");
  appendText(section, "h3", "family-browser__section-title", "Fixed grammar");
  const summary = createElement("dl", "family-browser__facts family-browser__facts--compact");
  [["Mark", grammar.mark], ["Layout", grammar.layout]].forEach(([label, value]) => {
    appendText(summary, "dt", "family-browser__fact-label", label);
    appendText(summary, "dd", "family-browser__fact-value", text(value, "Not declared"));
  });
  section.append(summary);
  [
    ["Encodings", values(grammar.encodings)],
    ["Invariants", values(grammar.invariants)],
  ].forEach(([label, items]) => {
    appendText(section, "h4", "family-browser__subheading", label);
    if (items.length > 0) {
      section.append(createList(items, "family-browser__plain-list", (item, value) => {
        item.textContent = text(value);
      }));
    } else {
      appendText(section, "p", "family-browser__empty-note", `No ${label.toLocaleLowerCase()} are declared.`);
    }
  });
  parent.append(section);
}

function renderRules(parent, family) {
  const validationRules = values(family?.validationRules ?? family?.validation?.rules);
  const evidenceRequirements = values(family?.evidenceRequirements ?? family?.evidence?.requirements);
  const section = createElement("section", "family-browser__section");
  appendText(section, "h3", "family-browser__section-title", "Validation and evidence");
  [
    ["Validation", validationRules],
    ["Evidence", evidenceRequirements],
  ].forEach(([label, rules]) => {
    appendText(section, "h4", "family-browser__subheading", label);
    if (rules.length > 0) {
      section.append(createList(rules, "family-browser__plain-list", (item, rule) => {
        item.textContent = text(rule);
      }));
    } else {
      appendText(section, "p", "family-browser__empty-note", `No ${label.toLocaleLowerCase()} rules are declared.`);
    }
  });
  parent.append(section);
}

function renderMediaMatrix(parent, family) {
  const section = createElement("section", "family-browser__section");
  appendText(section, "h3", "family-browser__section-title", "Production input media");
  const scroller = createElement("div", "family-browser__table-scroll");
  const table = createElement("table", "family-browser__media-table");
  const caption = createElement("caption", "family-browser__sr-only", `Input media decisions for ${family.title}`);
  const head = createElement("thead");
  const headRow = createElement("tr");
  ["Input", "Decision", "Why"].forEach((heading) => appendText(headRow, "th", "", heading).scope = "col");
  head.append(headRow);
  const body = createElement("tbody");
  values(family.mediaAdapters).forEach((adapter) => {
    const row = createElement("tr");
    row.dataset.decision = text(adapter?.decision);
    appendText(row, "th", "family-browser__media-name", words(adapter?.medium)).scope = "row";
    appendText(row, "td", "family-browser__media-decision", DECISION_LABELS[adapter?.decision] ?? words(adapter?.decision));
    appendText(row, "td", "family-browser__media-reason", text(adapter?.reason, "No reason recorded."));
    body.append(row);
  });
  table.append(caption, head, body);
  scroller.append(table);
  section.append(scroller);
  parent.append(section);
}

function renderAbstention(parent, family) {
  const abstention = family?.abstention ?? family?.abstain;
  if (!abstention) return;
  const section = createElement("section", "family-browser__section family-browser__abstention");
  appendText(section, "p", "family-browser__eyebrow", "When this family should abstain");
  appendText(section, "h3", "family-browser__section-title", text(abstention.question, "When should this family abstain?"));
  appendText(section, "p", "family-browser__abstention-reason", text(abstention.why));
  const instead = createElement("p", "family-browser__instead");
  appendText(instead, "strong", "", "Use instead: ");
  instead.append(document.createTextNode
    ? document.createTextNode(text(abstention.instead, "Show the source evidence directly."))
    : createElement("span", "", text(abstention.instead, "Show the source evidence directly.")));
  section.append(instead);
  parent.append(section);
}

function memberCounts(family) {
  return Object.fromEntries(RELEASE_STATUSES.map((status) => [
    status,
    familyMembers(family).filter((member) => memberStatus(member) === status).length,
  ]));
}

function groupLabel(catalog, groupId) {
  return familyGroups(catalog).find((group) => group.id === groupId)?.label ?? words(groupId);
}

/**
 * Mount the complete repertoire browser. The module owns route state, history,
 * catalog filtering, DOM rendering, and cleanup. The caller only supplies the
 * host element and the two navigation boundaries.
 */
export function mountFamilyBrowser({ root, onOpenRuntime, editorialBaseUrl } = {}) {
  if (!root || typeof root.replaceChildren !== "function") {
    throw new TypeError("family browser root must support replaceChildren()");
  }

  const catalog = FAMILY_BROWSER_CATALOG;
  let state = parseFamilyBrowserState(globalThis.location?.search ?? "", catalog);
  let destroyed = false;

  const shell = createElement("section", "family-browser");
  shell.dataset.catalogVersion = text(catalog?.catalogVersion);
  shell.setAttribute("aria-labelledby", "family-browser-heading");

  const header = createElement("header", "family-browser__header");
  appendText(header, "p", "family-browser__eyebrow", "Attend repertoire");
  const heading = appendText(header, "h1", "family-browser__heading", "Explore visualization families");
  heading.id = "family-browser-heading";
  appendText(
    header,
    "p",
    "family-browser__intro",
    "Browse every authored form, see what this release can run, and inspect the rules that keep each family honest.",
  );

  const ledger = createElement("div", "family-browser__ledger");
  ledger.setAttribute("aria-label", "Release catalog status");
  const statusButtons = new Map();
  RELEASE_STATUSES.forEach((status) => {
    const presentation = STATUS_PRESENTATION[status];
    const button = createButton(`family-browser__ledger-item family-browser__ledger-item--${status}`, "");
    button.dataset.status = status;
    button.setAttribute("aria-controls", "family-browser-results");
    appendText(button, "strong", "family-browser__ledger-count", statusCount(catalog, status));
    appendText(button, "span", "family-browser__ledger-label", presentation.label);
    statusButtons.set(status, button);
    ledger.append(button);
  });
  header.append(ledger);

  const controls = createElement("section", "family-browser__controls");
  controls.setAttribute("aria-label", "Browse filters");

  const searchLabel = createElement("label", "family-browser__search-label");
  searchLabel.htmlFor = "family-browser-search";
  searchLabel.textContent = "Search families and forms";
  const search = createElement("input", "family-browser__search");
  search.id = "family-browser-search";
  search.type = "search";
  search.placeholder = "Try flow, time, text, or comparison";
  search.autocomplete = "off";
  search.setAttribute("aria-controls", "family-browser-results");
  searchLabel.append(search);
  controls.append(searchLabel);

  const groupFieldset = createElement("fieldset", "family-browser__filter family-browser__filter--groups");
  groupFieldset.id = "family-browser-group-filter";
  appendText(groupFieldset, "legend", "family-browser__filter-label", "Groups");
  const groupInputs = new Map();
  familyGroups(catalog).forEach((group) => {
    const label = createElement("label", "family-browser__check");
    const input = createElement("input");
    input.type = "checkbox";
    input.value = group.id;
    input.setAttribute("aria-controls", "family-browser-results");
    label.append(input, createElement("span", "", group.label));
    groupInputs.set(group.id, input);
    groupFieldset.append(label);
  });
  controls.append(groupFieldset);

  const mediumLabel = createElement("label", "family-browser__filter family-browser__filter--medium");
  mediumLabel.htmlFor = "family-browser-medium";
  appendText(mediumLabel, "span", "family-browser__filter-label", "Works with input");
  const mediumSelect = createElement("select", "family-browser__medium");
  mediumSelect.id = "family-browser-medium";
  mediumSelect.setAttribute("aria-controls", "family-browser-results");
  const everyMedium = createElement("option", "", "Any input medium");
  everyMedium.value = "";
  mediumSelect.append(everyMedium);
  catalogMedia(catalog).forEach((medium) => {
    const option = createElement("option", "", words(medium));
    option.value = medium;
    mediumSelect.append(option);
  });
  mediumLabel.append(mediumSelect);
  controls.append(mediumLabel);

  const clearFilters = createButton("family-browser__clear", "Clear filters");
  controls.append(clearFilters);

  const lensNavigation = createElement("nav", "family-browser__lenses");
  lensNavigation.id = "family-browser-lenses";
  lensNavigation.setAttribute("aria-label", "Repertoire view");
  const lensButtons = new Map();
  LENSES.forEach((lens) => {
    const button = createButton("family-browser__lens", LENS_LABELS[lens]);
    button.dataset.lens = lens;
    button.setAttribute("aria-controls", "family-browser-results");
    lensButtons.set(lens, button);
    lensNavigation.append(button);
  });

  const body = createElement("div", "family-browser__body");
  const resultsColumn = createElement("section", "family-browser__results-column");
  const resultSummary = createElement("p", "family-browser__result-summary");
  resultSummary.id = "family-browser-result-summary";
  resultSummary.setAttribute("aria-live", "polite");
  resultSummary.setAttribute("aria-atomic", "true");
  const results = createElement("div", "family-browser__results");
  results.id = "family-browser-results";
  results.setAttribute("aria-labelledby", "family-browser-result-summary");
  resultsColumn.append(resultSummary, results);

  const dossier = createElement("aside", "family-browser__dossier");
  dossier.id = "family-browser-dossier";
  dossier.tabIndex = -1;
  dossier.setAttribute("aria-label", "Selected family details");
  body.append(resultsColumn, dossier);

  const live = createElement("p", "family-browser__sr-only");
  live.id = "family-browser-live";
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");

  shell.append(header, controls, lensNavigation, body, live);
  root.replaceChildren(shell);

  function currentUrl(searchValue) {
    if (!globalThis.location?.href) return null;
    const url = new URL(globalThis.location.href);
    url.search = searchValue;
    return url;
  }

  function writeHistory(mode) {
    const serialized = serializeFamilyBrowserState(state);
    const url = currentUrl(serialized);
    if (!url || !globalThis.history) return;
    if (mode === "push" && typeof globalThis.history.pushState === "function") {
      globalThis.history.pushState({ attendFamilyBrowser: true }, "", url);
    } else if (typeof globalThis.history.replaceState === "function") {
      globalThis.history.replaceState({ attendFamilyBrowser: true }, "", url);
    }
  }

  function updateState(patch, historyMode = "push") {
    state = { ...state, ...patch };
    writeHistory(historyMode);
    render();
  }

  function selectFamily(family, member = null) {
    updateState({
      familyId: family.id,
      memberId: member?.id ?? null,
    });
    dossier.focus?.();
    live.textContent = member
      ? `${text(member.name, words(member.id))} details opened in the family dossier.`
      : `${text(family.title, words(family.id))} family dossier opened.`;
  }

  function openRuntime(family, member) {
    if (memberStatus(member) !== "executable" || typeof onOpenRuntime !== "function") return;
    try {
      const result = onOpenRuntime({ familyId: family.id, memberId: member.id });
      if (result && typeof result.then === "function") {
        result.catch((error) => {
          live.textContent = error instanceof Error ? error.message : "Runtime could not be opened.";
        });
      }
    } catch (error) {
      live.textContent = error instanceof Error ? error.message : "Runtime could not be opened.";
    }
  }

  const actions = { editorialBaseUrl, onOpenRuntime, openRuntime };

  function renderFamilyCard(container, family, matches) {
    const card = createElement("article", "family-browser__family-card");
    card.dataset.familyId = family.id;
    if (state.familyId === family.id) card.classList?.add("is-selected");
    const top = createElement("div", "family-browser__family-card-top");
    appendText(top, "p", "family-browser__eyebrow", groupLabel(catalog, family.group));
    const title = createButton("family-browser__family-name", text(family.title, words(family.id)));
    title.setAttribute("aria-current", state.familyId === family.id ? "true" : "false");
    title.addEventListener("click", () => selectFamily(family));
    top.append(title);
    card.append(top);
    appendText(card, "p", "family-browser__family-question", text(family.question));
    appendText(card, "p", "family-browser__family-summary", text(family.oneLine ?? family.summary));

    const counts = memberCounts(family);
    const countList = createElement("ul", "family-browser__family-counts");
    RELEASE_STATUSES.forEach((status) => {
      if (counts[status] === 0) return;
      const item = createElement("li", `family-browser__family-count family-browser__family-count--${status}`);
      item.textContent = `${counts[status]} ${STATUS_PRESENTATION[status].label.toLocaleLowerCase()}`;
      countList.append(item);
    });
    card.append(countList);
    appendText(card, "p", "family-browser__matching-count", `${matches.length} matching ${matches.length === 1 ? "form" : "forms"}`);
    container.append(card);
  }

  function renderFamilies(matches) {
    const byFamily = new Map();
    matches.forEach((match) => {
      const list = byFamily.get(match.family.id) ?? [];
      list.push(match.member);
      byFamily.set(match.family.id, list);
    });
    const fragment = document.createDocumentFragment?.() ?? createElement("div");
    familyGroups(catalog).forEach((group) => {
      const groupFamilies = catalogFamilies(catalog)
        .filter((family) => family.group === group.id && byFamily.has(family.id));
      if (groupFamilies.length === 0) return;
      const section = createElement("section", "family-browser__family-group");
      section.dataset.groupId = group.id;
      appendText(section, "h2", "family-browser__group-title", group.label);
      const grid = createElement("div", "family-browser__family-grid");
      groupFamilies.forEach((family) => renderFamilyCard(grid, family, byFamily.get(family.id)));
      section.append(grid);
      fragment.append(section);
    });
    results.replaceChildren(fragment);
  }

  function renderForms(matches) {
    const list = createElement("ol", "family-browser__member-grid");
    matches.forEach(({ family, member }) => {
      const item = createElement("li", "family-browser__member-card");
      item.dataset.familyId = family.id;
      item.dataset.memberId = member.id;
      item.dataset.status = memberStatus(member);
      if (state.familyId === family.id && state.memberId === member.id) item.classList?.add("is-selected");
      const headingRow = createElement("div", "family-browser__member-heading");
      const copy = createElement("div");
      appendText(copy, "p", "family-browser__eyebrow", `${text(family.title, words(family.id))} · ${words(memberBand(member))}`);
      const name = createButton("family-browser__member-name", text(member.name, words(member.id)));
      name.setAttribute(
        "aria-label",
        `${text(member.name, words(member.id))}, ${STATUS_PRESENTATION[memberStatus(member)].label}, ${text(family.title, words(family.id))}`,
      );
      name.setAttribute("aria-current", state.familyId === family.id && state.memberId === member.id ? "true" : "false");
      name.addEventListener("click", () => selectFamily(family, member));
      copy.append(name);
      headingRow.append(copy);
      renderStatus(headingRow, memberStatus(member));
      item.append(headingRow);
      appendText(item, "p", "family-browser__member-when", text(member.when));
      appendText(item, "p", "family-browser__member-rationale", text(member.rationale));
      appendText(item, "p", "family-browser__status-copy", statusExplanation(member));
      const footer = createElement("div", "family-browser__member-footer");
      appendText(footer, "span", "family-browser__member-band", text(member.band, "No quantity band recorded"));
      if (memberStatus(member) === "executable" && typeof onOpenRuntime === "function") {
        const runtime = createButton("family-browser__runtime-link", "Open Runtime");
        runtime.addEventListener("click", () => openRuntime(family, member));
        footer.append(runtime);
      }
      item.append(footer);
      list.append(item);
    });
    results.replaceChildren(list);
  }

  function renderConstraintFamilies(matches) {
    const matchedFamilyIds = new Set(matches.map((match) => match.family.id));
    const list = createElement("ul", "family-browser__constraint-family-list");
    catalogFamilies(catalog).forEach((family) => {
      if (!matchedFamilyIds.has(family.id)) return;
      const item = createElement("li");
      const button = createButton("family-browser__constraint-family", text(family.title, words(family.id)));
      button.dataset.familyId = family.id;
      button.setAttribute("aria-current", state.familyId === family.id ? "true" : "false");
      button.addEventListener("click", () => selectFamily(family));
      item.append(button);
      list.append(item);
    });
    results.replaceChildren(list);
  }

  function renderDossier() {
    dossier.replaceChildren();
    const family = familyById(catalog, state.familyId);
    dossier.dataset.dossierState = family ? "populated" : "empty";
    dossier.dataset.familyId = family?.id ?? "";
    if (!family) {
      const empty = createElement("div", "family-browser__dossier-empty");
      appendText(empty, "p", "family-browser__eyebrow", "Family dossier");
      appendText(empty, "h2", "family-browser__dossier-title", "Choose a family");
      appendText(empty, "p", "family-browser__empty-note", "Its roles, readable bounds, grammar, media decisions, and abstention rules will stay here while you browse.");
      dossier.append(empty);
      return;
    }

    const header = createElement("header", "family-browser__dossier-header");
    appendText(header, "p", "family-browser__eyebrow", groupLabel(catalog, family.group));
    appendText(header, "h2", "family-browser__dossier-title", text(family.title, words(family.id)));
    appendText(header, "p", "family-browser__dossier-question", text(family.question));
    appendText(header, "p", "family-browser__dossier-summary", text(family.summary ?? family.oneLine));
    const atlas = createElement("a", "family-browser__atlas-link", "Read the long-form Atlas entry");
    atlas.href = createEditorialUrl(editorialBaseUrl, family.id);
    header.append(atlas);
    dossier.append(header);

    const selectedMember = familyMembers(family).find((member) => member.id === state.memberId) ?? null;
    if (selectedMember) renderMemberDetail(dossier, family, selectedMember, actions);
    renderRoles(dossier, family);
    renderGrammar(dossier, family);
    renderRules(dossier, family);
    renderMediaMatrix(dossier, family);
    renderAbstention(dossier, family);
  }

  function render() {
    if (destroyed) return;
    const matches = filterFamilyBrowserMembers(catalog, state);
    search.value = state.query;
    mediumSelect.value = state.medium ?? "";
    statusButtons.forEach((button, status) => {
      const selected = state.statuses.includes(status);
      button.setAttribute("aria-pressed", String(selected));
      button.classList?.toggle("is-active", selected);
    });
    groupInputs.forEach((input, groupId) => {
      input.checked = state.groupIds.includes(groupId);
    });
    lensButtons.forEach((button, lens) => {
      const selected = state.lens === lens;
      button.setAttribute("aria-pressed", String(selected));
      button.classList?.toggle("is-active", selected);
    });

    resultSummary.textContent = `${matches.length} of ${allMemberCount(catalog)} authored forms match`;
    if (matches.length === 0) {
      const empty = createElement("section", "family-browser__no-results");
      appendText(empty, "h2", "family-browser__no-results-title", "No forms match these filters");
      appendText(empty, "p", "family-browser__empty-note", "Clear a status, group, medium, or search filter to reopen the repertoire.");
      results.replaceChildren(empty);
    } else if (state.lens === "forms") {
      renderForms(matches);
    } else if (state.lens === "constraints") {
      renderConstraintFamilies(matches);
    } else {
      renderFamilies(matches);
    }
    renderDossier();
  }

  statusButtons.forEach((button, status) => {
    button.addEventListener("click", () => {
      const statuses = new Set(state.statuses);
      if (statuses.has(status)) statuses.delete(status);
      else statuses.add(status);
      updateState({ statuses: orderedStatuses([...statuses]) });
    });
  });
  search.addEventListener("input", () => updateState({ query: normalizedQuery(search.value) }, "replace"));
  groupInputs.forEach((input, groupId) => {
    input.addEventListener("change", () => {
      const groups = new Set(state.groupIds);
      if (input.checked) groups.add(groupId);
      else groups.delete(groupId);
      updateState({ groupIds: [...groups].sort((left, right) => left.localeCompare(right)) });
    });
  });
  mediumSelect.addEventListener("change", () => updateState({ medium: text(mediumSelect.value) || null }));
  clearFilters.addEventListener("click", () => updateState({
    query: "",
    statuses: [...RELEASE_STATUSES],
    groupIds: [],
    medium: null,
  }));
  lensButtons.forEach((button, lens) => {
    button.addEventListener("click", () => {
      let familyId = state.familyId;
      if (lens === "constraints" && !familyId) familyId = catalogFamilies(catalog)[0]?.id ?? null;
      updateState({ lens, familyId });
    });
  });

  const onPopState = () => {
    state = parseFamilyBrowserState(globalThis.location?.search ?? "", catalog);
    render();
  };
  globalThis.addEventListener?.("popstate", onPopState);

  const canonical = serializeFamilyBrowserState(state);
  if (globalThis.location && canonical !== globalThis.location.search) writeHistory("replace");
  render();

  return Object.freeze({
    destroy() {
      if (destroyed) return;
      destroyed = true;
      globalThis.removeEventListener?.("popstate", onPopState);
      root.replaceChildren();
    },
    getState() {
      return {
        ...state,
        statuses: [...state.statuses],
        groupIds: [...state.groupIds],
      };
    },
  });
}
