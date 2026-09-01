import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

import { parse as parseExif } from "./vendor/exifr-7.1.3.esm.mjs";
import { attachPrivateImageAssets } from "./internals.js";

export const LOCAL_IMAGE_SET_LIMITS = Object.freeze({
  minImages: 12,
  maxImages: 200,
  maxFileBytes: 12 * 1024 * 1024,
  maxPixels: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  originalsPerPage: 8,
});

const JPEG_EXTENSIONS = new Set([".jpg", ".jpeg"]);
const SAFE_ID = /^[a-z][a-z0-9_]{7,127}$/u;
const READ_ONLY_NOFOLLOW = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
const DATE_TIME_ORIGINAL = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u;
const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function publicRelativePath(root, candidate) {
  return toPosix(path.relative(root, candidate));
}

export class LocalImageSetError extends Error {
  constructor(requirement, message, details = {}) {
    super(message);
    this.name = "LocalImageSetError";
    this.code = "IMAGE_SET_INELIGIBLE";
    this.requirement = requirement;
    this.failedRequirements = [{ requirement, message, ...details }];
  }
}

function ineligible(requirement, message, details) {
  throw new LocalImageSetError(requirement, message, details);
}

async function assertNoSymbolicLink(root, candidate) {
  if (!isInside(root, candidate)) {
    ineligible("one-explicit-directory", "The image directory must remain inside the authorized root.");
  }
  let cursor = root;
  for (const part of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let info;
    try {
      info = await fs.lstat(cursor);
    } catch (error) {
      if (error?.code === "ENOENT") {
        ineligible("one-explicit-directory", "The authorized image directory does not exist.");
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      ineligible(
        "no-symbolic-links",
        "The image set contains or traverses a symbolic link.",
        { entry: publicRelativePath(root, cursor) },
      );
    }
  }
}

async function discoverJpegs(directory, root, files) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareText(left.name, right.name));
  for (const entry of entries) {
    const candidate = path.join(directory, entry.name);
    const relativePath = publicRelativePath(root, candidate);
    const info = await fs.lstat(candidate);
    if (info.isSymbolicLink()) {
      ineligible("no-symbolic-links", "The image set contains a symbolic link.", {
        entry: relativePath,
      });
    }
    if (info.isDirectory()) {
      await discoverJpegs(candidate, root, files);
      continue;
    }
    if (!info.isFile()) {
      ineligible("static-jpeg-only", "The image directory contains a non-file entry.", {
        entry: relativePath,
      });
    }
    if (!JPEG_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      ineligible("static-jpeg-only", "The image directory contains unsupported media.", {
        entry: relativePath,
      });
    }
    files.push({ absolutePath: candidate, relativePath, discovered: info });
    if (files.length > LOCAL_IMAGE_SET_LIMITS.maxImages) {
      ineligible(
        "image-count",
        `Contact atlas accepts at most ${LOCAL_IMAGE_SET_LIMITS.maxImages} JPEGs.`,
        { count: files.length },
      );
    }
  }
}

function sameIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function openVerifiedFile(candidate, root) {
  await assertNoSymbolicLink(root, candidate);
  let handle;
  try {
    handle = await fs.open(candidate, READ_ONLY_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ELOOP") {
      ineligible("no-symbolic-links", "The image set contains a symbolic link.");
    }
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    const current = await fs.lstat(candidate, { bigint: true });
    if (!opened.isFile() || current.isSymbolicLink() || !sameIdentity(opened, current)) {
      ineligible("unchanged-files", "An image changed while Attend was authorizing it.");
    }
    return { handle, identity: opened };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function readVerifiedFile(candidate, root, expected) {
  const { handle, identity } = await openVerifiedFile(candidate, root);
  try {
    if (expected && !sameIdentity(identity, expected)) {
      ineligible("unchanged-files", "An image changed after it was authorized.");
    }
    const byteLength = Number(identity.size);
    if (!Number.isSafeInteger(byteLength) || byteLength < 1) {
      ineligible("static-jpeg-only", "Every image must be a non-empty static JPEG.");
    }
    if (byteLength > LOCAL_IMAGE_SET_LIMITS.maxFileBytes) {
      ineligible(
        "file-size",
        `Each JPEG must be at most ${LOCAL_IMAGE_SET_LIMITS.maxFileBytes} bytes.`,
        { byteLength },
      );
    }
    const bytes = Buffer.allocUnsafe(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await fs.lstat(candidate, { bigint: true });
    if (offset !== byteLength || !sameIdentity(identity, after) || !sameIdentity(identity, current)) {
      ineligible("unchanged-files", "An image changed while Attend was reading it.");
    }
    return { bytes, identity };
  } finally {
    await handle.close().catch(() => {});
  }
}

function jpegStructure(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    ineligible("jpeg-signature", "A .jpg or .jpeg file does not contain JPEG data.");
  }
  let offset = 2;
  let frame = null;
  let sawScan = false;
  let sawEnd = false;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      if (!sawScan) ineligible("well-formed-jpeg", "A JPEG marker is malformed.");
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x00 && sawScan) continue;
    if (marker >= 0xd0 && marker <= 0xd7 && sawScan) continue;
    if (marker === 0xd9) {
      sawEnd = true;
      while (offset < bytes.length && bytes[offset] === 0x00) offset += 1;
      if (offset !== bytes.length) {
        ineligible("well-formed-jpeg", "A JPEG contains data after its end marker.");
      }
      break;
    }
    if (marker === 0xd8 || marker === 0x01) continue;
    if (offset + 2 > bytes.length) {
      ineligible("well-formed-jpeg", "A JPEG segment is truncated.");
    }
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      ineligible("well-formed-jpeg", "A JPEG segment has an invalid length.");
    }
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (frame || segmentLength < 8) {
        ineligible("static-jpeg-only", "A JPEG must contain exactly one image frame.");
      }
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (width < 1 || height < 1) {
        ineligible("image-dimensions", "A JPEG reports invalid dimensions.");
      }
      frame = { width, height };
    }
    if (marker === 0xda) sawScan = true;
    offset += segmentLength;
  }
  if (!frame || !sawScan || !sawEnd) {
    ineligible("well-formed-jpeg", "A JPEG is missing its frame, scan, or end marker.");
  }
  return frame;
}

