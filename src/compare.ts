/**
 * `aieval compare <baseline> <candidate>`: the before/after table every
 * prompt, model or config change ships with.
 *
 * Each aggregate gets a verdict. A change counts only when it exceeds the
 * metric's noise: its tolerance, the spread between samples of either run,
 * and for judge scores the judge's measured noise. Quality regressions block
 * adoption; cost and latency changes are listed as trade-offs for a person to
 * accept or reject, with the numbers.
 */
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { aggregateVariant, caseMeasurementMean, recordedLlmCalls, allMeasurements, type AggregateValue } from './aggregate.js';
import { formatDelta, formatPct, formatValue } from './format.js';
import { mergeSummaries } from './telemetry.js';
import type { Better, LlmSummary, MeasurementKind, RunReport, Tolerance, Unit } from './types.js';
import { cell, readJson } from './util.js';

export type Verdict = 'improved' | 'regressed' | 'within-noise' | 'unchanged' | 'changed' | 'n/a';

export interface ComparisonRow {
  key: string;
  label: string;
  unit: Unit;
  better: Better;
  kind: MeasurementKind;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  /** Delta as a percentage of the baseline; null when the baseline is missing or zero. */
  pct: number | null;
  /** The largest change still treated as noise. */
  noise: number;
  verdict: Verdict;
}

export interface CaseChange {
  caseId: string;
  key: string;
  label: string;
  unit: Unit;
  baseline: number;
  candidate: number;
  verdict: Verdict;
}

export interface SideSummary {
  label: string;
  dir: string;
  variant: string;
  startedIso: string;
  caseSet: string;
  cases: number;
  samples: number;
  git?: { commit: string; dirty: boolean };
  judgeModel?: string;
  judgedAtIso?: string;
  smoke: boolean;
}

export interface Comparison {
  baseline: SideSummary;
  candidate: SideSummary;
  rows: ComparisonRow[];
  caseChanges: CaseChange[];
  agents: Array<{ agent: string; baseline: LlmSummary | null; candidate: LlmSummary | null }>;
  warnings: string[];
  regressions: ComparisonRow[];
  tradeOffs: ComparisonRow[];
  improvements: ComparisonRow[];
}

export interface Selected {
  report: RunReport;
  variant: string;
  dir: string;
  label: string;
}

/** `path/to/run#variant`; the variant may be omitted when the run has only one. */
export function loadSelected(selector: string, cwd = process.cwd(), label?: string): Selected {
  const hash = selector.lastIndexOf('#');
  const path = hash > 0 ? selector.slice(0, hash) : selector;
  const requested = hash > 0 ? selector.slice(hash + 1) : undefined;
  const resolved = resolve(cwd, path);
  const file = existsSync(resolved) && statSync(resolved).isDirectory() ? join(resolved, 'report.json') : resolved;
  if (!existsSync(file)) throw new Error(`No report.json at ${resolved}`);
  const report = readJson<RunReport>(file);
  const names = report.variants.map((variant) => variant.name);
  const variant = requested ?? (names.length === 1 ? names[0] : undefined);
  if (!variant) throw new Error(`${path} has variants ${names.join(', ')}; pick one with ${path}#<variant>`);
  if (!names.includes(variant)) throw new Error(`${path} has no variant "${variant}" (it has ${names.join(', ')})`);
  return { report, variant, dir: path, label: label ?? (names.length > 1 || requested ? variant : path.replace(/\/+$/, '').split('/').pop() ?? path) };
}

export const DEFAULT_USAGE_TOLERANCE: Tolerance = '10%';

/** Changes this small are measurement noise whatever the tolerance: timer jitter, a stray token. */
const NOISE_FLOOR: Partial<Record<Unit, number>> = { ms: 100, tokens: 1, usd: 0.000001 };

function toleranceSpec(key: string, tolerances: Record<string, Tolerance>): Tolerance | undefined {
  if (key in tolerances) return tolerances[key];
  const prefix = Object.keys(tolerances)
    .filter((pattern) => pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1)))
    .sort((a, b) => b.length - a.length)[0];
  return prefix ? tolerances[prefix] : undefined;
}

function toleranceValue(spec: Tolerance, baseline: number | null): number {
  if (typeof spec === 'number') return spec;
  return Math.abs(baseline ?? 0) * (Number.parseFloat(spec) / 100);
}

export function verdictFor(better: Better, delta: number | null, noise: number): Verdict {
  if (delta === null) return 'n/a';
  if (Math.abs(delta) < 1e-12) return 'unchanged';
  if (better === 'none') return 'changed';
  if (Math.abs(delta) <= noise + 1e-12) return 'within-noise';
  return (better === 'higher' ? delta > 0 : delta < 0) ? 'improved' : 'regressed';
}

