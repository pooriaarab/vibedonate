import type { Duplex } from 'node:stream';
import { poolTopic, poolTopicKey } from './mesh-topic.js';
import { randomJobId } from './mesh-model.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, PER_DONOR_TIMEOUT_MS, REFRESH_INTERVAL_MS, attachLineReader, sendHello } from './mesh-common.js';
import { parseFrame, serializeFrame, type PeerHello } from './mesh-frames.js';
import type { RecipientPool } from './donation-config.js';
import type { PaymentLedger, PaymentProof, Wallet } from './payment.js';

export interface ConsumerOptions {
  readonly handle: string;
  readonly pool: RecipientPool;
  readonly capacityTier?: string;
  readonly wallet?: Wallet;
  readonly paymentLedger?: PaymentLedger;
  readonly topic?: Buffer;
  readonly bootstrap?: ReadonlyArray<{ readonly host: string; readonly port: number }>;
}
export interface JobResult { readonly output: string; readonly donor: string; readonly denied?: true; readonly reason?: string; }
interface ReadyDonor { readonly hello: PeerHello; readonly socket: Duplex; }
interface PendingRequest { readonly socket: Duplex; resolve(result: Extract<import('./mesh-frames.js').Frame, { t: 'result' }>): void; reject(err: Error): void; }
export interface ConsumerSession {
  readonly topic: Buffer; readonly hello: PeerHello; readonly peers: ReadonlyMap<string, PeerHello>; readonly ready: Promise<unknown>;
  request(prompt: string, opts?: { readonly timeoutMs?: number; readonly payUsdc?: number }): Promise<JobResult | null>;
  close(): Promise<void>;
}

function createPendingMaps() {
  const pending = new Map<string, PendingRequest>();
  const resolvePending = (id: string, result: Extract<import('./mesh-frames.js').Frame, { t: 'result' }>): void => {
    const p = pending.get(id);
    if (p === undefined) return;
    pending.delete(id);
    p.resolve(result);
  };
  const rejectPendingForSocket = (socket: Duplex, err: Error): void => {
    for (const [id, p] of pending) if (p.socket === socket) { pending.delete(id); p.reject(err); }
  };
  return { pending, resolvePending, rejectPendingForSocket };
}

type ConsumerPeerInfo = { readonly publicKey: Buffer };
type ConsumerSwarm = { on(event: 'connection', listener: (socket: Duplex, info: ConsumerPeerInfo) => void): void };
interface ConsumerSwarmOpts { readonly swarm: ConsumerSwarm; readonly hello: PeerHello; readonly peers: Map<string, PeerHello>; readonly donors: Map<string, ReadyDonor>; readonly res: ReturnType<typeof createPendingMaps>; }
function setupConsumerSwarm(opts: ConsumerSwarmOpts): void {
  const { swarm, hello, peers, donors, res } = opts;
  swarm.on('connection', (socket: Duplex, info: ConsumerPeerInfo) => {
    const remoteKey = info.publicKey.toString('hex');
    sendHello(socket, hello);
    attachLineReader(socket, (line) => {
      const frame = parseFrame(line);
      if (frame === null) return;
      if (frame.t === 'hello') {
        const peer: PeerHello = { t: 'hello', handle: frame.handle, pool: frame.pool, capacityTier: frame.capacityTier, ...(frame.priceUsdc !== undefined ? { priceUsdc: frame.priceUsdc } : {}), ...(frame.payTo !== undefined ? { payTo: frame.payTo } : {}), ...(frame.chain !== undefined ? { chain: frame.chain } : {}) };
        if (peer.pool !== hello.pool) return;
        peers.set(remoteKey, peer);
        donors.set(remoteKey, { hello: peer, socket });
        return;
      }
      if (frame.t === 'result') { res.resolvePending(frame.id, frame); return; }
    });
    socket.on('error', (err: NodeJS.ErrnoException) => res.rejectPendingForSocket(socket, err));
    socket.on('close', () => { donors.delete(remoteKey); res.rejectPendingForSocket(socket, new Error('donor disconnected')); });
  });
}

