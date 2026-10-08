// Shop API. Plain node:http, no dependencies. Run: node server.js
import { createServer } from 'node:http';
import { orders } from './data.js';

const PORT = Number(process.env.PORT ?? 3001);
const API_TOKEN = 'dev-token';
const ALLOWED_ORIGIN = 'http://localhost:5173';

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-headers': 'authorization, content-type',
  });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  if (req.headers.authorization !== `Bearer ${API_TOKEN}`) return send(res, 401, { error: 'unauthorized' });

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // GET /orders: every order, newest first.
  if (req.method === 'GET' && url.pathname === '/orders') {
    const items = [...orders].sort((a, b) => b.created_at.localeCompare(a.created_at));
    return send(res, 200, { items });
  }

  // GET /orders/:id
  const match = /^\/orders\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && match) {
    const order = orders.find((o) => o.order_id === match[1]);
    return order ? send(res, 200, order) : send(res, 404, { error: 'not found' });
  }

  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`Shop API on http://localhost:${PORT}`));