function calendarDays(year, month) {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function cameraLocalTimestamp(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const pad = (number) => String(number).padStart(2, "0");
    value = `${value.getFullYear()}:${pad(value.getMonth() + 1)}:${pad(value.getDate())} ` +
      `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }
  const match = DATE_TIME_ORIGINAL.exec(String(value ?? ""));
  if (!match) {
    ineligible("capture-time", "Every JPEG must contain a valid DateTimeOriginal value.");
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const [year, month, day, hour, minute, second] = [
    yearText, monthText, dayText, hourText, minuteText, secondText,
  ].map(Number);
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > calendarDays(year, month) ||
    hour > 23 || minute > 59 || second > 59
  ) {
    ineligible("capture-time", "Every JPEG must contain a valid DateTimeOriginal value.");
  }
  return `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}`;
}

function positiveDimension(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

async function imageMetadata(bytes) {
  let metadata;
  try {
    metadata = await parseExif(bytes, {
      // The pinned mini build intentionally omits translation dictionaries;
      // numeric EXIF tags keep this parser surface small and auditable.
      ifd0: [0x0100, 0x0101, 0x0112],
      exif: [0x9003, 0xa002, 0xa003],
      ifd1: false,
      gps: false,
      interop: false,
      makerNote: false,
      userComment: false,
      translateKeys: false,
      translateValues: false,
      reviveValues: false,
      sanitize: true,
      mergeOutput: true,
      silentErrors: false,
    });
  } catch {
    ineligible("well-formed-exif", "A JPEG contains malformed or unreadable EXIF metadata.");
  }
  const captureLocal = cameraLocalTimestamp(metadata?.[0x9003]);
  const width = positiveDimension(metadata?.[0xa002] ?? metadata?.[0x0100]);
  const height = positiveDimension(metadata?.[0xa003] ?? metadata?.[0x0101]);
  if (!width || !height) {
    ineligible("image-dimensions", "Every JPEG must contain evidenced image dimensions.");
  }
  const orientation = metadata?.[0x0112] === undefined
    ? 1
    : Number(metadata[0x0112]);
  if (!Number.isSafeInteger(orientation) || orientation < 1 || orientation > 8) {
    ineligible("image-orientation", "JPEG orientation must be an EXIF value from 1 through 8.");
  }
  return {
    captureLocal,
    width,
    height,
    orientation,
    orientationSource: metadata?.[0x0112] === undefined ? "default-normal" : "exif",
  };
}

function sanitizedBasename(relativePath) {
  const extension = path.posix.extname(relativePath);
  const value = path.posix.basename(relativePath, extension)
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/[<>:"/\\|?*]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 96);
  return value || "Untitled image";
}

function assertOpaqueId(value, label) {
  if (!SAFE_ID.test(value)) throw new TypeError(`${label} is not an opaque Attend id`);
  return value;
}

/**
 * Authorize and normalize one explicit JPEG directory without exposing source
 * paths. The returned object's private staging handle is deliberately
 * non-enumerable and is lost under JSON serialization.
 */
export async function loadLocalImageSet({ root = process.cwd(), directory } = {}) {
  if (typeof root !== "string" || !root) throw new TypeError("root is required");
  if (typeof directory !== "string" || !directory.trim()) {
    ineligible("one-explicit-directory", "local-image-set-v1 requires one explicit directory.");
  }
  if (directory.replaceAll("\\", "/").split("/").includes("..")) {
    ineligible("one-explicit-directory", "The image directory cannot contain parent traversal segments.");
  }
  const rootPath = path.resolve(root);
  const rootInfo = await fs.stat(rootPath).catch(() => null);
  if (!rootInfo?.isDirectory()) throw new TypeError("root must be an existing directory");
  const realRoot = await fs.realpath(rootPath);
  const directoryPath = path.resolve(realRoot, directory);
  if (!isInside(realRoot, directoryPath)) {
    ineligible("one-explicit-directory", "The image directory must remain inside the authorized root.");
  }
  await assertNoSymbolicLink(realRoot, directoryPath);
  const directoryInfo = await fs.lstat(directoryPath).catch(() => null);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) {
    ineligible("one-explicit-directory", "local-image-set-v1 requires one ordinary directory.");
  }

  const discovered = [];
  await discoverJpegs(directoryPath, realRoot, discovered);
  if (
    discovered.length < LOCAL_IMAGE_SET_LIMITS.minImages ||
    discovered.length > LOCAL_IMAGE_SET_LIMITS.maxImages
  ) {
    ineligible(
      "image-count",
      `Contact atlas requires ${LOCAL_IMAGE_SET_LIMITS.minImages}–${LOCAL_IMAGE_SET_LIMITS.maxImages} JPEGs.`,
      { count: discovered.length },
    );
  }
  let discoveredBytes = 0;
  for (const candidate of discovered) {
    if (candidate.discovered.size > LOCAL_IMAGE_SET_LIMITS.maxFileBytes) {
      ineligible(
        "file-size",
        `Each JPEG must be at most ${LOCAL_IMAGE_SET_LIMITS.maxFileBytes} bytes.`,
        { byteLength: candidate.discovered.size },
      );
    }
    discoveredBytes += candidate.discovered.size;
  }
  if (discoveredBytes > LOCAL_IMAGE_SET_LIMITS.maxTotalBytes) {
    ineligible(
      "total-size",
      `The image set must be at most ${LOCAL_IMAGE_SET_LIMITS.maxTotalBytes} bytes.`,
      { totalBytes: discoveredBytes },
    );
  }

  let totalBytes = 0;
  const authorized = [];
  for (const candidate of discovered) {
    const { bytes, identity } = await readVerifiedFile(candidate.absolutePath, realRoot);
    totalBytes += bytes.length;
    if (totalBytes > LOCAL_IMAGE_SET_LIMITS.maxTotalBytes) {
      ineligible(
        "total-size",
        `The image set must be at most ${LOCAL_IMAGE_SET_LIMITS.maxTotalBytes} bytes.`,
        { totalBytes },
      );
    }
    const frame = jpegStructure(bytes);
    const metadata = await imageMetadata(bytes);
    if (frame.width !== metadata.width || frame.height !== metadata.height) {
      ineligible("image-dimensions", "JPEG frame and EXIF dimensions do not agree.", {
        entry: candidate.relativePath,
      });
    }
    if (metadata.width * metadata.height > LOCAL_IMAGE_SET_LIMITS.maxPixels) {
      ineligible(
        "pixel-count",
        `Each JPEG must contain at most ${LOCAL_IMAGE_SET_LIMITS.maxPixels} pixels.`,
        { width: metadata.width, height: metadata.height },
      );
    }
    authorized.push({
      ...candidate,
      ...metadata,
      byteLength: bytes.length,
      sha256: digest(bytes),
      identity,
    });
  }

  authorized.sort((left, right) =>
    compareText(left.captureLocal, right.captureLocal) ||
    compareText(left.relativePath, right.relativePath),
  );
  const collectionHash = digest(Buffer.from(
    authorized.map((asset) => `${asset.relativePath}\u0000${asset.sha256}`).join("\n"),
    "utf8",
  ));
  const directoryId = assertOpaqueId(`image_set_${collectionHash.slice(0, 24)}`, "directoryId");
  const timestampCounts = new Map();
  for (const asset of authorized) {
    timestampCounts.set(asset.captureLocal, (timestampCounts.get(asset.captureLocal) ?? 0) + 1);
  }
  const timestampTies = [...timestampCounts]
    .filter(([, count]) => count > 1)
    .map(([captureLocal, count]) => ({ captureLocal, count }));

  const privateAssets = [];
  const items = authorized.map((asset, index) => {
    const assetId = assertOpaqueId(
      `asset_${digest(`${directoryId}\u0000${asset.relativePath}\u0000${asset.sha256}`).slice(0, 32)}`,
      "assetId",
    );
    const observationId = assertOpaqueId(
      `observation_${digest(`${directoryId}\u0000${index}`).slice(0, 24)}`,
      "observationId",
    );
    const sourceId = assertOpaqueId(`source_${assetId.slice(6)}`, "sourceId");
    const locator = { kind: "whole-file", assetId };
    const evidenceRef = assertOpaqueId(
      `evidence_${digest(JSON.stringify(canonicalValue({
        sourceId,
        recordId: observationId,
        locator,
      }))).slice(0, 16)}`,
      "evidenceRef",
    );
    const basename = sanitizedBasename(asset.relativePath);
    const dateLabel = asset.captureLocal.replace("T", " ");
    privateAssets.push({
      assetId,
      absolutePath: asset.absolutePath,
      relativePath: asset.relativePath,
      sha256: asset.sha256,
      byteLength: asset.byteLength,
      identity: asset.identity,
    });
    return {
      observationId,
      sourceId,
      evidenceRef,
      assetId,
      previewRoute: `assets/${assetId}`,
      label: `${basename} · ${dateLabel}`,
      basename,
      captureLocal: asset.captureLocal,
      captureTime: asset.captureLocal,
      order: index,
      width: asset.width,
      height: asset.height,
      orientation: asset.orientation,
      orientationSource: asset.orientationSource,
      byteLength: asset.byteLength,
      sha256: asset.sha256,
      mimeType: "image/jpeg",
    };
  });
  const evidenceReferences = items.map((item) => ({
    id: item.evidenceRef,
    sourceId: item.sourceId,
    recordId: item.observationId,
    locator: { kind: "whole-file", assetId: item.assetId },
  }));
  const sources = items.map((item) => ({
    id: item.sourceId,
    displayPath: `images/${item.sourceId}.jpg`,
    kind: "image-file",
    sha256: item.sha256,
    byteLength: item.byteLength,
    mediaType: "image",
    mimeType: item.mimeType,
  }));
  const referencesByRecord = new Map(
    evidenceReferences.map((reference) => [reference.recordId, reference]),
  );
  const records = items.map((item) => ({
    id: item.observationId,
    sourceId: item.sourceId,
    fields: {
      assetId: item.assetId,
      previewRoute: item.previewRoute,
      label: item.label,
      captureTime: item.captureTime,
      captureLocal: item.captureLocal,
      order: item.order,
      width: item.width,
      height: item.height,
      orientation: item.orientation,
    },
    evidenceRefs: [{
      sourceId: item.sourceId,
      recordId: item.observationId,
      locator: referencesByRecord.get(item.observationId).locator,
    }],
    media: {
      type: "image",
      mimeType: item.mimeType,
      width: item.width,
      height: item.height,
      preview: {
        kind: "image",
        src: item.previewRoute,
        label: item.label,
        aspectRatio: item.width / item.height,
      },
    },
  }));
  const disclosures = {
    timezone: "unknown",
    captureTimeBasis: "camera-local DateTimeOriginal; no timezone conversion was applied",
    timestampTieBreak: "normalized relative path (not published)",
    timestampTies,
    timestampTieCount: timestampTies.reduce((sum, tie) => sum + tie.count, 0),
  };
  const paging = { pageSize: LOCAL_IMAGE_SET_LIMITS.originalsPerPage, total: items.length };
  const canonicalSourceBundle = {
    kind: "attend-normalized-source-bundle",
    schemaVersion: 1,
    adapter: { id: "local-image-set-v1", version: 1 },
    medium: "image",
    requestedInputs: [`image-set/${directoryId}`],
    knownOmissions: [
      disclosures.captureTimeBasis,
      `Timestamp ties use ${disclosures.timestampTieBreak}.`,
    ],
    sources,
    records,
  };
  const stagingManifest = {
    schemaVersion: 1,
    kind: "attend-image-staging-plan",
    directoryId,
    sourceBundleSha256: digest(Buffer.from(JSON.stringify(canonicalSourceBundle))),
    assets: items.map((item) => ({
      assetId: item.assetId,
      evidenceRef: item.evidenceRef,
      sha256: item.sha256,
      byteLength: item.byteLength,
      mimeType: item.mimeType,
      width: item.width,
      height: item.height,
      orientation: item.orientation,
    })),
  };
  const result = {
    adapter: "local-image-set-v1",
    canonicalSourceBundle,
    sourceBundle: canonicalSourceBundle,
    records,
    items,
    evidenceReferences,
    stagingManifest,
    disclosures,
    paging,
  };
  return attachPrivateImageAssets(result, {
    root: realRoot,
    directoryId,
    sourceBundleSha256: stagingManifest.sourceBundleSha256,
    assets: privateAssets,
  });
}

export const mediaInternals = Object.freeze({
  digest,
  readVerifiedFile,
});
