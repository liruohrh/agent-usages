/**
 * End-to-end CLI tests.
 *
 * These spawn the real process against a fixture data root and assert on what a
 * user or a script would actually see: JSON shape, text output, exit codes, and
 * how the two extension axes (`--agent`, `--provider`) are selected.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

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

/** Run the CLI with the fixture as the data root. */
async function cli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      // Pin the data root explicitly: the adapter prefers DSH_HOME over HOME,
      // and the ambient environment in a developer's shell usually has one.
      env: { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh'), ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-usages-cli-'));
  await mkdir(join(home, '.dsh', 'storages'), { recursive: true });
  await writeFile(
    join(home, '.dsh', 'storages', 'workspace.json'),
    JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [WORKSPACE_ID], archivedSessionIds: [] },
      tables: {
        workspaces: {
          [WORKSPACE_ID]: { path: CWD, title: 'demo', sessionIds: [SESSION_ID], createdAt: 'x', updatedAt: 'x' },
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
          [SESSION_ID]: {
            identity: { createdAt: OFF_PEAK, cwd: CWD },
            rows: { title: { ver: 1, seq: 1, val: '演示会话' } },
          },
        },
      },
    }),
  );
  // One request: 1M of each bucket at the off-peak current rates is 0.02 + 1 + 4.
  await writeFile(
    join(home, '.dsh', 'storages', 'all_usage_ledger_00.json'),
    JSON.stringify({
      unit: { name: 'all_usage_ledger_00', version: 0 },
      global: null,
      tables: {
        sessions: {
          [SESSION_ID]: {
            version: 3,
            sessionId: SESSION_ID,
            workspaceId: WORKSPACE_ID,
            sourceCwd: CWD,
            lastSeq: 5,
            source: 'flush',
            updatedAt: OFF_PEAK,
            usage: [
              {
                key: `${SESSION_ID}:step:1:1`,
                seq: 5,
                time: OFF_PEAK,
                workspaceId: WORKSPACE_ID,
                identity: {
                  identityKey: '["deepseek-official","deepseek-v4-flash","deepseek-v4-flash",null]',
                  requestedModel: 'deepseek-v4-flash',
                  actualModel: 'deepseek-v4-flash',
                  label: 'deepseek-official / deepseek-v4-flash',
                },
                modelId: 'deepseek-official / deepseek-v4-flash',
                turn: 1,
                step: 1,
                values: { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, reasoning: 0 },
              },
            ],
          },
        },
      },
    }),
  );
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('usage', () => {
  it('emits valid JSON that identifies its agent and pricing source', async () => {
    const { code, stdout, stderr } = await cli(['usage', '--json']);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      agent: string;
      source: string;
      pricingProvider: string;
      currency: string;
      totals: { requests: number; cost: Record<string, string> };
      costComponents: { id: string; tokens: number }[];
    };
    expect(parsed.agent).toBe('dsh');
    expect(parsed.pricingProvider).toBe('deepseek');
    expect(parsed.currency).toBe('CNY');
    expect(parsed.totals.requests).toBe(1);
    expect(parsed.totals.cost['total']).toBe('5.0200');
    // The component breakdown names its own basis, so a vendor's rate list is
    // visible in the output rather than implied.
    expect(parsed.costComponents.map((component) => component.id).sort()).toEqual(['input-hit', 'input-miss', 'output']);
  });

  it('reports the exact cost components that produced the total', async () => {
    const { stdout } = await cli(['usage', '--json']);
    const parsed = JSON.parse(stdout) as { totals: { cost: Record<string, string> } };
    const cost = parsed.totals.cost;
    expect(cost['cacheHitInputCost']).toBe('0.0200');
    expect(cost['cacheMissInputCost']).toBe('1.0000');
    expect(cost['outputCost']).toBe('4.0000');
    expect(cost['cacheWriteInputCost']).toBe('0.0000');
  });

  it('accepts a global --json before the command', async () => {
    const { stdout } = await cli(['--json', 'usage']);
    expect(() => JSON.parse(stdout) as unknown).not.toThrow();
  });

  it('honours the dimension flags', async () => {
    for (const [flag, expected] of [['--all', 'all'], ['--project', 'project'], ['--session', 'session']] as const) {
      const parsed = JSON.parse((await cli(['usage', flag, '--json'])).stdout) as { dimension: string };
      expect(parsed.dimension).toBe(expected);
    }
  });

  it('rejects two mutually exclusive dimension flags', async () => {
    const { code, stderr } = await cli(['usage', '--all', '--project']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/只能指定一个/);
  });

  it('filters by project and session, warning when nothing matches', async () => {
    const hit = JSON.parse((await cli(['usage', '--json', '-p', 'demo'])).stdout) as { totals: { requests: number } };
    expect(hit.totals.requests).toBe(1);
    const miss = JSON.parse((await cli(['usage', '--json', '-p', 'other'])).stdout) as {
      totals: { requests: number };
      warnings: string[];
    };
    expect(miss.totals.requests).toBe(0);
    expect(miss.warnings.join('\n')).toMatch(/没有项目匹配/);
  });

  it('scopes by time range', async () => {
    const inside = JSON.parse((await cli(['usage', '--json', '--from', '2026-09-01'])).stdout) as {
      totals: { requests: number };
    };
    expect(inside.totals.requests).toBe(1);
    const outside = JSON.parse((await cli(['usage', '--json', '--from', '2027-01-01'])).stdout) as {
      totals: { requests: number };
    };
    expect(outside.totals.requests).toBe(0);
  });

  it('rejects contradictory time-range inputs', async () => {
    const { code, stderr } = await cli(['usage', '--today', '--from', '2026-09-01']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/只能指定一次/);
  });

  it('multiplies by --currency-rate', async () => {
    const parsed = JSON.parse((await cli(['usage', '--json', '--currency', 'USD', '--currency-rate', '0.14'])).stdout) as {
      currency: string;
      currencyRate: number;
      totals: { cost: Record<string, string> };
    };
    expect(parsed.currency).toBe('USD');
    expect(parsed.currencyRate).toBe(0.14);
    expect(parsed.totals.cost['total']).toBe('0.7028');
  });

  it('rejects a non-numeric currency rate', async () => {
    const { code, stderr } = await cli(['usage', '--currency-rate', 'abc']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/汇率必须是非负数字/);
  });

  it('renders a text report by default, naming both axes', async () => {
    const { stdout } = await cli(['usage']);
    expect(stdout).toContain('Agent 用量统计');
    expect(stdout).toContain('DeepSeek Harness (DSH)');
    expect(stdout).toContain('DeepSeek 官方');
    expect(stdout).toContain('¥5.02');
    expect(stdout).toContain('费用明细');
  });

  it('accepts --subagents in either mode', async () => {
    for (const [args, split] of [[['usage', '--session', '--json'], false], [['usage', '--session', '--subagents', '--json'], true]] as const) {
      const parsed = JSON.parse((await cli([...args])).stdout) as { subagents: { split: boolean } };
      expect(parsed.subagents.split).toBe(split);
    }
  });

  it('exits 2 when the filter matches no usage', async () => {
    expect((await cli(['usage', '--from', '2027-01-01'])).code).toBe(2);
  });
});

