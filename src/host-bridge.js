import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  beginHostAnswerLease,
  beginHostListener,
  endHostAnswerLease,
  endHostListener,
  hostAttachmentCoversSession,
  hostListenerStatus,
  refreshHostListener,
  safeChatCapability,
  sameChatRoute,
  verifyHostTicket,
} from "./chat-route.js";
import { buildHostQuestionPacket } from "./question-context.js";
import {
  completeHostQuestionResponse,
  pendingQuestionResponseJobs,
  rebindQueuedHostQuestionResponse,
} from "./session-store.js";

const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const MAX_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const LISTENER_REFRESH_INTERVAL_MS = 2_000;
const INSTANT_WAIT_BUILD_LEASE_MS = 30_000;
const RETRYABLE_READ_ERRORS = new Set([
  "QUESTION_ALREADY_ANSWERED",
  "QUESTION_NOT_FOUND",
  "HOST_QUESTION_NOT_QUEUED",
]);

function validateRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("root must be a non-empty path");
  }
  return resolve(root);
}

function validateTimeout(timeoutMs) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > MAX_WAIT_TIMEOUT_MS
  ) {
    throw new TypeError(
      `timeoutMs must be an integer between 0 and ${MAX_WAIT_TIMEOUT_MS}`,
    );
  }
  return timeoutMs;
}

function validatePollInterval(pollIntervalMs) {
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 5_000) {
    throw new TypeError("pollIntervalMs must be an integer between 1 and 5000");
  }
  return pollIntervalMs;
}

function validateListenerRefreshInterval(intervalMs) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1 || intervalMs > 5_000) {
    throw new TypeError("listenerRefreshIntervalMs must be an integer between 1 and 5000");
  }
  return intervalMs;
}

function matchingHostJob(job, attachment, route) {
  return Boolean(
    job &&
    job.status === "queued" &&
    hostAttachmentCoversSession(attachment, job.sessionId) &&
    sameChatRoute(job.route, route),
  );
}

/**
 * Wait for the oldest queued question owned by one host attachment. Delivery
 * leaves the durable response job queued while a bounded local lease protects
 * packet construction and the delivery-to-reply window. Returns null on timeout.
 */
export async function waitForHostQuestion({
  root,
  ticket,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  signal,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  listenerRefreshIntervalMs = LISTENER_REFRESH_INTERVAL_MS,
  listJobs = pendingQuestionResponseJobs,
  packetBuilder = buildHostQuestionPacket,
  beginAnswerLease = beginHostAnswerLease,
  answerLeaseTtlMs,
  refreshListener = refreshHostListener,
  loadContext,
  evidenceForSelection,
} = {}) {
  const boundary = validateRoot(root);
  const timeout = validateTimeout(timeoutMs);
  const pollInterval = validatePollInterval(pollIntervalMs);
  const refreshInterval = validateListenerRefreshInterval(listenerRefreshIntervalMs);
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("signal must be an AbortSignal");
  }
  if (typeof listJobs !== "function") throw new TypeError("listJobs must be a function");
  if (typeof packetBuilder !== "function") {
    throw new TypeError("packetBuilder must be a function");
  }
  if (typeof beginAnswerLease !== "function") {
    throw new TypeError("beginAnswerLease must be a function");
  }
  if (typeof refreshListener !== "function") {
    throw new TypeError("refreshListener must be a function");
  }
  signal?.throwIfAborted();

  const verified = await verifyHostTicket({ root: boundary, ticket });
  const startedAt = Date.now();
  const deadline = Math.min(
    startedAt + timeout,
    Date.parse(verified.attachment.expiresAt),
  );
  const listenerDeadline = timeout > 0
    ? deadline
    : Math.min(
        startedAt + INSTANT_WAIT_BUILD_LEASE_MS,
        Date.parse(verified.attachment.expiresAt),
      );
  let listener = await beginHostListener({
    root: boundary,
    ticket,
    waitExpiresAt: new Date(listenerDeadline),
  });
  const heartbeatController = new AbortController();
  let heartbeatError = null;
  const heartbeat = listener
    ? (async () => {
        while (!heartbeatController.signal.aborted) {
          const remaining = listenerDeadline - Date.now();
          if (remaining <= refreshInterval) return;
          try {
            await delay(refreshInterval, undefined, {
              signal: heartbeatController.signal,
            });
          } catch (error) {
            if (heartbeatController.signal.aborted) return;
            heartbeatError = error;
            return;
          }
          try {
            await refreshListener({ root: boundary, ticket, listener });
          } catch (error) {
            heartbeatError = error;
            return;
          }
        }
      })()
    : null;
  let heartbeatStopped = false;
  let delivered = false;
  const stopHeartbeat = async () => {
    if (heartbeatStopped) return;
    heartbeatStopped = true;
    heartbeatController.abort();
    await heartbeat;
  };

  try {
    while (true) {
      signal?.throwIfAborted();
      if (heartbeatError) throw heartbeatError;
      const jobs = await listJobs({ root: boundary });
      if (!Array.isArray(jobs)) {
        throw new TypeError("listJobs must return an array");
      }
      for (const job of jobs) {
        if (!matchingHostJob(job, verified.attachment, verified.route)) continue;
        try {
          const packet = await packetBuilder({
            root: boundary,
            sessionId: job.sessionId,
            questionId: job.questionId,
            route: verified.route,
            signal,
            deadline: new Date(timeout > 0 ? deadline : listenerDeadline),
            ...(loadContext === undefined ? {} : { loadContext }),
            ...(evidenceForSelection === undefined
              ? {}
              : { evidenceForSelection }),
          });
          signal?.throwIfAborted();
          if (timeout > 0 && Date.now() >= deadline) return null;
          if (heartbeatError) throw heartbeatError;
          await verifyHostTicket({
            root: boundary,
            ticket,
            expectedRoute: packet.route,
          });
          if (!hostAttachmentCoversSession(
            verified.attachment,
            packet.replyGuard?.sessionId,
          )) {
            const error = new Error(
              "The host question packet does not belong to this attachment session",
            );
            error.code = "HOST_ATTACHMENT_MISMATCH";
            throw error;
          }
          await stopHeartbeat();
          listener = await beginAnswerLease({
            root: boundary,
            ticket,
            listener,
            sessionId: job.sessionId,
            questionId: job.questionId,
            ...(answerLeaseTtlMs === undefined ? {} : { ttlMs: answerLeaseTtlMs }),
          });
          signal?.throwIfAborted();
          delivered = true;
          return packet;
        } catch (error) {
          if (!RETRYABLE_READ_ERRORS.has(error?.code)) throw error;
        }
      }

      const now = Date.now();
      if (now >= deadline) return null;
      await delay(Math.min(pollInterval, deadline - now), undefined, {
        ...(signal === undefined ? {} : { signal }),
      });
    }
  } finally {
    await stopHeartbeat();
    if (listener && !delivered) {
      await endHostListener({ root: boundary, listener });
    }
  }
}

