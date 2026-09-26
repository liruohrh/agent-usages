/**
 * The HTTP layer: a small Express app over {@link DashboardStore}.
 *
 * Every `/api/*` route answers JSON in the shapes `types.ts` declares. The
 * non-API routes serve the built dashboard (`web/dist`) or, with `--dev`, proxy
 * to the Vite dev server, so `agent-usages serve` and `pnpm --filter web dev` can
 * be used together with hot reload.
 *
 * Three deliberate limits:
 *
 * - it binds `127.0.0.1` unless told otherwise;
 * - it never writes to an agent's data directory; the only file it may write is a
 *   snapshot, and only when explicitly asked for one;
 * - the one other write it can make is the language in the tool's *own*
 *   configuration file (`PUT /api/settings`), because the switch in the page is
 *   meant to be the same setting the CLI reads. That route is the only one that
 *   accepts a body, it demands `application/json` (so a form or a cross-site
 *   `fetch` cannot reach it without a preflight this server never allows) and it
 *   ignores any request whose `Origin` is not the server itself.
 *
 * The page can also ask for a language per request (`?lang=en`): the payload's
 * sentences — the range label, the warnings — are rendered in it, while the
 * numbers stay what they are.
 */

import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

import { flattenWarning, localizeDashboard, openStore, type DashboardQuery, type DashboardStore } from './data.ts';
import { LANGUAGES, language, messagesFor, parseLanguage, setLanguage, t, type Language } from '../i18n/index.ts';
import { renderDiagnostic } from '../i18n/errors.ts';
import {
  readUserConfig,
  readUserConfigDocument,
  updateUserConfig,
  validateUserPatch,
  type UserConfigPatch,
} from '../config/user.ts';
import { ConfigError } from '../config/pricing.ts';
import { userConfigPath } from '../config/paths.ts';
import { UserError } from '../i18n/errors.ts';
import type {
  ConfigPayload,
  SettingsPayload,
  Dashboard,
  DashboardMeta,
  ProjectSummary,
  RefreshReport,
  SessionNode,
  TimeseriesBucket,
} from './types.ts';

/** Where Vite listens by default. */
const DEFAULT_DEV_TARGET = 'http://127.0.0.1:5173';

/** How the server is started. */
export interface ServeOptions {
  /** TCP port; `0` picks a free one. Default `7788`. */
  port?: number | undefined;
  /** Interface to bind. Default `127.0.0.1` (loopback only). */
  host?: string | undefined;
  /** Open the dashboard in the system browser once it is listening. */
  open?: boolean | undefined;
  /** Seconds between automatic rescans; `0` or absent disables them. */
  refresh?: number | undefined;
  /** Proxy everything that is not `/api` to a Vite dev server. */
  dev?: boolean | undefined;
  /** Vite dev server to proxy to. Default `http://127.0.0.1:5173`. */
  devTarget?: string | undefined;
  /** Directory holding the built front end. Default `<repo>/web/dist`. */
  webRoot?: string | undefined;
  /** Agent selector for the scan (`all`, `dsh`, `dsh,pi`). */
  agent?: string | undefined;
  /** Explicit data root, passed to every adapter. */
  home?: string | undefined;
  /** Read a JSON snapshot instead of scanning. */
  snapshot?: string | undefined;
  /** Skip the lazy price/rate refresh. */
  noUpdate?: boolean | undefined;
  /** Suppress the startup lines (the smoke test and tests do). */
  quiet?: boolean | undefined;
}

/** A listening server. */
export interface RunningServer {
  /** The URL the dashboard is reachable at. */
  url: string;
  /** The port actually bound (useful when `port: 0` was requested). */
  port: number;
  /** The data behind it. */
  store: DashboardStore;
  /** Stop listening and clear any refresh timer. */
  close(): Promise<void>;
}

/** The repo's `web/dist`, resolved from this file rather than the cwd. */
export function defaultWebRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
}