describe('agent and provider selection', () => {
  it('auto-detects DSH from the default location', async () => {
    const parsed = JSON.parse((await cli(['usage', '--json'])).stdout) as { agent: string };
    expect(parsed.agent).toBe('dsh');
  });

  it('accepts an explicit --agent and --home', async () => {
    const parsed = JSON.parse((await cli(['usage', '--json', '--agent', 'dsh', '--home', join(home, '.dsh')], { HOME: '/nowhere' })).stdout) as {
      agent: string;
    };
    expect(parsed.agent).toBe('dsh');
  });

  it('rejects an unknown agent, listing what exists', async () => {
    const { code, stderr } = await cli(['usage', '--agent', 'nope']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/未知的 agent "nope"；当前支持：dsh/);
  });

  it('rejects an unknown pricing provider, listing what exists', async () => {
    const { code, stderr } = await cli(['usage', '--provider', 'nope']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/未知的计价来源 "nope"；当前支持：deepseek/);
  });

  it('accepts an explicit --provider', async () => {
    const parsed = JSON.parse((await cli(['usage', '--json', '--provider', 'deepseek'])).stdout) as {
      pricingProvider: string;
    };
    expect(parsed.pricingProvider).toBe('deepseek');
  });

  it('fails clearly when no agent matches the data root', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'agent-usages-none-'));
    const { code, stderr } = await cli(['usage', '--home', empty], { HOME: empty });
    expect(code).toBe(1);
    expect(stderr).toMatch(/没有找到可统计的用量数据/);
    await rm(empty, { recursive: true, force: true });
  });

  it('reports a missing data root without a stack trace', async () => {
    const { code, stderr } = await cli(['usage', '--home', join(home, 'missing')]);
    expect(code).toBe(1);
    expect(stderr).not.toContain('at Object.');
  });
});

