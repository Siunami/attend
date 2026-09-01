# Changelog

This file records user-visible changes to Attend.

## [0.6.0] - 2026-09-01

- Stream private local chat: answers arrive token by token, your message echoes immediately, and the drawer updates over a push channel instead of polling. Questions on the local route start answering in under a tenth of a second.
- Add area select: a tool in the chat composer arms a drag mode, and a rectangle over a visualization attaches every mark inside it, up to fifty, as one selection to ask about.
- Let a selection carry many marks. The selection endpoint accepts a mark-id array, and a multi-mark attachment summarizes as a count with the facet and time range its marks share.
- Keep labels legible at any density. Every form thins and truncates axis, category, and value labels by measured text width, and weekday, month, hour, and quarter categories order by calendar rather than alphabet. Map requests may declare an explicit category order.
- Fail the browser verification when any rendered label overlaps another or leaves the canvas, across every executable form at both viewports.
- Size evidence to the local model's context window, cache verified session and evidence loads, keep a transient model error from reloading the model, and reuse the prompt prefix across follow-up questions on one selection.

- Replace the context ledger with the data itself: every visualization carries a click-to-filter list of its underlying rows. Click a point, component, or aggregate to see exactly the records it stands for; click it again or choose Show all to widen back out. Nothing pops up on hover anymore, and selecting evidence no longer auto-opens the chat drawer.
- Give small marks invisible pointer halos so selecting a dot never requires pixel precision.
- Split the exploration workspace into a gallery view for people (finished visualizations only, shown as live previews with a one-line why and a compact relevance score) and a debug view that keeps every run, failure, and full assessment.
- Expand the governed runtime to 34 exact forms across all 19 visualization families, with exact form registrations for requirements, transformations, renderers, evidence behavior, and usage guidance.
- Add map-request version 3 with evidenced-record and verified local-JPEG adapters while retaining version 2 text compatibility.
- Add server-verified aggregate visual targets and hash-bound, session-private contact-atlas assets.
- Preserve historical Atlas v2 catalog receipts while rejecting cross-wired family, member, payload, renderer, or variant combinations.
- Add a Getting started guide written for the person installing Attend, covering what it is for, a first week of use, eight questions worth asking it, and an explicit account of what it will not do yet. The published package now ships the documentation folder.

## [0.5.5] - 2026-08-27

- Preserve verified Attend 0.5.3 Atlas sessions when upgrading across the 0.5.4 catalog metadata change.
- Continue rejecting unknown catalog receipts or any package whose family, member, renderer, variant, or hashes no longer match.

## [0.5.4] - 2026-08-27

- Add a complete Family Atlas browser and visualization inspector for exploring every governed family and executable member.
- Preserve explicit representation intent and reject visual forms, interactions, projections, motion, or dimensionality that the selected member cannot support exactly.
- Add durable project chat threads that retain their visual context while moving between saved visualization pages.
- Add a self-auditing system atlas for Attend's runtime, storage, routing, and evidence boundaries.

## [0.5.3] - 2026-08-27

- Make mechanism diagrams readable with dense or cyclic relationship data.
- Keep downstream dependency layers separate from feedback loops.
- Add component focus, complete typed-relationship lists, wrapped labels, and accessible selection states.

## [0.5.2] - 2026-08-27

- License Attend under the MIT License.
- Add continuous verification for Node.js 22 and 24.
- Publish releases through npm trusted publishing with provenance.
- Make release retries safe when npm already contains the version.
- Add a private security-reporting policy and complete npm package metadata.

## [0.5.1] - 2026-08-27

- Publish Attend as `@siunami/attend` with the `attend` command.
- Put coding-agent installation first in the README.
- Add six privacy-reviewed visual examples made from fabricated data.
- Deprecate the earlier `attend-local` package identity.
