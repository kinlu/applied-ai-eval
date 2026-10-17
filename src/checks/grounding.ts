/**
 * Grounding checks: does the output say only what its inputs support, and
 * does it keep what it restates as precise as the source said it?
 *
 * Each function takes plain strings so it can be tested and reused outside
 * the runner. Thresholds were calibrated on real model output against known
 * ground truth; the reasoning is kept next to each constant.
 */
import { examplesOf } from '../util.js';
import {
  extractNumericFacts,
  isRestatement,
  normalizeNumericToken,
  numericCores,
  splitSentences,
  statementCoverage,
  statementOverlap,
  tokenize,
  stemToken,
} from './text.js';
import { supportVocabulary, unsupportedWords } from './vocabulary.js';

export interface CountResult {
  count: number;
  examples: string[];
}

/* -------------------------------------------------- numeric traceability */

export interface NumericTraceabilityResult {
  /** Distinct numeric facts in the output. */
  total: number;
  untraceable: string[];
  /** Share of numeric facts whose value appears in a source (1 when there are none). */
  rate: number;
}

/**
 * Numbers the output states that no source states. A model that invents a
 * figure ("cut costs by 40%", "within 2 hours") is wrong in the way readers
 * trust most, so every number has to trace back to an input.
 */
export function numericTraceability(text: string, sourceTexts: readonly string[], allow: readonly string[] = []): NumericTraceabilityResult {
  const known = new Set([...sourceTexts.flatMap(extractNumericFacts), ...allow].map(normalizeNumericToken));
  const seen = new Set<string>();
  const untraceable: string[] = [];
  for (const token of extractNumericFacts(text)) {
    const core = normalizeNumericToken(token);
    if (core.length === 0 || seen.has(core)) continue;
    seen.add(core);
    if (!known.has(core)) untraceable.push(token);
  }
  const total = seen.size;
  return { total, untraceable, rate: total === 0 ? 1 : (total - untraceable.length) / total };
}

/* ---------------------------------------------------- unsupported lines */

/** Lines using a content word that none of the sources uses (see vocabulary.ts). */
export function unsupportedLines(lines: readonly string[], sourceTexts: readonly string[], allowWords: readonly string[] = []): CountResult {
  const vocabulary = supportVocabulary([...sourceTexts, ...allowWords]);
  const flagged: string[] = [];
  for (const line of lines) {
    const words = unsupportedWords(line, vocabulary);
    if (words.length > 0) flagged.push(`${line} [${words.join(', ')}]`);
  }
  return { count: flagged.length, examples: examplesOf(flagged) };
}

/* ------------------------------------------------------- near duplicates */

/**
 * Content overlap at or above which two lines count as the same line twice.
 * Matched the generation guard's own threshold in the app it came from, so the
 * metric reported exactly what the guard was meant to prevent.
 */
export const NEAR_DUPLICATE_MIN_OVERLAP = 0.6;

/**
 * Line pairs within one group that restate each other. Pairs are only counted
 * within a group: the same fact can legitimately appear in two sections.
 */
export function nearDuplicatePairs(groups: readonly (readonly string[])[], minOverlap = NEAR_DUPLICATE_MIN_OVERLAP): CountResult {
  const pairs: string[] = [];
  for (const lines of groups) {
    for (let i = 0; i < lines.length; i += 1) {
      for (let j = i + 1; j < lines.length; j += 1) {
        if (isRestatement(lines[i], lines[j], minOverlap)) pairs.push(`${lines[i]} ⇄ ${lines[j]}`);
      }
    }
  }
  return { count: pairs.length, examples: examplesOf(pairs) };
}

/* ------------------------------------------------------------ input echo */

/** A line this well covered by one statement of the echoed input… */
export const ECHO_MIN_COVERAGE = 0.7;
/** …and this poorly covered by every source sentence, was written from the request, not the facts. */
export const ECHO_MAX_SOURCE_COVERAGE = 0.5;

/**
 * Lines that parrot an input the output should answer rather than repeat (a
 * job ad, the user's question): one of its statements accounts for most of
 * the line while no source sentence does. A line that borrows the request's
 * wording for a fact the sources state is not flagged.
 */
