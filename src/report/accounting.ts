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

import { emptyBuckets, tokenBreakdown } from '../core/buckets.ts';
import { UserError, renderDiagnostic } from '../i18n/errors.ts';
import { t } from '../i18n/index.ts';
import { formatDecimal, MONEY_SCALE_DIGITS, multiplyDecimal, parseDecimal, trimDecimal } from '../core/money.ts';
import type { CacheWriteTtl, CostTotals, TokenBuckets, TokenTotals, UsageRecord } from '../core/types.ts';
import {
  counterForBasis,
  type ComponentCharge,
  type CostBreakdown,
  type CostCharge,
  type DualMoney,
  type PricePeriod,
  type PricingEngine,
  type RateComponent,
  type RecordCost,
} from '../pricing/index.ts';

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

/** A price list, named the way the reader knows it. */
export interface TableRef {
  /** Provider id, e.g. `anthropic`. */
  id: string;
  /** Provider label, e.g. `Anthropic`. */
  label: string;
}

/**
 * How to see the money in the currency each price list published.
 *
 * The engine here bills every record at its own table's *published* rates — the
 * same engine the report charges with, minus any conversion — so what it returns
 * are the vendor's own numbers for the very same requests. The display figures
 * are untouched: they stay the ones the run already charges, and this only adds
 * a second view beside them.
 *
 * A record's original currency is the currency of the `PricePeriod` it actually
 * hit, never a currency the vendor also happens to publish: two published lists
 * are two vendor prices for the same tokens, not a conversion of each other, so
 * quoting the other one would invent an exchange rate the vendor never printed.
 */
export interface OriginalPricing {
  /** Engine billing each record at its own table's published rates. */
  engine: PricingEngine;
  /** Table that published the period a record was billed under. */
  tableOf(period: PricePeriod): TableRef | undefined;
  /** ISO code of the display currency the converted figures are in. */
  currency: string;
  /**
   * One-shot conversion rates to {@link OriginalPricing.currency}, keyed
   * `${tableId}\u0000${currency}` and quoted as decimal strings.
   *
   * A subtotal converts once, from its exact sum in the published currency —
   * which is not always the same as summing per-record conversions, so
   * {@link CostSubtotal.perRecord} carries the other number when it differs.
   * Absent in historical mode, where each record converts at its own date's rate
   * and only the per-record sum is honest.
   */
  rates?: ReadonlyMap<string, string> | undefined;
}

/** One (table, currency) subtotal, exact, in the currency the table published. */
export interface OriginalTotal {
  /** Table that published the rates. */
  table: TableRef;
  /** Currency its records were billed in. */
  currency: string;
  /** Requests billed under this table and currency. */
  requests: number;
  /** Exact sum in {@link OriginalTotal.currency}, at {@link AMOUNT_SCALE_DIGITS}. */
  amount: bigint;
  /** Exact sum of the same requests' display-currency amounts. */
  display: bigint;
}

/**
 * One price list's share of the bill, in both currencies.
 *
 * Grouped by (table, currency), not by table: a vendor may publish two lists,
 * and the records priced from each are two different vendor prices. The display
 * side is the subtotal converted once — see {@link OriginalPricing.rates} — and
 * {@link CostSubtotal.perRecord} records the other reading when the two differ.
 */
export interface CostSubtotal {
  /** Provider id, e.g. `anthropic`. */
  table: string;
  /** Provider label, as the table itself names it. */
  tableLabel: string;
  /** Currency the records under it were billed in. */
  currency: string;
  /** Requests billed under this table and currency. */
  requests: number;
  /** Exact sum in {@link CostSubtotal.currency}, rounded for display. */
  original: string;
  /** The subtotal in the display currency, converted once from {@link CostSubtotal.original}. */
  display: string;
  /**
   * The published sum converted once at this (table, currency)'s rate.
   *
   * The reading the task's rule describes, carried beside the displayed one for
   * comparison: rounding is not linear, so converting the sum in one step and
   * summing the per-band conversions can differ in the last displayed digits.
   * {@link CostSubtotal.display} stays the authority because it is what the
   * report's total is summed from. Absent in historical mode, where no single
   * rate covers the sum.
   */
  converted?: string | undefined;
  /**
   * The same money summed record by record, rounded once.
   *
   * A second reading of the same records, carried so a consumer can see how far
   * the band-by-band rounding the report displays moves the number.
   */
  perRecord?: string | undefined;
  /** Both sides together, for rows that print both. */
  money: DualMoney;
}

