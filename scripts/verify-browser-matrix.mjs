#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CATALOG_VERSION,
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
import { formFixtureDataset, toCompilerRequest } from "../viewer/family-compiler-adapter.js";
import { GENERATED_FORM_RUNTIME } from "../viewer/form-runtime-generated.js";

const VIEWER_ASSETS = fileURLToPath(new URL("../viewer/", import.meta.url));
const DEFAULT_TIMEOUT_MS = 12_000;
const CATALOG_SYNC_TIMEOUT_MS = 20_000;
const DEVTOOLS_FETCH_TIMEOUT_MS = 10_000;
const DEVTOOLS_PORT_TIMEOUT_MS = 30_000;
const STALE_PROFILE_AGE_MS = 60 * 60 * 1_000;
const OPAQUE_EVIDENCE_ID = /^evidence_[a-f0-9]{16}$/u;
const STRESS_SAMPLE_RASTER_SIDE = process.env.ATTEND_BROWSER_STRESS_SAMPLE_RASTER === "1"
  ? Number.parseInt(process.env.ATTEND_BROWSER_STRESS_SAMPLE_RASTER_SIDE ?? "50", 10)
  : null;
if (STRESS_SAMPLE_RASTER_SIDE !== null && (
  !Number.isSafeInteger(STRESS_SAMPLE_RASTER_SIDE)
  || STRESS_SAMPLE_RASTER_SIDE < 5
  || STRESS_SAMPLE_RASTER_SIDE > 50
)) {
  throw new RangeError("ATTEND_BROWSER_STRESS_SAMPLE_RASTER_SIDE must be an integer from 5 through the executable maximum of 50");
}
const STRESS_TREND = process.env.ATTEND_BROWSER_STRESS_TREND === "1";
const STRESS_MATRIX = process.env.ATTEND_BROWSER_STRESS_MATRIX === "1";
const STRESS_MATRIX_ROWS = Object.freeze([
  "Friday",
  "Monday",
  "Saturday",
  "Wednesday",
  "Sunday",
  "Tuesday",
  "Thursday",
]);
const CALENDAR_ROWS = Object.freeze([
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
]);

const AREA_SELECT_FORM_KEY = "trend/line";
const AREA_SELECT_MIN_MARKS = 4;

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

async function devtoolsFetch(url, init = {}) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(DEVTOOLS_FETCH_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Chrome DevTools endpoint ${url} did not answer within ${DEVTOOLS_FETCH_TIMEOUT_MS}ms: ${errorMessage(error)}`);
  }
}

async function pruneStaleProfiles() {
  const entries = await readdir(tmpdir()).catch(() => []);
  const cutoff = Date.now() - STALE_PROFILE_AGE_MS;
  await Promise.all(entries
    .filter((entry) => entry.startsWith("attend-browser-matrix-"))
    .map(async (entry) => {
      const path = join(tmpdir(), entry);
      const info = await stat(path).catch(() => null);
      if (!info || info.mtimeMs > cutoff) return;
      await rm(path, { recursive: true, force: true }).catch(() => {});
    }));
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
  // Ubuntu 24.04 runners restrict unprivileged user namespaces through AppArmor,
  // so Chrome's own sandbox cannot start there. Local runs keep it.
  const sandboxArguments = process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : [];
  const child = spawn(chromePath, [
    ...sandboxArguments,
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
    }, { label: "Chrome DevTools port", timeoutMs: DEVTOOLS_PORT_TIMEOUT_MS });
  } catch (error) {
    if (!exit) child.kill("SIGTERM");
    throw error;
  }

  const devtoolsOrigin = `http://127.0.0.1:${port}`;
  const versionResponse = await devtoolsFetch(`${devtoolsOrigin}/json/version`);
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
  const response = await devtoolsFetch(`${chrome.devtoolsOrigin}/json/new?about%3Ablank`, { method: "PUT" });
  if (!response.ok) throw new Error(`Chrome could not create a page target (${response.status})`);
  const target = await response.json();
  if (!target.id || !target.webSocketDebuggerUrl) throw new Error("Chrome returned an incomplete page target");
  return target;
}

