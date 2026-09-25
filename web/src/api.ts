/**
 * The API client.
 *
 * Every request is a plain `fetch` against the same origin (`agent-usages serve`
 * hosts both), with the query string built from one filter object so the URL the
 * browser shows and the URL the server sees agree.
 */

import type { Dashboard, RangeKey, RefreshReport, SessionDetail, TimeseriesBucket } from './types';

/** What the dashboard is filtered by. */
export interface Filters {
  /** Time range preset. */
  range: RangeKey;
  /** Agent ids; empty means every loaded agent. */
  agents: string[];
  /** Project ids; empty means every project. */
  projects: string[];
  /** Free-text project search. */
  search: string;
}

/** The filters an empty state starts from. */
export const DEFAULT_FILTERS: Filters = { range: 'all', agents: [], projects: [], search: '' };

/** Turn filters into the parameters the API reads. */
export function filterParams(filters: Filters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.range !== 'all') params.set('range', filters.range);
  if (filters.agents.length > 0) params.set('agent', filters.agents.join(','));
  if (filters.projects.length > 0) params.set('project', filters.projects.join(','));
  if (filters.search.trim().length > 0) params.set('q', filters.search.trim());
  return params;
}

/** One JSON request, with the server's own error message on failure. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    throw new Error(`${path}: 返回的不是 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const message = (body as { error?: { message?: string } } | undefined)?.error?.message;
    throw new Error(message ?? `${path}: HTTP ${response.status}`);
  }
  return body as T;
}

/** The whole dashboard for one set of filters. */
export function fetchDashboard(filters: Filters, signal?: AbortSignal): Promise<Dashboard> {
  const query = filterParams(filters).toString();
  return request<Dashboard>(`/api/dashboard${query.length === 0 ? '' : `?${query}`}`, { signal });
}

/** Usage over time, already aggregated per bucket. */
export function fetchTimeseries(
  filters: Filters,
  bucket: 'day' | 'hour',
  signal?: AbortSignal,
): Promise<{ points: TimeseriesBucket[] }> {
  const params = filterParams(filters);
  params.set('bucket', bucket);
  return request<{ points: TimeseriesBucket[] }>(`/api/timeseries?${params.toString()}`, { signal });
}

/** One session, with its delegation tree. */
export function fetchSession(uid: string, filters: Filters, signal?: AbortSignal): Promise<{ detail: SessionDetail }> {
  const params = filterParams(filters);
  const query = params.toString();
  return request<{ detail: SessionDetail }>(
    `/api/sessions/${encodeURIComponent(uid)}${query.length === 0 ? '' : `?${query}`}`,
    { signal },
  );
}

/** Rescan the agents on the server. */
export function refresh(): Promise<RefreshReport> {
  return request<RefreshReport>('/api/refresh', { method: 'POST' });
}
