import { readFileSync, statSync } from 'node:fs';

import { MAX_OSC_PACKET_SIZE, type OscValue } from './osc.js';

export type JsonObject = Record<string, unknown>;

export type CommandKind = 'get' | 'set' | 'action';
export type ValueType = 'string' | 'integer' | 'number' | 'boolean' | 'enum' | 'trigger' | 'blob';

export interface Transform {
  scale: number;
  offset: number;
}

export interface ArgumentDefinition {
  name: string;
  type: Exclude<ValueType, 'trigger' | 'blob'>;
  width: number;
  min?: number;
  max?: number;
  values: string[];
}

export interface ValueDefinition {
  type: ValueType;
  oscType?: 'int' | 'float' | 'string' | 'bool' | 'nil' | 'blob';
  min?: number;
  max?: number;
  unit: string;
  /**
   * Index of the reply argument carrying this value. Consoles that answer a
   * query with several representations of the same parameter (the WING sends
   * display-string, normalised float, native float) need a non-zero index.
   */
  replyIndex: number;
  values: string[];
  transform?: Transform;
}

export interface CommandDefinition {
  id: string;
  description: string;
  group: string;
  kind: CommandKind;
  arguments: ArgumentDefinition[];
  value?: ValueDefinition;
  // `reply` is the address the answer is expected on, when it differs from the
  // one queried: DiGiCo asks by appending '/?' but answers on the bare address.
  // Defaults to `get` when absent.
  osc: { get?: string; set?: string; action?: string; reply?: string };
  snapshot: boolean;
}

export interface SnapshotEntry {
  command: string;
  arguments: JsonObject;
}

export interface TransportSettings {
  host: string;
  port: number;
  timeoutMs: number;
  rateLimitPerSecond: number;
}

export interface MappingProfile {
  schemaVersion: 1;
  id: string;
  name: string;
  transport: TransportSettings;
  snapshotCommands: SnapshotEntry[];
  commands: CommandDefinition[];
}

const MAX_COMMANDS = 4096;
const MAX_ARGUMENTS = 64;
const MAX_ENUM_VALUES = 256;
const MAX_PROFILE_SIZE = 8 * 1024 * 1024;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown, context: string): JsonObject {
  if (!isObject(value)) throw new Error(`${context} must be an object`);
  return value;
}

function required(value: JsonObject, name: string, context: string): unknown {
  if (!(name in value)) throw new Error(`${context} is missing '${name}'`);
  return value[name];
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error(`${context} must be a string`);
  return value;
}

function requiredString(value: JsonObject, name: string, context: string): string {
  return stringValue(required(value, name, context), `${context}.${name}`);
}

