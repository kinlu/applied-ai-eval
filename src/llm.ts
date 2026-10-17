/**
 * A minimal OpenAI-compatible chat client (OpenAI, OpenRouter, vLLM, Ollama,
 * local servers) that reports every attempt as an LlmCallRecord. The judge
 * uses it; apps can use it too so their calls land in the run's telemetry.
 */
import type { LlmCallRecord } from './types.js';
import { errorMessage } from './util.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmClientOptions {
  model: string;
  apiKey?: string;
  /** Defaults to https://api.openai.com/v1. */
  baseUrl?: string;
  timeoutMs?: number;
  /** Retries after the first attempt, for network errors, timeouts, 429 and 5xx. Default 2. */
  maxRetries?: number;
  retryDelayMs?: number;
  headers?: Record<string, string>;
  /** Called once per attempt, including failed ones. */
  onCall?: (record: LlmCallRecord) => void;
  fetch?: typeof fetch;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Name recorded on the call, e.g. the pipeline stage. */
  agent?: string;
  temperature?: number;
  maxTokens?: number;
  /** Ask for a JSON object (`response_format: json_object`). */
  json?: boolean;
  /** Merged into the request body, e.g. `{ reasoning: { effort: 'low' } }`. */
  extraBody?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  record: LlmCallRecord;
  raw: unknown;
}

export interface LlmClient {
  readonly model: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface ChatCompletionBody {
  model?: string;
  provider?: string;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '')).join('');
  }
  return '';
}

function retryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 429 || error.status >= 500;
  return true;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createLlmClient(options: LlmClientOptions): LlmClient {
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const maxRetries = options.maxRetries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const isOpenRouter = /openrouter\.ai/.test(baseUrl);

  async function attempt(request: ChatRequest, attemptNumber: number): Promise<ChatResponse> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    const onAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener('abort', onAbort, { once: true });
    const base: LlmCallRecord = { agent: request.agent, model: options.model, status: 'ok', durationMs: 0, attempt: attemptNumber };
    try {
      const body: Record<string, unknown> = {
        model: options.model,
        messages: request.messages,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
        ...(request.json ? { response_format: { type: 'json_object' } } : {}),
        // OpenRouter reports the billed cost only when asked.
        ...(isOpenRouter ? { usage: { include: true } } : {}),
        ...request.extraBody,
      };
      const response = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
          ...options.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) throw new HttpError(response.status, `HTTP ${response.status}: ${raw.slice(0, 300)}`);
      const parsed = JSON.parse(raw) as ChatCompletionBody;
      const usage = parsed.usage ?? {};
      const record: LlmCallRecord = {
        ...base,
        durationMs: Date.now() - started,
        ...(parsed.model ? { servedModel: parsed.model } : {}),
        ...(parsed.provider ? { provider: parsed.provider } : {}),
        ...(usage.prompt_tokens !== undefined ? { promptTokens: usage.prompt_tokens } : {}),
        ...(usage.completion_tokens !== undefined ? { completionTokens: usage.completion_tokens } : {}),
        ...(usage.completion_tokens_details?.reasoning_tokens !== undefined ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens } : {}),
        ...(usage.prompt_tokens_details?.cached_tokens !== undefined ? { cachedTokens: usage.prompt_tokens_details.cached_tokens } : {}),
        ...(typeof usage.cost === 'number' ? { costUsd: usage.cost } : {}),
      };
      options.onCall?.(record);
      return { text: messageText(parsed.choices?.[0]?.message?.content), record, raw: parsed };
    } catch (error) {
      const reason = controller.signal.aborted && !(error instanceof HttpError) ? errorMessage(controller.signal.reason ?? error) : errorMessage(error);
      // A failed call reports no usage, but the provider may still have billed it.
      options.onCall?.({ ...base, status: 'error', durationMs: Date.now() - started, error: reason });
      throw error instanceof HttpError ? error : new Error(reason);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    model: options.model,
    async chat(request) {
      let lastError: unknown;
      for (let attemptNumber = 1; attemptNumber <= maxRetries + 1; attemptNumber += 1) {
        try {
          return await attempt(request, attemptNumber);
        } catch (error) {
          lastError = error;
          if (request.signal?.aborted || !retryable(error) || attemptNumber > maxRetries) break;
          await delay(retryDelayMs * 2 ** (attemptNumber - 1));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
  };
}

/** Options from OPENAI_API_KEY / OPENAI_MODEL / OPENAI_BASE_URL (or a custom prefix); null without a key and model. */
export function llmOptionsFromEnv(prefix = 'OPENAI', env: NodeJS.ProcessEnv = process.env): LlmClientOptions | null {
  const apiKey = env[`${prefix}_API_KEY`]?.trim();
  const model = env[`${prefix}_MODEL`]?.trim();
  if (!apiKey || !model) return null;
  const baseUrl = env[`${prefix}_BASE_URL`]?.trim();
  return { apiKey, model, ...(baseUrl ? { baseUrl } : {}) };
}

/** Parses a model reply that should be one JSON object, tolerating a ```json fence or text around it. */
export function parseJsonReply(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error(`reply is not JSON: ${trimmed.slice(0, 120)}`);
  }
}
