/**
 * Integration test: real hyperswarm nodes in ONE process on an isolated,
 * in-process DHT (hyperdht's createTestnet — the public DHT is never touched).
 *
 * Scaffold copied from the sibling vibedating repo's p2p.integration.test.ts:
 * createTestnet(3) bootstrap, lazy Hyperswarm import, waitFor pollers, fresh
 * tmp state per node.
 *
 * Covers the four behaviors the brief requires:
 *  (a) a consumer routes a job → it lands on an AUTHORIZED, capacity-green donor
 *      → correct output returns;
 *  (b) a metering receipt is recorded + the cap is decremented;
 *  (c) a peer NOT in the pool allow-list is DENIED (no job runs, no receipt);
 *  (d) a donor OVER CAP or STOPPED does not accept jobs.
 */
import createTestnet from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createConsentLedger,
  createDonationConfig,
  createMeteringLedger,
  createPaymentLedger,
  DONATE_COMPUTE_SCOPE,
  stubWallet,
  type ConsentLedger,
  type DonationConfig,
  type MeteringLedger,
  type PaymentLedger,
} from './index.js';
import {
  DEFAULT_JOB_TOKEN_COST,
  startConsumer,
  startDonor,
  type ConsumerSession,
  type DonorSession,
} from './mesh.js';

/** Always-active idle window so capacity is green regardless of test wall-clock. */
const ALWAYS = '00:00-00:00';

interface DonorBundle {
  readonly session: DonorSession;
  readonly ledger: MeteringLedger;
  readonly consent: ConsentLedger;
  readonly config: DonationConfig;
}

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

function makeConfig(opts: { pool?: string; cap?: number; enabled?: boolean; price?: number } = {}): DonationConfig {
  return createDonationConfig({
    idle: ALWAYS,
    cap: opts.cap ?? 1_000_000,
    pool: opts.pool ?? 'allowlist:alice,bob',
    enabled: opts.enabled ?? true,
    ...(opts.price === undefined ? {} : { price: opts.price }),
  });
}

