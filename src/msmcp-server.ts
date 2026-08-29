import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import type { DiscoveredParameter } from './discovery.js';
import type { MsMcpGateway } from './msmcp-gateway.js';

/** Result envelope returned by every tool handler: success content or a failure flag. */
export type ToolResult =
	| { content: [{ type: 'text'; text: string }]; structuredContent: unknown }
	| { content: [{ type: 'text'; text: string }]; isError: true };

function success(value: unknown): ToolResult {
	const structuredContent = typeof value === 'object' && value !== null && !Array.isArray(value)
		? value : { items: value };
	return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent };
}

function failure(error: unknown): ToolResult {
	return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
}

function safe<T>(operation: () => Promise<T>): Promise<ToolResult> {
	return operation().then(success).catch(failure);
}

/** Fails fast on a path that was not discovered on the connected mixer. */
function requireParameter(gateway: MsMcpGateway, path: string): DiscoveredParameter {
	const parameter = gateway.getParameter(path);
	if (!parameter) throw new Error(`unknown parameter path: ${path}`);
	return parameter;
}

function valueSchema(parameter: DiscoveredParameter): z.ZodObject<any> {
	if (parameter.type === 'bool') return z.object({ value: z.boolean() }).strict();
	if (parameter.type === 'string' || parameter.type === 'enum') return z.object({ value: z.string() }).strict();
	if (parameter.type === 'int') return z.object({ value: z.number().int() }).strict();
	return z.object({ value: z.number() }).strict();
}

function toolDescription(parameter: DiscoveredParameter, verb: string): string {
	return `${verb} ${parameter.label}${parameter.unit ? ` (${parameter.unit})` : ''} — Mixing Station path ${parameter.path}`;
}

/**
 * MCP adapter over MsMcpGateway. Six fixed tools (list/get/set/batch/
 * subscribe/unsubscribe) plus one generated pair of tools per discovered
 * parameter in a flat namespace: mixer.ch.0.mix.lvl.get / .set.
 */
export function createMsMcpServer(gateway: MsMcpGateway): McpServer {
	const server = new McpServer(
		{ name: 'MsMcp', version: '0.1.0' },
		{ capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } },
	);

	server.registerTool('mixer.list_parameters', {
		description: 'List all discovered mixer parameters as JSON.',
		inputSchema: z.object({}).strict(),
	}, async () => safe(async () => gateway.getParameters()));

	server.registerTool('mixer.get', {
		description: 'Read a parameter value by Mixing Station path (e.g. ch.0.mix.lvl).',
		inputSchema: z.object({ path: z.string() }).strict(),
	}, async (input) => safe(async () => {
		requireParameter(gateway, input.path);
		return gateway.get(input.path);
	}));

	server.registerTool('mixer.set', {
		description: 'Write a parameter value by Mixing Station path (e.g. ch.0.mix.lvl).',
		inputSchema: z.object({ path: z.string(), value: z.unknown() }).strict(),
	}, async (input) => safe(async () => {
		requireParameter(gateway, input.path);
		return gateway.set(input.path, input.value);
	}));

	server.registerTool('mixer.batch', {
		description: 'Set up to 128 parameter values in order.',
		inputSchema: z.object({
			calls: z.array(z.object({ path: z.string(), value: z.unknown() }).strict()).min(1).max(128),
		}).strict(),
	}, async (input) => safe(async () => {
		for (const call of input.calls) requireParameter(gateway, call.path);
		return gateway.batch(input.calls);
	}));

	server.registerTool('mixer.subscribe', {
		description: 'Subscribe to value updates for a parameter path or pattern (e.g. ch.*.mix.lvl).',
		inputSchema: z.object({ path: z.string() }).strict(),
	}, async (input) => safe(async () => {
		await gateway.subscribe(input.path, () => {});
		return { path: input.path, subscribed: true };
	}));

	server.registerTool('mixer.unsubscribe', {
		description: 'Stop receiving updates for a parameter path or pattern.',
		inputSchema: z.object({ path: z.string() }).strict(),
	}, async (input) => safe(async () => {
		gateway.unsubscribe(input.path);
		return { path: input.path, unsubscribed: true };
	}));
	server.registerTool('mixer.scene.list', {
		description: 'List all Mixing Station scenes with their index and name.',
		inputSchema: z.object({}).strict(),
	}, async () => safe(async () => gateway.listScenes()));

	server.registerTool('mixer.scene.get_current', {
		description: 'Read the currently active Mixing Station scene index.',
		inputSchema: z.object({}).strict(),
	}, async () => safe(async () => gateway.getCurrentScene()));

	server.registerTool('mixer.scene.recall', {
		description: 'Recall a Mixing Station scene by index; the mixer applies the change asynchronously.',
		inputSchema: z.object({ index: z.number().int().min(0) }).strict(),
	}, async (input) => safe(async () => gateway.recallScene(input.index)));

	for (const parameter of gateway.getParameters()) {
		if (parameter.canGet) {
			server.registerTool(`mixer.${parameter.path}.get`, {
				description: toolDescription(parameter, 'Read'),
				inputSchema: z.object({}).strict(),
			}, async () => safe(async () => gateway.get(parameter.path)));
		}
		if (parameter.canSet) {
			server.registerTool(`mixer.${parameter.path}.set`, {
				description: toolDescription(parameter, 'Write'),
				inputSchema: valueSchema(parameter),
			}, async (input) => safe(async () => {
				// The generated set schema always carries exactly one 'value' key
				// (valueSchema above), but the SDK types dynamic schemas' handler
				// input as unknown, so narrow it once here.
				const args = input as { value: unknown };
				return gateway.set(parameter.path, args.value);
			}));
		}
	}

	server.registerResource('mixer-parameters', 'mixer://parameters', {
		description: 'All parameters discovered on the connected Mixing Station mixer.',
		mimeType: 'application/json',
	}, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(gateway.getParameters()) }] }));

	server.registerResource('mixer-status', 'mixer://status', {
		description: 'Mixing Station connection status.',
		mimeType: 'application/json',
	}, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ connected: gateway.connected, url: gateway.url }) }] }));

	return server;
}

/**
 * Serves MsMcp over stdio. `server.connect()` resolves as soon as the
 * transport starts, not when the session ends, so `onClose` is wired to the
 * transport's close event: it runs when the MCP session ends (stdin EOF).
 */
export async function runMsMcpServer(gateway: MsMcpGateway, onClose?: () => void): Promise<void> {
	const server = createMsMcpServer(gateway);
	const transport = new StdioServerTransport();
	if (onClose) {
		const previous = transport.onclose;
		transport.onclose = () => {
			previous?.();
			onClose();
		};
	}
	await server.connect(transport);
}
