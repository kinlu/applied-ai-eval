/**
 * Public types: the case format, the app adapter contract, measurements and
 * the run report written to report.json.
 */

/* ------------------------------------------------------------------ cases */

export interface Trap {
  /** Stable id, unique within the case. */
  id: string;
  /** What the trap tests, phrased as the mistake a model can make. */
  description: string;
  /** Literal substrings (case-insensitive) the output must all contain. */
  mustInclude?: string[];
  /** Literal substrings (case-insensitive) the output must not contain. */
  mustNotInclude?: string[];
  /** Regular expressions (flags `iu`) the output must all match. */
  mustMatch?: string[];
  /** Regular expressions (flags `iu`) the output must not match. */
  mustNotMatch?: string[];
  /** A failed trap also fails the run's gate `trap:<id>`. */
  gate?: boolean;
  /** Question for the human review checklist; defaults to the description. */
  review?: string;
}

export interface CaseAllowances {
  /** Numbers the output may state although no source does (e.g. a support hotline). */
  numbers?: string[];
  /** Words the output may use although no source does. */
  words?: string[];
}

export interface HoldoutSeenEntry {
  date: string;
  note: string;
}

/** Shape of `case.json`. */
export interface CaseDefinition {
  id?: string;
  title?: string;
  tags?: string[];
  /** What the case is designed to exercise. */
  notes?: string;
  /**
   * Named inputs passed to the app. A value is literal JSON, or `{ "file": "name.txt" }`
   * to read a file next to case.json (`.json` files are parsed). When omitted, every file
   * in the case directory except case.json and gold.json becomes an input named after
   * the file without its extension.
   */
  inputs?: Record<string, unknown>;
  /** Inputs the output may be grounded in. Defaults to the config's `sources`, else every input. */
  sources?: string[];
  /** Inputs the output should not parrot (the user's request, a job ad, instructions). */
  echoOf?: string[];
  /** Terms the output is expected to contain. */
  keywords?: string[];
  /** Facts from the inputs the output must carry, each checked for coverage. */
  carry?: string[];
  /** Planted traps: deterministic assertions plus a reviewer question. */
  traps?: Trap[];
  /** Extra questions for the human review checklist. */
  review?: string[];
  allow?: CaseAllowances;
  /** Expected values for app-specific metrics; `gold.json` next to case.json is loaded here. */
  gold?: unknown;
  /** Hold-out only: when this case's outputs were read, and why. */
  seen?: HoldoutSeenEntry[];
}

export type CaseSet = 'cases' | 'holdout';

export interface LoadedCase extends CaseDefinition {
  id: string;
  dir: string;
  set: CaseSet;
  inputs: Record<string, unknown>;
  /** SHA-256 of the resolved inputs, so runs can tell when a case's inputs changed. */
  inputHash: string;
}

/* -------------------------------------------------------- adapter contract */

export interface VariantRef {
  name: string;
  options: Record<string, unknown>;
}

/** What the app receives for one case run. Gold and traps are never passed in. */
export interface AppInput {
  caseId: string;
  inputs: Record<string, unknown>;
  variant: VariantRef;
  sample: number;
}

export interface AppContext {
  /** Aborted when the run times out. */
  signal: AbortSignal;
  /** Report one LLM call (each attempt, including failed ones). */
  recordLlmCall(call: LlmCallRecord): void;
  log(message: string): void;
}

export interface StageReport {
  /** e.g. `llm`, `fallback`, `deterministic`, `mechanical`, `skipped`. */
  mode: string;
  attempts?: number;
  durationMs?: number;
  error?: string;
}

export interface GateResult {
  pass: boolean;
  detail?: string;
}

export interface AppMetricValue {
  value: number | null;
  label?: string;
  unit?: Unit;
  better?: Better;
  kind?: MeasurementKind;
  aggregate?: 'sum' | 'mean';
  examples?: string[];
}

/** What the app returns for one case run. Only `output` is required. */
export interface AppResult {
  /** The final, user-visible output: what a user of the app would get. */
  output: unknown;
  /** Text the checks read. Defaults to `output` when it is a string, else every string in it. */
  text?: string;
  /**
   * Lines the line-level checks read (sentences, bullets). Pass named groups to keep
   * near-duplicate detection within a group, e.g. `{ "Acme": [...], "Globex": [...] }`.
   * Defaults to splitting `text` into lines and sentences.
   */
  lines?: string[] | Record<string, string[]>;
  /** What each pipeline stage did; modes listed in `fallbackModes` count as fallbacks. */
  stages?: Record<string, StageReport>;
  /** Protocol gates the app checked itself (schema accepted, required tool called, ...). */
  gates?: Record<string, boolean | GateResult>;
  /** Intermediate outputs kept with the run for post-hoc judging and re-scoring. */
  artifacts?: Record<string, unknown>;
  /** Extra files written next to the artifacts (a rendered PDF, an image). */
  files?: Record<string, string | Uint8Array>;
  /** LLM calls made, when they were not reported through `ctx.recordLlmCall`. */
  llmCalls?: LlmCallRecord[];
  /** App-defined metrics, e.g. accuracy against `gold`. */
  metrics?: Record<string, number | null | AppMetricValue>;
}

