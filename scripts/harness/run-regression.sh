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

ALL=(test_permissions.py test_ticket_delete.py test_ticket_status.py test_ticket_assign.py test_notify_routing.py test_internal_review.py test_ticket_rate.py test_customer_e2e.py test_stats_view.py test_proxy_register.py test_storage_rules.py test_auth.py test_schema_contract.py)
# 병렬 안전 = 알림 발송 건수/타입을 단언하지 않는 스위트(응답 코드·권한·구조만 검사).
# 나머지(알림 타이밍 민감 + 전역 집계)는 직렬. 지정 실행 시엔 이 분류를 그대로 따른다.
PAR_SAFE=(test_permissions.py test_ticket_delete.py test_storage_rules.py test_ticket_rate.py test_proxy_register.py test_auth.py test_schema_contract.py)

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

l2_fail=0
FAILED=()   # 1차에서 실패한 스위트 이름

# ── L2 정적 스모크 — index.html 문법/핸들러/DOM id (1초 미만) ──
echo "────────────────────────────────────────"
echo "▶ l2-smoke.mjs (index.html 정적 검사)"
node "$HDIR/l2-smoke.mjs" || l2_fail=1

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
  [ "$rc" -ne 0 ] && FAILED+=("$tf")
done

# ── 직렬 무리: 알림 타이밍·전역 집계 민감 스위트 ──
for tf in "${SER[@]+"${SER[@]}"}"; do
  echo "────────────────────────────────────────"
  echo "▶ $tf (직렬 — 알림/집계 민감)"
  python "$HDIR/tests/$tf" || FAILED+=("$tf")
done

# ── 재시도 단계 — 1차 실패 스위트를 단독·직렬로 1회 더 돌린다 ──
# 알림 판정이 비동기 라이브 재조회라, 병렬 부하에서 경합해 간헐 실패(flaky)가 난다.
# 재시도에서 통과하면 flaky(⚠, 치명 아님), 또 실패하면 진짜 실패(❌)로 분류한다.
FLAKY=(); REALFAIL=()
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "════════════════════════════════════════"
  echo "▶ 재시도: 1차 실패 ${#FAILED[@]}종 단독 재실행 — ${FAILED[*]}"
  for tf in "${FAILED[@]}"; do
    echo "────────────────────────────────────────"
    echo "▶ 재시도 $tf"
    if python "$HDIR/tests/$tf"; then
      echo "⚠ FLAKY: $tf (1차 실패 → 재시도 통과)"
      FLAKY+=("$tf")
    else
      echo "❌ REALFAIL: $tf (재시도도 실패)"
      REALFAIL+=("$tf")
    fi
  done
fi

echo "────────────────────────────────────────"
# 안전망: 각 테스트가 finally로 정리하지만, 중단 등으로 남은 '[테스트]' 라벨 잔여물을 청소.
echo "▶ 잔여 테스트 데이터 정리(sweep --delete)"
bash "$HDIR/sweep.sh" --delete || true
echo "════════════════════════════════════════"

# ── 판정 ── 치명 = L2 실패 또는 재시도도 실패한 스위트. flaky만이면 통과(경고).
strip(){ printf '%s' "$*" | sed 's/\.py//g;s/test_//g'; }
if [ "$l2_fail" -ne 0 ] || [ "${#REALFAIL[@]}" -gt 0 ]; then
  MARK="❌ 회귀 실패"
  [ "$l2_fail" -ne 0 ] && MARK="$MARK · L2"
  [ "${#REALFAIL[@]}" -gt 0 ] && MARK="$MARK · ${#REALFAIL[@]}종: $(strip "${REALFAIL[*]}")"
  [ "${#FLAKY[@]}" -gt 0 ] && MARK="$MARK (불안정 $(strip "${FLAKY[*]}"))"
  echo "$MARK"
  exit 1
elif [ "${#FLAKY[@]}" -gt 0 ]; then
  echo "⚠ 회귀 통과(불안정 ${#FLAKY[@]}종: $(strip "${FLAKY[*]}")) — 재시도에서 통과, 경합 의심"
  exit 0
else
  echo "✅ 회귀 전체 PASS"
  exit 0
fi
