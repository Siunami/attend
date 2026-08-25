# Host-attached chat routing

## Decision

Attend routes sidebar questions back to the coding agent that opened the artifact by default. The agent receives a bounded, verified question packet through `attend chat wait`, answers inside its existing conversation, and commits through Attend's guarded reply operation.

Detached Codex CLI and Claude CLI responders remain explicit machine-local routes. Attend never changes a question's route because a host or provider is unavailable.

## Caller workflow

```sh
attend view --open --json
attend chat wait --ticket <ticket-from-view> --timeout 300 --json
attend reply \
  --ticket <ticket-from-view> \
  --question-id <question-id> \
  --expected-revision <revision> \
  --selection-id <selection-id> \
  --message-stdin
```

The agent writes only the answer to the reply process's stdin and closes it. Evidence-derived answer text is never interpolated into a shell command.

`view` creates a machine-local host attachment and returns its raw ticket once. `chat wait` requires that ticket and returns only questions bound to that attachment. Attend keeps a live listener lease while polling and building the packet. Delivery replaces it with a bounded `delivered` reservation without changing the durable question's queued status. If the wait process disappears before delivery, the question remains queued for the same host ticket.

The packet contains the stored question, its immutable selection, the visual-context binding, bounded prior Attend turns, and the verified evidence packet. It does not contain ambient browser data or caller-supplied evidence.

The managed skill owns the loop while its agent turn is alive. Attend cannot wake a finished coding-agent conversation, so a timed-out wait is reported honestly and the question remains saved locally. A later host can take over only through the explicit, user-approved `chat rebind --take-over` transition. A currently listening owner is protected from takeover. A delivered reservation is not proof that the agent is still alive, so the browser labels it as delivered and an approved takeover may revoke its reply guard.

MCP cancellation applies to the read-only wait. Guarded reply and takeover calls are short, idempotent mutations; once dispatched, they finish and return their receipt even if the client sends a cancellation notification. Repeating the exact guard reconciles an uncertain client outcome without creating a second answer or takeover.

## Core data shape

```ts
type ChatRoute =
  | {
      kind: "host";
      attachmentId: string;
      generation: number;
    }
  | {
      kind: "detached";
      adapter: "codex-cli" | "claude-cli";
    };

type QuestionResponse = {
  status: "queued" | "running" | "failed" | "completed";
  route: ChatRoute;
  queuedAt: string;
  updatedAt: string;
  attempt: number;
  errorCode?: string;
  answerTurnId?: string;
  answerDigest?: string;
};

type HostQuestionPacket = {
  schema: "attend-host-question/1";
  route: { kind: "host"; attachmentId: string; generation: number };
  replyGuard: {
    sessionId: string;
    questionId: string;
    expectedRevision: number;
    selectionId: string;
  };
  question: object;
  selection: object | null;
  contextBinding: object;
  evidence: object;
  conversation: object[];
};
```

Host attachment files and the selected chat route live under gitignored `.attend/local/chat/`. Attachment files store only a ticket digest. The raw ticket is not written to the session, browser state, project configuration, or URL. Each queued question snapshots its route, so a later `view` or route change cannot silently redirect evidence.

## State and ownership

The session conversation remains the only durable queue.

```text
browser append -> queued(host attachment snapshot)
               -> queued(detached adapter snapshot), only by explicit route

host wait reads queued(host) without changing it
host reply -> completed, atomically and guard-checked

detached worker -> running -> completed | failed
```

Host delivery never creates a durable running job. A short machine-local reservation distinguishes a packet that was delivered from a live wait or an inactive host. Two waits using the same attachment ticket may receive the same immutable packet, but the session lock and reply guards allow only one committed answer. A waiter crash never creates a stranded running job. A different attachment cannot read or answer the question without an explicit takeover.

Reply validates the attachment proof, route generation, question ID, current session revision, frozen selection ID, and answer digest under the session lock. Repeating the exact completed reply is idempotent. A different replay or stale context fails.

