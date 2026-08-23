import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { evidencePacketForSelection } from "./evidence.js";
import {
  completeQuestionResponse,
  loadQuestionResponseContext,
  markQuestionResponseFailed,
  markQuestionResponseRunning,
  pendingQuestionResponseJobs,
} from "./session-store.js";

const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_CONTENT_CHARS = 4_000;
const MAX_HISTORY_BYTES = 48 * 1024;
const MAX_ANSWER_BYTES = 64 * 1024;
const MAX_CONCURRENT_RESPONSES = 2;
const FAILURE_PERSIST_ATTEMPTS = 3;
const FAILURE_PERSIST_RETRY_MS = 40;
const TERMINAL_JOB_ERRORS = new Set([
  "QUESTION_ALREADY_ANSWERED",
  "QUESTION_NOT_FOUND",
]);

function jobKey({ sessionId, questionId }) {
  return JSON.stringify([sessionId, questionId]);
}

function validateIdentifier(name, value) {
  if (typeof value !== "string" || !SESSION_ID.test(value)) {
    throw new TypeError(`${name} must be a safe non-empty identifier`);
  }
  return value;
}

function normalizeJob(workerRoot, job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw new TypeError("question job must be an object");
  }
  if (job.root !== undefined && resolve(job.root) !== workerRoot) {
    throw new TypeError("question job root does not match this worker");
  }
  return Object.freeze({
    sessionId: validateIdentifier("sessionId", job.sessionId),
    questionId: validateIdentifier("questionId", job.questionId),
  });
}

function truncateContent(content) {
  if (typeof content !== "string") return "";
  if (content.length <= MAX_HISTORY_CONTENT_CHARS) return content;
  return `${content.slice(0, MAX_HISTORY_CONTENT_CHARS)}\n[Earlier message truncated by Attend]`;
}

function historyTurn(turn) {
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return null;
  if (turn.role !== "user" && turn.role !== "assistant") return null;
  const value = {
    role: turn.role,
    content: truncateContent(turn.content),
  };
  for (const field of ["id", "createdAt", "replyToTurnId"]) {
    if (typeof turn[field] === "string" && turn[field].length <= 512) {
      value[field] = turn[field];
    }
  }
  if (typeof turn.selection?.id === "string" && turn.selection.id.length <= 512) {
    value.selection = { id: turn.selection.id };
  }
  if (
    typeof turn.context?.selectionTurnId === "string" &&
    turn.context.selectionTurnId.length <= 512
  ) {
    value.context = { selectionTurnId: turn.context.selectionTurnId };
  }
  return value;
}

/**
 * Keep only prior turns. The current question, resolved immutable visual
 * context, and verified evidence packet are supplied separately, so
 * duplicating their bodies in history would spend model context needlessly.
 */
export function boundedConversation(conversation, questionId) {
  if (!Array.isArray(conversation)) return [];
  const questionIndex = conversation.findIndex((turn) => turn?.id === questionId);
  const candidates = conversation.slice(0, questionIndex < 0 ? conversation.length : questionIndex);
  const selected = [];
  let bytes = 2;
  for (
    let index = candidates.length - 1;
    index >= 0 && selected.length < MAX_HISTORY_TURNS;
    index -= 1
  ) {
    const turn = historyTurn(candidates[index]);
    if (!turn) continue;
    const turnBytes = Buffer.byteLength(JSON.stringify(turn), "utf8") + 1;
    if (bytes + turnBytes > MAX_HISTORY_BYTES) break;
    selected.unshift(turn);
    bytes += turnBytes;
  }
  return selected;
}

function dataPackagePath(root, session) {
  const dataPackageId = validateIdentifier(
    "dataPackageId",
    session?.dataPackageId ?? session?.dataPackage?.id,
  );
  return join(root, ".attend", "local", "analyses", `${dataPackageId}.json`);
}

