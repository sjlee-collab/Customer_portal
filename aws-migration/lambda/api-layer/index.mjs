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
import { query, withTransaction } from './db.mjs';
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
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
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
  const rows = await query(
    `select id, name, email, role, company_id, contract_id, unit_id,
            array(select unit_id from user_org_units where user_id=users.id) as unit_ids
     from users where id=$1`, [userId]);
  return rows[0] ?? null;
}

// JWT 인가자(jwt-authorizer)가 넘겨준 role/userId/companyId/contractId — data-api에서
// 이미 검증된 것과 동일한 패턴. api-layer의 /tickets/* 엔드포인트들은 지금까지 이 정보를
// 전혀 확인하지 않고 body 값만 그대로 믿어서, 로그인만 하면 남의 티켓 상태변경·재배정·
// 답글주입·내부메모작성·사칭이 전부 가능했다(실제 테스트로 확인).
function getAuthz(event) {
  const a = event.requestContext?.authorizer?.lambda || {};
  const unitIds = typeof a.unitIds === 'string' && a.unitIds ? a.unitIds.split(',').filter(Boolean) : [];
  return { role: a.role || null, userId: a.userId || null, companyId: a.companyId || null, contractId: a.contractId || null, unitIds };
}

const STAFF_ROLES = new Set(['admin', 'sales', 'tech_support', 'education']);
// 대리 등록 가능 역할 = 내부 + 전 스태프(고객 제외). 실제 허용은 여기에 더해 ticket_create 권한까지 확인.
const PROXY_ROLES = new Set(['internal', 'admin', 'sales', 'tech_support', 'education']);

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
  const { role, userId, companyId, contractId, unitIds } = authz;
  if (role === 'internal') return true; // 내부직원: 전체 티켓 답글 허용
  let sql, params;
  if (unitIds?.length) { sql = 'select 1 from tickets where id=$1 and (unit_id = any($2::uuid[]) or created_by=$3)'; params = [ticketId, unitIds, userId]; }
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
  // 조직 기준: 티켓의 조직이 요청자의 배정 목록에 없으면(조직 이동 후) 옛 조직 티켓 메일 차단
  if (ticket.unit_id && Array.isArray(requester.unit_ids) && requester.unit_ids.length
      && !requester.unit_ids.includes(ticket.unit_id)) return false;
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

  const actor = await getUser(authz.userId);
  if (!actor) return json(400, { error: '존재하지 않는 사용자입니다' });

  // ── 대리 등록(proxy) ── 내부·스태프 계정이 고객을 대신해 요청을 등록하는 경로.
  // 평상시엔 created_by/company/contract를 절대 body로 안 믿지만(사칭 방지), 이 경로에 한해
  // 역할(내부+전 스태프)·권한(ticket_create)·대상(role=customer)을 서버에서 검증한 뒤에만 적용한다.
  // 요청은 대상 고객 명의로 남고(registered_by에 실제 등록자를 스냅샷으로 기록). 고객 역할은 불가.
  const isProxy = PROXY_ROLES.has(authz.role) && body.on_behalf_of && body.on_behalf_of !== authz.userId;
  let registeredBy = null, registeredByName = null;
  let requester; // 요청 명의(대리 등록이면 대상 고객, 아니면 본인)
  if (isProxy) {
    if (!(await hasPermission(authz.role, 'ticket_create'))) {
      return json(403, { error: '요청을 등록할 권한이 없습니다' });
    }
    const target = await getUser(body.on_behalf_of);
    if (!target || target.role !== 'customer') {
      return json(400, { error: '대리 등록 대상은 고객 계정이어야 합니다' });
    }
    requester = target;
    registeredBy = actor.id;
    registeredByName = actor.name;
  } else {
    requester = actor;
  }

  const created_by = requester.id;
  const company_id = requester.company_id ?? null;
  const contract_id = requester.contract_id ?? null;

  // 조직 스냅샷 — body로 unit_id를 받되(다중 조직 사용자의 "요청 조직" 선택), 반드시 요청 명의
  // (일반=본인, 대리=대상 고객)의 배정 목록(user_org_units)에 있는 조직만 허용. 없으면 대표 조직.
  const reqUnits = Array.isArray(requester.unit_ids) ? requester.unit_ids : [];
  let unit_id = requester.unit_id ?? null;
  if (body.unit_id) {
    if (!reqUnits.includes(body.unit_id) && !STAFF_ROLES.has(authz.role)) {
      return json(403, { error: '배정되지 않은 조직으로는 요청을 등록할 수 없습니다' });
    }
    unit_id = body.unit_id;
  }
  let unit_name = null;
  if (unit_id) {
    const u = await query('select unit_name from org_units where id=$1', [unit_id]);
    unit_name = u[0]?.unit_name ?? null;
    if (!unit_name) unit_id = null; // 존재하지 않는 조직 id 방어
  }

  // 담당자 — 대리 등록은 선택한 스태프(role 검증), 그 외/미선택은 기존 카테고리 자동배정 규칙.
  let assignedTo = null, assignedToName = null;
  if (isProxy && body.assigned_to) {
    const staff = await getUser(body.assigned_to);
    if (!staff || !STAFF_ROLES.has(staff.role)) {
      return json(400, { error: '담당자는 빅스데이터 스태프여야 합니다' });
    }
    assignedTo = staff.id; assignedToName = staff.name;
  } else {
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
  }

  const companyName = await getCompanyName(company_id);

  const inserted = await query(
    `insert into tickets (title, category, description, status, priority, product, created_by, created_by_name, company_id, company_name, contract_id, unit_id, unit_name, assigned_to, assigned_to_name, registered_by, registered_by_name)
     values ($1,$2,$3,'received',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     returning *`,
    [title, category, description ?? null, priority, product ?? null, created_by, requester.name, company_id ?? null, companyName, contract_id ?? null, unit_id, unit_name, assignedTo, assignedToName, registeredBy, registeredByName]
  );
  const ticket = inserted[0];

  await deferNotify('create', { ticketId: ticket.id });

  return json(201, { ticket });
}

// ── 대리 등록 지원 조회 (내부 계정 전용) ──
// 내부(internal) 계정은 data-api에서 companies/users 전체목록·org_units를 못 읽는다
// (테넌트 격리 + STAFF_ONLY). 대리 등록 모달의 드롭다운을 채우려면 이 정보가 필요하므로,
// 권한(internal + ticket_create)을 서버에서 확인한 뒤 최소 필드만 추려 돌려준다.
function proxyAuthz(event) {
  const authz = getAuthz(event);
  if (!authz.userId) return { deny: json(401, { error: '인증이 필요합니다' }) };
  if (!PROXY_ROLES.has(authz.role)) return { deny: json(403, { error: '대리 등록 권한이 없습니다' }) };
  return { authz };
}

async function proxyBootstrap(event) {
  const { authz, deny } = proxyAuthz(event);
  if (deny) return deny;
  if (!(await hasPermission(authz.role, 'ticket_create'))) return json(403, { error: '요청을 등록할 권한이 없습니다' });
  const [companies, staff] = await Promise.all([
    query('select id, name from companies order by name'),
    query('select id, name, role from users where role = any($1) and coalesce(is_active,true)=true order by name', [[...STAFF_ROLES]]),
  ]);
  return json(200, { companies, staff });
}

