const MANIFEST_SCHEMA_VERSION = 1;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function contractError(message, path = "manifest") {
  const error = new TypeError(`${path}: ${message}`);
  error.code = "INVALID_MAP_FAMILY_MANIFEST";
  error.path = path;
  return error;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export const CANONICAL_INPUT_MEDIA = deepFreeze([
  "structured",
  "text",
  "image",
  "video",
  "audio",
  "document",
  "geography",
  "mixed",
]);

export const MAP_FAMILY_GROUPS = deepFreeze([
  {
    id: "compare",
    label: "Compare",
    purpose: "Judge magnitude, shape, parts, profiles, or passages against an explicit peer or baseline.",
  },
  {
    id: "time",
    label: "Time",
    purpose: "See change, events, and ordered states without losing temporal evidence.",
  },
  {
    id: "relate",
    label: "Relate",
    purpose: "Inspect association, structure, connection, flow, and mechanism.",
  },
  {
    id: "space",
    label: "Space / locate",
    purpose: "Locate values, objects, fields, and annotations in physical or constructed space.",
  },
  {
    id: "browse",
    label: "Browse",
    purpose: "Move from collection overview to neighborhoods, specimens, and exact evidence without requiring a prior lookup target.",
  },
]);

const GROUP_IDS = new Set(MAP_FAMILY_GROUPS.map((group) => group.id));

export const REPEAT_LAYOUT_PROFILES = deepFreeze({
  "numeric-chart": {
    label: "Numeric chart",
    adaptationDecision: "direct",
    minimumReadableUnit: { width: 136, height: 104, unit: "css-px" },
    maximumColumns: 8,
    selectionBehavior: "linked mark selection and shared-scale brushing",
    quantityBands: [
      { id: "single", maxCount: 1, layout: "single-panel", fallback: "none" },
      { id: "few", maxCount: 6, layout: "aligned-row", fallback: "wrap to aligned grid" },
      { id: "many", maxCount: 24, layout: "aligned-grid", fallback: "facet, then scroll" },
      { id: "dense", maxCount: null, layout: "virtualized-grid", fallback: "aggregate and reveal on selection" },
    ],
  },
  image: {
    label: "Image",
    adaptationDecision: "direct",
    minimumReadableUnit: { width: 176, height: 152, unit: "css-px" },
    maximumColumns: 6,
    selectionBehavior: "single focus with additive comparison selection",
    quantityBands: [
      { id: "single", maxCount: 1, layout: "single-specimen", fallback: "none" },
      { id: "few", maxCount: 8, layout: "aligned-contact-row", fallback: "wrap without cropping evidence" },
      { id: "many", maxCount: 36, layout: "contact-sheet", fallback: "progressive thumbnails" },
      { id: "dense", maxCount: null, layout: "virtualized-contact-sheet", fallback: "cluster, sample, and zoom" },
    ],
  },
  video: {
    label: "Video",
    adaptationDecision: "deterministic",
    minimumReadableUnit: { width: 264, height: 190, unit: "css-px" },
    maximumColumns: 4,
    selectionBehavior: "one active player; linked time-range selections remain comparable",
    quantityBands: [
      { id: "single", maxCount: 1, layout: "single-player", fallback: "none" },
      { id: "few", maxCount: 4, layout: "poster-filmstrip", fallback: "one active player with peer posters" },
      { id: "many", maxCount: 12, layout: "poster-grid", fallback: "page posters; play on demand" },
      { id: "dense", maxCount: null, layout: "paged-poster-index", fallback: "summarize sequences before playback" },
    ],
  },
  audio: {
    label: "Audio",
    adaptationDecision: "deterministic",
    minimumReadableUnit: { width: 248, height: 112, unit: "css-px" },
    maximumColumns: 4,
    selectionBehavior: "one active player with linked transcript or waveform range",
    quantityBands: [
      { id: "single", maxCount: 1, layout: "single-waveform", fallback: "none" },
      { id: "few", maxCount: 6, layout: "waveform-stack", fallback: "collapse inactive transcripts" },
      { id: "many", maxCount: 18, layout: "compact-audio-list", fallback: "page and summarize clips" },
      { id: "dense", maxCount: null, layout: "indexed-audio-list", fallback: "cluster clips; load waveform on focus" },
    ],
  },
  text: {
    label: "Text",
    adaptationDecision: "direct",
    minimumReadableUnit: { width: 304, height: 176, unit: "css-px" },
    maximumColumns: 1,
    selectionBehavior: "one focused reading column with persistent passage selection and source offsets",
    quantityBands: [
      { id: "single", maxCount: 1, layout: "single-passage", fallback: "none" },
      { id: "few", maxCount: 3, layout: "readable-passage-column", fallback: "stack passages vertically at reading width" },
      { id: "many", maxCount: 12, layout: "paged-passage-index", fallback: "show bounded excerpts and expand the selected passage at reading width" },
      { id: "dense", maxCount: null, layout: "virtualized-passage-index", fallback: "cluster passages and open the selected passage in one readable column" },
    ],
  },
  document: {
    label: "Document",
    adaptationDecision: "deterministic",
    minimumReadableUnit: { width: 280, height: 360, unit: "css-px" },
    maximumColumns: 4,
    selectionBehavior: "page or region selection with synchronized page navigation",
    quantityBands: [
      { id: "single", maxCount: 1, layout: "single-page", fallback: "none" },
      { id: "few", maxCount: 4, layout: "page-comparison", fallback: "lock zoom and page alignment" },
      { id: "many", maxCount: 16, layout: "page-contact-sheet", fallback: "thumbnail pages; inspect on focus" },
      { id: "dense", maxCount: null, layout: "virtualized-page-index", fallback: "group by document and page range" },
    ],
  },
  geography: {
    label: "Geography",
    adaptationDecision: "deterministic",
    minimumReadableUnit: { width: 320, height: 240, unit: "css-px" },
    maximumColumns: 3,
    selectionBehavior: "linked feature selection with a shared projection, extent, and legend",
    quantityBands: [
      { id: "single", maxCount: 1, layout: "single-map", fallback: "none" },
      { id: "few", maxCount: 4, layout: "projected-map-row", fallback: "use identical extents and scales" },
      { id: "many", maxCount: 12, layout: "projected-map-grid", fallback: "fix projection and simplify geometry" },
      { id: "dense", maxCount: null, layout: "paged-map-grid", fallback: "aggregate regions or provide one interactive overview" },
    ],
  },
  "3d-mixed": {
    label: "3D or mixed media",
    adaptationDecision: "enrich",
    minimumReadableUnit: { width: 360, height: 280, unit: "css-px" },
    maximumColumns: 3,
    selectionBehavior: "one active rich specimen with linked, type-aware peer selection",
    quantityBands: [
      { id: "single", maxCount: 1, layout: "single-rich-view", fallback: "none" },
      { id: "few", maxCount: 3, layout: "rich-view-row", fallback: "activate one expensive view at a time" },
      { id: "many", maxCount: 9, layout: "preview-grid", fallback: "use static previews until focused" },
      { id: "dense", maxCount: null, layout: "faceted-preview-index", fallback: "split by medium, cluster, then inspect" },
    ],
  },
});

export const REPEAT_LAYOUT_POLICY = deepFreeze({
  id: "attend-repeat-layout",
  version: 1,
  principle: "Small multiples are a cross-family comparison policy, never a semantic map family.",
  profiles: Object.keys(REPEAT_LAYOUT_PROFILES),
});

export const GEOGRAPHY_RENDERER_POLICY = deepFreeze({
  interactiveGlobal: {
    library: "MapLibre GL JS",
    version: "5.6.1",
    useWhen: "The person must pan, zoom, inspect, or filter a global or multi-resolution geographic view.",
  },
  fixedProjectedComparison: {
    library: "d3-geo",
    version: "3",
    useWhen: "Several maps must share a fixed projection, extent, and scale for reliable comparison.",
  },
  donor: "People Atlas",
});

export function classifyRepeatMedia(value) {
  const raw = String(value ?? "numeric-chart").trim().toLowerCase();
  if (["numeric", "number", "quantitative", "structured", "chart", "numeric-chart"].includes(raw)) return "numeric-chart";
  if (raw === "image" || raw.startsWith("image/")) return "image";
  if (raw === "video" || raw.startsWith("video/")) return "video";
  if (raw === "audio" || raw.startsWith("audio/")) return "audio";
  if (raw === "text" || raw.startsWith("text/")) return "text";
  if (raw === "document" || raw === "application/pdf" || raw.includes("document")) return "document";
  if (["geography", "geographic", "geo", "map"].includes(raw) || raw.includes("geo+json")) return "geography";
  if (["mixed", "3d", "model", "3d-mixed"].includes(raw) || raw.startsWith("model/")) return "3d-mixed";
  return "3d-mixed";
}

export function multiplesPolicy({ mediaType = "numeric-chart", count, availableWidth } = {}) {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("count must be a non-negative integer");
  }
  if (typeof availableWidth !== "number" || !Number.isFinite(availableWidth) || availableWidth <= 0) {
    throw new TypeError("availableWidth must be a positive finite number");
  }
  const profileId = classifyRepeatMedia(mediaType);
  const profile = REPEAT_LAYOUT_PROFILES[profileId];
  const width = profile.minimumReadableUnit.width;
  const columns = count === 0
    ? 0
    : Math.max(1, Math.min(count, profile.maximumColumns, Math.floor(availableWidth / width) || 1));
  const band = profile.quantityBands.find((candidate) =>
    candidate.maxCount === null || count <= candidate.maxCount,
  );
  const rows = columns === 0 ? 0 : Math.ceil(count / columns);
  return deepFreeze({
    policy: { id: REPEAT_LAYOUT_POLICY.id, version: REPEAT_LAYOUT_POLICY.version },
    requestedMediaType: String(mediaType),
    profile: profileId,
    count,
    availableWidth,
    minimumReadableUnit: { ...profile.minimumReadableUnit },
    columns,
    rows,
    quantityBand: band.id,
    layout: band.layout,
    fallback: band.fallback,
    selectionBehavior: profile.selectionBehavior,
    adaptationDecision: profile.adaptationDecision,
  });
}

