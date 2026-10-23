#!/usr/bin/env node
// Pair Programmer: a shared office where teammate agents coordinate instead of duplicating work. One host, everybody joins with a 12 character code: open | join CODE | mcp
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

type Bag = Record<string, any>;
const PORT = 7437;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const HOME = process.env.PAIRPROGRAMMER_HOME || join(homedir(), '.pair-programmer');
const CONFIG = join(HOME, 'office.json');
const BOARD = join(HOME, 'board.json');
// Work nobody has touched for this long is up for grabs, so an agent that crashed or a
// laptop that closed cannot hold a task hostage for the rest of the afternoon.
const LEASE = 45 * 60e3;
// A desk belongs to a person's machine, not to one harness window, so the id survives a
// window being closed and reopened. Work handed to somebody still finds them tomorrow.
const deskId = (who: string) => createHash('sha256').update('desk:' + who).digest('hex').slice(0, 16);
const ago = (at: number) => { const m = Math.round((Date.now() - at) / 60e3); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`; };
const filesOf = (items: string[] = []) => [...new Set((items || []).map(x => String(x).trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()).filter(Boolean))].sort();

// Turn an address into a 12 character code somebody can type.
export const joinCode = (host: string, port = PORT) => {
  const raw = [...Buffer.from(host.split('.').map(Number)), port >> 8, port & 255];
  const bits = [...raw, raw.reduce((a, b) => (a + b) & 255, 0)].map(x => x.toString(2).padStart(8, '0')).join(''); let out = '';
  for (let i = 0; i < 12; i++) out += ALPHABET[parseInt(bits.slice(i * 5, i * 5 + 5).padEnd(5, '0'), 2)];
  return out.match(/.{1,4}/g)!.join('-');
};

// Turn a code somebody typed back into the address of the host.
export const readJoinCode = (code: string) => {
  const text = (code || '').toUpperCase().split('').filter(c => ALPHABET.includes(c)).join('');
  if (text.length !== 12) throw new Error('a join code is 12 characters');
  let bits = ''; for (const c of text) bits += ALPHABET.indexOf(c).toString(2).padStart(5, '0');
  const raw = Buffer.from(bits.slice(0, 56).match(/.{8}/g)!.map(b => parseInt(b, 2)));
  if ([...raw.subarray(0, 6)].reduce((a, b) => (a + b) & 255, 0) !== raw[6]) throw new Error('that code has a typo in it');
  return [`${raw[0]}.${raw[1]}.${raw[2]}.${raw[3]}`, raw.readUInt16BE(4)] as const;
};

// A ticket id at the front of the title: "TICKET-42 ...", "proj-7 ...", "#42 ...".
const TICKET = /^\s*(#\w+|[A-Za-z][A-Za-z0-9]{0,15}[-_][A-Za-z0-9]+)/;

// The identity of a piece of work. A ticket id wins over the wording.
export const taskKey = (title: string) => {
  const m = TICKET.exec(title || ''), flat = (m ? 'ticket:' + m[1] : 'title:' + (title || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha256').update(flat).digest('hex').slice(0, 12); };

// Everything the office knows. Only the host keeps one, and it writes itself down, so
// closing the terminal does not throw away what the team worked out.
export const createBoard = (file?: string) => {
  const prior = file ? (() => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } })() : {};
  const sessions = new Map<string, Bag>(), tasks = new Map<string, Bag>((prior.tasks || []).map((t: Bag) => [t.task_key, t]));
  const memories = new Map<string, Bag>((prior.memories || []).map((m: Bag) => [m.key.toLowerCase(), m])), log: Bag[] = prior.log || [];
  // Desks are the one thing not written down: a desk that stopped calling is gone.
  const keep = () => { if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ tasks: [...tasks.values()], memories: [...memories.values()], log })); } };

  // A desk shows up by itself the first time it calls, and its last call is its heartbeat.
  const sit = (f: Bag) => {
    if (f.session_id) sessions.set(f.session_id, { ...sessions.get(f.session_id), session_id: f.session_id, owner: f.owner || 'someone', harness: f.harness || 'unknown', at: Date.now() }); };

  // One record per piece of work, not one per claim and another per handover: who has it,
  // how far it got, what it is waiting on, and everything that happened along the way.
  const taskOf = (f: Bag, title: string) => { const key = f.task_key || taskKey(title); if (!tasks.has(key)) tasks.set(key, { task_key: key, title, files: filesOf(f.files), state: 'open', owner: '', session_id: '', events: [], at: Date.now() }); return tasks.get(key); };
  const note = (t: Bag, f: Bag, text: string) => { t.events.push({ at: Date.now(), by: f.owner || 'someone', text }); if (t.events.length > 20) t.events.shift(); t.at = Date.now(); },
    held = (t: Bag) => ['working', 'waiting'].includes(t.state) && Date.now() - t.at < LEASE,
    yours = (t: Bag, f: Bag) => !!t.owner && (t.session_id === f.session_id || t.owner.toLowerCase() === String(f.owner || '').toLowerCase());

  const claim = (f: Bag) => {
    const t = taskOf(f, (f.task || '').trim() || String(f.task_key || ''));
    if (t.owner && !yours(t, f) && ['working', 'waiting'].includes(t.state)) {
      if (held(t)) return { ok: true, status: 'conflict', task_key: t.task_key, held_by: { owner: t.owner, since: ago(t.at) }, message: `${t.owner} already claimed this work. Do not start it. Pick something else, or delegate to them.` };
      note(t, f, `took over from ${t.owner}, who had gone quiet`);
    }
    t.files = [...new Set([...t.files, ...filesOf(f.files)])].sort();
    Object.assign(t, { state: 'working', owner: f.owner || 'someone', session_id: f.session_id || '' });
    note(t, f, `claimed${t.files.length ? ` ${t.files.join(' ')}` : ''}`);
    const overlaps = [...tasks.values()].filter(x => x.task_key !== t.task_key && held(x) && x.files.some(v => t.files.includes(v))).map(x => ({ owner: x.owner, task: x.title, files: x.files.filter(v => t.files.includes(v)) }));
    // The team may already have worked this out. Hand it back with the claim rather than
    // making the agent remember to go and look.
    const known = [...memories.values()].filter(m => t.files.some(v => m.files.includes(v)));
    return { ok: true, status: 'claimed', task_key: t.task_key, ...(overlaps.length ? { overlaps } : {}), ...(known.length ? { known } : {}), ...(t.question && !t.answer ? { waiting_on: t.question } : {}), ...(t.events.length > 1 ? { history: t.events.slice(0, -1) } : {}) };
  };

  // Progress, a blocker, or the end of it. Leave the state out to add a note without closing it.
  const report = (f: Bag) => {
    const t = taskOf(f, String(f.task_key || '').trim());
    const state = f.state === 'released' ? 'open' : ['done', 'failed'].includes(f.state) ? f.state : t.state === 'open' ? 'done' : t.state;
    if (f.result) { t.result = String(f.result); note(t, f, t.result); }
    if (f.state === 'released') Object.assign(t, { session_id: '', owner: '', to_owner: '' });
    t.state = state; t.at = Date.now();
    return { ok: true, task_key: t.task_key, state };
  };

  // Work handed to one desk, or posted for whoever is free.
  const offer = (f: Bag) => {
    const title = (f.task || '').trim();
    if (!title) return { ok: false, error: 'a task title is required' };
    const wanted = (f.to || '').trim().toLowerCase();
    const desk = wanted ? [...sessions.values()].find(s => s.session_id.toLowerCase() === wanted || s.owner.toLowerCase() === wanted) : null;
    // Somebody who is not at a desk right now still gets the work: it waits for them
    // rather than failing, which is the whole point of handing it over.
    const t = taskOf(f, title), to = wanted ? desk?.owner || (f.to || '').trim() : '';
    Object.assign(t, { state: 'offered', to_owner: to, brief: f.brief || '', source: f.source || 'posted', at: Date.now() });
    note(t, f, to ? `handed to ${to}` : 'posted for whoever is free');
    return { ok: true, task_key: t.task_key, ...(to ? { delegated_to: { owner: to, session_id: desk?.session_id || '' }, message: desk ? `handed to ${to}. They pick it up on their next turn.` : `${to} is not at a desk right now, so it waits for them.` } : { waiting: true, message: 'posted for whoever is free. The next agent to call pair_next_task picks it up.' }) };
  };

  // Yours: work handed to you or posted for anyone, and your own questions that got answered.
  const take = (f: Bag) => {
    const all = [...tasks.values()], resumed = all.filter(t => yours(t, f) && t.state === 'waiting' && t.answer);
    const grabbed = all.filter(t => ['open', 'offered'].includes(t.state) && (!t.to_owner || t.to_owner.toLowerCase() === String(f.owner || '').toLowerCase()));
    for (const t of [...resumed, ...grabbed]) Object.assign(t, { state: 'working', session_id: f.session_id || '', owner: f.owner || 'someone', to_owner: t.to_owner || f.owner || 'someone' });
    for (const t of grabbed) note(t, f, 'picked up');
    return { ok: true, tasks: [...resumed, ...grabbed], ...(resumed.length || grabbed.length ? {} : { note: 'nothing is waiting for you. Claim your own work with pair_claim.' }) };
  };

  // MCP has no way to push, so this is the closest thing to being woken up: hold the call
  // open until work lands, instead of the agent polling in a loop or giving up and idling.
  const wait = async (f: Bag) => {
    const until = Date.now() + Math.min(Number(f.seconds) || 30, 55) * 1e3;
    for (;;) {
      const got = take(f); if (got.tasks.length) { keep(); return { ...got, arrived: true }; }
      if (Date.now() >= until) return { ok: true, tasks: [], note: 'nothing arrived while you waited. Start your own work, or wait again.' };
      await new Promise(r => setTimeout(r, 1000));
    }
  };

  const result = (f: Bag) => {
    const t = tasks.get(f.task_key || '');
    return t?.result ? { ok: true, result: t } : { ok: false, error: t ? `${t.owner || 'nobody'} has not reported a result yet (${t.state})` : 'no such task' };
  };

  // Park the work on a question only somebody else can answer. This is what to do instead
  // of guessing, and the task keeps its place in the queue until somebody answers it.
  const ask = (f: Bag) => {
    const text = (f.question || '').trim();
    if (!text) return { ok: false, error: 'a question is required' };
    const t = taskOf(f, (f.task || '').trim() || String(f.task_key || ''));
    t.question = { text, options: (f.options || []).slice(0, 4), by: f.owner || 'someone' };
    t.state = 'waiting'; note(t, f, `asked: ${text}`);
    return { ok: true, task_key: t.task_key, waiting: true, message: 'parked. Whoever calls pair_answer unblocks it, and the holder picks it back up with pair_next_task.' };
  };

  const answer = (f: Bag) => {
    const t = tasks.get(f.task_key || '');
    if (!t?.question) return { ok: false, error: 'nothing is waiting on that task' };
    t.answer = { text: String(f.answer || ''), by: f.owner || 'someone', at: Date.now() };
    note(t, f, `answered: ${t.answer.text}`);
    return { ok: true, task_key: t.task_key, question: t.question.text, answer: t.answer.text };
  };

  // What the team learned. The next agent reads it instead of working it out again.
  const remember = (f: Bag) => {
    const key = (f.key || '').trim();
    if (!key) return { ok: false, error: 'a key is required' };
    memories.set(key.toLowerCase(), { key, value: String(f.value || ''), kind: f.kind || 'fact', files: filesOf(f.files), by: f.owner || 'someone', at: Date.now() });
    return { ok: true, key, remembered: true };
  };

  // A skill is the same record with a kind, so there is one place to look for what the team knows.
  const share = (f: Bag) => remember({ ...f, key: f.name, value: f.text, kind: 'skill' });
  const skillList = () => ({ ok: true, skills: [...memories.values()].filter(m => m.kind === 'skill').map(m => ({ name: m.key, text: m.value, by: m.by })) });

  const recall = (f: Bag) => {
    const q = (f.query || '').trim().toLowerCase(), want = filesOf(f.files);
    const found = [...memories.values()].filter(m => want.length ? m.files.some((x: string) => want.includes(x)) : !q || m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q));
    return { ok: true, memories: found, ...(found.length ? {} : { note: 'the team has not remembered anything about that yet' }) }; };

  // The shared log: a heads up for the whole team, not a task for one desk.
  const say = (f: Bag) => {
    const text = (f.text || '').trim();
    if (!text) return { ok: false, error: 'nothing to say' };
    log.push({ at: Date.now(), owner: f.owner || 'someone', text });
    if (log.length > 500) log.splice(0, log.length - 500);
    return { ok: true, said: true }; };

  const read = (f: Bag) => ({ ok: true, log: log.slice(-Math.min(Number(f.last) || 20, 100)) });

  // What an agent reads before it starts, and what a person reads to see who is stuck on what.
  const status = () => ({ ok: true, sessions: [...sessions.values()], tasks: [...tasks.values()].map(t => ({ task_key: t.task_key, title: t.title, state: t.state !== 'open' && !held(t) && ['working', 'waiting'].includes(t.state) ? 'stale' : t.state, owner: t.owner, since: ago(t.at), ...(t.question && !t.answer ? { waiting_on: t.question.text } : {}) })), memories: memories.size, log: log.length });

  const actions: Bag = { claim, report, delegate: offer, post: offer, take, result, status, remember, recall, share, skills: skillList, say, read, ask, answer, wait };
  // These are the ones that change something, so these are the ones that write it down.
  for (const name of ['claim', 'report', 'delegate', 'post', 'take', 'remember', 'share', 'say', 'ask', 'answer']) { const act = actions[name]; actions[name] = (f: Bag) => { const out = act(f); keep(); return out; }; }
  return { sit, actions };
};

// Run the host. One process, one board, everybody points at it.
export const serve = (port: number, board: ReturnType<typeof createBoard>) =>
  new Promise<any>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const reply = (payload: Bag) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const path = req.url || '';
      if (req.method !== 'POST' || !(path.startsWith('/call') || path.startsWith('/trigger'))) { res.writeHead(404); return res.end(); }
      let body = ''; for await (const chunk of req) body += chunk;
      let payload: Bag = {};
      // A trigger may be JSON, or just the task in the body: curl -d 'TICKET-9 deploy' host:7437/trigger
      try { payload = JSON.parse(body || '{}'); } catch { payload = { task: body.trim(), source: 'trigger' }; }
      board.sit(payload);
      const name = path.startsWith('/trigger') ? payload.action || 'post' : payload.action, handler = board.actions[name];
      reply(handler ? await handler(payload) : { ok: false, error: `the office does not know how to ${name}` });
    });
    server.on('error', reject);
    server.listen(port, '0.0.0.0', () => resolve(server));
  });

// A failed join has three different causes that need three different answers.
// "refused" means the host is not running. A timeout means something dropped the
// packets: on a LAN that is the host's firewall, unless the name is simply wrong.
const why = (error: Bag, address: string) => {
  const code = error?.cause?.code || error?.code || '';
  if (code === 'ECONNREFUSED') return `nothing is listening at ${address}. Is the host still running "open"?`;
  if (String(code).includes('TIMEOUT')) {
    // A bad hostname is reported as a timeout too, so only blame the firewall when
    // the address is a literal, which cannot be a naming mistake.
    const literal = /^\d+\.\d+\.\d+\.\d+$/.test(address.split(':')[0]);
    return literal
      ? `${address} never answered. That is what a firewall looks like: the host has to allow inbound ${PORT}. See "When somebody cannot join" in the README.`
      : `${address} never answered. Either that name is wrong, or the host's firewall is dropping it. It has to allow inbound ${PORT}.`;
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `this machine cannot see ${address} at all. Are you on the same network? Guest and office wifi often block machines from talking to each other.`;
  if (code === 'ENOTFOUND') return `${address} is not a name this machine can resolve.`;
  return `${address} is not answering${code ? ` (${code})` : ''}`;
};

