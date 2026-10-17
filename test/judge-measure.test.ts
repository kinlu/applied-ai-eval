import { describe, expect, it } from 'vitest';
import { averageScores, judgeNoise, judgeSystemPrompt, parseJudgeReply, scoreRuns } from '../src/judge.js';
import type { LlmClient } from '../src/llm.js';
import { measureResult } from '../src/measure.js';
import type { EvalConfig, JudgeConfig } from '../src/types.js';
import { caseRun, loadedCase, runReport } from './helpers.js';

const judge: JudgeConfig = {
  dimensions: [
    { key: 'grounded', description: 'Claims are supported by the inputs.' },
    { key: 'tone', description: 'Warm and concise.' },
  ],
};

describe('judge prompt and parsing', () => {
  it('lists every dimension and the JSON contract', () => {
    const prompt = judgeSystemPrompt(judge);
    expect(prompt).toContain('- grounded: Claims are supported by the inputs.');
    expect(prompt).toContain('{"grounded": <1-5>, "tone": <1-5>, "comments": "<one short paragraph>"}');
  });

  it('keeps in-range scores, rounds them, and nulls the rest', () => {
    expect(parseJudgeReply('```json\n{"grounded": 4.4, "tone": "5", "comments": " Fine. "}\n```', judge)).toEqual({ scores: { grounded: 4, tone: 5 }, comments: 'Fine.' });
    expect(parseJudgeReply('{"grounded": 9}', judge)).toEqual({ scores: { grounded: null, tone: null } });
  });

  it('averages passes and measures the judge’s noise', () => {
    expect(averageScores([{ scores: { grounded: 4, tone: 5 } }, null, { scores: { grounded: 5, tone: 5 } }], ['grounded', 'tone'])).toEqual({ scores: { grounded: 4.5, tone: 5 }, passes: 2 });
    expect(averageScores([null], ['grounded'])).toBeNull();
    expect(judgeNoise([{ grounded: 4.1, tone: 3 }, { grounded: 3.9, tone: 3 }], ['grounded', 'tone'])).toEqual({ grounded: expect.closeTo(0.2), tone: 0 });
  });
});

describe('scoreRuns', () => {
  it('scores successful runs only, averages passes and records noise and usage', async () => {
    let call = 0;
    const client: LlmClient = {
      model: 'fake-judge',
      async chat() {
        call += 1;
        const grounded = call % 2 === 1 ? 4 : 5;
        return { text: JSON.stringify({ grounded, tone: 4 }), record: { status: 'ok', durationMs: 1 }, raw: {} };
      },
    };
    const report = runReport([
      caseRun({ caseId: 'case-a' }),
      caseRun({ caseId: 'case-a', variant: 'candidate', status: 'error', error: 'boom' }),
    ]);
    const scored = await scoreRuns({
      report,
      cases: new Map([['case-a', loadedCase()]]),
      config: { app: () => ({ output: '' }), judge } satisfies EvalConfig,
      loadResult: () => ({ output: 'Refunds are available within 30 days.' }),
      passes: 2,
      client: { client, model: 'fake-judge' },
    });
    expect(call).toBe(2);
    expect(scored.runs[0].judge).toEqual({ scores: { grounded: 4.5, tone: 4 }, passes: 2 });
    expect(scored.runs[1].judge).toBeUndefined();
    expect(scored.judge).toMatchObject({ model: 'fake-judge', passes: 2, noise: { grounded: 1, tone: 0 } });
  });
});

describe('measureResult', () => {
  const config: EvalConfig = {
    app: () => ({ output: '' }),
    checks: ['numeric-traceability', 'near-duplicates', { check: 'length', max: 60 }, { check: 'json-shape', gate: true }],
    metrics: [{ key: 'custom.words', unit: 'count', better: 'none', measure: ({ text }) => text.split(/\s+/).length }],
  };

  it('gives failed or empty runs no quality measurements', () => {
    expect(measureResult(loadedCase(), { output: '' }, config, 'error', 'boom')).toEqual({ measurements: [], gates: { completed: { pass: false, detail: 'boom' } }, traps: [] });
    expect(measureResult(loadedCase(), { output: '  ' }, config, 'ok').gates.completed).toEqual({ pass: false, detail: 'no output text' });
    expect(measureResult(loadedCase(), { output: '' }, config, 'timeout', 'timed out after 5 ms').gates.completed.detail).toBe('timed out: timed out after 5 ms');
  });

  it('runs checks, case expectations, app gates and metrics', () => {
    const caseDef = loadedCase({
      traps: [{ id: 'window', description: 'States 30 days', mustInclude: ['30 days'], gate: true }],
      keywords: ['refund'],
      carry: ['Refunds are available within 30 days of purchase.'],
    });
    const measured = measureResult(caseDef, {
      output: { reply: 'Refunds within 60 days.' },
      gates: { tool_called: false },
      stages: { draft: { mode: 'fallback', error: 'timeout' }, polish: { mode: 'llm' } },
      metrics: { 'app.accuracy': { value: 0.8, unit: 'ratio', better: 'higher' } },
    }, config, 'ok');
    const byKey = new Map(measured.measurements.map((entry) => [entry.key, entry]));
    expect(byKey.get('numbers.untraceable')).toMatchObject({ value: 1, examples: ['60'] });
    expect(byKey.get('traps.failed')!.value).toBe(1);
    expect(byKey.get('keywords.coverage')!.value).toBe(1);
    expect(byKey.get('carry.coverage')!.value).toBe(0);
    expect(byKey.get('stages.fallbacks')).toMatchObject({ value: 1, examples: ['draft: fallback (timeout)'] });
    expect(byKey.get('app.accuracy')).toMatchObject({ value: 0.8, unit: 'ratio', better: 'higher' });
    expect(byKey.get('custom.words')!.value).toBe(4);
    expect(measured.gates).toMatchObject({
      completed: { pass: true },
      tool_called: { pass: false },
      length: { pass: true },
      prose: { pass: true },
      'trap:window': { pass: false },
    });
  });

  it('keeps near-duplicate detection within the groups the app returns', () => {
    const line = 'Cut cloud spend by 38% through right-sizing and spot instances';
    const again = 'Through right-sizing and spot instances, cut cloud spend by 38%';
    const grouped = measureResult(loadedCase({ inputs: { history: `${line}.` } }), { output: 'x', lines: { acme: [line], globex: [again] } }, config, 'ok');
    expect(grouped.measurements.find((entry) => entry.key === 'lines.nearDuplicates')!.value).toBe(0);
    const flat = measureResult(loadedCase({ inputs: { history: `${line}.` } }), { output: 'x', lines: [line, again] }, config, 'ok');
    expect(flat.measurements.find((entry) => entry.key === 'lines.nearDuplicates')!.value).toBe(1);
  });

  it('gates on schema and script when configured', () => {
    const strict: EvalConfig = {
      app: () => ({ output: '' }),
      checks: [
        { check: 'schema', schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } } },
        { check: 'script-ratio', script: 'han', min: 0.6 },
      ],
    };
    const measured = measureResult(loadedCase(), { output: '{"answer": 42}' }, strict, 'ok');
    expect(measured.gates.schema).toEqual({ pass: false, detail: '/answer: expected string, got integer' });
    expect(measured.gates.script.pass).toBe(false);
    expect(measured.measurements.find((entry) => entry.key === 'text.foreignRuns')!.value).toBe(0);
  });
});
