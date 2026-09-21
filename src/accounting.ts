/**
 * Accounting: turn filtered usage records into token totals and money.
 *
 * The arithmetic is vendor-neutral by construction. Rates come from a
 * {@link PricingEngine}, which decides *which* rates apply to each record; this
 * module only decides how to accumulate them:
 *
 * - Costs accumulate as exact scaled integers in `bigint`, because each group
 *   needs `tokens × rate / per` computed *before* summing — adding token counts
 *   first and multiplying once would be wrong the moment a session spans two
 *   price periods or two tiers within one period.
 * - Rounding happens exactly once per report, on the components, and every
 *   aggregate is then the sum of already-rounded components. A grand total is
 *   computed in a single pass over the in-scope records rather than by adding up
 *   the rows displayed beside it, so the number a reader checks always matches.
 */

import { emptyBuckets, tokenBreakdown } from './core/buckets.ts';
import { formatDecimal, parseDecimal } from './core/money.ts';
import type { CostTotals, TokenBuckets, TokenTotals, UsageRecord } from './core/types.ts';
import { counterForBasis, type CostBreakdown, type PricingEngine, type RateComponent, type RecordCost } from './pricing/index.ts';

/** Digits kept for money in the output: finer than any real per-request cost. */
export const COST_DIGITS = 4;

/**
 * Scale every amount is carried at: 1e-9 of the pricing currency.
 *
 * Arithmetic stays at this scale and only {@link renderAmount} divides it down,
 * so an amount can pass through several merges without losing a digit.
 */
export const AMOUNT_SCALE_DIGITS = 9;

/** Cost components at the arithmetic scale, before display rounding. */
export interface ExactCost {
  /** Amount per component id, at 1e-9 currency units. */
  byComponent: Map<string, bigint>;
  /** Sum of {@link ExactCost.byComponent}. */
  total: bigint;
}

/** Report counters a charged component contributes tokens to. */
type ReportCounter = 'cacheHitInputTokens' | 'cacheMissInputTokens' | 'outputTokens' | 'cacheWriteTokens';

/** One (model, period, tier) group plus the tokens that produced it. */
export interface CostGroup {
  /** Model billed. */
  model: string;
  /** Period the rate came from. */
  periodId: string;
  /** Period label. */
  periodLabel: string;
  /** Tier the rate came from. */
  tier: 'peak' | 'off-peak' | 'flat';
  /** How the period was selected. */
  resolution: CostBreakdown['resolution'];
  /** Requests billed under this group. */
  requests: number;
  /** Exact amount per component id. */
  amounts: Map<string, bigint>;
  /** Tokens attributed to each report counter. */
  counters: Record<ReportCounter, number>;
  /**
   * Reasoning tokens billed in this group.
   *
   * Kept per group because the split of the output bill between `O` and `R` is
   * only meaningful where the output rate is constant: one model's thinking can
   * be billed at four times another's, and a token-weighted split of the
   * combined bill would move money between them.
   */
  reasoningTokens: number;
}

/** One component's contribution, for the token/rate detail table. */
export interface ComponentUsage {
  /** The component charged. */
  component: RateComponent;
  /** Tokens charged under it, across every request. */
  tokens: number;
}

/** What one set of records cost, in the provider's currency. */
export interface UsageCost {
  /** Token totals. */
  tokens: TokenTotals;
  /** Unrounded amounts per component id. */
  exact: ExactCost;
  /** Tokens charged per component, keyed by component id. */
  components: Map<string, ComponentUsage>;
  /** Requests that were billed. */
  priced: number;
  /** Records no schedule could price. */
  unpriced: number;
  /** Per (model, period, tier) groups, newest period first. */
  groups: CostGroup[];
}

