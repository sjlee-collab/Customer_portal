#!/usr/bin/env bash
# 릴리스 태그 + 변경 이력 — "언제 무엇이 나갔는지"를 남기고 되돌릴 기준점을 만든다.
#
# 사용:
#   bash scripts/harness/release.sh --dry-run     # 무엇이 나갈지 미리보기(아무것도 안 바꿈)
#   bash scripts/harness/release.sh               # 오늘 날짜로 태그 + CHANGELOG 갱신 + push
#   bash scripts/harness/release.sh v2026.09.20   # 버전을 직접 지정
#
# 버전 규칙: CalVer `vYYYY.MM.DD` — 하루 여러 번 내면 `-2`, `-3`이 붙는다.
#   이 프로젝트는 main에 들어가는 즉시 배포되는 연속 배포라(주 40커밋 이상), 기능 단위로
#   번호를 매기는 SemVer보다 "며칠자 배포본"이 추적에 맞는다. 화면에 표시되는 빌드 정보
#   (사용자 메뉴 하단)도 같은 날짜 형식이라 눈으로 바로 대조된다.
#
# 무엇을 태그하나: 로컬이 아니라 **origin/main**을 태그한다. 배포되는 것이 origin/main이고,
#   로컬 워크트리는 병렬 세션 때문에 앞서거나 뒤처질 수 있다.
set -uo pipefail

REMOTE="${RELEASE_REMOTE:-origin}"
BRANCH="${RELEASE_BRANCH:-main}"
DRY=0
VERSION=""
for a in "$@"; do
  case "$a" in
    --dry-run|-n) DRY=1 ;;
    v[0-9]*) VERSION="$a" ;;
    *) echo "사용: release.sh [--dry-run] [vYYYY.MM.DD]"; exit 2 ;;
  esac
done

cd "$(dirname "$0")/../.." || { echo "레포 루트를 찾지 못했습니다"; exit 1; }

git fetch "$REMOTE" --tags -q 2>/dev/null || { echo "❌ fetch 실패($REMOTE)"; exit 1; }
SRC="$(git rev-parse --verify -q "$REMOTE/$BRANCH")" || { echo "❌ $REMOTE/$BRANCH 없음"; exit 1; }

# ── 버전 결정: 지정값 우선, 없으면 오늘(KST) 날짜. 같은 날 재릴리스면 -2, -3 …
if [ -z "$VERSION" ]; then
  BASE="v$(TZ=Asia/Seoul date +%Y.%m.%d)"
  VERSION="$BASE"
  n=2
  while git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null; do
    VERSION="$BASE-$n"; n=$((n + 1))
  done
fi
if git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null; then
  echo "❌ 이미 있는 태그입니다: $VERSION"; exit 1
fi

PREV="$(git describe --tags --abbrev=0 "$SRC" 2>/dev/null || true)"
# 첫 릴리스는 기준 태그가 없어 전체 이력(1000건 이상)이 딸려온다 — 읽히지도 않고 되돌림
# 기준으로도 쓸모없다. 최근 구간만 담고, 그 이전은 git 로그에 있다고 한 줄로 밝힌다.
FIRST_WINDOW="${RELEASE_FIRST_WINDOW:-14 days ago}"
if [ -n "$PREV" ]; then
  RANGE="$PREV..$SRC"
  LOGARGS=("$RANGE")
else
  RANGE="$SRC"
  LOGARGS=(--since="$FIRST_WINDOW" "$SRC")
fi
COUNT="$(git rev-list --count "${LOGARGS[@]}")"

echo "── 릴리스 준비 ──"
echo "  대상      : $REMOTE/$BRANCH ($(git rev-parse --short "$SRC"))"
echo "  새 버전   : $VERSION"
echo "  직전 태그 : ${PREV:-(없음 — 첫 릴리스)}"
echo "  포함 커밋 : ${COUNT}개"
if [ "$COUNT" -eq 0 ]; then
  echo "⚠ 직전 태그 이후 새 커밋이 없습니다 — 릴리스할 내용이 없습니다."; exit 1
fi

# ── 변경 이력 본문: 머지 커밋은 빼고(노이즈), 한 줄씩 ──
NOTES="$(git log --no-merges --pretty='- %s (%h)' "${LOGARGS[@]}")"
[ -z "$PREV" ] && NOTES="$NOTES
- (이 릴리스가 첫 태그입니다 — 위는 최근 ${FIRST_WINDOW} 구간이며, 그 이전 이력은 git 로그에 있습니다)"
DATE="$(TZ=Asia/Seoul date +%Y-%m-%d)"

echo
echo "── 변경 내역 ──"
echo "$NOTES" | head -40
[ "$(echo "$NOTES" | wc -l)" -gt 40 ] && echo "  … 외 $(( $(echo "$NOTES" | wc -l) - 40 ))줄"

if [ "$DRY" -eq 1 ]; then
  echo
  echo "(--dry-run — 태그·CHANGELOG·push 모두 건너뜀)"
  exit 0
fi

# ── CHANGELOG.md 갱신(맨 위에 새 릴리스를 끼워 넣는다) ──
CL="CHANGELOG.md"
TMP="$(mktemp)"
{
  echo "# 변경 이력"
  echo
  echo "고객지원포탈 릴리스 기록. 버전은 배포일 기준(\`vYYYY.MM.DD\`)이며, 화면 우측 상단"
  echo "사용자 메뉴 하단의 \"버전\" 표기와 같은 날짜를 가리킨다."
  echo
  echo "## $VERSION ($DATE)"
  echo
  echo "$NOTES"
  echo
  if [ -f "$CL" ]; then
    # 기존 파일에서 머리말(첫 릴리스 제목 전까지)을 빼고 이어 붙인다
    awk 'f{print} /^## /{if(!f){f=1; print}}' "$CL"
  fi
} > "$TMP"
mv "$TMP" "$CL"

git add "$CL"
git commit -q -m "chore(release): $VERSION — 변경 이력 ${COUNT}건

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>" || { echo "❌ CHANGELOG 커밋 실패"; exit 1; }

if ! git push "$REMOTE" "HEAD:$BRANCH" -q; then
  echo "❌ CHANGELOG push 실패 — 원격이 앞섰을 수 있습니다. git pull 후 다시 실행하세요."
  exit 1
fi

# 태그는 CHANGELOG 커밋까지 포함해서 찍는다(그래야 태그 시점 = 배포된 내용)
NEWSRC="$(git rev-parse HEAD)"
git tag -a "$VERSION" "$NEWSRC" -m "$VERSION ($DATE) — 커밋 ${COUNT}건"
if git push "$REMOTE" "refs/tags/$VERSION" -q; then
  echo "✅ 릴리스 완료: $VERSION → $(git rev-parse --short "$NEWSRC")"
  echo "   CHANGELOG.md 갱신 · 태그 push 완료"
  echo "   되돌리려면: git revert 또는 git checkout $VERSION -- <파일>"
else
  echo "❌ 태그 push 실패 — 로컬 태그는 남아 있습니다: git push $REMOTE refs/tags/$VERSION"
  exit 1
fi
