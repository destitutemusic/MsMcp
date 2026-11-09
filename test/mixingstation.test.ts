import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

import { DEFAULT_HOST, DEFAULT_PORT, MixingStationClient } from '../src/mixingstation.js';

interface MockState {
	http: HttpServer;
	wss: WebSocketServer;
	values: Map<string, unknown>;
	connections: WebSocket[];
	port: number;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve) => {
		let raw = '';
		req.setEncoding('utf8');
		req.on('data', (chunk: string) => {
			raw += chunk;
		});
		req.on('end', () => {
			try {
				resolve(raw.length === 0 ? undefined : JSON.parse(raw));
			} catch {
				resolve(undefined);
			}
		});
	});
}

/** In-process stand-in for Mixing Station Desktop's REST/websocket API. */
function startMock(): Promise<MockState> {
	return new Promise((resolve) => {
		const values = new Map<string, unknown>([['ch.0.mix.lvl', -5]]);
		const connections: WebSocket[] = [];
		const http = createServer(async (req, res) => {
			const url = req.url ?? '';
			if (url === '/app/state') {
				res.setHeader('content-type', 'application/json');
				res.end('{}');
				return;
			}
			const match = /^\/console\/data\/(get|set)\/(.+)\/val$/.exec(url);
			if (match) {
				const action = match[1]!;
				const dataPath = decodeURIComponent(match[2]!);
				if (action === 'get') {
					if (dataPath === 'ch.9.error') {
						res.statusCode = 500;
						res.end('{"error":"boom"}');
						return;
					}
					if (dataPath === 'ch.9.timeout') return; // never reply — the client aborts
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify({ format: 'val', value: values.get(dataPath) ?? null }));
					return;
				}
				const body = await readJsonBody(req);
				const value = typeof body === 'object' && body !== null && 'value' in body ? body.value : undefined;
				values.set(dataPath, value);
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({ format: 'val', value }));
				return;
			}
			res.statusCode = 404;
			res.end('{}');
		});
		const wss = new WebSocketServer({ server: http });
		wss.on('connection', (socket) => {
			connections.push(socket);
			socket.on('message', (data) => {
				const request = JSON.parse(data.toString()) as { path: string; method: string; body?: unknown };
				const dataPath = request.path.replace(/^\/console\/data\//, '');
				const reply = (body: unknown, error: string | null = null) => {
					socket.send(JSON.stringify({ path: request.path, method: request.method, body, error }));
				};
				if (dataPath === 'subscribe') {
					let pattern = 'unknown';
					if (request.body !== null && typeof request.body === 'object' && 'path' in request.body) {
						pattern = String(request.body.path);
					}
					if (pattern === 'ch.9.error') {
						reply(null, 'boom');
						return;
					}
					reply(null);
					const concrete = pattern.replace('*', '0');
					socket.send(JSON.stringify({ path: `/console/data/${concrete}`, method: 'POST', body: values.get(concrete) ?? 0, error: null }));
					return;
				}
				if (dataPath === 'unsubscribe') {
					reply(null);
				}
			});
		});
		http.listen(0, '127.0.0.1', () => {
			resolve({ http, wss, values, connections, port: (http.address() as { port: number }).port });
		});
	});
}

function push(state: MockState, path: string, value: unknown): void {
	for (const socket of state.connections) {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ path: `/console/data/${path}`, method: 'POST', body: value, error: null }));
		}
	}
}

/**
 * Poll `predicate` every 10 ms until it holds or the deadline passes.
 *
 * The deadline is deliberately generous. It used to be 2 s (and 3 s at one call site), which is
 * fine on an idle machine and not fine under load: the discovery tests in this suite each take
 * 21-70 s, so by the time the reconnect test runs the event loop is busy and a legitimate
 * reconnect-and-resubscribe (which has an intentional 30-60 ms backoff) can miss a 3 s window.
 * A test that fails only in a full suite teaches contributors to ignore red.
 *
 * Fast polling stays; only the ceiling moved. Fifteen seconds is ~50x the observed reconnect
 * latency, so the test cannot flake on scheduling delay, and a genuine hang still fails fast
 * enough to be a useful signal.
 */
const WAIT_FOR_DEADLINE_MS = 15_000;

