import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { libraryMetadataForArtifact } from "./artifacts/index.js";
import {
  assertSafeWritePath,
  ensureSafeDirectory,
  writeJsonAtomic,
} from "./project.js";

const CHAT_THREAD_SCHEMA_VERSION = 1;
const CHAT_THREAD_DIRECTORY = ".attend/local/chat-threads";
const CHAT_THREAD_ID = /^thread_[a-f0-9]{24}$/u;
const LEGACY_CHAT_THREAD_ID = /^legacy_[a-f0-9]{24}$/u;
const LOCK_RETRY_DELAYS_MS = [10, 20, 40, 80, 120, 160, 200, 250];
const MALFORMED_LOCK_STALE_MS = 2_000;

function cloneJson(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable: ${error.message}`);
  }
  if (encoded === undefined) throw new TypeError(`${label} must be JSON-serializable`);
  return JSON.parse(encoded);
}

export function validateChatThreadId(threadId, { allowLegacy = true } = {}) {
  if (
    typeof threadId !== "string" ||
    (!CHAT_THREAD_ID.test(threadId) && !(allowLegacy && LEGACY_CHAT_THREAD_ID.test(threadId)))
  ) {
    const error = new TypeError("threadId must be a valid Attend chat thread id");
    error.code = "INVALID_CHAT_THREAD_ID";
    throw error;
  }
  return threadId;
}

function threadsDirectory(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("A project root is required");
  }
  return resolve(root, CHAT_THREAD_DIRECTORY);
}

export function chatThreadFilePath({ root, threadId }) {
  return join(
    threadsDirectory(root),
    `${validateChatThreadId(threadId, { allowLegacy: false })}.json`,
  );
}

export function legacyChatThreadId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("sessionId must be a non-empty string");
  }
  return `legacy_${createHash("sha256").update(sessionId).digest("hex").slice(0, 24)}`;
}

export function pageDescriptorForSession(session) {
  if (!session || typeof session !== "object" || typeof session.id !== "string") {
    throw new TypeError("A stored session is required");
  }
  let label = session.id;
  try {
    label = libraryMetadataForArtifact(session.dataPackage).question || session.id;
  } catch {
    // A caller that already validated the session still gets a safe fallback.
  }
  return { sessionId: session.id, label };
}

function normalizePage(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    typeof value.label !== "string" ||
    value.label.length === 0
  ) {
    throw new TypeError(`${label} must contain a sessionId and label`);
  }
  return { sessionId: value.sessionId, label: value.label };
}

function normalizeChatThread(value, expectedId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Chat thread record must be an object");
  }
  const id = validateChatThreadId(value.id, { allowLegacy: false });
  if (expectedId !== undefined && id !== expectedId) {
    throw new TypeError("Chat thread record id does not match its file name");
  }
  if (value.schemaVersion !== CHAT_THREAD_SCHEMA_VERSION) {
    throw new TypeError("Unsupported chat thread schema version");
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new TypeError("Chat thread createdAt must be an ISO timestamp");
  }
  return {
    schemaVersion: CHAT_THREAD_SCHEMA_VERSION,
    id,
    createdAt: value.createdAt,
    initialPage: normalizePage(value.initialPage, "initialPage"),
  };
}

async function readThread(path, threadId) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      const missing = new Error(`Chat thread not found: ${threadId}`);
      missing.code = "CHAT_THREAD_NOT_FOUND";
      throw missing;
    }
    throw error;
  }
  try {
    return normalizeChatThread(JSON.parse(source), threadId);
  } catch (error) {
    if (error?.code === "CHAT_THREAD_NOT_FOUND") throw error;
    const invalid = new Error(`Chat thread is invalid: ${threadId}`);
    invalid.code = "INVALID_CHAT_THREAD";
    invalid.cause = error;
    throw invalid;
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return null;
  }
}

async function reclaimStaleLock(lockPath) {
  let info;
  let metadata;
  try {
    info = await lstat(lockPath);
    if (info.isSymbolicLink() || !info.isFile()) return false;
    metadata = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    metadata = null;
  }
  const alive = processIsAlive(metadata?.pid);
  const stale = alive === false || (
    alive === null && Date.now() - info.mtimeMs >= MALFORMED_LOCK_STALE_MS
  );
  if (!stale) return false;
  const current = await lstat(lockPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!current) return true;
  if (current.dev !== info.dev || current.ino !== info.ino) return false;
  await unlink(lockPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return true;
}

async function acquireLock(path, threadId) {
  const lockPath = `${path}.lock`;
  const owner = randomUUID();
  for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({
          pid: process.pid,
          owner,
          createdAt: new Date().toISOString(),
        })}\n`);
        await handle.sync();
        const info = await handle.stat();
        return { handle, lockPath, dev: info.dev, ino: info.ino };
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
        throw error;
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await reclaimStaleLock(lockPath)) continue;
      if (attempt < LOCK_RETRY_DELAYS_MS.length) {
        await delay(LOCK_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      const busy = new Error(`Chat thread ${threadId} is being updated by another process.`);
      busy.code = "CHAT_THREAD_BUSY";
      throw busy;
    }
  }
  throw new Error("unreachable chat thread lock state");
}

async function releaseLock(lock) {
  if (!lock) return;
  await lock.handle.close().catch(() => {});
  const current = await lstat(lock.lockPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!current || current.dev !== lock.dev || current.ino !== lock.ino) return;
  await unlink(lock.lockPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

export async function withChatThreadLock({ root, threadId, operation }) {
  const safeThreadId = validateChatThreadId(threadId);
  if (typeof operation !== "function") throw new TypeError("operation must be a function");
  const path = join(threadsDirectory(root), `${safeThreadId}.json`);
  await ensureSafeDirectory(root, dirname(path));
  await assertSafeWritePath(root, path);
  let lock;
  try {
    lock = await acquireLock(path, safeThreadId);
    return await operation();
  } finally {
    await releaseLock(lock);
  }
}

export async function createChatThread({ root, session } = {}) {
  const initialPage = pageDescriptorForSession(session);
  const thread = {
    schemaVersion: CHAT_THREAD_SCHEMA_VERSION,
    id: `thread_${randomBytes(12).toString("hex")}`,
    createdAt: new Date().toISOString(),
    initialPage,
  };
  const path = chatThreadFilePath({ root, threadId: thread.id });
  await withChatThreadLock({
    root,
    threadId: thread.id,
    async operation() {
      const exists = await readFile(path).then(() => true, (error) => {
        if (error?.code === "ENOENT") return false;
        throw error;
      });
      if (exists) {
        const collision = new Error(`Chat thread already exists: ${thread.id}`);
        collision.code = "CHAT_THREAD_EXISTS";
        throw collision;
      }
      await writeJsonAtomic(path, thread, { root });
    },
  });
  return cloneJson(thread, "chat thread");
}

export async function loadChatThread({ root, threadId } = {}) {
  const safeThreadId = validateChatThreadId(threadId, { allowLegacy: false });
  const path = chatThreadFilePath({ root, threadId: safeThreadId });
  await assertSafeWritePath(root, path);
  return cloneJson(await readThread(path, safeThreadId), "chat thread");
}

export async function listChatThreadRecords({ root } = {}) {
  const directory = threadsDirectory(root);
  await assertSafeWritePath(root, directory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const threadId = entry.name.slice(0, -5);
    if (!CHAT_THREAD_ID.test(threadId)) continue;
    try {
      records.push(await readThread(join(directory, entry.name), threadId));
    } catch {
      // One corrupt chat must not hide healthy local history.
    }
  }
  return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
