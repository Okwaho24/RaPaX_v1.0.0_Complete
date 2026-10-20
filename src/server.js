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
import { startBackupScheduler, stopBackupScheduler } from './services/backupService.js';
import { getDbPath, closeDb } from './utils/db.js';
import fs from 'fs';

// Routes
import productRoutes  from './routes/products.js';
import purchaseRoutes from './routes/purchase.js';
import downloadRoutes from './routes/download.js';
import internalRoutes from './routes/internal.js';
import operatorRoutes from './routes/operator.js';
import webhookRoutes  from './routes/webhooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// Behind a reverse proxy (Railway) every visitor otherwise appears as the proxy's IP and all
// buyers share one rate-limit bucket. Number of trusted proxy hops; 0 disables (direct exposure).
app.set('trust proxy', Number.parseInt(process.env.TRUST_PROXY_HOPS ?? '1', 10));

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
  max: 20,
  message: { error: 'Too many purchase attempts.' },
});

// Order-status polling (the storefront polls every 5 s ≈ 12 req/min per open order).
const statusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many status checks — please slow down.' },
});

const operatorLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  message: { error: 'Too many operator requests.' },
});

// ── Rate limits, scoped per route group ───────────────────────────
// Each limiter is mounted on its own paths only. Mounting a limiter on '/api' would count every
// request in every group against it (downloads, operator calls and status polling would starve
// one another).
app.use(['/api/products', '/api/product', '/api/payment-methods', '/api/download'], publicLimiter);
app.post('/api/purchase/initiate', purchaseLimiter);
app.get('/api/purchase/status/:transaction_id', statusLimiter);
app.use(['/api/operator', '/api/internal'], operatorLimiter);

// ── Public Routes ─────────────────────────────────────────────────
app.use('/api', productRoutes);
app.use('/api', purchaseRoutes);
app.use('/api', downloadRoutes);

// ── Internal Routes (operator-auth protected) ─────────────────────
app.use('/api/internal', internalRoutes);
app.use('/api', operatorRoutes);

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
    if (bad.length) {
      console.error(`[RaPaX™] FATAL: ${bad.join(', ')} unset, default, or shorter than 16 chars. Refusing to start.`);
      process.exit(1);
    }
  }

  // 0b. Production safety: on Railway the DB must live inside the persistent volume
  const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (config.server.env === 'production' && volume) {
    const rel = path.relative(volume, getDbPath());
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      console.error(`[RaPaX™] WARNING: database ${getDbPath()} is NOT inside the persistent volume ${volume}. Data will be lost on redeploy. Set DB_PATH=${volume}/rapax.db`);
    }
  }

  // 1. Initialize DB (creates tables if not exist)
  await initDb();
  console.log(`[RaPaX™] Database: ${getDbPath()} (${fs.existsSync(getDbPath()) ? fs.statSync(getDbPath()).size : 0} bytes)`);

  // 2. Demo seed — NEVER in production unless explicitly requested
  if (config.server.env !== 'production' || process.env.SEED_DEMO === 'true') {
    await seedProducts();
  }

  // 3. Start payment poller
  startPaymentPoller();

  // 3b. Scheduled DB backups to R2
  startBackupScheduler();

  // 4. Start HTTP server
  const server = app.listen(config.server.port, '0.0.0.0', () => {
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

  // 5. Graceful shutdown (Railway sends SIGTERM on every redeploy)
  let stopping = false;
  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`[RaPaX™] ${sig} received — shutting down gracefully…`);
    stopBackupScheduler();
    const force = setTimeout(() => { console.error('[RaPaX™] Forced exit after 15s'); process.exit(1); }, 15000);
    force.unref();
    server.close(() => {
      try { closeDb(); } catch (e) { console.error('[RaPaX™] DB close error:', e.message); }
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

boot().catch((err) => {
  console.error('[RaPaX™] FATAL: boot failed:', err);
  process.exit(1);
});

export default app;
