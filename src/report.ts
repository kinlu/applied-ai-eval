/**
 * Markdown views of a run: report.md (results), inputs.md (the exact inputs
 * every variant received), review.md (the human review checklist) and one
 * Markdown file per output for side-by-side reading.
 */
import { aggregateVariant, recordedLlmCalls, type AggregateValue } from './aggregate.js';
import { formatSpread, formatValue } from './format.js';
import { mergeSummaries } from './telemetry.js';
import type { AppResult, CaseRun, LlmSummary, LoadedCase, RunReport } from './types.js';
import { cell, truncate } from './util.js';

const SHORT_LABELS: Record<string, string> = {
  'numbers.untraceable': 'untraceable numbers',
  'lines.unsupported': 'unsupported lines',
  'lines.nearDuplicates': 'near-duplicate pairs',
  'lines.echo': 'echo lines',
  'text.misspellings': 'misspellings',
  'numbers.baselineDrops': 'baseline drops',
  'numbers.qualifierDrops': 'qualifier drops',
  'text.reasoningLeaks': 'reasoning leaks',
  'text.jsonShape': 'JSON-shaped',
  'text.foreignRuns': 'English runs',
  'schema.errors': 'schema errors',
  'traps.failed': 'traps failed',
  'keywords.missing': 'keywords missing',
  'carry.missing': 'facts dropped',
  'stages.fallbacks': 'fallbacks',
};

function runLabel(run: Pick<CaseRun, 'variant' | 'sample'>, samples: number): string {
  return samples > 1 ? `${run.variant} s${run.sample}` : run.variant;
}

export function artifactLink(report: RunReport, run: CaseRun, extension = 'md'): string {
  return `${report.artifactsDir}/${run.artifact}.${extension}`;
}

function variantNames(report: RunReport): string[] {
  return report.variants.map((variant) => variant.name);
}

function gateSummary(run: CaseRun): string {
  const failed = Object.entries(run.gates).filter(([, gate]) => !gate.pass);
  if (failed.length === 0) return 'pass';
  return `**FAIL** ${failed.map(([name, gate]) => `${name}${gate.detail ? `: ${truncate(gate.detail, 80)}` : ''}`).join('; ')}`;
}

function flags(run: CaseRun): string {
  const parts = run.measurements
    .filter((measurement) => measurement.unit === 'count' && measurement.better === 'lower' && (measurement.value ?? 0) > 0)
    .map((measurement) => `${SHORT_LABELS[measurement.key] ?? measurement.label} ${formatValue(measurement.value, 'count')}`);
  return parts.length > 0 ? parts.join(', ') : '–';
}

const SHORT_RATIO_LABELS: Record<string, string> = {
  'numbers.traceable': 'numbers',
  'carry.coverage': 'facts',
  'keywords.coverage': 'keywords',
  'text.scriptRatio': 'script',
};

function coverage(run: CaseRun): string {
  const parts = run.measurements
    .filter((measurement) => measurement.unit === 'ratio' && measurement.value !== null)
    .map((measurement) => `${SHORT_RATIO_LABELS[measurement.key] ?? measurement.label} ${formatValue(measurement.value, 'ratio')}`);
  return parts.length > 0 ? parts.join(', ') : '–';
}

function judgeCell(run: CaseRun): string {
  if (!run.judge) return run.judge === null ? 'failed' : '–';
  return Object.values(run.judge.scores).map((score) => (score === null ? '?' : String(Math.round(score * 100) / 100))).join('/');
}

