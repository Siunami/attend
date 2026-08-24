# Attend Local

Attend Local turns evidence from explicitly authorized files into a designed visualization in a private local artifact view with selection-aware chat.

## Install in this project

From the project root, paste this one command into a terminal or compatible coding agent:

```sh
curl -fsSL https://attend-cli.matthewwilsonsiu.workers.dev/releases/0.2.2/install.sh | sh
```

It installs the pinned `0.2.2` release, configures the current project for both `.agents` and `.claude`, and verifies the CLI, catalog, local viewer, and Codex chat capability. Node.js 22 or newer and npm are required.

The host agent does not write chart code. It asks Attend for the installed Family Atlas catalog, selects an executable member for the analytic job, transforms source-backed facts into that member's declared roles, and submits a data-only request. Attend reopens the sources, verifies exact quotes, compiles a canonical package, resolves a fixed bundled renderer, and serves the result on loopback.

This release includes all 19 visualization families. The catalog records every authored form and rejection from the [Family Atlas](https://storytelling-family-atlas.matthewwilsonsiu.workers.dev/), but it is intentionally honest about runtime coverage: 18 families have one tested executable member. Annotated specimen is marked `unavailable` because the text-only request contract cannot bind its required visible specimen yet. Other approved designs remain `documented`; rejected designs remain `rejected`. Attend never falls back to an unimplemented member or generates a substitute chart.

## Install with one prompt

Open [the Attend Local release page](https://attend-cli.matthewwilsonsiu.workers.dev/) and paste its installation prompt into a coding agent from the project where Attend should run. The prompt pins the release tarball by SHA-256, installs it globally, configures the project, installs the managed agent skill for both `.agents` and `.claude`, and verifies the local Codex chat dependency.

Requirements:

- macOS or Linux
- Node.js 22 or newer and npm
- Codex CLI signed in for automatic artifact-sidebar answers

The visualization, library, and manual host-agent bridge work without automatic chat. The installer does not call chat ready unless `attend doctor --json` reports the `codex-chat` check passing.

For development from a checkout, run these commands in the directory containing this README:

```sh
npm install --global .
attend setup --json
attend doctor --json
```

## Agent workflow

The installed `attend-visualize` skill directs a compatible host agent through this sequence:

```text
user question
  -> attend families --json
  -> exact executable family/member
  -> evidence-backed map request
  -> attend map request.json --json
  -> attend view --json
  -> local artifact + selected-mark chat
```

The family is chosen by the question, not by visual taste:

- Compare: rank, distribution, composition, profile, passage comparison
- Time: trend, timeline, sequence
- Relate: relationship, matrix, hierarchy, network, flow, mechanism
- Space and inspect: region map, point map, field, annotated specimen, collection atlas

Run `attend families --json` for each governed member, required roles, field types, structured requirements, availability, abstention guidance, and the documented and rejected alternatives.

## Map request contract

`attend map` accepts one declarative JSON request. For example:

```json
{
  "version": 1,
  "question": "How do results differ by region?",
  "family": "rank",
  "member": "bar-list",
  "sources": [
    { "path": "notes/results.md", "textProjection": "utf8" }
  ],
  "records": [
    { "key": "north", "label": "North", "value": 42 },
    { "key": "south", "label": "South", "value": 31 },
    { "key": "east", "label": "East", "value": 27 }
  ],
  "evidence": [
    {
      "source": { "path": "notes/results.md", "textProjection": "utf8" },
      "quote": "North: 42",
      "recordKey": "north",
      "field": "label"
    },
    {
      "source": { "path": "notes/results.md", "textProjection": "utf8" },
      "quote": "North: 42",
      "recordKey": "north",
      "field": "value"
    },
    {
      "source": { "path": "notes/results.md", "textProjection": "utf8" },
      "quote": "South: 31",
      "recordKey": "south",
      "field": "label"
    },
    {
      "source": { "path": "notes/results.md", "textProjection": "utf8" },
      "quote": "South: 31",
      "recordKey": "south",
      "field": "value"
    },
    {
      "source": { "path": "notes/results.md", "textProjection": "utf8" },
      "quote": "East: 27",
      "recordKey": "east",
      "field": "label"
    },
    {
      "source": { "path": "notes/results.md", "textProjection": "utf8" },
      "quote": "East: 27",
      "recordKey": "east",
      "field": "value"
    }
  ],
  "options": { "title": "Results by region" }
}
```

Then compile and open it:

```sh
attend map request.json --json
attend view --open --json
```

`question` is required and carries the user's literal question into the compiled artifact. `options.title` is an optional display label; it does not replace or rewrite the question.

The invocation determines the project root. A request cannot supply or enlarge it. Source paths must resolve inside that root. Attend supports explicit UTF-8 text and normalized-text projections in this release; it abstains from raw binary or remote URL input.

Every required field in every record needs at least one exact source quote. If a quote occurs more than once, the claim must include its one-based `occurrence`. Attend derives file hashes, stable source and record identifiers, text locators, mark IDs, package hashes, and the catalog renderer receipt. Requests cannot provide renderer modules, asset URLs, hashes, locators, source bodies, or executable code.

The compiler rejects unknown families, unavailable or non-executable members, missing roles, invalid types, unsupported media, ambiguous or absent quotes, geographic values outside valid bounds, malformed graph shapes, incomplete grids, hierarchy errors, and family-specific size violations. It validates and stages the public package and private evidence store before updating `current.json`, so a failed request leaves the prior current artifact intact.

The canonical package stored on the local machine includes source-integrity receipts such as stable IDs, display paths, and hashes, but no source bodies or private evidence claims. The package projection sent to the browser contains only the fields needed to draw the view, the visible role values, and opaque evidence IDs; it omits source metadata, provenance, locators, record IDs, source bodies, and private quote claims. A visible role such as a passage may intentionally contain source-derived text when that text is the designed mark. Private source snapshots and evidence linkage are hash-bound, gitignored, and available only through the local evidence boundary.

## Artifact view and chat

`attend view` starts or reuses a detached loopback-only service, waits for it to become healthy, prints the project `libraryUrl` and current `viewerUrl`, then exits. The capability-bearing library URL remains stable across new artifacts and stop/start cycles. Each saved artifact has its own session URL.

The production viewer consumes a closed projection of the canonical package emitted by `attend map`. It resolves that package through the installed catalog and the fixed renderer assigned to its executable member. The package and browser cannot choose a module or remote asset. Every interactive visual mark uses the canonical package mark ID.

Selecting a mark updates server-owned, revisioned state. The server re-derives the selection and implicated evidence rather than accepting evidence from the browser. A selected mark can be attached to the next sidebar question; later messages inherit the latest relevant attachment until the user selects a new visual topic.

Automatic sidebar responses use a separate ephemeral `codex exec` worker and the user's existing Codex sign-in. No `OPENAI_API_KEY` is required. Attend deliberately ignores project and user Codex instructions, hooks, plugins, MCP servers, and custom provider configuration for this worker. It launches without a shell, uses a read-only sandbox and a fixed environment allowlist, and receives no project path or package path.

Attend sends the worker only the question, bounded recent conversation, immutable selection, and implicated private evidence. Full source bodies are included when the 1 MiB packet fits; otherwise each selected source receives deterministic head, middle, and tail segments with explicit coverage metadata. The viewer and state are local, but the selected evidence used for an answer follows the user's OpenAI Codex sign-in route. Attend has no hosted account or telemetry.

The browser persists the question before the worker starts, displays a real pending state, and polls for the linked answer. Failed and timed-out calls can be retried without resending the question or changing its historical attachment. A service restart marks interrupted work for an explicit retry instead of silently repeating an external call.

## Phrase recurrence shortcut

The original deterministic phrase analysis remains as a specialized shortcut:

```sh
attend phrases notes/ \
  --question "Which phrases recur across these notes?" \
  --target "Project notes" \
  --json
attend view --open --json
```

It accepts `.md`, `.mdx`, `.txt`, and normalized `.jsonl` sources. By default, a phrase must occur at least twice across at least two distinct sources, and distinct-source breadth ranks before raw repetition. Use `--min-sources 1` only when repetition inside one source is intentional. Do not use this shortcut for a different analytic job.

## Manual host-agent bridge

The sidebar works without the current coding-agent conversation. Use the bridge only when the user explicitly asks that conversation to inspect a click, troubleshoot, or recover an answer:

```sh
attend context --json
attend context --include-excerpts --json
```

`attend context` returns the exact current or oldest unanswered historical selection with its package ID, view revision, mark IDs, and evidence links. It omits excerpts by default because command output consumed by a host agent follows that agent's configured provider route.

To save a manual response to a pending question:

```sh
attend reply \
  --question-id <pendingQuestion.id> \
  --expected-revision <pendingQuestion.viewState.revision> \
  --selection-id <pendingQuestion.selection.id> \
  --message "<answer>"
```

The revision prevents concurrent overwrites. The immutable selection ID prevents an answer to one mark from being attached to another.

## Commands

- `attend setup [--agent <agents|claude>]... [--dry-run] [--json]` configures the project and managed skill. Without `--agent`, it installs both targets.
- `attend families [--json]` returns the governed Atlas catalog.
- `attend map <request.json> [--json]` verifies sources and compiles a canonical Atlas artifact.
- `attend phrases <paths...> --question <text> [options]` runs the specialized recurrence analyzer.
- `attend view [--port 0] [--open] [--json]` starts or reuses the local artifact library.
- `attend status [--json]` reports the service and stable URLs.
- `attend stop [--json]` stops the service without deleting artifacts or configuration.
- `attend context [--include-excerpts] [--json]` reads exact visual and pending-question state.
- `attend reply ...` commits a guarded manual answer.
- `attend doctor [--json]` checks runtime, setup, catalog, current artifact, viewer assets, and automatic chat readiness.

Run `attend <command> --help` for all options.

## Local state

Shared configuration lives at `.attend/project.json`. Derived packages, private evidence, sessions, conversations, service identity, and the current pointer live below gitignored `.attend/local/`. The managed skill is installed at `.agents/skills/attend-visualize/SKILL.md` and `.claude/skills/attend-visualize/SKILL.md` unless setup is restricted with `--agent`.

Attend reads source files but does not edit them. It does not scan paths that were not supplied, upload a corpus to an Attend service, watch files, or silently choose another visualization implementation. Regenerate an artifact from its explicit request when sources change; do not hand-edit packages or evidence stores.

## Verify

```sh
npm run verify
```

The verification suite covers the 19-family catalog, all 18 available mappings, the explicit specimen abstention, exact evidence and hash checks, fixed package-native renderer contracts, browser selection and revision behavior, phrase compatibility, private evidence hydration, asynchronous chat jobs, idempotent cross-agent setup, loopback service lifecycle, release tarball allowlisting, SHA-pinned staging, and package contents.
