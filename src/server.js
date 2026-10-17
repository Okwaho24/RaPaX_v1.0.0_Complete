// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Server Entry Point
// ─────────────────────────────────────────────────────────────────
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

import { config } from './config/index.js';
import { initDb } from './utils/initDb.js';
import { seedProducts } from './utils/seedDb.js';
import { startPaymentPoller } from './services/paymentPoller.js';

// Routes
import productRoutes  from './routes/products.js';
import purchaseRoutes from './routes/purchase.js';
import downloadRoutes from './routes/download.js';
import internalRoutes from './routes/internal.js';
import operatorRoutes from './routes/operator.js';
import webhookRoutes  from './routes/webhooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ── Security & Middleware ─────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // relaxed for dashboard serving
}));
app.use(cors());
app.use(morgan(config.server.env === 'production' ? 'combined' : 'dev'));
// Webhooks need the RAW body → mounted before express.json()
app.use('/api', webhookRoutes);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting — public endpoints
const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
});

const purchaseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.PURCHASE_RATE_MAX || '20', 10),
  message: { error: 'Too many purchase attempts.' },
});

const operatorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  message: { error: 'Too many operator requests.' },
});

// ── Public Routes ─────────────────────────────────────────────────
app.use('/api', publicLimiter, productRoutes);
app.use('/api', purchaseLimiter, purchaseRoutes);
app.use('/api', publicLimiter, downloadRoutes);

// ── Internal Routes (operator-auth protected) ─────────────────────
app.use('/api/internal', operatorLimiter, internalRoutes);
app.use('/api', operatorLimiter, operatorRoutes);

// ── Serve Public Storefront ───────────────────────────────────────
const publicPath = path.resolve(__dirname, '../public');
app.use(express.static(publicPath));

// ── Serve Operator Dashboard ──────────────────────────────────────
const operatorHtml = path.resolve(__dirname, '../public/operator/index.html');
app.get('/operator', (req, res) => res.sendFile(operatorHtml));
app.get('/operator/', (req, res) => res.sendFile(operatorHtml));

// ── Health Check ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    service: 'RaPaX™',
    version: '1.0.0',
    time:    new Date().toISOString(),
  });
});

// ── 404 Handler ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ── Global Error Handler ──────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[RaPaX™] Unhandled error:', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Boot ──────────────────────────────────────────────────────────
async function boot() {
  // 0. Production safety: refuse to run with default / weak secrets
  if (config.server.env === 'production') {
    const weak = (v, dflt) => !v || v === dflt || String(v).length < 16;
    const bad = [];
    if (weak(config.auth.operatorSecret, 'rapax_operator_secret')) bad.push('OPERATOR_SECRET');
    if (weak(config.auth.jwtSecret, 'rapax_jwt_secret')) bad.push('JWT_SECRET');
    const isDefaultUrl = (v, d) => !v || v === d;
    if (!config.acerbe.apiKey || config.acerbe.apiKey.length < 32) bad.push('ACERBE_API_KEY (>=32 chars)');
    if (isDefaultUrl(process.env.ACERBE_BASE_URL, 'http://localhost:5000')) bad.push('ACERBE_BASE_URL');
    if (!config.lexforge.secret || config.lexforge.secret.length < 32) bad.push('RAPAX_WEBHOOK_SECRET (>=32 chars)');
    if (isDefaultUrl(process.env.LEXFORGE_BASE_URL, '')) bad.push('LEXFORGE_BASE_URL');
    for (const k of ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) if (!process.env[k]) bad.push(k);
    if (bad.length) {
      console.error(`[RaPaX™] FATAL: ${bad.join(', ')} unset, default, or too short. Refusing to start.`);
      process.exit(1);
    }
  }

  // 1. Initialize DB (creates tables if not exist)
  await initDb();

  // 2. Demo seed — NEVER in production unless explicitly requested
  if (config.server.env !== 'production' || process.env.SEED_DEMO === 'true') {
    await seedProducts();
  }

  // 3. Start payment poller
  startPaymentPoller();

  // 4. Start HTTP server
  app.listen(config.server.port, '0.0.0.0', () => {
    console.log(`\n ██████╗  █████╗ ██████╗  █████╗ ██╗  ██╗`);
    console.log(` ██╔══██╗██╔══██╗██╔══██╗██╔══██╗╚██╗██╔╝`);
    console.log(` ██████╔╝███████║██████╔╝███████║ ╚███╔╝ `);
    console.log(` ██╔══██╗██╔══██║██╔═══╝ ██╔══██║ ██╔██╗ `);
    console.log(` ██║  ██║██║  ██║██║     ██║  ██║██╔╝ ██╗`);
    console.log(` ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝`);
    console.log(`\n RaPaX™ — Sovereign Digital Vending Machine`);
    console.log(` Running on http://localhost:${config.server.port}`);
    console.log(` Operator:  http://localhost:${config.server.port}/operator`);
    console.log(` Environment: ${config.server.env}\n`);
  });
}

boot();

export default app;
