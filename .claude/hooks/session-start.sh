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

echo "[session-start] 개발환경 준비 완료"