function side(selected: Selected): SideSummary {
  const { report } = selected;
  return {
    label: selected.label,
    dir: selected.dir,
    variant: selected.variant,
    startedIso: report.startedIso,
    caseSet: report.caseSet,
    cases: new Set(report.runs.filter((run) => run.variant === selected.variant).map((run) => run.caseId)).size,
    samples: report.samples,
    ...(report.git ? { git: report.git } : {}),
    ...(report.judge ? { judgeModel: report.judge.model, judgedAtIso: report.judge.judgedAtIso } : {}),
    smoke: !recordedLlmCalls(report, selected.variant),
  };
}

function caseIds(selected: Selected): Map<string, string> {
  return new Map(selected.report.runs.filter((run) => run.variant === selected.variant).map((run) => [run.caseId, run.inputHash]));
}

function agentSummaries(selected: Selected): Map<string, LlmSummary> {
  const runs = selected.report.runs.filter((run) => run.variant === selected.variant);
  const agents = [...new Set(runs.flatMap((run) => Object.keys(run.llmByAgent)))];
  const samples = Math.max(1, selected.report.samples);
  return new Map(agents.map((agent) => {
    const merged = mergeSummaries(runs.map((run) => run.llmByAgent[agent]).filter((entry): entry is LlmSummary => Boolean(entry)));
    // Per-sample totals, so runs with different sample counts compare.
    return [agent, {
      ...merged,
      calls: merged.calls / samples,
      errors: merged.errors / samples,
      promptTokens: merged.promptTokens / samples,
      completionTokens: merged.completionTokens / samples,
      reasoningTokens: merged.reasoningTokens / samples,
      totalMs: merged.totalMs / samples,
      costUsd: merged.costUsd === null ? null : merged.costUsd / samples,
    }];
  }));
}

export interface CompareOptions {
  /** Merged over the candidate run's own tolerances. */
  tolerances?: Record<string, Tolerance>;
  /** Minimum judge noise per dimension, when neither run measured it. */
  judgeNoise?: number;
}

