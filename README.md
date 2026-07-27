# vibedonate

BitTorrent-style mesh for AI inference — donate spare **local compute** across Claude, Codex, Gemini, Grok, pi. Your hardware, opt-in, metered.

Part of the **Vibe Suite** — companion tools for agentic coding CLIs (Claude Code, Codex, Gemini, Grok/pi, Kimi). Ships as **CLI + npm package + MCP server**.

**Local-first: runs on your own machine, no data out** (consent model in `@pooriaarab/vibe-core`).

> **v0 = the local-compute tier only.** This release donates spare compute from a model on *your* machine, metered against a daily token cap and scoped to an allow-list. Routing a stranger's inference through your logged-in subscription or API key is a *different trust surface* and needs trust/legal design first (see [`docs/spec.md`](docs/spec.md) §"Open questions"). It is deliberately **not** in v0.

## Install

```bash
# use it
npx vibedonate share --compute --idle 22:00-07:00 --cap 2M --pool allowlist:alice,bob

# or install globally
npm install -g vibedonate
vibedonate status
```

As a library:

```bash
npm install vibedonate
```

## Quick start (CLI)

```bash
# Arm donation: local compute, 22:00–07:00 UTC, 2M tokens/day, only alice & bob.
vibedonate share --compute --idle 22:00-07:00 --cap 2000000 --pool allowlist:alice,bob
```

```
vibedonate — enabled · ● your machine · opt-in
  tier:     compute
  idle:     22:00-07:00 (UTC)
  cap:      2,000,000 tokens/day
  pool:     allowlist [alice, bob]
  usage:    donated 0 (today 0) · received 0 · 0 receipt(s)
  sharing:  yes (now 2026-07-26T03:17:55Z)
```

```bash
vibedonate status      # config + metering totals + whether sharing right now
vibedonate stop        # disable (revokes the donate:compute consent grant)
vibedonate mcp         # run the MCP server over stdio
vibedonate --version
vibedonate --help
```

State lives in `$VIBEDONATE_DIR` (default `~/.vibedonate`): `config.json`, `consent.json`, `metering.json`. Nothing leaves your machine.

### `--pool`

| Value | Who can receive |
|-------|-----------------|
| `open` | any peer (you opted into the open pool) |
| `org:acme` or `org:acme,alice,bob` | a named group; trailing ids are its member allow-list |
| `allowlist:alice,bob` | an explicit peer-id list |

### `--cap`

A bare integer (`2000000`) or shorthand (`2M`, `500k`). Scoped to the UTC day of each receipt.

## Quick start (library)

```ts
import {
  createDonationConfig,
  isSharingActive,
  createMeteringLedger,
  authorizePeer,
  DONATE_COMPUTE_SCOPE,
  resolveCompute,        // cascade-backed on-device model resolution
  evaluateCapacity,      // the shared gate (MCP + mesh runtime)
  createLocalMeshRuntime,// serves a request + commits a receipt
  createDonationHooks,   // lifecycle events into the suite notify channel
  createConsentLedger, // from @pooriaarab/vibe-core, re-exported
} from 'vibedonate';

const config = createDonationConfig({
  idle: '22:00-07:00',      // wraps midnight
  cap: '2M',                // 2,000,000 tokens/day
  pool: 'allowlist:alice,bob',
});

const now = new Date();
const ledger = createMeteringLedger();       // in-memory; pass a store to persist
const consent = createConsentLedger();
consent.grant(DONATE_COMPUTE_SCOPE);          // arm donation

// The schedule boolean: enabled AND not busy AND under cap AND inside the window.
const active = isSharingActive(config, now, /* systemBusy */ false, ledger.totals(now).donatedToday);

// What "donate local compute" actually means: is there an on-device model to
// serve with? Resolved through vibe-core's cascade with egress forbidden, so it
// provably never leaves your machine (Ollama by default).
const compute = await resolveCompute();

// The shared gate both the MCP pre-flight and the mesh runtime consult.
// Adds consent, peer auth, and on-device availability to the schedule check.
const verdict = evaluateCapacity(config, consent, 'alice', 500, {
  now,
  systemBusy: false,
  donatedToday: ledger.totals(now).donatedToday,
  localAvailable: compute.available,
}); // { decision: 'allow' | 'deny', reason }

// The runtime: on allow it commits a real, hash-chained receipt. The P2P
// transport that feeds it remote requests is the one seam still to land.
const mesh = createLocalMeshRuntime({
  config: () => config,
  consent: () => consent,
  ledger: () => ledger,
  now: () => new Date(),
  systemBusy: () => false,
  resolveLocal: () => resolveCompute(),
});
await mesh.serve({ peer: 'alice', tokens: 500 });
```

