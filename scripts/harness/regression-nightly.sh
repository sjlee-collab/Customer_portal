#!/usr/bin/env bash
# 새벽 자동 회귀 — Windows 작업 스케줄러가 매일 호출한다(클로드 세션과 무관, 순수 배치).
#
# 흐름: 최신 origin/main으로 ff → drift-check(경고) → run-regression → 결과를
#       SLACK_WEBHOOK_TEST(테스트 채널)로 통지 + 날짜별 로그 저장.
#
# ★ 반드시 hades 워크트리 전용으로 둔다 ★
#   이 스크립트는 자기 위치(=워크트리)에서 git ff를 한다. 사람이 작업하는 main 워크트리는
#   형제 세션의 미커밋 변경이 잦아 ff가 막히지만, hades는 이 배치 외엔 아무도 안 건드려
#   항상 clean → ff가 매번 성공하고 "정확히 origin/main의 이 커밋"을 검증한다.
#   등록: 작업 스케줄러가
#     "C:\Program Files\Git\bin\bash.exe" -lc \
#       /c/Installed_program/고객포탈/Customer_portal-hades/scripts/harness/regression-nightly.sh
#   를 매일 새벽(예: 04:00, 운영 09:00 배치와 안 겹침) 실행하도록 한다.
#   절전 대응: 작업의 WakeToRun=true, DisallowStartIfOnBatteries=false 설정(README 참고).
#
# 종료코드: 회귀 통과 0 / 실패·중단 1. (스케줄러 Last Result로도 확인 가능)
set -uo pipefail

REGION=ap-northeast-2
NOTIFY_FN=customer_portal_notify-handler
export AWS_PROFILE="${AWS_PROFILE:-customer_portal}"
export PYTHONIOENCODING=utf-8

# 자기 위치 기준으로 워크트리 루트를 잡는다(절대경로 하드코딩 회피).
HDIR="$(cd "$(dirname "$0")" && pwd)"          # .../scripts/harness
WT="$(cd "$HDIR/../.." && pwd)"                 # 워크트리 루트(= hades)
LOGDIR="$HOME/portal-nightly"; mkdir -p "$LOGDIR"
LOG="$LOGDIR/$(date +%Y%m%d_%H%M%S).log"

