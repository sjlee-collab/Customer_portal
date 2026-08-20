#!/usr/bin/env bash
# 메일 안전창 토글 — send-email의 TEST_EMAIL_OVERRIDE 켜기/끄기(다른 env 보존).
# 사용: bash scripts/harness/email-safe.sh on|off|status
#   on  = 모든 메일을 sjlee@bigxdata.io 로 리다이렉트(테스트 창). 끝나면 반드시 off.
#   off = 리다이렉트 해제(운영 정상 발송).
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-customer_portal}"
FN=customer_portal_send-email; REGION=ap-northeast-2
SINK="${OVERRIDE_TO:-sjlee@bigxdata.io}"
MODE="${1:-status}"

get_vars() { aws.exe lambda get-function-configuration --function-name "$FN" --region "$REGION" --query 'Environment.Variables' --output json; }

if [ "$MODE" = "status" ]; then
  get_vars | python -c "import sys,json;d=json.load(sys.stdin);print('TEST_EMAIL_OVERRIDE =', repr(d.get('TEST_EMAIL_OVERRIDE','')))"
  exit 0
fi
case "$MODE" in on) VAL="$SINK" ;; off) VAL="" ;; *) echo "사용: email-safe.sh on|off|status"; exit 2 ;; esac

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
VAL="$VAL" TMP="$TMP" python - <<'PY'
import os, json, subprocess
env=dict(os.environ); env['AWS_PROFILE']=env.get('AWS_PROFILE','customer_portal')
r=subprocess.run(['aws','lambda','get-function-configuration','--function-name','customer_portal_send-email','--region','ap-northeast-2','--query','Environment.Variables','--output','json'],capture_output=True,text=True,env=env)
vars=json.loads(r.stdout); vars['TEST_EMAIL_OVERRIDE']=os.environ['VAL']
pf=os.path.join(os.environ['TMP'],'env.json'); open(pf,'w',encoding='utf-8').write(json.dumps({'Variables':vars},ensure_ascii=False))
u=subprocess.run(['aws','lambda','update-function-configuration','--function-name','customer_portal_send-email','--region','ap-northeast-2','--environment','file://'+pf,'--query','LastUpdateStatus','--output','text'],capture_output=True,text=True,env=env)
os.remove(pf)
print('update:', u.stdout.strip(), u.stderr.strip()[:120])
PY
aws.exe lambda wait function-updated --function-name "$FN" --region "$REGION"
echo -n "적용됨 → "; get_vars | python -c "import sys,json;d=json.load(sys.stdin);print('TEST_EMAIL_OVERRIDE =', repr(d.get('TEST_EMAIL_OVERRIDE','')))"
if [ "$MODE" = "on" ]; then echo "⚠ 테스트 끝나면 반드시: bash scripts/harness/email-safe.sh off"; fi
