// 아주 작은 자체 JWT 서명/검증 (HS256) — 외부 라이브러리 없이 node:crypto만 사용.
// jwt-authorizer Lambda도 같은 로직(복사본)으로 검증하므로 두 곳의 알고리즘을 반드시 맞춰야 한다.
import { createHmac, timingSafeEqual } from 'node:crypto';

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(headerB64, payloadB64, secret) {
  return base64url(createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest());
}

export function signToken(claims, secret, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const headerB64 = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadB64 = base64url(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds }));
  return `${headerB64}.${payloadB64}.${sign(headerB64, payloadB64, secret)}`;
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
