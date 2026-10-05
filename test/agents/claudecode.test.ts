/**
 * Claude Code adapter tests.
 *
 * The fixtures mirror a real 2.1.278 demo run: a session file, and the subagent
 * file Claude Code files under the session-named `subagents/` directory.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudecodeAgent } from '../../src/agents/claudecode/loader.ts';

const SESSION = '112307e5-1035-404c-8fea-b6650edc8080';
const AGENT = 'af8b105c79ddcebf5';

let home: string;

/** One assistant entry, with the usage block Claude Code records. */
function assistant(
  uuid: string,
  timestamp: string,
  model: string,
  input: number,
  output: number,
  messageId = `msg-${uuid}`,
): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    parentUuid: null,
    sessionId: SESSION,
    timestamp,
    cwd: '/tmp/demo',
    version: '2.1.278',
    message: {
      id: messageId,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 7,
        output_tokens_details: { thinking_tokens: 3 },
      },
    },
  });
}

/** One `user` entry, the way Claude Code writes a prompt — or an injected block. */
function userEntry(uuid: string, timestamp: string, sessionId: string, content: unknown): string {
  return JSON.stringify({
    type: 'user',
    uuid,
    parentUuid: null,
    sessionId,
    timestamp,
    cwd: '/tmp/demo',
    message: { role: 'user', content },
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-usages-claude-'));
  const project = join(home, 'projects', '-tmp-demo');
  const subagents = join(project, SESSION, 'subagents');
  await mkdir(subagents, { recursive: true });

  await writeFile(
    join(project, `${SESSION}.jsonl`),
    [
      JSON.stringify({ type: 'user', uuid: 'u1', sessionId: SESSION, timestamp: '2026-09-23T00:00:00.000Z', cwd: '/tmp/demo' }),
      assistant('a1', '2026-09-23T00:00:01.000Z', 'deepseek-flash[1m]', 1_000, 100),
      // A rejected request Claude Code never sent: it must not become a request.
      assistant('a2', '2026-09-23T00:00:02.000Z', '<synthetic>', 0, 0),
      // The same response written again for a second content block: one request.
      assistant('a3', '2026-09-23T00:00:01.000Z', 'deepseek-flash[1m]', 1_000, 100, 'msg-a1'),
    ].join('\n') + '\n',
  );
  await writeFile(
    join(subagents, `agent-${AGENT}.jsonl`),
    // Subagent entries keep the parent's sessionId, which is why the id comes
    // from the file name instead.
    `${assistant('b1', '2026-09-23T00:00:03.000Z', 'deepseek-flash', 2_000, 50)}\n`,
  );
  // Claude Code stores a user-set session name next to the log.
  await writeFile(join(project, SESSION, 'custom-title.json'), JSON.stringify({ customTitle: '我的会话' }));
  await writeFile(
    join(subagents, `agent-${AGENT}.meta.json`),
    JSON.stringify({
      agentType: 'claude',
      description: 'Say hello',
      toolUseId: 'call_test',
      spawnDepth: 1,
      requestShape: 'foreground',
    }),
  );
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('reading a Claude Code home', () => {
  it('bills cache writes at the 1h tier when the log says so', async () => {
    // Claude Code splits the two ephemeral tiers, and the vendor charges 1h writes at
    // 2× input against 1.25× for 5m. Real logs are ~98.9% 1h (measured 2026-10-04), so
    // billing the summed bucket at the 5m rate undercharged every cache write by 1.6×
    // until this tier reached the record.
    const project = join(home, 'projects', '-tmp-demo');
    const id = 'eeeeeeee-1111-4111-8111-000000000001';
    await writeFile(
      join(project, `${id}.jsonl`),
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'ttl-1',
        parentUuid: null,
        sessionId: id,
        timestamp: '2026-09-23T00:00:05.000Z',
        cwd: '/tmp/demo',
        message: {
          id: 'msg-ttl',
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 3_000,
            cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
          },
        },
      })}\n`,
    );
    const data = await claudecodeAgent.load({ home });
    const records = data.sessions.flatMap((session) => session.records);
    expect(records.find((record) => record.tokens.cacheWrite === 3_000)?.cacheWriteTtl).toBe('1h');
  });

  it('leaves the tier alone when the log only reports the 5m bucket', async () => {
    const project = join(home, 'projects', '-tmp-demo');
    const id = 'eeeeeeee-1111-4111-8111-000000000002';
    await writeFile(
      join(project, `${id}.jsonl`),
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'ttl-2',
        parentUuid: null,
        sessionId: id,
        timestamp: '2026-09-23T00:00:06.000Z',
        cwd: '/tmp/demo',
        message: {
          id: 'msg-ttl-5m',
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 500,
            cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 },
          },
        },
      })}\n`,
    );
    const data = await claudecodeAgent.load({ home });
    const records = data.sessions.flatMap((session) => session.records);
    expect(records.find((record) => record.tokens.cacheWrite === 500)?.cacheWriteTtl).toBeUndefined();
  });

  it('carries both tiers of a mixed cache write, not just the larger one', async () => {
    // One request wrote both tiers: the 5m share must be billed as 5m even though
    // the record's headline tier is 1h, so the split travels with the record.
    const project = join(home, 'projects', '-tmp-demo');
    const id = 'eeeeeeee-1111-4111-8111-000000000003';
    await writeFile(
      join(project, `${id}.jsonl`),
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'ttl-3',
        parentUuid: null,
        sessionId: id,
        timestamp: '2026-09-23T00:00:07.000Z',
        cwd: '/tmp/demo',
        message: {
          id: 'msg-ttl-split',
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 3_000,
            cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
          },
        },
      })}\n`,
    );
    const data = await claudecodeAgent.load({ home });
    const record = data.sessions.flatMap((session) => session.records).find((entry) => entry.id.endsWith(':msg-ttl-split'));
    expect(record?.tokens.cacheWrite).toBe(3_000);
    expect(record?.cacheWriteTiers).toEqual({ '5m': 1_000, '1h': 2_000 });
    // The tier holding most of the write is the one a report labels it with.
    expect(record?.cacheWriteTtl).toBe('1h');
  });

  it('names the 5m tier when the 5m share is the larger one', async () => {
    const project = join(home, 'projects', '-tmp-demo');
    const id = 'eeeeeeee-1111-4111-8111-000000000004';
    await writeFile(
      join(project, `${id}.jsonl`),
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'ttl-4',
        parentUuid: null,
        sessionId: id,
        timestamp: '2026-09-23T00:00:08.000Z',
        cwd: '/tmp/demo',
        message: {
          id: 'msg-ttl-5m-majority',
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 3_000,
            cache_creation: { ephemeral_5m_input_tokens: 2_000, ephemeral_1h_input_tokens: 1_000 },
          },
        },
      })}\n`,
    );
    const data = await claudecodeAgent.load({ home });
    const record = data.sessions
      .flatMap((session) => session.records)
      .find((entry) => entry.id.endsWith(':msg-ttl-5m-majority'));
    expect(record?.cacheWriteTiers).toEqual({ '5m': 2_000, '1h': 1_000 });
    // The old single-tier rule would have called this whole write a 1h one.
    expect(record?.cacheWriteTtl).toBe('5m');
  });

  it('leaves a usage block with no breakdown without a split', async () => {
    const project = join(home, 'projects', '-tmp-demo');
    const id = 'eeeeeeee-1111-4111-8111-000000000005';
    await writeFile(
      join(project, `${id}.jsonl`),
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'ttl-5',
        parentUuid: null,
        sessionId: id,
        timestamp: '2026-09-23T00:00:09.000Z',
        cwd: '/tmp/demo',
        message: {
          id: 'msg-ttl-none',
          model: 'claude-opus-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 700 },
        },
      })}\n`,
    );
    const data = await claudecodeAgent.load({ home });
    const record = data.sessions.flatMap((session) => session.records).find((entry) => entry.id.endsWith(':msg-ttl-none'));
    expect(record?.tokens.cacheWrite).toBe(700);
    expect(record?.cacheWriteTiers).toBeUndefined();
    expect(record?.cacheWriteTtl).toBeUndefined();
  });
  it('keeps the fuller record when one message.id appears twice', async () => {
    // A replayed request can repeat a message id with a different usage; the
    // entry that finished (a `stop_reason`) and reported more output wins.
    const project = join(home, 'projects', '-tmp-demo');
    const id = 'dddddddd-0000-4000-8000-00000000000d';
    const entry = (uuid: string, timestamp: string, output: number, stop: boolean): string =>
      JSON.stringify({
        type: 'assistant',
        uuid,
        parentUuid: null,
        sessionId: id,
        timestamp,
        cwd: '/tmp/demo',
        message: {
          id: 'msg-dup',
          model: 'deepseek-flash',
          ...(stop ? { stop_reason: 'end_turn' } : {}),
          usage: { input_tokens: 100, output_tokens: output },
        },
      });
    await writeFile(
      join(project, `${id}.jsonl`),
      `${[entry('p1', '2026-09-23T00:30:01.000Z', 1, false), entry('p2', '2026-09-23T00:30:02.000Z', 40, true)].join('\n')}\n`,
    );

    const data = await claudecodeAgent.load({ home });
    const session = data.sessions.find((candidate) => candidate.id === id);
    expect(session?.records).toHaveLength(1);
    expect(session?.records[0]?.tokens.output).toBe(40);
  });

  it('names a session from custom-title.json', async () => {
    const data = await claudecodeAgent.load({ home });
    const session = data.sessions.find((candidate) => candidate.id === SESSION);
    expect(session?.title).toBe('我的会话');
  });

  it('bills assistant entries and strips the model suffix', async () => {
    const data = await claudecodeAgent.load({ home });
    const session = data.sessions.find((candidate) => candidate.id === SESSION);
    expect(session?.records).toHaveLength(1);
    expect(session?.records[0]?.model).toBe('deepseek-flash');
    expect(session?.records[0]?.modelLabel).toBe('deepseek-flash[1m]');
    expect(session?.records[0]?.tokens).toEqual({
      input: 1_000,
      output: 100,
      cacheRead: 5,
      cacheWrite: 7,
      reasoning: 3,
    });
    expect(session?.isSubagent).toBe(false);
  });

  it('reads a subagent from the session-named directory', async () => {
    const data = await claudecodeAgent.load({ home });
    const child = data.sessions.find((candidate) => candidate.id === AGENT);
    const parent = data.sessions.find((candidate) => candidate.id === SESSION);
    expect(child?.isSubagent).toBe(true);
    expect(child?.depth).toBe(1);
    expect(child?.parentId).toBe(SESSION);
    expect(child?.parentKnown).toBe(true);
    expect(child?.records).toHaveLength(1);
    // The description the parent gave it is the title.
    expect(child?.title).toBe('Say hello');
    expect(child?.extra).toEqual({
      agentType: 'claude',
      description: 'Say hello',
      toolUseId: 'call_test',
    });
    expect(parent?.childIds).toEqual([AGENT]);
  });

  it('drops the history a fork copied from its source', async () => {
    // `claude --fork-session` copies the source's entries — same `message.id`,
    // no back-pointer — so the inherited calls are recognised by their ids.
    const project = join(home, 'projects', '-tmp-demo');
    const forkId = 'ffffffff-0000-4000-8000-00000000000f';
    const fork = [
      JSON.stringify({ type: 'user', uuid: 'u2', sessionId: forkId, timestamp: '2026-09-23T00:10:00.000Z', cwd: '/tmp/demo' }),
      assistant('f1', '2026-09-23T00:10:01.000Z', 'deepseek-flash', 1_000, 100, 'msg-a1'),
      assistant('f2', '2026-09-23T00:10:02.000Z', 'deepseek-flash', 3_000, 70, 'msg-new'),
    ].join('\n');
    await writeFile(join(project, `${forkId}.jsonl`), `${fork}\n`);

    const data = await claudecodeAgent.load({ home });
    const forked = data.sessions.find((session) => session.id === forkId);
    const source = data.sessions.find((session) => session.id === SESSION);
    // Only the call the fork made itself is billed here.
    expect(forked?.records.map((record) => record.id)).toEqual([`${forkId}:msg-new`]);
    expect(forked?.parentId).toBe(SESSION);
    expect(forked?.isSubagent).toBe(false);
    expect(forked?.extra?.['forkedFrom']).toBe(SESSION);
    expect(forked?.extra?.['inheritedRequests']).toBe(1);
    expect(source?.childIds).toEqual([AGENT]);
  });

  it('reports where a session branched', async () => {
    // `--resume-session-at` branches in place: the log only grows, and the
    // branch appears as one message with two children.
    const project = join(home, 'projects', '-tmp-demo');
    const branchId = 'eeeeeeee-0000-4000-8000-00000000000e';
    const shared = (uuid: string, timestamp: string, id: string): string =>
      JSON.stringify({
        type: 'assistant',
        uuid,
        parentUuid: 'branch-root',
        sessionId: branchId,
        timestamp,
        cwd: '/tmp/demo',
        message: { id, model: 'deepseek-flash', usage: { input_tokens: 10, output_tokens: 1 } },
      });
    await writeFile(
      join(project, `${branchId}.jsonl`),
      `${[shared('c1', '2026-09-23T00:20:01.000Z', 'b1'), shared('c2', '2026-09-23T00:20:02.000Z', 'b2')].join('\n')}\n`,
    );
    const data = await claudecodeAgent.load({ home });
    const branched = data.sessions.find((session) => session.id === branchId);
    expect(branched?.extra?.['branchPoints']).toBe(1);
  });

  it('says nothing when every session was read from one file', async () => {
    const data = await claudecodeAgent.load({ home });
    expect(data.warnings.filter((warning) => warning.code === 'claudecodeSessionMerged')).toHaveLength(0);
  });

  it('merges two logs of one session in the same root, and says so once', async () => {
    // Resuming a session in another working directory writes the conversation
    // into that project's directory as well: the same session id, a log that
    // repeats one call and adds one of its own.
    const other = join(home, 'projects', '-tmp-other');
    await mkdir(other, { recursive: true });
    await writeFile(
      join(other, `${SESSION}.jsonl`),
      [
        JSON.stringify({ type: 'user', uuid: 'u9', sessionId: SESSION, timestamp: '2026-09-23T00:00:09.000Z', cwd: '/tmp/other' }),
        assistant('c1', '2026-09-23T00:00:10.000Z', 'deepseek-flash', 1_000, 100, 'msg-a1'),
        assistant('c2', '2026-09-23T00:00:11.000Z', 'deepseek-flash', 500, 20, 'msg-extra'),
      ].join('\n') + '\n',
    );

    const data = await claudecodeAgent.load({ home });
    const sessions = data.sessions.filter((session) => session.id === SESSION);
    // One conversation however many files carry it: `msg-a1` once, `msg-extra`
    // only the second file had.
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.records.map((record) => record.id)).toEqual([`${SESSION}:msg-a1`, `${SESSION}:msg-extra`]);

    const merged = data.warnings.filter((warning) => warning.code === 'claudecodeSessionMerged');
    expect(merged).toHaveLength(1);
    expect(merged[0]?.message).toContain(SESSION);
    expect(merged[0]?.message).toContain('-tmp-demo');
    expect(merged[0]?.message).toContain('-tmp-other');
  });

  it('groups sessions under the project their cwd names', async () => {
    const data = await claudecodeAgent.load({ home });
    expect(data.agent).toBe('claudecode');
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0]?.path).toBe('/tmp/demo');
    expect(data.projects[0]?.name).toBe('demo');
    expect(data.stats.records).toBe(2);
    expect(await claudecodeAgent.hasData(home)).toBe(true);
    expect(await claudecodeAgent.hasData(join(home, 'nope'))).toBe(false);
  });
});

describe('one session with two logs', () => {
  it('folds a session resumed in another working directory into one row', async () => {
    // `--resume` in a different cwd makes Claude Code open a second file under
    // *that* directory's project, with the same session id: one conversation in
    // two logs. What both logs repeat is one API call and what only the second
    // holds is not a duplicate, so the two files union instead of the second one
    // replacing the first (or being dropped).
    const id = 'bbbbbbbb-1111-4111-8111-00000000000b';
    const entry = (uuid: string, messageId: string, time: string, cwd: string): string =>
      JSON.stringify({
        type: 'assistant',
        uuid,
        parentUuid: null,
        sessionId: id,
        timestamp: time,
        cwd,
        message: {
          id: messageId,
          model: 'deepseek-flash',
          usage: { input_tokens: 1_000, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      });
    const elsewhere = join(home, 'projects', '-tmp-elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await writeFile(
      join(home, 'projects', '-tmp-demo', `${id}.jsonl`),
      `${entry('orig-1', 'msg-orig', '2026-09-24T00:00:01.000Z', '/tmp/demo')}\n`,
    );
    await writeFile(
      join(elsewhere, `${id}.jsonl`),
      [
        // The same call the original log already billed, written again under the
        // new cwd, plus one the original log does not have.
        entry('moved-1', 'msg-orig', '2026-09-24T00:00:01.000Z', '/tmp/elsewhere'),
        entry('moved-2', 'msg-new', '2026-09-24T00:00:02.000Z', '/tmp/elsewhere'),
      ].join('\n') + '\n',
    );

    const data = await claudecodeAgent.load({ home });
    const rows = data.sessions.filter((session) => session.id === id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.records.map((candidate) => candidate.id)).toEqual([`${id}:msg-orig`, `${id}:msg-new`]);
  });
});

describe('titling a Claude Code session', () => {
  const project = (): string => join(home, 'projects', '-tmp-demo');

  /** Write one log whose entries are given in file order. */
  async function writeSession(id: string, entries: string[]): Promise<void> {
    await writeFile(join(project(), `${id}.jsonl`), `${entries.join('\n')}\n`);
  }

  /** The title the loader gave one session id. */
  async function titleOf(id: string): Promise<string | null | undefined> {
    const data = await claudecodeAgent.load({ home });
    return data.sessions.find((candidate) => candidate.id === id)?.title;
  }

  it('prefers the name the user set over the opening prompt', async () => {
    const id = '0c0c0c0c-0000-4000-8000-00000000000c';
    await writeSession(id, [
      userEntry('u1', '2026-09-23T00:40:00.000Z', id, 'Fix the flaky retry helper'),
      assistant('a1', '2026-09-23T00:40:01.000Z', 'deepseek-flash', 100, 10),
    ]);
    // Claude Code keeps the user's own name next to the log; it used to lose to
    // the opening prompt whenever the session had one.
    await mkdir(join(project(), id), { recursive: true });
    await writeFile(join(project(), id, 'custom-title.json'), JSON.stringify({ customTitle: 'Retry helper' }));

    expect(await titleOf(id)).toBe('Retry helper');
  });

  it('prefers a compaction summary over the opening prompt', async () => {
    const id = '0e0e0e0e-0000-4000-8000-00000000000e';
    await writeSession(id, [
      userEntry('u1', '2026-09-23T00:41:00.000Z', id, 'Investigate the slow dashboard query'),
      JSON.stringify({ type: 'summary', summary: 'Dashboard query performance', leafUuid: 'u2' }),
    ]);

    expect(await titleOf(id)).toBe('Dashboard query performance');
  });

  it('skips injected blocks and takes the first real user input', async () => {
    const id = '0f0f0f0f-0000-4000-8000-00000000000f';
    await writeSession(id, [
      userEntry('u1', '2026-09-23T00:42:00.000Z', id, '<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.</local-command-caveat>'),
      userEntry('u2', '2026-09-23T00:42:01.000Z', id, '<command-name>/resume</command-name>\n            <command-message>resume</command-message>\n            <command-args></command-args>'),
      userEntry('u3', '2026-09-23T00:42:02.000Z', id, '<local-command-stdout>Session was not found.</local-command-stdout>'),
      userEntry('u4', '2026-09-23T00:42:03.000Z', id, '<system-reminder>\nKeep the answer short.\n</system-reminder>'),
      // A prompt can also arrive beside an image, so the text blocks are joined.
      userEntry('u5', '2026-09-23T00:42:04.000Z', id, [
        { type: 'text', text: 'Rewrite the paste helper' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ]),
    ]);

    const title = await titleOf(id);
    expect(title).toBe('Rewrite the paste helper');
    expect(title?.startsWith('<')).toBe(false);
  });

  it('leaves a scaffolding-only or empty session untitled', async () => {
    const onlyScaffolding = '1a1a1a1a-0000-4000-8000-00000000001a';
    await writeSession(onlyScaffolding, [
      userEntry('s1', '2026-09-23T00:43:00.000Z', onlyScaffolding, '<task-notification>\n<task-id>demo</task-id>\n</task-notification>'),
    ]);
    // A session that was never used has no user entry at all.
    const empty = '1b1b1b1b-0000-4000-8000-00000000001b';
    await writeSession(empty, [
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: null,
        sessionId: empty,
        timestamp: '2026-09-23T00:44:00.000Z',
        cwd: '/tmp/demo',
        message: { id: 'msg-empty', model: 'deepseek-flash', usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    ]);

    const data = await claudecodeAgent.load({ home });
    const titles = data.sessions.filter((session) => session.id === onlyScaffolding || session.id === empty);
    expect(titles.map((session) => session.title)).toEqual([null, null]);
  });

  it('clips a long prompt at a word boundary, not mid-word', async () => {
    // 96 characters, and the 80-char window ends inside `permitted`.
    const id = '2a2a2a2a-0000-4000-8000-00000000002a';
    const prompt = "Refused to start the preview because 'quick-mode' or 'safe-mode' is not permitted by the sandbox";
    await writeSession(id, [userEntry('u1', '2026-09-23T00:45:00.000Z', id, prompt)]);

    const title = await titleOf(id);
    expect(title).toBe("Refused to start the preview because 'quick-mode' or 'safe-mode' is not");
    expect(prompt.startsWith(title as string)).toBe(true);
    expect(prompt[(title as string).length]).toBe(' ');
    expect(prompt.slice(0, 80).trim()).not.toBe(title);
  });
});
