/**
 * vibedonate MCP server (stdio).
 *
 * Exposes two tools an agent (or any MCP client) can call:
 *   - `status`           — current config, metering totals, the resolved
 *                          on-device model, and whether the node is sharing
 *                          *right now*.
 *   - `request_capacity` — a pre-flight: "can you take `tokens` for `peer`?"
 *                          Returns allow/deny with a reason, gating on consent,
 *                          peer authorization, on-device compute availability,
 *                          the idle window, local activity, and the daily cap.
 *
 * `request_capacity` only *asks* — it does not record consumption. Recording
 * real usage (and the donor actually running inference for the peer) is the
 * runtime half of the mesh and lands after v0; the gate is the part you can
 * trust today. Both tools share one pure gate ({@link evaluateCapacity}) with
 * the library's mesh runtime, so the answer is identical everywhere.
 *
 * Dependency injection keeps the server deterministic: the config, ledger,
 * consent ledger, clock, "busy" signal, and compute resolver are all functions
 * the caller wires. {@link runMcpServer} wires them to the real file-backed
 * stores (and a real on-device probe) over stdio.
 */

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

/** Injected dependencies. All functions so the server stays side-effect-free. */
export interface McpServerDeps {
  /** Current config, or `null` if donation was never armed. */
  getConfig(): DonationConfig | null;
  getLedger(): MeteringLedger;
  getConsent(): ConsentLedger;
  now(): Date;
  /** True if local activity should pause donation. */
  systemBusy(): boolean;
  /** Resolve on-device compute (default {@link resolveCompute}). */
  resolveLocal(): Promise<ComputeResolution>;
}

export interface McpServerHooks {
  readonly name?: string;
  readonly version?: string;
}

const SERVER_VERSION = '0.2.0';

/**
 * Build the MCP server (no transport). Pure-ish: registers tools against the
 * injected deps. Returns the `McpServer` so a caller can `connect()` it to any
 * transport — used by tests and {@link runMcpServer}.
 */
export function createMcpServer(deps: McpServerDeps, hooks: McpServerHooks = {}): McpServer {
  const server = new McpServer({ name: hooks.name ?? 'vibedonate', version: hooks.version ?? SERVER_VERSION });

  server.registerTool(
    'status',
    {
      title: 'Donation status',
      description:
        'Report the current vibedonate config, the resolved on-device model, metering totals (donated / donatedToday / received), and whether the node is sharing capacity right now.',
    },
    async () => {
      const now = deps.now();
      const config = deps.getConfig();
      const ledger = deps.getLedger();
      const compute = await deps.resolveLocal();
      if (config === null) {
        return {
          isError: false,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  armed: false,
                  sharing: false,
                  compute: { available: compute.available, label: compute.label },
                  reason: 'not configured — run `vibedonate share`',
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const totals = ledger.totals(now);
      const consent = deps.getConsent().allows(DONATE_COMPUTE_SCOPE);
      const sharing = consent && isSharingActive(config, now, deps.systemBusy(), totals.donatedToday);
      return {
        isError: false,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                armed: config.enabled,
                consentGranted: consent,
                tier: config.tier,
                idle: `${config.idle.start}-${config.idle.end}`,
                cap: config.cap,
                pool: config.pool,
                compute: { available: compute.available, label: compute.label, egress: compute.egress },
                sharing,
                totals,
                now: now.toISOString(),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'request_capacity',
    {
      title: 'Request donated capacity',
      description:
        'Pre-flight: ask whether this node can serve `tokens` for `peer`. Checks the donate:compute consent grant, peer authorization (allow-list/org/open), on-device compute availability, the idle window, local activity, and the daily cap. Returns a decision and a reason. Does not consume capacity.',
      inputSchema: {
        peer: z.string().min(1).describe('The requesting peer id.'),
        tokens: z.number().int().positive().describe('Tokens requested for this request.'),
      },
    },
    async ({ peer, tokens }) => {
      const now = deps.now();
      const config = deps.getConfig();
      const compute = await deps.resolveLocal();
      const respond = (decision: 'allow' | 'deny', reason: string, extra: Record<string, unknown> = {}) => ({
        isError: false,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ decision, peer, tokens, reason, ...extra }, null, 2),
          },
        ],
      });

      if (config === null) return respond('deny', 'not configured — run `vibedonate share`');

      const consent = deps.getConsent();
      const ledger = deps.getLedger();
      const totals = ledger.totals(now);
      const verdict = evaluateCapacity(config, consent, peer, tokens, {
        now,
        systemBusy: deps.systemBusy(),
        donatedToday: totals.donatedToday,
        localAvailable: compute.available,
      });

      if (verdict.decision === 'deny') {
        return respond('deny', verdict.reason, { compute: { available: compute.available, label: compute.label } });
      }
      const remainingAfter = config.cap - totals.donatedToday - tokens;
      return respond('allow', verdict.reason, {
        compute: { available: compute.available, label: compute.label, egress: compute.egress },
        remainingAfter,
      });
    },
  );

  return server;
}

/**
 * Run the server over real stdio, backed by the file stores in `dir`
 * (default `~/.vibedonate`) and a real on-device compute probe. Resolves only
 * when the transport closes (client disconnect / stdin EOF), so callers that
 * `await` it won't tear the server down the instant `connect()` returns.
 */
export async function runMcpServer(dir: string = defaultDataDir()): Promise<void> {
  const deps: McpServerDeps = {
    getConfig: () => loadConfigFromFile(dir),
    getLedger: () => createMeteringLedger(fileMeteringStore(dir)),
    getConsent: () => createConsentLedger(fileConsentStore(dir)),
    now: () => new Date(),
    systemBusy: () => false, // v0: no real local-activity detector; default not busy.
    resolveLocal: () => resolveCompute(),
  };
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Block until the client disconnects or stdin hits EOF. The transport's stdin
  // listener keeps the event loop alive while connected; bridging 'end'/'close'
  // resolves this promise so the process can exit cleanly.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.on('end', () => resolve());
    process.stdin.on('close', () => resolve());
  });
}
