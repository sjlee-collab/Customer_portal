#!/usr/bin/env bash
# API Gateway 라우트 조회/추가 (HTTP API 8xbmazu4ij, 인가자·통합 재사용).
# 사용:
#   bash scripts/harness/apigw-route.sh list
#   bash scripts/harness/apigw-route.sh add "DELETE /tickets/{id}"    # 기존 /tickets 통합·인가자 재사용
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-customer_portal}"
API=8xbmazu4ij; REGION=ap-northeast-2
CMD="${1:-list}"

if [ "$CMD" = "list" ]; then
  aws.exe apigatewayv2 get-routes --api-id "$API" --region "$REGION" --query 'Items[].RouteKey' --output json
  exit 0
fi
if [ "$CMD" = "add" ]; then
  RK="${2:?사용: apigw-route.sh add \"METHOD /path\"}"
  # 기존 /tickets/{id}/manage 라우트의 통합·인가자를 재사용(같은 api-layer 대상)
  REF=$(aws.exe apigatewayv2 get-routes --api-id "$API" --region "$REGION" \
        --query "Items[?RouteKey=='PATCH /tickets/{id}/manage']|[0].{t:Target,a:AuthorizerId}" --output json)
  TARGET=$(echo "$REF" | python -c "import sys,json;print(json.load(sys.stdin)['t'])")
  AUTHZ=$(echo "$REF"  | python -c "import sys,json;print(json.load(sys.stdin)['a'])")
  echo "재사용: target=$TARGET authorizer=$AUTHZ"
  aws.exe apigatewayv2 create-route --api-id "$API" --region "$REGION" \
    --route-key "$RK" --target "integrations/${TARGET#integrations/}" \
    --authorization-type CUSTOM --authorizer-id "$AUTHZ" \
    --query '{RouteKey:RouteKey,Auth:AuthorizationType,Target:Target}' --output json
  exit 0
fi
echo "사용: apigw-route.sh list | add \"METHOD /path\""; exit 2
