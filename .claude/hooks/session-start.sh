#!/bin/bash
# 원격(Claude Code on the web) 세션 시작 시 개발환경 준비 훅
set -euo pipefail

# 로컬 세션에서는 아무것도 하지 않음
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"

# Lambda 함수 중 의존성이 있는 것만 npm install (멱등, 컨테이너 캐시 활용)
for dir in aws-migration/lambda/*/; do
  pkg="$dir/package.json"
  if [ -f "$pkg" ] && grep -q '"dependencies"' "$pkg"; then
    echo "[session-start] npm install: $dir"
    (cd "$dir" && npm install --no-audit --no-fund --loglevel=error)
  fi
done

# 브랜치 기준 대상 시스템 환경변수 주입 — main만 운영, 나머지(dev 포함)는 전부 개발계 취급
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
if [ "$branch" = "main" ]; then
  PORTAL_ENV="prod"
  PORTAL_URL="https://support.bigxdata.io/"
  AMPLIFY_APP_ID="d197cwv814vb95"
else
  PORTAL_ENV="dev"
  PORTAL_URL="https://dev.dlayoierdftk6.amplifyapp.com/"
  AMPLIFY_APP_ID="dlayoierdftk6"
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export PORTAL_ENV=\"$PORTAL_ENV\""
    echo "export PORTAL_URL=\"$PORTAL_URL\""
    echo "export AMPLIFY_APP_ID=\"$AMPLIFY_APP_ID\""
  } >> "$CLAUDE_ENV_FILE"
fi

echo "[session-start] 브랜치=$branch → 대상 시스템=$PORTAL_ENV ($PORTAL_URL)"
echo "[session-start] 개발환경 준비 완료"
