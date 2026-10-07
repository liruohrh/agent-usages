/**
 * A dataset as JSON, and back.
 *
 * The dataset is already plain data — paths, numbers, ids, token buckets — with
 * exactly one exception: its warnings are `UserError`s, which carry a *code* and
 * its parameters and render a sentence when they are read. Caching the sentence
 * would freeze it in the language of the run that wrote the cache, so the code
 * and its parameters go to disk and the sentence is rebuilt when the file is
 * read back, in whatever language that reader is using.
 *
 * The module knows nothing about the cache file: it only turns a dataset into
 * something `JSON.stringify` can carry whole, and turns that back.
 */

import { UserError, type ErrorCode, type ErrorParams } from '../i18n/errors.ts';
import type { DatasetStats, ProjectRecord, SessionRecord, UsageDataset } from '../core/types.ts';

/** One warning, as a code and the parameters its sentence needs. */
export interface WarningJson {
  /** The catalogue entry that renders this warning. */
  code: ErrorCode;
  /** What that entry needs to say it. */
  params: Record<string, unknown>;
}

/** A dataset in its JSON form: the same data, warnings as codes. */
export interface DatasetJson {
  /** Agent the dataset came from. */
  agent: string;
  /** Every agent it holds, in the order they were read. */
  agents: string[];
  /** Root the data was read from. */
  source: string;
  /** Projects, verbatim. */
  projects: ProjectRecord[];
  /** Sessions, verbatim. */
  sessions: SessionRecord[];
  /** Counters of what the adapter read. */
  stats: DatasetStats;
  /** Non-fatal problems, as codes — never as sentences. */
  warnings: WarningJson[];
}

/**
 * Turn a dataset into JSON-ready data.
 *
 * The result is a deep copy, so a cache that keeps it cannot be changed by a
 * caller that keeps mutating the dataset it came from.
 * @param dataset - the dataset to serialize.
 * @returns the dataset, with warnings reduced to `{ code, params }`.
 */
export function toJson(dataset: UsageDataset): DatasetJson {
  const { warnings, ...rest } = dataset;
  const body = structuredClone(rest) as Omit<DatasetJson, 'warnings'>;
  return {
    ...body,
    warnings: warnings.map((warning) => ({
      code: warning.code,
      params: structuredClone(warning.params) as Record<string, unknown>,
    })),
  };
}

/**
 * Rebuild a dataset from its JSON form.
 *
 * Warnings become `UserError`s again, so their `message` is rendered in the
 * language active *now* rather than the one the cache was written in.
 *
 * The input is trusted to have come from {@link toJson} (or from a cache file
 * that was checked before it got here); a malformed entry can only produce a
 * wrong sentence, never a thrown loop, because a warning whose code is not in
 * the catalogue renders as the code itself.
 *
 * @param json - the stored form.
 * @returns a dataset equal to the one that was serialized.
 */
export function fromJson(json: DatasetJson): UsageDataset {
  const { warnings, ...rest } = json;
  return {
    ...(structuredClone(rest) as Omit<UsageDataset, 'warnings'>),
    warnings: warnings.map((warning) => new UserError(
      warning.code,
      // The parameters travelled with the code, so the catalog's own type for
      // that entry is what they are; one cast covers the whole union.
      warning.params as ErrorParams<ErrorCode>,
    )),
  };
}
