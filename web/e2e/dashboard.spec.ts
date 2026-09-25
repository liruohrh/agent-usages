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

  test('lists projects with their share, and opens one on click', async ({ page }) => {
    await page.goto('/');
    const dashboard = await apiDashboard(page);
    const card = cardOf(page, '项目花费');
    await expect(card).toBeVisible();
    const links = card.locator('a[href^="/p/"]');
    expect(await links.count()).toBeGreaterThan(0);
    // The ranking is by spend, whatever order the API listed the projects in.
    const dearest = [...dashboard.projects].sort((left, right) => Number(right.cost.total) - Number(left.cost.total))[0];
    await links.first().click();
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
    const table = cardStartingWith(page, '会话');
    await expect(table.locator('tbody tr')).toHaveCount(roots.length);

    await table.getByRole('button', { name: '合并子代理' }).click();
    await expect(table.locator('tbody tr')).toHaveCount(project.sessionReports.length);
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
    await table.getByRole('button', { name: '金额' }).click();
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
    await selectProject(page, project.name);

    const link = page.locator('main a[href^="/s/"]').first();
    test.skip((await link.count()) === 0, 'no billed session to open');
    const href = (await link.getAttribute('href')) ?? '/';
    const uid = decodeURIComponent(href.replace('/s/', ''));
    await link.click();

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

test.describe('the session comparison', () => {
  test('lists every session with the columns that explain the money', async ({ page }) => {
    await page.goto('/?view=sessions');
    const sessions = rootSessions(await apiDashboard(page));
    const table = cardStartingWith(page, '会话');
    await expect(table.locator('tbody tr')).toHaveCount(sessions.length);

    // Every indicator is on screen by default — hiding buckets behind a toggle is
    // what made the comparison view useless.
    const head = (await table.locator('thead th').allInnerTexts()).map((cell) => cell.replace(/[↕▼▲]/g, '').trim());
    for (const column of ['会话', '项目', 'agent', 'Q', 'I/M', 'I/C', 'O', 'T', '缓存金额', '费用', '最后使用']) {
      expect(head, `column ${column}`).toContain(column);
    }

    // Default order is cost, dearest first — the first question a reader has.
    const dearest = [...sessions].sort((left, right) => Number(right.cost.total) - Number(left.cost.total))[0];
    await expect(table.locator('tbody tr').first()).toContainText(dearest?.title ?? dearest?.id ?? '');
  });

  test('sorts by cost, tokens and cache money on click', async ({ page }) => {
    await page.goto('/?view=sessions');
    const sessions = rootSessions(await apiDashboard(page));
    const table = cardStartingWith(page, '会话');
    const firstRow = (): Locator => table.locator('tbody tr').first();
    const header = (label: string): Locator =>
      table.locator('thead th').filter({ has: page.getByRole('button', { name: new RegExp(`^${label}`) }) }).locator('button');

    const byCostDesc = [...sessions].sort((left, right) => Number(right.cost.total) - Number(left.cost.total))[0];
    const byCostAsc = [...sessions].sort((left, right) => Number(left.cost.total) - Number(right.cost.total))[0];
    const byTokens = [...sessions].sort((left, right) => billed(right) - billed(left))[0];
    const byCacheMoney = [...sessions].sort(
      (left, right) => Number(right.cost.cacheHitInputCost) - Number(left.cost.cacheHitInputCost),
    )[0];

    // 费用 is the default sort; one click flips it, the next flips it back.
    await expect(firstRow()).toContainText(byCostDesc?.title ?? '');
    await header('费用').click();
    await expect(firstRow()).toContainText(byCostAsc?.title ?? '');
    await header('费用').click();
    await expect(firstRow()).toContainText(byCostDesc?.title ?? '');

    // Tokens: the session with the most billed tokens comes first.
    await header('T').click();
    await expect(firstRow()).toContainText(byTokens?.title ?? '');

    // Cache money: same, on the cache column.
    await header('缓存金额').click();
    await expect(firstRow()).toContainText(byCacheMoney?.title ?? '');
  });

  test('can be reduced to the main columns, then restored', async ({ page }) => {
    await page.goto('/?view=sessions');
    const table = cardStartingWith(page, '会话');
    const head = async (): Promise<string[]> =>
      (await table.locator('thead th').allInnerTexts()).map((cell) => cell.replace(/[↕▼▲]/g, '').trim());

    await table.getByRole('button', { name: '精简列' }).click();
    const compact = await head();
    expect(compact).toContain('Q');
    expect(compact).not.toContain('I/M');
    await table.getByRole('button', { name: '全部列' }).click();
    expect(await head()).toContain('I/M');
  });

  test('the overview ranks the dearest sessions and links to the table', async ({ page }) => {
    await page.goto('/');
    const sessions = rootSessions(await apiDashboard(page));
    const card = cardStartingWith(page, '花费最多的会话');
    await expect(card).toBeVisible();
    const dearest = [...sessions].sort((left, right) => Number(right.cost.total) - Number(left.cost.total))[0];
    await expect(card.locator('tbody tr').first()).toContainText(dearest?.title ?? '');
    await expect(card.locator('tbody tr')).toHaveCount(Math.min(8, sessions.length));
    await card.getByRole('link', { name: /全部 .* 个会话/ }).click();
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
    await selectProject(page, project.name);
    const link = page.locator('main a[href^="/s/"]').first();
    test.skip((await link.count()) === 0, 'no billed session to open');
    await link.click();
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

    // The comparison table carries twelve columns; at 1440 it scrolls inside its
    // own card, and the page itself must never scroll sideways.
    await page.goto('/?view=sessions');
    const measured = await cardStartingWith(page, '会话')
      .locator('table')
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
    // The sidebar must not have grown a ten-figure line: its rows stay short.
    const rows = await page.locator('aside button').allInnerTexts();
    expect(Math.max(...rows.map((row) => row.split('\n').length))).toBeLessThanOrEqual(8);
  });
});