const ROLE_TYPES = new Set([
  "string",
  "number",
  "time",
  "identifier",
  "latitude",
  "longitude",
  "ratio",
  "media",
]);

function role(id, types, description) {
  return { id, types: Array.isArray(types) ? types : [types], description };
}

const LOCATOR_BY_MEDIUM = Object.freeze({
  structured: "row-or-cell",
  text: "character-or-line-range",
  image: "bounding-box",
  video: "time-range-or-frame",
  audio: "time-range",
  document: "page-region",
  geography: "feature-id-or-coordinate",
  mixed: "compound-locator",
});

const PREVIEW_BY_MEDIUM = Object.freeze({
  structured: "formatted-value",
  text: "bounded-excerpt",
  image: "thumbnail-with-alt",
  video: "poster-and-timecode",
  audio: "waveform-and-transcript-excerpt",
  document: "page-thumbnail-and-excerpt",
  geography: "feature-outline-or-static-projection",
  mixed: "type-aware-preview",
});

function mediaAdapters(decisions, extractedFields) {
  return CANONICAL_INPUT_MEDIA.map((medium) => {
    const specified = decisions[medium] ?? "abstain";
    const decision = typeof specified === "string" ? specified : specified.decision;
    return {
      medium,
      decision,
      fieldsExtracted: decision === "abstain"
        ? []
        : (typeof specified === "object" && specified.fieldsExtracted
            ? [...specified.fieldsExtracted]
            : [...extractedFields]),
      evidenceLocatorKind: decision === "abstain"
        ? "none"
        : (typeof specified === "object" && specified.evidenceLocatorKind) || LOCATOR_BY_MEDIUM[medium],
      previewTreatment: decision === "abstain"
        ? "none"
        : (typeof specified === "object" && specified.previewTreatment) || PREVIEW_BY_MEDIUM[medium],
      reason: typeof specified === "object" && specified.reason
        ? specified.reason
        : decision === "abstain"
          ? `This family cannot preserve its required roles from ${medium} input without inventing structure.`
          : `${medium} input is handled through a bounded ${decision} adapter before the medium-agnostic family transform.`,
    };
  });
}

function multiplesContract(supportedMedia, defaultMedia) {
  return {
    policy: { id: REPEAT_LAYOUT_POLICY.id, version: REPEAT_LAYOUT_POLICY.version },
    supportedMedia: [...supportedMedia],
    defaultMedia,
    profiles: supportedMedia.map((id) => ({
      id,
      minimumReadableUnit: { ...REPEAT_LAYOUT_PROFILES[id].minimumReadableUnit },
      layouts: REPEAT_LAYOUT_PROFILES[id].quantityBands.map((band) => band.layout),
      quantityBands: REPEAT_LAYOUT_PROFILES[id].quantityBands.map((band) => ({ ...band })),
      selectionBehavior: REPEAT_LAYOUT_PROFILES[id].selectionBehavior,
      adaptationDecision: REPEAT_LAYOUT_PROFILES[id].adaptationDecision,
    })),
  };
}

function control(id, type, description) {
  return { id, type, description };
}

function selection(id, description, cardinality = "one-or-more") {
  return { id, description, cardinality };
}

function variant(id, label, when, grammarDelta) {
  return { id, label, when, grammarDelta };
}

const DEFAULT_MEDIA_DECISIONS = Object.freeze({
  structured: "direct",
  text: "deterministic",
  image: "enrich",
  video: "enrich",
  audio: "enrich",
  document: "deterministic",
  geography: "deterministic",
  mixed: "enrich",
});

function family(definition) {
  const allRoles = [...definition.requiredRoles, ...(definition.optionalRoles ?? [])];
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: "attend-map-family",
    id: definition.id,
    version: 1,
    group: definition.group,
    title: definition.title,
    summary: definition.summary,
    maturity: "pipeline",
    questions: {
      answersWell: definition.answersWell,
      abstainsWhen: definition.abstainsWhen,
      examples: definition.examples,
    },
    data: {
      requiredRoles: definition.requiredRoles,
      optionalRoles: definition.optionalRoles ?? [],
      minimumRecords: definition.minimumRecords ?? 1,
      maximumRecords: definition.maximumRecords ?? 50_000,
    },
    mediaAdapters: mediaAdapters(
      { ...DEFAULT_MEDIA_DECISIONS, ...(definition.mediaDecisions ?? {}) },
      allRoles.map((item) => item.id),
    ),
    transformation: {
      id: `${definition.id}/deterministic-v1`,
      version: 1,
      deterministic: true,
      description: definition.transformDescription,
      orderBy: definition.orderBy,
      markLabelRoles: definition.markLabelRoles,
      markLabelSeparator: definition.markLabelSeparator ?? " · ",
      payload: {
        schemaVersion: 1,
        kind: `attend-${definition.id}-payload`,
        collection: definition.collection,
      },
    },
    enrichment: {
      mode: "optional-bounded",
      maximumPatches: definition.maximumEnrichments ?? 48,
      allowedFields: ["label", "summary", "media.preview.alt"],
      requiresInputEvidence: true,
      acceptedStatus: "accepted",
      rule: "Only explicitly accepted, evidence-linked string patches may alter presentation metadata; role values never change.",
    },
    validation: {
      mode: "fail-closed",
      rules: [
        "Every required role is mapped and valid on every compiled record.",
        "Every mark has a stable id and at least one evidence reference.",
        "Every payload mark reference resolves within the package.",
        ...definition.validationRules,
      ],
      emptyState: "Explain why the family abstained; never render an empty analytic frame as an answer.",
      uncertainty: "Retain missingness, inference status, and known omissions in package quality metadata.",
    },
    evidence: {
      required: true,
      granularity: "per-mark",
      locatorKinds: [...new Set(mediaAdapters(
        { ...DEFAULT_MEDIA_DECISIONS, ...(definition.mediaDecisions ?? {}) },
        [],
      ).filter((entry) => entry.decision !== "abstain").map((entry) => entry.evidenceLocatorKind))],
      requirements: [
        "A mark must resolve to one or more normalized records and source ids.",
        "Excerpts and previews are bounded; source bodies remain outside the public package.",
        "Coverage counts and omissions remain visible to the renderer and conversation layer.",
      ],
    },
    grammar: {
      version: 1,
      mark: definition.grammar.mark,
      layout: definition.grammar.layout,
      encodings: definition.grammar.encodings,
      invariants: definition.grammar.invariants,
    },
    variants: definition.variants,
    multiples: multiplesContract(definition.repeatMedia, definition.defaultRepeatMedia),
    controls: definition.controls,
    selections: definition.selections,
    followUps: definition.followUps,
    renderer: {
      id: `attend-${definition.id}`,
      version: 1,
      maturity: "specified",
      ...(definition.geographyRenderer ? { geography: GEOGRAPHY_RENDERER_POLICY } : {}),
    },
  };
  validateMapFamilyManifest(manifest);
  return deepFreeze(manifest);
}

