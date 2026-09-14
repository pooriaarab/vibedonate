# vibedonate

<p align="center">Donate spare local AI compute to other agentic CLI users, opt-in, metered, on your hardware.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vibedonate"><img src="https://img.shields.io/npm/v/vibedonate" alt="npm 0.4.3"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License MIT"/></a>
  <a href="#mcp"><img src="https://img.shields.io/badge/MCP_tools-2-informational" alt="2 MCP tools"/></a>
</p>

```text
$ npx vibedonate@latest status
vibedonate is not armed. Run `vibedonate share ...` to start.
```

<p align="center"><em><code>vibedonate status</code> before anyone has armed donation.</em></p>

## Install

> [!NOTE]
> Needs Node.js 18 or newer.

```bash
npx vibedonate@latest
npx vibedonate@latest status
```

Pin `@latest` so a stale global install or npx cache cannot serve an old build. State lives in `$VIBEDONATE_DIR` (default `~/.vibedonate`): `config.json`, `consent.json`, `metering.json`, `payments.json`.

## Quick start

```bash
npx vibedonate@latest share --compute --idle 22:00-07:00 --cap 2M --pool allowlist:alice,bob
```

```
vibedonate — enabled · ● your machine · opt-in
  tier:     compute
  idle:     22:00-07:00 (UTC)
  cap:      2,000,000 tokens/day
  pool:     allowlist [alice, bob]
  usage:    donated 0 (today 0) · received 0 · 0 receipt(s)
  sharing:  yes (now 2026-09-14T21:34:06.646Z)
sharing compute on the mesh: announcing only your handle + pool + tier (never raw usage) to same-pool peers on the public DHT
```

`share` stays in the foreground until Ctrl-C. v0 donates local compute only. It does not route a peer through your logged-in subscription or API key.

## Why

