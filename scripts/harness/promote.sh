#!/usr/bin/env bash
# main을 dev/Design/QA(+notion-migration)에 ff 전파 + SHA 검증.
# 사용: bash scripts/harness/promote.sh
# 전제: 각 브랜치가 별도 워크트리(Customer_portal-dev / -design / -QA / -notion)로 존재.
# notion-migration은 형제 세션의 기능 브랜치라 항상 ff-only로만 반영한다 — 자체 커밋으로
# 갈라져 ff가 안 되면 절대 강제하지 않고(건드리지 않고) 보고만 한다.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"   # 워크트리들의 상위(고객포탈)
MAIN="$ROOT/Customer_portal"
cd "$MAIN"
git fetch origin main dev Design QA notion-migration -q 2>/dev/null || true
echo "origin/main = $(git rev-parse --short origin/main)"
declare -A WT=( [dev]=Customer_portal-dev [Design]=Customer_portal-design [QA]=Customer_portal-QA [notion-migration]=Customer_portal-notion )
for b in dev Design QA notion-migration; do
  d="$ROOT/${WT[$b]}"
  if [ ! -d "$d" ]; then echo "  $b: 워크트리 없음($d) — 건너뜀"; continue; fi
  ( cd "$d" || { echo "  $b: ⚠ cd 실패($d) — 건너뜀"; exit 1; }   # 가드 없으면 main 위치에서 push할 위험
    git fetch origin "$b" main -q 2>/dev/null || true
    if git merge --ff-only origin/main >/dev/null 2>&1; then
      if git push origin "$b" >/dev/null 2>&1; then
        echo "  $b -> $(git rev-parse --short HEAD) pushed"
      else
        # 조용히 삼키면 "로컬만 ff·원격 미반영"을 아무도 모른다(감사 T4) — 반드시 보고.
        echo "  $b: ⚠ push 실패 — 로컬은 ff됐으나 원격 미반영(원격이 앞섰을 수 있음, 수동 확인)"
      fi
    else
      echo "  $b: ff 불가 — 이 브랜치가 main과 갈라져 있음($(git rev-parse --short HEAD)). 강제하지 않음(수동 확인)"
    fi )
done
echo "── 최종 SHA ──"
git fetch origin main dev Design QA notion-migration -q 2>/dev/null || true
for b in main dev Design QA notion-migration; do echo "  origin/$b: $(git rev-parse --short "origin/$b" 2>/dev/null || echo '?')"; done
