const DELTA_BUFFER_BYTES = 64 * 1024;
const TERMINAL_RETENTION_MS = 60_000;
const TERMINAL_EVENT_TYPES = new Set(["answer", "failed"]);

function deltaBytesOf(event) {
  return Buffer.byteLength(typeof event.text === "string" ? event.text : "", "utf8");
}

/**
 * Relay one in-flight question's progress from the worker to whoever is
 * watching it. Events are a closed union tagged by `type`:
 *
 *   { type: "status", questionId, status }
 *   { type: "delta",  questionId, text }
 *   { type: "answer", questionId, answerTurnId }
 *   { type: "failed", questionId, errorCode }
 *
 * The worker never overlaps jobs from the same visualization, so one buffered
 * entry per session is the invariant and a publish for a different questionId
 * means the previous question is over. Nothing here is durable: the session
 * file remains the record, this only spares a late subscriber the wait.
 */
export function createQuestionStreamRelay() {
  const subscribers = new Map();
  const entries = new Map();

  // A subscriber is normally a live HTTP response that can die mid-write. One
  // dead stream must not cost the others their events, nor fail the publisher.
  const deliver = (handler, event) => {
    try {
      handler(event);
    } catch {}
  };

  const cancelEviction = (entry) => {
    if (!entry?.evictTimer) return;
    clearTimeout(entry.evictTimer);
    entry.evictTimer = null;
  };

  const trimDeltas = (entry, incomingBytes) => {
    while (entry.deltaBytes + incomingBytes > DELTA_BUFFER_BYTES) {
      const oldest = entry.events.findIndex((buffered) => buffered.type === "delta");
      if (oldest < 0) return;
      const [dropped] = entry.events.splice(oldest, 1);
      entry.deltaBytes -= deltaBytesOf(dropped);
    }
  };

  const publish = (sessionId, event) => {
    let entry = entries.get(sessionId);
    cancelEviction(entry);
    if (!entry || entry.questionId !== event.questionId) {
      entry = { questionId: event.questionId, events: [], deltaBytes: 0, evictTimer: null };
      entries.set(sessionId, entry);
    }

    if (event.type === "delta") {
      const bytes = deltaBytesOf(event);
      trimDeltas(entry, bytes);
      entry.deltaBytes += bytes;
    }
    entry.events.push(event);

    if (TERMINAL_EVENT_TYPES.has(event.type)) {
      entry.evictTimer = setTimeout(() => entries.delete(sessionId), TERMINAL_RETENTION_MS);
      entry.evictTimer.unref?.();
    }

    for (const handler of [...(subscribers.get(sessionId) ?? [])]) {
      deliver(handler, event);
    }
  };

  const subscribe = (sessionId, handler) => {
    for (const event of entries.get(sessionId)?.events ?? []) {
      deliver(handler, event);
    }
    let handlers = subscribers.get(sessionId);
    if (!handlers) {
      handlers = new Set();
      subscribers.set(sessionId, handlers);
    }
    handlers.add(handler);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      handlers.delete(handler);
      if (handlers.size === 0) subscribers.delete(sessionId);
    };
  };

  return Object.freeze({ publish, subscribe });
}
