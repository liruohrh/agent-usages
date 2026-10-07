#!/usr/bin/env node
/**
 * The installer behind `install.sh` and `install.ps1`.
 *
 * Why a third script: a shell one-liner can discover `node` and download a file,
 * and that is all it should do — parsing JSON, gunzipping, untarring and mapping
 * failures to exit codes is the same code twice in two languages otherwise. So
 * everything after "is there a node?" lives here, in Node's own standard library
 * (`fetch`, `node:zlib`, a small tar reader below) with no dependency to install
 * before installing.
 *
 * The install itself is deliberately the path a user would take by hand:
 * `npm install -g <tarball>`. npm treats a tarball as a published package and runs
 * no build scripts, so nothing is compiled or bundled on the user's machine. What
 * this script adds is *verification* before and after: the bytes really are a
 * gzip, the tarball really is `@agent/usages` at the requested version, and the
 * binary that landed on PATH reports that same version.
 *
 * `--base` defaults to `releases/latest/download`, whose fixed asset name
 * (`agent-usages.tgz`) is what lets the docs stay version-free: every release re-uploads
 * the same name, so publishing never edits a URL. Note the two different defaults — the
 * wrappers fetch *this file* from raw `master` while the package comes from the latest
 * release: an installer fix ships with a push, a package ships with a tag, and this
 * script therefore depends on neither. `AGENT_USAGES_BASE_URL` moves both halves at once.
 * `--tarball` exists for offline installs and for CI, which already has the file and
 * cannot (and should not) reach the release.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const PACKAGE_NAME = '@agent/usages';
const REPO = 'https://github.com/liruohrh/agent-usages';
const DEFAULT_BASE = `${REPO}/releases/latest/download`;
const MIN_NODE = '22.18';
const WINDOWS = process.platform === 'win32';
const NPM = WINDOWS ? 'npm.cmd' : 'npm';

const HELP = `agent-usages 安装器（Node ≥ ${MIN_NODE}，只用 node: 内置模块）

用法：node install.mjs [选项]

  --base <url>           安装器与发布包的基址；默认
                         ${DEFAULT_BASE}
  --version <v|latest>   装哪一版，默认 latest（最新一版）；v1.2.3 与 1.2.3 都认（这里只是例子，
                         钉住你自己那一版时换成真实版本号）。
                         指定版本、又没给 --base 时自动换成该版本自己的 release 页
                         （…/releases/download/v1.2.3/agent-usages-1.2.3.tgz）
  --tarball <路径|URL>   直接给 tarball：本地文件就直接装，给 http(s) 就下这个地址
  --prefix <dir>         装到 <dir>（等价于 npm 的 --prefix；默认 npm 的全局前缀）
  --dry-run              只打印将要做什么：不下载、不安装、不写盘
  -h, --help             显示这段帮助

环境变量：
  AGENT_USAGES_BASE_URL  同 --base（命令行优先）；install.sh / install.ps1 也用它
                         决定从哪儿下载这个 install.mjs（镜像、内网、本地测试）

例：
  node install.mjs                                     # 装最新一版
  node install.mjs --version 1.2.3                     # 装 v1.2.3 那一版（版本号换成你要的那个）
  node install.mjs --tarball ./agent-usages-1.2.3.tgz --prefix /tmp/prefix
`;

/** A message meant for the user; `main`'s caller prints it without a stack. */
class Failure extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function fail(message, code = 1) {
  throw new Failure(message, code);
}

function parseArgs(argv) {
  const envBase = process.env['AGENT_USAGES_BASE_URL'];
  const options = {
    base: envBase === undefined || envBase === '' ? DEFAULT_BASE : envBase,
    baseGiven: envBase !== undefined && envBase !== '',
    version: undefined,
    tarball: undefined,
    prefix: undefined,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index++) {
    const raw = argv[index];
    const equals = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const name = equals === -1 ? raw : raw.slice(0, equals);
    const inline = equals === -1 ? undefined : raw.slice(equals + 1);
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++index];
      if (next === undefined) fail(`${name} 缺少值`, 2);
      return next;
    };

    switch (name) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--base':
        options.base = value();
        options.baseGiven = true;
        break;
      case '--version':
        options.version = value();
        break;
      case '--tarball':
        options.tarball = value();
        break;
      case '--prefix':
        options.prefix = value();
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        fail(`未知参数 ${raw}（--help 看用法）`, 2);
    }
  }

  if (options.help) return options;

  // `latest` is the default spelled out; `v1.2.3` and `1.2.3` name the same tag.
  if (options.version === 'latest' || options.version === '') options.version = undefined;
  if (options.version !== undefined) {
    options.version = options.version.startsWith('v') ? options.version.slice(1) : options.version;
    if (!/^\d+\.\d+\.\d+/.test(options.version)) fail(`--version 不像版本号：${options.version}`, 2);
  }
  options.base = options.base.replace(/\/+$/, '');
  if (options.base === '') fail('--base 不能为空', 2);
  return options;
}

