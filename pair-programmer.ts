#!/usr/bin/env node
// Pair Programmer: a shared office where teammate agents coordinate instead of duplicating
// work. One host, everybody joins with a 12 character code.
//   node pair-programmer.ts open | join CODE | mcp
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

type Bag = Record<string, any>;
const PORT = 7437;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const HOME = process.env.PAIRPROGRAMMER_HOME || join(homedir(), '.pair-programmer');
const CONFIG = join(HOME, 'office.json');
const id = () => randomBytes(8).toString('hex');

// Turn an address into a 12 character code somebody can type.
export const joinCode = (host: string, port = PORT) => {
  const raw = [...Buffer.from(host.split('.').map(Number)), port >> 8, port & 255];
  const bits = [...raw, raw.reduce((a, b) => (a + b) & 255, 0)].map(x => x.toString(2).padStart(8, '0')).join('');
  let out = '';
  for (let i = 0; i < 12; i++) out += ALPHABET[parseInt(bits.slice(i * 5, i * 5 + 5).padEnd(5, '0'), 2)];
  return out.match(/.{1,4}/g)!.join('-');
};

// Turn a code somebody typed back into the address of the host.
export const readJoinCode = (code: string) => {
  const text = (code || '').toUpperCase().split('').filter(c => ALPHABET.includes(c)).join('');
  if (text.length !== 12) throw new Error('a join code is 12 characters');
  let bits = '';
  for (const c of text) bits += ALPHABET.indexOf(c).toString(2).padStart(5, '0');
  const raw = Buffer.from(bits.slice(0, 56).match(/.{8}/g)!.map(b => parseInt(b, 2)));
  if ([...raw.subarray(0, 6)].reduce((a, b) => (a + b) & 255, 0) !== raw[6]) throw new Error('that code has a typo in it');
  return [`${raw[0]}.${raw[1]}.${raw[2]}.${raw[3]}`, raw.readUInt16BE(4)] as const;
};

