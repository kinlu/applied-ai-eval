/**
 * Text primitives shared by the deterministic checks. Nothing here calls a
 * model: every check compares the output with the inputs the app was given.
 *
 * Latin-script text is compared on lower-cased word tokens with crude suffix
 * stripping; Chinese, Japanese and Korean runs are compared on overlapping
 * character bigrams, so overlap and coverage also work on CJK output. The
 * thresholds used by the checks were calibrated on English output.
 */

const CJK_CLASS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const CJK_CHAR = new RegExp(`[${CJK_CLASS}]`, 'u');
const TOKEN_PATTERN = new RegExp(`[${CJK_CLASS}]+|(?:(?![${CJK_CLASS}])[\\p{L}\\p{N}/+-])+`, 'gu');
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

export function isCjk(text: string): boolean {
  return CJK_CHAR.test(text);
}

/** Lower-cased word tokens; CJK runs become overlapping bigrams (a lone character stays one token). */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const [run] of text.toLowerCase().matchAll(TOKEN_PATTERN)) {
    if (CJK_CHAR.test(run)) {
      const chars = [...run];
      if (chars.length === 1) tokens.push(run);
      for (let index = 0; index + 1 < chars.length; index += 1) tokens.push(chars[index] + chars[index + 1]);
      continue;
    }
    if (HAS_WORD_CHAR.test(run)) tokens.push(run);
  }
  return tokens;
}

/** English function words, ignored when comparing statements. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'above', 'across', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as',
  'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'could', 'did',
  'do', 'does', 'doing', 'down', 'during', 'each', 'either', 'else', 'even', 'ever', 'every', 'few', 'for', 'from',
  'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'him', 'his', 'how', 'however', 'i', 'if',
  'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'less', 'many', 'may', 'me', 'might', 'more', 'most', 'much',
  'must', 'my', 'neither', 'no', 'nor', 'not', 'of', 'off', 'often', 'on', 'once', 'only', 'onto', 'or', 'other',
  'others', 'our', 'ours', 'out', 'over', 'own', 'per', 'quite', 'rather', 'same', 'several', 'shall', 'she',
  'should', 'since', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'then', 'there',
  'therefore', 'these', 'they', 'this', 'those', 'though', 'through', 'thus', 'to', 'too', 'toward', 'towards',
  'under', 'until', 'up', 'upon', 'us', 'very', 'via', 'was', 'we', 'were', 'what', 'whatever', 'when', 'whenever',
  'where', 'whereas', 'wherever', 'whether', 'which', 'while', 'who', 'whom', 'whose', 'why', 'will', 'with',
  'within', 'without', 'would', 'yet', 'you', 'your', 'yours',
]);

export function tokenizeFiltered(text: string, stopWords: ReadonlySet<string> = STOP_WORDS, minLength = 2): string[] {
  return tokenize(text).filter((token) => [...token].length >= minLength && !stopWords.has(token));
}

/**
 * Crude suffix stripping so "managed" / "manage" / "managing" and "services" /
 * "service" compare as the same content token. Not a real stemmer: it only has
 * to agree with itself on both sides of a comparison.
 */
export function stemToken(token: string): string {
  if (token.length <= 4 || isCjk(token)) return token;
  const stripped = token.replace(/(?:ing|ed|es|s)$/, '');
  return stripped.length > 3 ? stripped.replace(/e$/, '') : stripped;
}

export function contentTokens(text: string, stopWords: ReadonlySet<string> = STOP_WORDS): Set<string> {
  return new Set(tokenizeFiltered(text, stopWords).map(stemToken));
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared;
}

/**
 * Overlap coefficient of two statements' content tokens: the share of the
 * shorter statement's tokens that also appear in the longer one, in [0, 1].
 * A sentence split out of a longer one, or a tense rewrite of it, scores near
 * 1; two facts that merely share a tail phrase score low.
 */
export function statementOverlap(a: string, b: string, stopWords: ReadonlySet<string> = STOP_WORDS): number {
  const tokensA = contentTokens(a, stopWords);
  const tokensB = contentTokens(b, stopWords);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  return sharedCount(tokensA, tokensB) / Math.min(tokensA.size, tokensB.size);
}

/**
 * Directional variant: the share of `statement`'s own content tokens found in
 * `reference`. Asks "how much of this line does that sentence account for?".
 */
export function statementCoverage(statement: string, reference: string, stopWords: ReadonlySet<string> = STOP_WORDS): number {
  const tokens = contentTokens(statement, stopWords);
  if (tokens.size === 0) return 0;
  return sharedCount(tokens, contentTokens(reference, stopWords)) / tokens.size;
}

/**
 * Below this many shared content tokens, a high overlap ratio only means two
 * short lines share a frame ("Prepared accruals for 15 entities" / "Prepared
 * journals for 15 entities"): siblings, not one fact said twice.
 */
const RESTATEMENT_MIN_SHARED_TOKENS = 4;

/**
 * Whether two lines restate each other: overlap at or above `minOverlap`, and
 * either enough shared tokens to carry a fact or one line wholly inside the
 * other. The ratio alone over-fires on short parallel lines.
 */
export function isRestatement(a: string, b: string, minOverlap: number, stopWords: ReadonlySet<string> = STOP_WORDS): boolean {
  const tokensA = contentTokens(a, stopWords);
  const tokensB = contentTokens(b, stopWords);
  if (tokensA.size === 0 || tokensB.size === 0) return false;
  const shared = sharedCount(tokensA, tokensB);
  const overlap = shared / Math.min(tokensA.size, tokensB.size);
  if (overlap < minOverlap) return false;
  return overlap >= 1 || shared >= RESTATEMENT_MIN_SHARED_TOKENS;
}

/** Money, percentages, multipliers and bare counts: the figures a reader takes as fact. */
const NUMERIC_FACT_PATTERN =
  /\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|b|bn|million|billion))?|(?<![a-z0-9$])\d[\d,]*(?:\.\d+)?\s?%|(?<![a-z0-9$])\d[\d,]*(?:\.\d+)?x\b|(?<![a-z0-9$])\d[\d,]*(?:\.\d+)?\+?/gi;

export function extractNumericFacts(text: string): string[] {
  return (text.match(NUMERIC_FACT_PATTERN) ?? []).map((token) => token.trim());
}

/** Reduces a numeric fact to its comparable core: "$1.4M" → "1.4", "1,200" → "1200", "08" → "8". */
export function normalizeNumericToken(token: string): string {
  return token.toLowerCase().replace(/[^0-9.]/g, '').replace(/\.+$/, '').replace(/^0+(?=\d)/, '');
}

export function numericCores(text: string): Set<string> {
  return new Set(extractNumericFacts(text).map(normalizeNumericToken).filter((core) => core.length > 0));
}

/** Splits text into sentences on line breaks and sentence-ending punctuation (including 。！？). */
export function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+|(?<=[。！？；])/u))
    .map((sentence) => sentence.trim())
    .filter((sentence) => HAS_WORD_CHAR.test(sentence));
}