const call = async (base: string, action: string, fields: Bag = {}): Promise<Bag> => {
  try { const r = await fetch(`${base}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...fields }) });
    return await r.json();
  } catch (error) { return { ok: false, error: why(error, base.replace(/^https?:\/\//, '')) }; }
};

const readConfig = (): Bag => { try { return JSON.parse(readFileSync(CONFIG, 'utf8').replace(/^﻿/, '')); } catch { return {}; } };

const writeConfig = (u: Bag) => {
  mkdirSync(HOME, { recursive: true }); const d = { ...readConfig(), ...u }; writeFileSync(CONFIG, JSON.stringify(d, null, 2) + '\n'); return d; };

// name: [office action, description, {argument: type or fixed value}], "?" marks an optional one
const TOOLS: Record<string, [string, string, Bag]> = {
  pair_status: ['status', 'Who is in the office and what everybody is working on, including anything parked on a question. Call this before you start a task.', {}],
  pair_claim: ['claim', 'Claim work before you start it, so nobody does the same job twice. Start the title with the ticket id, and list the files you expect to touch. The reply carries the history if somebody worked it before, and anything the team already knows about those files.', { task: 's', files: 'a?' }],
  pair_release: ['report', 'Give up a claim so somebody else can take the work. Use it when you stop or hand the work over.', { task_key: 's', state: 'released' }],
  pair_delegate: ['delegate', 'Hand work to one teammate\'s agent. Use it when their session fits better, or when you would otherwise do it twice. Use pair_post instead when you do not care who takes it.', { task: 's', to: 's', brief: 's?', files: 'a?' }],
  pair_next_task: ['take', 'Pick up work at the start of a turn: what a teammate handed you, what somebody posted for whoever is free, and any of your own questions that got answered. Call it before you start your own work.', {}],
  pair_report: ['report', 'Say how a task is going, or that it is finished or blocked. Leave the state out to add a progress note without closing it. Report often: a task nobody has heard about for 45 minutes looks abandoned.', { task_key: 's', result: 's', state: 's?' }],
  pair_result: ['result', 'Read the result of work you handed over. Errors until it is done.', { task_key: 's' }],
  pair_ask: ['ask', 'Park the work on a question that is somebody else\'s to answer: a decision, a credential you do not have, a call you should not make alone. Do this instead of guessing, or instead of stopping. Give options when the answer is a choice.', { task: 's', question: 's', options: 'a?', task_key: 's?' }],
  pair_answer: ['answer', 'Answer a question somebody parked with pair_ask. That unblocks the task, and whoever was holding it picks it back up on their next pair_next_task.', { task_key: 's', answer: 's' }],
  pair_remember: ['remember', 'Save something the whole team should know: a convention, a gotcha, a command that works, a decision you made. The next agent reads it instead of working it out again. Pass files to attach it to the work it belongs to. Keep it short and specific.', { key: 's', value: 's', files: 'a?' }],
  pair_recall: ['recall', 'Read what the team already remembered. Call it before you spend time working something out, and after somebody tells you something useful. Leave query out to read everything, or pass files to get only what touches them.', { query: 's?', files: 'a?' }],
  pair_share_skill: ['share', 'Publish a team skill or convention once, so every agent on the team reads it instead of each person briefing their own. Use it for how this team does things.', { name: 's', text: 's' }],
  pair_skills: ['skills', 'Read the team skills and conventions shared in this office. Call it at the start of a task, before you decide how to do the work.', {}],
  pair_say: ['say', 'Leave a short note in the shared log for the whole team. Not a task and not addressed to anyone: a heads up, a blocker, a file you just changed.', { text: 's' }],
  pair_read: ['read', 'Read the recent shared log, oldest first. Bounded to the last 20 entries unless you ask for more.', { last: 's?' }],
  pair_post: ['post', 'Post work for whoever is free, when you do not know or care which teammate takes it. The next agent to call pair_next_task picks it up. A cron or a webhook posts here too.', { task: 's', brief: 's?', files: 'a?' }],
  pair_wait: ['wait', 'Wait for work to land instead of polling or idling: a teammate hands you something, or somebody posts it. Holds the call open until it arrives or the wait runs out, then returns whatever it picked up. Use it when you are free and the rest of the team is still working.', { seconds: 's?' }],
};

const TYPES: Bag = { s: { type: 'string' }, a: { type: 'array', items: { type: 'string' } } };

const toolList = () => Object.entries(TOOLS).map(([name, [action, description, props]]) => ({
  name, description, inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, TYPES[v[0]] || { enum: [v] }])), required: Object.keys(props).filter(k => !props[k].endsWith('?')) }, }));

const identity = (): Bag => { const s = readConfig(), owner = process.env.PAIRPROGRAMMER_OWNER || s.name || hostname(); return { session_id: process.env.PAIRPROGRAMMER_SESSION_ID || deskId(owner), owner, harness: process.env.PAIRPROGRAMMER_HARNESS || s.harness || 'unknown' }; };

const serveMcp = async () => {
  const base = readConfig().hub || `http://127.0.0.1:${PORT}`, me = identity();
  for await (const line of createInterface({ input: process.stdin })) {
    let message: Bag;
    try { message = JSON.parse(line.replace(/^﻿/, '')); } catch { continue; }
    const { id: requestId, method, params = {} } = message; if (requestId === undefined) continue;
    let result: Bag = {};
    if (method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'pair-programmer', version: '1.0.0' } };
    else if (method === 'tools/list') result = { tools: toolList() };
    else if (method === 'tools/call') {
      const [action, , props] = TOOLS[params.name] || [], fields: Bag = { ...me };
      for (const [k, t] of Object.entries(props || {})) fields[k] = t[0] in TYPES ? params.arguments?.[k] ?? (t[0] === 'a' ? [] : '') : t;      const outcome = action ? await call(base, action, fields) : { ok: false, error: 'no such tool' };
      result = { content: [{ type: 'text', text: JSON.stringify(outcome) }], isError: !outcome.ok };
    } else result = { error: { code: -32601, message: method } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, result }) + '\n');
  }
};