async function closePage(chrome, target, client) {
  client?.close();
  if (!target?.id) return;
  await devtoolsFetch(`${chrome.devtoolsOrigin}/json/close/${encodeURIComponent(target.id)}`).catch(() => {});
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

function browserIssueRecorder(client, viewerOrigin, { allowUnavailableContactAssets = false } = {}) {
  const issues = [];
  const requests = new Map();
  const responses = [];
  const add = (kind, text) => issues.push({ kind, text: bounded(text, 600) });
  const expectedUnavailableAsset = (url) => {
    if (!allowUnavailableContactAssets || typeof url !== "string" || !url) return false;
    try {
      const parsed = new URL(url);
      return parsed.origin === viewerOrigin && /\/s\/[^/]+\/assets\/asset_[a-f0-9]{32}$/u.test(parsed.pathname);
    } catch {
      return false;
    }
  };

  client.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    add("page-exception", exceptionDetails?.exception?.description ?? exceptionDetails?.text ?? "Uncaught exception");
  });
  client.on("Runtime.consoleAPICalled", ({ type, args = [] }) => {
    if (type !== "error" && type !== "assert") return;
    add("console-error", args.map((argument) => argument.value ?? argument.description ?? argument.type).join(" "));
  });
  client.on("Log.entryAdded", ({ entry }) => {
    if (entry?.level !== "error") return;
    if (
      allowUnavailableContactAssets
      && entry.source === "network"
      && /Failed to load resource/iu.test(entry.text ?? "")
      && (!entry.url || expectedUnavailableAsset(entry.url))
    ) return;
    add("page-log", entry.text);
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
      if (response.status >= 400 && !expectedUnavailableAsset(url)) add("http-error", `${response.status} ${url}`);
    }
  });
  client.on("Network.loadingFailed", ({ requestId, errorText, canceled }) => {
    const url = requests.get(requestId) ?? "";
    if (url.startsWith(viewerOrigin) && !canceled && !expectedUnavailableAsset(url)) {
      add("network-error", `${errorText}: ${url}`);
    }
  });

  return { issues, requests, responses };
}

async function contactUnavailableReady(client) {
  return retry(async () => evaluate(client, `(() => {
    const frames = [...document.querySelectorAll(".contact-atlas__frame")];
    const images = [...document.querySelectorAll(".contact-atlas__image")];
    if (frames.length !== 8 || images.length !== 8) return null;
    const unavailable = frames.every((frame) => frame.getAttribute("data-preview-state") === "unavailable")
      && images.every((image) => image.hidden === true);
    return unavailable ? { frameCount: frames.length } : null;
  })()`), { label: "the generated contact fixture to disclose unavailable previews" });
}

async function maximumRasterReady(client, side) {
  const expectedCount = side ** 2;
  return retry(async () => evaluate(client, `(() => {
    const root = document.getElementById("atlas-visual");
    const markCount = root?.querySelectorAll("[data-mark-id]").length ?? 0;
    const nodeCount = root?.querySelectorAll("*").length ?? 0;
    if (markCount !== ${expectedCount} || nodeCount >= ${expectedCount + 100}) return null;
    return { markCount, nodeCount };
  })()`), { label: `the ${side} by ${side} sample raster to remain a bounded selectable DOM` });
}

async function waitForLoad(client, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolveLoad, rejectLoad) => {
    const timer = setTimeout(() => rejectLoad(new Error("Page.loadEventFired did not arrive")), timeoutMs);
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
  if ([...recorder.requests.values()].some((url) => new URL(url).pathname.endsWith("/api/chat"))) {
    throw new Error("Browser verification must not call the chat worker");
  }
}

