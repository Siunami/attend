import SAMPLE_SOURCES from "./family-datasets.js";
import { renderFamily, RENDERER_IDS } from "./family-renderers.js";
import { toCompilerRequest } from "./family-compiler-adapter.js";
import {
  CANONICAL_INPUT_MEDIA,
  MAP_FAMILIES,
  MAP_FAMILY_GROUPS,
  multiplesPolicy,
} from "./core/map-families/registry.js";
import { compileMap } from "./core/pipeline/compile.js";

const FALLBACK_MEDIA = ["structured", "text", "image", "video", "audio", "document", "geography", "mixed"];
const FAMILY_ORDER = Object.keys(SAMPLE_SOURCES);
const manifests = Array.isArray(MAP_FAMILIES) ? MAP_FAMILIES : Object.values(MAP_FAMILIES);
const manifestById = new Map(manifests.map((manifest) => [manifest.id, manifest]));

const elements = {
  contract: document.getElementById("family-contract"),
  description: document.getElementById("family-description"),
  evidence: document.getElementById("pipeline-evidence"),
  family: document.getElementById("pipeline-family"),
  familySelect: document.getElementById("family-select"),
  fallback: document.getElementById("visual-fallback"),
  gallery: document.getElementById("gallery-view"),
  kicker: document.getElementById("family-kicker"),
  markSelect: document.getElementById("mark-select"),
  marks: document.getElementById("pipeline-marks"),
  media: document.getElementById("media-view"),
  mediaDecision: document.getElementById("media-decision"),
  mediaLayout: document.getElementById("media-layout"),
  mediaNote: document.getElementById("media-note"),
  mediaSelect: document.getElementById("media-select"),
  mediaVisual: document.getElementById("media-visual"),
  navigation: document.getElementById("family-navigation"),
  packagePreview: document.getElementById("package-preview"),
  pipeline: document.getElementById("pipeline-view"),
  pipelineHash: document.getElementById("pipeline-hash"),
  pipelineVisual: document.getElementById("pipeline-visual"),
  quantitySelect: document.getElementById("quantity-select"),
  question: document.getElementById("family-question"),
  selection: document.getElementById("selection-summary"),
  status: document.getElementById("family-status"),
  title: document.getElementById("family-title"),
  visual: document.getElementById("family-visual"),
};

const state = {
  familyId: FAMILY_ORDER[0],
  galleryRenderRevision: 0,
  mediaRenderRevision: 0,
  mode: "gallery",
  selectedId: null,
};

function words(value) {
  return String(value ?? "")
    .replace(/[-_]/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value) return [value];
  return [];
}

function field(dataset, roleName, fallback) {
  return dataset.roles?.[roleName] ?? fallback;
}

function recordId(dataset, record) {
  return String(record?.[field(dataset, "id", "id")] ?? record?.id ?? "");
}

function recordLabel(dataset, record) {
  const labelField = field(dataset, "label", "label");
  return String(record?.[labelField] ?? record?.label ?? record?.id ?? "Untitled mark");
}

function groupLabel(manifest) {
  return words(manifest?.group ?? manifest?.groupId ?? "Family");
}

function maturity(manifest) {
  const value = manifest?.maturity;
  if (typeof value === "string") return words(value);
  if (value?.renderer) return words(value.renderer);
  return "Prototype";
}

function familyDescription(manifest) {
  return manifest?.summary ?? manifest?.description ?? manifest?.purpose ?? list(manifest?.questions?.answersWell ?? manifest?.answersWell)[0] ?? "A bounded, evidence-bearing map family.";
}

function familyVariants(manifest) {
  return list(manifest?.variants).map((variant) => typeof variant === "string" ? variant : variant.label ?? variant.id).filter(Boolean);
}

function makeOption(value, text) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = text;
  return option;
}

