#!/usr/bin/env bash
# Full integration test: LexForge + AcerbE package service + RaPaX + an S3-compatible stand-in for R2.
# Needs: node, python3 with fastapi uvicorn python-multipart cryptography Pillow pikepdf "moto[server]" boto3.
# Required env: LEXFORGE_DIR RAPAX_DIR ACERBE_SERVICE_DIR ACERBE_ENGINE_DIR   (all local checkouts)
# Everything uses random throwaway keys and temp storage. No real chain, Stripe or Cloudflare is contacted.
set -euo pipefail
: "${LEXFORGE_DIR:?}" "${RAPAX_DIR:?}" "${ACERBE_SERVICE_DIR:?}" "${ACERBE_ENGINE_DIR:?}"
W=$(mktemp -d); PIDS=()
cleanup(){ for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done; rm -rf "$W"; }
trap cleanup EXIT
rnd(){ python3 -c 'import secrets;print(secrets.token_hex(32))'; }
export ACERBE_MASTER_KEY=$(rnd) ACERBE_REGISTRY_KEY=$(rnd) ACERBE_API_KEY=$(rnd) RAPAX_WEBHOOK_SECRET=$(rnd)
export ACERBE_REGISTRY=$W/registry.db OPERATOR_SECRET=$(rnd) JWT_SECRET=$(rnd)
PM=5555 PL=5311 PA=7750 PR=4010
wait_http(){ for i in $(seq 1 60); do curl -s -o /dev/null "$1" && return 0; sleep 0.5; done; echo "TIMEOUT $1"; return 1; }

moto_server -p $PM >$W/moto.log 2>&1 & PIDS+=($!)
wait_http http://127.0.0.1:$PM/
AWS_ACCESS_KEY_ID=t AWS_SECRET_ACCESS_KEY=t python3 -c "import boto3;boto3.client('s3',endpoint_url='http://127.0.0.1:$PM',region_name='us-east-1').create_bucket(Bucket='rapax-products')"

node "$LEXFORGE_DIR/test/fixtures/makeFixture.mjs" $W/templates
echo '{"default":["EUA","TOS","PP","WA"],"products":{}}' > $W/product-docs.json
start_lexforge(){ (cd "$LEXFORGE_DIR" && PORT=$PL LEXFORGE_TEMPLATES_ROOT=$W/templates LEXFORGE_PRODUCT_DOCS=$W/product-docs.json LEXFORGE_VAR_OPERATOR_LEGAL_NAME="E2E Test Operator" exec node src/index.js >$W/lexforge.log 2>&1) & PIDS+=($!); wait_http http://127.0.0.1:$PL/health; }
start_acerbe(){ (cd "$ACERBE_SERVICE_DIR" && ACERBE_ENGINE_DIR=$ACERBE_ENGINE_DIR PYTHONPATH=$ACERBE_SERVICE_DIR:$ACERBE_ENGINE_DIR exec python3 -m uvicorn acerbe_service.app:create_app --factory --port $PA >$W/acerbe.log 2>&1) & ACP=$!; PIDS+=($ACP); wait_http http://127.0.0.1:$PA/health; }
start_lexforge; start_acerbe

(cd "$RAPAX_DIR" && NODE_ENV=development PORT=$PR DB_PATH=$W/rapax.db PRODUCTS_DIR=$W/p FINGERPRINTED_DIR=$W/f LOGS_DIR=$W/logs \
  PURCHASE_RATE_MAX=1000 ENABLED_CURRENCIES=BTC FIAT_ENABLED=false BTC_XPUB=zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs \
  R2_ENDPOINT=http://127.0.0.1:$PM R2_ACCESS_KEY_ID=t R2_SECRET_ACCESS_KEY=t R2_BUCKET_NAME=rapax-products \
  ACERBE_BASE_URL=http://127.0.0.1:$PA LEXFORGE_BASE_URL=http://127.0.0.1:$PL PIPELINE_BACKOFF_MS=200,200 AWS_REGION=auto \
  exec node src/server.js >$W/rapax.log 2>&1) & PIDS+=($!)
export RAPAX_URL=http://127.0.0.1:$PR
wait_http $RAPAX_URL/api/payment-methods
D="node $RAPAX_DIR/test/e2e/driver.mjs"

python3 - <<PY
import zipfile
with zipfile.ZipFile("$W/product.zip","w") as z:
    z.writestr("listener.js","console.log('hello');\n"); z.writestr("README.md","# E2E product\nSome readme text.\n"); z.writestr("config.json","{}\n")
PY
$D setup $W/product.zip $W/pid
$D refusals $W/pid
$D sale $W/pid $W/out.zip $W/tx
python3 "$RAPAX_DIR/test/e2e/verify_package.py" $W/out.zip "$(cat $W/tx)" bc1qe2ebuyer0000000000000000000000000000

echo "--- AcerbE down: a paid order must NOT ship unstamped ---"
kill $ACP; wait $ACP 2>/dev/null || true; ! curl -s -o /dev/null http://127.0.0.1:$PA/health || { echo 'AcerbE still up'; exit 1; }
EXPECT=held $D sale $W/pid $W/none.zip $W/tx2
test ! -e $W/none.zip
start_acerbe
$D release $W/tx2

echo "--- no human review sign-off: sale refused before payment ---"
node "$LEXFORGE_DIR/test/fixtures/makeFixture.mjs" $W/templates --unverified
$D unverified $W/pid
echo "ALL E2E CHECKS PASSED"
