// The office: a board of desks, and the rules for sharing the work.
//
// One machine hosts the board. Everybody else joins it with a 12 character
// code that you read out like a meeting link. That is the whole topology.

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Bag = Record<string, any>;

export const VERSION = '1.0.0';
export const PORT = 7437;
// 32 symbols, no I, L, O or U. A code you can read out loud.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const HOME = process.env.PAIRPROGRAMMER_HOME || join(homedir(), '.pair-programmer');
const CONFIG = join(HOME, 'office.json');
export const id = () => randomBytes(8).toString('hex');

// ------------------------------------------------------------------ the join code

// Turn an address into a 12 character code somebody can type.
export const joinCode = (host: string, port = PORT) => {
  const raw = Buffer.from(host.split('.').map(Number));
  const sum = [...raw, port >> 8, port & 255].reduce((a, b) => (a + b) & 255, 0);
  const bits = BigInt('0x' + Buffer.concat([raw, Buffer.from([port >> 8, port & 255, sum])]).toString('hex')) << 4n;
  let text = '';
  for (let i = 0; i < 12; i++) text += ALPHABET[Number((bits >> BigInt(55 - 5 * i)) & 31n)];
  return text.match(/.{1,4}/g)!.join('-');
};

// Turn a code somebody typed back into the address of the host.
export const readJoinCode = (code: string) => {
  const text = (code || '').toUpperCase().split('').filter(c => ALPHABET.includes(c)).join('');
  if (text.length !== 12) throw new Error('a join code is 12 characters');
  let bits = 0n;
  for (const c of text) bits = (bits << 5n) | BigInt(ALPHABET.indexOf(c));
  const bytes = Buffer.from((bits >> 4n).toString(16).padStart(14, '0'), 'hex');
  if ([...bytes.subarray(0, 6)].reduce((a, b) => (a + b) & 255, 0) !== bytes[6])
    throw new Error('that code has a typo in it');
  return [`${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`, bytes.readUInt16BE(4)] as const;
};

// ----------------------------------------------------------------- work identity

