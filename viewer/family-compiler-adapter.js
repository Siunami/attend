import {
  catalogReceiptForMember,
} from "./package-model.js";
import { GENERATED_FORM_RUNTIME } from "./form-runtime-generated.js";

const generatedFormByKey = new Map(GENERATED_FORM_RUNTIME.forms.map((form) => [form.key, form]));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function roleField(dataset, role) {
  return dataset.roles?.[role];
}

function roleValue(dataset, record, role) {
  const field = roleField(dataset, role);
  return typeof field === "string" ? record?.[field] : undefined;
}

function compact(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

function semanticProjection(dataset, record, aliases) {
  return compact(Object.fromEntries(
    Object.entries(aliases).map(([semanticRole, fixtureRole]) => [semanticRole, roleValue(dataset, record, fixtureRole)]),
  ));
}

function evidenceReferences(dataset, owner) {
  const evidenceField = roleField(dataset, "evidence") ?? "evidenceRefs";
  const evidenceById = new Map(dataset.evidence.map((evidence) => [evidence.id, evidence]));
  return (owner?.[evidenceField] ?? owner?.evidenceRefs ?? []).map((evidenceId) => {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) throw new TypeError(`${dataset.familyId}: unknown fixture evidence ${String(evidenceId)}`);
    return {
      sourceId: evidence.sourceId,
      locator: evidence.locator,
      excerpt: evidence.excerpt,
    };
  });
}

function mediaFor(dataset, owner, evidenceRefs) {
  const previewField = roleField(dataset, "preview");
  const mediaTypeField = roleField(dataset, "mediaType");
  const sourceById = new Map(dataset.sources.map((source) => [source.id, source]));
  const evidenceSource = sourceById.get(evidenceRefs[0]?.sourceId);
  const type = (typeof mediaTypeField === "string" ? owner?.[mediaTypeField] : undefined)
    ?? evidenceSource?.mediaType
    ?? dataset.mediaType;
  const preview = (typeof previewField === "string" ? owner?.[previewField] : undefined)
    ?? (dataset.familyId === "annotated-specimen" ? dataset.specimen?.preview : undefined);
  return compact({ type, preview });
}

function normalizedRecord(dataset, owner, id, fields) {
  const evidenceRefs = evidenceReferences(dataset, owner);
  const sourceId = evidenceRefs[0]?.sourceId;
  if (!sourceId) throw new TypeError(`${dataset.familyId}/${id}: fixture record needs evidence`);
  return {
    id,
    sourceId,
    fields: compact(fields),
    evidenceRefs,
    media: mediaFor(dataset, owner, evidenceRefs),
  };
}

const RECORD_PROJECTIONS = Object.freeze({
  rank: { label: "label", value: "value", group: "group" },
  distribution: { value: "value", label: "label", group: "group" },
  composition: { part: "part", value: "value", whole: "series" },
  "passage-comparison": { passage: "text", version: "version", label: "stance" },
  trend: { time: "x", value: "y", series: "series", label: "annotation" },
  timeline: { time: "start", endTime: "end", label: "label", lane: "group", status: "status" },
  sequence: { order: "order", label: "label", stage: "mediaType" },
  relationship: { x: "x", y: "y", label: "label", group: "group" },
  matrix: { row: "row", column: "column", value: "value", label: "annotation" },
  hierarchy: { id: "id", parentId: "parent", label: "label", value: "value" },
  "region-map": { region: "region", value: "value", label: "label", baseline: "baseline" },
  "point-map": { latitude: "latitude", longitude: "longitude", label: "label", value: "value", group: "category" },
  field: { x: "x", y: "y", value: "value", label: "yLabel" },
  "collection-atlas": { x: "x", y: "y", label: "label", cluster: "category" },
  "annotated-specimen": { label: "label", x: "x", y: "y", layer: "layer", width: "width", height: "height" },
});

