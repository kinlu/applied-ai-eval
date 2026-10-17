/**
 * LLM-as-judge rubric scoring, inline (`aieval run --judge`) or post hoc
 * (`aieval judge <run>`).
 *
 * Judge scores move between passes even on identical outputs, and they drift
 * between provider windows. So: keep the judge model fixed across the runs
 * you compare, judge baseline and candidate back to back from their saved
 * artifacts instead of trusting scores taken hours apart, and measure the
 * judge's own noise with `--passes 2` before reading a small difference as
 * real.
 */
import { relative, resolve } from 'node:path';
import { inputText } from './checks/index.js';
import { loadCases } from './cases.js';
import { loadConfig } from './config.js';
import { createLlmClient, parseJsonReply, type LlmClient } from './llm.js';
import { buildRunMarkdown } from './report.js';
import { resultText } from './segment.js';
import { summarizeCalls } from './telemetry.js';
import type { AppResult, CaseRun, EvalConfig, JudgeConfig, JudgeScores, LlmCallRecord, LoadedCase, RunArtifact, RunReport } from './types.js';
import { mean, readJson, writeJson, writeText } from './util.js';

export const JUDGE_AGENT = 'judge';

export function judgeScale(judge: JudgeConfig): { min: number; max: number } {
  return judge.scale ?? { min: 1, max: 5 };
}

export function judgeSystemPrompt(judge: JudgeConfig): string {
  const { min, max } = judgeScale(judge);
  return [
    judge.instructions ?? "You are a strict, consistent evaluator of an AI application's output.",
    `Score the output on each dimension with an integer from ${min} (poor) to ${max} (excellent). Judge the output against the inputs you are given; do not reward length or confident tone.`,
    ...judge.dimensions.map((dimension) => `- ${dimension.key}: ${dimension.description}`),
    `Return ONLY a JSON object: {${judge.dimensions.map((dimension) => `"${dimension.key}": <${min}-${max}>`).join(', ')}, "comments": "<one short paragraph>"}`,
  ].join('\n');
}

/** Every input under its name, then the output text. */
export function defaultJudgeRender({ case: loaded, text }: { case: LoadedCase; text: string }): string {
  const inputs = Object.entries(loaded.inputs).map(([name, value]) => `## Input: ${name}\n\n${inputText(value)}`);
  return [...inputs, `## Output to score\n\n${text}`].join('\n\n');
}

export function parseJudgeReply(raw: string, judge: JudgeConfig): JudgeScores {
  const parsed = parseJsonReply(raw) as Record<string, unknown>;
  const { min, max } = judgeScale(judge);
  const scores: Record<string, number | null> = {};
  for (const { key } of judge.dimensions) {
    const value = typeof parsed[key] === 'string' ? Number(parsed[key]) : parsed[key];
    scores[key] = typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : null;
  }
  return { scores, ...(typeof parsed.comments === 'string' && parsed.comments.trim() ? { comments: parsed.comments.trim() } : {}) };
}

export interface JudgeClient {
  client: LlmClient;
  model: string;
}

/** The judge client from the environment: AIEVAL_JUDGE_MODEL (or `judge.model`) plus an API key. */
export function judgeClientFromEnv(judge: JudgeConfig, onCall: (record: LlmCallRecord) => void, env: NodeJS.ProcessEnv = process.env): JudgeClient | null {
  const model = env.AIEVAL_JUDGE_MODEL?.trim() || judge.model;
  const apiKey = env[judge.apiKeyEnv ?? 'AIEVAL_JUDGE_API_KEY']?.trim() || env.OPENAI_API_KEY?.trim();
  if (!model || !apiKey) return null;
  const baseUrl = env.AIEVAL_JUDGE_BASE_URL?.trim() || judge.baseUrl || env.OPENAI_BASE_URL?.trim();
  return { model, client: createLlmClient({ model, apiKey, ...(baseUrl ? { baseUrl } : {}), timeoutMs: judge.timeoutMs ?? 120_000, onCall }) };
}

export async function judgeOnce(client: LlmClient, judge: JudgeConfig, loaded: LoadedCase, result: AppResult): Promise<JudgeScores | null> {
  const text = resultText(result);
  const user = (judge.render ?? defaultJudgeRender)({ case: loaded, result, text });
  try {
    const reply = await client.chat({
      agent: JUDGE_AGENT,
      messages: [{ role: 'system', content: judgeSystemPrompt(judge) }, { role: 'user', content: user }],
      temperature: judge.temperature ?? 0,
      maxTokens: judge.maxTokens ?? 1000,
      json: true,
    });
    const scores = parseJudgeReply(reply.text, judge);
    return Object.values(scores.scores).some((score) => score !== null) ? scores : null;
  } catch {
    return null;
  }
}

/** Mean per dimension over the passes that answered; null when none did. */
export function averageScores(passes: Array<JudgeScores | null>, dimensions: string[]): JudgeScores | null {
  const answered = passes.filter((entry): entry is JudgeScores => entry !== null);
  if (answered.length === 0) return null;
  const scores: Record<string, number | null> = {};
  for (const dimension of dimensions) {
    scores[dimension] = mean(answered.map((entry) => entry.scores[dimension]).filter((score): score is number => typeof score === 'number'));
  }
  const comments = answered.find((entry) => entry.comments)?.comments;
  return { scores, ...(comments ? { comments } : {}), passes: answered.length };
}

/** For each dimension, max − min of its mean across passes: how far the judge moves on identical outputs. */
export function judgeNoise(passMeans: Array<Record<string, number | null>>, dimensions: string[]): Record<string, number> {
  const noise: Record<string, number> = {};
  for (const dimension of dimensions) {
    const values = passMeans.map((entry) => entry[dimension]).filter((value): value is number => typeof value === 'number');
    noise[dimension] = values.length > 1 ? Math.max(...values) - Math.min(...values) : 0;
  }
  return noise;
}

