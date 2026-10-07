import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from './db/index.js';
import { buildRelay, type RelayApp } from './http/server.js';

export interface StartRelayOptions {
  port?: number;
  host?: string;
  /** Directory for relay.db; created if missing. */
  dataDir: string;
  logger?: boolean;
}

export const DEFAULT_RELAY_PORT = 4747;

/**
 * Starts a self-hosted relay (`tool relay start`). It speaks plain HTTP; put it behind a
 * TLS-terminating proxy, or on a private network, since the spec requires encrypted connections.
 */
export async function startRelay(options: StartRelayOptions): Promise<RelayApp & { url: string; stop: () => Promise<void> }> {
  mkdirSync(options.dataDir, { recursive: true });
  const store = openStore({ path: join(options.dataDir, 'relay.db') });
  const relay = await buildRelay(store, { logger: options.logger ?? true });
  const url = await relay.app.listen({ port: options.port ?? DEFAULT_RELAY_PORT, host: options.host ?? '0.0.0.0' });
  return {
    ...relay,
    url,
    stop: async () => {
      await relay.app.close();
      store.db.close();
    },
  };
}
