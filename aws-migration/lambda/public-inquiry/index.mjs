// 계정 문의 공개 엔드포인트 (POST /public/account-inquiry, 인증 NONE)
//
// 로그인 화면의 "담당자에게 문의" 폼에서 호출한다(비인증). 입력을 검증해
// account_inquiries 테이블에 기록하고, 전용 Slack 채널로 알림을 보낸다.
// 공개 엔드포인트이므로 허니팟·필수검증·길이제한으로 남용을 막는다.
//
// data-api와 동일 VPC/서브넷/보안그룹·DB 시크릿을 재사용한다(db.mjs 그대로 복사).

import { query } from './db.mjs';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

// 계정 문의 알림도 공통 채널(#고객지원포탈-공통)로 보낸다. 변수명 오타(WEEBHOOK)는 기존 그대로.
const SLACK_WEBHOOK = process.env.SLACK_WEEBHOOK_COMMON || '';
// 하네스 테스트 모드 — email-safe.sh on 이면 실 채널 대신 테스트 채널로만 보낸다.
// 웹훅 주소는 비밀값이라 레포가 아닌 Lambda 환경변수로만 보관한다.
const SLACK_WEBHOOK_TEST = process.env.SLACK_WEBHOOK_TEST || '';
const SLACK_REDIRECT     = process.env.SLACK_REDIRECT === '1';
const TEST_TAG           = process.env.TEST_TAG || '';
const SEND_EMAIL_FN = process.env.SEND_EMAIL_FN || 'customer_portal_send-email';
const lambda = new LambdaClient({});

function resp(status, body) {
  return { statusCode: status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// 최초 1회 테이블 생성용 — API Gateway가 아닌 직접 invoke(`{ "__migrate": true }`)로만 동작.
const MIGRATE_SQL = `
create table if not exists public.account_inquiries (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  company     text,
  phone       text,
  email       text,
  message     text,
  status      text not null default 'new' check (status in ('new','handled','spam')),
  handled_by  uuid,
  handled_at  timestamptz,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_account_inquiries_created on public.account_inquiries(created_at desc);
`;

export async function handler(event) {
  // 직접 invoke 마이그레이션/점검(HTTP 요청이 아닐 때만) — 공개 라우트로는 절대 실행 안 됨.
  if (event && event.__migrate === true && !event.requestContext) {
    await query(MIGRATE_SQL);
    return { migrated: true };
  }

  let data;
  try { data = JSON.parse(event.body || '{}'); } catch { return resp(400, { ok: false, error: 'bad json' }); }

  // 이메일 중복 확인(계정 신청 폼) — users에 이미 있는 이메일이면 안내용. 대소문자 무시.
  if (data.action === 'check-email') {
    const em = (typeof data.email === 'string' ? data.email.trim().slice(0, 150) : '');
    if (!em || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return resp(200, { ok: true, exists: false });
    try {
      const rows = await query('select 1 from public.users where lower(email) = lower($1) limit 1', [em]);
      return resp(200, { ok: true, exists: (rows || []).length > 0 });
    } catch (e) {
      console.error('[inquiry] check-email 실패', e);
      return resp(200, { ok: true, exists: false }); // 오류 시 신청을 막지 않는다
    }
  }

  // 허니팟: 사람에겐 보이지 않는 필드가 채워졌으면 봇으로 간주하고 조용히 성공 처리.
  if (data.website) return resp(200, { ok: true });

  const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');
  const name    = clip(data.name, 100);
  const company = clip(data.company, 150);
  const phone   = clip(data.phone, 50);
  const email   = clip(data.email, 150);
  const message = clip(data.message, 1000);

  if (!name || !company || !phone || !email) return resp(400, { ok: false, error: 'missing required fields' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return resp(400, { ok: false, error: 'invalid email' });

  // 이미 가입된 이메일이면 계정 신청을 막는다(프론트 버튼잠금의 서버측 방어).
  try {
    const dup = await query('select 1 from public.users where lower(email) = lower($1) limit 1', [email]);
    if ((dup || []).length) return resp(409, { ok: false, exists: true, error: 'already registered' });
  } catch (e) { console.error('[inquiry] 중복확인 실패', e); }

  // ① DB 기록 (실패해도 Slack은 시도)
  let dbOk = false;
  try {
    await query(
      `insert into public.account_inquiries (name, company, phone, email, message) values ($1,$2,$3,$4,$5)`,
      [name, company, phone, email, message || null]
    );
    dbOk = true;
  } catch (e) { console.error('[inquiry] db insert 실패', e); }

  // ② Slack 발송 (best-effort)
  let slackOk = false;
  const slackHook = (SLACK_REDIRECT && SLACK_WEBHOOK_TEST) ? SLACK_WEBHOOK_TEST : SLACK_WEBHOOK;
  if (slackHook) {
    try {
      const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
      const lines = [
        (TEST_TAG ? TEST_TAG + ' ' : '') + '📩 *신규 계정 요청*',
        `• 성함: ${name}`,
        `• 기업명: ${company}`,
        `• 연락처: ${phone}`,
        `• 이메일: ${email}`,
      ];
      if (message) lines.push(`• 내용: ${message}`);
      lines.push(`• 접수: ${now}`);
      const r = await fetch(slackHook, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: lines.join('\n') }),
      });
      slackOk = r.ok;
      if (!r.ok) console.error('[inquiry] slack HTTP', r.status);
    } catch (e) { console.error('[inquiry] slack 실패', e); }
  }

  // ③ 관리자(role=admin) 이메일 알림 — send-email Lambda를 비동기(Event) 호출. best-effort.
  //    응답을 막지 않도록 fire-and-forget. 실패해도 DB/Slack 결과에는 영향 없음.
  try {
    const admins = await query(
      "select email from public.users where role='admin' and coalesce(is_active,true)=true and email is not null"
    );
    const adminEmails = (admins || []).map(r => r.email).filter(Boolean);
    if (adminEmails.length) {
      await lambda.send(new InvokeCommand({
        FunctionName: SEND_EMAIL_FN,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify({
          type: 'ACCOUNT_INQUIRY', adminEmails, name, company, phone, email, message: message || '',
        })),
      }));
    }
  } catch (e) { console.error('[inquiry] 관리자 메일 알림 실패', e); }

  // DB·Slack 둘 다 실패하면 오류로 알려 재시도를 유도한다.
  if (!dbOk && !slackOk) return resp(502, { ok: false, error: 'delivery failed' });
  return resp(200, { ok: true });
}