export interface ScoreRunsOptions {
  report: RunReport;
  cases: Map<string, LoadedCase>;
  config: EvalConfig;
  loadResult: (run: CaseRun) => AppResult | null;
  passes: number;
  judgedFromIso?: string;
  /** Injected for tests; defaults to judgeClientFromEnv. */
  client?: JudgeClient;
  log?: (line: string) => void;
}

/** A copy of `report` with every successful run scored; failed runs and runs without artifacts get no score. */
export async function scoreRuns(options: ScoreRunsOptions): Promise<RunReport> {
  const judge = options.config.judge;
  if (!judge) throw new Error('The config has no `judge` section');
  const calls: LlmCallRecord[] = [];
  const judgeClient = options.client ?? judgeClientFromEnv(judge, (record) => calls.push(record));
  if (!judgeClient) throw new Error('Judging needs a judge model (AIEVAL_JUDGE_MODEL or judge.model) and an API key (AIEVAL_JUDGE_API_KEY or OPENAI_API_KEY)');
  const dimensions = judge.dimensions.map((dimension) => dimension.key);
  const passes = Math.max(1, Math.floor(options.passes));
  const log = options.log ?? (() => undefined);

  const perRun = new Map<string, Array<JudgeScores | null>>();
  const passMeans: Array<Record<string, number | null>> = [];
  for (let pass = 1; pass <= passes; pass += 1) {
    const passScores: JudgeScores[] = [];
    for (const run of options.report.runs) {
      if (run.status !== 'ok') continue;
      const loaded = options.cases.get(run.caseId);
      const result = options.loadResult(run);
      if (!loaded || !result) continue;
      const scores = await judgeOnce(judgeClient.client, judge, loaded, result);
      perRun.set(run.artifact, [...(perRun.get(run.artifact) ?? []), scores]);
      if (scores) passScores.push(scores);
      log(`  judge pass ${pass}: ${run.caseId} · ${run.variant} s${run.sample} · ${scores ? dimensions.map((dimension) => scores.scores[dimension] ?? '?').join('/') : 'FAILED'}`);
    }
    passMeans.push(Object.fromEntries(dimensions.map((dimension) => [dimension, mean(passScores.map((entry) => entry.scores[dimension]).filter((score): score is number => typeof score === 'number'))])));
  }

  const runs = options.report.runs.map((run) => {
    const { judge: _previous, ...rest } = run;
    const scores = perRun.get(run.artifact);
    return scores ? { ...rest, judge: averageScores(scores, dimensions) } : rest;
  });
  return {
    ...options.report,
    judge: {
      model: judgeClient.model,
      dimensions,
      judgedAtIso: new Date().toISOString(),
      ...(options.judgedFromIso ? { judgedFromIso: options.judgedFromIso } : {}),
      passes,
      ...(passes > 1 ? { noise: judgeNoise(passMeans, dimensions) } : {}),
      usage: summarizeCalls(calls, options.config.pricing),
    },
    runs,
  };
}

export function loadArtifact(runDir: string, report: RunReport, run: CaseRun): RunArtifact | null {
  try {
    return readJson<RunArtifact>(resolve(runDir, report.artifactsDir, `${run.artifact}.json`));
  } catch {
    return null;
  }
}

/** Loads the current cases of a run's case set by id, warning about cases whose inputs changed since the run. */
export function casesForRun(casesDir: string, holdoutDir: string, report: RunReport, warn: (line: string) => void): Map<string, LoadedCase> {
  const cases = loadCases(report.caseSet === 'holdout' ? holdoutDir : casesDir, report.caseSet);
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  for (const id of new Set(report.runs.map((run) => run.caseId))) {
    const loaded = byId.get(id);
    const run = report.runs.find((entry) => entry.caseId === id)!;
    if (!loaded) warn(`warning: case "${id}" no longer exists; its runs are kept as they were`);
    else if (loaded.inputHash !== run.inputHash) warn(`warning: the inputs of case "${id}" changed since the run; scores use the current case files`);
  }
  return byId;
}

export interface JudgeRunDirOptions {
  runDir: string;
  config?: string;
  cwd?: string;
  passes?: number;
  out?: string;
  log?: (line: string) => void;
}

/** `aieval judge <run>`: scores a finished run's saved outputs into `<run>-judged/`, leaving the run untouched. */
export async function judgeRunDir(options: JudgeRunDirOptions): Promise<{ outDir: string; report: RunReport }> {
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const runDir = resolve(options.cwd ?? process.cwd(), options.runDir);
  const report = readJson<RunReport>(resolve(runDir, 'report.json'));
  const loaded = await loadConfig(options.config, options.cwd);
  const cases = casesForRun(loaded.casesDir, loaded.holdoutDir, report, log);
  const outDir = resolve(options.cwd ?? process.cwd(), options.out ?? `${runDir.replace(/\/+$/, '')}-judged`);
  log(`Judging ${report.runs.length} run(s) from ${runDir}`);
  const judged = await scoreRuns({
    report,
    cases,
    config: loaded.config,
    loadResult: (run) => loadArtifact(runDir, report, run)?.result ?? null,
    passes: options.passes ?? 1,
    judgedFromIso: report.startedIso,
    log,
  });
  judged.artifactsDir = relative(outDir, resolve(runDir, report.artifactsDir)) || '.';
  writeJson(resolve(outDir, 'report.json'), judged);
  writeText(resolve(outDir, 'report.md'), buildRunMarkdown(judged));
  return { outDir, report: judged };
}
