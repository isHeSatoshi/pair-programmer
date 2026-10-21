#!/usr/bin/env node
// Pair Programmer: a shared office where teammate agents coordinate instead
// of duplicating work.
//
//   node pair-programmer.ts open        host the office, print the join code
//   node pair-programmer.ts join CODE   join somebody else's office
//   node pair-programmer.ts mcp         speak MCP on stdio (what a harness runs)

import { cpSync, existsSync } from 'node:fs';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import {
  PORT, VERSION, boardAt, call, createBoard, id, joinCode, readConfig,
  readJoinCode, serve, writeConfig,
} from './office.ts';

type Bag = Record<string, any>;
const HERE = dirname(fileURLToPath(import.meta.url));

// -------------------------------------------------------------------- the MCP server

// name: [office action, description, {argument: type}], a trailing "?" means optional
const TOOLS: Record<string, [string, string, Bag]> = {
  pair_status: ['status', 'Who is in the office and what everybody is working on. Call this before you start a task.', {}],
  pair_claim: ['claim', 'Claim a piece of work before you start it, so nobody does the same job twice. Start the task title with the ticket id.',
    { task: 's', files: 'a?', note: 's?' }],
  pair_release: ['release', 'Give up a claim so somebody else can take the work. Use it when you stop or hand the work over.',
    { task_key: 's', reason: 's?' }],
  pair_delegate: ['delegate', 'Hand a piece of work to a teammate\'s agent. Use it when their session is the better fit, or when you would otherwise do it twice.',
    { task: 's', to: 's', brief: 's?', files: 'a?' }],
  pair_next_task: ['take', 'Pick up work a teammate\'s agent handed to you. Call it at the start of a turn.', {}],
  pair_report: ['report', 'Report that a task is finished or blocked, with a short summary.',
    { task_key: 's', result: 's', state: 's?' }],
};

const TYPES: Bag = { s: { type: 'string' }, a: { type: 'array', items: { type: 'string' } } };

const toolList = () => Object.entries(TOOLS).map(([name, [action, description, props]]) => ({
  name, description,
  inputSchema: { type: 'object',
    properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, TYPES[(v as string)[0]]])),
    required: Object.keys(props).filter(k => !(props[k] as string).endsWith('?')) },
}));

const identity = (): Bag => {
  const settings = readConfig();
  return { session_id: process.env.PAIRPROGRAMMER_SESSION_ID || id(),
           owner: process.env.PAIRPROGRAMMER_OWNER || settings.name || hostname(),
           harness: process.env.PAIRPROGRAMMER_HARNESS || settings.harness || 'unknown',
           cwd: process.cwd() };
};

// The office this machine talks to. A guest points at somebody else's host.
const connect = async () => {
  const settings = readConfig();
  if (settings.hub) return settings.hub;
  const port = settings.port || PORT;
  const base = `http://127.0.0.1:${port}`;
  if ((await boardAt(base)).ok) return base;
  try { await serve(port, createBoard()); } catch { /* somebody on this machine is already hosting */ }
  return base;
};

const serveMcp = async () => {
  const base = await connect();
  const me = identity();
  await call(base, 'join', me);
  for await (const line of createInterface({ input: process.stdin })) {
    const text = line.replace(/^﻿/, '');
    if (!text.trim()) continue;
    let message: Bag;
    try { message = JSON.parse(text); } catch { continue; }
    const { id: requestId, method, params = {} } = message;
    if (requestId === undefined || requestId === null) continue;
    let result: Bag;
    if (method === 'initialize') {
      result = { protocolVersion: '2024-11-05', capabilities: { tools: { listChanged: false } },
                 serverInfo: { name: 'pair-programmer', version: VERSION } };
    } else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: toolList() };
    else if (method === 'tools/call') {
      const [action, , props] = TOOLS[params.name] || [];
      const fields: Bag = { ...me };
      for (const [key, type] of Object.entries(props || {}))
        fields[key] = params.arguments?.[key] ?? (type[0] === 'a' ? [] : '');
      const outcome = action ? await call(base, action, fields)
                             : { ok: false, error: `no tool called ${params.name}` };
      result = { content: [{ type: 'text', text: JSON.stringify(outcome, null, 2) }],
                 isError: !outcome.ok };
    } else result = { error: { code: -32601, message: `no method ${method}` } };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, result }) + '\n');
  }
};

// -------------------------------------------------------------------- the command line

const localAddress = () => {
  for (const list of Object.values(networkInterfaces()))
    for (const entry of list || [])
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  return '127.0.0.1';
};