function familyGroups() {
  const declared = Array.isArray(MAP_FAMILY_GROUPS) ? MAP_FAMILY_GROUPS : [];
  const declaredIds = declared.map((group) => typeof group === "string" ? group : group.id);
  const inferred = [...new Set(FAMILY_ORDER.map((familyId) => manifestById.get(familyId)?.group ?? manifestById.get(familyId)?.groupId ?? "other"))];
  const ids = declaredIds.length ? declaredIds : inferred;
  return ids.map((id) => {
    const definition = declared.find((group) => (typeof group === "string" ? group : group.id) === id);
    return {
      id,
      label: typeof definition === "object" ? definition.label ?? definition.title ?? words(id) : words(id),
      familyIds: FAMILY_ORDER.filter((familyId) => {
        const manifest = manifestById.get(familyId);
        return (manifest?.group ?? manifest?.groupId ?? "other") === id;
      }),
    };
  }).filter((group) => group.familyIds.length);
}

function renderNavigation() {
  const groups = familyGroups();
  const sections = groups.map((group) => {
    const section = document.createElement("section");
    section.className = "family-nav-group";
    const heading = document.createElement("h2");
    heading.textContent = group.label;
    const listElement = document.createElement("ul");
    listElement.className = "family-nav-list";
    group.familyIds.forEach((familyId) => {
      const manifest = manifestById.get(familyId);
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `family-nav-button${familyId === state.familyId ? " is-active" : ""}`;
      button.dataset.familyId = familyId;
      button.textContent = manifest?.shortTitle ?? manifest?.title ?? words(familyId);
      button.setAttribute("aria-pressed", String(familyId === state.familyId));
      item.append(button);
      listElement.append(item);
    });
    section.append(heading, listElement);
    return section;
  });
  elements.navigation.replaceChildren(...sections);

  elements.familySelect.replaceChildren(...FAMILY_ORDER.map((familyId) => {
    const manifest = manifestById.get(familyId);
    return makeOption(familyId, manifest?.title ?? words(familyId));
  }));
  elements.familySelect.value = state.familyId;
}

