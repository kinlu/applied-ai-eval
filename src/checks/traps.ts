/**
 * Traps: deterministic assertions a case plants in its inputs.
 *
 * A good case makes the interesting behaviour available to be got wrong: a
 * number restated on a different basis, a preference stated as a decision, a
 * claim the reference documents contradict. The trap records the mistake and
 * the cheapest test that catches it; its reviewer question covers what a
 * pattern cannot.
 */
import type { Trap, TrapResult } from '../types.js';

function asList(value: string[] | string | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function compile(pattern: string, trapId: string): RegExp {
  try {
    return new RegExp(pattern, 'iu');
  } catch (error) {
    throw new Error(`Trap "${trapId}": invalid regular expression ${JSON.stringify(pattern)} (${error instanceof Error ? error.message : String(error)})`);
  }
}

export function evaluateTrap(trap: Trap, text: string): TrapResult {
  const lower = text.toLowerCase();
  const problems: string[] = [];
  for (const needle of asList(trap.mustInclude)) {
    if (!lower.includes(needle.toLowerCase())) problems.push(`missing "${needle}"`);
  }
  for (const needle of asList(trap.mustNotInclude)) {
    if (lower.includes(needle.toLowerCase())) problems.push(`contains "${needle}"`);
  }
  for (const pattern of asList(trap.mustMatch)) {
    if (!compile(pattern, trap.id).test(text)) problems.push(`no match for /${pattern}/`);
  }
  for (const pattern of asList(trap.mustNotMatch)) {
    const match = text.match(compile(pattern, trap.id));
    if (match) problems.push(`matched /${pattern}/: "${match[0]}"`);
  }
  return {
    id: trap.id,
    description: trap.description,
    pass: problems.length === 0,
    ...(problems.length > 0 ? { detail: problems.join('; ') } : {}),
    ...(trap.gate ? { gate: true } : {}),
  };
}

/** Throws on a trap without an assertion or with a bad pattern, so mistakes surface when cases load. */
export function validateTrap(trap: Trap, caseId: string): void {
  if (!trap.id || !trap.description) throw new Error(`Case "${caseId}": every trap needs an id and a description`);
  const assertions = [trap.mustInclude, trap.mustNotInclude, trap.mustMatch, trap.mustNotMatch].flatMap((value) => asList(value));
  if (assertions.length === 0) throw new Error(`Case "${caseId}", trap "${trap.id}": add mustInclude, mustNotInclude, mustMatch or mustNotMatch`);
  for (const pattern of [...asList(trap.mustMatch), ...asList(trap.mustNotMatch)]) compile(pattern, trap.id);
}
