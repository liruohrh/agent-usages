/**
 * The usage store, end to end.
 *
 * These spawn the real CLI against synthetic agent homes and a database of their
 * own, because what is under test is the *contract* of persistence:
 *
 * - a second run over unchanged files answers the same numbers without parsing,
 *   which is proved by planting a value in the database and watching it come back;
 * - a file that changed is read again;
 * - a directory that disappeared keeps its history and says so, and so does a
 *   single file that disappeared inside a directory that is still there;
 * - a database that cannot be trusted is moved aside, and one that cannot be
 *   written does not fail the run.
 *
 * Real data is deliberately absent here — the borrowed dump is a *validation*
 * step, not a fixture, because it changes under the reader and cannot express
 * "this file was deleted a moment ago".
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli', 'index.ts');

/** One Claude Code session log with the given message ids, one request each. */
function claudeLog(sessionId: string, messageIds: readonly string[]): string {
  const lines = [
    JSON.stringify({ type: 'user', uuid: 'u1', sessionId, timestamp: '2026-09-23T00:00:00.000Z', cwd: '/tmp/demo' }),
  ];
  messageIds.forEach((messageId, index) => {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        uuid: `a${index}`,
        parentUuid: null,
        sessionId,
        timestamp: `2026-09-23T00:0${index + 1}:00.000Z`,
        cwd: '/tmp/demo',
        message: {
          id: messageId,
          model: 'deepseek-v4-flash',
          usage: { input_tokens: 1_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }),
    );
  });
  return `${lines.join('\n')}\n`;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

interface Report {
  totals: { requests: number; cost: { total: string } };
  warnings: { code: string; message: string }[];
  projects: { sessionReports: { id: string; title: string | null; requests: number }[] }[];
}

let root: string;
let storeDir: string;
let configHome: string;

/** Run the CLI with the given arguments and environment. */
async function runCli(args: string[], extraEnv: Record<string, string> = {}): Promise<Result> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, 'usage', ...args], {
      env: {
        ...process.env,
        LANG: 'zh_CN.UTF-8',
        HOME: configHome,
        XDG_CONFIG_HOME: configHome,
        CLAUDE_CONFIG_DIR: root,
        ...extraEnv,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

/** Path of the store this test's runs share. */
const storePath = (): string => join(storeDir, 'usage.db');

/** Run the CLI against one Claude Code home and one scan database. */
async function usage(args: string[] = [], extraEnv: Record<string, string> = {}): Promise<Result> {
  return runCli(
    ['--agent', 'claudecode', '--home', root, '--db', storePath(), '--no-update', '--json', ...args],
    extraEnv,
  );
}

/** The report one run produced, asserting it actually succeeded. */
async function report(args: string[] = [], extraEnv: Record<string, string> = {}): Promise<Report> {
  const result = await usage(args, extraEnv);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Report;
}

/** The session titles a report carries, for spotting a planted value. */
function titles(seen: Report): (string | null)[] {
  return seen.projects.flatMap((project) => project.sessionReports.map((entry) => entry.title));
}

const warningCodes = (seen: Report): string[] => seen.warnings.map((warning) => warning.code);

/**
 * Rewrite every stored session title to a sentinel.
 *
 * Only a run that answered from the database can show it, so this is what proves
 * a warm run did not parse the logs. It edits the database with `sqlite3`'s own
 * SQL through the same driver the tool uses.
 */
async function plantSentinel(): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(storePath());
  try {
    database.exec("UPDATE sessions SET title = 'SENTINEL'");
  } finally {
    database.close();
  }
}

/**
 * Make the stored roots look like another version of the tool wrote them.
 *
 * This is the state a run killed between opening the database and writing its
 * first root leaves behind: `meta.tool_version` already names the build that was
 * running, while the rows — and now the roots' own `reader_version` — are the
 * previous build's work.
 * @param version - the version to blame the rows on.
 */
async function ageStore(version: string): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(storePath());
  try {
    database.exec(`UPDATE roots SET reader_version = '${version}'`);
  } finally {
    database.close();
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-usages-store-root-'));
  storeDir = await mkdtemp(join(tmpdir(), 'agent-usages-store-db-'));
  configHome = await mkdtemp(join(tmpdir(), 'agent-usages-store-home-'));
  const project = join(root, 'projects', '-tmp-demo');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'aaa.jsonl'), claudeLog('11111111-1111-4111-8111-111111111111', ['m1', 'm2']));
  await writeFile(join(project, 'bbb.jsonl'), claudeLog('22222222-2222-4222-8222-222222222222', ['m3']));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(storeDir, { recursive: true, force: true });
  await rm(configHome, { recursive: true, force: true });
});

