/**
 * The dashboard, in a real browser.
 *
 * These tests exist because the JSX can be wrong in ways no unit test sees: a
 * list keyed by something that is not unique makes React leave stale rows behind
 * when the scope changes, and a table with more columns than its half-width
 * offers forces the reader to scroll sideways. Both were real bugs, so both are
 * pinned here.
 *
 * Nothing here names a project or expects a number: the assertions compare the
 * DOM against the `/api/dashboard` payload the page itself fetched, so the suite
 * runs on any machine's data (and the offline fixture is a dump of real usage
 * that deliberately never enters the repository).
 */

import { expect, test, type Locator, type Page } from '@playwright/test';

/** The part of the dashboard payload the assertions use. */
interface ApiDashboard {
  models: ApiRow[];
  bands: ApiRow[];
  projects: { id: string; name: string; models: ApiRow[]; bands: ApiRow[] }[];
}

interface ApiRow {
  agent: string;
  model: string;
  periodLabel?: string;
  requests: number;
  cost: { total: string };
}

/** Agent ids as the badges write them. */
const AGENT_LABELS: Record<string, string> = { dsh: 'DSH', pi: 'pi', claude: 'Claude', codex: 'Codex' };

/** Fetch `/api/dashboard` from inside the page — the same request the app made. */
async function apiDashboard(page: Page): Promise<ApiDashboard> {
  return page.evaluate(async () => (await fetch('/api/dashboard')).json()) as Promise<ApiDashboard>;
}

/** The card whose heading is `title`. */
function cardOf(page: Page, title: string): Locator {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}

/** One card's data rows, as trimmed cell texts; the "nothing here" row is dropped. */
async function rowsOf(page: Page, title: string): Promise<string[][]> {
  return cardOf(page, title)
    .locator('tbody tr')
    .evaluateAll((rows) =>
      rows
        .map((row) => [...row.querySelectorAll('td')].map((cell) => (cell.textContent ?? '').trim()))
        .filter((cells) => cells.length > 1),
    );
}

/** `2,294` → `2294`. */
function numberOf(text: string): number {
  return Number(text.replace(/[^\d]/g, ''));
}

/** The API's rows in the order the tables show them: dearest first, then by name. */
function sortedRows(rows: readonly ApiRow[]): ApiRow[] {
  return [...rows].sort(
    (left, right) => Number(right.cost.total) - Number(left.cost.total) || left.model.localeCompare(right.model),
  );
}

/** Click a project in the tree and wait for the scope heading to follow. */
async function selectProject(page: Page, name: string): Promise<void> {
  await page.locator('aside').getByText(name, { exact: true }).first().click();
  await expect(page.locator('main h1')).toHaveText(name);
}

/** The `agent|model|requests` triples a table shows, and the same for an API row. */
function triples(cells: readonly (readonly string[])[], columns: { agent: number; model: number; requests: number }): string[] {
  return cells.map((row) => `${row[columns.agent]}|${row[columns.model]}|${numberOf(row[columns.requests] ?? '')}`);
}

function apiTriple(row: ApiRow, withPeriod = false): string {
  const model = withPeriod ? `${row.model} · ${row.periodLabel ?? ''}` : row.model;
  return `${AGENT_LABELS[row.agent] ?? row.agent}|${model}|${row.requests}`;
}

test.describe('scope switching', () => {
  test('the model and band tables describe the project that is selected', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('main h1')).toHaveText('全部项目');

    const whole = await apiDashboard(page);
    test.skip(whole.projects.length < 2, 'needs two projects to switch between');
    // The overview agrees with the API before anything is clicked.
    expect(await rowsOf(page, '模型明细')).toHaveLength(whole.models.length);

    const names = whole.projects.slice(0, 2).map((project) => project.name);
    for (const name of [...names, names[0] ?? '']) {
      await selectProject(page, name);

      // What the page itself fetched, so data growing between requests cannot
      // explain a mismatch.
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
      // Column 0 is the expand arrow, and a band's model cell carries its period.
      expect(triples(bandRows, { agent: 1, model: 2, requests: 5 })).toEqual(
        expectedBands.map((row) => apiTriple(row, true)),
      );

      // No stale row from another scope may survive the switch: every identity on
      // screen has to be one this project actually has.
      const modelKeys = modelRows.map((row) => `${row[0]}|${row[1]}`);
      expect(new Set(modelKeys).size, 'model rows are unique').toBe(modelKeys.length);
      const bandKeys = bandRows.map((row) => `${row[1]}|${row[2]}|${row[4]}`);
      expect(new Set(bandKeys).size, 'band rows are unique').toBe(bandKeys.length);
    }
  });

  test('a session shows its own breakdown, not its project’s', async ({ page }) => {
    await page.goto('/');
    const project = (await apiDashboard(page)).projects[0];
    test.skip(project === undefined, 'needs at least one project');
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
    )) as { detail: { session: { title: string | null }; models: ApiRow[] } };

    // The panel's heading is the session's own title…
    if (detail.detail.session.title !== null) {
      await expect(page.locator('main h1')).toHaveText(detail.detail.session.title);
    }
    // …and its table is that session's models, in the same order and numbers.
    const rows = await rowsOf(page, '本会话模型明细');
    expect(rows.length, 'one row per model of this session').toBe(detail.detail.models.length);
    expect(triples(rows, { agent: 0, model: 1, requests: 2 })).toEqual(
      sortedRows(detail.detail.models).map((row) => apiTriple(row)),
    );

    // Going back to the project keeps the project's own numbers.
    await page.goto('/');
    await selectProject(page, project.name);
    expect((await rowsOf(page, '模型明细')).length).toBe(
      (await apiDashboard(page)).projects.find((entry) => entry.name === project.name)?.models.length,
    );
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

  test('the project overview stacks its detail tables', async ({ page }) => {
    await page.goto('/');
    await expectStacked(page, '模型明细', '计价区间明细');
  });

  test('a session stacks its own detail tables too', async ({ page }) => {
    await page.goto('/');
    const project = (await apiDashboard(page)).projects[0];
    test.skip(project === undefined, 'needs at least one project');
    if (project === undefined) return;
    await selectProject(page, project.name);

    const link = page.locator('main a[href^="/s/"]').first();
    test.skip((await link.count()) === 0, 'no billed session to open');
    await link.click();
    await expect(cardOf(page, '本会话模型明细')).toBeVisible();
    await expectStacked(page, '本会话模型明细', '本会话计价区间');
  });

  test('a wide window needs no horizontal scrolling inside the tables', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');

    for (const title of ['按 agent 分列', '模型明细', '计价区间明细']) {
      const measured = await cardOf(page, title)
        .locator('table')
        .evaluate((table) => ({
          table: table.scrollWidth,
          wrapper: table.parentElement?.clientWidth ?? 0,
        }));
      expect(measured.table, `${title} fits its card`).toBeLessThanOrEqual(measured.wrapper + 1);
    }
  });

  test('no width makes the page scroll sideways', async ({ page }) => {
    for (const width of [1440, 1200, 900, 700, 500]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      const overflow = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth,
        window: window.innerWidth,
      }));
      expect(overflow.page, `${width}px: the page must not scroll sideways`).toBeLessThanOrEqual(overflow.window + 1);
    }
  });
});