/** Everything a caller needs to render a cost report. */
export interface CostSummary {
  /** Display totals, rounded once. */
  totals: CostTotals;
  /** Per-group breakdown with display amounts. */
  breakdown: CostBreakdown[];
  /** Tokens charged per component. */
  components: Map<string, ComponentUsage>;
  /** Requests that were billed. */
  priced: number;
  /** Records no schedule could price. */
  unpriced: number;
}

/** Sum provider buckets across records. */
export function sumTokens(records: readonly UsageRecord[]): TokenTotals {
  const totals = emptyBuckets();
  for (const record of records) {
    totals.input += record.tokens.input;
    totals.output += record.tokens.output;
    totals.cacheRead += record.tokens.cacheRead;
    totals.cacheWrite += record.tokens.cacheWrite;
    totals.reasoning += record.tokens.reasoning;
  }
  return totals;
}

/**
 * Round a scaled amount to {@link COST_DIGITS} places, half-up on the magnitude.
 *
 * The result stays at {@link AMOUNT_SCALE_DIGITS}, so summing rounded amounts is
 * still exact.
 */
function round(value: bigint): bigint {
  const divisor = 10n ** BigInt(AMOUNT_SCALE_DIGITS - COST_DIGITS);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const rounded = ((magnitude + divisor / 2n) / divisor) * divisor;
  return negative ? -rounded : rounded;
}

/** Render an amount at the arithmetic scale as a decimal string. */
export function renderAmount(value: bigint): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const text = magnitude.toString().padStart(AMOUNT_SCALE_DIGITS + 1, '0');
  const whole = text.slice(0, text.length - AMOUNT_SCALE_DIGITS);
  const fraction = text.slice(text.length - AMOUNT_SCALE_DIGITS);
  return `${negative && magnitude !== 0n ? '-' : ''}${whole}.${fraction}`;
}

/** Render an amount rounded to {@link COST_DIGITS} places. */
export function renderRounded(value: bigint): string {
  const text = renderAmount(round(value));
  return text.slice(0, text.length - (AMOUNT_SCALE_DIGITS - COST_DIGITS));
}

/**
 * Price a set of records.
 *
 * Pure and engine-agnostic: it asks the engine for each record's rates, groups by
 * (model, period, tier), and accumulates exact amounts. Records the engine cannot
 * price are counted rather than silently treated as free.
 * @param records - the records to bill.
 * @param engine - the engine supplying rates.
 * @returns the exact cost, ready to be converted and rounded.
 */
