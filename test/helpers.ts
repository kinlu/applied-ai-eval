import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { emptySummary } from '../src/telemetry.js';
import type { CaseRun, LoadedCase, Measurement, RunReport } from '../src/types.js';

export function tempDir(prefix = 'aieval-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Writes `files` (relative path → content) under `root`. */
export function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

export function loadedCase(overrides: Partial<LoadedCase> = {}): LoadedCase {
  return {
    id: 'case-a',
    dir: '/tmp/case-a',
    set: 'cases',
    inputs: { kb: 'Refunds are available within 30 days of purchase.', message: 'Can I get a refund after 45 days?' },
    inputHash: 'hash-a',
    ...overrides,
  };
}

export function count(key: string, value: number, extra: Partial<Measurement> = {}): Measurement {
  return { key, label: key, value, unit: 'count', better: 'lower', aggregate: 'sum', ...extra };
}

export function caseRun(overrides: Partial<CaseRun> = {}): CaseRun {
  return {
    caseId: 'case-a',
    variant: 'baseline',
    sample: 1,
    inputHash: 'hash-a',
    status: 'ok',
    durationMs: 1000,
    gates: { completed: { pass: true } },
    traps: [],
    measurements: [],
    llm: { ...emptySummary(), calls: 1, promptTokens: 100, completionTokens: 20, totalMs: 900 },
    llmByAgent: {},
    artifact: `${overrides.caseId ?? 'case-a'}/${overrides.variant ?? 'baseline'}-s${overrides.sample ?? 1}`,
    ...overrides,
  };
}

export function runReport(runs: CaseRun[], overrides: Partial<RunReport> = {}): RunReport {
  const variants = [...new Set(runs.map((run) => run.variant))].map((name) => ({ name, options: {} }));
  return {
    tool: { name: 'applied-ai-eval', version: '0.0.0-test' },
    startedIso: '2026-10-01T00:00:00.000Z',
    finishedIso: '2026-10-01T00:01:00.000Z',
    caseSet: 'cases',
    variants,
    samples: Math.max(...runs.map((run) => run.sample)),
    checks: ['numeric-traceability'],
    artifactsDir: 'artifacts',
    runs,
    ...overrides,
  };
}