async function selectableReady(client) {
  let lastObservation = null;
  try {
    return await retry(async () => {
      const result = await evaluate(client, `(() => {
        const root = document.getElementById("atlas-visual");
        const abstention = document.getElementById("atlas-abstention");
        if (!root) return { ready: false, reason: "missing-root" };
        if (abstention && !abstention.hidden) {
          return { ready: false, reason: "abstained", detail: abstention.textContent || "Renderer abstained" };
        }
        if (root.getAttribute("aria-busy") !== "false") {
          return {
            ready: false,
            reason: "busy",
            markCount: root.querySelectorAll("[data-mark-id]").length,
            targetCount: root.querySelectorAll("[data-target-id]").length,
          };
        }
        const marks = [...root.querySelectorAll("[data-mark-id], [data-target-id]")];
        if (!marks.length) {
          return {
            ready: false,
            reason: "missing-selectable",
            childCount: root.childElementCount,
            text: (root.textContent || "").slice(0, 160),
          };
        }
        const observations = marks.map((mark) => {
          const style = getComputedStyle(mark);
          const rect = mark.getBoundingClientRect();
          const strokeWidth = Number.parseFloat(style.strokeWidth);
          const paintedStroke = style.stroke !== "none"
            && style.stroke !== "transparent"
            && Number.isFinite(strokeWidth)
            && strokeWidth > 0
            && (rect.width > 0 || rect.height > 0);
          const paintedArea = rect.width > 0 && rect.height > 0;
          const painted = style.display !== "none"
            && style.visibility !== "hidden"
            && Number(style.opacity) > 0
            && (paintedArea || paintedStroke);
          const visible = painted
            && rect.right > 0
            && rect.bottom > 0
            && rect.left < innerWidth
            && rect.top < innerHeight;
          const kind = mark.hasAttribute("data-target-id") ? "target" : "mark";
          const attribute = kind === "target" ? "data-target-id" : "data-mark-id";
          return {
            ready: painted && mark.getAttribute("role") === "button",
            kind,
            id: mark.getAttribute(attribute),
            label: mark.getAttribute("aria-label"),
            visible,
            tabIndex: mark.tabIndex,
            role: mark.getAttribute("role"),
            pressed: mark.getAttribute("aria-pressed"),
            size: [Math.round(rect.width), Math.round(rect.height)],
          };
        });
        const observation = observations.find((candidate) => candidate.ready && candidate.tabIndex === 0)
          ?? observations.find((candidate) => candidate.ready)
          ?? observations[0];
        return observation;
      })()`);
      lastObservation = result;
      if (!result?.ready) return null;
      return result;
    }, { label: "a visible and focusable Atlas mark or aggregate target" });
  } catch (error) {
    throw new Error(`${errorMessage(error)}; last observation: ${bounded(JSON.stringify(lastObservation), 800)}`);
  }
}

