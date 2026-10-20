# RaPaX™ — Sovereign Digital Products Vending Machine

> Black. Gold. Sovereign.

---

## Architecture

```
rapax/
├── src/
│   ├── config/          — Central env-driven config
│   ├── middleware/       — Auth (JWT operator guard)
│   ├── models/           — DB models (SQLite via sql.js)
│   │   ├── productModel.js
│   │   ├── transactionModel.js
│   │   ├── paymentAddressModel.js
│   │   ├── fingerprintModel.js
│   │   └── deliveryModel.js
│   ├── routes/
│   │   ├── products.js
│   │   ├── purchase.js
│   │   ├── download.js
│   │   ├── internal.js
│   │   └── operator.js
│   ├── services/
│   │   ├── paymentService.js
│   │   ├── acerbeService.js
│   │   ├── deliveryService.js
│   │   ├── pipeline.js
│   │   ├── paymentPoller.js
│   │   └── exportService.js
│   ├── utils/
│   │   ├── initDb.js
│   │   ├── db.js
│   │   ├── seedDb.js
│   │   ├── ensureDirs.js
│   │   └── auditLogger.js
│   └── server.js
├── dashboard/dist/index.html
├── storage/products/
├── storage/fingerprinted/
├── logs/
├── .env.example
└── package.json
```

---

## Setup

```bash
npm install
cp .env.example .env
npm start
```

Dashboard: http://localhost:4000/dashboard
API: http://localhost:4000/api
Health: http://localhost:4000/health

> Windows: use http://127.0.0.1:4000 if localhost fails.

---

## Public API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/products | List all available products |
| GET | /api/product/:id | Single product |
| POST | /api/purchase/initiate | Start a purchase |
| GET | /api/purchase/status/:transaction_id | Poll status |
| GET | /api/download/:token | Secure file download |

---

## Internal API Endpoints (Operator Auth Required)

All internal routes mounted under /api/internal/

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/operator/login | Get operator JWT |
| POST | /api/internal/fingerprint | Trigger AcerbE fingerprinting |
| POST | /api/internal/payment/confirm | Confirm a payment |
| POST | /api/internal/delivery/issue | Issue a delivery link |

---

## Operator Dashboard API

All require Authorization: Bearer token

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/operator/products | All products |
| POST | /api/operator/products | Upload product |
| PATCH | /api/operator/products/:id | Update metadata |
| PATCH | /api/operator/products/:id/file | Replace file |
| PATCH | /api/operator/products/:id/toggle | Toggle availability |
| DELETE | /api/operator/products/:id | Soft delete |
| GET | /api/operator/transactions | All transactions |
| GET | /api/operator/deliveries | All deliveries |
| GET | /api/operator/logs | Audit log |
| GET | /api/operator/export/json | Export JSON |
| GET | /api/operator/export/csv | Export CSV |
| GET | /api/operator/export/deliveries | Export deliveries |

---

## End-to-End Flow

1. Buyer calls GET /api/products
2. Buyer calls POST /api/purchase/initiate - receives payment address
3. Buyer sends crypto to address
4. Poller detects payment on-chain (60s cron)
5. Transaction marked confirmed
6. Pipeline runs: AcerbE fingerprints asset, delivery token generated
7. Buyer polls status - sees download_link
8. Buyer calls GET /api/download/:token - receives asset
9. Transaction marked complete
10. All events logged in immutable audit_log

---

## AcerbE™ Integration

POST {ACERBE_BASE_URL}/fingerprint

Request: { product_id, buyer_wallet, timestamp, file_path }
Response: { fingerprint_id, fingerprinted_file_path, hash }

Dev fallback active when NODE_ENV != production.

---

## Security

- 96-character random hex download tokens - no file paths exposed
- Tokens expire (default 1 hour, DOWNLOAD_LINK_TTL in .env)
- Audit log append-only - no DELETE or UPDATE ever
- Fingerprinted assets stored separately
- Unique payment address per transaction
- JWT protection on all operator endpoints
- Rate limiting: 300 req/15min public, 20 req/min purchase
- Helmet security headers

---

## Database

sql.js - SQLite compiled to WebAssembly. No native compilation required. Node.js 18+ only.

- DB file: rapax.db (DB_PATH in .env)
- Auto-persisted every 5 seconds and on shutdown
- Auto-initialised on first boot

---

## Supported Currencies

| Currency | Network | Provider |
|----------|---------|----------|
| BTC | Bitcoin mainnet | BlockCypher or own node |
| ETH | Ethereum mainnet | Infura / Alchemy / own node |
| SOL | Solana mainnet | Helius / QuickNode / own node |
| USDT | ERC-20 | Same as ETH |

---

## FIAT (Future)

Gated by FIAT_ENABLED=false in .env. FiatService stub exists in paymentService.js.

---

## Deployment - Cloudflare Tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create rapax
cloudflared tunnel route dns rapax store.archerchainanalytics.com
cloudflared tunnel run --url http://localhost:4000 rapax
```

---

*© Archer Chain Analytics™ — All Rights Reserved.*
*Sovereign. Zero-Trust. Zero Compromise.*

---

## Ownership & Legal

**© 2026 Neil Scott Archer / Archer Chain Analytics**
- **ISC Registration:** 102237785
- **CRA BN:** 709110639
- **Address:** 417 Avenue G S, 5th Ave N, Saskatoon SK S7M 1V5
- **Contact:** archerchainanalytics@gmail.com

All rights reserved. Exclusive property of Neil Scott Archer operating as Archer Chain Analytics. Unauthorized use prohibited. Trademark applications pending with CIPO.

---
