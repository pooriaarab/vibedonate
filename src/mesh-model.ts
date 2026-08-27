import { randomBytes } from 'node:crypto';

export interface LocalModelResult { readonly output: string; readonly tokens: number; }
export interface LocalModel { readonly id: string; run(prompt: string): LocalModelResult; }
export const DEFAULT_JOB_TOKEN_COST = 100;
export function createEchoModel(cost: number = DEFAULT_JOB_TOKEN_COST): LocalModel {
  const tokens = Math.max(1, Math.floor(cost));
  return { id: 'echo-stub', run(prompt) { return { output: prompt.split('').reverse().join(''), tokens }; } };
}
export function randomTopic(): Buffer { return randomBytes(32); }
export function randomJobId(): string { return randomBytes(8).toString('hex'); }
export const SHARE_NOTICE = 'sharing compute on the mesh: announcing only your handle + pool + tier (never raw usage) to same-pool peers on the public DHT';
