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
import { startPaymentPoller } from './services/paymentPoller.js';

// Routes
import productRoutes  from './routes/products.js';
import purchaseRoutes from './routes/purchase.js';
import downloadRoutes from './routes/download.js';
import internalRoutes from './routes/internal.js';
import operatorRoutes from './routes/operator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ── Security & Middleware ─────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // relaxed for dashboard serving
}));
app.use(cors());
app.use(morgan(config.server.env === 'production' ? 'combined' : 'dev'));
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

// ── Serve Operator Dashboard (static SPA) ─────────────────────────
const dashboardPath = path.resolve(__dirname, '../dashboard/dist');
app.use('/dashboard', express.static(dashboardPath));
app.get('/dashboard/*', (req, res) => {
  res.sendFile(path.join(dashboardPath, 'index.html'));
});

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
  // 1. Initialize DB (creates tables if not exist)
  await initDb();

  // 2. Start payment poller
  startPaymentPoller();

  // 3. Start HTTP server
  app.listen(config.server.port, '0.0.0.0', () => {
    console.log(`\n ██████╗  █████╗ ██████╗  █████╗ ██╗  ██╗`);
    console.log(` ██╔══██╗██╔══██╗██╔══██╗██╔══██╗╚██╗██╔╝`);
    console.log(` ██████╔╝███████║██████╔╝███████║ ╚███╔╝ `);
    console.log(` ██╔══██╗██╔══██║██╔═══╝ ██╔══██║ ██╔██╗ `);
    console.log(` ██║  ██║██║  ██║██║     ██║  ██║██╔╝ ██╗`);
    console.log(` ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝`);
    console.log(`\n RaPaX™ — Sovereign Digital Vending Machine`);
    console.log(` Running on http://localhost:${config.server.port}`);
    console.log(` Dashboard: http://localhost:${config.server.port}/dashboard`);
    console.log(` Environment: ${config.server.env}\n`);
  });
}

boot();

export default app;