/** The provenance block every answer carries. */
function metaOf(dashboard: Dashboard): DashboardMeta {
  return {
    generatedAt: dashboard.generatedAt,
    mode: dashboard.mode,
    source: dashboard.source,
    scannedAt: dashboard.scannedAt,
    scanMs: dashboard.scanMs,
    loadedAgents: dashboard.loadedAgents,
    currency: dashboard.currency,
    currencySymbol: dashboard.currencySymbol,
    pricingProvider: dashboard.pricingProvider,
    pricingLabel: dashboard.pricingLabel,
    rangeLabel: dashboard.rangeLabel,
    rangeFrom: dashboard.rangeFrom,
    rangeTo: dashboard.rangeTo,
  };
}

/** Split a comma/space separated query parameter into a list. */
function listOf(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** A single string query parameter. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** The language the configuration file asks for, or `undefined` when it has no opinion. */
function configuredLanguage(env: NodeJS.ProcessEnv = process.env): Language | undefined {
  return readUserConfig(env).config.language;
}

/** The language one request asks for: `?lang=`, else the configured one. */
function requestLanguage(request: Request): Language {
  return parseLanguage(request.query['lang']) ?? configuredLanguage() ?? language();
}

/** Whether an `Origin` header names this very server. */
function sameOrigin(request: Request, origin: string): boolean {
  try {
    const host = new URL(origin).host;
    return host === request.get('host');
  } catch {
    return false;
  }
}

/**
 * Answer in one language without leaving the process in it.
 *
 * The payload's prose is written when it is built, and the scan that builds it is
 * cached across requests — so a request in another language re-renders those
 * sentences from their codes. The process-wide switch is set and restored inside
 * one synchronous block, so no other response can observe it.
 * @param request - the request, which may carry `?lang=`.
 * @param render - builds the answer.
 * @returns whatever `render` returned.
 */
function withRequestLanguage<T>(request: Request, render: () => T): T {
  const wanted = requestLanguage(request);
  if (wanted === language()) return render();
  const previous = language();
  setLanguage(wanted);
  try {
    return render();
  } finally {
    setLanguage(previous);
  }
}

/** Turn a request's query string into the filters the store understands. */
function queryOf(request: Request): DashboardQuery & { bucket?: 'day' | 'hour' } {
  const bucket = stringOf(request.query['bucket']);
  return {
    ...(stringOf(request.query['range']) === undefined ? {} : { range: stringOf(request.query['range']) }),
    ...(listOf(request.query['agent']).length === 0 ? {} : { agents: listOf(request.query['agent']) }),
    ...(listOf(request.query['project']).length === 0 ? {} : { projects: listOf(request.query['project']) }),
    ...(stringOf(request.query['q']) === undefined ? {} : { search: stringOf(request.query['q']) }),
    ...(bucket === 'day' || bucket === 'hour' ? { bucket } : {}),
  };
}

/** One row per session, flattened out of the project tree. */
function flattenSessions(dashboard: Dashboard, options: { subagents?: boolean }): SessionNode[] {
  const sessions = dashboard.projects.flatMap((project) => project.sessionReports);
  const filtered = options.subagents === false ? sessions.filter((session) => !session.isSubagent) : sessions;
  return filtered.sort(
    (left, right) => (right.lastUsage ?? 0) - (left.lastUsage ?? 0) || left.uid.localeCompare(right.uid),
  );
}

/**
 * Build the Express app over an already-loaded store.
 *
 * Exported so a test can mount it without binding a port; the CLI uses
 * {@link startServer}.
 * @param store - the data to serve.
 * @param options - dev-proxy and static-hosting switches.
 * @returns the app.
 */
export function createApp(store: DashboardStore, options: ServeOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  /** Every answer is a fresh read of live numbers. */
  const json = (response: Response, payload: unknown, status = 200): void => {
    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json(payload);
  };

  /** Wrap a handler so a failure becomes a JSON error, not an HTML stack. */
  const route =
    (handler: (request: Request, response: Response) => void) =>
    (request: Request, response: Response, next: NextFunction): void => {
      try {
        handler(request, response);
      } catch (error) {
        next(error);
      }
    };

  /**
   * The dashboard for one request: its filters applied, its sentences in the
   * language the request asked for.
   */
  const dashboardOf = (request: Request): { dashboard: Dashboard; query: DashboardQuery & { bucket?: 'day' | 'hour' } } =>
    withRequestLanguage(request, () => {
      const query = queryOf(request);
      return { dashboard: localizeDashboard(store.dashboard(query), query.range), query };
    });

  app.get('/api/health', route((request, response) => {
    json(response, {
      ok: true,
      mode: store.mode,
      scannedAt: store.scannedAt,
      scanMs: store.scanMs,
      agents: store.loadedAgents,
    });
  }));

  app.get('/api/summary', route((request, response) => {
    const { dashboard } = dashboardOf(request);
    json(response, {
      ...metaOf(dashboard),
      agents: dashboard.agents,
      totals: dashboard.totals,
      counts: {
        projects: dashboard.projects.length,
        workspaces: dashboard.projects.reduce((total, project) => total + project.workspaces.length, 0),
        models: new Set(dashboard.models.map((row) => row.model)).size,
        bands: dashboard.bands.length,
      },
      warnings: dashboard.warnings,
    });
  }));

  app.get('/api/agents', route((request, response) => {
    const { dashboard } = dashboardOf(request);
    json(response, { ...metaOf(dashboard), agents: dashboard.agents, totals: dashboard.totals, warnings: dashboard.warnings });
  }));

  app.get('/api/projects', route((request, response) => {
    const { dashboard } = dashboardOf(request);
    json(response, {
      ...metaOf(dashboard),
      totals: dashboard.totals,
      agents: dashboard.agents,
      projects: dashboard.projects,
      repos: dashboard.repos,
      warnings: dashboard.warnings,
    });
  }));

  app.get('/api/projects/:id', route((request, response) => {
    const { dashboard } = dashboardOf(request);
    const wanted = String(request.params['id'] ?? '');
    const project =
      dashboard.projects.find((candidate) => candidate.id === wanted) ??
      dashboard.projects.find((candidate) => candidate.name === wanted) ??
      dashboard.projects.find((candidate) => candidate.workspaces.includes(wanted));
    if (project === undefined) {
      json(response, { error: { code: 'projectNotFound', message: `没有这个项目：${wanted}` } }, 404);
      return;
    }
    json(response, { ...metaOf(dashboard), project });
  }));

  app.get('/api/sessions', route((request, response) => {
    const { dashboard } = dashboardOf(request);
    const subagents = request.query['subagents'];
    const sessions = flattenSessions(dashboard, { subagents: subagents === '0' || subagents === 'false' ? false : undefined });
    const projectIds = listOf(request.query['project']);
    const selected =
      projectIds.length === 0
        ? sessions
        : sessions.filter((session) => projectIds.includes(session.projectId) || projectIds.includes(session.projectName));
    json(response, {
      ...metaOf(dashboard),
      count: selected.length,
      sessions: selected,
      warnings: dashboard.warnings,
    });
  }));

  app.get('/api/sessions/:id', route((request, response) => {
    const id = String(request.params['id'] ?? '');
    const qualifier = stringOf(request.query['agent']);
    const wanted = qualifier !== undefined && !id.includes(':') ? `${qualifier}:${id}` : id;
    const { dashboard } = dashboardOf(request);
    const detail = store.sessionDetail(wanted, queryOf(request));
    if (detail === undefined) {
      json(response, { error: { code: 'sessionNotFound', message: t().errors.sessionNotFound({ selector: id }) } }, 404);
      return;
    }
    json(response, { ...metaOf(dashboard), detail });
  }));

  app.get('/api/timeseries', route((request, response) => {
    const { dashboard, query } = dashboardOf(request);
    const bucket = query.bucket ?? 'day';
    withRequestLanguage(request, () => {
      const points: TimeseriesBucket[] = store.timeseries({ ...query, bucket });
      json(response, { ...metaOf(dashboard), bucket, count: points.length, points });
    });
  }));

  app.get('/api/dashboard', route((request, response) => {
    json(response, dashboardOf(request).dashboard);
  }));

  /** What the language switch needs to know: what is set, and where it is written. */
  const settings = (): SettingsPayload => {
    const loaded = readUserConfig();
    return {
      language: language(),
      configured: loaded.config.language ?? null,
      path: userConfigPath(),
      languages: [...LANGUAGES],
    };
  };

  app.get('/api/settings', route((request, response) => {
    json(response, withRequestLanguage(request, settings));
  }));

  /** The configuration file, the way the settings page edits it. */
  const configPayload = (): ConfigPayload => {
    const { path, exists, document } = readUserConfigDocument();
    const loaded = readUserConfig();
    return {
      path,
      exists,
      document,
      config: {
        language: loaded.config.language ?? null,
        currency: loaded.config.currency ?? null,
        rateMode: loaded.config.rateMode ?? null,
        rateSource: loaded.config.rateSource ?? null,
        updates: loaded.config.updates,
        projects: loaded.config.projects.map((group) => ({ name: group.name, paths: [...group.paths] })),
        pricingProviders: loaded.config.pricing.map((provider) => provider.id),
      },
      warnings: loaded.warnings.map((item) => flattenWarning(item)),
    };
  };

  app.get('/api/config', route((request, response) => {
    json(response, withRequestLanguage(request, configPayload));
  }));

  /**
   * Write the settings the page manages, then rescan.
   *
   * Project declarations are applied by the merge layer during a scan, and the
   * currency and rate settings are baked into the pricing engine, so the answer
   * to a write is a *new scan*: it re-reads the configuration, rebuilds the
   * engine and re-groups the sessions. The scan takes a couple of seconds on a
   * real machine, which is why the page says so on the button.
   */
  app.put('/api/config', route((request, response) => {
    const origin = request.get('origin');
    if (origin !== undefined && origin.length > 0 && !sameOrigin(request, origin)) {
      withRequestLanguage(request, () =>
        json(response, { error: { code: 'settingsForeignOrigin', message: t().errors.settingsForeignOrigin({ origin }) } }, 403),
      );
      return;
    }
    const body = (request.body ?? {}) as Record<string, unknown>;
    // Only the keys the settings page manages: anything else in the body is a
    // caller that misunderstood the endpoint, and guessing would be worse than
    // saying so.
    const allowed = ['projects', 'currency', 'rateMode', 'rateSource', 'updates'] as const;
    const unknown = Object.keys(body).filter((key) => !(allowed as readonly string[]).includes(key));
    if (unknown.length > 0) {
      json(
        response,
        {
          error: {
            code: 'settingsUnknownKey',
            message: t().errors.settingsUnknownKey({ allowed: allowed.join(', '), key: unknown.join(', ') }),
          },
        },
        400,
      );
      return;
    }
    const patch = body as UserConfigPatch;
    try {
      withRequestLanguage(request, () => validateUserPatch(patch));
    } catch (error) {
      const detail = error instanceof ConfigError ? error : undefined;
      json(
        response,
        {
          error: {
            code: detail?.code ?? 'settingsWriteFailed',
            message: error instanceof Error ? error.message : String(error),
            ...(detail === undefined ? {} : { field: detail.path }),
          },
        },
        400,
      );
      return;
    }
    try {
      updateUserConfig(patch as Record<string, unknown>);
    } catch (error) {
      withRequestLanguage(request, () =>
        json(
          response,
          {
            error: {
              code: 'settingsWriteFailed',
              message: error instanceof Error ? error.message : String(error),
            },
          },
          500,
        ),
      );
      return;
    }
    void store
      .refresh()
      .then((report: RefreshReport) => {
        withRequestLanguage(request, () => json(response, { ...configPayload(), refresh: report }));
      })
      .catch((error: unknown) => {
        json(response, { error: { code: 'refreshFailed', message: (error as Error).message } }, 500);
      });
  }));

  app.put('/api/settings', route((request, response) => {
    // Only a same-origin `application/json` request can reach this: a cross-site
    // `fetch` with a JSON body needs a preflight, and this app answers none.
    const origin = request.get('origin');
    if (origin !== undefined && origin.length > 0 && !sameOrigin(request, origin)) {
      withRequestLanguage(request, () =>
        json(response, { error: { code: 'settingsForeignOrigin', message: t().errors.settingsForeignOrigin({ origin }) } }, 403),
      );
      return;
    }
    const wanted = parseLanguage((request.body as { language?: unknown } | undefined)?.language);
    if (wanted === undefined) {
      const value = JSON.stringify((request.body as { language?: unknown } | undefined)?.language);
      withRequestLanguage(request, () =>
        json(
          response,
          {
            error: {
              code: 'settingsUnknownLanguage',
              message: t().errors.settingsUnknownLanguage({ known: LANGUAGES.join(' / '), value }),
            },
          },
          400,
        ),
      );
      return;
    }
    try {
      updateUserConfig({ language: wanted });
    } catch (error) {
      withRequestLanguage(request, () =>
        json(
          response,
          {
            error: {
              code: 'settingsWriteFailed',
              message:
                error instanceof UserError
                  ? error.message
                  : renderDiagnostic('settingsWriteFailed', { path: userConfigPath(), reason: (error as Error).message }),
            },
          },
          500,
        ),
      );
      return;
    }
    setLanguage(wanted);
    json(response, settings());
  }));

  app.post('/api/refresh', route((request, response) => {
    void store
      .refresh()
      .then((report: RefreshReport) => json(response, report, report.ok ? 200 : 409))
      .catch((error: unknown) => {
        json(response, { error: { code: 'refreshFailed', message: (error as Error).message } }, 500);
      });
  }));

  // Unknown API routes are JSON 404s, never the SPA's HTML.
  app.use('/api', (request: Request, response: Response) => {
    json(response, { error: { code: 'notFound', message: `没有这个接口：${request.method} ${request.originalUrl}` } }, 404);
  });

  // Nothing below this point is an API route, so an error that surfaces here is
  // either a bad filter (the user's) or a bug (ours) — and both are JSON.
  const onError = (error: unknown, request: Request, response: Response, next: NextFunction): void => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const code = (error as { code?: unknown }).code;
    const badRequest = error instanceof Error && typeof code === 'string' && code.length > 0;
    json(
      response,
      {
        error: {
          code: badRequest ? String(code) : 'internalError',
          message: (error as Error).message,
          path: request.originalUrl,
        },
      },
      badRequest ? 400 : 500,
    );
  };

  if (options.dev === true) {
    const target = options.devTarget ?? DEFAULT_DEV_TARGET;
    app.use(
      createProxyMiddleware({
        target,
        changeOrigin: true,
        ws: true,
        logger: options.quiet === true ? undefined : console,
      }),
    );
    app.use(onError);
    return app;
  }

  const webRoot = options.webRoot ?? defaultWebRoot();
  const index = join(webRoot, 'index.html');
  if (existsSync(index)) {
    app.use(express.static(webRoot, { index: false, maxAge: 0 }));
    // A client-side route (`/p/<id>`) is not a file: hand back the shell and let
    // react-router resolve it.
    app.use((request: Request, response: Response, next: NextFunction) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        next();
        return;
      }
      response.setHeader('Cache-Control', 'no-store');
      response.sendFile(index);
    });
    app.use(onError);
    return app;
  }

  app.use((request: Request, response: Response, next: NextFunction) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      next();
      return;
    }
    response
      .status(503)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>agent-usages serve</title>` +
          `<body style="font:14px/1.6 system-ui;background:#0b1017;color:#e6edf3;padding:2rem">` +
          `<h1>${t().serve.webNotBuilt}</h1><p>${t().serve.webNotBuiltHint(
            '<code>pnpm --filter web build</code>',
            '<code>agent-usages serve --dev</code>',
          )} <a style="color:#7cc4ff" href="/api/summary">/api/summary</a></p>` +
          `<p>${t().serve.webNotBuiltLooking(`<code>${webRoot}</code>`)}</p></body>`,
      );
  });
  app.use(onError);
  return app;
}

/** Bind an app, failing with a readable message instead of an unhandled throw. */
function listen(app: Express, port: number, host: string): Promise<Server> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer(app);
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(t().serve.portInUse(String(port))));
        return;
      }
      reject(error);
    });
    server.listen(port, host, () => resolvePromise(server));
  });
}

/**
 * Start the dashboard.
 *
 * The store is loaded first — a scan failure is a startup failure, not a
 * half-alive server — and the returned `close()` stops the refresh timer and the
 * listener, which is what the smoke test relies on.
 *
 * @param options - scan, hosting and lifecycle options.
 * @returns the URL, the store, and a way to stop.
 */
export async function startServer(options: ServeOptions = {}): Promise<RunningServer> {
  const store = await openStore({
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.snapshot === undefined ? {} : { snapshot: options.snapshot }),
    noUpdate: options.noUpdate ?? true,
  });
  const app = createApp(store, options);
  const port = options.port ?? 7788;
  const host = options.host ?? '127.0.0.1';
  const server = await listen(app, port, host);
  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : port;
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${displayHost}:${bound}`;

  let timer: NodeJS.Timeout | undefined;
  if (options.refresh !== undefined && options.refresh > 0) {
    const period = Math.max(1, Math.round(options.refresh)) * 1000;
    // A period shorter than one scan must not queue scans: the tick that lands
    // while one is running is dropped, and the next one reports again. (The data
    // layer joins a scan that is already in flight, so this is about not logging
    // the same scan twice rather than about correctness.)
    let rescanning = false;
    timer = setInterval(() => {
      if (rescanning) return;
      rescanning = true;
      void store
        .refresh()
        .then((report) => {
          if (options.quiet !== true && report.ok) {
            process.stdout.write(`${t().serve.rescanned(String(report.ms), String(report.agents.length))}\n`);
          }
        })
        .finally(() => {
          rescanning = false;
        });
    }, period);
    timer.unref();
  }

  if (options.quiet !== true) {
    const agents = store.loadedAgents.map((agent) => agent.id).join('、');
    process.stdout.write(
      `${t().serve.started(url)}\n` +
        `${store.mode === 'snapshot' ? t().serve.sourceSnapshot(store.source) : t().serve.sourceLive(store.source)}\n` +
        t().serve.scanLine(agents.length === 0 ? t().serve.noAgents : agents, String(store.dashboard().projects.length), String(store.scanMs)) +
        '\n' +
        (options.refresh === undefined || options.refresh <= 0 ? '' : `${t().serve.refreshEvery(String(options.refresh))}\n`) +
        (options.dev === true ? `${t().serve.devProxy(options.devTarget ?? DEFAULT_DEV_TARGET)}\n` : ''),
    );
  }

  if (options.open === true) {
    const { default: open } = await import('open');
    await open(url);
  }

  return {
    url,
    port: bound,
    store,
    async close() {
      if (timer !== undefined) clearInterval(timer);
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
      });
    },
  };
}

/** The dashboard as one object, for a caller that wants everything at once. */
export type { Dashboard, ProjectSummary, SessionNode };
