/**
 * Golden cases: one directory per case under `eval/cases/` (tuning) or
 * `eval/holdout/` (acceptance only), each with a case.json and its input files.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { validateTrap } from './checks/traps.js';
import type { CaseDefinition, CaseSet, HoldoutSeenEntry, LoadedCase } from './types.js';
import { canonicalJson, sha256 } from './util.js';

const CASE_FILE = 'case.json';
const GOLD_FILE = 'gold.json';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface CaseFilter {
  ids?: string[];
  tags?: string[];
}

function readFileValue(caseDir: string, file: string): unknown {
  const path = resolve(caseDir, file);
  const inside = relative(resolve(caseDir), path);
  if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`${caseDir}: input file "${file}" is outside the case directory`);
  if (!existsSync(path)) throw new Error(`${caseDir}: input file "${file}" not found`);
  const text = readFileSync(path, 'utf8');
  if (extname(path).toLowerCase() === '.json') {
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return text;
}

function isFileRef(value: unknown): value is { file: string } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { file?: unknown }).file === 'string' && Object.keys(value as object).length === 1;
}

function resolveInputs(caseDir: string, definition: CaseDefinition): Record<string, unknown> {
  if (definition.inputs) {
    return Object.fromEntries(Object.entries(definition.inputs).map(([name, value]) => [name, isFileRef(value) ? readFileValue(caseDir, value.file) : value]));
  }
  const inputs: Record<string, unknown> = {};
  for (const entry of readdirSync(caseDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || entry.name.startsWith('.') || entry.name === CASE_FILE || entry.name === GOLD_FILE) continue;
    const name = parse(entry.name).name;
    if (name in inputs) throw new Error(`${caseDir}: two files would both become input "${name}"; list inputs in case.json`);
    inputs[name] = readFileValue(caseDir, entry.name);
  }
  return inputs;
}

export function inputHash(inputs: Record<string, unknown>): string {
  return sha256(canonicalJson(inputs));
}

export function loadCase(caseDir: string, set: CaseSet): LoadedCase {
  const file = join(caseDir, CASE_FILE);
  let definition: CaseDefinition;
  try {
    definition = JSON.parse(readFileSync(file, 'utf8')) as CaseDefinition;
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const id = definition.id ?? parse(caseDir).base;
  if (!SAFE_ID.test(id)) throw new Error(`${file}: case id "${id}" must use letters, digits, ".", "_" or "-"`);
  const inputs = resolveInputs(caseDir, definition);
  if (Object.keys(inputs).length === 0) throw new Error(`${caseDir}: the case has no inputs`);
  for (const trap of definition.traps ?? []) validateTrap(trap, id);
  const goldPath = join(caseDir, GOLD_FILE);
  const gold = definition.gold !== undefined
    ? (isFileRef(definition.gold) ? readFileValue(caseDir, definition.gold.file) : definition.gold)
    : existsSync(goldPath) ? readFileValue(caseDir, GOLD_FILE) : undefined;
  return {
    ...definition,
    id,
    dir: caseDir,
    set,
    inputs,
    ...(gold !== undefined ? { gold } : {}),
    inputHash: inputHash(inputs),
  };
}

/** Loads every case directory under `dir`, sorted by id. Directories starting with "." or "_" are skipped. */
export function loadCases(dir: string, set: CaseSet, filter: CaseFilter = {}): LoadedCase[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Case directory not found: ${dir}`);
  const cases: LoadedCase[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const caseDir = join(dir, entry.name);
    if (!existsSync(join(caseDir, CASE_FILE))) throw new Error(`${caseDir}: missing ${CASE_FILE} (prefix the directory with "_" to skip it)`);
    cases.push(loadCase(caseDir, set));
  }
  cases.sort((a, b) => a.id.localeCompare(b.id));

  const ids = new Set<string>();
  for (const loaded of cases) {
    if (ids.has(loaded.id)) throw new Error(`${dir}: duplicate case id "${loaded.id}"`);
    ids.add(loaded.id);
  }
  if (filter.ids?.length) {
    const unknown = filter.ids.filter((id) => !ids.has(id));
    if (unknown.length > 0) throw new Error(`Unknown case id(s): ${unknown.join(', ')}. Available: ${[...ids].join(', ')}`);
  }
  return cases.filter((loaded) => (!filter.ids?.length || filter.ids.includes(loaded.id))
    && (!filter.tags?.length || filter.tags.some((tag) => loaded.tags?.includes(tag))));
}

/** Records in a hold-out case's case.json that its outputs were read, so it is no longer blind. */
export function markSeen(caseDir: string, note: string, date = new Date().toISOString().slice(0, 10)): HoldoutSeenEntry {
  const file = join(caseDir, CASE_FILE);
  const definition = JSON.parse(readFileSync(file, 'utf8')) as CaseDefinition;
  const entry = { date, note };
  definition.seen = [...(definition.seen ?? []), entry];
  writeFileSync(file, `${JSON.stringify(definition, null, 2)}\n`);
  return entry;
}
