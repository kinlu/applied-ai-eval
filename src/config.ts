/**
 * Loading `eval.config.mjs` (or .js / .json) and resolving its directories.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCheckSpec } from './checks/index.js';
import type { EvalConfig } from './types.js';
import { readJson } from './util.js';

export const CONFIG_FILES = ['eval.config.mjs', 'eval.config.js', 'eval.config.json'];
const VARIANT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Identity helper that gives config files type checking: `export default defineConfig({...})`. */
export function defineConfig(config: EvalConfig): EvalConfig {
  return config;
}

export interface LoadedConfig {
  config: EvalConfig;
  path: string;
  dir: string;
  casesDir: string;
  holdoutDir: string;
  reportsDir: string;
}

export function findConfig(cwd = process.cwd()): string | undefined {
  return CONFIG_FILES.map((file) => resolve(cwd, file)).find((path) => existsSync(path));
}

/** Throws a readable error for config mistakes before any case runs. */
export function validateConfig(config: EvalConfig, path: string): void {
  const fail = (message: string): never => {
    throw new Error(`${path}: ${message}`);
  };
  if (!config || typeof config !== 'object') fail('the config must export an object');
  const app = config.app as unknown;
  const appOk = typeof app === 'function'
    || (app !== null && typeof app === 'object' && (
      typeof (app as { module?: unknown }).module === 'string'
      || (Array.isArray((app as { command?: unknown }).command) && ((app as { command: unknown[] }).command).length > 0)
      || typeof (app as { url?: unknown }).url === 'string'));
  if (!appOk) fail('`app` must be a function, { module }, { command: [...] } or { url }');
  for (const name of Object.keys(config.variants ?? {})) {
    if (!VARIANT_NAME.test(name)) fail(`variant name "${name}" must use letters, digits, ".", "_" or "-"`);
  }
  for (const spec of config.checks ?? []) {
    try {
      parseCheckSpec(spec);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  if (config.judge) {
    if (!Array.isArray(config.judge.dimensions) || config.judge.dimensions.length === 0) fail('`judge.dimensions` needs at least one { key, description }');
    for (const dimension of config.judge.dimensions) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(dimension.key)) fail(`judge dimension key "${dimension.key}" must be an identifier`);
    }
  }
  for (const [key, tolerance] of Object.entries(config.tolerances ?? {})) {
    if (typeof tolerance === 'number' ? tolerance < 0 : !/^\d+(?:\.\d+)?%$/.test(String(tolerance))) fail(`tolerance for "${key}" must be a non-negative number or a percentage like "10%"`);
  }
}

export async function loadConfig(path?: string, cwd = process.cwd()): Promise<LoadedConfig> {
  const resolved = path ? resolve(cwd, path) : findConfig(cwd);
  if (!resolved || !existsSync(resolved)) {
    throw new Error(path ? `Config not found: ${resolve(cwd, path)}` : `No config found in ${cwd} (looked for ${CONFIG_FILES.join(', ')}). Run \`aieval init\` to create one.`);
  }
  const config = resolved.endsWith('.json')
    ? readJson<EvalConfig>(resolved)
    : ((await import(pathToFileURL(resolved).href)) as { default?: EvalConfig }).default;
  if (!config) throw new Error(`${resolved}: no default export`);
  validateConfig(config, resolved);
  const dir = dirname(resolved);
  return {
    config,
    path: resolved,
    dir,
    casesDir: resolve(dir, config.cases ?? 'eval/cases'),
    holdoutDir: resolve(dir, config.holdout ?? 'eval/holdout'),
    reportsDir: resolve(dir, config.reports ?? 'eval/reports'),
  };
}

/** The variants a run uses: the requested names, `all`, or the first configured one. */
export function selectVariants(config: EvalConfig, requested?: string[]): Array<{ name: string; options: Record<string, unknown> }> {
  const configured = Object.entries(config.variants ?? {});
  if (configured.length === 0) {
    if (requested?.length && !(requested.length === 1 && (requested[0] === 'default' || requested[0] === 'all'))) {
      throw new Error(`The config defines no variants; remove --variant ${requested.join(',')}`);
    }
    return [{ name: 'default', options: {} }];
  }
  if (!requested?.length) return [{ name: configured[0][0], options: configured[0][1] }];
  if (requested.length === 1 && requested[0] === 'all') return configured.map(([name, options]) => ({ name, options }));
  return requested.map((name) => {
    const options = config.variants?.[name];
    if (!options) throw new Error(`Unknown variant "${name}". Configured: ${configured.map(([key]) => key).join(', ')}`);
    return { name, options };
  });
}
