import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoard, joinCode, readJoinCode, taskKey } from '../office.ts';

test('a join code is twelve characters and decodes back to the address', () => {
  const code = joinCode('192.168.1.42', 7437);
  assert.equal(code.replace(/-/g, '').length, 12);
  assert.deepEqual(readJoinCode(code), ['192.168.1.42', 7437]);
  assert.deepEqual(readJoinCode(code.toLowerCase().replace(/-/g, '')), ['192.168.1.42', 7437]);
});

test('a join code with a typo is rejected', () => {
  const code = joinCode('10.0.0.7', 9000);
  assert.throws(() => readJoinCode('Z' + code.slice(1)), /typo/);
  assert.throws(() => readJoinCode('ABC'), /12 characters/);
});

test('a ticket id wins over the wording, otherwise wording must match', () => {
  assert.equal(taskKey('TICKET-42 add auth middleware'), taskKey('TICKET-42 completely different words'));
  assert.notEqual(taskKey('TICKET-42 add auth middleware'), taskKey('TICKET-51 add auth middleware'));
  assert.equal(taskKey('add auth middleware'), taskKey('add auth middleware'));
  assert.notEqual(taskKey('add auth middleware'), taskKey('add rate limit middleware'));
});

test('the first claim wins and the second one is told who holds it', () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice' };
  const bob = { session_id: 'b', owner: 'bob' };
  b.actions.join(alice);
  b.actions.join(bob);
  const title = 'TICKET-42 add auth middleware';

  assert.equal(b.actions.claim({ ...alice, task: title }).status, 'claimed');
  const clash = b.actions.claim({ ...bob, task: title });
  assert.equal(clash.status, 'conflict');
  assert.equal(clash.held_by.owner, 'alice');
});

test('different tickets do not collide but the same file is flagged', () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice' };
  const bob = { session_id: 'b', owner: 'bob' };
  b.actions.join(alice);
  b.actions.join(bob);
  b.actions.claim({ ...alice, task: 'TICKET-42 auth work', files: ['src/auth.py'] });

  const other = b.actions.claim({ ...bob, task: 'TICKET-51 login work', files: ['src/auth.py'] });
  assert.equal(other.status, 'claimed');
  assert.deepEqual(other.overlaps[0].files, ['src/auth.py']);
});

test('releasing a claim lets the other desk take it', () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice' };
  const bob = { session_id: 'b', owner: 'bob' };
  b.actions.join(alice);
  b.actions.join(bob);
  const first = b.actions.claim({ ...alice, task: 'TICKET-42 auth work' });
  b.actions.release({ ...alice, task_key: first.task_key });
  assert.equal(b.actions.claim({ ...bob, task: 'TICKET-42 auth work' }).status, 'claimed');
});

test('a delegation lands in the other desk and the result comes back', () => {
  const b = createBoard();
  const alice = { session_id: 'a', owner: 'alice' };
  const bob = { session_id: 'b', owner: 'bob' };
  b.actions.join(alice);
  b.actions.join(bob);

  const handed = b.actions.delegate({ ...bob, task: 'TICKET-51 rate limit', to: 'alice', brief: '429 please' });
  assert.equal(handed.delegated_to.owner, 'alice');

  const inbox = b.actions.take({ ...alice });
  assert.equal(inbox.tasks.length, 1);
  assert.equal(inbox.tasks[0].brief, '429 please');

  b.actions.report({ ...alice, task_key: inbox.tasks[0].task_key, state: 'done', result: 'token bucket' });
  const result = b.actions.result({ task_key: inbox.tasks[0].task_key });
  assert.equal(result.result.result, 'token bucket');
});

test('delegating to nobody is an error that lists the desks', () => {
  const b = createBoard();
  b.actions.join({ session_id: 'a', owner: 'alice' });
  const reply = b.actions.delegate({ task: 'TICKET-51 work', to: 'nobody' });
  assert.equal(reply.ok, false);
  assert.equal(reply.available.length, 1);
});

test('the board lists every desk and the work in flight', () => {
  const b = createBoard();
  b.actions.join({ session_id: 'a', owner: 'alice', harness: 'minimax' });
  b.actions.join({ session_id: 'b', owner: 'bob', harness: 'cursor' });
  b.actions.claim({ session_id: 'a', owner: 'alice', task: 'TICKET-42 auth work' });
  const board = b.actions.status({});
  assert.equal(board.sessions.length, 2);
  assert.equal(board.claims.length, 1);
  assert.match(board.summary, /alice \(minimax\)/);
  assert.match(board.summary, /work in flight: 1/);
});
