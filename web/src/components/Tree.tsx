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
import { AgentBadge, Chip, MetricSplit, MoneyTokens } from './Bits';

/** The four billed buckets, which is what the compact tree row counts as "tok". */
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
  const projects = dashboard.projects;

  const totalCost = useMemo(
    () => projects.reduce((total, project) => total + Number(project.cost.total), 0),
    [projects],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="text-[12px] font-semibold text-muted">
          项目 <span className="tnum text-faint">{projects.length}</span>
        </div>
        <button
          type="button"
          onClick={() => onSelectProject(null)}
          className={`rounded border px-2 py-0.5 text-[11px] ${
            selectedProjectId === null ? 'border-accent/60 bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'
          }`}
        >
          全部
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {projects.length === 0 && <p className="px-2 py-4 text-[12px] text-faint">没有匹配的项目。</p>}
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
        共 {formatCost(String(totalCost), symbol)} · {formatTokens(dashboard.totals.requests)} 次请求
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
          aria-label={expanded ? '收起' : '展开'}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <button type="button" onClick={() => onSelectProject(project.id)} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-1.5">
            <span className="cell-title font-medium" title={`${project.name}\n${project.workspaces.join('\n')}`}>
              {project.name}
            </span>
            <Chip tone={project.kind === 'repo' ? 'accent' : 'muted'} title={project.kind === 'repo' ? 'git 仓库（含各 worktree）' : '单个目录'}>
              {project.kind === 'repo' ? 'repo' : 'path'}
            </Chip>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            {project.agents.map((agent) => (
              <AgentBadge key={agent} id={agent} small />
            ))}
            <span className="tnum text-[11px] text-faint">
              会话 {project.sessions}／子代理 {project.subagentSessions}／工作区 {project.workspaces.length}
            </span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <span className="tnum text-[11px] text-faint">最近 {formatInstant(project.lastUsage)}</span>
            <MoneyTokens
              cost={project.cost.total}
              tokens={billed(project.tokens)}
              symbol={symbol}
              requests={project.requests}
              hint={metricText(project.tokens, project.cost, project.requests, symbol)}
            />
          </div>
        </button>
      </div>
      {selected && (
        // The full line does not fit a 340px column, so it appears for the row
        // the reader is actually looking at, and on hover for the others.
        <div className="ml-3 border-l border-line pl-2">
          <MetricSplit
            total={{ tokens: project.tokens, cost: project.cost, requests: project.requests }}
            own={{ tokens: project.own.tokens, cost: project.own.cost, requests: project.own.requests }}
            spawned={{ tokens: project.spawned.tokens, cost: project.spawned.cost, requests: project.spawned.requests }}
            symbol={symbol}
          />
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
          aria-label={expanded ? '收起' : '展开'}
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
              会话 {workspace.sessionCount}／子代理 {workspace.subagentCount}
            </span>
            <MoneyTokens
              cost={workspace.cost.total}
              tokens={billed(workspace.tokens)}
              symbol={symbol}
              requests={workspace.requests}
              hint={metricText(workspace.tokens, workspace.cost, workspace.requests, symbol)}
            />
          </div>
        </div>
      </div>
      {expanded && (
        <div className="ml-3 border-l border-line pl-1">
          {roots.length === 0 && <p className="px-2 py-1 text-[11px] text-faint">这个工作区在当前时间范围内没有消耗。</p>}
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
  const children = useMemo(() => childrenOf(sessions, session, present), [sessions, session, present]);
  const key = `s:${session.uid}`;
  const expanded = open[key] === true;
  const selected = selectedSessionUid === session.uid;
  const title = session.title ?? `（无标题会话 ${session.id.slice(0, 8)}）`;
  return (
    <div>
      <div className={`flex items-start gap-1 rounded px-1.5 py-1 ${selected ? 'bg-accent-soft' : 'hover:bg-raised'}`}>
        <button
          type="button"
          onClick={() => (children.length > 0 ? toggle(key) : onSelectSession(session.uid))}
          className="mt-0.5 w-3 shrink-0 text-[10px] text-faint hover:text-fg"
          aria-label={children.length > 0 ? (expanded ? '收起' : '展开') : '查看'}
        >
          {children.length > 0 ? (expanded ? '▾' : '▸') : '·'}
        </button>
        <button type="button" onClick={() => onSelectSession(session.uid)} className="min-w-0 flex-1 text-left">
          <div className="cell-title text-[12px]" title={title}>
            {title}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <AgentBadge id={session.agent} small />
            {session.archived && <Chip tone="muted">已归档</Chip>}
            {children.length > 0 && <Chip tone="muted">子代理 {children.length}</Chip>}
            <span className="tnum text-[11px] text-faint">{formatInstant(session.lastUsage)}</span>
            <MoneyTokens
              cost={session.cost.total}
              tokens={billed(session.tokens)}
              symbol={symbol}
              requests={session.requests}
              hint={metricText(session.total.tokens, session.total.cost, session.total.requests, symbol)}
            />
          </div>
        </button>
      </div>
      {selected && session.spawned.requests > 0 && (
        <div className="ml-6 border-l border-line pl-2">
          <MetricSplit
            total={{ tokens: session.total.tokens, cost: session.total.cost, requests: session.total.requests }}
            own={{ tokens: session.own.tokens, cost: session.own.cost, requests: session.own.requests }}
            spawned={{ tokens: session.spawned.tokens, cost: session.spawned.cost, requests: session.spawned.requests }}
            symbol={symbol}
          />
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
