/**
 * End-to-end tests for the multi-agent default.
 *
 * A fixture home holds two agents' data for the *same* directory, which is the
 * case the merge layer exists for: `--agent all` has to read both without
 * needing a flag, report one project, and say which agent produced which row.
 * The DSH and Claude Code file layouts are the smallest ones their adapters
 * accept, copied from the per-adapter test suites.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

const CWD = '/home/user/ws/shared';
const DSH_SESSION = 'session-aaaaaaaa-0000-4000-8000-00000000000a';
const WORKSPACE_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const CLAUDE_SESSION = '112307e5-1035-404c-8fea-b6650edc8080';
/** 2026-09-11 20:00 CST (Friday) — off-peak in the current price period. */
const OFF_PEAK = Date.parse('2026-09-11T12:00:00Z');

/** Result of one CLI invocation. */
interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

let home: string;
let configHome: string;

/** Run the CLI against the two-agent fixture home. */
async function cli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        LANG: 'zh_CN.UTF-8',
        HOME: home,
        DSH_HOME: join(home, '.dsh'),
        XDG_CONFIG_HOME: configHome,
        ...env,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-usages-cli-agents-'));
  configHome = await mkdtemp(join(tmpdir(), 'agent-usages-cli-agents-config-'));

  // DSH: a workspace registry, a projection cache, and one session log whose
  // log holds the billed request.
  await mkdir(join(home, '.dsh', 'storages'), { recursive: true });
  await writeFile(
    join(home, '.dsh', 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [WORKSPACE_ID], archivedSessionIds: [] },
      tables: {
        workspaces: {
          [WORKSPACE_ID]: { path: CWD, title: 'demo', sessionIds: [DSH_SESSION], createdAt: 'x', updatedAt: 'x' },
        },
      },
    }),
  );
  await writeFile(
    join(home, '.dsh', 'storages', 'session_projcache.json'),
    JSON.stringify({
      unit: { name: 'session_projcache', version: 3 },
      global: null,
      tables: {
        sessions: {
          [DSH_SESSION]: {
            identity: { createdAt: OFF_PEAK, cwd: CWD },
            rows: { title: { ver: 1, seq: 1, val: 'DSH 会话' } },
          },
        },
      },
    }),
  );
  const projectKey = `--${CWD.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '')}--`;
  await mkdir(join(home, '.dsh', 'sessions', projectKey, DSH_SESSION), { recursive: true });
  await writeFile(
    join(home, '.dsh', 'sessions', projectKey, DSH_SESSION, 'session.jsonl'),
    `${[
      JSON.stringify({ type: 'session', version: 0, id: DSH_SESSION, createdAt: OFF_PEAK, cwd: CWD, delegationDepth: 0 }),
      JSON.stringify({ type: 'session/title', seq: 2, time: OFF_PEAK, data: { title: 'DSH 会话' } }),
      JSON.stringify({
        type: 'assistant/message',
        seq: 5,
        time: OFF_PEAK,
        data: {
          turn: 1,
          step: 1,
          message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
          usage: {
            inputTokens: 1_000_000,
            outputTokens: 1_000_000,
            cacheReadTokens: 1_000_000,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        },
      }),
    ].join('\n')}\n`,
  );

  // Claude Code: one session log under its escaped-cwd project directory.
  const claudeProject = join(home, '.claude', 'projects', '-home-user-ws-shared');
  await mkdir(claudeProject, { recursive: true });
  await writeFile(
    join(claudeProject, `${CLAUDE_SESSION}.jsonl`),
    `${[
      JSON.stringify({ type: 'user', uuid: 'u1', sessionId: CLAUDE_SESSION, timestamp: '2026-09-11T11:59:59.000Z', cwd: CWD }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: null,
        sessionId: CLAUDE_SESSION,
        timestamp: '2026-09-11T12:00:01.000Z',
        cwd: CWD,
        version: '2.1.278',
        message: {
          id: 'msg-a1',
          model: 'deepseek-v4-flash',
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      }),
    ].join('\n')}\n`,
  );
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(configHome, { recursive: true, force: true });
});