describe('session list', () => {
  it('emits valid JSON with and without the global flag', async () => {
    for (const args of [['session', 'list', '--json'], ['--json', 'session', 'list']]) {
      const { code, stdout } = await cli(args);
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout) as {
        agent: string;
        totalProjects: number;
        totalSessions: number;
        projects: { name: string; sessionCount: number; sessions: { title: string }[] }[];
      };
      expect(parsed.agent).toBe('dsh');
      expect(parsed.totalProjects).toBe(1);
      expect(parsed.totalSessions).toBe(1);
      expect(parsed.projects[0]?.name).toBe('demo');
      expect(parsed.projects[0]?.sessionCount).toBe(1);
      expect(parsed.projects[0]?.sessions[0]?.title).toBe('演示会话');
    }
  });

  it('renders a text listing by default', async () => {
    const { stdout } = await cli(['session', 'list']);
    expect(stdout).toContain('Agent 会话列表');
    expect(stdout).toContain('demo');
    expect(stdout).toContain('演示会话');
  });
});

describe('price', () => {
  it('prints the schedule with its sources, without reading any data', async () => {
    const { code, stdout } = await cli(['price'], { HOME: '/nowhere' });
    expect(code).toBe(0);
    expect(stdout).toContain('DeepSeek 官方');
    expect(stdout).toContain('deepseek-flash');
    expect(stdout).toContain('0.02');
    expect(stdout).toContain('api-docs.deepseek.com');
  });

  it('lists every provider with --all', async () => {
    const { stdout } = await cli(['price', '--all']);
    expect(stdout).toContain('deepseek-v4-pro');
  });
});

describe('agents', () => {
  it('lists the supported agents and pricing sources', async () => {
    const { code, stdout } = await cli(['agents']);
    expect(code).toBe(0);
    expect(stdout).toContain('支持的 agent');
    expect(stdout).toContain('dsh');
    expect(stdout).toContain('DSH_HOME');
    expect(stdout).toContain('支持的计价来源');
    expect(stdout).toContain('deepseek');
  });

  it('emits the same inventory as JSON', async () => {
    const parsed = JSON.parse((await cli(['agents', '--json'])).stdout) as {
      agents: { id: string; envVars: string[]; notes: string[] }[];
      pricingProviders: { id: string; currency: { code: string }; models: { model: string }[] }[];
    };
    expect(parsed.agents[0]?.id).toBe('dsh');
    expect(parsed.agents[0]?.envVars).toEqual(['DSH_HOME']);
    expect(parsed.agents[0]?.notes.length).toBeGreaterThan(0);
    expect(parsed.pricingProviders[0]?.id).toBe('deepseek');
    expect(parsed.pricingProviders[0]?.currency.code).toBe('CNY');
    expect(parsed.pricingProviders[0]?.models.map((model) => model.model)).toContain('deepseek-flash');
  });
});

describe('help', () => {
  it('documents every command', async () => {
    const { code, stdout } = await cli(['--help']);
    expect(code).toBe(0);
    for (const command of ['usage', 'session', 'price', 'agents']) expect(stdout).toContain(command);
    expect(stdout).toContain('--agent');
    expect(stdout).toContain('--provider');
  });
});
