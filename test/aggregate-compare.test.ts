import { describe, expect, it } from 'vitest';
import { aggregateVariant } from '../src/aggregate.js';
import { compareRuns, verdictFor, type Selected } from '../src/compare.js';
import type { RunReport } from '../src/types.js';
import { caseRun, count, runReport } from './helpers.js';

function selected(report: RunReport, variant: string, label = variant): Selected {
  return { report, variant, dir: `runs/${label}`, label };
}

describe('aggregateVariant', () => {
  it('sums counts, averages ratios and measures the spread between samples', () => {
    const report = runReport([
      caseRun({ caseId: 'a', sample: 1, measurements: [count('numbers.untraceable', 2), { key: 'carry.coverage', label: 'carry', value: 1, unit: 'ratio', better: 'higher', aggregate: 'mean' }] }),
      caseRun({ caseId: 'b', sample: 1, measurements: [count('numbers.untraceable', 0), { key: 'carry.coverage', label: 'carry', value: 0.5, unit: 'ratio', better: 'higher', aggregate: 'mean' }] }),
      caseRun({ caseId: 'a', sample: 2, measurements: [count('numbers.untraceable', 0), { key: 'carry.coverage', label: 'carry', value: 1, unit: 'ratio', better: 'higher', aggregate: 'mean' }] }),
      caseRun({ caseId: 'b', sample: 2, measurements: [count('numbers.untraceable', 0), { key: 'carry.coverage', label: 'carry', value: 1, unit: 'ratio', better: 'higher', aggregate: 'mean' }] }),
    ]);
    const aggregates = aggregateVariant(report, 'baseline');
    const untraceable = aggregates.find((entry) => entry.key === 'numbers.untraceable')!;
    expect(untraceable).toMatchObject({ value: 1, spread: 2, affected: 0.5, n: 2 });
    const carry = aggregates.find((entry) => entry.key === 'carry.coverage')!;
    expect(carry.value).toBeCloseTo(0.875);
    expect(carry.spread).toBeCloseTo(0.25);
  });

  it('derives run bookkeeping: failures, gates, usage, judge scores, duration percentiles', () => {
    const report = runReport([
      caseRun({ caseId: 'a', judge: { scores: { grounded: 4 } } }),
      caseRun({ caseId: 'b', status: 'timeout', gates: { completed: { pass: false, detail: 'timed out' } }, durationMs: 5000 }),
    ]);
    const byKey = new Map(aggregateVariant(report, 'baseline').map((entry) => [entry.key, entry]));
    expect(byKey.get('runs.failed')!.value).toBe(1);
    expect(byKey.get('gates.failedRuns')!.value).toBe(1);
    expect(byKey.get('gate.completed')!.value).toBe(0.5);
    expect(byKey.get('judge.grounded')!.value).toBe(4);
    expect(byKey.get('llm.promptTokens')!).toMatchObject({ value: 100, kind: 'usage' });
    expect(byKey.get('run.durationMs.max')!.value).toBe(5000);
  });
});

describe('verdictFor', () => {
  it('applies direction and noise', () => {
    expect(verdictFor('lower', 2, 0)).toBe('regressed');
    expect(verdictFor('lower', -2, 0)).toBe('improved');
    expect(verdictFor('higher', 0.1, 0.16)).toBe('within-noise');
    expect(verdictFor('none', 5, 0)).toBe('changed');
    expect(verdictFor('lower', 0, 0)).toBe('unchanged');
    expect(verdictFor('lower', null, 0)).toBe('n/a');
  });
});

describe('compareRuns', () => {
  const baseline = runReport([
    caseRun({ caseId: 'a', measurements: [count('numbers.untraceable', 0)], judge: { scores: { grounded: 4 } } }),
    caseRun({ caseId: 'b', measurements: [count('numbers.untraceable', 1)], judge: { scores: { grounded: 4 } } }),
  ], { judge: { model: 'judge-1', dimensions: ['grounded'], judgedAtIso: '2026-10-01T00:00:00.000Z', passes: 2, noise: { grounded: 0.2 } } });

  it('flags quality regressions, treats judge moves within noise as no change and lists cost as a trade-off', () => {
    const candidate = runReport([
      caseRun({ caseId: 'a', measurements: [count('numbers.untraceable', 3)], judge: { scores: { grounded: 4 } }, llm: { ...caseRun().llm, promptTokens: 200 } }),
      caseRun({ caseId: 'b', measurements: [count('numbers.untraceable', 1)], judge: { scores: { grounded: 4.3 } }, llm: { ...caseRun().llm, promptTokens: 200 } }),
    ], { judge: { model: 'judge-1', dimensions: ['grounded'], judgedAtIso: '2026-10-01T00:30:00.000Z', passes: 1 } });
    const comparison = compareRuns(selected(baseline, 'baseline', 'before'), selected(candidate, 'baseline', 'after'));
    expect(comparison.regressions.map((row) => row.key)).toEqual(['numbers.untraceable']);
    expect(comparison.rows.find((row) => row.key === 'judge.grounded')).toMatchObject({ verdict: 'within-noise', noise: 0.2 });
    expect(comparison.tradeOffs.map((row) => row.key)).toEqual(['llm.promptTokens']);
    expect(comparison.caseChanges).toEqual([expect.objectContaining({ caseId: 'a', key: 'numbers.untraceable', baseline: 0, candidate: 3, verdict: 'regressed' })]);
    expect(comparison.warnings).toEqual([]);
  });

  it('honours tolerances, including prefix patterns and percentages', () => {
    const candidate = runReport([
      caseRun({ caseId: 'a', measurements: [count('numbers.untraceable', 1)], judge: { scores: { grounded: 4 } }, llm: { ...caseRun().llm, promptTokens: 105 } }),
      caseRun({ caseId: 'b', measurements: [count('numbers.untraceable', 1)], judge: { scores: { grounded: 4 } }, llm: { ...caseRun().llm, promptTokens: 105 } }),
    ], { judge: baseline.judge });
    const comparison = compareRuns(selected(baseline, 'baseline', 'before'), selected(candidate, 'baseline', 'after'), { tolerances: { 'numbers.*': 1, 'llm.promptTokens': '10%' } });
    expect(comparison.rows.find((row) => row.key === 'numbers.untraceable')!.verdict).toBe('within-noise');
    expect(comparison.rows.find((row) => row.key === 'llm.promptTokens')!.verdict).toBe('within-noise');
    expect(comparison.regressions).toEqual([]);
  });

  it('warns when the runs are not comparable', () => {
    const smoke = runReport([
      caseRun({ caseId: 'a', inputHash: 'changed', llm: { ...caseRun().llm, calls: 0 } }),
      caseRun({ caseId: 'c', llm: { ...caseRun().llm, calls: 0 } }),
    ], { caseSet: 'holdout', judge: { model: 'judge-2', dimensions: ['grounded'], judgedAtIso: '2026-10-01T09:00:00.000Z', passes: 1 } });
    smoke.runs[0].judge = { scores: { grounded: 3 } };
    const warnings = compareRuns(selected(baseline, 'baseline', 'before'), selected(smoke, 'baseline', 'after')).warnings.join('\n');
    expect(warnings).toMatch(/different case sets/);
    expect(warnings).toMatch(/Only in before: b/);
    expect(warnings).toMatch(/Only in after: c/);
    expect(warnings).toMatch(/Inputs changed between the runs for: a/);
    expect(warnings).toMatch(/after recorded no LLM calls/);
    expect(warnings).toMatch(/Different judge models/);
    expect(warnings).toMatch(/9 h apart/);
    expect(warnings).toMatch(/Hold-out comparison/);
  });
});
