import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { hashSecret } from '../auth/secrets.js';
import type { Member, Store } from '../db/index.js';
import { ThreadService } from '../domain/thread-service.js';
import { DeliveryHub } from '../ws/hub.js';
import { HttpError, sendError } from './errors.js';
import { registerRoutes } from './routes.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The authenticated member; set on every route not marked `public`. */
    member: Member;
  }
  interface FastifyContextConfig {
    public?: boolean;
  }
}

export interface RelayApp {
  app: FastifyInstance;
  hub: DeliveryHub;
  service: ThreadService;
}

/** Builds the relay without listening, so tests can drive it with `inject` and `injectWS`. */
export async function buildRelay(store: Store, options: { logger?: FastifyServerOptions['logger'] } = {}): Promise<RelayApp> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1024 * 1024 });
  const service = new ThreadService(store);
  const hub = new DeliveryHub(store);

  app.decorateRequest('member', null as unknown as Member);

  // Bearer token on every route unless it is marked public. Runs before the WebSocket upgrade too.
  app.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions.config.public) return;
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
    const member = token ? store.members.findActiveByTokenHash(hashSecret(token)) : undefined;
    if (!member) return sendError(reply, new HttpError(401, 'UNAUTHORIZED', 'Missing, unknown or revoked member token.'));
    request.member = member;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return sendError(reply, error);
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return sendError(reply, new HttpError(status, 'INVALID_REQUEST', (error as Error).message));
    }
    request.log.error(error);
    return sendError(reply, new HttpError(500, 'INTERNAL', 'The relay hit an unexpected error.'));
  });

  app.setNotFoundHandler((request, reply) =>
    sendError(reply, new HttpError(404, 'NOT_FOUND', `No route ${request.method} ${request.url}.`)),
  );

  app.addHook('onClose', async () => hub.closeAll());

  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(async (scope) => registerRoutes(scope, { store, service, hub }));
  return { app, hub, service };
}
