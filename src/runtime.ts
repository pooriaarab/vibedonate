import { createConsentLedger } from '@pooriaarab/vibe-core';
import { evaluateCapacity } from './capacity.js';
import { resolveCompute, type ComputeResolution } from './compute.js';
import type { DonationConfig } from './donation-config.js';
import type { ConsentLedger } from '@pooriaarab/vibe-core';
import type { MeteringLedger, UsageReceipt } from './metering.js';

export interface MeshRequest { readonly peer: string; readonly tokens: number; readonly model?: string; }
export interface MeshVerdict { readonly decision: 'allow' | 'deny'; readonly reason: string; readonly receipt?: UsageReceipt; }
export interface LocalMeshDeps {
  readonly config: () => DonationConfig;
  readonly consent: () => ConsentLedger;
  readonly ledger: () => MeteringLedger;
  readonly now: () => Date;
  readonly systemBusy: () => boolean;
  readonly resolveLocal?: () => Promise<ComputeResolution>;
}
export interface MeshRuntime { serve(req: MeshRequest): Promise<MeshVerdict>; }

export function createLocalMeshRuntime(deps: LocalMeshDeps): MeshRuntime {
  return {
    async serve(req) {
      if (!Number.isFinite(req.tokens) || req.tokens <= 0) return { decision: 'deny', reason: 'tokens must be a positive number' };
      const config = deps.config();
      const consent = deps.consent();
      const ledger = deps.ledger();
      const now = deps.now();
      const resolve = deps.resolveLocal ?? resolveCompute;
      const local = await resolve();
      const totals = ledger.totals(now);
      const verdict = evaluateCapacity({ config, consent, peer: req.peer, tokens: req.tokens, ctx: { now, systemBusy: deps.systemBusy(), donatedToday: totals.donatedToday, localAvailable: local.available } });
      if (verdict.decision === 'deny') return verdict;
      const receipt = ledger.record({ peer: req.peer, tokens: req.tokens, model: req.model ?? local.label, ts: now.toISOString(), direction: 'donated' });
      return { ...verdict, receipt };
    },
  };
}
