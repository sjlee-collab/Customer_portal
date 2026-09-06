#!/usr/bin/env bash
# Lambda 안전 재배포 — 배포본 zip을 받아 레포 소스(.mjs)로 교체, drift 진단 후 배포.
# 사용: bash scripts/harness/deploy-fn.sh <fn> [--force]
#   fn: api-layer|data-api|public-inquiry|send-email|storage-api|jwt-authorizer|notify-handler
# 특징: api-layer는 소스 4개(index/db/notify/jwt) 자동 포함(단일 파일만 올리면 로그인 순단).
#
# ★ 파괴적 drift는 --force 없이 배포하지 않는다 ★
#   drift에는 두 방향이 있는데 화면상으론 똑같아 보인다:
#     ① 레포가 앞섬 — 내가 고친 걸 올리는 정상 배포(순수 추가).
#     ② 배포본이 앞섬 — 운영에만 있는 수정(핫픽스·형제 세션 배포)을 레포의 옛 코드가
#        덮어써 **조용히 롤백**된다. 2026-08-31에 실제로 그럴 뻔했다(DESIGN.md R4).
#   diff의 '-' 줄 수(=배포본에만 있어 사라질 줄)가 그 구분이며, 예전엔 이 값을 출력만
#   하고 3초 sleep 후 무조건 배포했다 — 비대화형 호출에선 게이트가 아예 없는 셈이었다.
#   이제 '-'가 0이면 그냥 진행하고(정상 배포는 방해 없음), 0보다 크면 중단한다.
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-customer_portal}"
# drift 경고는 사람이 읽고 판단해야 하는데, 이게 없으면 파이썬이 찍는 한글이 콘솔 코드페이지에
# 따라 깨진다(다른 하네스 스크립트는 이미 설정하고 있었음).
export PYTHONIOENCODING=utf-8
REGION=ap-northeast-2
KEY=""; FORCE=0; DRYRUN=0
for a in "$@"; do
  case "$a" in
    --force|--yes|-f) FORCE=1 ;;
    --dry-run|-n)     DRYRUN=1 ;;   # drift 판정까지만 하고 배포 없이 종료(게이트 확인용)
    -*) echo "알 수 없는 옵션: $a"; exit 2 ;;
    *) [ -z "$KEY" ] && KEY="$a" || { echo "인자가 너무 많음: $a"; exit 2; } ;;
  esac
done
REPO="$(cd "$(dirname "$0")/../.." && pwd)"           # Customer_portal 루트
# LAMBDA_DIR은 게이트 자체를 검증하는 테스트(test_deploy_gate)가 진짜 소스를 건드리지 않고
# 가짜 소스를 물리기 위한 이음매다. 평소엔 지정하지 않는다.
LDIR="${LAMBDA_DIR:-$REPO/backend/lambda}"
BACKUP_DIR="${DEPLOY_BACKUP_DIR:-$HOME/portal-deploy-backup}"

case "$KEY" in
  api-layer)      FN=customer-portal_slack_status_change; SRC="$LDIR/api-layer" ;;
  data-api)       FN=customer_portal_data-api;            SRC="$LDIR/data-api" ;;
  public-inquiry) FN=customer_portal_public-inquiry;      SRC="$LDIR/public-inquiry" ;;
  send-email)     FN=customer_portal_send-email;          SRC="$LDIR/send-email" ;;
  storage-api)    FN=customer_portal_storage-api;         SRC="$LDIR/storage-api" ;;
  jwt-authorizer) FN=customer_portal_jwt-authorizer;      SRC="$LDIR/jwt-authorizer" ;;
  notify-handler) FN=customer_portal_notify-handler;      SRC="$LDIR/notify-handler" ;;
  *) echo "사용: deploy-fn.sh <api-layer|data-api|public-inquiry|send-email|storage-api|jwt-authorizer|notify-handler>"; exit 2 ;;
esac

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "▶ $KEY → $FN : 현재 배포본 다운로드"
URL=$(aws.exe lambda get-function --function-name "$FN" --region "$REGION" --query 'Code.Location' --output text)
curl -s -o "$TMP/cur.zip" "$URL"

echo "▶ drift 진단 (배포본 소스 ↔ 레포 소스)"
# 사람이 읽는 요약은 그대로 찍고, 판단에 쓸 수치는 drift.env에 따로 남긴다.
# LOST = 배포본에만 있어 이 배포로 사라질 줄 수 — 이 스크립트의 유일한 차단 기준.
python - "$TMP/cur.zip" "$SRC" "$TMP/drift.env" <<'PY'
import sys, os, zipfile, difflib
cur, src, out = sys.argv[1], sys.argv[2], sys.argv[3]
z = zipfile.ZipFile(cur)
names = set(z.namelist())
diffs = 0; lost = 0; lost_files = []
for f in sorted(os.listdir(src)):
    if not f.endswith('.mjs'): continue
    if f not in names:
        print("  [신규] %s (배포본에 없음 → 추가됨)" % f); diffs += 1; continue
    dep = z.read(f).decode('utf-8', 'replace').replace('\r','')
    rep = open(os.path.join(src, f), encoding='utf-8').read().replace('\r','')
    if dep != rep:
        # a=배포본, b=레포 → '-'는 배포본에만 있는 줄(이 배포로 사라진다), '+'는 새로 올라갈 줄
        d = list(difflib.unified_diff(dep.splitlines(), rep.splitlines(), lineterm='', n=0))
        add = sum(1 for x in d if x.startswith('+') and not x.startswith('+++'))
        rem = sum(1 for x in d if x.startswith('-') and not x.startswith('---'))
        print("  [변경] %s : +%d -%d 라인%s" % (f, add, rem, ('  ← 운영 코드 %d줄 사라짐' % rem) if rem else '')); diffs += 1
        lost += rem
        if rem: lost_files.append('%s(-%d)' % (f, rem))
