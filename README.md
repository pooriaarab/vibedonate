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

// The core gate: enabled AND not busy AND under cap AND inside the idle window.
const active = isSharingActive(config, now, /* systemBusy */ false, ledger.totals(now).donatedToday);

const decision = authorizePeer(config, 'alice'); // 'allow' | 'deny'
```

Every function is **pure and injectable**: `now`, `systemBusy`, the metering store, and the consent ledger are all passed in — which is what makes the gating logic unit-testable to exhaustion.

## MCP server

`vibedonate mcp` runs an stdio MCP server with two tools:

| Tool | Args | Returns |
|------|------|---------|
| `status` | — | config, metering totals, and whether the node is sharing *now* |
| `request_capacity` | `{ peer, tokens }` | `allow`/`deny` + reason |

`request_capacity` is a **pre-flight** — it checks the `donate:compute` consent grant, peer authorization, the idle window, local activity, and the daily cap, then answers. It does not consume capacity (recording real usage is the runtime half of the mesh, landing after v0). An agent running low on quota can ask the mesh for capacity behind your consent.

## How it gates

`isSharingActive(config, now, systemBusy, donatedToday)` is the single boolean everything consults. It is `true` **iff**:

1. the donation is `enabled` (master toggle — `stop` flips it and revokes consent),
2. the machine is not busy with local activity (`systemBusy`),
3. today's donated tokens are still under `cap`, and
4. `now` falls inside the idle window.

Metering receipts form a sha-256 **hash-chain** (`seq → prev → hash`); `ledger.verify()` detects any mutation, drop, or reorder — a local tamper-evident ledger, as the spec calls for.

## Prototype

Interactive, self-contained UX prototype (no build, no network): open [`docs/prototype.html`](docs/prototype.html) in a browser.

## Status

Prototype + spec + **v0 implementation** (local-compute tier). Account/credit-routing tiers need trust/legal design — see [`docs/spec.md`](docs/spec.md).
