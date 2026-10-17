import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inputHash, loadCases, markSeen } from '../src/cases.js';
import { tempDir, writeTree } from './helpers.js';

describe('loadCases', () => {
  it('resolves file inputs, parses JSON files and loads gold.json', () => {
    const root = tempDir();
    writeTree(root, {
      'refund/case.json': JSON.stringify({
        title: 'Refund',
        tags: ['refund'],
        inputs: { message: { file: 'message.txt' }, account: { file: 'account.json' }, locale: 'en-AU' },
        traps: [{ id: 'window', description: 'States 30 days', mustInclude: ['30 days'] }],
      }),
      'refund/message.txt': 'Can I get a refund?\n',
      'refund/account.json': '{"plan": "annual"}',
      'refund/gold.json': '{"window": 30}',
    });
    const [loaded] = loadCases(root, 'cases');
    expect(loaded.id).toBe('refund');
    expect(loaded.inputs).toEqual({ message: 'Can I get a refund?\n', account: { plan: 'annual' }, locale: 'en-AU' });
    expect(loaded.gold).toEqual({ window: 30 });
    expect(loaded.set).toBe('cases');
    expect(loaded.inputHash).toBe(inputHash(loaded.inputs));
  });

  it('turns every file into an input when case.json lists none', () => {
    const root = tempDir();
    writeTree(root, {
      'b-case/case.json': '{}',
      'b-case/resume.txt': 'History',
      'b-case/jd.txt': 'Job ad',
      'b-case/gold.json': '{}',
      'a-case/case.json': '{"id": "a-case"}',
      'a-case/notes.md': 'A',
      '_draft/whatever.txt': 'skipped',
    });
    const cases = loadCases(root, 'cases');
    expect(cases.map((entry) => entry.id)).toEqual(['a-case', 'b-case']);
    expect(Object.keys(cases[1].inputs)).toEqual(['jd', 'resume']);
  });

  it('filters by id and tag, and rejects unknown ids', () => {
    const root = tempDir();
    writeTree(root, {
      'one/case.json': '{"tags": ["x"]}', 'one/in.txt': '1',
      'two/case.json': '{"tags": ["y"]}', 'two/in.txt': '2',
    });
    expect(loadCases(root, 'cases', { ids: ['two'] }).map((entry) => entry.id)).toEqual(['two']);
    expect(loadCases(root, 'cases', { tags: ['x'] }).map((entry) => entry.id)).toEqual(['one']);
    expect(() => loadCases(root, 'cases', { ids: ['three'] })).toThrow(/Unknown case id\(s\): three/);
  });

  it('fails loudly on broken cases', () => {
    const missing = tempDir();
    writeTree(missing, { 'oops/input.txt': 'x' });
    expect(() => loadCases(missing, 'cases')).toThrow(/missing case.json/);

    const escape = tempDir();
    writeTree(escape, { 'bad/case.json': '{"inputs": {"x": {"file": "../../etc/passwd"}}}' });
    expect(() => loadCases(escape, 'cases')).toThrow(/outside the case directory/);

    const duplicate = tempDir();
    writeTree(duplicate, { 'a/case.json': '{"id": "same"}', 'a/i.txt': '1', 'b/case.json': '{"id": "same"}', 'b/i.txt': '2' });
    expect(() => loadCases(duplicate, 'cases')).toThrow(/duplicate case id "same"/);

    const badTrap = tempDir();
    writeTree(badTrap, { 'a/case.json': '{"traps": [{"id": "t", "description": "d"}]}', 'a/i.txt': '1' });
    expect(() => loadCases(badTrap, 'cases')).toThrow(/add mustInclude/);
  });

  it('hashes inputs independently of key order', () => {
    expect(inputHash({ a: 1, b: { c: 2, d: 3 } })).toBe(inputHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(inputHash({ a: 1 })).not.toBe(inputHash({ a: 2 }));
  });
});

describe('markSeen', () => {
  it('appends to the case’s seen list', () => {
    const root = tempDir();
    writeTree(root, { 'h/case.json': '{"title": "Hold-out"}', 'h/in.txt': 'x' });
    markSeen(join(root, 'h'), 'read while tuning the guard', '2026-10-06');
    markSeen(join(root, 'h'), 'read again', '2026-10-07');
    const definition = JSON.parse(readFileSync(join(root, 'h/case.json'), 'utf8'));
    expect(definition).toEqual({
      title: 'Hold-out',
      seen: [{ date: '2026-10-06', note: 'read while tuning the guard' }, { date: '2026-10-07', note: 'read again' }],
    });
  });
});
