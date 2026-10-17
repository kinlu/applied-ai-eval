import { cpSync, existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { compareRuns, loadSelected } from '../src/compare.js';
import { loadConfig } from '../src/config.js';
import { holdoutStatus, markHoldoutSeen } from '../src/holdout.js';
import { initProject } from '../src/init.js';
import { judgeRunDir } from '../src/judge.js';
import { rescoreRunDir } from '../src/rescore.js';
import { runEval } from '../src/runner.js';
import type { RunArtifact, RunReport } from '../src/types.js';
import { tempDir, writeTree } from './helpers.js';

const EXAMPLE = resolve(import.meta.dirname, '../examples/support-reply');
const quiet = () => undefined;

describe('the support-reply example, offline', () => {
  let runDir: string;
  let report: RunReport;

  beforeAll(async () => {
    ({ runDir, report } = await runEval({
      config: join(EXAMPLE, 'eval.config.mjs'),
      variants: ['baseline', 'friendly'],
      reportsDir: tempDir(),
      log: quiet,
    }));
  });

  it('writes the run directory', () => {
    for (const file of ['report.json', 'report.md', 'inputs.md', 'review.md']) expect(existsSync(join(runDir, file))).toBe(true);
    const artifact = JSON.parse(readFileSync(join(runDir, 'artifacts/refund-annual-after-six-weeks/friendly-s1.json'), 'utf8')) as RunArtifact;
    expect(artifact.result.output).toMatch(/Hi Priya/);
    expect(readFileSync(join(runDir, 'artifacts/refund-annual-after-six-weeks/friendly-s1.md'), 'utf8')).toMatch(/## Local checks/);
    expect(report.runs).toHaveLength(12);
    expect(report.caseSet).toBe('cases');
  });

  it('keeps the grounded baseline clean and catches the friendly prompt', () => {
    const failedGates = (variant: string) => report.runs.filter((run) => run.variant === variant && Object.values(run.gates).some((gate) => !gate.pass)).map((run) => run.caseId);
    expect(failedGates('baseline')).toEqual([]);
    expect(failedGates('friendly')).toEqual(['refund-annual-after-six-weeks']);
    const total = (variant: string, key: string) => report.runs
      .filter((run) => run.variant === variant)
      .reduce((sum, run) => sum + (run.measurements.find((entry) => entry.key === key)?.value ?? 0), 0);
    for (const key of ['numbers.untraceable', 'lines.unsupported', 'lines.echo', 'lines.nearDuplicates', 'traps.failed', 'carry.missing']) {
      expect(total('baseline', key), key).toBe(0);
    }
    expect(total('friendly', 'numbers.untraceable')).toBe(6);
    expect(total('friendly', 'lines.echo')).toBeGreaterThan(0);
  });

  it('marks the run as a smoke run and writes the review checklist', () => {
    expect(readFileSync(join(runDir, 'report.md'), 'utf8')).toMatch(/\*\*Smoke run\.\*\*/);
    const review = readFileSync(join(runDir, 'review.md'), 'utf8');
    expect(review).toMatch(/Must not agree that annual plans are refundable within 60 days\. _\(trap `accepts-false-claim`: baseline pass, friendly FAIL\)_/);
    expect(review).toMatch(/## Not verified/);
  });

  it('compares the variants and fails on regression only when asked', async () => {
    const comparison = compareRuns(loadSelected(`${runDir}#baseline`), loadSelected(`${runDir}#friendly`));
    expect(comparison.regressions.map((row) => row.key)).toEqual(expect.arrayContaining(['gates.failedRuns', 'numbers.untraceable', 'lines.echo', 'traps.failed']));
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await main(['compare', `${runDir}#baseline`, `${runDir}#friendly`, '--fail-on-regression'])).toBe(1);
      expect(await main(['compare', `${runDir}#baseline`, `${runDir}#friendly`])).toBe(0);
      expect(await main(['compare', `${runDir}#baseline`, `${runDir}#baseline`, '--fail-on-regression'])).toBe(0);
    } finally {
      write.mockRestore();
    }
  });

  it('re-scores saved outputs without calling the app', async () => {
    const { outDir, report: rescored } = await rescoreRunDir({ runDir, config: join(EXAMPLE, 'eval.config.mjs'), log: quiet });
    expect(outDir).toBe(`${runDir}-rescored`);
    expect(rescored.rescoredFromIso).toBe(report.startedIso);
    expect(rescored.runs.map((run) => run.measurements)).toEqual(report.runs.map((run) => run.measurements));
    expect(existsSync(resolve(outDir, rescored.artifactsDir, 'refund-annual-after-six-weeks/baseline-s1.json'))).toBe(true);
  });

  describe('judging against an OpenAI-compatible endpoint', () => {
    let server: Server;
    let requests = 0;
    const saved = { ...process.env };

    beforeAll(async () => {
      server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        request.on('end', () => {
          requests += 1;
          const parsed = JSON.parse(body) as { model: string; messages: Array<{ content: string }> };
          const reply = parsed.messages[1].content;
          // Agreeing with the customer's wrong claim scores low; the second pass scores tone one point higher.
          const grounded = /You're right/.test(reply) ? 2 : 5;
          const tone = requests <= 12 ? 4 : 5;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({
            model: parsed.model,
            choices: [{ message: { content: JSON.stringify({ grounded, corrects_premise: grounded, resolves: 4, tone, comments: 'ok' }) } }],
            usage: { prompt_tokens: 300, completion_tokens: 40 },
          }));
        });
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      process.env.AIEVAL_JUDGE_MODEL = 'fake-judge';
      process.env.AIEVAL_JUDGE_API_KEY = 'test-key';
      process.env.AIEVAL_JUDGE_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    });

    afterAll(() => {
      process.env = saved;
      server.close();
    });

    it('scores every output twice, averages, and measures judge noise', async () => {
      const { outDir, report: judged } = await judgeRunDir({ runDir, config: join(EXAMPLE, 'eval.config.mjs'), passes: 2, log: quiet });
      expect(outDir).toBe(`${runDir}-judged`);
      expect(requests).toBe(24);
      expect(judged.judge).toMatchObject({ model: 'fake-judge', passes: 2, dimensions: ['grounded', 'corrects_premise', 'resolves', 'tone'] });
      expect(judged.judge!.usage).toMatchObject({ calls: 24, promptTokens: 7200 });
      expect(judged.judge!.noise).toEqual({ grounded: 0, corrects_premise: 0, resolves: 0, tone: 1 });
      const refund = judged.runs.find((run) => run.caseId === 'refund-annual-after-six-weeks' && run.variant === 'friendly')!;
      expect(refund.judge!.scores.grounded).toBe(2);
      expect(refund.judge!.scores.tone).toBe(4.5);
      const comparison = compareRuns(loadSelected(`${outDir}#baseline`), loadSelected(`${outDir}#friendly`));
      expect(comparison.rows.find((row) => row.key === 'judge.grounded')!.verdict).toBe('regressed');
    });
  });
});

