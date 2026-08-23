# Attend Local

Attend Local is the first working slice of an agent-native visualization
harness. It turns an explicitly named local corpus into a fixed, locally hosted
visual instrument whose interaction state is readable by both a browser sidebar
and a local, authenticated Codex response worker.

This alpha answers one question well: **which multi-word phrases recur across
these notes?** Extraction, normalization, counting, ranking, hashing, and source
references are deterministic. By default, a phrase must appear in at least two
distinct notes, and source breadth ranks before raw repetition. Use
`--min-sources 1` only when repetition within a single note is intentional. The
analyzer itself makes no model or network call.

## Try it from this repository

Requires Node.js 22 or later.

```sh
npm install --global ./attend-cli

attend setup
attend phrases path/to/notes \
  --question "Which phrases recur across my notes about Apple?" \
  --target "Apple notes"
attend view --open
```

`attend view` starts or reuses this project's detached, loopback-only service,
waits for it to become healthy, prints both the project library URL and the
current visualization URL, and exits. `--open` opens the current visualization.
The same unguessable `127.0.0.1` library URL remains stable across new analyses
and stop/restart cycles because its port and capability token are stored in the
project's local Attend state. Every visualization saved in this project appears
in that library and has a stable session URL beneath it.

The library is project-scoped: a different project gets its own URL and local
service. Attend does not yet provide a global registry spanning projects.
`attend setup` only writes project configuration, local-state exclusions, and
the managed agent skill; it never starts background work.

The library also links to an experimental **Map-family lab**. It presents
nineteen executable family contracts and fixture-backed renderer specimens,
with evidence-linked dummy data for comparison, time,
relationship, geography, specimen, and collection views. Its Media policy mode
shows why small multiples are a cross-family system rather than one chart:
numeric series, passages, images, video, audio, documents, maps, and mixed
collections keep different minimum readable units and may aggregate or abstain
at different quantities. Its Pipeline mode compiles every fixture through the
same canonical `compileMap()` path used by the executable registry, then exposes
the validated `attend-data-package` receipt, evidence coverage, and content hash.

Open a visualization to get a viewport-sized workspace: the phrase list scrolls
inside its own frame, while the Ask button opens an independently scrolling chat
drawer. Selecting a phrase attaches its exact count and source breadth to the
composer. A contextual question suggestion can be accepted with Tab, then sent
with Enter. Sending atomically saves the question with that exact selection id
and view revision, then consumes the staged phrase from the composer. The sent
message keeps its immutable visual-context attachment while query, source scope,
threshold, and sort controls remain unchanged. The sidebar does not pretend that
a model answered synchronously: it commits the question immediately, shows a
normal `Thinking…` response, and fills in the linked answer when the background
worker finishes. The composer attachment is one-shot, like an image attached to
a message, but the conversation is not: a later message with no new attachment
inherits the latest relevant visual context. Attaching another phrase changes
the active visual topic for subsequent turns.

The analyzer accepts `.md`, `.mdx`, and `.txt` files, directories containing
them, and normalized `.jsonl` notes with `text` plus optional `title`, `id`,
`date`, `sourcePath`, and `sourceSha256` fields.

Recursive scans skip hidden and dependency directories. A hidden source remains
available when the user names that directory or file explicitly.
Unsupported or oversized inputs are listed by relative path and reason. Attend
fails clearly when every requested input is skipped instead of opening an empty,
misleading view. JSONL containers and the aggregate source corpus each have a
32 MiB hard read ceiling in this alpha.

## Local Codex chat

The local service exposes a provider-neutral response interface internally:

```text
respond({ question, conversation, selection, contextBinding, evidence }) -> { answer }
```

The default adapter implements that interface by starting a separate,
ephemeral `codex exec` worker. It uses the user's existing Codex/ChatGPT sign-in,
so no `OPENAI_API_KEY` is required. User and project Codex configuration are
deliberately ignored: this adapter uses the default OpenAI Codex route associated
with that sign-in, not a custom provider, model, hook, plugin, or MCP route from
the user's ordinary coding-agent configuration. The browser request is not held
open while Codex works: the exact question and visual attachment are persisted
first, a background scheduler claims the job, and the sidebar polls the local
state until the linked answer arrives. A failed or timed-out answer can be
retried without resending the user message or changing its historical
attachment. A service restart never silently repeats an in-flight provider
call: interrupted work becomes an explicit Retry instead.

This is equivalent to calling an answer service from the viewer, but it is not
an RPC into the currently open Conductor conversation. Each answer is a fresh,
read-only Codex run with bounded conversation history and the exact active
selection, whether newly attached or inherited from an earlier turn. The runner
uses low reasoning by default, never hardcodes a model,
has a two-minute timeout, and permits only one active answer per visualization.
Up to two different visualizations can answer concurrently, so one slow Codex
process does not block the entire project library.
That isolation keeps answers reproducible and prevents a slow coding harness
from blocking the chat request, but a cold Codex process will still usually be
slower than a direct model API. The adapter boundary leaves room for a warm
Codex service or direct API adapter later without changing viewer or session
contracts.

The runner is launched without a shell, with fixed arguments, an ephemeral
session, a read-only sandbox, a strict non-secret environment allowlist, and no
filesystem, search, app, plugin, hook, or MCP tools. It runs from a fresh private
directory outside the project, so repository `AGENTS.md`, `.codex` configuration,
skills, and rules cannot join the response. Attend validates the local analysis
and a private, hash-linked evidence snapshot, then supplies only the question,
bounded recent conversation, immutable selection, and the implicated source
contents over stdin. Full selected source bodies are used when the bounded packet
fits; otherwise every selected source receives deterministic head, middle, and
tail segments with explicit coverage metadata. The worker receives no project
root or data-package path and cannot browse the corpus.

