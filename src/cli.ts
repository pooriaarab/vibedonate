#!/usr/bin/env node
export { parseArgs, parseChain, parseRequest, parseShare, takeFlagValue } from './cli-parse.js';
export { BADGE, HELP, VERSION, renderStatus, renderWallet } from './cli-render.js';
export { runCli, type RunCliOptions } from './cli-run.js';
export type { ParsedCommand } from './cli-types.js';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { runCli } from './cli-run.js';
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]); } catch { return false; }
}
if (isMainModule()) {
  runCli().then((code) => process.exit(code)).catch((err) => { process.stderr.write(`vibedonate: ${(err as Error).message}\n`); process.exit(1); });
}