async function waitFor(predicate: () => boolean, timeoutMs = WAIT_FOR_DEADLINE_MS): Promise<void> {
	const started = Date.now();
	const deadline = started + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error(`waitFor timed out after ${Date.now() - started} ms (deadline ${timeoutMs} ms)`);
		}
		await new Promise((r) => setTimeout(r, 10));
	}
}

/**
 * Build the in-process mock and a client, and run one test body against them.
 *
 * `timeoutMs` is the CLIENT's request deadline, and it defaults generous for the same reason
 * `waitFor` does: under load this suite's own discovery tests hold the event loop for 21-70 s, so
 * a 2 s request deadline expired on tests that had done nothing wrong. The one test that is
 * *about* a timeout -- 'unanswered requests time out' -- passes 100 ms explicitly, so the
 * behaviour it pins is unchanged.
 */
async function withMock(t: { after: (fn: () => void | Promise<void>) => void }, run: (state: MockState, client: MixingStationClient) => Promise<void>, timeoutMs = 15_000): Promise<void> {
	const state = await startMock();
	const client = new MixingStationClient({ host: '127.0.0.1', port: state.port, timeoutMs, reconnectDelayMs: 30, maxReconnectDelayMs: 60 });
	t.after(() => {
		client.close();
		for (const socket of state.connections) socket.terminate();
		state.wss.close();
		state.http.close();
	});
	await run(state, client);
}

test('the default port is Mixing Station\'s documented REST port, 8080', () => {
	// Pinned against RESEARCH.md's own CLI spec ("--port PORT ... default: 8080") and the sibling
	// app's config, so the first-run experience cannot drift back to a port nothing listens on.
	assert.equal(DEFAULT_PORT, 8080);
	assert.equal(DEFAULT_HOST, '127.0.0.1');
});

test('get reads a value over HTTP REST', async (t) => {
	await withMock(t, async (state, client) => {
		await client.connect();
		assert.equal(await client.get('ch.0.mix.lvl'), -5);
	});
});

test('set writes a value and reads it back', async (t) => {
	await withMock(t, async (state, client) => {
		await client.connect();
		assert.equal(await client.set('ch.1.mix.lvl', 0.5), 0.5);
		assert.equal(state.values.get('ch.1.mix.lvl'), 0.5);
		assert.equal(await client.get('ch.1.mix.lvl'), 0.5);
	});
});

test('subscribe delivers the initial value and pushed updates', async (t) => {
	await withMock(t, async (state, client) => {
		await client.connect();
		const received: unknown[] = [];
		await client.subscribe('ch.*.mix.lvl', (value) => received.push(value));
		await waitFor(() => received.length >= 1);
		assert.deepEqual(received, [-5]);
		push(state, 'ch.2.mix.lvl', 0.25);
		await waitFor(() => received.length >= 2);
		assert.deepEqual(received, [-5, 0.25]);
	});
});

test('subscribe rejects when the server reports an error', async (t) => {
	await withMock(t, async (state, client) => {
		await client.connect();
		await assert.rejects(client.subscribe('ch.9.error', () => {}), /boom/);
	});
});

test('error responses reject the request', async (t) => {
	await withMock(t, async (state, client) => {
		await client.connect();
		await assert.rejects(client.get('ch.9.error'), /HTTP 500/);
	});
});

test('unanswered requests time out', async (t) => {
	await withMock(t, async (state, client) => {
		await client.connect();
		await assert.rejects(client.get('ch.9.timeout'), /timed out/);
	}, 100);
});

test('get/set throw when not connected', async (t) => {
	const state = await startMock();
	const client = new MixingStationClient({ host: '127.0.0.1', port: state.port, timeoutMs: 100 });
	t.after(() => {
		client.close();
		state.wss.close();
		state.http.close();
	});
	await assert.rejects(client.get('ch.0.mix.lvl'), /not connected/);
	await assert.rejects(client.set('ch.0.mix.lvl', 1), /not connected/);
});

test('reconnects and resubscribes after a disconnect', async (t) => {
	await withMock(t, async (state, client) => {
		await client.connect();
		const received: unknown[] = [];
		await client.subscribe('ch.*.mix.lvl', (value) => received.push(value));
		await waitFor(() => received.length >= 1);

		for (const socket of state.connections) socket.terminate();
		await waitFor(() => state.connections.length >= 2 && client.connected);
		push(state, 'ch.3.mix.lvl', -3);
		await waitFor(() => received.some((value) => value === -3));
	});
});
