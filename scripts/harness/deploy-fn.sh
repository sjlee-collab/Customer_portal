#!/usr/bin/env bash
# Lambda 안전 재배포 — 배포본 zip을 받아 레포 소스(.mjs)로 교체, drift 진단 후 배포.
# 사용: bash scripts/harness/deploy-fn.sh <api-layer|data-api|public-inquiry|send-email|storage-api>
# 특징: api-layer는 소스 4개(index/db/notify/jwt) 자동 포함(단일 파일만 올리면 로그인 순단).
#       배포본 index.mjs ↔ 레포 index.mjs diff를 보여줘 예기치 않은 drift(병렬 세션)를 잡는다.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-customer_portal}"
REGION=ap-northeast-2
KEY="${1:-}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"           # Customer_portal 루트
LDIR="$REPO/aws-migration/lambda"

case "$KEY" in
  api-layer)      FN=customer-portal_slack_status_change; SRC="$LDIR/api-layer" ;;
  data-api)       FN=customer_portal_data-api;            SRC="$LDIR/data-api" ;;
  public-inquiry) FN=customer_portal_public-inquiry;      SRC="$LDIR/public-inquiry" ;;
  send-email)     FN=customer_portal_send-email;          SRC="$LDIR/send-email" ;;
  storage-api)    FN=customer_portal_storage-api;         SRC="$LDIR/storage-api" ;;
  jwt-authorizer) FN=customer_portal_jwt-authorizer;      SRC="$LDIR/jwt-authorizer" ;;
  *) echo "사용: deploy-fn.sh <api-layer|data-api|public-inquiry|send-email|storage-api|jwt-authorizer>"; exit 2 ;;
esac

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "▶ $KEY → $FN : 현재 배포본 다운로드"
URL=$(aws.exe lambda get-function --function-name "$FN" --region "$REGION" --query 'Code.Location' --output text)
curl -s -o "$TMP/cur.zip" "$URL"

echo "▶ drift 진단 (배포본 소스 ↔ 레포 소스)"
python - "$TMP/cur.zip" "$SRC" <<'PY'
import sys, os, zipfile
cur, src = sys.argv[1], sys.argv[2]
z = zipfile.ZipFile(cur)
names = set(z.namelist())
diffs = 0
for f in os.listdir(src):
    if not f.endswith('.mjs'): continue
    if f not in names:
        print("  [신규] %s (배포본에 없음 → 추가됨)" % f); diffs += 1; continue
    dep = z.read(f).decode('utf-8', 'replace').replace('\r','')
    rep = open(os.path.join(src, f), encoding='utf-8').read().replace('\r','')
    if dep != rep:
        import difflib
        d = list(difflib.unified_diff(dep.splitlines(), rep.splitlines(), lineterm='', n=0))
        add = sum(1 for x in d if x.startswith('+') and not x.startswith('+++'))
        rem = sum(1 for x in d if x.startswith('-') and not x.startswith('---'))
        print("  [변경] %s : +%d -%d 라인" % (f, add, rem)); diffs += 1
if diffs == 0:
    print("  (배포본 == 레포 : 배포해도 변화 없음)")
PY
echo "  ↑ 위 변경이 의도한 것이면 계속됩니다(3초). 아니면 Ctrl+C."
sleep 3

echo "▶ 새 zip 생성(레포 .mjs로 교체) + 배포"
python - "$TMP/cur.zip" "$SRC" "$TMP/new.zip" <<'PY'
import sys, os, zipfile
cur, src, out = sys.argv[1], sys.argv[2], sys.argv[3]
repo = {f: open(os.path.join(src, f), 'rb').read() for f in os.listdir(src) if f.endswith('.mjs')}
seen = set()
with zipfile.ZipFile(cur) as zin, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zo:
    for it in zin.infolist():
        nm = it.filename.replace(chr(92), '/')
        data = repo.get(nm, zin.read(it.filename))
        if nm in repo: seen.add(nm)
        zi = zipfile.ZipInfo(nm); zi.external_attr = it.external_attr; zi.compress_type = zipfile.ZIP_DEFLATED
        zo.writestr(zi, data)
    for nm, data in repo.items():   # 배포본에 없던 신규 소스 추가
        if nm not in seen:
            zo.writestr(nm, data)
print("  zip ok:", os.path.getsize(out), "bytes,", len(repo), ".mjs 반영")
PY
NZ=$(cygpath -w "$TMP/new.zip")
aws.exe lambda update-function-code --function-name "$FN" --region "$REGION" --zip-file "fileb://$NZ" --query 'LastUpdateStatus' --output text
aws.exe lambda wait function-updated --function-name "$FN" --region "$REGION"
echo "▶ 배포 완료. 스모크:"
HDIR="$(cd "$(dirname "$0")" && pwd)"
HARNESS_TMP="$HDIR/lib" KEY="$KEY" python - <<'PY'
import sys, os, json
sys.path.insert(0, os.path.join(os.environ['HARNESS_TMP']))
from itest import invoke, dget
key = os.environ['KEY']
if key == 'api-layer':
    r = invoke('api', {'requestContext': {'http': {'method': 'POST'}}, 'rawPath': '/auth/login',
                       'body': json.dumps({'email': 'zz-smoke@example.com', 'password': 'x'})})
    ok = r.get('status') in (400, 401, 404)
    print('  로그인 엔드포인트:', r.get('status'), 'OK' if ok else 'FAIL(재확인 필요)')
    sys.exit(0 if ok else 1)
else:
    r = dget('companies', {'select': 'id', 'limit': '1'}, role='admin')
    ok = r.get('status') == 200
    print('  data-api 조회:', r.get('status'), 'OK' if ok else 'FAIL')
    sys.exit(0 if ok else 1)
PY
echo "✅ $KEY 배포 성공"
