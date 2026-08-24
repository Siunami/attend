function textEvidence(id, sourceId, path, startLine, endLine, excerpt) {
  return {
    id,
    sourceId,
    mediaType: "text",
    locator: { kind: "text-range", path, startLine, endLine },
    excerpt,
  };
}

function rowEvidence(id, sourceId, path, row, excerpt) {
  return {
    id,
    sourceId,
    mediaType: "structured",
    locator: { kind: "row", path, row },
    excerpt,
  };
}

function geoEvidence(id, sourceId, path, featureId, excerpt, coordinates) {
  return {
    id,
    sourceId,
    mediaType: "geography",
    locator: {
      kind: coordinates ? "coordinate-feature" : "feature",
      path,
      featureId,
      ...(coordinates ? { coordinates } : {}),
    },
    excerpt,
  };
}

function imageEvidence(id, sourceId, path, region, excerpt) {
  return {
    id,
    sourceId,
    mediaType: "image",
    locator: {
      kind: "normalized-region",
      path,
      coordinateSpace: "normalized",
      ...region,
    },
    excerpt,
  };
}

function timedEvidence(id, sourceId, mediaType, path, startSeconds, endSeconds, excerpt) {
  return {
    id,
    sourceId,
    mediaType,
    locator: { kind: "time-range", path, startSeconds, endSeconds },
    excerpt,
  };
}

function documentEvidence(id, sourceId, path, page, region, excerpt) {
  return {
    id,
    sourceId,
    mediaType: "document",
    locator: {
      kind: "page-region",
      path,
      page,
      coordinateSpace: "normalized",
      ...region,
    },
    excerpt,
  };
}

const source = (id, title, mediaType, kind, path, details = {}) => ({
  id,
  title,
  mediaType,
  kind,
  locator: { kind: "local-path", path },
  ...details,
});

/**
 * Self-contained fixtures for the map-family lab. Every mark resolves through
 * `evidenceRefs` to a medium-aware locator in the sample's `evidence` array.
 */
