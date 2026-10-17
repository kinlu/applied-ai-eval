/**
 * `aieval run`: every selected variant × sample × case through the app, each
 * output measured, and everything written to one run directory:
 *
 *   <reports>/<timestamp>[-holdout][-label]/
 *     report.json   machine-readable results (what `compare` reads)
 *     report.md     the results for people
 *     inputs.md     the exact inputs every variant received
 *     review.md     the human review checklist
 *     artifacts/<case>/<variant>-s<sample>.{json,md}   every output, kept for re-scoring and judging
 */
import { join, resolve } from 'node:path';
import { createAppRunner } from './adapters.js';
import { parseCheckSpec, DEFAULT_CHECKS } from './checks/index.js';
import { loadCases } from './cases.js';
import { loadConfig, selectVariants } from './config.js';
import { scoreRuns } from './judge.js';
import { measureResult } from './measure.js';
import { buildInputsMarkdown, buildOutputMarkdown, buildReviewMarkdown, buildRunMarkdown } from './report.js';
import { normalizeResult } from './segment.js';
import { summarizeByAgent, summarizeCalls } from './telemetry.js';
import type { AppContext, AppResult, CaseRun, EvalConfig, LlmCallRecord, LoadedCase, RunArtifact, RunReport, VariantRef } from './types.js';
import { TOOL } from './version.js';
import { errorMessage, gitState, runPool, timestampSlug, writeJson, writeText } from './util.js';

export interface RunOptions {
  /** Config file; defaults to eval.config.mjs (or .js / .json) in `cwd`. */
  config?: string;
  cwd?: string;
  /** Run the hold-out set instead of the tuning cases. */
  holdout?: boolean;
  caseIds?: string[];
  tags?: string[];
  /** Variant names, or ["all"]; defaults to the first configured variant. */
  variants?: string[];
  /** Runs per case and variant; use 2 or more to tell real differences from sampling noise. */
  samples?: number;
  label?: string;
  concurrency?: number;
  timeoutMs?: number;
  /** Score every output with the configured LLM judge after the run. */
  judge?: boolean;
  /** Parent directory for the run directory; defaults to the config's `reports`. */
  reportsDir?: string;
  log?: (line: string) => void;
}

export interface RunOutcome {
  runDir: string;
  report: RunReport;
}

/** Fails fast when a config or case names an input a case does not have. */
export function validateInputNames(cases: LoadedCase[], config: EvalConfig): void {
  const optionNames = (config.checks ?? []).flatMap((spec) => {
    const { options } = parseCheckSpec(spec);
    return [options.sources, options.echoOf].filter((value): value is string[] => Array.isArray(value)).flat();
  });
  for (const loaded of cases) {
    const named = [
      ...(config.sources ?? []), ...(config.echoOf ?? []), ...(loaded.sources ?? []), ...(loaded.echoOf ?? []), ...optionNames,
    ];
    const missing = [...new Set(named.filter((name) => !(name in loaded.inputs)))];
    if (missing.length > 0) {
      throw new Error(`Case "${loaded.id}" has no input named ${missing.map((name) => `"${name}"`).join(', ')} (its inputs: ${Object.keys(loaded.inputs).join(', ')})`);
    }
  }
}

class RunTimeout extends Error {}