log(){ echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

# ── 슬랙 통지 헬퍼: 웹훅은 레포에 없고 Lambda env에만 있으므로 런타임 조회 ──
notify_slack(){
  local text="$1" hook
  hook="$(aws lambda get-function-configuration --function-name "$NOTIFY_FN" --region "$REGION" \
          --query 'Environment.Variables.SLACK_WEBHOOK_TEST' --output text 2>/dev/null)"
  if [ -z "$hook" ] || [ "$hook" = "None" ]; then
    log "슬랙 웹훅 조회 실패 — 통지 생략(로그만): $text"; return
  fi
  # JSON 이스케이프는 python으로(한글·따옴표 안전).
  local payload; payload="$(printf '%s' "$text" | python -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))')"
  curl -s -m 15 -X POST "$hook" -H 'Content-type: application/json' -d "$payload" >/dev/null \
    && log "슬랙 통지 발송" || log "슬랙 통지 실패(무시)"
}

cd "$WT" || { echo "워크트리 없음: $WT"; exit 1; }
log "새벽 회귀 시작 — 워크트리 $WT"

# ── 1) 최신 origin/main으로 ff (hades는 clean이라 항상 성공해야 정상) ──
git fetch origin -q 2>>"$LOG" || { log "git fetch 실패"; notify_slack "🌙 새벽 회귀 ❌ — git fetch 실패($WT)"; exit 1; }
BEFORE="$(git rev-parse --short HEAD)"
if ! git merge --ff-only origin/main >>"$LOG" 2>&1; then
  # hades에서 ff가 막히면 = 누가 이 워크트리를 더럽혔거나 갈라뜨렸다는 신호(정상 아님).
  # 낡은 코드로 조용히 검증하지 않도록 중단하고 명확히 알린다.
  log "ff 실패 — hades 워크트리가 clean·최신이 아님. 회귀 중단."
  notify_slack "🌙 새벽 회귀 ⚠️ 중단 — hades 워크트리가 origin/main으로 ff되지 않음(누군가 편집했거나 갈라짐). 확인 필요."
  exit 1
fi
AFTER="$(git rev-parse --short HEAD)"
log "ff 완료: $BEFORE → $AFTER (origin/main)"

# ── 2) drift 진단(레포↔배포본) — 경고만, 회귀는 계속 ──
if ! bash "$HDIR/drift-check.sh" >>"$LOG" 2>&1; then
  log "⚠ drift 감지 — 배포본과 레포 불일치(로그 참고). 회귀는 계속 진행."
  DRIFT=" · ⚠drift있음"
else
  DRIFT=""
fi

# ── 3) 회귀 실행 ──
log "회귀 실행…"
bash "$HDIR/run-regression.sh" >>"$LOG" 2>&1; RC=$?
SUMMARY="$(grep -E '회귀 전체 PASS|실패한 테스트' "$LOG" | tail -1)"
FAILS="$(grep -c 'FAIL ' "$LOG" 2>/dev/null || echo 0)"
log "회귀 종료 rc=$RC / $SUMMARY"

SHA="$(git rev-parse --short HEAD)"

# ── 4) 알림 로그(log_notification)에 회귀 알람 1건 기록 ──
# 포탈 「알림 로그 › 회귀 알람」 탭에서 실행 이력을 본다. channel='regression',
# is_test=true(운영 탭 제외), content=요약 전문. data-api admin insert(새 엔드포인트 불필요).
# 실패해도 통지·종료엔 영향 없도록 오류는 삼킨다.
{
  # PASS/FAIL 라인 + 스위트별 결과 줄을 요약으로 추린다.
  RESULT_LINES="$(grep -E '^▶ |^[0-9]+/[0-9]+ (PASS|FAIL)|✅ 회귀 전체 PASS|❌ 실패한 테스트|FAIL ' "$LOG" | tail -60)"
  PASSED="$( { grep -oE '[0-9]+/[0-9]+ PASS' "$LOG" | awk -F/ '{s+=$1} END{print s+0}'; } 2>/dev/null )"
  TOTAL="$(  { grep -oE '[0-9]+/[0-9]+ (PASS|FAIL)' "$LOG" | sed -E 's#[0-9]+/([0-9]+).*#\1#' | awk '{s+=$1} END{print s+0}'; } 2>/dev/null )"
  if [ "$RC" -eq 0 ]; then EVT=nightly_pass; STC=success; RECIP="$SHA · ${TOTAL}건"; ERRMSG='';
  else EVT=nightly_fail; STC=failed; RECIP="$SHA · ${PASSED}/${TOTAL}"
       # 실패한 체크 설명(FAIL 라인)만 추린다 — 전체 테스트명이 아니라 실제로 깨진 것.
       ERRMSG="$(grep -E '^FAIL ' "$LOG" | sed -E 's/^FAIL /✖ /' | head -3 | paste -sd '; ' -)"
       [ -z "$ERRMSG" ] && ERRMSG="실패 ${FAILS}건(로그 참고)";
  fi
  CONTENT="🌙 새벽 회귀 $([ "$RC" = 0 ] && echo '✅ PASS' || echo "❌ FAIL(${FAILS}건)") — $SHA${DRIFT}

${RESULT_LINES}

로그: ${LOG//\\//}"
  AWS_PROFILE="$AWS_PROFILE" HARNESS_TMP="$HDIR/lib" python - "$EVT" "$STC" "$RECIP" "$ERRMSG" "$CONTENT" <<'PY' >>"$LOG" 2>&1 || echo "[회귀 알람 기록 실패(무시)]" >>"$LOG"
import sys, os
sys.path.insert(0, os.path.join(os.environ['HARNESS_TMP']))
from itest import dpost
evt, stc, recip, errmsg, content = sys.argv[1:6]
r = dpost('log_notification', {
    'channel': 'regression', 'event_type': evt, 'recipient': recip,
    'status': stc, 'error_message': (errmsg or None), 'content': content, 'is_test': True,
}, role='admin')
print('[회귀 알람 기록] status=%s' % r.get('status'))
PY
} || true

# ── 5) 결과 통지 ──
if [ "$RC" -eq 0 ]; then
  notify_slack "🌙 새벽 회귀 ✅ PASS — ${SHA}${DRIFT} · $SUMMARY"
else
  notify_slack "🌙 새벽 회귀 ❌ FAIL($FAILS건) — ${SHA}${DRIFT} · 로그: ${LOG//\\//}"
fi

# 오래된 로그 정리(30일 초과)
find "$LOGDIR" -name '*.log' -type f -mtime +30 -delete 2>/dev/null || true
exit $RC