// A ticket id at the front of the title: "TICKET-42 ...", "proj-7 ...", "#42 ...".
const TICKET = /^\s*(#\w+|[A-Za-z][A-Za-z0-9]{0,15}[-_][A-Za-z0-9]+)/;

// The identity of a piece of work. A ticket id wins over the wording.
export const taskKey = (title: string) => {
  const m = TICKET.exec(title || '');
  const flat = (m ? 'ticket:' + m[1] : 'title:' + (title || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha256').update(flat).digest('hex').slice(0, 12);
};

// Everything the office knows. Only the host keeps one.
export const createBoard = () => {
  const sessions = new Map<string, Bag>(), claims = new Map<string, Bag>(), delegations = new Map<string, Bag>();

  // A desk shows up by itself the first time it calls.
  const sit = (f: Bag) => {
    if (f.session_id && !sessions.has(f.session_id)) sessions.set(f.session_id, { session_id: f.session_id, owner: f.owner || 'someone', harness: f.harness || 'unknown' });
  };

  const claim = (f: Bag) => {
    const title = (f.task || '').trim();
    if (!title) return { ok: false, error: 'a task title is required' };
    const key = f.task_key || taskKey(title), held = claims.get(key);
    if (held?.state === 'claimed' && held.session_id !== f.session_id) {
      return { ok: true, status: 'conflict', task_key: key, held_by: held, message: `${held.owner} already claimed this work. Do not start it. Pick something else, or delegate to them.` };
    }
    claims.set(key, { task_key: key, title, owner: f.owner || 'someone', session_id: f.session_id || '', state: 'claimed' });
    return { ok: true, status: 'claimed', task_key: key, title };
  };

  const report = (f: Bag) => {
    const key = f.task_key || '', state = ['done', 'failed', 'released'].includes(f.state) ? f.state : 'done';
    const held = claims.get(key) || { task_key: key, title: key };
    held.state = state;
    held.result = f.result || '';
    claims.set(key, held);
    for (const d of delegations.values()) if (d.task_key === key && d.state === 'taken') { d.state = state; d.result = f.result || ''; }
    return { ok: true, task_key: key, state, result: held.result };
  };

  const delegate = (f: Bag) => {
    const title = (f.task || '').trim();
    if (!title) return { ok: false, error: 'a task title is required' };
    const wanted = (f.to || '').trim().toLowerCase();
    const target = [...sessions.values()].find(s => s.session_id.toLowerCase() === wanted || s.owner.toLowerCase() === wanted);
    if (!target) return { ok: false, error: 'no desk matches that name' };
    const key = f.task_key || taskKey(title);
    const d = { id: id(), task_key: key, title, brief: f.brief || '', to_session: target.session_id, to_owner: target.owner, state: 'pending' };
    delegations.set(d.id, d);
    return { ok: true, task_key: key, delegated_to: { owner: target.owner, session_id: target.session_id }, message: `handed to ${target.owner}. They pick it up on their next turn.` };
  };

  const take = (f: Bag) => {
    const tasks = [...delegations.values()].filter(d => d.state === 'pending' && d.to_session === f.session_id);
    for (const d of tasks) {
      d.state = 'taken';
      if (!claims.has(d.task_key)) claims.set(d.task_key, { task_key: d.task_key, title: d.title, owner: d.to_owner, session_id: f.session_id, state: 'claimed' });
    }
    return { ok: true, tasks };
  };

  const status = () => ({ ok: true, sessions: [...sessions.values()], claims: [...claims.values()], delegations: [...delegations.values()] });

  return { sit, actions: { claim, report, delegate, take, status } };
};

// Run the host. One process, one board, everybody points at it.
export const serve = (port: number, board: ReturnType<typeof createBoard>) =>
  new Promise<any>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const reply = (payload: Bag) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (req.method !== 'POST' || !req.url?.startsWith('/call')) { res.writeHead(404); return res.end(); }
      let body = '';
      for await (const chunk of req) body += chunk;
      let payload: Bag = {};
      try { payload = JSON.parse(body || '{}'); } catch { /* the board complains */ }
      const { action, ...fields } = payload;
      board.sit(fields);
      const handler = board.actions[action];
      reply(handler ? handler(fields) : { ok: false, error: `the office does not know how to ${action}` });
    });
    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });

const call = async (base: string, action: string, fields: Bag = {}): Promise<Bag> => {
  try {
    const response = await fetch(`${base}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...fields }) });
    return await response.json();
  } catch { return { ok: false, error: `the office at ${base} is not answering` }; }
};

const readConfig = (): Bag => { try { return JSON.parse(readFileSync(CONFIG, 'utf8').replace(/^﻿/, '')); } catch { return {}; } };

const writeConfig = (updates: Bag) => {
  mkdirSync(HOME, { recursive: true });
  const data = { ...readConfig(), ...updates };
  writeFileSync(CONFIG, JSON.stringify(data, null, 2) + '\n');
  return data;
};

// name: [office action, description, {argument: type or fixed value}], "?" marks an optional one
const TOOLS: Record<string, [string, string, Bag]> = {
  pair_status: ['status', 'Who is in the office and what everybody is working on. Call this before you start a task.', {}],
  pair_claim: ['claim', 'Claim work before you start it, so nobody does the same job twice. Start the title with the ticket id.', { task: 's' }],
  pair_release: ['report', 'Give up a claim so somebody else can take the work. Use it when you stop or hand the work over.', { task_key: 's', state: 'released' }],
  pair_delegate: ['delegate', 'Hand work to a teammate\'s agent. Use it when their session fits better, or when you would otherwise do it twice.', { task: 's', to: 's', brief: 's?' }],
  pair_next_task: ['take', 'Pick up work a teammate\'s agent handed to you. Call it at the start of a turn.', {}],
  pair_report: ['report', 'Report that a task is finished or blocked, with a short summary.', { task_key: 's', result: 's', state: 's?' }],
};

const TYPES: Bag = { s: { type: 'string' } };

const toolList = () => Object.entries(TOOLS).map(([name, [action, description, props]]) => ({
  name, description, inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, TYPES[v[0]] || { enum: [v] }])), required: Object.keys(props).filter(k => !props[k].endsWith('?')) },
}));

const identity = (): Bag => {
  const s = readConfig();
  return { session_id: process.env.PAIRPROGRAMMER_SESSION_ID || id(), owner: process.env.PAIRPROGRAMMER_OWNER || s.name || hostname(), harness: process.env.PAIRPROGRAMMER_HARNESS || s.harness || 'unknown' };
};

const serveMcp = async () => {
  const base = readConfig().hub || `http://127.0.0.1:${PORT}`, me = identity();
  for await (const line of createInterface({ input: process.stdin })) {
    let message: Bag;
    try { message = JSON.parse(line.replace(/^﻿/, '')); } catch { continue; }
    const { id: requestId, method, params = {} } = message;
    if (requestId === undefined) continue;
    let result: Bag;
    if (method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'pair-programmer', version: '1.0.0' } };
    else if (method === 'tools/list') result = { tools: toolList() };
    else if (method === 'tools/call') {
      const [action, , props] = TOOLS[params.name] || [], fields: Bag = { ...me };
      for (const [k, t] of Object.entries(props || {})) fields[k] = t in TYPES ? params.arguments?.[k] ?? '' : t;
      const outcome = action ? await call(base, action, fields) : { ok: false, error: 'no such tool' };
      result = { content: [{ type: 'text', text: JSON.stringify(outcome) }], isError: !outcome.ok };
    } else result = { error: { code: -32601, message: method } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, result }) + '\n');
  }
};

