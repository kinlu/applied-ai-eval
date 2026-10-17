/**
 * LLM call telemetry: what each case run cost and how long its calls took.
 *
 * Billed cost comes from the provider when it reports one. List-price
 * estimates are a fallback with a stated upper bound, because some providers
 * bill hidden reasoning tokens on top of the completion tokens they report:
 * estimating from visible output alone systematically under-counts.
 */
import type { LlmCallRecord, LlmSummary, ModelPricing } from './types.js';
import { percentile } from './util.js';

export function emptySummary(): LlmSummary {
  return {
    calls: 0,
    errors: 0,
    totalMs: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    costUsd: null,
    costReportedCalls: 0,
    estimatedCostUsd: null,
    estimatedCostUpperUsd: null,
    p50Ms: null,
    p90Ms: null,
    maxMs: null,
    outputTokensPerSec: null,
    models: {},
    modelMismatches: [],
  };
}

function priceFor(pricing: Record<string, ModelPricing> | undefined, record: LlmCallRecord): ModelPricing | undefined {
  if (!pricing) return undefined;
  return (record.servedModel ? pricing[record.servedModel] : undefined) ?? (record.model ? pricing[record.model] : undefined);
}

/** Folds `servedModel` like "vendor/model-2026-07-31" back to a requested "vendor/model" before calling it a mismatch. */
function sameModel(requested: string, served: string): boolean {
  const base = (id: string) => id.toLowerCase().replace(/:.*$/, '').replace(/-\d{4}-?\d{2}-?\d{2}$/, '');
  return base(requested) === base(served) || base(served).startsWith(base(requested)) || base(requested).endsWith(`/${base(served)}`);
}

export function summarizeCalls(records: readonly LlmCallRecord[], pricing?: Record<string, ModelPricing>): LlmSummary {
  const summary = emptySummary();
  const durations: number[] = [];
  let okMs = 0;
  let estimated = 0;
  let estimatedUpper = 0;
  let priced = false;
  const mismatches = new Set<string>();

  for (const record of records) {
    summary.calls += 1;
    summary.totalMs += record.durationMs;
    durations.push(record.durationMs);
    if (record.status === 'ok') {
      const model = record.servedModel ?? record.model ?? 'unknown';
      summary.models[model] = (summary.models[model] ?? 0) + 1;
    }
    if (record.model && record.servedModel && !sameModel(record.model, record.servedModel)) {
      mismatches.add(`${record.model} → ${record.servedModel}`);
    }
    if (record.status === 'error') {
      summary.errors += 1;
    } else {
      okMs += record.durationMs;
    }
    const prompt = record.promptTokens ?? 0;
    const completion = record.completionTokens ?? 0;
    const reasoning = record.reasoningTokens ?? 0;
    summary.promptTokens += prompt;
    summary.completionTokens += completion;
    summary.reasoningTokens += reasoning;
    summary.cachedTokens += record.cachedTokens ?? 0;
    if (typeof record.costUsd === 'number') {
      summary.costUsd = (summary.costUsd ?? 0) + record.costUsd;
      summary.costReportedCalls += 1;
    }
    const price = priceFor(pricing, record);
    if (price) {
      priced = true;
      estimated += (prompt * price.input + completion * price.output) / 1_000_000;
      estimatedUpper += (prompt * price.input + (completion + reasoning) * price.output) / 1_000_000;
    }
  }

  if (priced) {
    summary.estimatedCostUsd = estimated;
    summary.estimatedCostUpperUsd = estimatedUpper;
  }
  summary.p50Ms = percentile(durations, 50);
  summary.p90Ms = percentile(durations, 90);
  summary.maxMs = durations.length > 0 ? Math.max(...durations) : null;
  if (okMs > 0 && summary.completionTokens > 0) {
    summary.outputTokensPerSec = Math.round((summary.completionTokens / (okMs / 1000)) * 100) / 100;
  }
  summary.modelMismatches = [...mismatches].sort();
  return summary;
}

/** Per-agent summaries; calls without an agent land in `unknown`. Keys are sorted. */
export function summarizeByAgent(records: readonly LlmCallRecord[], pricing?: Record<string, ModelPricing>): Record<string, LlmSummary> {
  const grouped = new Map<string, LlmCallRecord[]>();
  for (const record of records) {
    const key = record.agent ?? 'unknown';
    grouped.set(key, [...(grouped.get(key) ?? []), record]);
  }
  return Object.fromEntries([...grouped.keys()].sort().map((key) => [key, summarizeCalls(grouped.get(key)!, pricing)]));
}

/**
 * Adds `next` into `into` for run-level totals. Percentiles cannot be merged
 * from summaries, so the merged p50/p90 are left null; `maxMs` stays exact.
 */
export function mergeSummaries(summaries: readonly LlmSummary[]): LlmSummary {
  const merged = emptySummary();
  let okMs = 0;
  for (const summary of summaries) {
    merged.calls += summary.calls;
    merged.errors += summary.errors;
    merged.totalMs += summary.totalMs;
    merged.promptTokens += summary.promptTokens;
    merged.completionTokens += summary.completionTokens;
    merged.reasoningTokens += summary.reasoningTokens;
    merged.cachedTokens += summary.cachedTokens;
    if (summary.costUsd !== null) merged.costUsd = (merged.costUsd ?? 0) + summary.costUsd;
    merged.costReportedCalls += summary.costReportedCalls;
    if (summary.estimatedCostUsd !== null) merged.estimatedCostUsd = (merged.estimatedCostUsd ?? 0) + summary.estimatedCostUsd;
    if (summary.estimatedCostUpperUsd !== null) merged.estimatedCostUpperUsd = (merged.estimatedCostUpperUsd ?? 0) + summary.estimatedCostUpperUsd;
    if (summary.maxMs !== null) merged.maxMs = Math.max(merged.maxMs ?? 0, summary.maxMs);
    if (summary.outputTokensPerSec && summary.outputTokensPerSec > 0) okMs += (summary.completionTokens / summary.outputTokensPerSec) * 1000;
    for (const [model, calls] of Object.entries(summary.models)) merged.models[model] = (merged.models[model] ?? 0) + calls;
    merged.modelMismatches = [...new Set([...merged.modelMismatches, ...summary.modelMismatches])].sort();
  }
  if (okMs > 0 && merged.completionTokens > 0) merged.outputTokensPerSec = Math.round((merged.completionTokens / (okMs / 1000)) * 100) / 100;
  return merged;
}
