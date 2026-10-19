export { TableRoom } from './room';
export { PresenceHub } from './presence';

/**
 * The game worker only hosts the TableRoom and PresenceHub Durable Objects. It
 * has no public routes: players reach a room exclusively through the API
 * worker, which authenticates the session and forwards the WebSocket upgrade
 * (and calls the presence hub for friends' status).
 */
export default {
  async fetch(): Promise<Response> {
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler;
