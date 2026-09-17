import { describe, expect, it } from 'vitest';

import { formatDecimal, parseDecimal, scalePerMillion, sumAmounts } from '../../src/core/money.ts';

describe('parseDecimal', () => {
  it('parses the rates DeepSeek publishes', () => {
    expect(parseDecimal('0.02')).toBe(20_000_000n);
    expect(parseDecimal('1')).toBe(1_000_000_000n);
    expect(parseDecimal('13.5')).toBe(13_500_000_000n);
    expect(parseDecimal('27')).toBe(27_000_000_000n);
    expect(parseDecimal('0')).toBe(0n);
  });

  it('handles a leading or trailing decimal point and signs', () => {
    expect(parseDecimal('.5')).toBe(500_000_000n);
    expect(parseDecimal('5.')).toBe(5_000_000_000n);
    expect(parseDecimal('-2.5')).toBe(-2_500_000_000n);
    expect(parseDecimal('+2.5')).toBe(2_500_000_000n);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseDecimal('  0.05  ')).toBe(50_000_000n);
  });

  it('rejects non-decimal input rather than silently returning NaN', () => {
    expect(() => parseDecimal('abc')).toThrow(/不是合法的十进制字面量/);
    expect(() => parseDecimal('1e3')).toThrow(/不是合法的十进制字面量/);
    expect(() => parseDecimal('')).toThrow(/不是合法的十进制字面量/);
    expect(() => parseDecimal('NaN')).toThrow(/不是合法的十进制字面量/);
  });

  it('rejects more fractional digits than the scale can hold', () => {
    expect(() => parseDecimal('0.0000000001')).toThrow(/小数位超过/);
  });
});

describe('scalePerMillion', () => {
  it('charges exactly one rate unit per million tokens', () => {
    // 1,000,000 tokens at 1 CNY/1M is exactly 1 CNY.
    expect(scalePerMillion(1_000_000, parseDecimal('1'))).toBe(parseDecimal('1'));
    // 1,000,000 tokens at 13.5 CNY/1M is exactly 13.5 CNY.
    expect(scalePerMillion(1_000_000, parseDecimal('13.5'))).toBe(parseDecimal('13.5'));
  });

  it('bills cache hits at the cache-hit rate, not the cache-miss rate', () => {
    // 4,000,000 cached tokens at 0.02 CNY/1M = 0.08 CNY.
    expect(scalePerMillion(4_000_000, parseDecimal('0.02'))).toBe(parseDecimal('0.08'));
    // The same tokens at the miss rate (1 CNY/1M) cost 4 CNY.
    expect(scalePerMillion(4_000_000, parseDecimal('1'))).toBe(parseDecimal('4'));
  });

  it('is exact where floating point would drift', () => {
    // 0.1 + 0.2 style drift: 3 * 0.1 CNY is exactly 0.3 CNY here.
    const each = scalePerMillion(100_000, parseDecimal('1'));
    expect(sumAmounts([each, each, each])).toBe(parseDecimal('0.3'));
    expect(parseDecimal('0.1') + parseDecimal('0.2')).toBe(parseDecimal('0.3'));
  });

  it('returns zero for zero tokens or a zero rate', () => {
    expect(scalePerMillion(0, parseDecimal('9'))).toBe(0n);
    expect(scalePerMillion(12345, parseDecimal('0'))).toBe(0n);
  });

  it('truncates at the ninth decimal, far below display precision', () => {
    // One token at 0.02 CNY/1M is 2e-8 CNY, which the scale can represent.
    expect(scalePerMillion(1, parseDecimal('0.02'))).toBe(20n);
    // One token at 1 CNY/1M is 1e-6 CNY.
    expect(scalePerMillion(1, parseDecimal('1'))).toBe(1000n);
  });

  it('rejects invalid token counts', () => {
    expect(() => scalePerMillion(-1, 1n)).toThrow(/非负安全整数/);
    expect(() => scalePerMillion(1.5, 1n)).toThrow(/非负安全整数/);
    expect(() => scalePerMillion(Number.NaN, 1n)).toThrow(/非负安全整数/);
  });
});

describe('formatDecimal', () => {
  it('renders with the requested precision', () => {
    expect(formatDecimal(parseDecimal('0.02'), 4)).toBe('0.0200');
    expect(formatDecimal(parseDecimal('18.9872'), 4)).toBe('18.9872');
    expect(formatDecimal(parseDecimal('4'), 2)).toBe('4.00');
    expect(formatDecimal(parseDecimal('4'), 0)).toBe('4');
  });

  it('rounds half-up at the requested precision', () => {
    expect(formatDecimal(parseDecimal('0.00005'), 4)).toBe('0.0001');
    expect(formatDecimal(parseDecimal('0.00004'), 4)).toBe('0.0000');
    expect(formatDecimal(parseDecimal('2.345'), 2)).toBe('2.35');
  });

  it('keeps a negative sign only for non-zero values', () => {
    expect(formatDecimal(parseDecimal('-1.5'), 1)).toBe('-1.5');
    expect(formatDecimal(-1n, 4)).toBe('0.0000');
  });

  it('round-trips through parse and format at the display precision', () => {
    const cases: [string, string][] = [
      ['0.02', '0.0200'],
      ['1', '1.0000'],
      ['13.5', '13.5000'],
      ['27', '27.0000'],
      ['0.04', '0.0400'],
      ['4.5', '4.5000'],
    ];
    for (const [input, expected] of cases) {
      expect(formatDecimal(parseDecimal(input), 4)).toBe(expected);
    }
  });

  it('rejects an out-of-range precision', () => {
    expect(() => formatDecimal(1n, -1)).toThrow(/digits/);
    expect(() => formatDecimal(1n, 10)).toThrow(/digits/);
  });
});
