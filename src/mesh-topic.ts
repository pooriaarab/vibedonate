import { topicFor } from '@pooriaarab/vibe-core/ids';
import type { RecipientPool } from './donation-config.js';

export const TOPIC_PREFIX = 'vibedonate:';

export function poolTopicKey(pool: RecipientPool): string {
  switch (pool.kind) {
    case 'open': return 'open';
    case 'org': return `org:${pool.id}`;
    case 'allowlist': return `allowlist:${[...pool.peers].sort().join(',')}`;
  }
}

export function poolTopic(pool: RecipientPool): Buffer {
  return topicFor(TOPIC_PREFIX, poolTopicKey(pool));
}