const FAMILY_DEFINITIONS = [
  {
    id: "rank", group: "compare", title: "Rank", summary: "Order named items by one comparable measure.",
    answersWell: ["Which items are largest, smallest, most frequent, or highest priority?", "Where does a named item sit relative to its peers?"],
    abstainsWhen: ["Values use incompatible units or an honest baseline is unavailable.", "The ordering would imply precision the evidence does not support."],
    examples: ["Which themes recur across the most sources?", "Which projects consume the most time?"],
    requiredRoles: [role("label", "string", "Name of the ranked item."), role("value", "number", "Comparable numeric measure.")],
    optionalRoles: [role("group", "string", "Bounded facet or peer group."), role("baseline", "number", "Explicit comparison baseline.")],
    minimumRecords: 2,
    transformDescription: "Project comparable label/value records, retain ties, and order by value then label.",
    orderBy: [{ role: "value", direction: "desc" }, { role: "label", direction: "asc" }], markLabelRoles: ["label"], collection: "items",
    validationRules: ["Values are finite and share the unit declared by the normalized bundle."],
    grammar: { mark: "aligned bar or ranked specimen row", layout: "single ordered axis with zero baseline where meaningful", encodings: ["position and length=value", "text=label", "facet=group"], invariants: ["Ordering is visible.", "Ties are not broken arbitrarily.", "The baseline and unit remain visible."] },
    variants: [variant("bar-list", "Bar list", "Numeric values and readable labels.", "Aligned horizontal bars."), variant("ranked-specimens", "Ranked specimens", "The ranked objects are images, video, audio, text, or documents.", "Repeat media previews beside one shared rank scale.")],
    repeatMedia: ["numeric-chart", "image", "video", "audio", "text", "document"], defaultRepeatMedia: "numeric-chart",
    controls: [control("group", "select", "Choose one declared peer group."), control("order", "segmented", "Switch ascending or descending order.")],
    selections: [selection("ranked-item", "Select one or more ranked items and their exact evidence.")],
    followUps: ["Why is this item ranked here?", "Compare the top and bottom items.", "Which sources contribute most to this value?"],
  },
  {
    id: "distribution", group: "compare", title: "Distribution", summary: "Show the shape, spread, gaps, and outliers of one measure.",
    answersWell: ["How are values distributed?", "Is the apparent average hiding skew, clusters, or outliers?"],
    abstainsWhen: ["There are too few observations to characterize shape.", "Values mix units or were sampled through incomparable processes."],
    examples: ["How long are these notes?", "How are response times distributed by team?"],
    requiredRoles: [role("value", "number", "Observed numeric value.")], optionalRoles: [role("label", "string", "Observation label."), role("group", "string", "Comparison group."), role("weight", "number", "Explicit observation weight.")], minimumRecords: 3,
    transformDescription: "Sort exact observations and calculate finite extent and group membership without inventing bins.",
    orderBy: [{ role: "value", direction: "asc" }, { role: "label", direction: "asc" }], markLabelRoles: ["label", "value"], collection: "observations",
    validationRules: ["Weights, when present, are non-negative.", "Any renderer-selected bins expose their boundaries."],
    grammar: { mark: "dot, tick, or bin", layout: "one quantitative axis shared across groups", encodings: ["position=value", "stack or facet=group", "count or density=aggregation"], invariants: ["Raw observations remain selectable.", "Bin boundaries are explicit.", "Group scales are identical."] },
    variants: [variant("strip", "Strip distribution", "The number of observations remains individually legible.", "One selectable tick or dot per observation."), variant("histogram", "Histogram", "Density would otherwise overplot observations.", "Deterministic bins with exact boundaries and drill-through marks.")],
    repeatMedia: ["numeric-chart"], defaultRepeatMedia: "numeric-chart",
    controls: [control("group", "select", "Facet by a declared group."), control("binning", "segmented", "Choose one tested deterministic bin preset.")], selections: [selection("observation-or-bin", "Select an observation or a bin that resolves to its observations.")],
    followUps: ["What explains this outlier?", "How do these groups differ?", "Which observations form this cluster?"],
  },
  {
    id: "composition", group: "compare", title: "Composition", summary: "Compare how a total is divided into named parts.",
    answersWell: ["What makes up this whole?", "How does part-to-whole balance differ across groups?"], abstainsWhen: ["Parts overlap or do not share a defensible whole.", "Negative values or incompatible denominators make part-to-whole encoding misleading."],
    examples: ["What share of work belongs to each theme?", "How does budget composition differ by quarter?"],
    requiredRoles: [role("part", "string", "Named part."), role("value", "number", "Non-negative part magnitude.")], optionalRoles: [role("whole", "string", "Named whole or comparison group.")], minimumRecords: 2,
    transformDescription: "Group non-negative parts by whole, retain exact values, and derive explicit totals and shares.", orderBy: [{ role: "whole", direction: "asc" }, { role: "value", direction: "desc" }, { role: "part", direction: "asc" }], markLabelRoles: ["part"], collection: "parts",
    validationRules: ["Part values are non-negative.", "Every displayed share names its denominator."],
    grammar: { mark: "stack segment or aligned part bar", layout: "shared whole axis or repeated normalized whole", encodings: ["length=value or share", "color=part", "facet=whole"], invariants: ["Totals and denominators are visible.", "Parts keep stable identity across wholes.", "Tiny parts remain discoverable without false area precision."] },
    variants: [variant("absolute-stack", "Absolute composition", "Whole magnitudes must remain comparable.", "Shared absolute scale with labeled totals."), variant("normalized-parts", "Normalized composition", "The question is relative mix rather than total size.", "One hundred percent scale with the absolute total alongside.")], repeatMedia: ["numeric-chart"], defaultRepeatMedia: "numeric-chart",
    controls: [control("measure", "segmented", "Switch absolute values and declared shares."), control("whole", "select", "Focus one whole without changing the denominator.")], selections: [selection("part", "Select a part within its explicit whole.")], followUps: ["Why is this part unusually large?", "Compare the mix across these wholes.", "What is hidden in the remainder?"],
  },
  {
    id: "profile", group: "compare", title: "Profile", summary: "Compare entities across the same ordered set of dimensions.",
    answersWell: ["How do these entities differ across several measures?", "Where is one profile unusually strong, weak, or uneven?"], abstainsWhen: ["Dimensions cannot share honest normalization or direction.", "Missing dimensions would make a silhouette look complete when it is not."],
    examples: ["How do product options fit the same constraints?", "How do teams differ across capability dimensions?"],
    requiredRoles: [role("entity", "string", "Compared entity."), role("dimension", "string", "Shared comparison dimension."), role("value", "number", "Dimension value.")], optionalRoles: [role("baseline", "number", "Dimension-specific baseline.")], minimumRecords: 3,
    transformDescription: "Build an entity-by-dimension profile table while preserving missing cells and declared baselines.", orderBy: [{ role: "entity", direction: "asc" }, { role: "dimension", direction: "asc" }], markLabelRoles: ["entity", "dimension"], collection: "measurements",
    validationRules: ["Entity/dimension pairs are unique.", "Normalization and favorable direction are declared outside the observed values."],
    grammar: { mark: "profile point and connecting segment or aligned cell", layout: "identical dimension order and scale for every entity", encodings: ["position=value", "axis or row=dimension", "facet or series=entity"], invariants: ["Missing cells remain gaps.", "Dimension order is stable.", "Normalized values expose their original unit on inspection."] },
    variants: [variant("parallel-profile", "Parallel profile", "A few entities must be traced across ordered dimensions.", "Connected profiles on aligned dimension rows."), variant("profile-matrix", "Profile matrix", "Many entities would create crossing lines.", "Small-multiple rows or a value matrix with shared legends.")], repeatMedia: ["numeric-chart"], defaultRepeatMedia: "numeric-chart",
    controls: [control("entity", "multi-select", "Choose a bounded set of entities."), control("normalization", "segmented", "Use one declared normalization preset.")], selections: [selection("profile-cell", "Select an entity/dimension measurement.")], followUps: ["Why is this dimension different?", "Which entity most closely matches this profile?", "How does the baseline change the comparison?"],
  },
  {
    id: "passage-comparison", group: "compare", title: "Passage comparison", summary: "Align readable excerpts, versions, or claims while preserving source position.",
    answersWell: ["What changed between these passages or versions?", "Where do sources agree, diverge, or omit material?"], abstainsWhen: ["Text cannot be aligned without speculative paraphrase.", "Copyright or permission boundaries do not allow the passages to be displayed."],
    examples: ["How did this policy wording change?", "Compare how three documents describe the same idea."],
    requiredRoles: [role("passage", "string", "Bounded readable passage."), role("version", ["string", "time"], "Version, source, or comparison column.")], optionalRoles: [role("label", "string", "Passage label or aligned section."), role("order", "number", "Stable passage order.")], minimumRecords: 2,
    transformDescription: "Order bounded passages by aligned label and version while retaining exact source offsets.", orderBy: [{ role: "order", direction: "asc" }, { role: "label", direction: "asc" }, { role: "version", direction: "asc" }], markLabelRoles: ["label", "version"], collection: "passages",
    validationRules: ["Every visible passage is bounded and source-located.", "Similarity or alignment is labeled as deterministic or enriched."],
    grammar: { mark: "passage block and aligned change span", layout: "synchronized columns or stacked versions", encodings: ["column=version", "row=aligned passage", "annotation=addition, removal, or divergence"], invariants: ["Readable text is primary.", "No diff span loses its source offset.", "Omissions differ visually from empty text."] },
    variants: [variant("aligned-passages", "Aligned passages", "Several sources discuss parallel material.", "Synchronized readable columns with linked evidence."), variant("version-diff", "Version diff", "Two or three ordered versions can be aligned deterministically.", "Add/remove/change spans with an unchanged-text collapse control.")], repeatMedia: ["text", "document"], defaultRepeatMedia: "text",
    mediaDecisions: { structured: "deterministic", text: "direct", image: "enrich", video: "abstain", audio: "enrich", document: "deterministic", geography: "abstain", mixed: "enrich" },
    controls: [control("version", "multi-select", "Choose two or more comparison versions."), control("unchanged", "toggle", "Collapse or reveal unchanged context.")], selections: [selection("passage-or-change", "Select a passage or aligned change span.")], followUps: ["What is the practical consequence of this change?", "Which source is the outlier?", "Show the exact surrounding context."],
  },
  {
    id: "trend", group: "time", title: "Trend", summary: "Show how one or more comparable measures change through time.",
    answersWell: ["Is a measure rising, falling, recurring, or changing pace?", "How do time series differ over the same interval?"], abstainsWhen: ["Time coverage is too sparse or irregular for continuity.", "Aggregation would hide consequential events or incompatible sampling."], examples: ["How did theme volume change?", "When did response latency begin to rise?"],
    requiredRoles: [role("time", "time", "Event or observation time."), role("value", "number", "Observed measure.")], optionalRoles: [role("series", "string", "Named series."), role("label", "string", "Observation label.")], minimumRecords: 2,
    transformDescription: "Sort observations by series and time and derive the exact observed extent without interpolation.", orderBy: [{ role: "series", direction: "asc" }, { role: "time", direction: "asc" }, { role: "label", direction: "asc" }], markLabelRoles: ["label", "series", "time"], collection: "points",
    validationRules: ["Times are valid and comparable.", "Interpolation, smoothing, and aggregation are renderer presets with visible methods."],
    grammar: { mark: "point and optional connecting line or interval band", layout: "shared chronological axis", encodings: ["x=time", "y=value", "series=color or small multiple"], invariants: ["Observed points remain visible or inspectable.", "Gaps remain gaps.", "Series use the same time and value scale when compared."] },
    variants: [variant("observed-line", "Observed line", "Continuity between observations is defensible.", "Points joined by restrained lines; gaps stay visible."), variant("repeated-trends", "Repeated trends", "Several series would overlap noisily.", "Shared-scale small multiples using the repeat-layout policy.")], repeatMedia: ["numeric-chart"], defaultRepeatMedia: "numeric-chart",
    controls: [control("interval", "select", "Choose a declared aggregation interval."), control("series", "multi-select", "Choose visible series without rescaling peers silently.")], selections: [selection("point-or-interval", "Select an observation or bounded time interval.")], followUps: ["What happened around this change?", "Compare before and after this point.", "Which sources make up this interval?"],
  },
  {
    id: "timeline", group: "time", title: "Timeline", summary: "Place discrete events or intervals in chronological context.",
    answersWell: ["What happened, in what order, and with what overlaps?", "Which events cluster around a selected moment?"], abstainsWhen: ["Ordering is unknown or timestamps are too uncertain to support sequence.", "The question is about continuous magnitude rather than discrete events."], examples: ["How did the decision unfold?", "Which launches overlapped this incident?"],
    requiredRoles: [role("time", "time", "Event start time."), role("label", "string", "Event label.")], optionalRoles: [role("endTime", "time", "Event end time."), role("lane", "string", "Declared event lane."), role("status", "string", "Event status or certainty.")], minimumRecords: 1,
    transformDescription: "Order exact dated events, retain intervals and uncertainty, and group only by declared lanes.", orderBy: [{ role: "time", direction: "asc" }, { role: "lane", direction: "asc" }, { role: "label", direction: "asc" }], markLabelRoles: ["label"], collection: "events",
    validationRules: ["End time is not earlier than start time.", "Uncertain or inferred dates retain status."],
    grammar: { mark: "event point or interval", layout: "chronological axis with bounded lanes", encodings: ["x=time", "length=duration", "lane=declared category"], invariants: ["Chronology is stable.", "Overlaps remain visible.", "Date uncertainty is never rendered as exact."] },
    variants: [variant("event-strip", "Event strip", "Events are sparse and share one context.", "One chronological strip with evidence callouts."), variant("lane-timeline", "Lane timeline", "A few declared categories must be compared.", "Aligned lanes sharing one time axis.")], repeatMedia: ["numeric-chart", "image", "video", "audio", "text", "document"], defaultRepeatMedia: "numeric-chart",
    controls: [control("time-range", "brush", "Choose a bounded time range."), control("lane", "multi-select", "Show declared lanes.")], selections: [selection("event-or-interval", "Select events or a time interval.")], followUps: ["What changed after this event?", "What else was happening here?", "Which events have uncertain dates?"],
  },
  {
    id: "sequence", group: "time", title: "Sequence", summary: "Compare ordered states, frames, steps, or versions where order matters more than elapsed time.",
    answersWell: ["How did this object or scene progress step by step?", "Where does an image, video, audio, document, or text sequence change?"], abstainsWhen: ["Order is unknown or imposed only for presentation.", "Independent items would be misread as causal or consecutive."], examples: ["How did the design evolve across versions?", "What are the decisive frames in this process?"],
    requiredRoles: [role("order", ["number", "time"], "Stable step order."), role("label", "string", "Step or state label.")], optionalRoles: [role("stage", "string", "Declared phase."), role("duration", "number", "Duration where known.")], minimumRecords: 2,
    transformDescription: "Order states by explicit ordinal or time without inventing transitions.", orderBy: [{ role: "order", direction: "asc" }, { role: "label", direction: "asc" }], markLabelRoles: ["label"], collection: "steps",
    validationRules: ["Order values are comparable and ties remain explicit.", "A visual transition never implies a causal transition without evidence."],
    grammar: { mark: "step specimen, frame, or state card", layout: "ordered strip, storyboard, or bounded grid", encodings: ["position=order", "group=stage", "preview=source medium"], invariants: ["Reading order is unmistakable.", "Every preview carries its source locator.", "Only one rich medium auto-activates at a time."] },
    variants: [variant("storyboard", "Storyboard", "Image, document, or mixed states need readable spatial comparison.", "Numbered specimen grid with stage separators."), variant("filmstrip", "Filmstrip", "Video, audio, or dense image states need linear scanning.", "Ordered poster/waveform strip with one active player.")], repeatMedia: ["image", "video", "audio", "text", "document", "3d-mixed"], defaultRepeatMedia: "image",
    mediaDecisions: { structured: "direct", text: "direct", image: "direct", video: "deterministic", audio: "deterministic", document: "deterministic", geography: "abstain", mixed: "enrich" },
    controls: [control("stage", "select", "Focus a declared phase."), control("spacing", "segmented", "Use ordinal or elapsed-time spacing when both exist.")], selections: [selection("step", "Select one or more ordered states.")], followUps: ["What changed between these steps?", "Why is this transition important?", "Show the exact source around this state."],
  },
  {
    id: "relationship", group: "relate", title: "Relationship", summary: "Inspect how two quantitative variables vary together.",
    answersWell: ["Do two measures move together?", "Which items depart from the overall relationship?"], abstainsWhen: ["Either axis is categorical, incomparable, or derived from the other.", "The view would imply causation from association."], examples: ["Does project size relate to delay?", "Which items have high reach but low recurrence?"],
    requiredRoles: [role("x", "number", "Horizontal measure."), role("y", "number", "Vertical measure.")], optionalRoles: [role("label", "string", "Point label."), role("group", "string", "Declared group."), role("size", "number", "Optional third magnitude.")], minimumRecords: 3,
    transformDescription: "Project exact paired observations and derive finite x/y extents without fitting a model.", orderBy: [{ role: "x", direction: "asc" }, { role: "y", direction: "asc" }, { role: "label", direction: "asc" }], markLabelRoles: ["label", "x", "y"], collection: "points",
    validationRules: ["Both axes expose units and domains.", "Any fitted relationship is a separately versioned enrichment, not an observed value."],
    grammar: { mark: "point", layout: "orthogonal quantitative axes", encodings: ["x=x measure", "y=y measure", "size=optional magnitude", "color=group"], invariants: ["Axis zero and truncation choices are visible.", "Overplotting has a deterministic reveal strategy.", "Association is not labeled causation."] },
    variants: [variant("scatter", "Scatter", "Individual observations remain legible.", "Selectable points on two shared axes."), variant("binned-relationship", "Binned relationship", "Density causes severe overplotting.", "Deterministic cells with count and drill-through observations.")], repeatMedia: ["numeric-chart"], defaultRepeatMedia: "numeric-chart",
    controls: [control("group", "select", "Facet or color by a declared group."), control("scale", "segmented", "Use one declared linear or log scale preset.")], selections: [selection("point-or-density-cell", "Select an observation or density cell.")], followUps: ["What explains this outlier?", "Does the relationship hold within each group?", "Which sources support these coordinates?"],
  },
  {
    id: "matrix", group: "relate", title: "Matrix", summary: "Compare values at the intersections of two categorical dimensions.",
    answersWell: ["Which row/column combinations are strong, weak, missing, or unusual?", "Where do two categorical systems overlap?"], abstainsWhen: ["Rows or columns lack stable identity.", "Sparse cells would be mistaken for zero rather than missing."], examples: ["Which themes appear in which sources?", "How do capabilities map to user needs?"],
    requiredRoles: [role("row", "string", "Row category."), role("column", "string", "Column category."), role("value", "number", "Cell value.")], optionalRoles: [role("label", "string", "Cell annotation.")], minimumRecords: 2,
    transformDescription: "Build an explicit sparse row/column cell set while retaining missing cells as missing.", orderBy: [{ role: "row", direction: "asc" }, { role: "column", direction: "asc" }], markLabelRoles: ["row", "column"], collection: "cells",
    validationRules: ["Row/column pairs are unique or use a declared aggregation.", "Missing, zero, and unavailable remain distinct."],
    grammar: { mark: "cell or dot", layout: "aligned row and column headers", encodings: ["x=column", "y=row", "color or size=value"], invariants: ["Headers remain visible during navigation.", "Missingness has its own treatment.", "Ordering is stable or explicitly sorted."] },
    variants: [variant("heat-matrix", "Heat matrix", "Values share a meaningful sequential or diverging scale.", "Fixed cells with one tested color scale."), variant("dot-matrix", "Dot matrix", "Area is more legible than color or values are sparse.", "Centered dots with exact values on inspection.")], repeatMedia: ["numeric-chart", "image", "text"], defaultRepeatMedia: "numeric-chart",
    controls: [control("row-order", "select", "Choose one deterministic row ordering."), control("column-order", "select", "Choose one deterministic column ordering.")], selections: [selection("cell-or-band", "Select cells, a row, or a column.")], followUps: ["Why is this cell empty?", "Compare this row with its peers.", "Which sources contribute to this intersection?"],
  },
  {
    id: "hierarchy", group: "relate", title: "Hierarchy", summary: "Navigate explicit parent–child structure and relative magnitude.",
    answersWell: ["How is this collection nested?", "Where does a selected item sit within the whole structure?"], abstainsWhen: ["Parentage is ambiguous, cyclic, or inferred only from similarity.", "Cross-links matter more than containment."], examples: ["How are documents organized by topic?", "Which subparts account for this branch?"],
    requiredRoles: [role("id", "identifier", "Stable node id."), role("label", "string", "Node label.")], optionalRoles: [role("parentId", "identifier", "Parent node id; absent for roots."), role("value", "number", "Optional node magnitude.")], minimumRecords: 2,
    transformDescription: "Resolve explicit parent ids, detect cycles, and order siblings deterministically.", orderBy: [{ role: "parentId", direction: "asc" }, { role: "label", direction: "asc" }, { role: "id", direction: "asc" }], markLabelRoles: ["label"], collection: "nodes",
    validationRules: ["Every parent id resolves or is empty.", "The graph is acyclic.", "Derived parent totals never silently double-count children."],
    grammar: { mark: "node and parent–child edge", layout: "rooted tree or containment bands", encodings: ["position=depth and sibling order", "size=optional value", "edge=parentage"], invariants: ["Parentage is explicit.", "Depth remains readable.", "Collapsed branches report hidden descendants."] },
    variants: [variant("node-tree", "Node tree", "Links and ancestry are the primary reading task.", "Indented or spatial tree with collapsible branches."), variant("icicle", "Icicle", "Containment and relative magnitude are primary.", "Depth bands with explicit branch labels and drill-down.")], repeatMedia: ["numeric-chart", "image", "text", "document"], defaultRepeatMedia: "numeric-chart",
    controls: [control("depth", "range", "Limit visible hierarchy depth."), control("branch", "search", "Locate and focus a branch.")], selections: [selection("node-or-branch", "Select a node or its complete descendant branch.")], followUps: ["What belongs under this branch?", "Why was this parent assigned?", "Which branch contains the most evidence?"],
  },
  {
    id: "network", group: "relate", title: "Network", summary: "Inspect explicit many-to-many connections between entities.",
    answersWell: ["Which entities connect, cluster, bridge, or remain isolated?", "What is the neighborhood around a selected node or edge?"], abstainsWhen: ["Edges are merely weak similarity scores without a defensible threshold.", "A matrix or hierarchy would answer the question with less layout ambiguity."], examples: ["Which ideas repeatedly co-occur?", "Which people bridge otherwise separate groups?"],
    requiredRoles: [role("source", "identifier", "Edge source node."), role("target", "identifier", "Edge target node.")], optionalRoles: [role("weight", "number", "Edge weight."), role("relation", "string", "Typed relation."), role("label", "string", "Edge label.")], minimumRecords: 1,
    transformDescription: "Build a typed edge list and stable node index without force-layout coordinates.", orderBy: [{ role: "source", direction: "asc" }, { role: "target", direction: "asc" }, { role: "relation", direction: "asc" }], markLabelRoles: ["source", "target"], markLabelSeparator: " → ", collection: "edges",
    validationRules: ["Node ids are stable and edge direction is declared.", "Similarity edges expose method and threshold."],
    grammar: { mark: "node and edge", layout: "bounded deterministic or seeded network layout", encodings: ["edge=relation", "width=optional weight", "node grouping=declared type"], invariants: ["Layout is not treated as data.", "Dense networks have an adjacency or neighborhood fallback.", "Edge evidence is selectable."] },
    variants: [variant("node-link", "Node-link", "The network is sparse enough for paths and neighborhoods.", "Seeded layout with restrained labels."), variant("adjacency", "Adjacency", "Density makes paths unreadable.", "Ordered matrix preserving the same nodes and typed edges.")], repeatMedia: ["numeric-chart", "text"], defaultRepeatMedia: "numeric-chart",
    controls: [control("relation", "multi-select", "Show declared edge types."), control("neighborhood", "range", "Choose one bounded hop depth.")], selections: [selection("node-or-edge", "Select nodes or evidence-bearing edges.")], followUps: ["What connects these two nodes?", "Which node bridges these groups?", "Show only directly evidenced edges."],
  },
  {
    id: "flow", group: "relate", title: "Flow", summary: "Trace quantities moving between stages, states, or categories.",
    answersWell: ["Where does volume enter, split, merge, or leave a process?", "Which path accounts for a selected outcome?"], abstainsWhen: ["Links do not conserve or meaningfully represent quantity.", "The direction or stage order is speculative."], examples: ["How do items move through review states?", "Where does budget flow between programs?"],
    requiredRoles: [role("source", "string", "Origin node or state."), role("target", "string", "Destination node or state."), role("value", "number", "Non-negative flow magnitude.")], optionalRoles: [role("stage", "string", "Declared stage or interval."), role("label", "string", "Flow label.")], minimumRecords: 1,
    transformDescription: "Aggregate identical directed links deterministically while retaining contributing marks and exact values.", orderBy: [{ role: "stage", direction: "asc" }, { role: "source", direction: "asc" }, { role: "target", direction: "asc" }], markLabelRoles: ["source", "target"], markLabelSeparator: " → ", collection: "links",
    validationRules: ["Flow values are non-negative.", "Any conservation gap is measured and visible."],
    grammar: { mark: "directed link and stage node", layout: "ordered stages with bounded crossings", encodings: ["width=value", "direction=source to target", "column=stage"], invariants: ["Direction is visible.", "Thin flows remain selectable.", "Unaccounted input or output is shown explicitly."] },
    variants: [variant("sankey", "Sankey", "A few ordered stages carry conserved quantities.", "Weighted links between fixed stage columns."), variant("alluvial", "Alluvial", "Membership changes across repeated observations.", "Aligned categorical axes with stable cohort identity.")], repeatMedia: ["numeric-chart"], defaultRepeatMedia: "numeric-chart",
    controls: [control("stage", "select", "Focus one declared transition."), control("minimum-flow", "range", "Hide small links while reporting hidden volume.")], selections: [selection("flow-or-node", "Select a flow link or stage node.")], followUps: ["Where does this flow originate?", "What accounts for the loss here?", "Which records make up this path?"],
  },
  {
    id: "mechanism", group: "relate", title: "Mechanism", summary: "Explain how named components interact through typed, evidence-bearing links.",
    answersWell: ["How does this system or process work?", "Which component, dependency, or causal claim connects an input to an outcome?"], abstainsWhen: ["Links cannot be typed or grounded and would become decorative arrows.", "The evidence supports association but not mechanism."], examples: ["How does a request move through this system?", "Which components produce this behavior?"],
    requiredRoles: [role("source", "identifier", "Origin component."), role("target", "identifier", "Destination component."), role("relation", "string", "Typed interaction." )], optionalRoles: [role("label", "string", "Readable link label."), role("stage", "string", "Declared subsystem or phase."), role("weight", "number", "Optional strength or volume.")], minimumRecords: 1,
    transformDescription: "Build a typed component-link model, preserving evidence and never inferring causality from layout.", orderBy: [{ role: "stage", direction: "asc" }, { role: "source", direction: "asc" }, { role: "target", direction: "asc" }, { role: "relation", direction: "asc" }], markLabelRoles: ["source", "relation", "target"], markLabelSeparator: " · ", collection: "links",
    validationRules: ["Every link has an explicit relation type.", "Causal relations require causal evidence status rather than visual implication."],
    grammar: { mark: "component, port, and typed connector", layout: "bounded schematic with declared stages or layers", encodings: ["shape=component type", "connector style=relation", "position=declared stage or subsystem"], invariants: ["Arrows carry verbs.", "Layout proximity is not evidence.", "Every consequential link opens its grounds."] },
    variants: [variant("system-schematic", "System schematic", "Components and typed interactions are primary.", "Layered components with labeled connectors."), variant("exploded-mechanism", "Exploded mechanism", "A physical or visual specimen supplies component positions.", "Annotated component layers over or beside the specimen.")], repeatMedia: ["text", "image", "document", "3d-mixed"], defaultRepeatMedia: "text",
    mediaDecisions: { structured: "direct", text: "enrich", image: "enrich", video: "enrich", audio: "enrich", document: "enrich", geography: "abstain", mixed: "enrich" },
    controls: [control("relation", "multi-select", "Show declared interaction types."), control("stage", "select", "Focus a subsystem or phase.")], selections: [selection("component-or-link", "Select components or typed links.")], followUps: ["What evidence supports this connection?", "What happens if this component fails?", "Which link is inferred rather than observed?"],
  },
  {
    id: "region-map", group: "space", title: "Region map", summary: "Compare values attached to known geographic areas.",
    answersWell: ["How does a measure vary across regions?", "Which neighboring or peer regions differ?"], abstainsWhen: ["Geographic boundaries are missing, disputed, or too coarse for the claim.", "Raw counts would primarily reflect region size or population without an appropriate denominator."], examples: ["Where is adoption highest by district?", "How do outcomes differ across countries?"],
    requiredRoles: [role("region", "identifier", "Stable geographic feature id."), role("value", "number", "Region measure.")], optionalRoles: [role("label", "string", "Region label."), role("baseline", "number", "Comparison baseline or denominator.")], minimumRecords: 1,
    transformDescription: "Join exact values to declared feature ids and retain unmatched regions as validation failures or visible omissions.", orderBy: [{ role: "region", direction: "asc" }], markLabelRoles: ["label", "region"], collection: "regions",
    validationRules: ["Every region id resolves in the declared geography.", "Counts and rates name their denominator.", "Projection and boundary version are recorded."],
    grammar: { mark: "geographic region", layout: "declared projection and extent", encodings: ["fill or symbol=value", "boundary=declared feature geometry"], invariants: ["A legend and no-data state are visible.", "Area is not mistaken for value.", "Compared maps share projection, extent, and scale."] },
    variants: [variant("choropleth", "Choropleth", "Normalized values attach to complete regions.", "Tested sequential or diverging fill scale."), variant("region-symbols", "Region symbols", "Raw magnitudes or tiny regions make fill misleading.", "Comparable symbols anchored to region centroids with boundary context.")], repeatMedia: ["geography", "numeric-chart"], defaultRepeatMedia: "geography", geographyRenderer: true,
    mediaDecisions: { structured: "deterministic", text: "enrich", image: "abstain", video: "abstain", audio: "abstain", document: "enrich", geography: "direct", mixed: "enrich" },
    controls: [control("measure", "select", "Choose a declared value or rate."), control("time", "select", "Choose a comparable period when present.")], selections: [selection("region", "Select one or more geographic features.")], followUps: ["Why does this region differ?", "Compare neighboring regions.", "Which denominator produced this value?"],
  },
  {
    id: "point-map", group: "space", title: "Point map", summary: "Locate discrete observations at exact geographic coordinates.",
    answersWell: ["Where are these events or objects?", "Which places cluster, isolate, or sit near a selected location?"], abstainsWhen: ["Coordinates are inferred too coarsely or reveal sensitive locations.", "Aggregation to regions would be more honest than apparent point precision."], examples: ["Where did these incidents occur?", "Which sites are near this route?"],
    requiredRoles: [role("latitude", "latitude", "Latitude in decimal degrees."), role("longitude", "longitude", "Longitude in decimal degrees.")], optionalRoles: [role("label", "string", "Point label."), role("value", "number", "Optional point magnitude."), role("group", "string", "Declared point group.")], minimumRecords: 1,
    transformDescription: "Validate coordinates, retain exact points, and derive no geographic precision beyond the source.", orderBy: [{ role: "latitude", direction: "asc" }, { role: "longitude", direction: "asc" }, { role: "label", direction: "asc" }], markLabelRoles: ["label", "latitude", "longitude"], collection: "points",
    validationRules: ["Latitude and longitude are in range.", "Coordinate precision and privacy transformations are recorded."],
    grammar: { mark: "geographic point or deterministic cluster", layout: "interactive or fixed projected map", encodings: ["position=longitude/latitude", "size=optional value", "color=group"], invariants: ["Clusters expose their members.", "Jitter or privacy displacement is visible.", "Compared maps share projection and extent."] },
    variants: [variant("dot-map", "Dot map", "Points remain legible at the chosen extent.", "Direct selectable point marks."), variant("point-clusters", "Point clusters", "Density would overplot points.", "Deterministic zoom-dependent clusters with exact member counts.")], repeatMedia: ["geography", "image", "numeric-chart"], defaultRepeatMedia: "geography", geographyRenderer: true,
    mediaDecisions: { structured: "direct", text: "enrich", image: "deterministic", video: "deterministic", audio: "enrich", document: "enrich", geography: "direct", mixed: "enrich" },
    controls: [control("extent", "map-navigation", "Pan or zoom without changing source coordinates."), control("group", "multi-select", "Show declared point groups.")], selections: [selection("point-or-cluster", "Select points or a cluster that resolves to exact members.")], followUps: ["What happened at this location?", "Which points are nearest?", "Why are these places clustered?"],
  },
  {
    id: "field", group: "space", title: "Field", summary: "Show a continuous or sampled value across constructed or physical space.",
    answersWell: ["Where are peaks, troughs, boundaries, or gradients?", "How does a measured field vary across two dimensions?"], abstainsWhen: ["Samples are too sparse for the proposed interpolation.", "Constructed coordinates have no stable interpretation."], examples: ["Where is temperature highest?", "Where are semantic density and uncertainty concentrated?"],
    requiredRoles: [role("x", "number", "Horizontal coordinate."), role("y", "number", "Vertical coordinate."), role("value", "number", "Observed field value.")], optionalRoles: [role("label", "string", "Sample label."), role("uncertainty", "number", "Measurement or interpolation uncertainty.")], minimumRecords: 3,
    transformDescription: "Retain exact samples and extents; interpolation remains a named renderer variant with fixed parameters.", orderBy: [{ role: "x", direction: "asc" }, { role: "y", direction: "asc" }, { role: "label", direction: "asc" }], markLabelRoles: ["label", "x", "y"], collection: "samples",
    validationRules: ["Coordinates and values are finite.", "Interpolation method, resolution, and uncertainty are visible."],
    grammar: { mark: "sample, contour, or raster cell", layout: "bounded two-dimensional field", encodings: ["position=x/y", "color or contour=value", "opacity or hatching=uncertainty"], invariants: ["Observed samples remain inspectable.", "Interpolation is distinguished from observation.", "The color scale is fixed and labeled."] },
    variants: [variant("contours", "Contours", "Gradients and thresholds are the primary task.", "Fixed contour levels over visible samples."), variant("sample-raster", "Sample raster", "A regular grid is observed or defensibly interpolated.", "Fixed-resolution cells with sample and uncertainty overlay.")], repeatMedia: ["numeric-chart", "image", "geography"], defaultRepeatMedia: "numeric-chart",
    controls: [control("surface", "segmented", "Switch samples, one tested contour preset, or one tested raster preset."), control("threshold", "range", "Inspect one field threshold.")], selections: [selection("sample-or-region", "Select samples or a bounded field region.")], followUps: ["Which observations create this peak?", "How uncertain is this boundary?", "What changes above this threshold?"],
  },
  {
    id: "collection-atlas", group: "browse", title: "Collection atlas", summary: "Navigate a large text or media collection through stable two-dimensional similarity coordinates.",
    answersWell: ["What neighborhoods, gaps, clusters, and outliers organize this collection?", "Which nearby items deserve comparison or inspection?"], abstainsWhen: ["Coordinates are unstable, opaque, or too weak to support neighborhood claims.", "The collection is small enough for a simpler list, matrix, or sequence."], examples: ["How is this image archive organized?", "Which notes occupy similar semantic neighborhoods?"],
    requiredRoles: [role("x", "number", "Stable atlas x coordinate."), role("y", "number", "Stable atlas y coordinate."), role("label", "string", "Item label.")], optionalRoles: [role("cluster", "string", "Bounded cluster or region label."), role("similarity", "number", "Optional neighborhood strength."), role("order", "number", "Optional local order.")], minimumRecords: 2,
    transformDescription: "Project already-derived stable coordinates into selectable atlas marks and retain cluster and media metadata.", orderBy: [{ role: "cluster", direction: "asc" }, { role: "label", direction: "asc" }], markLabelRoles: ["label"], collection: "items",
    validationRules: ["Coordinate method, seed, and version are recorded upstream.", "Cluster labels are bounded enrichment, not ground truth.", "Nearest-neighbor claims retain exact item ids and method."],
    grammar: { mark: "collection item, thumbnail, or point", layout: "zoomable two-dimensional atlas with overview-to-detail levels", encodings: ["position=x/y", "preview=source medium", "region=cluster", "proximity=derived similarity"], invariants: ["Zoom changes detail, not semantic coordinates.", "Dense mixed media follows the repeat-layout policy.", "Every item remains one move from evidence."] },
    variants: [variant("semantic-field", "Semantic field", "Thousands of items require a calm overview before previews.", "Points and region labels reveal thumbnails or passages with zoom."), variant("contact-atlas", "Contact atlas", "Visual comparison of media is primary and density permits previews.", "Type-aware contact sheet positioned by atlas coordinates.")], repeatMedia: ["image", "video", "audio", "text", "document", "3d-mixed"], defaultRepeatMedia: "3d-mixed",
    mediaDecisions: { structured: "deterministic", text: "deterministic", image: "deterministic", video: "deterministic", audio: "deterministic", document: "deterministic", geography: "deterministic", mixed: "enrich" },
    controls: [control("viewport", "pan-zoom", "Navigate the stable atlas coordinate system."), control("cluster", "multi-select", "Focus bounded derived regions."), control("media", "multi-select", "Show available media types.")], selections: [selection("item-or-region", "Select collection items or a bounded atlas region.")], followUps: ["What do these nearby items have in common?", "Why is this item an outlier?", "Compare this region with the neighboring one."],
  },
  {
    id: "annotated-specimen", group: "space", title: "Annotated specimen", summary: "Locate evidence-linked callouts and layers on a source image, frame, page, or document.",
    answersWell: ["What should I notice in this specimen, and exactly where is it?", "How do labeled regions, layers, or observations relate to the source object?"], abstainsWhen: ["The source cannot be displayed or annotations lack exact locators.", "Callouts would assert interpretation without evidence or obscure the specimen."], examples: ["Explain this historical chart in place.", "Where do these interface problems appear in the screenshot?"],
    requiredRoles: [role("specimen", "identifier", "Stable specimen id."), role("label", "string", "Annotation label."), role("x", "ratio", "Normalized horizontal anchor."), role("y", "ratio", "Normalized vertical anchor.")], optionalRoles: [role("layer", "string", "Declared annotation layer."), role("width", "ratio", "Normalized region width."), role("height", "ratio", "Normalized region height."), role("order", "number", "Callout order.")], minimumRecords: 1,
    transformDescription: "Attach bounded annotations to normalized specimen coordinates while preserving source-region evidence.", orderBy: [{ role: "specimen", direction: "asc" }, { role: "layer", direction: "asc" }, { role: "order", direction: "asc" }, { role: "label", direction: "asc" }], markLabelRoles: ["label"], collection: "annotations",
    validationRules: ["Anchor and region coordinates fall within the normalized specimen bounds.", "Every annotation resolves to a source region, page region, frame, or time range."],
    grammar: { mark: "callout anchor, region, connector, or layer", layout: "source specimen with non-obscuring annotation margins", encodings: ["position=x/y on specimen", "region=width/height", "style=declared layer"], invariants: ["The source remains legible.", "Callout connectors do not imply relationships between annotations.", "Annotations can be hidden and restored by layer."] },
    variants: [variant("callout-overlay", "Callout overlay", "A few annotations can sit beside a readable specimen.", "Margin labels with restrained leaders into exact regions."), variant("layered-lens", "Layered lens", "Several annotation systems must coexist without visual noise.", "One active layer at a time with a compact layer index.")], repeatMedia: ["image", "video", "document", "text", "3d-mixed"], defaultRepeatMedia: "image",
    mediaDecisions: { structured: "enrich", text: "deterministic", image: "direct", video: "deterministic", audio: "abstain", document: "direct", geography: "deterministic", mixed: "enrich" },
    controls: [control("layer", "multi-select", "Show declared annotation layers."), control("zoom", "pan-zoom", "Inspect the specimen without moving annotation anchors.")], selections: [selection("annotation-or-region", "Select a callout or annotated source region.")], followUps: ["Why is this region important?", "Show the exact evidence for this annotation.", "Compare annotations across layers."],
  },
];