function recordsForProfile(dataset) {
  const measures = roleField(dataset, "measures") ?? [];
  return dataset.records.flatMap((record) => measures.map((measure) => normalizedRecord(
    dataset,
    record,
    `${record.id}-${measure}`,
    {
      entity: roleValue(dataset, record, "label"),
      dimension: measure,
      value: record[measure],
    },
  )));
}

function recordsForLinks(dataset) {
  const projections = {
    network: { source: "source", target: "target", weight: "value", relation: "linkType", label: "linkType" },
    flow: { source: "source", target: "target", value: "value", stage: "stage", label: "linkType" },
    mechanism: { source: "source", target: "target", relation: "linkType", label: "linkType", weight: "value" },
  };
  const idField = roleField(dataset, "id") ?? "id";
  const evidenceField = roleField(dataset, "evidence") ?? "evidenceRefs";
  const nodesById = new Map(dataset.records.map((record) => [String(record[idField]), record]));
  return dataset.links.map((link) => {
    const source = nodesById.get(String(link.source));
    const target = nodesById.get(String(link.target));
    const owner = {
      ...link,
      [evidenceField]: [...new Set([
        ...(link[evidenceField] ?? []),
        ...(source?.[evidenceField] ?? []),
        ...(target?.[evidenceField] ?? []),
      ])],
    };
    return normalizedRecord(
      dataset,
      owner,
      link.id,
      semanticProjection(dataset, link, projections[dataset.familyId]),
    );
  });
}

function recordsForFamily(dataset) {
  if (dataset.familyId === "profile") return recordsForProfile(dataset);
  if (["network", "flow", "mechanism"].includes(dataset.familyId)) return recordsForLinks(dataset);
  const projection = RECORD_PROJECTIONS[dataset.familyId];
  if (!projection) throw new TypeError(`${dataset.familyId}: no gallery compiler projection is registered`);
  const passageOrderByVersion = new Map();
  return dataset.records.map((record, index) => {
    const fields = semanticProjection(dataset, record, projection);
    if (dataset.familyId === "passage-comparison") {
      const witness = String(fields.version);
      fields.order = passageOrderByVersion.get(witness) ?? 0;
      passageOrderByVersion.set(witness, fields.order + 1);
    }
    if (dataset.familyId === "collection-atlas") fields.order = index;
    if (dataset.familyId === "annotated-specimen") {
      fields.specimen = dataset.specimen.sourceId;
      fields.order = index;
    }
    return normalizedRecord(dataset, record, record.id, fields);
  });
}

async function sourceForCompiler(source) {
  const fixtureIdentity = canonicalJson(source);
  return compact({
    id: source.id,
    displayPath: source.locator?.path ?? `fixture/${source.id}`,
    sha256: await sha256Hex(fixtureIdentity),
    kind: source.kind,
    byteLength: new TextEncoder().encode(fixtureIdentity).byteLength,
    title: source.title,
    date: source.date,
    mediaType: source.mediaType,
  });
}

export function formFixtureDataset(familyId, memberId, familySample = {}) {
  const form = generatedFormByKey.get(`${familyId}/${memberId}`);
  if (!form?.fixture || form.fixture.familyId !== familyId || form.fixture.memberId !== memberId) {
    throw new TypeError(`No generated browser fixture for ${String(familyId)}/${String(memberId)}`);
  }
  const memberName = String(memberId).replaceAll("-", " ");
  return {
    kind: "attend-generated-form-fixture",
    fixtureId: form.fixture.id,
    familyId,
    memberId,
    adapter: form.fixture.adapter,
    roleMapping: form.fixture.roleMapping,
    records: form.fixture.records,
    mediaType: form.fixture.adapter === "local-image-set-v1" ? "image" : "structured",
    title: familySample.title ? `${familySample.title} · ${memberName}` : `${familyId} · ${memberName}`,
    question: familySample.question ?? `How does the ${memberName} form answer this question?`,
  };
}