/** The JSON one `usage` run printed. */
async function usageJson(args: string[] = [], env: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const { code, stdout, stderr } = await cli(['usage', '--json', '--no-update', ...args], env);
  expect(stderr).toBe('');
  expect(code).toBe(0);
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe('--agent all', () => {
  it('reads every agent that has data, without being asked', async () => {
    const parsed = (await usageJson()) as {
      agent: string;
      agents: { agent: string; requests: number; cost: { total: string } }[];
      projects: { name: string; agents: string[]; workspaces: string[]; sessions: number; subagentSessions: number }[];
    };
    expect(parsed.agents.map((row) => row.agent)).toEqual(['claude', 'dsh']);
    expect(parsed.agent).toBe('dsh+claude');
    // One directory, read by two agents, is one project.
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0]?.name).toBe('shared');
    expect(parsed.projects[0]?.agents).toEqual(['claude', 'dsh']);
    expect(parsed.projects[0]?.workspaces).toEqual([CWD]);
    expect(parsed.projects[0]?.sessions).toBe(2);
    expect(parsed.projects[0]?.subagentSessions).toBe(0);
  });

  it('keeps Σ agentTotals equal to the grand total', async () => {
    const parsed = (await usageJson()) as {
      agents: { agent: string; requests: number; tokens: { input: number; output: number }; cost: { total: string } }[];
      totals: { requests: number; tokens: { input: number; output: number }; cost: { total: string } };
      projects: { agentTotals: { cost: { total: string }; requests: number }[]; requests: number }[];
    };
    const requests = parsed.agents.reduce((total, row) => total + row.requests, 0);
    const input = parsed.agents.reduce((total, row) => total + row.tokens.input, 0);
    const cost = parsed.agents.reduce((total, row) => total + Number(row.cost.total), 0);
    expect(requests).toBe(parsed.totals.requests);
    expect(input).toBe(parsed.totals.tokens.input);
    expect(cost.toFixed(4)).toBe(parsed.totals.cost.total);
    // The per-project rows are the same partition, one level down.
    for (const project of parsed.projects) {
      expect(project.agentTotals.reduce((total, row) => total + row.requests, 0)).toBe(project.requests);
    }
    // Each agent's own bill is its own: DSH also read a cache-hit request, so
    // its request costs 0.02 more than Claude Code's.
    expect(parsed.agents.map((row) => `${row.agent}:${row.cost.total}`)).toEqual(['claude:5.0000', 'dsh:5.0200']);
  });

  it('names the agents it read, and marks every row, in the text report', async () => {
    const { code, stdout } = await cli(['usage', '--no-update']);
    expect(code).toBe(0);
    expect(stdout).toContain('claude·dsh');
    expect(stdout).toContain('2 会话');
    expect(stdout).toContain('· dsh');
    expect(stdout).toContain('· claude');
    // One metric line per agent, then the node's own total.
    expect(stdout).toMatch(/\n\s+claude {2}I\/M/);
    expect(stdout).toMatch(/\n\s+总 {2}I\/M/);
  });

  it('still reads just one agent when only one is installed', async () => {
    // DSH_HOME points at a directory with no data: the other agent is absent,
    // which `--agent all` must treat as "contributes nothing".
    const parsed = (await usageJson([], { DSH_HOME: join(home, 'nowhere') })) as {
      agent: string;
      agents: { agent: string }[];
      projects: { agents: string[] }[];
    };
    expect(parsed.agents.map((row) => row.agent)).toEqual(['claude']);
    expect(parsed.agent).toBe('claude');
    expect(parsed.projects[0]?.agents).toEqual(['claude']);
    const { stdout } = await cli(['usage', '--no-update'], { DSH_HOME: join(home, 'nowhere') });
    // A single-agent report keeps its unmarked rendering.
    expect(stdout).not.toContain('· claude');
  });

  it('accepts a comma-separated list and repeated flags alike', async () => {
    const comma = (await usageJson(['--agent', 'dsh,claude'])) as { agents: { agent: string }[] };
    const repeated = (await usageJson(['--agent', 'dsh', '--agent', 'claude'])) as { agents: { agent: string }[] };
    expect(comma.agents.map((row) => row.agent)).toEqual(['claude', 'dsh']);
    expect(repeated.agents).toEqual(comma.agents);
  });

  it('rejects an unknown id inside a list, naming it', async () => {
    const { code, stderr } = await cli(['usage', '--agent', 'dsh,nope', '--no-update']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/未知的 agent "nope"/);
  });

  it('fails when an explicitly named agent has no data', async () => {
    const { code, stderr } = await cli(['usage', '--agent', 'pi', '--no-update']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/没有找到|pi/);
  });

  it('marks the agent on every session row of the inventory', async () => {
    const { code, stdout } = await cli(['session', 'list', '--json', '--no-update']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      agents: string[];
      projects: { sessions: { id: string; agent: string }[] }[];
    };
    expect(parsed.agents).toEqual(['claude', 'dsh']);
    const rows = parsed.projects.flatMap((project) => project.sessions);
    expect(rows.map((row) => row.agent).sort()).toEqual(['claude', 'dsh']);
  });
});