async function focusSelectable(client, selection) {
  const attribute = selection.kind === "target" ? "data-target-id" : "data-mark-id";
  const result = await evaluate(client, `(() => {
    const attribute = ${JSON.stringify(attribute)};
    const expectedId = ${JSON.stringify(selection.id)};
    const mark = [...document.querySelectorAll(${JSON.stringify(`[${attribute}]`)})]
      .find((candidate) => candidate.getAttribute(attribute) === expectedId);
    if (!mark) return null;
    mark.focus();
    const rect = mark.getBoundingClientRect();
    return {
      id: mark.getAttribute(attribute),
      focused: document.activeElement === mark,
      tabIndex: mark.tabIndex,
      role: mark.getAttribute("role"),
      visible: rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight,
    };
  })()`);
  if (!result?.focused || result.id !== selection.id || result.tabIndex !== 0 || result.role !== "button" || !result.visible) {
    throw new Error(`The Atlas evidence target could not enter the roving keyboard focus position: ${bounded(JSON.stringify(result), 500)}`);
  }
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

async function selectedState(viewerUrl, selected, canonical) {
  return retry(async () => {
    const response = await fetch(new URL("api/state", viewerUrl), { cache: "no-store" });
    if (!response.ok) throw new Error(`state endpoint returned ${response.status}`);
    const value = await response.json();
    const stateMarks = value.state?.markIds ?? [];
    const selectedMarks = value.selection?.selectedMarkIds ?? [];
    const evidenceRefs = value.selection?.evidenceRefIds ?? [];
    if (value.selection?.stateRevision !== 1) return null;
    if (!evidenceRefs.length || !evidenceRefs.every((id) => OPAQUE_EVIDENCE_ID.test(id))) {
      throw new Error("Selected state did not expose opaque evidence linkage");
    }
    if (selected.kind === "mark") {
      const expected = [...canonical.evidenceRefs].sort();
      if (stateMarks.length !== 1 || stateMarks[0] !== selected.id) return null;
      if (selectedMarks.length !== 1 || selectedMarks[0] !== selected.id) return null;
      if (value.state?.targetId !== undefined || value.selection?.target !== undefined) return null;
      if (JSON.stringify([...evidenceRefs].sort()) !== JSON.stringify(expected)) {
        throw new Error("Selected state evidence linkage does not match the canonical mark");
      }
    } else {
      if (stateMarks.length !== 0 || selectedMarks.length !== 0) return null;
      if (value.state?.targetId !== selected.id || value.selection?.target?.id !== selected.id) return null;
      if (value.selection?.predicate?.targetId !== selected.id) return null;
      if (value.selection?.target?.count !== canonical.count) {
        throw new Error("Selected aggregate count does not match the canonical visual target");
      }
      if (value.selection?.target?.membershipHash !== canonical.membershipHash) {
        throw new Error("Selected aggregate membership hash does not match the canonical visual target");
      }
    }
    return value;
  }, { label: "the selected Atlas evidence target in /api/state" });
}

async function chatPaneOpen(client) {
  return retry(async () => evaluate(client, `(() => {
    const pane = document.getElementById("chat-pane");
    if (!pane) return null;
    if (pane.getAttribute("aria-hidden") !== "false" || pane.inert) {
      document.getElementById("chat-toggle")?.click();
      return null;
    }
    return { open: true, inputFocused: document.activeElement === document.getElementById("chat-input") };
  })()`), { label: "the chat pane to open for the selection attachment" });
}

async function attachmentReady(client, selection, label, count) {
  const attribute = selection.kind === "target" ? "data-target-id" : "data-mark-id";
  return retry(async () => evaluate(client, `(() => {
    const panel = document.getElementById("selection-panel");
    const attachment = panel?.querySelector(".atlas-selection-attachment");
    const attribute = ${JSON.stringify(attribute)};
    const expectedId = ${JSON.stringify(selection.id)};
    const mark = [...document.querySelectorAll(${JSON.stringify(`[${attribute}]`)})]
      .find((candidate) => candidate.getAttribute(attribute) === expectedId);
    if (!panel || panel.hidden || !attachment || !mark) return null;
    const rect = attachment.getBoundingClientRect();
    const style = getComputedStyle(attachment);
    const names = attachment.querySelector(".attachment-phrase")?.textContent ?? "";
    const targetMembers = panel.querySelector(".target-members-status")?.textContent ?? "";
    const pane = document.getElementById("chat-pane");
    const input = document.getElementById("chat-input");
    return {
      visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
      names,
      targetMembers,
      chatOpen: pane?.getAttribute("aria-hidden") === "false" && !pane?.inert,
      inputFocused: document.activeElement === input,
      pressed: mark.getAttribute("aria-pressed") === "true",
    };
  })()`).then((value) => {
    if (!value?.visible || !value.chatOpen || !value.inputFocused || !value.pressed) return null;
    if (!value.names.includes(label)) throw new Error("Chat attachment does not name the selected evidence target");
    if (selection.kind === "target" && !value.targetMembers.includes(`of ${count}`)) {
      return null;
    }
    return value;
  }), { label: "the selected Atlas chat attachment" });
}

async function targetMembershipPage(viewerUrl, target) {
  const url = new URL("api/target-members", viewerUrl);
  url.search = new URLSearchParams({ targetId: target.id, offset: "0", limit: "12" });
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`target-members endpoint returned ${response.status}`);
  const page = await response.json();
  if (page.target?.id !== target.id || page.count !== target.count || page.membershipHash !== target.membershipHash) {
    throw new Error("Target membership page does not match the canonical visual target");
  }
  if (!Array.isArray(page.markIds) || page.markIds.length < 1 || page.markIds.length > 12) {
    throw new Error("Target membership page is not bounded to complete canonical mark ids");
  }
  return page;
}

