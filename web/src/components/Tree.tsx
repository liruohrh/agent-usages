/**
 * The left column: 项目 → 工作区 → 会话 → 子代理.
 *
 * Every level is a disclosure row that stays one line tall (a title clamps to two,
 * a path truncates in the middle) so a long session name cannot push the numbers
 * off screen. Every row names its agent; a project row names all of them.
 */

import { useMemo, useState } from 'react';

import type { Dashboard, ProjectSummary, SessionNode, WorkspaceNode } from '../types';
import { formatCost, formatInstant, formatTokens, metricText, shortenPath } from '../format';
import { AgentBadge, Chip, MoneyTokens } from './Bits';
import { useT } from '../i18n';

/** The four billed buckets, which is what the compact tree row counts as `T`. */
function billed(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/** Which rows are open, keyed by a stable id per level. */
type OpenState = Record<string, boolean>;

/** Sort sessions newest first, subagents under their parent. */
function sortSessions(sessions: readonly SessionNode[]): SessionNode[] {
  return [...sessions].sort(
    (left, right) => (right.lastUsage ?? 0) - (left.lastUsage ?? 0) || left.uid.localeCompare(right.uid),
  );
}

/** Children of one session inside the same project. */
function childrenOf(sessions: readonly SessionNode[], parent: SessionNode, present: Set<string>): SessionNode[] {
  return sortSessions(
    sessions.filter(
      (candidate) => candidate.parentId === parent.id && candidate.agent === parent.agent && present.has(candidate.uid),
    ),
  );
}

/**
 * The tree.
 * @param props - the dashboard (already filtered by the server) and the selection callbacks.
 */
export function ProjectTree({
  dashboard,
  selectedProjectId,
  selectedSessionUid,
  onSelectProject,
  onSelectSession,
  symbol,
}: {
  dashboard: Dashboard;
  selectedProjectId: string | null;
  selectedSessionUid: string | null;
  onSelectProject: (id: string | null) => void;
  onSelectSession: (uid: string) => void;
  symbol: string;
}): React.ReactElement {
  const [open, setOpen] = useState<OpenState>({});
  const toggle = (key: string): void => setOpen((state) => ({ ...state, [key]: state[key] !== true }));
  const t = useT();
  const projects = dashboard.projects;

  const totalCost = useMemo(
    () => projects.reduce((total, project) => total + Number(project.cost.total), 0),
    [projects],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="text-[12px] font-semibold text-muted">
          {t.tree.title} <span className="tnum text-faint">{projects.length}</span>
        </div>
        <button
          type="button"
          onClick={() => onSelectProject(null)}
          className={`rounded border px-2 py-0.5 text-[11px] ${
            selectedProjectId === null ? 'border-accent/60 bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'
          }`}
        >
          {t.tree.all}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {projects.length === 0 && <p className="px-2 py-4 text-[12px] text-faint">{t.tree.none}</p>}
        {projects.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            symbol={symbol}
            open={open}
            toggle={toggle}
            selectedProjectId={selectedProjectId}
            selectedSessionUid={selectedSessionUid}
            onSelectProject={onSelectProject}
            onSelectSession={onSelectSession}
          />
        ))}
      </div>
      <div className="border-t border-line px-3 py-1.5 text-[11px] text-faint">
        {t.tree.total(formatCost(String(totalCost), symbol), formatTokens(dashboard.totals.requests))}
      </div>
    </div>
  );
}