function updateNavigationState() {
  elements.navigation.querySelectorAll("[data-family-id]").forEach((button) => {
    const active = button.dataset.familyId === state.familyId;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  elements.familySelect.value = state.familyId;
}

function contractSection(title, content) {
  const section = document.createElement("section");
  section.className = "contract-section";
  const heading = document.createElement("h2");
  heading.textContent = title;
  section.append(heading);
  if (Array.isArray(content)) {
    const listElement = document.createElement("ul");
    content.forEach((item) => {
      const row = document.createElement("li");
      row.textContent = String(item);
      listElement.append(row);
    });
    section.append(listElement);
  } else {
    const paragraph = document.createElement("p");
    paragraph.textContent = String(content || "Not declared");
    section.append(paragraph);
  }
  return section;
}

function mediaRows(manifest) {
  const media = Array.isArray(CANONICAL_INPUT_MEDIA) && CANONICAL_INPUT_MEDIA.length
    ? CANONICAL_INPUT_MEDIA
    : FALLBACK_MEDIA;
  return media.map((mediaType) => {
    const adapters = manifest?.mediaAdapters;
    const adapter = Array.isArray(adapters)
      ? adapters.find((candidate) => candidate.medium === mediaType) ?? {}
      : adapters?.[mediaType] ?? {};
    return {
      mediaType,
      mode: adapter.decision ?? adapter.mode ?? adapter.status ?? "abstain",
      preview: adapter.previewTreatment ?? adapter.preview ?? adapter.minimumReadableUnit ?? adapter.readableUnit ?? adapter.reason ?? "Not declared",
      extracts: list(adapter.fieldsExtracted ?? adapter.extracts ?? adapter.roles ?? adapter.fields).join(", ") || adapter.reason || "—",
    };
  });
}

function renderContract(manifest) {
  const transform = manifest?.transformation ?? manifest?.deterministicTransform;
  const transformation = typeof transform === "string"
    ? transform
    : [transform?.id, transform?.version].filter(Boolean).join(" · ");
  const table = document.createElement("table");
  table.className = "media-matrix";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  ["Input medium", "Decision", "Extraction and readable treatment"].forEach((text) => {
    const header = document.createElement("th");
    header.scope = "col";
    header.textContent = text;
    headRow.append(header);
  });
  head.append(headRow);
  const body = document.createElement("tbody");
  mediaRows(manifest).forEach((row) => {
    const tableRow = document.createElement("tr");
    const medium = document.createElement("td");
    medium.textContent = words(row.mediaType);
    const mode = document.createElement("td");
    mode.className = "media-mode";
    mode.textContent = words(row.mode);
    const treatment = document.createElement("td");
    treatment.textContent = `${row.extracts}${row.preview && row.preview !== row.extracts ? ` · ${typeof row.preview === "string" ? row.preview : JSON.stringify(row.preview)}` : ""}`;
    tableRow.append(medium, mode, treatment);
    body.append(tableRow);
  });
  table.append(head, body);

  elements.contract.replaceChildren(
    contractSection("Answers well", list(manifest?.questions?.answersWell ?? manifest?.answersWell)),
    contractSection("Abstains when", list(manifest?.questions?.abstainsWhen ?? manifest?.abstainsWhen)),
    contractSection("Bounded variants", familyVariants(manifest)),
    contractSection("Deterministic seam", transformation || manifest?.transform?.id || "Family-specific deterministic transform"),
    table,
  );
}

function evidenceForRecord(dataset, record) {
  const refs = list(record?.[field(dataset, "evidence", "evidenceRefs")]);
  return refs.map((reference) => dataset.evidence.find((item) => item.id === reference)).filter(Boolean);
}

function inspectableItems(dataset) {
  return [
    ...dataset.records.map((item) => ({ kind: "mark", item })),
    ...list(dataset.links).map((item) => ({ kind: "relationship", item })),
  ];
}

function inspectableLabel(dataset, entry) {
  if (entry.kind === "mark") return recordLabel(dataset, entry.item);
  const source = dataset.records.find((record) => recordId(dataset, record) === String(entry.item.source));
  const target = dataset.records.find((record) => recordId(dataset, record) === String(entry.item.target));
  const relation = entry.item.type ?? entry.item.relation ?? "connects";
  return `${source ? recordLabel(dataset, source) : entry.item.source} —${relation}→ ${target ? recordLabel(dataset, target) : entry.item.target}`;
}

function locatorLabel(locator) {
  if (!locator) return "source locator";
  if (locator.kind === "text-range") return `${locator.path}:${locator.startLine}–${locator.endLine}`;
  if (locator.kind === "row") return `${locator.path}, row ${locator.row}`;
  if (locator.kind === "time-range") return `${locator.path}, ${locator.startSeconds}–${locator.endSeconds}s`;
  if (locator.kind === "page-region") return `${locator.path}, page ${locator.page}`;
  if (locator.kind === "normalized-region") return `${locator.path}, image region`;
  if (locator.kind === "coordinate-feature") return `${locator.path}, ${locator.featureId}`;
  if (locator.kind === "feature") return `${locator.path}, ${locator.featureId}`;
  return locator.path ?? locator.kind;
}

function updateMarkSelect(dataset) {
  const placeholder = makeOption("", "Choose a mark…");
  const marks = document.createElement("optgroup");
  marks.label = "Marks";
  marks.append(...dataset.records.map((record) => makeOption(recordId(dataset, record), recordLabel(dataset, record))));
  const options = [placeholder, marks];
  if (list(dataset.links).length) {
    const relationships = document.createElement("optgroup");
    relationships.label = "Relationships";
    relationships.append(...dataset.links.map((link) => makeOption(String(link.id), inspectableLabel(dataset, { kind: "relationship", item: link }))));
    options.push(relationships);
  }
  elements.markSelect.replaceChildren(...options);
  elements.markSelect.value = state.selectedId ?? "";
}

function updateSelection(dataset) {
  const entry = inspectableItems(dataset).find((candidate) => recordId(dataset, candidate.item) === state.selectedId);
  if (!entry) {
    elements.selection.textContent = "Choose a mark to inspect its evidence.";
    return;
  }
  const record = entry.item;
  const evidence = evidenceForRecord(dataset, record);
  const first = evidence[0];
  const detailField = field(dataset, "detail", null);
  const detail = entry.kind === "mark" && detailField ? record[detailField] : null;
  elements.selection.textContent = [
    inspectableLabel(dataset, entry),
    detail,
    first?.excerpt,
    first ? locatorLabel(first.locator) : null,
    evidence.length > 1 ? `${evidence.length} evidence anchors` : null,
  ].filter(Boolean).join(" · ");
}

function fallbackSummary(dataset) {
  const labels = dataset.records.slice(0, 8).map((record) => recordLabel(dataset, record));
  const relationshipCount = list(dataset.links).length;
  return `${dataset.question} The view contains ${dataset.records.length} primary marks${relationshipCount ? ` and ${relationshipCount} evidence-bearing relationships` : ""}: ${labels.join(", ")}${dataset.records.length > labels.length ? ", and more" : ""}.`;
}

async function renderGallery() {
  const revision = ++state.galleryRenderRevision;
  const dataset = SAMPLE_SOURCES[state.familyId];
  const manifest = manifestById.get(state.familyId) ?? { id: state.familyId, title: words(state.familyId) };
  elements.kicker.textContent = `${groupLabel(manifest)} family · ${dataset.mediaType} sample`;
  elements.title.textContent = manifest.title ?? words(state.familyId);
  elements.question.textContent = dataset.question;
  elements.description.textContent = familyDescription(manifest);
  elements.status.textContent = maturity(manifest);
  elements.fallback.textContent = fallbackSummary(dataset);
  renderContract(manifest);
  updateMarkSelect(dataset);
  updateSelection(dataset);
  elements.visual.setAttribute("aria-busy", "true");
  const stagingRoot = document.createElement("div");
  try {
    await renderFamily({ root: stagingRoot, dataset, selectedId: state.selectedId });
    if (revision === state.galleryRenderRevision) elements.visual.replaceChildren(...stagingRoot.childNodes);
  } catch (error) {
    if (revision === state.galleryRenderRevision) {
      const notice = document.createElement("p");
      notice.className = "render-error";
      notice.textContent = error instanceof Error ? `This specimen could not render: ${error.message}` : "This specimen could not render.";
      elements.visual.replaceChildren(notice);
    }
  } finally {
    if (revision === state.galleryRenderRevision) elements.visual.setAttribute("aria-busy", "false");
  }
}

const PIPELINE_STAGES = [
  ["Scope", "Adapter records explicit inputs and known omissions."],
  ["Normalize", "Deterministic parsing creates stable source records."],
  ["Transform", "The family derives only its declared semantic roles."],
  ["Enrich", "Optional model fields remain bounded and receipted."],
  ["Validate", "Schema, evidence, identity, and consistency fail closed."],
  ["Package", "Family, renderer, hashes, and provenance are versioned."],
  ["Render", "One fixed grammar exposes marks and exact evidence."],
];

function renderPipelineStages() {
  elements.pipelineVisual.replaceChildren(...PIPELINE_STAGES.map(([title, description], index) => {
    const stage = document.createElement("section");
    stage.className = "pipeline-stage";
    const number = document.createElement("span");
    number.className = "pipeline-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const heading = document.createElement("strong");
    heading.textContent = title;
    const paragraph = document.createElement("p");
    paragraph.textContent = description;
    stage.append(number, heading, paragraph);
    return stage;
  }));
}

async function renderPipelineReceipt() {
  const dataset = SAMPLE_SOURCES[state.familyId];
  const manifest = manifestById.get(state.familyId);
  const requestedFamilyId = state.familyId;
  const request = await toCompilerRequest(dataset, manifest, {
    availableWidth: Math.max(elements.pipeline.clientWidth || 0, 320),
  });
  const packageValue = await compileMap(request);
  if (state.familyId !== requestedFamilyId) return;
  const evidenceReferences = packageValue.quality.coverage.evidenceRefCount;
  elements.family.textContent = manifest?.title ?? words(state.familyId);
  elements.marks.textContent = String(packageValue.marks.length);
  elements.evidence.textContent = String(evidenceReferences);
  elements.pipelineHash.textContent = packageValue.hashes.package.slice(0, 12);
  const collection = manifest.transformation.payload.collection;
  const excerpt = {
    ...packageValue,
    marks: packageValue.marks.slice(0, 2),
    payload: {
      ...packageValue.payload,
      [collection]: `[${packageValue.payload[collection].length} validated ${collection}]`,
    },
  };
  elements.packagePreview.textContent = JSON.stringify(excerpt, null, 2);
}

function safeRepeatPolicy(mediaType, count, availableWidth) {
  try {
    return multiplesPolicy({ mediaType, count, availableWidth });
  } catch {
    try {
      return multiplesPolicy(mediaType, count, availableWidth);
    } catch {
      return { availableWidth, columns: 1, decision: count > 36 ? "aggregate" : "repeat", layout: "media-specific", reason: "Use the medium's minimum readable unit." };
    }
  }
}

const MEDIA_DETAILS = Object.freeze({
  structured: {
    label: "Structured / numeric",
    note: "Shared scales allow numeric panels to compress from full plots to mini-charts and then sparklines. Past that point, aggregate before individual marks become indistinguishable.",
  },
  text: {
    label: "Text",
    note: "Text stays at reading size in a vertical column. Larger collections become an index plus selected passage; the policy never creates postage-stamp paragraphs.",
  },
  image: {
    label: "Image",
    note: "Images keep their aspect ratio and enough area to recognize the feature being compared. Dense quilts remain overviews and always lead to full-resolution detail.",
  },
  video: {
    label: "Video",
    note: "Video repeats as aligned poster frames or short storyboards. Only the selected specimen plays, and every mark keeps its source time range.",
  },
  audio: {
    label: "Audio",
    note: "Waveforms summarize aligned segments without pretending to replace listening. Playback is selected, and the evidence anchor is a time range.",
  },
  document: {
    label: "Document / page",
    note: "A contact sheet supports discovery, not reading. Selection opens the full page at readable scale with page and region provenance.",
  },
  geography: {
    label: "Geography",
    note: "Geographic multiples hold projection and extent constant. When maps become too small to locate a feature, the policy aggregates or switches to one overview with selected detail.",
  },
  mixed: {
    label: "Mixed / 3D",
    note: "Mixed collections partition by medium or compile to a genuinely common semantic role. Equal card sizes are not treated as equal readability; 3D items use consistent contact views and selected orbit.",
  },
});

function repeatColumns(policy) {
  const columns = Number.isSafeInteger(policy?.columns) ? policy.columns : 1;
  const minimumWidth = Number(policy?.minimumReadableUnit?.width);
  const availableWidth = Number(policy?.availableWidth);
  const gap = 8;
  const fittingColumns = Number.isFinite(minimumWidth) && Number.isFinite(availableWidth)
    ? Math.max(1, Math.floor((availableWidth + gap) / (minimumWidth + gap)))
    : columns;
  return Math.max(1, Math.min(8, columns, fittingColumns));
}

function sparkline(index, audio = false) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 120 48");
  svg.setAttribute("class", audio ? "waveform" : "spark-strip");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", audio ? `Audio segment ${index + 1} waveform` : `Series ${index + 1} trend`);
  const values = Array.from({ length: audio ? 22 : 10 }, (_, point) => {
    const wave = Math.sin((point + index) * 1.7) * 8;
    return audio ? 8 + Math.abs(wave) + ((point * 5 + index * 3) % 10) : 24 + wave + ((point * 7 + index * 3) % 13) - point * 0.6;
  });
  if (audio) {
    values.forEach((height, point) => {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(4 + point * 5.2));
      line.setAttribute("x2", String(4 + point * 5.2));
      line.setAttribute("y1", String(24 - height / 2));
      line.setAttribute("y2", String(24 + height / 2));
      line.setAttribute("class", "wave-bar");
      svg.append(line);
    });
  } else {
    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.setAttribute("points", values.map((point, pointIndex) => `${4 + pointIndex * 12.4},${point}`).join(" "));
    polyline.setAttribute("class", "spark-path");
    svg.append(polyline);
  }
  return svg;
}

