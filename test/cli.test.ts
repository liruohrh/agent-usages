/**
 * End-to-end CLI tests.
 *
 * These spawn the real process against a fixture data root and assert on what a
 * user or a script would actually see: JSON shape, text output, exit codes, and
 * how the two extension axes (`--agent`, `--provider`) are selected.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { formatDecimal, parseDecimal, sumAmounts } from '../src/core/money.ts';

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
      // The default display currency follows the locale, so tests pin one:
      // zh-CN keeps the fixture's own currency and leaves the numbers alone.
      env: { ...process.env, LANG: 'zh_CN.UTF-8', HOME: home, DSH_HOME: join(home, '.dsh'), ...env },
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
    // Named as the request named it — the price schedule it matched (and any
    // fallback) stays visible through `resolution`.
    expect(parsed.pricingBands[0]?.model).toBe('deepseek-v4-flash');
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
      warnings: { code: string; message: string }[];
    };
    expect(miss.totals.requests).toBe(0);
    expect(miss.warnings.map((warning) => warning.message).join('\n')).toMatch(/没有项目匹配/);
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
      warnings: { code: string; message: string }[];
    };
    expect(parsed.totals.requests).toBe(0);
    expect(parsed.warnings.map((warning) => warning.message).join('\n')).toMatch(/找不到会话 "演示"/);
  });

  it('scopes by time range', async () => {
    const inside = JSON.parse((await cli(['usage', '--json', '--range', '2026-09-01..'])).stdout) as {
      totals: { requests: number };
    };
    expect(inside.totals.requests).toBe(1);
    const outside = JSON.parse((await cli(['usage', '--json', '--range', '2027-01-01..'])).stdout) as {
      totals: { requests: number };
    };
    expect(outside.totals.requests).toBe(0);
  });

  it('takes the end of a range literally, excluding that instant', async () => {
    // The fixture's only request is at 2026-09-11T12:00:00Z. A range ending at
    // that instant excludes it; one ending a second later includes it. No end
    // date is quietly widened to the whole day.
    const requests = async (spec: string): Promise<number> =>
      (JSON.parse((await cli(['usage', '--json', '--range', spec])).stdout) as { totals: { requests: number } }).totals
        .requests;
    expect(await requests('2026-09-11T12:00:00Z..')).toBe(1);
    expect(await requests('..2026-09-11T12:00:00Z')).toBe(0);
    expect(await requests('..2026-09-11T12:00:01Z')).toBe(1);
  });

  it('rejects an unreadable range instead of guessing', async () => {
    const { code, stderr } = await cli(['usage', '--range', 'last-week']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/无法识别的时间/);
  });

  it('retires the flags --range replaced', async () => {
    const { code, stderr } = await cli(['usage', '--today']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown option/);
  });

  it('converts at --currency-rate and names the currency', async () => {
    const parsed = JSON.parse((await cli(['usage', '--json', '--currency', 'USD', '--currency-rate', '0.14'])).stdout) as {
      currency: string;
      currencyRate: number;
      rateInfo: { source: string; base: string; display: string };
      totals: { cost: Record<string, string> };
    };
    expect(parsed.currency).toBe('USD');
    expect(parsed.currencyRate).toBe(0.14);
    expect(parsed.rateInfo).toMatchObject({ source: '手工指定', base: 'CNY', display: 'USD' });
    expect(parsed.totals.cost['total']).toBe('0.7028');
  });

  it('rejects a rate that is not a positive decimal', async () => {
    for (const bad of ['abc', '0', '-1']) {
      const { code, stderr } = await cli(['usage', '--currency-rate', bad]);
      expect(code).toBe(1);
      expect(stderr).toMatch(/汇率必须是正的十进制数/);
    }
  });

  it('follows the locale for its default currency', async () => {
    // Each locale picks the list DeepSeek publishes for it, so both are exact as
    // published: no conversion, no rate, only different numbers.
    const zh = JSON.parse((await cli(['usage', '--json'])).stdout) as {
      currency: string;
      currencyRate: number;
      rateInfo: { base: string; source: string };
      totals: { cost: Record<string, string> };
    };
    expect(zh.currency).toBe('CNY');
    expect(zh.currencyRate).toBe(1);
    expect(zh.rateInfo.base).toBe('CNY');
    expect(zh.totals.cost['total']).toBe('5.0200');

    const en = JSON.parse((await cli(['usage', '--json'], { LANG: 'en_US.UTF-8' })).stdout) as {
      currency: string;
      currencyRate: number;
      rateInfo: { base: string };
      totals: { cost: Record<string, string> };
    };
    expect(en.currency).toBe('USD');
    expect(en.currencyRate).toBe(1);
    expect(en.rateInfo.base).toBe('USD');
    // The fixture's request is 1M miss + 1M hit + 1M output; DeepSeek's dollar
    // list prices that at 0.15 + 0.003 + 0.6 = 0.753.
    expect(Number(en.totals.cost['total'])).toBeCloseTo(0.753, 4);
  });

  it('converts when the wanted currency is not published', async () => {
    const eur = JSON.parse((await cli(['usage', '--json', '--currency', 'EUR'])).stdout) as {
      currency: string;
      currencyRate: number;
      rateInfo: { base: string; source: string };
      totals: { cost: Record<string, string> };
    };
    expect(eur.currency).toBe('EUR');
    expect(eur.rateInfo.base).toBe('CNY');
    expect(eur.currencyRate).toBeGreaterThan(0);
    expect(Number(eur.totals.cost['total'])).toBeLessThan(5.02);
  });

  it('converts without naming a currency when only a rate is given', async () => {
    const { stdout } = await cli(['usage', '--currency-rate', '0.5']);
    expect(stdout).toMatch(/未指定目标货币/);
    expect(stdout).not.toMatch(/\$|¥[0-9]/u);
  });

  it('renders the project/session tree by default, naming both axes', async () => {
    const { stdout } = await cli(['usage']);
    expect(stdout).toContain('Agent 用量统计');
    expect(stdout).toContain('DeepSeek Harness (DSH)');
    expect(stdout).toContain('DeepSeek');
    expect(stdout).toContain('演示会话');
    // The fixture is one project with one session, so both aggregate levels
    // collapse and a single metric line remains.
    expect(stdout).toContain('I/M 1.00M');
    expect(stdout).toContain('I/C 1.00M / 50.0%');
    expect(stdout).toContain('I/T 2.00M');
    // The fixture never reasons, so `R` is left out rather than printed as 0 —
    // the same rule `I/W` follows.
    expect(stdout).not.toContain(' · R ');
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

  it('adds the pricing bands only with --cost', async () => {
    const plain = (await cli(['usage'])).stdout;
    expect(plain).not.toContain('计价区间');
    expect(plain).not.toContain('时间窗口');
    expect((await cli(['usage', '--cost'])).stdout).toContain('计价区间:');
  });

  it('exits 2 when the filter matches no usage', async () => {
    expect((await cli(['usage', '--range', '2027-01-01..'])).code).toBe(2);
  });

  it('writes a self-contained HTML report with --html', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-usages-html-'));
    const file = join(dir, 'report.html');
    try {
      const { code, stdout, stderr } = await cli(['usage', '--html', file, '--no-update']);
      expect(code).toBe(0);
      expect(stderr).toBe('');
      const document = await readFile(file, 'utf8');
      expect(document.startsWith('<!doctype html>')).toBe(true);
      expect(document).toContain('demo');
      expect(document).toContain('演示会话');
      expect(document).toContain('¥5.02');
      expect(document).not.toContain('<script');
      // The file replaces the text report: stdout only says where it went.
      expect(stdout).toContain(`已写入 ${file}`);
      expect(stdout).not.toContain('I/M 1.00M');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps --json on stdout when it also writes HTML', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-usages-html-json-'));
    const file = join(dir, 'report.html');
    try {
      const { code, stdout, stderr } = await cli(['usage', '--json', '--html', file, '--no-update']);
      expect(code).toBe(0);
      // The notice goes to stderr, so a script's stdout stays parseable.
      expect(JSON.parse(stdout)).toMatchObject({ totals: { requests: 1 } });
      expect(stderr).toContain(`已写入 ${file}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still exits 2 when the written report has no usage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-usages-html-empty-'));
    const file = join(dir, 'report.html');
    try {
      const { code } = await cli(['usage', '--html', file, '--range', '2027-01-01..', '--no-update']);
      expect(code).toBe(2);
      expect((await readFile(file, 'utf8')).startsWith('<!doctype html>')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails clearly when the HTML file cannot be written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-usages-html-gone-'));
    await rm(dir, { recursive: true, force: true });
    const { code, stderr } = await cli(['usage', '--html', join(dir, 'report.html'), '--no-update']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/无法写入/);
    expect(stderr).toContain('report.html');
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
    // Model rows are the node's line split up, and carry the model name first;
    // every other line is a node's own metric line.
    const metrics = stdout
      .split('\n')
      .filter((line) => line.includes(' · Q ') && !line.trim().startsWith('['));
    expect(metrics.length).toBeGreaterThan(0);
    for (const line of metrics) {
      const labels = line.trim().split(' · ').map((segment) => segment.split(' ')[0] ?? '');
      // `I/W` and `R` are conditional, so the fixture (no cache writes, no
      // reasoning) shows the seven always-on labels plus the money.
      expect(labels.slice(0, 7)).toEqual(['I/M', 'I/C', 'I/T', 'O', 'O/T', 'T', 'Q']);
      expect(labels[7]?.startsWith('¥')).toBe(true);
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

  it('marks an archived session without dropping it from the numbers', async () => {
    // DSH's archive list lives in `workspace.json`; archiving is the harness
    // hiding a row, not the user unspending the tokens.
    const workspacePath = join(home, '.dsh', 'storages', 'workspace.json');
    const original = await readFile(workspacePath, 'utf8');
    const parsed = JSON.parse(original) as { global: { archivedSessionIds: string[] } };
    parsed.global.archivedSessionIds = [SESSION_ID];
    await writeFile(workspacePath, JSON.stringify(parsed));
    try {
      expect((await cli(['session', 'list'])).stdout).toContain('演示会话（已归档）');

      const json = JSON.parse((await cli(['session', 'list', '--json'])).stdout) as {
        projects: { sessions: { id: string; archived: boolean }[] }[];
      };
      const row = json.projects.flatMap((project) => project.sessions).find((session) => session.id === SESSION_ID);
      expect(row?.archived).toBe(true);

      // The report labels the session and still bills its one request.
      const usage = await cli(['usage']);
      expect(usage.stdout).toContain('演示会话（已归档）');
      expect(usage.stdout).toContain('Q 1 · ¥5.02');
    } finally {
      await writeFile(workspacePath, original);
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

describe('git repositories', () => {
  it('reports a worktree and its main tree as one repository', async () => {
    // A DSH home of its own: two sessions whose cwd is a real directory, one a
    // worktree of the other, so the report can tell they share a repository.
    const repoHome = await mkdtemp(join(tmpdir(), 'agent-usages-repo-cli-'));
    const main = join(repoHome, 'repo');
    const worktree = join(repoHome, 'lynx-rewrite');
    await mkdir(join(main, '.git', 'worktrees', 'lynx-rewrite'), { recursive: true });
    await writeFile(join(main, '.git', 'HEAD'), 'ref: refs/heads/master\n');
    await writeFile(join(main, '.git', 'worktrees', 'lynx-rewrite', 'HEAD'), 'ref: refs/heads/lynx-rewrite\n');
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'lynx-rewrite')}\n`);

    /** Write one session log whose single request bills 1M of each bucket. */
    const writeLog = async (dir: string, id: string): Promise<void> => {
      const sessionDir = join(repoHome, 'sessions', 'proj', id);
      await mkdir(sessionDir, { recursive: true });
      const lines = [
        JSON.stringify({ type: 'session', version: 0, id, createdAt: OFF_PEAK, cwd: dir, delegationDepth: 0 }),
        JSON.stringify({
          type: 'assistant/message',
          seq: 5,
          time: OFF_PEAK,
          data: {
            turn: 1,
            step: 1,
            message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
            usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          },
        }),
      ];
      await writeFile(join(sessionDir, 'session.jsonl'), `${lines.join('\n')}\n`);
    };
    await writeLog(main, 'session-11111111-0000-4000-8000-0000000000aa');
    await writeLog(worktree, 'session-22222222-0000-4000-8000-0000000000bb');

    const { stdout } = await cli(['usage', '--home', repoHome, '--no-update']);
    expect(stdout).toContain('repo 仓库 · 2 个项目');
    expect(stdout).toContain('· git worktree · lynx-rewrite');
    // The repository line carries the sum of the two projects under it.
    expect(stdout).toContain('Q 2 ·');
    await rm(repoHome, { recursive: true, force: true });
  });
});

