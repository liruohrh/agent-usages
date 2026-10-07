#!/usr/bin/env node
/**
 * The dashboard's smoke test.
 *
 * Starts the server on a free port, calls every endpoint the UI depends on,
 * asserts the shapes and the things that must add up, then stops it again — the
 * process exits non-zero on the first failed assertion and never leaves a server
 * behind, because the server lives in this process rather than in a shell.
 *
 * The offline fixture is a dump of a real machine, so it is not tracked. `--snapshot`
 * points the run at another one — CI uses the synthetic fixture that *is* tracked
 * (`web/mock/ci.snapshot.json`, generated from `web/mock/fixtures/`):
 *
 * ```sh
 * node web/scripts/smoke.mjs                                        # this machine's dump
 * node web/scripts/smoke.mjs --snapshot web/mock/ci.snapshot.json   # synthetic, what CI runs
 * node web/scripts/smoke.mjs --live                                 # also rescan real data
 * ```
 *
 * The live pass is a second, bigger check: it proves the adapters, the merge
 * layer and the report all work end to end. It is skipped by default so the test
 * is green on a machine with no agent data at all.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { isolateConfig } from './tmp-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
/** The fixture to replay: `--snapshot <path>`, else this machine's own dump. */
function fixtureFrom(argv) {
  const index = argv.indexOf('--snapshot');
  const given = index === -1 ? undefined : argv[index + 1];
  return given === undefined ? resolve(repo, 'web', 'mock', 'dashboard.snapshot.json') : resolve(process.cwd(), given);
}
const snapshotPath = fixtureFrom(process.argv.slice(2));