function validatedAnswer(result) {
  const answer = result?.answer;
  if (
    typeof answer !== "string" ||
    answer.trim().length === 0 ||
    answer.includes("\0") ||
    Buffer.byteLength(answer, "utf8") > MAX_ANSWER_BYTES
  ) {
    const error = new Error("Agent returned an invalid answer");
    error.code = "AGENT_RUN_INVALID_OUTPUT";
    throw error;
  }
  return answer.trim();
}

/** Map every provider/child-process failure to the fixed public vocabulary. */
export function questionResponseErrorCode(error) {
  switch (error?.code) {
    case "AGENT_RUN_UNAVAILABLE":
      return "runner_unavailable";
    case "AGENT_RUN_TIMEOUT":
      return "timeout";
    case "AGENT_RUN_INVALID_OUTPUT":
    case "AGENT_RUN_OUTPUT_LIMIT":
      return "invalid_output";
    default:
      return "runner_failed";
  }
}

function capabilityUnavailable(capability) {
  return capability?.available === false || capability?.authenticated === false;
}

function unavailableError() {
  const error = new Error("The configured local agent is unavailable");
  error.code = "AGENT_RUN_UNAVAILABLE";
  return error;
}

function isShutdownCancellation(error, closing) {
  return closing && (
    error?.name === "AbortError" ||
    error?.code === "AGENT_RUN_CANCELLED"
  );
}

/**
 * Run durable response jobs with a small global concurrency bound and never
 * overlap jobs from the same visualization. The queue itself lives in session
 * files; this object is only the in-process scheduler.
 */