describe('price', () => {
  it('prints the schedule with its sources, without reading any data', async () => {
    const { code, stdout } = await cli(['price'], { HOME: '/nowhere' });
    expect(code).toBe(0);
    expect(stdout).toContain('DeepSeek');
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
      pricingProviders: { id: string; currencies: string[]; models: { model: string }[] }[];
    };
    expect(parsed.agents[0]?.id).toBe('dsh');
    expect(parsed.agents[0]?.envVars).toEqual(['DSH_HOME']);
    expect(parsed.agents[0]?.notes.length).toBeGreaterThan(0);
    expect(parsed.pricingProviders[0]?.id).toBe('deepseek');
    expect(parsed.pricingProviders[0]?.currencies).toEqual(['CNY', 'USD']);
    expect(parsed.pricingProviders[0]?.models.map((model) => model.model)).toContain('deepseek-flash');
  });
});

describe('help', () => {
  it('documents every command', async () => {
    const { code, stdout } = await cli(['--help']);
    expect(code).toBe(0);
    for (const command of ['usage', 'session', 'price', 'agents', 'serve']) expect(stdout).toContain(command);
    expect(stdout).toContain('--agent');
    expect(stdout).toContain('--provider');
  });

  it('documents the HTML report option', async () => {
    const { stdout } = await cli(['usage', '--help']);
    // `--html` takes an optional value now: a path writes a file, no value (or
    // `-`) sends the document to stdout.
    expect(stdout).toContain('--html [path]');
    expect(stdout).toContain('自包含');
  });
});

