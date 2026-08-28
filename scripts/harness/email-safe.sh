#!/usr/bin/env bash
# 테스트 모드 토글.
# 원칙: 운영에 필요한 메일 알림은 항상 정상 발송(실수신자). 테스트성 메일만 sjlee@bigxdata.io로 간다.
#   ① 메일: send-email은 on/off 무관하게 항상 운영(리다이렉트·태그 없음). 테스트가 만드는 메일은
#      lib/itest.py의 temail()이 수신자를 sjlee 싱크(sjlee+태그@bigxdata.io)로 지정하므로, 그 메일만
#      자연히 sjlee로 간다. 즉 "운영 메일=실수신자 / 테스트 메일=sjlee"가 수신자 주소로 구분된다.
#      ⚠ 그래서 알림-트리거 테스트는 반드시 temail() 싱크 수신자를 써야 한다(실주소 쓰면 실발송됨).
#   ② 슬랙: 슬랙은 수신자 지정이 불가(채널로 감)라 여전히 안전장치가 필요하다. on이면
#      notify-handler·public-inquiry에 SLACK_REDIRECT=1 → 실 채널(공통/영업/기술지원/교육) 대신
#      테스트 채널(SLACK_WEBHOOK_TEST)로만 발송(원래 대상 채널명은 본문에 남김) + TEST_TAG='[테스트]' 헤더 접두.
#      SLACK_WEBHOOK_TEST 주소는 비밀값이라 이 스크립트가 아니라 Lambda 환경변수에 저장돼 있다.
# 사용: bash scripts/harness/email-safe.sh on|off|status
#   ⚠ on 상태에서는 실 슬랙 알림도 테스트 채널로 리다이렉트되므로(매일 09:00 배치 슬랙 포함), 끝나면 반드시 off.
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
# SLK_TG/RD = 슬랙 태그·리다이렉트(on일 때만). 메일(send-email)은 항상 운영이라 별도 스위치 없음.
case "$MODE" in on) SLK_TG="$TAG"; RD="1" ;; off) SLK_TG=""; RD="" ;; *) echo "사용: email-safe.sh on|off|status"; exit 2 ;; esac

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

echo "테스트 모드 → $MODE"
# send-email은 항상 운영: 리다이렉트(TEST_EMAIL_OVERRIDE)·태그(TEST_TAG) 모두 비운다 → 실수신자에게 정상 발송.
# 테스트 메일은 temail() 싱크 수신자(sjlee+태그)로 발송되므로 그것만 sjlee로 간다.
apply "$SENDMAIL" 1 "" ""                # send-email: 항상 운영(무리다이렉트·무태그)
apply "$NOTIFY"   0 "" "$SLK_TG" "$RD"   # notify-handler: 슬랙 테스트채널 리다이렉트 + [테스트] 태그
apply "$INQUIRY"  0 "" "$SLK_TG" "$RD"   # public-inquiry: 슬랙 테스트채널 리다이렉트 + [테스트] 태그
aws.exe lambda wait function-updated --function-name "$SENDMAIL" --region "$REGION" 2>/dev/null || true
aws.exe lambda wait function-updated --function-name "$NOTIFY" --region "$REGION" 2>/dev/null || true
aws.exe lambda wait function-updated --function-name "$INQUIRY" --region "$REGION" 2>/dev/null || true
echo "적용 결과:"; show
if [ "$MODE" = "on" ]; then echo "⚠ 테스트 끝나면 반드시: bash scripts/harness/email-safe.sh off"; fi