/** Where the tarball comes from: a local path, or a URL to download. */
function resolveSource(options) {
  if (options.tarball !== undefined) {
    return /^https?:\/\//i.test(options.tarball)
      ? { url: options.tarball }
      : { path: resolve(options.tarball) };
  }
  if (options.version === undefined) {
    // The fixed asset name: identical bytes to the versioned one, so `latest` works
    // without this script ever asking the API which version is newest.
    return { url: `${options.base}/agent-usages.tgz` };
  }
  // A version without an explicit base means the version's own release page: the
  // tag is `v<version>`, and `latest/download` only proxies the newest release.
  const base = options.baseGiven ? options.base : `${REPO}/releases/download/v${options.version}`;
  return { url: `${base}/agent-usages-${options.version}.tgz` };
}

function assertNode() {
  const [, major = '', minor = ''] = /^(\d+)\.(\d+)/.exec(process.versions.node) ?? [];
  if (Number(major) > 22 || (Number(major) === 22 && Number(minor) >= 18)) return;
  fail(
    `需要 Node ≥ ${MIN_NODE}，当前是 ${process.versions.node}。\n` +
      '装一个 Node（任选一种，装完重开终端）：\n' +
      '  - 官网安装包：https://nodejs.org/\n' +
      '  - mise：mise use -g node@22\n' +
      '  - nvm：nvm install 22 && nvm use 22\n' +
      '  - Homebrew：brew install node\n' +
      '  - 或指定已有的 node：AGENT_USAGES_NODE=/path/to/node sh install.sh …',
  );
}

async function download(url, destination) {
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': `agent-usages-installer (+${REPO})` },
    });
  } catch (cause) {
    fail(`下载失败：${url}\n  ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!response.ok) fail(`下载失败：${url} → HTTP ${response.status} ${response.statusText}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length === 0) fail(`下载到的是空文件：${url}`);
  writeFileSync(destination, body);
  return body.length;
}

/** ustar/PAX header fields are NUL-padded; `\0` may be absent on exact-size fields. */
function readCString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function readOctal(buffer, start, length) {
  const text = buffer
    .subarray(start, start + length)
    .toString('ascii')
    .replace(/\0/g, ' ')
    .trim();
  if (text === '') return 0;
  const size = Number.parseInt(text, 8);
  if (Number.isNaN(size)) fail(`tarball 头部的 size 不是八进制：${JSON.stringify(text)}`);
  return size;
}

/** The `path=` record of a PAX extended header, which overrides the next name. */
function paxPath(body) {
  for (const line of body.toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space === -1) continue;
    const record = line.slice(space + 1);
    const equals = record.indexOf('=');
    if (equals !== -1 && record.slice(0, equals) === 'path') return record.slice(equals + 1);
  }
  return undefined;
}

/**
 * Minimal tar reader — enough for `npm pack` output, which is ustar/PAX entries of
 * `package/…` written by node-tar. It exists so the installer needs no dependency
 * before it can install one; npm's own tarballs are the only input.
 */
function tarEntries(tar) {
  const entries = [];
  let offset = 0;
  let pendingName;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const name = readCString(header, 0, 100);
    if (name === '') break; // The two zero blocks that end an archive.
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0) || '0';
    const prefix = readCString(header, 345, 155);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === 'x' || type === 'g') {
      pendingName = paxPath(body) ?? pendingName;
      continue;
    }
    if (type === 'L') {
      pendingName = body.toString('utf8').replace(/\0+$/, '').replace(/\n$/, '');
      continue;
    }
    entries.push({ name: pendingName ?? (prefix === '' ? name : `${prefix}/${name}`), body });
    pendingName = undefined;
  }
  return entries;
}

