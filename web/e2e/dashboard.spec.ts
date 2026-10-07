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
  /** The same money in the currency the price list published. */
  money?: { original: { currency: string; amount: string }; display: { currency: string; amount: string } } | undefined;
}

interface ApiSession {
  uid: string;
  id: string;
  title: string | null;
  agent: string;
  isSubagent: boolean;
  parentId: string | null;
  workspace: string;
  cwd: string | null;
  /** Absolute path of the session's own log file, when the agent reports one. */
  sourceFile?: string | undefined;
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
  currency: string;
  subtotals?: {
    table: string;
    tableLabel: string;
    currency: string;
    requests: number;
    original: string;
    display: string;
    money: { original: { currency: string; amount: string }; display: { currency: string; amount: string } };
  }[];
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
const AGENT_LABELS: Record<string, string> = { dsh: 'DSH', pi: 'pi', claudecode: 'Claude', codex: 'Codex' };

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

/** What the page's clipboard holds right now. */
async function clipboardOf(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

interface ApiSeriesPoint {
  t: number;
  label: string;
  requests: number;
}

/** The time series the page itself fetches, for one grid. */
async function apiSeries(page: Page, bucket: string): Promise<{ bucket?: string; points: ApiSeriesPoint[] }> {
  return page.evaluate(async (grid) => (await fetch(`/api/timeseries?bucket=${grid}`)).json(), bucket) as Promise<{
    bucket?: string;
    points: ApiSeriesPoint[];
  }>;
}

/** The host div ECharts drew into, with the instance the wrapper keeps on it. */
async function seriesHost(page: Page): Promise<{ categories: number } & Record<string, unknown>> {
  return page.evaluate(() => {
    // ECharts nests its own div (and the canvas) inside the host, so walk up
    // until the element the wrapper marked is found.
    let node = document.querySelector('main canvas')?.parentElement as
      | (HTMLDivElement & { chartInstance?: { getOption: () => { xAxis?: { data?: unknown[] }[] } } })
      | null
      | undefined;
    while (node != null && node.chartInstance === undefined) node = node.parentElement as typeof node;
    const option = node?.chartInstance?.getOption();
    return { categories: option?.xAxis?.[0]?.data?.length ?? 0 };
  }) as Promise<{ categories: number } & Record<string, unknown>>;
}

/** How many categories the drawn chart currently has. */
async function seriesCategories(page: Page): Promise<number> {
  return (await seriesHost(page)).categories;
}

/**
 * Click one drawn data point, through the real ECharts handler.
 *
 * The chart is a canvas, so a Playwright locator cannot address a point: the
 * pixel is asked of the instance the wrapper keeps on its host div, and the
 * click is then a real mouse click at that pixel — the same event a reader
 * produces, so the drill path under test is the one that ships.
 */
async function clickSeriesPoint(page: Page, index: number): Promise<void> {
  // The chart draws once the series arrives; a click before that lands on an
  // empty canvas and does nothing, which is a flaky failure rather than a bug.
  await expect.poll(async () => seriesCategories(page), { timeout: 15_000 }).toBeGreaterThan(index);
  const canvas = page.locator('main canvas').first();
  const box = await canvas.boundingBox();
  const spot = await page.evaluate((at) => {
    let node = document.querySelector('main canvas')?.parentElement as
      | (HTMLDivElement & {
          chartInstance?: {
            getOption: () => { series?: { data?: number[] }[] };
            convertToPixel: (finder: Record<string, number>, value: number) => number;
          };
        })
      | null
      | undefined;
    while (node != null && node.chartInstance === undefined) node = node.parentElement as typeof node;
    const chart = node?.chartInstance;
    if (chart === undefined) return null;
    const series = chart.getOption().series ?? [];
    // Any series will do: the handler asks which bucket was hit, not which line.
    const hit = series.find((entry) => Number(entry.data?.[at] ?? 0) > 0) ?? series[series.length - 1];
    const value = Number(hit?.data?.[at] ?? 0);
    return { x: chart.convertToPixel({ xAxisIndex: 0 }, at), y: chart.convertToPixel({ yAxisIndex: 0 }, value) };
  }, index);
  if (box === null || spot === null) throw new Error('the chart is not on screen');
  // Move first, then click: the same two events a reader produces, and the
  // hover pass is what ECharts uses to resolve a symbol under the pointer.
  await page.mouse.move(box.x + spot.x, box.y + spot.y);
  await page.mouse.click(box.x + spot.x, box.y + spot.y);
}

/**
 * Every session in the payload whose agent named its log file.
 *
 * The button is only offered where there is a path to copy, so a test about it
 * has to pick one of those — or skip, when the data at hand (the tracked
 * synthetic fixture, say) predates the field.
 */
function sessionsWithLogFile(dashboard: ApiDashboard): ApiSession[] {
  return dashboard.projects
    .flatMap((project) => project.sessionReports)
    .filter((session) => typeof session.sourceFile === 'string' && session.sourceFile.length > 0);
}

/** The two projects a switching test uses, or a skip when there are fewer. */
async function twoProjects(page: Page): Promise<ApiDashboard['projects']> {
  const dashboard = await apiDashboard(page);
  test.skip(dashboard.projects.length < 2, 'needs two projects to switch between');
  return dashboard.projects.slice(0, 2);
}

test.describe('the overview', () => {
  test('leads with four figures, in the order a reader asks for them', async ({ page }) => {
    await page.goto('/');
    const dashboard = await apiDashboard(page);
    const cards = page.locator('main div.grid > div.rounded-xl');
    await expect(cards).toHaveCount(4);
    const texts = (await cards.allInnerTexts()).join(' ');
    // The money card names itself: the amount carries the currency symbol, so no
    // column heading and no card label spell it out.
    expect(texts).not.toContain('费用');
    expect(texts).not.toContain('金额');
    // The card groups thousands, so compare the digits rather than the spelling.
    expect(texts.replace(/,/g, '')).toContain(dashboard.totals.cost.total);

    // Money, `T`, `I/C`, `Q` — and each card says one thing: the buckets and
    // their money belong to the composition card below, not to a card's hint.
    const labels = await cards.evaluateAll((nodes) =>
      nodes.map((node) => (node.innerText.split('\n')[0] ?? '').trim()),
    );
    expect(labels[0]).toContain('¥');
    expect(labels.slice(1)).toEqual(['T', 'I/C 缓存', 'Q']);
    const lines = await cards.evaluateAll((nodes) =>
      nodes.map((node) =>
        node.innerText
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    );
    // Money has no label (2 lines: amount, currency); `T` and `I/C` have a label
    // and a number and nothing else — the buckets belong to the composition card
    // below; `Q` keeps its session count (and appends an unpriced note when the
    // data has records no price list covers).
    expect(lines.slice(0, 3).map((card) => card.length)).toEqual([2, 2, 2]);
    expect(lines[3]?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(lines[1]?.[0]).toBe('T');
    expect(lines[1]?.[1]).toMatch(/[\d万亿KMB.,]/);
    expect(lines[2]?.[0]).toBe('I/C 缓存');
    expect(lines[2]?.[1]).toMatch(/%$/);
  });

  test('shows where the tokens and the money went', async ({ page }) => {
    await page.goto('/');
    const card = cardOf(page, '构成');
    await expect(card).toBeVisible();
    const labels = (await card.locator('table tbody tr').allInnerTexts()).join(' ');
    expect(labels).toContain('I/M');
    expect(labels).toContain('I/C');
    // The full names live in the hover text, not on the screen: one vocabulary.
    const names = await card.locator('table tbody tr td span[title]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('title') ?? ''),
    );
    expect(names).toContain('未命中缓存输入');
    expect(names).toContain('缓存命中输入');
  });

  test('draws the series on five grids', async ({ page }) => {
    await page.goto('/');
    await expect(cardOf(page, '时间序列')).toBeVisible();
    const grids: [string, string][] = [
      ['按小时', 'hour'],
      ['按天', 'day'],
      ['按周', 'week'],
      ['按月', 'month'],
      ['按年', 'year'],
    ];
    for (const [label, grid] of grids) {
      const button = cardOf(page, '时间序列').getByRole('button', { name: label, exact: true });
      await expect(button, `${label} is offered`).toHaveCount(1);
      await button.click();
      await expect(button, `${label} is the active grid`).toHaveAttribute('aria-pressed', 'true');
      // The grid the page asked for is the grid the server answered with.
      const answer = (await apiSeries(page, grid)) as { bucket?: string };
      expect(answer.bucket, `${grid} comes back labelled`).toBe(grid);
      await expect.poll(async () => seriesCategories(page)).toBeGreaterThan(0);
    }
  });

  test('a click on a bucket opens the next finer grid', async ({ page }) => {
    await page.goto('/');
    // The chart plots what the API returned; pick the newest day that the hourly
    // grid still covers, so the drill has hours to show.
    const days = (await apiSeries(page, 'day')).points;
    const hours = (await apiSeries(page, 'hour')).points;
    const covered = new Set(hours.map((point) => new Date(point.t).toDateString()));
    const index = days.findLastIndex((point) => point.requests > 0 && covered.has(new Date(point.t).toDateString()));
    test.skip(index < 0, 'no day inside the hourly window to drill into');
    const target = days[index];
    if (target === undefined) return;

    const before = await seriesCategories(page);
    await clickSeriesPoint(page, index);

    // The grid steps down, the window narrows to that day, and the way back is
    // on screen rather than remembered.
    const hourly = cardOf(page, '时间序列').getByRole('button', { name: '按小时', exact: true });
    await expect(hourly).toHaveAttribute('aria-pressed', 'true');
    await expect(cardOf(page, '时间序列').getByText(/^窗口 /)).toBeVisible();
    await expect.poll(async () => seriesCategories(page)).toBeLessThan(before);
    const narrowed = await seriesCategories(page);
    expect(narrowed).toBeGreaterThan(0);
    expect(narrowed).toBeLessThanOrEqual(24);

    // Clearing puts the reader back on the grid they came from.
    await cardOf(page, '时间序列').getByRole('button', { name: /清除窗口/ }).click();
    await expect(cardOf(page, '时间序列').getByRole('button', { name: '按天', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect.poll(async () => seriesCategories(page)).toBe(before);
  });

  test('a click on a month narrows to that month, day by day', async ({ page }) => {
    await page.goto('/');
    await cardOf(page, '时间序列').getByRole('button', { name: '按月', exact: true }).click();
    const months = (await apiSeries(page, 'month')).points;
    const index = months.findLastIndex((point) => point.requests > 0);
    test.skip(index < 0, 'no month with usage to drill into');
    await clickSeriesPoint(page, index);
    // The drill steps straight to days: a week is a grid one can ask for, not a
    // step the click inserts.
    await expect(cardOf(page, '时间序列').getByRole('button', { name: '按天', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(cardOf(page, '时间序列').getByText(/^窗口 /)).toBeVisible();
    // The window is that month, so the days drawn are exactly the days of it.
    const month = months[index];
    const daysInMonth = (await apiSeries(page, 'day')).points.filter(
      (point) => point.t >= (month?.t ?? 0) && point.t < (month?.t ?? 0) + 31 * 24 * 60 * 60 * 1000,
    );
    expect(daysInMonth.length).toBeGreaterThan(0);
    await expect.poll(async () => seriesCategories(page)).toBe(daysInMonth.length);
  });

  test('the chart has a fullscreen button that follows the document', async ({ page }) => {
    await page.goto('/');
    const button = cardOf(page, '时间序列').getByRole('button', { name: '全屏', exact: true });
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('title', '全屏');
    const section = cardOf(page, '时间序列');
    await button.click();
    // Element fullscreen needs a user gesture and a browser that grants it; the
    // click above is one. When the browser refuses, the button must at least not
    // have lied about the state.
    const entered = await page.evaluate(() => document.fullscreenElement !== null);
    if (entered) {
      // The label follows the document (this is the `fullscreenchange` sync),
      // and the button is the way out; Esc is the browser's business and is not
      // routed to a headless element reliably enough to assert here.
      const exit = section.getByRole('button', { name: '退出全屏', exact: true });
      await expect(exit).toBeVisible();
      await exit.click();
      await expect.poll(async () => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
      await expect(section.getByRole('button', { name: '全屏', exact: true })).toBeVisible();
    } else {
      await expect(button).toHaveAttribute('aria-label', '全屏');
    }
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

  test('shows each price list beside the currency it published', async ({ page }) => {
    await page.goto('/?view=models');
    await expect(cardOf(page, '模型明细')).toBeVisible();
    const dashboard = await apiDashboard(page);
    const subtotals = dashboard.subtotals ?? [];
    // The tracked synthetic fixture predates the field; the local snapshot has it.
    test.skip(subtotals.length === 0, 'this snapshot carries no per-price-list rows');
    // One list quoted in the display currency says nothing the total line has not,
    // so the page leaves the block out — and there is no row to compare against.
    test.skip(
      subtotals.length === 1 && subtotals[0]?.currency === dashboard.currency,
      'a single price list in the display currency is not drawn',
    );

    const rows = await rowsOf(page, '按表小计');
    expect(rows, 'one row per (price list, currency)').toHaveLength(subtotals.length);
    for (const entry of subtotals) {
      const row = rows.find((cells) => cells.some((cell) => cell.includes(entry.tableLabel)));
      expect(row, `a row names ${entry.tableLabel}`).toBeDefined();
      if (row === undefined) continue;
      // The published column is the vendor's own number, to the cent.
      expect(numberOf(row[1] ?? ''), `${entry.tableLabel} published`).toBeCloseTo(Number(entry.original), 2);
      // The converted column is filled in only where the currencies differ.
      if (entry.currency === dashboard.currency) expect(row[2] ?? '').toContain('—');
      else expect(numberOf(row[2] ?? ''), `${entry.tableLabel} converted`).toBeCloseTo(Number(entry.display), 2);
    }
    // The converted column adds up to the total the header prints.
    const converted = subtotals.reduce((sum, row) => sum + Number(row.money.display.amount), 0);
    expect(converted.toFixed(4)).toBe(Number(dashboard.totals.cost.total).toFixed(4));

    // A model row whose list is quoted in another currency carries the published
    // amount as a secondary value; the API says which models those are. One model
    // may have a row per project, so compare against the set of its rows.
    const dual = dashboard.models.find(
      (row) => row.money !== undefined && row.money.original.currency !== row.money.display.currency,
    );
    test.skip(dual === undefined, 'every model in this run is quoted in the display currency');
    if (dual === undefined) return;
    const money = dual.money as NonNullable<ApiRow['money']>;
    const modelRows = await rowsOf(page, '模型明细');
    const sameModel = modelRows.filter((cells) => cells[1] === dual.model);
    expect(sameModel.length, `the rows for ${dual.model} exist`).toBeGreaterThan(0);
    // The money cell now holds two amounts (display, then published), so read
    // every number out of the cells rather than one per cell.
    const shown = sameModel.flatMap((cells) =>
      cells.flatMap((cell) => (cell.match(/[\d][\d,.]*/g) ?? []).map(numberOf)),
    );
    expect(shown.some((value) => Math.abs(value - Number(money.display.amount)) < 0.01), 'display amount').toBe(true);
    // The published amount is the vendor's, printed as small print with the full
    // text in its `title`.
    const titled = await cardOf(page, '模型明细')
      .locator('tbody tr')
      .filter({ hasText: dual.model })
      .locator('[title]')
      .evaluateAll((nodes) => nodes.map((node) => (node.getAttribute('title') ?? '') + ' ' + (node.textContent ?? '')));
    const published = titled.flatMap((text) => (text.match(/[\d][\d,.]*/g) ?? []).map(numberOf));
    expect(published.some((value) => Math.abs(value - Number(money.original.amount)) < 0.01), 'published amount').toBe(true);
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
    await sortSelect(page).selectOption({ label: 'T' });
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
    for (const column of ['agent', '会话（子）', 'Q', 'I/M', 'I/C', 'I/T', 'O', 'O/T', 'T', '占比']) {
      expect(detailed, `column ${column}`).toContain(column);
    }
    // The money column has no heading: its cells are `¥` amounts.
    expect(detailed).not.toContain('费用');
    const moneyHead = table.locator('thead th').nth(detailed.indexOf('T') + 1);
    expect((await moneyHead.innerText()).trim()).toBe('');
    expect(await moneyHead.getAttribute('title')).toBeTruthy();

    await table.getByRole('button', { name: '精简列' }).click();
    const summary = (await table.locator('thead th').allInnerTexts()).map((cell) => cell.trim());
    expect(summary).toEqual(['agent', '会话（子）', 'Q', 'T', '', '占比']);
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

  test('copies the log file path and the workspace from its header', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // The payload is fetched from the page, so the page has to exist first.
    await page.goto('/');
    const named = sessionsWithLogFile(await apiDashboard(page));
    test.skip(named.length === 0, 'no session reports a log file (the fixture predates the field)');
    const chosen = named[0] as ApiSession;
    await page.goto(`/s/${encodeURIComponent(chosen.uid)}`);

    // The header shows the file and offers it on the clipboard: the whole point is
    // to paste this path into a terminal or an editor.
    const logButton = page.getByRole('button', { name: '复制日志文件路径' });
    await expect(logButton).toBeVisible();
    await expect(logButton).toHaveAttribute('aria-label', '复制日志文件路径');
    await expect(logButton).toHaveAttribute('title', new RegExp(chosen.sourceFile?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? ''));
    await logButton.click();
    await expect(logButton).toHaveAttribute('data-copy-state', 'copied');
    expect(await clipboardOf(page)).toBe(chosen.sourceFile);

    // Where it ran is one more path worth having, and it is on the same header.
    const workspace = chosen.cwd ?? chosen.workspace;
    const workspaceButton = page.getByRole('button', { name: '复制工作目录' });
    await expect(workspaceButton).toBeVisible();
    await workspaceButton.click();
    expect(await clipboardOf(page)).toBe(workspace);
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
    // The totals are the header's `Q` / `T` / 费用 columns, not chips.
    expect(chips.join(' ')).not.toContain('费用');
    const columns = await page
      .locator('[data-columns]')
      .first()
      .evaluate((row) => [...row.children].map((cell) => (cell.textContent ?? '').trim()));
    expect(columns.slice(-3)).toEqual(['Q', 'T', '']);

    const dearest = [...sessions].sort((left, right) => Number(right.cost.total) - Number(left.cost.total))[0];
    await expect(rowAt(page, 0)).toContainText(dearest?.title ?? '');
    const [requests, tokens, cost] = await rowFigures(page, 0);
    const close = (shown: number | undefined, actual: number | undefined): number =>
      Math.abs((shown ?? 0) - (actual ?? 0)) / Math.max(1, actual ?? 1);
    expect(requests).toBe(dearest?.requests);
    expect(close(tokens, dearest ? billed(dearest) : 0)).toBeLessThan(0.02);
    expect(close(cost, Number(dearest?.cost.total ?? 0))).toBeLessThan(0.01);
  });

  test('copies a row’s log path without opening the row', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/?view=sessions');
    const sessions = rootSessions(await apiDashboard(page));
    const named = sessions.filter((session) => typeof session.sourceFile === 'string' && session.sourceFile.length > 0);
    test.skip(named.length === 0, 'no session reports a log file (the fixture predates the field)');

    // Which rows offer the button is data-dependent, so the row is found by the
    // path its button carries rather than by position.
    const buttons = page.locator('main ol > li button[data-copy-path]');
    const paths = await buttons.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-copy-path')));
    const index = paths.findIndex((path) => named.some((session) => session.sourceFile === path));
    expect(index, 'at least one row copies a path the API reports').toBeGreaterThanOrEqual(0);
    const button = buttons.nth(index);
    await expect(button).toHaveAttribute('aria-label', '复制日志文件路径');
    await button.click();
    await expect(button).toHaveAttribute('data-copy-state', 'copied');
    expect(await clipboardOf(page)).toBe(paths[index]);
    // Copying is not selecting: the row's own expansion stays closed.
    await expect(rowAt(page, index).locator('table')).toHaveCount(0);
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
    await sortSelect(page).selectOption({ label: 'T' });
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
    // Compare the share as a number: the page trims a trailing `.0` (`40.0%` is
    // drawn as `40%`), and which one it is depends on the data.
    const shownShare = Number(((rows[0]?.match(/([\d.]+)%/) ?? [])[1] ?? 'NaN'));
    expect(Math.abs(shownShare - (Number(dearest?.cost.total ?? 0) / total) * 100)).toBeLessThan(0.1);

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

    // Every entry, biggest first, no "其余 N 项合计" left behind. Each entry is
    // two lines: the bar row (the one carrying `title`) and the chip row under
    // it, indented.
    const barRows = dialog.locator('li[title]');
    const shares = await barRows.evaluateAll((nodes) =>
      nodes.map((node) => Number(/([\d.]+)%/.exec(node.getAttribute('title') ?? '')?.[1] ?? '0')),
    );
    expect(shares.length).toBe(sessions.length);
    expect(shares).toEqual([...shares].sort((left, right) => right - left));
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeGreaterThan(99);
    expect(await dialog.innerText()).not.toContain('其余');

    // Under each name, what else that entry is made of — the same buckets a
    // leaderboard row shows under its bar.
    const chipRows = dialog.locator('li:not([title])');
    await expect(chipRows).toHaveCount(sessions.length);
    const chips = await chipRows.first().innerText();
    expect(chips).toMatch(/I\/M|I\/C|O|R/);
    expect(chips).toContain('¥');
    const indented = await chipRows.first().evaluate((row) => {
      const style = getComputedStyle(row);
      return Number.parseFloat(style.paddingLeft) || 0;
    });
    expect(indented, 'the chip line is indented under the name').toBeGreaterThan(0);

    // It fits the viewport instead of hanging off it.
    const box = await dialog.boundingBox();
    expect(box?.y ?? 0).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) + 1);

    // Escape and the close button both dismiss it.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Charting a bucket leaves that bucket out of the line: the bar above it is
    // already showing the same figure.
    await page.locator('[data-chart="cacheRead"]').getByRole('button', { name: /展示更多/ }).click();
    const cacheDialog = page.locator('[data-metric-dialog="cacheRead"]');
    await expect(cacheDialog).toBeVisible();
    const cacheFirst = await cacheDialog.locator('li:not([title])').first().innerText();
    expect(cacheFirst).not.toMatch(/I\/C/);
    expect(cacheFirst).toMatch(/I\/M/);
    await page.keyboard.press('Escape');
    await expect(cacheDialog).toHaveCount(0);

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
      // The segments are named by definition on hover, not by abbreviation: the
      // abbreviation is what the row prints underneath.
      expect(found.map((segment) => segment.title.slice(0, 2))).toContain('思考');
      expect(found.map((segment) => segment.title.slice(0, 2))).toContain('输出');
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
    // The 合计 line is this session's money. Compare the numbers, not the strings:
    // the page trims trailing zeros (`58.3080` renders as `¥58.308`).
    const totalLine = buckets.find((line) => line.includes('合计')) ?? '';
    const shownCost = Number(((totalLine.match(/¥([\d.,]+)/) ?? [])[1] ?? '').replace(/,/g, ''));
    expect(shownCost).toBeCloseTo(Number(first0?.cost.total ?? '0'), 2);
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
    for (const column of ['会话', '项目', 'agent', 'Q', 'I/M', 'I/C', 'O', 'T']) {
      expect(head, `column ${column}`).toContain(column);
    }
    // The money column keeps sorting, but it is named only on hover.
    expect(head).not.toContain('费用');
    const moneyHead = page.locator('main section thead th').filter({ has: page.getByRole('button', { name: '总费用（每格都是它自己的钱）' }) });
    await expect(moneyHead).toHaveCount(1);
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

/** The parts of `/api/tools` the tool-call tab is asserted against. */
interface ApiTools {
  agents: {
    agent: string;
    calls: number;
    records: number;
    recordsWithCalls: number;
    ok: { true: number; false: number; unknown: number };
    bytes: number;
    tools: {
      name: string;
      calls: number;
      ok: { true: number; false: number; unknown: number };
      bytes: number;
      share: number;
    }[];
  }[];
  totals: {
    calls: number;
    records: number;
    recordsWithCalls: number;
    ok: { true: number; false: number; unknown: number };
    bytes: number;
  };
  unavailable?: boolean;
}

/** The tool report the page itself fetches — asked from the browser, same origin. */
async function apiTools(page: Page): Promise<ApiTools> {
  return page.evaluate(async () => (await fetch('/api/tools')).json()) as Promise<ApiTools>;
}

/** The zeroed report the server sends when the data carries no tool call. */
const NO_TOOL_CALLS = {
  agents: [],
  totals: { calls: 0, records: 0, recordsWithCalls: 0, ok: { true: 0, false: 0, unknown: 0 }, bytes: 0 },
};

test.describe('the tool-call tab', () => {
  test('is a tab of its own and shows the three outcomes as three columns', async ({ page }) => {
    await page.goto('/?view=tools');
    const tab = page.getByRole('button', { name: '工具调用' });
    await expect(tab).toBeVisible();
    await expect(tab).toHaveClass(/border-accent/);

    const tools = await apiTools(page);
    test.skip(tools.unavailable === true || tools.totals.calls === 0, 'this fixture records no tool call');
    const usage = tools.agents.find((agent) => agent.tools.length > 0);
    expect(usage, 'an agent with calls').toBeDefined();
    if (usage === undefined) return;

    // The card is headed by the agent's badge, whose `title` is the raw agent id
    // — the one handle that does not depend on the display-name mapping.
    const card = page
      .locator('section')
      .filter({ has: page.locator(`span[title="${usage.agent}"]`) })
      .first();
    await expect(card).toBeVisible();
    const head = (await card.locator('thead th').allInnerTexts()).map((cell) => cell.trim());
    // 未表态 is a column of its own: a verdict the log never wrote is not success.
    expect(head).toEqual(['工具', '调用', '占比', '成功', '失败', '未表态', '参数体量']);

    const top = usage.tools[0];
    const first = card.locator('tbody tr').first();
    await expect(first).toContainText(top?.name ?? '');
    // The row prints the payload's own figures, not a second computation.
    const cells = (await first.locator('td').allInnerTexts()).map((cell) => cell.trim());
    expect(numberOf(cells[1] ?? '')).toBe(top?.calls);
    expect(numberOf(cells[3] ?? '')).toBe(top?.ok.true);
    expect(numberOf(cells[4] ?? '')).toBe(top?.ok.false);
    expect(numberOf(cells[5] ?? '')).toBe(top?.ok.unknown);
  });

  test('the overview adds the outcome buckets up to the call count', async ({ page }) => {
    await page.goto('/?view=tools');
    const tools = await apiTools(page);
    test.skip(tools.unavailable === true || tools.totals.calls === 0, 'this fixture records no tool call');
    const { totals } = tools;
    // Each figure is its own tile, and the three verdicts partition the calls.
    for (const [label, value] of [
      ['成功', totals.ok.true],
      ['失败', totals.ok.false],
      ['未表态', totals.ok.unknown],
    ] as const) {
      const figure = page.getByText(label, { exact: true }).first().locator('xpath=following-sibling::div');
      await expect(figure).toBeVisible();
      expect(numberOf(await figure.innerText()), `${label} tile`).toBe(value);
    }
    expect(totals.ok.true + totals.ok.false + totals.ok.unknown).toBe(totals.calls);
  });

  test('an unavailable snapshot and an empty report say different things, and neither draws a table', async ({ page }) => {
    // 1) The file never carried tool data: the tab says so and shows nothing.
    await page.route('**/api/tools*', (route) =>
      route.fulfill({ json: { ...NO_TOOL_CALLS, unavailable: true } }),
    );
    await page.goto('/?view=tools');
    await expect(page.getByText('这份快照是旧格式，没有带工具调用数据')).toBeVisible();
    await expect(page.getByText('这些数据里没有记录到工具调用')).toHaveCount(0);
    await expect(page.locator('main table')).toHaveCount(0);

    // 2) The data is there and recorded nothing: a different sentence, still no table.
    await page.unroute('**/api/tools*');
    await page.route('**/api/tools*', (route) => route.fulfill({ json: NO_TOOL_CALLS }));
    await page.reload();
    await expect(page.getByText('这些数据里没有记录到工具调用')).toBeVisible();
    await expect(page.getByText('这份快照是旧格式，没有带工具调用数据')).toHaveCount(0);
    await expect(page.locator('main table')).toHaveCount(0);
  });

  test('at 500px the table scrolls inside its card instead of clipping', async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 900 });
    await page.goto('/?view=tools');
    const tools = await apiTools(page);
    test.skip(tools.unavailable === true || tools.totals.calls === 0, 'this fixture records no tool call');
    // The page itself must not scroll sideways...
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'no page-level horizontal overflow').toBeLessThanOrEqual(1);
    // ...because the table keeps a declared minimum width inside a scroll box.
    const measured = await page.locator('main table').first().evaluate((table) => ({
      scroll: table.scrollWidth,
      wrapper: table.parentElement?.clientWidth ?? 0,
      minWidth: getComputedStyle(table).minWidth,
    }));
    expect(measured.scroll, 'the table is wider than the viewport, not squeezed').toBeGreaterThan(measured.wrapper);
    expect(measured.minWidth, 'a minimum width is declared').not.toBe('0px');
  });

  test('a project scope does not offer the tab', async ({ page }) => {
    // `twoProjects` asks the page for the payload, so the page must be on the app.
    await page.goto('/');
    const projects = await twoProjects(page);
    const first = projects[0];
    if (first === undefined) return;
    await page.goto(`/p/${encodeURIComponent(first.id)}`);
    await expect(page.getByRole('button', { name: '工具调用' })).toHaveCount(0);
    // And the URL cannot reach it either: the tab falls back to the overview.
    await page.goto(`/p/${encodeURIComponent(first.id)}?view=tools`);
    await expect(page.getByRole('button', { name: '概览' })).toHaveClass(/border-accent/);
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
    // The compact sidebar row shows money and `T` only: requests are the least
    // useful figure there, and the boards keep them.
    const row = await page.locator('aside button').filter({ hasText: 'T ' }).first().innerText();
    expect(row).toContain('T ');
    expect(row).not.toContain('Q ');
    // The sidebar must not have grown a ten-figure line: its rows stay short.
    const rows = await page.locator('aside button').allInnerTexts();
    expect(Math.max(...rows.map((row) => row.split('\n').length))).toBeLessThanOrEqual(8);
  });
});

test.describe('the project tree', () => {
  test('copies a session’s log path without selecting or expanding its row', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    // The tree starts folded: open the first project, then its first workspace.
    await page.locator('aside button[aria-label="展开"]').first().click();
    await page.locator('aside button[aria-label="展开"]').first().click();
    test.skip(
      (await page.locator('aside button[data-copy-path]').count()) === 0,
      'no session in the tree reports a log file',
    );
    const button = page.locator('aside button[data-copy-path]').first();
    const path = await button.getAttribute('data-copy-path');

    // A 340px sidebar cannot afford a labelled button: the glyph stays invisible
    // until the row is hovered or the button is reached from the keyboard.
    await expect(button).toHaveCSS('opacity', '0');
    await expect(button).toHaveAttribute('aria-label', '复制日志文件路径');
    await button.hover();
    await expect(button).toHaveCSS('opacity', '1');

    // Copying is neither selecting the session nor expanding it: the row keeps the
    // class it had (a click on the row itself adds `bg-accent-soft`), and the
    // disclosure glyph does not change.
    const row = button.locator('..');
    const rowClass = await row.getAttribute('class');
    const glyph = await row.locator('button').first().innerText();
    await button.click();
    await expect(button).toHaveAttribute('data-copy-state', 'copied');
    expect(await clipboardOf(page)).toBe(path);
    expect(await row.getAttribute('class')).toBe(rowClass);
    expect(await row.locator('button').first().innerText()).toBe(glyph);
  });
});

test.describe('the language switch', () => {
  const kpis = (page: Page): Locator => page.locator('main div.grid > div.rounded-xl');

  test('switches the page, the numbers, and the file the CLI reads', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: '概览' })).toBeVisible();
    // Chinese compact notation: the numbers are part of the language, not just
    // the labels around them.
    await expect(kpis(page).first()).toContainText('¥');
    expect((await page.locator('main').innerText())).toMatch(/[亿万]/);

    await page.getByRole('button', { name: 'EN', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible();
    await expect
      .poll(async () => (await page.locator('main').innerText()).match(/[KMB]\b/)?.[0] ?? '')
      .toMatch(/[KMB]/);

    // The switch is not a browser preference: it wrote the configuration file,
    // and the server now speaks English without being asked.
    const settings = (await page.evaluate(async () => (await fetch('/api/settings')).json())) as {
      language: string;
      configured: string;
      path: string;
    };
    expect(settings.configured).toBe('en');
    expect(settings.language).toBe('en');
    // The scratch copy the tests run against — never a developer's own file.
    expect(settings.path).toContain('.tmp');

    // And back, so the rest of the suite and the next run start in Chinese.
    await page.getByRole('button', { name: '中文', exact: true }).click();
    await expect(page.getByRole('button', { name: '概览' })).toBeVisible();
    const after = (await page.evaluate(async () => (await fetch('/api/settings')).json())) as { configured: string };
    expect(after.configured).toBe('zh');
  });
});

test.describe('the settings page', () => {
  test('is reachable from the top bar', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('main section').first()).toBeVisible();
    await page.getByRole('button', { name: '配置', exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { name: '配置', exact: true })).toBeVisible();
  });

  test('edits the project declarations and writes the configuration file', async ({ page }) => {
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '配置', exact: true })).toBeVisible();
    const save = page.locator('[data-save-config]');
    // Opening the page is not a change.
    await expect(save).toBeDisabled();
    await expect(page.locator('[data-dirty]')).toHaveCount(0);

    // A new declaration: a name, and one of the workspaces this scan found.
    await page.getByRole('button', { name: '新建分组' }).click();
    await page.getByLabel('项目名').last().fill('demo-group');
    const picker = page.locator('[data-add-path]').last();
    const path = await picker.locator('option').nth(1).getAttribute('value');
    expect(path, 'a scanned workspace to add').toBeTruthy();
    await picker.selectOption(path!);
    // The path shows up in the group (and again in the reference list below).
    await expect(page.getByText(path!, { exact: true }).first()).toBeVisible();

    // Now it is a change, and the page says so until it is saved.
    await expect(page.locator('[data-dirty]')).toBeVisible();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.locator('[data-config-status]')).toBeVisible();
    await expect(page.locator('[data-dirty]')).toHaveCount(0);

    // The file itself now carries the declaration — and still carries the language
    // the switch wrote, because a patch merges rather than replaces.
    const stored = (await page.evaluate(async () => (await fetch('/api/config')).json())) as {
      config: { projects: { name: string; paths: string[] }[]; language: string | null };
      path: string;
    };
    expect(stored.path).toContain('.tmp');
    expect(stored.config.projects).toContainEqual({ name: 'demo-group', paths: [path] });
    expect(stored.config.language).toBe('zh');

    // Discarding puts the draft back to the file.
    await page.getByRole('button', { name: '新建分组' }).click();
    await expect(page.locator('[data-dirty]')).toBeVisible();
    await page.getByRole('button', { name: '放弃修改' }).click();
    await expect(page.locator('[data-dirty]')).toHaveCount(0);
    await expect(save).toBeDisabled();
  });
});

test.describe('the metric vocabulary', () => {
  /**
   * The names of the figures, in words, are definitions — they belong in a
   * `title` tooltip, in the docs and in `--help`, never in the text on screen.
   * The screen prints the CLI's abbreviations (`Q I/M I/C I/W I/T O R O/T T`),
   * so a figure on the page is recognisably the one in the terminal.
   */
  const IN_WORDS = [
    '未命中缓存输入',
    '缓存未命中输入',
    '未命中缓存的输入',
    '缓存命中输入',
    '缓存写入输入',
    '缓存读取',
    '输入（未命中缓存）',
    '输出（不含思考）',
    '输出（含思考）',
    '其中思考',
    '思考（含于输出）',
    '总 token',
    'tokens（计费桶）',
    '缓存命中率',
    '最后使用',
    '次请求',
    '请求数',
  ];

  /**
   * Wait for a screen to have drawn its data. The page is a single-page app:
   * `goto` resolves before the numbers arrive, and an empty page would pass the
   * checks below for the wrong reason.
   */
  async function waitForScreen(page: Page): Promise<void> {
    await expect(page.locator('main section').first()).toBeVisible();
    await expect(page.locator('main')).not.toContainText('加载中');
  }

  /** Check one screen: no definition in the text, no `tok`/`req` beside a figure. */
  async function expectAbbreviations(page: Page, where: string): Promise<void> {
    await waitForScreen(page);
    const text = await page.locator('body').innerText();
    // A screen that rendered nothing would pass the check below for the wrong
    // reason, so require a real page that really names its figures.
    expect(text.length, `${where} has content`).toBeGreaterThan(200);
    const abbreviations = ['I/M', 'I/C', 'I/W', 'I/T', 'O/T', 'Q', 'T'].filter((name) => text.includes(name));
    expect(abbreviations.length, `${where} prints abbreviations`).toBeGreaterThanOrEqual(2);
    for (const name of IN_WORDS) expect(text, `${where} shows 「${name}」`).not.toContain(name);
    expect(text, `${where} spells out a unit`).not.toMatch(/\btok\b|\breq\b/);
  }

  test('prints abbreviations in every tab, and the words only on hover', async ({ page }) => {
    for (const view of ['', '?view=projects', '?view=agents', '?view=sessions', '?view=usage', '?view=models']) {
      await page.goto(`/${view}`);
      await expectAbbreviations(page, view === '' ? '概览' : view);
    }

    // The definitions are still there — one hover away.
    await page.goto('/?view=usage');
    await waitForScreen(page);
    const defs = await page
      .locator('[title]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title') ?? ''));
    for (const name of ['未命中缓存输入', '缓存命中输入', '缓存写入输入']) {
      expect(defs.some((def) => def.includes(name)), `「${name}」 is defined somewhere`).toBe(true);
    }
  });

  test('prints abbreviations on a session page and in a project scope too', async ({ page }) => {
    await page.goto('/');
    const { uid } = await openSession(page);
    await page.goto(`/s/${encodeURIComponent(uid)}`);
    await expectAbbreviations(page, '会话详情');

    const projects = await twoProjects(page);
    await page.goto('/?view=usage');
    await selectProject(page, projects[0]?.name ?? '');
    await expectAbbreviations(page, '单个项目');
  });
});
