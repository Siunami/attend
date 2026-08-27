# Proposed Attend observer and impact protocol

This document describes a target architecture, not current Attend behavior. It
incorporates the failure modes found during the architecture review.

## The process model

Use one project-local daemon with isolated `ObserverSession` contexts keyed to an
authenticated host-session identity. Do not launch one operating-system process
per coding session. Each logical observer owns a bounded inbox, cursor, task shape,
authorized source scope, prior proposals, interruption budget, and retention clock.

The observer receives typed lifecycle events through a versioned host adapter. An
event must carry a producer identity, `sourceEventId`, producer epoch, monotonic
sequence, host-session join key, and schema version. Delivery is at-least-once.
The observer derives a stable operation ID from the source event, records an inbox
intent, applies a replay-safe reducer, and advances its cursor idempotently. It
must detect duplicate, conflicting, missing, and out-of-order events; it must not
claim exactly-once delivery across independent stores.

Ingress must be authenticated local IPC or a signed outbox. Self-asserted actor,
exposure, use, or outcome events are rejected unless the producer has the matching
capability. Per-project, domain-separated HMACs provide join keys. Raw prompts,
transcripts, source bodies, quotes, credentials, and stable cross-project hashes do
not enter the observer or impact stores.

## Authority

The observer's proactive remit is exploratory data analysis at eligible natural
task boundaries when the user has not requested a visualization. If the user names
a visual form, dimensionality, motion, projection, or interaction, the observer may
use Attend only when one executable catalog member is an exact and natural match.
Otherwise it records an abstention and yields to the host's ordinary just-in-time
workflow, which may search the repository and build a bespoke visualization.

The first deployment mode is `shadow`: evaluate and record both abstentions and
proposals, but do not interrupt, compile, or mutate current state. `suggest` may
surface a bounded proposal under an interruption budget. A future `stage` mode
requires a separately authorized source-transform worker; until that exists, the
observer cannot turn a proposal into an artifact on its own.

No observer mode may broaden a source scope, edit project files, use provider
credentials implicitly, or write Attend's project-global `current.json`. Every
observer/view operation names an explicit Attend session. Global inference capacity
uses bounded per-host queues, coalescing, fair scheduling, quotas, and deadlines.

## Impact ledger

Keep canonical Attend records as their own sources of truth. Add one append-only
ledger only for cross-boundary joins. Multi-store actions use a write-ahead intent,
one stable operation ID passed into the canonical mutation, and a terminal receipt;
a reconciler repairs intents without terminal records.

Every event kind has a strict payload schema and retention rule. The minimum useful
chain is:

1. `host-boundary-observed` — authenticated input activity.
2. `intervention-proposed` — pre-result hypothesis and authority mode.
3. `intervention-decision-recorded` — accept, reject, defer, or narrow.
4. `intervention-delivered` — explicit host delivery or browser render acknowledgement.
5. `intervention-use-recorded` — an authorized actor explicitly used, contradicted,
   rejected, or reversed the result.
6. `eligibility-recorded` and `arm-assigned` — immutable pre-result experiment
   assignment, metric schema, baseline, and observation window.
7. `outcome-recorded` — the measured result tied to that assignment.
8. `effect-reversed` — withdrawal without deleting history.

A view command, browser open, selection, dwell time, promotion, or bare
`acted-upon` label is not causal impact. Reporting must keep four states separate:

| State | Claim allowed |
| --- | --- |
| Activity | Attend did something. |
| Exposure | An authorized receiver actually got it. |
| Influence | A downstream actor explicitly used or rejected it. |
| Impact | A declared outcome differed against a defensible counterfactual. |

## Delivery order

1. Define privacy, retention, purge, key rotation, authenticated ingress, and strict
   schemas before collecting events.
2. Add the append-only ledger and explicit delivery/use receipts without changing
   agent behavior.
3. Establish and exercise the host lifecycle adapter under replay, crash, duplicate,
   gap, and out-of-order tests.
4. Run the observer in shadow mode and measure its abstention and proposal quality.
5. Add suggestion mode only after interruption budgets and global fairness work.
6. Consider staging only after a scoped transform worker exists.
7. Run opt-in holdouts only after eligibility, assignment, exposure, use, and outcome
   can all be joined without post-result reconstruction.