async function labelGeometry(client) {
  return evaluate(client, `(() => {
    const parseViewBox = (svg) => {
      const numbers = (svg.getAttribute("viewBox") ?? "").trim().split(/[\\s,]+/u).map(Number);
      return numbers.length === 4 && numbers.every(Number.isFinite) ? numbers : null;
    };
    let root = null;
    let box = null;
    for (const candidate of document.querySelectorAll("#atlas-visual svg")) {
      const parsed = parseViewBox(candidate);
      if (parsed) {
        root = candidate;
        box = parsed;
        break;
      }
    }
    if (!root) return null;
    const painted = (node) => {
      for (let current = node; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (current === root) break;
      }
      return true;
    };
    const nested = (node) => {
      for (let current = node.parentElement; current && current !== root; current = current.parentElement) {
        if (current.tagName.toLowerCase() === "text") return true;
      }
      return false;
    };
    const toRoot = root.getScreenCTM()?.inverse();
    const point = root.createSVGPoint();
    const texts = [];
    for (const node of root.querySelectorAll("text")) {
      if (texts.length >= 400) break;
      const content = (node.textContent ?? "").trim();
      if (!content || nested(node) || !painted(node)) continue;
      try {
        const raw = node.getBBox();
        const matrix = toRoot && node.getScreenCTM() ? toRoot.multiply(node.getScreenCTM()) : null;
        let bbox = { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
        if (matrix) {
          const xs = [];
          const ys = [];
          for (const corner of [
            [raw.x, raw.y],
            [raw.x + raw.width, raw.y],
            [raw.x, raw.y + raw.height],
            [raw.x + raw.width, raw.y + raw.height],
          ]) {
            point.x = corner[0];
            point.y = corner[1];
            const mapped = point.matrixTransform(matrix);
            xs.push(mapped.x);
            ys.push(mapped.y);
          }
          bbox = {
            x: Math.min(...xs),
            y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
          };
        }
        const rect = node.getBoundingClientRect();
        texts.push({
          text: content,
          class: node.getAttribute("class") ?? "",
          anchor: getComputedStyle(node).textAnchor || node.getAttribute("text-anchor") || "",
          bbox,
          clientRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        });
      } catch {
        continue;
      }
    }
    return { viewBox: { minX: box[0], minY: box[1], width: box[2], height: box[3] }, texts };
  })()`);
}

function labelIssues({ viewBox, texts }) {
  const centerY = (entry) => entry.bbox.y + entry.bbox.height / 2;
  const overlaps = [];
  const clips = [];
  for (let index = 0; index < texts.length; index += 1) {
    const first = texts[index];
    if (
      first.bbox.x < viewBox.minX - 1
      || first.bbox.y < viewBox.minY - 1
      || first.bbox.x + first.bbox.width > viewBox.minX + viewBox.width + 1
      || first.bbox.y + first.bbox.height > viewBox.minY + viewBox.height + 1
    ) {
      clips.push({ kind: "label-clip", text: bounded(first.text, 120) });
    }
    for (let other = index + 1; other < texts.length; other += 1) {
      const second = texts[other];
      if (Math.abs(centerY(first) - centerY(second)) > 4) continue;
      const gap = Math.max(first.bbox.x, second.bbox.x)
        - Math.min(first.bbox.x + first.bbox.width, second.bbox.x + second.bbox.width);
      if (gap >= 2) continue;
      overlaps.push({
        kind: "label-overlap",
        text: `${bounded(first.text, 120)} / ${bounded(second.text, 120)} at y≈${Math.round(centerY(first))}`,
      });
    }
  }
  return [...overlaps, ...clips].slice(0, 5);
}

