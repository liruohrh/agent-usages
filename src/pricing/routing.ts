/**
 * Routing: one engine, many price tables.
 *
 * A run may read several agents at once, and an agent is not a vendor: `dsh` and
 * `pi` run whatever model the user points them at, and `codex` runs OpenAI while
 * `claudecode` runs Anthropic. So a table is chosen **per record**, from the model the
 * record names: the first table in configuration order that knows it wins, and a
 * model no table prices stays unpriced rather than borrowing another vendor's
 * rate — an unpriced record is honest, a guessed price is not.
 *
 * `--provider` keeps its meaning as a pin: one table, used for every record —
 * exactly what `createPricingEngine` does, which is why a pinned run barely needs
 * a router at all.
 *
 * The rest of {@link PricingEngine} is vendor-neutral (`describeBasis`,
 * `quantityOf`) or belongs to the period that was chosen (`describeWindow`,
 * `describeTiers`), so those delegate to the table that published that period.
 */

import { createPricingEngine, bareModelName } from './engine.ts';
import type {
  BillingBasis,
  PricingEngine,
  PricingProvider,
  RateComponent,
  RecordCost,
  ResolvedRate,
  PricePeriod,
} from './contract.ts';
import type { HolidayCalendar } from '../core/calendar.ts';
import type { TokenBuckets, UsageRecord } from '../core/types.ts';

/**
 * An engine that picks a table per record.
 *
 * Everything a `PricingEngine` offers, plus the two questions a report header
 * asks: which tables this run may draw on, and which of them actually priced
 * something (the header names those, and only those).
 */
export interface RoutingEngine extends PricingEngine {
  /** The tables this run may draw on, in configuration order. */
  tables(): readonly PricingProvider[];
  /**
   * The tables that were in effect for this run, in configuration order.
   *
   * A pinned run reports the pinned table whether or not it priced anything, since
   * that is the table the numbers came from either way; an unpinned run reports
   * only the tables that priced at least one record.
   */
  tablesUsed(): readonly PricingProvider[];
  /** Whether one table was pinned (the `--provider` case). */
  readonly pinned: boolean;
}

/** Whether an engine routes per record rather than standing for a single table. */
export function isRoutingEngine(engine: PricingEngine): engine is RoutingEngine {
  return typeof (engine as Partial<RoutingEngine>).tablesUsed === 'function';
}

/** How to build the engines a router delegates to. */
export interface RoutingOptions {
  /**
   * Pin one table: only it prices records.
   *
   * This is what `--provider` asks for, and it is deliberately *not* routing: the
   * user named a table, so every record is read against it.
   */
  pinned?: PricingProvider | undefined;
  /**
   * Build one table's engine.
   *
   * The caller needs this seam because it converts each table's rates from that
   * table's own published currency, so the engine it wants is not always
   * `createPricingEngine(provider)`. Defaults to that call, with `holidays`.
   */
  engineFor?: ((provider: PricingProvider) => PricingEngine) | undefined;
  /** Holiday calendar handed to the default engine builder. */
  holidays?: HolidayCalendar | undefined;
}

/** The default engine for one table: vendor-neutral, with the holiday calendar. */
function defaultEngineFor(provider: PricingProvider, holidays: HolidayCalendar | undefined): PricingEngine {
  return createPricingEngine(provider, holidays === undefined ? {} : { holidays });
}

/** The two lookups {@link PricingEngine.resolve} itself makes before a fallback. */
function knows(provider: PricingProvider, model: string): boolean {
  return provider.find(model) !== undefined || provider.find(bareModelName(model)) !== undefined;
}

/**
 * Build the router.
 * @param providers - every table, in configuration order (the order is the priority).
 * @param options - the pin, and how each table's engine is built.
 * @returns an engine that resolves each record against the table that knows its model.
 */
export function createRoutingEngine(
  providers: readonly PricingProvider[],
  options: RoutingOptions = {},
): RoutingEngine {
  const build = options.engineFor ?? ((provider: PricingProvider) => defaultEngineFor(provider, options.holidays));
  const pinned = options.pinned === undefined ? undefined : build(options.pinned);
  const engines = providers.map(build);
  return new Router(engines, pinned);
}

/** The implementation, kept private: callers get the interface above. */
class Router implements RoutingEngine {
  private readonly engines: readonly PricingEngine[];
  private readonly pin: PricingEngine | undefined;
  /** Providers that priced at least one record, by provider identity. */
  private readonly served = new Set<PricingProvider>();
  /** Which table published a period, so its prose can be written by that table. */
  private readonly owner = new WeakMap<PricePeriod, PricingEngine>();

  constructor(engines: readonly PricingEngine[], pin: PricingEngine | undefined) {
    const first = engines[0] ?? pin;
    if (first === undefined) throw new Error('createRoutingEngine: at least one pricing provider is required');
    this.engines = engines.length === 0 ? [first] : engines;
    this.pin = pin;
    for (const engine of this.engines) {
      for (const model of engine.provider.models()) {
        for (const period of model.periods) this.owner.set(period, engine);
      }
    }
  }

  get provider(): PricingProvider {
    return (this.pin ?? this.engines[0]!).provider;
  }

  get pinned(): boolean {
    return this.pin !== undefined;
  }

  tables(): readonly PricingProvider[] {
    return this.engines.map((engine) => engine.provider);
  }

  tablesUsed(): readonly PricingProvider[] {
    if (this.pin !== undefined) return [this.pin.provider];
    return this.engines.filter((engine) => this.served.has(engine.provider)).map((engine) => engine.provider);
  }

  /** The engine that should price this record, or `undefined` when none can. */
  private ownerOf(model: string): PricingEngine | undefined {
    if (this.pin !== undefined) return this.pin;
    return this.engines.find((engine) => knows(engine.provider, model));
  }

  /** The engine that published a period, or the first one when it is unknown. */
  private engineFor(period: PricePeriod): PricingEngine {
    return this.owner.get(period) ?? this.engines[0]!;
  }

  resolve(record: UsageRecord): ResolvedRate | undefined {
    const engine = this.ownerOf(record.model);
    if (engine === undefined) return undefined;
    const resolved = engine.resolve(record);
    if (resolved !== undefined) this.served.add(engine.provider);
    return resolved;
  }

  costOf(record: UsageRecord): RecordCost | undefined {
    const engine = this.ownerOf(record.model);
    if (engine === undefined) return undefined;
    const cost = engine.costOf(record);
    if (cost !== undefined) this.served.add(engine.provider);
    return cost;
  }

  describeWindow(period: PricePeriod): string {
    return this.engineFor(period).describeWindow(period);
  }

  describeTiers(period: PricePeriod): string {
    return this.engineFor(period).describeTiers(period);
  }

  describeBasis(basis: BillingBasis): string {
    return this.engines[0]!.describeBasis(basis);
  }

  quantityOf(component: RateComponent, tokens: TokenBuckets): number {
    return this.engines[0]!.quantityOf(component, tokens);
  }
}
