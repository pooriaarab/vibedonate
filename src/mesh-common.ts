import type { Duplex } from 'node:stream';
import { serializeFrame, type PeerHello } from './mesh-frames.js';

export function attachLineReader(socket: Duplex, onLine: (line: string) => void): void {
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
export function sendHello(socket: Duplex, hello: PeerHello): void {
  socket.write(`${serializeFrame(hello)}\n`);
}
export const REFRESH_INTERVAL_MS = 5_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const PER_DONOR_TIMEOUT_MS = 6_000;
