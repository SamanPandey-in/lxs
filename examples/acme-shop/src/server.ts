import express from 'express';
import decoys from '../decoy.config.js';

const app = express();

// Must be the first middleware: decoy paths are answered here and never reach the routes below.
app.use(decoys.express());

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/products', (_req, res) => {
  res.json([
    { id: 1, name: 'Espresso beans 1kg', price_cents: 2400 },
    { id: 2, name: 'Pour-over kettle', price_cents: 5900 },
  ]);
});

// The critical asset. The middleware reports a hit here only when the caller was already seen on a decoy.
app.get('/api/payments', (_req, res) => {
  res.json({ payments: [{ id: 'pay_1001', amount_cents: 2400, status: 'captured' }] });
});

app.post('/api/payments', (req, res) => {
  const { amount_cents = 0 } = (req.body ?? {}) as { amount_cents?: number };
  res.status(201).json({ id: 'pay_1002', amount_cents, status: 'pending' });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`acme-shop listening on :${port}`);
});
