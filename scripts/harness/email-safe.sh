#!/usr/bin/env bash
# 테스트 알림 분리는 이제 "자동"이라 이 스크립트는 사실상 호환용(운영 상태로 리셋)이다.
# 원칙: 운영 알림은 항상 정상 발송, 테스트 알림만 테스트로 격리 — 둘 다 코드가 자동 구분한다.
#   ① 메일: send-email은 항상 운영(실수신자 발송). 테스트 메일은 lib/itest.py의 temail()이
#      수신자를 sjlee 싱크(sjlee+태그@bigxdata.io)로 지정하므로 그것만 sjlee로 간다.
#   ② 슬랙: notify-handler·public-inquiry가 **알림 대상 데이터의 제목/기업명이 "[테스트]"로 시작하면**
#      실 채널 대신 테스트 채널(SLACK_WEBHOOK_TEST)로만 보낸다(+[테스트] 태그). 운영 알림은 항상 실 채널.
#      즉 예전의 전역 SLACK_REDIRECT 스위치는 더 이상 필요 없다(라벨로 자동 라우팅).
# 사용: bash scripts/harness/email-safe.sh on|off|status
#   on/off 모두 세 Lambda의 테스트 env(TEST_EMAIL_OVERRIDE·TEST_TAG·SLACK_REDIRECT)를 비워 운영 상태로 만든다
#   (혹시 예전에 남은 리다이렉트/태그 값을 정리하는 용도). status로 현재 값 확인 가능.
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-customer_portal}"
REGION=ap-northeast-2
SINK="${OVERRIDE_TO:-sjlee@bigxdata.io}"
TAG="[테스트]"
MODE="${1:-status}"

# 함수명 ↔ 세팅할 env(키=값; VALUE는 on일 때 값, off일 때 빈문자)
SENDMAIL=customer_portal_send-email
NOTIFY=customer_portal_notify-handler
INQUIRY=customer_portal_public-inquiry

show() {
  for fn in "$SENDMAIL" "$NOTIFY" "$INQUIRY"; do
    aws.exe lambda get-function-configuration --function-name "$fn" --region "$REGION" --query 'Environment.Variables' --output json \
      | python -c "import sys,json;d=json.load(sys.stdin);print('  %-34s TEST_EMAIL_OVERRIDE=%r TEST_TAG=%r SLACK_REDIRECT=%r 테스트웹훅=%s'%('$fn', d.get('TEST_EMAIL_OVERRIDE',''), d.get('TEST_TAG',''), d.get('SLACK_REDIRECT',''), '등록됨' if d.get('SLACK_WEBHOOK_TEST') else '없음'))"
  done
}

if [ "$MODE" = "status" ]; then echo "현재 테스트 모드:"; show; exit 0; fi
# 테스트 분리는 자동(메일=sink 수신자, 슬랙=[테스트] 라벨 라우팅)이라 on/off 모두 운영 상태로 리셋한다.
case "$MODE" in on|off) : ;; *) echo "사용: email-safe.sh on|off|status"; exit 2 ;; esac

apply() { # $1=함수명  $2=setov(1이면 TEST_EMAIL_OVERRIDE도 설정)  $3=override값  $4=tag값
  FN="$1" SETOV="$2" OV="$3" TG="$4" RD="${5:-}" python - <<'PY'
import os, json, subprocess
env=dict(os.environ); env['AWS_PROFILE']=env.get('AWS_PROFILE','customer_portal'); env['PYTHONIOENCODING']='utf-8'
fn=os.environ['FN']
r=subprocess.run(['aws','lambda','get-function-configuration','--function-name',fn,'--region','ap-northeast-2','--query','Environment.Variables','--output','json'],capture_output=True,text=True,env=env)
vars=json.loads(r.stdout or '{}')
if os.environ.get('SETOV')=='1': vars['TEST_EMAIL_OVERRIDE']=os.environ['OV']
vars['TEST_TAG']=os.environ['TG']
# 슬랙 리다이렉트 스위치. 웹훅 주소(SLACK_WEBHOOK_TEST)는 건드리지 않고 이미 등록된 값을 그대로 둔다.
vars['SLACK_REDIRECT']=os.environ.get('RD','')
# 인라인 JSON으로 전달(파일 인코딩 회피). subprocess args라 셸 인용 불필요.
payload=json.dumps({'Variables':vars},ensure_ascii=False)
u=subprocess.run(['aws','lambda','update-function-configuration','--function-name',fn,'--region','ap-northeast-2','--environment',payload,'--query','LastUpdateStatus','--output','text'],capture_output=True,text=True,env=env)
print('  update %-32s %s %s'%(fn, u.stdout.strip(), u.stderr.strip()[:120]))
PY
}

echo "운영 상태로 리셋 (테스트 분리는 자동)"
# 세 Lambda의 테스트 env를 모두 비워 운영 상태 보장. 테스트 격리는 코드가 자동 처리.
apply "$SENDMAIL" 1 "" "" ""   # send-email: 항상 운영
apply "$NOTIFY"   0 "" "" ""   # notify-handler: SLACK_REDIRECT/TAG 비움([테스트] 라벨로 자동 라우팅)
apply "$INQUIRY"  0 "" "" ""   # public-inquiry: 동일
aws.exe lambda wait function-updated --function-name "$SENDMAIL" --region "$REGION" 2>/dev/null || true
aws.exe lambda wait function-updated --function-name "$NOTIFY" --region "$REGION" 2>/dev/null || true
aws.exe lambda wait function-updated --function-name "$INQUIRY" --region "$REGION" 2>/dev/null || true
echo "적용 결과:"; show
echo "ℹ 테스트 알림 격리는 자동입니다(메일=temail 싱크 / 슬랙=[테스트] 제목 라우팅). 이 명령은 운영 상태 리셋용."