## Modules

- `src/chat-route.js` owns machine-local route configuration, host attachments, listener presence, ticket verification, and safe browser capability projection.
- `src/question-context.js` builds the single bounded and evidence-verified packet used by host and detached routes.
- `src/host-bridge.js` implements bounded wait and guarded host completion over session-store APIs.
- `src/session-store.js` owns route snapshots and atomic response transitions.
- `src/question-worker.js` handles only questions for its explicit detached adapter.
- `src/agent-runner.js` contains isolated Codex and Claude subprocess adapters. Neither is constructed in host mode.
- `src/server.js` resolves the current route when persisting a question and exposes only safe route/listener status.
- `src/mcp-server.js` is an optional stdio facade over the same wait, takeover, and reply functions. It adds no second queue or trust path.

## Doctor and installation

Core visualization readiness does not depend on a model CLI.

Doctor reports separate checks:

- `core:*`: runtime, project, skills, catalog, artifacts, and viewer assets. These determine `ok`.
- `host-bridge`: bundled wait/reply bridge and current listener state. No active listener is informational.
- `chat-route`: the selected machine-local route.
- `adapter:codex-cli` and `adapter:claude-cli`: optional capability and authentication, probed only when explicitly requested with `doctor --adapter`.

The installer checks only core and host-bridge support. It does not install, require, or authenticate Codex or Claude.

## Browser language

The browser names the selected route:

- Host route, listener present: “Waiting for the coding agent that opened this view.”
- Host route, packet delivered: “Question delivered to the coding agent that opened this view; waiting for its guarded reply.”
- Host route, no listener: “Saved locally. Attend cannot wake an inactive agent.”
- Detached route: “Detached fallback: Codex CLI” or “Detached fallback: Claude CLI.”

It never calls a delivered reservation a live or thinking agent, and it never hides which provider receives selected evidence.

## Arena synthesis

Candidate A supplied the strongest attachment capability, per-question route binding, and disclosure model, but its claims, leases, heartbeats, reaper, and takeover state duplicated failure handling. Candidate B kept the session as the single queue and gave the CLI workflow a smaller surface, but its delivered claim could strand a question after a hard crash. A third candidate did not complete and was treated as a dropout.

The chosen design combines the attachment boundary from A with a durable queued read and a short local delivery reservation. An independent judge scored this constrained design highest for simplicity, crash recovery, truthfulness, security, and fit with Attend's existing invariants.

## Accepted tradeoffs

- Attend can reuse a live host conversation only while that host keeps issuing bounded waits. It does not promise background wake-up.
- Duplicate delivery to two waits sharing one ticket is possible. Duplicate committed answers are not.
- A question is never reassigned automatically. A replacement host needs a fresh same-session ticket, the exact question and revision, and explicit takeover confirmation. Rebind preserves the frozen evidence context and revokes the previous host route atomically.
- Detached adapters keep their current isolation: bounded evidence, clean working directory, restricted environment, no project tools, and no silent replay after uncertain provider work.

## Rejected alternatives

- Calling a new provider subprocess “the launching agent.” It shares authentication, not conversation context.
- A global oldest-question wait without an attachment ticket. It cannot guarantee delivery to the opening agent.
- A claim lease for host delivery. It adds a crash-created stranded state without strengthening reply integrity.
- A second host inbox. It can drift from the durable session conversation and duplicates ordering and recovery rules.
- Automatic provider fallback. It changes the evidence recipient without a deliberate user action.

## Verification requirements

1. A default view starts no Codex or Claude subprocess.
2. Only the matching attachment ticket receives a queued host packet.
3. A killed or timed-out wait leaves the question queued and readable again.
4. Guarded reply commits once, exact replay is idempotent, and stale revision or selection fails.
5. Detached adapters run only when explicitly selected and remain visibly labelled.
6. Installation and core doctor pass with neither provider CLI installed.
7. A packed, standalone CLI completes browser question, host wait, guarded reply, and viewer answer as one end-to-end path.