if diffs == 0:
    print("  (배포본 == 레포 : 배포해도 변화 없음)")
with open(out, 'w', encoding='utf-8') as fh:
    fh.write('LOST=%d\nLOST_FILES="%s"\n' % (lost, ' '.join(lost_files)))
PY
. "$TMP/drift.env"

# ── 차단 판정 ── 정상 배포(순수 추가)는 방해하지 않고, 운영 코드가 사라질 때만 멈춘다.
if [ "${LOST:-0}" -gt 0 ]; then
  echo ""
  echo "  ⛔ 파괴적 drift — 배포본에만 있는 ${LOST}줄이 이 배포로 사라집니다: ${LOST_FILES}"
  echo "     운영에 직접 반영된 수정(핫픽스·형제 세션 배포)을 레포의 옛 코드가 덮는 상황일 수 있습니다."
  echo "     전체 diff 확인: bash scripts/harness/drift-check.sh $KEY"
  echo "     배포본이 앞서 있다면 레포를 먼저 역동기화한 뒤 배포할 것 — DESIGN.md §6.5"
  if [ "$FORCE" -ne 1 ]; then
    echo "     의도한 삭제가 맞다면: bash scripts/harness/deploy-fn.sh $KEY --force"
    exit 3
  fi
  echo "  ⚠ --force 지정 — 위 ${LOST}줄을 덮어쓰고 진행합니다."
else
  echo "  ✅ 사라지는 운영 코드 없음(순수 추가/동일) — 진행"
fi

if [ "$DRYRUN" -eq 1 ]; then
  echo "▶ --dry-run — 배포하지 않고 종료(위 판정까지만)."
  exit 0
fi

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
# ── 롤백 아티팩트 보존 ──
# 직전 배포본(cur.zip)은 $TMP에 있는데 $TMP는 EXIT 트랩이 지운다. 스모크가 실패해 스크립트가
# 종료되는 순간, 되돌릴 물건이 바로 그 트랩에 삭제되던 문제(로그인 순단 이력 R6를 감안하면
# 최악의 타이밍). 배포 전에 트랩이 안 닿는 곳으로 복사해두고 경로를 알려준다.
mkdir -p "$BACKUP_DIR"
BK="$BACKUP_DIR/${KEY}-$(date +%Y%m%d_%H%M%S).zip"
cp "$TMP/cur.zip" "$BK"
echo "▶ 직전 배포본 백업: $BK"
# 함수당 최근 10개만 유지(오래된 것부터 정리)
ls -1t "$BACKUP_DIR/${KEY}-"*.zip 2>/dev/null | tail -n +11 | while read -r old; do rm -f "$old"; done

NZ=$(cygpath -w "$TMP/new.zip")
aws.exe lambda update-function-code --function-name "$FN" --region "$REGION" --zip-file "fileb://$NZ" --query 'LastUpdateStatus' --output text
aws.exe lambda wait function-updated --function-name "$FN" --region "$REGION"
echo "▶ 배포 완료. 스모크:"
HDIR="$(cd "$(dirname "$0")" && pwd)"
SMOKE_RC=0
# 함수별 프로브(lib/fnsmoke.py) — 예전엔 api-layer 외 전부 dget('companies')라 정작
# 방금 배포한 함수를 안 건드렸다(7개 중 5개에서 스모크가 무의미했다).
HARNESS_TMP="$HDIR/lib" KEY="$KEY" python "$HDIR/lib/fnsmoke.py" || SMOKE_RC=$?

if [ "$SMOKE_RC" -ne 0 ]; then
  # 예전엔 여기서 set -e로 그냥 죽었고, EXIT 트랩이 롤백용 zip까지 지웠다.
  # 이제 백업 경로와 되돌리는 명령을 그대로 찍어준다(장애 중에 문서 찾을 시간이 없다).
  echo ""
  echo "  ❌ 배포 후 스모크 실패 — 방금 올린 코드가 의심됩니다."
  echo "     되돌리기:"
  echo "       aws.exe lambda update-function-code --function-name $FN --region $REGION \\"
  echo "         --zip-file fileb://$(cygpath -w "$BK") --query LastUpdateStatus --output text"
  echo "       aws.exe lambda wait function-updated --function-name $FN --region $REGION"
  echo "     백업(직전 배포본): $BK"
  exit 1
fi
echo "✅ $KEY 배포 성공  (롤백용 직전 배포본: $BK)"
