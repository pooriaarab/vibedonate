import type { Duplex } from 'node:stream';
import { authorizePeer, DONATE_COMPUTE_SCOPE, isSharingActive, type DonationConfig, type RecipientPool } from './donation-config.js';
import type { ConsentLedger } from '@pooriaarab/vibe-core';
import type { MeteringLedger } from './metering.js';
import { poolTopic, poolTopicKey } from './mesh-topic.js';
import { DEFAULT_JOB_TOKEN_COST, createEchoModel, type LocalModel } from './mesh-model.js';
import { REFRESH_INTERVAL_MS, attachLineReader, sendHello } from './mesh-common.js';
import { parseFrame, serializeFrame, type PeerHello } from './mesh-frames.js';
import type { PaymentLedger, PaymentProof, PaymentTerms, Wallet } from './payment.js';

export interface DonorOptions {
  readonly handle: string;
  readonly config: DonationConfig;
  readonly consent: ConsentLedger;
  readonly ledger: MeteringLedger;
  readonly model?: LocalModel;
  readonly wallet?: Wallet;
  readonly paymentLedger?: PaymentLedger;
  readonly topic?: Buffer;
  readonly bootstrap?: ReadonlyArray<{ readonly host: string; readonly port: number }>;
  readonly now?: () => Date;
  readonly systemBusy?: () => boolean;
}
export interface DonorSession {
  readonly topic: Buffer;
  readonly hello: PeerHello;
  readonly peers: ReadonlyMap<string, PeerHello>;
  readonly jobsRun: number;
  readonly jobsDenied: number;
  readonly ready: Promise<unknown>;
  close(): Promise<void>;
}
interface DonorCtx {
  readonly handle: string;
  readonly config: DonationConfig;
  readonly consent: ConsentLedger;
  readonly ledger: MeteringLedger;
  readonly model: LocalModel;
  readonly wallet?: Wallet;
  readonly paymentLedger?: PaymentLedger;
  readonly now: () => Date;
  readonly systemBusy: () => boolean;
  readonly hello: PeerHello;
  readonly terms: PaymentTerms | null;
  readonly peers: Map<string, PeerHello>;
  counters: { jobsRun: number; jobsDenied: number };
}

type JobPayload = { readonly id: string; readonly prompt: string; readonly payment?: PaymentProof };
type SwarmPeerInfo = { readonly publicKey: Buffer };
type DonorSwarm = {
  on(event: 'connection', listener: (socket: Duplex, info: SwarmPeerInfo) => void): void;
};
type DonorHyperswarm = DonorSwarm & {
  readonly dht: { fullyBootstrapped(): Promise<unknown> };
  join(topic: Buffer, opts: { server: boolean; client: boolean }): { flushed(): Promise<unknown>; refresh(opts: { server: boolean; client: boolean }): Promise<unknown> };
  leave(topic: Buffer): Promise<void>;
  destroy(): Promise<void>;
};

function buildDonorHello(handle: string, pool: RecipientPool, tier: string, terms: PaymentTerms | null): PeerHello {
  if (terms === null) return { t: 'hello', handle, pool: poolTopicKey(pool), capacityTier: tier };
  return { t: 'hello', handle, pool: poolTopicKey(pool), capacityTier: tier, priceUsdc: terms.priceUsdc, payTo: terms.payTo, chain: terms.chain };
}

function denyJob(ctx: DonorCtx, socket: Duplex, job: JobPayload, reason: string): void {
  ctx.counters.jobsDenied += 1;
  socket.write(`${serializeFrame({ t: 'result', id: job.id, output: '', denied: true, reason })}\n`);
}

function checkPeer(ctx: DonorCtx, remoteKey: string): PeerHello | null {
  return ctx.peers.get(remoteKey) ?? null;
}

function checkConsent(ctx: DonorCtx): boolean {
  return ctx.consent.allows(DONATE_COMPUTE_SCOPE);
}

function checkAuthorization(ctx: DonorCtx, peer: PeerHello): boolean {
  return authorizePeer(ctx.config, peer.handle) !== 'deny';
}

async function checkPayment(ctx: DonorCtx, job: JobPayload, peer: PeerHello): Promise<string | null> {
  if (ctx.terms === null) return null;
  const proof = job.payment;
  if (proof === undefined || ctx.wallet === undefined) return 'payment required';
  const verified = await ctx.wallet.verify(proof);
  if (!verified) return 'payment required';
  if (proof.payer !== peer.handle) return 'payment required';
  if (proof.amountUsdc < ctx.terms.priceUsdc) return 'payment required';
  return null;
}

function sharingDenyReason(ctx: DonorCtx, now: Date, donatedToday: number): string | null {
  if (isSharingActive(ctx.config, now, ctx.systemBusy(), donatedToday)) return null;
  if (donatedToday >= ctx.config.cap) return 'donor over daily cap';
  if (ctx.systemBusy()) return 'donor busy with local activity';
  if (!ctx.config.enabled) return 'donor stopped';
  return `donor outside idle window ${ctx.config.idle.start}-${ctx.config.idle.end}`;
}

function executeJob(ctx: DonorCtx, job: JobPayload, peer: PeerHello, socket: Duplex): void {
  const t = ctx.now();
  const donatedToday = ctx.ledger.totals(t).donatedToday;
  const reason = sharingDenyReason(ctx, t, donatedToday);
  if (reason !== null) {
    denyJob(ctx, socket, job, reason);
    return;
  }
  const result = ctx.model.run(job.prompt);
  ctx.ledger.record({ peer: peer.handle, tokens: result.tokens, model: ctx.model.id, direction: 'donated' });
  if (ctx.terms !== null && job.payment !== undefined && ctx.paymentLedger !== undefined) {
    ctx.paymentLedger.record({ peer: peer.handle, amountUsdc: job.payment.amountUsdc, direction: 'received', txRef: job.payment.txRef, ts: t.toISOString() });
  }
  ctx.counters.jobsRun += 1;
  socket.write(`${serializeFrame({ t: 'result', id: job.id, output: result.output })}\n`);
}

