import {
  ANALYZER_VERSION,
  DATA_PACKAGE_VERSION,
  VIEW_ID,
  VIEW_VERSION,
} from "./constants.js";
import { buildEvidenceStore } from "./evidence.js";
import { loadSources, publicSource, sha256, stableId } from "./sources.js";

const TOKEN_RE = /[\p{L}\p{M}\p{N}]+(?:['’ʼ\-‐‑][\p{L}\p{M}\p{N}]+)*/gu;
const LETTER_RE = /\p{L}/u;
const PHRASE_BOUNDARY_RE = /[.!?:;。！？：；•\-‒–—]/u;
const WORD_BOUNDARY_RE = /^\p{L}[\p{L}\p{M}'-]*$/u;
const MAX_EXCERPT_CHARS = 280;

// Stopwords are retained inside a phrase ("future of work") but may not be its
// first or last token. That boundary-only rule keeps connective language while
// preventing rows such as "the future" and "work and" from winning on volume.
const BOUNDARY_STOPWORDS = new Set(
  `a about above across after again against all almost alone along already also although always am among an and
  another any anybody anyone anything anywhere are aren't around as at be became because become becomes been before
  being below between both but by can can't cannot could couldn't did didn't do does doesn't doing don't done down
  during each either else enough especially even ever every everybody everyone everything everywhere few for from
  further get gets getting got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers
  herself him himself his how how's however i i'd i'll i'm i've if in into is isn't it it's its itself just least
  less let let's like likely may me might mine more most mostly much must mustn't my myself nearly neither no nobody
  none nor not nothing now of off often on once one only or other others our ours ourselves out over own perhaps quite
  rather really said same say says second several shall shan't she she'd she'll she's should shouldn't since so some
  somebody someone something sometimes somewhere still such than that that's the their theirs them themselves then
  there there's therefore these they they'd they'll they're they've this those though through thus to too toward under
  unless until up upon us very was wasn't we we'd we'll we're we've were weren't what what's whatever when when's where
  where's whether which while who who's whoever whom whose why why's will with within without won't would wouldn't you
  you'd you'll you're you've your yours yourself yourselves oh okay ok uh um yeah`.split(/\s+/),
);

const RANKING = Object.freeze([
  { field: "distinctSourceCount", direction: "desc" },
  { field: "occurrenceCount", direction: "desc" },
  { field: "wordCount", direction: "desc" },
  { field: "phrase", direction: "asc", collation: "unicode-code-point" },
]);

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function validatePositiveInteger(name, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function normalizeToken(value) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("ß", "ss")
    .replaceAll("ς", "σ")
    .replace(/[’ʼ]/g, "'")
    .replace(/[‐‑]/g, "-");
}

function replaceSpanWithSpaces(value, start, end) {
  return `${value.slice(0, start)}${" ".repeat(end - start)}${value.slice(end)}`;
}

function stripInlineCode(value) {
  let result = value;
  let cursor = 0;
  while (cursor < result.length) {
    const start = result.indexOf("`", cursor);
    if (start < 0) break;
    let endOfRun = start + 1;
    while (result[endOfRun] === "`") endOfRun += 1;
    const marker = result.slice(start, endOfRun);
    const close = result.indexOf(marker, endOfRun);
    if (close < 0) {
      cursor = endOfRun;
      continue;
    }
    const end = close + marker.length;
    result = replaceSpanWithSpaces(result, start, end);
    cursor = end;
  }
  return result;
}

function stripMarkdownAndUrls(value) {
  let line = stripInlineCode(value);
  line = line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/(?:https?:\/\/|www\.)[^\s<>()]+/giu, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:[a-z][a-z0-9]+|#\d+|#x[a-f0-9]+);/giu, " ")
    .replace(/^ {0,3}(?:#{1,6}\s+|[-+*>]\s+|\d+[.)]\s+)/u, "");
  return line;
}

function tokenize(value) {
  const normalized = normalizeToken(value);
  const tokens = [];
  let previousEnd = 0;
  TOKEN_RE.lastIndex = 0;
  for (const match of normalized.matchAll(TOKEN_RE)) {
    tokens.push({
      value: match[0],
      start: match.index,
      end: match.index + match[0].length,
      column: match.index + 1,
      boundaryBefore:
        tokens.length > 0 &&
        PHRASE_BOUNDARY_RE.test(normalized.slice(previousEnd, match.index)),
    });
    previousEnd = match.index + match[0].length;
  }
  return tokens;
}

function validBoundary(token) {
  return LETTER_RE.test(token) && WORD_BOUNDARY_RE.test(token) && !BOUNDARY_STOPWORDS.has(token);
}

function excerptForLine(value, approximateColumn) {
  const clean = value.replace(/\s+/gu, " ").trim();
  if (clean.length <= MAX_EXCERPT_CHARS) return clean;

  const center = Math.max(0, Math.min(clean.length, approximateColumn - 1));
  let start = Math.max(0, center - Math.floor(MAX_EXCERPT_CHARS * 0.38));
  let end = Math.min(clean.length, start + MAX_EXCERPT_CHARS);
  start = Math.max(0, end - MAX_EXCERPT_CHARS);

  if (start > 0) {
    const nextSpace = clean.indexOf(" ", start);
    if (nextSpace > start && nextSpace < center) start = nextSpace + 1;
  }
  if (end < clean.length) {
    const previousSpace = clean.lastIndexOf(" ", end);
    if (previousSpace > center) end = previousSpace;
  }
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}

function analyzedLines(text) {
  const lines = text.split(/\r\n?|\n/);
  const output = [];
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const original = lines[index];
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(original)?.[1];
    if (fence) {
      if (marker && marker[0] === fence.character && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = { character: marker[0], length: marker.length };
      continue;
    }
    if (/^(?: {4}|\t)/u.test(original)) continue;

    const analyzed = stripMarkdownAndUrls(original);
    if (analyzed.trim()) output.push({ number: index + 1, original, analyzed });
  }
  return output;
}

function rowOrder(left, right) {
  return (
    right.distinctSourceCount - left.distinctSourceCount ||
    right.occurrenceCount - left.occurrenceCount ||
    right.wordCount - left.wordCount ||
    compareText(left.phrase, right.phrase)
  );
}

function occurrenceOrder(sourceOrder) {
  return (left, right) =>
    sourceOrder.get(left.sourceId) - sourceOrder.get(right.sourceId) ||
    left.line - right.line ||
    left.token - right.token;
}

function countSignature(row) {
  return `${row.occurrenceCount}\u0000${row.distinctSourceCount}`;
}

function coordinateKey(sourceId, line, token) {
  return `${sourceId}\u0000${line}\u0000${token}`;
}

function contiguousSubphrases(row, minWords) {
  const words = row.phrase.split(" ");
  const subphrases = [];
  for (let wordCount = minWords; wordCount < words.length; wordCount += 1) {
    for (let offset = 0; offset + wordCount <= words.length; offset += 1) {
      subphrases.push({
        phrase: words.slice(offset, offset + wordCount).join(" "),
        offset,
      });
    }
  }
  return subphrases;
}

function potentialSuppressionPhrases(rankedRows, minWords) {
  const byPhrase = new Map(rankedRows.map((row) => [row.phrase, row]));
  const potential = new Set();
  for (const longer of rankedRows) {
    for (const subphrase of contiguousSubphrases(longer, minWords)) {
      const shorter = byPhrase.get(subphrase.phrase);
      if (!shorter || countSignature(shorter) !== countSignature(longer)) continue;
      potential.add(longer.phrase);
      potential.add(shorter.phrase);
    }
  }
  return potential;
}

function exactShiftedOccurrenceSet(longer, shorter, offset, coordinates) {
  const longerCoordinates = coordinates.get(longer.phrase);
  const shorterCoordinates = coordinates.get(shorter.phrase);
  if (!longerCoordinates || !shorterCoordinates) return false;
  if (longerCoordinates.list.length !== shorterCoordinates.set.size) return false;
  return longerCoordinates.list.every((occurrence) =>
    shorterCoordinates.set.has(
      coordinateKey(occurrence.sourceId, occurrence.line, occurrence.token + offset),
    ),
  );
}

function suppressExactSubphrases(rankedRows, minWords, coordinates) {
  const coverage = new Map();
  const kept = [];

  for (const candidate of rankedRows) {
    const signature = countSignature(candidate);
    const candidates = coverage.get(signature)?.get(candidate.phrase) || [];
    const redundant = candidates.some(({ longer, offset }) =>
      exactShiftedOccurrenceSet(longer, candidate, offset, coordinates),
    );
    if (redundant) continue;

    kept.push(candidate);
    let bySubphrase = coverage.get(signature);
    if (!bySubphrase) {
      bySubphrase = new Map();
      coverage.set(signature, bySubphrase);
    }
    for (const subphrase of contiguousSubphrases(candidate, minWords)) {
      const entries = bySubphrase.get(subphrase.phrase) || [];
      entries.push({ longer: candidate, offset: subphrase.offset });
      bySubphrase.set(subphrase.phrase, entries);
    }
  }
  return kept;
}

function visitPhrases(sources, minWords, maxWords, visit) {
  for (const source of sources) {
    for (const line of analyzedLines(source.text)) {
      const tokens = tokenize(line.analyzed);
      for (let start = 0; start < tokens.length; start += 1) {
        for (let wordCount = minWords; wordCount <= maxWords; wordCount += 1) {
          const end = start + wordCount;
          if (end > tokens.length) break;
          const crossesBoundary = tokens
            .slice(start + 1, end)
            .some((token) => token.boundaryBefore);
          if (crossesBoundary) continue;
          const first = tokens[start].value;
          const last = tokens[end - 1].value;
          if (!validBoundary(first) || !validBoundary(last)) continue;
          const values = tokens.slice(start, end).map((token) => token.value);
          if (new Set(values).size === 1) continue;
          visit({
            source,
            line,
            start,
            wordCount,
            phrase: values.join(" "),
            column: tokens[start].column,
          });
        }
      }
    }
  }
}

function fixedTransformations() {
  return [
    {
      id: "unicode-normalization",
      description: "Text is normalized with Unicode NFKC and casefold-like lowercasing.",
    },
    {
      id: "markdown-cleaning",
      description: "Fenced, indented, and inline Markdown code, URLs, HTML tags, and link destinations are excluded.",
    },
    {
      id: "unicode-tokenization",
      description: "Phrases are contiguous Unicode letter/mark/number tokens and never cross sentence-like punctuation or a line boundary.",
    },
    {
      id: "stopword-boundaries",
      description: "English stopwords may occur inside a phrase but not at its first or last token.",
    },
    {
      id: "lexical-boundaries",
      description: "Phrase boundaries must be alphabetic words; single-token repetitions such as filler speech are excluded.",
    },
    {
      id: "deterministic-ranking",
      description: "Rows rank by distinct-source breadth, occurrences, word count, then Unicode code-point phrase order.",
    },
    {
      id: "exact-subphrase-suppression",
      description: "A shorter row is suppressed only when an already-kept longer phrase contains it and their exact source, line, and shifted token occurrence sets match.",
    },
  ];
}

function fixedOmissions() {
  return [
    {
      id: "supported-text-only",
      reason: "Only .md, .mdx, .txt, and JSONL text records are analyzed.",
    },
    {
      id: "lexical-not-semantic",
      reason: "Paraphrases, synonyms, and semantically similar phrases are not merged.",
    },
    {
      id: "no-cross-boundary-phrases",
      reason: "A phrase split across sentence-like punctuation, lines, or sources is intentionally not counted.",
    },
    {
      id: "english-boundary-stopwords",
      reason: "Boundary stopwords are English; other languages receive Unicode normalization but no language-specific stopword list.",
    },
  ];
}

/**
 * Build a deterministic, locally derived phrase-list DataPackage.
 *
 * The returned object contains no absolute paths, source text, timestamps,
 * model output, or network-derived fields. Every count can be inspected through
 * its complete occurrence list and stable source hashes.
 */
async function analyzePhraseCorpus({
  root = process.cwd(),
  inputPaths,
  question,
  target = "",
  minWords = 2,
  maxWords = 4,
  minCount = 2,
  minSources = 2,
  limit = 60,
  maxFileBytes = 2_000_000,
}, { includeEvidenceStore = false } = {}) {
  if (typeof question !== "string" || !question.trim()) {
    throw new Error("question must be a non-empty string");
  }
  if (typeof target !== "string") throw new Error("target must be a string");
  validatePositiveInteger("minWords", minWords);
  validatePositiveInteger("maxWords", maxWords);
  validatePositiveInteger("minCount", minCount);
  validatePositiveInteger("minSources", minSources);
  validatePositiveInteger("limit", limit);
  validatePositiveInteger("maxFileBytes", maxFileBytes);
  if (maxWords < minWords) throw new Error("maxWords must be greater than or equal to minWords");

  const loaded = await loadSources({ root, inputPaths, maxFileBytes });
  if (loaded.sources.length === 0) {
    const skipped = loaded.omissions.filter((omission) => omission.skipped === true);
    const sample = skipped[0];
    const error = new Error(
      `No readable supported sources were found in the requested scope${
        sample ? `; ${sample.path}: ${sample.reason}` : ""
      }.`,
    );
    error.code = "NO_SOURCES";
    error.omissions = skipped;
    throw error;
  }
  const sources = loaded.sources.map(publicSource);
  const sourceOrder = new Map(sources.map((source, index) => [source.id, index]));
  const phrases = new Map();

  // Count first, retaining only one last-seen source id per phrase. Sources are
  // processed contiguously, so this yields exact distinct-source counts without
  // a Set—and avoids retaining millions of occurrence objects for rows that do
  // not survive the count, source-breadth, and limit thresholds.
  visitPhrases(loaded.sources, minWords, maxWords, ({ source, phrase, wordCount }) => {
    let entry = phrases.get(phrase);
    if (!entry) {
      entry = {
        phrase,
        wordCount,
        occurrenceCount: 0,
        distinctSourceCount: 0,
        lastSourceId: null,
      };
      phrases.set(phrase, entry);
    }
    entry.occurrenceCount += 1;
    if (entry.lastSourceId !== source.id) {
      entry.distinctSourceCount += 1;
      entry.lastSourceId = source.id;
    }
  });

  const rankedRows = [...phrases.values()]
    .filter(
      (entry) =>
        entry.occurrenceCount >= minCount &&
        entry.distinctSourceCount >= minSources,
    )
    .map((entry) => ({
      id: stableId("phrase", entry.phrase),
      phrase: entry.phrase,
      wordCount: entry.wordCount,
      occurrenceCount: entry.occurrenceCount,
      distinctSourceCount: entry.distinctSourceCount,
      occurrences: [],
    }))
    .sort(rowOrder);

  const potential = potentialSuppressionPhrases(rankedRows, minWords);
  const coordinates = new Map(
    [...potential].map((phrase) => [phrase, { list: [], set: new Set() }]),
  );
  if (coordinates.size) {
    visitPhrases(
      loaded.sources,
      minWords,
      maxWords,
      ({ source, line, start, phrase }) => {
        const found = coordinates.get(phrase);
        if (!found) return;
        const occurrence = { sourceId: source.id, line: line.number, token: start + 1 };
        found.list.push(occurrence);
        found.set.add(coordinateKey(occurrence.sourceId, occurrence.line, occurrence.token));
      },
    );
  }
  const rows = suppressExactSubphrases(rankedRows, minWords, coordinates).slice(0, limit);

  const selectedRows = new Map(rows.map((row) => [row.phrase, row]));
  visitPhrases(
    loaded.sources,
    minWords,
    maxWords,
    ({ source, line, start, phrase, column }) => {
      const row = selectedRows.get(phrase);
      if (!row) return;
      row.occurrences.push({
        sourceId: source.id,
        line: line.number,
        token: start + 1,
        excerpt: excerptForLine(line.original, column),
      });
    },
  );
  for (const row of rows) row.occurrences.sort(occurrenceOrder(sourceOrder));

  const questionSpec = {
    text: question.trim(),
    target: target.trim(),
    analysis: "phrase-recurrence",
  };
  const config = {
    analyzerVersion: ANALYZER_VERSION,
    minWords,
    maxWords,
    minCount,
    minSources,
    limit,
    maxFileBytes,
    ranking: RANKING.map((rule) => ({ ...rule })),
  };
  const map = {
    id: VIEW_ID,
    version: VIEW_VERSION,
    kind: "list",
    rowIdField: "id",
    labelField: "phrase",
    valueField: "occurrenceCount",
    secondaryValueField: "distinctSourceCount",
    evidenceField: "occurrences",
  };
  const transformations = fixedTransformations();
  const knownOmissions = [...fixedOmissions(), ...loaded.omissions];
  const corpusHash = sha256(canonicalJson(sources));
  const configHash = sha256(canonicalJson({ question: questionSpec, config }));

  const hashable = {
    schemaVersion: DATA_PACKAGE_VERSION,
    kind: "attend-data-package",
    question: questionSpec,
    hashes: { corpus: corpusHash, config: configHash },
    config,
    sources,
    rows,
    map,
    transformations,
    knownOmissions,
    execution: { modelCalls: 0, networkCalls: 0 },
  };
  const dataHash = sha256(canonicalJson(hashable));

  const dataPackage = {
    ...hashable,
    id: `data_${dataHash.slice(0, 16)}`,
    hashes: { corpus: corpusHash, config: configHash, data: dataHash },
  };
  if (!includeEvidenceStore) return dataPackage;
  return {
    dataPackage,
    evidenceStore: buildEvidenceStore({
      dataPackage,
      sources: loaded.sources,
    }),
  };
}

export async function analyzePhrases(options) {
  return analyzePhraseCorpus(options);
}

/**
 * Analyze and retain the exact, private source snapshot in one filesystem
 * read. The DataPackage remains text-free; callers persist the companion store
 * under `.attend/local/evidence` and never expose it through viewer routes.
 */
export async function analyzePhrasesWithEvidence(options) {
  return analyzePhraseCorpus(options, { includeEvidenceStore: true });
}
