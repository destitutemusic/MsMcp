import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { ConsoleGateway } from './gateway.js';
import type { CommandDefinition, JsonObject, ValueType } from './mapping.js';

function zodFor(type: ValueType, values: string[], min?: number, max?: number): z.ZodTypeAny {
  if (type === 'string') return z.string();
  if (type === 'enum') return z.enum(values as [string, ...string[]]);
  if (type === 'integer') {
    let schema = z.number().int();
    if (min !== undefined) schema = schema.min(min);
    if (max !== undefined) schema = schema.max(max);
    return schema;
  }
  if (type === 'number') {
    let schema = z.number();
    if (min !== undefined) schema = schema.min(min);
    if (max !== undefined) schema = schema.max(max);
    return schema;
  }
  if (type === 'boolean' || type === 'trigger') return z.boolean();
  let schema = z.array(z.number().int().min(0).max(255));
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return schema;
}

function inputSchema(definition: CommandDefinition): z.ZodObject<any> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const argument of definition.arguments) shape[argument.name] = zodFor(argument.type, argument.values, argument.min, argument.max);
  if (definition.value !== undefined && definition.kind !== 'get') {
    shape.value = zodFor(definition.value.type, definition.value.values, definition.value.min, definition.value.max);
  }
  return z.object(shape).strict();
}

const emptySchema = (): z.ZodObject<any> => z.object({}).strict();
const objectSchema = (): z.ZodRecord => z.record(z.string(), z.unknown());

function success(value: unknown): { content: [{ type: 'text'; text: string }]; structuredContent: JsonObject } {
  const structuredContent: JsonObject = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject : { items: value };
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent };
}

function failure(error: unknown): { content: [{ type: 'text'; text: string }]; isError: true } {
  return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
}

function safe<T>(operation: () => Promise<T>): Promise<ReturnType<typeof success> | ReturnType<typeof failure>> {
  return operation().then(success).catch(failure);
}

export function createServer(gateway: ConsoleGateway): McpServer {
  const server = new McpServer(
    { name: 'ConsoleMCP', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true }, resources: { listChanged: true } } },
  );

  server.registerTool('console.list_commands', {
    description: 'List the mapped commands for the selected console.',
    inputSchema: emptySchema(),
  }, async () => safe(async () => gateway.catalog.commandsJson()));

  server.registerTool('console.call', {
    description: 'Invoke a mapped console command by id.',
    inputSchema: z.object({ command: z.string(), arguments: objectSchema() }).strict(),
  }, async (input) => safe(async () => gateway.execute(input.command, input.arguments as JsonObject)));

  server.registerTool('console.batch', {
    description: 'Invoke up to 128 mapped console commands in order.',
    inputSchema: z.object({
      calls: z.array(z.object({ command: z.string(), arguments: objectSchema() }).strict()).min(1).max(128),
    }).strict(),
  }, async (input) => safe(async () => gateway.batch(input.calls)));

  server.registerTool('console.snapshot', {
    description: "Read the profile's configured snapshot commands.",
    inputSchema: emptySchema(),
  }, async () => safe(async () => gateway.snapshot()));

  server.registerTool('console.restore', {
    description: 'Restore values from a console.snapshot result.',
    inputSchema: z.object({ entries: z.array(objectSchema()).min(1).max(128) }).strict(),
  }, async (input) => safe(async () => gateway.restore(input)));

  server.registerTool('console.raw_osc', {
    description: 'Send explicitly typed raw OSC when enabled at startup.',
    inputSchema: z.object({ address: z.string(), arguments: z.array(z.unknown()).max(64) }).strict(),
  }, async (input) => safe(async () => gateway.rawOsc(input)));

  for (const definition of gateway.catalog.profile.commands) {
    server.registerTool(`console.${definition.id}`, {
      description: definition.description,
      inputSchema: inputSchema(definition),
    }, async (input) => safe(async () => gateway.execute(definition.id, input as JsonObject)));
  }

  server.registerResource('console-profile', 'console://profile', {
    description: 'The active user-editable mapping profile.',
    mimeType: 'application/json',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({
    schemaVersion: gateway.catalog.profile.schemaVersion,
    id: gateway.catalog.profile.id,
    name: gateway.catalog.profile.name,
    transport: gateway.catalog.profile.transport,
    commands: gateway.catalog.commandsJson(),
  }) }] }));

  server.registerResource('console-commands', 'console://commands', {
    description: 'All commands exposed by the active mapping profile.',
    mimeType: 'application/json',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(gateway.catalog.commandsJson()) }] }));

  return server;
}

export async function runStdioServer(gateway: ConsoleGateway): Promise<void> {
  const server = createServer(gateway);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
