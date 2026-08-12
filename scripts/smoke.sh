#!/bin/bash
# API Gateway 스모크 테스트 — 백엔드 도달성 확인
# 인증 토큰 없이 호출하므로 401/403이 정상(도달 성공). 5xx/타임아웃이면 실패.
set -euo pipefail

API_BASE="${API_BASE:-https://8xbmazu4ij.execute-api.ap-northeast-2.amazonaws.com}"

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
  "$API_BASE/data/companies?limit=1") || {
  echo "FAIL API Gateway 접속 불가 ($API_BASE)"
  exit 1
}

if [ "$code" -ge 200 ] && [ "$code" -lt 500 ]; then
  echo "OK   API Gateway 응답 HTTP $code (인증 없는 호출이라 401/403이 정상)"
else
  echo "FAIL API Gateway HTTP $code"
  exit 1
fi