/** One project, its workspaces and their sessions. */
function ProjectRow({
  project,
  symbol,
  open,
  toggle,
  selectedProjectId,
  selectedSessionUid,
  onSelectProject,
  onSelectSession,
}: {
  project: ProjectSummary;
  symbol: string;
  open: OpenState;
  toggle: (key: string) => void;
  selectedProjectId: string | null;
  selectedSessionUid: string | null;
  onSelectProject: (id: string | null) => void;
  onSelectSession: (uid: string) => void;
}): React.ReactElement {
  const t = useT();
  const key = `p:${project.id}`;
  const expanded = open[key] === true;
  const selected = selectedProjectId === project.id;
  return (
    <div className="mb-0.5">
      <div
        className={`flex items-start gap-1 rounded px-1.5 py-1 ${selected ? 'bg-accent-soft' : 'hover:bg-raised'}`}
      >
        <button
          type="button"
          onClick={() => toggle(key)}
          className="mt-0.5 w-3 shrink-0 text-[10px] text-faint hover:text-fg"
          aria-label={expanded ? t.tree.collapse : t.tree.expand}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <button type="button" onClick={() => onSelectProject(project.id)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-1.5">
            <span className="cell-title font-medium" title={`${project.name}\n${project.workspaces.join('\n')}`}>
              {project.name}
            </span>
            <Chip tone={project.kind === 'repo' ? 'accent' : 'muted'} title={project.kind === 'repo' ? t.tree.repoHint : t.tree.pathHint}>
              {project.kind === 'repo' ? 'repo' : 'path'}
            </Chip>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {project.agents.map((agent) => (
              <AgentBadge key={agent} id={agent} small />
            ))}
            <span className="tnum text-[11px] text-faint">
              {t.tree.counts(String(project.sessions), String(project.subagentSessions), String(project.workspaces.length))}
            </span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className="tnum text-[11px] text-faint">{t.tree.last(formatInstant(project.lastUsage))}</span>
            <MoneyTokens
              cost={project.cost.total}
              tokens={billed(project.tokens)}
              symbol={symbol}
              hint={metricText(project.tokens, project.cost, project.requests, symbol)}
            />
          </div>
        </button>
      </div>
      {selected && (
        // Two short lines, not the ten-figure line: the sidebar is 340px wide, and
        // the full breakdown belongs in the panel the row opens.
        <div className="ml-3 space-y-0.5 border-l border-line pl-3 pb-1 text-[12px] text-muted">
          <div>
            {t.tree.own} <span className="tnum text-fg">{formatCost(project.own.cost.total, symbol)}</span>
            <span className="text-faint"> · Q {formatTokens(project.own.requests)}</span>
          </div>
          {project.spawned.requests > 0 && (
            <div>
              {t.tree.spawned} <span className="tnum text-fg">{formatCost(project.spawned.cost.total, symbol)}</span>
              <span className="text-faint"> · Q {formatTokens(project.spawned.requests)}</span>
            </div>
          )}
        </div>
      )}
      {expanded && (
        <div className="ml-3 border-l border-line pl-1">
          {project.workspaceNodes.map((workspace) => (
            <WorkspaceRow
              key={workspace.path}
              workspace={workspace}
              symbol={symbol}
              open={open}
              toggle={toggle}
              selectedSessionUid={selectedSessionUid}
              onSelectSession={onSelectSession}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One workspace: path, agents, and the sessions that ran in it. */
function WorkspaceRow({
  workspace,
  symbol,
  open,
  toggle,
  selectedSessionUid,
  onSelectSession,
}: {
  workspace: WorkspaceNode;
  symbol: string;
  open: OpenState;
  toggle: (key: string) => void;
  selectedSessionUid: string | null;
  onSelectSession: (uid: string) => void;
}): React.ReactElement {
  const t = useT();
  const key = `w:${workspace.path}`;
  const expanded = open[key] === true;
  const sessions = useMemo(() => sortSessions(workspace.sessionReports), [workspace.sessionReports]);
  const present = useMemo(() => new Set(sessions.map((session) => session.uid)), [sessions]);
  const roots = useMemo(
    () => sessions.filter((session) => session.parentId === null || !present.has(`${session.agent}:${session.parentId}`)),
    [sessions, present],
  );
  return (
    <div>
      <div className="flex items-start gap-1 rounded px-1.5 py-1 hover:bg-raised">
        <button
          type="button"
          onClick={() => toggle(key)}
          className="mt-0.5 w-3 shrink-0 text-[10px] text-faint hover:text-fg"
          aria-label={expanded ? t.tree.collapse : t.tree.expand}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] text-fg" title={workspace.path} dir="rtl">
            {shortenPath(workspace.path, 40)}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {workspace.agents.map((agent) => (
              <AgentBadge key={agent} id={agent} small />
            ))}
            <span className="tnum text-[11px] text-faint">
              {t.tree.workspaceCounts(String(workspace.sessionCount), String(workspace.subagentCount))}
            </span>
            <MoneyTokens
              cost={workspace.cost.total}
              tokens={billed(workspace.tokens)}
              symbol={symbol}
              hint={metricText(workspace.tokens, workspace.cost, workspace.requests, symbol)}
            />
          </div>
        </div>
      </div>
      {expanded && (
        <div className="ml-3 border-l border-line pl-1">
          {roots.length === 0 && <p className="px-2 py-1 text-[11px] text-faint">{t.tree.noUsage}</p>}
          {roots.map((session) => (
            <SessionRow
              key={session.uid}
              session={session}
              sessions={sessions}
              present={present}
              symbol={symbol}
              open={open}
              toggle={toggle}
              selectedSessionUid={selectedSessionUid}
              onSelectSession={onSelectSession}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One session, with its subagents nested underneath. */
function SessionRow({
  session,
  sessions,
  present,
  symbol,
  open,
  toggle,
  selectedSessionUid,
  onSelectSession,
}: {
  session: SessionNode;
  sessions: readonly SessionNode[];
  present: Set<string>;
  symbol: string;
  open: OpenState;
  toggle: (key: string) => void;
  selectedSessionUid: string | null;
  onSelectSession: (uid: string) => void;
}): React.ReactElement {
  const t = useT();
  const children = useMemo(() => childrenOf(sessions, session, present), [sessions, session, present]);
  const key = `s:${session.uid}`;
  const expanded = open[key] === true;
  const selected = selectedSessionUid === session.uid;
  const title = session.title ?? t.tree.untitled(session.id.slice(0, 8));
  return (
    <div>
      <div className={`flex items-start gap-1 rounded px-1.5 py-1 ${selected ? 'bg-accent-soft' : 'hover:bg-raised'}`}>
        <button
          type="button"
          onClick={() => (children.length > 0 ? toggle(key) : onSelectSession(session.uid))}
          className="mt-0.5 w-3 shrink-0 text-[10px] text-faint hover:text-fg"
          aria-label={children.length > 0 ? (expanded ? t.tree.collapse : t.tree.expand) : t.tree.view}
        >
          {children.length > 0 ? (expanded ? '▾' : '▸') : '·'}
        </button>
        <button type="button" onClick={() => onSelectSession(session.uid)} className="min-w-0 flex-1 text-left">
          <div className="cell-title text-[12px]" title={title}>
            {title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <AgentBadge id={session.agent} small />
            {session.archived && <Chip tone="muted">{t.tree.archived}</Chip>}
            {children.length > 0 && <Chip tone="muted">{t.tree.subagents(String(children.length))}</Chip>}
            <span className="tnum text-[11px] text-faint">{formatInstant(session.lastUsage)}</span>
            <MoneyTokens
              cost={session.cost.total}
              tokens={billed(session.tokens)}
              symbol={symbol}
              hint={metricText(session.total.tokens, session.total.cost, session.total.requests, symbol)}
            />
          </div>
        </button>
      </div>
      {selected && session.spawned.requests > 0 && (
        <div className="ml-6 border-l border-line pl-3 pb-1 text-[12px] text-muted">
          {t.tree.own} <span className="tnum text-fg">{formatCost(session.own.cost.total, symbol)}</span>
          <span className="text-faint"> · {t.tree.spawned} </span>
          <span className="tnum text-fg">{formatCost(session.spawned.cost.total, symbol)}</span>
        </div>
      )}
      {expanded && children.length > 0 && (
        <div className="ml-3 border-l border-line pl-1">
          {children.map((child) => (
            <SessionRow
              key={child.uid}
              session={child}
              sessions={sessions}
              present={present}
              symbol={symbol}
              open={open}
              toggle={toggle}
              selectedSessionUid={selectedSessionUid}
              onSelectSession={onSelectSession}
            />
          ))}
        </div>
      )}
    </div>
  );
}