function summaryRows(report: RunReport, kind: 'quality' | 'usage'): string[] {
  const variants = variantNames(report);
  const byVariant = new Map(variants.map((variant) => [variant, aggregateVariant(report, variant)]));
  const keys: AggregateValue[] = [];
  for (const variant of variants) {
    for (const aggregate of byVariant.get(variant) ?? []) {
      if (aggregate.kind === kind && !keys.some((entry) => entry.key === aggregate.key)) keys.push(aggregate);
    }
  }
  // A gate every run passed adds nothing next to "Runs with a failed gate"; `completed` always shows.
  const alwaysPassed = (key: string) => variants.every((variant) => (byVariant.get(variant)?.find((entry) => entry.key === key)?.value ?? 1) >= 1);
  return keys
    .filter((aggregate) => !aggregate.key.startsWith('gate.') || aggregate.key === 'gate.completed' || !alwaysPassed(aggregate.key))
    .map((aggregate) => {
      const cells = variants.map((variant) => {
        const value = byVariant.get(variant)?.find((entry) => entry.key === aggregate.key);
        if (!value || value.value === null) return '–';
        const affected = value.affected !== undefined && value.value > 0 && value.aggregate === 'sum' && !aggregate.key.startsWith('runs.') && !aggregate.key.startsWith('gates.')
          ? ` (${formatValue(value.affected, 'count')} case${value.affected === 1 ? '' : 's'})`
          : '';
        return `${formatValue(value.value, value.unit)}${affected}${formatSpread(value.spread, value.unit)}`;
      });
      return `| ${cell(aggregate.label)} | ${cells.join(' | ')} |`;
    });
}

function usageNotes(report: RunReport): string[] {
  const merged = mergeSummaries(report.runs.map((run) => run.llm));
  const notes: string[] = [];
  if (merged.errors > 0) {
    notes.push(`${merged.errors} LLM call(s) failed. Failed calls report no usage, but the provider may still have billed them; reconcile with the provider's own records before quoting a cost.`);
  }
  if (merged.modelMismatches.length > 0) {
    notes.push(`The provider answered with a different model than requested: ${merged.modelMismatches.join('; ')}. Check that the comparison measured the model you meant.`);
  }
  if (merged.reasoningTokens > 0 && merged.costUsd === null) {
    notes.push(`Calls used ${merged.reasoningTokens} hidden reasoning tokens and no billed cost was reported. Estimates from visible output under-count; use the upper bound.`);
  }
  if (merged.calls > 0 && merged.costUsd === null && merged.estimatedCostUsd === null) {
    notes.push('No cost was reported or estimated. Report billed cost from your client, or add `pricing` to the config for list-price estimates.');
  }
  return notes;
}

function agentRows(report: RunReport): string[] {
  const rows: string[] = [];
  for (const variant of variantNames(report)) {
    const runs = report.runs.filter((run) => run.variant === variant);
    const agents = [...new Set(runs.flatMap((run) => Object.keys(run.llmByAgent)))].sort();
    for (const agent of agents) {
      const summary: LlmSummary = mergeSummaries(runs.map((run) => run.llmByAgent[agent]).filter((entry): entry is LlmSummary => Boolean(entry)));
      const cost = summary.costUsd !== null ? formatValue(summary.costUsd, 'usd') : summary.estimatedCostUsd !== null ? `~${formatValue(summary.estimatedCostUsd, 'usd')}–${formatValue(summary.estimatedCostUpperUsd, 'usd')}` : '–';
      rows.push(`| ${variant} | ${agent} | ${summary.calls} | ${summary.errors} | ${summary.promptTokens} | ${summary.completionTokens} | ${summary.reasoningTokens} | ${formatValue(summary.totalMs, 'ms')} | ${formatValue(summary.maxMs, 'ms')} | ${cost} | ${cell(Object.keys(summary.models).join(', '))} |`);
    }
  }
  return rows;
}