describe('the usage store', () => {
  it('answers an unchanged root from the store, and writes one on the first run', async () => {
    const cold = await report();
    expect(cold.totals.requests).toBe(3);
    await expect(stat(storePath())).resolves.toBeTruthy();

    await plantSentinel();
    const planted = await stat(storePath());
    const warm = await report();
    // The sentinel can only appear if the second run did not parse the logs.
    expect(titles(warm)).toEqual(['SENTINEL', 'SENTINEL']);
    expect(warm.totals.requests).toBe(cold.totals.requests);
    expect(warm.totals.cost.total).toBe(cold.totals.cost.total);
    // And a run that learned nothing writes nothing: the file is as it was left.
    const after = await stat(storePath());
    expect(after.mtimeMs).toBe(planted.mtimeMs);
    expect(after.size).toBe(planted.size);
  });

  it('re-reads a file that grew, and counts the new request', async () => {
    await report();

    const log = join(root, 'projects', '-tmp-demo', 'aaa.jsonl');
    await writeFile(log, `${(await readFile(log, 'utf8')).trimEnd()}\n${JSON.stringify({
      type: 'assistant',
      uuid: 'a9',
      parentUuid: null,
      sessionId: '11111111-1111-4111-8111-111111111111',
      timestamp: '2026-09-23T00:09:00.000Z',
      cwd: '/tmp/demo',
      message: {
        id: 'm4',
        model: 'deepseek-v4-flash',
        usage: { input_tokens: 1_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    })}\n`);

    const grown = await report();
    expect(grown.totals.requests).toBe(4);
  });

  it('keeps the history of a directory that disappeared, and says so', async () => {
    const cold = await report();
    await rm(root, { recursive: true, force: true });

    const after = await report();
    expect(after.totals.requests).toBe(cold.totals.requests);
    expect(after.totals.cost.total).toBe(cold.totals.cost.total);
    expect(warningCodes(after)).toContain('storeSourceVanished');
  });

  it('measures the machine as it is now under --no-store, and writes nothing', async () => {
    await rm(storePath(), { force: true });
    const fresh = await report(['--no-store']);
    expect(fresh.totals.requests).toBe(3);
    await expect(stat(storePath())).rejects.toThrow();

    // With no store to fall back on, a vanished directory is simply gone.
    await rm(root, { recursive: true, force: true });
    const empty = await usage(['--no-store']);
    expect(empty.code).toBe(1);
  });

  it('keeps the sessions of a single file that disappeared, and says so', async () => {
    const cold = await report();
    expect(cold.totals.requests).toBe(3);
    // One log gone, the directory still there: its session is history, not a
    // number that silently shrinks.
    await rm(join(root, 'projects', '-tmp-demo', 'bbb.jsonl'), { force: true });

    const after = await report();
    expect(after.totals.requests).toBe(3);
    expect(warningCodes(after)).toContain('storeFilesVanished');

    // `--no-store` answers the other question: what is on disk right now.
    const now = await report(['--no-store']);
    expect(now.totals.requests).toBe(2);
    expect(warningCodes(now)).not.toContain('storeFilesVanished');
  });

  it('re-reads a root whose rows were written by another version of the tool', async () => {
    const cold = await report();
    expect(cold.totals.requests).toBe(3);
    await plantSentinel();

    // The file as a killed run leaves it: it recorded the version that was
    // opening it, and never got as far as re-reading the root, so the rows are
    // still the old build's work. Nothing in `meta` can tell, which is why the
    // root carries the version that wrote it.
    await ageStore('0.0.3');
    const aged = await readFile(storePath());

    const after = await report();
    // The sentinel is gone: the run parsed the logs again rather than answering
    // from rows another build wrote.
    expect(titles(after)).not.toContain('SENTINEL');
    expect(titles(after).length).toBe(2);
    expect(after.totals.requests).toBe(cold.totals.requests);
    expect(await readFile(storePath())).not.toEqual(aged);

    // And the re-read stamped the root: the run after it answers from the store
    // again, sentinel and all.
    await plantSentinel();
    const warm = await report();
    expect(titles(warm)).toEqual(['SENTINEL', 'SENTINEL']);
  });

  it('keeps a vanished agent in an "everything" plan while another version wrote its rows', async () => {
    const others = { CODEX_HOME: join(configHome, 'codex'), DSH_HOME: join(configHome, 'dsh'), PI_CODING_AGENT_DIR: join(configHome, 'pi') };
    const all = async (): Promise<Report> => {
      const result = await runCli(['--agent', 'all', '--db', storePath(), '--no-update', '--json'], others);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as Report;
    };

    const cold = await all();
    expect(cold.totals.requests).toBe(3);
    await rm(root, { recursive: true, force: true });
    // An upgrade: a newer build opens the file, and this root is not reusable.
    await ageStore('0.0.3');

    // The directory is gone, so nothing detects the agent — but the store
    // remembers its root, and a root that cannot be reused is still a root whose
    // history has to be reported. Asking "may I reuse this?" here would drop the
    // agent from the plan on the one run where the tombstone is all that is left.
    const after = await all();
    expect(after.totals.requests).toBe(cold.totals.requests);
    expect(warningCodes(after)).toContain('storeSourceVanished');
  });

  it('moves a database that cannot be trusted aside, and reports it', async () => {
    await report();
    await writeFile(storePath(), 'not a database {', 'utf8');
    const rebuilt = await report();
    expect(rebuilt.totals.requests).toBe(3);
    expect(warningCodes(rebuilt)).toContain('storeRebuilt');
    // The old file is kept, not overwritten: it is the user's data.
    const kept = (await readdir(storeDir)).filter((name) => name.includes('.corrupt-'));
    expect(kept.length).toBe(1);
  });

  it('does not fail the run when the store cannot be written', async () => {
    // `/nowhere` is not writable for a normal user: the run must still answer.
    const result = await usage(['--db', '/nowhere/agent-usages/usage.db']);
    expect(result.code).toBe(0);
    const seen = JSON.parse(result.stdout) as Report;
    expect(seen.totals.requests).toBe(3);
    expect(warningCodes(seen)).toContain('storeUnreadable');
  });

  it('uses the data-directory default when --db is absent', async () => {
    const dataHome = await mkdtemp(join(tmpdir(), 'agent-usages-store-xdg-'));
    try {
      const result = await runCli(
        ['--agent', 'claudecode', '--home', root, '--no-update', '--json'],
        { XDG_DATA_HOME: dataHome },
      );
      expect(result.code, result.stderr).toBe(0);
      const path = join(dataHome, 'agent-usages', 'usage.db');
      const header = await readFile(path);
      // A real SQLite database, readable by any sqlite3 client.
      expect(header.subarray(0, 6).toString('utf8')).toBe('SQLite');
    } finally {
      await rm(dataHome, { recursive: true, force: true });
    }
  });
});
/** Run the CLI with a full command line: the `store` family is not `usage`. */
async function runStore(args: string[], extraEnv: Record<string, string> = {}): Promise<Result> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        LANG: 'zh_CN.UTF-8',
        HOME: configHome,
        XDG_CONFIG_HOME: configHome,
        CLAUDE_CONFIG_DIR: root,
        ...extraEnv,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

