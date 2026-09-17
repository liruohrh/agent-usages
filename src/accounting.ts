/**
 * Accounting: turn a filtered list of usage records into token totals and cost.
 *
 * Cost is accumulated as exact scaled integers grouped by
 * (model, period, band), because each group needs `tokens × rate / 1e6` computed
 * before summing — summing tokens first and multiplying once would be wrong the
 * moment a session spans two price periods or two bands within a period.
 *
 * Rounding happens exactly once, on the four cost components, so every total in
 * the UI is a sum of the numbers the user can already see: the per-model, per-
 * project, per-band, and grand totals all reconcile.
 */

import { formatDecimal, parseDecimal, scalePerMillion } from './money.ts';
import type { PricingEngine } from './pricing.ts';
import type {
  CostTotals,
  PricingBandSummary,
  PricingResolution,
  SessionRecord,
  TokenTotals,
  UsageEntry,
} from './types.ts';
import { emptyBuckets } from './loader.ts';

/** Exact money amount: a currency value scaled by `MONEY_SCALE` (1e-9 units). */
type MoneyAmount = bigint;

/** Cost component keys, in report order. */
const COST_COMPONENTS = ['cacheHitInputCost', 'cacheMissInputCost', 'outputCost'] as const;

/** One component of a cost, as an exact scaled amount. */
type CostComponent = (typeof COST_COMPONENTS)[number];

/** Digits kept for money in the output: finer than any real per-request cost. */
export const COST_DIGITS = 4;

/** Exact cost of one (model, period, band) group. */
interface CostGroup {
  model: string;
  periodId: string;
  periodLabel: string;
  band: string;
  resolution: PricingResolution;
  requests: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cost: Record<CostComponent, MoneyAmount>;
}

/** Round a scaled amount to {@link COST_DIGITS} decimal places, half-up. */
function roundAmount(value: MoneyAmount): MoneyAmount {
  const divisor = 10n ** BigInt(9 - COST_DIGITS);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const rounded = (magnitude + divisor / 2n) / divisor * divisor;
  return negative ? -rounded : rounded;
}

/** Multiply a scaled amount by a unit-less factor, keeping the scale. */
function applyRate(value: MoneyAmount, factorScaled: MoneyAmount): MoneyAmount {
  return (value * factorScaled) / 1_000_000_000n;
}

/** Internal accumulator pairing exact money with the token counters that produced it. */
class CostAccumulator {
  private readonly groups = new Map<string, CostGroup>();
  private readonly engine: PricingEngine;
  private readonly factor: MoneyAmount;

  constructor(engine: PricingEngine, currencyRate: number) {
    this.engine = engine;
    this.factor = decimalFromNumber(currencyRate);
  }

  /** Charge one usage record. */
  add(entry: UsageEntry): void {
    const resolved = this.engine.rateAt(entry.model, entry.time);
    if (resolved === undefined) {
      throw new Error(`没有可用于模型 ${entry.model} 的价格表`);
    }
    const { period, band, rates, resolution } = resolved;
    const groupKey = `${entry.model}\u0000${period.id}\u0000${band}`;
    let group = this.groups.get(groupKey);
    if (group === undefined) {
      group = {
        model: entry.model,
        periodId: period.id,
        periodLabel: period.label,
        band,
        resolution,
        requests: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cost: { cacheHitInputCost: 0n, cacheMissInputCost: 0n, outputCost: 0n },
      };
      this.groups.set(groupKey, group);
    }
    // DeepSeek bills cache writes at the cache-miss rate, so writes join the
    // miss bucket; the separate counter is kept for transparency.
    const missTokens = entry.tokens.input + entry.tokens.cacheWrite;
    group.requests += 1;
    group.cacheHitTokens += entry.tokens.cacheRead;
    group.cacheMissTokens += missTokens;
    group.outputTokens += entry.tokens.output;
    group.cacheWriteTokens += entry.tokens.cacheWrite;
    group.cost.cacheHitInputCost += scalePerMillion(entry.tokens.cacheRead, parseRate(rates.inputCacheHit));
    group.cost.cacheMissInputCost += scalePerMillion(missTokens, parseRate(rates.inputCacheMiss));
    group.cost.outputCost += scalePerMillion(entry.tokens.output, parseRate(rates.output));
  }

  /**
   * The report's cost components, converted and rounded exactly once.
   *
   * Every aggregate in the CLI is built by summing these, so the displayed
   * numbers always add up.
   */
  components(): Record<CostComponent, MoneyAmount> {
    const totals: Record<CostComponent, MoneyAmount> = {
      cacheHitInputCost: 0n,
      cacheMissInputCost: 0n,
      outputCost: 0n,
    };
    for (const group of this.groups.values()) {
      for (const component of COST_COMPONENTS) {
        totals[component] += applyRate(group.cost[component], this.factor);
      }
    }
    for (const component of COST_COMPONENTS) {
      totals[component] = roundAmount(totals[component]);
    }
    return totals;
  }

  /** Group rows, newest pricing period first. */
  groupRows(): readonly CostGroup[] {
    return [...this.groups.values()].sort(
      (left, right) =>
        right.periodId.localeCompare(left.periodId) ||
        left.model.localeCompare(right.model) ||
        left.band.localeCompare(right.band),
    );
  }
}

/** Rate cards are authored as decimal literals; parse once per distinct literal. */
const rateCache = new Map<string, bigint>();

/** Memoized decimal parse — the same handful of rate literals recur constantly. */
function parseRate(text: string): bigint {
  let parsed = rateCache.get(text);
  if (parsed === undefined) {
    parsed = parseDecimal(text);
    rateCache.set(text, parsed);
  }
  return parsed;
}

