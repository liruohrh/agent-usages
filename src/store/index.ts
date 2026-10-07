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
 * - `location.ts` — where the database goes when nobody names a path.
 *
 * Nothing here touches the CLI, the adapters or the report: the layers above
 * decide *when* to scan and what to say about it, this one only remembers.
 */

export { STORE_DIR_NAME, STORE_FILE_NAME, defaultStorePath } from './location.ts';
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