export function inputEcho(
  lines: readonly string[],
  echoTexts: readonly string[],
  sourceTexts: readonly string[],
  options: { minCoverage?: number; maxSourceCoverage?: number } = {},
): CountResult {
  const minCoverage = options.minCoverage ?? ECHO_MIN_COVERAGE;
  const maxSource = options.maxSourceCoverage ?? ECHO_MAX_SOURCE_COVERAGE;
  const statements = echoTexts.flatMap(splitSentences);
  const sentences = sourceTexts.flatMap(splitSentences);
  const best = (line: string, references: string[]): number =>
    references.reduce((top, reference) => Math.max(top, statementCoverage(line, reference)), 0);
  const flagged = lines.filter((line) => best(line, statements) >= minCoverage && best(line, sentences) < maxSource);
  return { count: flagged.length, examples: examplesOf(flagged) };
}

/* -------------------------------------------------------- carry coverage */

/**
 * A fact this well covered by one output line counts as carried. Calibrated on
 * 27 runs where ground truth was known (pre- vs post-trim output, where trimming
 * only deletes): every surviving line scored 1.00 and deleted lines at most 0.67
 * (p95 0.38), so the threshold sits in an empty band and is insensitive between
 * 0.4 and 0.7.
 */
export const CARRY_MIN_COVERAGE = 0.5;

export interface CoverageResult {
  total: number;
  missing: string[];
  rate: number;
}

/** Share of the facts a case says must survive that some output line still carries. */
export function carryCoverage(facts: readonly string[], lines: readonly string[], min = CARRY_MIN_COVERAGE): CoverageResult {
  const items = facts.filter((fact) => fact.trim().length > 0);
  const missing = items.filter((fact) => lines.reduce((top, line) => Math.max(top, statementCoverage(fact, line)), 0) < min);
  return { total: items.length, missing, rate: items.length === 0 ? 1 : (items.length - missing.length) / items.length };
}

/* ------------------------------------------------------ keyword coverage */

/** Share of expected terms the output contains; every word of a multi-word term must appear. */
export function keywordCoverage(text: string, keywords: readonly string[]): CoverageResult {
  const stems = new Set(tokenize(text).map(stemToken));
  const lower = text.toLowerCase();
  const terms = keywords.filter((term) => term.trim().length > 0);
  const missing = terms.filter((term) => {
    const tokens = tokenize(term).map(stemToken);
    if (tokens.length === 0) return !lower.includes(term.toLowerCase());
    return !tokens.every((token) => stems.has(token)) && !lower.includes(term.toLowerCase());
  });
  return { total: terms.length, missing, rate: terms.length === 0 ? 1 : (terms.length - missing.length) / terms.length };
}

/* ---------------------------------------------------------- misspellings */

/**
 * Shortest token/source pair a one-edit difference is read as a misspelling
 * rather than an irregular form ("drove" / "drive", "led" / "lead"). On 27
 * calibration runs this flagged 3 tokens, all genuine misspellings, and no
 * false positives; at 5 the "drive" / "drove" pairs came back.
 */
export const MISSPELLING_MIN_LENGTH = 6;
/** Longest token treated as a fragment of a word split by a stray space ("U KG"). */
const SPLIT_WORD_MAX_LENGTH = 2;
const LATIN_WORD = /^[\p{Script=Latin}][\p{Script=Latin}\p{N}/+-]*$/u;

/**
 * Whether `a` and `b` differ by one insertion, deletion, substitution, or a
 * swap of two adjacent letters ("Kuberentes" for "Kubernetes").
 */
export function isOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || a === b) return false;
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  if (a.length - head - tail <= 1 && b.length - head - tail <= 1) return true;
  return a.length === b.length && a.length - head - tail === 2 && a[head] === b[head + 1] && a[head + 1] === b[head];
}

/** Whether the single edit falls in the last two characters, where inflection lives. */
function editIsInTail(a: string, b: string): boolean {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  return head >= Math.max(a.length, b.length) - 2;
}

/**
 * Words the model mistyped: absent from every input, yet one edit away from
 * an input word. Rewording is the app's job, so a word merely absent from the
 * inputs is not a defect; a near-miss of one is. Also reports input words
 * split by a stray space ("U KG" for "UKG"). Latin-script words only.
 */