function numberValue(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${context} must be finite numeric`);
  return value;
}

function optionalNumber(value: JsonObject, name: string, context: string): number | undefined {
  if (!(name in value)) return undefined;
  return numberValue(value[name], `${context}.${name}`);
}

function optionalBoolean(value: JsonObject, name: string, fallback: boolean, context: string): boolean {
  if (!(name in value)) return fallback;
  if (typeof value[name] !== 'boolean') throw new Error(`${context}.${name} must be boolean`);
  return value[name] as boolean;
}

function parseType(value: string, context: string): ValueType {
  if (value === 'string' || value === 'integer' || value === 'number' || value === 'float'
      || value === 'boolean' || value === 'bool' || value === 'enum' || value === 'trigger' || value === 'blob') {
    return value === 'float' ? 'number' : value === 'bool' ? 'boolean' : value;
  }
  throw new Error(`${context} has unsupported type '${value}'`);
}

function parseEnumValues(value: JsonObject, context: string): string[] {
  const raw = required(value, 'values', context);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ENUM_VALUES) {
    throw new Error(`${context}.values must be a non-empty array of at most ${MAX_ENUM_VALUES} items`);
  }
  const result = raw.map((item, index) => stringValue(item, `${context}.values[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${context}.values contains a duplicate`);
  return result;
}

function validateRange(min: number | undefined, max: number | undefined, context: string): void {
  if (min !== undefined && max !== undefined && min > max) throw new Error(`${context} has min greater than max`);
}

function parseArgument(value: unknown, context: string): ArgumentDefinition {
  const object = objectValue(value, context);
  const name = requiredString(object, 'name', context);
  if (name.length === 0) throw new Error(`${context}.name must not be empty`);
  const type = parseType(requiredString(object, 'type', context), context);
  if (type === 'trigger' || type === 'blob') throw new Error(`${context} arguments cannot be trigger or blob`);
  const widthValue = object.width;
  const width = widthValue === undefined ? 0 : numberValue(widthValue, `${context}.width`);
  if (!Number.isInteger(width) || width < 0 || width > 8) throw new Error(`${context}.width must be an integer from 0 to 8`);
  if (width !== 0 && type !== 'integer') throw new Error(`${context}.width is only valid for integer arguments`);
  const min = optionalNumber(object, 'min', context);
  const max = optionalNumber(object, 'max', context);
  validateRange(min, max, context);
  return { name, type, width, min, max, values: type === 'enum' ? parseEnumValues(object, context) : [] };
}

function parseValue(value: unknown, context: string): ValueDefinition {
  const object = objectValue(value, context);
  const type = parseType(requiredString(object, 'type', context), context);
  const min = optionalNumber(object, 'min', context);
  const max = optionalNumber(object, 'max', context);
  validateRange(min, max, context);
  const oscTypeValue = object.oscType;
  const allowedOscTypes = ['int', 'float', 'string', 'bool', 'nil', 'blob'] as const;
  let oscType: ValueDefinition['oscType'];
  if (oscTypeValue !== undefined) {
    const parsed = stringValue(oscTypeValue, `${context}.oscType`);
    if (!(allowedOscTypes as readonly string[]).includes(parsed)) throw new Error(`${context}.oscType is unsupported`);
    oscType = parsed as ValueDefinition['oscType'];
  }
  const unit = object.unit === undefined ? '' : stringValue(object.unit, `${context}.unit`);
  let replyIndex = 0;
  if (object.replyIndex !== undefined) {
    const parsed = object.replyIndex;
    if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 0 || parsed > 15) {
      throw new Error(`${context}.replyIndex must be an integer from 0 to 15`);
    }
    replyIndex = parsed;
  }
  let transform: Transform | undefined;
  if (object.transform !== undefined) {
    const transformObject = objectValue(object.transform, `${context}.transform`);
    const scale = transformObject.scale === undefined ? 1 : numberValue(transformObject.scale, `${context}.transform.scale`);
    const offset = transformObject.offset === undefined ? 0 : numberValue(transformObject.offset, `${context}.transform.offset`);
    if (scale === 0) throw new Error(`${context}.transform.scale must not be zero`);
    transform = { scale, offset };
  }
  return {
    type,
    oscType,
    min,
    max,
    unit,
    replyIndex,
    values: type === 'enum' ? parseEnumValues(object, context) : [],
    transform,
  };
}

function parseKind(value: string, context: string): CommandKind {
  if (value === 'get' || value === 'set' || value === 'action') return value;
  throw new Error(`${context} has unsupported kind '${value}'`);
}

function validateTemplate(address: string, argumentsList: ArgumentDefinition[], context: string): void {
  if (!address.startsWith('/')) throw new Error(`${context} must start with '/'`);
  const names = new Set(argumentsList.map((argument) => argument.name));
  let cursor = 0;
  while (cursor < address.length) {
    const open = address.indexOf('{', cursor);
    const close = address.indexOf('}', cursor);
    if (close >= 0 && (open < 0 || close < open)) throw new Error(`${context} has an unmatched '}'`);
    if (open < 0) break;
    if (close < 0) throw new Error(`${context} has an unmatched '{'`);
    const name = address.slice(open + 1, close);
    if (name.length === 0 || !names.has(name)) throw new Error(`${context} references an undeclared argument`);
    cursor = close + 1;
  }
}

function parseCommand(value: unknown, index: number): CommandDefinition {
  const context = `commands[${index}]`;
  const object = objectValue(value, context);
  const id = requiredString(object, 'id', context);
  if (id.length === 0 || id.length > 128) throw new Error(`${context}.id must be 1-128 characters`);
  const description = requiredString(object, 'description', context);
  const group = object.group === undefined ? '' : stringValue(object.group, `${context}.group`);
  const kind = parseKind(requiredString(object, 'kind', context), `${context}.kind`);
  const rawArguments = object.arguments;
  const argumentsList: ArgumentDefinition[] = [];
  if (rawArguments !== undefined) {
    if (!Array.isArray(rawArguments) || rawArguments.length > MAX_ARGUMENTS) {
      throw new Error(`${context}.arguments must be an array of at most ${MAX_ARGUMENTS} items`);
    }
    const names = new Set<string>();
    rawArguments.forEach((item, argumentIndex) => {
      const argument = parseArgument(item, `${context}.arguments[${argumentIndex}]`);
      if (names.has(argument.name)) throw new Error(`${context}.arguments contains a duplicate name`);
      names.add(argument.name);
      argumentsList.push(argument);
    });
  }
  const valueDefinition = object.value === undefined ? undefined : parseValue(object.value, `${context}.value`);
  const oscObject = objectValue(required(object, 'osc', context), `${context}.osc`);
  const osc: CommandDefinition['osc'] = {};
  for (const operation of ['get', 'set', 'action', 'reply'] as const) {
    if (oscObject[operation] !== undefined) osc[operation] = stringValue(oscObject[operation], `${context}.osc.${operation}`);
  }
  if (osc.reply !== undefined && osc.get === undefined) throw new Error(`${context}.osc.reply requires osc.get`);
  if ((kind === 'get' && osc.get === undefined) || (kind === 'set' && osc.set === undefined)
      || (kind === 'action' && osc.action === undefined)) {
    throw new Error(`${context}.osc is missing the path required by kind`);
  }
  if (kind === 'set' && valueDefinition === undefined) throw new Error(`${context} set command requires a value definition`);
  for (const path of [osc.get, osc.set, osc.action, osc.reply]) {
    if (path !== undefined) validateTemplate(path, argumentsList, `${context}.osc`);
  }
  return { id, description, group, kind, arguments: argumentsList, value: valueDefinition,
    osc, snapshot: optionalBoolean(object, 'snapshot', false, context) };
}

function schemaFor(type: ValueType, values: string[], min?: number, max?: number): JsonObject {
  const schema: JsonObject = {};
  if (type === 'string' || type === 'enum') schema.type = 'string';
  else if (type === 'integer') schema.type = 'integer';
  else if (type === 'number') schema.type = 'number';
  else if (type === 'boolean' || type === 'trigger') schema.type = 'boolean';
  else {
    schema.type = 'array';
    schema.items = { type: 'integer', minimum: 0, maximum: 255 };
  }
  if (values.length > 0) schema.enum = values;
  if (min !== undefined) schema.minimum = min;
  if (max !== undefined) schema.maximum = max;
  return schema;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function validateTypedValue(value: unknown, type: ValueType, min: number | undefined, max: number | undefined,
                             values: string[], context: string): void {
  const matches = type === 'string' || type === 'enum' ? typeof value === 'string'
    : type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
    : type === 'number' ? numericValue(value) !== undefined
    : type === 'boolean' || type === 'trigger' ? typeof value === 'boolean'
    : Array.isArray(value);
  if (!matches) throw new Error(`${context} has the wrong type`);
  if (type === 'enum' && !values.includes(value as string)) throw new Error(`${context} is not an allowed enum value`);
  if (type === 'blob') {
    const bytes = value as unknown[];
    if (bytes.length > MAX_OSC_PACKET_SIZE) throw new Error(`${context} is too large`);
    if (bytes.some((item) => typeof item !== 'number' || !Number.isInteger(item) || item < 0 || item > 255)) {
      throw new Error(`${context} must contain bytes from 0 to 255`);
    }
  }
  if (min !== undefined || max !== undefined) {
    const number = numericValue(value);
    if (number === undefined || (min !== undefined && number < min) || (max !== undefined && number > max)) {
      throw new Error(`${context} is outside its allowed range`);
    }
  }
}

function formatAddressValue(value: unknown, name: string, definitions: ArgumentDefinition[]): string {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (definition === undefined || definition.width === 0) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
    throw new Error(`address argument '${name}' must be scalar`);
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`formatted address argument '${name}' must be an integer`);
  return String(value).padStart(definition.width, '0');
}

function int32Value(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new Error(`${context} must fit OSC int32`);
  }
  return value;
}

export class MappingCatalog {
  public readonly profile: MappingProfile;
  private readonly commandMap: ReadonlyMap<string, CommandDefinition>;

  private constructor(profile: MappingProfile) {
    this.profile = profile;
    this.commandMap = new Map(profile.commands.map((command) => [command.id, command]));
    for (const snapshot of profile.snapshotCommands) {
      const definition = this.command(snapshot.command);
      if (definition.osc.get === undefined) throw new Error(`snapshot command has no OSC get path: ${snapshot.command}`);
      MappingCatalog.validateArguments(definition, snapshot.arguments, false);
    }
  }

  public static fromFile(path: string): MappingCatalog {
    if (statSync(path).size > MAX_PROFILE_SIZE) throw new Error('mapping profile exceeds the 8 MiB limit');
    return MappingCatalog.fromObject(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  }

  public static fromObject(value: unknown): MappingCatalog {
    const object = objectValue(value, 'profile');
    if (object.schemaVersion !== 1) throw new Error('profile.schemaVersion must be 1');
    const id = requiredString(object, 'id', 'profile');
    const name = requiredString(object, 'name', 'profile');
    const transportObject = object.transport === undefined ? {} : objectValue(object.transport, 'profile.transport');
    const port = transportObject.port === undefined ? 10023 : numberValue(transportObject.port, 'profile.transport.port');
    const timeoutMs = transportObject.timeoutMs === undefined ? 250 : numberValue(transportObject.timeoutMs, 'profile.transport.timeoutMs');
    const rateLimitPerSecond = transportObject.rateLimitPerSecond === undefined ? 100 : numberValue(transportObject.rateLimitPerSecond, 'profile.transport.rateLimitPerSecond');
    const transport = {
      host: transportObject.host === undefined ? '127.0.0.1' : stringValue(transportObject.host, 'profile.transport.host'),
      port, timeoutMs, rateLimitPerSecond,
    };
    if (id.length === 0 || id.length > 128) throw new Error('profile.id must be 1-128 characters');
    if (transport.host.length === 0 || transport.host.length > 255) throw new Error('profile.transport.host must be 1-255 characters');
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('profile.transport.port must be between 1 and 65535');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 10_000) throw new Error('profile.transport.timeoutMs must be between 0 and 10000');
    if (!Number.isInteger(rateLimitPerSecond) || rateLimitPerSecond < 1 || rateLimitPerSecond > 10_000) throw new Error('profile.transport.rateLimitPerSecond must be between 1 and 10000');

    const rawCommands = required(object, 'commands', 'profile');
    if (!Array.isArray(rawCommands) || rawCommands.length === 0 || rawCommands.length > MAX_COMMANDS) {
      throw new Error(`profile.commands must be a non-empty array of at most ${MAX_COMMANDS} items`);
    }
    const commands = rawCommands.map(parseCommand);
    const ids = new Set<string>();
    for (const command of commands) {
      if (ids.has(command.id)) throw new Error(`profile.commands contains duplicate id '${command.id}'`);
      ids.add(command.id);
    }

    const snapshotCommands: SnapshotEntry[] = [];
    const rawSnapshots = object.snapshotCommands;
    if (rawSnapshots !== undefined) {
      if (!Array.isArray(rawSnapshots) || rawSnapshots.length > MAX_COMMANDS) throw new Error('profile.snapshotCommands is too large');
      rawSnapshots.forEach((item) => {
        if (typeof item === 'string') snapshotCommands.push({ command: item, arguments: {} });
        else {
          const snapshot = objectValue(item, 'profile.snapshotCommands[]');
          snapshotCommands.push({ command: requiredString(snapshot, 'command', 'profile.snapshotCommands[]'),
            arguments: snapshot.arguments === undefined ? {} : objectValue(snapshot.arguments, 'profile.snapshotCommands[].arguments') });
        }
      });
    }
    for (const command of commands) if (command.snapshot) snapshotCommands.push({ command: command.id, arguments: {} });
    return new MappingCatalog({ schemaVersion: 1, id, name, transport, snapshotCommands, commands });
  }

  public command(id: string): CommandDefinition {
    const definition = this.commandMap.get(id);
    if (definition === undefined) throw new Error(`unknown console command: ${id}`);
    return definition;
  }

  public overrideTransport(host?: string, port?: number): void {
    if (host !== undefined) {
      if (host.length === 0 || host.length > 255) throw new Error('OSC host must be 1-255 characters');
      this.profile.transport.host = host;
    }
    if (port !== undefined) {
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('OSC port must be between 1 and 65535');
      this.profile.transport.port = port;
    }
  }

  public commandsJson(): JsonObject[] {
    return this.profile.commands.map((definition) => ({ id: definition.id, description: definition.description,
      group: definition.group, kind: definition.kind, inputSchema: this.toolSchema(definition) }));
  }

  public toolSchema(definition: CommandDefinition): JsonObject {
    const properties: JsonObject = {};
    const requiredFields: string[] = [];
    for (const argument of definition.arguments) {
      properties[argument.name] = schemaFor(argument.type, argument.values, argument.min, argument.max);
      requiredFields.push(argument.name);
    }
    if (definition.value !== undefined) {
      properties.value = schemaFor(definition.value.type, definition.value.values, definition.value.min, definition.value.max);
      if (definition.kind !== 'get') requiredFields.push('value');
    }
    return { type: 'object', additionalProperties: false, properties, required: requiredFields };
  }

  public static expandAddress(address: string, argumentsObject: JsonObject, definitions: ArgumentDefinition[] = []): string {
    let result = '';
    let cursor = 0;
    while (cursor < address.length) {
      const open = address.indexOf('{', cursor);
      if (open < 0) { result += address.slice(cursor); break; }
      result += address.slice(cursor, open);
      const close = address.indexOf('}', open + 1);
      if (close < 0) throw new Error('OSC address template has an unmatched {');
      const name = address.slice(open + 1, close);
      if (!(name in argumentsObject)) throw new Error(`missing address argument: ${name}`);
      const replacement = formatAddressValue(argumentsObject[name], name, definitions);
      if (replacement.length === 0 || replacement.includes('{') || replacement.includes('}') || replacement.includes('\0')) {
        throw new Error(`invalid OSC address argument: ${name}`);
      }
      result += replacement;
      cursor = close + 1;
    }
    if (!result.startsWith('/') || result.length > 1024) throw new Error('expanded OSC address is invalid');
    return result;
  }

  public static validateArguments(definition: CommandDefinition, input: JsonObject, includeValue: boolean): void {
    for (const key of Object.keys(input)) {
      if (key === 'value' && includeValue) continue;
      if (!definition.arguments.some((argument) => argument.name === key)) {
        throw new Error(`unexpected argument '${key}' for command '${definition.id}'`);
      }
    }
    for (const argument of definition.arguments) {
      if (!(argument.name in input)) throw new Error(`missing argument '${argument.name}' for command '${definition.id}'`);
      validateTypedValue(input[argument.name], argument.type, argument.min, argument.max, argument.values, `argument '${argument.name}'`);
    }
    if (includeValue) {
      if (definition.value === undefined || !('value' in input)) throw new Error(`missing value for command '${definition.id}'`);
      validateTypedValue(input.value, definition.value.type, definition.value.min, definition.value.max, definition.value.values, 'value');
    } else if ('value' in input) {
      throw new Error(`command '${definition.id}' does not accept a value`);
    }
  }

  public static toOscValue(definition: ValueDefinition, value: unknown): OscValue {
    validateTypedValue(value, definition.type, definition.min, definition.max, definition.values, 'value');
    if (definition.oscType === 'int' || definition.oscType === 'float') {
      let number: number;
      if (definition.type === 'boolean') number = value as boolean ? 1 : 0;
      else if (definition.type === 'trigger') number = 1;
      else { number = value as number; if (definition.transform !== undefined) number = number * definition.transform.scale + definition.transform.offset; }
      if (definition.oscType === 'int') return { type: 'int', value: int32Value(number, 'transformed value') };
      if (!Number.isFinite(number) || Math.abs(number) > 3.4028235e38) throw new Error('transformed value does not fit OSC float');
      return { type: 'float', value: number };
    }
    if (definition.oscType === 'string') {
      if (definition.type !== 'string' && definition.type !== 'enum') throw new Error('string OSC type requires a string semantic value');
      return { type: 'string', value: value as string };
    }
    if (definition.oscType === 'bool') {
      if (definition.type !== 'boolean') throw new Error('bool OSC type requires a boolean semantic value');
      return { type: 'bool', value: value as boolean };
    }
    if (definition.oscType === 'nil') {
      if (definition.type !== 'trigger' || value !== true) throw new Error('nil OSC type requires a true trigger');
      return { type: 'nil' };
    }
    if (definition.oscType === 'blob' && definition.type !== 'blob') throw new Error('blob OSC type requires a blob value');
    if (definition.type === 'string' || definition.type === 'enum') return { type: 'string', value: value as string };
    if (definition.type === 'integer') {
      let number = int32Value(value, 'value');
      if (definition.transform !== undefined) number = definition.transform.scale * number + definition.transform.offset;
      return { type: 'int', value: int32Value(number, 'transformed value') };
    }
    if (definition.type === 'number') {
      let number = value as number;
      if (definition.transform !== undefined) number = definition.transform.scale * number + definition.transform.offset;
      if (!Number.isFinite(number) || Math.abs(number) > 3.4028235e38) throw new Error('transformed value does not fit OSC float');
      return { type: 'float', value: number };
    }
    if (definition.type === 'boolean') return { type: 'bool', value: value as boolean };
    if (definition.type === 'trigger') {
      if (value !== true) throw new Error('trigger value must be true');
      return { type: 'nil' };
    }
    return { type: 'blob', value: Uint8Array.from(value as number[]) };
  }

  public static fromOscValue(definition: ValueDefinition, value: OscValue): unknown {
    if (definition.type === 'trigger') return true;
    if (definition.type === 'blob') {
      if (value.type !== 'blob') throw new Error('OSC reply is not a blob');
      return [...value.value];
    }
    if (definition.type === 'string' || definition.type === 'enum') {
      if (value.type !== 'string') throw new Error('OSC reply is not a string');
      if (definition.type === 'enum' && !definition.values.includes(value.value)) throw new Error('OSC reply contains an unknown enum value');
      return value.value;
    }
    if (definition.type === 'boolean') {
      if (value.type === 'bool') return value.value;
      if (value.type === 'int') return value.value !== 0;
      if (value.type === 'float') return value.value !== 0;
      throw new Error('OSC reply is not boolean');
    }
    let number: number;
    if (value.type === 'int' || value.type === 'float') number = value.value;
    else throw new Error('OSC reply is not numeric');
    if (definition.transform !== undefined) number = (number - definition.transform.offset) / definition.transform.scale;
    if (!Number.isFinite(number)) throw new Error('OSC reply transform produced a non-finite value');
    if (definition.type === 'integer' && !Number.isInteger(number)) throw new Error('OSC reply is not an integer');
    return number;
  }
}