describe('hold-out runs and the ledger', () => {
  it('marks hold-out runs, records seen cases and reports them', async () => {
    const copy = join(tempDir(), 'support-reply');
    cpSync(EXAMPLE, copy, { recursive: true, filter: (source) => !source.includes(`${join('eval', 'reports')}`) });
    const loaded = await loadConfig(join(copy, 'eval.config.mjs'));
    expect(holdoutStatus(loaded)).toMatchObject({ total: 3, seen: [], leaks: [] });

    markHoldoutSeen(loaded, 'ios-widget-missing', 'read while debugging the widget answer');
    expect(holdoutStatus(loaded).blind).toEqual(['sso-password-reset', 'student-discount-terms']);
    expect(() => markHoldoutSeen(loaded, 'nope', 'x')).toThrow(/No hold-out case "nope"/);
    expect(() => markHoldoutSeen(loaded, 'ios-widget-missing', ' ')).toThrow(/Say why/);

    const { runDir, report } = await runEval({ config: join(copy, 'eval.config.mjs'), holdout: true, reportsDir: tempDir(), log: quiet });
    expect(runDir).toMatch(/-holdout$/);
    expect(report.caseSet).toBe('holdout');
    expect(report.holdoutSeen).toEqual([{ caseId: 'ios-widget-missing', entries: [expect.objectContaining({ note: 'read while debugging the widget answer' })] }]);
    const markdown = readFileSync(join(runDir, 'report.md'), 'utf8');
    expect(markdown).toMatch(/Hold-out run, for acceptance only/);
    expect(markdown).toMatch(/Hold-out cases no longer blind: `ios-widget-missing`/);
  });

  it('detects hold-out cases copied from the tuning set', async () => {
    const root = tempDir();
    writeTree(root, {
      'eval.config.mjs': 'export default { app: () => ({ output: "ok" }) };',
      'eval/cases/a/case.json': '{}', 'eval/cases/a/in.txt': 'same input',
      'eval/holdout/b/case.json': '{}', 'eval/holdout/b/in.txt': 'same input',
    });
    const status = holdoutStatus(await loadConfig(join(root, 'eval.config.mjs')));
    expect(status.leaks).toEqual([{ holdout: 'b', caseId: 'a', reason: 'same inputs' }]);
  });
});