async function runOne(
  app: Awaited<ReturnType<typeof createAppRunner>>,
  loaded: LoadedCase,
  variant: VariantRef,
  sample: number,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<{ result: AppResult; calls: LlmCallRecord[]; status: CaseRun['status']; error?: string; durationMs: number }> {
  const calls: LlmCallRecord[] = [];
  const controller = new AbortController();
  const ctx: AppContext = {
    signal: controller.signal,
    recordLlmCall: (call) => calls.push(call),
    log: (message) => log(`    [${loaded.id} ${variant.name} s${sample}] ${message}`),
  };
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new RunTimeout(`timed out after ${timeoutMs} ms`));
      reject(new RunTimeout(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const raw = await Promise.race([app({ caseId: loaded.id, inputs: loaded.inputs, variant, sample }, ctx), timeout]);
    return { result: normalizeResult(raw), calls, status: 'ok', durationMs: Date.now() - started };
  } catch (error) {
    const status = error instanceof RunTimeout ? 'timeout' : 'error';
    return { result: { output: '' }, calls, status, error: errorMessage(error), durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

function storableResult(result: AppResult): AppResult {
  const { files, ...rest } = result;
  return files ? { ...rest, files: Object.fromEntries(Object.keys(files).map((name) => [name, `<file ${name}>`])) } : rest;
}

export async function runEval(options: RunOptions = {}): Promise<RunOutcome> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const loaded = await loadConfig(options.config, options.cwd);
  const { config } = loaded;
  if (options.judge && !config.judge) throw new Error('--judge needs a `judge` section in the config');
  const caseSet = options.holdout ? 'holdout' : 'cases';
  const cases = loadCases(options.holdout ? loaded.holdoutDir : loaded.casesDir, caseSet, { ids: options.caseIds, tags: options.tags });
  if (cases.length === 0) throw new Error('No cases matched.');
  validateInputNames(cases, config);
  const variants = selectVariants(config, options.variants);
  const samples = options.samples ?? 1;
  if (!Number.isInteger(samples) || samples < 1) throw new Error('--samples must be a positive integer');
  const timeoutMs = options.timeoutMs ?? config.timeoutMs ?? 600_000;
  const app = await createAppRunner(config.app, loaded.dir);

  const startedIso = new Date().toISOString();
  const label = options.label?.replace(/[^A-Za-z0-9._-]+/g, '-');
  const runDir = resolve(options.reportsDir ?? loaded.reportsDir, `${timestampSlug(startedIso)}${options.holdout ? '-holdout' : ''}${label ? `-${label}` : ''}`);
  const artifactsDir = join(runDir, 'artifacts');
  const total = variants.length * samples * cases.length;
  log(`Running ${cases.length} case(s) × ${variants.length} variant(s) × ${samples} sample(s) from ${caseSet} → ${runDir}`);

  // Variant by variant, sample by sample, case by case: the order runs appear in the report.
  const plan = variants.flatMap((variant) => Array.from({ length: samples }, (_, index) => index + 1)
    .flatMap((sample) => cases.map((loadedCase) => ({ variant, sample, loadedCase }))));
  let done = 0;
  const results = new Map<string, AppResult>();

  const runCase = async ({ variant, sample, loadedCase }: (typeof plan)[number]): Promise<CaseRun> => {
    const outcome = await runOne(app, loadedCase, variant, sample, timeoutMs, log);
    let { status, error } = outcome;
    const calls = [...outcome.calls, ...(outcome.result.llmCalls ?? [])];
    let measured;
    try {
      measured = measureResult(loadedCase, outcome.result, config, status, error);
    } catch (measureError) {
      status = 'error';
      error = `measuring failed: ${errorMessage(measureError)}`;
      measured = measureResult(loadedCase, outcome.result, config, status, error);
    }
    const artifact = `${loadedCase.id}/${variant.name}-s${sample}`;
    const run: CaseRun = {
      caseId: loadedCase.id,
      ...(loadedCase.title ? { title: loadedCase.title } : {}),
      variant: variant.name,
      sample,
      ...(loadedCase.tags ? { tags: loadedCase.tags } : {}),
      inputHash: loadedCase.inputHash,
      status,
      ...(error ? { error } : {}),
      durationMs: outcome.durationMs,
      gates: measured.gates,
      traps: measured.traps,
      measurements: measured.measurements,
      ...(outcome.result.stages ? { stages: outcome.result.stages } : {}),
      llm: summarizeCalls(calls, config.pricing),
      llmByAgent: summarizeByAgent(calls, config.pricing),
      artifact,
    };

    const stored: RunArtifact = {
      caseId: run.caseId,
      variant: run.variant,
      sample,
      status,
      ...(error ? { error } : {}),
      result: storableResult({ ...outcome.result, llmCalls: calls }),
    };
    writeJson(join(artifactsDir, `${artifact}.json`), stored);
    for (const [name, content] of Object.entries(outcome.result.files ?? {})) {
      writeText(join(artifactsDir, `${artifact}.files`, name.replace(/[\\/]/g, '_')), content);
    }
    results.set(artifact, outcome.result);

    done += 1;
    const failedGates = Object.entries(run.gates).filter(([, gate]) => !gate.pass).map(([name]) => name);
    log(`  [${done}/${total}] ${loadedCase.id} · ${variant.name} s${sample} · ${status}${error ? ` (${error})` : ''}`
      + ` · ${(run.durationMs / 1000).toFixed(1)} s · ${run.llm.calls} LLM call(s)${failedGates.length ? ` · gates failed: ${failedGates.join(', ')}` : ''}`);
    return run;
  };
  const runs = await runPool(plan.map((job) => () => runCase(job)), options.concurrency ?? config.concurrency ?? 1);

  const git = gitState(loaded.dir);
  const holdoutSeen = caseSet === 'holdout'
    ? cases.filter((entry) => entry.seen?.length).map((entry) => ({ caseId: entry.id, entries: entry.seen! }))
    : [];
  let report: RunReport = {
    tool: TOOL,
    ...(config.name ? { name: config.name } : {}),
    ...(options.label ? { label: options.label } : {}),
    startedIso,
    finishedIso: new Date().toISOString(),
    caseSet,
    variants,
    samples,
    checks: config.checks ?? DEFAULT_CHECKS,
    ...(config.tolerances ? { tolerances: config.tolerances } : {}),
    ...(git ? { git } : {}),
    artifactsDir: 'artifacts',
    ...(holdoutSeen.length > 0 ? { holdoutSeen } : {}),
    runs,
  };

  if (options.judge) {
    log('Judging outputs…');
    report = await scoreRuns({
      report,
      cases: new Map(cases.map((entry) => [entry.id, entry])),
      config,
      loadResult: (run) => results.get(run.artifact) ?? null,
      passes: 1,
      log,
    });
  }

  for (const run of report.runs) {
    writeText(join(artifactsDir, `${run.artifact}.md`), buildOutputMarkdown(report, run, results.get(run.artifact)));
  }
  writeJson(join(runDir, 'report.json'), report);
  writeText(join(runDir, 'report.md'), buildRunMarkdown(report));
  writeText(join(runDir, 'inputs.md'), buildInputsMarkdown(cases, caseSet));
  writeText(join(runDir, 'review.md'), buildReviewMarkdown(report, cases));
  return { runDir, report };
}

