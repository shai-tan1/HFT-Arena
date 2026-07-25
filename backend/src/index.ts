/**
 * backend/src/index.ts — process entry point.
 */

import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { api } from './routes/api';
import { Gateway } from './realtime/gateway';

const PORT = Number(process.env.PORT ?? 4000);
const ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:5173';

const app = express();
app.use(cors({ origin: ORIGIN.split(',').map((s) => s.trim()) }));
app.use(express.json({ limit: '256kb' }));

app.use('/api', api);

const server = http.createServer(app);
const gateway = new Gateway(server);

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptimeSec: Math.floor(process.uptime()), ...gateway.stats() });
});

server.listen(PORT, () => {
  console.log(`HFT Arena backend on http://localhost:${PORT}  (ws: /ws)`);
  console.log(`CORS origin: ${ORIGIN}`);
});

// A match in flight is worth more than a fast shutdown. Stop accepting, let the
// event loop drain, then exit.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n${sig} — draining`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
