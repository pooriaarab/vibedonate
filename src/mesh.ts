/**
 * Live P2P compute-mesh transport for vibedonate — over the hyperswarm DHT.
 *
 * Mirrors the proven pattern in the sibling `vibedating` repo (src/p2p.ts): no
 * central server, NAT hole-punching + encryption from hyperswarm/hyperdht, and
 * a consent gate that LIVES WITH THE CALLER (the CLI) — this module never
 * decides policy on its own, it only enforces what the caller already armed.
 *
 * Discovery: the recipient pool is hashed into a 32-byte topic
 * (`sha256('vibedonate:' + poolTopicKey(pool))`). Donors ANNOUNCE capacity on
 * that topic; consumers look it up and connect. Everyone on the same pool
 * definition hashes to the same topic anywhere in the world.
 *
 * NOTE on the topic vs. the allow-list (same split as vibedating's league): the
 * topic is the PUBLIC discovery label — a non-member can compute it and connect.
 * The real authorization gate is {@link authorizePeer} on every JOB: a peer not
 * in the pool's allow-list connects fine but is DENIED (no job runs, no receipt).
 *
 * Handshake: on each encrypted peer connection both sides send a single JSON
 * line with ONLY { handle, pool, capacityTier }. Raw usage / system info is
 * NEVER sent, and {@link parseFrame} builds its result from an allow-list of
 * keys, so anything a peer adds beyond those fields is dropped on receipt.
 *
 * Job routing (v0): a consumer sends { t:'job', id, prompt }; the donor, ONLY IF
 * the donate:compute consent grant holds AND authorizePeer(pool) allows the
 * consumer AND {@link isSharingActive} is green, runs the prompt on a LOCAL
 * on-device model STUB (no real LLM in v0 — the transport + gating is the
 * deliverable) and returns { t:'result', id, output }. Every completed job
 * records a hash-chained receipt via the EXISTING {@link createMeteringLedger}
 * and its token cost counts against the daily cap.
 *
 * Consent: {@link startDonor} refuses to join at all without the
 * `donate:compute` grant (fast-fail), AND re-checks it per job so a mid-session
 * `stop` revokes instantly — mirroring vibedating's share:live caller gate.
 */
import { randomBytes } from 'node:crypto';
import { topicFor } from '@pooriaarab/vibe-core/ids';
import type { Duplex } from 'node:stream';

import {
  authorizePeer,
  DONATE_COMPUTE_SCOPE,
  isSharingActive,
  type ConsentLedger,
  type DonationConfig,
  type MeteringLedger,
  type RecipientPool,
} from './index.js';
import type {
  Chain,
  PaymentLedger,
  PaymentProof,
  PaymentTerms,
  Wallet,
} from './payment.js';

/* -------------------------------------------------------------------------- */
/* Topic derivation                                                           */
/* -------------------------------------------------------------------------- */

/** Namespace prefix so vibedonate topics never collide with other DHT traffic. */
export const TOPIC_PREFIX = 'vibedonate:';

/**
 * Stable, deterministic public label for a recipient pool. Everyone who builds
 * the SAME {@link RecipientPool} computes the SAME key, so they hash to the
 * same DHT topic. Pure.
 *
 * - `open`                   → `"open"`
 * - `org:id`                 → `"org:id"`
 * - `allowlist:a,b`          → `"allowlist:a,b"` (members sorted → stable)
 */
export function poolTopicKey(pool: RecipientPool): string {
  switch (pool.kind) {
    case 'open':
      return 'open';
    case 'org':
      return `org:${pool.id}`;
    case 'allowlist':
      // Sort so any member set {b,a} and {a,b} share a topic.
      return `allowlist:${[...pool.peers].sort().join(',')}`;
  }
}

/**
 * Derive the 32-byte DHT topic for a pool. Deterministic: everyone on the pool
 * anywhere in the world hashes to the same topic — that IS the discovery
 * mechanism. Pure.
 */
export function poolTopic(pool: RecipientPool): Buffer {
  // Shared derivation (vibe-core/ids topicFor) — byte-identical to the raw
  // sha256(prefix+key).digest() this used to compute, so live pool topics
  // are unchanged. Namespace stays vibedonate's policy.
  return topicFor(TOPIC_PREFIX, poolTopicKey(pool));
}

/* -------------------------------------------------------------------------- */
/* Wire frames (newline-JSON, allow-listed, capped)                           */
/* -------------------------------------------------------------------------- */