/** Convert a JavaScript number into the scaled decimal representation. */
function decimalFromNumber(value: number): MoneyAmount {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`汇率必须是非负有限数字，收到 ${String(value)}`);
  }
  const text = value.toString();
  if (text.includes('e') || text.includes('E')) {
    return BigInt(Math.round(value * 1e9));
  }
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(`${whole}${fraction.padEnd(9, '0').slice(0, 9)}`);
}

/** Sum the raw provider buckets of a set of records. */
export function sumTokens(entries: readonly UsageEntry[]): TokenTotals {
  const totals = emptyBuckets();
  for (const entry of entries) {
    totals.input += entry.tokens.input;
    totals.output += entry.tokens.output;
    totals.cacheRead += entry.tokens.cacheRead;
    totals.cacheWrite += entry.tokens.cacheWrite;
    totals.reasoning += entry.tokens.reasoning;
  }
  return totals;
}

/** Cost components at the arithmetic scale, before any display rounding. */
export interface ExactCost {
  cacheHitInputCost: bigint;
  cacheMissInputCost: bigint;
  outputCost: bigint;
}

/**
 * A complete token + cost result for one group of usage records.
 *
 * {@link UsageReport.cost} is rounded for display, while
 * {@link UsageReport.exactCost} keeps the unrounded scaled integers. Aggregates
 * must sum the exact values and round once at the end: adding already-rounded
 * per-session figures lets each session's rounding error accumulate, which is
 * enough to make the same total differ depending on how it was grouped.
 */
export interface UsageReport {
  /** Aggregated provider buckets. */
  tokens: TokenTotals;
  /** Unrounded cost components, for aggregation. */
  exactCost: ExactCost;
  /** Aggregated cost, in the requested currency. */
  cost: CostTotals;
  /** Which pricing periods and bands contributed, newest first. */
  bands: PricingBandSummary[];
  /** Number of billed requests. */
  requests: number;
}

/**
 * Public cost totals built from already-rounded exact components.
 *
 * The total sums the three rounded components as scaled integers, so the
 * displayed total always equals the displayed parts — no phantom 1e-16.
 */
function toCostTotals(components: Record<CostComponent, MoneyAmount>): CostTotals {
  const total =
    components.cacheHitInputCost + components.cacheMissInputCost + components.outputCost;
  return {
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheHitInputCost: formatDecimal(components.cacheHitInputCost, COST_DIGITS),
    cacheMissInputCost: formatDecimal(components.cacheMissInputCost, COST_DIGITS),
    outputCost: formatDecimal(components.outputCost, COST_DIGITS),
    total: formatDecimal(total, COST_DIGITS),
  };
}

/**
 * Compute tokens and cost for a set of usage records.
 * @param entries - the records to bill.
 * @param engine - the pricing engine supplying rates.
 * @param currencyRate - units of the target currency per 1 CNY; `1` keeps CNY.
 * @returns the report, with cost expressed in the target currency.
 */
export function computeReport(
  entries: readonly UsageEntry[],
  engine: PricingEngine,
  currencyRate = 1,
): UsageReport {
  const accumulator = new CostAccumulator(engine, currencyRate);
  for (const entry of entries) accumulator.add(entry);
  const tokens = sumTokens(entries);
  const exact = accumulator.components();
  const cost = toCostTotals(exact);
  cost.cacheHitInputTokens = tokens.cacheRead;
  cost.cacheMissInputTokens = tokens.input + tokens.cacheWrite;
  cost.outputTokens = tokens.output;
  cost.cacheWriteTokens = tokens.cacheWrite;
  return {
    tokens,
    exactCost: exact,
    cost,
    bands: accumulator.groupRows().map((group) => ({
      periodId: group.periodId,
      periodLabel: group.periodLabel,
      band: group.band,
      resolution: group.resolution,
      requests: group.requests,
    })),
    requests: entries.length,
  };
}

/** Render already-rounded exact components as display totals. */
export function displayCost(components: ExactCost, tokens: TokenTotals): CostTotals {
  const cost = toCostTotals(components);
  cost.cacheHitInputTokens = tokens.cacheRead;
  cost.cacheMissInputTokens = tokens.input + tokens.cacheWrite;
  cost.outputTokens = tokens.output;
  cost.cacheWriteTokens = tokens.cacheWrite;
  return cost;
}

/**
 * Aggregate usage records of several sessions.
 * @param sessions - sessions whose records should be billed.
 * @param engine - the pricing engine supplying rates.
 * @param currencyRate - units of the target currency per 1 CNY.
 * @returns the combined report.
 */
export function reportForSessions(
  sessions: readonly SessionRecord[],
  engine: PricingEngine,
  currencyRate = 1,
): UsageReport {
  const entries: UsageEntry[] = [];
  for (const session of sessions) entries.push(...session.entries);
  return computeReport(entries, engine, currencyRate);
}

/**
 * Cross-check aggregated buckets against the harness' own projection totals.
 * @param tokens - buckets summed from the ledger.
 * @param projected - buckets the harness projection cache reports.
 * @returns a human-readable warning, or `undefined` when they agree.
 */
export function reconcile(tokens: TokenTotals, projected: TokenTotals): string | undefined {
  const diffs: string[] = [];
  const compare = (label: string, ledger: number, cache: number): void => {
    if (ledger !== cache) diffs.push(`${label} 账本 ${ledger} vs 投影缓存 ${cache}`);
  };
  compare('未命中输入', tokens.input, projected.input);
  compare('输出', tokens.output, projected.output);
  compare('缓存命中输入', tokens.cacheRead, projected.cacheRead);
  compare('缓存写入', tokens.cacheWrite, projected.cacheWrite);
  return diffs.length === 0 ? undefined : `会话用量与投影缓存不一致：${diffs.join('；')}`;
}
