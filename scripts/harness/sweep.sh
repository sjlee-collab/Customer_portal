#!/usr/bin/env bash
# 테스트 잔여 데이터 정리 — 이름/제목에 '[테스트]' 라벨이 붙은 행만 찾아 삭제한다.
# 중단된 테스트가 남긴 데이터를 라벨로 안전하게 청소(라벨 없는 운영 데이터는 절대 안 건드림).
# 사용:
#   bash scripts/harness/sweep.sh          # 미리보기(dry-run): 대상만 출력
#   bash scripts/harness/sweep.sh --delete # 실제 삭제
set -u
export AWS_PROFILE="${AWS_PROFILE:-customer_portal}"
export PYTHONIOENCODING=utf-8
HDIR="$(cd "$(dirname "$0")" && pwd)"
export HARNESS_TMP="$HDIR/lib"
MODE="${1:-}"

DELETE=$([ "$MODE" = "--delete" ] && echo 1 || echo 0) \
python - <<'PY'
import sys, os
sys.path.insert(0, os.path.join(os.environ['HARNESS_TMP']))
try: sys.stdout.reconfigure(encoding='utf-8')
except Exception: pass
from itest import sweep_test_data, TEST_PREFIX
delete = os.environ.get('DELETE') == '1'
found = sweep_test_data(dry_run=not delete)
total = sum(len(v) for v in found.values())
print("라벨 '%s' 잔여 데이터: %d건" % (TEST_PREFIX, total))
for tbl, rows in found.items():
    print("  [%s] %d건" % (tbl, len(rows)))
    for rid, label in rows[:20]:
        print("     - %s  %s" % (rid, label))
if not delete:
    print(">> 미리보기(dry-run). 실제 삭제: bash scripts/harness/sweep.sh --delete")
else:
    print(">> 삭제 완료 (%d건)" % total)
PY