/** Defensive caps so a hostile/buggy peer can't make us retain junk. */
export const MAX_HANDLE_LEN = 64;
export const MAX_POOL_LEN = 96;
export const MAX_TIER_LEN = 32;
export const MAX_ID_LEN = 64;
export const MAX_PROMPT_LEN = 8_000;
export const MAX_OUTPUT_LEN = 16_000;
export const MAX_REASON_LEN = 256;
/** Max length of an advertised on-chain receiving address (`payTo`). */
export const MAX_ADDR_LEN = 64;
/** Max length of a settlement reference (`txRef`: on-chain hash or `stub:…`). */
export const MAX_TXREF_LEN = 128;
/** Max length of an optional payment signature. */
export const MAX_SIG_LEN = 256;
/**
 * Per-line ceiling sized to admit the LARGEST legal frame after JSON escaping
 * (worst case every char is escaped → ~2×). Generous slack on top.
 */
const MAX_FRAME_LEN = Math.max(MAX_PROMPT_LEN, MAX_OUTPUT_LEN) * 2 + 2_048;

/** The ONLY three frames on the wire. `hello` is frame #1 on every connection. */
export type Frame =
  | {
      readonly t: 'hello';
      readonly handle: string;
      readonly pool: string;
      readonly capacityTier: string;
      /**
       * Present ONLY when the donor charges per job (x402). Advertises the price
       * + receiving address — never raw usage. Absent on a FREE donor.
       */
      readonly priceUsdc?: number;
      readonly payTo?: string;
      readonly chain?: Chain;
    }
  | {
      readonly t: 'job';
      readonly id: string;
      readonly prompt: string;
      /** Present ONLY when paying a priced donor. A {@link PaymentProof}; no usage. */
      readonly payment?: PaymentProof;
    }
  | {
      readonly t: 'result';
      readonly id: string;
      readonly output: string;
      readonly denied?: true;
      readonly reason?: string;
    };

/** Convenience alias for the handshake frame (the only thing that identifies a peer). */
export type PeerHello = Extract<Frame, { t: 'hello' }>;

/**
 * Serialize a frame to one JSON line. Built key-by-key from the allow-list per
 * type — even if a caller sneaks extra properties onto the object, they cannot
 * leak onto the wire (same rigor as vibedating's serializeHandshake).
 */
export function serializeFrame(f: Frame): string {
  switch (f.t) {
    case 'hello': {
      // Built key-by-key from the allow-list — extra caller props can't leak.
      const base: Record<string, unknown> = {
        t: 'hello',
        handle: f.handle,
        pool: f.pool,
        capacityTier: f.capacityTier,
      };
      // Advertise payment terms ONLY when the donor is priced. Never raw usage.
      if (typeof f.priceUsdc === 'number' && f.priceUsdc > 0) {
        base['priceUsdc'] = f.priceUsdc;
        if (typeof f.payTo === 'string' && f.payTo.length > 0) base['payTo'] = f.payTo;
        if (typeof f.chain === 'string') base['chain'] = f.chain;
      }
      return JSON.stringify(base);
    }
    case 'job': {
      const base: Record<string, unknown> = { t: 'job', id: f.id, prompt: f.prompt };
      // Attach payment proof ONLY when present (priced donor). No usage data.
      if (f.payment !== undefined) {
        const p: Record<string, unknown> = {
          payer: f.payment.payer,
          amountUsdc: f.payment.amountUsdc,
          txRef: f.payment.txRef,
        };
        if (typeof f.payment.sig === 'string') p['sig'] = f.payment.sig;
        base['payment'] = p;
      }
      return JSON.stringify(base);
    }
    case 'result': {
      // Optional denied/reason are only emitted when present, never as `undefined`.
      const base: Record<string, unknown> = { t: 'result', id: f.id, output: f.output };
      if (f.denied === true) base['denied'] = true;
      if (typeof f.reason === 'string' && f.reason.length > 0) base['reason'] = f.reason;
      return JSON.stringify(base);
    }
  }
}

/**
 * Parse one incoming line. Returns `null` for anything malformed (oversized,
 * bad JSON, non-object, unknown type, wrong field shape). The result is built
 * key-by-key from the allow-list, so any extra fields a peer sends — in
 * particular any raw-usage / system field — are ignored and never retained.
 */