// The language the page reads lives in the user's configuration file, and this
// test switches it. Point the server at a copy so a run never rewrites the file
// a developer is actually using.
isolateConfig(repo, 'zh');

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

  // The language the page speaks, and the one write this server allows: the
  // switch in the page is the same setting the CLI reads.
  const settings = await call(base, '/api/settings');
  check('GET /api/settings → 200', settings.status === 200, `HTTP ${settings.status}`);
  check('settings 报了语言与写入路径', settings.body?.language === 'zh' && typeof settings.body?.path === 'string',
    JSON.stringify(settings.body));
  check('settings 只列本版本支持的语言', JSON.stringify(settings.body?.languages) === '["zh","en"]');
  const refused = await call(base, '/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'fr' }),
  });
  check('PUT /api/settings 拒绝不支持的语言', refused.status === 400, `HTTP ${refused.status}`);
  check('拒绝时带 code', refused.body?.error?.code === 'settingsUnknownLanguage');
  const english = await call(base, '/api/dashboard?lang=en');
  check('?lang=en 把散文换成英文', /all time|today|this week|this month/.test(english.body?.rangeLabel ?? ''), english.body?.rangeLabel);

  // The settings page's own endpoint: the file it edits, as the page edits it.
  const config = await call(base, '/api/config');
  check('GET /api/config → 200', config.status === 200, `HTTP ${config.status}`);
  check(
    'config 报了路径、原文与解析后的值',
    typeof config.body?.path === 'string' &&
      typeof config.body?.document === 'object' &&
      Array.isArray(config.body?.config?.projects),
    JSON.stringify(config.body?.config),
  );
  check('config 只接受它管的键', (await call(base, '/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ language: 'en' }),
  })).status === 400);

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
  const listSessions = sessions.body?.sessions ?? [];
  check('sessions 非空且带 uid/agent', listSessions.every((session) => typeof session.uid === 'string' && typeof session.agent === 'string'));
  const subagents = listSessions.filter((session) => session.isSubagent);
  check('会话列表里有子代理（isSubagent）', subagents.length > 0);

  const target = subagents[0] ?? listSessions[0];
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

  // The page's copy button hands the reader the session's own log file. Whether a
  // session has one depends on the agent (an index-only session has no log), so
  // absence is allowed — but a path that *is* there must be absolute, must match
  // between the list and the detail, and in a live scan must be on disk. The
  // tracked synthetic fixture predates the field, so the strict half waits for
  // the live pass (or for a regenerated snapshot) to mean anything.
  const namedSessions = listSessions.filter((session) => session.sourceFile !== undefined);
  check(
    '会话 sourceFile 有则必须是绝对路径',
    namedSessions.every((session) => typeof session.sourceFile === 'string' && isAbsolute(session.sourceFile)),
    namedSessions.slice(0, 3).map((session) => JSON.stringify(session.sourceFile)).join('; '),
  );
  check(
    '会话详情沿用列表里的 sourceFile',
    detail.body?.detail?.session?.sourceFile === target?.sourceFile,
    `${JSON.stringify(detail.body?.detail?.session?.sourceFile)} vs ${JSON.stringify(target?.sourceFile)}`,
  );
  if (live) {
    const broken = namedSessions.filter((session) => !existsSync(session.sourceFile));
    // An adapter that fills the field at all must fill it from a file it read.
    check(
      '实时扫描：会话带 sourceFile',
      namedSessions.length > 0,
      `0 / ${listSessions.length} 个会话有日志路径`,
    );
    check(
      '实时扫描：每个 sourceFile 都真的存在',
      broken.length === 0,
      broken.slice(0, 3).map((session) => session.sourceFile).join('; '),
    );
  }

  const day = await call(base, '/api/timeseries?bucket=day');
  check('GET /api/timeseries?bucket=day → 200', day.status === 200, `HTTP ${day.status}`);
  check('日粒度有点且有 byAgent', (day.body?.points ?? []).length > 0 && (day.body?.points ?? []).every((point) => typeof point.cost === 'string' && point.byAgent !== undefined));
  const hour = await call(base, '/api/timeseries?bucket=hour');
  check('GET /api/timeseries?bucket=hour → 200', hour.status === 200, `HTTP ${hour.status}`);
  const filtered = await call(base, `/api/timeseries?bucket=day&agent=${encodeURIComponent(agents[0]?.id ?? 'dsh')}`);
  check('带 agent 过滤的时序可用', filtered.status === 200 && (filtered.body?.points ?? []).every((point) => Object.keys(point.byAgent).every((id) => id === agents[0]?.id)));

  // Five grids over the same records: hour/day come from the scan, week/month/
  // year are folded from the day grid. Each bucket starts where it says it does
  // (its `t` is the local start the drill narrows to), and the labels carry the
  // year so a week that straddles New Year cannot be mistaken for another.
  const grids = ['hour', 'day', 'week', 'month', 'year'];
  const series = new Map();
  for (const grid of grids) {
    const answer = await call(base, `/api/timeseries?bucket=${grid}`);
    series.set(grid, answer);
    check(`GET /api/timeseries?bucket=${grid} → 200 且回显档位`, answer.status === 200 && answer.body?.bucket === grid, `HTTP ${answer.status} bucket=${answer.body?.bucket}`);
  }
  const labelShape = {
    hour: /^\d{4}-\d{2}-\d{2} \d{2}:00$/,
    day: /^\d{4}-\d{2}-\d{2}$/,
    week: /^\d{4}-W\d{2}$/,
    month: /^\d{4}-\d{2}$/,
    year: /^\d{4}$/,
  };
  check(
    '五档标签各自成形',
    grids.every((grid) => (series.get(grid)?.body?.points ?? []).every((point) => labelShape[grid].test(point.label))),
    grids.map((grid) => `${grid}:${(series.get(grid)?.body?.points ?? [])[0]?.label ?? '-'}`).join(' '),
  );
  // The grids this reader folds (`week`/`month`/`year`) have to land on a local
  // start — that is the code under test. `hour` and `day` are baked into the
  // snapshot in the timezone it was written in, so outside that timezone their
  // `t` is deliberately not a local midnight: the file decides those, not this
  // code. Both were checked to be strictly increasing instead.
  const pointsOf = (grid) => series.get(grid)?.body?.points ?? [];
  const isLocalStart = (t, grid) => {
    const date = new Date(t);
    if (grid === 'week') return date.getDay() === 1 && date.getHours() === 0 && date.getMinutes() === 0;
    if (grid === 'month') return date.getDate() === 1 && date.getHours() === 0 && date.getMinutes() === 0;
    return date.getMonth() === 0 && date.getDate() === 1 && date.getHours() === 0 && date.getMinutes() === 0;
  };
  check(
    '折出来的周/月/年每桶都落在本地起点（周一 / 1 号 / 1 月 1 日）',
    ['week', 'month', 'year'].every((grid) => pointsOf(grid).every((point) => isLocalStart(point.t, grid))),
    ['week', 'month', 'year'].map((grid) => `${grid}:${pointsOf(grid)[0]?.label ?? '-'}`).join(' '),
  );
  check(
    '每档的点都按时间严格递增',
    grids.every((grid) => pointsOf(grid).every((point, index) => index === 0 || (pointsOf(grid)[index - 1]?.t ?? 0) < point.t)),
  );
  // The hourly grid keeps only the recent window by design, so it is a subset;
  // the other four cover every record the range holds.
  check(
    'Σ day/week/month/year 请求 === 总计请求',
    ['day', 'week', 'month', 'year'].every(
      (grid) =>
        (series.get(grid)?.body?.points ?? []).reduce((sum, point) => sum + point.requests, 0) ===
        summary.body?.totals?.requests,
    ),
    ['day', 'week', 'month', 'year']
      .map((grid) => `${grid}:${(series.get(grid)?.body?.points ?? []).reduce((sum, point) => sum + point.requests, 0)}`)
      .join(' '),
  );
  check(
    'Σ hour 请求 ≤ 总计请求（小时只保留近 14 天）',
    (series.get('hour')?.body?.points ?? []).reduce((sum, point) => sum + point.requests, 0) <=
      (summary.body?.totals?.requests ?? 0),
  );
  // Folding the day grid must be lossless: one month's requests are its days'.
  const monthOf = (label) => (series.get('month')?.body?.points ?? []).find((point) => point.label === label);
  const monthPoint = (series.get('month')?.body?.points ?? [])[0];
  if (monthPoint !== undefined) {
    const daysInside = (series.get('day')?.body?.points ?? []).filter(
      (point) => new Date(point.t).getFullYear() === new Date(monthPoint.t).getFullYear() && new Date(point.t).getMonth() === new Date(monthPoint.t).getMonth(),
    );
    check(
      '一个月的请求 = 该月各天的请求',
      daysInside.reduce((sum, point) => sum + point.requests, 0) === monthPoint.requests,
      `${monthOf(monthPoint.label)?.requests} vs ${daysInside.reduce((sum, point) => sum + point.requests, 0)}`,
    );
  }
  // An explicit `A..B` window (what a drill writes) narrows the series; the same
  // window on the next finer grid is how "click a day → see its hours" works.
  // A day the hourly grid still covers: the first day of the range would predate
  // the 14-day window and drill into nothing.
  const hourDays = new Set((series.get('hour')?.body?.points ?? []).map((point) => new Date(point.t).toDateString()));
  const dayPoint = [...(series.get('day')?.body?.points ?? [])]
    .reverse()
    .find((point) => hourDays.has(new Date(point.t).toDateString()));
  if (dayPoint !== undefined) {
    const start = dayPoint.t;
    const end = new Date(dayPoint.t);
    end.setDate(end.getDate() + 1);
    // The window is written from the bucket's own `t`, time of day included: the
    // snapshot's day buckets need not start at *this* reader's midnight, and a
    // spec that forced `T00:00:00` would cut the bucket in half elsewhere.
    const pad = (value) => String(value).padStart(2, '0');
    const isoLocal = (date) =>
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    const spec = `${isoLocal(new Date(start))}..${isoLocal(end)}`;
    const narrowed = await call(base, `/api/timeseries?bucket=hour&range=${encodeURIComponent(spec)}`);
    const kept = narrowed.body?.points ?? [];
    check(
      '显式窗口把时序收窄到那一天',
      narrowed.status === 200 && kept.length > 0 && kept.every((point) => point.t >= start && point.t < end.getTime()),
      `窗口 ${spec} → ${kept.length} 个小时桶，首尾 ${kept[0]?.label ?? '-'} … ${kept[kept.length - 1]?.label ?? '-'}`,
    );
    check(
      '收窄后的小时之和 = 那一天的请求',
      kept.reduce((sum, point) => sum + point.requests, 0) === dayPoint.requests,
      `${kept.reduce((sum, point) => sum + point.requests, 0)} vs ${dayPoint.requests}`,
    );
  }
  // An unknown bucket keeps the documented default rather than failing.
  const unknown = await call(base, '/api/timeseries?bucket=fortnight');
  check(
    '未知档位退回 day',
    unknown.status === 200 && unknown.body?.bucket === 'day',
    `HTTP ${unknown.status} bucket=${unknown.body?.bucket}`,
  );

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
  // Bands exist only for records a price list could price, while the totals and
  // the model rows count every record: the difference is exactly `unpriced`.
  const priced = (summary.body?.totals?.requests ?? 0) - (summary.body?.totals?.unpriced ?? 0);
  check('Σ 区间行请求 === 已计价请求', requestSum(bands) === priced, `${requestSum(bands)} vs ${priced}`);
  // The dual-currency view: every (price list, currency) the run billed under,
  // with the published amount beside the converted one. The converted column is
  // summed from the same bands the total is, so it reconciles exactly, and the
  // rows cover every priced request.
  const subtotals = dashboard.body?.subtotals ?? [];
  check(
    '按表小计非空（有已计价请求时）',
    subtotals.length > 0 || priced === 0,
    `${subtotals.length} rows for ${priced} priced requests`,
  );
  check(
    '每条小计都带原币与显示币',
    subtotals.every(
      (row) =>
        typeof row?.money?.original?.currency === 'string' &&
        typeof row?.money?.original?.amount === 'string' &&
        typeof row?.money?.display?.currency === 'string' &&
        typeof row?.money?.display?.amount === 'string' &&
        row.money.display.currency === dashboard.body?.currency,
    ),
  );
  check(
    'Σ 小计(显示币) === 总计',
    subtotals
      .reduce((sum, row) => sum + Number(row?.money?.display?.amount ?? 0), 0)
      .toFixed(4) === Number(summary.body?.totals?.cost?.total ?? 0).toFixed(4),
    `${subtotals.map((row) => row?.money?.display?.amount).join(' + ')} vs ${summary.body?.totals?.cost?.total}`,
  );
  check(
    'Σ 小计请求 === 已计价请求',
    requestSum(subtotals) === priced,
    `${requestSum(subtotals)} vs ${priced}`,
  );
  // Two sides of one sum: a list already quoted in the display currency must
  // print the identical number, and a converted row must be in the dashboard's
  // currency — never a third one the page would have no symbol for.
  check(
    '小计的原币与显示币自洽',
    subtotals.every((row) =>
      row?.money?.original?.currency === row?.money?.display?.currency
        ? row.money.original.amount === row.money.display.amount
        : row?.money?.display?.currency === dashboard.body?.currency,
    ),
  );
  // JSON always carries both sides (a consumer must not have to infer from a
  // missing field); the *text* views are what drop the duplicate number.
  check(
    '模型行双币形状一致',
    models.every(
      (row) =>
        row?.money === undefined ||
        (typeof row.money.original.amount === 'string' &&
          typeof row.money.display.amount === 'string' &&
          (row.money.original.currency === row.money.display.currency ||
            row.money.original.currency.length === 3)),
    ),
  );
  const short = (dashboard.body?.projects ?? []).filter((project) => requestSum(project.models) !== project.requests);
  check(
    '每个项目 Σ 模型行请求 === 项目请求',
    short.length === 0,
    short.map((project) => `${project.id}: ${requestSum(project.models)} vs ${project.requests}`).join('; '),
  );

  // The CLI's `总 / 自身 / 子代理` split: every scope carries it, and 自身 + 子代理
  // has to be exactly the scope's own total — same requests, same tokens, same
  // money — or the two reports disagree on the same data.
  const split = (row) => ({
    requests: (row?.own?.requests ?? 0) + (row?.spawned?.requests ?? 0),
    cost: addAmounts([row?.own?.cost?.total ?? '0', row?.spawned?.cost?.total ?? '0']),
    tokens: BUCKETS.map((key) => (row?.own?.tokens?.[key] ?? 0) + (row?.spawned?.tokens?.[key] ?? 0)),
  });
  const splitMatches = (row) => {
    const sum = split(row);
    return (
      sum.requests === row?.requests &&
      sum.cost === addAmounts([row?.cost?.total ?? '0']) &&
      BUCKETS.every((key, index) => sum.tokens[index] === row?.tokens?.[key])
    );
  };
  check('summary.totals 带 自身/子代理 且 Σ = 总计', splitMatches(summary.body?.totals));
  const shortSplit = (dashboard.body?.projects ?? []).filter((project) => !splitMatches(project));
  check(
    '每个项目 自身 + 子代理 = 项目总计',
    shortSplit.length === 0,
    shortSplit.map((project) => project.id).join('; '),
  );
  check(
    '单项目接口也带 自身/子代理 且 Σ = 总计',
    splitMatches(one.body?.project) && (one.body?.project?.own?.requests ?? 0) > 0,
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
    `\n找不到离线快照 ${snapshotPath}\n` +
      '本机生成一份：pnpm web:snapshot（见 web/mock/README.md）；\n' +
      '或者用仓库里合成的那份：node web/scripts/smoke.mjs --snapshot web/mock/ci.snapshot.json\n',
  );
  process.exit(2);
}

await run({ port: 0, snapshot: snapshotPath }, false);

if (process.argv.includes('--live')) {
  // A live scan writes a scan cache: give it a scratch directory so the run never
  // touches the one the developer's own commands use.
  const cacheDir = await mkdtemp(join(tmpdir(), 'agent-usages-smoke-cache-'));
  try {
    await run({ port: 0, cacheDir }, true);
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
} else {
  process.stdout.write('\n（跳过实时扫描；加 --live 会再跑一遍真实数据）\n');
}

process.stdout.write(`\n通过 ${passed} 项，失败 ${failures.length} 项\n`);
if (failures.length > 0) {
  for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`);
  process.exitCode = 1;
}
