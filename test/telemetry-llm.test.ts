import { describe, expect, it } from 'vitest';
import { createLlmClient, llmOptionsFromEnv, parseJsonReply } from '../src/llm.js';
import { mergeSummaries, summarizeByAgent, summarizeCalls } from '../src/telemetry.js';
import type { LlmCallRecord } from '../src/types.js';

describe('summarizeCalls', () => {
  const records: LlmCallRecord[] = [
    { agent: 'draft', model: 'vendor/fast', servedModel: 'vendor/fast-2026-07-31', status: 'ok', durationMs: 1000, promptTokens: 1000, completionTokens: 200, reasoningTokens: 300, costUsd: 0.001 },
    { agent: 'draft', model: 'vendor/fast', status: 'error', durationMs: 3000, error: 'HTTP 500' },
    { agent: 'polish', model: 'vendor/fast', servedModel: 'other/model', status: 'ok', durationMs: 2000, promptTokens: 500, completionTokens: 100 },
  ];

  it('totals usage, keeps billed cost separate from estimates and flags model substitution', () => {
    const summary = summarizeCalls(records, { 'vendor/fast': { input: 1, output: 2 } });
    expect(summary).toMatchObject({
      calls: 3,
      errors: 1,
      totalMs: 6000,
      promptTokens: 1500,
      completionTokens: 300,
      reasoningTokens: 300,
      costUsd: 0.001,
      costReportedCalls: 1,
      p50Ms: 2000,
      p90Ms: 3000,
      maxMs: 3000,
      modelMismatches: ['vendor/fast → other/model'],
      models: { 'vendor/fast-2026-07-31': 1, 'other/model': 1 },
    });
    expect(summary.estimatedCostUsd).toBeCloseTo((1500 * 1 + 300 * 2) / 1e6);
    expect(summary.estimatedCostUpperUsd).toBeCloseTo((1500 * 1 + 600 * 2) / 1e6);
    expect(summary.outputTokensPerSec).toBe(100);
  });

  it('reports no cost when nothing was billed or priced', () => {
    expect(summarizeCalls([records[2]])).toMatchObject({ costUsd: null, estimatedCostUsd: null });
  });

  it('groups by agent and merges summaries', () => {
    const byAgent = summarizeByAgent(records);
    expect(Object.keys(byAgent)).toEqual(['draft', 'polish']);
    const merged = mergeSummaries(Object.values(byAgent));
    expect(merged).toMatchObject({ calls: 3, errors: 1, promptTokens: 1500, costUsd: 0.001, maxMs: 3000 });
  });
});

function fakeFetch(responses: Array<{ status: number; body: unknown } | Error>, seen: Array<{ url: string; body: Record<string, unknown> }> = []): typeof fetch {
  let index = 0;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
}

const OK_BODY = {
  model: 'vendor/fast-2026',
  provider: 'SomeHost',
  choices: [{ message: { content: 'Hello' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0002, completion_tokens_details: { reasoning_tokens: 2 }, prompt_tokens_details: { cached_tokens: 4 } },
};

describe('createLlmClient', () => {
  it('parses text, usage, served model and billed cost', async () => {
    const calls: LlmCallRecord[] = [];
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = createLlmClient({ model: 'vendor/fast', apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1/', fetch: fakeFetch([{ status: 200, body: OK_BODY }], seen), onCall: (record) => calls.push(record) });
    const reply = await client.chat({ agent: 'draft', messages: [{ role: 'user', content: 'Hi' }], json: true, temperature: 0 });
    expect(reply.text).toBe('Hello');
    expect(seen[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(seen[0].body).toMatchObject({ model: 'vendor/fast', temperature: 0, response_format: { type: 'json_object' }, usage: { include: true } });
    expect(calls).toEqual([expect.objectContaining({
      agent: 'draft', model: 'vendor/fast', servedModel: 'vendor/fast-2026', provider: 'SomeHost', status: 'ok',
      promptTokens: 10, completionTokens: 5, reasoningTokens: 2, cachedTokens: 4, costUsd: 0.0002, attempt: 1,
    })]);
  });

  it('retries 5xx and network errors, recording every attempt', async () => {
    const calls: LlmCallRecord[] = [];
    const client = createLlmClient({
      model: 'm', retryDelayMs: 1, maxRetries: 2,
      fetch: fakeFetch([{ status: 503, body: { error: 'busy' } }, new Error('socket hang up'), { status: 200, body: OK_BODY }]),
      onCall: (record) => calls.push(record),
    });
    await expect(client.chat({ messages: [{ role: 'user', content: 'Hi' }] })).resolves.toMatchObject({ text: 'Hello' });
    expect(calls.map((record) => [record.status, record.attempt])).toEqual([['error', 1], ['error', 2], ['ok', 3]]);
    expect(calls[0].error).toMatch(/HTTP 503/);
  });

  it('does not retry client errors and does not ask non-OpenRouter hosts for usage accounting', async () => {
    const calls: LlmCallRecord[] = [];
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = createLlmClient({ model: 'm', retryDelayMs: 1, fetch: fakeFetch([{ status: 400, body: { error: 'bad' } }], seen), onCall: (record) => calls.push(record) });
    await expect(client.chat({ messages: [{ role: 'user', content: 'Hi' }] })).rejects.toThrow(/HTTP 400/);
    expect(calls).toHaveLength(1);
    expect(seen[0].body.usage).toBeUndefined();
  });

  it('times out a silent call', async () => {
    const calls: LlmCallRecord[] = [];
    const hanging = ((_url: string, init?: RequestInit) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as typeof fetch;
    const client = createLlmClient({ model: 'm', timeoutMs: 20, maxRetries: 0, fetch: hanging, onCall: (record) => calls.push(record) });
    await expect(client.chat({ messages: [{ role: 'user', content: 'Hi' }] })).rejects.toThrow(/timed out after 20 ms/);
    expect(calls[0]).toMatchObject({ status: 'error', error: 'timed out after 20 ms' });
  });
});

describe('parseJsonReply and llmOptionsFromEnv', () => {
  it('tolerates fences and surrounding text', () => {
    expect(parseJsonReply('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('Sure! {"a": 2} Hope that helps')).toEqual({ a: 2 });
    expect(() => parseJsonReply('no json')).toThrow(/not JSON/);
  });

  it('needs a key and a model', () => {
    expect(llmOptionsFromEnv('OPENAI', { OPENAI_API_KEY: 'k' })).toBeNull();
    expect(llmOptionsFromEnv('OPENAI', { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'm', OPENAI_BASE_URL: 'http://x/v1' })).toEqual({ apiKey: 'k', model: 'm', baseUrl: 'http://x/v1' });
  });
});