export type AppFunction = (input: AppInput, ctx: AppContext) => Promise<AppResult | unknown> | AppResult | unknown;

export type AppAdapterConfig =
  | AppFunction
  /** An ES module (path relative to the config file) exporting the app function. */
  | { module: string; export?: string }
  /** Any executable: reads AppInput JSON on stdin, writes AppResult JSON on stdout. */
  | { command: string[]; cwd?: string; env?: Record<string, string> }
  /** An HTTP endpoint: receives AppInput as a JSON POST, answers AppResult JSON. */
  | { url: string; headers?: Record<string, string> };

/* ----------------------------------------------------------- measurements */

export type Better = 'higher' | 'lower' | 'none';
export type Unit = 'count' | 'ratio' | 'score' | 'ms' | 'tokens' | 'usd' | 'chars';
/** `quality` regressions block adoption; `usage` changes (cost, latency) are trade-offs to decide. */
export type MeasurementKind = 'quality' | 'usage';

export interface Measurement {
  key: string;
  label: string;
  /** `null` means not applicable for this case (e.g. no keywords declared). */
  value: number | null;
  unit: Unit;
  better: Better;
  kind?: MeasurementKind;
  /** How case runs combine: counts are summed by default, everything else averaged. */
  aggregate?: 'sum' | 'mean';
  /** Up to five offending lines or values, for the report. */
  examples?: string[];
}

export interface TrapResult {
  id: string;
  description: string;
  pass: boolean;
  detail?: string;
  gate?: boolean;
}

/* -------------------------------------------------------------- telemetry */

export interface LlmCallRecord {
  /** The app's name for the call site or stage, e.g. `draft`, `import`, `judge`. */
  agent?: string;
  /** The model requested. */
  model?: string;
  /** The model the provider says answered, when it echoes one. */
  servedModel?: string;
  /** Upstream provider, when a router reports it. */
  provider?: string;
  status: 'ok' | 'error';
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Hidden reasoning tokens, when reported; they are billed but never visible. */
  reasoningTokens?: number;
  cachedTokens?: number;
  /** USD billed for the call, when the provider reports it. */
  costUsd?: number;
  attempt?: number;
  error?: string;
}

export interface LlmSummary {
  calls: number;
  errors: number;
  totalMs: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  /** USD billed, summed over the calls that reported it; null when none did. */
  costUsd: number | null;
  costReportedCalls: number;
  /** List price from `pricing` (prompt + completion tokens); null without pricing. */
  estimatedCostUsd: number | null;
  /** List price counting reasoning tokens on top of completion tokens, for providers that bill them separately. */
  estimatedCostUpperUsd: number | null;
  p50Ms: number | null;
  p90Ms: number | null;
  maxMs: number | null;
  /** Completion tokens per second over successful calls. */
  outputTokensPerSec: number | null;
  /** Successful calls per served (else requested) model. */
  models: Record<string, number>;
  /** Distinct `requested → served` pairs where the provider answered with another model. */
  modelMismatches: string[];
}

/* ----------------------------------------------------------------- config */

export type CheckName =
  | 'numeric-traceability'
  | 'unsupported-lines'
  | 'near-duplicates'
  | 'input-echo'
  | 'misspellings'
  | 'baseline-drops'
  | 'qualifier-drops'
  | 'reasoning-leak'
  | 'json-shape'
  | 'script-ratio'
  | 'length'
  | 'schema';

export type CheckSpec = CheckName | ({ check: CheckName } & Record<string, unknown>);

export interface CustomMetricInput {
  case: LoadedCase;
  result: AppResult;
  text: string;
  lines: string[];
}

export interface CustomMetric {
  key: string;
  label?: string;
  unit?: Unit;
  better?: Better;
  kind?: MeasurementKind;
  aggregate?: 'sum' | 'mean';
  measure(input: CustomMetricInput): number | null | { value: number | null; examples?: string[] };
}

export interface JudgeDimension {
  key: string;
  description: string;
}

export interface JudgeRenderInput {
  case: LoadedCase;
  result: AppResult;
  text: string;
}

