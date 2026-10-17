import { describe, expect, it } from 'vitest';
import {
  baselineDrops,
  carryCoverage,
  inputEcho,
  isOneEdit,
  keywordCoverage,
  misspellings,
  nearDuplicatePairs,
  numericTraceability,
  qualifierDrops,
  unsupportedLines,
} from '../src/checks/grounding.js';

const SOURCE = [
  'Annual plans can be refunded within 30 days of purchase.',
  'Refunds reach the original payment method within 5 to 10 business days.',
].join('\n');

describe('numericTraceability', () => {
  it('flags numbers no source states', () => {
    const result = numericTraceability('Refunds within 30 days, processed in 24 hours.', [SOURCE]);
    expect(result.untraceable).toEqual(['24']);
    expect(result.total).toBe(2);
    expect(result.rate).toBe(0.5);
  });

  it('matches across formatting and honours allowances', () => {
    expect(numericTraceability('About $1,400,000 saved', ['saved $1400000']).untraceable).toEqual([]);
    expect(numericTraceability('Call 1800 555 0199', [SOURCE], ['1800', '555', '0199']).untraceable).toEqual([]);
  });

  it('reads as fully traceable when the output has no numbers', () => {
    expect(numericTraceability('No figures here.', [SOURCE])).toEqual({ total: 0, untraceable: [], rate: 1 });
  });
});

describe('unsupportedLines', () => {
  it('flags a line with a content word no source uses', () => {
    const result = unsupportedLines([
      'Annual plans are refundable within 30 days.',
      'We guarantee a reply within two hours.',
    ], [SOURCE]);
    expect(result.count).toBe(1);
    expect(result.examples[0]).toContain('[guarantee');
  });

  it('folds inflections and ignores framing and courtesy words', () => {
    expect(unsupportedLines(['Thanks for reaching out. Your refund was processed to the original payment method.'], [
      'We process refunds to the original payment method.',
    ]).count).toBe(0);
  });

  it('accepts explicitly allowed words', () => {
    expect(unsupportedLines(['Quillbox refunds annual plans.'], [SOURCE], ['Quillbox']).count).toBe(0);
  });
});

describe('nearDuplicatePairs', () => {
  it('counts restatements within a group only', () => {
    const line = 'Cut cloud spend by 38% through right-sizing and spot instances';
    const again = 'Through right-sizing and spot instances, cut cloud spend by 38%';
    expect(nearDuplicatePairs([[line, again, 'Led a team of seven engineers']]).count).toBe(1);
    expect(nearDuplicatePairs([[line], [again]]).count).toBe(0);
  });
});

describe('inputEcho', () => {
  const request = 'You will own the observability roadmap and partner with SRE on incident reviews.';
  const history = 'Built Grafana dashboards for 30 services and ran weekly incident reviews.';

  it('flags a line written from the request rather than the facts', () => {
    const result = inputEcho(['Owned the observability roadmap and partnered with SRE on incident reviews.'], [request], [history]);
    expect(result.count).toBe(1);
  });

  it('does not flag a fact the sources state in the request’s words', () => {
    expect(inputEcho(['Ran weekly incident reviews and built Grafana dashboards for 30 services.'], [request], [history]).count).toBe(0);
  });
});

describe('carryCoverage', () => {
  it('reports facts no output line carries', () => {
    const result = carryCoverage(
      ['Annual plans can be refunded within 30 days of purchase.', 'Refunds reach the original payment method within 5 to 10 business days.'],
      ['You can get a refund on an annual plan within 30 days of purchase.'],
    );
    expect(result.total).toBe(2);
    expect(result.missing).toEqual(['Refunds reach the original payment method within 5 to 10 business days.']);
    expect(result.rate).toBe(0.5);
  });
});

describe('keywordCoverage', () => {
  it('matches whole terms through inflection', () => {
    const result = keywordCoverage('You can cancel at any time; refunds take 30 days.', ['30 days', 'cancellation', 'refund']);
    expect(result.missing).toEqual(['cancellation']);
  });
});

describe('misspellings', () => {
  it('detects one-edit near-misses and transpositions', () => {
    expect(isOneEdit('kuberentes', 'kubernetes')).toBe(true);
    expect(isOneEdit('reconcilation', 'reconciliation')).toBe(true);
    expect(isOneEdit('drive', 'drove')).toBe(true);
    expect(isOneEdit('payment', 'payments')).toBe(true);
    expect(isOneEdit('payment', 'pigment')).toBe(false);
  });

  it('flags misspelt source words but not inflections or new words', () => {
    const result = misspellings('Migrated 40 services to Kuberentes and drove the reconcilation of 12 ledgers.', [
      'Migrated services to Kubernetes. Drive the reconciliation of ledgers.',
    ]);
    expect(result.examples).toEqual(['kuberentes (source: kubernetes)', 'reconcilation (source: reconciliation)']);
  });

  it('flags a source word split by a stray space', () => {
    expect(misspellings('Implemented U KG payroll.', ['Implemented UKG payroll.']).examples).toEqual(['u kg (source: ukg)']);
  });
});

describe('baselineDrops', () => {
  it('flags an improvement that kept its result but lost its start', () => {
    const source = ['Cut invoice turnaround from 10 business days to 6 by automating approvals.'];
    expect(baselineDrops(['Cut invoice turnaround to 6 business days by automating approvals.'], source).count).toBe(1);
    expect(baselineDrops(['Cut invoice turnaround from 10 to 6 business days by automating approvals.'], source).count).toBe(0);
  });

  it('ignores year ranges', () => {
    expect(baselineDrops(['Worked there to 2021.'], ['Worked there from 2018 to 2021.']).pairs).toBe(0);
  });
});

describe('qualifierDrops', () => {
  it('flags a dropped time window', () => {
    const source = ['Delivered zero audit adjustments in the last two years across all entities.'];
    expect(qualifierDrops(['Delivered zero audit adjustments across all entities.'], source).count).toBe(1);
    expect(qualifierDrops(['Delivered zero audit adjustments in the last 2 years across all entities.'], source).count).toBe(0);
  });

  it('flags a dropped approximation but accepts a kept one or a range', () => {
    const source = ['Managed a portfolio of around 60 clients in the retail sector.'];
    expect(qualifierDrops(['Managed a portfolio of 60 clients in the retail sector.'], source).count).toBe(1);
    expect(qualifierDrops(['Managed a portfolio of about 60 clients in the retail sector.'], source).count).toBe(0);
  });
});
