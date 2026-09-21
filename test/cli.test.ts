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

/** Display width of a line, counting wide characters as two cells. */
function cells(text: string): number {
  return [...text].reduce((total, character) => total + ((character.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1), 0);
}

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
  // The harness records it in the session log, which is the adapter's only
  // per-request source.
  const projectKey = `--${CWD.replace(/^\/+/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '')}--`;
  await mkdir(join(home, '.dsh', 'sessions', projectKey, SESSION_ID), { recursive: true });
  await writeFile(
    join(home, '.dsh', 'sessions', projectKey, SESSION_ID, 'session.jsonl'),
    `${[
      JSON.stringify({ type: 'session', version: 0, id: SESSION_ID, createdAt: OFF_PEAK, cwd: CWD, delegationDepth: 0 }),
      JSON.stringify({ type: 'session/title', seq: 2, time: OFF_PEAK, data: { title: '演示会话' } }),
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
      pricingBands: { model: string; components: { id: string; tokens: number }[] }[];
    };
    expect(parsed.agent).toBe('dsh');
    expect(parsed.pricingProvider).toBe('deepseek');
    expect(parsed.currency).toBe('CNY');
    expect(parsed.totals.requests).toBe(1);
    expect(parsed.totals.cost['total']).toBe('5.0200');
    // Each band carries the rate card that produced it, so a vendor's rate list
    // is visible in the output rather than implied — and it names its model.
    expect(parsed.pricingBands).toHaveLength(1);
    expect(parsed.pricingBands[0]?.model).toBe('deepseek-flash');
    expect(parsed.pricingBands[0]?.components.map((component) => component.id).sort()).toEqual([
      'input-hit',
      'input-miss',
      'output',
    ]);
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

  it('retires the old dimension flags', async () => {
    // The tree always shows projects and their sessions, so the three
    // mutually exclusive flags are gone rather than silently ignored.
    for (const flag of ['--all', '--project', '--session']) {
      const { code, stderr } = await cli(['usage', flag]);
      expect(code, flag).toBe(1);
      expect(stderr, flag).toMatch(/unknown option/);
    }
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

  it('filters by session title, trimming whitespace', async () => {
    for (const selector of ['演示会话', '  演示会话  ']) {
      const parsed = JSON.parse((await cli(['usage', '--json', '-s', selector])).stdout) as {
        totals: { requests: number };
      };
      expect(parsed.totals.requests).toBe(1);
    }
  });

  it('keeps a title match exact', async () => {
    const parsed = JSON.parse((await cli(['usage', '--json', '-s', '演示'])).stdout) as {
      totals: { requests: number };
      warnings: string[];
    };
    expect(parsed.totals.requests).toBe(0);
    expect(parsed.warnings.join('\n')).toMatch(/找不到会话 "演示"/);
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

  it('renders the project/session tree by default, naming both axes', async () => {
    const { stdout } = await cli(['usage']);
    expect(stdout).toContain('Agent 用量统计');
    expect(stdout).toContain('DeepSeek Harness (DSH)');
    expect(stdout).toContain('DeepSeek 官方');
    expect(stdout).toContain('演示会话');
    // The fixture is one project with one session, so both aggregate levels
    // collapse and a single metric line remains.
    expect(stdout).toContain('I/M 1.00M');
    expect(stdout).toContain('I/C 1.00M / 50.0%');
    expect(stdout).toContain('I/T 2.00M');
    expect(stdout).toContain('R 0 ');
    expect(stdout).toContain('Q 1 · ¥5.02');
    expect(stdout.match(/ · Q /g)).toHaveLength(1);
  });

  it('distinguishes the three subagent modes', async () => {
    const cases = [
      [['usage', '--json'], 'total', false],
      [['usage', '--subagent', '--json'], 'subagents', true],
      [['usage', '--subagents', '--json'], 'detail', true],
    ] as const;
    for (const [args, mode, hasBreakdown] of cases) {
      const parsed = JSON.parse((await cli([...args])).stdout) as {
        subagentMode: string;
        scopeBreakdown?: { own: { requests: number }; subagents: { requests: number }; total: { requests: number } };
      };
      expect(parsed.subagentMode).toBe(mode);
      expect(parsed.scopeBreakdown !== undefined).toBe(hasBreakdown);
      if (hasBreakdown) {
        // own + subagents must equal total.
        expect(parsed.scopeBreakdown!.own.requests + parsed.scopeBreakdown!.subagents.requests).toBe(
          parsed.scopeBreakdown!.total.requests,
        );
      }
    }
  });

  it('lists every subagent row only in detail mode', async () => {
    const rows = async (args: string[]): Promise<number> => {
      const parsed = JSON.parse((await cli(args)).stdout) as {
        projects: { sessionReports?: { isSubagent: boolean }[] }[];
      };
      return (parsed.projects[0]?.sessionReports ?? []).filter((row) => row.isSubagent).length;
    };
    // The fixture has no subagents, so no mode invents a row for one.
    expect(await rows(['usage', '--json'])).toBe(0);
    expect(await rows(['usage', '--subagent', '--json'])).toBe(0);
    expect(await rows(['usage', '--subagents', '--json'])).toBe(0);
  });

  it('adds the cost tables only with --cost, and windows only with --windows', async () => {
    const plain = (await cli(['usage'])).stdout;
    expect(plain).not.toContain('计价区间');
    expect(plain).not.toContain('时间窗口');
    expect((await cli(['usage', '--cost'])).stdout).toContain('计价区间:');
    const windows = (await cli(['usage', '--windows'])).stdout;
    expect(windows).toContain('时间窗口  总 / 今日 / 本周 / 本月 / 今年');
    for (const label of ['总', '今日', '本周', '本月', '今年']) expect(windows).toMatch(new RegExp(`\\n${label}( · |\\n)`));
  });

  it('exits 2 when the filter matches no usage', async () => {
    expect((await cli(['usage', '--from', '2027-01-01'])).code).toBe(2);
  });
});

describe('text output alignment', () => {
  /** The value column of each aligned block, in terminal cells. */
  function columnsOf(lines: readonly string[]): number[] {
    const cells = (text: string): number =>
      [...text].reduce((total, character) => total + ((character.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1), 0);
    return lines.map((line) => {
      const match = /^(\S.*?)(\s{2,})(\S.*)$/.exec(line);
      return match === null ? -1 : cells(`${match[1]}${match[2]}`);
    });
  }

  it('lines the header values up in one column', async () => {
    const { stdout } = await cli(['usage']);
    const lines = stdout.split('\n');
    const valueColumn = (line: string): number => {
      const match = /^(\S.*?)(\s{2,})(\S.*)$/.exec(line);
      return match === null ? -1 : cells(`${match[1]}${match[2]}`);
    };
    // The header block: every field's value starts in the same column.
    const header = lines.filter((line) => /^(Agent|数据目录|时间范围|计价来源)\s{2,}\S/.test(line));
    expect(header).toHaveLength(4);
    expect(new Set(header.map(valueColumn)).size).toBe(1);
  });

  it('prints the same compact label set on every node', async () => {
    const { stdout } = await cli(['usage', '--cost', '--models']);
    const metrics = stdout.split('\n').filter((line) => line.includes(' · Q '));
    expect(metrics.length).toBeGreaterThan(0);
    for (const line of metrics) {
      const labels = line.trim().split(' · ').map((segment) => segment.split(' ')[0] ?? '');
      expect(labels.slice(0, 8)).toEqual(['I/M', 'I/C', 'I/T', 'O', 'R', 'O/T', 'T', 'Q']);
      expect(labels[8]?.startsWith('¥')).toBe(true);
    }
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

  it('filters by session title', async () => {
    const parsed = JSON.parse((await cli(['session', 'list', '--json', '-s', '演示会话'])).stdout) as {
      totalSessions: number;
    };
    expect(parsed.totalSessions).toBe(1);
  });

  it('documents title search in its help', async () => {
    const { stdout } = await cli(['usage', '--help']);
    expect(stdout).toContain('标题');
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