// A ticket id at the front of the title: "TICKET-42 ...", "proj-7 ...", "#42 ...".
const TICKET = /^\s*(#[A-Za-z0-9]+|[A-Za-z][A-Za-z0-9]{0,15}[-_][A-Za-z0-9]+)/;

// The identity of a piece of work. A ticket id wins over the wording.
export const taskKey = (title: string) => {
  const match = TICKET.exec(title || '');
  const identity = match ? 'ticket:' + match[1] : 'title:' + (title || '');
  return createHash('sha256').update(identity.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
    .digest('hex').slice(0, 12);
};

export const filesOf = (items: string[] = []) => [...new Set(items
  .map(x => x.trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()).filter(Boolean))].sort();

// ---------------------------------------------------------------------------- board

// Everything the office knows. Only the host keeps one.
export const createBoard = () => {
  const sessions = new Map<string, Bag>(), claims = new Map<string, Bag>();
  const delegations = new Map<string, Bag>(), results = new Map<string, Bag>();
  const live = () => [...claims.values()].filter(c => c.state === 'claimed');

  const join = (f: Bag) => {
    const s = { session_id: f.session_id || id(), owner: f.owner || 'someone',
                harness: f.harness || 'unknown', cwd: f.cwd || '' };
    sessions.set(s.session_id, s);
    return { ok: true, ...s };
  };

  const claim = (f: Bag) => {
    const title = (f.task || '').trim();
    if (!title) return { ok: false, error: 'a task title is required' };
    const key = f.task_key || taskKey(title);
    const held = claims.get(key);
    if (held?.state === 'claimed' && held.session_id !== f.session_id) {
      return { ok: true, status: 'conflict', task_key: key, held_by: held,
        message: `${held.owner} already claimed this work. Do not start it. ` +
                 `Pick something else, or delegate to them.` };
    }
    const files = filesOf(f.files || []);
    claims.set(key, { task_key: key, title, files, owner: f.owner || 'someone',
                      session_id: f.session_id || '', state: 'claimed' });
    const overlaps = live().filter(c => c.task_key !== key && c.files.some((x: string) => files.includes(x)))
      .map(c => ({ owner: c.owner, task: c.title, files: c.files.filter((x: string) => files.includes(x)) }));
    const reply: Bag = { ok: true, status: 'claimed', task_key: key, title };
    if (overlaps.length) {
      reply.overlaps = overlaps;
      reply.message = 'You claimed this, but other people are editing the same files. ' +
                      'Tell them before you start.';
    }
    return reply;
  };

  const release = (f: Bag) => {
    const held = claims.get(f.task_key || '');
    if (!held) return { ok: false, error: 'no claim with that key' };
    held.state = 'released';
    return { ok: true, state: 'released' };
  };

  const report = (f: Bag) => {
    const key = f.task_key || '';
    const state = ['done', 'failed', 'released'].includes(f.state) ? f.state : 'done';
    const held = claims.get(key) || { task_key: key, title: key, files: [] };
    held.state = state;
    claims.set(key, held);
    results.set(key, { task_key: key, title: held.title, owner: f.owner || '',
                       state, result: f.result || '' });
    for (const d of delegations.values())
      if (d.task_key === key && d.state === 'taken') { d.state = state; d.result = f.result || ''; }
    return { ok: true, task_key: key, state };
  };

  const find = (needle: string) => {
    const wanted = (needle || '').trim().toLowerCase();
    for (const s of sessions.values())
      if (s.session_id.toLowerCase() === wanted || s.owner.toLowerCase() === wanted) return s;
    return null;
  };

  const delegate = (f: Bag) => {
    const title = (f.task || '').trim();
    if (!title) return { ok: false, error: 'a task title is required' };
    const target = find(f.to);
    if (!target) return { ok: false, error: 'no desk matches that name',
      available: [...sessions.values()].map(s => ({ owner: s.owner, session_id: s.session_id })) };
    const key = f.task_key || taskKey(title);
    const d = { id: id(), task_key: key, title, brief: f.brief || '', files: filesOf(f.files || []),
                to_session: target.session_id, to_owner: target.owner,
                from_owner: f.owner || '', state: 'pending' };
    delegations.set(d.id, d);
    return { ok: true, task_key: key,
      delegated_to: { owner: target.owner, session_id: target.session_id },
      message: `handed to ${target.owner}. They pick it up on their next turn.` };
  };

  const take = (f: Bag) => {
    const tasks = [...delegations.values()].filter(d => d.state === 'pending' && d.to_session === f.session_id);
    for (const d of tasks) {
      d.state = 'taken';
      if (!claims.has(d.task_key)) claims.set(d.task_key, { task_key: d.task_key, title: d.title,
        files: d.files, owner: d.to_owner, session_id: f.session_id, state: 'claimed' });
    }
    return { ok: true, tasks, summary: tasks.length ? tasks.map(t =>
      `${t.title} (from ${t.from_owner || 'someone'})${t.brief ? '\n  ' + t.brief : ''}` +
      `${t.files.length ? '\n  files: ' + t.files.join(', ') : ''}`).join('\n')
      : 'Nothing handed to you.' };
  };

  const result = (f: Bag) => {
    const found = results.get(f.task_key || '');
    return found ? { ok: true, result: found } : { ok: false, error: 'no result yet' };
  };

  const status = () => ({ ok: true, sessions: [...sessions.values()], claims: [...claims.values()],
    delegations: [...delegations.values()], results: Object.fromEntries(results),
    summary: [...[...sessions.values()].map(s => `  ${s.owner} (${s.harness})`),
      `work in flight: ${live().length}`,
      ...live().map(c => `  ${c.owner}: ${c.title}`)].join('\n') });

  return { actions: { join, claim, release, report, delegate, take, result, status } };
};

// ----------------------------------------------------------------------- transport

// Run the host. One process, one board, everybody points at it.
export const serve = (port: number, board: ReturnType<typeof createBoard>) =>
  new Promise<any>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const reply = (payload: Bag) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && req.url?.startsWith('/board')) return reply(board.actions.status({}));
      if (req.method === 'GET' && req.url?.startsWith('/health'))
        return reply({ ok: true, version: VERSION });
      if (req.method !== 'POST' || !req.url?.startsWith('/call')) { res.writeHead(404); return res.end(); }
      let body = '';
      for await (const chunk of req) body += chunk;
      let payload: Bag = {};
      try { payload = JSON.parse(body || '{}'); } catch { /* empty body, let the board complain */ }
      const action = payload.action;
      delete payload.action;
      try {
        const handler = board.actions[action];
        reply(handler ? handler(payload) : { ok: false, error: `the office does not know how to ${action}` });
      } catch (error) { reply({ ok: false, error: String(error) }); }
    });
    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });

export const call = async (base: string, action: string, fields: Bag = {}): Promise<Bag> => {
  try {
    const response = await fetch(`${base}/call`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...fields }) });
    return await response.json();
  } catch { return { ok: false, error: `the office at ${base} is not answering` }; }
};

export const boardAt = async (base: string): Promise<Bag> => {
  try { return await (await fetch(`${base}/board`)).json(); }
  catch { return { ok: false, error: `the office at ${base} is not answering` }; }
};

export const readConfig = (): Bag => {
  try { return JSON.parse(readFileSync(CONFIG, 'utf8').replace(/^﻿/, '')); } catch { return {}; }
};

export const writeConfig = (updates: Bag) => {
  mkdirSync(HOME, { recursive: true });
  const data = { ...readConfig(), ...updates };
  writeFileSync(CONFIG, JSON.stringify(data, null, 2) + '\n');
  return data;
};
