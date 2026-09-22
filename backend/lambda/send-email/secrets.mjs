// Secrets Manager 조회 — 의존성 0 (Node 내장 crypto + fetch로 SigV4 직접 서명)
//
// 왜 AWS SDK를 안 쓰나(2026-09-22, P-1):
//   jwt-authorizer·send-email·notify-handler는 node_modules가 아예 없고(의존성 0), 런타임이
//   nodejs22.x/24.x다. Node.js 22부터 Lambda 런타임은 AWS SDK를 포함하지 않으므로
//   `@aws-sdk/client-secrets-manager`를 import하면 모듈을 못 찾아 함수가 즉시 죽는다
//   (jwt-authorizer가 죽으면 전 API가 401). 게다가 배포 스크립트(deploy-fn.sh)는 .mjs만
//   교체·추가하므로 node_modules를 새로 넣을 수도 없다. 그래서 GetSecretValue 한 건만
//   직접 서명해 호출한다 — 파일 하나, 의존성 0, 모든 Lambda에서 동일하게 동작.
//
// 자격증명은 Lambda 실행 환경이 환경변수로 넣어준다(AWS_ACCESS_KEY_ID / SECRET / SESSION_TOKEN).
// 값은 모듈 스코프에 캐시하므로 컨테이너당 1회만 조회한다(콜드스타트 +50~150ms, 이후 0).

import { createHmac, createHash } from 'node:crypto';

const REGION = process.env.AWS_REGION || 'ap-northeast-2';
const SERVICE = 'secretsmanager';
const cache = new Map();   // name -> 파싱된 객체
const inflight = new Map(); // name -> Promise (동시 요청이 중복 조회하지 않도록)

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s, 'utf8').digest();

function signingKey(secretKey, date) {
  let k = hmac(`AWS4${secretKey}`, date);
  k = hmac(k, REGION);
  k = hmac(k, SERVICE);
  return hmac(k, 'aws4_request');
}

async function fetchSecret(secretId) {
  const accessKey = process.env.AWS_ACCESS_KEY_ID;
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY;
  const token = process.env.AWS_SESSION_TOKEN || '';
  if (!accessKey || !secretKey) throw new Error('실행 환경 자격증명 없음');

  const host = `${SERVICE}.${REGION}.amazonaws.com`;
  const body = JSON.stringify({ SecretId: secretId });
  const bodyHash = sha256hex(body);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const date = amzDate.slice(0, 8);

  // 서명 대상 헤더는 소문자·이름순. 세션 토큰이 있을 때만 포함한다.
  const headers = {
    'content-type': 'application/x-amz-json-1.1',
    host,
    'x-amz-date': amzDate,
    'x-amz-target': 'secretsmanager.GetSecretValue',
  };
  if (token) headers['x-amz-security-token'] = token;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map(n => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, bodyHash].join('\n');
  const scope = `${date}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(secretKey, date)).update(stringToSign, 'utf8').digest('hex');

  const res = await fetch(`https://${host}/`, {
    method: 'POST',
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`GetSecretValue HTTP ${res.status} ${txt.slice(0, 200)}`);
  }
  const j = await res.json();
  if (!j.SecretString) throw new Error('SecretString 없음');
  return JSON.parse(j.SecretString);
}

/** 시크릿(JSON)을 객체로 반환. 실패하면 null — 호출부가 환경변수로 폴백한다. */
export async function getSecret(secretId) {
  if (cache.has(secretId)) return cache.get(secretId);
  if (inflight.has(secretId)) return inflight.get(secretId);
  const p = fetchSecret(secretId)
    .then(obj => { cache.set(secretId, obj); inflight.delete(secretId); return obj; })
    .catch(err => {
      inflight.delete(secretId);
      console.error(`[secrets] ${secretId} 조회 실패 — 환경변수 폴백`, err?.message || err);
      return null;
    });
  inflight.set(secretId, p);
  return p;
}

/**
 * 시크릿의 키 하나를 읽고, 없으면 환경변수 폴백.
 * 전환기에는 둘 다 살아 있고, env를 지우면 시크릿만 쓰인다.
 */
export async function secretValue(secretId, key, fallbackEnv) {
  const obj = await getSecret(secretId);
  const v = obj && obj[key];
  if (v) return v;
  if (fallbackEnv) console.warn(`[secrets] ${secretId}#${key} 없음 — 환경변수 사용`);
  return fallbackEnv || '';
}
