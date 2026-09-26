#!/usr/bin/env node
/**
 * Install a packed tarball the way a user does, then use it.
 *
 * This is the *release* path, and it is different from the git path on purpose:
 * npm treats a tarball as a published package, so it runs **no build scripts at
 * all** — nothing is compiled or bundled on the user's machine, and the install
 * takes seconds instead of the ~13 minutes a cold `github:` install costs
 * (measured 2026-09-26). That only holds if the tarball really carries `dist/`
 * (the compiled CLI, because Node refuses to strip types under `node_modules`)
 * and `web/dist/` (the dashboard) — which is exactly what this script proves:
 * install, run, serve.
 *
 * Three details are deliberate, each of them a bug this script failed to catch
 * before (2026-09-26):
 *
 * - **The install goes under a dot-directory.** Global installs live in
 *   `~/.local/share/mise/…`, `~/.nvm/…`, `~/.asdf/…` all the time, and a dot
 *   segment in the path made `res.sendFile` answer 404 for the dashboard.
 * - **The port must be free before starting, and the server we talk to must be
 *   ours.** A leftover server on the port makes every check pass without testing
 *   anything.
 * - **The whole process group is killed.** `bin/agent-usages.js` is a `spawnSync`
 *   wrapper, so killing the wrapper leaves the real server running (that is how
 *   the first two mistakes went unnoticed).
 *
 * Shared by CI (`.github/workflows/release.yml`, before the asset is uploaded) and
 * by a maintainer checking a build by hand:
 *
 * ```bash
 * pnpm release:pack
 * node scripts/verify-tarball.mjs release/agent-usages-0.0.1.tgz
 * ```
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv[2] === undefined) {
  process.stderr.write('用法: node scripts/verify-tarball.mjs <agent-usages-x.y.z.tgz>\n');
  process.exit(2);
}
const tarball = resolve(process.argv[2]);
if (!existsSync(tarball)) {
  process.stderr.write(`找不到 ${tarball}\n`);
  process.exit(2);
}

const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
const size = (readFileSync(tarball).length / 1024 / 1024).toFixed(1);

const work = mkdtempSync(join(tmpdir(), '.usages-verify-'));
const prefix = join(work, 'prefix');
const configHome = join(work, 'config');
mkdirSync(join(configHome, 'agent-usages'), { recursive: true });
// Updates off: this checks the *artifact*, so it must not depend on the network or
// on whatever configuration the machine running it happens to have.
writeFileSync(
  join(configHome, 'agent-usages', 'config.json'),
  JSON.stringify({ version: 1, updates: { pricing: false, rates: false } }, null, 2),
);

const env = { ...process.env, XDG_CONFIG_HOME: configHome, AGENT_USAGES_NO_BROWSER: '1' };
const failed = [];
function check(label, ok, detail = '') {
  process.stdout.write(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : ` — ${detail}`}\n`);
  if (!ok) failed.push(label);
}

const started = Date.now();
const install = spawnSync('npm', ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', tarball], {
  env,
  encoding: 'utf8',
});
const seconds = ((Date.now() - started) / 1000).toFixed(1);
check('安装（npm 对 tarball 不跑任何脚本）', install.status === 0, `${size} MB / ${seconds} s`);

const bin = join(prefix, 'bin', 'agent-usages');
const installed = join(prefix, 'lib', 'node_modules', '@agent', 'usages');
check('装出了可执行入口', existsSync(bin));
check('自带编译好的 CLI', existsSync(join(installed, 'dist', 'cli', 'index.js')));
check('自带构建好的仪表盘', existsSync(join(installed, 'web', 'dist', 'index.html')));
check('没有在用户机上装前端依赖', !existsSync(join(installed, 'web', 'node_modules')));

const cli = (args) => spawnSync(bin, args, { env, encoding: 'utf8' });
const printed = cli(['--version']).stdout.trim();
check('--version', printed === version, printed);
check('price', cli(['price']).stdout.includes('DeepSeek'));
check('check-config', cli(['check-config']).stdout.includes('ok'));

/** A port nothing is listening on, so a leftover server cannot answer for ours. */
async function freePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 4700 + Math.floor(Math.random() * 200);
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(300) });
      continue; // Something answered: not free.
    } catch {
      return port;
    }
  }
  throw new Error('找不到空闲端口');
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const get = async (path) => {
  try {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.text() };
  } catch {
    return undefined;
  }
};

// `detached` so the whole group can be stopped: the bin spawns the real server.
const server = spawn(bin, ['serve', '--port', String(port), '--quiet'], { env, stdio: 'ignore', detached: true });
let health;
for (let attempt = 0; attempt < 60; attempt++) {
  health = await get('/api/health');
  if (health?.status === 200) break;
  await new Promise((wake) => setTimeout(wake, 500));
}
const settings = await get('/api/settings');
check('serve 起来了，而且应答的是它自己', health?.status === 200 && settings?.body.includes('"languages"'));
check('托管前端页面', (await get('/'))?.body.toLowerCase().includes('<!doctype html>'));
// The SPA fallback, which is what a dot segment in the install path used to break.
check('客户端路由回落到前端壳', (await get('/p/anything'))?.body.toLowerCase().includes('<!doctype html>'));

try {
  process.kill(-server.pid, 'SIGTERM');
} catch {
  // Already gone.
}
await new Promise((done) => {
  const timer = setTimeout(() => {
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
    done();
  }, 3000);
  server.once('exit', () => {
    clearTimeout(timer);
    done();
  });
});

rmSync(work, { recursive: true, force: true });
if (failed.length > 0) {
  process.stderr.write(`\n${failed.length} 项没通过：${failed.join('、')}\n`);
  process.exit(1);
}
process.stdout.write(`\n${tarball} 装出来能用（${seconds} s，路径含点段）\n`);
