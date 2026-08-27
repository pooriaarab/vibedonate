import type { DonationConfig, RecipientPool } from './donation-config.js';
export type ParsedCommand =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'share'; readonly config: DonationConfig; readonly handle: string }
  | { readonly kind: 'status' }
  | { readonly kind: 'stop' }
  | { readonly kind: 'mcp' }
  | { readonly kind: 'request'; readonly prompt: string; readonly pool: RecipientPool; readonly handle: string; readonly timeoutMs?: number; readonly payUsdc?: number; }
  | { readonly kind: 'wallet' };
