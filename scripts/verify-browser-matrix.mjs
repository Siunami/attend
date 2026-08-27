#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CATALOG_VERSION,
  catalogReceiptForMember,
  listCatalogFamilies,
} from "../src/catalog/index.js";
import {
  registerHostAttachment,
  resolveChatRoute,
} from "../src/chat-route.js";
import { requireMapFamily } from "../src/map-families/registry.js";
import { compileMapWithEvidence } from "../src/pipeline/compile.js";
import { createViewerServer } from "../src/server.js";
import { createSession } from "../src/session-store.js";
import SAMPLE_SOURCES from "../viewer/family-datasets.js";
import { toCompilerRequest } from "../viewer/family-compiler-adapter.js";

const VIEWER_ASSETS = fileURLToPath(new URL("../viewer/", import.meta.url));
const DEFAULT_TIMEOUT_MS = 12_000;
const CATALOG_SYNC_TIMEOUT_MS = 20_000;
const OPAQUE_EVIDENCE_ID = /^evidence_[a-f0-9]{16}$/u;

const VIEWPORTS = Object.freeze([
  { id: "desktop", width: 1_440, height: 1_000, mobile: false },
  { id: "mobile", width: 390, height: 844, mobile: true },
]);

const REQUIRED_RESOURCE_SUFFIXES = Object.freeze([
  "app.js",
  "styles.css",
  "package-model.js",
  "package-renderer.js",
  "family-renderers.js",
  "vendor/d3.min.js",
  "vendor/topojson-client.min.js",
  "api/data",
  "api/state",
]);

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function bounded(value, maximum = 400) {
  const text = String(value ?? "").replaceAll(/\s+/gu, " ").trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function errorMessage(error) {
  return bounded(error instanceof Error ? error.message : error);
}

async function retry(operation, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = 75,
  label = "condition",
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  const suffix = lastError ? `: ${errorMessage(lastError)}` : "";
  throw new Error(`Timed out waiting for ${label}${suffix}`);
}

async function executablePath(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next known installation path.
    }
  }
  throw new Error("Google Chrome is not installed in a known location. Set ATTEND_CHROME_PATH to its executable.");
}

