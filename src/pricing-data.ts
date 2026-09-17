/**
 * DeepSeek official API price schedule.
 *
 * All rates are CNY per 1,000,000 tokens, transcribed from DeepSeek's official
 * *Models & Pricing* page and *Change Log*, plus archived snapshots of that page
 * for periods that are no longer live. Nothing here is interpolated or derived —
 * every period was announced by DeepSeek, and each carries the URL it came from.
 *
 * Sources (fetched 2026-09-17):
 * - https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * - https://api-docs.deepseek.com/quick_start/pricing
 * - https://api-docs.deepseek.com/zh-cn/updates
 * - https://web.archive.org/web/20260323134549/https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * - https://web.archive.org/web/20260424030643/https://api-docs.deepseek.com/quick_start/pricing/
 * - https://web.archive.org/web/20260607093431/https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * - https://web.archive.org/web/20260816161307/https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * - https://web.archive.org/web/20260822130627/https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * - https://web.archive.org/web/20260823120000/https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 *
 * DeepSeek bills three things:
 *  - input tokens that MISS the context cache (缓存未命中)
 *  - input tokens that HIT the context cache (缓存命中)
 *  - output tokens (reasoning tokens are included in the output count)
 * Cache WRITES are never billed: DeepSeek builds the disk cache automatically and
 * charges only reads. `cacheWrite` is reported for transparency, priced at the
 * cache-miss rate, and is always 0 for DeepSeek's own adapter.
 */

/** Billing grid for one band, in CNY per 1M tokens. */
export interface RateCard {
  /** CNY per 1M prompt tokens that hit the context cache. */
  inputCacheHit: string;
  /** CNY per 1M prompt tokens that missed the context cache. */
  inputCacheMiss: string;
  /** CNY per 1M completion tokens. */
  output: string;
}

/** A recurring daily peak window, expressed in the period's own timezone. */
export interface PeakWindow {
  /** Start hour, inclusive, in 24-hour local time. */
  fromHour: number;
  /** End hour, exclusive, in 24-hour local time. */
  toHour: number;
  /**
   * Weekdays (0 = Sunday … 6 = Saturday) the window applies to. `null` means
   * every day of the week, which is what DeepSeek charged from 2026-08-17 until
   * weekends were exempted on 2026-08-23.
   */
  weekdays: readonly number[] | null;
}

/** A model's price across a contiguous span of time. */
export interface PricingPeriod {
  /** Stable identifier, conventionally the effective date. */
  id: string;
  /** Label for display. */
  label: string;
  /** Inclusive start of validity, milliseconds since the Unix epoch (UTC). */
  effectiveFrom: number;
  /** Exclusive end of validity, or `null` when the period is open-ended. */
  effectiveTo: number | null;
  /** Rate charged outside every {@link peakWindows} window. */
  offPeak: RateCard;
  /** Rate charged inside a {@link peakWindows} window. */
  peak: RateCard | null;
  /** Peak windows, in local device time. An empty list means a flat schedule. */
  peakWindows: readonly PeakWindow[];
  /** IANA zone the window hours are expressed in. */
  peakTimezone: string;
  /** Official source this period was transcribed from. */
  source: string;
  /** Free-form provenance note. */
  note: string;
}

/** A billable model and its chronological price periods. */
export interface ModelPricing {
  /** Canonical DeepSeek model id. */
  model: string;
  /** Model names the provider has routed to this model, including retired spellings. */
  aliases: readonly string[];
  /** Periods in ascending `effectiveFrom` order. */
  periods: readonly PricingPeriod[];
}

/** Monday–Friday, used by the peak windows in force from 2026-08-23 onward. */
const WEEKDAYS_MON_FRI: readonly number[] = [1, 2, 3, 4, 5];

/** Every day of the week, used by the peak windows in force 2026-08-17 → 2026-08-22. */
const EVERY_DAY: null = null;

/** Milliseconds for a UTC instant written as a Beijing wall-clock time (UTC+8). */
function beijing(text: string): number {
  return Date.parse(`${text}+08:00`);
}

/** Peak windows as DeepSeek first published them on 2026-08-17: every day, same hours. */
const PEAK_WINDOWS_EVERY_DAY: readonly PeakWindow[] = [
  { fromHour: 9, toHour: 12, weekdays: EVERY_DAY },
  { fromHour: 14, toHour: 18, weekdays: EVERY_DAY },
];

/** Peak windows after the 2026-08-23 weekend exemption: weekdays only. */
const PEAK_WINDOWS_WEEKDAYS: readonly PeakWindow[] = [
  { fromHour: 9, toHour: 12, weekdays: WEEKDAYS_MON_FRI },
  { fromHour: 14, toHour: 18, weekdays: WEEKDAYS_MON_FRI },
];

