import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoard, joinCode, readJoinCode, serve, taskKey } from '../pair-programmer.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const freePort = () => new Promise<number>(resolve => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const port = (probe.address() as any).port;
    probe.close(() => resolve(port));
  });
});

test('a join code is twelve characters and decodes back to the address', () => {
  const code = joinCode('192.168.1.42', 7437);
  assert.equal(code.replace(/-/g, '').length, 12);
  assert.deepEqual(readJoinCode(code), ['192.168.1.42', 7437]);
  assert.deepEqual(readJoinCode(code.toLowerCase().replace(/-/g, '')), ['192.168.1.42', 7437]);
  assert.throws(() => readJoinCode('Z' + code.slice(1)), /typo/);
  assert.throws(() => readJoinCode('ABC'), /12 characters/);
});

test('a ticket id wins over the wording, otherwise wording must match', () => {
  assert.equal(taskKey('TICKET-42 add auth middleware'), taskKey('TICKET-42 completely different words'));
  assert.notEqual(taskKey('TICKET-42 add auth middleware'), taskKey('TICKET-51 add auth middleware'));
  assert.notEqual(taskKey('add auth middleware'), taskKey('add rate limit middleware'));
});

test('the first claim wins and the second one is told who holds it', () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice' }, bob = { session_id: 'b', owner: 'bob' };
  b.sit(alice);
  b.sit(bob);
  const title = 'TICKET-42 add auth middleware';
  assert.equal(b.actions.claim({ ...alice, task: title }).status, 'claimed');
  const clash = b.actions.claim({ ...bob, task: title });
  assert.equal(clash.status, 'conflict');
  assert.equal(clash.held_by.owner, 'alice');
});

test('two agents on the same file are flagged even on different tickets', () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice' }, bob = { session_id: 'b', owner: 'bob' };
  b.sit(alice);
  b.sit(bob);
  b.actions.claim({ ...alice, task: 'TICKET-42 auth work', files: ['src/auth.py'] });
  const second = b.actions.claim({ ...bob, task: 'TICKET-51 login work', files: ['src/auth.py'] });
  assert.equal(second.status, 'claimed');
  assert.equal(second.overlaps[0].owner, 'alice');
  assert.deepEqual(second.overlaps[0].files, ['src/auth.py']);
});

test('a delegation lands in the other desk and the result comes back', () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice' }, bob = { session_id: 'b', owner: 'bob' };
  b.sit(alice);
  b.sit(bob);
  const handed = b.actions.delegate({ ...bob, task: 'TICKET-51 rate limit', to: 'alice', brief: '429 please' });
  assert.equal(handed.delegated_to.owner, 'alice');
  const inbox = b.actions.take({ ...alice });
  assert.equal(inbox.tasks.length, 1);
  assert.equal(b.actions.result({ task_key: inbox.tasks[0].task_key }).ok, false);
  b.actions.report({ ...alice, task_key: inbox.tasks[0].task_key, state: 'done', result: 'token bucket' });
  assert.equal(b.actions.result({ task_key: inbox.tasks[0].task_key }).result.result, 'token bucket');
});

test('the demo: two agents, one ticket, no duplicated work', () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice' }, bob = { session_id: 'b', owner: 'bob' };
  b.sit(alice);
  b.sit(bob);
  const title = 'TICKET-42 add auth middleware';
  console.log('alice claims ', b.actions.claim({ ...alice, task: title }).status);
  const clash = b.actions.claim({ ...bob, task: title });
  console.log('bob claims   ', clash.status, clash.message);
  b.actions.delegate({ ...bob, task: 'TICKET-51 rate limit', to: 'alice' });
  console.log('alice picks up', b.actions.take({ ...alice }).tasks[0].title);
});

test('the join code printed in the README is a real code', () => {
  assert.deepEqual(readJoinCode('R2M0-2AGX-1PYG'), ['192.168.1.42', 7437]);
  assert.equal(joinCode('192.168.1.42', 7437), 'R2M0-2AGX-1PYG');
});

test('the files the README tells you to download are the files in this repo', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const paths = [...readme.matchAll(/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/main\/(\S+)/g)].map(m => m[1]);
  assert.equal(new Set(paths).size, 2, 'the install is two files');
  for (const path of new Set(paths)) {
    assert.ok(existsSync(join(ROOT, path)), `the README says to download ${path}, which is not in the repo`);
  }
});