const cli = async (argv: string[]) => {
  const [command, ...rest] = argv;
  const base = readConfig().hub || `http://127.0.0.1:${PORT}`;
  const who = process.env.PAIRPROGRAMMER_OWNER || readConfig().name || hostname();
  const me = { session_id: process.env.PAIRPROGRAMMER_SESSION_ID || deskId(who), owner: who };
  if (command === 'open') {
    // Virtual adapters (Docker, WSL) answer first, so prefer a plain LAN range.
    const all = Object.values(networkInterfaces()).flatMap(l => l || []).filter(e => e.family === 'IPv4' && !e.internal);
    const address = (all.find(e => e.address.startsWith('192.168.') || e.address.startsWith('10.')) || all[0])?.address || '127.0.0.1';
    const code = joinCode(address, PORT); writeConfig({ port: PORT, hub: null });
    // The port has to be reachable from the other machine, and a firewall is the
    // usual reason it is not. Say so here, where the host is looking, not later.
    const allow = process.platform === 'win32'
      ? 'netsh advfirewall firewall add rule name="Pair Programmer" dir=in action=allow protocol=TCP localport=' + PORT
      : process.platform === 'darwin' ? 'check System Settings > Network > Firewall' : `allow inbound tcp ${PORT} (ufw allow ${PORT})`;
    console.log(`the office is open  ${address}:${PORT}\n  join code   ${code}\n  teammates run  node pair-programmer.ts join ${code}\n  if they cannot reach you, this machine has to allow inbound ${PORT}\n    ${allow}`);
    try { await serve(PORT, createBoard(BOARD)); }
    catch (error) { console.error(`could not open the office on port ${PORT}: ${(error as Error).message}`); return 1; }
  } else if (command === 'join') {
    // A join code never has a dot or a colon, so anything that does is an address:
    // an SSH tunnel, a VPN address, or a machine the code cannot describe.
    const arg = (rest[0] || '').trim();
    let address: string, port: number;
    if (/[.:]/.test(arg)) {
      const bare = arg.replace(/^https?:\/\//, ''), cut = bare.lastIndexOf(':');
      address = cut > 0 ? bare.slice(0, cut) : bare; port = cut > 0 ? Number(bare.slice(cut + 1)) || PORT : PORT;
    } else {
      try { [address, port] = readJoinCode(arg); } catch (error) { console.error(String((error as Error).message)); return 1; }
    }
    const hub = `http://${address}:${port}`;
    const reply = await call(hub, 'status', me);
    if (!reply.ok) { console.error(`could not join: ${reply.error}`); return 1; }
    writeConfig({ hub, port });
    console.log(`you are in  the office is at ${hub}`);
  } else if (command === 'status') {
    const board = await call(base, 'status', me);
    if (!board.ok) { console.error(board.error); return 1; }
    console.log('in the office:');
    for (const owner of [...new Set(board.sessions.map(s => s.owner))]) console.log(`  ${owner}`);
    console.log('work in flight:');
    for (const t of board.tasks.filter(t => t.state === 'working' || t.state === 'stale')) console.log(`  ${t.owner}: ${t.title}${t.state === 'stale' ? '  (nobody has touched it for a while)' : ''}`);
    for (const t of board.tasks.filter(t => t.state === 'offered')) console.log(`  offered to ${t.owner || 'whoever is free'}: ${t.title}`);
    for (const t of board.tasks.filter(t => t.state === 'waiting')) console.log(`  waiting on an answer: ${t.title}  ${t.waiting_on || ''}`);
  } else if (command === 'claim') {
    const reply = await call(base, 'claim', { ...me, task: rest.join(' ').replace(/^"|"$/g, '') });
    console.log(reply.ok ? (reply.status === 'conflict' ? `conflict  ${reply.message}` : `claimed  ${reply.task_key}`) : reply.error);
  } else if (command === 'delegate') {
    const to = rest[rest.length - 1] || '', task = rest.slice(0, -1).join(' ').replace(/^"|"$/g, '');
    const reply = await call(base, 'delegate', { ...me, task, to, brief: '' });
    console.log(reply.ok ? `handed to ${reply.delegated_to.owner}  ${reply.task_key}` : reply.error);
  } else if (command === 'next') {
    const reply = await call(base, 'take', me);
    console.log(reply.ok ? reply.tasks.map((t: Bag) => `picked up  ${t.title}  ${t.task_key}`).join('\n') || 'nothing has been handed to you' : reply.error);
  } else if (command === 'wait') {
    const reply = await call(base, 'wait', { ...me, seconds: rest[0] });
    console.log(reply.ok ? reply.tasks.map((t: Bag) => `picked up  ${t.title}  ${t.task_key}`).join('\n') || reply.note : reply.error);
  } else if (command === 'report') {
    const state = ['done', 'failed', 'released'].includes(rest[rest.length - 1]) ? rest.pop() : 'done';
    const reply = await call(base, 'report', { ...me, task_key: rest[0], state, result: rest.slice(1).join(' ') });
    console.log(reply.ok ? `reported  ${reply.state}  ${reply.task_key}` : reply.error);
  } else if (command === 'answer') {
    const reply = await call(base, 'answer', { ...me, task_key: rest[0], answer: rest.slice(1).join(' ') });
    console.log(reply.ok ? `answered  ${reply.task_key}  ${reply.answer}` : reply.error);
  } else if (command === 'post') {
    const reply = await call(base, 'post', { ...me, task: rest.join(' ').replace(/^"|"$/g, '') });
    console.log(reply.ok ? `posted  ${reply.task_key}` : reply.error);
  } else if (command === 'remember') {
    const [key, ...value] = rest, reply = await call(base, 'remember', { ...me, key, value: value.join(' ') });
    console.log(reply.ok ? `remembered  ${key}` : reply.error);
  } else if (command === 'recall') {
    const reply = await call(base, 'recall', { ...me, query: rest.join(' ') });
    console.log(reply.ok ? reply.memories.map((m: Bag) => `${m.key}  ${m.value}  (${m.by})`).join('\n') || 'the team has not remembered anything yet' : reply.error);
  } else if (command === 'share') {
    const [name, ...text] = rest, reply = await call(base, 'share', { ...me, name, text: text.join(' ') });
    console.log(reply.ok ? `shared  ${name}` : reply.error);
  } else if (command === 'skills') {
    const reply = await call(base, 'skills', me);
    console.log(reply.ok ? reply.skills.map((s: Bag) => `${s.name}  (${s.by})\n  ${s.text}`).join('\n') || 'the team has not shared any skills yet' : reply.error);
  } else if (command === 'say') {
    const reply = await call(base, 'say', { ...me, text: rest.join(' ') });
    console.log(reply.ok ? 'said' : reply.error);
  } else if (command === 'read') {
    const reply = await call(base, 'read', { ...me, last: rest[0] });
    console.log(reply.ok ? reply.log.map((l: Bag) => `${l.owner}  ${l.text}`).join('\n') || 'the log is empty' : reply.error);
  } else if (command === 'config') {
    // No vendor directory and no vendor manifest: the server speaks MCP over stdio,
    // so every harness wires it up the same way, by pointing at this file.
    // Forward slashes, because a Windows path with backslashes is unusable in a
    // bash shell and node reads forward slashes on every platform.
    const self = join(import.meta.dirname, 'pair-programmer.ts').replace(/\\/g, '/');
    mkdirSync(HOME, { recursive: true });
    writeFileSync(join(HOME, 'mcp.json'), JSON.stringify({ mcpServers: { 'pair-programmer': { command: 'node', args: [self, 'mcp'] } } }, null, 2) + '\n');
    console.log(`the office speaks MCP over stdio, so any harness can run it:\n  server  node ${self} mcp\n\n  claude code  claude mcp add pair-programmer -- node ${self} mcp\n  codex        [mcp_servers.pair-programmer]  command = "node"  args = ["${self}", "mcp"]\n  anything else  point its MCP config at the server command above\n\n  a copy of the json is in ${join(HOME, 'mcp.json')}\n\n  now pick one:\n    you open the office  node ${self} open   (prints the join code to share)\n    you join a teammate  node ${self} join <code>   (ask them for the code)`);
  } else console.log(['pair-programmer',
    '  open            open the office and print the join code',
    '  join <code>     join somebody else\'s office',
    '  status          who is in the office, what is taken, what is stuck',
    '  claim <work>    claim a piece of work',
    '  next            pick up work handed to you, or posted for anyone',
    '  wait [seconds]  hold on until work lands, instead of asking again',
    '  report <key> [result] [done|failed|released]   say how it went',
    '  delegate <work> <who>   hand work to one teammate',
    '  post <work>     post work for whoever is free',
    '  answer <key> <what>     answer a question somebody parked',
    '  remember <key> <what>   save something for the whole team',
    '  recall [query]  read what the team remembered',
    '  share <name> <text>     publish a team skill',
    '  skills          read the team skills',
    '  say <note>      leave a note in the shared log',
    '  read [n]        read the recent shared log',
    '  config          print the MCP config for your harness'].join('\n'));
  return 0;
};

if (process.argv[1]?.endsWith('pair-programmer.ts')) {
  const [first] = process.argv.slice(2);
  // Never process.exit() here: it truncates a pending stdout write and the harness loses the last line.
  if (first === 'mcp') await serveMcp();
  else process.exitCode = await cli(process.argv.slice(2));
}