/** Release a delivered question lease after an aborted host handoff. */
export async function releaseHostQuestion({ root, ticket, questionId } = {}) {
  const boundary = validateRoot(root);
  await endHostAnswerLease({ root: boundary, ticket, questionId });
}

function completionFields(options) {
  const guard = options.replyGuard;
  if (guard !== undefined && (!guard || typeof guard !== "object" || Array.isArray(guard))) {
    throw new TypeError("replyGuard must be an object");
  }
  return {
    sessionId: options.sessionId ?? guard?.sessionId,
    questionId: options.questionId ?? guard?.questionId,
    expectedRevision: options.expectedRevision ?? guard?.expectedRevision,
    selectionId: options.selectionId ?? guard?.selectionId,
    content: options.content ?? options.message,
  };
}

/** Verify host ownership, then enter the session store's atomic reply guard. */
export async function completeHostQuestion(options = {}) {
  const {
    root,
    ticket,
    completeResponse = completeHostQuestionResponse,
    endAnswerLease = endHostAnswerLease,
  } = options;
  const boundary = validateRoot(root);
  if (typeof completeResponse !== "function") {
    throw new TypeError("completeResponse must be a function");
  }
  if (typeof endAnswerLease !== "function") {
    throw new TypeError("endAnswerLease must be a function");
  }
  const fields = completionFields(options);
  const verified = await verifyHostTicket({ root: boundary, ticket });
  const sessionId = fields.sessionId ?? verified.attachment.sessionId;
  if (!hostAttachmentCoversSession(verified.attachment, sessionId)) {
    const error = new Error("The host ticket does not own this visualization session");
    error.code = "HOST_ATTACHMENT_MISMATCH";
    throw error;
  }
  const completed = await completeResponse({
    root: boundary,
    sessionId,
    questionId: fields.questionId,
    expectedRevision: fields.expectedRevision,
    expectedSelectionId: fields.selectionId,
    route: verified.route,
    content: fields.content,
  });
  await endAnswerLease({
    root: boundary,
    ticket,
    questionId: fields.questionId,
  }).catch(() => {});
  return completed;
}

/**
 * Explicitly move one queued host question to a newly verified attachment in
 * the same visualization session. The session id and target route come only
 * from the replacement ticket, never from caller input.
 */
export async function rebindHostQuestion({
  root,
  ticket,
  questionId,
  expectedRevision,
  confirmTakeover = false,
  listenerStatus = hostListenerStatus,
  rebindResponse = rebindQueuedHostQuestionResponse,
} = {}) {
  const boundary = validateRoot(root);
  if (confirmTakeover !== true) {
    const error = new Error(
      "Rebinding requires explicit confirmation because it revokes the question's earlier host attachment",
    );
    error.code = "HOST_REBIND_CONFIRMATION_REQUIRED";
    throw error;
  }
  if (typeof rebindResponse !== "function") {
    throw new TypeError("rebindResponse must be a function");
  }
  if (typeof listenerStatus !== "function") {
    throw new TypeError("listenerStatus must be a function");
  }
  const verified = await verifyHostTicket({ root: boundary, ticket });
  return rebindResponse({
    root: boundary,
    sessionId: verified.attachment.sessionId,
    questionId,
    expectedRevision,
    route: verified.route,
    async beforeRebind({ currentRoute, targetRoute }) {
      if (
        currentRoute.kind === "host" &&
        !sameChatRoute(currentRoute, targetRoute) &&
        (await listenerStatus({
          root: boundary,
          route: currentRoute,
          questionId,
        })).phase === "waiting"
      ) {
        const error = new Error(
          "The question's current coding agent is actively listening; takeover is unavailable",
        );
        error.code = "HOST_OWNER_LISTENING";
        throw error;
      }
    },
  });
}

/** Doctor-facing capability. Listener absence is informative, not a failure. */
export async function hostBridgeCapability({ root, route, now = new Date() } = {}) {
  const chat = await safeChatCapability({ root, route, now });
  return Object.freeze({
    supported: true,
    transport: "cli",
    protocol: "attend-host-question/1",
    listening: chat.kind === "host" && chat.listenerPresent,
    chat,
  });
}

export const HOST_BRIDGE_LIMITS = Object.freeze({
  defaultWaitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
  maxWaitTimeoutMs: MAX_WAIT_TIMEOUT_MS,
  defaultPollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
});
