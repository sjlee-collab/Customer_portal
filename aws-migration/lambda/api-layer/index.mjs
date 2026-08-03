// api-layer Lambda — 티켓 생성/상태변경/담당자배정 API (RDS 직접 연결, VPC 안)
// index.html(Phase 6)이 API Gateway를 통해 호출하게 될 엔드포인트.
// DB 쓰기 후 notify-handler/send-email Lambda를 직접 호출해서 알림을 보낸다.
//
// Slack/이메일 발송은 외부 API 호출이라 느릴 수 있어 클라이언트 응답을 기다리게 하면 안 된다.
// 응답을 만든 뒤 await 없이 그냥 두는 방식(fire-and-forget)은 Lambda 실행 환경이 응답 직후
// 멈춰버릴 수 있어 신뢰할 수 없으므로, 자기 자신을 비동기(Event) 방식으로 재호출해서
// 완전히 별도의 Lambda 실행으로 알림 처리를 넘긴다 (deferNotify / __deferred 분기).

import { randomBytes } from 'node:crypto';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { query } from './db.mjs';
import { notifySlack, notifyEmail } from './notify.mjs';

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

const lambda = new LambdaClient({});
const SELF_FN = process.env.AWS_LAMBDA_FUNCTION_NAME;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
};

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
  return { statusCode, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
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
  const rows = await query('select id, name, email from users where id=$1', [userId]);
  return rows[0] ?? null;
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
async function createTicket(body) {
  const { title, category, description, product, priority = 'normal', created_by, company_id, contract_id } = body;
  if (!title || !category || !created_by) return json(400, { error: 'title, category, created_by는 필수입니다' });

  const requester = await getUser(created_by);
  if (!requester) return json(400, { error: '존재하지 않는 사용자입니다' });

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

  const emailJobs = [];
  const emailPayload = { ticket, companyName: ticket.company_name, requesterEmail: requester?.email, requesterName: ticket.created_by_name };
  if (requester?.email) {
    emailJobs.push(notifyEmail({ type: 'INSERT', ...emailPayload }));
  }
  if (['contract', 'license'].includes(ticket.category)) {
    const accountManagerEmail = await getAccountManagerEmail(ticket.company_id, 'account_manager');
    if (accountManagerEmail) emailJobs.push(notifyEmail({ type: 'INSERT', ...emailPayload, accountManagerEmail }));
  }
  if (ticket.priority === 'critical') {
    const [accountManagerEmail, adminEmails] = await Promise.all([
      getAccountManagerEmail(ticket.company_id, 'account_manager'),
      getAdminEmails(),
    ]);
    emailJobs.push(notifyEmail({ type: 'INSERT', ...emailPayload, accountManagerEmail, adminEmails }));
  }
  await Promise.allSettled(emailJobs);
}

// ── PATCH /tickets/{id}/status ──
async function updateStatus(ticketId, body) {
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

  if (requester?.email) {
    await notifyEmail({ type: 'STATUS_CHANGE', ticket, companyName, requesterEmail: requester.email, requesterName: requester.name, prevStatus });
  }

  if (!['completed', 'cancelled'].includes(nextStatus) && ticket.due_date && new Date(ticket.due_date) < new Date()) {
    await notifySlack({ type: 'TICKET_OVERDUE', ticket, ...notifyBase });
  }
}

// ── PATCH /tickets/{id}/assign ──
async function assignTicket(ticketId, body) {
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

// ── PATCH /tickets/{id}/manage ──
// index.html의 "관리" 모달(saveManage) 전용: 상태/담당자/마감일을 한 번에 저장한다.
// 이력(ticket_history)·메모(ticket_memos) 기록은 응답 전에 즉시 처리하고,
// Slack 알림·이메일(느린 외부 호출)만 비동기로 넘긴다.
async function manageTicket(ticketId, body) {
  const { category, status, assigned_to, due_date, memo, send_email, cc_emails, changed_by, changed_by_name } = body;

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
  if (statusChanged && sendEmail && requester?.email) {
    await notifyEmail({
      type: 'STATUS_CHANGE', ticket, companyName,
      requesterEmail: requester.email, requesterName: requester.name,
      prevStatus, ccEmails,
    });
  }
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
  const { token, newPasswordHash } = body;
  if (!token || !newPasswordHash) return json(400, { error: 'token, newPasswordHash는 필수입니다' });

  const updated = await query(
    `update users set password=$1, reset_token=null, reset_token_expires_at=null
     where reset_token=$2 and reset_token_expires_at > now() returning id`,
    [newPasswordHash, token]
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
};

export const handler = async (event) => {
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

  if (method === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };

  const body = event.body ? JSON.parse(event.body) : {};

  try {
    if (method === 'POST' && path === '/auth/request-reset') {
      return await requestPasswordReset(body);
    }
    if (method === 'POST' && path === '/auth/reset-password') {
      return await resetPassword(body);
    }
    if (method === 'POST' && path === '/tickets') {
      return await createTicket(body);
    }
    const statusMatch = path.match(/^\/tickets\/([^/]+)\/status$/);
    if (method === 'PATCH' && statusMatch) {
      return await updateStatus(statusMatch[1], body);
    }
    const assignMatch = path.match(/^\/tickets\/([^/]+)\/assign$/);
    if (method === 'PATCH' && assignMatch) {
      return await assignTicket(assignMatch[1], body);
    }
    const manageMatch = path.match(/^\/tickets\/([^/]+)\/manage$/);
    if (method === 'PATCH' && manageMatch) {
      return await manageTicket(manageMatch[1], body);
    }
    return json(404, { error: 'not found' });
  } catch (err) {
    console.error('[api-layer 오류]', err);
    return json(500, { error: String(err) });
  }
};