/** Report counters a charged component contributes tokens to. */
type ReportCounter = 'cacheHitInputTokens' | 'cacheMissInputTokens' | 'outputTokens' | 'cacheWriteTokens';

/**
 * One component's tranche split inside a group, still exact.
 *
 * Only components whose money a second rate changed appear here, so the map is
 * absent — not merely empty — for a rate card with no tranches at all.
 */
export interface GroupCharge {
  /** Tokens billed at the component's own rate. */
  baseTokens: number;
  /** Tokens billed above the long-context threshold. */
  excessTokens: number;
  /** Money the excess tranche produced, at {@link AMOUNT_SCALE_DIGITS}. */
  excessAmount: bigint;
  /** Rate the excess was billed at, scaled by 1e9, or `null` when none was. */
  excessRate: bigint | null;
  /** Tokens per cache-write TTL tier whose multiplier scaled this component's rate. */
  ttlTiers: Map<CacheWriteTtl, { tokens: number; multiplier: bigint }>;
}

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
  /** Tranche detail per component id, for components a second rate changed. */
  charges: Map<string, GroupCharge>;
  /** Table that published this group's rates, when the caller named one. */
  table?: TableRef | undefined;
  /** The group's money in its own price list's currency, exact. */
  original?: { currency: string; amounts: Map<string, bigint>; total: bigint } | undefined;
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

/**
 * Add one request's tranche detail to a group's running total.
 *
 * Tokens and money add; the rates and multipliers are properties of the rate
 * card, so they are carried rather than summed. Two different TTL tiers can meet
 * in one band — the card may price both — and then neither multiplier describes
 * the band's blended money, so both are dropped and the amounts stand alone.
 */
function addGroupCharge(target: GroupCharge, charge: ComponentCharge): void {
  target.baseTokens += charge.baseTokens;
  target.excessTokens += charge.excessTokens;
  target.excessAmount += charge.excess;
  target.excessRate = charge.excessRate ?? target.excessRate;
  if (charge.ttlTier === null) return;
  const existing = target.ttlTiers.get(charge.ttlTier);
  target.ttlTiers.set(charge.ttlTier, {
    tokens: (existing?.tokens ?? 0) + charge.ttlTokens,
    multiplier: charge.ttlMultiplier,
  });
}

/** Fold one group's tranche detail into another's, for merged groups. */
function mergeGroupCharge(target: GroupCharge, source: GroupCharge): void {
  target.baseTokens += source.baseTokens;
  target.excessTokens += source.excessTokens;
  target.excessAmount += source.excessAmount;
  target.excessRate = source.excessRate ?? target.excessRate;
  for (const [tier, entry] of source.ttlTiers) {
    const existing = target.ttlTiers.get(tier);
    target.ttlTiers.set(tier, {
      tokens: (existing?.tokens ?? 0) + entry.tokens,
      multiplier: entry.multiplier,
    });
  }
}

/**
 * Turn a group's exact tranche totals into the report's display strings.
 *
 * `excessAmount` is rounded exactly like the component amounts it is a part of,
 * so it never claims more than the line it belongs to.
 */
function displayCharges(
  charges: ReadonlyMap<string, GroupCharge>,
  convert: (value: bigint) => bigint,
): Record<string, CostCharge> {
  const displayed: Record<string, CostCharge> = {};
  for (const [id, charge] of charges) {
    // One tier is the normal case and the only one a single multiplier can
    // describe; if a band ever mixes several, its money is reported without one.
    let single: { tier: CacheWriteTtl; tokens: number; multiplier: bigint } | undefined;
    if (charge.ttlTiers.size === 1) {
      const [tier, entry] = [...charge.ttlTiers.entries()][0] as [
        CacheWriteTtl,
        { tokens: number; multiplier: bigint },
      ];
      single = { tier, tokens: entry.tokens, multiplier: entry.multiplier };
    }
    displayed[id] = {
      baseTokens: charge.baseTokens,
      excessTokens: charge.excessTokens,
      excessAmount: renderRounded(convert(charge.excessAmount)),
      excessRate: charge.excessRate === null ? null : renderRate(charge.excessRate),
      ttlTier: single?.tier ?? null,
      ttlTokens: single?.tokens ?? 0,
      ttlMultiplier: single === undefined ? '1' : renderRate(single.multiplier),
    };
  }
  return displayed;
}

