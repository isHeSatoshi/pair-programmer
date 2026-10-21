import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBoard, serve } from '../office.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const freePort = () => new Promise<number>(resolve => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const port = (probe.address() as any).port;
    probe.close(() => resolve(port));
  });
});

// A tiny MCP client: write one JSON-RPC line, read one back.
class Client {
  private nextId = 0;
  private child: any;

  constructor(child: any) {
    this.child = child;
  }

  call(method: string, params?: any) {
    const id = ++this.nextId;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 15000);
      const onData = (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (message.id !== id) continue;
          clearTimeout(timer);
          this.child.stdout.off('data', onData);
          resolve(message);
        }
      };
      this.child.stdout.on('data', onData);
    });
  }

  async tool(name: string, args: any = {}) {
    const reply = await this.call('tools/call', { name, arguments: args });
    return { payload: JSON.parse(reply.result.content[0].text), isError: reply.result.isError };
  }
}

test('the MCP server answers initialize, lists the tools and runs them', async () => {
  const port = await freePort();
  const board = createBoard();
  const server = await serve(port, board);

  const home = mkdtempSync(join(tmpdir(), 'pair-programmer-'));
  writeFileSync(join(home, 'office.json'),
    JSON.stringify({ role: 'guest', hub: `http://127.0.0.1:${port}`, name: 'tester' }));

  const child = spawn(process.execPath, [join(ROOT, 'pair-programmer.ts'), 'mcp'], {
    env: { ...process.env, PAIRPROGRAMMER_HOME: home, PAIRPROGRAMMER_HARNESS: 'minimax' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const client = new Client(child);

  try {
    const init = await client.call('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    });
    assert.equal(init.result.serverInfo.name, 'pair-programmer');

    const tools = await client.call('tools/list');
    const names = tools.result.tools.map((t: any) => t.name);
    assert.deepEqual(names.sort(),
      ['pair_claim', 'pair_delegate', 'pair_next_task', 'pair_release', 'pair_report', 'pair_status']);

    const claimed = await client.tool('pair_claim', { task: 'TICKET-42 add auth middleware' });
    assert.equal(claimed.isError, false);
    assert.equal(claimed.payload.status, 'claimed');

    const reported = await client.tool('pair_report', { task_key: claimed.payload.task_key, result: 'done' });
    assert.equal(reported.payload.state, 'done');

    const status = await client.tool('pair_status');
    assert.equal(status.isError, false);
    assert.match(status.payload.summary, /tester/);
  } finally {
    child.kill();
    server.close();
  }
});
