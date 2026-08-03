// api-layer/jwt.mjs와 동일한 서명/검증 로직의 복사본 — 이 프로젝트는 Lambda Layer를 쓰지
// 않고 각 Lambda 디렉터리를 그대로 zip 배포하므로, 알고리즘을 바꿀 땐 두 파일을 함께 고쳐야 한다.
import { createHmac, timingSafeEqual } from 'node:crypto';

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(headerB64, payloadB64, secret) {
  return base64url(createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest());
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  const expectedSig = sign(headerB64, payloadB64, secret);
  const a = Buffer.from(sigB64), b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload;
  try { payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch { return null; }
  if (!payload.exp || Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}
