# Design

## Overview

The shipped interface is the plain-text CLI in `src/cli-render.ts`.

`docs/prototype.html` defines the interactive design direction. It is not a deployed application.

`docs/launch-video.html` and its aspect-ratio variants reuse that direction for launch media.

The repository does not own a custom production deployment. Do not add live routes here.

## Colors

The prototype defines its palette in `docs/prototype.html`.

| Role | Token | Value |
|---|---|---|
| Canvas | `--bg` | `#090b10` |
| Panel | `--bg-panel` | `#11141b` |
| Raised control | `--bg-panel-raised` | `#151924` |
| Text | `--text` | `#e8ecf3` |
| Secondary text | `--text-dim` | `#93a1ba` |
| Faint text | `--text-faint` | `#5d6a82` |
| Donating | `--give` | `#57d9c4` |
| Receiving | `--get` | `#b592ff` |
| Verified | `--verified` | `#4ade80` |
| Pending | `--pending` | `#f2b25a` |
| Destructive | `--danger` | `#f2716b` |

Use text and shape with every status color. Focus outlines use `--give`.

The CLI emits no ANSI color and inherits the terminal theme.

## Typography

The prototype uses `--sans` for interface copy and `--mono` for exact values.

The system sans stack includes Segoe UI, Inter, and Roboto fallbacks.

The monospace stack includes SF Mono, Cascadia Code, Menlo, and Consolas.

The CLI relies on the terminal font. Keep labels aligned in its existing two-space grid.

## Layout

The prototype shell stops at `1360px` with `32px` side padding.

Its grid uses `300px`, one flexible column, and `320px`, with a `20px` gap.

Below `1180px`, the grid becomes one column.

The 24-cell hour strip maps one cell to each UTC hour.

CLI status and wallet output stay single-column with stable label widths.

## Elevation & Depth

Panels use `--bg-panel`, a subtle border, and a `14px` radius.

Raised inputs and nested controls use `--bg-panel-raised`.

Node badges use a compact shadow. Active packet markers use colored drop shadows.

The CLI is flat. Blank lines, indentation, and punctuation provide hierarchy.

## Shapes

Use pill shapes for badges, switches, and chips.

Use `14px` radii for panels, `10px` for nested cards, and `8px` for controls.

The mesh diagram uses circles for nodes and paths for give, receive, and pending edges.

The CLI uses `●`, `·`, `⚠`, `←`, `→`, `—`, and `–` with their existing meanings.

## Components

The master switch arms or stops donation. Its focus state uses a visible outline.

The schedule uses the hour strip. The capacity control combines a slider and exact value.

Recipient choice uses radio options for open, organization, and allow-list pools.

The mesh diagram pairs edge styles with moving packets and node labels.

Meter cards show donated, received, and current-cap totals.

Request cards show pending, approve, and deny states.

`renderStatus` and `renderWallet` own all CLI presentation. Reuse them instead of ad hoc output.

The prototype and launch video honor `prefers-reduced-motion`.

## Do's and Don'ts

Do reuse the declared CSS tokens and CLI render functions.

Do preserve keyboard focus, reduced motion, responsive collapse, and non-color status cues.

Do keep give and receive directions visually distinct.

Don't add a third-party CLI color library.

Don't present prototype controls as shipped web functionality.

Don't add a production URL, `/design.md`, or `/brand` without deployment ownership evidence.