async function launchChrome(profileDirectory) {
  const chromePath = await executablePath([
    process.env.ATTEND_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ]);
  const stderr = [];
  const child = spawn(chromePath, [
    "--headless=new",
    "--disable-background-networking",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-features=MediaRouter,OptimizationHints,Translate",
    "--disable-gpu",
    "--disable-sync",
    "--metrics-recording-only",
    "--mute-audio",
    "--no-default-browser-check",
    "--no-first-run",
    "--password-store=basic",
    "--remote-allow-origins=*",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDirectory}`,
    "--use-mock-keychain",
    "about:blank",
  ], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.join("").length < 8_000) stderr.push(String(chunk));
  });
  let exit = null;
  const exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      resolveExit(exit);
    });
  });

  const activePortPath = join(profileDirectory, "DevToolsActivePort");
  let port;
  try {
    port = await retry(async () => {
      if (exit) throw new Error(`Chrome exited with ${exit.code ?? exit.signal}: ${bounded(stderr.join(""), 1_000)}`);
      const lines = (await readFile(activePortPath, "utf8")).trim().split(/\r?\n/u);
      const parsed = Number.parseInt(lines[0], 10);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    }, { label: "Chrome DevTools port" });
  } catch (error) {
    if (!exit) child.kill("SIGTERM");
    throw error;
  }

  const devtoolsOrigin = `http://127.0.0.1:${port}`;
  const versionResponse = await fetch(`${devtoolsOrigin}/json/version`);
  if (!versionResponse.ok) throw new Error(`Chrome DevTools version endpoint returned ${versionResponse.status}`);
  const version = await versionResponse.json();

  return {
    child,
    chromePath,
    devtoolsOrigin,
    exited,
    get exit() {
      return exit;
    },
    product: version.Browser ?? version.Product ?? "Google Chrome",
    stderr: () => bounded(stderr.join(""), 1_000),
  };
}

async function stopChrome(chrome) {
  if (!chrome || chrome.exit) return;
  chrome.child.kill("SIGTERM");
  await Promise.race([chrome.exited, sleep(2_000)]);
  if (!chrome.exit) {
    chrome.child.kill("SIGKILL");
    await Promise.race([chrome.exited, sleep(2_000)]);
  }
}

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error("Timed out opening the Chrome DevTools WebSocket")), DEFAULT_TIMEOUT_MS);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectOpen(new Error("Chrome DevTools WebSocket failed to open"));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.handlerErrors = [];
    socket.addEventListener("message", (event) => {
      void this.#receive(event.data);
    });
    socket.addEventListener("close", () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("Chrome DevTools WebSocket closed"));
      }
      this.pending.clear();
    });
  }

  async #receive(data) {
    try {
      let source;
      if (typeof data === "string") source = data;
      else if (data instanceof Blob) source = await data.text();
      else source = Buffer.from(data).toString("utf8");
      const message = JSON.parse(source);
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        } else {
          pending.resolve(message.result ?? {});
        }
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) {
        try {
          listener(message.params ?? {});
        } catch (error) {
          this.handlerErrors.push(errorMessage(error));
        }
      }
    } catch (error) {
      this.handlerErrors.push(`CDP message: ${errorMessage(error)}`);
    }
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  command(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCommand(new Error(`${method}: command timed out`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve: resolveCommand, reject: rejectCommand, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}

async function createPage(chrome) {
  const response = await fetch(`${chrome.devtoolsOrigin}/json/new?about%3Ablank`, { method: "PUT" });
  if (!response.ok) throw new Error(`Chrome could not create a page target (${response.status})`);
  const target = await response.json();
  if (!target.id || !target.webSocketDebuggerUrl) throw new Error("Chrome returned an incomplete page target");
  return target;
}

async function closePage(chrome, target, client) {
  client?.close();
  if (!target?.id) return;
  await fetch(`${chrome.devtoolsOrigin}/json/close/${encodeURIComponent(target.id)}`).catch(() => {});
}

async function evaluate(client, expression) {
  const result = await client.command("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? "Runtime.evaluate failed";
    throw new Error(bounded(description, 1_000));
  }
  return result.result?.value;
}

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
}

function browserIssueRecorder(client, viewerOrigin) {
  const issues = [];
  const requests = new Map();
  const responses = [];
  const add = (kind, text) => issues.push({ kind, text: bounded(text, 600) });

  client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    add("page-exception", exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? "Uncaught exception");
  });
  client.on("Runtime.consoleAPICalled", ({ type, args = [] }) => {
    if (type !== "error" && type !== "assert") return;
    add("console-error", args.map((argument) => argument.value ?? argument.description ?? argument.type).join(" "));
  });
  client.on("Log.entryAdded", ({ entry }) => {
    if (entry?.level === "error") add("page-log", entry.text);
  });
  client.on("Inspector.targetCrashed", () => add("page-crash", "Chrome renderer process crashed"));
  client.on("Page.javascriptDialogOpening", ({ message }) => add("dialog", message || "Unexpected JavaScript dialog"));
  client.on("Network.requestWillBeSent", ({ requestId, request }) => {
    requests.set(requestId, request?.url ?? "");
  });
  client.on("Network.responseReceived", ({ response, type }) => {
    const url = response?.url ?? "";
    if (url.startsWith(viewerOrigin)) {
      responses.push({
        url,
        status: response.status,
        type,
        headers: normalizeHeaders(response.headers),
      });
      if (response.status >= 400) add("http-error", `${response.status} ${url}`);
    }
  });
  client.on("Network.loadingFailed", ({ requestId, errorText, canceled }) => {
    const url = requests.get(requestId) ?? "";
    if (url.startsWith(viewerOrigin) && !canceled) add("network-error", `${errorText}: ${url}`);
  });

  return { issues, requests, responses };
}