function specimenShell(index, frame) {
  const specimen = document.createElement("div");
  specimen.className = "media-specimen";
  specimen.append(frame);
  const title = document.createElement("strong");
  title.textContent = `Specimen ${String(index + 1).padStart(2, "0")}`;
  specimen.append(title);
  return specimen;
}

function visibleRepeatCount(mediaType, count, policy) {
  if (policy?.quantityBand !== "dense") return count;
  const rows = mediaType === "structured" ? 9 : mediaType === "image" ? 5 : mediaType === "audio" ? 6 : 4;
  return Math.min(count, repeatColumns(policy) * rows);
}

function remainderSpecimen(remaining) {
  const specimen = document.createElement("div");
  specimen.className = "media-specimen remainder-specimen";
  const amount = document.createElement("strong");
  amount.textContent = `+${remaining}`;
  const label = document.createElement("span");
  label.textContent = "Indexed beyond this overview";
  specimen.append(amount, label);
  return specimen;
}

function renderRepeatGrid(mediaType, count, policy) {
  const grid = document.createElement("div");
  grid.className = `repeat-grid columns-${repeatColumns(policy)}`;
  const displayCount = visibleRepeatCount(mediaType, count, policy);
  for (let index = 0; index < displayCount; index += 1) {
    if (mediaType === "structured") {
      grid.append(specimenShell(index, sparkline(index)));
    } else if (mediaType === "image") {
      const frame = document.createElement("div");
      frame.className = `image-frame ratio-${["portrait", "square", "landscape", "wide"][index % 4]}`;
      grid.append(specimenShell(index, frame));
    } else if (mediaType === "video") {
      const frame = document.createElement("div");
      frame.className = "video-frame";
      frame.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
      grid.append(specimenShell(index, frame));
    } else if (mediaType === "audio") {
      grid.append(specimenShell(index, sparkline(index, true)));
    } else if (mediaType === "document") {
      const frame = document.createElement("div");
      frame.className = "document-page";
      grid.append(specimenShell(index, frame));
    }
  }
  if (displayCount < count) grid.append(remainderSpecimen(count - displayCount));
  return grid;
}

