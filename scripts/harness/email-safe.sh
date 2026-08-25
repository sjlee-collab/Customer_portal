#!/usr/bin/env bash
# 테스트 모드 토글 — 테스트로 트리거되는 알림이 "테스트용"임을 보장한다.
#   ① 메일: send-email의 TEST_EMAIL_OVERRIDE=sink → 모든 메일을 sjlee 싱크로 리다이렉트(실 고객 무발송)
#   ② 표기: send-email·notify-handler의 TEST_TAG='[테스트]' → 메일 제목/슬랙 헤더에 [테스트] 접두
# 사용: bash scripts/harness/email-safe.sh on|off|status
#   ⚠ on 상태에서는 실 알림도 리다이렉트/태그되므로, 테스트 끝나면 반드시 off. (매일 09:00 배치 슬랙도 영향)
# 참고: TEST_TAG를 실제로 붙이는 건 notify-handler/send-email 코드가 이 env를 읽도록 배포된 뒤 활성화된다
#       (사용통계 기능 배포 시 포함). 그 전에도 테스트 데이터의 [테스트] 라벨이 제목에 노출되어 식별된다.
set -uo pipefail
export AWS_PROFILE="${AWS_PROFILE:-customer_portal}"
REGION=ap-northeast-2
SINK="${OVERRIDE_TO:-sjlee@bigxdata.io}"
TAG="[테스트]"
MODE="${1:-status}"

# 함수명 ↔ 세팅할 env(키=값; VALUE는 on일 때 값, off일 때 빈문자)
SENDMAIL=customer_portal_send-email
NOTIFY=customer_portal_notify-handler

show() {
  for fn in "$SENDMAIL" "$NOTIFY"; do
    aws.exe lambda get-function-configuration --function-name "$fn" --region "$REGION" --query 'Environment.Variables' --output json \
      | python -c "import sys,json;d=json.load(sys.stdin);print('  %-32s TEST_EMAIL_OVERRIDE=%r TEST_TAG=%r'%('$fn', d.get('TEST_EMAIL_OVERRIDE',''), d.get('TEST_TAG','')))"
  done
}

if [ "$MODE" = "status" ]; then echo "현재 테스트 모드:"; show; exit 0; fi
case "$MODE" in on) OV="$SINK"; TG="$TAG" ;; off) OV=""; TG="" ;; *) echo "사용: email-safe.sh on|off|status"; exit 2 ;; esac

apply() { # $1=함수명  $2=setov(1이면 TEST_EMAIL_OVERRIDE도 설정)  $3=override값  $4=tag값
  FN="$1" SETOV="$2" OV="$3" TG="$4" python - <<'PY'
import os, json, subprocess, tempfile
env=dict(os.environ); env['AWS_PROFILE']=env.get('AWS_PROFILE','customer_portal')
fn=os.environ['FN']
r=subprocess.run(['aws','lambda','get-function-configuration','--function-name',fn,'--region','ap-northeast-2','--query','Environment.Variables','--output','json'],capture_output=True,text=True,env=env)
vars=json.loads(r.stdout or '{}')
if os.environ.get('SETOV')=='1': vars['TEST_EMAIL_OVERRIDE']=os.environ['OV']
vars['TEST_TAG']=os.environ['TG']
pf=tempfile.NamedTemporaryFile('w',suffix='.json',delete=False,encoding='utf-8'); pf.write(json.dumps({'Variables':vars},ensure_ascii=False)); pf.close()
u=subprocess.run(['aws','lambda','update-function-configuration','--function-name',fn,'--region','ap-northeast-2','--environment','file://'+pf.name,'--query','LastUpdateStatus','--output','text'],capture_output=True,text=True,env=env)
os.remove(pf.name)
print('  update %-32s %s %s'%(fn, u.stdout.strip(), u.stderr.strip()[:100]))
PY
}

echo "테스트 모드 → $MODE"
apply "$SENDMAIL" 1 "$OV" "$TG"     # send-email: override + tag
apply "$NOTIFY"   0 ""   "$TG"      # notify-handler: tag만
aws.exe lambda wait function-updated --function-name "$SENDMAIL" --region "$REGION" 2>/dev/null || true
aws.exe lambda wait function-updated --function-name "$NOTIFY" --region "$REGION" 2>/dev/null || true
echo "적용 결과:"; show
if [ "$MODE" = "on" ]; then echo "⚠ 테스트 끝나면 반드시: bash scripts/harness/email-safe.sh off"; fi