test('the size claim in the README matches the source', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const lines = readFileSync(join(ROOT, 'pair-programmer.ts'), 'utf8').split('\n');
  const code = lines.filter(line => line.trim() && !line.trim().startsWith('//')).length;
  assert.equal(code, Number(readme.match(/(\d+) lines of code/)?.[1]), 'the README line count is stale');
  const claimed = Number(readme.match(/under (\d+) LOC/)?.[1]);
  assert.ok(claimed, 'the README no longer makes a size claim');
  assert.ok(code < claimed, `${code} lines of code is over the ${claimed} the README claims`);
});

test('the team remembers things, and telling it twice corrects the first', () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice' }, bob = { session_id: 'b', owner: 'bob' };
  b.sit(alice);
  b.sit(bob);
  b.actions.remember({ ...alice, key: 'test runner', value: 'node --test' });
  assert.equal(b.actions.recall({ query: 'runner' }).memories[0].value, 'node --test');
  assert.equal(b.actions.recall({ query: 'nothing here' }).memories.length, 0);
  b.actions.remember({ ...bob, key: 'test runner', value: 'node --test, no trailing slash' });
  const found = b.actions.recall({ query: 'runner' }).memories;
  assert.equal(found.length, 1, 'the same key corrects in place rather than piling up');
  assert.equal(found[0].by, 'bob');
  assert.equal(b.actions.recall({}).memories.length, 1, 'an empty query reads everything');
});

test('skills and the shared log reach everybody in the office', () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice' };
  b.sit(alice);
  b.actions.share({ ...alice, name: 'release', text: 'Tag on main, never on a branch.' });
  assert.equal(b.actions.skills().skills[0].name, 'release');
  b.actions.say({ ...alice, text: 'staging is down, do not deploy' });
  assert.equal(b.actions.read({}).log[0].text, 'staging is down, do not deploy');
  assert.equal(b.actions.read({ last: 1 }).log.length, 1);
});

test('work stops on a question and picks back up when somebody answers it', () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice' }, bob = { session_id: 'b', owner: 'bob' };
  b.sit(alice);
  b.sit(bob);
  b.actions.claim({ ...alice, task: 'TICKET-42 rotate the staging key' });
  const parked = b.actions.ask({ ...alice, task: 'TICKET-42 rotate the staging key',
    question: 'Which vault does staging read from?', options: ['vault', 'the .env'] });
  assert.equal(parked.waiting, true);
  const task = b.actions.status().tasks.find((t: any) => t.task_key === parked.task_key);
  assert.equal(task.state, 'waiting');
  assert.equal(task.waiting_on, 'Which vault does staging read from?');
  assert.equal(b.actions.take({ ...alice }).tasks.length, 0, 'the holder does not get it back while the question is open');
  b.actions.answer({ ...bob, task_key: parked.task_key, answer: 'the .env on the deploy box' });
  const resumed = b.actions.take({ ...alice }).tasks;
  assert.equal(resumed.length, 1, 'the answer hands the work back to whoever parked it');
  assert.equal(resumed[0].answer.text, 'the .env on the deploy box');
  assert.equal(b.actions.ask({ ...alice, task: 'nothing' }).ok, false, 'a question is required');
});

test('work nobody has touched for 45 minutes is up for grabs again', () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice' }, bob = { session_id: 'b', owner: 'bob' };
  b.sit(alice);
  b.sit(bob);
  const title = 'TICKET-42 add auth middleware';
  b.actions.claim({ ...alice, task: title });
  assert.equal(b.actions.claim({ ...bob, task: title }).status, 'conflict');
  const real = Date.now;
  Date.now = () => real() + 46 * 60e3;
  try {
    assert.equal(b.actions.status().tasks[0].state, 'stale');
    const taken = b.actions.claim({ ...bob, task: title });
    assert.equal(taken.status, 'claimed', 'a claim that went quiet does not hold the task hostage');
    assert.ok(taken.history.some((e: any) => /took over from alice/.test(e.text)), 'and the taker is told why');
  } finally { Date.now = real; }
});