export function misspellings(text: string, vocabularyTexts: readonly string[]): CountResult {
  const vocabulary = new Set(vocabularyTexts.flatMap(tokenize));
  const stems = new Set([...vocabulary].map(stemToken));
  const seen = new Set<string>();
  const splitFlagged = new Set<string>();
  const flagged: string[] = [];

  for (const line of text.split(/\n+/)) {
    const tokens = tokenize(line);
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!LATIN_WORD.test(token) || seen.has(token) || vocabulary.has(token) || stems.has(stemToken(token))) continue;
      seen.add(token);

      if (token.length <= SPLIT_WORD_MAX_LENGTH) {
        const next = tokens[index + 1];
        const previous = tokens[index - 1];
        if (next !== undefined && vocabulary.has(`${token}${next}`)) {
          flagged.push(`${token} ${next} (source: ${token}${next})`);
          splitFlagged.add(`${token}${next}`);
          seen.add(next);
        } else if (previous !== undefined && vocabulary.has(`${previous}${token}`) && !splitFlagged.has(`${previous}${token}`)) {
          flagged.push(`${previous} ${token} (source: ${previous}${token})`);
          splitFlagged.add(`${previous}${token}`);
        }
        continue;
      }
      if (/^\d+$/.test(token)) continue;

      const source = [...vocabulary].find((candidate) => Math.min(token.length, candidate.length) >= MISSPELLING_MIN_LENGTH
        && isOneEdit(token, candidate)
        && !editIsInTail(token, candidate));
      if (source) flagged.push(`${token} (source: ${source})`);
    }
  }
  return { count: flagged.length, examples: examplesOf(flagged) };
}

/* -------------------------------------------------------- baseline drops */

/** A line this close to a source sentence restates that sentence's fact. */
const SAME_FACT_MIN_OVERLAP = 0.5;
/** "from 10 business days to 6", "from 480ms to 95ms", "from 99.9% to 99.97%". */
const IMPROVEMENT_PAIR = /\bfrom\s+(\$?\d[\d.,]*\s?(?:%|ms|s|k|m|bn)?)(?:\s+[a-z][a-z-]*){0,3}\s+to\s+(\$?\d[\d.,]*\s?(?:%|ms|s|k|m|bn)?)/gi;
const YEAR = /^(?:19|20)\d\d$/;

export interface BaselineDropResult extends CountResult {
  /** Before→after improvements found in the sources. */
  pairs: number;
}

/**
 * Improvements whose starting point was dropped: a line restates a source
 * "from X to Y" fact and keeps Y but not X, so a measured change reads as a
 * plain state ("turnaround is 6 days" for "from 10 days to 6"). Every number
 * stays traceable, which is why numeric traceability misses it. English only.
 */
export function baselineDrops(lines: readonly string[], sourceTexts: readonly string[]): BaselineDropResult {
  const improvements: Array<{ sentence: string; before: string; after: string }> = [];
  for (const sentence of sourceTexts.flatMap(splitSentences)) {
    for (const match of sentence.matchAll(IMPROVEMENT_PAIR)) {
      const before = normalizeNumericToken(match[1] ?? '');
      const after = normalizeNumericToken(match[2] ?? '');
      if (!before || !after || before === after) continue;
      if (YEAR.test(before) && YEAR.test(after)) continue; // a date range, not an improvement
      improvements.push({ sentence, before, after });
    }
  }
  const flagged = lines.filter((line) => {
    const cores = numericCores(line);
    return improvements.some((improvement) => cores.has(improvement.after)
      && !cores.has(improvement.before)
      && statementOverlap(line, improvement.sentence) >= SAME_FACT_MIN_OVERLAP);
  });
  return { pairs: improvements.length, count: flagged.length, examples: examplesOf(flagged) };
}

/* ------------------------------------------------------- qualifier drops */

const NUMBER_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', twelve: '12',
};

function withDigits(text: string): string {
  return text.toLowerCase().replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b/g, (word) => NUMBER_WORDS[word] ?? word);
}

