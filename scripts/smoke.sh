#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 고객지원포탈 백엔드 스모크 테스트 — 핵심 API 경로가 살아있는지 빠르게(비파괴) 점검.
#
# 사용법:
#   scripts/smoke.sh                         # 비인증 경로만 (로그인 없이 안전)
#   SMOKE_EMAIL=... SMOKE_PASSWORD=... scripts/smoke.sh   # 로그인·조회 경로까지
#   API_BASE=https://dev... scripts/smoke.sh # dev 등 다른 환경 대상
#
# 성격: 전부 읽기전용/비파괴. account-inquiry는 허니팟 값이라 DB·Slack 미발생.
# 종료코드: 실패 0건이면 0, 하나라도 실패면 1 (CI/배포 후 훅에서 사용 가능)
# ─────────────────────────────────────────────────────────────────────────────
set -u

API_BASE="${API_BASE:-https://8xbmazu4ij.execute-api.ap-northeast-2.amazonaws.com}"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
PASS=0; FAIL=0; SKIP=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
skip() { echo "  ⏭️  $1"; SKIP=$((SKIP+1)); }

echo "== 고객지원포탈 스모크 테스트 =="
echo "   대상: $API_BASE"
echo ""

# 1) 로그인 엔드포인트 alive — 없는 계정으로 더미 요청 → 구조화된 4xx(401/404), 5xx 아님
code=$(curl -s -o "$TMP" -w '%{http_code}' -X POST "$API_BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"smoke-nonexistent@example.com","password":"x"}')
case "$code" in
  401|404) ok "auth/login 응답 정상 (HTTP $code)";;
  5*|000)  bad "auth/login 죽음/오류 (HTTP $code)";;
  *)       bad "auth/login 예상밖 (HTTP $code)";;
esac

# 2) 계정신청 공개 엔드포인트 — 허니팟 페이로드(website 채움) → 200, DB·Slack 미발생(비파괴)
code=$(curl -s -o "$TMP" -w '%{http_code}' -X POST "$API_BASE/public/account-inquiry" \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke","company":"smoke","phone":"0","email":"smoke@smoke.test","website":"bot-honeypot"}')
if [ "$code" = "200" ]; then ok "public/account-inquiry alive (HTTP 200, 허니팟 비파괴)"
else bad "public/account-inquiry 이상 (HTTP $code: $(cat "$TMP"))"; fi

# 3) 인증 보호 확인 — 토큰 없이 /data/tickets → 401/403 (jwt-authorizer 살아있음)
code=$(curl -s -o /dev/null -w '%{http_code}' "$API_BASE/data/tickets?limit=1")
case "$code" in
  401|403) ok "data/tickets 인증 보호 정상 (토큰없음 HTTP $code)";;
  200)     bad "data/tickets가 토큰 없이 200 — 인증 우회 위험!";;
  *)       bad "data/tickets 예상밖 (HTTP $code, 401/403 기대)";;
esac

# 4) (선택) 실제 로그인 → 티켓 조회 — SMOKE_EMAIL/PASSWORD 설정 시에만. 읽기전용.
if [ -n "${SMOKE_EMAIL:-}" ] && [ -n "${SMOKE_PASSWORD:-}" ]; then
  t0=$(date +%s%N)
  curl -s -o "$TMP" -X POST "$API_BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"${SMOKE_EMAIL}\",\"password\":\"${SMOKE_PASSWORD}\"}"
  t1=$(date +%s%N); ms=$(( (t1 - t0) / 1000000 ))
  token=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TMP")
  if [ -n "$token" ]; then
    ok "로그인 성공 (${SMOKE_EMAIL}, ${ms}ms)"
    [ "$ms" -gt 2000 ] && echo "       ⚠️ 로그인 ${ms}ms — 느림(콜드스타트 가능성)"
    code=$(curl -s -o "$TMP" -w '%{http_code}' \
      "$API_BASE/data/tickets?limit=1&select=id,ticket_number,unit_name" \
      -H "Authorization: Bearer $token")
    if [ "$code" = "200" ]; then ok "티켓 조회 성공 (HTTP 200, 인증+data-api 정상)"
    else bad "티켓 조회 이상 (HTTP $code)"; fi
  else
    bad "로그인 실패 (토큰 없음) — 응답: $(cat "$TMP")"
  fi
else
  skip "로그인·조회 경로 (SMOKE_EMAIL/SMOKE_PASSWORD 미설정)"
fi

echo ""
echo "== 결과:  ✅ $PASS   ❌ $FAIL   ⏭️ $SKIP =="
[ "$FAIL" -eq 0 ]
