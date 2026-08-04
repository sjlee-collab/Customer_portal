// api-layer Lambda — 티켓 생성/상태변경/담당자배정 API (RDS 직접 연결, VPC 안)
// index.html(Phase 6)이 API Gateway를 통해 호출하게 될 엔드포인트.
// DB 쓰기 후 notify-handler/send-email Lambda를 직접 호출해서 알림을 보낸다.
//
// Slack/이메일 발송은 외부 API 호출이라 느릴 수 있어 클라이언트 응답을 기다리게 하면 안 된다.
// 응답을 만든 뒤 await 없이 그냥 두는 방식(fire-and-forget)은 Lambda 실행 환경이 응답 직후
// 멈춰버릴 수 있어 신뢰할 수 없으므로, 자기 자신을 비동기(Event) 방식으로 재호출해서
// 완전히 별도의 Lambda 실행으로 알림 처리를 넘긴다 (deferNotify / __deferred 분기).

import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { query } from './db.mjs';
import { notifySlack, notifyEmail } from './notify.mjs';
import { signToken } from './jwt.mjs';

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const JWT_SECRET = process.env.JWT_SECRET;
// 클라이언트의 절대 세션 만료(SESSION_ABSOLUTE_LIMIT_MS, index.html)와 맞춤 — 토큰이
// 화면상 "로그인 유지" 시간보다 먼저 만료되면 만료 안내 없이 API가 갑자기 401나기 시작한다.
const TOKEN_TTL_SECONDS = 8 * 60 * 60;

const lambda = new LambdaClient({});
const SELF_FN = process.env.AWS_LAMBDA_FUNCTION_NAME;

const ALLOWED_ORIGINS = ['https://support.bigxdata.io', 'https://dev.dlayoierdftk6.amplifyapp.com'];

function corsHeaders(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin;
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Vary': 'Origin',
  };
}

let currentEvent = null;

