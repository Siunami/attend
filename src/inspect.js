import { posix, win32 } from "node:path";

import { loadSources, publicSource, sha256 } from "./sources.js";

const REQUEST_VERSION = 1;
const REQUEST_KEYS = new Set(["version", "goal", "sources", "options"]);
const SOURCE_KEYS = new Set(["path"]);
const OPTION_KEYS = new Set(["maxFileBytes"]);
const ISO_DATE = /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/gu;
const NUMBER = /(?<![\p{L}\p{N}_])-?\d+(?:[,.]\d+)*(?:%|\b)/gu;
const WORD = /[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}'’_-]*[\p{L}\p{N}])?/gu;

function fail(code, message, path = "request") {
  const error = new Error(`${path}: ${message}`);
  error.code = code;
  error.path = path;
  throw error;
}
function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknown(value, allowed, path) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) fail("UNKNOWN_INSPECTION_FIELD", `unknown field ${unexpected[0]}`, `${path}.${unexpected[0]}`);
}

function text(value, path, maximum) {
  if (typeof value !== "string" || !value.trim()) fail("INVALID_INSPECTION", "must be a non-empty string", path);
  const normalized = value.trim();
  if (normalized.length > maximum) fail("INVALID_INSPECTION", `must contain at most ${maximum} characters`, path);
  return normalized;
}

function relativeSourcePath(value, path) {
  const raw = text(value, path, 2_048);
  const forward = raw.replaceAll("\\", "/");
  if (
    raw.includes("\0")
    || raw.startsWith("~")
    || win32.isAbsolute(raw)
    || forward.startsWith("/")
    || forward.split("/").includes("..")
  ) {
    fail("UNSAFE_INSPECTION_SOURCE", "must be a relative project path without parent traversal", path);
  }
  return posix.normalize(forward);
}

function normalizeRequest(request) {
  if (!plainObject(request)) fail("INVALID_INSPECTION", "must be an object");
  rejectUnknown(request, REQUEST_KEYS, "request");
  if (request.version !== REQUEST_VERSION) fail("INVALID_INSPECTION", `version must be ${REQUEST_VERSION}`, "request.version");
  const goal = text(request.goal, "request.goal", 4_000);
  if (!Array.isArray(request.sources) || request.sources.length === 0) {
    fail("INVALID_INSPECTION", "sources must be a non-empty array", "request.sources");
  }
  const sources = request.sources.map((source, index) => {
    const path = `request.sources[${index}]`;
    if (!plainObject(source)) fail("INVALID_INSPECTION", "must be an object", path);
    rejectUnknown(source, SOURCE_KEYS, path);
    return { path: relativeSourcePath(source.path, `${path}.path`) };
  });
  const options = request.options ?? {};
  if (!plainObject(options)) fail("INVALID_INSPECTION", "must be an object", "request.options");
  rejectUnknown(options, OPTION_KEYS, "request.options");
  const maxFileBytes = options.maxFileBytes ?? 2_000_000;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 32 * 1024 * 1024) {
    fail("INVALID_INSPECTION", "must be an integer between 1 and 33554432", "request.options.maxFileBytes");
  }
  return {
    version: REQUEST_VERSION,
    goal,
    sources: [...new Map(sources.map((source) => [source.path, source])).values()],
    options: { maxFileBytes },
  };
}

function occurrences(expression, value) {
  return [...value.matchAll(expression)].map((match) => match[0]);
}

function observeSource(source) {
  const dates = [...new Set(occurrences(ISO_DATE, source.text))].sort();
  return {
    ...publicSource(source),
    lineCount: source.text ? source.text.split(/\r\n?|\n/u).length : 0,
    wordCount: occurrences(WORD, source.text).length,
    numericTokenCount: occurrences(NUMBER, source.text).length,
    isoDateCount: occurrences(ISO_DATE, source.text).length,
    uniqueIsoDates: dates,
  };
}

export async function inspectSources({ root, request }) {
  const normalized = normalizeRequest(request);
  const loaded = await loadSources({
    root,
    inputPaths: normalized.sources.map((source) => source.path),
    maxFileBytes: normalized.options.maxFileBytes,
  });
  const sources = loaded.sources.map(observeSource);
  const dates = [...new Set(sources.flatMap((source) => source.uniqueIsoDates))].sort();
  const summary = {
    sourceCount: sources.length,
    totalBytes: sources.reduce((sum, source) => sum + source.byteLength, 0),
    lineCount: sources.reduce((sum, source) => sum + source.lineCount, 0),
    wordCount: sources.reduce((sum, source) => sum + source.wordCount, 0),
    numericTokenCount: sources.reduce((sum, source) => sum + source.numericTokenCount, 0),
    isoDateCount: sources.reduce((sum, source) => sum + source.isoDateCount, 0),
    uniqueIsoDateCount: dates.length,
    dateRange: dates.length ? { first: dates[0], last: dates.at(-1) } : null,
    omissionCount: loaded.omissions.length,
  };
  const receipt = {
    schemaVersion: 1,
    kind: "attend-inspection",
    goal: normalized.goal,
    sourceScope: normalized.sources,
    summary,
    sources,
    omissions: loaded.omissions,
  };
  return {
    ...receipt,
    inspectionHash: sha256(JSON.stringify(receipt)),
  };
}
