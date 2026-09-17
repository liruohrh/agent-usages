/**
 * DeepSeek's price list.
 *
 * Rates are CNY per 1,000,000 tokens, transcribed from DeepSeek's official
 * *Models & Pricing* page and *Change Log*, plus archived snapshots of that page
 * for periods no longer published. Nothing here is interpolated: every period
 * was announced by DeepSeek, and each carries the URL it came from.
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
 * DeepSeek bills three things: prompt tokens that MISS the cache, prompt tokens
 * that HIT the cache, and output tokens (reasoning included). Cache writes are
 * never billed — the disk cache is built automatically and only reads are
 * charged — so the `input-miss` component charges `inputAndCacheWrite`, which
 * reproduces that behaviour while staying correct if a future adapter ever
 * reports a non-zero cache-write count.
 */

import {
  type ModelPrice,
  type PeakWindow,
  type PricePeriod,
  type PricingProvider,
  type RateComponent,
} from '../contract.ts';

/** Rate component builders, so a period reads like the vendor's price table. */
const PER_MILLION = 1_000_000;

/** Cache-miss prompt tokens (plus any cache writes, which DeepSeek does not bill separately). */
function inputMiss(rate: string): RateComponent {
  return { id: 'input-miss', label: '缓存未命中输入', basis: 'inputAndCacheWrite', rate, per: PER_MILLION };
}

/** Cache-hit prompt tokens. */
function inputHit(rate: string): RateComponent {
  return { id: 'input-hit', label: '缓存命中输入', basis: 'cacheRead', rate, per: PER_MILLION };
}

/** Completion tokens. */
function output(rate: string): RateComponent {
  return { id: 'output', label: '输出', basis: 'output', rate, per: PER_MILLION };
}

/** A flat (untiered) rate card. */
function flat(cacheHit: string, cacheMiss: string, outputRate: string): RateComponent[] {
  return [inputHit(cacheHit), inputMiss(cacheMiss), output(outputRate)];
}

/** Monday–Friday, used by the peak windows in force from 2026-08-23 onward. */
const WEEKDAYS_MON_FRI: readonly number[] = [1, 2, 3, 4, 5];

/** Peak windows as first published on 2026-08-17: every day of the week. */
const PEAK_WINDOWS_EVERY_DAY: readonly PeakWindow[] = [
  { fromHour: 9, toHour: 12, weekdays: null },
  { fromHour: 14, toHour: 18, weekdays: null },
];

/** Peak windows after the 2026-08-23 weekend exemption. */
const PEAK_WINDOWS_WEEKDAYS: readonly PeakWindow[] = [
  { fromHour: 9, toHour: 12, weekdays: WEEKDAYS_MON_FRI },
  { fromHour: 14, toHour: 18, weekdays: WEEKDAYS_MON_FRI },
];

const DOCS_PRICING = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing';
const ARCHIVE = (stamp: string): string =>
  `https://web.archive.org/web/${stamp}/https://api-docs.deepseek.com/zh-cn/quick_start/pricing/`;

/** Milliseconds for a UTC instant written as a Beijing wall-clock time (UTC+8). */
function beijing(text: string): number {
  return Date.parse(`${text}+08:00`);
}

/**
 * V4-Flash price history, oldest first.
 *
 * `deepseek-chat` and `deepseek-reasoner` were the billable names until
 * 2026-04-24, when DeepSeek mapped them onto V4-Flash's non-thinking and
 * thinking modes and later retired them (2026-07-24). Records naming those
 * models therefore belong on this schedule too.
 */
const FLASH_PERIODS: readonly PricePeriod[] = [
  {
    id: '2026-01-01',
    label: 'V3.2（deepseek-chat / deepseek-reasoner）统一价',
    from: beijing('2026-01-01T00:00:00'),
    to: beijing('2026-04-24T00:00:00'),
    offPeak: flat('0.2', '2', '3'),
    peak: null,
    peakWindows: [],
    timezone: 'Asia/Shanghai',
    source: ARCHIVE('20260323134549'),
    note: 'DeepSeek-V3.2 的 deepseek-chat / deepseek-reasoner 统一价，不分峰谷；自 2025-12-01 V3.2 上线沿用至 2026-04-24 V4 发布。',
  },
  {
    id: '2026-04-24',
    label: 'V4-Flash 预览版上线价',
    from: beijing('2026-04-24T00:00:00'),
    to: beijing('2026-04-26T20:15:00'),
    offPeak: flat('0.2', '1', '2'),
    peak: null,
    peakWindows: [],
    timezone: 'Asia/Shanghai',
    source: ARCHIVE('20260424030643'),
    note: 'DeepSeek API 上线 V4-Pro / V4-Flash，flat 定价。deepseek-chat / deepseek-reasoner 自此时起对应 V4-Flash 的非思考/思考模式并按此价格计费。',
  },
  {
    id: '2026-04-26',
    label: 'V4-Flash 缓存命中降价',
    from: beijing('2026-04-26T20:15:00'),
    to: beijing('2026-08-17T00:00:00'),
    offPeak: flat('0.02', '1', '2'),
    peak: null,
    peakWindows: [],
    timezone: 'Asia/Shanghai',
    source: ARCHIVE('20260607093431'),
    note: '缓存命中价降至上线价的 1/10，未命中与输出价不变；2026-07-31 V4-Flash 转正式版（公测）时价格未变。',
  },
  {
    id: '2026-08-17',
    label: 'V4-Flash（正式版）峰谷定价',
    from: beijing('2026-08-17T00:00:00'),
    to: beijing('2026-08-23T00:00:00'),
    offPeak: flat('0.05', '1.5', '4.5'),
    peak: flat('0.1', '3', '9'),
    peakWindows: PEAK_WINDOWS_EVERY_DAY,
    timezone: 'Asia/Shanghai',
    source: ARCHIVE('20260816161307'),
    note: '首次启用峰谷定价，空闲价为高峰价的一半。此阶段官方只写「北京时间 9:00-12:00、14:00-18:00」，未限定工作日，因此周六周日同样按高峰计费。',
  },
  {
    id: '2026-08-23',
    label: 'V4-Flash（正式版）峰谷定价（周末全天低谷）',
    from: beijing('2026-08-23T00:00:00'),
    to: beijing('2026-09-10T12:00:00'),
    offPeak: flat('0.05', '1.5', '4.5'),
    peak: flat('0.1', '3', '9'),
    peakWindows: PEAK_WINDOWS_WEEKDAYS,
    timezone: 'Asia/Shanghai',
    source: ARCHIVE('20260822130627'),
    note: '自北京时间 2026-08-23（周日）00:00 起，周末（周六、周日）全天不再区分峰谷，统一按低谷价计费。单价本身不变。',
  },
  {
    id: '2026-09-10',
    label: 'V4.1-Flash（deepseek-flash）峰谷定价',
    from: beijing('2026-09-10T12:00:00'),
    to: null,
    offPeak: flat('0.02', '1', '4'),
    peak: flat('0.04', '2', '8'),
    peakWindows: PEAK_WINDOWS_WEEKDAYS,
    timezone: 'Asia/Shanghai',
    source: DOCS_PRICING,
    note: 'DeepSeek-V4.1-Flash 上线并同步降价；模型名改为 deepseek-flash，旧名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 仍按 Flash 价格计费。峰谷规则沿用 2026-08-23 起的周一至周五。',
  },
];