test('a delegation waits for a teammate who has not connected yet', () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice' };
  b.sit(alice);
  const handed = b.actions.delegate({ ...alice, task: 'TICKET-51 rate limit', to: 'bob' });
  assert.equal(handed.delegated_to.owner, 'bob');
  assert.match(handed.message, /not at a desk/);
  assert.equal(b.actions.take({ ...alice }).tasks.length, 0, 'and it is not offered to anybody else');
  b.sit({ session_id: 'b', owner: 'bob' });
  assert.equal(b.actions.take({ session_id: 'b', owner: 'bob' }).tasks[0].title, 'TICKET-51 rate limit');
  // a name typed in a different case still reaches the desk that is here
  const again = b.actions.delegate({ ...alice, task: 'TICKET-52 second look', to: 'BOB' });
  assert.equal(again.delegated_to.owner, 'bob');
  assert.equal(b.actions.take({ session_id: 'b3', owner: 'Bob' }).tasks[0].title, 'TICKET-52 second look');
});

test('a memory can be attached to the files it is about', () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice' };
  b.sit(alice);
  b.actions.remember({ ...alice, key: 'auth convention', value: 'tokens go in the header', files: ['src/auth.py'] });
  b.actions.remember({ ...alice, key: 'deploy', value: 'staging reads the .env' });
  assert.equal(b.actions.recall({ files: ['src/auth.py'] }).memories.length, 1);
  assert.equal(b.actions.recall({ files: ['src/auth.py'] }).memories[0].key, 'auth convention');
  assert.equal(b.actions.recall({ files: ['src/other.py'] }).memories.length, 0);
  const claimed = b.actions.claim({ ...alice, task: 'TICKET-42 auth work', files: ['src/auth.py'] });
  assert.equal(claimed.known[0].key, 'auth convention', 'a claim hands back what the team knows about those files');
});

test('the board is written down, so restarting the host does not lose the team', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pair-programmer-board-')), 'board.json');
  const alice = { session_id: 'a', owner: 'alice' };
  const first = createBoard(file);
  first.sit(alice);
  first.actions.claim({ ...alice, task: 'TICKET-42 add auth middleware' });
  first.actions.remember({ ...alice, key: 'test runner', value: 'node --test' });
  first.actions.say({ ...alice, text: 'staging is down, do not deploy' });

  const second = createBoard(file);
  assert.equal(second.actions.recall({ query: 'runner' }).memories[0].value, 'node --test');
  assert.equal(second.actions.read({}).log[0].text, 'staging is down, do not deploy');
  assert.equal(second.actions.claim({ session_id: 'b', owner: 'bob', task: 'TICKET-42 add auth middleware' }).status,
    'conflict', 'the claim came back too');
  assert.deepEqual(second.actions.status().sessions, [], 'who is in the office is not written down');
});

test('pair_wait returns the moment work lands instead of polling', async () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice' }, bob = { session_id: 'b', owner: 'bob' };
  b.sit(alice);
  b.sit(bob);
  const waiting = b.actions.wait({ ...bob, seconds: 5 });
  setTimeout(() => b.actions.delegate({ ...alice, task: 'TICKET-51 rate limit', to: 'bob' }), 1100);
  const arrived = await waiting;
  assert.equal(arrived.arrived, true);
  assert.equal(arrived.tasks[0].title, 'TICKET-51 rate limit');

  const quiet = createBoard();
  quiet.sit(bob);
  const nothing = await quiet.actions.wait({ ...bob, seconds: 1 });
  assert.equal(nothing.tasks.length, 0);
  assert.match(nothing.note, /nothing arrived/);
});

test('posted work goes to whoever asks first, a delegation only to its target', () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice' }, bob = { session_id: 'b', owner: 'bob' };
  b.sit(alice);
  b.sit(bob);
  const posted = b.actions.post({ ...alice, task: 'TICKET-90 write the migration guide' });
  const picked = b.actions.take({ ...bob }).tasks;
  assert.equal(picked.length, 1);
  assert.equal(picked[0].to_owner, 'bob');
  assert.equal(b.actions.take({ ...alice }).tasks.length, 0, 'a posted task is only handed out once');
  b.actions.report({ ...bob, task_key: posted.task_key, state: 'done', result: 'guide is up' });
  assert.equal(b.actions.result({ task_key: posted.task_key }).result.result, 'guide is up');
  b.actions.delegate({ ...alice, task: 'TICKET-91 check it', to: 'bob' });
  assert.equal(b.actions.take({ ...alice }).tasks.length, 0, 'a delegation is not for anybody else');
});

