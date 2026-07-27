/**
 * Real end-to-end test of the vibedonate MCP server: spin up `createMcpServer`
 * against an injected dep set, link it to a real MCP `Client` over an in-memory
 * transport, and call the tools through the actual JSON-RPC protocol surface.
 *
 * No transport mocking, no direct handler invocation — this exercises the same
 * wire path an agent (Claude Code, Codex, …) would.
 */

import { describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  createConsentLedger,
  createDonationConfig,
  createMeteringLedger,
  DONATE_COMPUTE_SCOPE,
  type ComputeResolution,
  type ConsentLedger,
  type DonationConfig,
} from './index.js';
import { createMcpServer, type McpServerDeps } from './mcp.js';

/** UTC date for `HH:MM` on a fixed day. */
function at(hh: number, mm: number): Date {
  return new Date(Date.UTC(2026, 0, 15, hh, mm, 0));
}

interface DepOverrides {
  readonly config?: DonationConfig | null;
  readonly consent?: boolean;
  readonly busy?: boolean;
  readonly local?: boolean;
  readonly now?: Date;
}

function buildDeps(over: DepOverrides = {}): McpServerDeps {
  const config =
    over.config === undefined
      ? createDonationConfig({ idle: '22:00-07:00', cap: 1_000_000, pool: 'allowlist:alice,bob' })
      : over.config;
  const consent: ConsentLedger = createConsentLedger();
  if (over.consent ?? true) consent.grant(DONATE_COMPUTE_SCOPE);
  const ledger = createMeteringLedger();
  const local: ComputeResolution = {
    tier: 'local',
    egress: false,
    available: over.local ?? true,
    label: over.local === false ? 'no local chat model (install ollama)' : 'fake · unit',
  };
  return {
    getConfig: () => config,
    getLedger: () => ledger,
    getConsent: () => consent,
    now: () => over.now ?? at(23, 0),
    systemBusy: () => over.busy ?? false,
    resolveLocal: async () => local,
  };
}

async function withClient<T>(
  deps: McpServerDeps,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'vibedonate-test', version: '0.0.0' });
  await client.connect(clientTransport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

interface TextResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
}
async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = (await client.callTool({ name, arguments: args })) as TextResult;
  const text = res.content.find((c) => c.type === 'text');
  if (!text) throw new Error(`tool ${name} returned no text content`);
  return JSON.parse(text.text) as Record<string, unknown>;
}

describe('MCP server (real client over in-memory transport)', () => {
  it('status: not configured reports armed=false', async () => {
    const out = await withClient(buildDeps({ config: null }), (c) => callTool(c, 'status'));
    expect(out['armed']).toBe(false);
    expect(out['sharing']).toBe(false);
    expect(out['reason']).toMatch(/not configured/);
  });

  it('status: armed + sharing reports the resolved compute model', async () => {
    const out = await withClient(buildDeps(), (c) => callTool(c, 'status'));
    expect(out['armed']).toBe(true);
    expect(out['consentGranted']).toBe(true);
    expect(out['sharing']).toBe(true);
    expect((out['compute'] as { available: boolean }).available).toBe(true);
    expect((out['compute'] as { label: string }).label).toBe('fake · unit');
  });

  it('request_capacity: allows an authorized peer under the cap', async () => {
    const out = await withClient(buildDeps(), (c) =>
      callTool(c, 'request_capacity', { peer: 'alice', tokens: 500 }),
    );
    expect(out['decision']).toBe('allow');
    expect(out['reason']).toMatch(/remain after/);
    expect((out['compute'] as { egress: boolean }).egress).toBe(false);
  });

  it('request_capacity: denies an unauthorized peer', async () => {
    const out = await withClient(buildDeps(), (c) =>
      callTool(c, 'request_capacity', { peer: 'eve', tokens: 500 }),
    );
    expect(out['decision']).toBe('deny');
    expect(out['reason']).toMatch(/not authorized/);
  });

  it('request_capacity: denies when no on-device model is available', async () => {
    const out = await withClient(buildDeps({ local: false }), (c) =>
      callTool(c, 'request_capacity', { peer: 'alice', tokens: 500 }),
    );
    expect(out['decision']).toBe('deny');
    expect(out['reason']).toMatch(/local chat model/);
  });

  it('request_capacity: denies without the consent grant', async () => {
    const out = await withClient(buildDeps({ consent: false }), (c) =>
      callTool(c, 'request_capacity', { peer: 'alice', tokens: 500 }),
    );
    expect(out['decision']).toBe('deny');
    expect(out['reason']).toMatch(/consent/);
  });

  it('request_capacity: denies outside the idle window', async () => {
    const out = await withClient(buildDeps({ now: at(12, 0) }), (c) =>
      callTool(c, 'request_capacity', { peer: 'alice', tokens: 500 }),
    );
    expect(out['decision']).toBe('deny');
    expect(out['reason']).toMatch(/idle window/);
  });

  it('request_capacity: denies when not configured', async () => {
    const out = await withClient(buildDeps({ config: null }), (c) =>
      callTool(c, 'request_capacity', { peer: 'alice', tokens: 500 }),
    );
    expect(out['decision']).toBe('deny');
    expect(out['reason']).toMatch(/not configured/);
  });
});