export const SAMPLE_SOURCES = Object.freeze({
  rank: {
    familyId: "rank",
    mediaType: "text",
    title: "The work asking for attention",
    question: "Which active projects deserve attention this week, and what is the next move?",
    sources: [
      source(
        "weekly-review",
        "Weekly review — August 17",
        "text",
        "markdown",
        "notes/weekly/2026-08-17.md",
        { date: "2026-08-17", recordUnit: "project assessment" },
      ),
    ],
    roles: {
      id: "id",
      label: "project",
      value: "attentionScore",
      group: "domain",
      detail: "nextMove",
      evidence: "evidenceRefs",
    },
    records: [
      { id: "rank-mapping-cli", project: "Mapping CLI", attentionScore: 92, domain: "Product", nextMove: "Lock the first family contracts", evidenceRefs: ["rank-e1"] },
      { id: "rank-field-synthesis", project: "Field-study synthesis", attentionScore: 84, domain: "Research", nextMove: "Cluster the remaining interviews", evidenceRefs: ["rank-e2"] },
      { id: "rank-meeting-lab", project: "Meeting Lab reliability", attentionScore: 77, domain: "Infrastructure", nextMove: "Close the recovery-path gaps", evidenceRefs: ["rank-e3"] },
      { id: "rank-notes-migration", project: "Notes migration", attentionScore: 63, domain: "Operations", nextMove: "Resolve duplicate attachments", evidenceRefs: ["rank-e4"] },
      { id: "rank-portfolio", project: "Portfolio refresh", attentionScore: 48, domain: "Communication", nextMove: "Choose three representative projects", evidenceRefs: ["rank-e5"] },
      { id: "rank-expenses", project: "Expense cleanup", attentionScore: 31, domain: "Admin", nextMove: "Reconcile July receipts", evidenceRefs: ["rank-e6"] },
    ],
    evidence: [
      textEvidence("rank-e1", "weekly-review", "notes/weekly/2026-08-17.md", 12, 14, "Mapping CLI — 92. Important and newly tractable. Next: lock the first family contracts."),
      textEvidence("rank-e2", "weekly-review", "notes/weekly/2026-08-17.md", 16, 18, "Field-study synthesis — 84. The interviews are complete; the remaining leverage is synthesis."),
      textEvidence("rank-e3", "weekly-review", "notes/weekly/2026-08-17.md", 20, 22, "Meeting Lab reliability — 77. Recovery paths still need focused attention."),
      textEvidence("rank-e4", "weekly-review", "notes/weekly/2026-08-17.md", 24, 26, "Notes migration — 63. Mostly mechanical, except duplicate attachments."),
      textEvidence("rank-e5", "weekly-review", "notes/weekly/2026-08-17.md", 28, 30, "Portfolio refresh — 48. Select three projects before designing pages."),
      textEvidence("rank-e6", "weekly-review", "notes/weekly/2026-08-17.md", 32, 33, "Expense cleanup — 31. Reconcile the July receipts; no deeper work required."),
    ],
  },

  distribution: {
    familyId: "distribution",
    mediaType: "structured",
    title: "Shape of a focus session",
    question: "How long are uninterrupted focus sessions, and how does their shape differ by kind of work?",
    sources: [
      source("focus-log", "Focus session log", "structured", "csv", "exports/focus-sessions-2026-08.csv", {
        dateRange: { start: "2026-08-03", end: "2026-08-21" },
        recordUnit: "focus session",
      }),
    ],
    roles: {
      id: "id",
      value: "durationMinutes",
      group: "workType",
      facet: "dayPart",
      label: "date",
      evidence: "evidenceRefs",
    },
    records: [
      { id: "focus-01", date: "2026-08-03", durationMinutes: 34, workType: "Writing", dayPart: "Morning", evidenceRefs: ["focus-e1"] },
      { id: "focus-02", date: "2026-08-03", durationMinutes: 57, workType: "Coding", dayPart: "Afternoon", evidenceRefs: ["focus-e2"] },
      { id: "focus-03", date: "2026-08-04", durationMinutes: 48, workType: "Research", dayPart: "Morning", evidenceRefs: ["focus-e3"] },
      { id: "focus-04", date: "2026-08-05", durationMinutes: 81, workType: "Writing", dayPart: "Morning", evidenceRefs: ["focus-e4"] },
      { id: "focus-05", date: "2026-08-06", durationMinutes: 42, workType: "Coding", dayPart: "Evening", evidenceRefs: ["focus-e5"] },
      { id: "focus-06", date: "2026-08-07", durationMinutes: 66, workType: "Research", dayPart: "Afternoon", evidenceRefs: ["focus-e6"] },
      { id: "focus-07", date: "2026-08-10", durationMinutes: 73, workType: "Coding", dayPart: "Morning", evidenceRefs: ["focus-e7"] },
      { id: "focus-08", date: "2026-08-11", durationMinutes: 52, workType: "Writing", dayPart: "Afternoon", evidenceRefs: ["focus-e8"] },
      { id: "focus-09", date: "2026-08-12", durationMinutes: 91, workType: "Coding", dayPart: "Morning", evidenceRefs: ["focus-e9"] },
      { id: "focus-10", date: "2026-08-13", durationMinutes: 38, workType: "Research", dayPart: "Evening", evidenceRefs: ["focus-e10"] },
      { id: "focus-11", date: "2026-08-17", durationMinutes: 62, workType: "Writing", dayPart: "Morning", evidenceRefs: ["focus-e11"] },
      { id: "focus-12", date: "2026-08-18", durationMinutes: 109, workType: "Coding", dayPart: "Morning", evidenceRefs: ["focus-e12"] },
      { id: "focus-13", date: "2026-08-19", durationMinutes: 46, workType: "Research", dayPart: "Afternoon", evidenceRefs: ["focus-e13"] },
      { id: "focus-14", date: "2026-08-20", durationMinutes: 76, workType: "Writing", dayPart: "Morning", evidenceRefs: ["focus-e14"] },
      { id: "focus-15", date: "2026-08-21", durationMinutes: 29, workType: "Coding", dayPart: "Evening", evidenceRefs: ["focus-e15"] },
    ],
    evidence: [34, 57, 48, 81, 42, 66, 73, 52, 91, 38, 62, 109, 46, 76, 29].map((minutes, index) =>
      rowEvidence(
        `focus-e${index + 1}`,
        "focus-log",
        "exports/focus-sessions-2026-08.csv",
        index + 2,
        `Recorded uninterrupted session: ${minutes} minutes.`,
      ),
    ),
  },

  composition: {
    familyId: "composition",
    mediaType: "structured",
    title: "Where the week went",
    question: "How did the mix of work change between the last two full weeks?",
    sources: [
      source("time-ledger", "Personal time ledger", "structured", "csv", "exports/time-ledger-2026-08.csv", {
        dateRange: { start: "2026-08-03", end: "2026-08-16" },
        recordUnit: "weekly activity total",
      }),
    ],
    roles: {
      id: "id",
      part: "activity",
      value: "hours",
      series: "week",
      total: "weeklyTotal",
      evidence: "evidenceRefs",
    },
    records: [
      { id: "comp-w1-build", week: "Aug 3–9", activity: "Build", hours: 15, weeklyTotal: 40, evidenceRefs: ["comp-e1"] },
      { id: "comp-w1-research", week: "Aug 3–9", activity: "Research", hours: 9, weeklyTotal: 40, evidenceRefs: ["comp-e1"] },
      { id: "comp-w1-writing", week: "Aug 3–9", activity: "Writing", hours: 5, weeklyTotal: 40, evidenceRefs: ["comp-e1"] },
      { id: "comp-w1-coordination", week: "Aug 3–9", activity: "Coordination", hours: 7, weeklyTotal: 40, evidenceRefs: ["comp-e1"] },
      { id: "comp-w1-admin", week: "Aug 3–9", activity: "Admin", hours: 2, weeklyTotal: 40, evidenceRefs: ["comp-e1"] },
      { id: "comp-w1-renewal", week: "Aug 3–9", activity: "Renewal", hours: 2, weeklyTotal: 40, evidenceRefs: ["comp-e1"] },
      { id: "comp-w2-build", week: "Aug 10–16", activity: "Build", hours: 11, weeklyTotal: 40, evidenceRefs: ["comp-e2"] },
      { id: "comp-w2-research", week: "Aug 10–16", activity: "Research", hours: 13, weeklyTotal: 40, evidenceRefs: ["comp-e2"] },
      { id: "comp-w2-writing", week: "Aug 10–16", activity: "Writing", hours: 8, weeklyTotal: 40, evidenceRefs: ["comp-e2"] },
      { id: "comp-w2-coordination", week: "Aug 10–16", activity: "Coordination", hours: 4, weeklyTotal: 40, evidenceRefs: ["comp-e2"] },
      { id: "comp-w2-admin", week: "Aug 10–16", activity: "Admin", hours: 1, weeklyTotal: 40, evidenceRefs: ["comp-e2"] },
      { id: "comp-w2-renewal", week: "Aug 10–16", activity: "Renewal", hours: 3, weeklyTotal: 40, evidenceRefs: ["comp-e2"] },
    ],
    evidence: [
      rowEvidence("comp-e1", "time-ledger", "exports/time-ledger-2026-08.csv", 4, "Aug 3–9: Build 15, Research 9, Writing 5, Coordination 7, Admin 2, Renewal 2; total 40 hours."),
      rowEvidence("comp-e2", "time-ledger", "exports/time-ledger-2026-08.csv", 5, "Aug 10–16: Build 11, Research 13, Writing 8, Coordination 4, Admin 1, Renewal 3; total 40 hours."),
    ],
  },

  profile: {
    familyId: "profile",
    mediaType: "text",
    title: "Profiles of the active experiments",
    question: "How do the current experiments differ in clarity, evidence, momentum, reach, and effort?",
    sources: [
      source("experiment-review", "Experiment review", "text", "markdown", "notes/reviews/experiments-2026-08.md", {
        date: "2026-08-16",
        recordUnit: "scored experiment",
      }),
    ],
    roles: {
      id: "id",
      label: "experiment",
      group: "stage",
      measures: ["clarity", "evidence", "momentum", "reach", "effort"],
      evidence: "evidenceRefs",
    },
    records: [
      { id: "profile-map-cli", experiment: "Mapping CLI", stage: "Prototype", clarity: 9, evidence: 6, momentum: 9, reach: 8, effort: 7, evidenceRefs: ["profile-e1"] },
      { id: "profile-meeting-lab", experiment: "Meeting Lab", stage: "Pilot", clarity: 8, evidence: 8, momentum: 6, reach: 7, effort: 8, evidenceRefs: ["profile-e2"] },
      { id: "profile-atlas", experiment: "Collection Atlas", stage: "Prototype", clarity: 6, evidence: 5, momentum: 8, reach: 9, effort: 8, evidenceRefs: ["profile-e3"] },
      { id: "profile-marginalia", experiment: "Marginalia", stage: "Exploration", clarity: 7, evidence: 4, momentum: 5, reach: 6, effort: 4, evidenceRefs: ["profile-e4"] },
      { id: "profile-notes", experiment: "Notes pipeline", stage: "Operational", clarity: 9, evidence: 9, momentum: 7, reach: 5, effort: 3, evidenceRefs: ["profile-e5"] },
      { id: "profile-story", experiment: "Story fragments", stage: "Exploration", clarity: 5, evidence: 3, momentum: 6, reach: 7, effort: 5, evidenceRefs: ["profile-e6"] },
    ],
    evidence: [
      textEvidence("profile-e1", "experiment-review", "notes/reviews/experiments-2026-08.md", 14, 17, "Mapping CLI — clarity 9, evidence 6, momentum 9, reach 8, effort 7."),
      textEvidence("profile-e2", "experiment-review", "notes/reviews/experiments-2026-08.md", 20, 23, "Meeting Lab — clarity 8, evidence 8, momentum 6, reach 7, effort 8."),
      textEvidence("profile-e3", "experiment-review", "notes/reviews/experiments-2026-08.md", 26, 29, "Collection Atlas — clarity 6, evidence 5, momentum 8, reach 9, effort 8."),
      textEvidence("profile-e4", "experiment-review", "notes/reviews/experiments-2026-08.md", 32, 35, "Marginalia — clarity 7, evidence 4, momentum 5, reach 6, effort 4."),
      textEvidence("profile-e5", "experiment-review", "notes/reviews/experiments-2026-08.md", 38, 41, "Notes pipeline — clarity 9, evidence 9, momentum 7, reach 5, effort 3."),
      textEvidence("profile-e6", "experiment-review", "notes/reviews/experiments-2026-08.md", 44, 47, "Story fragments — clarity 5, evidence 3, momentum 6, reach 7, effort 5."),
    ],
  },

  trend: {
    familyId: "trend",
    mediaType: "structured",
    title: "A season of making",
    question: "How has weekly effort shifted among building, research, and writing?",
    sources: [
      source("weekly-hours", "Weekly mode totals", "structured", "csv", "exports/weekly-mode-hours.csv", {
        dateRange: { start: "2026-06-15", end: "2026-08-17" },
        recordUnit: "week by work mode",
      }),
    ],
    roles: {
      id: "id",
      x: "week",
      y: "hours",
      series: "mode",
      annotation: "milestone",
      evidence: "evidenceRefs",
    },
    records: [
      ...[
        ["2026-06-15", 8, 15, 4, "Interview cycle began"],
        ["2026-06-22", 10, 17, 5, null],
        ["2026-06-29", 13, 14, 6, null],
        ["2026-07-06", 16, 11, 7, "First prototype"],
        ["2026-07-13", 19, 9, 6, null],
        ["2026-07-20", 21, 8, 8, null],
        ["2026-07-27", 14, 12, 10, "Prototype review"],
        ["2026-08-03", 17, 10, 7, null],
        ["2026-08-10", 12, 14, 11, "Family model clarified"],
        ["2026-08-17", 15, 9, 13, "Direction memo"],
      ].flatMap(([week, build, research, writing, milestone], weekIndex) =>
        [
          { id: `trend-${weekIndex}-build`, week, mode: "Build", hours: build, milestone, evidenceRefs: [`trend-e${weekIndex + 1}`] },
          { id: `trend-${weekIndex}-research`, week, mode: "Research", hours: research, milestone, evidenceRefs: [`trend-e${weekIndex + 1}`] },
          { id: `trend-${weekIndex}-writing`, week, mode: "Writing", hours: writing, milestone, evidenceRefs: [`trend-e${weekIndex + 1}`] },
        ],
      ),
    ],
    evidence: [
      ["2026-06-15", 8, 15, 4], ["2026-06-22", 10, 17, 5], ["2026-06-29", 13, 14, 6],
      ["2026-07-06", 16, 11, 7], ["2026-07-13", 19, 9, 6], ["2026-07-20", 21, 8, 8],
      ["2026-07-27", 14, 12, 10], ["2026-08-03", 17, 10, 7], ["2026-08-10", 12, 14, 11],
      ["2026-08-17", 15, 9, 13],
    ].map(([week, build, research, writing], index) =>
      rowEvidence(`trend-e${index + 1}`, "weekly-hours", "exports/weekly-mode-hours.csv", index + 2, `${week}: build ${build}h, research ${research}h, writing ${writing}h.`),
    ),
  },

  timeline: {
    familyId: "timeline",
    mediaType: "mixed",
    title: "The road to a family lab",
    question: "Which workstreams overlap, and what must land before the family lab can be reviewed?",
    sources: [
      source("planning-note", "Family lab plan", "text", "markdown", "notes/plans/family-lab.md", { date: "2026-08-18" }),
      source("calendar-export", "Project calendar", "structured", "ical-export", "exports/project-calendar.ics", { dateRange: { start: "2026-08-18", end: "2026-09-11" } }),
    ],
    roles: {
      id: "id",
      label: "item",
      start: "start",
      end: "end",
      group: "track",
      status: "status",
      milestone: "milestone",
      evidence: "evidenceRefs",
    },
    records: [
      { id: "timeline-taxonomy", item: "Family taxonomy", start: "2026-08-18", end: "2026-08-21", track: "Definition", status: "Done", milestone: true, evidenceRefs: ["timeline-e1"] },
      { id: "timeline-schemas", item: "Data contracts", start: "2026-08-20", end: "2026-08-25", track: "Definition", status: "Active", milestone: false, evidenceRefs: ["timeline-e2"] },
      { id: "timeline-fixtures", item: "Sample datasets", start: "2026-08-21", end: "2026-08-26", track: "Build", status: "Active", milestone: false, evidenceRefs: ["timeline-e3"] },
      { id: "timeline-shell", item: "Viewer shell", start: "2026-08-22", end: "2026-08-28", track: "Build", status: "Planned", milestone: false, evidenceRefs: ["timeline-e4"] },
      { id: "timeline-renderers", item: "First renderers", start: "2026-08-25", end: "2026-09-02", track: "Build", status: "Planned", milestone: false, evidenceRefs: ["timeline-e5"] },
      { id: "timeline-evidence", item: "Evidence interaction", start: "2026-08-27", end: "2026-09-03", track: "Integration", status: "Planned", milestone: false, evidenceRefs: ["timeline-e6"] },
      { id: "timeline-accessibility", item: "Keyboard and contrast pass", start: "2026-09-01", end: "2026-09-04", track: "Quality", status: "Planned", milestone: false, evidenceRefs: ["timeline-e7"] },
      { id: "timeline-review", item: "Family review", start: "2026-09-08", end: "2026-09-08", track: "Review", status: "Scheduled", milestone: true, evidenceRefs: ["timeline-e8"] },
      { id: "timeline-decide", item: "Choose first release families", start: "2026-09-11", end: "2026-09-11", track: "Review", status: "Scheduled", milestone: true, evidenceRefs: ["timeline-e9"] },
    ],
    evidence: [
      textEvidence("timeline-e1", "planning-note", "notes/plans/family-lab.md", 8, 12, "Aug 18–21 — settle the family taxonomy before renderer work begins."),
      textEvidence("timeline-e2", "planning-note", "notes/plans/family-lab.md", 14, 17, "Aug 20–25 — turn each family into a narrow data contract."),
      textEvidence("timeline-e3", "planning-note", "notes/plans/family-lab.md", 19, 21, "Aug 21–26 — prepare credible fixtures for every family."),
      textEvidence("timeline-e4", "planning-note", "notes/plans/family-lab.md", 23, 25, "Aug 22–28 — build the common viewer shell."),
      textEvidence("timeline-e5", "planning-note", "notes/plans/family-lab.md", 27, 30, "Aug 25–Sep 2 — render the first full pass across families."),
      textEvidence("timeline-e6", "planning-note", "notes/plans/family-lab.md", 32, 34, "Aug 27–Sep 3 — make every selection resolve to exact evidence."),
      textEvidence("timeline-e7", "planning-note", "notes/plans/family-lab.md", 36, 38, "Sep 1–4 — keyboard navigation and contrast review."),
      rowEvidence("timeline-e8", "calendar-export", "exports/project-calendar.ics", 17, "Family review — 2026-09-08, 10:00–11:30."),
      rowEvidence("timeline-e9", "calendar-export", "exports/project-calendar.ics", 23, "Release-family decision — 2026-09-11, 14:00–15:00."),
    ],
  },

  relationship: {
    familyId: "relationship",
    mediaType: "structured",
    title: "Meetings and focus",
    question: "What relationship appears between meeting load and uninterrupted focus time?",
    sources: [
      source("weekly-balance", "Weekly work balance", "structured", "csv", "exports/weekly-work-balance.csv", {
        dateRange: { start: "2026-06-01", end: "2026-08-17" },
        recordUnit: "week",
      }),
    ],
    roles: {
      id: "id",
      x: "meetingHours",
      y: "focusHours",
      label: "week",
      group: "context",
      detail: "note",
      evidence: "evidenceRefs",
    },
    records: [
      { id: "rel-01", week: "Jun 1", meetingHours: 5, focusHours: 22, context: "Normal", note: "Protected mornings", evidenceRefs: ["rel-e1"] },
      { id: "rel-02", week: "Jun 8", meetingHours: 7, focusHours: 20, context: "Normal", note: "Two workshop days", evidenceRefs: ["rel-e2"] },
      { id: "rel-03", week: "Jun 15", meetingHours: 10, focusHours: 17, context: "Normal", note: "Interview cycle", evidenceRefs: ["rel-e3"] },
      { id: "rel-04", week: "Jun 22", meetingHours: 12, focusHours: 15, context: "Travel", note: "New York trip", evidenceRefs: ["rel-e4"] },
      { id: "rel-05", week: "Jun 29", meetingHours: 6, focusHours: 24, context: "Normal", note: "Quiet week", evidenceRefs: ["rel-e5"] },
      { id: "rel-06", week: "Jul 6", meetingHours: 9, focusHours: 19, context: "Normal", note: "Prototype reviews", evidenceRefs: ["rel-e6"] },
      { id: "rel-07", week: "Jul 13", meetingHours: 14, focusHours: 12, context: "Normal", note: "Planning-heavy", evidenceRefs: ["rel-e7"] },
      { id: "rel-08", week: "Jul 20", meetingHours: 4, focusHours: 27, context: "Retreat", note: "Solo work retreat", evidenceRefs: ["rel-e8"] },
      { id: "rel-09", week: "Jul 27", meetingHours: 11, focusHours: 16, context: "Normal", note: "Two demos", evidenceRefs: ["rel-e9"] },
      { id: "rel-10", week: "Aug 3", meetingHours: 8, focusHours: 21, context: "Normal", note: "Stable cadence", evidenceRefs: ["rel-e10"] },
      { id: "rel-11", week: "Aug 10", meetingHours: 13, focusHours: 14, context: "Travel", note: "Portland trip", evidenceRefs: ["rel-e11"] },
      { id: "rel-12", week: "Aug 17", meetingHours: 6, focusHours: 23, context: "Normal", note: "Protected mornings", evidenceRefs: ["rel-e12"] },
    ],
    evidence: [
      ["Jun 1", 5, 22], ["Jun 8", 7, 20], ["Jun 15", 10, 17], ["Jun 22", 12, 15],
      ["Jun 29", 6, 24], ["Jul 6", 9, 19], ["Jul 13", 14, 12], ["Jul 20", 4, 27],
      ["Jul 27", 11, 16], ["Aug 3", 8, 21], ["Aug 10", 13, 14], ["Aug 17", 6, 23],
    ].map(([week, meetings, focus], index) =>
      rowEvidence(`rel-e${index + 1}`, "weekly-balance", "exports/weekly-work-balance.csv", index + 2, `${week}: ${meetings} meeting hours, ${focus} focus hours.`),
    ),
  },

  matrix: {
    familyId: "matrix",
    mediaType: "text",
    title: "What each prototype has proved",
    question: "Where is the evidence strong or weak across the current prototypes?",
    sources: [
      source("prototype-scorecard", "Prototype scorecard", "text", "markdown", "notes/reviews/prototype-scorecard.md", {
        date: "2026-08-19",
        recordUnit: "prototype score row",
      }),
    ],
    roles: {
      id: "id",
      row: "prototype",
      column: "criterion",
      value: "score",
      annotation: "note",
      evidence: "evidenceRefs",
    },
    records: [
      ...[
        ["Mapping CLI", [5, 4, 4, 3, 4], "Strong contract; integration still forming"],
        ["Meeting Lab", [4, 5, 3, 4, 3], "Proven in use; slower interaction"],
        ["Collection Atlas", [4, 3, 5, 3, 2], "Compelling overview; evidence link is early"],
        ["Marginalia", [3, 3, 4, 4, 4], "Lightweight and flexible"],
        ["Notes Pipeline", [5, 5, 2, 5, 4], "Reliable foundation; modest visual novelty"],
        ["Story Fragments", [3, 2, 4, 3, 3], "Promising interaction; little validation"],
      ].flatMap(([prototype, scores, note], rowIndex) =>
        ["Question fit", "Evidence", "Overview", "Interaction", "Reliability"].map((criterion, columnIndex) => ({
          id: `matrix-${rowIndex}-${columnIndex}`,
          prototype,
          criterion,
          score: scores[columnIndex],
          note,
          evidenceRefs: [`matrix-e${rowIndex + 1}`],
        })),
      ),
    ],
    evidence: [
      textEvidence("matrix-e1", "prototype-scorecard", "notes/reviews/prototype-scorecard.md", 11, 13, "Mapping CLI | Question fit 5 | Evidence 4 | Overview 4 | Interaction 3 | Reliability 4"),
      textEvidence("matrix-e2", "prototype-scorecard", "notes/reviews/prototype-scorecard.md", 15, 17, "Meeting Lab | Question fit 4 | Evidence 5 | Overview 3 | Interaction 4 | Reliability 3"),
      textEvidence("matrix-e3", "prototype-scorecard", "notes/reviews/prototype-scorecard.md", 19, 21, "Collection Atlas | Question fit 4 | Evidence 3 | Overview 5 | Interaction 3 | Reliability 2"),
      textEvidence("matrix-e4", "prototype-scorecard", "notes/reviews/prototype-scorecard.md", 23, 25, "Marginalia | Question fit 3 | Evidence 3 | Overview 4 | Interaction 4 | Reliability 4"),
      textEvidence("matrix-e5", "prototype-scorecard", "notes/reviews/prototype-scorecard.md", 27, 29, "Notes Pipeline | Question fit 5 | Evidence 5 | Overview 2 | Interaction 5 | Reliability 4"),
      textEvidence("matrix-e6", "prototype-scorecard", "notes/reviews/prototype-scorecard.md", 31, 33, "Story Fragments | Question fit 3 | Evidence 2 | Overview 4 | Interaction 3 | Reliability 3"),
    ],
  },

  hierarchy: {
    familyId: "hierarchy",
    mediaType: "structured",
    title: "The shape of the working archive",
    question: "Where is the personal archive concentrated, and which branches are becoming unwieldy?",
    sources: [
      source("archive-manifest", "Archive manifest", "structured", "json", "indexes/archive-manifest.json", {
        date: "2026-08-20",
        recordUnit: "folder",
      }),
    ],
    roles: {
      id: "id",
      parent: "parentId",
      label: "label",
      value: "itemCount",
      color: "recentShare",
      evidence: "evidenceRefs",
    },
    records: [
      { id: "archive", parentId: null, label: "Archive", itemCount: 624, recentShare: 0.22, evidenceRefs: ["hier-e1"] },
      { id: "projects", parentId: "archive", label: "Projects", itemCount: 286, recentShare: 0.34, evidenceRefs: ["hier-e2"] },
      { id: "research", parentId: "archive", label: "Research", itemCount: 168, recentShare: 0.18, evidenceRefs: ["hier-e3"] },
      { id: "journal", parentId: "archive", label: "Journal", itemCount: 112, recentShare: 0.12, evidenceRefs: ["hier-e4"] },
      { id: "reference", parentId: "archive", label: "Reference", itemCount: 58, recentShare: 0.05, evidenceRefs: ["hier-e5"] },
      { id: "mapping", parentId: "projects", label: "Mapping CLI", itemCount: 94, recentShare: 0.61, evidenceRefs: ["hier-e6"] },
      { id: "meeting", parentId: "projects", label: "Meeting Lab", itemCount: 78, recentShare: 0.29, evidenceRefs: ["hier-e7"] },
      { id: "atlas", parentId: "projects", label: "Collection Atlas", itemCount: 67, recentShare: 0.42, evidenceRefs: ["hier-e8"] },
      { id: "other-projects", parentId: "projects", label: "Other experiments", itemCount: 47, recentShare: 0.11, evidenceRefs: ["hier-e9"] },
      { id: "interviews", parentId: "research", label: "Interviews", itemCount: 73, recentShare: 0.26, evidenceRefs: ["hier-e10"] },
      { id: "visual-history", parentId: "research", label: "Visual history", itemCount: 55, recentShare: 0.31, evidenceRefs: ["hier-e11"] },
      { id: "papers", parentId: "research", label: "Papers", itemCount: 40, recentShare: 0.04, evidenceRefs: ["hier-e12"] },
      { id: "daily", parentId: "journal", label: "Daily notes", itemCount: 86, recentShare: 0.13, evidenceRefs: ["hier-e13"] },
      { id: "weekly", parentId: "journal", label: "Weekly reviews", itemCount: 26, recentShare: 0.46, evidenceRefs: ["hier-e14"] },
    ],
    evidence: [
      ["archive", 624], ["projects", 286], ["research", 168], ["journal", 112], ["reference", 58],
      ["mapping", 94], ["meeting", 78], ["atlas", 67], ["other-projects", 47], ["interviews", 73],
      ["visual-history", 55], ["papers", 40], ["daily", 86], ["weekly", 26],
    ].map(([folder, count], index) =>
      rowEvidence(`hier-e${index + 1}`, "archive-manifest", "indexes/archive-manifest.json", index + 1, `${folder}: ${count} indexed items.`),
    ),
  },

  network: {
    familyId: "network",
    mediaType: "text",
    title: "Ideas that keep meeting",
    question: "Which ideas connect the current projects, and where are the strongest bridges?",
    sources: [
      source("concept-index", "Concept-link index", "text", "jsonl", "indexes/concept-links.jsonl", {
        date: "2026-08-20",
        recordUnit: "supported concept relation",
      }),
    ],
    roles: {
      id: "id",
      label: "label",
      group: "group",
      source: "source",
      target: "target",
      linkType: "type",
      value: "strength",
      evidence: "evidenceRefs",
    },
    records: [
      { id: "net-question", label: "Question-shaped views", group: "Principle", evidenceRefs: ["net-e1"] },
      { id: "net-evidence", label: "Exact evidence", group: "Principle", evidenceRefs: ["net-e2"] },
      { id: "net-local", label: "Local processing", group: "Principle", evidenceRefs: ["net-e3"] },
      { id: "net-selection", label: "Selection as context", group: "Interaction", evidenceRefs: ["net-e4"] },
      { id: "net-overview", label: "Overview to detail", group: "Interaction", evidenceRefs: ["net-e5"] },
      { id: "net-templates", label: "Opinionated templates", group: "System", evidenceRefs: ["net-e6"] },
      { id: "net-compiler", label: "Source compiler", group: "System", evidenceRefs: ["net-e7"] },
      { id: "net-chat", label: "Map–chat coupling", group: "Interaction", evidenceRefs: ["net-e8"] },
      { id: "net-provenance", label: "Provenance", group: "Principle", evidenceRefs: ["net-e9"] },
    ],
    links: [
      { id: "net-l1", source: "net-question", target: "net-templates", type: "bounds", strength: 4, evidenceRefs: ["net-e10"] },
      { id: "net-l2", source: "net-compiler", target: "net-evidence", type: "retains", strength: 5, evidenceRefs: ["net-e11"] },
      { id: "net-l3", source: "net-local", target: "net-compiler", type: "constrains", strength: 4, evidenceRefs: ["net-e12"] },
      { id: "net-l4", source: "net-selection", target: "net-chat", type: "grounds", strength: 5, evidenceRefs: ["net-e13"] },
      { id: "net-l5", source: "net-overview", target: "net-selection", type: "leads to", strength: 3, evidenceRefs: ["net-e14"] },
      { id: "net-l6", source: "net-provenance", target: "net-evidence", type: "verifies", strength: 5, evidenceRefs: ["net-e15"] },
      { id: "net-l7", source: "net-templates", target: "net-overview", type: "stabilizes", strength: 4, evidenceRefs: ["net-e16"] },
      { id: "net-l8", source: "net-evidence", target: "net-chat", type: "supports", strength: 5, evidenceRefs: ["net-e17"] },
      { id: "net-l9", source: "net-compiler", target: "net-provenance", type: "emits", strength: 5, evidenceRefs: ["net-e18"] },
      { id: "net-l10", source: "net-question", target: "net-selection", type: "focuses", strength: 3, evidenceRefs: ["net-e19"] },
    ],
    evidence: [
      ...["Question-shaped views", "Exact evidence", "Local processing", "Selection as context", "Overview to detail", "Opinionated templates", "Source compiler", "Map–chat coupling", "Provenance"].map((label, index) =>
        textEvidence(`net-e${index + 1}`, "concept-index", "indexes/concept-links.jsonl", index + 1, index + 1, `Concept: ${label}.`),
      ),
      ...[
        "Question-shaped views bound opinionated templates.", "The source compiler retains exact evidence.",
        "Local processing constrains the source compiler.", "Selection grounds the next chat turn.",
        "Overview leads to selection and detail.", "Templates stabilize overview behavior.",
        "Provenance verifies evidence references.", "Exact evidence supports map–chat answers.",
        "The compiler emits provenance with every mark.", "The question focuses meaningful selections.",
      ].map((excerpt, index) =>
        textEvidence(`net-e${index + 10}`, "concept-index", "indexes/concept-links.jsonl", index + 12, index + 12, excerpt),
      ),
    ],
  },

  flow: {
    familyId: "flow",
    mediaType: "text",
    title: "From captured material to a durable view",
    question: "Where does material enter the visualization workflow, and where does it fall away?",
    sources: [
      source("workflow-audit", "Visualization workflow audit", "text", "markdown", "notes/reviews/workflow-audit.md", {
        date: "2026-08-18",
        recordUnit: "stage transition",
      }),
    ],
    roles: {
      id: "id",
      label: "label",
      stage: "stage",
      source: "source",
      target: "target",
      value: "items",
      linkType: "type",
      evidence: "evidenceRefs",
    },
    records: [
      { id: "flow-notes", label: "Notes", stage: 0, evidenceRefs: ["flow-e1"] },
      { id: "flow-images", label: "Images", stage: 0, evidenceRefs: ["flow-e2"] },
      { id: "flow-exports", label: "Exports", stage: 0, evidenceRefs: ["flow-e3"] },
      { id: "flow-normalized", label: "Normalized records", stage: 1, evidenceRefs: ["flow-e4"] },
      { id: "flow-enriched", label: "Bounded enrichment", stage: 2, evidenceRefs: ["flow-e5"] },
      { id: "flow-validated", label: "Validated package", stage: 3, evidenceRefs: ["flow-e6"] },
      { id: "flow-view", label: "Rendered view", stage: 4, evidenceRefs: ["flow-e7"] },
      { id: "flow-omitted", label: "Known omissions", stage: 3, evidenceRefs: ["flow-e8"] },
    ],
    links: [
      { id: "flow-l1", source: "flow-notes", target: "flow-normalized", items: 184, type: "parsed", evidenceRefs: ["flow-e9"] },
      { id: "flow-l2", source: "flow-images", target: "flow-normalized", items: 62, type: "indexed", evidenceRefs: ["flow-e10"] },
      { id: "flow-l3", source: "flow-exports", target: "flow-normalized", items: 91, type: "adapted", evidenceRefs: ["flow-e11"] },
      { id: "flow-l4", source: "flow-normalized", target: "flow-enriched", items: 271, type: "eligible", evidenceRefs: ["flow-e12"] },
      { id: "flow-l5", source: "flow-normalized", target: "flow-validated", items: 54, type: "deterministic", evidenceRefs: ["flow-e13"] },
      { id: "flow-l6", source: "flow-enriched", target: "flow-validated", items: 258, type: "accepted", evidenceRefs: ["flow-e14"] },
      { id: "flow-l7", source: "flow-enriched", target: "flow-omitted", items: 13, type: "rejected", evidenceRefs: ["flow-e15"] },
      { id: "flow-l8", source: "flow-validated", target: "flow-view", items: 312, type: "rendered", evidenceRefs: ["flow-e16"] },
    ],
    evidence: [
      ...["Notes", "Images", "Exports", "Normalized records", "Bounded enrichment", "Validated package", "Rendered view", "Known omissions"].map((label, index) =>
        textEvidence(`flow-e${index + 1}`, "workflow-audit", "notes/reviews/workflow-audit.md", 10 + index * 2, 10 + index * 2, `Workflow stage: ${label}.`),
      ),
      ...[
        "184 note records parsed.", "62 image records indexed.", "91 exported records adapted.",
        "271 normalized records required bounded enrichment.", "54 records passed deterministically.",
        "258 enrichments passed validation.", "13 enrichments were retained as known omissions.",
        "312 validated records entered the rendered view.",
      ].map((excerpt, index) =>
        textEvidence(`flow-e${index + 9}`, "workflow-audit", "notes/reviews/workflow-audit.md", 31 + index * 2, 31 + index * 2, excerpt),
      ),
    ],
  },

  "region-map": {
    familyId: "region-map",
    mediaType: "geography",
    title: "Where the work has roots",
    question: "Which states hold the largest share of the indexed project memories?",
    sources: [
      source("state-memory-index", "State memory index", "geography", "geojson-with-properties", "indexes/state-memories.geojson", {
        date: "2026-08-20",
        recordUnit: "US state feature",
      }),
    ],
    roles: {
      id: "id",
      region: "geoId",
      regionLabel: "stateId",
      label: "state",
      value: "memoryShare",
      baseline: "memoryBaseline",
      secondary: "returnIntent",
      detail: "theme",
      evidence: "evidenceRefs",
    },
    records: [
      { id: "region-ca", geoId: "06", stateId: "CA", state: "California", memoryShare: 0.43, memoryBaseline: 200, returnIntent: 5, theme: "Home base and prototypes", evidenceRefs: ["region-e1"] },
      { id: "region-or", geoId: "41", stateId: "OR", state: "Oregon", memoryShare: 0.12, memoryBaseline: 200, returnIntent: 4, theme: "Long walks and systems conversations", evidenceRefs: ["region-e2"] },
      { id: "region-wa", geoId: "53", stateId: "WA", state: "Washington", memoryShare: 0.085, memoryBaseline: 200, returnIntent: 3, theme: "Cloud research and old collaborators", evidenceRefs: ["region-e3"] },
      { id: "region-ny", geoId: "36", stateId: "NY", state: "New York", memoryShare: 0.195, memoryBaseline: 200, returnIntent: 5, theme: "Exhibitions and editorial work", evidenceRefs: ["region-e4"] },
      { id: "region-tx", geoId: "48", stateId: "TX", state: "Texas", memoryShare: 0.065, memoryBaseline: 200, returnIntent: 2, theme: "Workshops and family visits", evidenceRefs: ["region-e5"] },
      { id: "region-il", geoId: "17", stateId: "IL", state: "Illinois", memoryShare: 0.105, memoryBaseline: 200, returnIntent: 4, theme: "Design history and teaching", evidenceRefs: ["region-e6"] },
    ],
    evidence: [
      ["CA", "California", "06", 86, 0.43], ["OR", "Oregon", "41", 24, 0.12], ["WA", "Washington", "53", 17, 0.085],
      ["NY", "New York", "36", 39, 0.195], ["TX", "Texas", "48", 13, 0.065], ["IL", "Illinois", "17", 21, 0.105],
    ].map(([stateId, state, fips, count, share], index) =>
      geoEvidence(`region-e${index + 1}`, "state-memory-index", "indexes/state-memories.geojson", stateId, `${state} (FIPS ${fips}): ${count} of 200 indexed project memories; normalized share ${share}.`),
    ),
  },

  "point-map": {
    familyId: "point-map",
    mediaType: "geography",
    title: "Places where ideas moved",
    question: "Where around the Bay Area did consequential work sessions happen?",
    sources: [
      source("place-log", "Geocoded work-place log", "geography", "geojson", "indexes/bay-area-work-places.geojson", {
        dateRange: { start: "2026-05-01", end: "2026-08-20" },
        recordUnit: "place",
      }),
    ],
    roles: {
      id: "id",
      latitude: "latitude",
      longitude: "longitude",
      label: "place",
      value: "sessionCount",
      category: "setting",
      detail: "breakthrough",
      evidence: "evidenceRefs",
    },
    records: [
      { id: "point-mission", place: "Mission studio", latitude: 37.7599, longitude: -122.4148, sessionCount: 18, setting: "Studio", breakthrough: "Map–chat coupling", evidenceRefs: ["point-e1"] },
      { id: "point-berkeley", place: "Berkeley library", latitude: 37.8715, longitude: -122.273, sessionCount: 11, setting: "Library", breakthrough: "Historical family taxonomy", evidenceRefs: ["point-e2"] },
      { id: "point-oakland", place: "Oakland workshop", latitude: 37.8044, longitude: -122.2711, sessionCount: 9, setting: "Workshop", breakthrough: "Evidence-first interaction", evidenceRefs: ["point-e3"] },
      { id: "point-palo-alto", place: "Palo Alto café", latitude: 37.4419, longitude: -122.143, sessionCount: 6, setting: "Café", breakthrough: "Template contracts", evidenceRefs: ["point-e4"] },
      { id: "point-sausalito", place: "Sausalito waterfront", latitude: 37.8591, longitude: -122.4853, sessionCount: 4, setting: "Outdoors", breakthrough: "Collection atlas sketch", evidenceRefs: ["point-e5"] },
      { id: "point-richmond", place: "Richmond field visit", latitude: 37.9358, longitude: -122.3477, sessionCount: 5, setting: "Field", breakthrough: "Spatial evidence notes", evidenceRefs: ["point-e6"] },
      { id: "point-alameda", place: "Alameda kitchen table", latitude: 37.7652, longitude: -122.2416, sessionCount: 7, setting: "Home", breakthrough: "Family viewer naming", evidenceRefs: ["point-e7"] },
      { id: "point-san-mateo", place: "San Mateo meeting room", latitude: 37.563, longitude: -122.3255, sessionCount: 8, setting: "Office", breakthrough: "Pipeline validation rules", evidenceRefs: ["point-e8"] },
      { id: "point-headlands", place: "Marin Headlands overlook", latitude: 37.8324, longitude: -122.4994, sessionCount: 3, setting: "Outdoors", breakthrough: "Overview-to-detail metaphor", evidenceRefs: ["point-e9"] },
      { id: "point-half-moon", place: "Half Moon Bay retreat", latitude: 37.4636, longitude: -122.4286, sessionCount: 5, setting: "Retreat", breakthrough: "Opinionated templates memo", evidenceRefs: ["point-e10"] },
    ],
    evidence: [
      ["mission", 37.7599, -122.4148], ["berkeley", 37.8715, -122.273], ["oakland", 37.8044, -122.2711],
      ["palo-alto", 37.4419, -122.143], ["sausalito", 37.8591, -122.4853], ["richmond", 37.9358, -122.3477],
      ["alameda", 37.7652, -122.2416], ["san-mateo", 37.563, -122.3255], ["headlands", 37.8324, -122.4994],
      ["half-moon", 37.4636, -122.4286],
    ].map(([featureId, latitude, longitude], index) =>
      geoEvidence(`point-e${index + 1}`, "place-log", "indexes/bay-area-work-places.geojson", featureId, `Recorded work place at ${latitude}, ${longitude}.`, [longitude, latitude]),
    ),
  },

  field: {
    familyId: "field",
    mediaType: "structured",
    title: "The weekly attention field",
    question: "At what times of day and week does sustained attention tend to be strongest?",
    sources: [
      source("attention-grid", "Attention check-ins", "structured", "csv", "exports/attention-grid.csv", {
        dateRange: { start: "2026-07-06", end: "2026-08-14" },
        recordUnit: "weekday by hour aggregate",
      }),
    ],
    roles: {
      id: "id",
      x: "x",
      y: "y",
      value: "value",
      xLabel: "hourLabel",
      yLabel: "weekday",
      evidence: "evidenceRefs",
    },
    records: [
      ...[
        ["Monday", [8, 9, 7, 6, 5, 4]],
        ["Tuesday", [7, 9, 8, 6, 5, 4]],
        ["Wednesday", [6, 8, 7, 5, 4, 3]],
        ["Thursday", [8, 9, 8, 7, 5, 4]],
        ["Friday", [7, 8, 6, 5, 4, 3]],
      ].flatMap(([weekday, values], weekdayIndex) =>
        [8, 10, 12, 14, 16, 18].map((hour, hourIndex) => ({
          id: `field-${weekdayIndex}-${hour}`,
          x: hour,
          y: weekdayIndex,
          hour,
          hourLabel: `${hour}:00`,
          weekday,
          weekdayIndex,
          value: values[hourIndex],
          attention: values[hourIndex],
          evidenceRefs: [`field-e${weekdayIndex + 1}`],
        })),
      ),
    ],
    evidence: [
      ["Monday", "8,9,7,6,5,4"], ["Tuesday", "7,9,8,6,5,4"], ["Wednesday", "6,8,7,5,4,3"],
      ["Thursday", "8,9,8,7,5,4"], ["Friday", "7,8,6,5,4,3"],
    ].map(([weekday, values], index) =>
      rowEvidence(`field-e${index + 1}`, "attention-grid", "exports/attention-grid.csv", index + 2, `${weekday} attention at 08,10,12,14,16,18: ${values}.`),
    ),
  },

  "collection-atlas": {
    familyId: "collection-atlas",
    mediaType: "mixed",
    title: "Atlas of a month’s working material",
    question: "What neighborhoods form across the notes, images, recordings, and clips collected this month?",
    sources: [
      source("atlas-notes", "August notes", "text", "markdown-folder", "notes/2026-08/", { recordUnit: "note" }),
      source("atlas-images", "August images", "image", "image-folder", "media/2026-08/images/", { recordUnit: "image" }),
      source("atlas-video", "August video clips", "video", "video-folder", "media/2026-08/video/", { recordUnit: "clip" }),
      source("atlas-audio", "August voice memos", "audio", "audio-folder", "media/2026-08/audio/", { recordUnit: "memo" }),
    ],
    roles: {
      id: "id",
      x: "x",
      y: "y",
      label: "label",
      category: "category",
      value: "size",
      mediaType: "mediaType",
      preview: "preview",
      date: "date",
      evidence: "evidenceRefs",
    },
    records: [
      { id: "atlas-01", x: 12, y: 18, category: "Product", size: 18, label: "Question before chart", date: "2026-08-02", mediaType: "text", preview: { kind: "text", excerpt: "Start with the question the view must answer.", lineCount: 9 }, evidenceRefs: ["atlas-e1"] },
      { id: "atlas-02", x: 17, y: 23, category: "Product", size: 13, label: "Family contract sketch", date: "2026-08-03", mediaType: "image", preview: { kind: "image", aspectRatio: 1.33, dominantColor: "#d9c8aa", alt: "Notebook sketch of a family contract" }, evidenceRefs: ["atlas-e2"] },
      { id: "atlas-03", x: 23, y: 17, category: "Product", size: 16, label: "Map–chat coupling", date: "2026-08-04", mediaType: "text", preview: { kind: "text", excerpt: "A selection should become the next conversational context.", lineCount: 14 }, evidenceRefs: ["atlas-e3"] },
      { id: "atlas-04", x: 28, y: 26, category: "Product", size: 20, label: "Viewer walkthrough", date: "2026-08-06", mediaType: "video", preview: { kind: "video", durationSeconds: 74, posterFrameSeconds: 21, dominantColor: "#394553" }, evidenceRefs: ["atlas-e4"] },
      { id: "atlas-05", x: 31, y: 19, category: "Product", size: 11, label: "Abstention rules", date: "2026-08-07", mediaType: "text", preview: { kind: "text", excerpt: "A family needs to know when its grammar would mislead.", lineCount: 7 }, evidenceRefs: ["atlas-e5"] },
      { id: "atlas-06", x: 38, y: 31, category: "Evidence", size: 17, label: "Exact locator card", date: "2026-08-08", mediaType: "image", preview: { kind: "image", aspectRatio: 1.5, dominantColor: "#e8e4db", alt: "Interface card showing a file and line range" }, evidenceRefs: ["atlas-e6"] },
      { id: "atlas-07", x: 43, y: 25, category: "Evidence", size: 14, label: "Trust is a property", date: "2026-08-09", mediaType: "audio", preview: { kind: "audio", durationSeconds: 46, peaks: [0.2, 0.6, 0.35, 0.8, 0.42, 0.5] }, evidenceRefs: ["atlas-e7"] },
      { id: "atlas-08", x: 47, y: 35, category: "Evidence", size: 19, label: "Provenance seam", date: "2026-08-10", mediaType: "text", preview: { kind: "text", excerpt: "The compiler must retain the path from mark back to source.", lineCount: 18 }, evidenceRefs: ["atlas-e8"] },
      { id: "atlas-09", x: 52, y: 28, category: "Evidence", size: 10, label: "Omission state", date: "2026-08-10", mediaType: "image", preview: { kind: "image", aspectRatio: 1, dominantColor: "#c9d3d0", alt: "Small diagram separating known omissions from validated records" }, evidenceRefs: ["atlas-e9"] },
      { id: "atlas-10", x: 57, y: 38, category: "Evidence", size: 15, label: "Evidence interaction", date: "2026-08-11", mediaType: "video", preview: { kind: "video", durationSeconds: 53, posterFrameSeconds: 12, dominantColor: "#273443" }, evidenceRefs: ["atlas-e10"] },
      { id: "atlas-11", x: 66, y: 17, category: "History", size: 21, label: "Golden-age atlas spread", date: "2026-08-12", mediaType: "image", preview: { kind: "image", aspectRatio: 1.42, dominantColor: "#c2a46e", alt: "Historic statistical atlas spread with maps and diagrams" }, evidenceRefs: ["atlas-e11"] },
      { id: "atlas-12", x: 72, y: 22, category: "History", size: 13, label: "Graphical standards", date: "2026-08-12", mediaType: "text", preview: { kind: "text", excerpt: "Clarity depends on refusing to say too much at once.", lineCount: 11 }, evidenceRefs: ["atlas-e12"] },
      { id: "atlas-13", x: 77, y: 15, category: "History", size: 16, label: "Milestones timeline", date: "2026-08-13", mediaType: "video", preview: { kind: "video", durationSeconds: 38, posterFrameSeconds: 8, dominantColor: "#705849" }, evidenceRefs: ["atlas-e13"] },
      { id: "atlas-14", x: 81, y: 28, category: "History", size: 12, label: "Bertin variables", date: "2026-08-13", mediaType: "image", preview: { kind: "image", aspectRatio: 0.75, dominantColor: "#ddd4c2", alt: "Seven visual variables drawn as a reference card" }, evidenceRefs: ["atlas-e14"] },
      { id: "atlas-15", x: 68, y: 34, category: "History", size: 9, label: "Repertoire, not endorsement", date: "2026-08-14", mediaType: "text", preview: { kind: "text", excerpt: "Historical novelty does not make a reliable default.", lineCount: 6 }, evidenceRefs: ["atlas-e15"] },
      { id: "atlas-16", x: 18, y: 61, category: "Fieldwork", size: 20, label: "Wall of interview notes", date: "2026-08-05", mediaType: "image", preview: { kind: "image", aspectRatio: 1.6, dominantColor: "#d5bd78", alt: "Sticky notes arranged on a studio wall" }, evidenceRefs: ["atlas-e16"] },
      { id: "atlas-17", x: 24, y: 68, category: "Fieldwork", size: 12, label: "Walking interview", date: "2026-08-06", mediaType: "audio", preview: { kind: "audio", durationSeconds: 132, peaks: [0.3, 0.55, 0.4, 0.7, 0.62, 0.28] }, evidenceRefs: ["atlas-e17"] },
      { id: "atlas-18", x: 31, y: 58, category: "Fieldwork", size: 16, label: "Selection behavior", date: "2026-08-07", mediaType: "text", preview: { kind: "text", excerpt: "People first pointed, then asked for the story behind the point.", lineCount: 16 }, evidenceRefs: ["atlas-e18"] },
      { id: "atlas-19", x: 36, y: 72, category: "Fieldwork", size: 14, label: "Prototype reaction", date: "2026-08-08", mediaType: "video", preview: { kind: "video", durationSeconds: 67, posterFrameSeconds: 29, dominantColor: "#52606b" }, evidenceRefs: ["atlas-e19"] },
      { id: "atlas-20", x: 42, y: 64, category: "Fieldwork", size: 10, label: "Paper map marks", date: "2026-08-09", mediaType: "image", preview: { kind: "image", aspectRatio: 1.25, dominantColor: "#e3d8bf", alt: "Paper map with pencil circles and margin notes" }, evidenceRefs: ["atlas-e20"] },
      { id: "atlas-21", x: 54, y: 63, category: "Craft", size: 18, label: "Quiet visual hierarchy", date: "2026-08-15", mediaType: "text", preview: { kind: "text", excerpt: "The interface should feel quieter than the material it contains.", lineCount: 13 }, evidenceRefs: ["atlas-e21"] },
      { id: "atlas-22", x: 59, y: 71, category: "Craft", size: 11, label: "Type scale study", date: "2026-08-15", mediaType: "image", preview: { kind: "image", aspectRatio: 1.4, dominantColor: "#f0ede7", alt: "Typography scale and annotation study" }, evidenceRefs: ["atlas-e22"] },
      { id: "atlas-23", x: 64, y: 59, category: "Craft", size: 15, label: "Selection motion", date: "2026-08-16", mediaType: "video", preview: { kind: "video", durationSeconds: 24, posterFrameSeconds: 7, dominantColor: "#243440" }, evidenceRefs: ["atlas-e23"] },
      { id: "atlas-24", x: 71, y: 67, category: "Craft", size: 9, label: "Color restraint", date: "2026-08-16", mediaType: "text", preview: { kind: "text", excerpt: "Reserve saturated color for evidence-bearing state.", lineCount: 8 }, evidenceRefs: ["atlas-e24"] },
      { id: "atlas-25", x: 77, y: 61, category: "Craft", size: 13, label: "Density modes", date: "2026-08-17", mediaType: "image", preview: { kind: "image", aspectRatio: 1.33, dominantColor: "#b9c5c2", alt: "Three sketches showing labels collapsing into clusters" }, evidenceRefs: ["atlas-e25"] },
      { id: "atlas-26", x: 34, y: 88, category: "Reflection", size: 17, label: "Composition is earned", date: "2026-08-18", mediaType: "audio", preview: { kind: "audio", durationSeconds: 59, peaks: [0.18, 0.45, 0.72, 0.5, 0.36, 0.6] }, evidenceRefs: ["atlas-e26"] },
      { id: "atlas-27", x: 43, y: 84, category: "Reflection", size: 12, label: "What stayed constant", date: "2026-08-18", mediaType: "text", preview: { kind: "text", excerpt: "The question, evidence, and selection contract survived every prototype.", lineCount: 12 }, evidenceRefs: ["atlas-e27"] },
      { id: "atlas-28", x: 52, y: 91, category: "Reflection", size: 19, label: "Month-end contact sheet", date: "2026-08-19", mediaType: "image", preview: { kind: "image", aspectRatio: 1.78, dominantColor: "#a98f75", alt: "Contact sheet of sketches, walks, screens, and workshop walls" }, evidenceRefs: ["atlas-e28"] },
      { id: "atlas-29", x: 62, y: 85, category: "Reflection", size: 14, label: "A tool for returning", date: "2026-08-20", mediaType: "video", preview: { kind: "video", durationSeconds: 42, posterFrameSeconds: 19, dominantColor: "#33404a" }, evidenceRefs: ["atlas-e29"] },
      { id: "atlas-30", x: 72, y: 89, category: "Reflection", size: 10, label: "Next month’s wager", date: "2026-08-20", mediaType: "text", preview: { kind: "text", excerpt: "Make four families excellent before making nineteen merely possible.", lineCount: 7 }, evidenceRefs: ["atlas-e30"] },
    ],
    evidence: [
      textEvidence("atlas-e1", "atlas-notes", "notes/2026-08/02-question-before-chart.md", 4, 12, "Start with the question the view must answer."),
      imageEvidence("atlas-e2", "atlas-images", "media/2026-08/images/family-contract-sketch.jpg", { x: 0.08, y: 0.12, width: 0.84, height: 0.72 }, "Notebook sketch of the first family contract."),
      textEvidence("atlas-e3", "atlas-notes", "notes/2026-08/04-map-chat.md", 9, 22, "A selection should become the next conversational context."),
      timedEvidence("atlas-e4", "atlas-video", "video", "media/2026-08/video/viewer-walkthrough.mov", 18, 31, "Walkthrough of selecting a mark and opening its evidence."),
      textEvidence("atlas-e5", "atlas-notes", "notes/2026-08/07-abstention.md", 3, 9, "A family needs to know when its grammar would mislead."),
      imageEvidence("atlas-e6", "atlas-images", "media/2026-08/images/exact-locator-card.png", { x: 0.14, y: 0.18, width: 0.7, height: 0.58 }, "Evidence card showing a file and exact line range."),
      timedEvidence("atlas-e7", "atlas-audio", "audio", "media/2026-08/audio/trust-property.m4a", 4, 28, "Trust is a property of the whole path, not a badge on the last screen."),
      textEvidence("atlas-e8", "atlas-notes", "notes/2026-08/10-provenance-seam.md", 6, 23, "The compiler must retain the path from mark back to source."),
      imageEvidence("atlas-e9", "atlas-images", "media/2026-08/images/omission-state.png", { x: 0.09, y: 0.1, width: 0.82, height: 0.8 }, "Diagram separating validated records and known omissions."),
      timedEvidence("atlas-e10", "atlas-video", "video", "media/2026-08/video/evidence-interaction.mov", 9, 26, "Prototype interaction that reveals evidence without leaving the map."),
      imageEvidence("atlas-e11", "atlas-images", "media/2026-08/images/golden-age-atlas.jpg", { x: 0, y: 0, width: 1, height: 1 }, "Historic statistical atlas spread."),
      textEvidence("atlas-e12", "atlas-notes", "notes/2026-08/12-graphical-standards.md", 7, 17, "Clarity depends on refusing to say too much at once."),
      timedEvidence("atlas-e13", "atlas-video", "video", "media/2026-08/video/milestones-scroll.mov", 3, 19, "Screen recording moving through the historical milestones timeline."),
      imageEvidence("atlas-e14", "atlas-images", "media/2026-08/images/bertin-card.jpg", { x: 0.05, y: 0.08, width: 0.9, height: 0.84 }, "Hand-drawn reference card for visual variables."),
      textEvidence("atlas-e15", "atlas-notes", "notes/2026-08/14-repertoire.md", 2, 7, "Historical novelty does not make a reliable default."),
      imageEvidence("atlas-e16", "atlas-images", "media/2026-08/images/interview-wall.jpg", { x: 0.03, y: 0.06, width: 0.94, height: 0.86 }, "Wall of clustered interview notes."),
      timedEvidence("atlas-e17", "atlas-audio", "audio", "media/2026-08/audio/walking-interview.m4a", 41, 96, "Participant describes wanting to point at a visual and ask what lies behind it."),
      textEvidence("atlas-e18", "atlas-notes", "notes/2026-08/07-selection-behavior.md", 11, 26, "People first pointed, then asked for the story behind the point."),
      timedEvidence("atlas-e19", "atlas-video", "video", "media/2026-08/video/prototype-reaction.mov", 22, 47, "Participant moves from overview to one selected cluster."),
      imageEvidence("atlas-e20", "atlas-images", "media/2026-08/images/paper-map.jpg", { x: 0.1, y: 0.09, width: 0.8, height: 0.76 }, "Pencil circles and margin notes on a paper map."),
      textEvidence("atlas-e21", "atlas-notes", "notes/2026-08/15-quiet-hierarchy.md", 5, 17, "The interface should feel quieter than the material it contains."),
      imageEvidence("atlas-e22", "atlas-images", "media/2026-08/images/type-scale-study.png", { x: 0.06, y: 0.07, width: 0.88, height: 0.87 }, "Type scale and annotation hierarchy study."),
      timedEvidence("atlas-e23", "atlas-video", "video", "media/2026-08/video/selection-motion.mov", 2, 14, "Motion study for selecting and pinning a mark."),
      textEvidence("atlas-e24", "atlas-notes", "notes/2026-08/16-color-restraint.md", 4, 11, "Reserve saturated color for evidence-bearing state."),
      imageEvidence("atlas-e25", "atlas-images", "media/2026-08/images/density-modes.jpg", { x: 0.04, y: 0.08, width: 0.92, height: 0.82 }, "Labels collapse into clusters as the collection becomes dense."),
      timedEvidence("atlas-e26", "atlas-audio", "audio", "media/2026-08/audio/composition-earned.m4a", 7, 44, "Composition should be extracted from repeated successful families."),
      textEvidence("atlas-e27", "atlas-notes", "notes/2026-08/18-constants.md", 8, 19, "The question, evidence, and selection contract survived every prototype."),
      imageEvidence("atlas-e28", "atlas-images", "media/2026-08/images/month-contact-sheet.jpg", { x: 0, y: 0, width: 1, height: 1 }, "Contact sheet spanning the month’s working material."),
      timedEvidence("atlas-e29", "atlas-video", "video", "media/2026-08/video/tool-for-returning.mov", 11, 32, "Reflection on using a visual as a place to return to work."),
      textEvidence("atlas-e30", "atlas-notes", "notes/2026-08/20-next-wager.md", 3, 9, "Make four families excellent before making nineteen merely possible."),
    ],
  },

  "passage-comparison": {
    familyId: "passage-comparison",
    mediaType: "text",
    title: "How the product principle changed",
    question: "How did the argument for opinionated templates sharpen between the early notes and design review?",
    sources: [
      source("early-notes", "Early product notes", "text", "markdown", "notes/product/early-mapping-notes.md", { date: "2026-07-14" }),
      source("review-transcript", "Design review transcript", "text", "transcript", "notes/reviews/family-review.txt", { date: "2026-08-20" }),
    ],
    roles: {
      id: "id",
      text: "passage",
      source: "sourceLabel",
      version: "version",
      date: "date",
      stance: "stance",
      evidence: "evidenceRefs",
    },
    records: [
      { id: "passage-1", sourceLabel: "Early notes", version: "Early notes", date: "2026-07-14", stance: "Scope", passage: "The system might offer a grammar from which an agent can assemble almost any visualization.", evidenceRefs: ["passage-e1"] },
      { id: "passage-2", sourceLabel: "Early notes", version: "Early notes", date: "2026-07-14", stance: "Boundary", passage: "The open grammar is powerful, though the generated interfaces already feel too busy.", evidenceRefs: ["passage-e2"] },
      { id: "passage-3", sourceLabel: "Design review", version: "Design review", date: "2026-08-20", stance: "Scope", passage: "A template is not merely a chart; it owns a question, data contract, evidence behavior, and abstention rule.", evidenceRefs: ["passage-e3"] },
      { id: "passage-4", sourceLabel: "Design review", version: "Design review", date: "2026-08-20", stance: "Boundary", passage: "Composition becomes legitimate only after repeated families expose the same successful behavior.", evidenceRefs: ["passage-e4"] },
    ],
    evidence: [
      textEvidence("passage-e1", "early-notes", "notes/product/early-mapping-notes.md", 18, 20, "The system might offer a grammar from which an agent can assemble almost any visualization."),
      textEvidence("passage-e2", "early-notes", "notes/product/early-mapping-notes.md", 24, 27, "The open grammar is powerful, though the generated interfaces already feel too busy."),
      textEvidence("passage-e3", "review-transcript", "notes/reviews/family-review.txt", 141, 146, "A template is not merely a chart; it owns a question, data contract, evidence behavior, and abstention rule."),
      textEvidence("passage-e4", "review-transcript", "notes/reviews/family-review.txt", 168, 172, "Composition becomes legitimate only after repeated families expose the same successful behavior."),
    ],
  },

  sequence: {
    familyId: "sequence",
    mediaType: "mixed",
    title: "A prototype becoming legible",
    question: "How did the viewer change from the first paper sketch to the reviewable interaction?",
    sources: [
      source("sequence-images", "Prototype stills", "image", "image-folder", "media/prototype-sequence/stills/", { recordUnit: "frame" }),
      source("sequence-video", "Prototype recordings", "video", "video-folder", "media/prototype-sequence/clips/", { recordUnit: "time range" }),
    ],
    roles: {
      id: "id",
      order: "order",
      label: "label",
      mediaType: "mediaType",
      preview: "preview",
      date: "date",
      change: "change",
      evidence: "evidenceRefs",
    },
    records: [
      { id: "seq-01", order: 1, label: "Paper inventory", date: "2026-08-04", mediaType: "image", preview: { kind: "image", aspectRatio: 1.33, dominantColor: "#dfd0b6" }, change: "Listed candidate views without a shared shell", evidenceRefs: ["seq-e1"] },
      { id: "seq-02", order: 2, label: "Question header", date: "2026-08-06", mediaType: "image", preview: { kind: "image", aspectRatio: 1.5, dominantColor: "#e9e7e1" }, change: "Put the user question above the visualization", evidenceRefs: ["seq-e2"] },
      { id: "seq-03", order: 3, label: "First live data", date: "2026-08-08", mediaType: "video", preview: { kind: "video", durationSeconds: 31, posterFrameSeconds: 9 }, change: "Replaced drawn marks with compiled records", evidenceRefs: ["seq-e3"] },
      { id: "seq-04", order: 4, label: "Evidence drawer", date: "2026-08-10", mediaType: "image", preview: { kind: "image", aspectRatio: 1.6, dominantColor: "#d9dedc" }, change: "Added exact source anchors beside the selected mark", evidenceRefs: ["seq-e4"] },
      { id: "seq-05", order: 5, label: "Selection becomes context", date: "2026-08-12", mediaType: "video", preview: { kind: "video", durationSeconds: 44, posterFrameSeconds: 17 }, change: "Carried selection into the next question", evidenceRefs: ["seq-e5"] },
      { id: "seq-06", order: 6, label: "Quieter hierarchy", date: "2026-08-14", mediaType: "image", preview: { kind: "image", aspectRatio: 1.6, dominantColor: "#eff0ec" }, change: "Removed cards and reduced competing controls", evidenceRefs: ["seq-e6"] },
      { id: "seq-07", order: 7, label: "Density adaptation", date: "2026-08-17", mediaType: "video", preview: { kind: "video", durationSeconds: 36, posterFrameSeconds: 14 }, change: "Collapsed labels into cluster summaries at distance", evidenceRefs: ["seq-e7"] },
      { id: "seq-08", order: 8, label: "Review candidate", date: "2026-08-20", mediaType: "image", preview: { kind: "image", aspectRatio: 1.6, dominantColor: "#e8e9e4" }, change: "Unified title, legend, evidence, and selection states", evidenceRefs: ["seq-e8"] },
    ],
    evidence: [
      imageEvidence("seq-e1", "sequence-images", "media/prototype-sequence/stills/01-paper-inventory.jpg", { x: 0, y: 0, width: 1, height: 1 }, "Paper inventory of candidate map families."),
      imageEvidence("seq-e2", "sequence-images", "media/prototype-sequence/stills/02-question-header.png", { x: 0.04, y: 0.03, width: 0.92, height: 0.28 }, "Question moved into the primary header."),
      timedEvidence("seq-e3", "sequence-video", "video", "media/prototype-sequence/clips/03-live-data.mov", 6, 19, "Compiled records replace placeholder marks."),
      imageEvidence("seq-e4", "sequence-images", "media/prototype-sequence/stills/04-evidence-drawer.png", { x: 0.62, y: 0.08, width: 0.34, height: 0.84 }, "Evidence drawer with exact source anchors."),
      timedEvidence("seq-e5", "sequence-video", "video", "media/prototype-sequence/clips/05-selection-context.mov", 12, 31, "Selection is attached to a follow-up question."),
      imageEvidence("seq-e6", "sequence-images", "media/prototype-sequence/stills/06-quiet-hierarchy.png", { x: 0, y: 0, width: 1, height: 1 }, "Reduced controls and quieter hierarchy."),
      timedEvidence("seq-e7", "sequence-video", "video", "media/prototype-sequence/clips/07-density.mov", 8, 25, "Labels collapse into cluster summaries while zooming out."),
      imageEvidence("seq-e8", "sequence-images", "media/prototype-sequence/stills/08-review-candidate.png", { x: 0, y: 0, width: 1, height: 1 }, "Review candidate with unified interaction states."),
    ],
  },

  mechanism: {
    familyId: "mechanism",
    mediaType: "document",
    title: "How a local source becomes an answerable view",
    question: "Which components transform source material, and what kind of dependency connects them?",
    sources: [
      source("system-diagram", "Local visualization mechanism", "document", "pdf", "design/local-visualization-mechanism.pdf", {
        pageCount: 2,
        recordUnit: "diagram component or connector",
      }),
    ],
    roles: {
      id: "id",
      label: "label",
      group: "layer",
      source: "source",
      target: "target",
      linkType: "type",
      detail: "description",
      evidence: "evidenceRefs",
    },
    records: [
      { id: "mech-source", label: "Local sources", layer: "Input", description: "Notes, exports, media, and metadata", evidenceRefs: ["mech-e1"] },
      { id: "mech-adapter", label: "Source adapter", layer: "Compile", description: "Enumerates and parses an explicit scope", evidenceRefs: ["mech-e2"] },
      { id: "mech-normalizer", label: "Normalizer", layer: "Compile", description: "Produces deterministic records", evidenceRefs: ["mech-e3"] },
      { id: "mech-enricher", label: "Bounded enricher", layer: "Interpret", description: "Adds only declared semantic fields", evidenceRefs: ["mech-e4"] },
      { id: "mech-validator", label: "Validator", layer: "Verify", description: "Checks schema, consistency, and provenance", evidenceRefs: ["mech-e5"] },
      { id: "mech-package", label: "Family package", layer: "Output", description: "Versioned data plus role mapping", evidenceRefs: ["mech-e6"] },
      { id: "mech-renderer", label: "Fixed renderer", layer: "View", description: "Applies the family’s visual grammar", evidenceRefs: ["mech-e7"] },
      { id: "mech-evidence", label: "Evidence resolver", layer: "View", description: "Returns exact local anchors for selections", evidenceRefs: ["mech-e8"] },
    ],
    links: [
      { id: "mech-l1", source: "mech-source", target: "mech-adapter", type: "scoped by", evidenceRefs: ["mech-e9"] },
      { id: "mech-l2", source: "mech-adapter", target: "mech-normalizer", type: "feeds", evidenceRefs: ["mech-e10"] },
      { id: "mech-l3", source: "mech-normalizer", target: "mech-enricher", type: "may request", evidenceRefs: ["mech-e11"] },
      { id: "mech-l4", source: "mech-normalizer", target: "mech-validator", type: "must pass", evidenceRefs: ["mech-e12"] },
      { id: "mech-l5", source: "mech-enricher", target: "mech-validator", type: "must justify", evidenceRefs: ["mech-e13"] },
      { id: "mech-l6", source: "mech-validator", target: "mech-package", type: "certifies", evidenceRefs: ["mech-e14"] },
      { id: "mech-l7", source: "mech-package", target: "mech-renderer", type: "configures", evidenceRefs: ["mech-e15"] },
      { id: "mech-l8", source: "mech-package", target: "mech-evidence", type: "indexes", evidenceRefs: ["mech-e16"] },
      { id: "mech-l9", source: "mech-evidence", target: "mech-renderer", type: "grounds selections in", evidenceRefs: ["mech-e17"] },
    ],
    evidence: [
      ...[
        ["mech-e1", 0.03, 0.1, 0.18, 0.18, "Local sources"], ["mech-e2", 0.26, 0.1, 0.16, 0.18, "Source adapter"],
        ["mech-e3", 0.47, 0.1, 0.16, 0.18, "Normalizer"], ["mech-e4", 0.47, 0.39, 0.16, 0.18, "Bounded enricher"],
        ["mech-e5", 0.68, 0.24, 0.14, 0.18, "Validator"], ["mech-e6", 0.86, 0.24, 0.12, 0.18, "Family package"],
        ["mech-e7", 0.7, 0.7, 0.14, 0.18, "Fixed renderer"], ["mech-e8", 0.86, 0.7, 0.12, 0.18, "Evidence resolver"],
      ].map(([id, x, y, width, height, label]) =>
        documentEvidence(id, "system-diagram", "design/local-visualization-mechanism.pdf", 1, { x, y, width, height }, `Diagram component: ${label}.`),
      ),
      ...[
        ["mech-e9", 0.19, 0.14, 0.09, 0.06, "Local sources are scoped by the adapter."],
        ["mech-e10", 0.4, 0.14, 0.09, 0.06, "The adapter feeds deterministic normalization."],
        ["mech-e11", 0.53, 0.27, 0.06, 0.14, "Normalization may request bounded enrichment."],
        ["mech-e12", 0.61, 0.13, 0.1, 0.13, "Normalized records must pass validation."],
        ["mech-e13", 0.61, 0.43, 0.1, 0.1, "Enrichment must justify itself to validation."],
        ["mech-e14", 0.79, 0.28, 0.09, 0.08, "Validation certifies the family package."],
        ["mech-e15", 0.78, 0.46, 0.14, 0.25, "The package configures the fixed renderer."],
        ["mech-e16", 0.9, 0.43, 0.05, 0.26, "The package indexes the evidence resolver."],
        ["mech-e17", 0.81, 0.75, 0.08, 0.06, "Evidence grounds renderer selections."],
      ].map(([id, x, y, width, height, excerpt]) =>
        documentEvidence(id, "system-diagram", "design/local-visualization-mechanism.pdf", 1, { x, y, width, height }, excerpt),
      ),
    ],
  },

  "annotated-specimen": {
    familyId: "annotated-specimen",
    mediaType: "image",
    title: "Anatomy of a working wall",
    question: "Which regions of the synthesis wall carry decisions, evidence, uncertainty, and unresolved questions?",
    sources: [
      source("wall-photo", "Synthesis wall photograph", "image", "jpeg", "media/fieldwork/synthesis-wall.jpg", {
        width: 4032,
        height: 3024,
        date: "2026-08-09",
        recordUnit: "normalized callout region",
      }),
    ],
    specimen: {
      sourceId: "wall-photo",
      aspectRatio: 1.333,
      preview: { kind: "image", dominantColor: "#c7b891", alt: "Studio wall covered with notes, printouts, and thread" },
    },
    roles: {
      id: "id",
      x: "x",
      y: "y",
      width: "width",
      height: "height",
      label: "label",
      layer: "layer",
      detail: "detail",
      evidence: "evidenceRefs",
    },
    records: [
      { id: "spec-question", x: 0.07, y: 0.08, width: 0.28, height: 0.13, label: "Framing question", layer: "Question", detail: "The question governing the entire wall", evidenceRefs: ["spec-e1"] },
      { id: "spec-interviews", x: 0.05, y: 0.28, width: 0.34, height: 0.43, label: "Interview evidence", layer: "Evidence", detail: "Yellow notes, one claim per participant passage", evidenceRefs: ["spec-e2"] },
      { id: "spec-patterns", x: 0.43, y: 0.22, width: 0.25, height: 0.37, label: "Recurring patterns", layer: "Synthesis", detail: "Clusters that recur across at least three sources", evidenceRefs: ["spec-e3"] },
      { id: "spec-counter", x: 0.7, y: 0.18, width: 0.22, height: 0.22, label: "Counterexamples", layer: "Uncertainty", detail: "Cases that resist the dominant pattern", evidenceRefs: ["spec-e4"] },
      { id: "spec-decisions", x: 0.71, y: 0.48, width: 0.23, height: 0.26, label: "Design decisions", layer: "Decision", detail: "Blue cards translate patterns into commitments", evidenceRefs: ["spec-e5"] },
      { id: "spec-thread", x: 0.35, y: 0.14, width: 0.42, height: 0.58, label: "Evidence thread", layer: "Relationship", detail: "Red thread connects claims to decisions", evidenceRefs: ["spec-e6"] },
      { id: "spec-parking", x: 0.08, y: 0.77, width: 0.29, height: 0.14, label: "Parking lot", layer: "Question", detail: "Important questions outside the current scope", evidenceRefs: ["spec-e7"] },
      { id: "spec-next", x: 0.63, y: 0.8, width: 0.29, height: 0.12, label: "Next experiments", layer: "Decision", detail: "Three tests chosen for the next cycle", evidenceRefs: ["spec-e8"] },
    ],
    evidence: [
      imageEvidence("spec-e1", "wall-photo", "media/fieldwork/synthesis-wall.jpg", { x: 0.07, y: 0.08, width: 0.28, height: 0.13 }, "Handwritten framing question at the top left."),
      imageEvidence("spec-e2", "wall-photo", "media/fieldwork/synthesis-wall.jpg", { x: 0.05, y: 0.28, width: 0.34, height: 0.43 }, "Yellow interview notes grouped by participant."),
      imageEvidence("spec-e3", "wall-photo", "media/fieldwork/synthesis-wall.jpg", { x: 0.43, y: 0.22, width: 0.25, height: 0.37 }, "Named clusters of recurring observations."),
      imageEvidence("spec-e4", "wall-photo", "media/fieldwork/synthesis-wall.jpg", { x: 0.7, y: 0.18, width: 0.22, height: 0.22 }, "Counterexample cards separated from the main clusters."),
      imageEvidence("spec-e5", "wall-photo", "media/fieldwork/synthesis-wall.jpg", { x: 0.71, y: 0.48, width: 0.23, height: 0.26 }, "Blue design-decision cards."),
      imageEvidence("spec-e6", "wall-photo", "media/fieldwork/synthesis-wall.jpg", { x: 0.35, y: 0.14, width: 0.42, height: 0.58 }, "Red thread linking source claims to decisions."),
      imageEvidence("spec-e7", "wall-photo", "media/fieldwork/synthesis-wall.jpg", { x: 0.08, y: 0.77, width: 0.29, height: 0.14 }, "Parking-lot questions beneath the evidence cluster."),
      imageEvidence("spec-e8", "wall-photo", "media/fieldwork/synthesis-wall.jpg", { x: 0.63, y: 0.8, width: 0.29, height: 0.12 }, "Three next-experiment cards at the bottom right."),
    ],
  },
});

export default SAMPLE_SOURCES;