test('a cron or a webhook posts work with nothing but a plain text body', async () => {
  const port = await freePort();
  const server = await serve(port, createBoard());
  try {
    const sent = await fetch(`http://127.0.0.1:${port}/trigger`, { method: 'POST', body: 'TICKET-92 rotate the staging keys' });
    assert.equal((await sent.json()).ok, true);
    const picked = await fetch(`http://127.0.0.1:${port}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'take', session_id: 'cron', owner: 'cron' }) });
    const tasks = (await picked.json()).tasks;
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].title, 'TICKET-92 rotate the staging keys');
    assert.equal((await fetch(`http://127.0.0.1:${port}/trigger`)).status, 404, 'a GET is not a trigger');
  } finally {
    server.close();
  }
});

test('config tells you how to host or join, not only how to wire up MCP', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pair-programmer-config-'));
  const out = await new Promise<string>(resolve => {
    const child = spawn(process.execPath, [join(ROOT, 'pair-programmer.ts'), 'config'],
      { env: { ...process.env, PAIRPROGRAMMER_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    child.stdout.on('data', (chunk: Buffer) => (text += chunk));
    child.on('exit', () => resolve(text));
  });
  assert.match(out, /node \S+pair-programmer\.ts open/, 'config must say how to open the office');
  assert.match(out, /node \S+pair-programmer\.ts join <code>/, 'config must say how to join one');
  assert.ok(existsSync(join(home, 'mcp.json')), 'config writes the mcp json it points at');
});

test('a failed join says which of the three causes it was, not just "not answering"', async () => {
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), 'pair-programmer-join-'));
  const run = (...args: string[]) => new Promise<string>(resolve => {
    const child = spawn(process.execPath, [join(ROOT, 'pair-programmer.ts'), ...args], {
      env: { ...process.env, PAIRPROGRAMMER_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (c: Buffer) => (out += c)); child.stderr.on('data', (c: Buffer) => (out += c));
    child.on('exit', () => resolve(out.trim()));
  });

  // nothing listening: the host is not running. This is not a firewall problem.
  assert.match(await run('join', `127.0.0.1:${port}`), /nothing is listening.*still running "open"/);

  // a name that cannot resolve is reported as a timeout by fetch, so it must not
  // be blamed on the firewall, which would send the user to the wrong fix.
  const named = await run('join', 'no-such-host.invalid:7437');
  assert.match(named, /name is wrong/);
  assert.doesNotMatch(named, /That is what a firewall looks like/);

  // an address that cannot be a naming mistake, and still times out, is a firewall.
  assert.match(await run('join', '10.255.255.1:7437'), /That is what a firewall looks like/);

  // a short argument is still read as a code, not as an address.
  assert.match(await run('join', 'ABC'), /12 characters/);
});

test('join takes an address as well as a code, for a tunnel or a VPN', async () => {
  const port = await freePort();
  const server = await serve(port, createBoard());
  const home = mkdtempSync(join(tmpdir(), 'pair-programmer-addr-'));
  const run = (...args: string[]) => new Promise<string>(resolve => {
    const child = spawn(process.execPath, [join(ROOT, 'pair-programmer.ts'), ...args], {
      env: { ...process.env, PAIRPROGRAMMER_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (c: Buffer) => (out += c)); child.stderr.on('data', (c: Buffer) => (out += c));
    child.on('exit', () => resolve(out.trim()));
  });

  try {
    assert.match(await run('join', `127.0.0.1:${port}`), /you are in/);
    assert.match(await run('join', `http://127.0.0.1:${port}`), /you are in/);
    // and the code form still works, carrying the same address
    assert.match(await run('join', joinCode('127.0.0.1', port)), /you are in/);
  } finally {
    server.close();
  }
});

test('the CLI runs the whole loop: claim, conflict, delegate, pick up, report', async () => {
  const port = await freePort();
  const server = await serve(port, createBoard());
  const home = mkdtempSync(join(tmpdir(), 'pair-programmer-cli-'));
  writeFileSync(join(home, 'office.json'), JSON.stringify({ hub: `http://127.0.0.1:${port}` }));

  const run = (who: string, ...args: string[]) => new Promise<string>(resolve => {
    const child = spawn(process.execPath, [join(ROOT, 'pair-programmer.ts'), ...args], {
      env: { ...process.env, PAIRPROGRAMMER_HOME: home, PAIRPROGRAMMER_OWNER: who },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk));
    child.on('exit', () => resolve(out.trim()));
  });

  try {
    assert.match(await run('alice', 'claim', 'TICKET-42 add auth middleware'), /^claimed\s+\w+/);
    assert.match(await run('bob', 'claim', 'TICKET-42 add auth middleware'), /^conflict\s+alice already claimed/);
    assert.match(await run('alice', 'delegate', 'TICKET-51 write the rate limit middleware', 'bob'),
      /^handed to bob/);
    const picked = await run('bob', 'next');
    assert.match(picked, /^picked up\s+TICKET-51 write the rate limit middleware/);
    assert.match(await run('bob', 'report', picked.split(/\s+/).pop()!, 'token bucket', 'done'),
      /^reported\s+done/);
    assert.match(await run('bob', 'wait', '1'), /nothing arrived while you waited/);
    const board = await run('bob', 'status');
    assert.match(board, /alice/);
    assert.match(board, /TICKET-42 add auth middleware/);
  } finally {
    server.close();
  }
});

test('the MCP server answers initialize, lists the tools and runs them', async () => {
  const port = await freePort();
  const server = await serve(port, createBoard());
  const home = mkdtempSync(join(tmpdir(), 'pair-programmer-'));
  writeFileSync(join(home, 'office.json'),
    JSON.stringify({ role: 'guest', hub: `http://127.0.0.1:${port}`, name: 'tester' }));

  const child = spawn(process.execPath, [join(ROOT, 'pair-programmer.ts'), 'mcp'], {
    env: { ...process.env, PAIRPROGRAMMER_HOME: home, PAIRPROGRAMMER_HARNESS: 'test' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let nextId = 0;
  const ask = (method: string, params?: any) => new Promise<any>((resolve, reject) => {
    const id = ++nextId;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.id !== id) continue;
        child.stdout.off('data', onData);
        resolve(message);
      }
    };
    child.stdout.on('data', onData);
    setTimeout(() => reject(new Error(`no answer to ${method}`)), 15000);
  });

  try {
    const init = await ask('initialize', { protocolVersion: '2024-11-05', capabilities: {},
                                            clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'pair-programmer');
    const tools = await ask('tools/list');
    assert.equal(tools.result.tools.length, 17);
    const reply = await ask('tools/call', { name: 'pair_claim',
                                            arguments: { task: 'TICKET-42 add auth middleware' } });
    const outcome = JSON.parse(reply.result.content[0].text);
    assert.equal(outcome.status, 'claimed');
    assert.equal(reply.result.isError, false);
    const remembered = await ask('tools/call', { name: 'pair_remember',
                                                 arguments: { key: 'test runner', value: 'node --test' } });
    assert.equal(JSON.parse(remembered.result.content[0].text).remembered, true);
    const recalled = await ask('tools/call', { name: 'pair_recall', arguments: { query: 'runner' } });
    assert.equal(JSON.parse(recalled.result.content[0].text).memories[0].value, 'node --test');
    const parked = await ask('tools/call', { name: 'pair_ask', arguments: {
      task: 'TICKET-42 add auth middleware', question: 'which vault does staging read from?' } });
    assert.equal(JSON.parse(parked.result.content[0].text).waiting, true);
    const waited = await ask('tools/call', { name: 'pair_wait', arguments: { seconds: '1' } });
    assert.equal(JSON.parse(waited.result.content[0].text).tasks.length, 0);
    const read = await ask('tools/call', { name: 'pair_result',
                                            arguments: { task_key: outcome.task_key } });
    assert.equal(JSON.parse(read.result.content[0].text).ok, false);
  } finally {
    child.kill();
    server.close();
  }
});
