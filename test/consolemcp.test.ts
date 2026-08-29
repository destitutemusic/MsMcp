import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { Client, InMemoryTransport as ClientTransport } from '@modelcontextprotocol/client';
import { InMemoryTransport as ServerTransport } from '@modelcontextprotocol/server';

import { ConsoleGateway } from '../src/gateway.js';
import { MappingCatalog, type JsonObject } from '../src/mapping.js';
import { decodeOscPacket, encodeOscMessage, type OscMessage, type OscTransport } from '../src/osc.js';
import { createServer } from '../src/server.js';

class MockTransport implements OscTransport {
  public readonly sent: OscMessage[] = [];
  public readonly expected: string[] = [];
  public response: OscMessage | null = null;
  public timeout = false;

  public async send(message: OscMessage): Promise<void> {
    this.sent.push(message);
  }

  public async request(message: OscMessage, expectedAddress: string): Promise<OscMessage | null> {
    this.sent.push(message);
    this.expected.push(expectedAddress);
    if (this.timeout) return null;
    if (this.response !== null && this.response.address !== expectedAddress) return null;
    return this.response;
  }
}

function profilePath(name: string): string {
	return fileURLToPath(new URL(`../../profiles/${name}`, import.meta.url));
}

function testCatalog(): MappingCatalog {
  return MappingCatalog.fromObject({
    schemaVersion: 1,
    id: 'test',
    name: 'Test console',
    transport: { timeoutMs: 10, rateLimitPerSecond: 20 },
    snapshotCommands: [{ command: 'fader.get', arguments: {} }],
    commands: [
      { id: 'fader.get', description: 'Read fader', kind: 'get', value: { type: 'number', min: 0, max: 100, transform: { scale: 0.01, offset: 0 } }, osc: { get: '/fader' } },
      { id: 'fader.set', description: 'Set fader', kind: 'set', value: { type: 'number', min: 0, max: 100, transform: { scale: 0.01, offset: 0 } }, osc: { set: '/fader' } },
      { id: 'channel.set', description: 'Set channel fader', kind: 'set', arguments: [{ name: 'channel', type: 'integer', min: 1, max: 32, width: 2 }], value: { type: 'number', min: 0, max: 1 }, osc: { set: '/ch/{channel}/fader' } },
      { id: 'status.get', description: 'Read status', kind: 'get', value: { type: 'boolean', oscType: 'int' }, osc: { get: '/status' } },
      { id: 'multi.get', description: 'Read a multi-argument reply', kind: 'get', value: { type: 'number', min: -144, max: 10, replyIndex: 2 }, osc: { get: '/multi' } },
      { id: 'query.get', description: 'Query one address, answered on another', kind: 'get', arguments: [{ name: 'channel', type: 'integer', min: 1, max: 8 }], value: { type: 'number', min: 0, max: 1 }, osc: { get: '/ch/{channel}/level/?', reply: '/ch/{channel}/level' } },
    ],
  });
}

test('OSC codec round trips typed messages', () => {
  const original: OscMessage = { address: '/test', arguments: [
    { type: 'int', value: 7 }, { type: 'float', value: 0.5 }, { type: 'string', value: 'hello' },
    { type: 'bool', value: true }, { type: 'nil' }, { type: 'blob', value: Uint8Array.from([1, 2, 3]) },
  ] };
  const decoded = decodeOscPacket(encodeOscMessage(original));
  assert.deepEqual(decoded, [original]);
});

test('mapping and gateway validate, transform, and serialize commands', async () => {
  const catalog = testCatalog();
  assert.equal(MappingCatalog.expandAddress('/ch/{channel}', { channel: 1 }, [{ name: 'channel', type: 'integer', width: 2, min: 1, max: 32, values: [] }]), '/ch/01');
  const transport = new MockTransport();
  transport.response = { address: '/fader', arguments: [{ type: 'float', value: 0.5 }] };
  const gateway = new ConsoleGateway(catalog, transport, false);
  await gateway.execute('fader.set', { value: 50 });
  assert.equal(transport.sent.at(-1)?.arguments[0]?.type, 'float');
  assert.equal((transport.sent.at(-1)?.arguments[0] as { value: number }).value, 0.5);
  const result = await gateway.execute('fader.get', {});
  assert.equal(result.value, 50);
  await assert.rejects(() => gateway.execute('channel.set', { channel: 33, value: 0.5 }));
  assert.equal(transport.sent.length, 2);
  transport.timeout = true;
  await assert.rejects(() => gateway.execute('fader.get', {}), /timed out/);
});

