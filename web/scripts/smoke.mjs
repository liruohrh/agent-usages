#!/usr/bin/env node
/**
 * The dashboard's smoke test.
 *
 * Starts the server on a free port, calls every endpoint the UI depends on,
 * asserts the shapes and the things that must add up, then stops it again — the
 * process exits non-zero on the first failed assertion and never leaves a server
 * behind, because the server lives in this process rather than in a shell.
 *
 * Two modes:
 *
 * ```sh
 * node web/scripts/smoke.mjs           # offline snapshot fixture (deterministic)
 * node web/scripts/smoke.mjs --live    # also rescan this machine's real data
 * ```
 *
 * The live pass is a second, bigger check: it proves the adapters, the merge
 * layer and the report all work end to end. It is skipped by default so the test
 * is green on a machine with no agent data at all.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const snapshotPath = resolve(repo, 'web', 'mock', 'dashboard.snapshot.json');

const { startServer } = await import(resolve(repo, 'src', 'serve', 'server.ts'));

/** How many checks passed, and what failed. */
let passed = 0;
const failures = [];

/** Assert one condition, recording rather than throwing so one run reports all. */
function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    process.stdout.write(`  ✓ ${label}\n`);
    return;
  }
  failures.push(`${label}${detail.length === 0 ? '' : ` — ${detail}`}`);
  process.stdout.write(`  ✗ ${label}${detail.length === 0 ? '' : ` — ${detail}`}\n`);
}

/** Exact decimal addition on strings, so money is compared the way it is stored. */
function addAmounts(values) {
  const scale = 1_000_000_000n;
  const parse = (text) => {
    const [whole = '0', fraction = ''] = String(text).split('.');
    return BigInt(whole) * scale + BigInt((fraction + '0'.repeat(9)).slice(0, 9));
  };
  return values.reduce((total, value) => total + parse(value), 0n);
}

/** GET/POST one endpoint and parse the JSON body. */
async function call(base, path, init) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body;
  try {
    body = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body, text };
}

/** The five buckets every token total must carry. */
const BUCKETS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];