For people who run agentic CLIs (Claude Code, Codex, Gemini, Grok, pi, Kimi) and have spare local capacity, or who need a burst of inference from a chosen peer. The usual alternative is to run Ollama only for yourself, or to look at peer-compute projects such as [block/buzz](https://github.com/block/buzz).

Not for donating idle Claude or Codex hours, and not a hosted GPU market. Those tiers need a different trust surface and are not in this release. See [`docs/spec.md`](docs/spec.md).

Part of the Vibe Suite: CLI, npm package, and MCP server. Consent comes from `@pooriaarab/vibe-core`. Nothing is shared until you arm it.

## share

Arm donation, grant `donate:compute`, and join the mesh as a donor.

```bash
npx vibedonate@latest share --compute --idle 22:00-07:00 --cap 2M --pool allowlist:alice,bob
```

```
vibedonate — enabled · ● your machine · opt-in
  tier:     compute
  idle:     22:00-07:00 (UTC)
  cap:      2,000,000 tokens/day
  pool:     allowlist [alice, bob]
  usage:    donated 0 (today 0) · received 0 · 0 receipt(s)
  sharing:  yes (now 2026-09-14T21:34:06.646Z)
sharing compute on the mesh: announcing only your handle + pool + tier (never raw usage) to same-pool peers on the public DHT
```

`--compute` is required (the only v0 tier). `--idle` may wrap midnight. `--cap` is a bare integer (`2000000`) or shorthand (`2M`, `500k`), scoped to the UTC day. Optional: `--handle` (default: hostname), `--price <usdc>` and `--chain base|ethereum|polygon` for priced jobs (default is free).

| `--pool` | Who can receive |
|----------|-----------------|
| `open` | any peer that opted into the open pool |
| `org:acme` or `org:acme,alice,bob` | a named group; trailing ids are its member allow-list |
| `allowlist:alice,bob` | an explicit peer-id list |

The live donor serves a local stub model (it reverses the prompt) until Ctrl-C. Real Ollama chat is what `status` and the MCP tools probe, not what the mesh runs in v0.

## status

```bash
npx vibedonate@latest status
```

On a machine that has not armed donation:

```
vibedonate is not armed. Run `vibedonate share ...` to start.
```

After `share`, `status` prints the config, metering totals, the resolved on-device model, and whether the idle window is open right now. This machine resolved `ollama · qwen2.5:7b`. Without Ollama you get a "no local chat model" line instead. `sharing` follows the real schedule; outside `22:00-07:00` UTC it is `no` even if donation is enabled.

## stop

```bash
npx vibedonate@latest stop
```

```
vibedonate stopped — donation disabled and consent revoked.
```

Revokes the `donate:compute` grant and writes `enabled: false`.

## How it works

A BitTorrent-style mesh for inference, not files. Discovery is Hyperswarm. Same-pool donors and consumers meet on a topic derived from the pool. The handshake carries handle, pool, and tier (plus price and pay-to if you set `--price`). Raw usage totals are not announced. A job prompt and result cross the connected peer link.

Two functions, one gate:

- `isSharingActive(config, now, systemBusy, donatedToday)` is the schedule boolean. True only when donation is enabled, the machine is not busy, today's donated tokens are under `cap`, and `now` is inside the idle window. Use it for "are we in a sharing state right now?"
- `evaluateCapacity(...)` is the full request gate, shared by MCP `request_capacity` (no commit) and `createLocalMeshRuntime().serve()` (commits a receipt). Order: enabled, consent grant, peer authorization, on-device compute available, not busy, idle window, daily cap, request fits remaining.

`resolveCompute()` runs vibe-core's model-preference cascade with `allowEgress: false`, so only the on-device (`local`) tier is eligible. Default runner is Ollama (`VIBEDONATE_OLLAMA_MODEL`, default `qwen2.5:7b`). Metering receipts are a sha-256 hash chain (`seq → prev → hash`); `ledger.verify()` detects mutation, drop, or reorder.

`createLocalMeshRuntime` is the in-process seam: it serves and meters a request locally and does not open a peer socket. `vibedonate share` / `request` are the Hyperswarm path.

`share` / `stop` / `serve` / `deny` publish `VibeEvent`s to `~/.vibe/notify.jsonl` through vibe-core's hooks bus. A `session-end` milestone from a harness can stop donation.

Other commands: `vibedonate request "<prompt>" --pool <pool>` routes one job to a donor on that pool. `vibedonate wallet` prints the stub x402 address and a hash-chained payment ledger (v0 does not settle on-chain). `vibedonate mcp` runs the stdio MCP server. `vibedonate --version` / `--help` as usual.

Interactive UX prototype (no build, no network): open [`docs/prototype.html`](docs/prototype.html) in a browser. It is not a production app. MCP install recipes for Claude Code and Claude Desktop are in [`docs/SETUP.md`](docs/SETUP.md).

### MCP

`vibedonate mcp` exposes two tools:

| Tool | Args | Returns |
|------|------|---------|
| `status` | none | config, metering totals, resolved on-device model, whether the node is sharing now |
| `request_capacity` | `{ peer, tokens }` | `allow`/`deny` plus reason |

`request_capacity` is a pre-flight. It does not consume capacity.

<details>
<summary>Library</summary>

```bash
npm install vibedonate
```

```ts
import {
  createDonationConfig,
  isSharingActive,
  createMeteringLedger,
  authorizePeer,
  DONATE_COMPUTE_SCOPE,
  resolveCompute,
  evaluateCapacity,
  createLocalMeshRuntime,
  createDonationHooks,
  createConsentLedger,
} from 'vibedonate';

const config = createDonationConfig({
  idle: '22:00-07:00',
  cap: '2M',
  pool: 'allowlist:alice,bob',
});

const now = new Date();
const ledger = createMeteringLedger();
const consent = createConsentLedger();
consent.grant(DONATE_COMPUTE_SCOPE);

const active = isSharingActive(config, now, false, ledger.totals(now).donatedToday);
const compute = await resolveCompute();
const verdict = evaluateCapacity({
  config,
  consent,
  peer: 'alice',
  tokens: 500,
  ctx: {
    now,
    systemBusy: false,
    donatedToday: ledger.totals(now).donatedToday,
    localAvailable: compute.available,
  },
});

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

`now`, `systemBusy`, the metering store, and the consent ledger are passed in so the gate is testable.

</details>

## Contributing

See [CONTRIBUTING.md](https://github.com/pooriaarab/.github/blob/main/CONTRIBUTING.md).

## License

[MIT](LICENSE)