/** The live docs, the live changelog, and the archived snapshot the row came from. */
const DOCS_PRICING = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';
const DOCS_CHANGELOG = 'https://api-docs.deepseek.com/zh-cn/updates';
const ARCHIVE = (stamp: string): string =>
  `https://web.archive.org/web/${stamp}/https://api-docs.deepseek.com/zh-cn/quick_start/pricing/`;

/**
 * V4-Flash price periods, oldest first.
 *
 * `deepseek-chat` and `deepseek-reasoner` were the billable names until
 * 2026-04-24; DeepSeek then mapped them onto V4-Flash's non-thinking and
 * thinking modes, and retired them on 2026-07-24. Records mentioning the older
 * names therefore belong on this schedule too.
 */
const FLASH_PERIODS: readonly PricingPeriod[] = [
  {
    id: '2026-01-01',
    label: 'V3.2（deepseek-chat / deepseek-reasoner）统一价',
    effectiveFrom: beijing('2026-01-01T00:00:00'),
    effectiveTo: beijing('2026-04-24T00:00:00'),
    offPeak: { inputCacheHit: '0.2', inputCacheMiss: '2', output: '3' },
    peak: null,
    peakWindows: [],
    peakTimezone: 'Asia/Shanghai',
    source: ARCHIVE('20260323134549'),
    note: 'DeepSeek-V3.2 的 deepseek-chat / deepseek-reasoner 统一价，不分峰谷。该价格自 2025-12-01 V3.2 上线沿用至 2026-04-24 V4 发布。',
  },
  {
    id: '2026-04-24',
    label: 'V4-Flash 预览版上线价',
    effectiveFrom: beijing('2026-04-24T00:00:00'),
    effectiveTo: beijing('2026-04-26T20:15:00'),
    offPeak: { inputCacheHit: '0.2', inputCacheMiss: '1', output: '2' },
    peak: null,
    peakWindows: [],
    peakTimezone: 'Asia/Shanghai',
    source: ARCHIVE('20260424030643'),
    note: 'DeepSeek API 上线 V4-Pro / V4-Flash，flat 定价。deepseek-chat / deepseek-reasoner 自此时起分别对应 V4-Flash 的非思考/思考模式并按其价格计费。',
  },
  {
    id: '2026-04-26',
    label: 'V4-Flash 缓存命中降价',
    effectiveFrom: beijing('2026-04-26T20:15:00'),
    effectiveTo: beijing('2026-08-17T00:00:00'),
    offPeak: { inputCacheHit: '0.02', inputCacheMiss: '1', output: '2' },
    peak: null,
    peakWindows: [],
    peakTimezone: 'Asia/Shanghai',
    source: ARCHIVE('20260607093431'),
    note: '缓存命中价降至上线价的 1/10，未命中与输出价不变；2026-07-31 V4-Flash 转正式版（公测）时价格未变。',
  },
  {
    id: '2026-08-17',
    label: 'V4-Flash（正式版）峰谷定价',
    effectiveFrom: beijing('2026-08-17T00:00:00'),
    effectiveTo: beijing('2026-08-23T00:00:00'),
    offPeak: { inputCacheHit: '0.05', inputCacheMiss: '1.5', output: '4.5' },
    peak: { inputCacheHit: '0.1', inputCacheMiss: '3', output: '9' },
    peakWindows: PEAK_WINDOWS_EVERY_DAY,
    peakTimezone: 'Asia/Shanghai',
    source: ARCHIVE('20260816161307'),
    note: '首次启用峰谷定价，空闲价为高峰价的一半。此阶段官方只写「北京时间 9:00-12:00、14:00-18:00」，未限定工作日，因此周六周日同样按高峰计费。',
  },
  {
    id: '2026-08-23',
    label: 'V4-Flash（正式版）峰谷定价（周末全天低谷）',
    effectiveFrom: beijing('2026-08-23T00:00:00'),
    effectiveTo: beijing('2026-09-10T12:00:00'),
    offPeak: { inputCacheHit: '0.05', inputCacheMiss: '1.5', output: '4.5' },
    peak: { inputCacheHit: '0.1', inputCacheMiss: '3', output: '9' },
    peakWindows: PEAK_WINDOWS_WEEKDAYS,
    peakTimezone: 'Asia/Shanghai',
    source: ARCHIVE('20260822130627'),
    note: '自北京时间 2026-08-23（周日）00:00 起调整峰谷规则：周末（周六、周日）全天不再区分峰谷，统一按低谷价计费。单价本身不变。',
  },
  {
    id: '2026-09-10',
    label: 'V4.1-Flash（deepseek-flash）峰谷定价',
    effectiveFrom: beijing('2026-09-10T12:00:00'),
    effectiveTo: null,
    offPeak: { inputCacheHit: '0.02', inputCacheMiss: '1', output: '4' },
    peak: { inputCacheHit: '0.04', inputCacheMiss: '2', output: '8' },
    peakWindows: PEAK_WINDOWS_WEEKDAYS,
    peakTimezone: 'Asia/Shanghai',
    source: DOCS_PRICING,
    note: 'DeepSeek-V4.1-Flash 上线并同步降价；模型名改为 deepseek-flash，旧名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 仍按 Flash 价格计费。峰谷规则沿用 2026-08-23 起的周一至周五。',
  },
];