/** Everything asserted about a running server. */
async function exercise(base, { live }) {
  process.stdout.write(`\n▸ ${base}（${live ? '实时扫描' : '离线快照'}）\n`);

  const health = await call(base, '/api/health');
  check('GET /api/health → 200', health.status === 200, `HTTP ${health.status}`);
  check('health.ok === true', health.body?.ok === true);
  check('health 报了 agent 列表', Array.isArray(health.body?.agents));

  const summary = await call(base, '/api/summary');
  check('GET /api/summary → 200', summary.status === 200, `HTTP ${summary.status}`);
  const agents = summary.body?.agents ?? [];
  check('summary.agents 非空', agents.length > 0);
  check(
    'summary.agents[] 字段齐全',
    agents.every(
      (agent) =>
        typeof agent.id === 'string' &&
        typeof agent.label === 'string' &&
        typeof agent.sessions === 'number' &&
        typeof agent.subagentSessions === 'number' &&
        typeof agent.requests === 'number' &&
        BUCKETS.every((key) => typeof agent.tokens?.[key] === 'number') &&
        typeof agent.cost?.total === 'string',
    ),
  );
  check('summary.totals.requests > 0', (summary.body?.totals?.requests ?? 0) > 0);
  check(
    'summary.totals.tokenBreakdown 五桶齐全',
    BUCKETS.every((key) => typeof summary.body?.totals?.tokenBreakdown?.[key]?.tokens === 'number'),
  );
  const agentCostSum = addAmounts(agents.map((agent) => agent.cost.total));
  check(
    'Σ agent 费用 === 总计费用（精确到小数）',
    agentCostSum === addAmounts([summary.body?.totals?.cost?.total ?? '0']),
    `${agentCostSum} vs ${summary.body?.totals?.cost?.total}`,
  );

  const projects = await call(base, '/api/projects');
  check('GET /api/projects → 200', projects.status === 200, `HTTP ${projects.status}`);
  const list = projects.body?.projects ?? [];
  check('projects 非空', list.length > 0);
  check(
    'projects[] 字段齐全',
    list.every(
      (project) =>
        typeof project.id === 'string' &&
        typeof project.name === 'string' &&
        (project.kind === 'repo' || project.kind === 'path') &&
        Array.isArray(project.workspaces) &&
        Array.isArray(project.agents) &&
        typeof project.sessions === 'number' &&
        typeof project.subagentSessions === 'number' &&
        typeof project.activeSessions === 'number' &&
        typeof project.requests === 'number' &&
        BUCKETS.every((key) => typeof project.tokens?.[key] === 'number') &&
        typeof project.cost?.total === 'string' &&
        Array.isArray(project.agentTotals) &&
        Array.isArray(project.sessionReports),
    ),
  );
  const first = list[0];
  check(
    'Σ 项目 agentTotals === 项目费用',
    first !== undefined &&
      addAmounts(first.agentTotals.map((totals) => totals.cost.total)) === addAmounts([first.cost.total]),
  );
  check(
    'Σ 项目费用 === 总计费用',
    addAmounts(list.map((project) => project.cost.total)) === addAmounts([summary.body?.totals?.cost?.total ?? '0']),
  );
  check(
    '每个项目都带 agent 徽标所需的 agents[]',
    list.every((project) => project.agents.length > 0 && project.agentTotals.length > 0),
  );

  const one = await call(base, `/api/projects/${encodeURIComponent(first?.id ?? 'nope')}`);
  check('GET /api/projects/:id → 200', one.status === 200, `HTTP ${one.status}`);
  check('单项目带上 workspaceNodes 与 sessionReports', Array.isArray(one.body?.project?.workspaceNodes) && Array.isArray(one.body?.project?.sessionReports));
  const missingProject = await call(base, '/api/projects/definitely-not-a-project');
  check('GET /api/projects/<未知> → 404', missingProject.status === 404, `HTTP ${missingProject.status}`);

  const sessions = await call(base, '/api/sessions');
  check('GET /api/sessions → 200', sessions.status === 200, `HTTP ${sessions.status}`);
  check('sessions 非空且带 uid/agent', (sessions.body?.sessions ?? []).every((session) => typeof session.uid === 'string' && typeof session.agent === 'string'));
  const subagents = (sessions.body?.sessions ?? []).filter((session) => session.isSubagent);
  check('会话列表里有子代理（isSubagent）', subagents.length > 0);

  const target = subagents[0] ?? sessions.body?.sessions?.[0];
  const detail = await call(base, `/api/sessions/${encodeURIComponent(target?.uid ?? 'nope')}`);
  check('GET /api/sessions/:id → 200', detail.status === 200, `HTTP ${detail.status}`);
  check('会话详情带委派树', detail.body?.detail?.tree !== undefined && Array.isArray(detail.body?.detail?.tree?.children));
  check('会话详情带模型与计价区间', Array.isArray(detail.body?.detail?.models) && Array.isArray(detail.body?.detail?.bands));
  check(
    '会话 自身 + 子代理 === 总计',
    detail.body?.detail !== undefined &&
      addAmounts([detail.body.detail.session.own.cost.total, detail.body.detail.session.spawned.cost.total]) ===
        addAmounts([detail.body.detail.session.total.cost.total]),
  );
  const missingSession = await call(base, '/api/sessions/there-is-no-such-session');
  check('GET /api/sessions/<未知> → 404', missingSession.status === 404, `HTTP ${missingSession.status}`);

  const day = await call(base, '/api/timeseries?bucket=day');
  check('GET /api/timeseries?bucket=day → 200', day.status === 200, `HTTP ${day.status}`);
  check('日粒度有点且有 byAgent', (day.body?.points ?? []).length > 0 && (day.body?.points ?? []).every((point) => typeof point.cost === 'string' && point.byAgent !== undefined));
  const hour = await call(base, '/api/timeseries?bucket=hour');
  check('GET /api/timeseries?bucket=hour → 200', hour.status === 200, `HTTP ${hour.status}`);
  const filtered = await call(base, `/api/timeseries?bucket=day&agent=${encodeURIComponent(agents[0]?.id ?? 'dsh')}`);
  check('带 agent 过滤的时序可用', filtered.status === 200 && (filtered.body?.points ?? []).every((point) => Object.keys(point.byAgent).every((id) => id === agents[0]?.id)));

  const ranged = await call(base, '/api/summary?range=week');
  check('GET /api/summary?range=week → 200', ranged.status === 200, `HTTP ${ranged.status}`);
  check('range=week 的请求数不超过全部', (ranged.body?.totals?.requests ?? 0) <= (summary.body?.totals?.requests ?? 0));

  const badRange = await call(base, '/api/summary?range=2026-01-01..2026-02-02..2026-03-03');
  check('非法 range → 400 JSON', badRange.status === 400 && typeof badRange.body?.error?.message === 'string', `HTTP ${badRange.status}`);

  // The detail tables the UI draws: one row per identity, and the rows add up to
  // the totals they sit under. A row per session both duplicates the identity
  // (which is the React key) and leaves the tables short.
  const dashboard = await call(base, '/api/dashboard');
  check('GET /api/dashboard → 200', dashboard.status === 200, `HTTP ${dashboard.status}`);
  const models = dashboard.body?.models ?? [];
  const bands = dashboard.body?.bands ?? [];
  const identity = (row, parts) => parts.map((part) => row?.[part] ?? '').join('|');
  const unique = (keys) => new Set(keys).size === keys.length;
  const requestSum = (rows) => rows.reduce((total, row) => total + (row?.requests ?? 0), 0);
  const modelKey = (row) => identity(row, ['agent', 'projectId', 'model']);
  const bandKey = (row) => identity(row, ['agent', 'projectId', 'model', 'periodId', 'tier']);
  check('模型明细非空', models.length > 0);
  check('模型明细一行一个 (agent, 项目, 模型)', models.length > 0 && unique(models.map(modelKey)));
  check('计价区间一行一个 (agent, 项目, 模型, 区间, 档位)', bands.length > 0 && unique(bands.map(bandKey)));
  check(
    'Σ 模型行请求 === 总计请求',
    requestSum(models) === summary.body?.totals?.requests,
    `${requestSum(models)} vs ${summary.body?.totals?.requests}`,
  );
  check(
    'Σ 区间行请求 === 总计请求',
    requestSum(bands) === summary.body?.totals?.requests,
    `${requestSum(bands)} vs ${summary.body?.totals?.requests}`,
  );
  const short = (dashboard.body?.projects ?? []).filter((project) => requestSum(project.models) !== project.requests);
  check(
    '每个项目 Σ 模型行请求 === 项目请求',
    short.length === 0,
    short.map((project) => `${project.id}: ${requestSum(project.models)} vs ${project.requests}`).join('; '),
  );

  const shell = await fetch(base);
  const html = await shell.text();
  check('GET / → 200 HTML', shell.status === 200 && (shell.headers.get('content-type') ?? '').includes('text/html'), `HTTP ${shell.status}`);
  check('返回的是前端壳', html.includes('id="root"'));
  const spa = await fetch(`${base}/p/${encodeURIComponent(first?.id ?? 'x')}`);
  check('SPA 深链回退到 index.html', spa.status === 200 && (await spa.text()).includes('id="root"'));

  const refresh = await call(base, '/api/refresh', { method: 'POST' });
  if (live) {
    check('POST /api/refresh → 200 且 ok', refresh.status === 200 && refresh.body?.ok === true, `HTTP ${refresh.status}`);
    check('重扫后仍有数据', (refresh.body?.agents ?? []).length > 0);
  } else {
    check('快照模式 POST /api/refresh → 409 且说明原因', refresh.status === 409 && refresh.body?.ok === false, `HTTP ${refresh.status}`);
  }
}

/** Run one server, exercise it, and always close it. */
async function run(options, live) {
  const running = await startServer({ ...options, quiet: true });
  try {
    await exercise(running.url, { live });
  } finally {
    await running.close();
    process.stdout.write(`  · 已关闭 ${running.url}\n`);
  }
}

process.stdout.write('agent-usages serve · 冒烟测试\n');

// The offline fixture is a dump of this machine's usage and is not tracked, so a
// fresh clone has to make one. Say that instead of failing inside the reader.
if (!existsSync(snapshotPath)) {
  process.stdout.write(
    `\n找不到离线快照 ${snapshotPath}\n先运行 pnpm web:snapshot 生成它（见 web/mock/README.md），或加 --live 只跑实时扫描。\n`,
  );
  process.exit(2);
}

await run({ port: 0, snapshot: snapshotPath }, false);

if (process.argv.includes('--live')) {
  await run({ port: 0 }, true);
} else {
  process.stdout.write('\n（跳过实时扫描；加 --live 会再跑一遍真实数据）\n');
}

process.stdout.write(`\n通过 ${passed} 项，失败 ${failures.length} 项\n`);
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`);
  process.exitCode = 1;
}
