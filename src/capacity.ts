import { authorizePeer, DONATE_COMPUTE_SCOPE, withinIdleWindow, type DonationConfig } from './donation-config.js';
import type { ConsentLedger } from '@pooriaarab/vibe-core';

export interface CapacityContext {
  readonly now: Date;
  readonly systemBusy: boolean;
  readonly donatedToday: number;
  readonly localAvailable: boolean;
}
export interface CapacityDecision { readonly decision: 'allow' | 'deny'; readonly reason: string; }
export interface EvaluateCapacityOpts {
  readonly config: DonationConfig;
  readonly consent: ConsentLedger;
  readonly peer: string;
  readonly tokens: number;
  readonly ctx: CapacityContext;
}

interface EvaluateInternalOpts { readonly config: DonationConfig; readonly consent: ConsentLedger; readonly peer: string; readonly tokens: number; readonly ctx: CapacityContext; }
function evaluateInternal(opts: EvaluateInternalOpts): CapacityDecision {
  const { config, consent, peer, tokens, ctx } = opts;
  if (!config.enabled) return { decision: 'deny', reason: 'donation is stopped' };
  if (!consent.allows(DONATE_COMPUTE_SCOPE)) return { decision: 'deny', reason: 'donate:compute consent not granted' };
  if (authorizePeer(config, peer) === 'deny') return { decision: 'deny', reason: `peer "${peer}" not authorized by the ${config.pool.kind} pool` };
  if (!ctx.localAvailable) return { decision: 'deny', reason: 'no local chat model available to serve' };
  if (ctx.systemBusy) return { decision: 'deny', reason: 'local activity in progress' };
  if (!withinIdleWindow(config.idle, ctx.now)) return { decision: 'deny', reason: `outside idle window ${config.idle.start}-${config.idle.end}` };
  if (ctx.donatedToday >= config.cap) return { decision: 'deny', reason: 'daily cap reached' };
  const remaining = config.cap - ctx.donatedToday;
  if (tokens > remaining) return { decision: 'deny', reason: `only ${remaining} tokens remain under the daily cap` };
  return { decision: 'allow', reason: `ok — ${remaining - tokens} tokens remain after` };
}

export function evaluateCapacity(opts: EvaluateCapacityOpts | DonationConfig, ...rest: unknown[]): CapacityDecision {
  if (rest.length > 0) {
    const config = opts as unknown as DonationConfig;
    const consent = rest[0] as ConsentLedger;
    const peer = rest[1] as string;
    const tokens = rest[2] as number;
    const ctx = rest[3] as CapacityContext;
    return evaluateInternal({ config, consent, peer, tokens, ctx });
  }
  const o = opts as EvaluateCapacityOpts;
  return evaluateInternal({ config: o.config, consent: o.consent, peer: o.peer, tokens: o.tokens, ctx: o.ctx });
}
