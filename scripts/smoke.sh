#!/bin/bash
# API 스모크 테스트 — 현재 체크아웃된 코드가 바라보는 백엔드 도달성 확인
# index.html의 API_BASE를 파싱하므로, dev 브랜치가 dev 백엔드를 바라보면 자동으로 그쪽을 테스트한다.
# 인증 토큰 없이 호출하므로 401/403이 정상(도달 성공). 5xx/타임아웃이면 실패.
# 참고: 원격 샌드박스 프록시는 Amplify 배포 URL(*.amplifyapp.com 등) 접속을 차단하므로
#       프론트 배포 확인은 로컬에서만 가능. 여기서는 API Gateway만 확인한다.
set -euo pipefail
cd "$(dirname "$0")/.."

# 우선순위: 환경변수 API_BASE > index.html의 API_BASE 상수
if [ -z "${API_BASE:-}" ]; then
  API_BASE=$(grep -aoE "const API_BASE = '[^']+'" index.html | head -1 | cut -d"'" -f2)
fi
if [ -z "$API_BASE" ]; then
  echo "FAIL index.html에서 API_BASE를 찾지 못함"
  exit 1
fi
echo "대상 백엔드: $API_BASE"

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
