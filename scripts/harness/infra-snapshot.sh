#!/usr/bin/env bash
# 인프라 구성 스냅샷 — 콘솔에만 있는 설정을 infra/snapshot/*.json으로 떠서 레포에 남긴다.
# 복원을 자동화하지는 않는다. "원래 뭐였는지"를 남기고, 누가 콘솔에서 바꾸면 diff에 드러나게 한다.
#
# 사용:
#   bash scripts/harness/infra-snapshot.sh           # 스냅샷 갱신
#   bash scripts/harness/infra-snapshot.sh --check   # 갱신 후 달라진 설정이 있으면 종료코드 1
#
# 비밀값은 담지 않는다(민감 키는 sha256 지문으로 대체). 상세는 infra/snapshot/README.md.
set -u
export AWS_PROFILE="${AWS_PROFILE:-customer_portal}"
export AWS_PAGER=""
# 윈도우 콘솔 기본값(cp949)이면 AWS CLI가 한글·em-dash 출력에서 그대로 죽는다.
export PYTHONIOENCODING=utf-8
export PYTHONUTF8=1

cd "$(dirname "$0")/../.." || { echo "레포 루트를 찾지 못했습니다"; exit 1; }
exec python scripts/harness/infra_snapshot.py "$@"
