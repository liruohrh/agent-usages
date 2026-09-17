/** Token-bucket helpers shared by adapters and accounting. */
import type { TokenBuckets } from './types.ts';

/** Buckets with every counter at zero. */
export function emptyBuckets(): TokenBuckets {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

/**
 * Add two bucket sets together.
 * @param base - buckets to add into.
 * @param extras - bucket sets to add.
 * @returns a new bucket set.
 */
export function addBuckets(base: TokenBuckets, ...extras: readonly TokenBuckets[]): TokenBuckets {
  const merged: TokenBuckets = { ...base };
  for (const extra of extras) {
    merged.input += extra.input;
    merged.output += extra.output;
    merged.cacheRead += extra.cacheRead;
    merged.cacheWrite += extra.cacheWrite;
    merged.reasoning += extra.reasoning;
  }
  return merged;
}

/** Total tokens a report counts: the four disjoint billed buckets. */
export function totalTokens(buckets: TokenBuckets): number {
  return buckets.input + buckets.output + buckets.cacheRead + buckets.cacheWrite;
}

/** How an adapter's four disjoint buckets add up, as a reader needs to see them. */
export interface TokenBreakdown {
  /** Prompt tokens that missed the cache. */
  inputMiss: number;
  /** Prompt tokens served from the cache. */
  inputHit: number;
  /** Prompt tokens written to the cache; `0` for providers that never write. */
  inputWrite: number;
  /**
   * Total prompt tokens: `inputMiss + inputHit + inputWrite`.
   *
   * The buckets are disjoint, so a request's prompt is their sum — never one of
   * them alone.
   */
  inputTotal: number;
  /**
   * Reasoning tokens, which the provider reports **inside** the completion
   * count. Shown separately because it is interesting, not because it is extra.
   */
  reasoning: number;
  /** Completion tokens excluding reasoning: `output - reasoning`. */
  outputOnly: number;
  /**
   * Total completion tokens generated: `outputOnly + reasoning`, which is the
   * provider's own completion count. Reasoning is therefore counted once here,
   * not added on top of it.
   */
  outputTotal: number;
  /** Every token the provider counted: `inputTotal + outputTotal`. */
  total: number;
}

/**
 * Derive the reader-facing token breakdown from the raw buckets.
 * @param tokens - the four disjoint adapter buckets.
 * @returns the breakdown, with every figure a sum of disjoint parts.
 */
export function tokenBreakdown(tokens: TokenBuckets): TokenBreakdown {
  const inputTotal = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  // A provider could in principle report reasoning outside the completion count;
  // `outputOnly` is clamped so the two derived figures always add up.
  const reasoning = Math.min(tokens.reasoning, tokens.output);
  const outputOnly = tokens.output - reasoning;
  return {
    inputMiss: tokens.input,
    inputHit: tokens.cacheRead,
    inputWrite: tokens.cacheWrite,
    inputTotal,
    reasoning,
    outputOnly,
    outputTotal: outputOnly + reasoning,
    total: inputTotal + outputOnly + reasoning,
  };
}
