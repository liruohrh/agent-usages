/**
 * Holiday-aware tier selection.
 *
 * DeepSeek's peak windows exclude Chinese public holidays: a weekday that happens
 * to be a holiday is off-peak for the whole day, and that is real money — the peak
 * card is twice the off-peak one. These tests pin both halves of the mechanism:
 * the period *opts in* by naming a calendar, and a date the calendar does not
 * cover falls back to the weekday rule (with the configuration warning about it).
 */

import { describe, expect, it } from 'vitest';

import { emptyBuckets } from '../../src/core/buckets.ts';
import { parseHolidaysConfig, shippedHolidays } from '../../src/config/holidays.ts';
import { providerFromConfig, shippedPricingText, parsePricingConfig } from '../../src/pricing/catalog.ts';
import { createPricingEngine } from '../../src/pricing/index.ts';
import { perMillion, TEST_CURRENCY } from '../support/stub-pricing.ts';
import { record } from '../support/dataset.ts';

/** A small calendar, so the assertions do not move when the real one is updated. */
const FIXTURE = parseHolidaysConfig({
  version: 1,
  zone: 'Asia/Shanghai',
  source: 'test fixture',
  days: {
    '2026-10-01': '国庆节',
    '2026-10-02': '国庆节',
    '2026-10-05': '国庆节',
  },
});

/**
 * A provider whose peak window is weekdays 09:00–12:00 UTC.
 * @param calendar - the calendar id to opt into, when any.
 * @returns the provider.
 */
function provider(calendar?: 'cn') {
  return providerFromConfig({
    id: 'test',
    label: 'Test Vendor',
    defaultModel: 'm',
    models: [
      {
        model: 'm',
        aliases: ['m'],
        periods: [
          {
            id: '2026-01-01',
            label: 'weekday peak',
            from: Date.parse('2026-01-01T00:00:00Z'),
            to: null,
            currency: TEST_CURRENCY.code,
            offPeak: [perMillion('input-miss', 'miss', 'input', '1')],
            peak: [perMillion('input-miss', 'miss', 'input', '2')],
            peakWindows: [{ fromHour: 9, toHour: 12, weekdays: [1, 2, 3, 4, 5] }],
            utcOffset: 0,
            source: 'test',
            note: 'test',
            ...(calendar === undefined ? {} : { holidayCalendar: calendar }),
          },
        ],
      },
    ],
  });
}

const engine = createPricingEngine(provider('cn'), { holidays: FIXTURE });
const optedOut = createPricingEngine(provider(), { holidays: FIXTURE });
const noCalendar = createPricingEngine(provider('cn'));

/** One record at an instant, with a token or two so the cost is not zero. */
const at = (iso: string) => record({ time: Date.parse(iso), model: 'm', tokens: { ...emptyBuckets(), input: 1_000_000 } });

describe('a holiday is off-peak all day', () => {
  it('charges the off-peak card inside a peak window that happens to be a holiday', () => {
    // 2026-10-01 is a Thursday, so the weekday rule alone would say peak.
    const weekday = engine.resolve(at('2026-09-30T10:00:00Z'));
    const holiday = engine.resolve(at('2026-10-01T10:00:00Z'));
    expect(weekday?.tier).toBe('peak');
    expect(weekday?.reason).toBe('peak-window');
    expect(holiday?.tier).toBe('off-peak');
    expect(holiday?.reason).toBe('holiday');
    expect(holiday?.holiday).toBe('国庆节');
  });

  it('says so for every hour of the holiday, not only inside the window', () => {
    for (const iso of ['2026-10-01T01:00:00Z', '2026-10-01T10:00:00Z', '2026-10-01T22:00:00Z']) {
      const resolved = engine.resolve(at(iso));
      expect(resolved?.tier, iso).toBe('off-peak');
      expect(resolved?.reason, iso).toBe('holiday');
    }
  });

  it('keeps the weekend rule: a Saturday is off-peak without being a holiday', () => {
    const saturday = engine.resolve(at('2026-09-26T10:00:00Z'));
    expect(saturday?.tier).toBe('off-peak');
    expect(saturday?.reason).toBe('off-window');
    expect(saturday?.holiday).toBeUndefined();
  });

  it('costs half, which is the point', () => {
    // One million miss tokens at $1 vs $2 per million (amounts are scaled integers).
    const peak = engine.costOf(at('2026-09-30T10:00:00Z'))?.total;
    const holiday = engine.costOf(at('2026-10-01T10:00:00Z'))?.total;
    expect(peak).toBeDefined();
    expect(holiday).toBe(peak! / 2n);
  });
});

describe('the calendar is opt-in, and its absence is not silent', () => {
  it('ignores holidays unless the period names a calendar', () => {
    expect(optedOut.resolve(at('2026-10-01T10:00:00Z'))?.tier).toBe('peak');
  });

  it('falls back to the weekday rule when the engine has no calendar', () => {
    const resolved = noCalendar.resolve(at('2026-10-01T10:00:00Z'));
    expect(resolved?.tier).toBe('peak');
    expect(resolved?.reason).toBe('peak-window');
  });

  it('falls back for a date the calendar does not cover', () => {
    // 2027-01-04 is a Monday, past the last day the fixture knows.
    const resolved = engine.resolve(at('2027-01-04T10:00:00Z'));
    expect(resolved?.tier).toBe('peak');
    expect(resolved?.reason).toBe('peak-window');
  });
});

describe('the shipped calendar', () => {
  const calendar = shippedHolidays();

  it('covers the current year and only lists real dates', () => {
    expect(calendar.zone).toBe('Asia/Shanghai');
    expect(calendar.from.startsWith('2026-')).toBe(true);
    expect(calendar.to.startsWith('2026-')).toBe(true);
    // The State Council's 2026 notice: 元旦 3 days, 春节 9, 清明 3, 劳动节 5,
    // 端午 3, 中秋 3, 国庆 7.
    expect(calendar.days.size).toBe(33);
    expect(calendar.days.get('2026-02-17')).toBe('春节');
    expect(calendar.days.get('2026-10-07')).toBe('国庆节');
  });

  it('prices a real 国庆 morning as off-peak, with the shipped price list', () => {
    const provider = parsePricingConfig(shippedPricingText()).providers.find((entry) => entry.id === 'deepseek');
    expect(provider, 'the shipped DeepSeek provider').toBeDefined();
    const real = createPricingEngine(providerFromConfig(provider!), { holidays: calendar });
    // 2026-10-01 10:00 Beijing time — a Thursday, inside the published peak hours.
    const holiday = real.resolve(
      record({
        time: Date.parse('2026-10-01T02:00:00Z'),
        model: 'deepseek-flash',
        tokens: { ...emptyBuckets(), input: 1_000_000 },
      }),
    );
    expect(holiday?.tier).toBe('off-peak');
    expect(holiday?.holiday).toBe('国庆节');
    // The same clock on an ordinary Thursday is peak.
    const ordinary = real.resolve(
      record({
        time: Date.parse('2026-09-24T02:00:00Z'),
        model: 'deepseek-flash',
        tokens: { ...emptyBuckets(), input: 1_000_000 },
      }),
    );
    expect(ordinary?.tier).toBe('peak');
  });
});