/** V4-Pro price history, oldest first. */
const PRO_PERIODS: readonly PricePeriod[] = [
  {
    id: '2026-04-24',
    label: 'V4-Pro 预览版上线价',
    from: beijing('2026-04-24T00:00:00'),
    to: beijing('2026-04-26T20:15:00'),
    offPeak: flat('1', '12', '24'),
    peak: null,
    peakWindows: [],
    timezone: 'Asia/Shanghai',
    source: ARCHIVE('20260424030643'),
    note: 'V4-Pro 预览版上线价（list price），flat 定价。',
  },
  {
    id: '2026-04-26',
    label: 'V4-Pro 限时 2.5 折',
    from: beijing('2026-04-26T20:15:00'),
    to: beijing('2026-06-01T00:00:00'),
    offPeak: flat('0.025', '3', '6'),
    peak: null,
    peakWindows: [],
    timezone: 'Asia/Shanghai',
    source: ARCHIVE('20260607093431'),
    note: '缓存命中价降至 1/10（1 元 → 0.1 元）并叠加 2.5 折活动价；原定 2026-05-05 结束，后延长至 2026-05-31 23:59。',
  },
  {
    id: '2026-06-01',
    label: 'V4-Pro 永久降价（list 价的 1/4）',
    from: beijing('2026-06-01T00:00:00'),
    to: beijing('2026-08-17T00:00:00'),
    offPeak: flat('0.025', '3', '6'),
    peak: null,
    peakWindows: [],
    timezone: 'Asia/Shanghai',
    source: ARCHIVE('20260607093431'),
    note: '活动价转为常态价，数值与活动期相同，实际扣费无变化；2026-08-13 V4-Pro 转正式版（0813）时价格未变。',
  },
  {
    id: '2026-08-17',
    label: 'V4-Pro（正式版）峰谷定价',
    from: beijing('2026-08-17T00:00:00'),
    to: beijing('2026-08-23T00:00:00'),
    offPeak: flat('0.15', '4.5', '13.5'),
    peak: flat('0.3', '9', '27'),
    peakWindows: PEAK_WINDOWS_EVERY_DAY,
    timezone: 'Asia/Shanghai',
    source: ARCHIVE('20260816161307'),
    note: '与 V4-Flash 同时启用峰谷定价；此阶段高峰时段未限定工作日，周末同样按高峰计费。',
  },
  {
    id: '2026-08-23',
    label: 'V4-Pro（正式版）峰谷定价（周末全天低谷）',
    from: beijing('2026-08-23T00:00:00'),
    to: null,
    offPeak: flat('0.15', '4.5', '13.5'),
    peak: flat('0.3', '9', '27'),
    peakWindows: PEAK_WINDOWS_WEEKDAYS,
    timezone: 'Asia/Shanghai',
    source: DOCS_PRICING,
    note: '沿用 2026-08-23 起的周末全天低谷规则；2026-09-10 的 Flash 降价未影响 V4-Pro，DeepSeek 已公告 2026-09-14 之后继续提供该模型且计费方式不变。',
  },
];

/**
 * DeepSeek's published schedule.
 *
 * `deepseek-v4-flash-vision-exp` shares Flash's rates, including the window in
 * which it did not exist yet — a record for it can only exist from 2026-08-21,
 * by which time Flash's rates already applied.
 */
export const DEEPSEEK_PRICES: readonly ModelPrice[] = [
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

/** The DeepSeek pricing provider. */
export const deepseekPricing: PricingProvider = {
  id: 'deepseek',
  label: 'DeepSeek 官方',
  currency: { code: 'CNY', symbol: '¥' },
  // Flash is the model DeepSeek's own harness defaults to, so it is the least
  // surprising schedule to borrow when a record names something unrecognised.
  defaultModel: 'deepseek-flash',
  models: () => DEEPSEEK_PRICES,
  find: (model) => {
    const wanted = model.trim().toLowerCase();
    for (const price of DEEPSEEK_PRICES) {
      if (price.aliases.some((alias) => alias.toLowerCase() === wanted)) return price;
    }
    return undefined;
  },
};
