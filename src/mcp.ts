import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createConsentLedger } from '@pooriaarab/vibe-core';
import {
  createMeteringLedger,
  defaultDataDir,
  DONATE_COMPUTE_SCOPE,
  evaluateCapacity,
  fileConsentStore,
  fileMeteringStore,
  isSharingActive,
  loadConfigFromFile,
  resolveCompute,
  type ComputeResolution,
  type ConsentLedger,
  type DonationConfig,
  type MeteringLedger,
} from './index.js';

export interface McpServerDeps {
  getConfig(): DonationConfig | null;
  getLedger(): MeteringLedger;
  getConsent(): ConsentLedger;
  now(): Date;
  systemBusy(): boolean;
  resolveLocal(): Promise<ComputeResolution>;
}
export interface McpServerHooks { readonly name?: string; readonly version?: string; }

const SERVER_VERSION: string = (() => {
  try { return (createRequire(import.meta.url)('../package.json') as { version?: string }).version ?? '0.0.0'; } catch { return '0.0.0'; }
})();

function jsonContent(obj: unknown) {
  return { isError: false as const, content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] };
}

async function handleStatus(deps: McpServerDeps) {
  const now = deps.now();
  const config = deps.getConfig();
  const compute = await deps.resolveLocal();
  if (config === null) return jsonContent({ armed: false, sharing: false, compute: { available: compute.available, label: compute.label }, reason: 'not configured — run `vibedonate share`' });
  const ledger = deps.getLedger();
  const totals = ledger.totals(now);
  const consent = deps.getConsent().allows(DONATE_COMPUTE_SCOPE);
  const sharing = consent && isSharingActive(config, now, deps.systemBusy(), totals.donatedToday);
  return jsonContent({ armed: config.enabled, consentGranted: consent, tier: config.tier, idle: `${config.idle.start}-${config.idle.end}`, cap: config.cap, pool: config.pool, compute: { available: compute.available, label: compute.label, egress: compute.egress }, sharing, totals, now: now.toISOString() });
}

async function handleRequestCapacity(deps: McpServerDeps, peer: string, tokens: number) {
  const now = deps.now();
  const config = deps.getConfig();
  const compute = await deps.resolveLocal();
  const respond = (decision: 'allow' | 'deny', reason: string, extra: Record<string, unknown> = {}) => jsonContent({ decision, peer, tokens, reason, ...extra });
  if (config === null) return respond('deny', 'not configured — run `vibedonate share`');
  const consent = deps.getConsent();
  const ledger = deps.getLedger();
  const totals = ledger.totals(now);
  const verdict = evaluateCapacity({ config, consent, peer, tokens, ctx: { now, systemBusy: deps.systemBusy(), donatedToday: totals.donatedToday, localAvailable: compute.available } });
  if (verdict.decision === 'deny') return respond('deny', verdict.reason, { compute: { available: compute.available, label: compute.label } });
  const remainingAfter = config.cap - totals.donatedToday - tokens;
  return respond('allow', verdict.reason, { compute: { available: compute.available, label: compute.label, egress: compute.egress }, remainingAfter });
}

function registerStatusTool(server: McpServer, deps: McpServerDeps): void {
  server.registerTool('status', { title: 'Donation status', description: 'Report the current vibedonate config, the resolved on-device model, metering totals, and whether the node is sharing capacity right now.' }, async () => handleStatus(deps));
}

function registerRequestCapacityTool(server: McpServer, deps: McpServerDeps): void {
  server.registerTool('request_capacity', { title: 'Request donated capacity', description: 'Pre-flight: ask whether this node can serve `tokens` for `peer`. Checks consent, peer auth, compute, idle window, local activity, and daily cap.', inputSchema: { peer: z.string().min(1).describe('The requesting peer id.'), tokens: z.number().int().positive().describe('Tokens requested.') } }, async ({ peer, tokens }) => handleRequestCapacity(deps, peer, tokens));
}

export function createMcpServer(deps: McpServerDeps, hooks: McpServerHooks = {}): McpServer {
  const server = new McpServer({ name: hooks.name ?? 'vibedonate', version: hooks.version ?? SERVER_VERSION });
  registerStatusTool(server, deps);
  registerRequestCapacityTool(server, deps);
  return server;
}

export async function runMcpServer(dir: string = defaultDataDir()): Promise<void> {
  const deps: McpServerDeps = {
    getConfig: () => loadConfigFromFile(dir),
    getLedger: () => createMeteringLedger(fileMeteringStore(dir)),
    getConsent: () => createConsentLedger(fileConsentStore(dir)),
    now: () => new Date(),
    systemBusy: () => false,
    resolveLocal: () => resolveCompute(),
  };
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.on('end', () => resolve());
    process.stdin.on('close', () => resolve());
  });
}