export function parseFrame(raw: string | Buffer): Frame | null {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.length > MAX_FRAME_LEN) return null;
  let d: unknown;
  try {
    d = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return null;
  const r = d as Record<string, unknown>;
  switch (r['t']) {
    case 'hello': {
      const handle = r['handle'];
      const pool = r['pool'];
      const tier = r['capacityTier'];
      if (typeof handle !== 'string' || handle.length === 0 || handle.length > MAX_HANDLE_LEN) return null;
      if (typeof pool !== 'string' || pool.length === 0 || pool.length > MAX_POOL_LEN) return null;
      const capacityTier =
        typeof tier === 'string' && tier.length > 0 && tier.length <= MAX_TIER_LEN ? tier : 'compute';
      // OPTIONAL x402 payment terms — accepted only when well-formed + priced.
      // A FREE donor's hello stays exactly {t,handle,pool,capacityTier}.
      const priceUsdc = r['priceUsdc'];
      if (typeof priceUsdc === 'number' && Number.isFinite(priceUsdc) && priceUsdc > 0) {
        const payTo = r['payTo'];
        const chain = r['chain'];
        return {
          t: 'hello',
          handle,
          pool,
          capacityTier,
          priceUsdc,
          ...(typeof payTo === 'string' && payTo.length > 0 && payTo.length <= MAX_ADDR_LEN ? { payTo } : {}),
          ...(chain === 'base' || chain === 'ethereum' || chain === 'polygon' ? { chain } : {}),
        };
      }
      return { t: 'hello', handle, pool, capacityTier };
    }
    case 'job': {
      const id = r['id'];
      const prompt = r['prompt'];
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN) return null;
      if (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_LEN) return null;
      // OPTIONAL payment proof — accepted only when well-formed. No usage data.
      const payment = parsePaymentProofField(r['payment']);
      return payment === null
        ? { t: 'job', id, prompt }
        : { t: 'job', id, prompt, payment };
    }
    case 'result': {
      const id = r['id'];
      const output = r['output'];
      const denied = r['denied'];
      const reason = r['reason'];
      if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LEN) return null;
      if (typeof output !== 'string' || output.length > MAX_OUTPUT_LEN) return null;
      // Only an explicit `true` denied flag survives; anything else is dropped.
      if (denied !== undefined && denied !== true) return null;
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > MAX_REASON_LEN)) {
        return null;
      }
      return {
        t: 'result',
        id,
        output,
        ...(denied === true ? { denied: true } : {}),
        ...(typeof reason === 'string' ? { reason } : {}),
      };
    }
    default:
      return null;
  }
}

/**
 * Pull a {@link PaymentProof} out of an incoming `job` frame's `payment` field.
 * Returns `null` for anything malformed — built key-by-key from the allow-list
 * so extra fields a peer sneaks onto the proof are dropped (no raw-usage leak).
 */
function parsePaymentProofField(raw: unknown): PaymentProof | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const payer = r['payer'];
  const amountUsdc = r['amountUsdc'];
  const txRef = r['txRef'];
  const sig = r['sig'];
  if (typeof payer !== 'string' || payer.length === 0 || payer.length > MAX_HANDLE_LEN) return null;
  if (typeof amountUsdc !== 'number' || !Number.isFinite(amountUsdc) || amountUsdc <= 0) return null;
  if (typeof txRef !== 'string' || txRef.length === 0 || txRef.length > MAX_TXREF_LEN) return null;
  if (sig !== undefined && (typeof sig !== 'string' || sig.length > MAX_SIG_LEN)) return null;
  return { payer, amountUsdc, txRef, ...(typeof sig === 'string' ? { sig } : {}) };
}

/** Random 32-byte topic for tests/local experiments — never a real pool topic. */
export function randomTopic(): Buffer {
  return randomBytes(32);
}

/** Random job id (16 hex chars, well under {@link MAX_ID_LEN}). */
function randomJobId(): string {
  return randomBytes(8).toString('hex');
}

/** One-line privacy notice the CLI prints before joining the mesh as a donor. */
export const SHARE_NOTICE =
  'sharing compute on the mesh: announcing only your handle + pool + tier (never raw usage) to same-pool peers on the public DHT';

/* -------------------------------------------------------------------------- */
/* Local model stub (v0: deterministic, no real LLM)                          */
/* -------------------------------------------------------------------------- */

/**
 * What a completed local job produced. `tokens` is the deterministic cost
 * recorded in the metering ledger (counts against the daily cap).
 */