// 비밀번호 해시 — scrypt(salt 포함, node:crypto 내장, 느린 KDF)를 표준으로 쓴다.
// 예전 두 세대의 저장 형식(평문 / salt 없는 SHA-256)도 로그인 성공 시 이 형식으로 자동 승격한다.
function hashPassword(pw) {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function isScryptHash(pw) { return typeof pw === 'string' && /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(pw); }
function isSha256Hash(pw) { return typeof pw === 'string' && /^[0-9a-f]{64}$/.test(pw); }
function isHashed(pw) { return isScryptHash(pw) || isSha256Hash(pw); }

function checkPassword(pw, stored) {
  if (isScryptHash(stored)) {
    const [, saltHex, hashHex] = stored.split('$');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
  if (isSha256Hash(stored)) {
    return createHash('sha256').update(pw, 'utf8').digest('hex') === stored;
  }
  return pw === stored; // 아주 오래된 평문 legacy 계정
}

const DEFAULT_ASSIGNEE_BY_CATEGORY = {
  education: { id: '53d240b2-b950-4c94-9289-17feb229aa69', name: '김서연' }, // syeonkim@bigxdata.io
  tech_support: { id: 'f3637639-2574-41e7-83dd-2f7891c79688', name: '강원이' }, // wykang@bigxdata.io
};
const COMPANY_MANAGER_FIELD_BY_CATEGORY = {
  contract: 'account_manager',
  license: 'account_manager',
};
const STATUS_KO = {
  received: '접수', classifying: '분류 중', assigned: '담당자 배정', in_progress: '처리 중',
  pending_customer: '고객 확인 필요', on_hold: '보류', completed: '완료', cancelled: '취소',
};

function json(statusCode, body) {
  return { statusCode, headers: { ...corsHeaders(currentEvent), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

async function getTicket(id) {
  const rows = await query('select * from tickets where id=$1', [id]);
  return rows[0] ?? null;
}

async function getCompanyName(companyId) {
  if (!companyId) return '-';
  const rows = await query('select name from companies where id=$1', [companyId]);
  return rows[0]?.name ?? '-';
}

async function getUser(userId) {
  if (!userId) return null;
  const rows = await query('select id, name, email, role, company_id, contract_id from users where id=$1', [userId]);
  return rows[0] ?? null;
}

// JWT 인가자(jwt-authorizer)가 넘겨준 role/userId/companyId/contractId — data-api에서
// 이미 검증된 것과 동일한 패턴. api-layer의 /tickets/* 엔드포인트들은 지금까지 이 정보를
// 전혀 확인하지 않고 body 값만 그대로 믿어서, 로그인만 하면 남의 티켓 상태변경·재배정·
// 답글주입·내부메모작성·사칭이 전부 가능했다(실제 테스트로 확인).
function getAuthz(event) {
  const a = event.requestContext?.authorizer?.lambda || {};
  return { role: a.role || null, userId: a.userId || null, companyId: a.companyId || null, contractId: a.contractId || null };
}

const STAFF_ROLES = new Set(['admin', 'sales', 'tech_support', 'education']);

// role_permissions 테이블의 실제 설정을 그대로 따른다(하드코딩 admin 체크가 아님) —
// data-api 쪽과 동일한 기준으로, 권한 관리 화면에서 커스터마이징한 값이 진짜 기준이다.
async function hasPermission(role, featureKey) {
  if (role === 'admin') return true;
  if (!role) return false;
  const rows = await query(
    'select enabled from role_permissions where role=$1 and feature_key=$2',
    [role, featureKey]
  );
  return !!rows[0]?.enabled;
}

// 이 ticketId가 실제로 요청자의 것인지 확인 — 고객은 자기 회사/계약, internal은 본인이
// 만든 티켓만. 스태프/관리자는 여러 고객사 티켓을 같이 처리하는 게 원래 업무라 통과.
async function ticketBelongsToRequester(ticketId, authz) {
  if (STAFF_ROLES.has(authz.role)) return true;
  if (!ticketId) return false;
  const { role, userId, companyId, contractId } = authz;
  let sql, params;
  if (role === 'internal') { sql = 'select 1 from tickets where id=$1 and created_by=$2'; params = [ticketId, userId]; }
  else if (contractId)     { sql = 'select 1 from tickets where id=$1 and contract_id=$2'; params = [ticketId, contractId]; }
  else if (companyId)      { sql = 'select 1 from tickets where id=$1 and company_id=$2'; params = [ticketId, companyId]; }
  else return false;
  const rows = await query(sql, params);
  return rows.length > 0;
}

// 요청자에게 상태변경 메일을 보내도 되는지 확인 — 계약 재구성으로 요청자가 티켓 등록
// 당시와 다른 계약으로 옮겨졌으면, 스냅샷된 옛 계약 기준으로 메일이 나가지 않게 막는다.
// 둘 중 하나라도 계약이 지정 안 된 경우(null, 회사 전체 공유)는 막지 않는다.
function isNotifiableRequester(requester, ticket) {
  if (!requester?.email) return false;
  if (ticket.contract_id && requester.contract_id && requester.contract_id !== ticket.contract_id) return false;
  return true;
}

async function getAccountManagerEmail(companyId, managerField) {
  if (!companyId || !managerField) return null;
  const companyRows = await query(`select ${managerField} as manager_name from companies where id=$1`, [companyId]);
  const managerName = companyRows[0]?.manager_name;
  if (!managerName) return null;
  const userRows = await query('select email from users where name=$1 and is_active=true', [managerName]);
  return userRows[0]?.email ?? null;
}

async function getAdminEmails() {
  const rows = await query(`select email from users where role='admin' and is_active=true`);
  return rows.map(u => u.email).filter(Boolean);
}

// 알림 처리를 별도의 비동기 Lambda 실행으로 넘긴다. 실패해도 원래 요청(DB 쓰기)은 이미
// 끝난 뒤이므로 에러는 로그만 남기고 삼킨다 — 알림 실패가 저장 자체를 실패시키면 안 된다.
async function deferNotify(kind, payload) {
  if (!SELF_FN) return; // 함수명을 알 수 없는 환경(로컬 실행 등)에서는 건너뜀
  try {
    await lambda.send(new InvokeCommand({
      FunctionName: SELF_FN,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ __deferred: kind, ...payload })),
    }));
  } catch (err) {
    console.error(`[deferNotify:${kind} 호출 실패]`, err);
  }
}

// ── POST /tickets ──
// created_by/company_id/contract_id는 항상 로그인한 본인 계정 기준으로 채운다 — body로
// 받은 값을 그대로 믿으면 남을 사칭해서(다른 created_by로) 티켓을 만들 수 있었다
// (그 사람 명의로 등록되고 접수 확인 메일도 그 사람에게 감 — 실제 테스트로 확인됨).
async function createTicket(body, event) {
  const authz = getAuthz(event);
  if (!authz.userId) return json(401, { error: '인증이 필요합니다' });

  const { title, category, description, product, priority = 'normal' } = body;
  if (!title || !category) return json(400, { error: 'title, category는 필수입니다' });

  const requester = await getUser(authz.userId);
  if (!requester) return json(400, { error: '존재하지 않는 사용자입니다' });

  const created_by = authz.userId;
  const company_id = requester.company_id ?? null;
  const contract_id = requester.contract_id ?? null;

  let assignedTo = null, assignedToName = null;
  const defaultAssignee = DEFAULT_ASSIGNEE_BY_CATEGORY[category];
  if (defaultAssignee) {
    assignedTo = defaultAssignee.id;
    assignedToName = defaultAssignee.name;
  } else {
    const managerField = COMPANY_MANAGER_FIELD_BY_CATEGORY[category];
    if (managerField && company_id) {
      const companyRows = await query(`select ${managerField} as manager_name from companies where id=$1`, [company_id]);
      const managerName = companyRows[0]?.manager_name;
      if (managerName) {
        const mgrRows = await query('select id, name from users where name=$1 and is_active=true', [managerName]);
        if (mgrRows[0]) { assignedTo = mgrRows[0].id; assignedToName = mgrRows[0].name; }
      }
    }
  }

  const companyName = await getCompanyName(company_id);

  const inserted = await query(
    `insert into tickets (title, category, description, status, priority, product, created_by, created_by_name, company_id, company_name, contract_id, assigned_to, assigned_to_name)
     values ($1,$2,$3,'received',$4,$5,$6,$7,$8,$9,$10,$11,$12)
     returning *`,
    [title, category, description ?? null, priority, product ?? null, created_by, requester.name, company_id ?? null, companyName, contract_id ?? null, assignedTo, assignedToName]
  );
  const ticket = inserted[0];

  await deferNotify('create', { ticketId: ticket.id });

  return json(201, { ticket });
}

async function notifyForCreate(ticketId) {
  const ticket = await getTicket(ticketId);
  if (!ticket) return;
  const requester = await getUser(ticket.created_by);
  const notifyPayload = { companyName: ticket.company_name, requesterName: ticket.created_by_name, assigneeName: ticket.assigned_to_name };

  await notifySlack({ type: 'TICKET_INSERT', ticket, ...notifyPayload, attachmentFileNames: [] });

  if (!requester?.email) return;

  // send-email Lambda는 INSERT 타입 호출마다 요청자에게 접수 확인 메일을 보낸다.
  // 조건별로 notifyEmail을 여러 번 호출하면 접수 확인 메일이 중복 발송되므로,
  // 계약/라이선스·긴급 여부에 필요한 정보를 모두 모아 단 한 번만 호출한다.
  const emailPayload = { ticket, companyName: ticket.company_name, requesterEmail: requester.email, requesterName: ticket.created_by_name };

  if (['contract', 'license'].includes(ticket.category)) {
    emailPayload.accountManagerEmail = await getAccountManagerEmail(ticket.company_id, 'account_manager');
  }
  if (ticket.priority === 'critical') {
    const [accountManagerEmail, adminEmails] = await Promise.all([
      emailPayload.accountManagerEmail ?? getAccountManagerEmail(ticket.company_id, 'account_manager'),
      getAdminEmails(),
    ]);
    emailPayload.accountManagerEmail = accountManagerEmail;
    emailPayload.adminEmails = adminEmails;
  }

  await notifyEmail({ type: 'INSERT', ...emailPayload });
}

// ── PATCH /tickets/{id}/status ──
async function updateStatus(ticketId, body, event) {
  if (!(await hasPermission(getAuthz(event).role, 'ticket_manage'))) {
    return json(403, { error: '이 작업을 할 권한이 없습니다' });
  }
  const { status } = body;
  if (!status) return json(400, { error: 'status는 필수입니다' });

  const before = await query('select * from tickets where id=$1', [ticketId]);
  if (!before[0]) return json(404, { error: '티켓을 찾을 수 없습니다' });
  const prevStatus = before[0].status;

  const updated = await query(
    `update tickets set status=$1, updated_at=now() where id=$2 returning *`,
    [status, ticketId]
  );
  const ticket = updated[0];

  if (prevStatus !== status) {
    await deferNotify('status', { ticketId, prevStatus });
  }

  return json(200, { ticket });
}

async function notifyForStatus(ticketId, prevStatus) {
  const ticket = await getTicket(ticketId);
  if (!ticket) return;
  const nextStatus = ticket.status;
  const companyName = ticket.company_name;
  const requester = await getUser(ticket.created_by);
  const assignee = await getUser(ticket.assigned_to);
  const notifyBase = { companyName, requesterName: requester?.name, assigneeName: assignee?.name ?? '미배정' };

  if (['pending_customer', 'completed'].includes(nextStatus)) {
    await notifySlack({ type: 'TICKET_STATUS', ticket, ...notifyBase, prevStatus });
  }

  if (isNotifiableRequester(requester, ticket)) {
    await notifyEmail({ type: 'STATUS_CHANGE', ticket, companyName, requesterEmail: requester.email, requesterName: requester.name, prevStatus });
  }

  if (!['completed', 'cancelled'].includes(nextStatus) && ticket.due_date && new Date(ticket.due_date) < new Date()) {
    await notifySlack({ type: 'TICKET_OVERDUE', ticket, ...notifyBase });
  }
}

// ── PATCH /tickets/{id}/assign ──
async function assignTicket(ticketId, body, event) {
  if (!(await hasPermission(getAuthz(event).role, 'ticket_manage'))) {
    return json(403, { error: '이 작업을 할 권한이 없습니다' });
  }
  const { assigned_to } = body;
  if (!assigned_to) return json(400, { error: 'assigned_to는 필수입니다' });

  const before = await query('select * from tickets where id=$1', [ticketId]);
  if (!before[0]) return json(404, { error: '티켓을 찾을 수 없습니다' });
  const prevAssigneeId = before[0].assigned_to;

  const newAssignee = await getUser(assigned_to);
  if (!newAssignee) return json(400, { error: '존재하지 않는 사용자입니다' });

  const updated = await query(
    `update tickets set assigned_to=$1, assigned_to_name=$2, updated_at=now() where id=$3 returning *`,
    [assigned_to, newAssignee.name, ticketId]
  );
  const ticket = updated[0];

  if (prevAssigneeId !== assigned_to) {
    await deferNotify('assign', { ticketId, prevAssigneeId });
  }

  return json(200, { ticket });
}

async function notifyForAssign(ticketId, prevAssigneeId) {
  const ticket = await getTicket(ticketId);
  if (!ticket) return;
  const requester = await getUser(ticket.created_by);
  const prevAssignee = await getUser(prevAssigneeId);

  await notifySlack({
    type: 'TICKET_ASSIGNED', ticket, companyName: ticket.company_name,
    requesterName: requester?.name, assigneeName: ticket.assigned_to_name,
    prevAssigneeName: prevAssignee?.name ?? '미배정',
  });
}

// ── POST /tickets/{id}/reply ──
// 고객/직원 공용 답글 스레드. 답글 작성자가 고객(role='customer')일 때만 담당 Slack
// 채널로 알림을 보낸다 — 직원끼리의 답글은 알림 대상이 아님.
async function addReply(ticketId, body, event) {
  const authz = getAuthz(event);
  if (!authz.userId) return json(401, { error: '인증이 필요합니다' });
  if (!(await ticketBelongsToRequester(ticketId, authz))) {
    return json(403, { error: '이 요청에 접근할 권한이 없습니다' });
  }

  const { note } = body;
  if (!note) return json(400, { error: 'note는 필수입니다' });

  // changed_by는 항상 로그인한 본인 — body 값을 믿으면 남을 사칭한 답글을 남길 수 있었다.
  const changed_by = authz.userId;
  const author = await getUser(changed_by);

  await query(
    `insert into ticket_replies (ticket_id, note, changed_by) values ($1,$2,$3)`,
    [ticketId, note, changed_by]
  );

  if (author?.role === 'customer') {
    await deferNotify('reply', { ticketId });
  }

  return json(201, { ok: true });
}

async function notifyForReply(ticketId) {
  const ticket = await getTicket(ticketId);
  if (!ticket) return;
  const requester = await getUser(ticket.created_by);

  await notifySlack({
    type: 'TICKET_REPLY', ticket, companyName: ticket.company_name,
    requesterName: requester?.name, assigneeName: ticket.assigned_to_name,
  });
}

// ── PATCH /tickets/{id}/manage ──
// index.html의 "관리" 모달(saveManage) 전용: 상태/담당자/마감일을 한 번에 저장한다.
// 이력(ticket_history)·메모(ticket_memos) 기록은 응답 전에 즉시 처리하고,
// Slack 알림·이메일(느린 외부 호출)만 비동기로 넘긴다.
async function manageTicket(ticketId, body, event) {
  const authz = getAuthz(event);
  if (!(await hasPermission(authz.role, 'ticket_manage'))) {
    return json(403, { error: '이 작업을 할 권한이 없습니다' });
  }
  const { category, status, assigned_to, due_date, memo, send_email, cc_emails } = body;

  // changed_by/changed_by_name은 body 값을 절대 믿지 않고 항상 로그인한 본인으로 강제한다 —
  // 그러지 않으면 ticket_manage 권한만 있는 낮은 직급 스태프가 처리 이력·메모의 작성자를
  // 다른 실제 사용자(심지어 admin)로 위조할 수 있었다(실제 테스트로 확인됨).
  const actor = await getUser(authz.userId);
  const changed_by = authz.userId ?? null;
  const changed_by_name = actor?.name ?? null;

  const before = await query('select * from tickets where id=$1', [ticketId]);
  if (!before[0]) return json(404, { error: '티켓을 찾을 수 없습니다' });
  const prev = before[0];
  const prevStatus = prev.status;
  const prevAssigneeId = prev.assigned_to;

  let assignedToName = null;
  if (assigned_to) {
    const assignee = await getUser(assigned_to);
    if (!assignee) return json(400, { error: '존재하지 않는 담당자입니다' });
    assignedToName = assignee.name;
  }

  const nextStatus = status ?? prevStatus;
  const nextCategory = category ?? prev.category;
  const updated = await query(
    `update tickets set category=$1, status=$2, assigned_to=$3, assigned_to_name=$4, due_date=$5, updated_at=now() where id=$6 returning *`,
    [nextCategory, nextStatus, assigned_to ?? null, assignedToName, due_date ?? null, ticketId]
  );
  const ticket = updated[0];

  const statusChanged = nextStatus !== prevStatus;
  const assigneeChanged = (assigned_to ?? null) !== (prevAssigneeId ?? null);

  if (statusChanged) {
    await query(
      `insert into ticket_history (ticket_id, action, note, changed_by, changed_by_name) values ($1,'status_changed',$2,$3,$4)`,
      [ticketId, `${STATUS_KO[prevStatus] ?? prevStatus} → ${STATUS_KO[nextStatus] ?? nextStatus}`, changed_by ?? null, changed_by_name ?? null]
    );
  }
  if (assigneeChanged) {
    const prevAssignee = await getUser(prevAssigneeId);
    await query(
      `insert into ticket_history (ticket_id, action, note, changed_by, changed_by_name) values ($1,$2,$3,$4,$5)`,
      [ticketId, prevAssigneeId ? 'reassigned' : 'assigned', `${prevAssignee?.name ?? '미배정'} → ${assignedToName ?? '미배정'}`, changed_by ?? null, changed_by_name ?? null]
    );
  }
  if (memo) {
    await query(`insert into ticket_memos (ticket_id, note, changed_by) values ($1,$2,$3)`, [ticketId, memo, changed_by ?? null]);
  }

  if (statusChanged || assigneeChanged) {
    await deferNotify('manage', {
      ticketId, prevStatus, prevAssigneeId, statusChanged, assigneeChanged,
      sendEmail: !!send_email, ccEmails: cc_emails,
    });
  }

  return json(200, { ticket });
}

async function notifyForManage(job) {
  const { ticketId, prevStatus, prevAssigneeId, statusChanged, assigneeChanged, sendEmail, ccEmails } = job;
  const ticket = await getTicket(ticketId);
  if (!ticket) return;
  const companyName = ticket.company_name;
  const requester = await getUser(ticket.created_by);
  const notifyBase = { companyName, requesterName: requester?.name, assigneeName: ticket.assigned_to_name ?? '미배정' };

  if (assigneeChanged) {
    const prevAssignee = await getUser(prevAssigneeId);
    await notifySlack({ type: 'TICKET_ASSIGNED', ticket, ...notifyBase, prevAssigneeName: prevAssignee?.name ?? '미배정' });
  }
  if (statusChanged && ['pending_customer', 'completed'].includes(ticket.status)) {
    await notifySlack({ type: 'TICKET_STATUS', ticket, ...notifyBase, prevStatus });
  }
  if (statusChanged && !['completed', 'cancelled'].includes(ticket.status) && ticket.due_date && new Date(ticket.due_date) < new Date()) {
    await notifySlack({ type: 'TICKET_OVERDUE', ticket, ...notifyBase });
  }
  if (statusChanged && sendEmail && isNotifiableRequester(requester, ticket)) {
    await notifyEmail({
      type: 'STATUS_CHANGE', ticket, companyName,
      requesterEmail: requester.email, requesterName: requester.name,
      prevStatus, ccEmails,
    });
  }
}

// ── POST /auth/login ──
// 비밀번호 비교를 서버에서 전담한다 — 클라이언트는 password 컬럼을 절대 조회하지 않는다
// (data-api가 users.password를 응답에서 차단하므로 어차피 받을 수도 없다).
async function login(body) {
  const { email, password } = body;
  if (!email || !password) return json(400, { error: 'email, password는 필수입니다' });

  const rows = await query(
    'select id, name, role, company_id, contract_id, phone, is_active, password from users where email=$1',
    [email]
  );
  const user = rows[0];
  if (!user) return json(404, { error: '등록되지 않은 계정입니다. 담당자에게 문의하세요.' });
  if (user.is_active === false) return json(403, { error: '비활성화된 계정입니다. 담당자에게 문의하세요.' });

  const stored = user.password;
  // 비밀번호가 아예 설정되지 않은 계정(관리자가 막 등록한 신규 계정 등)은 무슨 비밀번호를
  // 넣어도 통과되던 구멍이 있었다 — 반드시 비밀번호 재설정을 먼저 거치게 막는다.
  if (!stored) return json(403, { error: '비밀번호가 설정되지 않은 계정입니다. "비밀번호를 잊으셨나요?"로 먼저 설정해주세요.' });
  if (!checkPassword(password, stored)) return json(401, { error: '비밀번호가 올바르지 않습니다.' });
  // 예전 형식(평문 또는 salt 없는 SHA-256)으로 저장돼 있었다면 로그인 성공 시점에 scrypt로 승격
  if (!isScryptHash(stored)) {
    await query('update users set password=$1 where id=$2', [hashPassword(password), user.id]);
  }

  const companyName = await getCompanyName(user.company_id);
  const token = signToken(
    { sub: user.id, role: user.role, company_id: user.company_id || null, contract_id: user.contract_id || null },
    JWT_SECRET, TOKEN_TTL_SECONDS
  );
  return json(200, {
    token,
    user: {
      id: user.id, name: user.name, role: user.role,
      company_id: user.company_id || null, contract_id: user.contract_id || null,
      phone: user.phone || '', company: companyName === '-' ? '' : companyName,
    },
  });
}

// ── POST /auth/verify-password ──
// 마이페이지에서 비밀번호를 바꾸기 전 "현재 비밀번호" 확인용. 검증만 하고 저장은
// 하지 않는다 — 실제 변경은 클라이언트가 기존처럼 새 비밀번호 해시로 PATCH한다.
// userId는 body가 아니라 인증 토큰(jwt-authorizer가 넘겨준 값)에서만 가져온다 —
// 그래야 다른 사람의 비밀번호를 대신 확인해보는 걸 막을 수 있다.
async function verifyPassword(event, body) {
  const userId = event.requestContext?.authorizer?.lambda?.userId;
  const { password } = body;
  if (!userId) return json(401, { error: '인증이 필요합니다' });

  const rows = await query('select password from users where id=$1', [userId]);
  const user = rows[0];
  if (!user) return json(404, { error: '사용자를 찾을 수 없습니다' });

  const stored = user.password;
  if (!stored) return json(200, { ok: true }); // 저장된 비밀번호가 없으면 확인할 게 없음

  if (!password) return json(400, { error: 'password는 필수입니다' });
  if (!checkPassword(password, stored)) return json(401, { error: '현재 비밀번호가 올바르지 않습니다.' });
  return json(200, { ok: true });
}

// ── PATCH /auth/change-password ──
// 마이페이지의 "새 비밀번호"는 여기서만 받는다 — data-api의 범용 PATCH로 users.password를
// 직접 쓰지 못하게 막아뒀으므로(아래 data-api 쪽 BLOCKED_WRITE_COLUMNS), 비밀번호 변경은
// 반드시 이 서버 엔드포인트를 거쳐야 하고 평문을 받아 여기서만 해시한다.
async function changePassword(event, body) {
  const userId = event.requestContext?.authorizer?.lambda?.userId;
  if (!userId) return json(401, { error: '인증이 필요합니다' });
  const { currentPassword, newPassword } = body;
  if (!newPassword || newPassword.length < 8) return json(400, { error: '비밀번호는 8자 이상이어야 합니다.' });

  // 현재 비밀번호를 서버에서 반드시 재확인한다 — 예전엔 유효한 토큰만 있으면 현재 비밀번호
  // 없이 새 비밀번호로 바꿔버릴 수 있어(토큰 1개 유출 = 계정 완전 탈취), 화면의 verify-password
  // 호출을 건너뛰고 이 엔드포인트를 직접 때리면 그대로 통했다(실제 테스트로 확인).
  const rows = await query('select password from users where id=$1', [userId]);
  const stored = rows[0]?.password;
  if (stored) {
    if (!currentPassword) return json(400, { error: '현재 비밀번호를 입력해주세요.' });
    if (!checkPassword(currentPassword, stored)) return json(401, { error: '현재 비밀번호가 올바르지 않습니다.' });
  }
  // stored가 없는(비밀번호 미설정) 계정은 로그인 자체가 안 되므로 여기 도달할 수 없다.

  await query('update users set password=$1 where id=$2', [hashPassword(newPassword), userId]);
  return json(200, { ok: true });
}

// ── POST /auth/request-reset ──
async function requestPasswordReset(body) {
  const { email } = body;
  if (!email) return json(400, { error: 'email은 필수입니다' });

  const rows = await query('select id, name, is_active from users where email=$1', [email]);
  const user = rows[0];
  if (!user || user.is_active === false) {
    return json(404, { error: '등록된 이메일이 아닙니다.' });
  }

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  await query('update users set reset_token=$1, reset_token_expires_at=$2 where id=$3', [token, expiresAt, user.id]);
  await notifyEmail({ type: 'PASSWORD_RESET', toEmail: email, userName: user.name, token });
  return json(200, { ok: true });
}

// ── POST /auth/reset-password ──
async function resetPassword(body) {
  const { token, newPassword } = body;
  if (!token || !newPassword) return json(400, { error: 'token, newPassword는 필수입니다' });
  if (newPassword.length < 8) return json(400, { error: '비밀번호는 8자 이상이어야 합니다.' });

  const updated = await query(
    `update users set password=$1, reset_token=null, reset_token_expires_at=null
     where reset_token=$2 and reset_token_expires_at > now() returning id`,
    [hashPassword(newPassword), token]
  );
  if (!updated.length) return json(400, { error: '유효하지 않거나 만료된 링크입니다' });
  return json(200, { ok: true });
}

// ── EventBridge Scheduler가 매일 09:00 KST에 {"task":"overdue_batch"} 페이로드로 직접 호출 ──
async function runOverdueBatch() {
  const today = new Date().toISOString().slice(0, 10);
  const overdueTickets = await query(
    `select * from tickets where due_date < $1 and status not in ('completed','cancelled') and due_date is not null`,
    [today]
  );

  const items = [];
  for (const ticket of overdueTickets) {
    const companyName = await getCompanyName(ticket.company_id);
    const requester = await getUser(ticket.created_by);
    const assignee = await getUser(ticket.assigned_to);
    const overdueDays = Math.floor((Date.now() - new Date(ticket.due_date).getTime()) / (24 * 60 * 60 * 1000));
    items.push({ ticket, companyName, requesterName: requester?.name, assigneeName: assignee?.name ?? '미배정', overdueDays });
  }

  if (items.length) await notifySlack({ type: 'OVERDUE_BATCH', tickets: items });
  return json(200, { processed: items.length });
}

// ── EventBridge Scheduler가 매일 09:00 KST에 {"task":"expire_contracts"} 페이로드로 직접 호출 ──
// 계약상태(진행중/만료 등)는 화면에서 수동으로만 바뀌는 값이라, 종료일이 지나도 자동으로
// "만료"로 안 바뀌는 문제가 있었음 — 매일 종료일 지난 "진행중" 계약을 "만료"로 정리한다.
async function runContractExpiryBatch() {
  const today = new Date().toISOString().slice(0, 10);
  const updated = await query(
    `update company_contracts set status='만료', updated_at=now()
     where status='진행중' and end_date < $1
     returning id, contract_name`,
    [today]
  );
  return json(200, { updated: updated.length, contracts: updated.map(c => c.contract_name) });
}

// 자기 자신에게 비동기(Event)로 재호출됐을 때 처리할 알림 작업 — kind별 디스패치
const DEFERRED_HANDLERS = {
  create: (job) => notifyForCreate(job.ticketId),
  status: (job) => notifyForStatus(job.ticketId, job.prevStatus),
  assign: (job) => notifyForAssign(job.ticketId, job.prevAssigneeId),
  manage: (job) => notifyForManage(job),
  reply: (job) => notifyForReply(job.ticketId),
};

export const handler = async (event) => {
  currentEvent = event;
  // ── 비동기 알림 작업 (자기 자신을 Event로 재호출한 경우) ──
  if (event.__deferred) {
    try {
      await DEFERRED_HANDLERS[event.__deferred]?.(event);
    } catch (err) {
      console.error(`[deferred:${event.__deferred} 처리 오류]`, err);
    }
    return { statusCode: 200 };
  }

  if (event.task === 'overdue_batch') {
    try {
      return await runOverdueBatch();
    } catch (err) {
      console.error('[overdue_batch 오류]', err);
      return json(500, { error: String(err) });
    }
  }

  if (event.task === 'expire_contracts') {
    try {
      return await runContractExpiryBatch();
    } catch (err) {
      console.error('[expire_contracts 오류]', err);
      return json(500, { error: String(err) });
    }
  }

  const method = event.requestContext?.http?.method ?? event.httpMethod;
  const path = event.rawPath ?? event.path ?? '';

  if (method === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(event), body: '' };

  const body = event.body ? JSON.parse(event.body) : {};

  try {
    if (method === 'POST' && path === '/auth/login') {
      return await login(body);
    }
    if (method === 'POST' && path === '/auth/verify-password') {
      return await verifyPassword(event, body);
    }
    if (method === 'PATCH' && path === '/auth/change-password') {
      return await changePassword(event, body);
    }
    if (method === 'POST' && path === '/auth/request-reset') {
      return await requestPasswordReset(body);
    }
    if (method === 'POST' && path === '/auth/reset-password') {
      return await resetPassword(body);
    }
    if (method === 'POST' && path === '/tickets') {
      return await createTicket(body, event);
    }
    const statusMatch = path.match(/^\/tickets\/([^/]+)\/status$/);
    if (method === 'PATCH' && statusMatch) {
      return await updateStatus(statusMatch[1], body, event);
    }
    const assignMatch = path.match(/^\/tickets\/([^/]+)\/assign$/);
    if (method === 'PATCH' && assignMatch) {
      return await assignTicket(assignMatch[1], body, event);
    }
    const manageMatch = path.match(/^\/tickets\/([^/]+)\/manage$/);
    if (method === 'PATCH' && manageMatch) {
      return await manageTicket(manageMatch[1], body, event);
    }
    const replyMatch = path.match(/^\/tickets\/([^/]+)\/reply$/);
    if (method === 'POST' && replyMatch) {
      return await addReply(replyMatch[1], body, event);
    }
    return json(404, { error: 'not found' });
  } catch (err) {
    console.error('[api-layer 오류]', err);
    return json(500, { error: String(err) });
  }
};
