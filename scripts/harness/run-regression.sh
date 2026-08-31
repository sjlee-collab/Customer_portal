#!/usr/bin/env bash
# 회귀 테스트 스위트 실행 — L1(권한/격리) + L1(삭제/상태) + L1-C(고객 기능).
# 사용: bash scripts/harness/run-regression.sh
# 전제: AWS_PROFILE=customer_portal (기본), aws.exe, python.
# L2(프론트)는 로그인 프리뷰에서 tests/smoke_frontend.js를 콘솔에 붙여 별도 확인.
set -u
export AWS_PROFILE="${AWS_PROFILE:-customer_portal}"
export PYTHONIOENCODING=utf-8
HDIR="$(cd "$(dirname "$0")" && pwd)"
export HARNESS_TMP="$HDIR/lib"

TESTS=(test_permissions.py test_ticket_delete.py test_ticket_status.py test_ticket_assign.py test_notify_routing.py test_customer_e2e.py test_stats_view.py test_proxy_register.py test_storage_rules.py test_auth.py)
fail=0
for tf in "${TESTS[@]}"; do
  echo "────────────────────────────────────────"
  echo "▶ $tf"
  python "$HDIR/tests/$tf" || fail=1
done
echo "────────────────────────────────────────"
# 안전망: 각 테스트가 finally로 정리하지만, 중단 등으로 남은 '[테스트]' 라벨 잔여물을 청소.
echo "▶ 잔여 테스트 데이터 정리(sweep --delete)"
bash "$HDIR/sweep.sh" --delete || true
echo "────────────────────────────────────────"
if [ "$fail" -eq 0 ]; then echo "✅ 회귀 전체 PASS"; else echo "❌ 실패한 테스트 있음 (위 로그 확인)"; fi
exit $fail
