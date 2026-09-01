import { requireMapFamily } from "./map-families/registry.js";
import { getExecutableForm } from "./forms/index.js";

export const REPRESENTATION_INTENT_VERSION = 1;
export const REPRESENTATION_INTENT_MODES = Object.freeze(["open", "exact"]);

const INTENT_KEYS = new Set(["version", "mode", "constraints"]);
const CONSTRAINT_KEYS = new Set(["kind", "value"]);
const SAFE_FORM = /^[a-z][a-z0-9-]{0,127}$/u;
const CONSTRAINT_VALUES = Object.freeze({
  dimensionality: Object.freeze(["2d", "3d"]),
  interaction: Object.freeze(["selection", "pan-zoom", "orbit", "custom"]),
  motion: Object.freeze(["static", "animated", "custom"]),
  projection: Object.freeze(["cartesian", "geographic", "none", "orthographic", "perspective", "custom"]),
});
const CARTESIAN_FAMILIES = new Set([
  "rank",
  "distribution",
  "composition",
  "profile",
  "trend",
  "timeline",
  "sequence",
  "relationship",
  "matrix",
  "field",
]);
const GEOGRAPHIC_FAMILIES = new Set(["region-map", "point-map"]);

export class RepresentationIntentContractError extends TypeError {
  constructor(code, message, path = "representationIntent") {
    super(`${path}: ${message}`);
    this.name = "RepresentationIntentContractError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path) {
  throw new RepresentationIntentContractError(code, message, path);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknownKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("INVALID_REPRESENTATION_INTENT", `unknown field ${key}`, `${path}.${key}`);
  }
}

function normalizeConstraint(value, index, path) {
  const constraintPath = `${path}.constraints[${index}]`;
  if (!isPlainObject(value)) fail("INVALID_REPRESENTATION_INTENT", "must be an object", constraintPath);
  rejectUnknownKeys(value, CONSTRAINT_KEYS, constraintPath);
  if (typeof value.kind !== "string" || !["form", ...Object.keys(CONSTRAINT_VALUES)].includes(value.kind)) {
    fail(
      "INVALID_REPRESENTATION_INTENT",
      "kind must be form, dimensionality, interaction, motion, or projection",
      `${constraintPath}.kind`,
    );
  }
  if (typeof value.value !== "string") {
    fail("INVALID_REPRESENTATION_INTENT", "value must be a string", `${constraintPath}.value`);
  }
  if (value.kind === "form") {
    if (!SAFE_FORM.test(value.value)) {
      fail("INVALID_REPRESENTATION_INTENT", "form must be a safe catalog-style identifier", `${constraintPath}.value`);
    }
  } else if (!CONSTRAINT_VALUES[value.kind].includes(value.value)) {
    fail(
      "INVALID_REPRESENTATION_INTENT",
      `${value.kind} must be one of ${CONSTRAINT_VALUES[value.kind].join(", ")}`,
      `${constraintPath}.value`,
    );
  }
  return { kind: value.kind, value: value.value };
}

export function openRepresentationIntent() {
  return { version: REPRESENTATION_INTENT_VERSION, mode: "open", constraints: [] };
}

export function normalizeRepresentationIntent(value, {
  path = "representationIntent",
  required = false,
} = {}) {
  if (value === undefined) {
    if (required) fail("MISSING_REPRESENTATION_INTENT", "is required", path);
    return openRepresentationIntent();
  }
  if (!isPlainObject(value)) fail("INVALID_REPRESENTATION_INTENT", "must be an object", path);
  rejectUnknownKeys(value, INTENT_KEYS, path);
  if (value.version !== REPRESENTATION_INTENT_VERSION) {
    fail(
      "INVALID_REPRESENTATION_INTENT",
      `version must be ${REPRESENTATION_INTENT_VERSION}`,
      `${path}.version`,
    );
  }
  if (!REPRESENTATION_INTENT_MODES.includes(value.mode)) {
    fail("INVALID_REPRESENTATION_INTENT", "mode must be open or exact", `${path}.mode`);
  }
  if (!Array.isArray(value.constraints)) {
    fail("INVALID_REPRESENTATION_INTENT", "constraints must be an array", `${path}.constraints`);
  }
  if (value.constraints.length > 16) {
    fail("INVALID_REPRESENTATION_INTENT", "constraints must contain at most 16 entries", `${path}.constraints`);
  }
  const constraints = value.constraints.map((constraint, index) => normalizeConstraint(constraint, index, path));
  if (value.mode === "open" && constraints.length !== 0) {
    fail("INVALID_REPRESENTATION_INTENT", "open mode cannot contain constraints", `${path}.constraints`);
  }
  if (value.mode === "exact" && constraints.length === 0) {
    fail("INVALID_REPRESENTATION_INTENT", "exact mode requires at least one constraint", `${path}.constraints`);
  }
  const seen = new Set();
  constraints.forEach((constraint, index) => {
    const key = `${constraint.kind}\u0000${constraint.value}`;
    if (seen.has(key)) {
      fail(
        "INVALID_REPRESENTATION_INTENT",
        `duplicate ${constraint.kind} ${constraint.value} constraint`,
        `${path}.constraints[${index}]`,
      );
    }
    seen.add(key);
  });
  return { version: REPRESENTATION_INTENT_VERSION, mode: value.mode, constraints };
}

function projectionForFamily(familyId) {
  if (GEOGRAPHIC_FAMILIES.has(familyId)) return "geographic";
  if (CARTESIAN_FAMILIES.has(familyId)) return "cartesian";
  return "none";
}

export function representationCapabilitiesFor({ family, member }) {
  const manifest = requireMapFamily(typeof family === "string" ? family : family.id);
  const form = getExecutableForm(manifest.id, member.id);
  if (form) {
    return {
      version: REPRESENTATION_INTENT_VERSION,
      constraints: Object.fromEntries(Object.entries(form.representation.constraints)
        .map(([kind, values]) => [kind, [...values]])),
    };
  }
  return {
    version: REPRESENTATION_INTENT_VERSION,
    constraints: {
      dimensionality: ["2d"],
      form: [member.id],
      interaction: [],
      motion: ["static"],
      projection: [projectionForFamily(manifest.id)],
    },
  };
}

export function assertRepresentationIntentSupported(intent, { family, member, path = "representationIntent" }) {
  const normalized = normalizeRepresentationIntent(intent, { path, required: true });
  if (normalized.mode === "open") return normalized;
  const capabilities = member.representationCapabilities
    ?? representationCapabilitiesFor({ family, member });
  normalized.constraints.forEach((constraint, index) => {
    const supported = capabilities.constraints[constraint.kind] ?? [];
    if (!supported.includes(constraint.value)) {
      fail(
        "UNSUPPORTED_REQUESTED_REPRESENTATION",
        `${String(family.id ?? family)}/${member.id} does not support requested ${constraint.kind} ${constraint.value}`,
        `${path}.constraints[${index}]`,
      );
    }
  });
  return normalized;
}

export function representationIntentsEqual(left, right) {
  const comparable = (value) => {
    const normalized = normalizeRepresentationIntent(value);
    return {
      ...normalized,
      constraints: [...normalized.constraints]
        .sort((leftConstraint, rightConstraint) =>
          leftConstraint.kind.localeCompare(rightConstraint.kind)
          || leftConstraint.value.localeCompare(rightConstraint.value)),
    };
  };
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}
