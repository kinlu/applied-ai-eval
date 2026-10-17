/**
 * Scores one case run: configured text checks, the case's own expectations
 * (traps, keywords, facts to carry), stage fallbacks, app metrics and gates.
 */
import { countMeasurement, DEFAULT_CHECKS, ratioMeasurement, runCheck, type CheckInput } from './checks/index.js';
import { carryCoverage, keywordCoverage } from './checks/grounding.js';
import { evaluateTrap } from './checks/traps.js';
import { normalizeResult, resultGroups, resultText, segmentText } from './segment.js';
import type { AppResult, CaseRun, EvalConfig, GateResult, LoadedCase, Measurement, TrapResult } from './types.js';
import { errorMessage } from './util.js';

export const DEFAULT_FALLBACK_MODES = ['fallback', 'deterministic'];

export interface MeasuredRun {
  measurements: Measurement[];
  gates: Record<string, GateResult>;
  traps: TrapResult[];
}

function appMeasurements(result: AppResult): Measurement[] {
  return Object.entries(result.metrics ?? {}).map(([key, metric]) => {
    if (metric === null || typeof metric === 'number') {
      return { key, label: key, value: metric, unit: 'score', better: 'none', aggregate: 'mean' } satisfies Measurement;
    }
    const unit = metric.unit ?? 'score';
    return {
      key,
      label: metric.label ?? key,
      value: metric.value,
      unit,
      better: metric.better ?? 'none',
      ...(metric.kind ? { kind: metric.kind } : {}),
      aggregate: metric.aggregate ?? (unit === 'count' ? 'sum' : 'mean'),
      ...(metric.examples?.length ? { examples: metric.examples.slice(0, 5) } : {}),
    } satisfies Measurement;
  });
}

function configMeasurements(config: EvalConfig, caseDef: LoadedCase, result: AppResult, text: string, lines: string[]): Measurement[] {
  return (config.metrics ?? []).map((metric) => {
    let measured: ReturnType<typeof metric.measure>;
    try {
      measured = metric.measure({ case: caseDef, result, text, lines });
    } catch (error) {
      throw new Error(`metric "${metric.key}" failed: ${errorMessage(error)}`);
    }
    const value = measured === null || typeof measured === 'number' ? measured : measured.value;
    const examples = measured && typeof measured === 'object' ? measured.examples ?? [] : [];
    const unit = metric.unit ?? 'score';
    return {
      key: metric.key,
      label: metric.label ?? metric.key,
      value,
      unit,
      better: metric.better ?? 'none',
      ...(metric.kind ? { kind: metric.kind } : {}),
      aggregate: metric.aggregate ?? (unit === 'count' ? 'sum' : 'mean'),
      ...(examples.length > 0 ? { examples: examples.slice(0, 5) } : {}),
    };
  });
}

/**
 * Measures a finished case run. A run that errored, timed out or produced no
 * text gets no quality measurements, so a failure can never read as clean
 * output; it fails the `completed` gate instead.
 */
export function measureResult(
  caseDef: LoadedCase,
  rawResult: unknown,
  config: EvalConfig,
  status: CaseRun['status'],
  error?: string,
): MeasuredRun {
  const result = normalizeResult(rawResult);
  const gates: Record<string, GateResult> = {};
  const text = status === 'ok' ? resultText(result) : '';

  if (status !== 'ok') {
    gates.completed = { pass: false, detail: status === 'timeout' ? `timed out${error ? `: ${error}` : ''}` : error ?? 'error' };
    return { measurements: [], gates, traps: [] };
  }
  if (text.trim().length === 0) {
    gates.completed = { pass: false, detail: 'no output text' };
    return { measurements: [], gates, traps: [] };
  }
  gates.completed = { pass: true };

  for (const [name, gate] of Object.entries(result.gates ?? {})) {
    gates[name] = typeof gate === 'boolean' ? { pass: gate } : { pass: Boolean(gate.pass), ...(gate.detail ? { detail: gate.detail } : {}) };
  }

  const groups = resultGroups(result, text, config.segment ?? segmentText);
  const lines = groups.flat();
  const input: CheckInput = { caseDef, result, text, lines, groups, config };
  const measurements: Measurement[] = [];

  for (const spec of config.checks ?? DEFAULT_CHECKS) {
    const output = runCheck(spec, input);
    measurements.push(...output.measurements);
    Object.assign(gates, output.gates ?? {});
  }

  const traps = (caseDef.traps ?? []).map((trap) => evaluateTrap(trap, text));
  if (traps.length > 0) {
    const failed = traps.filter((trap) => !trap.pass);
    measurements.push(countMeasurement('traps.failed', 'Traps failed', failed.length, failed.map((trap) => `${trap.id}: ${trap.detail ?? ''}`)));
    for (const trap of traps.filter((entry) => entry.gate)) {
      gates[`trap:${trap.id}`] = { pass: trap.pass, ...(trap.detail ? { detail: trap.detail } : {}) };
    }
  }

  if (caseDef.keywords?.length) {
    const coverage = keywordCoverage(text, caseDef.keywords);
    measurements.push(
      ratioMeasurement('keywords.coverage', 'Expected keywords present', coverage.rate),
      countMeasurement('keywords.missing', 'Expected keywords missing', coverage.missing.length, coverage.missing),
    );
  }

  if (caseDef.carry?.length) {
    const coverage = carryCoverage(caseDef.carry, lines);
    measurements.push(
      ratioMeasurement('carry.coverage', 'Facts carried into the output', coverage.rate),
      countMeasurement('carry.missing', 'Facts the output dropped', coverage.missing.length, coverage.missing),
    );
  }

  const fallbackModes = config.fallbackModes ?? DEFAULT_FALLBACK_MODES;
  if (result.stages && Object.keys(result.stages).length > 0) {
    const fellBack = Object.entries(result.stages)
      .filter(([, stage]) => fallbackModes.includes(stage.mode))
      .map(([name, stage]) => `${name}: ${stage.mode}${stage.error ? ` (${stage.error})` : ''}`);
    measurements.push(countMeasurement('stages.fallbacks', 'Stages that fell back', fellBack.length, fellBack));
  }

  measurements.push(...appMeasurements(result), ...configMeasurements(config, caseDef, result, text, lines));
  return { measurements, gates, traps };
}