Every function is **pure and injectable**: `now`, `systemBusy`, the metering store, and the consent ledger are all passed in — which is what makes the gating logic unit-testable to exhaustion.

## MCP server

`vibedonate mcp` runs an stdio MCP server with two tools:

| Tool | Args | Returns |
|------|------|---------|
| `status` | — | config, metering totals, and whether the node is sharing *now* |
| `request_capacity` | `{ peer, tokens }` | `allow`/`deny` + reason |

`request_capacity` is a **pre-flight** — it checks the `donate:compute` consent grant, peer authorization, **on-device compute availability** (resolved through vibe-core's cascade, egress forbidden), the idle window, local activity, and the daily cap, then answers. It does not consume capacity (recording real usage is the runtime half of the mesh, landing after v0). An agent running low on quota can ask the mesh for capacity behind your consent.

## How it gates

Two functions, one truth:

- **`isSharingActive(config, now, systemBusy, donatedToday)`** — the schedule boolean. `true` **iff** the donation is `enabled`, the machine is not busy, today's donated tokens are under `cap`, and `now` is inside the idle window. Use this for "are we in a sharing state right now?" (status, dashboards).
- **`evaluateCapacity(config, consent, peer, tokens, ctx)`** — the full request gate, shared by `request_capacity` (MCP, no commit) and `createLocalMeshRuntime().serve()` (runtime, commits a receipt). Checks in order: `enabled` → consent grant → peer authorization → **on-device compute available** → not busy → idle window → daily cap → request fits remaining. One definition, consulted everywhere.

The on-device compute check is real: `resolveCompute()` runs the request through vibe-core's **model-preference cascade** with `allowEgress:false`, so only the on-device (`local`) tier is ever eligible — donated compute provably never leaves your machine. vibedonate ships an Ollama-backed `chat` runner (set `VIBEDONATE_OLLAMA_MODEL`); other runners drop into `defaultChatRunners()` as they land.

Metering receipts form a sha-256 **hash-chain** (`seq → prev → hash`); `ledger.verify()` detects any mutation, drop, or reorder — a local tamper-evident ledger, as the spec calls for. `createLocalMeshRuntime().serve()` is what actually appends to it, so the ledger is exercised (not write-only).

### The one seam still to land

The **P2P transport** — carrying a remote peer's request to this node and the donor's inference back (encrypted peer-to-peer payload, relay only for discovery/NAT). `MeshRuntime` defines that seam; `createLocalMeshRuntime` implements everything *except* the transport, so a real request can be served and metered locally today, and the network layer plugs in later. See [`docs/spec.md`](docs/spec.md) §"Routing" / §"Open questions".

### Suite events

`share` / `stop` / `serve` / `deny` publish normalized `VibeEvent`s to the local notify channel (`~/.vibe/notify.jsonl`) via vibe-core's **hooks bus**, and a `session-end` milestone from any harness cleanly stops donation — so vibedonate is a first-class participant in the suite, not an island.

## Prototype

Interactive, self-contained UX prototype (no build, no network): open [`docs/prototype.html`](docs/prototype.html) in a browser.

## Status

Prototype + spec + **v0 implementation** (local-compute tier). v0.2 makes "donate local compute" real: an on-device model is resolved through vibe-core's cascade (egress forbidden), the shared capacity gate is factored into one function, the mesh runtime actually commits hash-chained receipts, and donation lifecycle publishes to the suite notify channel. Account/credit-routing tiers need trust/legal design, and the P2P transport is the one seam still to land — see [`docs/spec.md`](docs/spec.md).
