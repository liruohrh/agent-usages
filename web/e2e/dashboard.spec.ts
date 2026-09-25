/**
 * The dashboard, in a real browser.
 *
 * Two kinds of things are pinned here. The first is arithmetic the UI must not
 * get wrong: the tables compare, row by row, with the `/api/dashboard` payload
 * the page itself fetched, and `自身 + 子代理` has to be exactly the scope's total.
 * The second is the shape of the page: tabs that answer one question each, a
 * header that stays four figures, detail behind a disclosure, and no horizontal
 * scrolling where a table is wide.
 *
 * Nothing names a project or expects a number: the suite runs on any machine's
 * data, and the offline fixture is a dump of real usage that never enters the
 * repository.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

/** The parts of the dashboard payload the assertions use. */
interface ApiFigures {
  requests: number;
  cost: { total: string };
}

interface ApiRow {
  agent: string;
  model: string;
  periodLabel?: string;
  requests: number;
  cost: { total: string };
}

interface ApiSession {
  uid: string;
  id: string;
  title: string | null;
  agent: string;
  isSubagent: boolean;
  parentId: string | null;
  requests: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  cost: { total: string; cacheHitInputCost: string };
}

interface ApiDashboard {
  agents: {
    id: string;
    label: string;
    requests: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
    cost: { total: string };
  }[];
  models: ApiRow[];
  bands: ApiRow[];
  totals: ApiFigures & { own: ApiFigures; spawned: ApiFigures };
  loadedAgents: { id: string }[];
  projects: {
    id: string;
    name: string;
    models: ApiRow[];
    bands: ApiRow[];
    requests: number;
    cost: { total: string };
    own: ApiFigures;
    spawned: ApiFigures;
    sessionReports: ApiSession[];
    agentTotals: { id: string; label: string; cost: { total: string } }[];
    workspaceNodes: { path: string; name: string; cost: { total: string } }[];
  }[];
}

/** Agent ids as the badges write them. */
const AGENT_LABELS: Record<string, string> = { dsh: 'DSH', pi: 'pi', claude: 'Claude', codex: 'Codex' };

/** Fetch `/api/dashboard` from inside the page — the same request the app made. */
async function apiDashboard(page: Page): Promise<ApiDashboard> {
  return page.evaluate(async () => (await fetch('/api/dashboard')).json()) as Promise<ApiDashboard>;
}

/** The card whose heading is exactly `title`. */
function cardOf(page: Page, title: string): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

/** The card whose heading starts with `prefix` — cards that count their rows. */
function cardStartingWith(page: Page, prefix: string): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: new RegExp(`^${prefix}`) }) });
}

/** One card's data rows, as trimmed cell texts; a "nothing here" row is dropped. */
async function rowsOf(page: Page, title: string): Promise<string[][]> {
  return cardOf(page, title)
    .locator('tbody tr')
    .evaluateAll((rows) =>
      rows
        .map((row) => [...row.querySelectorAll('td')].map((cell) => (cell.textContent ?? '').trim()))
        .filter((cells) => cells.length > 1),
    );
}

/** `2,294` → `2294`; `¥1.2345` → `1.2345`. */
function numberOf(text: string): number {
  return Number(text.replace(/[^\d.]/g, ''));
}