/** V4-Pro price periods, oldest first. */
const PRO_PERIODS: readonly PricingPeriod[] = [
  {
    id: '2026-04-24',
    label: 'V4-Pro 预览版上线价',
    effectiveFrom: beijing('2026-04-24T00:00:00'),
    effectiveTo: beijing('2026-04-26T20:15:00'),
    offPeak: { inputCacheHit: '1', inputCacheMiss: '12', output: '24' },
    peak: null,
    peakWindows: [],
    peakTimezone: 'Asia/Shanghai',
    source: ARCHIVE('20260424030643'),
    note: 'V4-Pro 预览版上线价（list price），flat 定价。',
  },
  {
    id: '2026-04-26',
    label: 'V4-Pro 限时 2.5 折',
    effectiveFrom: beijing('2026-04-26T20:15:00'),
    effectiveTo: beijing('2026-06-01T00:00:00'),
    offPeak: { inputCacheHit: '0.025', inputCacheMiss: '3', output: '6' },
    peak: null,
    peakWindows: [],
    peakTimezone: 'Asia/Shanghai',
    source: ARCHIVE('20260607093431'),
    note: '缓存命中价降至 1/10（1 元 → 0.1 元）并叠加 2.5 折活动价；原定 2026-05-05 结束，后延长至 2026-05-31 23:59。',
  },
  {
    id: '2026-06-01',
    label: 'V4-Pro 永久降价（list 价的 1/4）',
    effectiveFrom: beijing('2026-06-01T00:00:00'),
    effectiveTo: beijing('2026-08-17T00:00:00'),
    offPeak: { inputCacheHit: '0.025', inputCacheMiss: '3', output: '6' },
    peak: null,
    peakWindows: [],
    peakTimezone: 'Asia/Shanghai',
    source: ARCHIVE('20260607093431'),
    note: '活动价转为常态价，数值与活动期相同，实际扣费无变化；2026-08-13 V4-Pro 转正式版（0813）时价格未变。',
  },
  {
    id: '2026-08-17',
    label: 'V4-Pro（正式版）峰谷定价',
    effectiveFrom: beijing('2026-08-17T00:00:00'),
    effectiveTo: beijing('2026-08-23T00:00:00'),
    offPeak: { inputCacheHit: '0.15', inputCacheMiss: '4.5', output: '13.5' },
    peak: { inputCacheHit: '0.3', inputCacheMiss: '9', output: '27' },
    peakWindows: PEAK_WINDOWS_EVERY_DAY,
    peakTimezone: 'Asia/Shanghai',
    source: ARCHIVE('20260816161307'),
    note: '与 V4-Flash 同时启用峰谷定价；此阶段高峰时段未限定工作日，周末同样按高峰计费。',
  },
  {
    id: '2026-08-23',
    label: 'V4-Pro（正式版）峰谷定价（周末全天低谷）',
    effectiveFrom: beijing('2026-08-23T00:00:00'),
    effectiveTo: null,
    offPeak: { inputCacheHit: '0.15', inputCacheMiss: '4.5', output: '13.5' },
    peak: { inputCacheHit: '0.3', inputCacheMiss: '9', output: '27' },
    peakWindows: PEAK_WINDOWS_WEEKDAYS,
    peakTimezone: 'Asia/Shanghai',
    source: DOCS_PRICING,
    note: '沿用 2026-08-23 起的周末全天低谷规则；2026-09-10 的 Flash 降价未影响 V4-Pro，DeepSeek 已公告 2026-09-14 之后继续提供该模型且计费方式不变。',
  },
];

/** The published schedule for every DeepSeek billed model this CLI knows about. */
export const MODEL_PRICING: readonly ModelPricing[] = [
  {
    model: 'deepseek-flash',
    aliases: [
      'deepseek-flash',
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-chat',
      'deepseek-reasoner',
    ],
    periods: FLASH_PERIODS,
  },
  {
    model: 'deepseek-v4-pro',
    aliases: ['deepseek-v4-pro'],
    periods: PRO_PERIODS,
  },
];

/**
 * Model used when a ledger record names a model with no schedule at all.
 *
 * The user's rule is "至少需要一个时间段来当默认价格" — V4-Flash is the model
 * DeepSeek Harness itself defaults to, so its schedule is the dataset default.
 */
export const DEFAULT_PRICING_MODEL = 'deepseek-flash';

/** Currency every {@link RateCard} is quoted in. */
export const PRICING_CURRENCY = 'CNY';
