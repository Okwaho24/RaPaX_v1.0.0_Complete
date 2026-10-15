// ─────────────────────────────────────────────────────────────────
//  RaPaX™ — Product Model
// ─────────────────────────────────────────────────────────────────
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../utils/initDb.js';
import { auditLog, EventType } from '../utils/auditLogger.js';

const now = () => new Date().toISOString();

export const ProductModel = {

  create({ name, description, price_btc, price_eth, price_sol, price_usdt, price_xrp, price_cad,
           price_fiat = null, file_path, version = '1.0.0', availability = true }) {
    const db         = getDb();
    const product_id = uuidv4();
    const ts         = now();
    db.prepare(`
      INSERT INTO products
        (product_id,name,description,price_btc,price_eth,price_sol,price_usdt,price_xrp,price_cad,
         price_fiat,file_path,version,availability,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run([
      product_id, name, description ?? null,
      price_btc ?? null, price_eth ?? null, price_sol ?? null, price_usdt ?? null, price_xrp ?? null, price_cad ?? null,
      price_fiat ?? null, file_path, version, availability ? 1 : 0, ts, ts,
    ]);
    const product = ProductModel.findById(product_id);
    auditLog({ eventType: EventType.PRODUCT, productId: product_id,
               actor: 'operator', payload: { action: 'CREATE', product } });
    return product;
  },

  listPublic() {
    return getDb().prepare(`
      SELECT product_id,name,description,price_btc,price_eth,price_sol,price_usdt,price_xrp,price_cad,
             price_fiat,version,availability,created_at,updated_at
      FROM products WHERE availability=1 ORDER BY created_at DESC
    `).all();
  },

  listAll() {
    return getDb().prepare(
      `SELECT * FROM products ORDER BY created_at DESC`
    ).all();
  },

  findById(id) {
    return getDb().prepare(
      `SELECT * FROM products WHERE product_id=?`
    ).get([id]) ?? null;
  },

  findByIdPublic(id) {
    return getDb().prepare(`
      SELECT product_id,name,description,price_btc,price_eth,price_sol,price_usdt,price_xrp,price_cad,
             price_fiat,version,availability,created_at,updated_at
      FROM products WHERE product_id=?
    `).get([id]) ?? null;
  },

  update(productId, fields) {
    const allowed = ['name','description','price_btc','price_eth','price_sol',
                     'price_usdt','price_xrp','price_cad','price_fiat','file_path','version','availability'];
    const sets = [];
    const vals = [];
    for (const k of Object.keys(fields)) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k}=?`);
      vals.push(k === 'availability' ? (fields[k] ? 1 : 0) : fields[k]);
    }
    if (!sets.length) throw new Error('No valid fields to update');
    sets.push('updated_at=?');
    vals.push(now());
    vals.push(productId);
    getDb().prepare(`UPDATE products SET ${sets.join(',')} WHERE product_id=?`).run(vals);
    const product = ProductModel.findById(productId);
    auditLog({ eventType: EventType.PRODUCT, productId,
               actor: 'operator', payload: { action: 'UPDATE', fields, product } });
    return product;
  },

  toggleAvailability(productId) {
    const p = ProductModel.findById(productId);
    if (!p) return null;
    const newVal = p.availability ? 0 : 1;
    getDb().prepare(
      `UPDATE products SET availability=?,updated_at=? WHERE product_id=?`
    ).run([newVal, now(), productId]);
    return ProductModel.findById(productId);
  },

  delete(productId) {
    getDb().prepare(
      `UPDATE products SET availability=0,updated_at=? WHERE product_id=?`
    ).run([now(), productId]);
    auditLog({ eventType: EventType.PRODUCT, productId,
               actor: 'operator', payload: { action: 'DELETE' } });
  },
};
