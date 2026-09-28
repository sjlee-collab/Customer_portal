#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 고객지원포탈 백엔드 스모크 테스트 — 핵심 API 경로가 살아있는지 빠르게(비파괴) 점검.
#
# 사용법:
#   scripts/harness/smoke.sh                         # 비인증 경로만 (로그인 없이 안전)
#   SMOKE_EMAIL=... SMOKE_PASSWORD=... scripts/harness/smoke.sh   # 로그인·조회 경로까지
#   API_BASE=https://dev... scripts/harness/smoke.sh # dev 등 다른 환경 대상
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

# 5) 운영 프론트 보안 헤더 — customHttp.yml(Amplify)이 실제 적용돼 있는지 (2026-09-22, S-5 후속)
#    콘솔에서 헤더를 지우거나 customHttp.yml이 배포에서 빠지는 회귀를 잡는다. 읽기전용(GET 1회).
PORTAL_URL="${PORTAL_URL:-https://support.bigxdata.io}"
if [ -n "$PORTAL_URL" ]; then
  hdr=$(curl -s -D - -o /dev/null --max-time 15 "$PORTAL_URL/")
  if [ -z "$hdr" ]; then
    bad "포탈 헤더 조회 실패 ($PORTAL_URL — 네트워크/도메인 확인)"
  else
    missing=""
    for h in strict-transport-security x-content-type-options x-frame-options \
             referrer-policy content-security-policy permissions-policy \
             cross-origin-opener-policy cross-origin-resource-policy; do
      printf '%s' "$hdr" | grep -qi "^$h:" || missing="$missing $h"
    done
    if [ -z "$missing" ]; then ok "보안 헤더 8종 적용됨 (customHttp.yml)"
    else bad "보안 헤더 누락:$missing"; fi
  fi

  # 6) /api Same-Origin 프록시 생존 — Amplify 리라이트 규칙이 살아있는지 (2026-09-18 운영 전환분)
  #    규칙이 지워지면 SPA 규칙이 /api를 삼켜 200+HTML이 온다 → 401(JSON, 균일 응답)이어야 정상.
  code=$(curl -s -o "$TMP" -w '%{http_code}' --max-time 15 -X POST "$PORTAL_URL/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d '{"email":"smoke-nonexistent@example.com","password":"x"}')
  if [ "$code" = "401" ] && grep -q '"error"' "$TMP"; then
    ok "/api 프록시 경유 auth/login 정상 (HTTP 401, 리라이트 생존)"
  elif [ "$code" = "200" ]; then
    bad "/api 프록시 이상 — 200 응답(SPA가 삼킴: Amplify customRules에서 /api 규칙 확인)"
  else
    bad "/api 프록시 이상 (HTTP $code: $(head -c 120 "$TMP"))"
  fi
else
  skip "운영 프론트 헤더·프록시 (PORTAL_URL 빈 값)"
fi

echo ""
echo "== 결과:  ✅ $PASS   ❌ $FAIL   ⏭️ $SKIP =="
[ "$FAIL" -eq 0 ]