Questions and the contents of selected sources needed to answer them are sent to
the OpenAI Codex service using the user's existing Codex sign-in. They are not
uploaded to an Attend service, and
Attend has no account or telemetry, but “locally hosted” does not mean the model
inference is on-device.

## Manual agent bridge

Setup also installs the bundled `attend-visualize` skill. The following commands
remain available for diagnostics, manual recovery, or mirroring an answer from
the current host-agent conversation. They are not required for ordinary sidebar
chat. `attend context` returns the oldest unanswered question across the
project's saved sessions together with its exact historical selection:

```sh
attend context --json
attend reply \
  --question-id turn_01234567-89ab-cdef-0123-456789abcdef \
  --expected-revision 3 \
  --selection-id selection_0123456789abcdef \
  --message "The selected phrase is concentrated in two notes…"
```

For a pending sidebar question, use `pendingQuestion.id` as `--question-id`,
`pendingQuestion.viewState.revision` as `--expected-revision`, and
`pendingQuestion.selection.id` as `--selection-id`. The pending object also
identifies its owning `sessionId` and `dataPackagePath`. The owning session's
revision guards against concurrent writes; the historical selection id prevents
an answer to phrase A from being attached to phrase B. The saved assistant turn
records `replyToTurnId` and reuses the question's authoritative stored
selection.

When `pendingQuestion` is `null`, an agent answering in its host chat can still
mirror that answer into the sidebar by omitting `--question-id` and using the
current `selection.id`.

The click is not silently injected into the currently open Codex or Claude
conversation. Ordinary sidebar chat is answered by the separate local Codex
worker described above; a host agent uses `attend context` and `attend reply`
only when the user explicitly wants that conversation involved.

`attend context` omits note excerpts by default while preserving the exact
selection id and revision. `--include-excerpts` adds them when they are needed.
The viewer and its stored state stay on the local machine, but selected phrase
metadata, paths, and the implicated source contents sent to the automatic Codex
worker follow the OpenAI Codex sign-in route. Source text opened by a host agent
follows that agent's configured provider route.

## Commands

- `attend setup [--dry-run] [--json]` — preview or create project configuration,
  local state exclusions, and the managed agent skill.
- `attend phrases <paths...>` — produce a provenance-bearing phrase-list data
  package and make it current.
- `attend view [--port 0] [--open] [--json]` — start or reuse the detached,
  loopback-only project library, print its stable URL and the current session's
  visualization URL, then exit.
- `attend status [--json]` — report whether this project's verified local
  library service is running and show its stable URL.
- `attend stop [--json]` — stop this project's verified service without
  deleting its analyses, conversations, capability token, or preferred port.
- `attend context [--include-excerpts] [--json]` — return the exact current
  selection and view state plus the oldest unanswered sidebar question across
  saved project sessions, omitting note excerpts by default.
- `attend reply --message <text> --expected-revision <n> --selection-id <id>
  [--question-id <turn-id>]` — link an answer to a pending sidebar question, or
  mirror a host-chat answer, only if the context is still current.
- `attend doctor [--json]` — check runtime, setup, state, skill, and viewer assets.

Run `attend <command> --help` for options.

## Local state and ownership

Shared project configuration lives in `.attend/project.json`. Derived data and
conversation state live under `.attend/local/` and are ignored by the nested
`.attend/.gitignore`. The installed skill is a managed file at
`.agents/skills/attend-visualize/SKILL.md`.

The source files are read-only. The Attend CLI and viewer do not scan outside
the paths supplied to `attend phrases`, upload the corpus, collect telemetry, or
silently fall back to a different paid API. `attend view` is the explicit action that starts the
detached local service; `attend setup` and `attend phrases` do not. Data packages
contain source-relative paths, hashes, line references, and short excerpts so
every visible phrase remains one move from its evidence. A separate gitignored
evidence store preserves the analyzer's verified source snapshot for synthesis;
it is never served by the viewer. The automatic Codex runner hydrates only the
sources implicated by the active selection through the user's Codex sign-in as
described above.

The visible selection includes at most 50 inline match references plus the exact
total. That display limit does not limit synthesis coverage: the worker resolves
all distinct source ids behind the selected marks and builds a packet of at most
1 MiB. The local data-package and evidence-store paths are not exposed to that
worker. Manual `attend context` can still return the data-package path to an
explicitly invoked host agent.

## What this proves—and what it does not

This is a narrow vertical slice of the `QuestionSpec → DataPackage → MapSpec →
Selection` contract. It proves an installable CLI, a deterministic transform, a
fixed local renderer, server-owned versioned selection, and a view/context
handoff seam. It also proves a durable asynchronous response job and a
provider-neutral agent-runner seam.
The map-family lab adds an executable registry, a versioned compiler seam,
media-aware repetition policy, and a first renderer specimen for every family.
Every fixture compiles through the canonical package, but the visual specimens
still consume a fixture view model; package-native renderer ingestion remains a
deliberate next seam rather than a compatibility shim that would silently drop
family semantics. Those views are a design and contract test surface, not yet
CLI commands over arbitrary real corpora. Attend is still not a general chart generator, MCP
server, source connector system, automatic corpus watcher/updater, cross-project
visualization registry, or visualization SDK.

## Verify

```sh
npm run verify
```

The verification suite covers deterministic extraction, exact provenance,
idempotent setup, optimistic state revisions, tokenized HTTP routes, saved-note
context snapshots, detached-service lifecycle and identity checks, stable
project URLs, persistent follow-up context, bounded source-content hydration,
the nineteen-family registry and compiler, gallery fixture/evidence integrity,
strict family-lab asset routes, and the npm package contents.
