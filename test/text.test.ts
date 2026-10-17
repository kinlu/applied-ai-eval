import { describe, expect, it } from 'vitest';
import {
  extractNumericFacts,
  isRestatement,
  normalizeNumericToken,
  splitSentences,
  statementCoverage,
  statementOverlap,
  stemToken,
  tokenize,
} from '../src/checks/text.js';

describe('tokenize', () => {
  it('lower-cases Latin words and keeps compounds', () => {
    expect(tokenize('Migrated the CI/CD pipeline to event-sourced C++ services')).toEqual([
      'migrated', 'the', 'ci/cd', 'pipeline', 'to', 'event-sourced', 'c++', 'services',
    ]);
  });

  it('keeps accented letters and drops punctuation-only runs', () => {
    expect(tokenize('Café — naïve résumé - ok')).toEqual(['café', 'naïve', 'résumé', 'ok']);
  });

  it('turns CJK runs into overlapping bigrams', () => {
    expect(tokenize('毛利率41%')).toEqual(['毛利', '利率', '41']);
    expect(tokenize('会')).toEqual(['会']);
  });
});

describe('stemToken', () => {
  it('folds common inflections and leaves CJK alone', () => {
    expect(stemToken('managed')).toBe(stemToken('manage'));
    expect(stemToken('services')).toBe(stemToken('service'));
    expect(stemToken('定价')).toBe('定价');
  });
});

describe('statement overlap and coverage', () => {
  it('scores a split-out sentence near 1 and unrelated facts low', () => {
    const source = 'Cut authorisation p99 latency from 480ms to 95ms by re-architecting the hot path';
    expect(statementOverlap('Cut p99 authorisation latency from 480ms to 95ms', source)).toBeGreaterThan(0.9);
    expect(statementOverlap('Mentored four engineers on the payments team', source)).toBeLessThan(0.2);
  });

  it('coverage is directional', () => {
    const short = 'Refunds are returned within 5 to 10 business days';
    const long = 'Approved refunds are returned to the original payment method within 5 to 10 business days.';
    expect(statementCoverage(short, long)).toBe(1);
    expect(statementCoverage(long, short)).toBeLessThan(0.7);
  });

  it('works on Chinese text through bigrams', () => {
    expect(statementOverlap('定价维持9.99美元', '会议决定定价维持9.99美元不变')).toBeGreaterThan(0.8);
  });
});

describe('isRestatement', () => {
  it('flags the same fact said twice', () => {
    expect(isRestatement(
      'Reduced AWS spend by 38% through right-sizing and spot instances',
      'Through right-sizing and spot instances, reduced AWS spend by 38%',
      0.6,
    )).toBe(true);
  });

  it('does not flag short sibling lines that share a frame', () => {
    expect(isRestatement('Prepared accruals for 15 entities', 'Prepared journals for 15 entities', 0.6)).toBe(false);
  });
});

describe('numeric facts', () => {
  it('extracts money, percentages, multipliers and counts', () => {
    expect(extractNumericFacts('Saved $1.4M (38%) at 3x speed for 1,200 users')).toEqual(['$1.4M', '38%', '3x', '1,200']);
  });

  it('normalises to a comparable core', () => {
    expect(normalizeNumericToken('$1.4M')).toBe('1.4');
    expect(normalizeNumericToken('1,200')).toBe('1200');
    expect(normalizeNumericToken('08')).toBe('8');
    expect(normalizeNumericToken('0.5')).toBe('0.5');
  });

  it('finds numbers next to CJK characters', () => {
    expect(extractNumericFacts('毛利率大概41%，定价9.99美元')).toEqual(['41%', '9.99']);
  });
});

describe('splitSentences', () => {
  it('splits on line breaks and sentence ends, including CJK punctuation', () => {
    expect(splitSentences('One fact. Another fact!\n第三句。第四句？')).toEqual(['One fact.', 'Another fact!', '第三句。', '第四句？']);
  });

  it('keeps decimals intact', () => {
    expect(splitSentences('It costs 9.99 per month. Cancel any time.')).toEqual(['It costs 9.99 per month.', 'Cancel any time.']);
  });
});