async function waitForLoad(client) {
  return new Promise((resolveLoad, rejectLoad) => {
    const timer = setTimeout(() => rejectLoad(new Error("Page.loadEventFired did not arrive")), DEFAULT_TIMEOUT_MS);
    const listener = () => {
      clearTimeout(timer);
      resolveLoad();
    };
    client.on("Page.loadEventFired", listener);
  });
}

function assertPageResources(recorder, viewerUrl) {
  const documentUrl = new URL(viewerUrl);
  documentUrl.hash = "";
  const documentResponse = recorder.responses.find(
    (response) => response.type === "Document" && response.url === documentUrl.href,
  );
  if (!documentResponse || documentResponse.status !== 200) {
    throw new Error("The viewer document did not load with HTTP 200");
  }
  const csp = documentResponse.headers["content-security-policy"] ?? "";
  if (!csp.includes("default-src 'self'") || !csp.includes("script-src 'self'")) {
    throw new Error("The viewer document did not carry its self-only Content-Security-Policy");
  }
  const loadedUrls = recorder.responses
    .filter((response) => response.status === 200)
    .map((response) => new URL(response.url).pathname);
  const missing = REQUIRED_RESOURCE_SUFFIXES.filter((suffix) => !loadedUrls.some((url) => url.endsWith(suffix)));
  if (missing.length) throw new Error(`Viewer resources did not load: ${missing.join(", ")}`);
  if ([...recorder.requests.values()].some((url) => /\/api\/chat(?:\/|$)/u.test(new URL(url).pathname))) {
    throw new Error("Browser verification must not call the chat worker");
  }
}

async function markReady(client) {
  let lastObservation = null;
  try {
    return await retry(async () => {
      const result = await evaluate(client, `(() => {
        const root = document.getElementById("atlas-visual");
        const mark = root?.querySelector("[data-mark-id]");
        const abstention = document.getElementById("atlas-abstention");
        if (!root) return { ready: false, reason: "missing-root" };
        if (abstention && !abstention.hidden) {
          return { ready: false, reason: "abstained", detail: abstention.textContent || "Renderer abstained" };
        }
        if (root.getAttribute("aria-busy") !== "false") {
          return { ready: false, reason: "busy", markCount: root.querySelectorAll("[data-mark-id]").length };
        }
        if (!mark) {
          return {
            ready: false,
            reason: "missing-mark",
            childCount: root.childElementCount,
            text: (root.textContent || "").slice(0, 160),
          };
        }
        const style = getComputedStyle(mark);
        const rect = mark.getBoundingClientRect();
        const strokeWidth = Number.parseFloat(style.strokeWidth);
        const paintedStroke = style.stroke !== "none"
          && style.stroke !== "transparent"
          && Number.isFinite(strokeWidth)
          && strokeWidth > 0
          && (rect.width > 0 || rect.height > 0);
        const paintedArea = rect.width > 0 && rect.height > 0;
        const visible = style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity) > 0
          && (paintedArea || paintedStroke)
          && rect.right > 0
          && rect.bottom > 0
          && rect.left < innerWidth
          && rect.top < innerHeight;
        return {
          ready: visible && mark.tabIndex === 0 && mark.getAttribute("role") === "button",
          id: mark.getAttribute("data-mark-id"),
          label: mark.getAttribute("aria-label"),
          visible,
          tabIndex: mark.tabIndex,
          role: mark.getAttribute("role"),
          pressed: mark.getAttribute("aria-pressed"),
          size: [Math.round(rect.width), Math.round(rect.height)],
        };
      })()`);
      lastObservation = result;
      if (!result?.ready) return null;
      return result;
    }, { label: "a visible and focusable Atlas mark" });
  } catch (error) {
    throw new Error(`${errorMessage(error)}; last observation: ${bounded(JSON.stringify(lastObservation), 800)}`);
  }
}

