import { randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  assertSafeWritePath,
  ensureSafeDirectory,
  readJson,
  writeJsonAtomic,
} from "../project.js";
import { privateImageAssets } from "./internals.js";
import { mediaInternals } from "./local-image-set.js";

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const ASSET_ID = /^asset_[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ASSET_DIRECTORY = ".attend/local/session-assets";

export class SessionAssetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SessionAssetError";
    this.code = code;
  }
}

function assetError(code, message) {
  throw new SessionAssetError(code, message);
}

function validateSessionId(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    throw new TypeError("sessionId must be a safe Attend session id");
  }
  return sessionId;
}

function packageDigest(dataPackage) {
  if (!dataPackage || typeof dataPackage !== "object" || Array.isArray(dataPackage)) {
    throw new TypeError("dataPackage must be a JSON object");
  }
  let encoded;
  try {
    encoded = JSON.stringify(dataPackage);
  } catch (error) {
    throw new TypeError(`dataPackage must be JSON-serializable: ${error.message}`);
  }
  if (encoded === undefined) throw new TypeError("dataPackage must be JSON-serializable");
  return mediaInternals.digest(Buffer.from(encoded));
}

function assetDirectory(root, sessionId) {
  return resolve(root, ASSET_DIRECTORY, validateSessionId(sessionId));
}

function manifestPath(root, sessionId) {
  return join(assetDirectory(root, sessionId), "manifest.json");
}

function assetPath(root, sessionId, assetId) {
  if (typeof assetId !== "string" || !ASSET_ID.test(assetId)) {
    assetError("ASSET_NOT_FOUND", "The requested session asset is unavailable.");
  }
  return join(assetDirectory(root, sessionId), `${assetId}.jpg`);
}