async function proxyCustomers(event) {
  const { authz, deny } = proxyAuthz(event);
  if (deny) return deny;
  if (!(await hasPermission(authz.role, 'ticket_create'))) return json(403, { error: '요청을 등록할 권한이 없습니다' });
  const companyId = event.queryStringParameters?.company_id;
  if (!companyId) return json(400, { error: 'company_id는 필수입니다' });
  const [customers, units] = await Promise.all([
    query(
      `select u.id, u.name, u.email,
              array(select unit_id from user_org_units where user_id=u.id) as unit_ids
       from users u
       where u.company_id=$1 and u.role='customer' and coalesce(u.is_active,true)=true
       order by u.name`, [companyId]),
    query("select id, unit_no, unit_name from org_units where company_id=$1 and status='active' order by unit_no", [companyId]),
  ]);
  return json(200, { customers, units });
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
  // 대리 등록(registered_by 있음)이면 registeredByName을 함께 넘겨 메일에 "담당자가 등록했습니다" 안내를 표시한다.
  const emailPayload = { ticket, companyName: ticket.company_name, requesterEmail: requester.email, requesterName: ticket.created_by_name };
  if (ticket.registered_by) emailPayload.registeredByName = ticket.registered_by_name;

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

// 상태 변경 시 슬랙 알림을 보낼 상태들. 접수(received)는 최초 생성 상태라 제외하고 나머지 전부.
const SLACK_STATUS_CHANGE = new Set(['classifying', 'in_progress', 'pending_customer', 'on_hold', 'completed', 'cancelled']);

async function notifyForStatus(ticketId, prevStatus) {
  const ticket = await getTicket(ticketId);
  if (!ticket) return;
  const nextStatus = ticket.status;
  const companyName = ticket.company_name;
  const requester = await getUser(ticket.created_by);
  const assignee = await getUser(ticket.assigned_to);
  const notifyBase = { companyName, requesterName: requester?.name, assigneeName: assignee?.name ?? '미배정' };

  if (SLACK_STATUS_CHANGE.has(nextStatus)) {
    await notifySlack({ type: 'TICKET_STATUS', ticket, ...notifyBase, prevStatus });
  }

  if (isNotifiableRequester(requester, ticket)) {
    await notifyEmail({ type: 'STATUS_CHANGE', ticket, companyName, requesterEmail: requester.email, requesterName: requester.name, prevStatus });
  }

  if (!['completed', 'cancelled'].includes(nextStatus) && isOverdue(ticket.due_date)) {
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
  // 답글도 "이 요청에 오늘 무슨 일이 있었나"에 해당하므로 티켓의 갱신 시각을 올린다.
  // 대시보드의 "오늘 업데이트된 요청" 카드가 updated_at을 기준으로 세는데, 이게 없으면
  // 고객이 답글만 단 요청은 아무도 손대지 않은 것처럼 보인다.
  await query(`update tickets set updated_at=now() where id=$1`, [ticketId]);

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

// ── PATCH /tickets/{id} — 작성자 본인(또는 스태프)의 요청 내용 수정 ──
// index.html의 "요청 수정" 모달(saveEditRequest) 전용. 제목/카테고리/제품/긴급도/내용만
// 수정하며 상태·담당자는 건드리지 않는다(그건 /manage). tickets는 data-api 직접쓰기가 막혀
// 있어(전용 API 강제) 이 엔드포인트를 통해서만 수정된다. 남의 요청 수정을 막기 위해
// created_by === 로그인 본인인지 확인한다(스태프는 ticket_manage 권한으로 허용).
async function editTicket(ticketId, body, event) {
  const authz = getAuthz(event);
  if (!authz.userId) return json(401, { error: '인증이 필요합니다' });

  const before = await query('select created_by from tickets where id=$1', [ticketId]);
  if (!before[0]) return json(404, { error: '요청을 찾을 수 없습니다' });

  const isOwner = before[0].created_by === authz.userId;
  const isStaff = await hasPermission(authz.role, 'ticket_manage');
  if (!isOwner && !isStaff) return json(403, { error: '본인이 등록한 요청만 수정할 수 있습니다' });

  const VALID_CATEGORIES = new Set(['tech_support', 'contract', 'license', 'education', 'customer', 'other']);
  const VALID_PRIORITIES = new Set(['normal', 'high', 'critical']);
  const title = (body.title ?? '').trim();
  const description = (body.description ?? '').trim();
  const category = body.category;
  const product = body.product ?? null;
  const priority = body.priority ?? 'normal';
  if (!title || !category || !description) return json(400, { error: 'title, category, description은 필수입니다' });
  if (!VALID_CATEGORIES.has(category)) return json(400, { error: '허용되지 않은 카테고리입니다' });
  if (!VALID_PRIORITIES.has(priority)) return json(400, { error: '허용되지 않은 긴급도입니다' });

  const updated = await query(
    `update tickets set title=$1, category=$2, product=$3, priority=$4, description=$5, updated_at=now()
     where id=$6 returning *`,
    [title, category, product, priority, description, ticketId]
  );
  return json(200, { ticket: updated[0] });
}

// ── DELETE /tickets/{id} — 요청 삭제 (자식행 포함, 트랜잭션). 권한: ticket_delete ──
// 첨부 S3 객체는 프론트가 이 호출 전에 storage-api로 먼저 제거한다(여기선 DB만 원자적 삭제).
async function deleteTicket(ticketId, event) {
  const authz = getAuthz(event);
  if (!authz.userId) return json(401, { error: '인증이 필요합니다' });
  if (!(await hasPermission(authz.role, 'ticket_delete'))) {
    return json(403, { error: '요청을 삭제할 권한이 없습니다' });
  }
  const before = await query('select id from tickets where id=$1', [ticketId]);
  if (!before[0]) return json(404, { error: '요청을 찾을 수 없습니다' });
  await withTransaction(async (q) => {
    await q('delete from ticket_history where ticket_id=$1', [ticketId]);
    await q('delete from ticket_replies where ticket_id=$1', [ticketId]);
    await q('delete from ticket_memos where ticket_id=$1', [ticketId]);
    await q('delete from ticket_attachments where ticket_id=$1', [ticketId]);
    await q('delete from log_notification where ticket_id=$1', [ticketId]);
    await q('delete from tickets where id=$1', [ticketId]);
  });
  return json(200, { ok: true });
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
  const statusChanged = nextStatus !== prevStatus;
  const assigneeChanged = (assigned_to ?? null) !== (prevAssigneeId ?? null);
  // 이전 담당자 이름은 트랜잭션 밖에서 미리 조회한다(트랜잭션 client와 섞지 않기 위해).
  const prevAssigneeName = assigneeChanged && prevAssigneeId ? (await getUser(prevAssigneeId))?.name ?? '미배정' : '미배정';

  // 티켓 수정과 이력·메모 기록을 한 트랜잭션으로 묶는다 — 예전에는 tickets UPDATE가 먼저
  // 커밋된 뒤 ticket_history/memo INSERT가 따로 실행돼, 뒤 단계가 실패하면 상태만 바뀌고
  // 이력은 안 남는 부분 반영이 생겼다(감사추적 누락). 이제 하나라도 실패하면 전부 롤백된다.
  const ticket = await withTransaction(async (q) => {
    const updated = await q(
      // cc_emails(추가 수신자)도 함께 저장한다 — 지금까지는 메일 발송에만 쓰고 버려서
      // 모달을 다시 열면 매번 빈 칸이었다. 티켓별로 마지막 입력을 기억한다.
      // 값을 아예 안 보낸 호출(cc_emails === undefined)은 기존 값을 덮어쓰지 않는다.
      `update tickets set category=$1, status=$2, assigned_to=$3, assigned_to_name=$4, due_date=$5,
              cc_emails = case when $6 then cc_emails else $7::text[] end,
              updated_at=now()
        where id=$8 returning *`,
      [nextCategory, nextStatus, assigned_to ?? null, assignedToName, due_date ?? null,
       cc_emails === undefined, Array.isArray(cc_emails) ? cc_emails : null, ticketId]
    );
    if (statusChanged) {
      await q(
        `insert into ticket_history (ticket_id, action, note, changed_by, changed_by_name) values ($1,'status_changed',$2,$3,$4)`,
        [ticketId, `${STATUS_KO[prevStatus] ?? prevStatus} → ${STATUS_KO[nextStatus] ?? nextStatus}`, changed_by ?? null, changed_by_name ?? null]
      );
    }
    if (assigneeChanged) {
      await q(
        `insert into ticket_history (ticket_id, action, note, changed_by, changed_by_name) values ($1,$2,$3,$4,$5)`,
        [ticketId, prevAssigneeId ? 'reassigned' : 'assigned', `${prevAssigneeName} → ${assignedToName ?? '미배정'}`, changed_by ?? null, changed_by_name ?? null]
      );
    }
    if (memo) {
      await q(`insert into ticket_memos (ticket_id, note, changed_by) values ($1,$2,$3)`, [ticketId, memo, changed_by ?? null]);
    }
    return updated[0];
  });

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
  if (statusChanged && SLACK_STATUS_CHANGE.has(ticket.status)) {
    await notifySlack({ type: 'TICKET_STATUS', ticket, ...notifyBase, prevStatus });
  }
  if (statusChanged && !['completed', 'cancelled'].includes(ticket.status) && isOverdue(ticket.due_date)) {
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
    'select id, name, role, company_id, contract_id, unit_id, phone, is_active, password from users where email=$1',
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
  // 배정 조직 목록 — id는 JWT에 실어 data-api 테넌트 필터(unit_id = ANY)가 쓰고,
  // 이름(unit_no/unit_name)은 응답 user.units로 내려 프런트 "요청 조직" 선택기에 쓴다
  // (org_units는 스태프 전용이라 고객이 직접 못 읽으므로 로그인 때 함께 내려준다).
  const unitRows = await query(
    `select uo.unit_id, uo.is_primary, o.unit_no, o.unit_name
       from user_org_units uo join org_units o on o.id = uo.unit_id
      where uo.user_id = $1 order by o.unit_no`, [user.id]);
  const unitIds = unitRows.map(r => r.unit_id);
  const units = unitRows.map(r => ({ id: r.unit_id, unit_no: r.unit_no, unit_name: r.unit_name, is_primary: r.is_primary }));
  const token = signToken(
    { sub: user.id, role: user.role, company_id: user.company_id || null, contract_id: user.contract_id || null, unit_ids: unitIds },
    JWT_SECRET, TOKEN_TTL_SECONDS
  );
  // 사용 통계(DAU/WAU/MAU)용 로그인 이벤트 기록 — 베스트에포트: 실패해도 로그인은 정상 진행.
  try {
    await query(
      'insert into login_events (user_id, user_name, role, company_id, company_name) values ($1,$2,$3,$4,$5)',
      [user.id, user.name, user.role, user.company_id || null, companyName === '-' ? null : companyName]
    );
  } catch (e) { console.error('login_events insert 실패(무시):', e); }
  return json(200, {
    token,
    user: {
      id: user.id, name: user.name, role: user.role,
      company_id: user.company_id || null, contract_id: user.contract_id || null,
      unit_id: user.unit_id || null, unit_ids: unitIds, units,
      phone: user.phone || '', company: companyName === '-' ? '' : companyName,
    },
  });
}

// ── GET /stats/active-users ──
// 사용 통계 화면의 접속 활동(DAU/WAU/MAU + 일별 DAU 추이). login_events를 서버에서 distinct 집계한다.
// login_events는 전 사용자 접속시각이라 민감 → stats_view 권한(또는 admin)만 조회 가능.
async function statsActiveUsers(event) {
  const authz = getAuthz(event);
  if (!(await hasPermission(authz.role, 'stats_view'))) return json(403, { error: '권한이 없습니다' });
  // DAU/WAU/MAU·고착도·총로그인·평균(series)은 모두 "고객 계정 기준"(role='customer')으로 집계한다.
  // 역할별 접속 비중(byRole)만 전체 역할을 대상으로 한다(그 카드의 취지가 역할 분포이므로).
  // 오늘(KST) 자정 이후 = DAU. KST 자정을 timestamptz로 만들어 created_at(timestamptz)과 비교.
  const [d] = await query(
    `select count(distinct user_id)::int n from login_events
      where role = 'customer' and created_at >= (date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')`);
  const [w] = await query(
    `select count(distinct user_id)::int n from login_events where role = 'customer' and created_at >= now() - interval '7 days'`);
  const [m] = await query(
    `select count(distinct user_id)::int n from login_events where role = 'customer' and created_at >= now() - interval '30 days'`);
  const series = await query(
    `select to_char((created_at at time zone 'Asia/Seoul')::date, 'YYYY-MM-DD') d, count(distinct user_id)::int n
       from login_events where role = 'customer' and created_at >= now() - interval '30 days' group by 1 order by 1`);
  // 총 로그인 횟수(중복 포함, 30일, 고객 기준) — DAU/WAU/MAU(고유)와 달리 재접속 빈도를 본다.
  const [tot] = await query(
    `select count(*)::int n from login_events where role = 'customer' and created_at >= now() - interval '30 days'`);
  // 역할별 고유 접속자(30일) — 접속 비중 도넛용. 전체 역할. login_events.role(로그인 시점 스냅샷) 기준.
  const byRole = await query(
    `select role, count(distinct user_id)::int n from login_events
       where created_at >= now() - interval '30 days' group by role order by n desc`);
  return json(200, {
    dau: d.n, wau: w.n, mau: m.n,
    stickiness: m.n ? Math.round((d.n / m.n) * 100) : 0,
    totalLogins: tot.n,
    byRole,
    series,
  });
}

// ── GET /stats/documents ──
// 사용 통계 > 자료실 활용 탭. content_documents 단독 집계.
//
// ⚠ download_count는 다운로드할 때마다 1씩 올리는 누적 카운터이지 이벤트 로그가 아니다.
// "총 몇 번"은 알 수 있어도 "언제·누가"는 남지 않으므로, 이 탭에는 추이 그래프도
// 사용자별 분해도 없다(있는 척하면 안 된다). 화면에도 그 사실을 적어 둔다.
// 쿼리스트링: category, limit/offset(다운로드 0건 목록 페이지네이션용).
async function statsDocuments(event) {
  const authz = getAuthz(event);
  if (!(await hasPermission(authz.role, 'stats_view'))) return json(403, { error: '권한이 없습니다' });

  const qs = event.queryStringParameters || {};
  const params = [];
  const where = [];
  if (qs.category) { params.push(qs.category); where.push(`category = $${params.length}`); }
  const w = where.length ? 'where ' + where.join(' and ') : '';

  const [sum] = await query(
    `select count(*)::int docs,
            count(*) filter (where is_public)::int public_n,
            count(*) filter (where not is_public)::int private_n,
            coalesce(sum(download_count), 0)::int downloads,
            count(*) filter (where coalesce(download_count, 0) = 0)::int zero,
            coalesce(max(download_count), 0)::int max_dl,
            coalesce(sum(file_size), 0)::bigint bytes
       from content_documents ${w}`, params);

  // 최다 다운로드 자료의 제목 — KPI 카드 부제로 쓴다.
  const [topDoc] = await query(
    `select title from content_documents ${w}
      order by download_count desc nulls last, created_at desc limit 1`, params);

  const top = await query(
    `select title, category, coalesce(nullif(product,''), '') product,
            coalesce(download_count, 0)::int n
       from content_documents ${w ? w + ' and' : 'where'} coalesce(download_count, 0) > 0
      order by n desc, created_at desc limit 8`, params);

  // 카테고리별 등록 수와 그중 0건 수를 함께 낸다 — 두 값을 나란히 놔야
  // "이 카테고리는 통째로 안 쓰인다"가 보인다(예: edu 9개 중 9개가 0건).
  const byCategory = await query(
    `select category, count(*)::int n,
            count(*) filter (where coalesce(download_count, 0) = 0)::int zero,
            coalesce(sum(download_count), 0)::int downloads
       from content_documents ${w} group by 1 order by n desc`, params);

  const limit = Math.min(100, Math.max(1, parseInt(qs.limit, 10) || 10));
  const offset = Math.max(0, parseInt(qs.offset, 10) || 0);
  const zeroList = await query(
    `select id, title, category, coalesce(nullif(product,''), '') product, is_public,
            to_char(created_at at time zone 'Asia/Seoul', 'YYYY-MM-DD') created,
            coalesce(file_size, 0)::bigint file_size
       from content_documents ${w ? w + ' and' : 'where'} coalesce(download_count, 0) = 0
      order by created_at desc limit ${limit} offset ${offset}`, params);

  return json(200, {
    summary: {
      docs: sum.docs, publicN: sum.public_n, privateN: sum.private_n,
      downloads: sum.downloads, zero: sum.zero, maxDownload: sum.max_dl,
      maxTitle: topDoc ? topDoc.title : '', bytes: Number(sum.bytes),
    },
    top, byCategory, zeroTotal: sum.zero, zeroList,
  });
}

// ── GET /stats/companies ──
// 사용 통계 > 고객 활용 탭. 고객사별 활용도(접속·계정·요청·계약)를 한 줄씩 집계한다.
// 397개 고객사를 한 쿼리로 모아 정렬·페이지네이션까지 서버에서 끝낸다.
//
// 등급 규칙. 접속·계정 중심이고 요청은 적체로만 보조 반영한다 — 요청 0건을 위험으로
// 잡으면 티켓이 적은 지금 거의 전부가 빨강이 되어 신호가 죽는다.
//
// ⚠ '한 번도 안 들어온 곳'을 위험으로 묶지 않는 이유: 실제로 402개사 중 387개사가 여기
// 해당해서(2026-08-31 기준) 위험에 넣으면 96%가 빨강이 되어 우선순위를 못 가린다.
// 성격도 다르다 — 쓰다가 끊긴 곳(이탈)과 아직 시작을 안 한 곳(온보딩)은 대응이 다르므로
// 'none'으로 따로 뺀다. 그래야 빨강이 "쓰던 고객이 이탈 중"이라는 진짜 신호가 된다.
//   미접속(none) = 로그인한 적 있는 계정이 하나도 없음(계정 미발급 포함)
//   위험(bad)   = 접속 이력은 있으나 90일 넘게 무접속
//   주의(mid)   = 활성화율 30% 미만 / 30~90일 무접속 / 30일+ 적체 보유
//   양호(ok)    = 나머지
// 접속 이벤트(login_events)는 기록 시작 이후만 있으므로 무접속 판정은 users.last_login을
// 쓴다(전체 기간 유효). 기간 내 접속자 수만 login_events에서 센다.
function _companyGradeSql() {
  return `case
    when coalesce(u.activated, 0) = 0 then 'none'
    when u.last_login < now() - interval '90 days' then 'bad'
    when (u.total > 0 and coalesce(u.activated, 0)::numeric / u.total < 0.3)
      or u.last_login < now() - interval '30 days'
      or coalesce(t.oldest_open_days, 0) >= 30 then 'mid'
    else 'ok' end`;
}

async function statsCompanies(event) {
  const authz = getAuthz(event);
  if (!(await hasPermission(authz.role, 'stats_view'))) return json(403, { error: '권한이 없습니다' });

  const qs = event.queryStringParameters || {};
  const days = Math.min(3650, Math.max(0, parseInt(qs.days, 10) || 0));
  const period = days > 0 ? `and created_at >= now() - interval '${days} days'` : '';
  const params = [];

  // 고객사 필터(검색·유형·담당영업·상태). 조건은 전부 바깥 래퍼에서 걸므로
  // CTE 별칭(co./u./t./c.)이 아니라 select 결과 컬럼명을 쓴다.
  const outer = [];
  const q = (qs.q || '').trim();
  if (q) { params.push('%' + q + '%'); outer.push(`name ilike $${params.length}`); }
  if (qs.type)    { params.push(qs.type);    outer.push(`customer_type = $${params.length}`); }
  if (qs.manager) { params.push(qs.manager); outer.push(`account_manager = $${params.length}`); }
  if (qs.status)  { params.push(qs.status);  outer.push(`status = $${params.length}`); }

  const base = `
    with u as (
      select company_id,
             count(*)::int total,
             count(*) filter (where last_login is not null)::int activated,
             max(last_login) last_login
        from users where role = 'customer' and company_id is not null group by 1),
    t as (
      select company_id,
             count(*)::int tickets,
             count(*) filter (where status not in ('completed','cancelled'))::int open_cnt,
             count(*) filter (where registered_by is not null)::int proxy,
             max(case when status not in ('completed','cancelled')
                      then (extract(epoch from (now() - created_at)) / 86400)::int end) oldest_open_days
        from tickets where company_id is not null ${period} group by 1),
    v as (
      select company_id, count(distinct user_id)::int visitors
        from login_events where company_id is not null ${period} group by 1),
    c as (
      select company_id, min(end_date) next_end
        from company_contracts where end_date >= current_date group by 1)
    select co.id, co.name, co.status, co.customer_type, co.account_manager,
           coalesce(u.total, 0)::int users_total,
           coalesce(u.activated, 0)::int users_activated,
           u.last_login,
           coalesce(v.visitors, 0)::int visitors,
           coalesce(t.tickets, 0)::int tickets,
           coalesce(t.open_cnt, 0)::int open_cnt,
           coalesce(t.proxy, 0)::int proxy,
           t.oldest_open_days,
           c.next_end,
           case when c.next_end is null then null
                else (c.next_end - current_date)::int end dday,
           ${_companyGradeSql()} grade
      from companies co
      left join u on u.company_id = co.id
      left join t on t.company_id = co.id
      left join v on v.company_id = co.id
      left join c on c.company_id = co.id`;

  // 프리셋 — 표를 실제로 쓰게 만드는 장치. 컬럼명은 위 select의 출력 이름을 쓴다.
  const preset = qs.preset || '';
  if (preset === 'risk') {
    // 이탈 위험: 쓰던 고객이 끊긴 곳(등급 위험) 또는 주의 상태에서 계약 만료가 임박한 곳
    outer.push(`(grade = 'bad' or (grade = 'mid' and next_end is not null and next_end <= current_date + 90))`);
  } else if (preset === 'onboard') {
    // 온보딩 필요: 계정은 발급했는데 아무도 로그인한 적이 없는 곳(계정 미발급은 제외 —
    // 아직 줄 계정이 없는 것과 주고도 안 쓰는 것은 다른 문제다)
    outer.push(`grade = 'none' and users_total > 0`);
  } else if (preset === 'heavy') {
    outer.push(`tickets > 0`);
  }
  const filtered = outer.length ? `select * from (${base}) x where ${outer.join(' and ')}` : base;

  // 정렬 — 기본은 위험도순(위험 → 주의 → 양호, 같은 등급이면 오래 안 들어온 순).
  const SORTS = {
    risk:       `case grade when 'bad' then 0 when 'mid' then 1 when 'none' then 2 else 3 end,
                 last_login asc nulls last, users_total desc`,
    tickets:    `tickets desc`,
    open:       `open_cnt desc`,
    visitors:   `visitors desc`,
    activation: `case when users_total = 0 then 0 else users_activated::numeric / users_total end asc`,
    dday:       `dday asc nulls last`,
    name:       `name asc`,
  };
  const order = SORTS[qs.sort] || SORTS.risk;
  const limit = Math.min(200, Math.max(1, parseInt(qs.limit, 10) || 20));
  const offset = Math.max(0, parseInt(qs.offset, 10) || 0);

  const [{ n: total }] = await query(`select count(*)::int n from (${filtered}) z`, params);
  const rows = await query(`select * from (${filtered}) z order by ${order} limit ${limit} offset ${offset}`, params);

  // ── 요약 KPI ── (프리셋·페이지와 무관하게 전체 모집단 기준)
  const [sum] = await query(`
    select count(*)::int companies,
           count(*) filter (where coalesce(v.visitors,0) > 0 or coalesce(t.tickets,0) > 0)::int active,
           count(*) filter (where coalesce(u.activated,0) = 0 and coalesce(u.total,0) > 0)::int never_in,
           count(*) filter (where coalesce(t.tickets,0) = 0)::int no_ticket,
           coalesce(sum(t.open_cnt), 0)::int open_total,
           count(*) filter (where c.next_end is not null and c.next_end <= current_date + 90)::int expiring
      from companies co
      left join (select company_id, count(*)::int total,
                        count(*) filter (where last_login is not null)::int activated
                   from users where role='customer' and company_id is not null group by 1) u on u.company_id = co.id
      left join (select company_id, count(*)::int tickets,
                        count(*) filter (where status not in ('completed','cancelled'))::int open_cnt
                   from tickets where company_id is not null ${period} group by 1) t on t.company_id = co.id
      left join (select company_id, count(distinct user_id)::int visitors
                   from login_events where company_id is not null ${period} group by 1) v on v.company_id = co.id
      left join (select company_id, min(end_date) next_end from company_contracts
                  where end_date >= current_date group by 1) c on c.company_id = co.id`);

  // 등급 분포(도넛) — 표 필터와 무관하게 전체 고객사 기준
  const grades = await query(`select grade, count(*)::int n from (${base}) g group by 1`, []);

  // 담당영업·고객유형 필터 옵션(화면에서 하드코딩하지 않도록 실제 값을 내려준다)
  const managers = await query(
    `select distinct account_manager m from companies
      where coalesce(account_manager,'') <> '' order by 1`);
  const types = await query(
    `select distinct customer_type t from companies
      where coalesce(customer_type,'') <> '' order by 1`);

  return json(200, {
    total, rows, summary: sum, grades,
    managers: managers.map(r => r.m), types: types.map(r => r.t),
  });
}

// ── GET /stats/company-detail ──
// 고객사 한 곳을 펼쳤을 때의 상세. 경로 파라미터 대신 쿼리스트링을 쓴다
// (API Gateway가 캐치올 없이 경로를 하나씩 등록하는 구조라 라우트를 덜 만든다).
async function statsCompanyDetail(event) {
  const authz = getAuthz(event);
  if (!(await hasPermission(authz.role, 'stats_view'))) return json(403, { error: '권한이 없습니다' });
  const qs = event.queryStringParameters || {};
  const id = qs.id || '';
  if (!/^[0-9a-fA-F-]{36}$/.test(id)) return json(400, { error: 'id가 필요합니다' });
  const days = Math.min(3650, Math.max(0, parseInt(qs.days, 10) || 0));
  const period = days > 0 ? `and created_at >= now() - interval '${days} days'` : '';

  // 월별 요청 수 + 접속자 수 (최근 6개월 고정 — 추이는 기간 필터와 무관하게 흐름을 본다)
  const series = await query(
    `with m as (select to_char(generate_series(
                  date_trunc('month', now() at time zone 'Asia/Seoul') - interval '5 months',
                  date_trunc('month', now() at time zone 'Asia/Seoul'), interval '1 month'), 'YYYY-MM') ym)
     select m.ym,
            (select count(*)::int from tickets
              where company_id = $1
                and to_char(created_at at time zone 'Asia/Seoul', 'YYYY-MM') = m.ym) tickets,
            (select count(distinct user_id)::int from login_events
              where company_id = $1
                and to_char(created_at at time zone 'Asia/Seoul', 'YYYY-MM') = m.ym) visitors
       from m order by m.ym`, [id]);

  const byStatus = await query(
    `select status, count(*)::int n from tickets where company_id = $1 ${period} group by 1`, [id]);
  const byCategory = await query(
    `select category, count(*)::int n from tickets where company_id = $1 ${period} group by 1 order by n desc`, [id]);
  const [intake] = await query(
    `select count(*) filter (where registered_by is null)::int direct,
            count(*) filter (where registered_by is not null)::int proxy
       from tickets where company_id = $1 ${period}`, [id]);
  const openList = await query(
    `select ticket_number, title, status, coalesce(nullif(assigned_to_name,''), '') assignee,
            (extract(epoch from (now() - created_at)) / 86400)::int days
       from tickets where company_id = $1 and status not in ('completed','cancelled')
      order by created_at asc limit 10`, [id]);
  // 계정별 활동 — 고객사 안에서 누가 창구 노릇을 하는지. last_login은 전체 기간 기준이라
  // 접속 이벤트 기록 시작 이전 접속도 반영된다.
  const users = await query(
    `select u.name, u.last_login,
            (select count(*)::int from tickets where created_by = u.id) tickets
       from users u where u.company_id = $1 and u.role = 'customer'
      order by u.last_login desc nulls last, u.name limit 12`, [id]);
  const [cnt] = await query(
    `select count(*)::int n from users where company_id = $1 and role = 'customer'`, [id]);

  return json(200, { series, byStatus, byCategory, intake, openList, users, usersTotal: cnt.n });
}

// ── GET /stats/tickets ──
// 사용 통계 > 요청 현황 탭. 티켓 집계를 서버(SQL)에서 끝낸다 — data-api의 범용 조회는
// limit이 1000으로 캡되므로 전건을 프런트로 내려 집계하면 건수가 늘어난 뒤 조용히 틀린 값이 된다.
// 쿼리스트링: days(기간, 0=전체), category, product, priority, assignee(미배정은 'none'),
//             path(direct=고객 직접 / proxy=대리 등록), agent(대리 등록자 uuid).
// 반환 지표는 tickets 단독 집계라 ticket_history의 상태전이 파싱에 의존하지 않는다.
async function statsTickets(event) {
  const authz = getAuthz(event);
  if (!(await hasPermission(authz.role, 'stats_view'))) return json(403, { error: '권한이 없습니다' });

  const qs = event.queryStringParameters || {};
  // 기간 필터는 접수(created_at) 기준. 0/미지정이면 전체 기간.
  const days = Math.min(3650, Math.max(0, parseInt(qs.days, 10) || 0));
  const where = [], params = [];
  if (days > 0) where.push(`created_at >= now() - interval '${days} days'`);
  if (qs.category) { params.push(qs.category); where.push(`category = $${params.length}`); }
  if (qs.product)  { params.push(qs.product);  where.push(`product = $${params.length}`); }
  if (qs.priority) { params.push(qs.priority); where.push(`priority = $${params.length}`); }
  if (qs.assignee === 'none') where.push('assigned_to is null');
  else if (qs.assignee) { params.push(qs.assignee); where.push(`assigned_to = $${params.length}`); }

  // 접수 경로 필터. 경로를 뺀 조건(wBase)을 따로 들고 있다가 "전체 대비 몇 %"를 낼 때 쓴다 —
  // 경로로 걸러진 상태에서 대리 등록 비율을 재면 항상 100%/0%가 되어 지표가 죽는다.
  const wBase = where.length ? 'where ' + where.join(' and ') : '';
  const baseParamCount = params.length;
  if (qs.path === 'direct') where.push('registered_by is null');
  else if (qs.path === 'proxy') where.push('registered_by is not null');
  if (qs.agent) { params.push(qs.agent); where.push(`registered_by = $${params.length}`); }
  const w = where.length ? 'where ' + where.join(' and ') : '';

  // 미해결 = 완료·취소를 제외한 모든 상태. 적체·미배정 지표가 모두 이 정의를 따른다.
  const OPEN = `status not in ('completed','cancelled')`;

  // ── 요약 KPI ──
  const [sum] = await query(
    `select count(*)::int total,
            count(*) filter (where status = 'completed')::int completed,
            count(*) filter (where status = 'cancelled')::int cancelled,
            count(*) filter (where ${OPEN})::int "open",
            count(*) filter (where ${OPEN} and created_at < now() - interval '30 days')::int aged,
            count(*) filter (where ${OPEN} and assigned_to is null)::int unassigned,
            count(*) filter (where ${OPEN} and due_date is not null and due_date < current_date)::int overdue,
            count(*) filter (where registered_by is not null)::int proxy
       from tickets ${w}`, params);

  // 직전 동일 기간 대비 증감(days=0이면 비교 대상이 없어 null).
  let prev = null;
  if (days > 0) {
    const pWhere = where.map(c => c.startsWith('created_at >=')
      ? `created_at >= now() - interval '${days * 2} days' and created_at < now() - interval '${days} days'`
      : c);
    const [p] = await query(
      `select count(*)::int total, count(*) filter (where registered_by is not null)::int proxy
         from tickets where ${pWhere.join(' and ')}`, params);
    prev = { total: p.total, proxy: p.proxy };
  }

  // ── 접수 추이 (주 단위 × 카테고리, KST 월요일 시작) ──
  // 전체 기간이면 최근 12주(84일)만 그린다 — 막대가 무한히 늘어나지 않게.
  const trend = await query(
    `select to_char(date_trunc('week', created_at at time zone 'Asia/Seoul'), 'YYYY-MM-DD') wk,
            category, count(*)::int n
       from tickets ${w ? w + ' and' : 'where'} created_at >= now() - interval '${days > 0 ? days : 84} days'
      group by 1, 2 order by 1`, params);

  // ── 분포 ──
  const byStatus   = await query(`select status, count(*)::int n from tickets ${w} group by 1`, params);
  const byCategory = await query(`select category, count(*)::int n from tickets ${w} group by 1 order by n desc`, params);
  const byPriority = await query(`select priority, count(*)::int n from tickets ${w} group by 1`, params);
  const byProduct  = await query(
    `select coalesce(nullif(product, ''), '(미지정)') p, count(*)::int n
       from tickets ${w} group by 1 order by n desc limit 8`, params);

  // ── 접수 시간대 히트맵 (요일 0=일~6=토, 시각 0~23, KST) ──
  const heatmap = await query(
    `select extract(dow  from created_at at time zone 'Asia/Seoul')::int d,
            extract(hour from created_at at time zone 'Asia/Seoul')::int h,
            count(*)::int n
       from tickets ${w} group by 1, 2`, params);

  // ── 담당자 부하 ──
  // 화면의 모든 블록이 같은 범위(= 선택한 기간에 접수된 요청 + 필터)를 쓴다. 여기만 전체 기간을
  // 보면 KPI의 미배정 수와 이 차트의 미배정 막대가 서로 다른 값이 되어 어느 쪽을 믿을지 알 수 없다.
  // 이름은 assigned_to_name 스냅샷을 써서 계정이 삭제돼도 이력이 남는다.
  const workload = await query(
    `select coalesce(nullif(assigned_to_name, ''), '(미배정)') name,
            count(*) filter (where ${OPEN})::int "open",
            count(*) filter (where status = 'completed')::int "done"
       from tickets ${w} group by 1 order by 2 desc, 3 desc limit 12`, params);

  // ── 적체: 경과일 버킷 + 오래된 순 목록 ──
  // 버킷 경계(7일·30일)는 접수 시각 기준 경과일이며, 위 KPI의 aged(30일+)와 같은 정의를 쓴다.
  const openWhere = w ? `${w} and ${OPEN}` : `where ${OPEN}`;
  const [age] = await query(
    `select count(*) filter (where created_at >= now() - interval '7 days')::int b0,
            count(*) filter (where created_at <  now() - interval '7 days'
                               and created_at >= now() - interval '30 days')::int b1,
            count(*) filter (where created_at <  now() - interval '30 days')::int b2
       from tickets ${openWhere}`, params);
  const oldest = await query(
    `select ticket_number, title, coalesce(company_name, '') company, category, status,
            coalesce(nullif(assigned_to_name, ''), '') assignee,
            (extract(epoch from (now() - created_at)) / 86400)::int days
       from tickets ${openWhere} order by created_at asc limit 10`, params);

  // 경로 필터를 뺀 총계 — "전체 대비 N%" 계산용. 필터가 없으면 total과 같으므로 재조회하지 않는다.
  let pathTotal = sum.total;
  if (qs.path || qs.agent) {
    const [pt] = await query(`select count(*)::int n from tickets ${wBase}`, params.slice(0, baseParamCount));
    pathTotal = pt.n;
  }

  // 대리 등록자 목록 — 실제로 대신 접수한 적이 있는 사람만. 담당자 필터와 달리 전체 스태프를
  // 넣지 않는다(대리 등록 이력이 없는 사람은 고를 이유가 없다). 경로 필터는 빼고 집계해야
  // 대리 등록을 고른 뒤에도 선택지가 그대로 남는다.
  const agents = await query(
    `select registered_by id, coalesce(nullif(registered_by_name,''), '(이름 없음)') name, count(*)::int n
       from tickets ${wBase ? wBase + ' and' : 'where'} registered_by is not null
      group by 1, 2 order by n desc limit 20`, params.slice(0, baseParamCount));

  return json(200, {
    summary: {
      total: sum.total, completed: sum.completed, cancelled: sum.cancelled,
      open: sum.open, aged: sum.aged, unassigned: sum.unassigned,
      overdue: sum.overdue, proxy: sum.proxy, pathTotal,
    },
    prev, trend, byStatus, byCategory, byPriority, byProduct, heatmap, workload, agents,
    aging: { lt7: age.b0, d7to30: age.b1, gt30: age.b2 },
    oldest,
  });
}

// ── GET /stats/login-history ──
// 로그인 이벤트 전체 이력(감사로그). 스냅샷(user_name/company_name)만 읽어 무조인. stats_view 강제.
// 쿼리스트링: q(이름·고객사 검색), role, days(기간), limit, offset.
async function statsLoginHistory(event) {
  const authz = getAuthz(event);
  if (!(await hasPermission(authz.role, 'stats_view'))) return json(403, { error: '권한이 없습니다' });
  const qs = event.queryStringParameters || {};
  const where = [], params = [];
  const q = (qs.q || '').trim();
  if (q) { params.push('%' + q + '%'); where.push(`(coalesce(user_name,'') ilike $${params.length} or coalesce(company_name,'') ilike $${params.length})`); }
  if (qs.role) { params.push(qs.role); where.push(`role = $${params.length}`); }
  const days = Math.min(3650, Math.max(0, parseInt(qs.days, 10) || 0));
  if (days > 0) where.push(`created_at >= now() - interval '${days} days'`);
  const limit = Math.min(200, Math.max(1, parseInt(qs.limit, 10) || 50));
  const offset = Math.max(0, parseInt(qs.offset, 10) || 0);
  const wsql = where.length ? 'where ' + where.join(' and ') : '';
  const [{ n: total }] = await query(`select count(*)::int n from login_events ${wsql}`, params);
  const rows = await query(
    `select id, coalesce(user_name,'(삭제된 사용자)') as name, role,
            coalesce(company_name,'') as company, created_at
       from login_events ${wsql}
      order by created_at desc limit ${limit} offset ${offset}`, params);
  return json(200, { total, limit, offset, rows });
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

// ── POST /auth/invite ──
// 관리자가 계정을 만든 뒤 호출한다. 임시 비밀번호를 만들지 않고, 사용자가 스스로
// 비밀번호를 정하도록 설정 링크만 메일로 보낸다(재설정 토큰 재사용).
// 초대 링크는 재설정(30분)보다 길게 7일을 준다 — 담당자가 메일을 늦게 확인하는 경우가 많다.
const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function inviteUser(body, event) {
  const authz = getAuthz(event);
  // 계정 생성 권한이 있는 사람만 초대 메일을 보낼 수 있다 — 아무나 호출하면 임의 주소로
  // 회사 명의 메일을 보내거나 남의 계정 비밀번호를 재설정할 수 있게 된다.
  if (!(await hasPermission(authz.role, 'user_manage'))) {
    return json(403, { error: '사용자 관리 권한이 필요합니다' });
  }
  const { email } = body;
  if (!email) return json(400, { error: 'email은 필수입니다' });

  const rows = await query('select id, name, is_active from users where email=$1', [email]);
  const user = rows[0];
  if (!user) return json(404, { error: '등록된 이메일이 아닙니다.' });
  if (user.is_active === false) return json(403, { error: '비활성화된 계정입니다.' });

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_MS).toISOString();
  await query('update users set reset_token=$1, reset_token_expires_at=$2 where id=$3', [token, expiresAt, user.id]);
  await notifyEmail({ type: 'ACCOUNT_INVITE', toEmail: email, userName: user.name, token, validDays: 7 });
  return json(200, { ok: true });
}

// ── GET /my/account-manager ──
// 로그인한 사용자가 자기 고객사의 담당영업 이름·이메일만 받아간다.
//
// 범용 /data/users로는 못 가져온다 — 고객 계정이 users를 조회하면 본인 행이 아닌 한
// 이메일이 지워져서 나온다(전체 직원 이메일 수집을 막는 장치). 그 장치를 풀지 않고,
// "자기 회사 담당자 한 명"만 서버가 짚어서 내려주는 좁은 경로를 따로 둔다.
async function getMyAccountManager(event) {
  const authz = getAuthz(event);
  if (!authz.companyId) return json(200, { name: null, email: null });

  const rows = await query(
    `select c.account_manager as name, u.email
       from companies c
       left join users u on u.name = c.account_manager and u.is_active = true
      where c.id = $1`,
    [authz.companyId]
  );
  const row = rows[0];
  if (!row?.name) return json(200, { name: null, email: null });
  return json(200, { name: row.name, email: row.email || null });
}

// ── POST /auth/admin-reset-password ──
// 관리자가 사용자를 대신해 비밀번호 재설정을 걸어준다. 관리자가 비밀번호를 정해주지
// 않고, "비밀번호를 잊으셨나요?"와 똑같은 재설정 메일만 보낸다 — 새 비밀번호는 본인만
// 알게 되고, 공용 임시 비밀번호가 돌아다니지 않는다.
// 토큰 유효기간도 그 흐름과 같은 30분이어야 한다(메일 본문이 30분이라고 안내한다).
async function adminResetPassword(body, event) {
  const authz = getAuthz(event);
  if (!(await hasPermission(authz.role, 'user_manage'))) {
    return json(403, { error: '사용자 관리 권한이 필요합니다' });
  }
  const { userId } = body;
  if (!userId) return json(400, { error: 'userId는 필수입니다' });

  const targets = await query('select id, name, email, role, is_active from users where id=$1', [userId]);
  const target = targets[0];
  if (!target) return json(404, { error: '존재하지 않는 사용자입니다.' });
  if (target.is_active === false) return json(403, { error: '비활성화된 계정입니다.' });

  // 권한 상승 차단 — user_manage를 가진 비관리자(예: 영업)가 관리자·내부직원 계정에
  // 재설정을 걸어 메일을 가로채는 식으로 계정을 넘겨받는 경로를 막는다.
  if (target.role !== 'customer' && authz.role !== 'admin') {
    return json(403, { error: '내부 직원 계정은 관리자만 재설정할 수 있습니다.' });
  }

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
  await query('update users set reset_token=$1, reset_token_expires_at=$2 where id=$3',
    [token, expiresAt, target.id]);
  // 누가 누구에게 재설정을 걸었는지는 남겨야 사후 추적이 된다(별도 감사 테이블은 아직 없음).
  console.log(`[admin-reset] by=${authz.userId} role=${authz.role} target=${target.email}`);

  let emailSent = false;
  try {
    const r = await notifyEmail({
      type: 'PASSWORD_RESET', toEmail: target.email, userName: target.name, token,
    });
    emailSent = !!r?.ok && (r.sent ?? 0) > 0;
  } catch (e) {
    console.error('[admin-reset] 재설정 메일 발송 실패', e);
  }
  return json(200, { ok: true, name: target.name, email: target.email, emailSent });
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

// 완료예정일 초과 판정 — 날짜만 비교한다(마감일 당일은 초과가 아니다).
// due_date는 날짜 컬럼이라 UTC 자정(=KST 09시) Date로 읽히는데, 예전 코드가 이걸 시각까지
// 비교해서 마감일 당일 오전 9시만 지나면 초과로 오판했다.
function kstToday() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function dueDateOnly(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return new Date(v).toISOString().slice(0, 10);   // pg date → UTC 자정 Date
}
function isOverdue(dueDate) {
  const d = dueDateOnly(dueDate);
  return !!d && d < kstToday();
}

// ── EventBridge Scheduler가 매일 09:00 KST에 {"task":"overdue_batch"} 페이로드로 직접 호출 ──
async function runOverdueBatch() {
  const today = kstToday();
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
    // 계정이 삭제되면 FK(created_by/assigned_to)는 null이 되므로, 티켓에 남긴 이름 스냅샷으로 폴백한다
    items.push({ ticket, companyName, requesterName: requester?.name ?? ticket.created_by_name, assigneeName: assignee?.name ?? ticket.assigned_to_name ?? '미배정', overdueDays });
  }

  if (items.length) await notifySlack({ type: 'OVERDUE_BATCH', tickets: items });
  return json(200, { processed: items.length });
}

// ── EventBridge Scheduler가 매일 00:01 KST에 {"task":"expire_contracts"} 페이로드로 직접 호출 ──
// 계약상태(진행중/만료 등)는 화면에서 수동으로만 바뀌는 값이라, 종료일이 지나도 자동으로
// "만료"로 안 바뀌는 문제가 있었음 — 매일 종료일 지난 "진행중" 계약을 "만료"로 정리한다.
// 기준일은 반드시 KST로 계산한다 — 예전엔 new Date().toISOString()(UTC)로 오늘을 구했는데,
// 이 배치는 00:01 KST(=전날 15:01 UTC)에 돌기 때문에 "오늘"이 하루 전 날짜로 잡혀서
// 종료일 당일 계약이 하루 늦게 만료 처리됐다. UTC에 9시간을 더해 KST 달력 날짜를 구한다.
async function runContractExpiryBatch() {
  const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const updated = await query(
    `update company_contracts set status='만료', updated_at=now()
     where status='진행중' and end_date < $1
     returning id, contract_name`,
    [today]
  );
  return json(200, { updated: updated.length, contracts: updated.map(c => c.contract_name) });
}

// ── EventBridge Scheduler가 매일 09:00 KST에 {"task":"license_expiry_notice"} 페이로드로 직접 호출 ──
// 라이선스 만료일/갱신일 정확히 7일 전에 공통 채널로 한 번 알린다.
//
// 라이선스는 유형(Creator/Viewer/…)마다 행이 따로 있고 날짜는 제품 그룹이 공유하므로,
// 그대로 조회하면 한 제품에 알림이 6번 간다 — 제품 그룹 단위로 묶어 한 건으로 보낸다.
//
// payload에 date를 넣으면 그 날짜를 "7일 뒤 기준일"로 삼는다. 배치가 실패한 날의 건을
// 나중에 다시 보내거나, 발송 테스트를 할 때 쓴다(직접 호출 전용 — HTTP 요청으로는
// event.task 자체가 설정되지 않아 이 경로에 닿지 않는다).
async function runLicenseExpiryNotice(event) {
  const targetDate = event?.date
    || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // 날짜는 to_char로 문자열로 받는다 — date 컬럼을 그대로 두면 JS Date로 올라와
  // 문자열 비교가 깨지고, 직렬화 과정의 타임존에 따라 하루 밀릴 수 있다.
  const rows = await query(
    `select c.name as company_name,
            ct.contract_name,
            ct.bixs_contact,
            ct.status as contract_status,
            to_char(ct.start_date, 'YYYY-MM-DD') as contract_start,
            to_char(ct.end_date,   'YYYY-MM-DD') as contract_end,
            l.product_info,
            to_char(l.end_date,     'YYYY-MM-DD') as end_date,
            to_char(l.renewal_date, 'YYYY-MM-DD') as renewal_date,
            string_agg(l.license_type || ' ' || l.quantity, ', '
                       order by l.license_type) as quantities
       from company_licenses l
       join companies c on c.id = l.company_id
       left join company_contracts ct on ct.id = l.contract_id
      where l.status = '활성'
        and l.quantity is not null and l.quantity > 0
        and (l.end_date = $1 or l.renewal_date = $1)
      group by c.name, ct.contract_name, ct.bixs_contact, ct.status,
               ct.start_date, ct.end_date,
               l.product_info, l.end_date, l.renewal_date
      order by c.name, l.product_info`,
    [targetDate]
  );

  // 만료 건과 갱신 건은 챙길 사람도 후속 조치도 달라서 메시지를 나눠 보낸다.
  // 두 날짜가 같은 날인 라이선스는 양쪽에 모두 들어간다 — 실제로 기한이 둘 다 걸린 것이다.
  const endRows   = rows.filter(r => r.end_date === targetDate);
  const renewRows = rows.filter(r => r.renewal_date === targetDate);

  // 해당 종류가 0건이면 그 메시지는 보내지 않는다 — 매일 "0건" 알림은 소음이다.
  if (endRows.length)   await notifySlack({ type: 'LICENSE_EXPIRY', kind: 'end',     targetDate, licenses: endRows });
  if (renewRows.length) await notifySlack({ type: 'LICENSE_EXPIRY', kind: 'renewal', targetDate, licenses: renewRows });
  return json(200, { targetDate, expiring: endRows.length, renewing: renewRows.length });
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

  if (event.task === 'license_expiry_notice') {
    try {
      return await runLicenseExpiryNotice(event);
    } catch (err) {
      console.error('[license_expiry_notice 오류]', err);
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
    if (method === 'POST' && path === '/auth/invite') {
      return await inviteUser(body, event);
    }
    if (method === 'GET' && path === '/my/account-manager') {
      return await getMyAccountManager(event);
    }
    if (method === 'GET' && path === '/stats/active-users') {
      return await statsActiveUsers(event);
    }
    if (method === 'GET' && path === '/stats/login-history') {
      return await statsLoginHistory(event);
    }
    if (method === 'GET' && path === '/stats/tickets') {
      return await statsTickets(event);
    }
    if (method === 'GET' && path === '/stats/companies') {
      return await statsCompanies(event);
    }
    if (method === 'GET' && path === '/stats/documents') {
      return await statsDocuments(event);
    }
    if (method === 'GET' && path === '/stats/company-detail') {
      return await statsCompanyDetail(event);
    }
    if (method === 'POST' && path === '/auth/admin-reset-password') {
      return await adminResetPassword(body, event);
    }
    if (method === 'GET' && path === '/proxy/bootstrap') {
      return await proxyBootstrap(event);
    }
    if (method === 'GET' && path === '/proxy/customers') {
      return await proxyCustomers(event);
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
    // 접미사 없는 /tickets/{id} — 작성자 본인 요청 내용 수정(위 접미사 라우트가 우선 매칭됨)
    const editMatch = path.match(/^\/tickets\/([^/]+)$/);
    if (method === 'PATCH' && editMatch) {
      return await editTicket(editMatch[1], body, event);
    }
    if (method === 'DELETE' && editMatch) {
      return await deleteTicket(editMatch[1], event);
    }
    return json(404, { error: 'not found' });
  } catch (err) {
    console.error('[api-layer 오류]', err);
    return json(500, { error: String(err) });
  }
};