export function buildRunMarkdown(report: RunReport): string {
  const variants = variantNames(report);
  const caseIds = [...new Set(report.runs.map((run) => run.caseId))];
  const wallSeconds = (Date.parse(report.finishedIso) - Date.parse(report.startedIso)) / 1000;
  const lines: string[] = [
    `# ${report.name ?? 'Eval'} — run ${report.label ?? report.startedIso}`,
    '',
    `- Case set: \`${report.caseSet}\` (${caseIds.length} cases) · variants: ${variants.join(', ')} · samples: ${report.samples}`,
    `- Started ${report.startedIso}, wall time ${Number.isFinite(wallSeconds) ? wallSeconds.toFixed(1) : '?'} s`,
    ...(report.git ? [`- Commit: \`${report.git.commit.slice(0, 12)}\`${report.git.dirty ? ' (uncommitted changes)' : ''}`] : []),
    `- Checks: ${report.checks.map((spec) => (typeof spec === 'string' ? spec : spec.check)).join(', ')}`,
    ...(report.judge ? [`- Judge: \`${report.judge.model}\`, ${report.judge.passes} pass(es), scored ${report.judge.judgedAtIso}${report.judge.judgedFromIso ? ` from the run of ${report.judge.judgedFromIso}` : ''}`] : []),
    ...(report.rescoredFromIso ? [`- Re-scored ${report.rescoredAtIso} from the run of ${report.rescoredFromIso}`] : []),
    `- ${report.tool.name} ${report.tool.version}`,
  ];

  if (!recordedLlmCalls(report)) {
    lines.push('', '> **Smoke run.** No LLM calls were recorded, so this run exercised the deterministic path only. It tests the harness, not output quality.');
  }
  if (report.caseSet === 'holdout') {
    lines.push('', '> **Hold-out run, for acceptance only.** Do not tune prompts, rules or thresholds against these outputs. If you read an output to diagnose a problem, record it with `aieval holdout seen <case> --note "..."` and add fresh hold-out cases before the next acceptance run.');
  }
  if (report.holdoutSeen?.length) {
    lines.push('', `> Hold-out cases no longer blind: ${report.holdoutSeen.map((entry) => `\`${entry.caseId}\` (${entry.entries.map((seen) => `${seen.date}: ${seen.note}`).join('; ')})`).join(', ')}.`);
  }

  const runsWithFailedGates = report.runs.filter((run) => Object.values(run.gates).some((gate) => !gate.pass));
  lines.push('', '## Gates', '');
  if (runsWithFailedGates.length === 0) {
    lines.push(`All ${report.runs.length} runs passed every gate.`);
  } else {
    lines.push('A failed gate means the output is unusable in this runtime, however good its text reads.', '');
    const labels = [...new Set(report.runs.map((run) => runLabel(run, report.samples)))];
    lines.push(`| Case | ${labels.join(' | ')} |`, `|---|${labels.map(() => '---').join('|')}|`);
    for (const caseId of caseIds) {
      const cells = labels.map((label) => {
        const run = report.runs.find((entry) => entry.caseId === caseId && runLabel(entry, report.samples) === label);
        return run ? gateSummary(run) : '–';
      });
      lines.push(`| ${caseId} | ${cells.map(cell).join(' | ')} |`);
    }
  }

  lines.push('', '## Summary', '', `| Metric | ${variants.join(' | ')} |`, `|---|${variants.map(() => '---').join('|')}|`, ...summaryRows(report, 'quality'));
  lines.push('', '### Cost and latency', '', `| Metric | ${variants.join(' | ')} |`, `|---|${variants.map(() => '---').join('|')}|`, ...summaryRows(report, 'usage'));
  const notes = usageNotes(report);
  if (notes.length > 0) lines.push('', ...notes.map((note) => `- ${note}`));

  lines.push(
    '',
    '## Per case',
    '',
    '| Case | Run | Status | Gates | Flags | Traceable / carried | LLM calls | Tokens in/out | Time | Judge |',
    '|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const run of report.runs) {
    lines.push(`| [${run.caseId}](${artifactLink(report, run)}) | ${runLabel(run, report.samples)} | ${run.status}${run.error ? `: ${cell(truncate(run.error, 60))}` : ''} | ${cell(gateSummary(run))} | ${cell(flags(run))} | ${cell(coverage(run))} | ${run.llm.calls} | ${run.llm.promptTokens}/${run.llm.completionTokens} | ${formatValue(run.durationMs, 'ms')} | ${judgeCell(run)} |`);
  }

  const trapRuns = report.runs.filter((run) => run.traps.length > 0);
  if (trapRuns.length > 0) {
    const labels = [...new Set(report.runs.map((run) => runLabel(run, report.samples)))];
    lines.push('', '## Traps', '', `| Case | Trap | ${labels.join(' | ')} |`, `|---|---|${labels.map(() => '---').join('|')}|`);
    for (const caseId of caseIds) {
      const trapIds = [...new Set(trapRuns.filter((run) => run.caseId === caseId).flatMap((run) => run.traps.map((trap) => trap.id)))];
      for (const trapId of trapIds) {
        const cells = labels.map((label) => {
          const trap = report.runs.find((run) => run.caseId === caseId && runLabel(run, report.samples) === label)?.traps.find((entry) => entry.id === trapId);
          return trap ? (trap.pass ? 'pass' : `**FAIL** ${trap.detail ?? ''}`) : '–';
        });
        lines.push(`| ${caseId} | ${trapId} | ${cells.map(cell).join(' | ')} |`);
      }
    }
  }

  const flagged = report.runs.filter((run) => run.measurements.some((measurement) => (measurement.examples?.length ?? 0) > 0 && (measurement.value ?? 0) > 0 && measurement.better === 'lower'));
  if (flagged.length > 0) {
    lines.push('', '## Flagged lines', '');
    for (const run of flagged) {
      lines.push(`### ${run.caseId} — ${runLabel(run, report.samples)}`, '');
      for (const measurement of run.measurements.filter((entry) => (entry.examples?.length ?? 0) > 0 && (entry.value ?? 0) > 0 && entry.better === 'lower')) {
        lines.push(`- ${measurement.label} (${formatValue(measurement.value, measurement.unit)}):`);
        for (const example of measurement.examples ?? []) lines.push(`  - ${truncate(example.replace(/\s+/g, ' '), 300)}`);
      }
      lines.push('');
    }
  }

  const agents = agentRows(report);
  if (agents.length > 0) {
    lines.push('', '## LLM usage by agent', '', '| Variant | Agent | Calls | Errors | Prompt tok | Completion tok | Reasoning tok | Time | Slowest call | Cost | Served by |', '|---|---|---|---|---|---|---|---|---|---|---|', ...agents);
  }

  if (report.judge?.noise) {
    lines.push('', '## Judge noise', '', `Spread of each dimension's mean across ${report.judge.passes} passes over identical outputs. Treat smaller differences between runs as no change.`, '');
    lines.push(...Object.entries(report.judge.noise).map(([dimension, noise]) => `- ${dimension}: ±${noise.toFixed(2)}`));
  }
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------ per output */