function generatedFixtureMedia(dataset, record) {
  if (dataset.adapter !== "local-image-set-v1") return undefined;
  return {
    type: "image",
    mimeType: "image/jpeg",
    width: record.width,
    height: record.height,
    preview: {
      kind: "image",
      src: record.previewRoute,
      aspectRatio: Number(record.width) / Number(record.height),
    },
  };
}

async function generatedFixtureCompilerParts(dataset) {
  const sourceId = "generated_form_fixture";
  const displayPath = `fixtures/${dataset.fixtureId}.json`;
  const identity = canonicalJson({
    fixtureId: dataset.fixtureId,
    adapter: dataset.adapter,
    roleMapping: dataset.roleMapping,
    records: dataset.records,
  });
  const source = {
    id: sourceId,
    displayPath,
    sha256: await sha256Hex(identity),
    kind: "generated-form-fixture",
    byteLength: new TextEncoder().encode(identity).byteLength,
    title: dataset.title,
    mediaType: dataset.mediaType,
    ...(dataset.mediaType === "image" ? { mimeType: "image/jpeg" } : {}),
  };
  const records = dataset.records.map((record, index) => {
    const id = `fixture_record_${String(index + 1).padStart(5, "0")}`;
    return {
      id,
      sourceId,
      fields: { ...record },
      evidenceRefs: [{
        sourceId,
        recordId: id,
        locator: { kind: "row", path: displayPath, row: index + 1 },
        quote: canonicalJson(record),
      }],
      ...(generatedFixtureMedia(dataset, record) ? { media: generatedFixtureMedia(dataset, record) } : {}),
    };
  });
  return { source, records };
}

/**
 * Compile-only adapter for the gallery's synthetic source fixtures.
 * Production source adapters hash actual source bytes before producing the same bundle shape.
 */
export async function toCompilerRequest(dataset, manifest, { availableWidth = 1_200, memberId } = {}) {
  if (!dataset || dataset.familyId !== manifest?.id) throw new TypeError("dataset and manifest family ids must match");
  if (typeof memberId !== "string" || !memberId) throw new TypeError("gallery compilation requires an exact memberId");
  if (dataset.kind === "attend-generated-form-fixture" && dataset.memberId !== memberId) {
    throw new TypeError("generated fixture and requested member ids must match exactly");
  }
  const catalog = catalogReceiptForMember(dataset.familyId, memberId);
  const generated = dataset.kind === "attend-generated-form-fixture"
    ? await generatedFixtureCompilerParts(dataset)
    : null;
  const records = generated?.records ?? recordsForFamily(dataset);
  const required = manifest.data.requiredRoles.map((role) => role.id);
  const optional = manifest.data.optionalRoles.map((role) => role.id);
  const presentRoles = new Set(records.flatMap((record) => Object.keys(record.fields)));
  const roleMapping = generated
    ? { ...dataset.roleMapping }
    : Object.fromEntries(
        [...required, ...optional]
          .filter((role) => required.includes(role) || presentRoles.has(role))
          .map((role) => [role, role]),
      );
  return {
    catalog,
    familyId: dataset.familyId,
    question: {
      text: dataset.question,
      target: dataset.title,
      analyticJob: dataset.familyId,
    },
    sourceBundle: {
      kind: "attend-normalized-source-bundle",
      schemaVersion: 1,
      adapter: { id: generated ? dataset.adapter : "gallery_fixture", version: 1 },
      medium: dataset.mediaType,
      requestedInputs: generated
        ? [generated.source.displayPath]
        : dataset.sources.map((source) => source.locator?.path ?? source.id),
      knownOmissions: [generated && dataset.adapter === "local-image-set-v1"
        ? "Generated contact-atlas fixture: staged image previews are intentionally unavailable in Family Lab."
        : "Synthetic demonstration data; source hashes cover fixture metadata, not external files."],
      sources: generated ? [generated.source] : await Promise.all(dataset.sources.map(sourceForCompiler)),
      records,
    },
    roleMapping,
    options: {
      availableWidth,
    },
  };
}

export default toCompilerRequest;