export function validateMapFamilyManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw contractError("must be an object");
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION || manifest.kind !== "attend-map-family") throw contractError("has an unsupported kind or schemaVersion");
  if (!/^[a-z][a-z0-9-]{1,63}$/u.test(manifest.id ?? "")) throw contractError("id must be a stable kebab-case identifier", "manifest.id");
  if (!Number.isSafeInteger(manifest.version) || manifest.version < 1) throw contractError("version must be a positive integer", `manifest.${manifest.id}.version`);
  if (!GROUP_IDS.has(manifest.group)) throw contractError("group is not registered", `manifest.${manifest.id}.group`);
  for (const field of ["title", "summary", "maturity"]) {
    if (!nonEmptyString(manifest[field])) throw contractError(`${field} must be a non-empty string`, `manifest.${manifest.id}.${field}`);
  }
  for (const field of ["answersWell", "abstainsWhen", "examples"]) {
    if (!Array.isArray(manifest.questions?.[field]) || manifest.questions[field].length === 0 || !manifest.questions[field].every(nonEmptyString)) {
      throw contractError(`questions.${field} must contain non-empty guidance`, `manifest.${manifest.id}.questions.${field}`);
    }
  }
  const requiredRoles = manifest.data?.requiredRoles;
  const optionalRoles = manifest.data?.optionalRoles;
  if (!Array.isArray(requiredRoles) || requiredRoles.length === 0 || !Array.isArray(optionalRoles)) throw contractError("data roles are incomplete", `manifest.${manifest.id}.data`);
  const roles = [...requiredRoles, ...optionalRoles];
  const roleIds = new Set();
  for (const item of roles) {
    if (!/^[a-z][A-Za-z0-9]*$/u.test(item?.id ?? "") || roleIds.has(item.id)) throw contractError("role ids must be unique identifiers", `manifest.${manifest.id}.data`);
    roleIds.add(item.id);
    if (!Array.isArray(item.types) || item.types.length === 0 || item.types.some((type) => !ROLE_TYPES.has(type))) throw contractError(`role ${item.id} has unsupported types`, `manifest.${manifest.id}.data`);
    if (!nonEmptyString(item.description)) throw contractError(`role ${item.id} needs a description`, `manifest.${manifest.id}.data`);
  }
  if (!Number.isSafeInteger(manifest.data.minimumRecords) || manifest.data.minimumRecords < 1 || !Number.isSafeInteger(manifest.data.maximumRecords) || manifest.data.maximumRecords < manifest.data.minimumRecords) throw contractError("record bounds are invalid", `manifest.${manifest.id}.data`);

  if (!Array.isArray(manifest.mediaAdapters) || manifest.mediaAdapters.length !== CANONICAL_INPUT_MEDIA.length) throw contractError("mediaAdapters must cover every canonical input medium", `manifest.${manifest.id}.mediaAdapters`);
  const adapterMedia = new Set();
  for (const adapter of manifest.mediaAdapters) {
    if (!CANONICAL_INPUT_MEDIA.includes(adapter?.medium) || adapterMedia.has(adapter.medium)) throw contractError("mediaAdapters contain a duplicate or unknown medium", `manifest.${manifest.id}.mediaAdapters`);
    adapterMedia.add(adapter.medium);
    if (!["direct", "deterministic", "enrich", "abstain"].includes(adapter.decision)) throw contractError("media adapter decision is invalid", `manifest.${manifest.id}.mediaAdapters.${adapter.medium}`);
    if (!Array.isArray(adapter.fieldsExtracted) || !nonEmptyString(adapter.evidenceLocatorKind) || !nonEmptyString(adapter.previewTreatment) || !nonEmptyString(adapter.reason)) throw contractError("media adapter must specify fields, evidence locator, preview, and reason", `manifest.${manifest.id}.mediaAdapters.${adapter.medium}`);
    if (adapter.decision === "abstain" && (adapter.fieldsExtracted.length !== 0 || adapter.evidenceLocatorKind !== "none" || adapter.previewTreatment !== "none")) throw contractError("abstaining adapters cannot claim extracted fields or previews", `manifest.${manifest.id}.mediaAdapters.${adapter.medium}`);
  }
  if (adapterMedia.size !== CANONICAL_INPUT_MEDIA.length) throw contractError("mediaAdapters coverage is incomplete", `manifest.${manifest.id}.mediaAdapters`);

  if (!manifest.transformation?.deterministic || !nonEmptyString(manifest.transformation.id) || !Number.isSafeInteger(manifest.transformation.version) || !Array.isArray(manifest.transformation.orderBy) || !Array.isArray(manifest.transformation.markLabelRoles) || !nonEmptyString(manifest.transformation.payload?.kind) || !nonEmptyString(manifest.transformation.payload?.collection)) throw contractError("deterministic transformation contract is incomplete", `manifest.${manifest.id}.transformation`);
  if (manifest.enrichment?.mode !== "optional-bounded" || !Number.isSafeInteger(manifest.enrichment.maximumPatches) || manifest.enrichment.maximumPatches < 0 || !Array.isArray(manifest.enrichment.allowedFields) || manifest.enrichment.requiresInputEvidence !== true) throw contractError("bounded enrichment contract is incomplete", `manifest.${manifest.id}.enrichment`);
  if (manifest.validation?.mode !== "fail-closed" || !Array.isArray(manifest.validation.rules) || manifest.validation.rules.length === 0 || manifest.evidence?.required !== true || manifest.evidence?.granularity !== "per-mark") throw contractError("validation and evidence contracts are incomplete", `manifest.${manifest.id}`);
  if (!nonEmptyString(manifest.grammar?.mark) || !nonEmptyString(manifest.grammar?.layout) || !Array.isArray(manifest.grammar.encodings) || !Array.isArray(manifest.grammar.invariants) || manifest.grammar.invariants.length === 0) throw contractError("fixed grammar is incomplete", `manifest.${manifest.id}.grammar`);
  if (!Array.isArray(manifest.variants) || manifest.variants.length < 2 || manifest.variants.some((item) => !nonEmptyString(item?.id) || !nonEmptyString(item?.label) || !nonEmptyString(item?.when) || !nonEmptyString(item?.grammarDelta))) throw contractError("at least two bounded variants are required", `manifest.${manifest.id}.variants`);
  if (manifest.multiples?.policy?.id !== REPEAT_LAYOUT_POLICY.id || !Array.isArray(manifest.multiples.supportedMedia) || manifest.multiples.supportedMedia.length === 0 || !manifest.multiples.supportedMedia.includes(manifest.multiples.defaultMedia) || manifest.multiples.supportedMedia.some((id) => !REPEAT_LAYOUT_PROFILES[id]) || !Array.isArray(manifest.multiples.profiles) || manifest.multiples.profiles.length !== manifest.multiples.supportedMedia.length) throw contractError("repeat-layout contract is invalid", `manifest.${manifest.id}.multiples`);
  for (const profile of manifest.multiples.profiles) {
    if (!manifest.multiples.supportedMedia.includes(profile.id) || !["direct", "deterministic", "enrich", "abstain"].includes(profile.adaptationDecision) || !Number.isFinite(profile.minimumReadableUnit?.width) || !Number.isFinite(profile.minimumReadableUnit?.height) || !Array.isArray(profile.layouts) || !Array.isArray(profile.quantityBands) || !nonEmptyString(profile.selectionBehavior)) throw contractError("repeat-layout media profile is incomplete", `manifest.${manifest.id}.multiples.${profile?.id ?? "unknown"}`);
  }
  for (const field of ["controls", "selections", "followUps"]) {
    if (!Array.isArray(manifest[field]) || manifest[field].length === 0) throw contractError(`${field} must be non-empty`, `manifest.${manifest.id}.${field}`);
  }
  if (!nonEmptyString(manifest.renderer?.id) || !Number.isSafeInteger(manifest.renderer.version) || !nonEmptyString(manifest.renderer.maturity)) throw contractError("renderer id, version, and maturity are required", `manifest.${manifest.id}.renderer`);
  return manifest;
}

