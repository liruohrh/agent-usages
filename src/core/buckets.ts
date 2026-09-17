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
