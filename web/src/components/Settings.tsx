/**
 * The settings page: the tool's own configuration file, edited in place.
 *
 * The file is the *user's*, and this page is the second way to write it (the
 * language switch is the first). Two rules follow from that:
 *
 * - the page edits the **document**, not a normalized copy, so a path written as
 *   `~/ws/app` goes back the same way and whatever the page does not manage (the
 *   price overrides) is never touched;
 * - a save **rescans**. Project declarations are applied by the merge layer and
 *   the currency settings are baked into the pricing engine, so the only honest
 *   answer to "did that work" is a fresh scan — which is why the button says so.
 */

import { useEffect, useMemo, useState } from 'react';

import { fetchConfig, saveConfig } from '../api';
import type { ConfigPatch, ConfigPayload, Dashboard, Language } from '../types';
import { Card } from './Bits';
import { useLanguage, useT } from '../i18n';

/** A project declaration while it is being edited. */
interface GroupDraft {
  name: string;
  paths: string[];
}

/** What the page is doing right now. */
type Status =
  | { kind: 'clean' }
  | { kind: 'saving' }
  | { kind: 'saved'; ms: number }
  | { kind: 'savedSnapshot' }
  | { kind: 'failed'; message: string };

/** The settings page. */
export function Settings({
  dashboard,
  onLanguage,
  onSaved,
}: {
  dashboard: Dashboard | null;
  /** The top bar owns the language; the page's own control calls the same setter. */
  onLanguage: (next: Language) => void;
  /** Called after a write: the numbers behind the page are out of date. */
  onSaved: () => void;
}): React.ReactElement {
  const t = useT();
  const current = useLanguage();
  const [loaded, setLoaded] = useState<ConfigPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The draft, one field per key the page manages.
  const [projects, setProjects] = useState<GroupDraft[]>([]);
  const [currency, setCurrency] = useState('');
  const [rateMode, setRateMode] = useState<'latest' | 'historical'>('latest');
  const [rateSource, setRateSource] = useState('');
  const [updates, setUpdates] = useState({ pricing: true, rates: false });
  const [status, setStatus] = useState<Status>({ kind: 'clean' });

  /** Put the draft back to what the file says. */
  const adopt = (payload: ConfigPayload): void => {
    setLoaded(payload);
    setProjects(payload.config.projects.map((group) => ({ name: group.name, paths: [...group.paths] })));
    setCurrency(payload.config.currency ?? '');
    setRateMode(payload.config.rateMode ?? 'latest');
    setRateSource(payload.config.rateSource ?? '');
    setUpdates(payload.config.updates);
    setStatus({ kind: 'clean' });
  };

  useEffect(() => {
    const controller = new AbortController();
    fetchConfig(controller.signal)
      .then(adopt)
      // React runs an effect twice in development to surface missing cleanups;
      // the first run's fetch is aborted by its own cleanup, and that rejection
      // is not a page that failed to load.
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError((cause as Error).message);
      });
    return () => controller.abort();
  }, []);

  /** The patch a save would send: only the keys this page manages. */
  const patch = useMemo((): ConfigPatch => {
    const clean: GroupDraft[] = (loaded?.config.projects ?? []).map((group) => ({
      name: group.name,
      paths: [...group.paths],
    }));
    const patch: ConfigPatch = {
      projects: projects.map((group) => ({ name: group.name.trim(), paths: [...group.paths] })),
      rateMode,
      updates,
      currency: currency.trim().toUpperCase(),
      rateSource: rateSource.trim(),
    };
    // Only send what actually differs, so the file keeps saying exactly what it
    // said about the keys nobody touched.
    const sameProjects = JSON.stringify(clean) === JSON.stringify(patch.projects);
    if (sameProjects) delete patch.projects;
    // `latest` is what the select shows when the file says nothing, so a file
    // without the key is not a reason to call the page dirty.
    const savedRateMode = loaded?.config.rateMode ?? 'latest';
    if (savedRateMode === rateMode) delete patch.rateMode;
    // An empty box is not "leave it alone": it removes the key, which is how a
    // setting goes back to the locale/whatever the tool would do on its own.
    if (loaded?.config.currency === (currency.trim().toUpperCase() || null)) delete patch.currency;
    if (loaded?.config.rateSource === (rateSource.trim() || null)) delete patch.rateSource;
    if (
      loaded !== null &&
      loaded.config.updates.pricing === updates.pricing &&
      loaded.config.updates.rates === updates.rates
    ) {
      delete patch.updates;
    }
    return patch;
  }, [loaded, projects, currency, rateMode, rateSource, updates]);

  const dirty = Object.keys(patch).length > 0;

  const onSave = (): void => {
    if (!dirty || status.kind === 'saving') return;
    setStatus({ kind: 'saving' });
    saveConfig(patch)
      .then((answer) => {
        adopt(answer);
        if (answer.refresh.ok) {
          setStatus({ kind: 'saved', ms: answer.refresh.ms });
          onSaved();
        } else {
          setStatus({ kind: 'savedSnapshot' });
        }
      })
      .catch((cause: unknown) => setStatus({ kind: 'failed', message: (cause as Error).message }));
  };

  /** Every workspace this scan found, with the ones already declared marked. */
  const scanned = useMemo(() => {
    const declared = projects.flatMap((group) => group.paths);
    const rows: { name: string; path: string; declared: boolean }[] = [];
    for (const project of dashboard?.projects ?? []) {
      for (const path of project.workspaces) {
        rows.push({ name: project.name, path, declared: declared.some((entry) => path === entry || path.startsWith(`${entry}/`)) });
      }
    }
    return rows.sort((left, right) => left.path.localeCompare(right.path));
  }, [dashboard, projects]);
  const ungrouped = scanned.filter((row) => !row.declared);

  if (error !== null) {
    return (
      <Card title={t.settings.title}>
        <p className="text-[12px] text-bad">{error}</p>
      </Card>
    );
  }
  if (loaded === null) {
    return (
      <Card title={t.settings.title}>
        <p className="text-[12px] text-faint">{t.app.loading}</p>
      </Card>
    );
  }

  const input = 'min-w-0 rounded border border-line bg-raised px-2 py-1 text-[12px] text-fg focus:border-accent focus:outline-none';
  const button = 'rounded border border-line px-2 py-1 text-[12px] text-muted hover:text-fg disabled:opacity-50';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-[18px] font-semibold">{t.settings.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={button}
            onClick={() => {
              setStatus({ kind: 'clean' });
              fetchConfig()
                .then(adopt)
                .catch((cause: unknown) => setError((cause as Error).message));
            }}
          >
            {t.settings.reload}
          </button>
          <button type="button" className={button} disabled={!dirty || status.kind === 'saving'} onClick={() => adopt({ ...loaded })}>
            {t.settings.discard}
          </button>
          <button
            type="button"
            data-save-config
            className="rounded border border-accent/50 bg-accent-soft px-2 py-1 text-[12px] text-accent disabled:opacity-50"
            disabled={!dirty || status.kind === 'saving'}
            title={t.settings.save}
            onClick={onSave}
          >
            {status.kind === 'saving' ? t.settings.saving : t.settings.save}
          </button>
        </div>
      </div>

      <p className="text-[11px] text-faint" title={loaded.path}>
        {t.settings.file(loaded.path)}
        {!loaded.exists && ` · ${t.settings.missingFile}`}
      </p>

      {/* The state of the last save, and anything wrong with the file. */}
      <div className="space-y-1 text-[11px]">
        {status.kind === 'saving' && <p className="text-muted">{t.settings.savingRescan}</p>}
        {status.kind === 'saved' && (
          <p className="text-good" data-config-status>
            {t.settings.saved(String(status.ms))}
          </p>
        )}
        {status.kind === 'savedSnapshot' && <p className="text-warn" data-config-status>{t.settings.savedSnapshot}</p>}
        {status.kind === 'failed' && (
          <p className="text-bad" data-config-status>
            {t.settings.failed}: {status.message}
          </p>
        )}
        {dirty && status.kind !== 'saving' && <p className="text-warn" data-dirty>{t.settings.dirty}</p>}
      </div>

      {loaded.warnings.length > 0 && (
        <Card title={t.settings.warnings(String(loaded.warnings.length))}>
          <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-muted">
            {loaded.warnings.map((warning) => (
              <li key={`${warning.code}:${warning.message.slice(0, 24)}`}>{warning.message}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card title={t.settings.projects.title}>
        <p className="mb-3 text-[11px] leading-5 text-faint">{t.settings.projects.note}</p>
        {projects.length === 0 && <p className="mb-2 text-[12px] text-faint">{t.settings.projects.empty}</p>}
        <ul className="space-y-3">
          {projects.map((group, index) => (
            <li key={index} className="rounded border border-line p-2">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  className={`${input} w-48`}
                  value={group.name}
                  placeholder={t.settings.projects.newGroup}
                  aria-label={t.settings.projects.name}
                  onChange={(event) =>
                    setProjects((rows) => rows.map((row, at) => (at === index ? { ...row, name: event.target.value } : row)))
                  }
                />
                <button
                  type="button"
                  className={button}
                  title={t.settings.projects.removeGroup}
                  onClick={() => setProjects((rows) => rows.filter((_, at) => at !== index))}
                >
                  ✕
                </button>
              </div>
              <ul className="mt-2 space-y-1">
                {group.paths.map((path, at) => (
                  <li key={`${path}:${at}`} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={path}>
                      {path}
                    </span>
                    <button
                      type="button"
                      className={button}
                      title={t.settings.projects.removePath}
                      onClick={() =>
                        setProjects((rows) =>
                          rows.map((row, position) =>
                            position === index ? { ...row, paths: row.paths.filter((_, offset) => offset !== at) } : row,
                          ),
                        )
                      }
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  className={`${input} max-w-72`}
                  value=""
                  data-add-path
                  aria-label={t.settings.projects.addPath}
                  title={t.settings.projects.addPathHint}
                  onChange={(event) => {
                    const path = event.target.value;
                    if (path.length === 0) return;
                    setProjects((rows) =>
                      rows.map((row, position) =>
                        position === index && !row.paths.includes(path) ? { ...row, paths: [...row.paths, path] } : row,
                      ),
                    );
                  }}
                >
                  <option value="">{t.settings.projects.pick}</option>
                  {scanned.map((row) => (
                    <option key={row.path} value={row.path}>
                      {row.path} · {row.name}
                    </option>
                  ))}
                </select>
                <input
                  className={`${input} w-64`}
                  placeholder={t.settings.projects.manualPlaceholder}
                  title={t.settings.projects.manual}
                  aria-label={t.settings.projects.manual}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    const path = event.currentTarget.value.trim();
                    if (path.length === 0) return;
                    event.currentTarget.value = '';
                    setProjects((rows) =>
                      rows.map((row, position) =>
                        position === index && !row.paths.includes(path) ? { ...row, paths: [...row.paths, path] } : row,
                      ),
                    );
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={`${button} mt-3`}
          onClick={() => setProjects((rows) => [...rows, { name: '', paths: [] }])}
        >
          {t.settings.projects.addGroup}
        </button>
        <p className="mt-3 text-[11px] text-faint">{t.settings.projects.ungrouped(String(ungrouped.length))}</p>
      </Card>

      <Card title={t.settings.general.title}>
        <div className="space-y-2 text-[12px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-28 text-faint">{t.settings.general.language}</span>
            <div className="flex overflow-hidden rounded border border-line">
              {(['zh', 'en'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`px-2 py-0.5 text-[11px] ${current === option ? 'bg-accent-soft text-accent' : 'text-muted hover:text-fg'}`}
                  onClick={() => onLanguage(option)}
                >
                  {option === 'zh' ? '中文' : 'EN'}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-faint">{t.settings.general.languageNote}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="w-28 text-faint">{t.settings.general.currency}</span>
            <input
              className={`${input} w-24`}
              value={currency}
              placeholder="CNY"
              onChange={(event) => setCurrency(event.target.value)}
            />
            <span className="text-[11px] text-faint">{t.settings.general.currencyNote}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="w-28 text-faint">{t.settings.general.rateMode}</span>
            <select
              className={input}
              value={rateMode}
              onChange={(event) => setRateMode(event.target.value === 'historical' ? 'historical' : 'latest')}
            >
              <option value="latest">{t.settings.general.rateModes.latest}</option>
              <option value="historical">{t.settings.general.rateModes.historical}</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="w-28 text-faint">{t.settings.general.rateSource}</span>
            <input
              className={`${input} w-40`}
              value={rateSource}
              placeholder={t.settings.general.rateSourcePlaceholder}
              onChange={(event) => setRateSource(event.target.value)}
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="w-28 text-faint">{t.settings.general.updates}</span>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={updates.pricing}
                onChange={(event) => setUpdates((value) => ({ ...value, pricing: event.target.checked }))}
              />
              {t.settings.general.updatePricing}
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={updates.rates}
                onChange={(event) => setUpdates((value) => ({ ...value, rates: event.target.checked }))}
              />
              {t.settings.general.updateRates}
            </label>
            <span className="text-[11px] text-faint">{t.settings.general.updatesNote}</span>
          </div>
        </div>
      </Card>

      <Card title={t.settings.pricing.title}>
        <p className="text-[12px] text-muted">
          {loaded.config.pricingProviders.length === 0
            ? t.settings.pricing.none
            : t.settings.pricing.some(loaded.config.pricingProviders.join('、'))}
        </p>
        <details className="mt-2">
          <summary className="cursor-pointer text-[11px] text-faint">{t.settings.pricing.document}</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-raised p-2 text-[11px] text-muted">
            {JSON.stringify(loaded.document, null, 2)}
          </pre>
        </details>
      </Card>

      <Card title={t.settings.projects.scanned}>
        <p className="mb-2 text-[11px] text-faint">{t.settings.projects.scannedNote}</p>
        <ul className="space-y-1 text-[12px]">
          {scanned.map((row) => (
            <li key={row.path} className="flex items-center gap-2">
              <span className="w-40 shrink-0 truncate text-muted">{row.name}</span>
              <span className="min-w-0 flex-1 truncate text-faint" title={row.path}>
                {row.path}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
