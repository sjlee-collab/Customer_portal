#!/usr/bin/env bash
# main을 dev/Design/QA에 ff 전파 + 4브랜치 SHA 일치 검증.
# 사용: bash scripts/harness/promote.sh
# 전제: 각 브랜치가 별도 워크트리(Customer_portal-dev / -design / -QA)로 존재.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"   # 워크트리들의 상위(고객포탈)
MAIN="$ROOT/Customer_portal"
cd "$MAIN"
git fetch origin main dev Design QA -q 2>/dev/null || true
echo "origin/main = $(git rev-parse --short origin/main)"
declare -A WT=( [dev]=Customer_portal-dev [Design]=Customer_portal-design [QA]=Customer_portal-QA )
for b in dev Design QA; do
  d="$ROOT/${WT[$b]}"
  if [ ! -d "$d" ]; then echo "  $b: 워크트리 없음($d) — 건너뜀"; continue; fi
  ( cd "$d"
    git fetch origin "$b" main -q 2>/dev/null || true
    if git merge --ff-only origin/main >/dev/null 2>&1; then
      git push origin "$b" >/dev/null 2>&1 && echo "  $b -> $(git rev-parse --short HEAD) pushed"
    else
      echo "  $b: ff 불가 — 이 브랜치가 main보다 앞서 있음($(git rev-parse --short HEAD)). 수동 확인 필요"
    fi )
done
echo "── 최종 SHA ──"
git fetch origin main dev Design QA -q 2>/dev/null || true
for b in main dev Design QA; do echo "  origin/$b: $(git rev-parse --short "origin/$b" 2>/dev/null || echo '?')"; done