export function buildOutputMarkdown(report: Pick<RunReport, 'samples'>, run: CaseRun, result: AppResult | undefined): string {
  const agentCalls = Object.entries(run.llmByAgent).map(([agent, summary]) => `${agent}×${summary.calls}`).join(', ');
  const lines = [
    `# ${run.caseId} — ${run.variant} (sample ${run.sample})`,
    '',
    `- Status: ${run.status === 'ok' ? 'ok' : `**${run.status}**${run.error ? ` — ${run.error}` : ''}`}`,
    `- Time: ${formatValue(run.durationMs, 'ms')} · LLM calls: ${run.llm.calls}${agentCalls ? ` (${agentCalls})` : ''} · tokens: in ${run.llm.promptTokens}, out ${run.llm.completionTokens} (reasoning ${run.llm.reasoningTokens})${run.llm.costUsd !== null ? ` · billed ${formatValue(run.llm.costUsd, 'usd')}` : ''}`,
    ...(run.stages ? [`- Stages: ${Object.entries(run.stages).map(([name, stage]) => `${name}=${stage.mode}${stage.attempts && stage.attempts > 1 ? `(${stage.attempts})` : ''}`).join(', ')}`] : []),
    `- Gates: ${gateSummary(run)}`,
    '',
    '## Local checks',
    '',
    'These only rule out obvious failures. They cannot tell you which output is better; read the outputs side by side for that.',
    '',
    '| Check | Value | Examples |',
    '|---|---|---|',
    ...run.measurements.map((measurement) => `| ${cell(measurement.label)} | ${formatValue(measurement.value, measurement.unit)} | ${cell((measurement.examples ?? []).map((example) => truncate(example, 160)).join(' · '))} |`),
  ];
  if (run.traps.length > 0) {
    lines.push('', '## Traps', '', ...run.traps.map((trap) => `- ${trap.pass ? 'pass' : '**FAIL**'} \`${trap.id}\`: ${trap.description}${trap.detail ? ` — ${trap.detail}` : ''}`));
  }
  if (run.judge) {
    lines.push('', '## Judge', '', ...Object.entries(run.judge.scores).map(([dimension, score]) => `- ${dimension}: ${score ?? '–'}`), ...(run.judge.comments ? ['', `> ${run.judge.comments}`] : []));
  }
  const text = result ? (typeof result.text === 'string' ? result.text : typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2)) : '';
  lines.push('', '## Output', '', text.trim().length > 0 ? text.trim() : '_(empty)_', '');
  return lines.join('\n');
}