/** Render a scaled rate as the decimal string it was published as. */
function renderRate(value: bigint): string {
  return trimDecimal(formatDecimal(value, MONEY_SCALE_DIGITS));
}

/**
 * Add two bands' tranche views, component by component.
 *
 * Tokens and money add; a rate or multiplier is a property of the rate card and
 * survives only while both sides agree on it, so a band that mixed two TTL tiers
 * reports neither rather than one of them.
 */
function mergeChargeViews(
  left: Readonly<Record<string, CostCharge>> | undefined,
  right: Readonly<Record<string, CostCharge>> | undefined,
  sum: (first: string, second: string) => string,
): Record<string, CostCharge> | undefined {
  if (left === undefined) return right === undefined ? undefined : { ...right };
  if (right === undefined) return { ...left };
  const merged: Record<string, CostCharge> = { ...left };
  for (const [id, charge] of Object.entries(right)) {
    const existing = merged[id];
    if (existing === undefined) {
      merged[id] = { ...charge };
      continue;
    }
    const sameTier = existing.ttlTier === charge.ttlTier;
    merged[id] = {
      baseTokens: existing.baseTokens + charge.baseTokens,
      excessTokens: existing.excessTokens + charge.excessTokens,
      excessAmount: sum(existing.excessAmount, charge.excessAmount),
      excessRate: existing.excessRate ?? charge.excessRate,
      ttlTier: sameTier ? existing.ttlTier : null,
      ttlTokens: sameTier ? existing.ttlTokens + charge.ttlTokens : 0,
      ttlMultiplier: sameTier ? existing.ttlMultiplier : '1',
    };
  }
  return merged;
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
  /**
   * Exact sums per (table, currency), in each table's published currency.
   *
   * Empty unless the caller handed in {@link OriginalPricing}: a run that never
   * names the tables has nothing to subtotal by.
   */
  originals: Map<string, OriginalTotal>;
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
  /**
   * One row per (table, currency), present when the caller tracked originals.
   *
   * Their display figures add up to {@link CostSummary.totals}: they are summed
   * from the same rounded bands the total is, so the block reconciles with the
   * number above it instead of nearly matching it.
   */
  subtotals: CostSubtotal[];
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

/** Add two rounded amounts exactly, as decimals. */
function addAmounts(left: string, right: string): string {
  return formatDecimal(parseDecimal(left) + parseDecimal(right), COST_DIGITS);
}

/** Multiply a rounded amount by an exact decimal rate, keeping the scale. */
function multiplyAmount(amount: string, rate: string): bigint {
  return parseDecimal(multiplyDecimal(amount, rate));
}

/**
 * Price a set of records.
 *
 * Pure and engine-agnostic: it asks the engine for each record's rates, groups by
 * (as-named model, period, tier), and accumulates exact amounts. Records the engine cannot
 * price are counted rather than silently treated as free.
 * @param records - the records to bill.
 * @param engine - the engine supplying rates.
 * @returns the exact cost, ready to be converted and rounded.
 */
export function priceRecords(
  records: readonly UsageRecord[],
  engine: PricingEngine,
  original?: OriginalPricing | undefined,
): UsageCost {
  const groups = new Map<string, CostGroup>();
  const components = new Map<string, ComponentUsage>();
  const exact: ExactCost = { byComponent: new Map(), total: 0n };
  const originals = new Map<string, OriginalTotal>();
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
    // Grouped by the model the *request* named, not by the price schedule it was
    // matched to: an alias is what the reader sees, and two names that happen to
    // share a schedule are still two models with their own rows. The schedule
    // name survives in `resolution` and in the engine's own provenance.
    const groupKey = `${record.model}\u0000${period.id}\u0000${tier}`;
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = {
        model: record.model,
        periodId: period.id,
        periodLabel: period.label,
        tier,
        resolution,
        requests: 0,
        amounts: new Map(),
        charges: new Map(),
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
    // The tranche detail is carried, not re-derived: the engine already split
    // the money, and the band has to agree with it to the last unit.
    for (const [id, charge] of cost.charges ?? []) {
      let entry = group.charges.get(id);
      if (entry === undefined) {
        entry = { baseTokens: 0, excessTokens: 0, excessAmount: 0n, excessRate: null, ttlTiers: new Map() };
        group.charges.set(id, entry);
      }
      addGroupCharge(entry, charge);
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
    // The same request, billed at the rates its own price list published. The
    // display money above is untouched: this only says what the vendor printed.
    if (original === undefined) continue;
    const raw = original.engine.costOf(record);
    if (raw === undefined) continue;
    const table = original.tableOf(raw.rate.period);
    if (table === undefined) continue;
    const currency = raw.rate.period.currency;
    const key = `${table.id}\u0000${currency}`;
    let total = originals.get(key);
    if (total === undefined) {
      total = { table, currency, requests: 0, amount: 0n, display: 0n };
      originals.set(key, total);
    }
    total.requests += 1;
    total.amount += raw.total;
    total.display += cost.total;
    group.table ??= table;
    const band = (group.original ??= { currency, amounts: new Map(), total: 0n });
    band.total += raw.total;
    for (const [id, amount] of raw.amounts) band.amounts.set(id, (band.amounts.get(id) ?? 0n) + amount);
  }

  return {
    tokens: sumTokens(records),
    exact,
    components,
    priced,
    unpriced,
    originals,
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
  const originals = new Map<string, OriginalTotal>();
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
    for (const [id, total] of cost.originals) {
      const known = originals.get(id);
      if (known === undefined) originals.set(id, { ...total });
      else {
        known.requests += total.requests;
        known.amount += total.amount;
        known.display += total.display;
      }
    }
    for (const [id, usage] of cost.components) {
      const known = components.get(id);
      if (known === undefined) components.set(id, { ...usage });
      else known.tokens += usage.tokens;
    }
    for (const group of cost.groups) {
      const key = `${group.model}\u0000${group.periodId}\u0000${group.tier}`;
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, {
          ...group,
          amounts: new Map(group.amounts),
          charges: new Map(
            [...group.charges].map(([id, charge]) => [id, { ...charge, ttlTiers: new Map(charge.ttlTiers) }]),
          ),
          counters: { ...group.counters },
          ...(group.original === undefined
            ? {}
            : { original: { ...group.original, amounts: new Map(group.original.amounts) } }),
        });
        continue;
      }
      existing.requests += group.requests;
      for (const [id, amount] of group.amounts) {
        existing.amounts.set(id, (existing.amounts.get(id) ?? 0n) + amount);
      }
      if (group.original !== undefined && group.table !== undefined) {
        existing.table ??= group.table;
        if (existing.original === undefined) {
          existing.original = { ...group.original, amounts: new Map(group.original.amounts) };
        } else {
          existing.original.total += group.original.total;
          for (const [id, amount] of group.original.amounts) {
            existing.original.amounts.set(id, (existing.original.amounts.get(id) ?? 0n) + amount);
          }
        }
      }
      for (const [id, charge] of group.charges) {
        let entry = existing.charges.get(id);
        if (entry === undefined) {
          entry = { baseTokens: 0, excessTokens: 0, excessAmount: 0n, excessRate: null, ttlTiers: new Map() };
          existing.charges.set(id, entry);
        }
        mergeGroupCharge(entry, charge);
      }
      for (const counter of Object.keys(existing.counters) as ReportCounter[]) {
        existing.counters[counter] += group.counters[counter];
      }
      existing.reasoningTokens += group.reasoningTokens;
    }
  }

  return { tokens, exact, components, priced, unpriced, originals, groups: [...groups.values()] };
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
 * @param original - the original-currency view, when the caller tracked one.
 * @returns display totals, per-group breakdown, and per-table subtotals.
 */
export function summarize(
  cost: UsageCost,
  convert: (value: bigint) => bigint = (value) => value,
  original?: OriginalPricing | undefined,
): CostSummary {
  const displayCurrency = original?.currency ?? '';
  const subtotals = new Map<string, CostSubtotal>();
  const breakdown: CostBreakdown[] = cost.groups.map((group) => {
    const amounts: Record<string, string> = {};
    let groupTotal = 0n;
    for (const [id, amount] of group.amounts) {
      const value = round(convert(amount));
      amounts[id] = renderRounded(value);
      groupTotal += value;
    }
    const charges = group.charges.size === 0 ? undefined : displayCharges(group.charges, convert);
    const band: CostBreakdown = {
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
    if (charges !== undefined) band.charges = charges;
    // The same band in the currency its own price list published. No conversion
    // happens here — these amounts are already the vendor's numbers — so the
    // band rounds each side exactly once and both are the same money.
    if (group.original !== undefined && original !== undefined) {
      const originalAmounts: Record<string, string> = {};
      let originalTotal = 0n;
      for (const [id, amount] of group.original.amounts) {
        const value = round(amount);
        originalAmounts[id] = renderRounded(value);
        originalTotal += value;
      }
      band.original = {
        currency: group.original.currency,
        table: group.table?.id ?? '',
        tableLabel: group.table?.label ?? '',
        amounts: originalAmounts,
        total: renderRounded(originalTotal),
      };
      band.money = {
        original: { currency: group.original.currency, amount: band.original.total },
        display: { currency: displayCurrency, amount: band.total },
      };
      // Subtotals are summed from the *rounded* bands above, which is what the
      // totals are summed from too: the block adds up to the number over it.
      if (group.table !== undefined) {
        const key = `${group.table.id}\u0000${group.original.currency}`;
        let entry = subtotals.get(key);
        if (entry === undefined) {
          entry = {
            table: group.table.id,
            tableLabel: group.table.label,
            currency: group.original.currency,
            requests: 0,
            original: '0.0000',
            display: '0.0000',
            money: { original: { currency: group.original.currency, amount: '0.0000' }, display: { currency: displayCurrency, amount: '0.0000' } },
          };
          subtotals.set(key, entry);
        }
        entry.requests += band.requests;
        entry.original = addAmounts(entry.original, band.original.total);
        entry.display = addAmounts(entry.display, band.total);
      }
    }
    return band;
  });

  // The totals are the sum of the bands, never a second rounding of the same
  // money: a band is the finest unit that has a price of its own, so it is the
  // only place rounding happens. Everything above a band adds up exactly.
  const byComponent = new Map<string, bigint>();
  let total = 0n;
  let reasoning = 0n;
  for (const band of breakdown) {
    for (const [id, amount] of Object.entries(band.amounts)) {
      byComponent.set(id, (byComponent.get(id) ?? 0n) + parseDecimal(amount));
    }
    total += parseDecimal(band.total);
    reasoning += parseDecimal(band.reasoningCost);
  }
  const atDisplay = (value: bigint | undefined): string => formatDecimal(value ?? 0n, COST_DIGITS);
  const totals: CostTotals = {
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheHitInputCost: atDisplay(byComponent.get('input-hit')),
    cacheMissInputCost: atDisplay(byComponent.get('input-miss')),
    outputCost: atDisplay(byComponent.get('output')),
    cacheWriteInputCost: atDisplay(byComponent.get('input-write')),
    reasoningCost: atDisplay(reasoning),
    total: atDisplay(total),
  };
  for (const group of cost.groups) {
    totals.cacheHitInputTokens += group.counters.cacheHitInputTokens;
    totals.cacheMissInputTokens += group.counters.cacheMissInputTokens;
    totals.outputTokens += group.counters.outputTokens;
    totals.cacheWriteTokens += group.counters.cacheWriteTokens;
  }

  // Each table's share, in the currency its own list printed.
  //
  // The displayed figure is the sum of the same rounded bands the total is
  // summed from, so the block adds up to the number above it — which is what a
  // reader checks. The one-step reading (convert the published sum once) and the
  // per-record reading are both carried beside it: rounding each band once is
  // this report's documented arithmetic, and the three part company by up to a
  // rounding unit per band, so the numbers are shown rather than reconciled away.
  const rows: CostSubtotal[] = [];
  for (const [key, entry] of subtotals) {
    const exact = cost.originals.get(key);
    const rate = original?.rates?.get(key);
    const converted = rate === undefined ? undefined : renderRounded(multiplyAmount(entry.original, rate));
    const perRecord = exact === undefined ? undefined : renderRounded(exact.display);
    const money: DualMoney = {
      original: { currency: entry.currency, amount: entry.original },
      display: { currency: displayCurrency, amount: entry.display },
    };
    const row: CostSubtotal = { ...entry, money };
    if (converted !== undefined) row.converted = converted;
    if (perRecord !== undefined) row.perRecord = perRecord;
    rows.push(row);
  }
  rows.sort(subtotalOrder);

  return { totals, breakdown, components: cost.components, priced: cost.priced, unpriced: cost.unpriced, subtotals: rows };
}

/** Display totals with every field at zero. */
export function zeroCostTotals(): CostTotals {
  return {
    cacheHitInputTokens: 0,
    cacheMissInputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheHitInputCost: '0.0000',
    cacheMissInputCost: '0.0000',
    outputCost: '0.0000',
    cacheWriteInputCost: '0.0000',
    reasoningCost: '0.0000',
    total: '0.0000',
  };
}

/**
 * Add two display totals, exactly.
 *
 * Both sides are already rounded to display precision, so this is plain decimal
 * addition of the numbers a reader can see — which is the point: a total that is
 * the sum of the rows beneath it always agrees with them.
 * @param left - first total.
 * @param right - second total.
 * @returns their sum.
 */
export function addCostTotals(left: CostTotals, right: CostTotals): CostTotals {
  const sum = (first: string, second: string): string =>
    formatDecimal(parseDecimal(first) + parseDecimal(second), COST_DIGITS);
  return {
    cacheHitInputTokens: left.cacheHitInputTokens + right.cacheHitInputTokens,
    cacheMissInputTokens: left.cacheMissInputTokens + right.cacheMissInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    cacheHitInputCost: sum(left.cacheHitInputCost, right.cacheHitInputCost),
    cacheMissInputCost: sum(left.cacheMissInputCost, right.cacheMissInputCost),
    outputCost: sum(left.outputCost, right.outputCost),
    cacheWriteInputCost: sum(left.cacheWriteInputCost, right.cacheWriteInputCost),
    reasoningCost: sum(left.reasoningCost, right.reasoningCost),
    total: sum(left.total, right.total),
  };
}

/**
 * Add display summaries together.
 * @param sets - the summaries to add, in any order.
 * @returns one summary whose bands are the union, keyed by (model, period, tier).
 */
export function addSummaries(sets: readonly CostSummary[]): CostSummary {
  const sum = (left: string, right: string): string =>
    formatDecimal(parseDecimal(left) + parseDecimal(right), COST_DIGITS);
  let totals = zeroCostTotals();
  const bands = new Map<string, CostBreakdown>();
  const components = new Map<string, ComponentUsage>();
  const subtotals = new Map<string, CostSubtotal>();
  let priced = 0;
  let unpriced = 0;

  for (const set of sets) {
    priced += set.priced;
    unpriced += set.unpriced;
    totals = addCostTotals(totals, set.totals);
    for (const [id, usage] of set.components) {
      const known = components.get(id);
      if (known === undefined) components.set(id, { ...usage });
      else known.tokens += usage.tokens;
    }
    // Subtotals are display values already, so they add exactly like the totals
    // do: the table block under a report sums to the number above it.
    for (const row of set.subtotals) {
      const key = `${row.table}\u0000${row.currency}`;
      const existing = subtotals.get(key);
      if (existing === undefined) {
        subtotals.set(key, { ...row, money: { original: { ...row.money.original }, display: { ...row.money.display } } });
        continue;
      }
      const original = sum(existing.original, row.original);
      const display = sum(existing.display, row.display);
      subtotals.set(key, {
        ...existing,
        requests: existing.requests + row.requests,
        original,
        display,
        money: {
          original: { currency: existing.currency, amount: original },
          display: { currency: existing.money.display.currency, amount: display },
        },
        ...(existing.perRecord === undefined && row.perRecord === undefined
          ? {}
          : { perRecord: sum(existing.perRecord ?? existing.display, row.perRecord ?? row.display) }),
        ...(existing.converted === undefined && row.converted === undefined
          ? {}
          : { converted: sum(existing.converted ?? existing.display, row.converted ?? row.display) }),
      });
    }
    for (const band of set.breakdown) {
      const key = `${band.model}\u0000${band.periodId}\u0000${band.tier}`;
      const existing = bands.get(key);
      if (existing === undefined) {
        bands.set(key, {
          ...band,
          amounts: { ...band.amounts },
          ...(band.charges === undefined ? {} : { charges: { ...band.charges } }),
          ...(band.original === undefined
            ? {}
            : { original: { ...band.original, amounts: { ...band.original.amounts } } }),
        });
        continue;
      }
      const amounts: Record<string, string> = { ...existing.amounts };
      for (const [id, amount] of Object.entries(band.amounts)) {
        amounts[id] = sum(amounts[id] ?? '0.0000', amount);
      }
      const charges = mergeChargeViews(existing.charges, band.charges, sum);
      const original = sumOriginalViews(existing.original, band.original, sum);
      const total = sum(existing.total, band.total);
      bands.set(key, {
        ...existing,
        requests: existing.requests + band.requests,
        total,
        reasoningCost: sum(existing.reasoningCost, band.reasoningCost),
        amounts,
        ...(charges === undefined ? {} : { charges }),
        ...(original === undefined ? {} : { original, money: dualOf(original, total, existing.money) }),
      });
    }
  }

  return {
    totals,
    breakdown: [...bands.values()],
    components,
    priced,
    unpriced,
    subtotals: [...subtotals.values()].sort(subtotalOrder),
  };
}

/**
 * Order subtotals the way a reader checks them: largest bill first.
 *
 * A merged report builds its rows in first-seen order, which says more about
 * where the sessions happened to live than about the money; sorting here keeps
 * every consumer's block in the same, meaningful order.
 * @param left - first row.
 * @param right - second row.
 * @returns the comparison.
 */
function subtotalOrder(left: CostSubtotal, right: CostSubtotal): number {
  return (
    Number(right.money.display.amount) - Number(left.money.display.amount) ||
    left.tableLabel.localeCompare(right.tableLabel)
  );
}

/** Add two bands' original-currency views, when both carry one. */
function sumOriginalViews(
  left: CostBreakdown['original'],
  right: CostBreakdown['original'],
  sum: (left: string, right: string) => string,
): CostBreakdown['original'] {
  if (left === undefined) return right;
  if (right === undefined || right.currency !== left.currency) return left;
  const amounts: Record<string, string> = { ...left.amounts };
  for (const [id, amount] of Object.entries(right.amounts)) {
    amounts[id] = sum(amounts[id] ?? '0.0000', amount);
  }
  return {
    currency: left.currency,
    table: left.table,
    tableLabel: left.tableLabel,
    amounts,
    total: sum(left.total, right.total),
  };
}

/** The band's dual money after merging, keeping the display currency it had. */
function dualOf(
  original: { currency: string; total: string },
  display: string,
  previous: CostBreakdown['money'],
): DualMoney {
  return {
    original: { currency: original.currency, amount: original.total },
    display: { currency: previous?.display.currency ?? '', amount: display },
  };
}

/** Convert a JavaScript number into the scaled decimal representation. */
function decimalFromNumber(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new UserError('rateInvalid', { value: String(value) });
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
export function costOf(
  records: readonly UsageRecord[],
  engine: PricingEngine,
  currencyRate = 1,
  original?: OriginalPricing | undefined,
): CostSummary {
  return summarize(priceRecords(records, engine, original), converter(currencyRate), original);
}

/**
 * Price several record sets and add the results.
 *
 * Each set is priced and rounded on its own, then the display values are added:
 * this is what makes a group of rows add up to the row above them. Rounding the
 * merged exact total instead would make the total depend on how the usage was
 * grouped — one number for the sum of the rows and another for the whole.
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
  return addSummaries(sets.map((records) => costOf(records, engine, currencyRate)));
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
  compare(t().errors.metricInputMiss, tokens.input, projected.input);
  compare(t().errors.metricOutput, tokens.output, projected.output);
  compare(t().errors.metricCacheRead, tokens.cacheRead, projected.cacheRead);
  compare(t().errors.metricCacheWrite, tokens.cacheWrite, projected.cacheWrite);
  if (diffs.length === 0) return undefined;
  return renderDiagnostic('projectionMismatch', { diffs: diffs.join(t().errors.metricJoin) });
}
