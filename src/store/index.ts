/**
 * The persistence layer's data side.
 *
 * - `fingerprint.ts` — what a scan read, cheaply described, so the next scan can
 *   tell whether the same files still hold the same usage.
 * - `dataset-json.ts` — a dataset as JSON: warnings travel as codes, never as
 *   sentences, so a stored warning speaks the reader's language, not the
 *   writer's.
 * - `sqlite.ts` — the usage store: roots, files, sessions and records as rows in
 *   a database the user owns, with a schema version and a migration path.
 * - `cache.ts` — the JSON file those entries used to live in. Superseded by the
 *   store; kept until the last caller has moved over.
 * - `location.ts` — where that file goes when nobody names a directory.
 *
 * Nothing here touches the CLI, the adapters or the report: the layers above
 * decide *when* to scan and what to say about it, this one only remembers.
 */

export { SCAN_CACHE_DIR_NAME, defaultScanCacheDir } from './location.ts';
export {
  HEAD_HASH_BYTES,
  fingerprintOf,
  fingerprintsEqual,
  rootIdOf,
  type FingerprintStatus,
  type SourceFingerprint,
} from './fingerprint.ts';
export {
  fromJson,
  toJson,
  warningsFromJson,
  warningsToJson,
  type DatasetJson,
  type WarningJson,
} from './dataset-json.ts';
export {
  STORE_BACKUP_SUFFIX,
  STORE_SCHEMA_VERSION,
  UsageStore,
  type ReadRootResult,
  type StoreRootSummary,
  type UsageStoreOpenOptions,
  type UsageStoreOpenResult,
  type UsageStoreReset,
  type WriteRootInput,
} from './sqlite.ts';
export {
  SCAN_CACHE_FILE,
  SCAN_CACHE_FORMAT,
  ScanCache,
  type ScanCacheDocument,
  type ScanCacheEntry,
  type ScanCacheOpenOptions,
  type ScanCacheOpenResult,
  type ScanCacheReset,
  type ScanCacheResetReason,
  type ScanCacheRoots,
} from './cache.ts';