describe('live compute mesh (in-process DHT, no public network)', () => {
  let testnet: Awaited<ReturnType<typeof createTestnet>>;
  let donors: DonorBundle[];
  let consumers: ConsumerSession[];

  beforeEach(async () => {
    testnet = await createTestnet(3);
    donors = [];
    consumers = [];
  }, 30_000);

  afterEach(async () => {
    for (const c of consumers) await c.close();
    for (const d of donors) await d.session.close();
    await testnet.destroy();
  }, 30_000);

  /** Spawn a donor that has ALREADY granted donate:compute (the caller gate). */
  async function spawnDonor(
    handle: string,
    config: DonationConfig,
  ): Promise<DonorBundle> {
    const consent = createConsentLedger();
    consent.grant(DONATE_COMPUTE_SCOPE);
    const ledger = createMeteringLedger(); // in-memory
    const session = await startDonor({
      handle,
      config,
      consent,
      ledger,
      bootstrap: testnet.bootstrap,
    });
    const bundle: DonorBundle = { session, ledger, consent, config };
    donors.push(bundle);
    return bundle;
  }

  async function spawnConsumer(handle: string, pool: string): Promise<ConsumerSession> {
    const session = await startConsumer({
      handle,
      pool: { kind: 'allowlist', peers: pool.split(',').map((s) => s.trim()) },
      bootstrap: testnet.bootstrap,
    });
    consumers.push(session);
    return session;
  }

  it('(a+b) routes a job to an authorized, capacity-green donor; output correct + receipt + cap decremented', async () => {
    // TWO authorized donors + the consumer (alice) they authorize.
    const d1 = await spawnDonor('donor1', makeConfig({ pool: 'allowlist:alice,bob' }));
    const d2 = await spawnDonor('donor2', makeConfig({ pool: 'allowlist:alice,bob' }));
    const alice = await spawnConsumer('alice', 'alice,bob');
    await Promise.all([d1.session.ready, d2.session.ready, alice.ready]);

    // Wait until alice sees a donor AND at least one donor has alice's hello,
    // so authorizePeer has a handle to check when the job lands.
    const discovered = await waitFor(
      () => alice.peers.size >= 1 && (d1.session.peers.size >= 1 || d2.session.peers.size >= 1),
      15_000,
    );
    expect(discovered).toBe(true);

    const result = await alice.request('hello world', { timeoutMs: 15_000 });
    expect(result).not.toBeNull();
    expect(result!.denied).toBeUndefined();
    // echo stub reverses the prompt.
    expect(result!.output).toBe('dlrow olleh');

    // Let any in-flight denial on the non-running donor settle.
    await waitFor(() => d1.session.jobsRun + d2.session.jobsRun === 1, 5_000);

    // EXACTLY ONE donor ran the job (sequential routing → one receipt total).
    const ran = [d1, d2].filter((d) => d.session.jobsRun === 1);
    const idle = [d1, d2].filter((d) => d.session.jobsRun === 0);
    expect(ran).toHaveLength(1);
    expect(idle).toHaveLength(1);

    // (b) metering receipt recorded on the running donor, cap decremented.
    const receipts = ran[0]!.ledger.all();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.peer).toBe('alice');
    expect(receipts[0]!.model).toBe('echo-stub');
    expect(receipts[0]!.tokens).toBe(DEFAULT_JOB_TOKEN_COST);
    expect(receipts[0]!.direction).toBe('donated');
    expect(ran[0]!.ledger.verify()).toBe(true); // hash-chain intact
    const cap = ran[0]!.config.cap;
    expect(ran[0]!.ledger.totals().donatedToday).toBe(DEFAULT_JOB_TOKEN_COST);
    expect(ran[0]!.ledger.remainingToday(cap)).toBe(cap - DEFAULT_JOB_TOKEN_COST);

    // The idle donor recorded nothing.
    expect(idle[0]!.ledger.all()).toHaveLength(0);
    expect(idle[0]!.session.jobsDenied).toBe(0);
  }, 30_000);

  it('(c) denies a peer NOT in the pool allow-list (no job runs, no receipt)', async () => {
    // Donor authorizes only alice,bob — eve is NOT a member.
    const d = await spawnDonor('donor1', makeConfig({ pool: 'allowlist:alice,bob' }));
    const eve = await spawnConsumer('eve', 'alice,bob'); // same topic, but eve isn't a member
    await Promise.all([d.session.ready, eve.ready]);

    const discovered = await waitFor(() => eve.peers.size >= 1, 15_000);
    expect(discovered).toBe(true);

    const result = await eve.request('let me in', { timeoutMs: 15_000 });
    expect(result).not.toBeNull();
    expect(result!.denied).toBe(true);
    expect(result!.reason).toMatch(/not authorized/);

    // No job ran and no receipt was recorded.
    await waitFor(() => d.session.jobsDenied >= 1, 5_000);
    expect(d.session.jobsRun).toBe(0);
    expect(d.ledger.all()).toHaveLength(0);
    expect(d.ledger.totals().donatedToday).toBe(0);
  }, 30_000);

  it('(d1) denies a job when the donor is OVER its daily cap', async () => {
    const cap = DEFAULT_JOB_TOKEN_COST; // one job's worth
    const d = await spawnDonor('donor1', makeConfig({ pool: 'allowlist:alice,bob', cap }));
    // Pre-fill the ledger to exactly the cap so isSharingActive is red on capacity.
    d.ledger.record({ peer: 'someone-else', tokens: cap, model: 'prefill', direction: 'donated' });
    expect(d.ledger.totals().donatedToday).toBe(cap);

    const alice = await spawnConsumer('alice', 'alice,bob');
    await Promise.all([d.session.ready, alice.ready]);
    await waitFor(() => alice.peers.size >= 1, 15_000);

    const result = await alice.request('please', { timeoutMs: 15_000 });
    expect(result!.denied).toBe(true);
    expect(result!.reason).toMatch(/cap/);

    await waitFor(() => d.session.jobsDenied >= 1, 5_000);
    expect(d.session.jobsRun).toBe(0); // over-cap donor accepted no new job
    // Still only the single pre-fill receipt — no new consumption recorded.
    expect(d.ledger.all()).toHaveLength(1);
    expect(d.ledger.totals().donatedToday).toBe(cap);
  }, 30_000);

  it('(d2) denies a job when the donor is STOPPED (consent revoked mid-session)', async () => {
    const d = await spawnDonor('donor1', makeConfig({ pool: 'allowlist:alice,bob' }));
    const alice = await spawnConsumer('alice', 'alice,bob');
    await Promise.all([d.session.ready, alice.ready]);
    await waitFor(() => alice.peers.size >= 1, 15_000);

    // `vibedonate stop` revokes the donate:compute grant; the per-job consent
    // gate must refuse immediately without re-joining.
    d.consent.revoke(DONATE_COMPUTE_SCOPE);
    expect(d.consent.allows(DONATE_COMPUTE_SCOPE)).toBe(false);

    const result = await alice.request('please', { timeoutMs: 15_000 });
    expect(result!.denied).toBe(true);
    expect(result!.reason).toMatch(/consent/);

    await waitFor(() => d.session.jobsDenied >= 1, 5_000);
    expect(d.session.jobsRun).toBe(0);
    expect(d.ledger.all()).toHaveLength(0);
  }, 30_000);

  it('refuses to JOIN as a donor without the donate:compute grant (caller gate)', async () => {
    const consent = createConsentLedger(); // NO grant
    await expect(
      startDonor({
        handle: 'rogue',
        config: makeConfig(),
        consent,
        ledger: createMeteringLedger(),
        bootstrap: testnet.bootstrap,
      }),
    ).rejects.toThrow(/consent/);
  }, 10_000);
});

