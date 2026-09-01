# Brand

## Identity

`vibedonate` is an opt-in mesh for sharing local AI inference capacity.

It ships as a CLI, npm package, and MCP server in the Vibe Suite.

The current tier is local compute. Subscription and API-credit routing are not shipped tiers.

## Audience

The product serves agentic CLI users with spare local capacity or a temporary inference need.

Donors need clear consent, limits, recipient controls, and local metering.

## Promise

Use the phrase “Your hardware, opt-in, metered.”

Donors choose an idle window, daily token cap, pool, and stop action.

The consent gate, capacity gate, and local ledgers make those controls inspectable.

## Voice

Be direct, technical, and explicit about data flow.

Say what is announced, what crosses a peer link, what stays local, and what remains experimental.

Do not use “secure,” “private,” or “verified” without naming the mechanism.

## Message hierarchy

1. Donate local compute only after explicit opt-in.
2. Bound each donation by time, capacity, activity, and recipient pool.
3. Discover same-pool peers through Hyperswarm.
4. Record usage and optional payment events in local hash-chained ledgers.

## Naming

Write the product name as `vibedonate`.

Use these commands: `share`, `request`, `status`, `stop`, `wallet`, and `mcp`.

Use `open`, `org:<id>`, and `allowlist:<peers>` for recipient pools.

## Claims

Mesh announcements contain a handle, pool, compute tier, and optional payment terms.

A job prompt and result cross the connected peer link. Raw usage totals are not announced.

The CLI defaults to free jobs. Optional x402-style payment records use USDC amounts.

The donor runtime applies consent, authorization, schedule, activity, cap, and payment checks.

## Assets

The logo is `branding/logo.png`.

`docs/prototype.html` defines the interactive prototype. `docs/launch-video*.html` define launch media.

## Do's and don'ts

Do distinguish shipped local-compute behavior from draft subscription and credit tiers.

Don't describe the prototype or a catalog URL as a production application.
