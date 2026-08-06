// RDS 접속 — 비밀번호는 Secrets Manager에서 읽어온다.
//
// 예전에는 DB_PASSWORD 환경변수에 비밀번호를 박아뒀는데, RDS 마스터 시크릿이 7일마다
// 자동 회전되기 때문에 회전될 때마다 환경변수가 낡아 인증이 깨졌다(2026-08-06에 실제로
// 약 50분간 로그인 장애 발생). 그래서 실행 시점에 시크릿을 읽고, 인증 오류가 나면
// 시크릿을 다시 읽어 한 번 재시도한다 — 회전이 나도 스스로 복구된다.

import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const DB_SECRET_ID = process.env.DB_SECRET_ID;
const sm = DB_SECRET_ID ? new SecretsManagerClient({}) : null;

let pool = null;

// 시크릿을 못 읽는 상황(권한·네트워크 문제)에서도 서비스가 멈추지 않도록
// 기존 DB_PASSWORD 환경변수를 폴백으로 남겨둔다.
async function resolveCredentials() {
  if (sm) {
    try {
      const res = await sm.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ID }));
      const s = JSON.parse(res.SecretString);
      if (s.password) return { user: s.username || process.env.DB_USER, password: s.password };
    } catch (err) {
      console.error('[db] Secrets Manager 조회 실패 — DB_PASSWORD 폴백 사용', err);
    }
  }
  return { user: process.env.DB_USER, password: process.env.DB_PASSWORD };
}

async function createPool() {
  const { user, password } = await resolveCredentials();
  return new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user,
    password,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
}

export async function getPool() {
  if (!pool) pool = await createPool();
  return pool;
}

// 비밀번호가 회전된 뒤 낡은 자격증명으로 만들어진 풀은 버리고 새로 만든다.
async function resetPool() {
  const old = pool;
  pool = null;
  if (old) { try { await old.end(); } catch (_) {} }
}

// 잘못된 비밀번호는 PostgreSQL 28P01(invalid_password)로 온다.
function isAuthError(err) {
  return !!err && (err.code === '28P01' || /password authentication failed/i.test(err.message || ''));
}

export async function query(sql, params = []) {
  try {
    const { rows } = await (await getPool()).query(sql, params);
    return rows;
  } catch (err) {
    if (!isAuthError(err)) throw err;
    console.warn('[db] 인증 실패 — 비밀번호 회전 가능성. 시크릿을 다시 읽고 1회 재시도합니다.');
    await resetPool();
    const { rows } = await (await getPool()).query(sql, params);
    return rows;
  }
}
