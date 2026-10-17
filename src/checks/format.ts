/**
 * Format checks: narrow, cheap tests for the failure modes that make an
 * output unusable regardless of its content: it silently switched language,
 * it leaked the model's own reasoning into user-visible text, or it came back
 * as a JSON object where prose was expected. They cannot say which output is
 * better; they only rule out the obviously broken ones.
 */

/**
 * Phrases that open a model's thinking rather than an answer. Kept short on
 * purpose: "Let me know if…" is ordinary in a reply, "Let me think" is not.
 * Extend it with the leaks your own app has actually shown.
 */
export const DEFAULT_REASONING_MARKERS: readonly string[] = [
  '<think', '</think>', '<reasoning', 'As an AI', 'As a language model', 'I need to', 'Let me think',
  'Let me analyze', 'Let me analyse', "Let's think step by step", 'The user wants', 'The user is asking',
  'According to the instructions', 'My instructions',
  '让我想想', '让我先', '我需要先', '首先我', '接下来我将', '用户要求', '根据用户的要求', '我会按照', '根据以上分析，我',
];

/** The markers present in `text` (case-insensitive), in list order. */
export function reasoningLeaks(text: string, markers: readonly string[] = DEFAULT_REASONING_MARKERS): string[] {
  const lower = text.toLowerCase();
  return markers.filter((marker) => lower.includes(marker.toLowerCase()));
}

/** Whether prose output came back shaped as JSON (an object, an array, or a fenced json block). */
export function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (/^```json/i.test(trimmed)) return true;
  if (!/^[[{]/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return /^\{\s*"/.test(trimmed);
  }
}

/** Friendly script names → Unicode script property values. */
export const SCRIPTS: Readonly<Record<string, readonly string[]>> = {
  latin: ['Latin'],
  han: ['Han'],
  chinese: ['Han'],
  japanese: ['Han', 'Hiragana', 'Katakana'],
  kana: ['Hiragana', 'Katakana'],
  korean: ['Hangul'],
  hangul: ['Hangul'],
  cyrillic: ['Cyrillic'],
  greek: ['Greek'],
  arabic: ['Arabic'],
  hebrew: ['Hebrew'],
  devanagari: ['Devanagari'],
  thai: ['Thai'],
};

function scriptPattern(script: string): RegExp {
  const names = SCRIPTS[script.toLowerCase()];
  if (!names) throw new Error(`Unknown script "${script}". Known: ${Object.keys(SCRIPTS).join(', ')}`);
  return new RegExp(`[${names.map((name) => `\\p{Script=${name}}`).join('')}]`, 'u');
}

/** Share of the letters in `text` written in `script`; null when the text has no letters. */
export function scriptRatio(text: string, script: string): number | null {
  const pattern = scriptPattern(script);
  let letters = 0;
  let matching = 0;
  for (const char of text) {
    if (!/\p{L}/u.test(char)) continue;
    letters += 1;
    if (pattern.test(char)) matching += 1;
  }
  return letters === 0 ? null : matching / letters;
}

/**
 * Runs of `minWords` or more consecutive ASCII words: in output that should be
 * in a non-Latin script, a sentence that slipped into English. Model ids and
 * file names are shorter than six words.
 */
export function foreignRuns(text: string, minWords = 6): number {
  let count = 0;
  let run = 0;
  for (const word of text.split(/\s+/)) {
    const ascii = word.length > 0 && [...word].every((char) => char.charCodeAt(0) < 128) && /[a-z]/i.test(word);
    run = ascii ? run + 1 : 0;
    if (run === minWords) count += 1;
  }
  return count;
}

/** Visible length in characters (code points) or whitespace-separated words. */
export function textLength(text: string, unit: 'chars' | 'words' = 'chars'): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return unit === 'words' ? trimmed.split(/\s+/).length : [...trimmed].length;
}
