/**
 * Adapters connect the harness to the app under test. Whatever the adapter,
 * the app should run its production path: the same prompts, protocol,
 * validators and post-processing a user's request goes through.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppAdapterConfig, AppContext, AppFunction, AppInput } from './types.js';

export type AppRunner = (input: AppInput, ctx: AppContext) => Promise<unknown>;

/** Parses a command's stdout: the whole of it as JSON, else its last non-empty line. */
export function parseCommandOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) throw new Error('the command wrote nothing to stdout');
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const last = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0).pop() ?? '';
    try {
      return JSON.parse(last) as unknown;
    } catch {
      throw new Error(`stdout is not JSON (write logs to stderr): ${trimmed.slice(0, 200)}`);
    }
  }
}

function commandRunner(spec: { command: string[]; cwd?: string; env?: Record<string, string> }, baseDir: string): AppRunner {
  return (input, ctx) => new Promise((resolvePromise, reject) => {
    const [command, ...args] = spec.command;
    const child = spawn(command, args, {
      cwd: resolve(baseDir, spec.cwd ?? '.'),
      env: { ...process.env, ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderrTail = '';
    let killTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) ctx.log(line);
    });
    child.on('error', (error) => {
      ctx.signal.removeEventListener('abort', onAbort);
      reject(new Error(`could not start ${command}: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      ctx.signal.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (ctx.signal.aborted) return reject(new Error('aborted'));
      if (code !== 0) {
        return reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}${stderrTail.trim() ? `: ${stderrTail.trim().split(/\r?\n/).slice(-3).join(' / ')}` : ''}`));
      }
      try {
        resolvePromise(parseCommandOutput(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}

function httpRunner(spec: { url: string; headers?: Record<string, string> }): AppRunner {
  return async (input, ctx) => {
    const response = await fetch(spec.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...spec.headers },
      body: JSON.stringify(input),
      signal: ctx.signal,
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${spec.url}: ${body.slice(0, 200)}`);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(`${spec.url} did not answer JSON: ${body.slice(0, 200)}`);
    }
  };
}

export async function createAppRunner(app: AppAdapterConfig, baseDir: string): Promise<AppRunner> {
  if (typeof app === 'function') return async (input, ctx) => (app as AppFunction)(input, ctx);
  if ('module' in app) {
    const modulePath = resolve(baseDir, app.module);
    const loaded = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
    const name = app.export ?? 'run';
    const fn = loaded[name] ?? (app.export ? undefined : loaded.default);
    if (typeof fn !== 'function') throw new Error(`${modulePath} does not export a function named "${name}"${app.export ? '' : ' (or a default export)'}`);
    return async (input, ctx) => (fn as AppFunction)(input, ctx);
  }
  if ('command' in app) return commandRunner(app, baseDir);
  return httpRunner(app);
}