interface AskDonorOpts { readonly donor: ReadyDonor; readonly prompt: string; readonly timeoutMs: number; readonly handle: string; readonly wallet?: Wallet; readonly paymentLedger?: PaymentLedger; readonly payUsdc?: number; readonly pending: Map<string, PendingRequest>; }
async function askDonor(opts: AskDonorOpts): Promise<JobResult> {
  const { donor, prompt, timeoutMs, handle, wallet, paymentLedger, payUsdc, pending } = opts;
  const id = randomJobId();
  let payment: PaymentProof | undefined;
  const priceUsdc = donor.hello.priceUsdc;
  if (typeof priceUsdc === 'number' && priceUsdc > 0) {
    const amount = payUsdc ?? priceUsdc;
    if (wallet !== undefined) {
      const r = await wallet.charge(handle, amount);
      if (r.paid && typeof r.txRef === 'string' && r.txRef.length > 0) payment = { payer: handle, amountUsdc: amount, txRef: r.txRef };
    }
  }
  return new Promise<JobResult>((resolve) => {
    const pMap = pending;
    const timer = setTimeout(() => { if (pMap.delete(id)) resolve({ output: '', donor: donor.hello.handle, denied: true, reason: 'timeout' }); }, timeoutMs);
    pMap.set(id, {
      socket: donor.socket,
      resolve: (result) => {
        clearTimeout(timer);
        if (payment !== undefined && result.denied !== true && paymentLedger !== undefined) {
          paymentLedger.record({ peer: donor.hello.handle, amountUsdc: payment.amountUsdc, direction: 'sent', txRef: payment.txRef });
        }
        resolve({ output: result.output, donor: donor.hello.handle, ...(result.denied === true ? { denied: true } : {}), ...(typeof result.reason === 'string' ? { reason: result.reason } : {}) });
      },
      reject: () => { clearTimeout(timer); resolve({ output: '', donor: donor.hello.handle, denied: true, reason: 'disconnected' }); },
    });
    donor.socket.write(`${serializeFrame({ t: 'job', id, prompt, ...(payment !== undefined ? { payment } : {}) })}\n`);
  });
}

export async function startConsumer(opts: ConsumerOptions): Promise<ConsumerSession> {
  const handle = opts.handle; const pool = opts.pool; const capacityTier = opts.capacityTier ?? 'compute';
  const topic = opts.topic ?? poolTopic(pool);
  const hello: PeerHello = { t: 'hello', handle, pool: poolTopicKey(pool), capacityTier };
  const { default: Hyperswarm } = await import('hyperswarm');
  const swarm = new Hyperswarm(opts.bootstrap === undefined ? {} : { bootstrap: opts.bootstrap });
  await swarm.dht.fullyBootstrapped();
  const peers = new Map<string, PeerHello>();
  const donors = new Map<string, ReadyDonor>();
  const pendingMaps = createPendingMaps();
  setupConsumerSwarm({ swarm, hello, peers, donors, res: pendingMaps });
  const discovery = swarm.join(topic, { server: true, client: true });
  const ready: Promise<unknown> = discovery.flushed().catch(() => undefined);
  await ready;
  const refresher = setInterval(() => { void discovery.refresh({ server: true, client: true }).catch(() => {}); }, REFRESH_INTERVAL_MS);
  refresher.unref();
  const waitForDonors = async (n: number, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (donors.size < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  };
  let closed = false;
  return {
    topic, hello,
    get peers() { return peers; },
    ready,
    async request(prompt, ropts = {}): Promise<JobResult | null> {
      const overallMs = ropts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const perDonorMs = Math.min(overallMs, PER_DONOR_TIMEOUT_MS);
      const payUsdc = ropts.payUsdc;
      await waitForDonors(1, overallMs);
      if (donors.size === 0) return null;
      const snapshot = [...donors.values()];
      let last: JobResult | null = null;
      for (const donor of snapshot) {
        const result = await askDonor({ donor, prompt, timeoutMs: perDonorMs, handle, wallet: opts.wallet, paymentLedger: opts.paymentLedger, payUsdc, pending: pendingMaps.pending });
        last = result;
        if (result.denied !== true) return result;
      }
      return last;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(refresher);
      try { await swarm.leave(topic); } catch {}
      await swarm.destroy();
    },
  };
}