async function areaSelectScenario(client, viewerUrl) {
  const issues = [];
  try {
    const armed = await evaluate(client, `(() => {
      const button = document.getElementById("chat-area-select");
      if (!button) return { state: "missing" };
      if (button.hidden) return { state: "hidden" };
      button.click();
      return { state: "clicked" };
    })()`);
    if (armed?.state === "missing") {
      return [{ kind: "area-select", text: "#chat-area-select is not in the composer" }];
    }
    if (armed?.state === "hidden") {
      return [{ kind: "area-select", text: "#chat-area-select stays hidden on an Atlas package that offers area selection" }];
    }
    await retry(async () => evaluate(client, `(() => {
      const button = document.getElementById("chat-area-select");
      const workspace = document.getElementById("workspace");
      if (button?.getAttribute("aria-pressed") !== "true") return null;
      return workspace?.dataset.areaSelect === "true" ? { armed: true } : null;
    })()`), { label: "area select mode to arm before the drag" });

    const drag = await evaluate(client, `(() => {
      const svg = document.querySelector("#atlas-visual svg");
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      const pane = document.getElementById("chat-pane");
      const paneRect = pane && pane.getAttribute("aria-hidden") === "false" ? pane.getBoundingClientRect() : null;
      const limit = Math.min(rect.right, paneRect ? paneRect.left : Infinity, innerWidth) - 2;
      const describe = (node) => (node
        ? \`\${node.tagName.toLowerCase()}\${node.id ? "#" + node.id : ""}\${node.getAttribute("class") ? "." + node.getAttribute("class") : ""}\`
        : "nothing");
      const candidates = [];
      for (const fractionY of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        for (const fractionX of [0.08, 0.16, 0.03, 0.28, 0.4]) {
          candidates.push({ x: rect.left + rect.width * fractionX, y: rect.top + rect.height * fractionY });
        }
      }
      const reachable = candidates.filter((point) => point.x > 1 && point.y > 1 && point.x < limit && point.y < innerHeight - 1);
      const press = reachable.find((point) => svg.contains(document.elementFromPoint(point.x, point.y))) ?? null;
      return {
        press,
        release: { x: Math.min(rect.right - 4, limit), y: Math.min(rect.bottom - 4, innerHeight - 2) },
        paneLeft: paneRect ? paneRect.left : null,
        probed: reachable.length,
        hitAt: reachable.length ? describe(document.elementFromPoint(reachable[0].x, reachable[0].y)) : "no reachable point",
      };
    })()`);
    if (!drag) return [{ kind: "area-select", text: "the Atlas chart svg is gone before the area drag" }];
    if (!drag.press) {
      return [{
        kind: "area-select",
        text: `no point of the Atlas chart svg is clear of the chat drawer edge x=${Math.round(drag.paneLeft ?? -1)}; ${drag.probed} candidates probed, the first resolved to ${drag.hitAt}`,
      }];
    }

    const press = { x: Math.round(drag.press.x), y: Math.round(drag.press.y) };
    const release = { x: Math.round(drag.release.x), y: Math.round(drag.release.y) };
    await client.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: press.x,
      y: press.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    for (let step = 1; step <= 4; step += 1) {
      await client.command("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(press.x + ((release.x - press.x) * step) / 4),
        y: Math.round(press.y + ((release.y - press.y) * step) / 4),
        button: "left",
        buttons: 1,
      });
    }
    await client.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: release.x,
      y: release.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });

    let lastState = null;
    let state;
    try {
      state = await retry(async () => {
        const response = await fetch(new URL("api/state", viewerUrl), { cache: "no-store" });
        if (!response.ok) throw new Error(`state endpoint returned ${response.status}`);
        const value = await response.json();
        lastState = value;
        return (value.state?.markIds?.length ?? 0) > 1 ? value : null;
      }, { label: "the area drag to attach more than one Atlas mark" });
    } catch (error) {
      const after = await evaluate(client, `(() => ({
        stillArmed: document.getElementById("workspace")?.dataset.areaSelect ?? "absent",
        status: document.getElementById("status")?.textContent ?? "",
      }))()`).catch(() => null);
      return [{
        kind: "area-select",
        text: `${errorMessage(error)} from press ${press.x},${press.y} to ${release.x},${release.y}; markIds ${lastState?.state?.markIds?.length ?? 0}; area-select mode after the drag ${after?.stillArmed ?? "unknown"}; status ${bounded(after?.status ?? "", 160)}`,
      }];
    }
    if (state.selection?.predicate?.operator !== "in") {
      issues.push({
        kind: "area-select",
        text: `predicate ${bounded(JSON.stringify(state.selection?.predicate ?? null), 200)} over ${state.state?.markIds?.length ?? 0} markIds is not an "in" set`,
      });
    }

    let lastPhrase = null;
    try {
      await retry(async () => {
        const observed = await evaluate(client, `(() => {
          const panel = document.getElementById("selection-panel");
          if (!panel || panel.hidden) return null;
          const phrase = panel.querySelector(".attachment-phrase");
          return phrase ? { text: phrase.textContent ?? "" } : null;
        })()`);
        if (observed) lastPhrase = observed.text;
        return observed && /\d+ marks/u.test(observed.text) ? observed : null;
      }, { label: "the selection chip to summarize the area-selected marks" });
    } catch (error) {
      issues.push({
        kind: "area-select",
        text: `${errorMessage(error)}; chip ${bounded(lastPhrase ?? "(never rendered)", 200)}`,
      });
    }
  } catch (error) {
    issues.push({ kind: "area-select", text: errorMessage(error) });
  }
  return issues;
}

