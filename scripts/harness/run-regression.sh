#!/usr/bin/env bash
# 회귀 테스트 스위트 실행 — L2 정적 스모크 + L1 백엔드 계약.
#
# 사용: bash scripts/harness/run-regression.sh                # 전체 (병렬)
#       bash scripts/harness/run-regression.sh auth stats     # 지정 스위트만
#       (이름은 test_ 접두·.py 확장자 생략 가능: auth == test_auth == test_auth.py)
#
# 병렬 실행: 알림 판정이 없는 스위트만 동시에 돌린다(PAR_SAFE). 알림 테스트는 notify-handler가
#   비동기로 "현재 티켓 상태"를 읽어 event_type을 정하는 구조라, 병렬 CPU 부하에서 전이와
#   비동기 발송이 경합해 분포가 어긋난다(실측). 그래서 알림·전역집계 민감 스위트는 직렬로 둔다.
#   벽시계 = max(병렬안전 무리) + sum(직렬). boto3 전환으로 개별 호출 오버헤드는 이미 크게 줄었다.
# 전제: AWS_PROFILE=customer_portal (기본), python(+boto3 권장 — 없으면 CLI 폴백), node.
set -u
export AWS_PROFILE="${AWS_PROFILE:-customer_portal}"
export PYTHONIOENCODING=utf-8
HDIR="$(cd "$(dirname "$0")" && pwd)"
export HARNESS_TMP="$HDIR/lib"

ALL=(test_permissions.py test_ticket_delete.py test_ticket_status.py test_ticket_assign.py test_notify_routing.py test_internal_review.py test_ticket_rate.py test_customer_e2e.py test_stats_view.py test_proxy_register.py test_storage_rules.py test_auth.py)
# 병렬 안전 = 알림 발송 건수/타입을 단언하지 않는 스위트(응답 코드·권한·구조만 검사).
# 나머지(알림 타이밍 민감 + 전역 집계)는 직렬. 지정 실행 시엔 이 분류를 그대로 따른다.
PAR_SAFE=(test_permissions.py test_ticket_delete.py test_storage_rules.py test_ticket_rate.py test_proxy_register.py test_auth.py)

# ── 인자 해석: 이름 정규화 + 존재 검증 ──
if [ "$#" -gt 0 ]; then
  TESTS=()
  for a in "$@"; do
    t="$a"
    case "$t" in test_*) ;; *) t="test_$t" ;; esac
    case "$t" in *.py) ;; *) t="$t.py" ;; esac
    if [ ! -f "$HDIR/tests/$t" ]; then
      echo "❌ 없는 테스트: $a (가능: $(cd "$HDIR/tests" && ls test_*.py | sed 's/test_//;s/\.py//' | tr '\n' ' '))"
      exit 2
    fi
    TESTS+=("$t")
  done
else
  TESTS=("${ALL[@]}")
fi

fail=0

# ── L2 정적 스모크 — index.html 문법/핸들러/DOM id (1초 미만) ──
echo "────────────────────────────────────────"
echo "▶ l2-smoke.mjs (index.html 정적 검사)"
node "$HDIR/l2-smoke.mjs" || fail=1

# ── 병렬안전/직렬 분리 ──
PAR=(); SER=()
for tf in "${TESTS[@]}"; do
  safe=0
  for s in "${PAR_SAFE[@]}"; do [ "$tf" = "$s" ] && safe=1; done
  if [ "$safe" -eq 1 ]; then PAR+=("$tf"); else SER+=("$tf"); fi
done

LOGDIR="$(mktemp -d)"; trap 'rm -rf "$LOGDIR"' EXIT

# ── 병렬안전 무리: 백그라운드로 동시 실행, 로그는 파일로 받아 순서대로 출력 ──
declare -A PID
for tf in "${PAR[@]+"${PAR[@]}"}"; do
  python "$HDIR/tests/$tf" > "$LOGDIR/$tf.log" 2>&1 &
  PID[$tf]=$!
done
for tf in "${PAR[@]+"${PAR[@]}"}"; do
  rc=0; wait "${PID[$tf]}" || rc=1
  echo "────────────────────────────────────────"
  echo "▶ $tf (병렬)"
  cat "$LOGDIR/$tf.log"
  [ "$rc" -ne 0 ] && fail=1
done

# ── 직렬 무리: 알림 타이밍·전역 집계 민감 스위트 ──
for tf in "${SER[@]+"${SER[@]}"}"; do
  echo "────────────────────────────────────────"
  echo "▶ $tf (직렬 — 알림/집계 민감)"
  python "$HDIR/tests/$tf" || fail=1
done

echo "────────────────────────────────────────"
# 안전망: 각 테스트가 finally로 정리하지만, 중단 등으로 남은 '[테스트]' 라벨 잔여물을 청소.
echo "▶ 잔여 테스트 데이터 정리(sweep --delete)"
bash "$HDIR/sweep.sh" --delete || true
echo "────────────────────────────────────────"
if [ "$fail" -eq 0 ]; then echo "✅ 회귀 전체 PASS"; else echo "❌ 실패한 테스트 있음 (위 로그 확인)"; fi
exit $fail
