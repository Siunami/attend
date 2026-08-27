# Attend system atlas

This is a bespoke, evidence-backed architecture view of the `attend-cli` library.
It deliberately uses the repository's earlier isometric renderer in `../../atlas/`
instead of routing the request through Attend's generic mechanism family.

The default plate compresses 21 conceptual components into 13 current modules and
shows four route families: invocation, map construction, sidebar questions, and
host-attached questions. Exact files, implementation notes, limits, and relation
verbs live in the inspector. The Observer and Impact views add three proposed
modules without presenting them as current behavior.

## Open it

Serve the repository root and open:

```text
http://127.0.0.1:9000/attend-cli/system-atlas/
```

For example:

```sh
python3 -m http.server 9000 --bind 127.0.0.1
```

The page has no network requests and contains no private corpus text, prompts,
credentials, or Attend tickets.

## Interaction contract

- Drag to pan and scroll to zoom. Camera state survives inspector and view changes.
- Hover or focus a module to isolate only its immediate relationships.
- Select a module for its plain-language role, implementation paths, and limits.
- Trace one request a step at a time rather than animating every relation at once.
- The inspector is a transform-only overlay. Opening or closing it never changes
  the SVG's width, viewBox, camera, or scroll position.
- Current and proposed modules are visually distinct. No proposed observer behavior
  is counted as shipped.

## Evidence and maintenance

The current-runtime claims were checked against the linked source files on
2026-08-27. `data.js` is the small curated architecture model. Update it when a
boundary changes, then run:

```sh
node --test system-atlas/app.test.js
```

The important test is conceptual, not just syntactic: a reader should be able to
trace a direct map request or sidebar question and identify the first boundary
that would have to change. If the page turns every import into a visible peer or
labels every edge at once, it has regressed into an inventory.
