/**
 * `agent-usages serve` — the standalone entry point.
 *
 * `src/cli/index.ts` gains the subcommand through `src/serve/index.ts`; this file exists
 * so the server can also be run (and tested) on its own:
 *
 * ```sh
 * node src/serve/main.ts --port 7788
 * node src/serve/main.ts --snapshot web/mock/dashboard.snapshot.json
 * node src/serve/main.ts --write-snapshot web/mock/dashboard.snapshot.json
 * ```
 *
 * The flags are the ones the documentation promises; `--help` prints them.
 */

import { startServer } from './server.ts';
import { openStore } from './data.ts';
import { t } from '../i18n/index.ts';

/** What the command line asked for. */
interface Args {
  port?: number;
  host?: string;
  open?: boolean;
  refresh?: number;
  agent?: string;
  home?: string;
  snapshot?: string;
  dev?: boolean;
  devTarget?: string;
  noUpdate?: boolean;
  writeSnapshot?: string;
  quiet?: boolean;
  help?: boolean;
}

const USAGE = `用法：agent-usages serve [选项]

起一个本地 Web 数据分析平台：项目 → 工作区 → 会话 → 子代理，按 agent 分列与
总计的消耗、时间序列、模型与计价区间明细。只读，默认只绑本地回环地址。

选项：
  -p, --port <端口>        监听端口（默认 7788，0 表示随机空闲端口）
      --host <地址>        绑定地址（默认 127.0.0.1）
      --open               启动后用系统浏览器打开
      --agent <选择>       要读的 agent：all（默认）、dsh、dsh,pi
      --home <路径>        指定数据根目录（原样传给各适配器）
      --refresh <秒>       每隔多少秒重扫一次（默认不重扫）
      --snapshot <文件>    读离线 JSON 快照，不扫描任何 agent 数据
      --dev                前端走 Vite 开发服务器（默认代理到 127.0.0.1:5173）
      --dev-target <地址>  --dev 代理的目标地址
      --no-update          不联网刷新价格表与汇率
  -q, --quiet              不打印启动信息（脚本里起服务用）
      --write-snapshot <文件>  扫一次并把整份仪表盘写成快照 JSON，然后退出
  -h, --help               显示本帮助

环境变量：DSH_HOME / PI_CODING_AGENT_DIR / CLAUDE_CONFIG_DIR / CODEX_HOME 与各
适配器一致；AGENT_USAGES_WEB_DIST 可覆盖前端构建产物目录。
`;

/** Parse the flags above, rejecting anything unknown rather than guessing. */
export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';
    const [flag, inline] = token.includes('=') ? (token.split(/=(.*)/s, 2) as [string, string]) : [token, undefined];
    const next = (): string => {
      if (inline !== undefined) return inline;
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error(`${flag} 缺少取值`);
      return value;
    };
    switch (flag) {
      case '-h':
      case '--help':
        args.help = true;
        break;
      case '-p':
      case '--port': {
        const value = Number(next());
        if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`--port 需要 0…65535 的整数，收到 ${value}`);
        args.port = value;
        break;
      }
      case '--host':
        args.host = next();
        break;
      case '--open':
        args.open = true;
        break;
      case '--refresh': {
        const value = Number(next());
        if (!Number.isFinite(value) || value < 0) throw new Error(`--refresh 需要非负秒数，收到 ${value}`);
        args.refresh = value;
        break;
      }
      case '--agent':
        args.agent = next();
        break;
      case '--home':
        args.home = next();
        break;
      case '--snapshot':
        args.snapshot = next();
        break;
      case '--dev':
        args.dev = true;
        if (inline !== undefined) args.devTarget = inline;
        break;
      case '--dev-target':
        args.devTarget = next();
        break;
      case '--no-update':
        args.noUpdate = true;
        break;
      case '-q':
      case '--quiet':
        args.quiet = true;
        break;
      case '--write-snapshot':
        args.writeSnapshot = next();
        break;
      default:
        throw new Error(`未知选项：${flag}（用 --help 看用法）`);
    }
  }
  return args;
}

/**
 * Run the command.
 * @param argv - arguments after the subcommand name.
 * @returns the process exit code.
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`agent-usages serve: ${(error as Error).message}\n`);
    return 1;
  }
  if (args.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const scan = {
    ...(args.agent === undefined ? {} : { agent: args.agent }),
    ...(args.home === undefined ? {} : { home: args.home }),
    ...(args.snapshot === undefined ? {} : { snapshot: args.snapshot }),
    noUpdate: args.noUpdate ?? true,
  };

  if (args.writeSnapshot !== undefined) {
    const store = await openStore(scan);
    await store.writeSnapshot(args.writeSnapshot);
    process.stdout.write(
      `${t().serve.snapshotWritten(
        args.writeSnapshot,
        String(store.dashboard().projects.length),
        String(store.dashboard().totals.requests),
      )}\n`,
    );
    return 0;
  }

  const running = await startServer({
    ...scan,
    port: args.port ?? 7788,
    host: args.host ?? '127.0.0.1',
    open: args.open === true,
    ...(args.refresh === undefined ? {} : { refresh: args.refresh }),
    dev: args.dev === true,
    quiet: args.quiet === true,
    ...(args.devTarget === undefined ? {} : { devTarget: args.devTarget }),
    ...(process.env['AGENT_USAGES_WEB_DIST'] === undefined ? {} : { webRoot: process.env['AGENT_USAGES_WEB_DIST'] }),
  });

  // Ctrl-C closes the listener; the timer is unref'd, so nothing else holds the
  // process open.
  const stop = (): void => {
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return 0;
}

// Only run when executed directly, so importing this module in a test is inert.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const code = await main();
  if (code !== 0) process.exitCode = code;
}