export interface LocalModelResult {
  readonly output: string;
  readonly tokens: number;
}

/**
 * A pluggable on-device model. v0 ships only the deterministic stub below; a
 * real local runner (Ollama / llama.cpp / the @vibe-core cascade) can implement
 * this interface and drop in without touching the transport.
 */
export interface LocalModel {
  /** Stable id stamped onto metering receipts (e.g. 'echo-stub'). */
  readonly id: string;
  /** Run a prompt locally and deterministically. No network. */
  run(prompt: string): LocalModelResult;
}

/** Default deterministic per-job token cost — keeps cap arithmetic clean + predictable. */
export const DEFAULT_JOB_TOKEN_COST = 100;

/**
 * The v0 stub: REVERSES the prompt. Deterministic, content-free, obviously
 * local, and trivially assertable — exactly the "echo/reverse" placeholder the
 * brief asks for. No real LLM is integrated; the transport + gating is the
 * deliverable.
 *
 * @param cost tokens charged per job (defaults to {@link DEFAULT_JOB_TOKEN_COST}).
 */
export function createEchoModel(cost: number = DEFAULT_JOB_TOKEN_COST): LocalModel {
  const tokens = Math.max(1, Math.floor(cost));
  return {
    id: 'echo-stub',
    run(prompt) {
      // split('') to reverse by code unit; fine for ASCII test prompts.
      return { output: prompt.split('').reverse().join(''), tokens };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Shared connection plumbing                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A newline-delimited JSON line reader. Feeds whole lines to `onLine`; drops
 * empty lines. Used by both sides — framing is identical donor/consumer.
 */
function attachLineReader(socket: Duplex, onLine: (line: string) => void): void {
  let buf = '';
  socket.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() === '') continue;
      onLine(line);
    }
  });
}

/** Send our hello as frame #1 on a fresh connection. */
function sendHello(socket: Duplex, hello: PeerHello): void {
  socket.write(`${serializeFrame(hello)}\n`);
}

/* -------------------------------------------------------------------------- */
/* Donor side                                                                 */
/* -------------------------------------------------------------------------- */

export interface DonorOptions {
  /** This donor's handle (self-reported identity — see v0 limitation note below). */
  readonly handle: string;
  /** What we share: pool (auth), idle window, cap, enabled. */
  readonly config: DonationConfig;
  /** Must already hold the `donate:compute` grant or the donor refuses to join. */
  readonly consent: ConsentLedger;
  /** Append-only hash-chain ledger; completed jobs record a receipt here. */
  readonly ledger: MeteringLedger;
  /** Local model stub. Defaults to {@link createEchoModel}. */
  readonly model?: LocalModel;
  /**
   * x402 wallet. REQUIRED when `config.priceUsdc > 0` — it advertises `payTo`
   * (its address) in the donor hello and verifies incoming PaymentProofs.
   * Ignored for FREE donors (price 0).
   */
  readonly wallet?: Wallet;
  /**
   * Hash-chained ledger of received payments; records one entry per priced job
   * SERVED. Ignored for FREE donors; optional even when priced (in-memory only
   * if omitted).
   */
  readonly paymentLedger?: PaymentLedger;
  /** Override the joined topic (tests pass a random one on an isolated DHT). */
  readonly topic?: Buffer;
  /** DHT bootstrap nodes; omit for the public DHT. Tests pass a local testnet. */
  readonly bootstrap?: ReadonlyArray<{ readonly host: string; readonly port: number }>;
  /** Clock injection (tests fix time to assert window/cap behavior). */
  readonly now?: () => Date;
  /** True if local activity should pause donation. Defaults to never busy. */
  readonly systemBusy?: () => boolean;
}

export interface DonorSession {
  /** The 32-byte topic actually joined. */
  readonly topic: Buffer;
  /** What we broadcast on every connection. */
  readonly hello: PeerHello;
  /** Live peer set, keyed by the remote's public key (hex). */
  readonly peers: ReadonlyMap<string, PeerHello>;
  /** Counters observable for tests: jobs actually RUN vs DENIED. */
  readonly jobsRun: number;
  readonly jobsDenied: number;
  /** Resolves when the first DHT announce/lookup round for the topic completes. */
  readonly ready: Promise<unknown>;
  /** Leave the topic and destroy the node. Idempotent. */
  close(): Promise<void>;
}

