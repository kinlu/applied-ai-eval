#!/usr/bin/env node
/**
 * The `aieval` command line.
 */
import { realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compareRuns, formatComparisonMarkdown, loadSelected } from './compare.js';
import { loadConfig } from './config.js';
import { formatHoldoutStatus, holdoutStatus, markHoldoutSeen } from './holdout.js';
import { initProject } from './init.js';
import { judgeRunDir } from './judge.js';
import { rescoreRunDir } from './rescore.js';
import { runEval } from './runner.js';
import type { Tolerance } from './types.js';
import { TOOL } from './version.js';

const HELP = `aieval — evaluate an applied AI app on golden cases, then compare before you adopt a change

Usage:
  aieval run      [--config <file>] [--case a,b] [--tag t] [--holdout] [--variant a,b|all]
                  [--samples N] [--label name] [--judge] [--concurrency N] [--timeout ms] [--reports <dir>]
  aieval compare  <baseline-run>[#variant] <candidate-run>[#variant]
                  [--out compare.md] [--fail-on-regression] [--judge-noise 0.16] [--tolerance key=value]...
  aieval judge    <run> [--passes N] [--out <dir>] [--config <file>]
  aieval rescore  <run> [--out <dir>] [--config <file>]
  aieval holdout  status | seen <case> --note "why it was read"   [--config <file>]
  aieval init     [dir]

run      Runs every selected case × variant × sample through your app and writes
         <reports>/<timestamp>/ with report.json, report.md, inputs.md, review.md and artifacts/.
compare  Prints the before/after table with a verdict per metric. --fail-on-regression exits 1
         when a quality metric regressed beyond its noise (cost and latency are trade-offs, listed).
judge    Scores a finished run's saved outputs with the configured LLM judge into <run>-judged/.
         Judge baseline and candidate back to back; --passes 2 measures the judge's own noise.
rescore  Recomputes every check from saved outputs (new metric definitions or gold, no app calls).
holdout  Shows which hold-out cases are still blind, or records that one's outputs were read.
init     Writes eval.config.mjs, an adapter stub and an example case.

Docs: https://github.com/kinlu/applied-ai-eval`;

function list(values: string[] | undefined): string[] | undefined {
  const items = (values ?? []).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function integer(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function tolerances(values: string[] | undefined): Record<string, Tolerance> | undefined {
  if (!values?.length) return undefined;
  const parsed: Record<string, Tolerance> = {};
  for (const value of values) {
    const [key, raw] = value.split('=');
    if (!key || raw === undefined) throw new Error(`--tolerance expects key=value, got "${value}"`);
    if (/^\d+(?:\.\d+)?%$/.test(raw)) parsed[key] = raw as Tolerance;
    else if (Number.isFinite(Number(raw)) && Number(raw) >= 0) parsed[key] = Number(raw);
    else throw new Error(`--tolerance ${key}: "${raw}" is not a number or a percentage`);
  }
  return parsed;
}

async function run(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: 'string' },
      case: { type: 'string', multiple: true },
      tag: { type: 'string', multiple: true },
      holdout: { type: 'boolean' },
      variant: { type: 'string', multiple: true },
      samples: { type: 'string' },
      label: { type: 'string' },
      judge: { type: 'boolean' },
      concurrency: { type: 'string' },
      timeout: { type: 'string' },
      reports: { type: 'string' },
    },
  });
  const { runDir, report } = await runEval({
    config: values.config,
    holdout: values.holdout,
    caseIds: list(values.case),
    tags: list(values.tag),
    variants: list(values.variant),
    samples: integer(values.samples, '--samples'),
    label: values.label,
    judge: values.judge,
    concurrency: integer(values.concurrency, '--concurrency'),
    timeoutMs: integer(values.timeout, '--timeout'),
    reportsDir: values.reports ? resolve(values.reports) : undefined,
  });
  const failed = report.runs.filter((entry) => entry.status !== 'ok').length;
  const gateFailures = report.runs.filter((entry) => Object.values(entry.gates).some((gate) => !gate.pass)).length;
  process.stdout.write(`\n${report.runs.length} run(s): ${failed} failed, ${gateFailures} with a failed gate.\n`);
  if (!report.runs.some((entry) => entry.llm.calls > 0)) {
    process.stdout.write('No LLM calls were recorded: this was a smoke run of the deterministic path, not a quality signal.\n');
  }
  process.stdout.write(`Report: ${resolve(runDir, 'report.md')}\nReview checklist: ${resolve(runDir, 'review.md')}\nCompare: aieval compare <baseline-run> ${runDir}${report.variants.length > 1 ? '#<variant>' : ''}\n`);
  return 0;
}

