export { TableRoom } from './room';

/**
 * The game worker only hosts the TableRoom Durable Object. It has no public
 * routes: players reach a room exclusively through the API worker, which
 * authenticates the session and forwards the WebSocket upgrade.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response('not found', { status: 404 });
  },
} satisfies ExportedHandler;
