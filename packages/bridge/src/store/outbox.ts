import { RelayError, RelayUnreachable, type RelayClient } from '../relay-client/http.js';
import type { BridgeCache } from './cache.js';

let flushing: Promise<void> | undefined;

/**
 * Sends queued messages in order. Stops at the first network failure so order is kept; a message
 * the relay refuses is marked failed and reported by `check_inbox`, and the rest continue.
 */
export function flushOutbox(relay: RelayClient, cache: BridgeCache): Promise<void> {
  flushing ??= (async () => {
    try {
      for (const item of cache.outbox()) {
        if (item.error) continue;
        try {
          const change = await relay.submit(item.draft);
          cache.putThread(change.thread);
          cache.removeOutbox(item.id);
        } catch (error) {
          if (error instanceof RelayUnreachable) return;
          if (error instanceof RelayError) cache.markOutboxFailed(item.id, `${error.error.code}: ${error.error.message}`);
          else throw error;
        }
      }
    } finally {
      flushing = undefined;
    }
  })();
  return flushing;
}