const demo = () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice', harness: 'minimax', cwd: '/repo' };
  const bob = { session_id: 'b', owner: 'bob', harness: 'cursor', cwd: '/repo' };
  b.actions.join(alice);
  b.actions.join(bob);
  const title = 'TICKET-42 add auth middleware to src/auth.py';
  console.log('Pair Programmer, two desks one repo\n');
  console.log('alice claims ', b.actions.claim({ ...alice, task: title }).status);
  const clash = b.actions.claim({ ...bob, task: title });
  console.log('bob claims   ', clash.status, clash.message);
  b.actions.delegate({ ...bob, task: 'TICKET-51 rate limit middleware', to: 'alice',
                        brief: '429 with Retry-After' });
  const inbox = b.actions.take({ ...alice });
  console.log('alice picks up', inbox.tasks[0].title);
  b.actions.report({ ...alice, task_key: inbox.tasks[0].task_key, state: 'done',
                     result: 'token bucket per key' });
  console.log('alice reports', b.actions.result({ task_key: inbox.tasks[0].task_key }).result.result);
  console.log('\nthe shared board');
  for (const c of b.actions.status({}).claims) console.log(`  ${c.state.padEnd(8)} ${c.owner.padEnd(6)} ${c.title}`);
  console.log('\none ticket, two agents, one of them doing it.');
};

const cli = async (argv: string[]) => {
  const [command, ...rest] = argv;
  const settings = readConfig();

  if (command === 'open') {
    const address = localAddress();
    const code = joinCode(address, PORT);
    writeConfig({ role: 'host', port: PORT, hub: null });
    console.log(`the office is open  ${address}:${PORT}\n`);
    console.log(`  join code   ${code}\n`);
    console.log(`  teammates run  node pair-programmer.ts join ${code}`);
    await serve(PORT, createBoard());
    return 0;
  }

  if (command === 'join') {
    let address: string, port: number;
    try { [address, port] = readJoinCode(rest[0] || ''); }
    catch (error) { console.error(String((error as Error).message)); return 1; }
    const base = `http://${address}:${port}`;
    const reply = await call(base, 'join', { session_id: id(), owner: hostname(),
                                            harness: 'unknown', cwd: process.cwd() });
    if (!reply.ok) { console.error(`could not join: ${reply.error}`); return 1; }
    writeConfig({ role: 'guest', hub: base, port });
    console.log(`you are in  the office is at ${base}`);
    return 0;
  }

  if (command === 'status') {
    const base = settings.hub || `http://127.0.0.1:${settings.port || PORT}`;
    const board = await boardAt(base);
    if (!board.ok) { console.error(board.error); return 1; }
    console.log(`office at ${base}\n`);
    for (const s of board.sessions) console.log(`  ${s.owner}  ${s.harness}  ${s.cwd}`);
    console.log('\nwork in flight');
    for (const c of board.claims.filter((c: Bag) => c.state === 'claimed'))
      console.log(`  ${c.owner}: ${c.title}`);
    return 0;
  }

  if (command === 'whoami') {
    if (rest[0]) writeConfig({ name: rest[0] });
    console.log(JSON.stringify(readConfig(), null, 2));
    return 0;
  }

  if (command === 'install') {
    const target = join(homedir(), '.minimax', 'plugins', 'pair-programmer');
    for (const item of ['.minimax-plugin', 'icon.png', 'icon-dark.png', 'pair-programmer.mcp.json',
                        'skills', 'office.ts', 'pair-programmer.ts']) {
      if (existsSync(join(HERE, item))) cpSync(join(HERE, item), join(target, item), { recursive: true });
    }
    console.log(`installed the plugin into ${target}`);
    console.log('\nfor another harness, add this to its MCP config:');
    console.log(JSON.stringify({ mcpServers: { 'pair-programmer': { command: 'node',
      args: [join(HERE, 'pair-programmer.ts'), 'mcp'], env: { PAIRPROGRAMMER_HARNESS: 'claude' } } } }, null, 2));
    return 0;
  }

  if (command === 'demo') { demo(); return 0; }

  console.log(`pair-programmer ${VERSION}\n`);
  console.log('  open             open the office and print the join code');
  console.log('  join <code>      join somebody else\'s office');
  console.log('  status           who is here and what they are working on');
  console.log('  whoami <name>    set your name in the office');
  console.log('  install          install the plugin, print the MCP config');
  console.log('  demo             watch two agents avoid doing the same work');
  return 0;
};

if (process.argv[1]?.endsWith('pair-programmer.ts')) {
  const [first] = process.argv.slice(2);
  // Never process.exit() here. It truncates a pending write on stdout, and the
  // last line a harness reads would be the last thing it never sees.
  if (first === 'mcp') await serveMcp();
  else process.exitCode = await cli(process.argv.slice(2));
}
