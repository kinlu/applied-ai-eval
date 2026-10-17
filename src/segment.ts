/**
 * Turning an app's result into the text and lines the checks read.
 */
import type { AppResult } from './types.js';
import { collectStrings } from './util.js';

const HEADING = /^#{1,6}\s/;
const TABLE_RULE = /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const FENCE = /^```/;
const LIST_MARKER = /^(?:[-*•·+]|\d{1,3}[.)、]|[a-z][.)]|\(\d{1,3}\))\s+/i;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Default segmentation: one entry per sentence of each line, with list
 * markers, emphasis and table pipes removed. Markdown headings, rules and
 * code fences are skipped: they frame the content rather than state it.
 */
export function segmentText(text: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || line.length === 0 || HEADING.test(line) || TABLE_RULE.test(line) || RULE.test(line)) continue;
    const cleaned = line
      .replace(/^>\s*/, '')
      .replace(LIST_MARKER, '')
      .replace(/\*\*|__|`/g, '')
      .replace(/^\||\|$/g, '')
      .replace(/\s*\|\s*/g, ' · ')
      .trim();
    for (const sentence of cleaned.split(/(?<=[.!?])\s+(?=\S)|(?<=[。！？；])/u)) {
      const trimmed = sentence.trim();
      if (HAS_WORD_CHAR.test(trimmed)) lines.push(trimmed);
    }
  }
  return lines;
}

/** Accepts whatever the app returned: a full AppResult, a bare string, or any other value as the output. */
export function normalizeResult(raw: unknown): AppResult {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'output' in raw) return raw as AppResult;
  return { output: raw };
}

/** The text checks read: `text`, else a string output, else every string in the output. */
export function resultText(result: AppResult): string {
  if (typeof result.text === 'string') return result.text;
  if (typeof result.output === 'string') return result.output;
  return collectStrings(result.output).join('\n');
}

/** Line groups for the line-level checks; one group unless the app returned named groups. */
export function resultGroups(result: AppResult, text: string, segment: (text: string) => string[] = segmentText): string[][] {
  if (Array.isArray(result.lines)) return [result.lines.filter((line) => typeof line === 'string')];
  if (result.lines && typeof result.lines === 'object') {
    return Object.values(result.lines).map((group) => (Array.isArray(group) ? group.filter((line) => typeof line === 'string') : []));
  }
  return [segment(text)];
}
