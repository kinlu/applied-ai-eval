/**
 * Folding case runs into per-variant aggregates. Pure: used by the report,
 * the comparison and tests.
 */
import type { Better, CaseRun, Measurement, MeasurementKind, RunReport, Unit } from './types.js';
import { mean, percentile, sum } from './util.js';

export interface AggregateValue {
  key: string;
  label: string;
  unit: Unit;
  better: Better;
  kind: MeasurementKind;
  aggregate: 'sum' | 'mean';
  /** Mean over samples of the per-sample aggregate; null when nothing was measured. */
  value: number | null;
  /** Max − min of the per-sample aggregates; null with a single sample. */
  spread: number | null;
  /** Count metrics: case runs with a non-zero value (mean over samples). */
  affected?: number;
  /** Case runs measured per sample (mean over samples). */
  n: number;
}

/** Measurements derived from a run's bookkeeping rather than from a check. */
export function runMeasurements(run: CaseRun): Measurement[] {
  const failedGates = Object.entries(run.gates).filter(([, gate]) => !gate.pass);
  const measurements: Measurement[] = [
    { key: 'runs.failed', label: 'Runs that errored or timed out', value: run.status === 'ok' ? 0 : 1, unit: 'count', better: 'lower', aggregate: 'sum' },
    { key: 'gates.failedRuns', label: 'Runs with a failed gate', value: failedGates.length > 0 ? 1 : 0, unit: 'count', better: 'lower', aggregate: 'sum' },
    ...Object.entries(run.gates).map(([name, gate]): Measurement => ({
      key: `gate.${name}`, label: `Gate passed: ${name}`, value: gate.pass ? 1 : 0, unit: 'ratio', better: 'higher', aggregate: 'mean',
    })),
    { key: 'llm.errors', label: 'Failed LLM calls', value: run.llm.errors, unit: 'count', better: 'lower', aggregate: 'sum' },
    { key: 'llm.calls', label: 'LLM calls per run', value: run.llm.calls, unit: 'count', better: 'lower', kind: 'usage', aggregate: 'mean' },
    { key: 'llm.promptTokens', label: 'Prompt tokens per run', value: run.llm.promptTokens, unit: 'tokens', better: 'lower', kind: 'usage', aggregate: 'mean' },
    { key: 'llm.completionTokens', label: 'Completion tokens per run', value: run.llm.completionTokens, unit: 'tokens', better: 'lower', kind: 'usage', aggregate: 'mean' },
    { key: 'llm.reasoningTokens', label: 'Reasoning tokens per run', value: run.llm.reasoningTokens, unit: 'tokens', better: 'lower', kind: 'usage', aggregate: 'mean' },
    { key: 'llm.costUsd', label: 'Billed cost per run (USD)', value: run.llm.costUsd, unit: 'usd', better: 'lower', kind: 'usage', aggregate: 'mean' },
    { key: 'llm.estimatedCostUsd', label: 'List-price cost per run (USD)', value: run.llm.estimatedCostUsd, unit: 'usd', better: 'lower', kind: 'usage', aggregate: 'mean' },
    { key: 'llm.timeMs', label: 'LLM time per run', value: run.llm.calls > 0 ? run.llm.totalMs : null, unit: 'ms', better: 'lower', kind: 'usage', aggregate: 'mean' },
    { key: 'run.durationMs', label: 'Run time', value: run.durationMs, unit: 'ms', better: 'lower', kind: 'usage', aggregate: 'mean' },
  ];
  for (const [dimension, score] of Object.entries(run.judge?.scores ?? {})) {
    measurements.push({ key: `judge.${dimension}`, label: `Judge: ${dimension}`, value: score, unit: 'score', better: 'higher', aggregate: 'mean' });
  }
  return measurements;
}

export function allMeasurements(run: CaseRun): Measurement[] {
  return [...runMeasurements(run), ...run.measurements];
}

interface Bucket {
  meta: Omit<AggregateValue, 'value' | 'spread' | 'affected' | 'n'>;
  perSample: Map<number, number[]>;
}

/** Aggregates of one variant across its samples, in a stable order: run bookkeeping first, then checks. */
export function aggregateVariant(report: RunReport, variant: string): AggregateValue[] {
  const runs = report.runs.filter((run) => run.variant === variant);
  const samples = [...new Set(runs.map((run) => run.sample))].sort((a, b) => a - b);
  const buckets = new Map<string, Bucket>();
  for (const run of runs) {
    for (const measurement of allMeasurements(run)) {
      let bucket = buckets.get(measurement.key);
      if (!bucket) {
        bucket = {
          meta: {
            key: measurement.key,
            label: measurement.label,
            unit: measurement.unit,
            better: measurement.better,
            kind: measurement.kind ?? 'quality',
            aggregate: measurement.aggregate ?? (measurement.unit === 'count' ? 'sum' : 'mean'),
          },
          perSample: new Map(),
        };
        buckets.set(measurement.key, bucket);
      }
      if (measurement.value === null || Number.isNaN(measurement.value)) continue;
      const values = bucket.perSample.get(run.sample) ?? [];
      values.push(measurement.value);
      bucket.perSample.set(run.sample, values);
    }
  }

  const aggregates: AggregateValue[] = [];
  for (const bucket of buckets.values()) {
    const sampleValues: number[] = [];
    const affected: number[] = [];
    const counts: number[] = [];
    for (const sample of samples) {
      const values = bucket.perSample.get(sample) ?? [];
      if (values.length === 0) continue;
      sampleValues.push(bucket.meta.aggregate === 'sum' ? sum(values) : mean(values)!);
      affected.push(values.filter((value) => value > 0).length);
      counts.push(values.length);
    }
    aggregates.push({
      ...bucket.meta,
      value: mean(sampleValues),
      spread: sampleValues.length > 1 ? Math.max(...sampleValues) - Math.min(...sampleValues) : null,
      ...(bucket.meta.aggregate === 'sum' ? { affected: mean(affected) ?? 0 } : {}),
      n: mean(counts) ?? 0,
    });
  }

  const durations = runs.map((run) => run.durationMs);
  for (const [suffix, label, value] of [
    ['p50', 'Run time p50', percentile(durations, 50)],
    ['p90', 'Run time p90', percentile(durations, 90)],
    ['max', 'Run time max', durations.length > 0 ? Math.max(...durations) : null],
  ] as const) {
    aggregates.push({ key: `run.durationMs.${suffix}`, label, unit: 'ms', better: 'lower', kind: 'usage', aggregate: 'mean', value, spread: null, n: runs.length });
  }
  return aggregates;
}

/** Mean of a measurement over one case's samples within a variant; null when never measured. */
export function caseMeasurementMean(report: RunReport, variant: string, caseId: string, key: string): number | null {
  const values = report.runs
    .filter((run) => run.variant === variant && run.caseId === caseId)
    .map((run) => allMeasurements(run).find((measurement) => measurement.key === key)?.value)
    .filter((value): value is number => typeof value === 'number' && !Number.isNaN(value));
  return mean(values);
}

/** Whether any case run recorded an LLM call; a run without any is a smoke test, not a quality signal. */
export function recordedLlmCalls(report: RunReport, variant?: string): boolean {
  return report.runs.some((run) => (!variant || run.variant === variant) && run.llm.calls > 0);
}