export function createQuestionWorker({
  root,
  runner,
  capability,
  evidenceForSelection = evidencePacketForSelection,
} = {}) {
  const workerRoot = resolve(root);
  if (!runner || typeof runner.respond !== "function") {
    throw new TypeError("runner must provide respond(request)");
  }
  if (typeof evidenceForSelection !== "function") {
    throw new TypeError("evidenceForSelection must be a function");
  }

  const queue = [];
  const known = new Set();
  const activeRuns = new Map();
  const activeSessions = new Set();
  let currentCapability = capability;
  let capabilityProbePromise = null;
  let closing = false;
  let idleWaiters = [];

  const resolveIdle = () => {
    if (activeRuns.size || queue.length) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolveWaiter of waiters) resolveWaiter();
  };

  const persistFailure = async (job, errorCode) => {
    for (let attempt = 1; attempt <= FAILURE_PERSIST_ATTEMPTS; attempt += 1) {
      try {
        await markQuestionResponseFailed({
          root: workerRoot,
          sessionId: job.sessionId,
          questionId: job.questionId,
          errorCode,
        });
        return true;
      } catch (failure) {
        if (TERMINAL_JOB_ERRORS.has(failure?.code)) return true;
        if (failure?.code !== "CONFLICT" || attempt === FAILURE_PERSIST_ATTEMPTS) {
          return false;
        }
        await delay(FAILURE_PERSIST_RETRY_MS * attempt);
      }
    }
    return false;
  };

  const failJob = async (job, error) => {
    if (TERMINAL_JOB_ERRORS.has(error?.code)) return;
    // Never persist raw provider/process details. A few bounded retries cover
    // a transient session lock without ever invoking the provider again.
    await persistFailure(job, questionResponseErrorCode(error));
  };

  const ensureAvailable = async (signal) => {
    if (!capabilityUnavailable(currentCapability)) return;
    if (typeof runner.capability !== "function") throw unavailableError();
    if (!capabilityProbePromise) {
      capabilityProbePromise = runner.capability({ signal })
        .then((next) => {
          currentCapability = next;
          return next;
        })
        .finally(() => {
          capabilityProbePromise = null;
        });
    }
    const next = await capabilityProbePromise;
    if (capabilityUnavailable(next)) throw unavailableError();
  };

  const runJob = async (job, controller) => {
    try {
      await markQuestionResponseRunning({
        root: workerRoot,
        sessionId: job.sessionId,
        questionId: job.questionId,
      });
      if (closing) return;

      const context = await loadQuestionResponseContext({
        root: workerRoot,
        sessionId: job.sessionId,
        questionId: job.questionId,
      });
      if (closing) return;
      await ensureAvailable(controller.signal);
      if (closing) return;

      const evidence = await evidenceForSelection({
        root: workerRoot,
        dataPackage: context.session.dataPackage,
        selection: context.visualContext,
      });
      if (closing) return;

      const result = await runner.respond({
        root: workerRoot,
        question: context.question,
        selection: context.visualContext,
        contextBinding: context.visualContextBinding,
        evidence,
        conversation: boundedConversation(context.conversation, job.questionId),
        dataPackagePath: dataPackagePath(workerRoot, context.session),
        signal: controller.signal,
      });
      if (closing) return;

      await completeQuestionResponse({
        root: workerRoot,
        sessionId: job.sessionId,
        questionId: job.questionId,
        content: validatedAnswer(result),
      });
    } catch (error) {
      if (!isShutdownCancellation(error, closing) && !closing) {
        await failJob(job, error);
      }
    }
  };

  const dispatch = () => {
    if (closing) return;
    while (activeRuns.size < MAX_CONCURRENT_RESPONSES) {
      const queueIndex = queue.findIndex(
        (candidate) => !activeSessions.has(candidate.sessionId),
      );
      if (queueIndex < 0) break;
      const [job] = queue.splice(queueIndex, 1);
      const key = jobKey(job);
      const controller = new AbortController();
      const record = { job, controller, promise: null };
      activeRuns.set(key, record);
      activeSessions.add(job.sessionId);
      record.promise = runJob(job, controller).finally(() => {
        known.delete(key);
        activeRuns.delete(key);
        activeSessions.delete(job.sessionId);
        dispatch();
        resolveIdle();
      });
    }
  };

  const enqueueQuestion = async (suppliedJob) => {
    if (closing) return { accepted: false, reason: "closing" };
    const job = normalizeJob(workerRoot, suppliedJob);
    const key = jobKey(job);
    if (known.has(key)) return { accepted: false, reason: "duplicate" };
    known.add(key);
    queue.push(job);
    dispatch();
    return { accepted: true };
  };

  const recover = async () => {
    if (closing) return { recovered: 0, interrupted: 0 };
    let recovered = 0;
    let interrupted = 0;
    for (const job of await pendingQuestionResponseJobs({ root: workerRoot })) {
      if (job.status === "running") {
        // The previous process may have received an answer that it never
        // committed. Do not silently spend another provider call; expose Retry.
        if (await persistFailure(job, "interrupted")) interrupted += 1;
        continue;
      }
      const result = await enqueueQuestion(job);
      if (result.accepted) recovered += 1;
    }
    return { recovered, interrupted };
  };

  const whenIdle = () => {
    if (activeRuns.size === 0 && queue.length === 0) return Promise.resolve();
    return new Promise((resolveWaiter) => idleWaiters.push(resolveWaiter));
  };

  const close = async () => {
    if (!closing) {
      closing = true;
      queue.length = 0;
      known.clear();
      for (const { controller } of activeRuns.values()) {
        controller.abort(new Error("Attend service is shutting down"));
      }
    }
    await Promise.allSettled(
      [...activeRuns.values()].map(({ promise }) => promise).filter(Boolean),
    );
    resolveIdle();
  };

  const status = () => {
    const active = [...activeRuns.values()].map(({ job }) => ({ ...job }));
    return Object.freeze({
      state: closing ? "closed" : active.length ? "running" : queue.length ? "queued" : "idle",
      queued: queue.length,
      active: active[0] ?? null,
      activeCount: active.length,
      activeJobs: active,
      capability: currentCapability,
    });
  };

  return Object.freeze({
    enqueueQuestion,
    recover,
    whenIdle,
    close,
    status,
  });
}

export const QUESTION_WORKER_LIMITS = Object.freeze({
  concurrency: MAX_CONCURRENT_RESPONSES,
  historyTurns: MAX_HISTORY_TURNS,
  historyBytes: MAX_HISTORY_BYTES,
  answerBytes: MAX_ANSWER_BYTES,
});
