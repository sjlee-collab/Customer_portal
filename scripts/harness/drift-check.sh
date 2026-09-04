#!/usr/bin/env bash
# 레포 소스 ↔ 배포된 Lambda 코드 대조 (읽기 전용 — 운영 무변경).
#
# 왜: Lambda는 git push로 배포되지 않아 레포와 배포본이 조용히 갈라진다(drift).
#     2026-08-31 실사례 — 상태알림 확대·마감일 판정이 배포본에만 있었고, 모르고
#     재배포했다면 운영이 옛 동작으로 롤백될 뻔했다. 지금까지는 deploy-fn.sh의
#     배포 직전 진단이 유일한 감지 시점이라, 커밋·리뷰 시점용으로 이 스크립트를 둔다.
#
# 사용: bash scripts/harness/drift-check.sh            # 7개 함수 전부
#       bash scripts/harness/drift-check.sh api-layer  # 하나만
# 종료코드: 전부 일치 0 / drift 있음 1 (훅·주기점검에서 사용 가능)
#
# 비교 규칙: 레포 소스 폴더의 *.mjs만 대조한다(배포 zip의 node_modules는 무시).
#   개행(CRLF/LF)만 다른 것은 일치로 본다 — 워크트리 autocrlf 차이는 drift가 아니다.
#   배포본 루트에만 있는 .mjs(레포에 없는 파일)도 drift로 보고한다.
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-customer_portal}"
REGION=ap-northeast-2
HDIR="$(cd "$(dirname "$0")" && pwd)"
LDIR="$(cd "$HDIR/../../backend/lambda" && pwd)"

declare -A FN=(
  [api-layer]=customer-portal_slack_status_change
  [data-api]=customer_portal_data-api
  [public-inquiry]=customer_portal_public-inquiry
  [send-email]=customer_portal_send-email
  [storage-api]=customer_portal_storage-api
  [jwt-authorizer]=customer_portal_jwt-authorizer
  [notify-handler]=customer_portal_notify-handler
)

if [ "$#" -gt 0 ]; then
  [ -n "${FN[$1]:-}" ] || { echo "알 수 없는 함수: $1 (가능: ${!FN[*]})"; exit 2; }
  KEYS=("$1")
else
  KEYS=(api-layer data-api public-inquiry send-email storage-api jwt-authorizer notify-handler)
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
drift=0

for k in "${KEYS[@]}"; do
  fn="${FN[$k]}"
  url="$(aws lambda get-function --function-name "$fn" --region "$REGION" \
         --query 'Code.Location' --output text 2>/dev/null)" || url=""
  if [ -z "$url" ] || [ "$url" = "None" ]; then
    echo "❌ $k: 배포본 조회 실패($fn) — 자격증명/함수명 확인"; drift=1; continue
  fi
  mkdir -p "$TMP/$k"
  curl -sf -o "$TMP/$k.zip" "$url" && unzip -oq "$TMP/$k.zip" -d "$TMP/$k" \
    || { echo "❌ $k: 다운로드/압축해제 실패"; drift=1; continue; }

  bad=()
  # 레포 쪽 각 .mjs를 배포본과 대조
  for f in "$LDIR/$k"/*.mjs; do
    b="$(basename "$f")"
    if [ ! -f "$TMP/$k/$b" ]; then bad+=("$b(배포본에 없음)"); continue; fi
    diff -q <(tr -d '\r' < "$f") <(tr -d '\r' < "$TMP/$k/$b") >/dev/null \
      || bad+=("$b($(diff <(tr -d '\r' < "$f") <(tr -d '\r' < "$TMP/$k/$b") | grep -c '^[<>]')줄)")
  done
  # 배포본 루트에만 있는 .mjs
  for f in "$TMP/$k"/*.mjs; do
    [ -e "$f" ] || continue
    b="$(basename "$f")"
    [ -f "$LDIR/$k/$b" ] || bad+=("$b(레포에 없음)")
  done

  if [ "${#bad[@]}" -eq 0 ]; then
    echo "✅ $k ($fn): 일치"
  else
    echo "❌ $k ($fn): drift — ${bad[*]}"
    drift=1
  fi
done

echo "──────────────────────────────"
if [ "$drift" -eq 0 ]; then
  echo "✅ 레포 = 배포본 (재배포 안전)"
else
  echo "❌ drift 있음 — 재배포 전 반드시 원인 확인. 배포본이 앞서 있으면 레포를 먼저"
  echo "   역동기화할 것(그냥 deploy-fn 하면 운영이 옛 동작으로 롤백된다). DESIGN.md §6.5 참고."
fi
exit $drift