async function compare(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      'fail-on-regression': { type: 'boolean' },
      'judge-noise': { type: 'string' },
      tolerance: { type: 'string', multiple: true },
    },
  });
  if (positionals.length !== 2) throw new Error('compare needs a baseline and a candidate run, e.g. aieval compare eval/reports/A eval/reports/B');
  let baseline = loadSelected(positionals[0]);
  let candidate = loadSelected(positionals[1]);
  if (baseline.label === candidate.label) {
    baseline = { ...baseline, label: 'baseline' };
    candidate = { ...candidate, label: 'candidate' };
  }
  const judgeNoise = values['judge-noise'] === undefined ? undefined : Number(values['judge-noise']);
  if (judgeNoise !== undefined && !(judgeNoise >= 0)) throw new Error('--judge-noise must be a non-negative number');
  const comparison = compareRuns(baseline, candidate, { tolerances: tolerances(values.tolerance), ...(judgeNoise !== undefined ? { judgeNoise } : {}) });
  const markdown = formatComparisonMarkdown(comparison);
  if (values.out) {
    writeFileSync(resolve(values.out), markdown);
    process.stderr.write(`Comparison written to ${resolve(values.out)}\n`);
  }
  process.stdout.write(markdown);
  return values['fail-on-regression'] && comparison.regressions.length > 0 ? 1 : 0;
}

async function judge(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { config: { type: 'string' }, passes: { type: 'string' }, out: { type: 'string' } },
  });
  if (positionals.length !== 1) throw new Error('judge needs one run directory');
  const { outDir } = await judgeRunDir({ runDir: positionals[0], config: values.config, passes: integer(values.passes, '--passes'), out: values.out });
  process.stdout.write(`Judged report: ${resolve(outDir, 'report.md')}\n`);
  return 0;
}

async function rescore(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { config: { type: 'string' }, out: { type: 'string' } },
  });
  if (positionals.length !== 1) throw new Error('rescore needs one run directory');
  const { outDir } = await rescoreRunDir({ runDir: positionals[0], config: values.config, out: values.out });
  process.stdout.write(`Re-scored report: ${resolve(outDir, 'report.md')}\n`);
  return 0;
}

async function holdout(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { config: { type: 'string' }, note: { type: 'string' } },
  });
  const loaded = await loadConfig(values.config);
  const [action, caseId] = positionals;
  if (action === 'status' || action === undefined) {
    process.stdout.write(`${formatHoldoutStatus(holdoutStatus(loaded))}\n`);
    return 0;
  }
  if (action === 'seen') {
    if (!caseId) throw new Error('holdout seen needs a case id');
    const entry = markHoldoutSeen(loaded, caseId, values.note ?? '');
    process.stdout.write(`Recorded in ${caseId}/case.json: ${entry.date}: ${entry.note}\nThis case is no longer blind. Add a fresh hold-out case before the next acceptance run.\n`);
    return 0;
  }
  throw new Error(`Unknown holdout action "${action}" (use status or seen)`);
}

function init(args: string[]): number {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const dir = resolve(positionals[0] ?? '.');
  const { created, skipped } = initProject(dir);
  for (const file of created) process.stdout.write(`created ${file}\n`);
  for (const file of skipped) process.stdout.write(`kept existing ${file}\n`);
  process.stdout.write('\nNext: point eval/app-adapter.mjs at your pipeline, write cases under eval/cases/, then run `aieval run`.\n');
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  switch (command) {
    case 'run': return run(args);
    case 'compare': return compare(args);
    case 'judge': return judge(args);
    case 'rescore': return rescore(args);
    case 'holdout': return holdout(args);
    case 'init': return init(args);
    case '--version':
    case '-v':
      process.stdout.write(`${TOOL.version}\n`);
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${HELP}\n`);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}\n`);
      return 1;
  }
}

function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`aieval: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
