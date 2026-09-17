import { describe, expect, it } from 'vitest';

import { bareModelName, isPeak, PricingEngine, zoneTime } from '../src/pricing.ts';
import { MODEL_PRICING } from '../src/pricing-data.ts';

/**
 * Deterministic instants, all written in UTC and annotated with the Beijing
 * wall clock they correspond to. The machine's own timezone must not matter.
 */
const T = {
  /** 2026-09-10 11:59:59 CST — one second before the V4.1-Flash price change. */
  beforePriceChange: Date.parse('2026-09-10T03:59:59Z'),
  /** 2026-09-10 12:00:00 CST — the instant the new price takes effect. */
  priceChange: Date.parse('2026-09-10T04:00:00Z'),
  /** 2026-09-10 12:00:01 CST. */
  justAfterPriceChange: Date.parse('2026-09-10T04:00:01Z'),
  /** 2026-08-17 00:00:00 CST — peak/off-peak pricing begins. */
  peakPricingStart: Date.parse('2026-08-16T16:00:00Z'),
  /** Thursday 2026-09-10 09:00:00 CST — peak window opens. */
  peak0900: Date.parse('2026-09-10T01:00:00Z'),
  /** Thursday 2026-09-10 08:59:59 CST — one second before peak. */
  beforePeak: Date.parse('2026-09-10T00:59:59Z'),
  /** Thursday 2026-09-10 11:59:59 CST — last second of the morning peak. */
  peakMorningEnd: Date.parse('2026-09-10T03:59:59Z'),
  /** Thursday 2026-09-10 12:00:00 CST — morning peak closed (off-peak). */
  peakMorningExclusiveEnd: Date.parse('2026-09-10T04:00:00Z'),
  /** Thursday 2026-09-10 14:00:00 CST — afternoon peak opens. */
  peak1400: Date.parse('2026-09-10T06:00:00Z'),
  /** Thursday 2026-09-10 17:59:59 CST — last second of the afternoon peak. */
  peakAfternoonEnd: Date.parse('2026-09-10T09:59:59Z'),
  /** Thursday 2026-09-10 18:00:00 CST — afternoon peak closed, after the price change. */
  evening: Date.parse('2026-09-10T10:00:00Z'),
  /** Thursday 2026-09-10 14:00:00 CST — afternoon peak open, after the price change. */
  peak1400AfterChange: Date.parse('2026-09-10T06:00:00Z'),
  /** Thursday 2026-09-10 18:00:00 CST — off-peak, after the price change. */
  eveningAfterChange: Date.parse('2026-09-10T10:00:00Z'),
  /** Saturday 2026-09-12 10:00:00 CST — inside the window, but a weekend. */
  saturdayPeakWindow: Date.parse('2026-09-12T02:00:00Z'),
  /** Sunday 2026-09-13 10:00:00 CST — inside the window, but a weekend. */
  sundayPeakWindow: Date.parse('2026-09-13T02:00:00Z'),
  /** Monday 2026-09-14 10:00:00 CST — same window, a weekday. */
  mondayPeakWindow: Date.parse('2026-09-14T02:00:00Z'),
  /** Saturday 2026-08-22 10:00:00 CST — inside the window BEFORE the weekend exemption. */
  saturdayBeforeExemption: Date.parse('2026-08-22T02:00:00Z'),
  /** Sunday 2026-08-23 00:00:00 CST — the exemption takes effect at this instant. */
  exemptionEffective: Date.parse('2026-08-22T16:00:00Z'),
  /** Sunday 2026-08-23 10:00:00 CST — inside the window, one second-period later. */
  sundayAfterExemption: Date.parse('2026-08-23T02:00:00Z'),
} as const;

const engine = new PricingEngine();