/* ----------------------------------------------------------------- inputs */

function inputBlock(value: unknown): string {
  if (typeof value === 'string') return ['````text', value.trimEnd(), '````'].join('\n');
  return ['````json', JSON.stringify(value, null, 2), '````'].join('\n');
}

export function buildInputsMarkdown(cases: LoadedCase[], caseSet: string): string {
  const lines = ['# Inputs', '', `Every variant and sample received exactly these inputs (case set \`${caseSet}\`).`, ''];
  for (const loaded of cases) {
    lines.push(`## ${loaded.id}${loaded.title ? ` — ${loaded.title}` : ''}`, '');
    if (loaded.tags?.length) lines.push(`Tags: ${loaded.tags.join(', ')}`, '');
    if (loaded.notes) lines.push(`Notes: ${loaded.notes}`, '');
    for (const [name, value] of Object.entries(loaded.inputs)) lines.push(`### ${name}`, '', inputBlock(value), '');
  }
  return lines.join('\n');
}

/* ----------------------------------------------------------------- review */

export function buildReviewMarkdown(report: RunReport, cases: LoadedCase[]): string {
  const lines = [
    `# Human review — ${report.name ?? 'eval'} run ${report.label ?? report.startedIso}`,
    '',
    'Open the outputs of one case side by side and answer the questions below. The local checks at the top of each output only rule out obviously broken outputs; they cannot say which one is better. Inputs are in [inputs.md](inputs.md).',
    '',
  ];
  if (report.caseSet === 'holdout') {
    lines.push('> Hold-out outputs: reading them makes these cases no longer blind. Record it with `aieval holdout seen <case> --note "..."`.', '');
  }
  for (const loaded of cases) {
    const runs = report.runs.filter((run) => run.caseId === loaded.id);
    if (runs.length === 0) continue;
    lines.push(`## ${loaded.id}${loaded.title ? ` — ${loaded.title}` : ''}`, '');
    lines.push(`Outputs: ${runs.map((run) => `[${runLabel(run, report.samples)}](${artifactLink(report, run)})`).join(' · ')}`, '');
    const questions: string[] = [];
    for (const trap of loaded.traps ?? []) {
      const results = runs.map((run) => {
        const result = run.traps.find((entry) => entry.id === trap.id);
        return `${runLabel(run, report.samples)} ${result ? (result.pass ? 'pass' : 'FAIL') : '–'}`;
      });
      questions.push(`${trap.review ?? trap.description} _(trap \`${trap.id}\`: ${results.join(', ')})_`);
    }
    questions.push(...(loaded.review ?? []));
    if (questions.length === 0) questions.push('Is every claim supported by the inputs, and does the output do what the user asked?');
    lines.push(...questions.map((question, index) => `${index + 1}. [ ] ${question}`), '');
  }
  lines.push(
    '## Findings',
    '',
    '_Conclusion first: which variant you would ship and why, with the evidence (case, file, the line that decides it). Separate structural differences (seen in every sample) from one-off ones._',
    '',
    '## Not verified',
    '',
    '_Say plainly what this run did not test: samples per cell, input lengths and kinds it never saw, providers or endpoints not covered, steps checked by inference rather than directly._',
    '',
  );
  return lines.join('\n');
}