// The address a teammate can reach. Virtual adapters answer first, so prefer a LAN range.
const localAddress = () => {
  const all = Object.values(networkInterfaces()).flatMap(l => l || []).filter(e => e.family === 'IPv4' && !e.internal);
  const lan = all.find(e => e.address.startsWith('192.168.') || e.address.startsWith('10.'));
  return (lan || all[0])?.address || '127.0.0.1';
};

const cli = async (argv: string[]) => {
  const [command, ...rest] = argv;
  if (command === 'open') {
    const address = localAddress(), code = joinCode(address, PORT);
    writeConfig({ port: PORT, hub: null });
    console.log(`the office is open  ${address}:${PORT}\n  join code   ${code}\n  teammates run  node pair-programmer.ts join ${code}`);
    await serve(PORT, createBoard());
    return 0;
  }
  if (command === 'join') {
    let address: string, port: number;
    try { [address, port] = readJoinCode(rest[0] || ''); }
    catch (error) { console.error(String((error as Error).message)); return 1; }
    const base = `http://${address}:${port}`;
    const reply = await call(base, 'status', { session_id: id(), owner: hostname() });
    if (!reply.ok) { console.error(`could not join: ${reply.error}`); return 1; }
    writeConfig({ hub: base, port });
    console.log(`you are in  the office is at ${base}`);
    return 0;
  }
  if (command === 'install') {
    const target = join(homedir(), '.minimax', 'plugins', 'pair-programmer');
    for (const item of ['.minimax-plugin', 'icon.png', 'icon-dark.png', 'pair-programmer.mcp.json', 'skills', 'pair-programmer.ts'])
      if (existsSync(join(import.meta.dirname, item))) cpSync(join(import.meta.dirname, item), join(target, item), { recursive: true });
    console.log(`installed the plugin into ${target}`);
    return 0;
  }
  console.log('pair-programmer\n  open      open the office and print the join code\n  join <code>   join somebody else\'s office\n  install   install the plugin');
  return 0;
};

if (process.argv[1]?.endsWith('pair-programmer.ts')) {
  const [first] = process.argv.slice(2);
  // Never process.exit() here: it truncates a pending stdout write and the harness loses the last line.
  if (first === 'mcp') await serveMcp();
  else process.exitCode = await cli(process.argv.slice(2));
}
