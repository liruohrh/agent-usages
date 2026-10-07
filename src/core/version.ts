/**
 * The version this build reports.
 *
 * Read from `package.json` rather than written down twice: the CLI prints it,
 * and the scan cache stamps it into every file it writes, so a release must not
 * be able to disagree with itself about which version produced a dataset.
 * `--version` and the cache stamp therefore move together by construction.
 */

import { readFileSync } from 'node:fs';

/** The `version` field of this package, e.g. `0.0.2`. */
export const TOOL_VERSION: string = (JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string }).version;