async function writeBytesOnce(root, target, bytes) {
  await assertSafeWritePath(root, target);
  try {
    const existing = await readFile(target);
    if (mediaInternals.digest(existing) !== mediaInternals.digest(bytes)) {
      assetError("ASSET_STORAGE_CONFLICT", "A different staged asset already occupies this id.");
    }
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = join(dirname(target), `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await assertSafeWritePath(root, target);
    await rename(temporary, target);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function manifestDigest(manifest) {
  return mediaInternals.digest(Buffer.from(JSON.stringify(manifest)));
}

function normalizedReceipt(receipt) {
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    receipt.schemaVersion !== 1 ||
    receipt.kind !== "attend-session-asset-receipt" ||
    !SESSION_ID.test(receipt.sessionId ?? "") ||
    typeof receipt.packageId !== "string" ||
    !SHA256.test(receipt.packageSha256 ?? "") ||
    !SHA256.test(receipt.sourceBundleSha256 ?? "") ||
    !SHA256.test(receipt.manifestSha256 ?? "") ||
    !Number.isSafeInteger(receipt.assetCount) ||
    receipt.assetCount < 1
  ) {
    assetError("INVALID_ASSET_RECEIPT", "The session asset receipt is invalid.");
  }
  return {
    schemaVersion: 1,
    kind: "attend-session-asset-receipt",
    sessionId: receipt.sessionId,
    packageId: receipt.packageId,
    packageSha256: receipt.packageSha256,
    sourceBundleSha256: receipt.sourceBundleSha256,
    manifestSha256: receipt.manifestSha256,
    assetCount: receipt.assetCount,
  };
}

function validateManifest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "attend-session-asset-manifest" ||
    !SESSION_ID.test(value.sessionId ?? "") ||
    typeof value.packageId !== "string" ||
    !SHA256.test(value.packageSha256 ?? "") ||
    !SHA256.test(value.sourceBundleSha256 ?? "") ||
    !Array.isArray(value.assets) ||
    value.assets.length < 1
  ) {
    assetError("INVALID_ASSET_MANIFEST", "The session asset manifest is invalid.");
  }
  const ids = new Set();
  for (const asset of value.assets) {
    if (
      !asset ||
      typeof asset !== "object" ||
      Array.isArray(asset) ||
      !ASSET_ID.test(asset.assetId ?? "") ||
      !SHA256.test(asset.sha256 ?? "") ||
      !Number.isSafeInteger(asset.byteLength) ||
      asset.byteLength < 1 ||
      asset.mimeType !== "image/jpeg" ||
      ids.has(asset.assetId)
    ) {
      assetError("INVALID_ASSET_MANIFEST", "The session asset manifest contains an invalid asset.");
    }
    ids.add(asset.assetId);
  }
  return value;
}

/** Snapshot authorized image bytes before a session is published. */
export async function stageLocalImageSet({ root, sessionId, imageSet, dataPackage } = {}) {
  if (typeof root !== "string" || !root) throw new TypeError("root is required");
  validateSessionId(sessionId);
  const privateSet = privateImageAssets(imageSet);
  if (!privateSet || !Array.isArray(privateSet.assets)) {
    throw new TypeError("imageSet must be the direct result of loadLocalImageSet");
  }
  const realRoot = await realpath(resolve(root));
  if (privateSet.root !== realRoot) {
    assetError("ASSET_ROOT_MISMATCH", "The image set was authorized under a different project root.");
  }
  const packageSha256 = packageDigest(dataPackage);
  const packageId = dataPackage.id;
  if (typeof packageId !== "string" || !packageId) {
    throw new TypeError("dataPackage.id is required for asset binding");
  }
  const directory = assetDirectory(realRoot, sessionId);
  await ensureSafeDirectory(realRoot, directory, 0o700);

  const stagedAssets = [];
  for (const asset of privateSet.assets) {
    const { bytes } = await mediaInternals.readVerifiedFile(
      asset.absolutePath,
      realRoot,
      asset.identity,
    );
    if (
      bytes.length !== asset.byteLength ||
      mediaInternals.digest(bytes) !== asset.sha256
    ) {
      assetError("ASSET_CHANGED", "An authorized image changed before it could be staged.");
    }
    const target = assetPath(realRoot, sessionId, asset.assetId);
    await writeBytesOnce(realRoot, target, bytes);
    stagedAssets.push({
      assetId: asset.assetId,
      sha256: asset.sha256,
      byteLength: asset.byteLength,
      mimeType: "image/jpeg",
      file: `${asset.assetId}.jpg`,
    });
  }
  stagedAssets.sort((left, right) => left.assetId.localeCompare(right.assetId));
  const manifest = {
    schemaVersion: 1,
    kind: "attend-session-asset-manifest",
    sessionId,
    packageId,
    packageSha256,
    sourceBundleSha256: privateSet.sourceBundleSha256,
    assets: stagedAssets,
  };
  const targetManifest = manifestPath(realRoot, sessionId);
  try {
    const existing = await readJson(targetManifest);
    if (JSON.stringify(existing) !== JSON.stringify(manifest)) {
      assetError("ASSET_STORAGE_CONFLICT", "This session id already has a different asset manifest.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeJsonAtomic(targetManifest, manifest, { root: realRoot });
  }
  const assetReceipt = {
    schemaVersion: 1,
    kind: "attend-session-asset-receipt",
    sessionId,
    packageId,
    packageSha256,
    sourceBundleSha256: privateSet.sourceBundleSha256,
    manifestSha256: manifestDigest(manifest),
    assetCount: stagedAssets.length,
  };
  return { assetReceipt, manifest };
}

/** Validate the private receipt before it is attached to a published session. */
export async function validateSessionAssetReceipt({ root, sessionId, dataPackage, receipt } = {}) {
  const normalized = normalizedReceipt(receipt);
  if (normalized.sessionId !== validateSessionId(sessionId)) {
    assetError("ASSET_SESSION_MISMATCH", "The asset receipt belongs to a different session.");
  }
  if (
    normalized.packageId !== dataPackage?.id ||
    normalized.packageSha256 !== packageDigest(dataPackage)
  ) {
    assetError("ASSET_PACKAGE_MISMATCH", "The asset receipt belongs to a different data package.");
  }
  let manifest;
  try {
    manifest = validateManifest(await readJson(manifestPath(root, sessionId)));
  } catch (error) {
    if (error?.code === "ENOENT") {
      assetError("ASSET_NOT_FOUND", "The staged asset manifest is unavailable.");
    }
    throw error;
  }
  if (
    manifestDigest(manifest) !== normalized.manifestSha256 ||
    manifest.sessionId !== sessionId ||
    manifest.packageId !== normalized.packageId ||
    manifest.packageSha256 !== normalized.packageSha256 ||
    manifest.sourceBundleSha256 !== normalized.sourceBundleSha256 ||
    manifest.assets.length !== normalized.assetCount
  ) {
    assetError("ASSET_MANIFEST_MISMATCH", "The staged asset manifest does not match its receipt.");
  }
  return normalized;
}

/** Resolve only an asset listed by the owning session's hash-bound manifest. */
export async function readSessionAsset({ root, session, assetId } = {}) {
  if (!session?.assetReceipt) {
    assetError("ASSET_NOT_FOUND", "The requested session has no image assets.");
  }
  const receipt = await validateSessionAssetReceipt({
    root,
    sessionId: session.id,
    dataPackage: session.dataPackage,
    receipt: session.assetReceipt,
  });
  const manifest = validateManifest(await readJson(manifestPath(root, session.id)));
  const asset = manifest.assets.find((candidate) => candidate.assetId === assetId);
  if (!asset || !ASSET_ID.test(assetId ?? "")) {
    assetError("ASSET_NOT_FOUND", "The requested session asset is unavailable.");
  }
  let bytes;
  try {
    ({ bytes } = await mediaInternals.readVerifiedFile(
      assetPath(root, session.id, assetId),
      resolve(root),
    ));
  } catch (error) {
    if (["ENOENT", "IMAGE_SET_INELIGIBLE"].includes(error?.code)) {
      assetError("ASSET_NOT_FOUND", "The requested session asset is unavailable.");
    }
    throw error;
  }
  if (
    bytes.length !== asset.byteLength ||
    mediaInternals.digest(bytes) !== asset.sha256 ||
    receipt.manifestSha256 !== manifestDigest(manifest)
  ) {
    assetError("ASSET_CHANGED", "The staged session asset is unavailable.");
  }
  return {
    bytes,
    assetId,
    mimeType: "image/jpeg",
    byteLength: bytes.length,
    sha256: asset.sha256,
  };
}

export const sessionAssetPaths = Object.freeze({ directory: ASSET_DIRECTORY });