function renderTextPolicy(count, policy) {
  if (count > 36) return aggregateMessage(count, "passages indexed", "The overview keeps titles and cluster counts; one selected passage opens in a readable column.");
  const listElement = document.createElement("ol");
  listElement.className = "text-repeat-list";
  const phrases = ["fixed visual grammar", "exact evidence", "source identity", "bounded enrichment"];
  const shown = Math.min(count, 12);
  for (let index = 0; index < shown; index += 1) {
    const item = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = `The ${phrases[index % phrases.length]} remains visible while the question changes. This passage stays at reading size instead of becoming a thumbnail.`;
    item.append(text);
    listElement.append(item);
  }
  if (policy?.quantityBand === "dense" && shown < count) {
    const remainder = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = `${count - shown} more passages remain in the index; selection opens one here at the same reading width.`;
    remainder.append(text);
    listElement.append(remainder);
  }
  return listElement;
}

function aggregateMessage(count, title, message) {
  const wrapper = document.createElement("div");
  wrapper.className = "aggregate-message";
  const heading = document.createElement("strong");
  heading.textContent = `${count} ${title}`;
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  wrapper.append(heading, paragraph);
  return wrapper;
}

let worldGeographyPromise;

async function loadWorldGeography() {
  worldGeographyPromise ??= fetch("./vendor/world-countries.json")
    .then(async (response) => {
      if (!response.ok) throw new Error("Published world geometry could not be loaded.");
      const topology = await response.json();
      if (!globalThis.topojson?.feature || !globalThis.d3?.geoEqualEarth) throw new Error("The projected-map renderer is unavailable.");
      return globalThis.topojson.feature(topology, topology.objects.countries).features;
    })
    .catch((error) => {
      worldGeographyPromise = undefined;
      throw error;
    });
  return worldGeographyPromise;
}

