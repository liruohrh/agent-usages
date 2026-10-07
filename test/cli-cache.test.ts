/**
 * The scan cache, end to end.
 *
 * These spawn the real CLI against synthetic agent homes and a cache directory
 * of their own, because what is under test is the *contract* of persistence:
 *
 * - a second run over unchanged files answers the same numbers without parsing,
 *   which is proved by planting a value in the cache and watching it come back;
 * - a file that changed is read again;
 * - a directory that disappeared keeps its history and says so;
 * - a cache file that cannot be trusted is rebuilt, and a cache that cannot be
 *   written does not fail the run.
 *
 * Real data is deliberately absent here — the borrowed dump is a *validation*
 * step, not a fixture, because it changes under the reader and cannot express
 * "this directory was deleted a moment ago".
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
let cacheDir: string;
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

/** Run the CLI against one Claude Code home and one cache directory. */
async function usage(args: string[] = [], extraEnv: Record<string, string> = {}): Promise<Result> {
  return runCli(
    ['--agent', 'claudecode', '--home', root, '--cache-dir', cacheDir, '--no-update', '--json', ...args],
    extraEnv,
  );
}

/** The report one run produced, asserting it actually succeeded. */
async function report(args: string[] = [], extraEnv: Record<string, string> = {}): Promise<Report> {
  const result = await usage(args, extraEnv);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Report;
}

const cacheFile = (): string => join(cacheDir, 'scan-cache.json');

/** The session titles a report carries, for spotting a planted value. */
function titles(seen: Report): (string | null)[] {
  return seen.projects.flatMap((project) => project.sessionReports.map((entry) => entry.title));
}

const warningCodes = (seen: Report): string[] => seen.warnings.map((warning) => warning.code);

/** Rewrite every cached session title to a sentinel; only a cache hit can see it. */
async function plantSentinel(): Promise<void> {
  const document = JSON.parse(await readFile(cacheFile(), 'utf8')) as {
    agents: Record<string, Record<string, { dataset: { projects: { sessions: { title: string | null }[] }[] } }>>;
  };
  for (const agent of Object.values(document.agents)) {
    for (const entry of Object.values(agent)) {
      for (const project of entry.dataset.projects) {
        for (const session of project.sessions) session.title = 'SENTINEL';
      }
    }
  }
  await writeFile(cacheFile(), JSON.stringify(document), 'utf8');
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-usages-cache-root-'));
  cacheDir = await mkdtemp(join(tmpdir(), 'agent-usages-cache-dir-'));
  configHome = await mkdtemp(join(tmpdir(), 'agent-usages-cache-home-'));
  const project = join(root, 'projects', '-tmp-demo');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'aaa.jsonl'), claudeLog('11111111-1111-4111-8111-111111111111', ['m1', 'm2']));
  await writeFile(join(project, 'bbb.jsonl'), claudeLog('22222222-2222-4222-8222-222222222222', ['m3']));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(cacheDir, { recursive: true, force: true });
  await rm(configHome, { recursive: true, force: true });
});

describe('the scan cache', () => {
  it('answers an unchanged root from the cache, and writes one on the first run', async () => {
    const cold = await report();
    expect(cold.totals.requests).toBe(3);
    await expect(stat(cacheFile())).resolves.toBeTruthy();

    await plantSentinel();
    const planted = await stat(cacheFile());
    const warm = await report();
    // The sentinel can only appear if the second run did not parse the logs.
    expect(titles(warm)).toEqual(['SENTINEL', 'SENTINEL']);
    expect(warm.totals.requests).toBe(cold.totals.requests);
    expect(warm.totals.cost.total).toBe(cold.totals.cost.total);
    // And a run that learned nothing writes nothing: the file is as it was left.
    const after = await stat(cacheFile());
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
    expect(warningCodes(after)).toContain('scanCacheSourceVanished');
  });

  it('measures the machine as it is now under --no-cache, and writes nothing', async () => {
    await rm(cacheDir, { recursive: true, force: true });
    const fresh = await report(['--no-cache']);
    expect(fresh.totals.requests).toBe(3);
    await expect(stat(cacheFile())).rejects.toThrow();

    // With no cache to fall back on, a vanished directory is simply gone.
    await rm(root, { recursive: true, force: true });
    const empty = await usage(['--no-cache']);
    expect(empty.code).toBe(1);
  });

  it('rebuilds a cache file that cannot be trusted, and reports it', async () => {
    await report();
    await writeFile(cacheFile(), 'not json {', 'utf8');
    const rebuilt = await report();
    expect(rebuilt.totals.requests).toBe(3);
    expect(warningCodes(rebuilt)).toContain('scanCacheRebuilt');
  });

  it('does not fail the run when the cache cannot be written', async () => {
    // `/nowhere` is not writable for a normal user: the run must still answer.
    const result = await usage(['--cache-dir', '/nowhere/agent-usages']);
    expect(result.code).toBe(0);
    const seen = JSON.parse(result.stdout) as Report;
    expect(seen.totals.requests).toBe(3);
    expect(warningCodes(seen)).toContain('scanCacheUnwritable');
  });

  it('uses the environment default when --cache-dir is absent', async () => {
    const cacheHome = await mkdtemp(join(tmpdir(), 'agent-usages-cache-xdg-'));
    try {
      const result = await runCli(
        ['--agent', 'claudecode', '--home', root, '--no-update', '--json'],
        { XDG_CACHE_HOME: cacheHome },
      );
      expect(result.code, result.stderr).toBe(0);
      const document = JSON.parse(await readFile(join(cacheHome, 'agent-usages', 'scan-cache.json'), 'utf8')) as {
        format: number;
        tool: string;
      };
      expect(document.format).toBe(1);
      expect(document.tool).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      await rm(cacheHome, { recursive: true, force: true });
    }
  });
});