/** The bucket chips under the first row's bar, as `label value money`. */
async function rowChips(page: Page, index = 0): Promise<string[]> {
  return page
    .locator('main ol > li')
    .nth(index)
    .evaluate((item) => {
      const row = item.firstElementChild;
      const content = row?.children[1];
      return [...(content?.querySelectorAll('span.whitespace-nowrap') ?? [])]
        .map((chip) => (chip.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter((text) => text.length > 0);
    });
}

/** The three figures pinned on the right of a row: Q, tokens, money. */
async function rowFigures(page: Page, index: number): Promise<number[]> {
  return page
    .locator('main ol > li')
    .nth(index)
    .evaluate((item) => {
      const row = item.firstElementChild;
      const cells = [...(row?.children ?? [])].slice(-3);
      return cells.map((cell) => {
        const text = (cell.textContent ?? '').replace(/,/g, '');
        const match = /([\d.]+)\s*(亿|万)?/.exec(text);
        if (match === null) return Number.NaN;
        const base = Number(match[1]);
        return match[2] === '亿' ? base * 1e8 : match[2] === '万' ? base * 1e4 : base;
      });
    });
}

/** The sort dropdown in the ranking card's header. */
function sortSelect(page: Page): Locator {
  return page.locator('main section header select');
}

/** Switch to one of the scope's tabs. */
async function openTab(page: Page, label: string): Promise<void> {
  await page.locator('main').getByRole('button', { name: label, exact: true }).first().click();
}

/** Click a project in the tree and wait for the scope heading to follow. */
async function selectProject(page: Page, name: string): Promise<void> {
  await page.locator('aside').getByText(name, { exact: true }).first().click();
  await expect(page.locator('main h1')).toHaveText(name);
}

/** The API's rows in the order the tables show them: dearest first, then by name. */
function sortedRows(rows: readonly ApiRow[]): ApiRow[] {
  return [...rows].sort(
    (left, right) => Number(right.cost.total) - Number(left.cost.total) || left.model.localeCompare(right.model),
  );
}

/** The `agent|model|requests` triples a table shows, and the same for an API row. */
function triples(
  cells: readonly (readonly string[])[],
  columns: { agent: number; model: number; requests: number },
): string[] {
  return cells.map((row) => `${row[columns.agent]}|${row[columns.model]}|${numberOf(row[columns.requests] ?? '')}`);
}

function apiTriple(row: ApiRow, withPeriod = false): string {
  const model = withPeriod ? `${row.model} · ${row.periodLabel ?? ''}` : row.model;
  return `${AGENT_LABELS[row.agent] ?? row.agent}|${model}|${row.requests}`;
}

/** Open one session page, chosen from the API rather than from a link. */
async function openSession(page: Page, project?: string): Promise<{ uid: string; title: string | null }> {
  const dashboard = await apiDashboard(page);
  const rows = rootSessions(dashboard);
  const wanted = project === undefined ? rows : rows.filter((session) => session.projectName === project);
  const billed0 = wanted.filter((session) => session.requests > 0);
  const chosen = (billed0[0] ?? wanted[0]) as ApiSession | undefined;
  test.skip(chosen === undefined, 'no session to open');
  if (chosen === undefined) return { uid: '', title: null };
  await page.goto(`/s/${encodeURIComponent(chosen.uid)}`);
  return { uid: chosen.uid, title: chosen.title };
}

/** The sessions the table shows by default: one row per delegation subtree. */
function rootSessions(dashboard: ApiDashboard): ApiSession[] {
  const all = dashboard.projects.flatMap((project) => project.sessionReports);
  const ids = new Set(all.map((session) => session.id));
  return all.filter((session) => !(session.isSubagent && session.parentId !== null && ids.has(session.parentId)));
}

/** The billed-bucket total a row's `T` column shows. */
function billed(session: ApiSession): number {
  return session.tokens.input + session.tokens.cacheRead + session.tokens.cacheWrite + session.tokens.output;
}

/** The two projects a switching test uses, or a skip when there are fewer. */
async function twoProjects(page: Page): Promise<ApiDashboard['projects']> {
  const dashboard = await apiDashboard(page);
  test.skip(dashboard.projects.length < 2, 'needs two projects to switch between');
  return dashboard.projects.slice(0, 2);
}

test.describe('the overview', () => {
  test('leads with four figures, not with a wall of numbers', async ({ page }) => {
    await page.goto('/');
    const dashboard = await apiDashboard(page);
    const cards = page.locator('main div.grid > div.rounded-xl');
    await expect(cards).toHaveCount(4);
    const texts = (await cards.allInnerTexts()).join(' ');
    for (const label of ['费用', '请求', 'tokens（计费桶）', '缓存命中率']) expect(texts).toContain(label);
    expect(texts).toContain(dashboard.totals.cost.total);
  });

  test('shows where the tokens and the money went', async ({ page }) => {
    await page.goto('/');
    const card = cardOf(page, '构成');
    await expect(card).toBeVisible();
    const labels = (await card.locator('table tbody tr').allInnerTexts()).join(' ');
    expect(labels).toContain('未命中缓存输入');
    expect(labels).toContain('缓存命中输入');
  });

  test('ranks the projects and the sessions, and opens one on click', async ({ page }) => {
    await page.goto('/');
    const dashboard = await apiDashboard(page);

    const dearest = [...dashboard.projects].sort((left, right) => Number(right.cost.total) - Number(left.cost.total))[0];
    const projects = cardStartingWith(page, '项目（前五）');
    await expect(projects.locator('ol > li')).toHaveCount(Math.min(5, dashboard.projects.length));
    await expect(projects.locator('ol > li').first()).toContainText(dearest?.name ?? '');

    const sessions = cardStartingWith(page, '会话（前五）');
    await expect(sessions.locator('ol > li')).toHaveCount(Math.min(5, rootSessions(dashboard).length));

    const link = projects.locator('a[href^="/p/"]').first();
    await link.click();
    await expect(page.locator('main h1')).toHaveText(dearest?.name ?? '');
  });
});

test.describe('scope switching', () => {
  test('the model and band tables describe the project that is selected', async ({ page }) => {
    await page.goto('/?view=models');
    await expect(page.locator('main h1')).toHaveText('全部项目');
    const whole = await apiDashboard(page);
    expect(await rowsOf(page, '模型明细')).toHaveLength(whole.models.length);

    const names = (await twoProjects(page)).map((project) => project.name);
    for (const name of [...names, names[0] ?? '']) {
      await selectProject(page, name);
      await openTab(page, '模型与计价');

      const dashboard = await apiDashboard(page);
      const project = dashboard.projects.find((entry) => entry.name === name);
      expect(project, `${name} is in the dashboard`).toBeDefined();
      if (project === undefined) return;

      const expectedModels = sortedRows(project.models);
      const modelRows = await rowsOf(page, '模型明细');
      expect(modelRows.length, 'one row per (agent, model)').toBe(expectedModels.length);
      expect(triples(modelRows, { agent: 0, model: 1, requests: 2 })).toEqual(expectedModels.map((row) => apiTriple(row)));

      const expectedBands = sortedRows(project.bands);
      const bandRows = await rowsOf(page, '计价区间明细');
      expect(bandRows.length, 'one row per (agent, model, price band)').toBe(expectedBands.length);
      expect(triples(bandRows, { agent: 1, model: 2, requests: 5 })).toEqual(
        expectedBands.map((row) => apiTriple(row, true)),
      );

      // No stale row from another scope may survive the switch.
      const modelKeys = modelRows.map((row) => `${row[0]}|${row[1]}`);
      expect(new Set(modelKeys).size, 'model rows are unique').toBe(modelKeys.length);
    }
  });

  test('the session table follows the project and can show subagents', async ({ page }) => {
    await page.goto('/');
    const project = (await twoProjects(page))[0];
    if (project === undefined) return;
    await selectProject(page, project.name);
    await openTab(page, '会话');

    const ids = new Set(project.sessionReports.map((session) => session.id));
    const roots = project.sessionReports.filter(
      (session) => !(session.isSubagent && session.parentId !== null && ids.has(session.parentId)),
    );
    await expect(page.locator('main ol > li')).toHaveCount(roots.length);

    await page.locator('main section header').getByRole('button', { name: '合并子代理' }).click();
    await expect(page.locator('main ol > li')).toHaveCount(project.sessionReports.length);
  });
});

test.describe('the project and agent rankings', () => {
  test('every project is ranked, with its own buckets on expand', async ({ page }) => {
    await page.goto('/?view=projects');
    const dashboard = await apiDashboard(page);
    const rows = page.locator('main ol > li');
    await expect(rows).toHaveCount(dashboard.projects.length);

    const dearest = [...dashboard.projects].sort((left, right) => Number(right.cost.total) - Number(left.cost.total))[0];
    await expect(rows.first()).toContainText(dearest?.name ?? '');
    // Each bucket is a chip with its money, and the rows carry the three
    // right-hand figures (Q, tokens, money).
    const chips = await rowChips(page);
    expect(chips.length).toBeGreaterThanOrEqual(2);
    expect(chips.every((chip) => chip.includes('¥'))).toBe(true);
    expect(await rowFigures(page, 0)).toHaveLength(3);
    // Expanding shows the bucket table with money per bucket.
    await rows.first().click();
    const detail = await rows.first().locator('table tbody tr').allInnerTexts();
    expect(detail.join(' ')).toContain('合计');
    expect((detail.join(' ').match(/¥/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  test('the agent board ranks what was read, and sorts', async ({ page }) => {
    await page.goto('/?view=agents');
    const dashboard = await apiDashboard(page);
    const rows = page.locator('main ol > li');
    await expect(rows).toHaveCount(dashboard.agents.length);

    const dearest = [...dashboard.agents].sort((left, right) => Number(right.cost.total) - Number(left.cost.total))[0];
    await expect(rows.first()).toContainText(dearest?.label ?? '');
    // Sorting is by the dropdown (or by clicking a chip).
    await sortSelect(page).selectOption({ label: '总 token' });
    const mostTokens = [...dashboard.agents].sort(
      (left, right) =>
        right.tokens.input + right.tokens.output + right.tokens.cacheRead + right.tokens.cacheWrite -
        (left.tokens.input + left.tokens.output + left.tokens.cacheRead + left.tokens.cacheWrite),
    )[0];
    await expect(rows.first()).toContainText(mostTokens?.label ?? '');
  });

  test('a project scope ranks its own workspaces and agents', async ({ page }) => {
    await page.goto('/');
    const project = (await twoProjects(page))[0];
    if (project === undefined) return;
    await selectProject(page, project.name);

    await openTab(page, '项目');
    await expect(page.locator('main ol > li')).toHaveCount(project.workspaceNodes.length);
    await openTab(page, 'agent');
    await expect(page.locator('main ol > li')).toHaveCount(project.agentTotals.length);
  });
});

test.describe('the usage tab', () => {
  test('prints 总 / 自身 / 子代理, and the two add up to the total', async ({ page }) => {
    await page.goto('/?view=usage');
    const dashboard = await apiDashboard(page);
    const rows = await rowsOf(page, '这部分的用量');
    expect(rows.map((row) => row[0])).toEqual(['总', '自身', '子代理']);

    const requests = rows.map((row) => numberOf(row[1] ?? ''));
    expect(requests[0], '自身 + 子代理 = 总').toBe(requests[1] + requests[2]);
    expect(requests).toEqual([
      dashboard.totals.requests,
      dashboard.totals.own.requests,
      dashboard.totals.spawned.requests,
    ]);

    const money = rows.map((row) => numberOf(row[6] ?? ''));
    expect(money[0]).toBeCloseTo(money[1] + money[2], 3);
    expect(money[0]).toBeCloseTo(Number(dashboard.totals.cost.total), 3);
  });

  test('keeps every CLI figure behind one disclosure', async ({ page }) => {
    await page.goto('/?view=usage');
    const card = cardOf(page, '完整指标');
    await expect(card).toBeVisible();
    await expect(card.locator('table')).toHaveCount(0);
    await card.getByRole('button', { name: '展开逐项数字' }).click();
    const head = (await card.locator('thead th').allInnerTexts()).map((cell) => cell.trim());
    for (const column of ['范围', 'I/M', 'I/C', 'I/T', 'O', 'O/T', 'T', 'Q', '合计']) {
      expect(head, `column ${column}`).toContain(column);
    }
    const rows = await card.locator('tbody tr').allInnerTexts();
    expect(rows.map((row) => row.trim().split(/\s+/)[0])).toEqual(['总', '自身', '子代理']);
  });

  test('the agent table starts with five columns and unfolds the buckets', async ({ page }) => {
    await page.goto('/?view=usage');
    const table = cardOf(page, '按 agent 分列');
    await expect(table.locator('thead th').first()).toBeVisible();
    const detailed = (await table.locator('thead th').allInnerTexts()).map((cell) => cell.trim());
    for (const column of ['agent', '会话（子）', 'Q', 'I/M', 'I/C', 'I/T', 'O', 'O/T', 'T', '费用', '占比']) {
      expect(detailed, `column ${column}`).toContain(column);
    }

    await table.getByRole('button', { name: '精简列' }).click();
    const summary = (await table.locator('thead th').allInnerTexts()).map((cell) => cell.trim());
    expect(summary).toEqual(['agent', '会话（子）', 'Q', 'T', '费用', '占比']);
    await table.getByRole('button', { name: '全部列' }).click();

    const firstBucket = table.locator('tbody tr').first().locator('td').nth(3);
    const asTokens = await firstBucket.innerText();
    await table.getByRole('button', { name: '费用' }).click();
    expect(await firstBucket.innerText()).not.toBe(asTokens);
    expect(await firstBucket.innerText()).toContain('¥');
    await table.getByRole('button', { name: '占比' }).click();
    expect(await firstBucket.innerText()).toContain('%');
  });
});

test.describe('a session', () => {
  test('shows its own figures, not its project’s', async ({ page }) => {
    await page.goto('/');
    const project = (await twoProjects(page))[0];
    if (project === undefined) return;
    const { uid } = await openSession(page, project.name);

    const detail = (await page.evaluate(
      async (id) => (await fetch(`/api/sessions/${encodeURIComponent(id)}`)).json(),
      uid,
    )) as {
      detail: {
        session: { title: string | null; total: ApiFigures; own: ApiFigures; spawned: ApiFigures };
        models: ApiRow[];
      };
    };
    if (detail.detail.session.title !== null) {
      await expect(page.locator('main h1')).toHaveText(detail.detail.session.title);
    }

    const rows = await rowsOf(page, '这部分的用量');
    const requests = rows.map((row) => numberOf(row[1] ?? ''));
    expect(requests[0]).toBe(detail.detail.session.total.requests);
    expect(requests[1]).toBe(detail.detail.session.own.requests);
    expect(requests[2]).toBe(detail.detail.session.spawned.requests);

    const modelRows = await cardOf(page, '本会话模型明细')
      .locator('tbody tr')
      .evaluateAll((list) =>
        list.map((row) => [...row.querySelectorAll('td')].map((cell) => (cell.textContent ?? '').trim())),
      );
    expect(modelRows.length).toBe(detail.detail.models.length);
    expect(triples(modelRows, { agent: 0, model: 1, requests: 2 })).toEqual(
      sortedRows(detail.detail.models).map((row) => apiTriple(row)),
    );
  });
});

test.describe('the session leaderboard', () => {
  /** One row of the leaderboard, by index. */
  const rowAt = (page: Page, index: number): Locator => page.locator('main ol > li').nth(index);

  test('shows every bucket with its money under the bar, and three figures on the right', async ({ page }) => {
    await page.goto('/?view=sessions');
    const sessions = rootSessions(await apiDashboard(page));
    await expect(page.locator('main ol > li')).toHaveCount(sessions.length);

    const chips = await rowChips(page);
    // One chip per bucket the row used, and each carries its own money.
    expect(chips.length).toBeGreaterThanOrEqual(2);
    for (const chip of chips) {
      expect(chip, chip).toMatch(/^(I\/M|I\/C|I\/W|O|R)/);
      expect(chip, `money in ${chip}`).toContain('¥');
    }
    // The totals are the right-hand columns, not chips.
    expect(chips.join(' ')).not.toContain('总 token');
    expect(chips.join(' ')).not.toContain('费用');

    const dearest = [...sessions].sort((left, right) => Number(right.cost.total) - Number(left.cost.total))[0];
    await expect(rowAt(page, 0)).toContainText(dearest?.title ?? '');
    const [requests, tokens, cost] = await rowFigures(page, 0);
    const close = (shown: number | undefined, actual: number | undefined): number =>
      Math.abs((shown ?? 0) - (actual ?? 0)) / Math.max(1, actual ?? 1);
    expect(requests).toBe(dearest?.requests);
    expect(close(tokens, dearest ? billed(dearest) : 0)).toBeLessThan(0.02);
    expect(close(cost, Number(dearest?.cost.total ?? 0))).toBeLessThan(0.01);
  });

  test('orders the list from the dropdown, both directions', async ({ page }) => {
    await page.goto('/?view=sessions');
    const sessions = rootSessions(await apiDashboard(page));
    const dearest = [...sessions].sort((left, right) => Number(right.cost.total) - Number(left.cost.total))[0];
    const mostRequests = [...sessions].sort((left, right) => right.requests - left.requests)[0];
    const mostTokens = [...sessions].sort((left, right) => billed(right) - billed(left))[0];
    const cheapest = [...sessions].sort((left, right) => Number(left.cost.total) - Number(right.cost.total))[0];
    const direction = page.locator('main section header').getByRole('button', { name: /降序|升序/ });

    await expect(rowAt(page, 0)).toContainText(dearest?.title ?? '');
    await sortSelect(page).selectOption({ label: 'Q' });
    await expect(rowAt(page, 0)).toContainText(mostRequests?.title ?? '');
    await sortSelect(page).selectOption({ label: '总 token' });
    await expect(rowAt(page, 0)).toContainText(mostTokens?.title ?? '');
    await sortSelect(page).selectOption({ label: '费用' });
    await expect(rowAt(page, 0)).toContainText(dearest?.title ?? '');
    await direction.click();
    await expect(rowAt(page, 0)).toContainText(cheapest?.title ?? '');
  });

  test('folds the per-metric charts behind one button', async ({ page }) => {
    await page.goto('/?view=sessions');
    const sessions = rootSessions(await apiDashboard(page));
    const button = page.locator('main section header').getByRole('button', { name: '图表分析' });

    // Folded away by default: no charts until asked.
    expect(await page.locator('[data-chart]').count()).toBe(0);
    await button.click();

    const charts = page.locator('[data-chart]');
    const labels = (await charts.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-chart')))).filter(
      (key): key is string => key !== null,
    );
    for (const metric of ['requests', 'input', 'cacheRead', 'output', 'tokens', 'cost']) {
      expect(labels, `chart ${metric}`).toContain(metric);
    }
    // No cache-money chart (it is the I/C figure's money) and no recency chart
    // (timestamps do not add up to anything).
    expect(labels).not.toContain('cacheCost');
    expect(labels).not.toContain('recent');

    // The cost chart names the dearest session first, with its share of the list.
    const total = sessions.reduce((sum, session) => sum + Number(session.cost.total), 0);
    const dearest = [...sessions].sort((left, right) => Number(right.cost.total) - Number(left.cost.total))[0];
    const costChart = page.locator('[data-chart="cost"]');
    const rows = await costChart.locator('li').allInnerTexts();
    expect(rows[0]).toContain(dearest?.title ?? '');
    expect(rows[0]).toContain(((Number(dearest?.cost.total ?? 0) / total) * 100).toFixed(1));

    // And it folds back.
    await page.locator('main section header').getByRole('button', { name: '收起图表' }).click();
    expect(await page.locator('[data-chart]').count()).toBe(0);
  });

  test('opens one metric over every entry behind 展示更多', async ({ page }) => {
    await page.goto('/?view=sessions');
    const sessions = rootSessions(await apiDashboard(page)).filter((session) => session.requests > 0);
    test.skip(sessions.length === 0, 'no session with requests');
    await page.locator('main section header').getByRole('button', { name: '图表分析' }).click();

    // The card itself stays short.
    const card = page.locator('[data-chart="requests"]');
    const cardRows = await card.locator('li').allInnerTexts();
    expect(cardRows.length).toBe(Math.min(6, sessions.length));

    await card.getByRole('button', { name: /展示更多/ }).click();
    const dialog = page.locator('[data-metric-dialog="requests"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`全部 ${sessions.length} 项`);

    // Every entry, biggest first, no "其余 N 项合计" left behind.
    const shares = await dialog
      .locator('li')
      .evaluateAll((nodes) =>
        nodes.map((node) => Number(/([\d.]+)%/.exec(node.getAttribute('title') ?? '')?.[1] ?? '0')),
      );
    expect(shares.length).toBe(sessions.length);
    expect(shares).toEqual([...shares].sort((left, right) => right - left));
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeGreaterThan(99);
    expect(await dialog.innerText()).not.toContain('其余');

    // It fits the viewport instead of hanging off it.
    const box = await dialog.boundingBox();
    expect(box?.y ?? 0).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 1);

    // Escape and the close button both dismiss it.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await card.getByRole('button', { name: /展示更多/ }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('each row draws its own composition, including reasoning', async ({ page }) => {
    await page.goto('/?view=sessions');
    const sessions = rootSessions(await apiDashboard(page));
    const withReasoning = sessions.filter((session) => session.tokens.reasoning > 0)[0];

    const segments = async (index: number): Promise<{ width: number; title: string }[]> =>
      page.locator('main ol > li').nth(index).evaluate((row) =>
        [...row.querySelectorAll('span')]
          .filter((span) => span.style.backgroundColor.length > 0 && span.style.width.length > 0)
          .map((span) => ({ width: Number(span.style.width.replace('%', '')), title: span.getAttribute('title') ?? '' })),
      );

    const all = await segments(0);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const sum = all.reduce((total, segment) => total + segment.width, 0);
    expect(sum).toBeGreaterThan(99);
    expect(sum).toBeLessThan(101);

    if (withReasoning !== undefined) {
      const index = sessions.map((session) => session.title).indexOf(withReasoning.title);
      const found = await segments(Math.max(0, index));
      expect(found.map((segment) => segment.title.slice(0, 2))).toContain('R ');
      // Reasoning is billed out of the output, so the row shows it as its own chip.
      expect((await rowChips(page, Math.max(0, index))).join(' ')).toMatch(/R[\d.,]+万?¥/);
    }
  });

  test('expands one session into every bucket, with money', async ({ page }) => {
    await page.goto('/?view=sessions');
    const first = rowAt(page, 0);
    await first.locator('[role="button"]').first().click();

    const detail = page.locator('main ol > li').first();
    const buckets = await detail.locator('table tbody tr').allInnerTexts();
    expect(buckets.join(' ')).toContain('I/M');
    expect(buckets.join(' ')).toContain('I/C');
    expect(buckets.join(' ')).toContain('合计');
    expect((buckets.join(' ').match(/¥/g) ?? []).length).toBeGreaterThanOrEqual(4);

    const sessions = rootSessions(await apiDashboard(page));
    const first0 = [...sessions].sort((left, right) => Number(right.cost.total) - Number(left.cost.total))[0];
    expect(buckets.join(' ')).toContain(first0?.cost.total ?? '');
    await expect(detail.getByRole('link', { name: /打开会话详情/ })).toBeVisible();

    await first.locator('[role="button"]').first().click();
    await expect(page.locator('main ol > li').first().locator('table')).toHaveCount(0);
  });

  test('still offers the column view for anyone who wants it', async ({ page }) => {
    await page.goto('/?view=sessions');
    await page.locator('main section header').getByRole('button', { name: '表格视图' }).click();
    const table = page.locator('main section table').first();
    await expect(table).toBeVisible();
    const head = (await page.locator('main section thead th').allInnerTexts()).map((cell) =>
      cell.replace(/[↕▼▲]/g, '').trim(),
    );
    for (const column of ['会话', '项目', 'agent', 'Q', 'I/M', 'I/C', 'O', 'T', '费用']) {
      expect(head, `column ${column}`).toContain(column);
    }
  });

  test('the overview ranks the dearest sessions and links to the list', async ({ page }) => {
    await page.goto('/');
    const sessions = rootSessions(await apiDashboard(page));
    const dearest = [...sessions].sort((left, right) => Number(right.cost.total) - Number(left.cost.total))[0];
    const card = cardStartingWith(page, '会话（前五）');
    await expect(card.locator('ol > li')).toHaveCount(Math.min(5, sessions.length));
    await expect(card.locator('ol > li').first()).toContainText(dearest?.title ?? '');
    await card.getByRole('link', { name: /全部 .* 个/ }).click();
    await expect(page).toHaveURL(/view=sessions/);
  });
});

test.describe('layout', () => {
  /** Two cards must line up on the left, have the same width, and stack. */
  async function expectStacked(page: Page, above: string, below: string): Promise<void> {
    const first = await cardOf(page, above).boundingBox();
    const second = await cardOf(page, below).boundingBox();
    expect(first, `${above} is on screen`).not.toBeNull();
    expect(second, `${below} is on screen`).not.toBeNull();
    if (first === null || second === null) return;
    expect(Math.abs(first.x - second.x), 'same left edge').toBeLessThanOrEqual(1);
    expect(Math.abs(first.width - second.width), 'same width').toBeLessThanOrEqual(1);
    expect(second.y, `${below} starts below ${above}`).toBeGreaterThanOrEqual(first.y + first.height - 1);
  }

  test('the model and band tables are stacked in their own tab', async ({ page }) => {
    await page.goto('/?view=models');
    await expectStacked(page, '模型明细', '计价区间明细');
  });

  test('a session stacks its own detail tables too', async ({ page }) => {
    await page.goto('/');
    const project = (await twoProjects(page))[0];
    if (project === undefined) return;
    await openSession(page, project.name);
    await expect(cardOf(page, '本会话模型明细')).toBeVisible();
    await expectStacked(page, '本会话模型明细', '本会话计价区间');
  });

  test('the summary tables fit at 1440, the wide ones scroll inside their card', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const [view, title] of [
      ['overview', '构成'],
      ['usage', '这部分的用量'],
      ['usage', '按 agent 分列'],
    ] as const) {
      await page.goto(`/?view=${view}`);
      const card = cardStartingWith(page, title);
      await expect(card.locator('table').first()).toBeVisible();
      const measured = await card
        .locator('table')
        .first()
        .evaluate((table) => ({ table: table.scrollWidth, wrapper: table.parentElement?.clientWidth ?? 0 }));
      expect(measured.table, `${view}/${title} fits its card`).toBeLessThanOrEqual(measured.wrapper + 1);
    }

    // The optional table view carries a dozen columns; at 1440 it scrolls inside
    // its own card (which is the point of keeping it optional), and the page
    // itself must never scroll sideways. The default leaderboard has no table.
    await page.goto('/?view=sessions');
    await page.locator('main section header').getByRole('button', { name: '表格视图' }).click();
    const measured = await page
      .locator('main section table')
      .first()
      .evaluate((table) => ({ table: table.scrollWidth, wrapper: table.parentElement?.clientWidth ?? 0 }));
    expect(measured.table).toBeGreaterThan(0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, 'the page stays inside the window').toBeLessThanOrEqual(1);
  });

  test('no width makes the page scroll sideways', async ({ page }) => {
    for (const width of [1600, 1280, 1024, 820, 500]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      const overflow = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        window: window.innerWidth,
      }));
      expect(overflow.page, `${width}px: the page must not scroll sideways`).toBeLessThanOrEqual(overflow.window + 1);
    }
  });

  test('the tree keeps one line per row, with the full line on hover', async ({ page }) => {
    await page.goto('/');
    const hint = await page.locator('aside [title*="I/M"]').first().getAttribute('title');
    expect(hint ?? '').toContain('I/T');
    expect(hint ?? '').toContain('Q ');
    // The compact sidebar row shows money and tokens only: requests are the least
    // useful figure there, and the boards keep them.
    const row = await page.locator('aside button').filter({ hasText: 'tok' }).first().innerText();
    expect(row).toContain('tok');
    expect(row).not.toContain('req');
    // The sidebar must not have grown a ten-figure line: its rows stay short.
    const rows = await page.locator('aside button').allInnerTexts();
    expect(Math.max(...rows.map((row) => row.split('\n').length))).toBeLessThanOrEqual(8);
  });
});