async function focusFirstMark(client, expectedId) {
  const result = await evaluate(client, `(() => {
    const mark = document.querySelector("[data-mark-id]");
    if (!mark) return null;
    mark.focus({ preventScroll: true });
    return {
      id: mark.getAttribute("data-mark-id"),
      focused: document.activeElement === mark,
    };
  })()`);
  if (!result?.focused || result.id !== expectedId) throw new Error("The first Atlas mark could not receive keyboard focus");
}

async function pressEnter(client) {
  await client.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    text: "\r",
    unmodifiedText: "\r",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await client.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

async function selectedState(viewerUrl, markId, expectedEvidenceRefs) {
  const expected = [...expectedEvidenceRefs].sort();
  return retry(async () => {
    const response = await fetch(new URL("api/state", viewerUrl), { cache: "no-store" });
    if (!response.ok) throw new Error(`state endpoint returned ${response.status}`);
    const value = await response.json();
    const stateMarks = value.state?.markIds ?? [];
    const selectedMarks = value.selection?.selectedMarkIds ?? [];
    const evidenceRefs = value.selection?.evidenceRefIds ?? [];
    if (stateMarks.length !== 1 || stateMarks[0] !== markId) return null;
    if (selectedMarks.length !== 1 || selectedMarks[0] !== markId) return null;
    if (value.selection?.stateRevision !== 1) return null;
    if (!evidenceRefs.length || !evidenceRefs.every((id) => OPAQUE_EVIDENCE_ID.test(id))) {
      throw new Error("Selected state did not expose opaque evidence linkage");
    }
    if (JSON.stringify([...evidenceRefs].sort()) !== JSON.stringify(expected)) {
      throw new Error("Selected state evidence linkage does not match the canonical mark");
    }
    return value;
  }, { label: "the selected mark in /api/state" });
}

async function attachmentReady(client, markId, label, evidenceCount) {
  return retry(async () => evaluate(client, `(() => {
    const panel = document.getElementById("selection-panel");
    const attachment = panel?.querySelector(".atlas-selection-attachment");
    const mark = document.querySelector(${JSON.stringify(`[data-mark-id="${markId}"]`)});
    if (!panel || panel.hidden || !attachment || !mark) return null;
    const rect = attachment.getBoundingClientRect();
    const style = getComputedStyle(attachment);
    const names = attachment.querySelector(".attachment-phrase")?.textContent ?? "";
    const meta = attachment.querySelector(".attachment-meta")?.textContent ?? "";
    const pane = document.getElementById("chat-pane");
    const input = document.getElementById("chat-input");
    return {
      visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
      names,
      meta,
      chatOpen: pane?.getAttribute("aria-hidden") === "false" && !pane?.inert,
      inputFocused: document.activeElement === input,
      markPressed: mark.getAttribute("aria-pressed") === "true",
    };
  })()`).then((value) => {
    if (!value?.visible || !value.chatOpen || !value.inputFocused || !value.markPressed) return null;
    if (!value.names.includes(label)) throw new Error("Chat attachment does not name the selected mark");
    if (!value.meta.includes(`${evidenceCount} evidence reference${evidenceCount === 1 ? "" : "s"}`)) {
      throw new Error("Chat attachment does not report the selected evidence count");
    }
    return value;
  }), { label: "the selected-mark chat attachment" });
}

async function verifyCase({ chrome, viewerUrl, viewport, dataPackage }) {
  const startedAt = Date.now();
  const target = await createPage(chrome);
  let client;
  try {
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    const viewerOrigin = new URL(viewerUrl).origin;
    const recorder = browserIssueRecorder(client, viewerOrigin);
    await Promise.all([
      client.command("Inspector.enable"),
      client.command("Log.enable"),
      client.command("Network.enable"),
      client.command("Page.enable"),
      client.command("Runtime.enable"),
    ]);
    await client.command("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });
    const loaded = waitForLoad(client);
    const navigation = await client.command("Page.navigate", { url: viewerUrl });
    if (navigation.errorText) throw new Error(`Page navigation failed: ${navigation.errorText}`);
    await loaded;

    const mark = await markReady(client);
    const canonicalMark = dataPackage.marks.find((candidate) => candidate.id === mark.id);
    if (!canonicalMark) throw new Error(`Rendered mark ${mark.id} is not in the canonical package`);
    if (!canonicalMark.evidenceRefs?.length) throw new Error(`Canonical mark ${mark.id} has no evidence linkage`);
    if (!canonicalMark.evidenceRefs.every((id) => OPAQUE_EVIDENCE_ID.test(id))) {
      throw new Error(`Canonical mark ${mark.id} carries a non-opaque evidence reference`);
    }

    await focusFirstMark(client, mark.id);
    await pressEnter(client);
    const state = await selectedState(viewerUrl, mark.id, canonicalMark.evidenceRefs);
    await attachmentReady(client, mark.id, canonicalMark.label, canonicalMark.evidenceRefs.length);
    await sleep(100);
    assertPageResources(recorder, viewerUrl);
    if (client.handlerErrors.length) throw new Error(client.handlerErrors.join("; "));
    if (recorder.issues.length) {
      throw new Error(recorder.issues.map((issue) => `${issue.kind}: ${issue.text}`).join("; "));
    }
    return {
      status: "pass",
      markId: mark.id,
      revision: state.state.revision,
      evidenceRefs: state.selection.evidenceRefCount,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await closePage(chrome, target, client);
  }
}

async function waitForBrowserCatalog(viewerUrl) {
  return retry(async () => {
    const response = await fetch(new URL("package-model.js", viewerUrl), { cache: "no-store" });
    if (!response.ok) throw new Error(`package-model.js returned ${response.status}`);
    const source = await response.text();
    const snapshot = /ATLAS_CATALOG_VERSION\s*=\s*"([a-f0-9]+)"/u.exec(source)?.[1];
    if (!snapshot) throw new Error("package-model.js does not declare ATLAS_CATALOG_VERSION");
    return snapshot === CATALOG_VERSION ? snapshot : null;
  }, {
    timeoutMs: CATALOG_SYNC_TIMEOUT_MS,
    intervalMs: 250,
    label: `the browser catalog snapshot to match backend ${CATALOG_VERSION}`,
  });
}

async function compileFamilies(root) {
  const available = [];
  const skipped = [];
  const catalogFamilies = listCatalogFamilies();
  const requestedIds = (process.env.ATTEND_BROWSER_FAMILIES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const unknownIds = requestedIds.filter((id) => !catalogFamilies.some((family) => family.id === id));
  if (unknownIds.length) throw new Error(`Unknown ATTEND_BROWSER_FAMILIES: ${unknownIds.join(", ")}`);
  const included = requestedIds.length
    ? catalogFamilies.filter((family) => requestedIds.includes(family.id))
    : catalogFamilies;
  for (const family of included) {
    const member = family.members.find((candidate) => candidate.status === "executable");
    if (!member) {
      const unavailable = family.members.find((candidate) => candidate.status === "unavailable");
      if (!unavailable) throw new Error(`${family.id} has neither an executable nor an explicitly unavailable catalog member`);
      skipped.push({
        family: family.id,
        member: unavailable.id,
        status: "unavailable",
        reason: unavailable.unavailableReason,
      });
      continue;
    }
    const dataset = SAMPLE_SOURCES[family.id];
    if (!dataset) throw new Error(`${family.id} has no synthetic family dataset`);
    const manifest = requireMapFamily(family.id);
    const request = await toCompilerRequest(dataset, manifest, { availableWidth: 1_200 });
    request.catalog = catalogReceiptForMember(family.id, member.id);
    request.options = {
      ...request.options,
      variant: member.rendererVariantId,
    };
    const { dataPackage } = await compileMapWithEvidence(request);
    const sessions = {};
    for (const viewport of VIEWPORTS) {
      const sessionId = `browser_${family.id}_${viewport.id}`;
      await createSession({ root, id: sessionId, dataPackage });
      const attachment = await registerHostAttachment({ root, sessionId });
      sessions[viewport.id] = {
        id: sessionId,
        route: attachment.route,
      };
    }
    available.push({ family, member, dataPackage, sessions });
  }
  return { available, skipped };
}

async function main() {
  const startedAt = Date.now();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "attend-browser-matrix-"));
  const profileDirectory = join(temporaryRoot, "chrome-profile");
  let chrome;
  let viewer;
  const summary = {
    ok: false,
    catalogVersion: CATALOG_VERSION,
    chrome: null,
    counts: {
      families: 0,
      executable: 0,
      unavailable: 0,
      cases: 0,
      passed: 0,
      failed: 0,
    },
    skipped: [],
    families: [],
    failures: [],
    durationMs: 0,
  };
  try {
    const { available, skipped } = await compileFamilies(temporaryRoot);
    summary.counts.families = available.length + skipped.length;
    summary.counts.executable = available.length;
    summary.counts.unavailable = skipped.length;
    summary.counts.cases = available.length * VIEWPORTS.length;
    summary.skipped = skipped;

    viewer = await createViewerServer({
      root: temporaryRoot,
      assetsDir: VIEWER_ASSETS,
      token: "browser-matrix-token-0123456789",
      instanceId: "browser-matrix-instance-0123456789",
      chatCapability: async ({ sessionId, hostRoute }) => {
        const route = await resolveChatRoute({
          root: temporaryRoot,
          sessionId,
          hostRoute,
          requireHostRoute: true,
        });
        return {
          defaultRoute: "host",
          active: {
            kind: "host",
            label: route ? "Browser matrix host" : "No coding agent attached",
            ownership: route ? "this-view" : "unattached",
            listener: "not-listening",
            registered: Boolean(route),
            disclosure: route
              ? "Selected evidence is returned to this browser-matrix host attachment."
              : "Sidebar chat is unavailable from this unbound library link.",
          },
        };
      },
    });
    const firstSession = available[0]?.sessions.desktop?.id;
    if (!firstSession) throw new Error("The backend catalog has no executable families to verify");
    await waitForBrowserCatalog(new URL(`s/${firstSession}/`, viewer.libraryUrl));

    chrome = await launchChrome(profileDirectory);
    summary.chrome = { path: chrome.chromePath, product: chrome.product };

    for (const entry of available) {
      const familyResult = { id: entry.family.id, member: entry.member.id };
      for (const viewport of VIEWPORTS) {
        const session = entry.sessions[viewport.id];
        const viewerUrl = new URL(`s/${session.id}/`, viewer.libraryUrl);
        viewerUrl.hash = new URLSearchParams({
          "attend-host": session.route.attachmentId,
          "attend-generation": String(session.route.generation),
        });
        try {
          familyResult[viewport.id] = await verifyCase({
            chrome,
            viewerUrl: viewerUrl.href,
            viewport,
            dataPackage: entry.dataPackage,
          });
          summary.counts.passed += 1;
        } catch (error) {
          const failure = {
            family: entry.family.id,
            member: entry.member.id,
            viewport: viewport.id,
            error: errorMessage(error),
          };
          familyResult[viewport.id] = { status: "fail", error: failure.error };
          summary.failures.push(failure);
          summary.counts.failed += 1;
        }
      }
      summary.families.push(familyResult);
    }
    summary.ok = summary.counts.failed === 0
      && summary.counts.passed === summary.counts.cases;
  } catch (error) {
    summary.failures.push({ phase: "setup", error: errorMessage(error) });
    summary.counts.failed += 1;
  } finally {
    await viewer?.close().catch(() => {});
    await stopChrome(chrome);
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    summary.durationMs = Date.now() - startedAt;
  }

  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (!summary.ok) process.exitCode = 1;
}

await main();
