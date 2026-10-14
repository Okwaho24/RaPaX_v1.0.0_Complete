// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Operator Dashboard API Routes
//  All protected by operatorAuth except POST /operator/login
// ─────────────────────────────────────────────────────────────────
import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { operatorAuth, generateOperatorToken } from '../middleware/auth.js';
import { ProductModel } from '../models/productModel.js';
import { TransactionModel } from '../models/transactionModel.js';
import { DeliveryModel } from '../models/deliveryModel.js';
import { ExportService } from '../services/exportService.js';
import { config } from '../config/index.js';
import { uploadToR2, deleteFromR2 } from '../services/r2Service.js';
import { getDb } from '../utils/initDb.js';

const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

router.post('/operator/login', async (req, res) => {
  const { secret } = req.body;
  if (!secret) return res.status(400).json({ error: 'secret required' });

  const secretBuf   = Buffer.from(String(secret));
  const expectedBuf = Buffer.from(String(config.auth.operatorSecret));
  const valid =
    secretBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(secretBuf, expectedBuf);

  if (!valid) return res.status(401).json({ error: 'Invalid operator secret' });

  const token = generateOperatorToken();
  res.json({ success: true, token, expires_in: config.auth.jwtExpiresIn });
});

router.use(operatorAuth);

router.get('/operator/products', (req, res) => {
  try {
    res.json({ success: true, products: ProductModel.listAll() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/operator/products', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Product file is required' });

  const {
    name, description,
    price_btc, price_eth, price_sol, price_usdt, price_fiat,
    version, availability,
  } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });

  try {
    const ext    = path.extname(req.file.originalname);
    const safe   = path.basename(req.file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const r2Key  = `products/${safe}_${uuidv4()}${ext}`;
    await uploadToR2(r2Key, req.file.buffer, req.file.mimetype);

    const product = ProductModel.create({
      name,
      description:  description  || null,
      price_btc:    price_btc    ? parseFloat(price_btc)    : null,
      price_eth:    price_eth    ? parseFloat(price_eth)    : null,
      price_sol:    price_sol    ? parseFloat(price_sol)    : null,
      price_usdt:   price_usdt   ? parseFloat(price_usdt)   : null,
      price_fiat:   price_fiat   ? parseFloat(price_fiat)   : null,
      file_path:    r2Key,
      version:      version      || '1.0.0',
      availability: availability !== 'false' && availability !== '0',
    });
    res.status(201).json({ success: true, product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/operator/products/:id', (req, res) => {
  const product = ProductModel.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  try {
    const updated = ProductModel.update(req.params.id, req.body);
    res.json({ success: true, product: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/operator/products/:id/file', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'New file is required' });
  const product = ProductModel.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  try {
    // Delete old R2 object if it exists
    if (product.file_path && product.file_path.startsWith('products/')) {
      await deleteFromR2(product.file_path).catch(() => {});
    }
    const ext    = path.extname(req.file.originalname);
    const safe   = path.basename(req.file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const r2Key  = `products/${safe}_${uuidv4()}${ext}`;
    await uploadToR2(r2Key, req.file.buffer, req.file.mimetype);
    const updated = ProductModel.update(req.params.id, { file_path: r2Key });
    res.json({ success: true, product: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/operator/products/:id/toggle', (req, res) => {
  try {
    const product = ProductModel.toggleAvailability(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/operator/products/:id', (req, res) => {
  const product = ProductModel.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  ProductModel.delete(req.params.id);
  res.json({ success: true, message: 'Product deactivated' });
});

router.get('/operator/transactions', (req, res) => {
  const limit  = parseInt(req.query.limit  || '100', 10);
  const offset = parseInt(req.query.offset || '0',   10);
  res.json({ success: true, transactions: TransactionModel.listAll({ limit, offset }) });
});

router.get('/operator/deliveries', (req, res) => {
  res.json({ success: true, deliveries: DeliveryModel.listAll() });
});

router.get('/operator/logs', (req, res) => {
  try {
    const db = getDb();
    const { event_type, from, to, limit } = req.query;
    let   sql    = `SELECT * FROM audit_log WHERE 1=1`;
    const params = [];
    if (event_type) { sql += ` AND event_type=?`;  params.push(event_type); }
    if (from)       { sql += ` AND created_at>=?`; params.push(from); }
    if (to)         { sql += ` AND created_at<=?`; params.push(to); }
    sql += ` ORDER BY created_at DESC`;
    if (limit)      { sql += ` LIMIT ?`; params.push(parseInt(limit, 10)); }
    const logs = params.length ? db.prepare(sql).all(params) : db.prepare(sql).all();
    res.json({ success: true, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/operator/export/json', (req, res) => {
  try {
    const json = ExportService.asJson(req.query);
    res.setHeader('Content-Disposition', 'attachment; filename="rapax_audit.json"');
    res.setHeader('Content-Type', 'application/json');
    res.send(json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/operator/export/csv', async (req, res) => {
  try {
    const filePath = await ExportService.asCsv(req.query);
    res.download(filePath, 'rapax_audit.csv');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/operator/export/deliveries', (req, res) => {
  try {
    const log = ExportService.deliveryLog();
    res.setHeader('Content-Disposition', 'attachment; filename="rapax_deliveries.json"');
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(log, null, 2));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
