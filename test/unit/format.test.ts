import { describe, expect, it } from 'vitest';

import { emptyBuckets } from '../../src/core/buckets.ts';
import { formatDecimal, parseDecimal, scalePerMillion, sumAmounts } from '../../src/core/money.ts';

describe('parseDecimal', () => {
  it('parses the rates vendors publish', () => {
    expect(parseDecimal('0.02')).toBe(20_000_000n);
    expect(parseDecimal('1')).toBe(1_000_000_000n);
    expect(parseDecimal('13.5')).toBe(13_500_000_000n);
    expect(parseDecimal('0')).toBe(0n);
  });

  it('handles a leading or trailing decimal point and signs', () => {
    expect(parseDecimal('.5')).toBe(500_000_000n);
    expect(parseDecimal('5.')).toBe(5_000_000_000n);
    expect(parseDecimal('-2.5')).toBe(-2_500_000_000n);
    expect(parseDecimal('+2.5')).toBe(2_500_000_000n);
  });

  it('rejects non-decimal input rather than silently returning NaN', () => {
    expect(() => parseDecimal('abc')).toThrow(/不是合法的十进制字面量/);
    expect(() => parseDecimal('1e3')).toThrow(/不是合法的十进制字面量/);
    expect(() => parseDecimal('')).toThrow(/不是合法的十进制字面量/);
  });

  it('rejects more fractional digits than the scale can hold', () => {
    expect(() => parseDecimal('0.0000000001')).toThrow(/小数位超过/);
  });
});

describe('scalePerMillion', () => {
  it('charges exactly one rate unit per million tokens', () => {
    expect(scalePerMillion(1_000_000, parseDecimal('1'))).toBe(parseDecimal('1'));
    expect(scalePerMillion(1_000_000, parseDecimal('13.5'))).toBe(parseDecimal('13.5'));
  });

  it('is exact where floating point would drift', () => {
    const each = scalePerMillion(100_000, parseDecimal('1'));
    expect(sumAmounts([each, each, each])).toBe(parseDecimal('0.3'));
    expect(parseDecimal('0.1') + parseDecimal('0.2')).toBe(parseDecimal('0.3'));
  });

  it('returns zero for zero tokens or a zero rate', () => {
    expect(scalePerMillion(0, parseDecimal('9'))).toBe(0n);
    expect(scalePerMillion(12345, parseDecimal('0'))).toBe(0n);
  });

  it('rejects invalid token counts', () => {
    expect(() => scalePerMillion(-1, 1n)).toThrow(/非负安全整数/);
    expect(() => scalePerMillion(1.5, 1n)).toThrow(/非负安全整数/);
  });
});

describe('formatDecimal', () => {
  it('renders with the requested precision', () => {
    expect(formatDecimal(parseDecimal('0.02'), 4)).toBe('0.0200');
    expect(formatDecimal(parseDecimal('4'), 2)).toBe('4.00');
  });

  it('rounds half-up at the requested precision', () => {
    expect(formatDecimal(parseDecimal('0.00005'), 4)).toBe('0.0001');
    expect(formatDecimal(parseDecimal('2.345'), 2)).toBe('2.35');
  });

  it('keeps a negative sign only for non-zero values', () => {
    expect(formatDecimal(parseDecimal('-1.5'), 1)).toBe('-1.5');
    expect(formatDecimal(-1n, 4)).toBe('0.0000');
  });

  it('rejects an out-of-range precision', () => {
    expect(() => formatDecimal(1n, -1)).toThrow(/digits/);
    expect(() => formatDecimal(1n, 10)).toThrow(/digits/);
  });
});

describe('emptyBuckets', () => {
  it('zeroes every counter', () => {
    expect(emptyBuckets()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
  });
});
