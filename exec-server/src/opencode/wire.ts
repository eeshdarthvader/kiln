import { randomBytes } from 'node:crypto';
import type { Provider } from '../shared/types.ts';

export type Wire = Record<string, unknown>;
export function object(value: unknown): Wire {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Unexpected OpenCode response object.');
  return value as Wire;
}
export function list(value: unknown): Wire[] {
  if (!Array.isArray(value)) throw new Error('Unexpected OpenCode response list.');
  return value.map(object);
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Unexpected OpenCode response string.');
  return value;
}
let identifierTimestamp = 0;
let identifierCounter = 0;
export function wireMessageId(commandId: string): string {
  const now = Date.now();
  identifierCounter = now === identifierTimestamp ? identifierCounter + 1 : 1;
  identifierTimestamp = now;
  const prefix = ((BigInt(now) << 12n) + BigInt(identifierCounter))
    .toString(16)
    .padStart(12, '0')
    .slice(-12);
  return `msg_${prefix}${randomBytes(7).toString('hex')}_sawd_${Buffer.from(`${commandId}:message`).toString('hex')}`;
}
export function data(value: unknown): Wire {
  return object(object(value).data);
}
export function dataList(value: unknown): Wire[] {
  return list(object(value).data);
}
export function identifier(value: unknown, prefix: 'ses' | 'msg_'): string {
  const id = text(value);
  if (!id.startsWith(prefix)) throw new Error('Unexpected OpenCode identifier.');
  return id;
}
export function discovery(providersValue: unknown, modelsValue: unknown): Provider[] {
  const models = dataList(modelsValue).flatMap((model) => {
    const capabilities = object(model.capabilities);
    if (
      typeof model.enabled !== 'boolean' ||
      typeof capabilities.tools !== 'boolean' ||
      !Array.isArray(capabilities.input) ||
      capabilities.input.some((value) => typeof value !== 'string') ||
      !Array.isArray(capabilities.output) ||
      capabilities.output.some((value) => typeof value !== 'string')
    )
      throw new Error('Unexpected OpenCode model capabilities.');
    if (
      !model.enabled ||
      !capabilities.tools ||
      !capabilities.input.includes('text') ||
      !capabilities.output.includes('text')
    )
      return [];
    return [{ providerID: text(model.providerID), id: text(model.id), name: text(model.name) }];
  });
  return dataList(providersValue)
    .filter((provider) => {
      if (!['auto', 'enabled', 'disabled'].includes(text(provider.activation)))
        throw new Error('Unexpected OpenCode provider activation.');
      return provider.activation !== 'disabled';
    })
    .map((provider) => ({
      id: text(provider.id),
      driver: 'opencode',
      name: text(provider.name),
      available: true,
      models: models
        .filter((model) => model.providerID === provider.id)
        .map(({ id, name }) => ({ id, name })),
    }));
}