/** How many roots and sessions one database holds. */
async function storeCounts(path: string): Promise<{ roots: number; sessions: number }> {
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path);
  try {
    const roots = database.prepare('SELECT count(*) AS n FROM roots').get() as { n: number };
    const sessions = database.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number };
    return { roots: Number(roots.n), sessions: Number(sessions.n) };
  } finally {
    database.close();
  }
}

describe('the store command', () => {
  it('says a missing database is empty, and does not create one to say it', async () => {
    const missing = join(storeDir, 'never-written.db');
    const result = await runStore(['store', 'list', '--db', missing]);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('库是空的');
    // Listing is a read: the file it was asked about must still not exist.
    await expect(stat(missing)).rejects.toThrow();
  });

  it('lists what it holds, along the dimension asked for', async () => {
    await report();
    const roots = await runStore(['store', 'list', '--db', storePath()]);
    expect(roots.code).toBe(0);
    expect(roots.stdout).toContain(root);

    const byCwd = await runStore(['store', 'list', '--db', storePath(), '--by', 'cwd', '--json']);
    expect(byCwd.code).toBe(0);
    const document = JSON.parse(byCwd.stdout) as { by: string; nodes: { key: string }[] };
    expect(document.by).toBe('cwd');
    expect(document.nodes.map((node) => node.key)).toContain('/tmp/demo');

    const bad = await runStore(['store', 'list', '--db', storePath(), '--by', 'nope']);
    expect(bad.code).toBe(1);
  });

  it('costs an excluded root without ever storing it', async () => {
    const excludedDb = join(storeDir, 'excluded.db');
    const controlDb = join(storeDir, 'control.db');
    const args = (db: string): string[] => [
      'usage', '--agent', 'claudecode', '--home', root, '--db', db, '--no-update', '--json',
    ];

    const excluded = await runStore([...args(excludedDb), '--store-exclude', root]);
    expect(excluded.code, excluded.stderr).toBe(0);
    // The figures are the same as a stored run's: exclusion decides where rows go,
    // never what the report says.
    expect((JSON.parse(excluded.stdout) as Report).totals.requests).toBe(3);
    expect(await storeCounts(excludedDb)).toEqual({ roots: 0, sessions: 0 });

    const control = await runStore(args(controlDb));
    expect(control.code, control.stderr).toBe(0);
    expect(await storeCounts(controlDb)).toEqual({ roots: 1, sessions: 2 });

    // A second excluded run still writes nothing — the root is not remembered either.
    await runStore([...args(excludedDb), '--store-exclude', root]);
    expect(await storeCounts(excludedDb)).toEqual({ roots: 0, sessions: 0 });
  });

  it('dry-runs a forget, and only deletes with --yes', async () => {
    await report();
    const before = await stat(storePath());
    const dry = await runStore([
      'store', 'forget', '--db', storePath(), '--session', '11111111-1111-4111-8111-111111111111',
    ]);
    expect(dry.code).toBe(0);
    expect(dry.stdout).toContain('预演');
    // A dry run is the real deletion rolled back: the file is untouched.
    expect((await stat(storePath())).mtimeMs).toBe(before.mtimeMs);
    expect((await storeCounts(storePath())).sessions).toBe(2);

    const yes = await runStore([
      'store', 'forget', '--db', storePath(), '--session', '11111111-1111-4111-8111-111111111111', '--yes',
    ]);
    expect(yes.code).toBe(0);
    expect(yes.stdout).toContain('已删除');
    expect((await storeCounts(storePath())).sessions).toBe(1);
  });

  it('refuses a selector-less forget, an unconfirmed --all, and reports no match', async () => {
    await report();
    const none = await runStore(['store', 'forget', '--db', storePath()]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('要说明删什么');

    const unconfirmed = await runStore(['store', 'forget', '--db', storePath(), '--all']);
    expect(unconfirmed.code).toBe(1);
    expect((await storeCounts(storePath())).roots).toBe(1);

    const noMatch = await runStore(['store', 'forget', '--db', storePath(), '--session', 'nope']);
    expect(noMatch.code).toBe(2);
    expect(noMatch.stdout).toContain('没有匹配');
  });

  it('reclaims the space a deletion held', async () => {
    await report();
    // `bytes` counts the database plus its WAL, which is where a fresh write
    // actually sits until the log is folded back in — the figure a reader sees.
    const bytesOf = async (): Promise<number> => {
      const listed = await runStore(['store', 'list', '--db', storePath(), '--json']);
      // An emptied store answers exit 2 and still prints its document: the JSON
      // owns stdout, and 2 is the "there is nothing to list" code.
      expect([0, 2], listed.stderr).toContain(listed.code);
      return (JSON.parse(listed.stdout) as { bytes: number }).bytes;
    };
    const before = await bytesOf();

    const removed = await runStore(['store', 'forget', '--db', storePath(), '--agent', 'claudecode', '--yes']);
    expect(removed.code).toBe(0);
    expect((await storeCounts(storePath())).roots).toBe(0);

    const vacuum = await runStore(['store', 'vacuum', '--db', storePath()]);
    expect(vacuum.code).toBe(0);
    expect(vacuum.stdout).toContain('已回收');
    // The fixture is small enough to sit at SQLite's minimum page size, so the
    // claim is "no bigger, and the write-ahead log is folded back in".
    expect(await bytesOf()).toBeLessThanOrEqual(before);
    const wal = `${storePath()}-wal`;
    const walSize = await stat(wal).then((entry) => entry.size).catch(() => 0);
    expect(walSize).toBe(0);
  });

  it('names an older build as the reader when the logs are gone', async () => {
    await report();
    await ageStore('0.0.1');
    // With the logs gone nothing can be read again, so the rows stay as that
    // build left them — and the report has to say whose reading it is showing.
    await rm(root, { recursive: true, force: true });
    const after = await report();
    expect(warningCodes(after)).toContain('storeSourceOutdated');
    expect(after.warnings.find((warning) => warning.code === 'storeSourceOutdated')?.message).toContain('0.0.1');
  });
});
