// api-layer Lambda — 티켓 생성/상태변경/담당자배정 API (RDS 직접 연결, VPC 안)
// index.html(Phase 6)이 API Gateway를 통해 호출하게 될 엔드포인트.
// DB 쓰기 후 notify-handler/send-email Lambda를 직접 호출해서 알림을 보낸다.

import { query } from './db.mjs';
import { notifySlack, notifyEmail } from './notify.mjs';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
};

const DEFAULT_ASSIGNEE_BY_CATEGORY = {
  education: { id: '53d240b2-b950-4c94-9289-17feb229aa69', name: '김서연' }, // syeonkim@bigxdata.io
};
const COMPANY_MANAGER_FIELD_BY_CATEGORY = {
  contract: 'account_manager',
  license: 'account_manager',
  tech_support: 'tech_support_manager',
};

function json(statusCode, body) {
  return { statusCode, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
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

  const notifyPayload = { companyName, requesterName: requester.name, assigneeName: assignedToName };

  await notifySlack({ type: 'TICKET_INSERT', ticket, ...notifyPayload, attachmentFileNames: [] });

  const emailJobs = [];
  const emailPayload = { ticket, companyName, requesterEmail: requester.email, requesterName: requester.name };
  if (requester.email) {
    emailJobs.push(notifyEmail({ type: 'INSERT', ...emailPayload }));
  }
  if (['contract', 'license'].includes(category)) {
    const accountManagerEmail = await getAccountManagerEmail(company_id, 'account_manager');
    if (accountManagerEmail) emailJobs.push(notifyEmail({ type: 'INSERT', ...emailPayload, accountManagerEmail }));
  }
  if (priority === 'critical') {
    const [accountManagerEmail, adminEmails] = await Promise.all([
      getAccountManagerEmail(company_id, 'account_manager'),
      getAdminEmails(),
    ]);
    emailJobs.push(notifyEmail({ type: 'INSERT', ...emailPayload, accountManagerEmail, adminEmails }));
  }
  await Promise.allSettled(emailJobs);

  return json(201, { ticket });
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
  if (prevStatus === status) return json(200, { ticket });

  const companyName = await getCompanyName(ticket.company_id);
  const requester = await getUser(ticket.created_by);
  const assignee = await getUser(ticket.assigned_to);
  const notifyBase = { companyName, requesterName: requester?.name, assigneeName: assignee?.name ?? '미배정' };

  if (['pending_customer', 'completed'].includes(status)) {
    await notifySlack({ type: 'TICKET_STATUS', ticket, ...notifyBase, prevStatus });
  }

  if (requester?.email) {
    await notifyEmail({ type: 'STATUS_CHANGE', ticket, companyName, requesterEmail: requester.email, requesterName: requester.name, prevStatus });
  }

  if (!['completed', 'cancelled'].includes(status) && ticket.due_date && new Date(ticket.due_date) < new Date()) {
    await notifySlack({ type: 'TICKET_OVERDUE', ticket, ...notifyBase });
  }

  return json(200, { ticket });
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
  if (prevAssigneeId === assigned_to) return json(200, { ticket });

  const companyName = await getCompanyName(ticket.company_id);
  const requester = await getUser(ticket.created_by);
  const prevAssignee = await getUser(prevAssigneeId);

  await notifySlack({
    type: 'TICKET_ASSIGNED', ticket, companyName,
    requesterName: requester?.name, assigneeName: newAssignee.name,
    prevAssigneeName: prevAssignee?.name ?? '미배정',
  });

  return json(200, { ticket });
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

export const handler = async (event) => {
  if (event.task === 'overdue_batch') {
    try {
      return await runOverdueBatch();
    } catch (err) {
      console.error('[overdue_batch 오류]', err);
      return json(500, { error: String(err) });
    }
  }

  const method = event.requestContext?.http?.method ?? event.httpMethod;
  const path = event.rawPath ?? event.path ?? '';

  if (method === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };

  const body = event.body ? JSON.parse(event.body) : {};

  try {
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
    return json(404, { error: 'not found' });
  } catch (err) {
    console.error('[api-layer 오류]', err);
    return json(500, { error: String(err) });
  }
};
