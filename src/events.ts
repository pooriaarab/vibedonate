import { makeEvent, notify } from '@pooriaarab/vibe-core';
import type { AsyncHookBus, VibeEvent } from '@pooriaarab/vibe-core';
import type { DonationTier } from './donation-config.js';

export const VIBEDONATE_AGENT = 'vibedonate' as const;
export type DonationAction = 'share' | 'stop' | 'serve' | 'deny';
export interface DonationEventPayload { readonly action: DonationAction; readonly tier?: DonationTier; readonly peer?: string; readonly tokens?: number; readonly reason?: string; readonly [extra: string]: unknown; }
export interface PublishOptions { readonly cwd?: string; readonly file?: string; }
function toVibeEvent(action: DonationAction, cwd: string, payload?: Omit<DonationEventPayload, 'action'>): VibeEvent {
  const p: DonationEventPayload = { action, ...payload };
  return makeEvent('manual', VIBEDONATE_AGENT, cwd, p);
}
export function publishDonationEvent(action: DonationAction, payload?: Omit<DonationEventPayload, 'action'>, opts: PublishOptions = {}): void {
  const cwd = opts.cwd ?? process.cwd();
  try { notify(toVibeEvent(action, cwd, payload), opts.file !== undefined ? { file: opts.file } : undefined); } catch { }
}
export interface DonationHooksOptions { readonly cwd?: string; readonly file?: string; readonly onStop?: () => void; }
export interface DonationHooks { publish(action: DonationAction, payload?: Omit<DonationEventPayload, 'action'>): void; dispose(): void; }
export function createDonationHooks(bus: AsyncHookBus, options: DonationHooksOptions = {}): DonationHooks {
  const cwd = options.cwd ?? process.cwd();
  const onStop = options.onStop;
  let active = onStop !== undefined;
  if (onStop) bus.on('session-end', () => { if (active) onStop(); });
  return {
    publish(action, payload) {
      try { notify(toVibeEvent(action, cwd, payload), options.file !== undefined ? { file: options.file } : undefined); } catch { }
    },
    dispose() { active = false; },
  };
}