test('bundled profiles load and generate MCP tools/resources', async () => {
  const x32 = MappingCatalog.fromFile(profilePath('x32-m32.json'));
  const transport = new MockTransport();
  transport.response = { address: '/main/st/mix/fader', arguments: [{ type: 'float', value: 0.5 }] };
  const server = createServer(new ConsoleGateway(x32, transport, false));
  const [clientTransport, serverTransport] = ClientTransport.createLinkedPair();
  const client = new Client({ name: 'consolemcp-test', version: '1' });
  await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport as unknown as ServerTransport)]);
  try {
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === 'console.channel.fader.set'));
    const getTool = tools.tools.find((tool) => tool.name === 'console.channel.fader.get');
    assert.ok(getTool);
    assert.equal((getTool.inputSchema.properties as Record<string, unknown>).value, undefined);
    const call = await client.callTool({ name: 'console.channel.fader.set', arguments: { channel: 2, value: 0.75 } });
    assert.equal(call.isError, undefined);
    assert.equal(transport.sent.at(-1)?.address, '/ch/2/mix/fader');
    const resource = await client.readResource({ uri: 'console://commands' });
    assert.equal(resource.contents.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test('raw OSC remains gated by startup configuration', async () => {
  const transport = new MockTransport();
  const gateway = new ConsoleGateway(testCatalog(), transport, false);
  await assert.rejects(() => gateway.rawOsc({ address: '/unsafe', arguments: [] }), /disabled/);
  const enabled = new ConsoleGateway(testCatalog(), transport, true);
  await enabled.rawOsc({ address: '/unsafe', arguments: [{ type: 'int', value: 4 }, true] });
  assert.equal(transport.sent.at(-1)?.address, '/unsafe');
});

test('replyIndex selects the right argument of a multi-argument reply', async () => {
  // Consoles such as the WING answer one query with several representations of
  // the same parameter, so a value must be able to name the argument it means.
  const transport = new MockTransport();
  const gateway = new ConsoleGateway(testCatalog(), transport, false);

  transport.response = {
    address: '/multi',
    arguments: [{ type: 'string', value: '-12.5' }, { type: 'float', value: 0.46 }, { type: 'float', value: -12.5 }],
  };
  assert.equal((await gateway.execute('multi.get', {})).value, -12.5);

  // A shorter reply than the index expects degrades to the last argument sent
  // rather than reading past the end.
  transport.response = { address: '/multi', arguments: [{ type: 'float', value: 7.5 }] };
  assert.equal((await gateway.execute('multi.get', {})).value, 7.5);
});

test('rate limiter paces a burst instead of aborting it', async () => {
  // The limiter must delay rather than fail: aborting part-way through a
  // restore would leave the console half-written.
  const transport = new MockTransport();
  const gateway = new ConsoleGateway(testCatalog(), transport, false);
  const rate = 20; // matches testCatalog's rateLimitPerSecond
  const overBudget = rate + 3;

  const started = Date.now();
  for (let index = 0; index < overBudget; index += 1) await gateway.execute('fader.set', { value: 50 });
  const elapsed = Date.now() - started;

  assert.equal(transport.sent.length, overBudget, 'rate limiter dropped messages instead of pacing them');
  assert.ok(elapsed >= 900, `rate limiter did not pace the burst (took ${elapsed}ms)`);
});

test('osc.reply matches a reply that arrives on a different address than the query', async () => {
  const catalog = testCatalog();
  const transport = new MockTransport();
  transport.response = { address: '/ch/3/level', arguments: [{ type: 'float', value: 0.25 }] };
  const gateway = new ConsoleGateway(catalog, transport, false);

  const result = await gateway.execute('query.get', { channel: 3 });
  assert.equal(result.value, 0.25);
  // The query carries the '/?' suffix; the reply is matched on the bare address.
  assert.equal(transport.sent.at(-1)?.address, '/ch/3/level/?');
  assert.equal(transport.expected.at(-1), '/ch/3/level');
});

test('a command without osc.reply still matches on the address it queried', async () => {
  const catalog = testCatalog();
  const transport = new MockTransport();
  transport.response = { address: '/fader', arguments: [{ type: 'float', value: 0.5 }] };
  const gateway = new ConsoleGateway(catalog, transport, false);
  assert.equal((await gateway.execute('fader.get', {})).value, 50);
  assert.equal(transport.expected.at(-1), '/fader');
});