describe('--html to stdout', () => {
  it('writes the document to stdout when no path is given', async () => {
    const { code, stdout, stderr } = await cli(['usage', '--html', '--no-update']);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout.startsWith('<!doctype html>')).toBe(true);
    expect(stdout).toContain('</html>');
    // The text report's aligned header is not printed beside it.
    expect(stdout).not.toContain('数据目录  ');
  });

  it('treats `-` as stdout too', async () => {
    const { code, stdout } = await cli(['usage', '--html', '-', '--agent', 'dsh', '--no-update']);
    expect(code).toBe(0);
    expect(stdout.startsWith('<!doctype html>')).toBe(true);
    expect(stdout).toContain('DSH 会话');
  });

  it('keeps stdout parseable when --json asks for it as well', async () => {
    const { code, stdout, stderr } = await cli(['usage', '--html', '-', '--json', '--no-update']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ totals: { requests: 2 } });
    expect(stderr).toContain('HTML 已跳过');
  });

  it('still writes a file when a path is given', async () => {
    const file = join(home, 'report.html');
    const { code, stdout } = await cli(['usage', '--html', file, '--no-update']);
    expect(code).toBe(0);
    expect(stdout).toContain(`已写入 ${file}`);
    expect((await readFile(file, 'utf8')).startsWith('<!doctype html>')).toBe(true);
  });
});

describe('configured projects', () => {
  /** Write the user's configuration, and read it back afterwards. */
  async function withProjects(document: unknown): Promise<string> {
    await mkdir(join(configHome, 'agent-usages'), { recursive: true });
    const path = join(configHome, 'agent-usages', 'config.json');
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    return path;
  }

  it('names a project from the configuration and filters by that name', async () => {
    const path = await withProjects({ version: 1, projects: [{ name: '共享工程', paths: [CWD] }] });
    const before = await readFile(path, 'utf8');

    const parsed = (await usageJson()) as { projects: { name: string; id: string; workspaces: string[] }[] };
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0]?.name).toBe('共享工程');
    expect(parsed.projects[0]?.id).toBe('project:共享工程');
    expect(parsed.projects[0]?.workspaces).toEqual([CWD]);

    const filtered = (await usageJson(['-p', '共享工程'])) as { totals: { requests: number } };
    expect(filtered.totals.requests).toBe(2);
    // A filter that matches nothing is a warning plus exit 2, not a failure.
    const missed = await cli(['usage', '--json', '--no-update', '-p', '没有这个项目']);
    expect(missed.code).toBe(2);
    const warnings = (JSON.parse(missed.stdout) as { warnings: { code: string }[] }).warnings;
    expect(warnings.map((warning) => warning.code)).toContain('noProjectMatch');

    // Auto-merging happens at run time and is never written back.
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('reports a malformed projects section instead of ignoring it silently', async () => {
    await withProjects({ version: 1, projects: [{ name: 'x', paths: 'not-a-list' }] });
    const parsed = (await usageJson()) as { warnings: { code: string; message: string }[] };
    const warning = parsed.warnings.find((entry) => entry.code === 'configIgnored');
    expect(warning?.message).toMatch(/projects\[0\]\.paths/);
    await rm(join(configHome, 'agent-usages'), { recursive: true, force: true });
  });
});
