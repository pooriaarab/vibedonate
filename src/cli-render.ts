import type { DonationConfig } from './donation-config.js';
import type { ComputeResolution } from './compute.js';
import type { PaymentRecord, PaymentTotals } from './payment.js';

export const VERSION = '0.4.1';
export const BADGE = '\u25CF your machine \u00B7 opt-in';

export const HELP = `vibedonate ${VERSION} — donate spare local compute across agentic CLIs.

USAGE
  vibedonate share --compute --idle <HH:MM-HH:MM> --cap <n|2M> --pool <pool> [--price <usdc>]
  vibedonate request "<prompt>" --pool <pool> [--handle <peer>] [--timeout <ms>] [--pay <usdc>]
  vibedonate status
  vibedonate stop
  vibedonate wallet
  vibedonate mcp
  vibedonate --version | --help

COMMANDS
  share    Arm donation AND join the live mesh as a donor (consent-gated).
  status   Show config, metering totals, the resolved local model, and whether sharing right now.
  stop     Disable donation (revokes the donate:compute consent grant).
  wallet   Show your x402 wallet address + a hash-chained ledger of payments.
  mcp      Run the MCP server over stdio (tools: status, request_capacity).
`;

function poolDesc(pool: DonationConfig['pool']): string {
  switch (pool.kind) {
    case 'open': return 'open pool';
    case 'org': return `org:${pool.id} (${pool.members.length} member${pool.members.length === 1 ? '' : 's'})`;
    case 'allowlist': return `allowlist [${pool.peers.join(', ')}]`;
  }
}

export interface RenderStatusOpts {
  readonly config: DonationConfig | null;
  readonly donatedToday: number;
  readonly totals: { donated: number; received: number; count: number };
  readonly sharing: boolean;
  readonly now: Date;
  readonly localModel?: ComputeResolution | null;
}

function renderStatusInternal(opts: RenderStatusOpts): string {
  const { config, donatedToday, totals, sharing, now, localModel } = opts;
  if (config === null) return 'vibedonate is not armed. Run `vibedonate share ...` to start.\n';
  const lines: string[] = [];
  lines.push(`vibedonate — ${config.enabled ? 'enabled' : 'stopped'} \u00B7 ${BADGE}`);
  lines.push(`  tier:     ${config.tier}`);
  lines.push(`  idle:     ${config.idle.start}-${config.idle.end} (UTC)`);
  lines.push(`  cap:      ${config.cap.toLocaleString('en-US')} tokens/day`);
  lines.push(`  pool:     ${poolDesc(config.pool)}`);
  if (localModel) lines.push(`  compute:  ${localModel.label}${localModel.available ? '' : ' \u26A0 not usable'}`);
  lines.push(`  usage:    donated ${totals.donated.toLocaleString('en-US')} (today ${donatedToday.toLocaleString('en-US')}) \u00B7 received ${totals.received.toLocaleString('en-US')} \u00B7 ${totals.count} receipt(s)`);
  lines.push(`  sharing:  ${sharing ? 'yes' : 'no'} (now ${now.toISOString()})`);
  return `${lines.join('\n')}\n`;
}

export function renderStatus(opts: RenderStatusOpts): string {
  return renderStatusInternal(opts);
}

export function renderWallet(address: string, totals: PaymentTotals, records: readonly PaymentRecord[], chain?: string): string {
  const lines: string[] = [];
  lines.push(`vibedonate wallet — ${address}${chain !== undefined ? ` (${chain})` : ''}`);
  lines.push(`  payments: received ${totals.received} USDC \u00B7 sent ${totals.sent} USDC \u00B7 ${totals.count} record(s)`);
  if (records.length === 0) lines.push('  (no payments yet \u2014 priced jobs record here once served/paid)');
  else for (const r of records) {
    const arrow = r.direction === 'received' ? '\u2190' : '\u2192';
    lines.push(`  #${r.seq} ${r.ts}  ${arrow} ${r.peer}  ${r.amountUsdc} USDC  ${r.txRef}`);
  }
  return `${lines.join('\n')}\n`;
}
