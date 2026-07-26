[WORKER] Implement `src/` for @pooriaarab/vibedonate — a working v0. Read README.md + docs/spec.md first. Scaffold is DONE — do NOT modify package.json/tsconfig/workflow/LICENSE. Implement ONLY under src/ + polish README.md.

## Build on @pooriaarab/vibe-core (already a dependency). Run `npm install` first.
Import from '@pooriaarab/vibe-core': createConsentLedger, types. The consent ledger gates the `donate:compute` scope. Inspect dist/index.d.ts.

## v0 scope — the SAFE tier only: LOCAL COMPUTE + metering + allow-list (NO routing a stranger's inference through your account; that's out of scope per spec's trust concerns). Everything runs on the user's machine.

### src/index.ts — library
- `createDonationConfig(opts): DonationConfig` — what to share (local-compute only for v0), idle-hours window, token/day cap, recipients (open|org|allowlist[]). Pure + validated.
- `isSharingActive(config, now, systemBusy): boolean` — PURE: true iff within idle window AND under cap AND not paused for local activity. The core gating logic — unit-test this hard.
- `createMeteringLedger(store?)` — records signed-ish usage receipts { peer, tokens, model, ts }, tracks donated/received totals, enforces the cap. Pure/injectable store.
- `authorizePeer(config, peerId): 'allow'|'deny'` — allow-list / reputation check (v0: allowlist membership).

### src/cli.ts — CLI (shebang, tiny arg parse, no new deps)
- `vibedonate share --compute --idle 22:00-07:00 --cap 2000000 --pool allowlist:alice,bob` — write config, print status + the "● your machine · opt-in" badge.
- `vibedonate status` — show config + metering totals + whether currently sharing (isSharingActive).
- `vibedonate stop` — disable. `vibedonate mcp`, `--version`, `--help`.

### src/mcp.ts — MCP server (`@modelcontextprotocol/sdk`, stdio) exposing `status` and `request_capacity` ({peer, tokens}) — the latter checks authorizePeer + isSharingActive + cap, returns allow/deny. Check installed SDK API.

### tests — src/*.test.ts (vitest): isSharingActive (in/out of window, over cap, system-busy), createMeteringLedger (cap enforcement, totals), authorizePeer (allowlist), CLI parser.

### README.md — polish for npm: keep existing, add install + quick start + a clear note "v0 = local-compute tier only; account/credit-routing tiers need trust/legal design (see spec)".

## Definition of done (run, all green): `npm install` → `npm run build` → `npm run typecheck` → `npm run test`. Strict tsconfig (`import type`, `.js` on relative imports). Then commit "feat: vibedonate v0 — CLI + lib + MCP" on branch build-v0. Do NOT push. Report build + tests + judgment calls.
