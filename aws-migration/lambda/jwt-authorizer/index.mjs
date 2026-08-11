// jwt-authorizer Lambda — API Gateway HTTP API의 Lambda Authorizer(REQUEST, simple response).
// DB 연결 없이 토큰 서명/만료만 검증하는 순수 계산 함수라 VPC 밖에 둔다(콜드 스타트가 빠름).
//
// isAuthorized:false를 반환하면 API Gateway가 403을 내려준다 (401이 아님에 주의 —
// 프런트엔드에서 "인증 만료" 판단 시 401과 403을 함께 봐야 한다).
import { verifyToken } from './jwt.mjs';

const JWT_SECRET = process.env.JWT_SECRET;

export const handler = async (event) => {
  const authHeader = event.headers?.authorization || event.headers?.Authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const payload = token ? verifyToken(token, JWT_SECRET) : null;

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
    },
  };
};