async function renderGeographyPolicy(count, policy) {
  if (policy?.quantityBand === "dense") return aggregateMessage(count, "regions summarized", "At this quantity, tiny maps would lose geographic context. The policy uses one overview and selected regional detail.");
  const features = await loadWorldGeography();
  const d3 = globalThis.d3;
  const projection = d3.geoEqualEarth().fitExtent([[3, 4], [117, 82]], { type: "FeatureCollection", features });
  const path = d3.geoPath(projection);
  const grid = document.createElement("div");
  grid.className = `repeat-grid columns-${repeatColumns(policy)}`;
  for (let index = 0; index < count; index += 1) {
    const frame = document.createElement("div");
    frame.className = "geo-frame";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 120 86");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `World comparison map ${index + 1}`);
    features.forEach((feature, featureIndex) => {
      const region = document.createElementNS("http://www.w3.org/2000/svg", "path");
      region.setAttribute("d", path(feature));
      region.setAttribute("class", featureIndex === (index * 7) % features.length ? "geo-region is-highlighted" : "geo-region");
      svg.append(region);
    });
    frame.append(svg);
    grid.append(specimenShell(index, frame));
  }
  return grid;
}

function renderMixedPolicy(count, policy) {
  const types = ["text", "image", "video", "audio", "document", "3D"];
  if (policy?.quantityBand === "dense") {
    return aggregateMessage(count, "mixed items partitioned", "The index separates text, images, video, audio, documents, and 3D objects before opening one native preview at a time.");
  }
  const groups = document.createElement("div");
  groups.className = "mixed-policy-groups";
  for (let index = 0; index < count; index += 1) {
    const type = types[index % types.length];
    const group = document.createElement("section");
    group.className = "mixed-policy-group";
    const heading = document.createElement("h2");
    heading.textContent = type;
    let preview;
    if (type === "text") preview = renderTextPolicy(1, { quantityBand: "single" });
    else if (type === "3D") {
      const frame = document.createElement("div");
      frame.className = "mixed-frame";
      const label = document.createElement("span");
      label.className = "mixed-type";
      label.textContent = "Consistent contact view";
      frame.append(label);
      preview = specimenShell(index, frame);
    } else {
      preview = renderRepeatGrid(type, 1, { columns: 1, quantityBand: "single" });
    }
    group.append(heading, preview);
    groups.append(group);
  }
  return groups;
}

