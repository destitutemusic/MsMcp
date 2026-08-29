import { MappingCatalog, type CommandDefinition, type JsonObject, type ValueDefinition } from './mapping.js';
import { type OscMessage, type OscTransport, type OscValue } from './osc.js';

const MAX_BATCH_CALLS = 128;
const MAX_RAW_ARGUMENTS = 64;

function required(value: JsonObject, name: string, context: string): unknown {
  if (!(name in value)) throw new Error(`${context} is missing '${name}'`);
  return value[name];
}

function requiredString(value: JsonObject, name: string, context: string): string {
  const result = required(value, name, context);
  if (typeof result !== 'string') throw new Error(`${context}.${name} must be a string`);
  return result;
}

/**
 * Picks the reply argument a value definition refers to, clamped to what the
 * console actually sent so a short reply degrades to the last argument present.
 */
function replyArgument(definition: ValueDefinition, values: OscValue[]): OscValue {
  return values[Math.min(definition.replyIndex, values.length - 1)]!;
}

function jsonForOscValue(value: OscValue): unknown {
  if (value.type === 'nil') return null;
  if (value.type === 'blob') return [...value.value];
  return value.value;
}

function jsonForOscArguments(values: OscValue[]): unknown[] {
  return values.map(jsonForOscValue);
}

function rawInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new Error('raw OSC integer must fit signed int32');
  }
  return value;
}

function rawOscValue(value: unknown): OscValue {
  if (typeof value === 'boolean') return { type: 'bool', value };
  if (typeof value === 'number') return Number.isInteger(value) ? { type: 'int', value: rawInt(value) } : { type: 'float', value };
  if (typeof value === 'string') return { type: 'string', value };
  if (Array.isArray(value)) {
    if (value.some((item) => typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 255)) {
      throw new Error('raw OSC blob array must contain bytes from 0 to 255');
    }
    return { type: 'blob', value: Uint8Array.from(value as number[]) };
  }
  if (typeof value !== 'object' || value === null) throw new Error('raw OSC argument has unsupported JSON type');
  const object = value as JsonObject;
  const type = requiredString(object, 'type', 'raw OSC argument');
  const payload = required(object, 'value', 'raw OSC argument');
  if (type === 'int' || type === 'integer') return { type: 'int', value: rawInt(payload) };
  if (type === 'float' || type === 'number') {
    if (typeof payload !== 'number' || !Number.isFinite(payload)) throw new Error('raw OSC float must be finite numeric');
    return { type: 'float', value: payload };
  }
  if (type === 'string') {
    if (typeof payload !== 'string') throw new Error('raw OSC string value must be a string');
    return { type: 'string', value: payload };
  }
  if (type === 'bool' || type === 'boolean') {
    if (typeof payload !== 'boolean') throw new Error('raw OSC bool value must be boolean');
    return { type: 'bool', value: payload };
  }
  if (type === 'nil') return { type: 'nil' };
  if (type === 'blob') return rawOscValue(payload);
  throw new Error(`unsupported raw OSC type: ${type}`);
}

export class ConsoleGateway {
  private readonly sendTimes: number[] = [];

  public constructor(
    public readonly catalog: MappingCatalog,
    private readonly transport: OscTransport,
    private readonly allowRawOsc: boolean,
  ) {}