export const MAP_FAMILIES = deepFreeze(FAMILY_DEFINITIONS.map(family));
const FAMILY_BY_ID = new Map(MAP_FAMILIES.map((manifest) => [manifest.id, manifest]));

export function validateMapFamilyRegistry(families = MAP_FAMILIES) {
  if (!Array.isArray(families) || families.length === 0) throw contractError("registry must be a non-empty array", "registry");
  const ids = new Set();
  for (const manifest of families) {
    validateMapFamilyManifest(manifest);
    if (ids.has(manifest.id)) throw contractError(`duplicate family id ${manifest.id}`, "registry");
    ids.add(manifest.id);
  }
  return families;
}

export function getMapFamily(id) {
  return typeof id === "string" ? FAMILY_BY_ID.get(id) ?? null : null;
}

export function requireMapFamily(id) {
  const manifest = getMapFamily(id);
  if (manifest) return manifest;
  const error = new RangeError(`Unknown map family: ${String(id)}`);
  error.code = "UNKNOWN_MAP_FAMILY";
  throw error;
}

export function listMapFamilies({ group } = {}) {
  if (group === undefined) return [...MAP_FAMILIES];
  if (!GROUP_IDS.has(group)) throw new RangeError(`Unknown map family group: ${String(group)}`);
  return MAP_FAMILIES.filter((manifest) => manifest.group === group);
}

validateMapFamilyRegistry();
