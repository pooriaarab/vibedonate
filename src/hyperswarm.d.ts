/**
 * Minimal local typings for the untyped (CJS) `hyperswarm` package and the
 * `hyperdht/testnet.js` helper used by the integration test. Only the surface
 * this repo actually consumes is declared; the real API is larger.
 *
 * Kept local (not @types) because DefinitelyTyped's @types/hyperswarm targets
 * the old v2 API (`announce`/`lookup`), which no longer matches v4.
 *
 * Copied verbatim from the sibling `vibedating` repo, whose live transport has
 * shipped against this exact shim — same versions, same surface.
 */
declare module 'hyperswarm' {
  import type { Duplex } from 'node:stream';

  namespace Hyperswarm {
    interface BootstrapNode {
      readonly host: string;
      readonly port: number;
    }

    interface Options {
      /** DHT bootstrap nodes; omit to use the public Holepunch bootstrap servers. */
      readonly bootstrap?: readonly BootstrapNode[];
      readonly seed?: Buffer;
      readonly maxPeers?: number;
    }

    /** Remote end of a `connection` event. */
    interface PeerInfo {
      readonly publicKey: Buffer;
    }

    /** Handle returned by {@link Hyperswarm.join}. */
    interface DiscoverySession {
      /** Resolves once the first announce/lookup round for the topic completes. */
      flushed(): Promise<unknown>;
      /** Re-run a discovery round now instead of waiting for the next refresh. */
      refresh(opts?: { server?: boolean; client?: boolean }): Promise<unknown>;
      destroy(): Promise<void>;
    }
  }

  class Hyperswarm {
    constructor(opts?: Hyperswarm.Options);
    readonly keyPair: { readonly publicKey: Buffer; readonly secretKey: Buffer };
    readonly dht: {
      /** Resolves once the node has queried its bootstrap nodes and has routes. */
      fullyBootstrapped(): Promise<unknown>;
    };
    join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): Hyperswarm.DiscoverySession;
    leave(topic: Buffer): Promise<void>;
    destroy(opts?: { force?: boolean }): Promise<void>;
    on(event: 'connection', listener: (socket: Duplex, info: Hyperswarm.PeerInfo) => void): this;
  }

  export = Hyperswarm;
}

declare module 'hyperdht/testnet.js' {
  namespace createTestnet {
    interface Testnet {
      readonly bootstrap: ReadonlyArray<{ readonly host: string; readonly port: number }>;
      createNode(opts?: Record<string, unknown>): unknown;
      destroy(): Promise<void>;
    }
  }

  /** Spin up an isolated, in-process DHT (no public network) for tests. */
  function createTestnet(size?: number, opts?: Record<string, unknown>): Promise<createTestnet.Testnet>;

  export = createTestnet;
}
