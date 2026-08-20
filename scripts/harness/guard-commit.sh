#!/usr/bin/env bash
# 커밋 전 clobber 방지 점검 — origin/main 최신 여부 + 워킹트리 변경이 '의도한 파일'만인지.
# 사용: bash scripts/harness/guard-commit.sh [의도한파일...]
#   예) bash scripts/harness/guard-commit.sh index.html aws-migration/lambda/api-layer/index.mjs
# 병렬 세션이 같은 워크트리를 건드릴 수 있으므로, 커밋 전에 실제 변경 파일 목록을 확인한다.
set -uo pipefail
cd "$(cd "$(dirname "$0")/../.." && pwd)"
git fetch origin main -q 2>/dev/null || true
LOCAL=$(git rev-parse --short HEAD); ORIGIN=$(git rev-parse --short origin/main 2>/dev/null || echo '?')
echo "로컬 HEAD=$LOCAL / origin/main=$ORIGIN"
[ "$LOCAL" != "$ORIGIN" ] && echo "  ⚠ 로컬과 origin/main이 다름 — 형제 세션 커밋 가능. push 시 ff 여부 확인 필요."

echo "── 워킹트리 변경 파일(노이즈 제외) ──"
CHANGED=$(git status --porcelain | grep -v 'node_modules\|package-lock\|\.claude/launch.json\|scratchpad' | awk '{print $2}')
echo "$CHANGED" | sed 's/^/  /'

if [ "$#" -gt 0 ]; then
  echo "── 의도한 파일 대비 검증 ──"
  bad=0
  for f in $CHANGED; do
    hit=0; for want in "$@"; do [ "$f" = "$want" ] && hit=1; done
    [ "$hit" -eq 0 ] && { echo "  ⚠ 의도에 없는 변경: $f"; bad=1; }
  done
  [ "$bad" -eq 0 ] && echo "  ✅ 변경이 의도한 파일뿐 — 커밋 안전" || echo "  ❌ 의도 외 변경 있음 — 커밋 전 확인(형제 세션 작업일 수 있음)"
  exit $bad
fi