describe('serve', () => {
  /** Wait for the child to print something matching `pattern`, and answer with it. */
  function firstMatch(child: ChildProcess, pattern: RegExp, timeoutMs = 30_000): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      let seen = '';
      let settled = false;
      const finish = (error?: Error, value?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== undefined) reject(error);
        else resolvePromise(value ?? '');
      };
      const timer = setTimeout(() => finish(new Error(`nothing matched ${String(pattern)} yet:\n${seen}`)), timeoutMs);
      child.stdout?.on('data', (chunk: Buffer) => {
        seen += chunk.toString();
        const match = seen.match(pattern);
        if (match !== null) finish(undefined, match[0]);
      });
      child.once('exit', (code) => finish(new Error(`serve exited early (${String(code)}):\n${seen}`)));
    });
  }

  /** Start the platform against the fixture, exactly as the command line would. */
  function startServe(args: string[], env: Record<string, string> = {}): ChildProcess {
    return spawn(process.execPath, [CLI, 'serve', ...args], {
      env: { ...process.env, LANG: 'zh_CN.UTF-8', HOME: home, DSH_HOME: join(home, '.dsh'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  /** Ask a running server to stop, the way Ctrl-C does, and wait for it to go. */
  async function stop(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, 'exit');
    child.kill('SIGINT');
    await ended;
  }

  /**
   * A snapshot of the fixture, written once for the whole file.
   *
   * Written by the command itself, so the round trip `--write-snapshot` →
   * `--snapshot` is what every test here exercises.
   */
  let snapshotFile: string | undefined;
  async function fixtureSnapshot(): Promise<string> {
    if (snapshotFile !== undefined) return snapshotFile;
    const target = join(home, 'serve-fixture.snapshot.json');
    const written = await cli([
      'serve',
      '--agent',
      'dsh',
      '--home',
      join(home, '.dsh'),
      '--no-update',
      '--write-snapshot',
      target,
    ]);
    expect(written.code).toBe(0);
    expect(written.stdout).toContain('已写入快照');
    snapshotFile = target;
    return target;
  }

  it('opens the report in the browser, from a file the user can keep', async () => {
    const { code, stdout } = await cli(['usage', '--range', 'month', '--open'], { AGENT_USAGES_NO_BROWSER: '1' });
    expect(code).toBe(0);
    const written = /已写入 (.+)$/m.exec(stdout)?.[1]?.trim();
    expect(written, stdout.slice(0, 200)).toBeDefined();
    // The default home is the system temporary directory, not the cwd.
    expect(written).toContain('agent-usages-usage-');
    const document = readFileSync(written as string, 'utf8');
    expect(document.startsWith('<!doctype html>')).toBe(true);
    expect(document).toContain('</html>');
  });

  it('lets --html name the path --open shows', async () => {
    const target = join(home, 'opened-report.html');
    const { code, stdout } = await cli(['usage', '--range', 'month', '--open', '--html', target], {
      AGENT_USAGES_NO_BROWSER: '1',
    });
    expect(code).toBe(0);
    expect(stdout).toContain(target);
    expect(readFileSync(target, 'utf8').startsWith('<!doctype html>')).toBe(true);
  });

  it('spells `ui` as `serve --open`', async () => {
    const { code, stdout } = await cli(['ui', '--help']);
    expect(code).toBe(0);
    // The alias is the serve command, options and all.
    expect(stdout).toContain('serve [options]');
    expect(stdout).toContain('--snapshot');
  });

  it('documents the platform and every option it takes', async () => {
    const { code, stdout } = await cli(['serve', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('Web 分析平台');
    for (const flag of ['--port', '--host', '--open', '--refresh', '--snapshot', '--dev', '--quiet', '--write-snapshot']) {
      expect(stdout).toContain(flag);
    }
  });

  it('refuses a port, a refresh interval, and options it does not have', async () => {
    const port = await cli(['serve', '--port', '70000']);
    expect(port.code).toBe(1);
    expect(port.stderr).toContain('0…65535');

    const refresh = await cli(['serve', '--refresh', '-1']);
    expect(refresh.code).toBe(1);
    expect(refresh.stderr).toContain('非负秒数');

    // `--json` and `--provider` are global, so commander takes them before the
    // subcommand name; a platform that ignored them would answer with someone
    // else's price list, so they are refused rather than dropped.
    const json = await cli(['--json', 'serve', '--port', '0']);
    expect(json.code).toBe(1);
    expect(json.stderr).toContain('serve 不接受 --json');

    const provider = await cli(['--provider', 'deepseek', 'serve', '--port', '0']);
    expect(provider.code).toBe(1);
    expect(provider.stderr).toContain('serve 不接受 --provider');
  });

  it('writes a snapshot that needs no agent data to serve', async () => {
    const file = await fixtureSnapshot();
    const snapshot = JSON.parse(await readFile(file, 'utf8')) as {
      projects: unknown[];
      totals: { requests: number };
    };
    expect(snapshot.projects.length).toBeGreaterThan(0);
    expect(snapshot.totals.requests).toBeGreaterThan(0);
  });

  it(
    'narrows a snapshot to the agents --agent names',
    async () => {
      const file = await fixtureSnapshot();

      // An unknown id is an error here too: the flag must not be accepted and
      // then ignored just because the data came from a file.
      const unknown = await cli(['serve', '--snapshot', file, '--agent', 'nosuch', '--port', '0']);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain('未知的 agent');

      // The file holds dsh only, so asking for pi is an empty dashboard rather
      // than the whole file: that is the difference the flag makes.
      const other = startServe(['--snapshot', file, '--agent', 'pi', '--port', '0']);
      try {
        const url = await firstMatch(other, /http:\/\/127\.0\.0\.1:\d+/);
        const summary = (await (await fetch(`${url}/api/summary`)).json()) as {
          agents: unknown[];
          totals: { requests: number };
        };
        expect(summary.agents).toEqual([]);
        expect(summary.totals.requests).toBe(0);

        // A request for an agent the server was narrowed away from is not a
        // request for "every agent": the intersection is empty, and an empty
        // selection must stay empty instead of falling back to the whole file.
        const overlap = (await (await fetch(`${url}/api/dashboard?agent=dsh`)).json()) as {
          agents: unknown[];
          projects: unknown[];
          totals: { requests: number; cost: { total: string } };
          loadedAgents: unknown[];
        };
        expect(overlap.agents).toEqual([]);
        expect(overlap.projects).toEqual([]);
        expect(overlap.totals.requests).toBe(0);
        expect(overlap.totals.cost.total).toBe('0.0000');
        // The file holds no pi at all, so the narrowed provenance block is empty
        // too — it describes what is being served, never the file's contents.
        expect(overlap.loadedAgents).toEqual([]);
      } finally {
        await stop(other);
      }
    },
    30_000,
  );

  it(
    'serves the front end from AGENT_USAGES_WEB_DIST when it is set',
    async () => {
      // The packaged build may put the bundle elsewhere, and the variable has to
      // work through the CLI entry point too — not only through `pnpm serve`.
      const child = startServe(['--snapshot', await fixtureSnapshot(), '--port', '0'], {
        AGENT_USAGES_WEB_DIST: join(home, 'no-such-dist'),
      });
      try {
        const url = await firstMatch(child, /http:\/\/127\.0\.0\.1:\d+/);
        const page = await fetch(`${url}/`);
        expect(page.status).toBe(503);
        expect(await page.text()).toContain('前端还没构建');
        // The API is independent of where the front end lives.
        expect((await (await fetch(`${url}/api/health`)).json()) as { ok: boolean }).toMatchObject({ ok: true });
      } finally {
        await stop(child);
      }
    },
    30_000,
  );

  it(
    'answers the API with figures that add up, then stops on a signal',
    async () => {
      const child = startServe(['--port', '0', '--agent', 'dsh', '--home', join(home, '.dsh'), '--no-update']);
      try {
        const url = await firstMatch(child, /http:\/\/127\.0\.0\.1:\d+/);
        const health = (await (await fetch(`${url}/api/health`)).json()) as {
          ok: boolean;
          agents: { id: string }[];
        };
        expect(health.ok).toBe(true);
        expect(health.agents.map((agent) => agent.id)).toEqual(['dsh']);

        const summary = (await (await fetch(`${url}/api/summary`)).json()) as {
          agents: { requests: number; tokens: { input: number }; cost: { total: string } }[];
          totals: { requests: number; tokens: { input: number }; cost: { total: string } };
        };
        expect(summary.totals.requests).toBeGreaterThan(0);
        // The identity the whole dashboard rests on: the agents *are* the total.
        expect(summary.agents.reduce((sum, agent) => sum + agent.requests, 0)).toBe(summary.totals.requests);
        expect(summary.agents.reduce((sum, agent) => sum + agent.tokens.input, 0)).toBe(summary.totals.tokens.input);
        expect(formatDecimal(sumAmounts(summary.agents.map((agent) => parseDecimal(agent.cost.total))), 4)).toBe(
          summary.totals.cost.total,
        );

        // A snapshot the server cannot refresh is a client error, not a crash.
        const unknown = await fetch(`${url}/api/nope`);
        expect(unknown.status).toBe(404);
        expect(unknown.headers.get('content-type')).toContain('application/json');
      } finally {
        await stop(child);
      }
      expect(child.exitCode).toBe(0);
    },
    30_000,
  );

  it(
    'answers in the language the request asks for, and remembers the one it is told',
    async () => {
      // The switch in the page writes the same file the CLI reads, so the test
      // keeps that file in a directory of its own — never the developer's own.
      const configHome = mkdtempSync(join(tmpdir(), 'agent-usages-serve-config-'));
      const env = { XDG_CONFIG_HOME: configHome };
      const child = startServe(['--snapshot', await fixtureSnapshot(), '--port', '0'], env);
      try {
        const url = await firstMatch(child, /http:\/\/127\.0\.0\.1:\d+/);
        const configFile = join(configHome, 'agent-usages', 'config.json');

        const settings = (await (await fetch(`${url}/api/settings`)).json()) as {
          language: string;
          configured: string | null;
          path: string;
          languages: string[];
        };
        // Nothing in the file yet: the machine's locale decides (`LANG=zh_CN`).
        expect(settings.language).toBe('zh');
        expect(settings.configured).toBeNull();
        expect(settings.languages).toEqual(['zh', 'en']);
        expect(settings.path).toBe(configFile);

        // The payload's prose follows `?lang=`, the numbers do not.
        const zh = (await (await fetch(`${url}/api/dashboard`)).json()) as { rangeLabel: string };
        const en = (await (await fetch(`${url}/api/dashboard?lang=en`)).json()) as { rangeLabel: string };
        expect(zh.rangeLabel).not.toBe(en.rangeLabel);
        expect(en.rangeLabel).toContain('all');
        expect(zh.rangeLabel).toContain('全部');

        // A language this build does not speak is refused, with the code.
        const bad = await fetch(`${url}/api/settings`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ language: 'fr' }),
        });
        expect(bad.status).toBe(400);
        expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('settingsUnknownLanguage');

        // A page other than this one cannot reach the write.
        const foreign = await fetch(`${url}/api/settings`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
          body: JSON.stringify({ language: 'en' }),
        });
        expect(foreign.status).toBe(403);

        const saved = await fetch(`${url}/api/settings`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ language: 'en' }),
        });
        expect(saved.status).toBe(200);
        expect((await saved.json()) as { configured: string }).toMatchObject({ configured: 'en', language: 'en' });
        expect(JSON.parse(await readFile(configFile, 'utf8'))).toEqual({ language: 'en' });

        // Which means the CLI itself speaks English on its next run.
        const help = await cli(['--help'], env);
        expect(help.stdout).toContain('Token usage and cost for coding agents');
      } finally {
        await stop(child);
      }
    },
    30_000,
  );

  it(
    'edits the project declarations from the page, and rescans to apply them',
    async () => {
      // A live scan against the fixture: project declarations are applied by the
      // merge layer, so the only honest test is one that rescans.
      const configHome = mkdtempSync(join(tmpdir(), 'agent-usages-serve-config-'));
      const child = startServe(['--port', '0', '--agent', 'dsh', '--home', join(home, '.dsh'), '--no-update'], {
        XDG_CONFIG_HOME: configHome,
      });
      try {
        const url = await firstMatch(child, /http:\/\/127\.0\.0\.1:\d+/);
        const before = (await (await fetch(`${url}/api/dashboard`)).json()) as {
          projects: { name: string; workspaces: string[]; sessions: number }[];
        };
        expect(before.projects.length).toBeGreaterThan(0);
        const first = before.projects[0]!;
        const path = first.workspaces[0]!;

        const config = (await (await fetch(`${url}/api/config`)).json()) as {
          path: string;
          exists: boolean;
          document: Record<string, unknown>;
        };
        expect(config.exists).toBe(false);
        expect(config.path).toBe(join(configHome, 'agent-usages', 'config.json'));

        // A declaration that does not pass the readers never reaches the file.
        const invalid = await fetch(`${url}/api/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projects: [{ name: '', paths: [] }] }),
        });
        expect(invalid.status).toBe(400);
        const failure = (await invalid.json()) as { error: { code: string; field: string } };
        expect(failure.error.code).toBe('configProjectName');
        expect(failure.error.field).toBe('projects[0].name');
        expect(existsSync(join(configHome, 'agent-usages', 'config.json'))).toBe(false);

        const saved = await fetch(`${url}/api/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projects: [{ name: 'renamed-project', paths: [path] }] }),
        });
        expect(saved.status).toBe(200);
        const answer = (await saved.json()) as { refresh: { ok: boolean }; config: { projects: unknown[] } };
        expect(answer.refresh.ok).toBe(true);
        expect(answer.config.projects).toEqual([{ name: 'renamed-project', paths: [path] }]);

        // The declaration is in the file…
        const written = JSON.parse(await readFile(join(configHome, 'agent-usages', 'config.json'), 'utf8')) as {
          projects: unknown[];
        };
        expect(written.projects).toEqual([{ name: 'renamed-project', paths: [path] }]);

        // …and the next dashboard is grouped by it.
        const after = (await (await fetch(`${url}/api/dashboard`)).json()) as {
          projects: { name: string; workspaces: string[]; sessions: number }[];
        };
        const renamed = after.projects.find((project) => project.name === 'renamed-project');
        expect(renamed, `renamed project in ${after.projects.map((p) => p.name).join(', ')}`).toBeDefined();
        expect(renamed?.workspaces).toContain(path);
        expect(renamed?.sessions).toBe(first.sessions);
        expect(after.projects.some((project) => project.name === first.name)).toBe(false);
      } finally {
        await stop(child);
      }
    },
    30_000,
  );

  it(
    'keeps the language out of the way of the rest of the configuration file',
    async () => {
      const configHome = mkdtempSync(join(tmpdir(), 'agent-usages-serve-config-'));
      const configDir = join(configHome, 'agent-usages');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'config.json'),
        `${JSON.stringify({ language: 'zh', projects: [{ name: 'demo', paths: ['/tmp/demo'] }] }, null, 2)}\n`,
        'utf8',
      );
      const child = startServe(['--snapshot', await fixtureSnapshot(), '--port', '0'], { XDG_CONFIG_HOME: configHome });
      try {
        const url = await firstMatch(child, /http:\/\/127\.0\.0\.1:\d+/);
        // The file's own value is what a request gets when it asks for nothing.
        const en = (await (await fetch(`${url}/api/dashboard?lang=en`)).json()) as { rangeLabel: string };
        expect(en.rangeLabel).toContain('all');

        const saved = await fetch(`${url}/api/settings`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ language: 'en' }),
        });
        expect(saved.status).toBe(200);
        const after = JSON.parse(await readFile(join(configDir, 'config.json'), 'utf8')) as Record<string, unknown>;
        expect(after['language']).toBe('en');
        expect(after['projects']).toEqual([{ name: 'demo', paths: ['/tmp/demo'] }]);
      } finally {
        await stop(child);
      }
    },
    30_000,
  );
});

