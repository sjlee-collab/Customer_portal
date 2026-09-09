#!/usr/bin/env bash
# main을 형제 브랜치에 ff-only로 전파하고 SHA를 검증한다 (R3 — 다중 브랜치 배포 drift).
#
# 사용: bash scripts/harness/promote.sh [--dry-run]
#
# ★ 워크트리가 필요 없다 ★
#   예전 버전은 $ROOT 아래에 Customer_portal / -dev / -design / -QA / -notion 이라는
#   형제 워크트리가 나란히 있다고 전제하고, 각 폴더에 들어가 merge --ff-only 후 push 했다.
#   그 레이아웃은 이 레포에 존재하지 않는다(워크트리는 .claude/worktrees/ 아래에 생긴다).
#   그래서 전 브랜치가 "워크트리 없음 — 건너뜀"으로 빠져 **아무것도 전파하지 않으면서
#   성공처럼 끝났다.** 원격 ref는 체크아웃 없이도 밀 수 있으므로 그렇게 바꿨다:
#       git push origin <main의 SHA>:refs/heads/<대상>
#   서버가 non-fast-forward를 거부하므로 ff-only가 구조적으로 보장된다(--force 안 씀).
#
# 판정 4가지 — 남의 작업은 절대 강제하지 않는다(DESIGN §2-4):
#   ① 이미 일치            → 아무것도 안 함
#   ② 대상이 main보다 앞섬 → 건드리지 않음(전파할 게 없음). 예: dev가 개발 중일 때
#   ③ 갈라짐               → 보고만 하고 중단(종료코드 1)
#   ④ 대상이 뒤처짐        → ff 전파
#
# 전파 대상: PROMOTE_TARGETS 로 덮어쓸 수 있다.
#   QA는 뺐다 — 문서와 옛 스크립트가 대상으로 적어왔지만 **원격에 존재한 적이 없다.**
#   없는 브랜치는 "원격에 없음"으로 보고하고 종료코드 1을 낸다(조용히 넘기지 않는다).
set -uo pipefail
REPO="${PROMOTE_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
REMOTE="${PROMOTE_REMOTE:-origin}"
TARGETS="${PROMOTE_TARGETS:-dev Design notion-migration stats}"
SOURCE="${PROMOTE_SOURCE:-main}"
DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run|-n) DRY=1 ;;
    *) echo "사용: promote.sh [--dry-run]"; exit 2 ;;
  esac
done

cd "$REPO" 2>/dev/null || { echo "레포 없음: $REPO"; exit 1; }
git fetch "$REMOTE" --prune -q 2>/dev/null || { echo "❌ fetch 실패($REMOTE)"; exit 1; }

SRC_REF="$REMOTE/$SOURCE"
SRC="$(git rev-parse --verify -q "$SRC_REF")" || { echo "❌ $SRC_REF 없음"; exit 1; }
echo "$SRC_REF = $(git rev-parse --short "$SRC")${DRY:+}"
[ "$DRY" -eq 1 ] && echo "(--dry-run — 아무것도 밀지 않음)"

rc=0
for b in $TARGETS; do
  if ! git rev-parse --verify -q "$REMOTE/$b" >/dev/null; then
    echo "  ❌ $b: 원격($REMOTE)에 없는 브랜치 — 전파 대상 목록을 고치거나 브랜치를 만들 것"
    rc=1; continue
  fi
  CUR="$(git rev-parse "$REMOTE/$b")"
  short_cur="$(git rev-parse --short "$CUR")"

  if [ "$CUR" = "$SRC" ]; then
    echo "  ✅ $b: 이미 일치 ($short_cur)"; continue
  fi
  if git merge-base --is-ancestor "$SRC" "$CUR"; then
    echo "  ⏭  $b: $SOURCE보다 $(git rev-list --count "$SRC..$CUR")커밋 앞섬 ($short_cur) — 전파할 것 없음"
    continue
  fi
  if ! git merge-base --is-ancestor "$CUR" "$SRC"; then
    echo "  ⚠ $b: $SOURCE과 갈라짐 ($short_cur, 고유 $(git rev-list --count "$SRC..$CUR")커밋) — 강제하지 않음(수동 확인)"
    rc=1; continue
  fi

  n="$(git rev-list --count "$CUR..$SRC")"
  if [ "$DRY" -eq 1 ]; then
    echo "  ▶ $b: ff 가능 (+$n) — dry-run이라 밀지 않음"; continue
  fi
  if git push "$REMOTE" "$SRC:refs/heads/$b" -q 2>/dev/null; then
    echo "  ✅ $b: ff 전파 (+$n → $(git rev-parse --short "$SRC"))"
  else
    echo "  ❌ $b: push 실패(권한·보호규칙 확인)"; rc=1
  fi
done

echo "── 최종 SHA ──"
git fetch "$REMOTE" --prune -q 2>/dev/null || true
for b in $SOURCE $TARGETS; do
  printf '  %s/%-18s %s\n' "$REMOTE" "$b" "$(git rev-parse --short "$REMOTE/$b" 2>/dev/null || echo '(없음)')"
done
[ "$rc" -eq 0 ] && echo "✅ 전파 완료 — 갈라지거나 빠진 브랜치 없음" \
                || echo "⚠ 확인 필요 — 갈라졌거나 원격에 없는 브랜치가 있다(위 목록 참고)"
exit $rc
