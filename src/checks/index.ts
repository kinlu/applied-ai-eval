/**
 * The check registry: maps each configured check to measurements and gates
 * for one case run.
 */
import type { AppResult, CheckName, CheckSpec, EvalConfig, GateResult, LoadedCase, Measurement } from '../types.js';
import { collectStrings, examplesOf } from '../util.js';
import { foreignRuns, looksLikeJson, reasoningLeaks, DEFAULT_REASONING_MARKERS, scriptRatio, SCRIPTS, textLength } from './format.js';
import {
  baselineDrops,
  inputEcho,
  misspellings,
  nearDuplicatePairs,
  numericTraceability,
  qualifierDrops,
  unsupportedLines,
} from './grounding.js';
import { parseJsonOutput, validateSchema, type JsonSchema } from './schema.js';

/** Checks that run when the config does not list any. They need no options and are cheap. */
export const DEFAULT_CHECKS: CheckName[] = [
  'numeric-traceability',
  'unsupported-lines',
  'near-duplicates',
  'input-echo',
  'misspellings',
  'baseline-drops',
  'qualifier-drops',
  'reasoning-leak',
  'length',
];

export interface CheckInput {
  caseDef: LoadedCase;
  result: AppResult;
  text: string;
  /** Every line, flattened across groups. */
  lines: string[];
  groups: string[][];
  config: EvalConfig;
}

export interface CheckOutput {
  measurements: Measurement[];
  gates?: Record<string, GateResult>;
}

type Options = Record<string, unknown>;
type CheckFn = (input: CheckInput, options: Options) => CheckOutput;

export function inputText(value: unknown): string {
  return typeof value === 'string' ? value : collectStrings(value).join('\n');
}

function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error(`Option "${name}" must be a list of strings`);
  return value;
}

function numberOption(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || Number.isNaN(value)) throw new Error(`Option "${name}" must be a number`);
  return value;
}

/** Input names the output may be grounded in: check option, then case, then config, else every input. */
export function sourceNames(input: CheckInput, options: Options = {}): string[] {
  return stringList(options.sources, 'sources') ?? input.caseDef.sources ?? input.config.sources ?? Object.keys(input.caseDef.inputs);
}

export function echoNames(input: CheckInput, options: Options = {}): string[] {
  return stringList(options.echoOf, 'echoOf') ?? input.caseDef.echoOf ?? input.config.echoOf ?? [];
}

function texts(input: CheckInput, names: string[]): string[] {
  return names.map((name) => inputText(input.caseDef.inputs[name]));
}

export function countMeasurement(key: string, label: string, value: number, examples: string[] = []): Measurement {
  return { key, label, value, unit: 'count', better: 'lower', aggregate: 'sum', ...(examples.length > 0 ? { examples: examplesOf(examples) } : {}) };
}

export function ratioMeasurement(key: string, label: string, value: number | null, examples: string[] = []): Measurement {
  return { key, label, value, unit: 'ratio', better: 'higher', aggregate: 'mean', ...(examples.length > 0 ? { examples: examplesOf(examples) } : {}) };
}