/** `package/package.json` out of the tarball, without unpacking anything to disk. */
function packageJsonOf(tarballPath) {
  const raw = readFileSync(tarballPath);
  if (raw.length < 2 || raw[0] !== 0x1f || raw[1] !== 0x8b) {
    fail(`${tarballPath} 不是 gzip 文件——它不是一个 npm pack 出来的 tarball？`);
  }
  let tar;
  try {
    tar = gunzipSync(raw);
  } catch (cause) {
    fail(`${tarballPath} 解压失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const entry = tarEntries(tar).find((candidate) => candidate.name === 'package/package.json');
  if (entry === undefined) fail(`${tarballPath} 里没有 package/package.json——这不是一个 npm 包？`);
  try {
    return JSON.parse(entry.body.toString('utf8'));
  } catch (cause) {
    fail(`${tarballPath} 的 package.json 不是 JSON：${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/**
 * Run a command, with the Windows spelling handled here.
 *
 * Windows needs a shell to launch a `.cmd` (Node refuses it otherwise), but Node's
 * `shell: true` joins the command line **without quoting** — so an argument with a
 * space in it (a user name with one, a `C:\Program Files\…` prefix) would be split in
 * two. Quote them ourselves; everywhere else this is a plain spawn.
 */
function runCommand(command, args, options = {}) {
  if (!WINDOWS) return spawnSync(command, args, options);
  const line = [command, ...args]
    .map((part) => (/[\s"&|<>^]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
    .join(' ');
  return spawnSync(line, { shell: true, ...options });
}

function npmRun(args, options = {}) {
  return runCommand(NPM, args, options);
}

function globalPrefix(options) {
  if (options.prefix !== undefined) return resolve(options.prefix);
  const result = npmRun(['prefix', '-g'], { encoding: 'utf8' });
  if (result.status !== 0) fail(`拿不到 npm 的全局前缀：npm prefix -g 退出码 ${result.status}`);
  return result.stdout.trim();
}

function dryRun(options, source) {
  const lines = ['dry-run：不下载、不安装、不写盘', `  基址：${options.base}`];
  if (source.url !== undefined) {
    lines.push(`  发布包：${source.url}`);
  } else {
    const known = existsSync(source.path) && statSync(source.path).isFile();
    lines.push(`  发布包：${source.path}${known ? '（本地文件，已存在）' : '（本地文件，不存在）'}`);
    if (known) {
      const pkg = packageJsonOf(source.path);
      lines.push(`  包：${pkg.name} ${pkg.version}`);
    }
  }
  lines.push(`  安装前缀：${options.prefix === undefined ? `${globalPrefix(options)}（npm 全局前缀）` : resolve(options.prefix)}`);
  const wanted = ['install', '-g', '--no-audit', '--no-fund'];
  if (options.prefix !== undefined) wanted.push('--prefix', resolve(options.prefix));
  wanted.push(source.url ?? source.path);
  lines.push(`  npm 命令：${NPM} ${wanted.map((part) => (part.includes(' ') ? `"${part}"` : part)).join(' ')}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  assertNode();

  const source = resolveSource(options);
  if (options.dryRun) {
    dryRun(options, source);
    return;
  }

  let work;
  try {
    let tarball;
    if (source.path !== undefined) {
      if (!existsSync(source.path)) fail(`找不到 ${source.path}`);
      if (!statSync(source.path).isFile()) fail(`${source.path} 不是文件`);
      tarball = source.path;
      process.stdout.write(`使用本地发布包：${tarball}\n`);
    } else {
      work = mkdtempSync(join(tmpdir(), 'agent-usages-install-'));
      tarball = join(work, 'agent-usages.tgz');
      process.stdout.write(`下载 ${source.url}\n`);
      const bytes = await download(source.url, tarball);
      process.stdout.write(`  ${(bytes / 1024 / 1024).toFixed(1)} MB\n`);
    }

    const pkg = packageJsonOf(tarball);
    if (pkg.name !== PACKAGE_NAME) fail(`这个 tarball 是 ${pkg.name}，不是 ${PACKAGE_NAME}`);
    if (options.version !== undefined && pkg.version !== options.version) {
      fail(`tarball 里是 ${pkg.name} ${pkg.version}，与 --version ${options.version} 不一致`);
    }

    const prefix = globalPrefix(options);
    const installArgs = ['install', '-g', '--no-audit', '--no-fund'];
    if (options.prefix !== undefined) installArgs.push('--prefix', resolve(options.prefix));
    installArgs.push(tarball);
    process.stdout.write(`安装：${pkg.name} ${pkg.version} → ${prefix}\n`);
    const install = npmRun(installArgs, { stdio: 'inherit' });
    if (install.error !== undefined) fail(`无法运行 ${NPM}：${install.error.message}`);
    if (install.status !== 0) {
      fail(
        `npm install 失败（退出码 ${install.status}）。` +
          '若只是没权限写全局目录，可以装到自己的目录：--prefix ~/.local',
        install.status ?? 1,
      );
    }

    // The tarball said one version; the thing on PATH has to say the same one.
    const bin = join(prefix, WINDOWS ? 'agent-usages.cmd' : join('bin', 'agent-usages'));
    if (!existsSync(bin)) fail(`装完了却找不到可执行入口 ${bin}`);
    const printed = runCommand(bin, ['--version'], { encoding: 'utf8' });
    const version = (printed.stdout ?? '').trim();
    if (printed.status !== 0 || version !== pkg.version) {
      fail(`装出来的 ${bin} --version 是 ${version === '' ? '(空)' : version}，tarball 里是 ${pkg.version}`);
    }

    process.stdout.write(`\n装好了：${PACKAGE_NAME} ${pkg.version}\n  ${bin}\n`);
    const binDir = dirname(bin);
    const pathEntries = (process.env['PATH'] ?? '').split(WINDOWS ? ';' : ':');
    process.stdout.write(
      pathEntries.includes(binDir)
        ? '  agent-usages --help\n'
        : `  ${binDir} 不在 PATH 里：先直接用上面的绝对路径，或把它加进 PATH。\n`,
    );
  } finally {
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof Failure) {
    process.stderr.write(`install.mjs: ${error.message}\n`);
    process.exit(error.code);
  }
  process.stderr.write(`install.mjs: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
}