async function renderMediaPolicy() {
  const revision = ++state.mediaRenderRevision;
  const mediaType = elements.mediaSelect.value;
  const count = Number(elements.quantitySelect.value);
  const availableWidth = Math.max(280, Math.floor(elements.mediaVisual.clientWidth || 960));
  const policy = safeRepeatPolicy(mediaType, count, availableWidth);
  const unit = policy.minimumReadableUnit;
  elements.mediaDecision.textContent = [
    words(policy.quantityBand ?? policy.decision ?? policy.mode ?? "Adapt"),
    `${repeatColumns(policy)} ${repeatColumns(policy) === 1 ? "column" : "columns"}`,
    unit ? `minimum ${unit.width}×${unit.height}px` : null,
  ].filter(Boolean).join(" · ");
  elements.mediaLayout.textContent = words(policy.layout ?? policy.profile ?? policy.layoutId ?? "Media-specific layout");
  elements.mediaVisual.setAttribute("aria-busy", "true");
  let visual;
  try {
    if (mediaType === "text") visual = renderTextPolicy(count, policy);
    else if (mediaType === "geography") visual = await renderGeographyPolicy(count, policy);
    else if (mediaType === "mixed") visual = renderMixedPolicy(count, policy);
    else if ((mediaType === "video" || mediaType === "document") && policy.quantityBand === "dense" && count > repeatColumns(policy) * 6) {
      visual = aggregateMessage(count, `${mediaType} specimens indexed`, `The overview groups the collection; selection opens one ${mediaType} at a readable size.`);
    } else visual = renderRepeatGrid(mediaType, count, policy);
  } catch (error) {
    visual = aggregateMessage(count, "specimens unavailable", error instanceof Error ? error.message : "The media preview could not be rendered.");
  }
  if (revision !== state.mediaRenderRevision) return;
  elements.mediaVisual.replaceChildren(visual);
  elements.mediaVisual.setAttribute("aria-busy", "false");
  elements.mediaNote.textContent = [
    MEDIA_DETAILS[mediaType].note,
    policy.fallback && policy.fallback !== "none" ? `Fallback: ${policy.fallback}` : null,
  ].filter(Boolean).join(" ");
}