const CHECKS: Record<CheckName, CheckFn> = {
  'numeric-traceability': (input, options) => {
    const allow = [...(stringList(options.allow, 'allow') ?? []), ...(input.caseDef.allow?.numbers ?? [])];
    const result = numericTraceability(input.text, texts(input, sourceNames(input, options)), allow);
    return {
      measurements: [
        countMeasurement('numbers.untraceable', 'Numbers no source states', result.untraceable.length, result.untraceable),
        ratioMeasurement('numbers.traceable', 'Numbers traceable to a source', result.total === 0 ? null : result.rate),
      ],
    };
  },
  'unsupported-lines': (input, options) => {
    const allow = [...(stringList(options.allow, 'allow') ?? []), ...(input.caseDef.allow?.words ?? [])];
    const result = unsupportedLines(input.lines, texts(input, sourceNames(input, options)), allow);
    return { measurements: [countMeasurement('lines.unsupported', 'Lines using words no source uses', result.count, result.examples)] };
  },
  'near-duplicates': (input, options) => {
    const result = nearDuplicatePairs(input.groups, numberOption(options.minOverlap, 'minOverlap'));
    return { measurements: [countMeasurement('lines.nearDuplicates', 'Near-duplicate line pairs', result.count, result.examples)] };
  },
  'input-echo': (input, options) => {
    const echo = echoNames(input, options);
    if (echo.length === 0) return { measurements: [] };
    const sources = sourceNames(input, options).filter((name) => !echo.includes(name));
    const result = inputEcho(input.lines, texts(input, echo), texts(input, sources), {
      minCoverage: numberOption(options.minCoverage, 'minCoverage'),
      maxSourceCoverage: numberOption(options.maxSourceCoverage, 'maxSourceCoverage'),
    });
    return { measurements: [countMeasurement('lines.echo', `Lines echoing ${echo.join(', ')}`, result.count, result.examples)] };
  },
  misspellings: (input, options) => {
    const names = stringList(options.sources, 'sources') ?? Object.keys(input.caseDef.inputs);
    const result = misspellings(input.text, texts(input, names));
    return { measurements: [countMeasurement('text.misspellings', 'Misspelt or split words', result.count, result.examples)] };
  },
  'baseline-drops': (input, options) => {
    const result = baselineDrops(input.lines, texts(input, sourceNames(input, options)));
    return { measurements: [countMeasurement('numbers.baselineDrops', 'Improvements without their starting value', result.count, result.examples)] };
  },
  'qualifier-drops': (input, options) => {
    const result = qualifierDrops(input.lines, texts(input, sourceNames(input, options)));
    return { measurements: [countMeasurement('numbers.qualifierDrops', 'Facts stripped of their qualifier', result.count, result.examples)] };
  },
  'reasoning-leak': (input, options) => {
    const markers = [...(stringList(options.markers, 'markers') ?? DEFAULT_REASONING_MARKERS), ...(stringList(options.extend, 'extend') ?? [])];
    const found = reasoningLeaks(input.text, markers);
    return { measurements: [countMeasurement('text.reasoningLeaks', 'Reasoning leaked into the output', found.length, found)] };
  },
  'json-shape': (input, options) => {
    const json = looksLikeJson(input.text);
    return {
      measurements: [countMeasurement('text.jsonShape', 'Prose returned as JSON', json ? 1 : 0)],
      ...(options.gate ? { gates: { prose: { pass: !json, ...(json ? { detail: 'output is shaped as JSON' } : {}) } } } : {}),
    };
  },
  'script-ratio': (input, options) => {
    const script = options.script;
    if (typeof script !== 'string' || !SCRIPTS[script.toLowerCase()]) {
      throw new Error(`script-ratio needs a "script" option: ${Object.keys(SCRIPTS).join(', ')}`);
    }
    const ratio = scriptRatio(input.text, script);
    const min = numberOption(options.min, 'min');
    const measurements: Measurement[] = [ratioMeasurement('text.scriptRatio', `Letters in ${script} script`, ratio)];
    if (script.toLowerCase() !== 'latin') {
      measurements.push(countMeasurement('text.foreignRuns', 'Runs of six or more English words', foreignRuns(input.text)));
    }
    const gates: Record<string, GateResult> = {};
    if (min !== undefined) {
      const pass = ratio !== null && ratio >= min;
      gates.script = { pass, ...(pass ? {} : { detail: `${script} letters ${ratio === null ? 'absent' : `${(ratio * 100).toFixed(0)}%`}, need ${(min * 100).toFixed(0)}%` }) };
    }
    return { measurements, gates };
  },
  length: (input, options) => {
    const unit = options.unit === 'words' ? 'words' : 'chars';
    const length = textLength(input.text, unit);
    const min = numberOption(options.min, 'min');
    const max = numberOption(options.max, 'max');
    const measurement: Measurement = {
      key: 'text.length',
      label: `Output length (${unit})`,
      value: length,
      unit: unit === 'chars' ? 'chars' : 'count',
      better: 'none',
      aggregate: 'mean',
    };
    if (min === undefined && max === undefined) return { measurements: [measurement] };
    const pass = (min === undefined || length >= min) && (max === undefined || length <= max);
    return {
      measurements: [measurement],
      gates: { length: { pass, ...(pass ? {} : { detail: `${length} ${unit}, allowed ${min ?? 0}–${max ?? '∞'}` }) } },
    };
  },
  schema: (input, options) => {
    const schema = options.schema as JsonSchema | undefined;
    if (!schema || typeof schema !== 'object') throw new Error('schema check needs a "schema" option');
    const field = typeof options.field === 'string' ? options.field : undefined;
    const target = field ? field.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), input.result.output) : input.result.output;
    const parsed = parseJsonOutput(target);
    const errors = parsed.error ? [parsed.error] : validateSchema(parsed.value, schema);
    return {
      measurements: [countMeasurement('schema.errors', 'Schema violations', errors.length, errors)],
      gates: { schema: { pass: errors.length === 0, ...(errors.length > 0 ? { detail: errors.slice(0, 3).join('; ') } : {}) } },
    };
  },
};

export const CHECK_NAMES = Object.keys(CHECKS) as CheckName[];

export function parseCheckSpec(spec: CheckSpec): { name: CheckName; options: Options } {
  const name = typeof spec === 'string' ? spec : spec.check;
  if (!CHECK_NAMES.includes(name)) throw new Error(`Unknown check "${String(name)}". Known checks: ${CHECK_NAMES.join(', ')}`);
  if (typeof spec === 'string') return { name, options: {} };
  const { check: _check, ...options } = spec;
  return { name, options };
}

export function runCheck(spec: CheckSpec, input: CheckInput): CheckOutput {
  const { name, options } = parseCheckSpec(spec);
  return CHECKS[name](input, options);
}