/** Time windows a result is limited to: "in the last two years", "over the past 3 months". */
const TIME_WINDOW = /\b(?:in|over|during|within)\s+the\s+(last|past|previous)\s+(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+)?(year|month|quarter|week|day)s?\b/gi;
const SINCE_YEAR = /\bsince\s+((?:19|20)\d\d)\b/gi;
/** Approximate or bounded figures. "over" is left out: it is mostly a duration ("over 14 months"). */
const APPROXIMATE_FIGURE = /\b(about|around|approximately|roughly|nearly|almost|up to|more than|at least|on average)\s+(\$?\d[\d.,]*)/gi;
const APPROXIMATORS = /\b(?:about|around|approximately|roughly|nearly|almost|up to|more than|over|at least|on average|average of|~)\s*$/i;
/** A bound kept as a range: "between $5M and $30M", "from 10 to 60", "$5M–$30M". */
const RANGE_BEFORE_FIGURE = /(?:\b(?:between|from)\s+\$?[\d.,]+\s*[a-z%]{0,8}\s*(?:and|to|-|–)|\$?\d[\d.,]*\s*[a-z%]{0,8}\s*[-–])\s*\$?$/i;
/** Words before a qualifier that name the fact it qualifies. */
const ANCHOR_WORDS = 6;

function anchorBefore(sentence: string, index: number): string {
  return sentence.slice(0, index).split(/\s+/).filter(Boolean).slice(-ANCHOR_WORDS).join(' ');
}

/** The line restates this sentence and names the fact right before the qualifier. */
function usesQualifiedFact(line: string, sentence: string, qualifierIndex: number): boolean {
  return statementOverlap(line, sentence) >= SAME_FACT_MIN_OVERLAP
    && statementCoverage(anchorBefore(sentence, qualifierIndex), line) >= SAME_FACT_MIN_OVERLAP;
}

/** Where `figure` (a normalized numeric core) appears in `text`, matching "140,000" to "140000". */
function figureIndex(text: string, figure: string): number {
  for (const match of text.matchAll(/\$?\d[\d,]*(?:\.\d+)?/g)) {
    if (normalizeNumericToken(match[0]) === figure) return match.index ?? -1;
  }
  return -1;
}

/**
 * Qualifiers dropped from a source fact: the line states the fact a qualifier
 * limits without the qualifier, so "zero adjustments in the last two years"
 * becomes "zero adjustments" and "around 60 clients" becomes "60 clients".
 * English only.
 */
export function qualifierDrops(lines: readonly string[], sourceTexts: readonly string[]): CountResult {
  const sentences = sourceTexts.flatMap(splitSentences);
  const flagged: string[] = [];
  for (const line of lines) {
    const lineDigits = withDigits(line);
    const cores = numericCores(line);
    let dropped: string | null = null;
    for (const sentence of sentences) {
      for (const match of sentence.matchAll(TIME_WINDOW)) {
        if (!usesQualifiedFact(line, sentence, match.index ?? 0)) continue;
        const amount = match[2] ? `${NUMBER_WORDS[match[2].toLowerCase()] ?? match[2]}\\s+` : '';
        const kept = new RegExp(`\\b(?:last|past|previous)\\s+${amount}${match[3]}s?\\b`, 'i').test(lineDigits);
        if (!kept) dropped = match[0];
      }
      for (const match of sentence.matchAll(SINCE_YEAR)) {
        if (!usesQualifiedFact(line, sentence, match.index ?? 0)) continue;
        if (!new RegExp(`\\bsince\\s+${match[1]}\\b`, 'i').test(line)) dropped = match[0];
      }
      for (const match of sentence.matchAll(APPROXIMATE_FIGURE)) {
        const figure = normalizeNumericToken(match[2] ?? '');
        if (!figure || !cores.has(figure)) continue;
        if (statementOverlap(line, sentence) < SAME_FACT_MIN_OVERLAP) continue;
        const at = figureIndex(line, figure);
        const before = line.slice(0, Math.max(0, at));
        const kept = at >= 0 && (APPROXIMATORS.test(`${before.trimEnd()} `) || RANGE_BEFORE_FIGURE.test(before));
        if (!kept) dropped = match[0];
      }
    }
    if (dropped) flagged.push(`${line} (source: "${dropped}")`);
  }
  return { count: flagged.length, examples: examplesOf(flagged) };
}