async function verifyCase({ chrome, viewerUrl, viewport, dataPackage }) {
  const startedAt = Date.now();
  const target = await createPage(chrome);
  let client;
  try {
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    const viewerOrigin = new URL(viewerUrl).origin;
    const contactFixture = dataPackage.catalog?.family === "collection-atlas"
      && dataPackage.catalog?.member === "contact-atlas";
    const recorder = browserIssueRecorder(client, viewerOrigin, {
      allowUnavailableContactAssets: contactFixture,
    });
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
    const loaded = waitForLoad(
      client,
      STRESS_SAMPLE_RASTER_SIDE !== null ? 60_000 : DEFAULT_TIMEOUT_MS,
    );
    const navigation = await client.command("Page.navigate", { url: viewerUrl });
    if (navigation.errorText) throw new Error(`Page navigation failed: ${navigation.errorText}`);
    await loaded;

    let selected;
    try {
      selected = await selectableReady(client);
    } catch (error) {
      const diagnostic = await evaluate(client, `(() => ({
        question: document.getElementById("question-heading")?.textContent ?? "",
        status: document.getElementById("status")?.textContent ?? "",
        atlasHidden: document.getElementById("atlas-view")?.hidden,
        phraseCount: document.querySelectorAll("[data-row-id]").length,
      }))()`);
      const issues = recorder.issues.map((issue) => `${issue.kind}: ${issue.text}`).join("; ");
      throw new Error(`${errorMessage(error)}; viewer diagnostic: ${bounded(JSON.stringify(diagnostic), 800)}${issues ? `; ${issues}` : ""}`);
    }
    if (contactFixture) await contactUnavailableReady(client);
    if (
      STRESS_SAMPLE_RASTER_SIDE !== null
      && dataPackage.catalog?.family === "field"
      && dataPackage.catalog?.member === "sample-raster"
    ) {
      await maximumRasterReady(client, STRESS_SAMPLE_RASTER_SIDE);
    }
    const geometry = await labelGeometry(client);
    if (geometry) {
      recorder.issues.push(...labelIssues(geometry));
      if (
        STRESS_MATRIX
        && dataPackage.catalog?.family === "matrix"
        && dataPackage.catalog?.member === "heatmap"
      ) {
        const rendered = geometry.texts
          .filter((entry) => !entry.class && entry.anchor === "end")
          .sort((first, second) => first.bbox.y - second.bbox.y)
          .map((entry) => entry.text);
        if (JSON.stringify(rendered) !== JSON.stringify(CALENDAR_ROWS)) {
          recorder.issues.push({ kind: "matrix-row-order", text: `rendered ${rendered.join(", ")}` });
        }
      }
    }
    const canonical = selected.kind === "mark"
      ? dataPackage.marks.find((candidate) => candidate.id === selected.id)
      : (dataPackage.visualTargets ?? dataPackage.payload?.visualTargets ?? [])
        .find((candidate) => candidate.id === selected.id);
    if (!canonical) throw new Error(`Rendered ${selected.kind} ${selected.id} is not in the canonical package`);
    if (selected.kind === "mark" && !canonical.evidenceRefs?.length) {
      throw new Error(`Canonical mark ${selected.id} has no evidence linkage`);
    }
    if (selected.kind === "mark" && !canonical.evidenceRefs.every((id) => OPAQUE_EVIDENCE_ID.test(id))) {
      throw new Error(`Canonical mark ${selected.id} carries a non-opaque evidence reference`);
    }

    await focusSelectable(client, selected);
    await pressEnter(client);
    const state = await selectedState(viewerUrl, selected, canonical);
    if (selected.kind === "target") await targetMembershipPage(viewerUrl, canonical);
    await chatPaneOpen(client);
    await attachmentReady(client, selected, canonical.label, canonical.count);
    if (
      viewport.id === "desktop"
      && `${dataPackage.catalog?.family}/${dataPackage.catalog?.member}` === AREA_SELECT_FORM_KEY
    ) {
      const markCount = await evaluate(client, `document.querySelectorAll("#atlas-visual svg [data-mark-id]").length`);
      if (markCount >= AREA_SELECT_MIN_MARKS) {
        recorder.issues.push(...await areaSelectScenario(client, viewerUrl));
      }
    }
    await sleep(100);
    assertPageResources(recorder, viewerUrl);
    if (client.handlerErrors.length) throw new Error(client.handlerErrors.join("; "));
    if (recorder.issues.length) {
      throw new Error(recorder.issues.map((issue) => `${issue.kind}: ${issue.text}`).join("; "));
    }
    return {
      status: "pass",
      selectionKind: selected.kind,
      selectionId: selected.id,
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
    const response = await fetch(new URL("form-runtime-generated.js", viewerUrl), { cache: "no-store" });
    if (!response.ok) throw new Error(`form-runtime-generated.js returned ${response.status}`);
    const source = await response.text();
    const snapshot = /"catalogVersion":\s*"([a-f0-9]+)"/u.exec(source)?.[1];
    if (!snapshot) throw new Error("form-runtime-generated.js does not declare catalogVersion");
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
  const requestedFormKeys = (process.env.ATTEND_BROWSER_FORMS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const unknownIds = requestedIds.filter((id) => !catalogFamilies.some((family) => family.id === id));
  if (unknownIds.length) throw new Error(`Unknown ATTEND_BROWSER_FAMILIES: ${unknownIds.join(", ")}`);
  const knownFormKeys = new Set(GENERATED_FORM_RUNTIME.forms.map((form) => form.key));
  const unknownFormKeys = requestedFormKeys.filter((key) => !knownFormKeys.has(key));
  if (unknownFormKeys.length) throw new Error(`Unknown ATTEND_BROWSER_FORMS: ${unknownFormKeys.join(", ")}`);
  let included = requestedIds.length
    ? catalogFamilies.filter((family) => requestedIds.includes(family.id))
    : catalogFamilies;
  if (requestedFormKeys.length) {
    const requestedFamilyIds = new Set(requestedFormKeys.map((key) => key.split("/", 1)[0]));
    included = included.filter((family) => requestedFamilyIds.has(family.id));
  }
  for (const family of included) {
    const forms = GENERATED_FORM_RUNTIME.forms.filter((form) => (
      form.familyId === family.id
      && (!requestedFormKeys.length || requestedFormKeys.includes(form.key))
    ));
    if (!forms.length) {
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
    for (const form of forms) {
      const member = family.members.find((candidate) => candidate.id === form.memberId && candidate.status === "executable");
      if (!member) throw new Error(`${form.key} is missing its exact executable catalog member`);
      const familySample = SAMPLE_SOURCES[family.id];
      if (!familySample) throw new Error(`${family.id} has no synthetic family context`);
      const dataset = formFixtureDataset(family.id, form.memberId, familySample);
      if (STRESS_SAMPLE_RASTER_SIDE !== null && form.key === "field/sample-raster") {
        dataset.records = Array.from({ length: STRESS_SAMPLE_RASTER_SIDE ** 2 }, (_, index) => ({
          x: index % STRESS_SAMPLE_RASTER_SIDE,
          y: Math.floor(index / STRESS_SAMPLE_RASTER_SIDE),
          value: (index % STRESS_SAMPLE_RASTER_SIDE) + Math.floor(index / STRESS_SAMPLE_RASTER_SIDE),
        }));
      }
      if (STRESS_TREND && form.key === "trend/line") {
        dataset.records = ["Series A", "Series B"].flatMap((series, seriesIndex) => (
          Array.from({ length: 31 }, (_, dayIndex) => ({
            time: `2026-03-${String(dayIndex + 1).padStart(2, "0")}T12:00:00`,
            value: seriesIndex * 5 + ((dayIndex * 7) % 19),
            series,
          }))
        ));
      }
      if (STRESS_MATRIX && form.key === "matrix/heatmap") {
        const columns = Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`);
        dataset.records = STRESS_MATRIX_ROWS.flatMap((row, rowIndex) => (
          columns.map((column, columnIndex) => ({
            row,
            column,
            value: (rowIndex + 1) * (columnIndex + 1),
          }))
        ));
      }
      const manifest = requireMapFamily(family.id);
      const request = await toCompilerRequest(dataset, manifest, {
        availableWidth: 1_200,
        memberId: form.memberId,
      });
      const { dataPackage } = await compileMapWithEvidence(request);
      const sessions = {};
      for (const viewport of VIEWPORTS) {
        const sessionId = `browser_${family.id}_${form.memberId}_${viewport.id}`;
        await createSession({ root, id: sessionId, dataPackage });
        const attachment = await registerHostAttachment({ root, sessionId });
        sessions[viewport.id] = {
          id: sessionId,
          route: attachment.route,
        };
      }
      available.push({ family, member, dataPackage, sessions });
    }
  }
  return { available, skipped };
}

async function main() {
  await pruneStaleProfiles();
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
    summary.counts.families = new Set([
      ...available.map((entry) => entry.family.id),
      ...skipped.map((entry) => entry.family),
    ]).size;
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