async function setFamily(familyId) {
  if (!SAMPLE_SOURCES[familyId]) return;
  state.familyId = familyId;
  state.selectedId = null;
  updateNavigationState();
  await renderGallery();
  if (state.mode === "pipeline") await renderPipelineReceipt();
}

function setMode(mode) {
  state.mode = mode;
  elements.gallery.hidden = mode !== "gallery";
  elements.pipeline.hidden = mode !== "pipeline";
  elements.media.hidden = mode !== "media";
  document.querySelectorAll(".mode-button").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  if (mode === "pipeline") renderPipelineReceipt();
  if (mode === "media") renderMediaPolicy();
}

async function selectMark(markId) {
  state.selectedId = markId || null;
  await renderGallery();
}

elements.navigation.addEventListener("click", (event) => {
  const button = event.target.closest("[data-family-id]");
  if (button) setFamily(button.dataset.familyId);
});

elements.familySelect.addEventListener("change", () => setFamily(elements.familySelect.value));
elements.markSelect.addEventListener("change", () => selectMark(elements.markSelect.value));
elements.visual.addEventListener("click", (event) => {
  const mark = event.target.closest("[data-mark-id]");
  if (mark) selectMark(mark.dataset.markId);
});
document.querySelectorAll(".mode-button").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
elements.mediaSelect.addEventListener("change", renderMediaPolicy);
elements.quantitySelect.addEventListener("change", renderMediaPolicy);

let mediaResizeFrame = null;
let mediaObservedWidth = 0;
if ("ResizeObserver" in globalThis) {
  const mediaResizeObserver = new ResizeObserver(([entry]) => {
    const width = Math.floor(entry?.contentRect.width ?? 0);
    if (width === mediaObservedWidth) return;
    mediaObservedWidth = width;
    if (state.mode !== "media" || mediaResizeFrame !== null) return;
    mediaResizeFrame = requestAnimationFrame(() => {
      mediaResizeFrame = null;
      renderMediaPolicy();
    });
  });
  mediaResizeObserver.observe(elements.mediaVisual);
}

function initializeMediaOptions() {
  const declared = Array.isArray(CANONICAL_INPUT_MEDIA) && CANONICAL_INPUT_MEDIA.length ? CANONICAL_INPUT_MEDIA : FALLBACK_MEDIA;
  const media = [...new Set(declared.map((item) => item === "3d" ? "mixed" : item))].filter((item) => MEDIA_DETAILS[item]);
  elements.mediaSelect.replaceChildren(...media.map((mediaType) => makeOption(mediaType, MEDIA_DETAILS[mediaType].label)));
}

function validateGalleryParity() {
  const missingManifest = FAMILY_ORDER.filter((familyId) => !manifestById.has(familyId));
  const missingRenderer = FAMILY_ORDER.filter((familyId) => !RENDERER_IDS.includes(familyId));
  if (missingManifest.length || missingRenderer.length) {
    throw new Error(`Gallery registry mismatch. Missing manifests: ${missingManifest.join(", ") || "none"}; missing renderers: ${missingRenderer.join(", ") || "none"}.`);
  }
}

validateGalleryParity();
renderPipelineStages();
initializeMediaOptions();
renderNavigation();
renderGallery();