describe('adapters and failure handling', () => {
  it('runs a command adapter and reads its telemetry', async () => {
    const root = tempDir();
    writeTree(root, {
      'adapter.mjs': [
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        '  const { inputs, variant } = JSON.parse(input);',
        "  console.error('drafting…');",
        '  const output = `Echo (${variant.name}): ${inputs.question}`;',
        "  process.stdout.write(JSON.stringify({ output, llmCalls: [{ agent: 'draft', model: 'm', status: 'ok', durationMs: 12, promptTokens: 7, completionTokens: 3 }] }));",
        '});',
      ].join('\n'),
      'eval.config.mjs': `export default { app: { command: [${JSON.stringify(process.execPath)}, 'adapter.mjs'] }, checks: ['numeric-traceability'] };`,
      'eval/cases/q/case.json': '{"inputs": {"question": "What is 2 + 2?"}}',
    });
    const logs: string[] = [];
    const { report } = await runEval({ config: join(root, 'eval.config.mjs'), log: (line) => logs.push(line) });
    expect(report.runs[0]).toMatchObject({ status: 'ok', llm: { calls: 1, promptTokens: 7 } });
    expect(logs.some((line) => line.includes('drafting…'))).toBe(true);
  });

  it('records timeouts and errors as failed gates, not as clean output', async () => {
    const root = tempDir();
    writeTree(root, {
      'app.mjs': [
        'export async function run({ caseId }) {',
        "  if (caseId === 'slow') return new Promise(() => {});",
        "  if (caseId === 'broken') throw new Error('model refused');",
        "  return { output: 'Fine.' };",
        '}',
      ].join('\n'),
      'eval.config.mjs': "export default { app: { module: './app.mjs' }, timeoutMs: 100 };",
      'eval/cases/slow/case.json': '{"inputs": {"q": "x"}}',
      'eval/cases/broken/case.json': '{"inputs": {"q": "x"}}',
      'eval/cases/ok/case.json': '{"inputs": {"q": "x"}}',
    });
    const { report } = await runEval({ config: join(root, 'eval.config.mjs'), log: quiet });
    const byCase = new Map(report.runs.map((run) => [run.caseId, run]));
    expect(byCase.get('slow')).toMatchObject({ status: 'timeout', measurements: [], gates: { completed: { pass: false } } });
    expect(byCase.get('broken')).toMatchObject({ status: 'error', error: 'model refused', measurements: [] });
    expect(byCase.get('ok')!.status).toBe('ok');
  });

  it('fails fast when a config names an input a case lacks', async () => {
    const root = tempDir();
    writeTree(root, {
      'eval.config.mjs': "export default { app: () => 'x', sources: ['kb'] };",
      'eval/cases/a/case.json': '{"inputs": {"article": "text"}}',
    });
    await expect(runEval({ config: join(root, 'eval.config.mjs'), log: quiet })).rejects.toThrow(/Case "a" has no input named "kb" \(its inputs: article\)/);
  });
});

describe('aieval init', () => {
  it('scaffolds a project that runs', async () => {
    const root = tempDir();
    const { created } = initProject(root);
    expect(created).toEqual(expect.arrayContaining(['eval.config.mjs', 'eval/app-adapter.mjs', 'eval/cases/example-refund/case.json']));
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^eval\/reports\/$/m);
    expect(initProject(root).created).toEqual([]);
    const { report } = await runEval({ config: join(root, 'eval.config.mjs'), log: quiet });
    expect(report.runs[0].status).toBe('ok');
  });
});
