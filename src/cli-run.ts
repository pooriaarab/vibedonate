import { hostname } from 'node:os';
import { createConsentLedger } from '@pooriaarab/vibe-core';
import { createMeteringLedger, defaultDataDir, fileConsentStore, fileMeteringStore, loadConfigFromFile, saveConfigToFile } from './metering.js';
import { createPaymentLedger, filePaymentStore, stubWallet } from './payment.js';
import { DONATE_COMPUTE_SCOPE, isSharingActive } from './donation-config.js';
import { publishDonationEvent, resolveCompute } from './index.js';
import { parseArgs, type ParsedCommand } from './cli-parse.js';
import { HELP, VERSION, renderStatus, renderWallet } from './cli-render.js';

async function handleShare(cmd: Extract<ParsedCommand, { kind: 'share' }>, dir: string): Promise<number> {
  saveConfigToFile(cmd.config, dir);
  createConsentLedger(fileConsentStore(dir)).grant(DONATE_COMPUTE_SCOPE, 'vibedonate share');
  const ledger = createMeteringLedger(fileMeteringStore(dir));
  publishDonationEvent('share', { tier: cmd.config.tier });
  process.stdout.write(renderStatus({ config: cmd.config, donatedToday: 0, totals: { donated: 0, received: 0, count: 0 }, sharing: true, now: new Date() }));
  const { startDonor, SHARE_NOTICE, poolTopicKey } = await import('./mesh.js');
  process.stdout.write(`${SHARE_NOTICE}\n`);
  const session = await startDonor({ handle: cmd.handle, config: cmd.config, consent: createConsentLedger(fileConsentStore(dir)), ledger, wallet: stubWallet(cmd.handle), paymentLedger: createPaymentLedger(filePaymentStore(dir)) });
  process.stdout.write(`joined mesh as donor "${cmd.handle}" on pool "${poolTopicKey(cmd.config.pool)}" — Ctrl-C to stop.\n`);
  await new Promise<void>((resolve) => { const h = (): void => resolve(); process.once('SIGINT', h); process.once('SIGTERM', h); });
  await session.close();
  process.stdout.write('vibedonate donor stopped — left the mesh.\n');
  return 0;
}

async function handleStatus(dir: string): Promise<number> {
  const config = loadConfigFromFile(dir);
  const ledger = createMeteringLedger(fileMeteringStore(dir));
  const consent = createConsentLedger(fileConsentStore(dir));
  const now = new Date();
  const totals = ledger.totals(now);
  const localModel = await resolveCompute();
  const sharing = config !== null && consent.allows(DONATE_COMPUTE_SCOPE) && isSharingActive(config, now, false, totals.donatedToday);
  process.stdout.write(renderStatus({ config, donatedToday: totals.donatedToday, totals, sharing, now, localModel }));
  return 0;
}

function handleStop(dir: string): number {
  const config = loadConfigFromFile(dir);
  createConsentLedger(fileConsentStore(dir)).revoke(DONATE_COMPUTE_SCOPE);
  if (config !== null) saveConfigToFile({ ...config, enabled: false }, dir);
  publishDonationEvent('stop');
  process.stdout.write('vibedonate stopped — donation disabled and consent revoked.\n');
  return 0;
}

async function handleRequest(cmd: Extract<ParsedCommand, { kind: 'request' }>, dir: string): Promise<number> {
  const { startConsumer } = await import('./mesh.js');
  const session = await startConsumer({ handle: cmd.handle, pool: cmd.pool, wallet: stubWallet(cmd.handle), paymentLedger: createPaymentLedger(filePaymentStore(dir)) });
  try {
    const result = await session.request(cmd.prompt, { ...(cmd.timeoutMs === undefined ? {} : { timeoutMs: cmd.timeoutMs }), ...(cmd.payUsdc === undefined ? {} : { payUsdc: cmd.payUsdc }) });
    if (result === null) { process.stderr.write('vibedonate: no donor available on the pool\n'); return 1; }
    if (result.denied === true) { process.stderr.write(`vibedonate: request denied by donor "${result.donor}" — ${result.reason ?? 'unknown'}\n`); return 1; }
    process.stdout.write(`${result.output}\n`);
    return 0;
  } finally { await session.close(); }
}

function handleWallet(dir: string): number {
  const config = loadConfigFromFile(dir);
  const wallet = stubWallet(hostname());
  const ledger = createPaymentLedger(filePaymentStore(dir));
  process.stdout.write(renderWallet(wallet.address(), ledger.totals(), ledger.all(), config?.chain));
  return 0;
}

async function handleMcp(dir: string): Promise<number> {
  const { runMcpServer } = await import('./mcp.js');
  await runMcpServer(dir);
  return 0;
}

function printHelp(): number {
  process.stdout.write(HELP);
  return 0;
}

function printVersion(): number {
  process.stdout.write(`vibedonate ${VERSION}\n`);
  return 0;
}

type CliContext = { readonly dir: string; readonly cmd: ParsedCommand };

const CLI_HANDLERS: Record<ParsedCommand['kind'], (ctx: CliContext) => Promise<number> | number> = {
  help: () => printHelp(),
  version: () => printVersion(),
  share: (ctx) => handleShare(ctx.cmd as Extract<ParsedCommand, { kind: 'share' }>, ctx.dir),
  status: (ctx) => handleStatus(ctx.dir),
  stop: (ctx) => handleStop(ctx.dir),
  request: (ctx) => handleRequest(ctx.cmd as Extract<ParsedCommand, { kind: 'request' }>, ctx.dir),
  mcp: (ctx) => handleMcp(ctx.dir),
  wallet: (ctx) => handleWallet(ctx.dir),
};

function dispatchCommand(ctx: CliContext): Promise<number> | number {
  const handler = CLI_HANDLERS[ctx.cmd.kind];
  return handler(ctx);
}

function parseCommand(argv: readonly string[]): ParsedCommand | { readonly error: Error } {
  try {
    return parseArgs(argv);
  } catch (err) {
    return { error: err as Error };
  }
}

export interface RunCliOptions { readonly dir?: string; readonly argv?: readonly string[]; }

export async function runCli(options: RunCliOptions = {}): Promise<number> {
  const dir = options.dir ?? defaultDataDir();
  const argv = options.argv ?? process.argv.slice(2);
  const parsed = parseCommand(argv);
  if ('error' in parsed) {
    process.stderr.write(`vibedonate: ${parsed.error.message}\n`);
    return 2;
  }
  const result = dispatchCommand({ dir, cmd: parsed });
  return result;
}