export function compareRuns(baseline: Selected, candidate: Selected, options: CompareOptions = {}): Comparison {
  const tolerances = { ...baseline.report.tolerances, ...candidate.report.tolerances, ...options.tolerances };
  const baseAggregates = aggregateVariant(baseline.report, baseline.variant);
  const candAggregates = aggregateVariant(candidate.report, candidate.variant);
  const byKey = (list: AggregateValue[]) => new Map(list.map((entry) => [entry.key, entry]));
  const baseMap = byKey(baseAggregates);
  const candMap = byKey(candAggregates);
  const keys = [...candAggregates.map((entry) => entry.key), ...baseAggregates.map((entry) => entry.key).filter((key) => !candMap.has(key))];

  const rows: ComparisonRow[] = keys.map((key) => {
    const a = baseMap.get(key);
    const b = candMap.get(key);
    const meta = (b ?? a)!;
    const baseValue = a?.value ?? null;
    const candValue = b?.value ?? null;
    const delta = baseValue !== null && candValue !== null ? candValue - baseValue : null;
    const spec = toleranceSpec(key, tolerances) ?? (meta.kind === 'usage' ? DEFAULT_USAGE_TOLERANCE : 0);
    let noise = Math.max(toleranceValue(spec, baseValue), a?.spread ?? 0, b?.spread ?? 0, NOISE_FLOOR[meta.unit] ?? 0);
    if (key.startsWith('judge.')) {
      const dimension = key.slice('judge.'.length);
      noise = Math.max(noise, baseline.report.judge?.noise?.[dimension] ?? 0, candidate.report.judge?.noise?.[dimension] ?? 0, options.judgeNoise ?? 0);
    }
    return {
      key,
      label: meta.label,
      unit: meta.unit,
      better: meta.better,
      kind: meta.kind,
      baseline: baseValue,
      candidate: candValue,
      delta,
      pct: delta !== null && baseValue ? (delta / Math.abs(baseValue)) * 100 : null,
      noise,
      verdict: verdictFor(meta.better, delta, noise),
    };
  });

  const baseCases = caseIds(baseline);
  const candCases = caseIds(candidate);
  const shared = [...baseCases.keys()].filter((id) => candCases.has(id));
  const caseChanges: CaseChange[] = [];
  for (const caseId of shared) {
    const keysForCase = new Map<string, { label: string; unit: Unit; better: Better }>();
    for (const selected of [baseline, candidate]) {
      for (const run of selected.report.runs.filter((entry) => entry.variant === selected.variant && entry.caseId === caseId)) {
        for (const measurement of allMeasurements(run)) {
          // Judge scores are compared in aggregate only, where their noise is known.
          if ((measurement.kind ?? 'quality') === 'quality' && measurement.better !== 'none' && !measurement.key.startsWith('judge.')) {
            keysForCase.set(measurement.key, measurement);
          }
        }
      }
    }
    for (const [key, meta] of keysForCase) {
      const a = caseMeasurementMean(baseline.report, baseline.variant, caseId, key);
      const b = caseMeasurementMean(candidate.report, candidate.variant, caseId, key);
      if (a === null || b === null) continue;
      const verdict = verdictFor(meta.better, b - a, 0);
      if (verdict === 'improved' || verdict === 'regressed') caseChanges.push({ caseId, key, label: meta.label, unit: meta.unit, baseline: a, candidate: b, verdict });
    }
  }

  const warnings: string[] = [];
  const baseSide = side(baseline);
  const candSide = side(candidate);
  if (baseline.report.caseSet !== candidate.report.caseSet) warnings.push(`The runs used different case sets (${baseline.report.caseSet} vs ${candidate.report.caseSet}).`);
  const onlyBase = [...baseCases.keys()].filter((id) => !candCases.has(id));
  const onlyCand = [...candCases.keys()].filter((id) => !baseCases.has(id));
  if (onlyBase.length > 0) warnings.push(`Only in ${baseSide.label}: ${onlyBase.join(', ')}. Aggregates cover different cases.`);
  if (onlyCand.length > 0) warnings.push(`Only in ${candSide.label}: ${onlyCand.join(', ')}. Aggregates cover different cases.`);
  const changedInputs = shared.filter((id) => baseCases.get(id) !== candCases.get(id));
  if (changedInputs.length > 0) warnings.push(`Inputs changed between the runs for: ${changedInputs.join(', ')}.`);
  if (baseSide.smoke || candSide.smoke) {
    warnings.push(`${[baseSide.smoke ? baseSide.label : null, candSide.smoke ? candSide.label : null].filter(Boolean).join(' and ')} recorded no LLM calls: a smoke run tests the harness, not output quality.`);
  }
  if (baseline.report.samples !== candidate.report.samples) warnings.push(`Sample counts differ (${baseline.report.samples} vs ${candidate.report.samples}).`);
  if (JSON.stringify(baseline.report.checks) !== JSON.stringify(candidate.report.checks) || baseline.report.tool.version !== candidate.report.tool.version) {
    warnings.push('The runs were scored with different checks or harness versions. Re-score the older run with `aieval rescore` so both use the same definitions.');
  }
  const baseJudged = baseline.report.runs.some((run) => run.variant === baseline.variant && run.judge);
  const candJudged = candidate.report.runs.some((run) => run.variant === candidate.variant && run.judge);
  if (baseJudged !== candJudged) warnings.push('Only one run has judge scores; judge both from their artifacts with `aieval judge`.');
  if (baseJudged && candJudged && baseline.report.judge && candidate.report.judge) {
    if (baseline.report.judge.model !== candidate.report.judge.model) warnings.push(`Different judge models (${baseline.report.judge.model} vs ${candidate.report.judge.model}); judge scores are not comparable.`);
    const gapHours = Math.abs(Date.parse(baseline.report.judge.judgedAtIso) - Date.parse(candidate.report.judge.judgedAtIso)) / 3_600_000;
    if (gapHours > 2 && baseline.report !== candidate.report) warnings.push(`Judge scores were taken ${gapHours.toFixed(0)} h apart. Re-judge both runs back to back: judge scores drift between provider windows.`);
    if (!baseline.report.judge.noise && !candidate.report.judge.noise && options.judgeNoise === undefined) {
      warnings.push('Judge noise was not measured. Judge one run with `--passes 2` to learn how far scores move on identical outputs.');
    }
  }
  if (baseline.report.caseSet === 'holdout' || candidate.report.caseSet === 'holdout') warnings.push('Hold-out comparison: for acceptance only. Do not tune against these outputs.');

  const baseAgents = agentSummaries(baseline);
  const candAgents = agentSummaries(candidate);
  const agents = [...new Set([...baseAgents.keys(), ...candAgents.keys()])].sort().map((agent) => ({ agent, baseline: baseAgents.get(agent) ?? null, candidate: candAgents.get(agent) ?? null }));

  return {
    baseline: baseSide,
    candidate: candSide,
    rows,
    caseChanges,
    agents,
    warnings,
    regressions: rows.filter((row) => row.kind === 'quality' && row.verdict === 'regressed'),
    tradeOffs: rows.filter((row) => row.kind === 'usage' && row.verdict === 'regressed'),
    improvements: rows.filter((row) => row.verdict === 'improved'),
  };
}

/* ------------------------------------------------------------- markdown */

function describe(label: string, summary: SideSummary): string {
  const parts = [
    `\`${summary.dir}${summary.variant ? `#${summary.variant}` : ''}\``,
    `run ${summary.startedIso}`,
    `${summary.cases} cases (${summary.caseSet})`,
    `${summary.samples} sample(s)`,
    summary.git ? `commit ${summary.git.commit.slice(0, 12)}${summary.git.dirty ? ' (dirty)' : ''}` : null,
    summary.judgeModel ? `judge ${summary.judgeModel} at ${summary.judgedAtIso}` : null,
  ].filter(Boolean);
  return `- ${label}: ${parts.join(' · ')}`;
}

