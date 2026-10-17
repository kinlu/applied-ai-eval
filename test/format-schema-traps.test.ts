import { describe, expect, it } from 'vitest';
import { foreignRuns, looksLikeJson, reasoningLeaks, scriptRatio, textLength } from '../src/checks/format.js';
import { parseJsonOutput, validateSchema, type JsonSchema } from '../src/checks/schema.js';
import { evaluateTrap, validateTrap } from '../src/checks/traps.js';

describe('format checks', () => {
  it('finds reasoning leaks but not ordinary courtesy', () => {
    expect(reasoningLeaks('Let me know if you need anything else.')).toEqual([]);
    expect(reasoningLeaks('<think>The user wants a refund</think> Hi!')).toEqual(['<think', '</think>', 'The user wants']);
    expect(reasoningLeaks('首先我需要分析一下')).toEqual(['首先我']);
  });

  it('spots JSON-shaped prose', () => {
    expect(looksLikeJson('{"reply": "Hi"}')).toBe(true);
    expect(looksLikeJson('```json\n{}\n```')).toBe(true);
    expect(looksLikeJson('[1] Reference')).toBe(false);
    expect(looksLikeJson('Hi there')).toBe(false);
  });

  it('measures the share of letters in a script', () => {
    expect(scriptRatio('定价 9.99 美元', 'han')).toBe(1);
    expect(scriptRatio('定价 pricing', 'han')).toBeCloseTo(2 / 9);
    expect(scriptRatio('12345', 'latin')).toBeNull();
    expect(() => scriptRatio('x', 'klingon')).toThrow(/Unknown script/);
  });

  it('counts runs of six English words in non-Latin output', () => {
    expect(foreignRuns('会议纪要 This sentence slipped into English by accident 结束')).toBe(1);
    expect(foreignRuns('使用 vendor/model-2 模型和 OpenRouter 连接')).toBe(0);
  });

  it('measures length in characters or words', () => {
    expect(textLength('  三个字  ')).toBe(3);
    expect(textLength('one two  three', 'words')).toBe(3);
    expect(textLength('   ')).toBe(0);
  });
});

describe('validateSchema', () => {
  const schema: JsonSchema = {
    type: 'object',
    required: ['points', 'skip'],
    additionalProperties: false,
    properties: {
      skip: { type: 'boolean' },
      points: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['tag', 'text'],
          properties: { tag: { enum: ['fact', 'risk'] }, text: { type: 'string', minLength: 1 } },
        },
      },
    },
  };

  it('accepts a conforming value', () => {
    expect(validateSchema({ skip: false, points: [{ tag: 'fact', text: 'Price is $8' }] }, schema)).toEqual([]);
  });

  it('reports every violation with its path', () => {
    expect(validateSchema({ points: [{ tag: 'opinion', text: '' }], extra: 1 }, schema)).toEqual([
      '/skip: required property missing',
      '/points/0/tag: "opinion" is not one of ["fact","risk"]',
      '/points/0/text: shorter than 1 characters',
      '/extra: additional property not allowed',
    ]);
  });

  it('handles anyOf, integers and patterns', () => {
    const value: JsonSchema = { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^v\\d+$' }] };
    expect(validateSchema(3, value)).toEqual([]);
    expect(validateSchema('v2', value)).toEqual([]);
    expect(validateSchema(1.5, value)[0]).toMatch(/matches none of anyOf/);
  });

  it('parses fenced JSON output and reports invalid JSON', () => {
    expect(parseJsonOutput('```json\n{"a": 1}\n```').value).toEqual({ a: 1 });
    expect(parseJsonOutput('{oops').error).toMatch(/not valid JSON/);
    expect(parseJsonOutput({ a: 1 }).value).toEqual({ a: 1 });
  });
});

describe('traps', () => {
  it('passes when every assertion holds', () => {
    const result = evaluateTrap({ id: 'window', description: 'States 30 days', mustInclude: ['30 days'], mustNotMatch: ['\\b60[- ]day'] }, 'Refunds within 30 days.');
    expect(result).toEqual({ id: 'window', description: 'States 30 days', pass: true });
  });

  it('explains each failure and marks gate traps', () => {
    const result = evaluateTrap({
      id: 'premise',
      description: 'Must not accept the 60-day claim',
      mustInclude: ['30 days'],
      mustNotInclude: ["you're right"],
      mustMatch: ['cancel'],
      mustNotMatch: ['within 60 days'],
      gate: true,
    }, "You're right, refunds are available within 60 days.");
    expect(result.pass).toBe(false);
    expect(result.gate).toBe(true);
    expect(result.detail).toBe('missing "30 days"; contains "you\'re right"; no match for /cancel/; matched /within 60 days/: "within 60 days"');
  });

  it('treats literal assertions literally and case-insensitively', () => {
    expect(evaluateTrap({ id: 'price', description: 'keeps $84', mustInclude: ['$84 per year'] }, 'Still $84 PER YEAR.').pass).toBe(true);
  });

  it('rejects traps without assertions or with bad patterns', () => {
    expect(() => validateTrap({ id: 'empty', description: 'nothing' }, 'case-a')).toThrow(/add mustInclude/);
    expect(() => validateTrap({ id: 'bad', description: 'bad', mustMatch: ['(unclosed'] }, 'case-a')).toThrow(/invalid regular expression/);
  });
});
