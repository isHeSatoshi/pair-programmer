import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

test('the MCP server answers initialize, lists the tools and runs them', async () => {
  const port = await freePort();
  const server = await serve(port, createBoard());
  const home = mkdtempSync(join(tmpdir(), 'pair-programmer-'));
  writeFileSync(join(home, 'office.json'),
    JSON.stringify({ role: 'guest', hub: `http://127.0.0.1:${port}`, name: 'tester' }));

  const child = spawn(process.execPath, [join(ROOT, 'pair-programmer.ts'), 'mcp'], {
    env: { ...process.env, PAIRPROGRAMMER_HOME: home, PAIRPROGRAMMER_HARNESS: 'minimax' },
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
    assert.equal(tools.result.tools.length, 7);
    const reply = await ask('tools/call', { name: 'pair_claim',
                                            arguments: { task: 'TICKET-42 add auth middleware' } });
    const outcome = JSON.parse(reply.result.content[0].text);
    assert.equal(outcome.status, 'claimed');
    assert.equal(reply.result.isError, false);
    const read = await ask('tools/call', { name: 'pair_result',
                                            arguments: { task_key: outcome.task_key } });
    assert.equal(JSON.parse(read.result.content[0].text).ok, false);
  } finally {
    child.kill();
    server.close();
  }
});