describe('configuration commands', () => {
  it('checks the shipped configuration', async () => {
    const { code, stdout } = await cli(['check-config']);
    expect(code).toBe(0);
    expect(stdout).toContain('config/pricing.json  通过');
    expect(stdout).toContain('config/rates.json  通过');
    expect(stdout).toContain('config/holidays.json  通过');
  });

  it('checks it as JSON too', async () => {
    const parsed = JSON.parse((await cli(['check-config', '--json'])).stdout) as {
      results: { file: string; ok: boolean }[];
    };
    expect(parsed.results.map((result) => result.file)).toEqual([
      'config/pricing.json',
      'config/rates.json',
      'config/holidays.json',
    ]);
    expect(parsed.results.every((result) => result.ok)).toBe(true);
  });

  it('rejects an update target it does not know', async () => {
    const { code, stderr } = await cli(['update', 'everything']);
    expect(code).toBe(1);
    expect(stderr).toMatch(/未知的更新目标/);
  });

  it('documents the update targets in its help', async () => {
    const { stdout } = await cli(['update', '--help']);
    expect(stdout).toContain('all（默认）/ prices / rates');
    expect(stdout).toContain('--write-config');
  });

  it('skips the network entirely with --no-update', async () => {
    // The fixture's own config directory has no cache, so this also proves the
    // shipped files are enough to run.
    const { code, stdout } = await cli(['usage', '--json', '--no-update']);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ agent: 'dsh' });
  });
});