/**
 * Join the swarm as a DONOR: announce capacity on the pool topic and serve jobs
 * from the local model stub. Refuses to join without the `donate:compute`
 * consent grant; re-checks consent + pool-auth + capacity on EVERY job before
 * any work runs.
 */
export async function startDonor(opts: DonorOptions): Promise<DonorSession> {
  const {
    handle,
    config,
    consent,
    ledger,
    model = createEchoModel(),
    now = () => new Date(),
    systemBusy = () => false,
    wallet,
    paymentLedger,
  } = opts;

  // CONSENT GATE AT JOIN — the caller (CLI) must already hold the grant, exactly
  // like vibedating's share:live gate lives with the caller. Throw rather than
  // silently announcing capacity the user never opted into.
  if (!consent.allows(DONATE_COMPUTE_SCOPE)) {
    throw new Error('donate:compute consent not granted — refusing to join the mesh as a donor');
  }
  // A PRICED donor (priceUsdc > 0) needs a wallet to advertise `payTo` and to
  // verify incoming PaymentProofs. FREE donors (price 0) need neither and take
  // the unchanged free path.
  if (config.priceUsdc > 0 && wallet === undefined) {
    throw new Error('a priced donor (priceUsdc > 0) needs a wallet to advertise payTo + verify payments');
  }

  const topic = opts.topic ?? poolTopic(config.pool);

  // x402: advertise payment terms ONLY when priced. A FREE donor's hello stays
  // exactly {t,handle,pool,capacityTier} — privacy-preserving by default.
  const terms: PaymentTerms | null =
    config.priceUsdc > 0 && wallet !== undefined
      ? { priceUsdc: config.priceUsdc, chain: config.chain, payTo: wallet.address() }
      : null;
  const hello: PeerHello =
    terms === null
      ? { t: 'hello', handle, pool: poolTopicKey(config.pool), capacityTier: config.tier }
      : {
          t: 'hello',
          handle,
          pool: poolTopicKey(config.pool),
          capacityTier: config.tier,
          priceUsdc: terms.priceUsdc,
          payTo: terms.payTo,
          chain: terms.chain,
        };

  // Lazy import so non-mesh commands (`status`, `mcp`, `--help`) never pay for
  // hyperswarm's native stack (udx/sodium) — it loads on first donor/consumer.
  const { default: Hyperswarm } = await import('hyperswarm');
  const swarm = new Hyperswarm(opts.bootstrap === undefined ? {} : { bootstrap: opts.bootstrap });
  await swarm.dht.fullyBootstrapped();

  const peers = new Map<string, PeerHello>();
  let jobsRun = 0;
  let jobsDenied = 0;

  swarm.on('connection', (socket: Duplex, info) => {
    const remoteKey = info.publicKey.toString('hex');
    sendHello(socket, hello);

    attachLineReader(socket, (line) => {
      const frame = parseFrame(line);
      if (frame === null) return; // malformed/unknown — drop, never crash
      if (frame.t === 'hello') {
        // Build the peer record from allow-listed fields only.
        const peer: PeerHello = { t: 'hello', handle: frame.handle, pool: frame.pool, capacityTier: frame.capacityTier };
        // A peer advertising a different pool on this topic is bogus — drop it.
        if (peer.pool !== hello.pool) return;
        peers.set(remoteKey, peer);
        return;
      }
      if (frame.t === 'job') {
        handleJob(socket, remoteKey, frame);
        return;
      }
      // result frames are unexpected on a donor socket — ignore.
    });
    socket.on('error', () => {
      /* peer vanished mid-stream — fine, the swarm retries on next round */
    });
  });

  /**
   * GATE + run, all on the donor. No work happens unless every gate is green.
   *
   * Gate order: handshake → consent → authorizePeer → PAYMENT (if priced) →
   * isSharingActive → run → record metering receipt AND (for priced jobs) a
   * payment record. Async because a real wallet's `verify` is async; the stub
   * resolves on the next microtask.
   */
  const handleJob = async (
    socket: Duplex,
    remoteKey: string,
    job: { readonly id: string; readonly prompt: string; readonly payment?: PaymentProof },
  ): Promise<void> => {
    const deny = (reason: string): void => {
      jobsDenied += 1;
      socket.write(`${serializeFrame({ t: 'result', id: job.id, output: '', denied: true, reason })}\n`);
    };

    // Identity comes from the AUTHENTICATED hello (frame #1), never from the job
    // frame (which has no handle field, so it can't be spoofed per-job).
    const peer = peers.get(remoteKey);
    if (peer === undefined) {
      deny('no handshake');
      return;
    }

    // GATE 1 — consent (re-checked per job so a mid-session `stop` revokes now).
    if (!consent.allows(DONATE_COMPUTE_SCOPE)) {
      deny('donor consent revoked (stopped)');
      return;
    }
    // GATE 2 — pool authorization (allow-list / org / open membership).
    if (authorizePeer(config, peer.handle) === 'deny') {
      deny(`peer "${peer.handle}" not authorized by the ${config.pool.kind} pool`);
      return;
    }
    // GATE 3 — PAYMENT (x402, only when priced). The proof must verify via the
    // wallet, be FROM this peer, and cover the advertised price. A missing or
    // invalid proof is denied 'payment required' BEFORE capacity is checked.
    if (terms !== null) {
      const proof = job.payment;
      if (proof === undefined || wallet === undefined) {
        deny('payment required');
        return;
      }
      const verified = await wallet.verify(proof);
      if (!verified || proof.payer !== peer.handle || proof.amountUsdc < terms.priceUsdc) {
        deny('payment required');
        return;
      }
    }
    // GATE 4 — capacity: enabled + inside idle window + under cap + not busy.
    const t = now();
    const donatedToday = ledger.totals(t).donatedToday;
    if (!isSharingActive(config, t, systemBusy(), donatedToday)) {
      if (donatedToday >= config.cap) {
        deny('donor over daily cap');
      } else if (systemBusy()) {
        deny('donor busy with local activity');
      } else if (!config.enabled) {
        deny('donor stopped');
      } else {
        deny(`donor outside idle window ${config.idle.start}-${config.idle.end}`);
      }
      return;
    }

    // ALL GREEN — run the local stub and record a hash-chained metering receipt.
    const result = model.run(job.prompt);
    ledger.record({
      peer: peer.handle,
      tokens: result.tokens,
      model: model.id,
      direction: 'donated',
    });
    // x402: also record the SETTLED payment (hash-chained, like the metering
    // ledger). Only a served priced job mints a payment record — so the ledger
    // is an audit trail of payments actually received for served compute.
    const payment = job.payment;
    if (terms !== null && payment !== undefined && paymentLedger !== undefined) {
      paymentLedger.record({
        peer: peer.handle,
        amountUsdc: payment.amountUsdc,
        direction: 'received',
        txRef: payment.txRef,
        ts: t.toISOString(),
      });
    }
    jobsRun += 1;
    socket.write(`${serializeFrame({ t: 'result', id: job.id, output: result.output })}\n`);
  };

  const discovery = swarm.join(topic, { server: true, client: true });
  const ready: Promise<unknown> = discovery.flushed().catch(() => undefined);
  await ready;

  // A bare swarm re-refreshes a topic only every ~10 minutes and its first
  // round can legitimately miss/error — re-run rounds on a short cadence so a
  // peer joining while we're online is noticed within seconds. (Same fix as
  // vibedating's startDiscovery.) unref so the timer never keeps the process
  // alive on its own.
  const refresher = setInterval(() => {
    void discovery.refresh({ server: true, client: true }).catch(() => {});
  }, REFRESH_INTERVAL_MS);
  refresher.unref();

  let closed = false;
  return {
    topic,
    hello,
    get peers() {
      return peers;
    },
    get jobsRun() {
      return jobsRun;
    },
    get jobsDenied() {
      return jobsDenied;
    },
    ready,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(refresher);
      try {
        await swarm.leave(topic);
      } catch {
        /* network already gone */
      }
      await swarm.destroy();
    },
  };
}

