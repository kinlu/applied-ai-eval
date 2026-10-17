/**
 * The hold-out ledger. Tune only against `eval/cases/`; run `eval/holdout/`
 * once at the end of a change for acceptance. Reading a hold-out output to
 * diagnose a problem makes that case no longer blind, so it is recorded in
 * the case's `seen` list, and fresh hold-out cases should be added before the
 * next acceptance run. Never change code to fix one hold-out output: fix the
 * problem against the tuning cases.
 */
import { existsSync } from 'node:fs';
import { loadCases, markSeen } from './cases.js';
import type { LoadedConfig } from './config.js';
import type { HoldoutSeenEntry } from './types.js';

export interface HoldoutStatus {
  total: number;
  blind: string[];
  seen: Array<{ caseId: string; entries: HoldoutSeenEntry[] }>;
  /** Hold-out cases that share an id or identical inputs with a tuning case. */
  leaks: Array<{ holdout: string; caseId: string; reason: 'same id' | 'same inputs' }>;
}

export function holdoutStatus(loaded: LoadedConfig): HoldoutStatus {
  const holdout = loadCases(loaded.holdoutDir, 'holdout');
  const tuning = existsSync(loaded.casesDir) ? loadCases(loaded.casesDir, 'cases') : [];
  const leaks: HoldoutStatus['leaks'] = [];
  for (const entry of holdout) {
    for (const tuned of tuning) {
      if (tuned.id === entry.id) leaks.push({ holdout: entry.id, caseId: tuned.id, reason: 'same id' });
      else if (tuned.inputHash === entry.inputHash) leaks.push({ holdout: entry.id, caseId: tuned.id, reason: 'same inputs' });
    }
  }
  return {
    total: holdout.length,
    blind: holdout.filter((entry) => !entry.seen?.length).map((entry) => entry.id),
    seen: holdout.filter((entry) => entry.seen?.length).map((entry) => ({ caseId: entry.id, entries: entry.seen! })),
    leaks,
  };
}

export function formatHoldoutStatus(status: HoldoutStatus): string {
  const lines = [`Hold-out cases: ${status.total} (${status.blind.length} blind, ${status.seen.length} seen)`];
  if (status.blind.length > 0) lines.push(`  blind: ${status.blind.join(', ')}`);
  for (const entry of status.seen) {
    lines.push(`  seen: ${entry.caseId} — ${entry.entries.map((seen) => `${seen.date}: ${seen.note}`).join('; ')}`);
  }
  for (const leak of status.leaks) {
    lines.push(`  LEAK: hold-out ${leak.holdout} has the ${leak.reason} as tuning case ${leak.caseId}`);
  }
  if (status.total > 0 && status.blind.length < Math.ceil(status.total / 2)) {
    lines.push('  Fewer than half the hold-out cases are blind: add fresh cases before the next acceptance run.');
  }
  return lines.join('\n');
}

export function markHoldoutSeen(loaded: LoadedConfig, caseId: string, note: string): HoldoutSeenEntry {
  if (!note.trim()) throw new Error('Say why the outputs were read: --note "..."');
  const cases = loadCases(loaded.holdoutDir, 'holdout');
  const loadedCase = cases.find((entry) => entry.id === caseId);
  if (!loadedCase) throw new Error(`No hold-out case "${caseId}". Hold-out cases: ${cases.map((entry) => entry.id).join(', ')}`);
  return markSeen(loadedCase.dir, note.trim());
}
