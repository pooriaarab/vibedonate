/**
 * @pooriaarab/vibedonate — BitTorrent-style mesh for AI inference.
 * v0 ships the SAFE tier only: local compute donated from your own machine.
 */
import {
  badge,
  createCascade,
  createConsentLedger,
  createHookBus,
  localRunners,
  makeEvent,
  mapSignalToKind,
  notify,
  pickLocalRunner,
  realDeps,
  tierChip,
} from '@pooriaarab/vibe-core';
import type {
  AsyncHookBus,
  Capability,
  Cascade,
  CascadeDeps,
  CascadeRequest,
  CascadeTier,
  ConsentGrant,
  ConsentLedger,
  ConsentScope,
  ConsentStore,
  HookBus,
  HookBusOptions,
  HookHandler,
  LocalRunner,
  ProviderAdapter,
  ResolvedProvider,
  SystemDeps,
  TriggerKind,
  VibeEvent,
} from '@pooriaarab/vibe-core';

export {
  badge,
  createCascade,
  createConsentLedger,
  createHookBus,
  localRunners,
  makeEvent,
  mapSignalToKind,
  notify,
  pickLocalRunner,
  realDeps,
  tierChip,
};
export type {
  AsyncHookBus,
  Capability,
  Cascade,
  CascadeDeps,
  CascadeRequest,
  CascadeTier,
  ConsentGrant,
  ConsentLedger,
  ConsentScope,
  ConsentStore,
  HookBus,
  HookBusOptions,
  HookHandler,
  LocalRunner,
  ProviderAdapter,
  ResolvedProvider,
  SystemDeps,
  TriggerKind,
  VibeEvent,
};

export {
  createPaymentLedger,
  filePaymentStore,
  parsePriceUsdc,
  paymentsPath,
  stubWallet,
} from './payment.js';
export type {
  Chain,
  ChargeResult,
  PaymentDirection,
  PaymentLedger,
  PaymentProof,
  PaymentRecord,
  PaymentRecordInput,
  PaymentStore,
  PaymentTerms,
  PaymentTotals,
  Wallet,
} from './payment.js';

export {
  DONATE_COMPUTE_SCOPE,
  authorizePeer,
  createDonationConfig,
  isSharingActive,
  parseCap,
  parseIdleWindow,
  parsePool,
  toMinutes,
  withinIdleWindow,
} from './donation-config.js';
export type {
  CreateDonationConfigOpts,
  DonationConfig,
  DonationTier,
  IdleWindow,
  RecipientPool,
} from './donation-config.js';

export {
  configPath,
  consentPath,
  createMeteringLedger,
  defaultDataDir,
  fileConsentStore,
  fileMeteringStore,
  loadConfigFromFile,
  meteringPath,
  saveConfigToFile,
} from './metering.js';
export type {
  MeteringLedger,
  MeteringStore,
  MeteringTotals,
  RecordInput,
  UsageReceipt,
} from './metering.js';

export { CHAT_CAPABILITY, createOllamaChatRunner, defaultChatRunners, resolveCompute } from './compute.js';
export type { ComputeResolution, ExecCapture, LabeledRunner, LocalComputeDeps } from './compute.js';

export { evaluateCapacity } from './capacity.js';
export type { CapacityContext, CapacityDecision, EvaluateCapacityOpts } from './capacity.js';

export { createLocalMeshRuntime } from './runtime.js';
export type { LocalMeshDeps, MeshRequest, MeshRuntime, MeshVerdict } from './runtime.js';

export { VIBEDONATE_AGENT, createDonationHooks, publishDonationEvent } from './events.js';
export type { DonationAction, DonationEventPayload, DonationHooks, DonationHooksOptions, PublishOptions } from './events.js';