function verdictCell(row: ComparisonRow): string {
  switch (row.verdict) {
    case 'regressed': return row.kind === 'usage' ? '**costlier/slower**' : '**regressed**';
    case 'improved': return 'improved';
    case 'within-noise': return 'within noise';
    default: return row.verdict;
  }
}

function rowLine(row: ComparisonRow): string {
  return `| ${cell(row.label)} | ${formatValue(row.baseline, row.unit)} | ${formatValue(row.candidate, row.unit)} | ${formatDelta(row.delta, row.unit)} | ${formatPct(row.pct)} | ${row.noise > 0 ? `±${formatDelta(row.noise, row.unit).replace(/^[+−±]/, '')}` : '0'} | ${verdictCell(row)} |`;
}

function arrow(a: number | null | undefined, b: number | null | undefined, unit: Unit): string {
  return `${formatValue(a ?? null, unit)} → ${formatValue(b ?? null, unit)}`;
}

export function formatComparisonMarkdown(comparison: Comparison): string {
  const { baseline, candidate } = comparison;
  const labels = { baseline: baseline.label, candidate: candidate.label };
  const lines: string[] = [
    `# Eval comparison: ${baseline.label} → ${candidate.label}`,
    '',
    describe('Baseline', baseline),
    describe('Candidate', candidate),
    '',
  ];
  const listed = (rows: ComparisonRow[]) => rows.map((row) => `${row.label} (${formatValue(row.baseline, row.unit)} → ${formatValue(row.candidate, row.unit)})`).join('; ');
  if (comparison.regressions.length === 0) {
    lines.push(`**Verdict: no quality regressions.** ${comparison.improvements.filter((row) => row.kind === 'quality').length} quality metric(s) improved.`);
  } else {
    lines.push(`**Verdict: ${comparison.regressions.length} quality regression(s)** — ${listed(comparison.regressions)}.`);
  }
  if (comparison.tradeOffs.length > 0) {
    lines.push('', `Cost and latency trade-offs to accept or reject: ${listed(comparison.tradeOffs)}.`);
  }
  if (comparison.warnings.length > 0) lines.push('', ...comparison.warnings.map((warning) => `> ${warning}`));

  const header = ['| Metric | ' + `${labels.baseline} | ${labels.candidate} | Δ | Δ% | Noise | Verdict |`, '|---|---|---|---|---|---|---|'];
  // A gate both runs always passed adds nothing next to "Runs with a failed gate".
  const visible = (row: ComparisonRow) => (row.baseline !== null || row.candidate !== null)
    && !(row.key.startsWith('gate.') && row.key !== 'gate.completed' && row.baseline === 1 && row.candidate === 1);
  lines.push('', '## Quality', '', ...header, ...comparison.rows.filter((row) => row.kind === 'quality' && visible(row)).map(rowLine));
  lines.push('', '## Cost and latency', '', ...header, ...comparison.rows.filter((row) => row.kind === 'usage' && visible(row)).map(rowLine));

  lines.push('', '## Per-case changes', '');
  if (comparison.caseChanges.length === 0) {
    lines.push('No case changed on any quality metric.');
  } else {
    lines.push(`| Case | Metric | ${labels.baseline} | ${labels.candidate} | Verdict |`, '|---|---|---|---|---|');
    for (const change of comparison.caseChanges) {
      lines.push(`| ${change.caseId} | ${cell(change.label)} | ${formatValue(change.baseline, change.unit)} | ${formatValue(change.candidate, change.unit)} | ${change.verdict === 'regressed' ? '**regressed**' : 'improved'} |`);
    }
  }

  if (comparison.agents.length > 0) {
    lines.push(
      '',
      '## LLM usage by agent (per sample)',
      '',
      `| Agent | Calls | Prompt tok | Completion tok | Reasoning tok | Time | Billed cost |`,
      '|---|---|---|---|---|---|---|',
      ...comparison.agents.map(({ agent, baseline: a, candidate: b }) => `| ${agent} | ${arrow(a?.calls, b?.calls, 'count')} | ${arrow(a?.promptTokens, b?.promptTokens, 'tokens')} | ${arrow(a?.completionTokens, b?.completionTokens, 'tokens')} | ${arrow(a?.reasoningTokens, b?.reasoningTokens, 'tokens')} | ${arrow(a?.totalMs, b?.totalMs, 'ms')} | ${arrow(a?.costUsd, b?.costUsd, 'usd')} |`),
    );
  }
  lines.push('');
  return lines.join('\n');
}