/** How often a session re-runs an announce/lookup round. */
const REFRESH_INTERVAL_MS = 5_000;

/* -------------------------------------------------------------------------- */
/* Consumer side                                                              */
/* -------------------------------------------------------------------------- */

export interface ConsumerOptions {
  /** This consumer's handle (what donors authorize against their pool). */
  readonly handle: string;
  /** Pool to join — topic derived from it; must match a donor's pool definition. */
  readonly pool: RecipientPool;
  /** Tier we say we want. Purely informational metadata in v0. */
  readonly capacityTier?: string;
  /**
   * x402 wallet used to PAY priced donors. When a targeted donor advertises a
   * price, the consumer charges `wallet.charge(handle, price)` and attaches the
   * resulting PaymentProof to the job. Omit to refuse payment (a priced donor
   * will then deny the job 'payment required').
   */
  readonly wallet?: Wallet;
  /**
   * Hash-chained ledger of payments SENT; records one entry per priced job that
   * actually succeeded. Optional (in-memory only if omitted).
   */
  readonly paymentLedger?: PaymentLedger;
  /** Override the joined topic (tests pass a random one on an isolated DHT). */
  readonly topic?: Buffer;
  /** DHT bootstrap nodes; omit for the public DHT. Tests pass a local testnet. */
  readonly bootstrap?: ReadonlyArray<{ readonly host: string; readonly port: number }>;
}

