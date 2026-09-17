import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

/** One session, one request, so the fixture is trivial to reason about. */
const SESSION_ID = 'session-eeeeeeee-0000-4000-8000-00000000000e';
const WORKSPACE_ID = 'cccccccc-3333-4333-8333-333333333333';
const CWD = '/home/user/ws/demo';
/** 2026-09-11 20:00 CST (Friday) — off-peak in the current price period. */
const OFF_PEAK = Date.parse('2026-09-11T12:00:00Z');

/** Result of one CLI invocation. */
interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI with `DSH_HOME` pointed at the fixture. */
async function cli(args: string[], home: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, DSH_HOME: home },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-usage-cli-'));
  await mkdir(join(home, 'storages'), { recursive: true });
  await writeFile(
    join(home, 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [WORKSPACE_ID], archivedSessionIds: [] },
      tables: {
        workspaces: {
          [WORKSPACE_ID]: {
            path: CWD,
            title: 'demo',
            sessionIds: [SESSION_ID],
            createdAt: '2026-09-11T00:00:00.000Z',
            updatedAt: '2026-09-11T00:00:00.000Z',
          },
        },
      },
    }),
  );
  await writeFile(
    join(home, 'storages', 'session_projcache.json'),
    JSON.stringify({
      unit: { name: 'session_projcache', version: 3 },
      global: null,
      tables: {
        sessions: {
          [SESSION_ID]: {
            identity: { createdAt: OFF_PEAK, cwd: CWD },
            rows: { title: { ver: 1, seq: 1, val: '演示会话' } },
          },
        },
      },
    }),
  );
  // Local references keep the fixture readable; 1M of each bucket at the
  // off-peak current rates is exactly 0.02 + 1 + 4 = 5.02 CNY.
  const row = {
    key: `${SESSION_ID}:step:1:1`,
    seq: 5,
    time: OFF_PEAK,
    workspaceId: WORKSPACE_ID,
    identity: {
      identityKey: '["deepseek-official","deepseek-v4-flash","deepseek-v4-flash",null]',
      provider: 'deepseek-official',
      requestedModel: 'deepseek-v4-flash',
      actualModel: 'deepseek-v4-flash',
      label: 'deepseek-official / deepseek-v4-flash',
      legacy: false,
    },
    modelId: 'deepseek-official / deepseek-v4-flash',
    turn: 1,
    step: 1,
    values: { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, reasoning: 0 },
  };
  await writeFile(
    join(home, 'storages', 'all_usage_ledger_00.json'),
    JSON.stringify({
      unit: { name: 'all_usage_ledger_00', version: 0 },
      global: null,
      tables: {
        sessions: {
          __all_usage_ledger_meta__: { version: 1 },
          [SESSION_ID]: {
            version: 3,
            sessionId: SESSION_ID,
            workspaceId: WORKSPACE_ID,
            sourceCwd: CWD,
            lastSeq: 5,
            source: 'flush',
            updatedAt: OFF_PEAK,
            usage: [row],
          },
        },
      },
    }),
  );
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('dsh-usage usage', () => {
  it('emits valid JSON on --json', async () => {
    const { code, stdout, stderr } = await cli(['usage', '--json'], home);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      dimension: string;
      currency: string;
      totals: { requests: number; cost: Record<string, string> };
      projects: unknown[];
    };
    expect(parsed.dimension).toBe('all');
    expect(parsed.currency).toBe('CNY');
    expect(parsed.totals.requests).toBe(1);
    expect(parsed.totals.cost['total']).toBe('5.0200');
    expect(parsed.projects).toHaveLength(1);
  });

  it('accepts a global --json placed before the command', async () => {
    const { stdout } = await cli(['--json', 'usage'], home);
    expect(() => JSON.parse(stdout) as unknown).not.toThrow();
  });

  it('defaults to the all dimension', async () => {
    const { stdout } = await cli(['usage', '--json'], home);
    const parsed = JSON.parse(stdout) as { dimension: string };
    expect(parsed.dimension).toBe('all');
  });

  it('honours --project and --session', async () => {
    const project = JSON.parse((await cli(['usage', '--project', '--json'], home)).stdout) as { dimension: string };
    expect(project.dimension).toBe('project');
    const session = JSON.parse((await cli(['usage', '--session', '--json'], home)).stdout) as { dimension: string };
    expect(session.dimension).toBe('session');
  });

  it('rejects two mutually exclusive dimension flags', async () => {
    const { code, stderr } = await cli(['usage', '--all', '--project'], home);
    expect(code).toBe(1);
    expect(stderr).toMatch(/只能指定一个/);
  });

  it('filters by project selector', async () => {
    const hit = JSON.parse((await cli(['usage', '--json', '-p', 'demo'], home)).stdout) as {
      totals: { requests: number };
    };
    expect(hit.totals.requests).toBe(1);
    const miss = JSON.parse((await cli(['usage', '--json', '-p', 'other'], home)).stdout) as {
      totals: { requests: number };
      warnings: string[];
    };
    expect(miss.totals.requests).toBe(0);
    expect(miss.warnings.join('\n')).toMatch(/没有项目匹配/);
  });

  it('multiplies by --currency-rate', async () => {
    const { stdout } = await cli(['usage', '--json', '--currency', 'USD', '--currency-rate', '0.14'], home);
    const parsed = JSON.parse(stdout) as { currency: string; currencyRate: number; totals: { cost: Record<string, string> } };
    expect(parsed.currency).toBe('USD');
    expect(parsed.currencyRate).toBe(0.14);
    expect(parsed.totals.cost['total']).toBe('0.7028');
  });

  it('rejects a non-numeric currency rate', async () => {
    const { code, stderr } = await cli(['usage', '--currency-rate', 'abc'], home);
    expect(code).toBe(1);
    expect(stderr).toMatch(/汇率必须是非负数字/);
  });

  it('scopes by time range', async () => {
    const inside = JSON.parse((await cli(['usage', '--json', '--from', '2026-09-01'], home)).stdout) as {
      totals: { requests: number };
    };
    expect(inside.totals.requests).toBe(1);
    const outside = JSON.parse((await cli(['usage', '--json', '--from', '2027-01-01'], home)).stdout) as {
      totals: { requests: number };
    };
    expect(outside.totals.requests).toBe(0);
  });

  it('rejects contradictory time-range inputs', async () => {
    const { code, stderr } = await cli(['usage', '--today', '--from', '2026-09-01'], home);
    expect(code).toBe(1);
    expect(stderr).toMatch(/只能指定一次/);
  });

  it('renders a text report by default', async () => {
    const { stdout } = await cli(['usage'], home);
    expect(stdout).toContain('DSH Token 用量统计');
    expect(stdout).toContain('¥5.02');
    expect(stdout).toContain('空闲时段');
  });

  it('reports a missing home through the exit code, not a stack trace', async () => {
    const { code, stderr } = await cli(['usage'], join(home, 'does-not-exist'));
    expect(code).toBe(1);
    expect(stderr).toMatch(/DSH 数据目录不存在/);
    expect(stderr).not.toContain('at Object.');
  });

  it('exits 2 when the filter matches no usage', async () => {
    const { code } = await cli(['usage', '--from', '2027-01-01'], home);
    expect(code).toBe(2);
  });
});

