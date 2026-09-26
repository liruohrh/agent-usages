/**
 * The dashboard has to be served from wherever npm put the package.
 *
 * `npm i -g` lands under a dot-directory surprisingly often — `~/.local/share/mise/…`
 * (mise, pnpm), `~/.nvm/…`, `~/.asdf/…`, `~/.volta/…`. `send`, which backs
 * `res.sendFile`, splits the **whole absolute path** into segments and answers
 * 404 "Not Found" when any of them starts with a dot, unless it is told
 * `dotfiles: 'allow'` — so every client-side route (`/`, `/p/<id>`) was a 500
 * `internalError` for those installs, while `/index.html` kept working because
 * `serve-static` looks at the *URL* path. That asymmetry is what made it look like
 * a missing front end (measured 2026-09-26).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { afterAll, describe, expect, it } from 'vitest';

import type { DashboardStore } from '../../src/serve/data.ts';
import { createApp, type ServeOptions } from '../../src/serve/server.ts';

// The dot segment is the point of the test, not an accident of mkdtemp.
const work = mkdtempSync(join(tmpdir(), '.agent-usages-webroot-'));
const built = join(work, 'dist');
mkdirSync(built, { recursive: true });
writeFileSync(join(built, 'index.html'), '<!doctype html><div id="root">the shell</div>');

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Start the app on a free port, the way `startServer` does. */
async function serve(options: ServeOptions): Promise<{ url: string; close: () => Promise<void> }> {
  // The static and fallback routes never touch the store; the routes that do are
  // not exercised here.
  const server = createApp({} as DashboardStore, options).listen(0);
  await new Promise((done) => server.once('listening', done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

describe('the built front end', () => {
  it('is served from an install path that contains a dot segment', async () => {
    const { url, close } = await serve({ webRoot: built });
    try {
      const shell = await fetch(`${url}/`);
      expect(shell.status).toBe(200);
      expect(await shell.text()).toContain('id="root"');
      // A client-side route goes through the same fallback, not through static.
      const route = await fetch(`${url}/p/anything`);
      expect(route.status).toBe(200);
      expect(await route.text()).toContain('id="root"');
      // A real file keeps being served by static.
      expect((await fetch(`${url}/index.html`)).status).toBe(200);
    } finally {
      await close();
    }
  });

  it('says the front end is missing instead of answering with an API error', async () => {
    const empty = join(work, 'not-built');
    mkdirSync(empty, { recursive: true });
    const { url, close } = await serve({ webRoot: empty });
    try {
      const response = await fetch(`${url}/`);
      expect(response.status).toBe(503);
      const page = await response.text();
      expect(page.toLowerCase()).toContain('<!doctype html>');
      expect(page).not.toContain('internalError');
    } finally {
      await close();
    }
  });
});
