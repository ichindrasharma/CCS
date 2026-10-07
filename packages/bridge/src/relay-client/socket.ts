import type { DeliveredEntry, ServerFrame } from '@tool/protocol';
import WebSocket from 'ws';
import type { BridgeCache } from '../store/cache.js';

/** Must match the relay's close code for a revoked membership. */
const CLOSE_REVOKED = 4001;

export interface SubscriptionOptions {
  relayUrl: string;
  token: string;
  memberId: string;
  cache: BridgeCache;
  /** Called with entries this bridge had not seen before, after they are stored. */
  onEntries: (fresh: DeliveredEntry[]) => void;
  /** Called after every successful (re)connect; the bridge flushes its outbox here. */
  onConnected?: () => void;
  onRevoked?: () => void;
}

/**
 * Keeps one WebSocket to the relay open. On every connect it asks for entries after the cache's
 * cursor, so live delivery, reconnects and offline catch-up are the same path. Entries are stored
 * before they are acked, so a crash in between only causes a harmless redelivery.
 */
export class Subscription {
  private socket: WebSocket | undefined;
  private stopped = false;
  private retryMs = 1000;
  private timer: NodeJS.Timeout | undefined;
  private connectedOnce: Promise<void>;
  private markConnected!: () => void;

  constructor(private readonly options: SubscriptionOptions) {
    this.connectedOnce = new Promise((resolve) => (this.markConnected = resolve));
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Resolves after the first `hello`; useful for tests and startup logs. */
  ready(): Promise<void> {
    return this.connectedOnce;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.close(1000, 'Bridge stopping');
  }

  private connect(): void {
    const { relayUrl, token, cache } = this.options;
    const url = `${relayUrl.replace(/^http/, 'ws')}/ws?after=${cache.cursor()}`;
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    this.socket = socket;

    socket.on('message', (raw) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(raw.toString()) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === 'hello') {
        this.retryMs = 1000;
        this.markConnected();
        this.options.onConnected?.();
      } else if (frame.type === 'entries') {
        const fresh = cache.storeDelivered(frame.entries, this.options.memberId);
        const last = frame.entries.at(-1);
        if (last && socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'ack', seq: last.entry.seq }));
        if (fresh.length > 0) this.options.onEntries(fresh);
      }
    });

    socket.on('close', (code) => {
      if (code === CLOSE_REVOKED) {
        this.stopped = true;
        this.options.onRevoked?.();
        return;
      }
      this.scheduleReconnect();
    });
    // 'close' follows 'error'; listening here only stops an unhandled-error crash.
    socket.on('error', () => {});
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
  }
}