  /**
   * Paces sending rather than failing: a snapshot or restore is inherently a
   * burst, and aborting part-way through a restore would leave the console
   * half-written. Waiting keeps the per-second ceiling without that hazard.
   */
  private async consumeRateLimit(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.sendTimes.length > 0 && this.sendTimes[0]! <= now - 1000) this.sendTimes.shift();
      if (this.sendTimes.length < this.catalog.profile.transport.rateLimitPerSecond) {
        this.sendTimes.push(now);
        return;
      }
      const waitMs = this.sendTimes[0]! + 1000 - now;
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, waitMs)));
    }
  }

  private makeMessage(definition: CommandDefinition, input: JsonObject): OscMessage {
    const addressTemplate = definition.kind === 'get' ? definition.osc.get : definition.kind === 'set' ? definition.osc.set : definition.osc.action;
    if (addressTemplate === undefined) throw new Error('command has no OSC path for its operation');
    const address = MappingCatalog.expandAddress(addressTemplate, input, definition.arguments);
    const argumentsList: OscValue[] = [];
    if (definition.value !== undefined && 'value' in input) argumentsList.push(MappingCatalog.toOscValue(definition.value, input.value));
    return { address, arguments: argumentsList };
  }

  public async execute(commandId: string, input: JsonObject): Promise<JsonObject> {
    const definition = this.catalog.command(commandId);
    if (definition.kind === 'get') return await this.executeGet(definition, input);
    return await this.executeSetOrAction(definition, input);
  }

  private async executeGet(definition: CommandDefinition, input: JsonObject): Promise<JsonObject> {
    MappingCatalog.validateArguments(definition, input, false);
    const message = this.makeMessage(definition, input);
    const expected = definition.osc.reply === undefined
      ? message.address
      : MappingCatalog.expandAddress(definition.osc.reply, input, definition.arguments);
    await this.consumeRateLimit();
    const response = await this.transport.request(message, expected, this.catalog.profile.transport.timeoutMs);
    if (response === null) throw new Error(`OSC get timed out waiting for '${expected}'`);
    const result: JsonObject = { command: definition.id, address: response.address, arguments: jsonForOscArguments(response.arguments) };
    if (definition.value !== undefined) {
      if (response.arguments.length === 0) throw new Error(`OSC get reply contains no value for '${definition.id}'`);
      result.value = MappingCatalog.fromOscValue(definition.value, replyArgument(definition.value, response.arguments));
    }
    return result;
  }

  private async executeSetOrAction(definition: CommandDefinition, input: JsonObject): Promise<JsonObject> {
    MappingCatalog.validateArguments(definition, input, definition.value !== undefined);
    const message = this.makeMessage(definition, input);
    await this.consumeRateLimit();
    await this.transport.send(message);
    const result: JsonObject = { command: definition.id, address: message.address, sent: true,
      arguments: jsonForOscArguments(message.arguments) };
    if ('value' in input) result.value = input.value;
    return result;
  }

  public async batch(calls: unknown[]): Promise<unknown[]> {
    if (calls.length === 0 || calls.length > MAX_BATCH_CALLS) throw new Error('batch must contain 1-128 calls');
    const results: unknown[] = [];
    for (const item of calls) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('batch call must be an object');
      const object = item as JsonObject;
      const command = requiredString(object, 'command', 'batch call');
      const rawArguments = object.arguments;
      if (typeof rawArguments !== 'object' || rawArguments === null || Array.isArray(rawArguments)) throw new Error('batch call.arguments must be an object');
      results.push(await this.execute(command, rawArguments as JsonObject));
    }
    return results;
  }

  private async readForSnapshot(definition: CommandDefinition, argumentsObject: JsonObject): Promise<JsonObject> {
    if (definition.osc.get === undefined) throw new Error(`snapshot command has no OSC get path: ${definition.id}`);
    MappingCatalog.validateArguments(definition, argumentsObject, false);
    const address = MappingCatalog.expandAddress(definition.osc.get, argumentsObject, definition.arguments);
    const message: OscMessage = { address, arguments: [] };
    const expected = definition.osc.reply === undefined
      ? address
      : MappingCatalog.expandAddress(definition.osc.reply, argumentsObject, definition.arguments);
    await this.consumeRateLimit();
    const response = await this.transport.request(message, expected, this.catalog.profile.transport.timeoutMs);
    if (response === null) throw new Error(`OSC snapshot read timed out waiting for '${expected}'`);
    if (definition.value === undefined || response.arguments.length === 0) throw new Error(`snapshot command must return one mapped value: ${definition.id}`);
    return { command: definition.id, arguments: argumentsObject, value: MappingCatalog.fromOscValue(definition.value, replyArgument(definition.value, response.arguments)) };
  }

  public async snapshot(): Promise<JsonObject> {
    const entries: JsonObject[] = [];
    for (const configured of this.catalog.profile.snapshotCommands) {
      entries.push(await this.readForSnapshot(this.catalog.command(configured.command), configured.arguments));
    }
    return { profile: this.catalog.profile.id, entries };
  }

  public async restore(snapshot: JsonObject): Promise<JsonObject> {
    const entries = required(snapshot, 'entries', 'snapshot');
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_BATCH_CALLS) throw new Error('snapshot.entries must contain 1-128 entries');
    const applied: unknown[] = [];
    for (const item of entries) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('snapshot entry must be an object');
      const entry = item as JsonObject;
      const command = requiredString(entry, 'command', 'snapshot entry');
      const argumentsObject = required(entry, 'arguments', 'snapshot entry');
      if (typeof argumentsObject !== 'object' || argumentsObject === null || Array.isArray(argumentsObject)) throw new Error('snapshot entry.arguments must be an object');
      const definition = this.catalog.command(command);
      if (definition.kind !== 'set') throw new Error(`snapshot entry command is not a set command: ${command}`);
      applied.push(await this.execute(command, { ...(argumentsObject as JsonObject), value: required(entry, 'value', 'snapshot entry') }));
    }
    return { profile: this.catalog.profile.id, applied };
  }

  public async rawOsc(input: JsonObject): Promise<JsonObject> {
    if (!this.allowRawOsc) throw new Error('raw OSC is disabled; restart with --allow-raw-osc to enable it');
    const address = requiredString(input, 'address', 'raw OSC');
    if (!address.startsWith('/') || address.length > 1024) throw new Error('raw OSC address must start with / and be at most 1024 characters');
    const argumentsValue = required(input, 'arguments', 'raw OSC');
    if (!Array.isArray(argumentsValue) || argumentsValue.length > MAX_RAW_ARGUMENTS) throw new Error('raw OSC arguments must be an array of at most 64 items');
    const message: OscMessage = { address, arguments: argumentsValue.map(rawOscValue) };
    await this.consumeRateLimit();
    await this.transport.send(message);
    return { address, sent: true, arguments: jsonForOscArguments(message.arguments) };
  }
}