function createJobHandler(ctx: DonorCtx) {
  return async (socket: Duplex, remoteKey: string, job: JobPayload): Promise<void> => {
    const peer = checkPeer(ctx, remoteKey);
    if (peer === null) {
      denyJob(ctx, socket, job, 'no handshake');
      return;
    }
    if (!checkConsent(ctx)) {
      denyJob(ctx, socket, job, 'donor consent revoked (stopped)');
      return;
    }
    if (!checkAuthorization(ctx, peer)) {
      denyJob(ctx, socket, job, `peer "${peer.handle}" not authorized by the ${ctx.config.pool.kind} pool`);
      return;
    }
    const payReason = await checkPayment(ctx, job, peer);
    if (payReason !== null) {
      denyJob(ctx, socket, job, payReason);
      return;
    }
    executeJob(ctx, job, peer, socket);
  };
}

function handleHelloFrame(ctx: DonorCtx, remoteKey: string, frame: PeerHello): void {
  const peer: PeerHello = { t: 'hello', handle: frame.handle, pool: frame.pool, capacityTier: frame.capacityTier };
  if (peer.pool !== ctx.hello.pool) return;
  ctx.peers.set(remoteKey, peer);
}

function handleDonorLine(opts: { ctx: DonorCtx; remoteKey: string; socket: Duplex; handleJob: (s: Duplex, k: string, j: JobPayload) => Promise<void>; line: string }): void {
  const { ctx, remoteKey, socket, handleJob, line } = opts;
  const frame = parseFrame(line);
  if (frame === null) return;
  if (frame.t === 'hello') {
    handleHelloFrame(ctx, remoteKey, frame);
    return;
  }
  if (frame.t === 'job') {
    void handleJob(socket, remoteKey, frame);
  }
}

function setupDonorSwarm(swarm: DonorSwarm, ctx: DonorCtx, handleJob: (s: Duplex, k: string, j: JobPayload) => Promise<void>): void {
  swarm.on('connection', (socket: Duplex, info: SwarmPeerInfo) => {
    const remoteKey = info.publicKey.toString('hex');
    sendHello(socket, ctx.hello);
    attachLineReader(socket, (line) => {
      handleDonorLine({ ctx, remoteKey, socket, handleJob, line });
    });
    socket.on('error', () => {});
  });
}

function validateDonorStart(opts: DonorOptions): void {
  if (!opts.consent.allows(DONATE_COMPUTE_SCOPE)) throw new Error('donate:compute consent not granted — refusing to join the mesh as a donor');
  if (opts.config.priceUsdc > 0 && opts.wallet === undefined) throw new Error('a priced donor (priceUsdc > 0) needs a wallet to advertise payTo + verify payments');
}

function resolveDonorTerms(opts: DonorOptions): PaymentTerms | null {
  if (opts.config.priceUsdc > 0 && opts.wallet !== undefined) {
    return { priceUsdc: opts.config.priceUsdc, chain: opts.config.chain, payTo: opts.wallet.address() };
  }
  return null;
}

function createDonorSwarm(opts: DonorOptions): Promise<DonorHyperswarm> {
  return (async () => {
    const { default: Hyperswarm } = await import('hyperswarm');
    const swarm = new Hyperswarm(opts.bootstrap === undefined ? {} : { bootstrap: opts.bootstrap }) as unknown as DonorHyperswarm;
    await swarm.dht.fullyBootstrapped();
    return swarm;
  })();
}

export async function startDonor(opts: DonorOptions): Promise<DonorSession> {
  validateDonorStart(opts);
  const handle = opts.handle;
  const config = opts.config;
  const consent = opts.consent;
  const ledger = opts.ledger;
  const model = opts.model ?? createEchoModel();
  const now = opts.now ?? (() => new Date());
  const systemBusy = opts.systemBusy ?? (() => false);
  const topic = opts.topic ?? poolTopic(config.pool);
  const terms = resolveDonorTerms(opts);
  const hello = buildDonorHello(handle, config.pool, config.tier, terms);
  const swarm = await createDonorSwarm(opts);
  const peers = new Map<string, PeerHello>();
  const counters = { jobsRun: 0, jobsDenied: 0 };
  const ctx: DonorCtx = { handle, config, consent, ledger, model, wallet: opts.wallet, paymentLedger: opts.paymentLedger, now, systemBusy, hello, terms, peers, counters };
  const handleJob = createJobHandler(ctx);
  setupDonorSwarm(swarm, ctx, handleJob);
  const discovery = swarm.join(topic, { server: true, client: true });
  const ready: Promise<unknown> = discovery.flushed().catch(() => undefined);
  await ready;
  const refresher = setInterval(() => { void discovery.refresh({ server: true, client: true }).catch(() => {}); }, REFRESH_INTERVAL_MS);
  refresher.unref();
  let closed = false;
  return {
    topic, hello,
    get peers() { return peers; },
    get jobsRun() { return counters.jobsRun; },
    get jobsDenied() { return counters.jobsDenied; },
    ready,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(refresher);
      try { await swarm.leave(topic); } catch {}
      await swarm.destroy();
    },
  };
}