describe('model name resolution', () => {
  it('strips a provider-qualified label', () => {
    expect(bareModelName('deepseek-official / deepseek-v4-flash')).toBe('deepseek-v4-flash');
    expect(bareModelName('deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(bareModelName('  provider / model  ')).toBe('model');
  });

  it('maps the retired deepseek-v4-flash name onto the flash schedule', () => {
    // DeepSeek kept the old names routable after renaming the model to
    // `deepseek-flash`, and bills them at the Flash price.
    expect(engine.scheduleFor('deepseek-v4-flash')?.model).toBe('deepseek-flash');
    expect(engine.scheduleFor('deepseek-v4-flash-vision-exp')?.model).toBe('deepseek-flash');
    expect(engine.scheduleFor('deepseek-official / deepseek-v4-flash')?.model).toBe('deepseek-flash');
  });

  it('is case-insensitive', () => {
    expect(engine.scheduleFor('DeepSeek-V4-Pro')?.model).toBe('deepseek-v4-pro');
  });

  it('returns undefined for an unknown model', () => {
    expect(engine.scheduleFor('gpt-5')).toBeUndefined();
    expect(engine.periodAt('gpt-5', T.priceChange)).toBeUndefined();
  });
});

describe('price period selection', () => {
  it('selects the period whose validity window contains the instant', () => {
    expect(engine.periodAt('deepseek-v4-flash', T.beforePriceChange)?.period.id).toBe('2026-08-23');
    expect(engine.periodAt('deepseek-v4-flash', T.priceChange)?.period.id).toBe('2026-09-10');
    expect(engine.periodAt('deepseek-v4-flash', T.justAfterPriceChange)?.period.id).toBe('2026-09-10');
  });

  it('treats the effective instant as belonging to the new period', () => {
    // The announcement says the new price runs "from 12:00"; the boundary
    // instant itself must therefore be billed at the *new* rate.
    const resolution = engine.periodAt('deepseek-v4-flash', T.priceChange);
    expect(resolution?.resolution).toBe('exact');
    expect(engine.rateAt('deepseek-v4-flash', T.priceChange)?.rates.inputCacheMiss).toBe('1');
  });

  it('falls back to the earliest LATER period when none covers the instant', () => {
    // 2025-12-31 predates every known period, so the rule "prefer the first
    // period that is greater" picks the oldest one rather than nothing.
    const resolution = engine.periodAt('deepseek-v4-flash', Date.parse('2025-12-31T00:00:00Z'));
    expect(resolution?.period.id).toBe('2026-01-01');
    expect(resolution?.resolution).toBe('fallback-later');
  });

  it('falls back to the latest EARLIER period when no later period exists', () => {
    // The rule's second half is only reachable when the newest period is
    // *closed*: while the last period is open-ended it covers every later
    // instant, so `exact` wins. Both live DeepSeek schedules end open-ended,
    // which is asserted below — this branch guards a future announcement that
    // publishes an end date, so that usage can never be priced at a period that
    // had not started yet when the "prefer later" rule finds nothing later.
    const bounded: { id: string; from: number; to: number | null }[] = [
      { id: 'first', from: Date.parse('2026-01-01T00:00:00Z'), to: Date.parse('2026-02-01T00:00:00Z') },
      { id: 'second', from: Date.parse('2026-02-01T00:00:00Z'), to: Date.parse('2026-03-01T00:00:00Z') },
    ];
    /** The documented decision rule, applied to any period list. */
    const select = (instant: number): { id: string; resolution: string } => {
      for (const period of bounded) {
        const withinStart = instant >= period.from;
        const withinEnd = period.to === null || instant < period.to;
        if (withinStart && withinEnd) return { id: period.id, resolution: 'exact' };
      }
      const later = bounded.find((period) => period.from > instant);
      const fallback = later ?? bounded[bounded.length - 1];
      if (fallback === undefined) throw new Error('no periods');
      return { id: fallback.id, resolution: later === undefined ? 'fallback-earlier' : 'fallback-later' };
    };

    // Past the final boundary with nothing later available: newest price holds.
    expect(select(Date.parse('2026-04-01T00:00:00Z'))).toEqual({ id: 'second', resolution: 'fallback-earlier' });
    // Before the first boundary: the earliest later period wins.
    expect(select(Date.parse('2025-06-01T00:00:00Z'))).toEqual({ id: 'first', resolution: 'fallback-later' });

    // Why the live schedules never take the `fallback-earlier` path today.
    for (const schedule of MODEL_PRICING) {
      expect(schedule.periods.at(-1)?.effectiveTo).toBeNull();
    }
  });

  it('prefers a later period over an earlier one when the instant sits in a gap', () => {
    // V4-Pro's schedule starts on 2026-04-24. An instant before that has no
    // earlier period and a later one, so the later wins.
    expect(engine.periodAt('deepseek-v4-pro', Date.parse('2026-01-01T00:00:00Z'))?.period.id).toBe('2026-04-24');
  });
});

describe('peak / off-peak bands', () => {
  it('reports the announced rates for each band', () => {
    // Both instants are after the 2026-09-10 12:00 CST price change, so they
    // exercise the current (V4.1-Flash) rate card.
    const offPeak = engine.rateAt('deepseek-flash', T.eveningAfterChange);
    expect(offPeak?.band).toBe('off-peak');
    expect(offPeak?.rates).toEqual({ inputCacheHit: '0.02', inputCacheMiss: '1', output: '4' });

    const peak = engine.rateAt('deepseek-flash', T.peak1400AfterChange);
    expect(peak?.band).toBe('peak');
    expect(peak?.rates).toEqual({ inputCacheHit: '0.04', inputCacheMiss: '2', output: '8' });
  });

  it('uses the pre-change rates before 2026-09-10 12:00 CST', () => {
    const peak = engine.rateAt('deepseek-v4-flash', T.peak0900 - 86_400_000 * 7);
    expect(peak?.period.id).toBe('2026-08-23');
    expect(peak?.rates.inputCacheMiss).toBe('3');
  });

  it('opens the morning peak inclusive at 09:00 and closes it exclusive at 12:00', () => {
    expect(isPeak(T.beforePeak, WINDOWS, 'Asia/Shanghai')).toBe(false);
    expect(isPeak(T.peak0900, WINDOWS, 'Asia/Shanghai')).toBe(true);
    expect(isPeak(T.peakMorningEnd, WINDOWS, 'Asia/Shanghai')).toBe(true);
    expect(isPeak(T.peakMorningExclusiveEnd, WINDOWS, 'Asia/Shanghai')).toBe(false);
  });

  it('opens the afternoon peak inclusive at 14:00 and closes it exclusive at 18:00', () => {
    expect(isPeak(T.peak1400, WINDOWS, 'Asia/Shanghai')).toBe(true);
    expect(isPeak(T.peakAfternoonEnd, WINDOWS, 'Asia/Shanghai')).toBe(true);
    expect(isPeak(T.evening, WINDOWS, 'Asia/Shanghai')).toBe(false);
  });

  it('treats weekends as off-peak even inside the window hours', () => {
    // The official page scopes peak to Monday-Friday; a Saturday 10:00 CST
    // request must therefore bill at the off-peak rate.
    expect(isPeak(T.saturdayPeakWindow, WINDOWS, 'Asia/Shanghai')).toBe(false);
    expect(isPeak(T.sundayPeakWindow, WINDOWS, 'Asia/Shanghai')).toBe(false);
    expect(isPeak(T.mondayPeakWindow, WINDOWS, 'Asia/Shanghai')).toBe(true);
    expect(engine.rateAt('deepseek-flash', T.saturdayPeakWindow)?.band).toBe('off-peak');
  });

  it('splits one session across both bands', () => {
    // A session billing at 08:00 and again at 10:00 on a weekday must produce
    // two different rates, not one blended rate.
    const morning = engine.rateAt('deepseek-flash', Date.parse('2026-09-10T00:00:00Z'));
    const midMorning = engine.rateAt('deepseek-flash', T.peak0900);
    expect(morning?.band).toBe('off-peak');
    expect(midMorning?.band).toBe('peak');
    expect(morning?.rates.inputCacheMiss).not.toBe(midMorning?.rates.inputCacheMiss);
  });

  it('resolves band selection in the schedule timezone, not the machine zone', () => {
    // 2026-09-10T01:00:00Z is 09:00 in Beijing (peak) but 18:00 the previous
    // day in Los Angeles (off-peak), so the Beijing answer must win.
    expect(zoneTime(T.peak0900, 'Asia/Shanghai').secondsOfDay).toBe(9 * 3600);
    expect(isPeak(T.peak0900, WINDOWS, 'Asia/Shanghai')).toBe(true);
    expect(isPeak(T.peak0900, WINDOWS, 'America/Los_Angeles')).toBe(false);
  });
});

describe('the 2026-08-23 weekend exemption', () => {
  it('charged weekends at peak before the exemption', () => {
    // DeepSeek's first peak/valley announcement scoped the window only by clock
    // time, so a Saturday 10:00 request was billed at the peak rate.
    expect(isPeak(T.saturdayBeforeExemption, WINDOWS_EVERY_DAY, 'Asia/Shanghai')).toBe(true);
    const rate = engine.rateAt('deepseek-v4-flash', T.saturdayBeforeExemption);
    expect(rate?.period.id).toBe('2026-08-17');
    expect(rate?.band).toBe('peak');
    expect(rate?.rates.inputCacheMiss).toBe('3');
  });

  it('exempts weekends from the effective instant onward', () => {
    // The change was announced for Beijing 2026-08-23 00:00 (a Sunday).
    expect(engine.periodAt('deepseek-v4-flash', T.exemptionEffective)?.period.id).toBe('2026-08-23');
    const saturdayAfter = engine.rateAt('deepseek-v4-flash', T.saturdayBeforeExemption + 7 * 86_400_000);
    expect(saturdayAfter?.period.id).toBe('2026-08-23');
    expect(saturdayAfter?.band).toBe('off-peak');
    expect(saturdayAfter?.rates.inputCacheMiss).toBe('1.5');
  });

  it('switches period exactly at Beijing 2026-08-23 00:00', () => {
    const oneSecondBefore = Date.parse('2026-08-22T15:59:59Z');
    expect(engine.periodAt('deepseek-v4-flash', oneSecondBefore)?.period.id).toBe('2026-08-17');
    expect(engine.periodAt('deepseek-v4-flash', oneSecondBefore)?.resolution).toBe('exact');
    expect(engine.periodAt('deepseek-v4-flash', T.exemptionEffective)?.period.id).toBe('2026-08-23');
    expect(engine.periodAt('deepseek-v4-flash', T.exemptionEffective)?.resolution).toBe('exact');
  });

  it('keeps the unit price unchanged across the exemption', () => {
    // 08-23 changed only which hours count as peak, not the rates themselves.
    const before = engine.rateAt('deepseek-v4-flash', T.saturdayBeforeExemption);
    const after = engine.rateAt('deepseek-v4-flash', T.saturdayBeforeExemption + 7 * 86_400_000);
    expect(before?.period.offPeak).toEqual(after?.period.offPeak);
    expect(before?.period.peak).toEqual(after?.period.peak);
    expect(after?.band).toBe('off-peak');
  });

  it('still charges weekdays at peak after the exemption', () => {
    expect(engine.rateAt('deepseek-v4-flash', T.mondayPeakWindow)?.band).toBe('peak');
  });

  it('shares the transition with V4-Pro', () => {
    const before = engine.rateAt('deepseek-v4-pro', T.saturdayBeforeExemption);
    const after = engine.rateAt('deepseek-v4-pro', T.saturdayBeforeExemption + 7 * 86_400_000);
    expect(before?.band).toBe('peak');
    expect(after?.band).toBe('off-peak');
  });
});

describe('schedule integrity', () => {
  it('lists periods in ascending order with no overlap', () => {
    for (const schedule of MODEL_PRICING) {
      for (let index = 1; index < schedule.periods.length; index += 1) {
        const previous = schedule.periods[index - 1];
        const current = schedule.periods[index];
        expect(current?.effectiveFrom).toBeGreaterThan(previous?.effectiveFrom ?? 0);
        expect(previous?.effectiveTo).toBe(current?.effectiveFrom);
      }
    }
  });

  it('gives every period a source URL', () => {
    for (const schedule of MODEL_PRICING) {
      for (const period of schedule.periods) {
        // Live docs or a Wayback snapshot of the same official page.
        expect(period.source).toMatch(/^https:\/\/(api-docs\.deepseek\.com|web\.archive\.org\/web\/\d+\/https:\/\/api-docs\.deepseek\.com)\//);
        expect(period.note.length).toBeGreaterThan(0);
      }
    }
  });

  it('prices peak at exactly twice off-peak, as DeepSeek states', () => {
    for (const schedule of MODEL_PRICING) {
      for (const period of schedule.periods) {
        if (period.peak === null) continue;
        for (const key of ['inputCacheHit', 'inputCacheMiss', 'output'] as const) {
          expect(Number(period.peak[key])).toBeCloseTo(Number(period.offPeak[key]) * 2, 10);
        }
      }
    }
  });
});

/**
 * The weekday peak windows published from 2026-08-23 onward, repeated here so
 * `isPeak` is exercised directly rather than only through the schedule.
 */
const WINDOWS = [
  { fromHour: 9, toHour: 12, weekdays: [1, 2, 3, 4, 5] },
  { fromHour: 14, toHour: 18, weekdays: [1, 2, 3, 4, 5] },
] as const;

/** The every-day windows DeepSeek charged from 2026-08-17 until 2026-08-23. */
const WINDOWS_EVERY_DAY = [
  { fromHour: 9, toHour: 12, weekdays: null },
  { fromHour: 14, toHour: 18, weekdays: null },
] as const;