describe('price filters', () => {
  it('narrows to one currency', async () => {
    const { stdout } = await cli(['price', '--currency', 'usd']);
    expect(stdout).toContain('deepseek，USD / 百万 tokens');
    expect(stdout).toContain('（USD）');
    expect(stdout).not.toContain('（CNY）');
  });

  it('narrows to the period in effect now', async () => {
    const all = (await cli(['price', '--currency', 'CNY'])).stdout;
    const current = (await cli(['price', '--currency', 'CNY', '--current'])).stdout;
    expect(all).toContain('[2026-01-01]');
    expect(current).not.toContain('[2026-01-01]');
    expect(current).toContain('[2026-09-10]');
    expect(current.split('[2026-').length).toBeLessThan(all.split('[2026-').length);
  });

  it('says so when a provider has no such currency', async () => {
    const { stdout } = await cli(['price', '--currency', 'JPY']);
    expect(stdout).toContain('没有 JPY 的价格');
  });

  it('lists every provider with --all', async () => {
    const { stdout } = await cli(['price', '--all', '--current']);
    expect(stdout).toContain('DeepSeek');
  });
});

describe('historical rate mode', () => {
  /**
   * A prepared config directory: EUR display, per-date rates, no network.
   *
   * The base list is CNY — a zh-CN reader's published list — even though the
   * display currency is EUR, so the series is CNY→EUR.
   */
  function historicalHome(): Record<string, string> {
    const dir = mkdtempSync(join(tmpdir(), 'agent-usages-cli-hist-'));
    mkdirSync(join(dir, 'agent-usages'), { recursive: true });
    writeFileSync(
      join(dir, 'agent-usages', 'config.json'),
      JSON.stringify({ version: 1, currency: 'EUR', rateMode: 'historical', updates: { pricing: false, rates: false } }),
      'utf8',
    );
    writeFileSync(
      join(dir, 'agent-usages', 'cache-series-CNY-EUR.json'),
      JSON.stringify({
        base: 'CNY',
        target: 'EUR',
        from: '2026-09-11',
        to: '2026-09-11',
        requestedFrom: '2025-01-01',
        requestedTo: '2099-01-01',
        fetchedAt: Date.now(),
        source: 'frankfurter.dev（欧洲央行参考汇率）',
        rates: { '2026-09-11': '0.5', '2026-09-12': '0.25' },
      }),
      'utf8',
    );
    return { XDG_CONFIG_HOME: dir };
  }

  it('converts at the record\'s own date and says so', async () => {
    const env = historicalHome();
    const parsed = JSON.parse((await cli(['usage', '--json', '--no-update'], env)).stdout) as {
      rateInfo: { mode: string; series?: string };
      totals: { cost: Record<string, string> };
    };
    expect(parsed.rateInfo.mode).toBe('historical');
    expect(parsed.rateInfo.series).toContain('frankfurter');
    // The fixture's request is on 2026-09-11T12:00Z and costs ¥5.02: at the
    // prepared 0.5 that is €2.51 — the day's own rate, not today's.
    expect(Number(parsed.totals.cost['total'])).toBeCloseTo(2.51, 2);

    const text = (await cli(['usage', '--no-update'], env)).stdout;
    expect(text).toContain('按每条记录当天的汇率折算为 EUR');
    expect(text).toMatch(/汇率      按记录日期 · .*frankfurter/);
  });

  it('keeps the default mode when the flag does not ask for history', async () => {
    const parsed = JSON.parse((await cli(['usage', '--json', '--no-update', '--rate-mode', 'latest'], historicalHome())).stdout) as {
      rateInfo: { mode: string };
      currency: string;
    };
    expect(parsed.rateInfo.mode).toBe('latest');
    expect(parsed.currency).toBe('EUR');
  });

  it('falls back to one rate when no series can be had', async () => {
    // Same config, no series cached and no network allowed: the report still runs.
    const dir = mkdtempSync(join(tmpdir(), 'agent-usages-cli-hist-'));
    mkdirSync(join(dir, 'agent-usages'), { recursive: true });
    writeFileSync(
      join(dir, 'agent-usages', 'config.json'),
      JSON.stringify({ version: 1, currency: 'EUR', rateMode: 'historical', updates: { pricing: false, rates: false } }),
      'utf8',
    );
    const parsed = JSON.parse((await cli(['usage', '--json', '--no-update'], { XDG_CONFIG_HOME: dir })).stdout) as {
      rateInfo: { mode: string };
      totals: { cost: Record<string, string> };
    };
    expect(parsed.rateInfo.mode).toBe('latest');
    expect(Number(parsed.totals.cost['total'])).toBeGreaterThan(0);
  });
});

