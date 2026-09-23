// jwt-authorizer Lambda — API Gateway HTTP API의 Lambda Authorizer(REQUEST, simple response).
// DB 연결 없이 토큰 서명/만료만 검증하는 순수 계산 함수라 VPC 밖에 둔다(콜드 스타트가 빠름).
//
// isAuthorized:false를 반환하면 API Gateway가 403을 내려준다 (401이 아님에 주의 —
// 프런트엔드에서 "인증 만료" 판단 시 401과 403을 함께 봐야 한다).
import { verifyToken } from './jwt.mjs';
import { secretValue } from './secrets.mjs';

// 서명 키는 Secrets Manager에서 읽는다(2026-09-22, P-1). 환경변수 노출을 없애되, 조회 실패 시
// JWT_SECRET 환경변수로 폴백해 인증이 통째로 멈추지 않게 한다. 컨테이너당 1회만 조회(캐시).
// api-layer의 signToken과 반드시 같은 값이어야 하므로 같은 시크릿을 본다.
let _jwtSecret = null;
async function jwtSecret() {
  if (_jwtSecret === null) {
    _jwtSecret = await secretValue(process.env.SECRET_JWT || 'customer-portal/jwt', 'JWT_SECRET', process.env.JWT_SECRET);
  }
  return _jwtSecret;
}

export const handler = async (event) => {
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = token ? verifyToken(token, await jwtSecret()) : null;

  if (!payload) return { isAuthorized: false };

  return {
    isAuthorized: true,
    context: {
      userId: payload.sub || '',
      role: payload.role || '',
      companyId: payload.company_id || '',
      contractId: payload.contract_id || '',
      // 조직 도입: 배정된 조직 id 목록. authorizer context 값은 문자열만 허용되므로
      // 콤마로 이어 전달한다. 구토큰(unit_ids 없음)은 빈 문자열 → 하위 필터가 contract/company로 폴백.
      unitIds: Array.isArray(payload.unit_ids) ? payload.unit_ids.join(',') : '',
      // 토큰 폐기(2026-09-18): 로그인 시 users.token_version을 ver 클레임으로 싣는다. 여기선 값만
      // 넘기고 대조는 DB가 있는 data-api/api-layer가 한다(인가자는 DB 없이 빠르게 유지).
      // 구토큰(ver 없음)은 '0' — 컬럼 기본값과 같아 배포 순간 아무도 튕기지 않는다. 항상 키를
      // 넣는 이유: 키 자체가 없는 컨텍스트는 "인가자를 거치지 않은 직접 invoke"(하네스·내부)로 구분한다.
      tokenVersion: String(payload.ver ?? 0),
    },
  };
};
