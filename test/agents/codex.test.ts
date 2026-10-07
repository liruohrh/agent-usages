/**
 * Codex adapter tests.
 *
 * Rollouts are built the way Codex writes them: `session_meta`, a
 * `turn_context`, and `token_count` events that carry a delta *and* a running
 * total — including the fork case, whose inherited total has no event behind it.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { codexAgent } from '../../src/agents/codex/loader.ts';
import type { UsageRecord } from '../../src/core/types.ts';

const PARENT = '01a0ca09-f65d-72c1-baf0-567e3e04ec8d';
const CHILD = '01a0ca0b-4181-7433-884b-58ccbd8701e9';

let home: string;

/** One `response_item` user message, the way Codex writes a prompt. */
function userMessage(ordinal: number, text: string): unknown {
  return {
    timestamp: `2026-09-23T00:1${ordinal}:00.000Z`,
    ordinal,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  };
}

/** One `session_meta` header. */
function meta(id: string, extra: Record<string, unknown> = {}): unknown {
  return {
    timestamp: '2026-09-23T00:10:00.000Z',
    ordinal: 0,
    type: 'session_meta',
    payload: { id, session_id: id, cwd: '/tmp/demo', ...extra },
  };
}

/** Write one extra rollout into the fixture home's day directory. */
async function writeRollout(name: string, entries: unknown[]): Promise<void> {
  const day = join(home, 'sessions', '2026', '09', '23');
  await writeFile(
    join(day, `rollout-${name}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
}

/** Codex's six counters, as a `token_count` event reports them. */
function counters(input: number, cached: number, output: number, reasoning: number): Record<string, number> {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

/** One `token_count` event carrying both the delta and the running total. */
function tokenCount(ordinal: number, delta: Record<string, number>, total: Record<string, number>): string {
  return JSON.stringify({
    timestamp: `2026-09-23T00:0${ordinal}:00.000Z`,
    ordinal,
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: delta } },
  });
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-usages-codex-'));
  const day = join(home, 'sessions', '2026', '09', '23');
  await mkdir(day, { recursive: true });

  const parent = [
    JSON.stringify({
      timestamp: '2026-09-23T00:00:00.000Z',
      ordinal: 0,
      type: 'session_meta',
      payload: { id: PARENT, session_id: PARENT, cwd: '/tmp/demo' },
    }),
    JSON.stringify({ timestamp: '2026-09-23T00:00:00.500Z', ordinal: 0, type: 'turn_context', payload: { model: 'deepseek-flash', cwd: '/tmp/demo' } }),
    tokenCount(1, counters(1000, 800, 100, 20), counters(1000, 800, 100, 20)),
    // The same call again in its other rendering: it must not be billed twice.
    JSON.stringify({
      timestamp: '2026-09-23T00:01:00.000Z',
      ordinal: 1,
      type: 'token_usage_record',
      payload: { usage: counters(1000, 800, 100, 20) },
    }),
    tokenCount(2, counters(2000, 1500, 200, 50), counters(3000, 2300, 300, 70)),
  ].join('\n');
  await writeFile(join(day, `rollout-2026-09-23T00-00-00-${PARENT}.jsonl`), `${parent}\n`);

  const child = [
    JSON.stringify({
      timestamp: '2026-09-23T00:02:00.000Z',
      ordinal: 0,
      type: 'session_meta',
      payload: {
        id: CHILD,
        // A subagent's session_id names its parent, not itself.
        session_id: PARENT,
        cwd: '/tmp/demo',
        thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_path: '/root/math' } } },
      },
    }),
    JSON.stringify({
      timestamp: '2026-09-23T00:02:00.500Z',
      ordinal: 1,
      type: 'response_item',
      payload: {
        type: 'agent_message',
        author: '/root',
        recipient: '/root/math',
        content: [
          { type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/math\nSender: /root\nPayload:\nAdd 1+1 and reply with the number.' },
        ],
      },
    }),
    tokenCount(1, counters(500, 400, 60, 10), counters(500, 400, 60, 10)),
  ].join('\n');
  await writeFile(join(day, `rollout-2026-09-23T00-02-00-${CHILD}.jsonl`), `${child}\n`);

  // A fork that *did* copy history (a flavour today's Codex does not produce):
  // anything at or below `forked_from_ordinal_exclusive` belongs to the source.
  const copiedFork = [
    JSON.stringify({
      timestamp: '2026-09-23T00:04:00.000Z',
      ordinal: 0,
      type: 'session_meta',
      payload: { id: 'fork-copied', session_id: 'fork-copied', cwd: '/tmp/demo', forked_from_id: PARENT, forked_from_ordinal_exclusive: 5 },
    }),
    tokenCount(3, counters(9_000, 0, 10, 0), counters(9_000, 0, 10, 0)),
    tokenCount(9, counters(700, 0, 20, 0), counters(700, 0, 20, 0)),
  ].join('\n');
  await writeFile(join(day, 'rollout-2026-09-23T00-04-00-fork-copied.jsonl'), `${copiedFork}\n`);

  // A fork: it inherits the parent's running total but copies no events, so its
  // only token_count carries a total with no delta behind it.
  const fork = [
    JSON.stringify({
      timestamp: '2026-09-23T00:03:00.000Z',
      ordinal: 0,
      type: 'session_meta',
      payload: { id: 'fork-1', session_id: 'fork-1', cwd: '/tmp/demo', forked_from_id: PARENT },
    }),
    JSON.stringify({
      timestamp: '2026-09-23T00:03:01.000Z',
      ordinal: 30,
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: counters(4000, 2300, 300, 70) } },
    }),
  ].join('\n');
  await writeFile(join(day, 'rollout-2026-09-23T00-03-00-fork-1.jsonl'), `${fork}\n`);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('reading a Codex home', () => {
  it('sums the delta and splits the counters into disjoint buckets', async () => {
    const data = await codexAgent.load({ home });
    const session = data.sessions.find((candidate) => candidate.id === PARENT);
    expect(session?.records.map((record) => record.id)).toEqual([`${PARENT}:tok:1`, `${PARENT}:tok:2`]);
    // input 1000 − cached 800, output 100 − reasoning 20.
    expect(session?.records[0]?.tokens).toEqual({ input: 200, output: 80, cacheRead: 800, cacheWrite: 0, reasoning: 20 });
    expect(session?.records[1]?.tokens).toEqual({ input: 500, output: 150, cacheRead: 1500, cacheWrite: 0, reasoning: 50 });
    expect(session?.records[0]?.model).toBe('deepseek-flash');
  });

  it('bills nothing for a fork that only inherited a running total', async () => {
    const data = await codexAgent.load({ home });
    const fork = data.sessions.find((candidate) => candidate.id === 'fork-1');
    const parent = data.sessions.find((candidate) => candidate.id === PARENT);
    expect(fork?.records).toEqual([]);
    // It is identified as a continuation of its source, not as a child.
    expect(fork?.parentId).toBe(PARENT);
    expect(fork?.isSubagent).toBe(false);
    expect(fork?.extra?.['forkedFrom']).toBe(PARENT);
    expect(parent?.childIds).toEqual([CHILD]);
  });

  it('attaches a subagent through thread_spawn, not through session_id', async () => {
    const data = await codexAgent.load({ home });
    const child = data.sessions.find((candidate) => candidate.id === CHILD);
    const parent = data.sessions.find((candidate) => candidate.id === PARENT);
    expect(child?.isSubagent).toBe(true);
    expect(child?.depth).toBe(1);
    expect(child?.parentId).toBe(PARENT);
    expect(child?.parentKnown).toBe(true);
    expect(child?.records).toHaveLength(1);
    // The task it was spawned with is its title.
    expect(child?.title).toBe('Add 1+1 and reply with the number.');
    expect(parent?.childIds).toEqual([CHILD]);
  });

  it('skips the history a fork copied from its source', async () => {
    const data = await codexAgent.load({ home });
    const fork = data.sessions.find((candidate) => candidate.id === 'fork-copied');
    // Ordinal 3 is at or below the fork boundary; only ordinal 9 is its own work.
    expect(fork?.records.map((record) => record.id)).toEqual(['fork-copied:tok:9']);
  });

  it('reports the tokens of a side question that never got a rollout', async () => {
    let sqlite: typeof import('node:sqlite');
    try {
      sqlite = await import('node:sqlite');
    } catch {
      return; // an older Node has no node:sqlite; the feature degrades quietly
    }
    const db = new sqlite.DatabaseSync(join(home, 'logs_2.sqlite'));
    db.exec('CREATE TABLE logs (thread_id TEXT, feedback_log_body TEXT)');
    const insert = db.prepare('INSERT INTO logs VALUES (?, ?)');
    insert.run('side-thread', 'session_task.run:run_turn: post sampling token usage total_usage_tokens=4242');
    // A thread that has a rollout is already billed from the rollout.
    insert.run(PARENT, 'session_task.run:run_turn: post sampling token usage total_usage_tokens=999999');
    db.close();

    const data = await codexAgent.load({ home });
    const warning = data.warnings.find((candidate) => candidate.code === 'sideQuestionsCounted');
    expect(warning?.message).toContain('4,242');
    expect(warning?.message).not.toContain('999,999');
  });

  it('groups sessions by their cwd and recognises the home', async () => {
    const data = await codexAgent.load({ home });
    expect(data.agent).toBe('codex');
    expect(data.projects).toHaveLength(1);
    expect(data.projects[0]?.path).toBe('/tmp/demo');
    expect(data.projects[0]?.name).toBe('demo');
    expect(data.projects[0]?.sessions).toHaveLength(4);
    expect(await codexAgent.hasData(home)).toBe(true);
    expect(await codexAgent.hasData(join(home, 'nope'))).toBe(false);
  });
});

describe('titling a Codex session', () => {
  /** The title the loader gave one rollout id. */
  async function titleOf(id: string): Promise<string | null | undefined> {
    const data = await codexAgent.load({ home });
    return data.sessions.find((candidate) => candidate.id === id)?.title;
  }

  it('takes the first user entry that is not injected scaffolding', async () => {
    // Codex writes several injected blocks as ordinary user entries, and a real
    // rollout opens with them; only the entry after them is the user's own text.
    await writeRollout('019f0000-0000-7000-8000-000000000001', [
      meta('scaffolded'),
      userMessage(
        1,
        '<environment_context>\n  <cwd>/tmp/demo</cwd>\n</environment_context><recommended_plugins>\n- Demo plugin\n</recommended_plugins>',
      ),
      userMessage(2, 'Rename the settings page\nand its tests\n'),
      tokenCount(3, counters(100, 0, 10, 0), counters(100, 0, 10, 0)),
    ]);

    expect(await titleOf('scaffolded')).toBe('Rename the settings page');
  });

  it('reads the request out of an attachment entry', async () => {
    await writeRollout('019f0000-0000-7000-8000-000000000002', [
      meta('attached'),
      userMessage(1, '<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>'),
      userMessage(2, '# Files mentioned by the user:\n\n## screenshot.png: /tmp/screenshot.png\n\n## My request:\nTidy up the sidebar spacing'),
      tokenCount(3, counters(100, 0, 10, 0), counters(100, 0, 10, 0)),
    ]);

    expect(await titleOf('attached')).toBe('Tidy up the sidebar spacing');
  });

  it('leaves a session with only scaffolding untitled', async () => {
    await writeRollout('019f0000-0000-7000-8000-000000000003', [
      meta('scaffolding-only'),
      userMessage(1, '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nDo not build the project.\n</INSTRUCTIONS><environment_context>\n  <cwd>/tmp/demo</cwd>\n</environment_context>'),
      tokenCount(2, counters(100, 0, 10, 0), counters(100, 0, 10, 0)),
    ]);

    expect(await titleOf('scaffolding-only')).toBeNull();
  });

  it('clips a long prompt at a word boundary, not mid-word', async () => {
    // 96 characters, and the 80-char window ends inside `permitted`: a hard cut
    // would leave `… is not permitte`, so the title has to stop at the gap.
    const prompt = "Refused to start the preview because 'quick-mode' or 'safe-mode' is not permitted by the sandbox";
    expect(prompt.length).toBeGreaterThan(80);
    await writeRollout('019f0000-0000-7000-8000-000000000004', [
      meta('long-prompt'),
      userMessage(1, prompt),
      tokenCount(2, counters(100, 0, 10, 0), counters(100, 0, 10, 0)),
    ]);

    const title = await titleOf('long-prompt');
    expect(title).toBe("Refused to start the preview because 'quick-mode' or 'safe-mode' is not");
    expect(title?.length).toBeLessThanOrEqual(80);
    // The cut is a prefix that ends between words, so nothing is left half-typed.
    expect(prompt.startsWith(title as string)).toBe(true);
    expect(prompt[(title as string).length]).toBe(' ');
    expect(prompt.slice(0, 80).trim()).not.toBe(title);
  });

  it('prefers a sentence end inside the window', async () => {
    // The first sentence ends at character 61 — inside the window, so the title
    // stops there rather than running on for another nineteen characters.
    const prompt = `Fix the flaky retry helper and add a regression test for it. ${'Then keep going with the rest of the work'.repeat(2)}`;
    expect(prompt.length).toBeGreaterThan(80);
    await writeRollout('019f0000-0000-7000-8000-000000000005', [
      meta('sentence'),
      userMessage(1, prompt),
      tokenCount(2, counters(100, 0, 10, 0), counters(100, 0, 10, 0)),
    ]);

    expect(await titleOf('sentence')).toBe('Fix the flaky retry helper and add a regression test for it.');
  });

  it('keeps the NEW_TASK task of a spawned subagent', async () => {
    await writeRollout('019f0000-0000-7000-8000-000000000006', [
      meta('spawned', {
        session_id: PARENT,
        thread_source: 'subagent',
        source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1, agent_path: '/root/math' } } },
      }),
      {
        timestamp: '2026-09-23T00:11:00.000Z',
        ordinal: 1,
        type: 'response_item',
        payload: {
          type: 'agent_message',
          author: '/root',
          recipient: '/root/math',
          content: [{ type: 'input_text', text: 'Message Type: NEW_TASK\nTask name: /root/math\nSender: /root\nPayload:\nAdd 1+1 and reply with the number.' }],
        },
      },
      // A spawned subagent's own environment entry is scaffolding too, and must
      // not displace the task it was given.
      userMessage(2, '<environment_context>\n  <cwd>/tmp/demo</cwd>\n</environment_context>'),
      tokenCount(3, counters(100, 0, 10, 0), counters(100, 0, 10, 0)),
    ]);

    expect(await titleOf('spawned')).toBe('Add 1+1 and reply with the number.');
  });

  it('names a subagent Codex ran itself by its flavour', async () => {
    // Codex spawns its reviewer without a `thread_spawn` record; its only user
    // entry is a machine-written prompt, so the flavour is the honest title.
    await writeRollout('019f0000-0000-7000-8000-000000000007', [
      meta('flavour', { thread_source: 'subagent', source: { subagent: { other: 'guardian' } } }),
      userMessage(1, '<environment_context>\n  <cwd>/tmp/demo</cwd>\n</environment_context>'),
      userMessage(2, 'Machine-written prompt asking for a review of the action above.'),
      tokenCount(3, counters(100, 0, 10, 0), counters(100, 0, 10, 0)),
    ]);

    expect(await titleOf('flavour')).toBe('guardian');
  });
});

describe('tool calls', () => {
  const TOOLS = '7b1e0b1e-0000-4000-8000-0000000000b1';

  let toolsHome: string;

  /** One `response_item` carrying a call, at the ordinal Codex would give it. */
  function item(ordinal: number, payload: Record<string, unknown>): unknown {
    return {
      timestamp: `2026-09-23T00:0${ordinal}:30.000Z`,
      ordinal,
      type: 'response_item',
      payload,
    };
  }

  /** A named call: `arguments` is JSON text in the rollout. */
  function functionCall(ordinal: number, name: string, args: string): unknown {
    return item(ordinal, { type: 'function_call', id: `fc_${ordinal}`, call_id: `call_${ordinal}`, name, arguments: args });
  }

  /** A built-in/custom call: `input` is text and `status` states the outcome. */
  function customCall(ordinal: number, name: string, input: string, status = 'completed'): unknown {
    return item(ordinal, { type: 'custom_tool_call', id: `ctc_${ordinal}`, call_id: `call_${ordinal}`, name, input, status });
  }

  /** Write one rollout into its own home and read its records back. */
  async function recordsOf(entries: readonly unknown[]): Promise<readonly UsageRecord[]> {
    const lines = [
      JSON.stringify(meta(TOOLS)),
      JSON.stringify({
        timestamp: '2026-09-23T00:00:10.500Z',
        ordinal: 0,
        type: 'turn_context',
        payload: { model: 'deepseek-flash', cwd: '/tmp/tools' },
      }),
      // `tokenCount` hands back JSON text already; the rest are plain objects.
      ...entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))),
    ];
    await writeFile(join(toolsHome, 'sessions', '2026', '09', '23', `rollout-${TOOLS}.jsonl`), `${lines.join('\n')}\n`);
    const data = await codexAgent.load({ home: toolsHome });
    return data.sessions[0]?.records ?? [];
  }

  beforeEach(async () => {
    toolsHome = await mkdtemp(join(tmpdir(), 'agent-usages-codex-tools-'));
    await mkdir(join(toolsHome, 'sessions', '2026', '09', '23'), { recursive: true });
  });

  afterEach(async () => {
    await rm(toolsHome, { recursive: true, force: true });
  });

  it('reads one call out of the response items before its token_count', async () => {
    const args = '{"command":"Get-Content -Raw README.md"}';
    const records = await recordsOf([
      functionCall(1, 'shell_command', args),
      tokenCount(2, counters(100, 0, 10, 0), counters(100, 0, 10, 0)),
    ]);

    expect(records).toHaveLength(1);
    // `function_call` carries no status field, so the outcome stays unstated.
    expect(records[0]?.events).toEqual([
      {
        kind: 'tool_call',
        ordinal: 0,
        name: 'shell_command',
        detail: args,
        bytes: Buffer.byteLength(args, 'utf8'),
      },
    ]);
  });

  it('keeps two calls in ordinal order and reads a custom call status', async () => {
    const records = await recordsOf([
      functionCall(1, 'shell_command', '{"command":"ls"}'),
      customCall(2, 'apply_patch', '*** Begin Patch\n'),
      tokenCount(3, counters(100, 0, 10, 0), counters(100, 0, 10, 0)),
    ]);

    expect(records[0]?.events?.map((event) => [event.ordinal, event.name, event.ok])).toEqual([
      [0, 'shell_command', undefined],
      [1, 'apply_patch', true],
    ]);
  });

  it('gives a failing custom call ok false', async () => {
    const records = await recordsOf([
      customCall(1, 'exec', 'exit 1', 'failed'),
      tokenCount(2, counters(100, 0, 10, 0), counters(100, 0, 10, 0)),
    ]);

    expect(records[0]?.events?.map((event) => event.ok)).toEqual([false]);
  });

  it('charges a call to the token_count that closes it, and drops a trailing one', async () => {
    const records = await recordsOf([
      tokenCount(1, counters(100, 0, 10, 0), counters(100, 0, 10, 0)),
      functionCall(2, 'shell_command', '{"command":"ls"}'),
      tokenCount(3, counters(200, 0, 20, 0), counters(300, 0, 30, 0)),
      // No token_count follows this one, so no record owns it.
      functionCall(4, 'shell_command', '{"command":"tail"}'),
    ]);

    expect(records).toHaveLength(2);
    expect(records[0]?.events).toBeUndefined();
    expect('events' in (records[0] as object)).toBe(false);
    expect(records[1]?.events?.map((event) => event.name)).toEqual(['shell_command']);
  });

  it('leaves events undefined for a request that called no tool', async () => {
    const records = await recordsOf([
      userMessage(1, 'hello'),
      tokenCount(2, counters(100, 0, 10, 0), counters(100, 0, 10, 0)),
    ]);

    expect(records[0]?.events).toBeUndefined();
  });

  it('bounds the excerpt while bytes keeps the whole payload', async () => {
    const args = `{"command":"${'x'.repeat(2_000)}"}`;
    const records = await recordsOf([
      functionCall(1, 'shell_command', args),
      tokenCount(2, counters(100, 0, 10, 0), counters(100, 0, 10, 0)),
    ]);

    const event = records[0]?.events?.[0];
    expect(event?.detail).toHaveLength(300);
    expect(event?.detail).toBe(args.slice(0, 300));
    expect(event?.bytes).toBe(Buffer.byteLength(args, 'utf8'));
    expect(event?.bytes).toBeGreaterThan(Buffer.byteLength(event?.detail ?? '', 'utf8'));
  });
});
