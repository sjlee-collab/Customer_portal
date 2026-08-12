#!/bin/bash
# 코드 문법 검사 하네스 — index.html 수정 후 push 전에 반드시 실행
#   1) index.html 내장 <script> 블록 JS 문법 검사
#   2) aws-migration/lambda/**/*.mjs ESM 문법 검사
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

# 1) index.html 내장 JS (단일 <script> 블록 전제)
start=$(grep -an '<script>' index.html | head -1 | cut -d: -f1)
end=$(grep -an '</script>' index.html | tail -1 | cut -d: -f1)
if [ -z "$start" ] || [ -z "$end" ] || [ "$start" -ge "$end" ]; then
  echo "FAIL index.html: <script> 블록을 찾지 못함 (start=$start end=$end)"
  fail=1
else
  tmp=$(mktemp /tmp/index-embedded-XXXXXX.js)
  sed -n "$((start + 1)),$((end - 1))p" index.html > "$tmp"
  if node --check "$tmp"; then
    echo "OK   index.html 내장 JS (라인 $((start + 1))~$((end - 1)))"
  else
    echo "FAIL index.html 내장 JS 문법 오류"
    fail=1
  fi
  rm -f "$tmp"
fi

# 2) Lambda 소스 (.mjs)
for f in aws-migration/lambda/*/*.mjs; do
  if node --check "$f" 2>/dev/null || node --input-type=module --check < "$f"; then
    echo "OK   $f"
  else
    echo "FAIL $f"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "== 문법 검사 실패 — push 금지 =="
  exit 1
fi
echo "== 전체 문법 검사 통과 =="