/** A donor's answer to a routed job. */
export interface JobResult {
  readonly output: string;
  /** Handle of the donor that produced the output (empty if all denied). */
  readonly donor: string;
  /** Present when every donor denied the job (no donor ran it). */
  readonly denied?: true;
  readonly reason?: string;
}

interface ReadyDonor {
  readonly hello: PeerHello;
  readonly socket: Duplex;
}

interface PendingRequest {
  readonly socket: Duplex;
  resolve(result: Extract<Frame, { t: 'result' }>): void;
  reject(err: Error): void;
}

export interface ConsumerSession {
  readonly topic: Buffer;
  readonly hello: PeerHello;
  readonly peers: ReadonlyMap<string, PeerHello>;
  readonly ready: Promise<unknown>;
  /**
   * Route a job to an AUTHORIZED, capacity-green donor. Tries currently-ready
   * donors in order (one outstanding job at a time → at most ONE receipt per
   * accepted job); returns the first non-denied result, else the denial.
   * Resolves to `null` only if no donor handshakes within the timeout.
   */
  request(prompt: string, opts?: { readonly timeoutMs?: number; readonly payUsdc?: number }): Promise<JobResult | null>;
  close(): Promise<void>;
}

/**
 * Join the swarm as a CONSUMER: look up donors on the pool topic, then route
 * jobs. The consumer holds no consent grant — it is requesting capacity, not
 * donating; the DONOR gates every job.
 */
