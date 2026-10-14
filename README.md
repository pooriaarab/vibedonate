# vibedonate

[![npm version](https://img.shields.io/npm/v/vibedonate)](https://www.npmjs.com/package/vibedonate) [![Downloads/month](https://img.shields.io/npm/dm/vibedonate)](https://www.npmjs.com/package/vibedonate) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/vibedonate) · [Setup](#install) · [Runtime surfaces](#runtime-surfaces) · [Compare](#compare)

vibedonate is an open-source, self-hosted compute-sharing experiment for developers who use coding agents.
Your hardware, opt-in, metered. It provides peer transport, donation controls, and local ledgers in the Vibe Suite.
The current CLI mesh runs an echo stub; its separate Ollama runner is not connected to mesh jobs.

## Install

```bash
npm install -g vibedonate
```

Requires Node.js 18 or later. Includes TypeScript declarations and three direct runtime dependencies.

## Run your first local check

```bash
vibedonate status
```

On a fresh installation, the output reports an unconfigured node and local model availability.
No credentials or environment variables are required. No sharing starts from this command.
The CLI reads exported environment variables; it does not load `.env` files.

For an opt-in transport demo, run this donor in one terminal:

```bash
vibedonate share --compute --idle 00:00-23:59 --cap 2M --pool allowlist:consumer --handle donor
```

Run the consumer in another terminal:

```bash
vibedonate request "hello" --pool allowlist:consumer --handle consumer
```

With reachable peers inside the UTC window, the consumer prints `olleh`. This is the echo stub, not AI inference.
Stop the donor with Ctrl+C, then run `vibedonate stop` to revoke persisted consent.

## How it works

```text
share -> saved config + consent -> Hyperswarm pool discovery
                                      |
consumer prompt -> donor checks -> echo stub -> result + metering receipt

status / MCP preflight -> separate Ollama availability check
payment flags -> stub wallet + local payment ledger
```

Announcements contain handle, pool, compute tier, and optional payment terms. Prompts and results cross connected peer links.
Raw usage totals are not announced. Local files default to `~/.vibedonate`.

## Why it exists

vibedonate explores opt-in donation controls around spare local compute.
Petals distributes model execution; Ray Serve provides model-serving infrastructure.
This package focuses on consent, schedules, recipient pools, and metering, with experimental peer transport.

## Compare

Checked 2026-10-14 against the [Petals research paper](https://arxiv.org/abs/2209.01188) and [Ray Serve documentation](https://docs.ray.io/en/latest/serve/llm/index.html).

| Property | vibedonate | Petals | Ray Serve |
| --- | --- | --- | --- |
| Scope | Donation controls and echo mesh demo | Collaborative model inference and fine-tuning | Distributed model serving |
| Execution | Default mesh uses echo stub | Distributed model blocks | Deployed model-serving applications |
| Interface | Node.js library, CLI, agent preflight | Model inference interface | Python deployment and inference APIs |

## Coverage

| Integration or tier | Status | Source behavior |
| --- | --- | --- |
| Hyperswarm | Implemented | Same-pool peer discovery and request/result transport |
| Ollama | Separate runner | Detects executable; invokes `ollama run`; not wired to mesh CLI |
| Echo mesh model | Stub | Reverses prompts; records 100 tokens per default job |
| USDC / x402-style payments | Stub | Deterministic wallet proofs and local ledger; no settlement |
| Base | Scaffold | Accepted payment chain label |
| Ethereum | Scaffold | Accepted payment chain label |
| Polygon | Scaffold | Accepted payment chain label |
| Subscription sharing | — | No shipped tier |
| API-credit routing | — | No shipped tier |

There is one default chat runner, one default echo mesh model, and two MCP tools.
Source inspection and local tests support these distinctions. No credentials, on-chain transactions, or public-network service guarantees were verified.

## Common use cases

1. Node.js developers: test consent and capacity decisions through the exported library.
2. Hyperswarm experimenters: exchange echo jobs between same-pool peers.
3. Ollama users: inspect local chat-runner availability before building a custom integration.
4. Agent builders: call MCP `request_capacity` to check a proposed donation without executing a job.
5. Vibe Suite users: inspect hash-chained usage and payment records on their own machine.

## Features

- **Consent:** `share` grants `donate:compute`; `stop` revokes it in persisted storage.
- **Schedules:** UTC idle windows and configurable daily token caps.
- **Recipient pools:** `open`, `org:<id>,<member>`, and `allowlist:<peers>`.
- **Metering:** local hash-chained receipts with a chain verification method.
- **Payments:** optional price metadata and stub payment records; free jobs by default.
- **Suite hooks:** exported donation lifecycle hooks use vibe-core events and notifications.

## Runtime surfaces

The Node.js package exports configuration parsers, consent helpers, capacity evaluation, metering, payment stubs, and compute resolution.

```text
vibedonate share --compute --idle HH:MM-HH:MM --cap 2M --pool open
  [--handle name] [--price 0.001] [--chain base|ethereum|polygon]
vibedonate request "prompt" --pool open
  [--handle name] [--timeout milliseconds] [--pay 0.001]
vibedonate status
vibedonate stop
vibedonate wallet
vibedonate mcp
vibedonate --help / -h
vibedonate --version / -v
```

`vibedonate mcp` starts a stdio Model Context Protocol (MCP) server with exactly two tools:

| Tool | Behavior |
| --- | --- |
| `status` | Config, consent, compute availability, schedule state, and totals |
| `request_capacity` | Preflight `{ peer, tokens }`; returns an allow/deny decision without inference or a receipt |

## Delivery and behavior limits

The CLI donor defaults to `createEchoModel()`. Installing Ollama does not replace it with model inference.
The separate local runtime records capacity receipts; it does not execute a prompt.
The CLI uses `stubWallet()`. Payment success means a synthetic proof passed, not that USDC moved on Base, Ethereum, or Polygon.
Peer authorization compares announced handles. It does not authenticate organization membership or bind handles to trusted identities.
CLI activity checks default to “not busy”; no automatic machine-idle detector is wired into the donor.
The running donor holds its initial config and consent objects. Use Ctrl+C to stop it; a separate `stop` process does not close it.
The mesh checks whether today's total is below the cap before a job; a job can exceed the remaining allowance.
The capacity preflight has a stricter request-fits check. Do not assume both paths enforce identical bounds.
Discovery defaults to 15 seconds; each attempted donor gets up to six seconds. Total elapsed time can exceed the discovery timeout.
Hash chains detect inconsistent record content; they do not prevent someone from rewriting the whole local ledger.

## Integration guides

- Ollama runner: install Ollama and pull `qwen2.5:7b`; set `VIBEDONATE_OLLAMA_MODEL` to choose another installed model.
- Separate state: export `VIBEDONATE_DIR` to override `~/.vibedonate`.
- Restricted demo pool: use the same `allowlist:consumer` string on both peers and `--handle consumer` for requests.
- Organization pool: include explicit members, such as `org:team,alice`; `org:team` alone authorizes no members.
- Agent setup: configure your MCP host to launch `vibedonate mcp` over stdio.

## Status

Version 0.4.3 is experimental and pre-1.0. Public case studies are not yet published.
No public documentation site is configured; the operational guidance is self-contained here.
Use [GitHub issues](https://github.com/pooriaarab/vibedonate/issues) for support; repository access may be required.
For contributions, run `npm ci`, `npm run typecheck`, `npm run build`, and `npm test`.

## FAQ

### Which integrations are verified?

vibedonate has source-backed peer transport and a separate Ollama runner. Local tests do not certify public peers or blockchain settlement.

### Does vibedonate provide a managed inference service?

vibedonate runs on your hardware. It provides no managed inference pool, availability guarantee, or hosted account service.

### Does the CLI run Ollama for donated jobs?

vibedonate uses an echo stub for default CLI mesh jobs. The Ollama chat runner exists as a separate library path.

### How is vibedonate different from Petals?

vibedonate experiments with donation controls and a request/result mesh. Petals distributes model execution across participants.

### How is vibedonate different from Ray Serve?

vibedonate supplies local donation controls and a CLI experiment. Ray Serve supplies infrastructure for deployed model-serving applications.

### Can I earn real USDC with vibedonate?

vibedonate ships a stub wallet and local payment records. The CLI does not submit or verify real blockchain payments.

### Does stop terminate an active donor?

vibedonate stop changes persisted config and consent. Stop the active donor process with Ctrl+C to leave the mesh.

### Does vibedonate share subscription quotas or API credits?

vibedonate ships only the compute tier. Subscription and API-credit routing are not implemented.

## License

MIT.