describe('live compute mesh — x402 payment gate (priced donor, in-process DHT)', () => {
  interface PricedBundle {
    readonly session: DonorSession;
    readonly ledger: MeteringLedger;
    readonly paymentLedger: PaymentLedger;
    readonly consent: ConsentLedger;
  }
  let testnet: Awaited<ReturnType<typeof createTestnet>>;
  let pricedDonors: PricedBundle[];
  let consumers: ConsumerSession[];
  let consumerLedgers: PaymentLedger[];

  beforeEach(async () => {
    testnet = await createTestnet(3);
    pricedDonors = [];
    consumers = [];
    consumerLedgers = [];
  }, 30_000);

  afterEach(async () => {
    for (const c of consumers) await c.close();
    for (const d of pricedDonors) await d.session.close();
    await testnet.destroy();
  }, 30_000);

  /** Spawn a PRICED donor (price > 0): arms a stubWallet + paymentLedger. */
  async function spawnPricedDonor(
    handle: string,
    price: number,
    pool = 'allowlist:alice,bob',
  ): Promise<PricedBundle> {
    const consent = createConsentLedger();
    consent.grant(DONATE_COMPUTE_SCOPE);
    const ledger = createMeteringLedger();
    const paymentLedger = createPaymentLedger();
    const session = await startDonor({
      handle,
      config: makeConfig({ pool, price }),
      consent,
      ledger,
      wallet: stubWallet(handle),
      paymentLedger,
      bootstrap: testnet.bootstrap,
    });
    const bundle: PricedBundle = { session, ledger, paymentLedger, consent };
    pricedDonors.push(bundle);
    return bundle;
  }

  /** Spawn a FREE donor (price 0) that still carries a paymentLedger (must stay empty). */
  async function spawnFreeDonor(handle: string, pool = 'allowlist:alice,bob'): Promise<PricedBundle> {
    const consent = createConsentLedger();
    consent.grant(DONATE_COMPUTE_SCOPE);
    const ledger = createMeteringLedger();
    const paymentLedger = createPaymentLedger();
    const session = await startDonor({
      handle,
      config: makeConfig({ pool }), // price omitted → FREE
      consent,
      ledger,
      paymentLedger,
      bootstrap: testnet.bootstrap,
    });
    const bundle: PricedBundle = { session, ledger, paymentLedger, consent };
    pricedDonors.push(bundle);
    return bundle;
  }

  /** Spawn a consumer that CAN pay (arms a stubWallet + paymentLedger). */
  async function spawnPayingConsumer(
    handle: string,
    pool = 'alice,bob',
  ): Promise<{ session: ConsumerSession; ledger: PaymentLedger }> {
    const ledger = createPaymentLedger();
    const session = await startConsumer({
      handle,
      pool: { kind: 'allowlist', peers: pool.split(',').map((s) => s.trim()) },
      wallet: stubWallet(handle),
      paymentLedger: ledger,
      bootstrap: testnet.bootstrap,
    });
    consumers.push(session);
    consumerLedgers.push(ledger);
    return { session, ledger };
  }

  /** Spawn a consumer with NO wallet (cannot pay a priced donor). */
  async function spawnBrokeConsumer(handle: string, pool = 'alice,bob'): Promise<ConsumerSession> {
    const session = await startConsumer({
      handle,
      pool: { kind: 'allowlist', peers: pool.split(',').map((s) => s.trim()) },
      bootstrap: testnet.bootstrap,
    });
    consumers.push(session);
    return session;
  }

  /** Wait until BOTH sides have each other's hello (bidirectional handshake). */
  async function bothSeen(d: PricedBundle, c: { session: ConsumerSession } | ConsumerSession): Promise<boolean> {
    const cSession = 'session' in c ? c.session : c;
    return waitFor(
      () => cSession.peers.size >= 1 && d.session.peers.size >= 1,
      15_000,
    );
  }

  it('denies a priced job WITHOUT payment — no job runs, no receipt, no payment', async () => {
    const d = await spawnPricedDonor('donor1', 0.5);
    const alice = await spawnBrokeConsumer('alice'); // no wallet → can't pay
    await Promise.all([d.session.ready, alice.ready]);
    expect(await bothSeen(d, alice)).toBe(true);

    const result = await alice.request('let me in', { timeoutMs: 15_000 });
    expect(result).not.toBeNull();
    expect(result!.denied).toBe(true);
    expect(result!.reason).toMatch(/payment required/);

    await waitFor(() => d.session.jobsDenied >= 1, 5_000);
    expect(d.session.jobsRun).toBe(0);
    expect(d.ledger.all()).toHaveLength(0); // no metering receipt
    expect(d.paymentLedger.all()).toHaveLength(0); // no payment received
  }, 30_000);

  it('allows a priced job WITH a valid proof — output + metering receipt + payment recorded both sides', async () => {
    const d = await spawnPricedDonor('donor1', 0.5);
    const alice = await spawnPayingConsumer('alice');
    await Promise.all([d.session.ready, alice.session.ready]);
    expect(await bothSeen(d, alice)).toBe(true);

    const result = await alice.session.request('charge me', { timeoutMs: 15_000 });
    expect(result).not.toBeNull();
    expect(result!.denied).toBeUndefined();
    expect(result!.output).toBe('em egrahc'); // echo stub reverses the prompt

    await waitFor(() => d.session.jobsRun >= 1, 5_000);

    // Donor: BOTH a metering receipt AND a hash-chained payment record.
    expect(d.ledger.all()).toHaveLength(1);
    expect(d.ledger.all()[0]!.tokens).toBe(DEFAULT_JOB_TOKEN_COST);
    const received = d.paymentLedger.all();
    expect(received).toHaveLength(1);
    expect(received[0]!.peer).toBe('alice');
    expect(received[0]!.amountUsdc).toBe(0.5);
    expect(received[0]!.direction).toBe('received');
    expect(d.paymentLedger.verify()).toBe(true);

    // Consumer: a matching 'sent' payment record (same settlement txRef).
    const sent = alice.ledger.all();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.peer).toBe('donor1');
    expect(sent[0]!.amountUsdc).toBe(0.5);
    expect(sent[0]!.direction).toBe('sent');
    expect(alice.ledger.verify()).toBe(true);
    expect(sent[0]!.txRef).toBe(received[0]!.txRef);
  }, 30_000);

  it('leaves a FREE donor unchanged — a paying consumer charges nothing, no payment records', async () => {
    const d = await spawnFreeDonor('donor1');
    const alice = await spawnPayingConsumer('alice');
    await Promise.all([d.session.ready, alice.session.ready]);
    expect(await bothSeen(d, alice)).toBe(true);

    const result = await alice.session.request('free please', { timeoutMs: 15_000 });
    expect(result).not.toBeNull();
    expect(result!.denied).toBeUndefined();
    expect(result!.output).toBe('esaelp eerf');

    await waitFor(() => d.session.jobsRun >= 1, 5_000);
    expect(d.ledger.all()).toHaveLength(1); // metering receipt STILL recorded
    expect(d.paymentLedger.all()).toHaveLength(0); // but NO payment
    expect(alice.ledger.all()).toHaveLength(0); // consumer charged nothing
  }, 30_000);

  it('refuses to JOIN as a priced donor without a wallet (before any network)', async () => {
    const consent = createConsentLedger();
    consent.grant(DONATE_COMPUTE_SCOPE);
    await expect(
      startDonor({
        handle: 'rogue',
        config: makeConfig({ price: 0.25 }),
        consent,
        ledger: createMeteringLedger(),
        bootstrap: testnet.bootstrap,
      }),
    ).rejects.toThrow(/wallet/);
  }, 10_000);
});
