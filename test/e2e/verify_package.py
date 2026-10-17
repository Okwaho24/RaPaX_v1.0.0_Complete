"""Independent check of a delivered package: unzip, verify SHA256SUMS, and re-identify every stampable file with the AcerbE engine.
usage: ACERBE_* env set; python3 verify_package.py <zip> <transaction_id> <buyer_ref>"""
import hashlib, os, sys, tempfile, zipfile, json
from pathlib import Path
sys.path.insert(0, os.environ["ACERBE_ENGINE_DIR"])
import acerbe_engine as E

zpath, tx, buyer = sys.argv[1:4]
with tempfile.TemporaryDirectory() as td:
    with zipfile.ZipFile(zpath) as z:
        assert z.testzip() is None
        z.extractall(td)
    top = next(Path(td).iterdir())
    sums = {l.split("  ", 1)[1]: l.split("  ", 1)[0] for l in (top / "SHA256SUMS").read_text().splitlines() if l.strip()}
    for rel, h in sums.items():
        assert hashlib.sha256((top / rel).read_bytes()).hexdigest() == h, f"checksum mismatch {rel}"
    exts = {e for v in E.SUPPORTED_TYPES.values() for e in v} - {".zip"}
    n = 0
    for f in sorted(p for p in top.rglob("*") if p.is_file() and p.suffix.lower() in exts):
        r = E.identify_file(str(f))
        assert r.get("identified"), f"NOT fingerprinted: {f.relative_to(top)}"
        assert r["transaction_id"] == tx and r["buyer_name"] == buyer, f"wrong buyer/tx in {f.relative_to(top)}: {r}"
        n += 1
    m = json.loads((top / "MANIFEST.json").read_text())
    docs = sorted(str(p.relative_to(top)) for p in (top / "legal").rglob("*.md"))
    assert docs and n >= len(docs) + 1
    print(f"PASS verify: {n} files fingerprinted to tx={tx[:8]}… buyer={buyer[:12]}…; docs={docs}; manifest languages={m.get('languages_shipped')}")