export async function startConsumer(opts: ConsumerOptions): Promise<ConsumerSession> {
  const { handle, pool, capacityTier = 'compute', wallet, paymentLedger } = opts;
  const topic = opts.topic ?? poolTopic(pool);
  const hello: PeerHello = { t: 'hello', handle, pool: poolTopicKey(pool), capacityTier };

  const { default: Hyperswarm } = await import('hyperswarm');
  const swarm = new Hyperswarm(opts.bootstrap === undefined ? {} : { bootstrap: opts.bootstrap });
  await swarm.dht.fullyBootstrapped();

  const peers = new Map<string, PeerHello>();
  const donors = new Map<string, ReadyDonor>(); // remoteKey → live socket + hello
  // One outstanding job at a time (sequential routing) → at most one entry live.
  const pending = new Map<string, PendingRequest>();

  const resolvePending = (id: string, result: Extract<Frame, { t: 'result' }>): void => {
    const p = pending.get(id);
    if (p === undefined) return;
    pending.delete(id);
    p.resolve(result);
  };
  const rejectPendingForSocket = (socket: Duplex, err: Error): void => {
    for (const [id, p] of pending) {
      if (p.socket === socket) {
        pending.delete(id);
        p.reject(err);
      }
    }
  };

  swarm.on('connection', (socket: Duplex, info) => {
    const remoteKey = info.publicKey.toString('hex');
    sendHello(socket, hello);
    attachLineReader(socket, (line) => {
      const frame = parseFrame(line);
      if (frame === null) return;
      if (frame.t === 'hello') {
        // Preserve an advertised price (priceUsdc/payTo/chain) so request() knows
        // what to pay — a FREE donor's hello carries none of these.
        const peer: PeerHello = {
          t: 'hello',
          handle: frame.handle,
          pool: frame.pool,
          capacityTier: frame.capacityTier,
          ...(frame.priceUsdc !== undefined ? { priceUsdc: frame.priceUsdc } : {}),
          ...(frame.payTo !== undefined ? { payTo: frame.payTo } : {}),
          ...(frame.chain !== undefined ? { chain: frame.chain } : {}),
        };
        if (peer.pool !== hello.pool) return; // different pool on this topic → drop
        peers.set(remoteKey, peer);
        donors.set(remoteKey, { hello: peer, socket });
        return;
      }
      if (frame.t === 'result') {
        resolvePending(frame.id, frame);
        return;
      }
      // job frames are unexpected on a consumer socket — ignore.
    });
    socket.on('error', (err: NodeJS.ErrnoException) => rejectPendingForSocket(socket, err));
    socket.on('close', () => {
      donors.delete(remoteKey);
      rejectPendingForSocket(socket, new Error('donor disconnected'));
    });
  });

  const discovery = swarm.join(topic, { server: true, client: true });
  const ready: Promise<unknown> = discovery.flushed().catch(() => undefined);
  await ready;
  const refresher = setInterval(() => {
    void discovery.refresh({ server: true, client: true }).catch(() => {});
  }, REFRESH_INTERVAL_MS);
  refresher.unref();

  /**
   * Send a job to one donor and await its result (per-donor timeout). When the
   * donor is priced, charges the wallet and attaches a PaymentProof first; on a
   * SUCCESSFUL result records a 'sent' payment to the payment ledger.
   */
  const askDonor = async (
    donor: ReadyDonor,
    prompt: string,
    timeoutMs: number,
    payUsdc?: number,
  ): Promise<JobResult> => {
    const id = randomJobId();
    // x402: if this donor advertises a price, charge via the wallet and attach
    // a proof. No wallet / failed charge → no proof → a priced donor denies
    // 'payment required'; a FREE donor ignores payment entirely.
    let payment: PaymentProof | undefined;
    const priceUsdc = donor.hello.priceUsdc;
    if (typeof priceUsdc === 'number' && priceUsdc > 0) {
      const amount = payUsdc ?? priceUsdc;
      if (wallet !== undefined) {
        const r = await wallet.charge(handle, amount);
        if (r.paid && typeof r.txRef === 'string' && r.txRef.length > 0) {
          payment = { payer: handle, amountUsdc: amount, txRef: r.txRef };
        }
      }
    }
    return new Promise<JobResult>((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve({ output: '', donor: donor.hello.handle, denied: true, reason: 'timeout' });
      }, timeoutMs);
      pending.set(id, {
        socket: donor.socket,
        resolve: (result) => {
          clearTimeout(timer);
          // x402: record a 'sent' payment ONLY when the job actually succeeded.
          if (payment !== undefined && result.denied !== true && paymentLedger !== undefined) {
            paymentLedger.record({
              peer: donor.hello.handle,
              amountUsdc: payment.amountUsdc,
              direction: 'sent',
              txRef: payment.txRef,
            });
          }
          resolve({
            output: result.output,
            donor: donor.hello.handle,
            ...(result.denied === true ? { denied: true } : {}),
            ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
          });
        },
        reject: () => {
          clearTimeout(timer);
          resolve({ output: '', donor: donor.hello.handle, denied: true, reason: 'disconnected' });
        },
      });
      donor.socket.write(
        `${serializeFrame({ t: 'job', id, prompt, ...(payment !== undefined ? { payment } : {}) })}\n`,
      );
    });
  };

  /** Wait until at least `n` donors have handshaked, or the deadline passes. */
  const waitForDonors = async (n: number, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (donors.size < n && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  let closed = false;
  return {
    topic,
    hello,
    get peers() {
      return peers;
    },
    ready,
    async request(prompt, ropts = {}): Promise<JobResult | null> {
      const overallMs = ropts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const perDonorMs = Math.min(overallMs, PER_DONOR_TIMEOUT_MS);
      const payUsdc = ropts.payUsdc;
      // Give the swarm a beat to discover + handshake at least one donor.
      await waitForDonors(1, overallMs);
      if (donors.size === 0) return null;

      // Snapshot then try donors in order. Stop at the first non-denied answer;
      // a denial means that donor is not authorized/green/paid, so try the next.
      const snapshot = [...donors.values()];
      let last: JobResult | null = null;
      for (const donor of snapshot) {
        const result = await askDonor(donor, prompt, perDonorMs, payUsdc);
        last = result;
        if (result.denied !== true) return result; // landed on a green donor
      }
      return last; // every donor denied (or timed out)
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(refresher);
      try {
        await swarm.leave(topic);
      } catch {
        /* network already gone */
      }
      await swarm.destroy();
    },
  };
}

/** Default overall timeout for a single routed job (discovery + run). */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** Per-donor attempt timeout — a hung donor shouldn't block the whole request. */
const PER_DONOR_TIMEOUT_MS = 6_000;
