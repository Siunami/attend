import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const SUPPORTED_EXTENSIONS = new Set([".md", ".mdx", ".txt", ".jsonl"]);
const SHA256_RE = /^[a-f0-9]{64}$/i;
const RECURSIVE_EXCLUDED_DIRECTORIES = new Set(["node_modules"]);
export const MAX_JSONL_CONTAINER_BYTES = 32 * 1024 * 1024;
export const MAX_SOURCE_CORPUS_BYTES = 32 * 1024 * 1024;
const READ_ONLY_NOFOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableId(prefix, value) {
  return `${prefix}_${sha256(value).slice(0, 16)}`;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function cleanDisplayPath(value) {
  const normalized = String(value || "")
    .replaceAll("\\", "/")
    .replace(/^[a-z]:\//i, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
  const parts = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/") || "untitled";
}

function relativeDisplayPath(root, absolutePath) {
  const relative = path.relative(root, absolutePath);
  return cleanDisplayPath(toPosix(relative || path.basename(absolutePath)));
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function firstSymbolicLink(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!isInside(root, candidate)) return candidate;
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let info;
    try {
      info = await fs.lstat(cursor);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (info.isSymbolicLink()) return cursor;
  }
  return null;
}

function sourceLimit(name, value, hardLimit) {
  if (!Number.isSafeInteger(value) || value < 1 || value > hardLimit) {
    throw new Error(`${name} must be an integer between 1 and ${hardLimit}`);
  }
  return value;
}

async function openSourceFile(candidate, root) {
  if (await firstSymbolicLink(root, candidate)) {
    throw new Error(`source path traverses a symbolic link: ${relativeDisplayPath(root, candidate)}`);
  }
  const handle = await fs.open(candidate, READ_ONLY_NOFOLLOW);
  try {
    const opened = await handle.stat();
    const current = await fs.lstat(candidate);
    if (
      !opened.isFile() ||
      current.isSymbolicLink() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      await firstSymbolicLink(root, candidate)
    ) {
      throw new Error(`source path changed during read: ${relativeDisplayPath(root, candidate)}`);
    }
    return { handle, info: opened };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readBoundedFile(handle, byteLength) {
  if (byteLength === 0) return Buffer.alloc(0);
  const chunks = [];
  for await (const chunk of handle.createReadStream({
    autoClose: false,
    start: 0,
    end: byteLength - 1,
  })) {
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== byteLength) {
    throw new Error("source file changed during read");
  }
  return bytes;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function discoverPath(candidate, root, files, omissions, explicit = false) {
  const info = await fs.lstat(candidate).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`input path does not exist: ${relativeDisplayPath(root, candidate)}`);
    }
    throw error;
  });

  if (info.isSymbolicLink()) {
    omissions.push({
      id: "symbolic-link",
      path: relativeDisplayPath(root, candidate),
      skipped: true,
      reason: "Symbolic links are not followed.",
    });
    return;
  }

  if (info.isDirectory()) {
    const name = path.basename(candidate);
    if (
      !explicit &&
      (name.startsWith(".") || RECURSIVE_EXCLUDED_DIRECTORIES.has(name))
    ) {
      omissions.push({
        id: "excluded-directory",
        path: relativeDisplayPath(root, candidate),
        skipped: true,
        reason: "Hidden and dependency directories are excluded during recursive discovery unless named explicitly.",
      });
      return;
    }
    const entries = await fs.readdir(candidate, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      await discoverPath(path.join(candidate, entry.name), root, files, omissions, false);
    }
    return;
  }

  if (!info.isFile()) return;
  const displayPath = relativeDisplayPath(root, candidate);
  if (!explicit && path.basename(candidate).startsWith(".")) {
    omissions.push({
      id: "excluded-file",
      path: displayPath,
      skipped: true,
      reason: "Hidden files are excluded during recursive discovery unless named explicitly.",
    });
    return;
  }
  if (!SUPPORTED_EXTENSIONS.has(path.extname(candidate).toLowerCase())) {
    omissions.push({
      id: "unsupported-file",
      path: displayPath,
      skipped: true,
      reason: "This file type is unsupported; Attend reads .md, .mdx, .txt, and .jsonl sources.",
    });
    return;
  }
  files.set(candidate, { absolutePath: candidate, byteLength: info.size });
}

function sourceRecord({
  id,
  displayPath,
  digest,
  kind,
  byteLength,
  title,
  date,
  recordId,
  containerPath,
  declaredSha256,
}) {
  const record = {
    id,
    displayPath,
    sha256: digest,
    kind,
    byteLength,
  };
  if (title) record.title = title;
  if (date) record.date = date;
  if (recordId) record.recordId = recordId;
  if (containerPath) record.containerPath = containerPath;
  if (declaredSha256) {
    record.declaredSha256 = declaredSha256;
    record.hashVerified = declaredSha256.toLowerCase() === digest;
  }
  return record;
}

async function parseJsonl(handle, byteLength, containerPath, omissions, maxFileBytes) {
  const records = [];
  const identities = new Set();
  if (byteLength === 0) return records;
  const stream = handle.createReadStream({
    autoClose: false,
    encoding: "utf8",
    start: 0,
    end: byteLength - 1,
  });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let index = 0;

  try {
    for await (const rawLine of lines) {
      index += 1;
      if (!rawLine.trim()) continue;

      let raw;
      try {
        raw = JSON.parse(rawLine);
      } catch (error) {
        throw new Error(`${containerPath}:${index}: invalid JSONL (${error.message})`);
      }
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`${containerPath}:${index}: each JSONL row must be an object`);
      }
      if (typeof raw.text !== "string") {
        throw new Error(`${containerPath}:${index}: JSONL record is missing string field \"text\"`);
      }

      const recordId = optionalString(raw.id);
      const recordPath = optionalString(raw.sourcePath);
      const locator = recordId || recordPath || `line-${index}`;
      const identity = `${containerPath}\u0000${locator}`;
      if (identities.has(identity)) {
        throw new Error(`${containerPath}:${index}: duplicate JSONL source identity \"${locator}\"`);
      }
      identities.add(identity);

      const recordByteLength = Buffer.byteLength(raw.text, "utf8");
      const displayPath = cleanDisplayPath(recordPath || `${containerPath}#${index}`);
      if (recordByteLength > maxFileBytes) {
        omissions.push({
          id: "record-too-large",
          path: displayPath,
          skipped: true,
          containerPath,
          byteLength: recordByteLength,
          maxFileBytes,
          reason: "The JSONL text record exceeded maxFileBytes and was not analyzed.",
        });
        continue;
      }

      const digest = sha256(Buffer.from(raw.text, "utf8"));
      const declaredSha256 = optionalString(raw.sourceSha256);
      if (declaredSha256 && (!SHA256_RE.test(declaredSha256) || declaredSha256.toLowerCase() !== digest)) {
        omissions.push({
          id: "source-hash-mismatch",
          path: cleanDisplayPath(recordPath || `${containerPath}#${index}`),
          reason: "The declared sourceSha256 did not match the analyzed text; the computed hash is authoritative.",
        });
      }

      const metadata = sourceRecord({
        id: stableId("src", identity),
        displayPath,
        digest,
        kind: "jsonl-record",
        byteLength: recordByteLength,
        title: optionalString(raw.title),
        date: optionalString(raw.date),
        recordId,
        containerPath,
        declaredSha256,
      });
      records.push({ ...metadata, text: raw.text });
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  return records;
}

/**
 * Resolve the explicitly supplied source scope and return logical text sources.
 * JSONL containers expand to one source per record; other supported files are
 * one source apiece. Absolute paths never appear in returned display metadata.
 */
export async function loadSources({
  root = process.cwd(),
  inputPaths,
  maxFileBytes = 2_000_000,
  maxJsonlContainerBytes = MAX_JSONL_CONTAINER_BYTES,
  maxCorpusBytes = MAX_SOURCE_CORPUS_BYTES,
}) {
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new Error("maxFileBytes must be a positive integer");
  }
  maxJsonlContainerBytes = sourceLimit(
    "maxJsonlContainerBytes",
    maxJsonlContainerBytes,
    MAX_JSONL_CONTAINER_BYTES,
  );
  maxCorpusBytes = sourceLimit(
    "maxCorpusBytes",
    maxCorpusBytes,
    MAX_SOURCE_CORPUS_BYTES,
  );

  const rootPath = path.resolve(root);
  const rootInfo = await fs.stat(rootPath).catch(() => null);
  if (!rootInfo?.isDirectory()) throw new Error(`root is not a directory: ${rootPath}`);
  const realRoot = await fs.realpath(rootPath);

  const requested = Array.isArray(inputPaths) ? inputPaths : [inputPaths];
  if (!requested.length || requested.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error("inputPaths must contain at least one path");
  }

  const files = new Map();
  const omissions = [];
  for (const input of requested) {
    const resolved = path.resolve(realRoot, input);
    if (!isInside(realRoot, resolved)) {
      throw new Error(`input path escapes root: ${input}`);
    }
    if (await firstSymbolicLink(realRoot, resolved)) {
      omissions.push({
        id: "symbolic-link",
        path: relativeDisplayPath(realRoot, resolved),
        skipped: true,
        reason: "Symbolic links are not followed.",
      });
      continue;
    }
    await discoverPath(resolved, realRoot, files, omissions, true);
  }

  const logicalSources = [];
  let corpusBytes = 0;
  const orderedFiles = [...files.values()].sort((left, right) =>
    compareText(left.absolutePath, right.absolutePath),
  );
  for (const file of orderedFiles) {
    const displayPath = relativeDisplayPath(realRoot, file.absolutePath);
    const extension = path.extname(file.absolutePath).toLowerCase();
    const opened = await openSourceFile(file.absolutePath, realRoot);
    const { handle, info } = opened;
    try {
      // A JSONL file is a container of logical source records. Apply maxFileBytes
      // to each record, while separately bounding the container and total corpus.
      if (extension !== ".jsonl" && info.size > maxFileBytes) {
        omissions.push({
          id: "file-too-large",
          path: displayPath,
          skipped: true,
          byteLength: info.size,
          maxFileBytes,
          reason: "The file exceeded maxFileBytes and was not read.",
        });
        continue;
      }
      if (extension === ".jsonl" && info.size > maxJsonlContainerBytes) {
        throw new Error(
          `JSONL container exceeds hard limit of ${maxJsonlContainerBytes} bytes: ${displayPath}`,
        );
      }
      if (corpusBytes + info.size > maxCorpusBytes) {
        throw new Error(`source corpus exceeds hard limit of ${maxCorpusBytes} bytes`);
      }
      corpusBytes += info.size;

      if (extension === ".jsonl") {
        logicalSources.push(
          ...await parseJsonl(handle, info.size, displayPath, omissions, maxFileBytes),
        );
        continue;
      }

      const bytes = await readBoundedFile(handle, info.size);
      logicalSources.push({
        ...sourceRecord({
          id: stableId("src", `file\u0000${displayPath}`),
          displayPath,
          digest: sha256(bytes),
          kind: "text-file",
          byteLength: bytes.byteLength,
        }),
        text: bytes.toString("utf8"),
      });
    } finally {
      await handle.close().catch(() => {});
    }
  }

  logicalSources.sort((left, right) =>
    compareText(left.displayPath, right.displayPath) || compareText(left.id, right.id),
  );
  omissions.sort((left, right) =>
    compareText(left.id, right.id) || compareText(left.path || "", right.path || ""),
  );

  return { root: realRoot, sources: logicalSources, omissions };
}

export function publicSource(source) {
  const { text: _text, ...metadata } = source;
  return metadata;
}
