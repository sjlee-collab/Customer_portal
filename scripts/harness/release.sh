#!/usr/bin/env bash
# 릴리스 태그 + 변경 이력 — "언제 무엇이 나갔는지"를 남기고 되돌릴 기준점을 만든다.
#
# 사용:
#   bash scripts/harness/release.sh --dry-run patch   # 무엇이 나갈지 미리보기(아무것도 안 바꿈)
#   bash scripts/harness/release.sh patch             # 1.2.3 → 1.2.4
#   bash scripts/harness/release.sh minor             # 1.2.3 → 1.3.0
#   bash scripts/harness/release.sh major             # 1.2.3 → 2.0.0
#   bash scripts/harness/release.sh v1.5.0            # 버전을 직접 지정
#
# 버전 규칙: SemVer `vMAJOR.MINOR.PATCH`.
#   이 포탈에는 버전을 읽고 행동을 바꾸는 외부 소비자(라이브러리 사용자, 공개 API 클라이언트)가
#   없다. 그래서 "무엇이 major인가"를 아래처럼 **사내 기준**으로 고정한다. 기준이 없으면
#   매 릴리스마다 자리 배정을 두고 다투게 되고, 번호는 금방 의미를 잃는다.
#
#   MAJOR — 고객에게 공지가 필요한 변경. 쓰던 절차·화면 구조가 바뀌거나(로그인 방식, 권한 체계,
#           조직 계층 개편), 되돌릴 수 없는 DB 스키마 변경이 포함된 릴리스.
#   MINOR — 하위 호환 기능 추가. 새 화면·새 메뉴·새 알림 채널 등(폼 빌더, 사용 통계, 대리 등록).
#   PATCH — 버그 수정, 문구·스타일 조정, 성능 개선, 리팩터. 사용자가 새로 배울 게 없는 변경.
#
#   판단이 갈리면 낮은 쪽으로 간다(minor냐 major냐 → minor). 번호를 올리는 것보다 잘못 올린
#   번호를 되돌리는 쪽이 훨씬 비싸다.
#
# 날짜는 어디에? 태그 메시지와 CHANGELOG 제목에 함께 박힌다(`v1.0.0 (2026-09-15)`). 화면
#   버전 표기도 `v1.0.0 · 2026-09-15 · 커밋7자리`라 번호·날짜·커밋을 한 줄에서 대조할 수 있다.
#
# 무엇을 태그하나: 로컬이 아니라 **origin/main**을 태그한다. 배포되는 것이 origin/main이고,
#   로컬 워크트리는 병렬 세션 때문에 앞서거나 뒤처질 수 있다.
set -uo pipefail

REMOTE="${RELEASE_REMOTE:-origin}"
BRANCH="${RELEASE_BRANCH:-main}"
DRY=0
VERSION=""
LEVEL=""
FIRST_VERSION="${RELEASE_FIRST_VERSION:-v1.0.0}"
usage() {
  echo "사용: release.sh [--dry-run] <major|minor|patch|vX.Y.Z>"
  echo "  major  고객 공지가 필요한 변경 · 되돌릴 수 없는 스키마 변경"
  echo "  minor  하위 호환 기능 추가(새 화면·새 기능)"
  echo "  patch  버그 수정 · 문구 · 성능 · 리팩터"
}
for a in "$@"; do
  case "$a" in
    --dry-run|-n)        DRY=1 ;;
    major|minor|patch)   LEVEL="$a" ;;
    v[0-9]*)             VERSION="$a" ;;
    *) usage; exit 2 ;;
  esac
done

cd "$(dirname "$0")/../.." || { echo "레포 루트를 찾지 못했습니다"; exit 1; }

git fetch "$REMOTE" --tags -q 2>/dev/null || { echo "❌ fetch 실패($REMOTE)"; exit 1; }
SRC="$(git rev-parse --verify -q "$REMOTE/$BRANCH")" || { echo "❌ $REMOTE/$BRANCH 없음"; exit 1; }

# ── 버전 결정: 지정값 우선, 없으면 직전 SemVer 태그에서 한 자리 올린다 ──
# 과거 CalVer 태그(v2026.09.15 등)는 이 계산에서 제외한다. 기록으로는 남되 SemVer 계보와
# 섞이면 안 되기 때문이다. 세 자리 숫자 형식만 후보로 본다.
SEMVER_RE='^v([0-9]+)\.([0-9]+)\.([0-9]+)$'
if [ -n "$VERSION" ]; then
  [[ "$VERSION" =~ $SEMVER_RE ]] || { echo "❌ 버전 형식은 vMAJOR.MINOR.PATCH 입니다 (예: v1.2.0)"; exit 2; }
else
  # 주의: glob 'v[0-9]*.[0-9]*.[0-9]*' 는 CalVer(v2026.09.15)도 잡는다 — 형식이 같기 때문이다.
  # MAJOR가 네 자리(연도)인 태그는 과거 CalVer로 보고 건너뛴다. SemVer MAJOR가 1000에 닿을
  # 일은 없으므로 이 기준이면 두 계보가 섞이지 않는다.
  LAST=""
  while IFS= read -r t; do
    [[ "$t" =~ $SEMVER_RE ]] || continue
    [ "${BASH_REMATCH[1]}" -ge 1000 ] && continue
    LAST="$t"; break
  done < <(git tag -l 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname)
  if [ -z "$LAST" ]; then
    VERSION="$FIRST_VERSION"
    [ -n "$LEVEL" ] && echo "ℹ 첫 SemVer 릴리스입니다 — '$LEVEL' 대신 $VERSION 으로 시작합니다"
  else
    [ -z "$LEVEL" ] && { echo "❌ 올릴 자리를 지정하세요."; usage; exit 2; }
    [[ "$LAST" =~ $SEMVER_RE ]] || { echo "❌ 직전 태그를 해석하지 못했습니다: $LAST"; exit 1; }
    MA="${BASH_REMATCH[1]}"; MI="${BASH_REMATCH[2]}"; PA="${BASH_REMATCH[3]}"
    case "$LEVEL" in
      major) MA=$((MA + 1)); MI=0; PA=0 ;;
      minor) MI=$((MI + 1)); PA=0 ;;
      patch) PA=$((PA + 1)) ;;
    esac
    VERSION="v$MA.$MI.$PA"
    echo "ℹ $LAST → $VERSION ($LEVEL)"
  fi
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
  echo "고객지원포탈 릴리스 기록. 버전은 SemVer(\`vMAJOR.MINOR.PATCH\`)이며, 화면 우측 상단"
  echo "사용자 메뉴 하단의 \"버전\" 표기와 같은 번호를 가리킨다."
  echo
  echo "- **MAJOR** — 고객 공지가 필요한 변경(절차·화면 구조·권한 체계) 또는 되돌릴 수 없는 스키마 변경"
  echo "- **MINOR** — 하위 호환 기능 추가(새 화면·새 기능)"
  echo "- **PATCH** — 버그 수정·문구·성능·리팩터"
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

# ── VERSION 파일 — Amplify 빌드가 이 값을 읽어 화면 버전 표기에 심는다 ──
# (태그는 빌드 환경에서 보이지 않을 수 있어, 번호를 레포 안의 파일로도 남긴다)
echo "${VERSION#v}" > VERSION

git add "$CL" VERSION
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