export interface JudgeConfig {
  dimensions: JudgeDimension[];
  /** Opening of the system prompt; the scale, dimensions and JSON contract are appended. */
  instructions?: string;
  /** What the judge sees for one case run. Defaults to every input followed by the output text. */
  render?: (input: JudgeRenderInput) => string;
  /** Judge model; `AIEVAL_JUDGE_MODEL` overrides it. Keep it fixed across the runs you compare. */
  model?: string;
  baseUrl?: string;
  /** Environment variable holding the judge's API key (default AIEVAL_JUDGE_API_KEY, then OPENAI_API_KEY). */
  apiKeyEnv?: string;
  temperature?: number;
  scale?: { min: number; max: number };
  maxTokens?: number;
  timeoutMs?: number;
}

/** Absolute (`0.5`) or relative to the baseline (`"10%"`). */
export type Tolerance = number | `${number}%`;

export interface ModelPricing {
  /** USD per million prompt tokens. */
  input: number;
  /** USD per million completion tokens. */
  output: number;
}

export interface EvalConfig {
  name?: string;
  app: AppAdapterConfig;
  /** Directories are relative to the config file. */
  cases?: string;
  holdout?: string;
  reports?: string;
  /** Named variants passed to the app as `input.variant`; the first one runs by default. */
  variants?: Record<string, Record<string, unknown>>;
  /** Default inputs the output may be grounded in. */
  sources?: string[];
  /** Default inputs the output should not parrot. */
  echoOf?: string[];
  /** Text checks to run; defaults to DEFAULT_CHECKS. Case expectations (traps, keywords, carry) always run. */
  checks?: CheckSpec[];
  metrics?: CustomMetric[];
  judge?: JudgeConfig;
  /** Splits output text into the lines line-level checks read. */
  segment?: (text: string) => string[];
  /** Per-run timeout; a timeout fails the `completed` gate. Default 600000 ms. */
  timeoutMs?: number;
  concurrency?: number;
  /** List prices by model id, for cost estimates when the provider bills nothing back. */
  pricing?: Record<string, ModelPricing>;
  /** Stage modes counted as fallbacks. Default: fallback, deterministic. */
  fallbackModes?: string[];
  /** Change treated as noise per aggregate key when comparing runs. */
  tolerances?: Record<string, Tolerance>;
}

/* ------------------------------------------------------------- run report */

export interface JudgeScores {
  /** One score per dimension; null when the judge gave none. */
  scores: Record<string, number | null>;
  comments?: string;
  /** How many judge passes were averaged into `scores`. */
  passes?: number;
}

export interface CaseRun {
  caseId: string;
  title?: string;
  variant: string;
  sample: number;
  tags?: string[];
  inputHash: string;
  status: 'ok' | 'error' | 'timeout';
  error?: string;
  durationMs: number;
  gates: Record<string, GateResult>;
  traps: TrapResult[];
  measurements: Measurement[];
  stages?: Record<string, StageReport>;
  llm: LlmSummary;
  llmByAgent: Record<string, LlmSummary>;
  judge?: JudgeScores | null;
  /** Artifact stem relative to the artifacts directory: `<case>/<variant>-s<sample>`. */
  artifact: string;
}

export interface JudgeRunInfo {
  model: string;
  dimensions: string[];
  judgedAtIso: string;
  /** Set when the scores were added after the run, by `aieval judge`. */
  judgedFromIso?: string;
  passes: number;
  /** Spread of each dimension's mean across passes over identical outputs. */
  noise?: Record<string, number>;
  usage?: LlmSummary;
}

export interface RunReport {
  tool: { name: string; version: string };
  name?: string;
  label?: string;
  startedIso: string;
  finishedIso: string;
  caseSet: CaseSet;
  variants: VariantRef[];
  samples: number;
  checks: CheckSpec[];
  tolerances?: Record<string, Tolerance>;
  git?: { commit: string; dirty: boolean };
  /** Where the artifacts live, relative to the directory holding report.json. */
  artifactsDir: string;
  /** Hold-out cases whose outputs were read before this run, so they are no longer blind. */
  holdoutSeen?: Array<{ caseId: string; entries: HoldoutSeenEntry[] }>;
  judge?: JudgeRunInfo;
  rescoredAtIso?: string;
  rescoredFromIso?: string;
  runs: CaseRun[];
}

/** What a run stores per case run in `artifacts/<case>/<variant>-s<sample>.json`. */
export interface RunArtifact {
  caseId: string;
  variant: string;
  sample: number;
  status: CaseRun['status'];
  error?: string;
  result: AppResult;
}
