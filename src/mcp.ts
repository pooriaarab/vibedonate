/**
 * vibedonate MCP server (stdio).
 *
 * Exposes two tools an agent (or any MCP client) can call:
 *   - `status`           — current config, metering totals, and whether the
 *                          node is sharing *right now*.
 *   - `request_capacity` — a pre-flight: "can you take `tokens` for `peer`?"
 *                          Returns allow/deny with a reason, gating on consent,
 *                          peer authorization, the idle window, and the cap.
 *
 * `request_capacity` only *asks* — it does not record consumption. Recording
 * real usage (and the donor actually running inference for the peer) is the
 * runtime half of the mesh and lands after v0; the gate is the part you can
 * trust today.
 *
 * Dependency injection keeps the server deterministic: the config, ledger,
 * consent ledger, clock, and "busy" signal are all functions the caller wires.
 * {@link runMcpServer} wires them to the real file-backed stores over stdio.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { createConsentLedger } from '@pooriaarab/vibe-core';

import {
  authorizePeer,
  createMeteringLedger,
  defaultDataDir,
  DONATE_COMPUTE_SCOPE,
  fileConsentStore,
  fileMeteringStore,
  isSharingActive,
  loadConfigFromFile,
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
}

export interface McpServerHooks {
  readonly name?: string;
  readonly version?: string;
}

/**
 * Build the MCP server (no transport). Pure-ish: registers tools against the
 * injected deps. Returns the `McpServer` so a caller can `connect()` it to any
 * transport — used by tests and {@link runMcpServer}.
 */
export function createMcpServer(deps: McpServerDeps, hooks: McpServerHooks = {}): McpServer {
  const server = new McpServer({ name: hooks.name ?? 'vibedonate', version: hooks.version ?? '0.1.0' });

  server.registerTool(
    'status',
    {
      title: 'Donation status',
      description:
        'Report the current vibedonate config, metering totals (donated / donatedToday / received), and whether the node is sharing capacity right now.',
    },
    () => {
      const now = deps.now();
      const config = deps.getConfig();
      const ledger = deps.getLedger();
      if (config === null) {
        return {
          isError: false,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                { armed: false, sharing: false, reason: 'not configured — run `vibedonate share`' },
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
        'Pre-flight: ask whether this node can serve `tokens` for `peer`. Checks the donate:compute consent grant, peer authorization (allow-list/org/open), the idle window, local activity, and the daily cap. Returns a decision and a reason. Does not consume capacity.',
      inputSchema: {
        peer: z.string().min(1).describe('The requesting peer id.'),
        tokens: z.number().int().positive().describe('Tokens requested for this request.'),
      },
    },
    ({ peer, tokens }) => {
      const now = deps.now();
      const config = deps.getConfig();
      const deny = (reason: string) => ({
        isError: false,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ decision: 'deny' as const, peer, tokens, reason }, null, 2),
          },
        ],
      });
      const allow = (remaining: number) => ({
        isError: false,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { decision: 'allow' as const, peer, tokens, remainingAfter: remaining - tokens },
              null,
              2,
            ),
          },
        ],
      });

      if (config === null) return deny('not configured — run `vibedonate share`');
      if (!config.enabled) return deny('donation is stopped');
      if (!deps.getConsent().allows(DONATE_COMPUTE_SCOPE)) {
        return deny('donate:compute consent not granted');
      }
      if (authorizePeer(config, peer) === 'deny') {
        return deny(`peer "${peer}" not authorized by the ${config.pool.kind} pool`);
      }

      const ledger = deps.getLedger();
      const totals = ledger.totals(now);
      if (!isSharingActive(config, now, deps.systemBusy(), totals.donatedToday)) {
        if (totals.donatedToday >= config.cap) return deny('daily cap reached');
        if (deps.systemBusy()) return deny('local activity in progress');
        return deny(`outside idle window ${config.idle.start}-${config.idle.end}`);
      }
      const remaining = ledger.remainingToday(config.cap, now);
      if (tokens > remaining) return deny(`only ${remaining} tokens remain under the daily cap`);

      return allow(remaining);
    },
  );

  return server;
}

/**
 * Run the server over real stdio, backed by the file stores in `dir`
 * (default `~/.vibedonate`). Resolves only when the transport closes (client
 * disconnect / stdin EOF), so callers that `await` it won't tear the server down
 * the instant `connect()` returns.
 */
export async function runMcpServer(dir: string = defaultDataDir()): Promise<void> {
  const deps: McpServerDeps = {
    getConfig: () => loadConfigFromFile(dir),
    getLedger: () => createMeteringLedger(fileMeteringStore(dir)),
    getConsent: () => createConsentLedger(fileConsentStore(dir)),
    now: () => new Date(),
    systemBusy: () => false, // v0: no real local-activity detector; default not busy.
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