describe('language', () => {
  /** A config directory that pins the output language. */
  function homeWith(language: string): Record<string, string> {
    const dir = mkdtempSync(join(tmpdir(), 'agent-usages-lang-'));
    mkdirSync(join(dir, 'agent-usages'), { recursive: true });
    writeFileSync(
      join(dir, 'agent-usages', 'config.json'),
      JSON.stringify({ version: 1, language, updates: { pricing: false, rates: false } }),
      'utf8',
    );
    return { XDG_CONFIG_HOME: dir };
  }

  it('speaks the configured language, whatever the machine locale is', async () => {
    const { stdout } = await cli(['usage'], homeWith('en'));
    const lines = stdout.split('\n');
    expect(lines[0]).toBe('Agent usage');
    expect(lines[1]).toBe('Agent     dsh (DeepSeek Harness (DSH))');
    // The header and the tree's own labels are English; a session title from the
    // fixture is data and is echoed as written.
    expect(lines.slice(0, 5).join('\n')).not.toMatch(/[一-龥]/);
    expect(stdout).toContain('total ·');
    expect(stdout).toContain('I/M 1.00M');
  });

  it('localises the other commands and their help', async () => {
    const env = homeWith('en');
    expect((await cli(['usage', '--help'], env)).stdout).toContain('token usage and cost');
    expect((await cli(['price', '--currency', 'USD', '--current'], env)).stdout).toContain('Default model');
    expect((await cli(['agents'], env)).stdout).toContain('Agents (--agent):');
    expect((await cli(['check-config'], env)).stdout).toContain('ok');
    expect((await cli(['update', 'nope'], env)).stderr).toMatch(/unknown update target/);
  });

  it('keeps the numbers and identifiers identical across languages', async () => {
    // The point of the separation: only prose changes. What still is prose inside
    // JSON — the range label and a warning's sentence — is excluded on purpose;
    // everything else, codes included, must match exactly.
    const pick = (body: string): Record<string, unknown> => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const rate = parsed['rateInfo'] as Record<string, unknown>;
      const range = parsed['range'] as Record<string, unknown>;
      const warnings = (parsed['warnings'] as { code: string }[]).map((warning) => warning.code);
      return {
        totals: parsed['totals'],
        currency: parsed['currency'],
        rate: { base: rate['base'], display: rate['display'], rate: rate['rate'], mode: rate['mode'] },
        range: { preset: range['preset'], from: range['from'], to: range['to'] },
        models: parsed['models'],
        subagents: parsed['subagents'],
        warnings,
      };
    };
    const zh = pick((await cli(['usage', '--range', 'today', '--json'], homeWith('zh'))).stdout);
    const en = pick((await cli(['usage', '--range', 'today', '--json'], homeWith('en'))).stdout);
    expect(en).toEqual(zh);
    expect(zh.range).toMatchObject({ preset: 'today' });
  });

  it('falls back to Chinese when the locale has no opinion', async () => {
    const { stdout } = await cli(['usage'], { LANG: 'C' });
    expect(stdout).toContain('Agent 用量统计');
  });

  it('serves other languages with English', async () => {
    const { stdout } = await cli(['usage'], { LANG: 'ja_JP.UTF-8' });
    expect(stdout).toContain('Agent usage');
  });
});
