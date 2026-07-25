# vibedonate — spec

Status: DRAFT (Opus-authored) · 2026-07-25 · depends on `@vibe/core`
Identity: vibedonate.org (available $8.50/yr) · ships CLI + npm + MCP
Prior art: github.com/block/buzz (peer compute sharing)

## What it is
A **BitTorrent-style mesh for AI inference** (not files). Users donate spare
capacity — idle subscription hours (overnight), spare API credits, or **local
compute** from models on their own machine — to others: research labs, people/orgs
without frontier access, or any opted-in peer. Runs across all harnesses' providers.

## The three things you can donate (each a different trust surface)
1. **Idle subscription time** — route a peer's request through your logged-in
   Claude/Codex/etc during hours you're not using it. Highest abuse risk (your
   account, your bill/limits).
2. **Spare API credits** — your key pays for a peer's inference. Metered spend cap.
3. **Local compute** — a model on YOUR hardware serves a peer. No account risk;
   hardware/DoS risk. This tier is the purest "local-first" story and reuses
   `@vibe/core`'s local runners (§2.3).

## Local-first framing
Your machine/account is the resource. **Nothing is shared until you arm it**, scoped
by schedule + cap + recipient. The consent ledger (`@vibe/core` §4) holds the
`donate:{sub|credits|compute}` grants; revoke = instant stop (prototype's master
toggle).

## Config (what / when / who)
- **What:** which of the 3 capacities, per-provider.
- **When:** idle-hours schedule, volume cap (tokens/day), pause-on-local-activity.
- **Who:** open pool · a specific org · an allow-list of peers.

## Trust / safety / metering (the hard core — needs real design before build)
- **Metering:** signed usage receipts per request (who, tokens, model, ts) so both
  sides agree on what was consumed; local tamper-evident ledger.
- **Abuse prevention:** per-peer rate + volume caps; content/prompt policy filter on
  donated *subscription/credit* tiers (you're liable for what runs on your account);
  kill-switch; anomaly detection (sudden spike → auto-pause).
- **Reputation/verification:** peers earn a score; capacity only routes to
  verified/allow-listed peers by default before trusting a stranger's account/hw.
  Sybil resistance is the open research question (see below).
- **Routing:** a peer's request → a matcher → an available donor honoring
  scope/reputation. Encrypted peer-to-peer payload (donor can't be forced to log
  plaintext); relay only for discovery/NAT, like vibelive's transport.

## Surfaces
- **CLI:** `vibedonate share --compute --idle 22:00-07:00 --cap 2M --pool org:acme` ·
  `vibedonate status` · `vibedonate requests` (approve/deny) · `vibedonate use`
  (consume, if you're a recipient).
- **npm:** programmatic node (donor/recipient) API.
- **MCP:** `vibedonate.status`, `vibedonate.request_capacity` — an agent low on
  quota can request mesh capacity (behind consent).

## Open questions (flagged as needing design, per original brief)
- Sybil/abuse: how to verify a peer + prevent one bad actor draining a shared key or
  running disallowed workloads through your account. Likely: start allow-list/org
  only, earn open-pool access via reputation, hard content filter on account-backed
  tiers.
- Legal/ToS: routing a stranger's inference through your Claude/Codex subscription may
  violate provider ToS — **local-compute tier is the safe v0**; account/credit tiers
  need legal review. Recommend v0 ships local-compute + credits-to-allowlist only.
- Fair matching/incentives: give-to-get ratio vs pure altruism pool.