describe('dsh-usage subagent option', () => {
  it('accepts --subagents and reports the scope in both modes', async () => {
    const folded = JSON.parse((await cli(['usage', '--session', '--json'], home)).stdout) as {
      subagents: { split: boolean; rows: number };
    };
    expect(folded.subagents.split).toBe(false);
    const split = JSON.parse((await cli(['usage', '--session', '--subagents', '--json'], home)).stdout) as {
      subagents: { split: boolean; rows: number };
    };
    expect(split.subagents.split).toBe(true);
    // This fixture has no session logs, so nothing is known to be a subagent.
    expect(folded.subagents.rows).toBe(0);
    expect(split.subagents.rows).toBe(0);
  });

  it('accepts --subagents on session list', async () => {
    const result = JSON.parse((await cli(['session', 'list', '--subagents', '--json'], home)).stdout) as {
      projects: { sessions: { subagentCount: number; nested: boolean }[] }[];
    };
    expect(result.projects[0]?.sessions[0]?.subagentCount).toBe(0);
    expect(result.projects[0]?.sessions[0]?.nested).toBe(false);
  });
});

describe('dsh-usage session list', () => {
  it('emits valid JSON with and without the global flag', async () => {
    for (const args of [['session', 'list', '--json'], ['--json', 'session', 'list']]) {
      const { code, stdout } = await cli(args, home);
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout) as {
        totalProjects: number;
        totalSessions: number;
        projects: { name: string; sessions: { title: string }[] }[];
      };
      expect(parsed.totalProjects).toBe(1);
      expect(parsed.totalSessions).toBe(1);
      expect(parsed.projects[0]?.name).toBe('demo');
      expect(parsed.projects[0]?.sessions[0]?.title).toBe('演示会话');
    }
  });

  it('renders a text listing by default', async () => {
    const { stdout } = await cli(['session', 'list'], home);
    expect(stdout).toContain('DSH 会话列表');
    expect(stdout).toContain('demo');
    expect(stdout).toContain('演示会话');
  });
});

describe('dsh-usage --home', () => {
  it('is accepted before the command and on the subcommand', async () => {
    for (const args of [
      ['--home', home, 'usage', '--json'],
      ['usage', '--json', '--home', home],
      ['--home', home, 'session', 'list', '--json'],
      ['session', 'list', '--json', '--home', home],
    ]) {
      const { code, stderr } = await cli(args, '/nonexistent-env-home');
      expect(stderr).toBe('');
      expect(code).toBe(0);
    }
  });

  it('overrides DSH_HOME from the environment', async () => {
    // The helper always sets DSH_HOME; an explicit --home to a missing directory
    // must win and fail loudly rather than silently read the environment's home.
    const { code, stderr } = await cli(['usage', '--home', join(home, 'missing')], home);
    expect(code).toBe(1);
    expect(stderr).toMatch(/DSH 数据目录不存在/);
  });
});

describe('dsh-usage price', () => {
  it('prints the schedule with its sources', async () => {
    const { code, stdout } = await cli(['price'], home);
    expect(code).toBe(0);
    expect(stdout).toContain('deepseek-flash');
    expect(stdout).toContain('0.02');
    expect(stdout).toContain('api-docs.deepseek.com');
  });
});

describe('dsh-usage help', () => {
  it('documents the commands', async () => {
    const { code, stdout } = await cli(['--help'], home);
    expect(code).toBe(0);
    expect(stdout).toMatch(/usage/);
    expect(stdout).toMatch(/session/);
    expect(stdout).toMatch(/price/);
  });
});