export function priceRecords(records: readonly UsageRecord[], engine: PricingEngine): UsageCost {
  const groups = new Map<string, CostGroup>();
  const components = new Map<string, ComponentUsage>();
  const exact: ExactCost = { byComponent: new Map(), total: 0n };
  let priced = 0;
  let unpriced = 0;

  for (const record of records) {
    const cost: RecordCost | undefined = engine.costOf(record);
    if (cost === undefined) {
      unpriced += 1;
      continue;
    }
    priced += 1;
    const { period, tier, resolution, model } = cost.rate;
    const groupKey = `${model}\u0000${period.id}\u0000${tier}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = {
        model,
        periodId: period.id,
        periodLabel: period.label,
        tier,
        resolution,
        requests: 0,
        amounts: new Map(),
        counters: { cacheHitInputTokens: 0, cacheMissInputTokens: 0, outputTokens: 0, cacheWriteTokens: 0 },
        reasoningTokens: 0,
      };
      groups.set(groupKey, group);
    }
    group.requests += 1;
    group.reasoningTokens += Math.min(record.tokens.reasoning, record.tokens.output);
    for (const [id, amount] of cost.amounts) {
      group.amounts.set(id, (group.amounts.get(id) ?? 0n) + amount);
      exact.byComponent.set(id, (exact.byComponent.get(id) ?? 0n) + amount);
      exact.total += amount;
    }
    // Attribute every charged component's tokens to a report counter, so the
    // totals a reader sees explain the amounts printed beside them.
    for (const component of cost.rate.components) {
      const quantity = engine.quantityOf(component, record.tokens);
      const known = components.get(component.id);
      if (known === undefined) components.set(component.id, { component, tokens: quantity });
      else known.tokens += quantity;
      group.counters[counterForBasis(component.basis)] += quantity;
    }
  }

  return {
    tokens: sumTokens(records),
    exact,
    components,
    priced,
    unpriced,
    groups: [...groups.values()].sort(
      (left, right) =>
        right.periodId.localeCompare(left.periodId) ||
        left.model.localeCompare(right.model) ||
        left.tier.localeCompare(right.tier),
    ),
  };
}

/** Merge priced sets, summing at the arithmetic scale. */
export function mergeCosts(costs: readonly UsageCost[]): UsageCost {
  const groups = new Map<string, CostGroup>();
  const components = new Map<string, ComponentUsage>();
  const exact: ExactCost = { byComponent: new Map(), total: 0n };
  const tokens = emptyBuckets();
  let priced = 0;
  let unpriced = 0;

  for (const cost of costs) {
    priced += cost.priced;
    unpriced += cost.unpriced;
    tokens.input += cost.tokens.input;
    tokens.output += cost.tokens.output;
    tokens.cacheRead += cost.tokens.cacheRead;
    tokens.cacheWrite += cost.tokens.cacheWrite;
    tokens.reasoning += cost.tokens.reasoning;
    for (const [id, amount] of cost.exact.byComponent) {
      exact.byComponent.set(id, (exact.byComponent.get(id) ?? 0n) + amount);
    }
    exact.total += cost.exact.total;
    for (const [id, usage] of cost.components) {
      const known = components.get(id);
      if (known === undefined) components.set(id, { ...usage });
      else known.tokens += usage.tokens;
    }
    for (const group of cost.groups) {
      const key = `${group.model}\u0000${group.periodId}\u0000${group.tier}`;
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, { ...group, amounts: new Map(group.amounts), counters: { ...group.counters } });
        continue;
      }
      existing.requests += group.requests;
      for (const [id, amount] of group.amounts) {
        existing.amounts.set(id, (existing.amounts.get(id) ?? 0n) + amount);
      }
      for (const counter of Object.keys(existing.counters) as ReportCounter[]) {
        existing.counters[counter] += group.counters[counter];
      }
      existing.reasoningTokens += group.reasoningTokens;
    }
  }

  return { tokens, exact, components, priced, unpriced, groups: [...groups.values()] };
}

/**
 * Split each group's output bill between its reasoning and its plain completion.
 *
 * Done per group, where one output rate applies, and summed afterwards: thinking
 * billed at a higher rate than another model's must not have its money diluted
 * by a token-weighted average of the two. The parts are rounded group by group,
 * matching how the components themselves are rounded.
 * @param cost - the priced sets.
 * @param convert - turns a scaled amount into the target currency.
 * @returns the reasoning share, at the arithmetic scale.
 */
function reasoningShare(cost: UsageCost, convert: (value: bigint) => bigint): bigint {
  let share = 0n;
  for (const group of cost.groups) share += groupReasoningShare(group, convert);
  return share;
}

/** The reasoning slice of one group's output bill. */
function groupReasoningShare(group: CostGroup, convert: (value: bigint) => bigint): bigint {
  const output = group.amounts.get('output') ?? 0n;
  const completion = group.counters.outputTokens;
  if (output === 0n || completion <= 0 || group.reasoningTokens <= 0) return 0n;
  const reasoning = Math.min(group.reasoningTokens, completion);
  return round((convert(output) * BigInt(reasoning)) / BigInt(completion));
}

/**
 * Convert exact amounts and round them once.
 *
 * Applied after all merging, so a converted report's components always sum to
 * its total.
 * @param cost - the exact cost.
 * @param convert - turns a scaled amount into the target currency.
 * @returns display totals and per-group breakdown.
 */
export function summarize(cost: UsageCost, convert: (value: bigint) => bigint = (value) => value): CostSummary {
  const rounded = new Map<string, bigint>();
  let total = 0n;
  for (const [id, amount] of cost.exact.byComponent) {
    const value = round(convert(amount));
    rounded.set(id, value);
    total += value;
  }

  const totals: CostTotals = {
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheHitInputCost: renderRounded(rounded.get('input-hit') ?? 0n),
    cacheMissInputCost: renderRounded(rounded.get('input-miss') ?? 0n),
    outputCost: renderRounded(rounded.get('output') ?? 0n),
    cacheWriteInputCost: renderRounded(rounded.get('input-write') ?? 0n),
    reasoningCost: renderRounded(reasoningShare(cost, convert)),
    total: renderRounded(total),
  };
  for (const group of cost.groups) {
    totals.cacheHitInputTokens += group.counters.cacheHitInputTokens;
    totals.cacheMissInputTokens += group.counters.cacheMissInputTokens;
    totals.outputTokens += group.counters.outputTokens;
    totals.cacheWriteTokens += group.counters.cacheWriteTokens;
  }

  const breakdown: CostBreakdown[] = cost.groups.map((group) => {
    const amounts: Record<string, string> = {};
    let groupTotal = 0n;
    for (const [id, amount] of group.amounts) {
      const value = round(convert(amount));
      amounts[id] = renderRounded(value);
      groupTotal += value;
    }
    return {
      model: group.model,
      periodId: group.periodId,
      periodLabel: group.periodLabel,
      tier: group.tier,
      resolution: group.resolution,
      requests: group.requests,
      amounts,
      reasoningCost: renderRounded(groupReasoningShare(group, convert)),
      total: renderRounded(groupTotal),
    };
  });

  return { totals, breakdown, components: cost.components, priced: cost.priced, unpriced: cost.unpriced };
}

/** Convert a JavaScript number into the scaled decimal representation. */
function decimalFromNumber(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`汇率必须是非负有限数字，收到 ${String(value)}`);
  }
  const text = value.toString();
  if (text.includes('e') || text.includes('E')) return BigInt(Math.round(value * 1e9));
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(`${whole}${fraction.padEnd(9, '0').slice(0, 9)}`);
}

/** A currency conversion, or the identity when the rate is 1. */
function converter(currencyRate: number): (value: bigint) => bigint {
  const factor = decimalFromNumber(currencyRate);
  return factor === 1_000_000_000n ? (value) => value : (value) => (value * factor) / 1_000_000_000n;
}

/**
 * Price, merge, convert, and round a set of records in one call.
 * @param records - the records to bill.
 * @param engine - the engine supplying rates.
 * @param currencyRate - units of the target currency per 1 unit of the provider's currency.
 * @returns the display summary.
 */
export function costOf(records: readonly UsageRecord[], engine: PricingEngine, currencyRate = 1): CostSummary {
  return summarize(priceRecords(records, engine), converter(currencyRate));
}

/**
 * Price several record sets and merge them at full precision before rounding.
 *
 * Merging rounded per-set summaries instead would let each set's rounding
 * remainder accumulate, making the same grand total come out differently
 * depending on how the records were grouped.
 * @param sets - one record list per group.
 * @param engine - the engine supplying rates.
 * @param currencyRate - units of the target currency per 1 unit of the provider's currency.
 * @returns the display summary for everything.
 */
export function costOfGrouped(
  sets: readonly (readonly UsageRecord[])[],
  engine: PricingEngine,
  currencyRate = 1,
): CostSummary {
  return summarize(mergeCosts(sets.map((records) => priceRecords(records, engine))), converter(currencyRate));
}

/** Money per reader-facing token figure, at display precision. */
export interface MoneyBreakdown {
  /** Cache-miss prompt tokens' share of the bill. */
  inputMiss: string;
  /** Cache-hit prompt tokens' share of the bill. */
  inputHit: string;
  /** Cache-write prompt tokens' share of the bill. */
  inputWrite: string;
  /** Every prompt token: `inputMiss + inputHit + inputWrite`. */
  inputTotal: string;
  /** Completion tokens excluding reasoning. */
  outputOnly: string;
  /** Reasoning tokens, split out of the completion bill by token share. */
  reasoning: string;
  /** The whole completion bill: `outputOnly + reasoning`. */
  outputTotal: string;
  /** Everything: `inputTotal + outputTotal`. */
  total: string;
}

/**
 * Break a bill down the same way {@link tokenBreakdown} breaks the tokens down.
 *
 * Three prompt buckets are billed one by one, so their money is exact. The
 * completion is billed as a whole, so `O` and `R` are a split of it by token
 * share — they add up to the completion bill, never beyond it. And
 * `inputTotal + outputTotal` is the report's total: nothing is counted twice.
 *
 * `cost.total` stays the authority: when the components do not quite add up to
 * it (a caller passing a total of its own), the difference — at most a display
 * unit — moves onto the largest component rather than being printed as a line
 * that does not reconcile with the report.
 * @param cost - the money as charged, per billed component.
 * @param tokens - the tokens the same records counted.
 * @returns one amount per reader-facing figure.
 */
export function moneyBreakdown(cost: CostTotals, tokens: TokenBuckets): MoneyBreakdown {
  const miss = parseDecimal(cost.cacheMissInputCost);
  const hit = parseDecimal(cost.cacheHitInputCost);
  const write = parseDecimal(cost.cacheWriteInputCost);
  const output = parseDecimal(cost.outputCost);
  const stats = tokenBreakdown(tokens);
  const billed = [miss, hit, write, output];
  const whole = parseDecimal(cost.total);
  const bedded = billed.reduce((sum, value) => sum + value, 0n);
  if (bedded !== whole) {
    let largest = 0;
    for (let index = 1; index < billed.length; index += 1) {
      if (billed[index]! > billed[largest]!) largest = index;
    }
    billed[largest] = billed[largest]! + (whole - bedded);
  }
  const [missPart, hitPart, writePart, outputPart] = billed as [bigint, bigint, bigint, bigint];
  const inputTotal = missPart + hitPart + writePart;
  const render = (value: bigint): string => formatDecimal(value, COST_DIGITS);
  // The two halves are rounded against the rounded whole rather than on their
  // own, so `outputOnly + reasoning` is exactly the completion bill.
  const wholeOutput = parseDecimal(render(outputPart));
  // The reasoning share was split where the output rate was known — in the
  // pricing pass — so all this has to do is subtract it from the output bill.
  const reasoningRaw = parseDecimal(cost.reasoningCost);
  const outputOnly = wholeOutput - parseDecimal(render(reasoningRaw));
  return {
    inputMiss: render(missPart),
    inputHit: render(hitPart),
    inputWrite: render(writePart),
    inputTotal: render(inputTotal),
    outputOnly: render(outputOnly),
    reasoning: render(wholeOutput - outputOnly),
    outputTotal: render(outputPart),
    total: render(inputTotal + outputPart),
  };
}

/**
 * Cross-check aggregated buckets against a second opinion.
 * @param tokens - buckets summed from the records.
 * @param projected - buckets an independent source reports.
 * @returns a warning describing the difference, or `undefined` when they agree.
 */
export function reconcile(tokens: TokenTotals, projected: TokenBuckets): string | undefined {
  const diffs: string[] = [];
  const compare = (label: string, left: number, right: number): void => {
    if (left !== right) diffs.push(`${label} ${left} vs ${right}`);
  };
  compare('未命中输入', tokens.input, projected.input);
  compare('输出', tokens.output, projected.output);
  compare('缓存命中输入', tokens.cacheRead, projected.cacheRead);
  compare('缓存写入', tokens.cacheWrite, projected.cacheWrite);
  return diffs.length === 0 ? undefined : `用量与投影缓存不一致：${diffs.join('；')}`;
}
