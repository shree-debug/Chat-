// Durable Object: one instance per user; holds that user's live WebSocket connections (hibernation API).
export class Hub {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const [client, server] = Object.values(new WebSocketPair());
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (url.pathname === '/push' && req.method === 'POST') {
      const msg = await req.text(); let delivered = 0;
      for (const ws of this.state.getWebSockets()) { try { ws.send(msg); delivered++; } catch {} }
      return Response.json({ delivered });
    }
    return new Response('not found', { status: 404 });
  }
  webSocketMessage(ws, msg) { if (msg === 'ping') ws.send('pong'); }
}
