// notify-handler Lambda (DB 접속 없음 — VPC 밖에서 실행, NAT 불필요)
//
// 원본(Supabase notify-handler.ts)은 DB 트리거가 직접 호출하며 자체적으로
// Postgres를 조회했지만, 이 버전은 순수 "Slack 발송기"로만 동작한다.
// 회사명/담당자명/첨부파일명 등은 전부 호출자(Phase 4 API 레이어, RDS와 VPC로
// 연결된 Lambda)가 미리 조회해서 payload에 채워 넘겨줘야 한다.
//
// 입력 payload 형태:
// {
//   type: 'TICKET_INSERT' | 'TICKET_ASSIGNED' | 'TICKET_STATUS' | 'TICKET_OVERDUE'
//       | 'OVERDUE_BATCH' | 'CONNECTION_TEST',
//   ticket: { id, ticket_number, title, category, priority, created_at, due_date, status },
//   companyName, requesterName, assigneeName,
//   prevAssigneeName,          // TICKET_ASSIGNED 용
//   prevStatus,                // TICKET_STATUS 용
//   attachmentFileNames: string[],   // TICKET_INSERT 용
//   overdueDays,                     // TICKET_OVERDUE / OVERDUE_BATCH 항목별
//   tickets: [{ ticket, companyName, requesterName, assigneeName, overdueDays }]  // OVERDUE_BATCH 전용
// }
//
// 출력: { ok: true, results: [{ channel:'slack', eventType, recipient, ticketId, status, errorMessage }] }
// results는 caller가 log_notification 테이블에 직접 기록한다 (이 함수는 DB를 모른다).

const SLACK_WEBHOOK_COMMON = process.env.SLACK_WEEBHOOK_COMMON || ''; // 오타 그대로 유지 (원본 환경변수명)
const SLACK_WEBHOOK_SALES  = process.env.SLACK_WEBHOOK_SALES || '';
const SLACK_WEBHOOK_TECH   = process.env.SLACK_WEBHOOK_TECH || '';
const SLACK_WEBHOOK_EDU    = process.env.SLACK_WEBHOOK_EDU || '';
const PORTAL_URL           = process.env.PORTAL_URL || 'https://support.bigxdata.io';

const STATUS_KO = {
  received: '접수', classifying: '분류 중', in_progress: '처리 중',
  pending_customer: '고객 확인 필요', on_hold: '보류', completed: '완료', cancelled: '취소',
};
const CATEGORY_KO = {
  tech_support: '기술지원', contract: '계약 문의', license: '라이선스 문의',
  education: '교육 문의', other: '기타',
};
const PRIORITY_KO = { normal: '일반', high: '빠른 확인 필요', critical: '긴급' };

async function sendSlack(webhookUrl, recipientName, ticketId, eventType, header, body, results) {
  if (!webhookUrl) {
    results.push({ channel: 'slack', eventType, recipient: recipientName, ticketId, status: 'failure', errorMessage: `webhook not set (${recipientName})` });
    return;
  }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: [
          { type: 'divider' },
          { type: 'section', text: { type: 'mrkdwn', text: `${header}\n${body}` } },
        ],
      }),
    });
    if (!res.ok) {
      const msg = await res.text();
      results.push({ channel: 'slack', eventType, recipient: recipientName, ticketId, status: 'failure', errorMessage: `HTTP ${res.status}: ${msg}` });
    } else {
      results.push({ channel: 'slack', eventType, recipient: recipientName, ticketId, status: 'success' });
    }
  } catch (e) {
    results.push({ channel: 'slack', eventType, recipient: recipientName, ticketId, status: 'failure', errorMessage: e?.message ?? String(e) });
  }
}

function buildBaseMessage(ticket, names) {
  const createdAt = new Date(ticket.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  return (
    `• *요청번호:* ${ticket.ticket_number}\n` +
    `• *제목:* ${ticket.title}\n` +
    `• *고객사:* ${names.companyName ?? '-'}\n` +
    `• *요청자:* ${names.requesterName ?? '-'}\n` +
    `• *카테고리:* ${CATEGORY_KO[ticket.category] ?? ticket.category}\n` +
    `• *긴급도:* ${PRIORITY_KO[ticket.priority] ?? ticket.priority}\n` +
    `• *등록일시:* ${createdAt}\n` +
    `• *담당자:* ${names.assigneeName ?? '미배정'}`
  );
}

function detailLink(ticketNumber) {
  return `<${PORTAL_URL}?ticket=${ticketNumber}|${ticketNumber}>`;
}

async function handleConnectionTest(results) {
  const nowStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const testMsg = `🔧 *연결 테스트 (무시하셔도 됩니다)*\n고객지원포탈 관리자가 발송한 테스트 메시지입니다\n• *발송시각:* ${nowStr}`;
  const channels = [
    { name: '공통', webhook: SLACK_WEBHOOK_COMMON },
    { name: '기술지원', webhook: SLACK_WEBHOOK_TECH },
    { name: '영업', webhook: SLACK_WEBHOOK_SALES },
    { name: '교육', webhook: SLACK_WEBHOOK_EDU },
  ];
  await Promise.all(channels.map(ch => sendSlack(ch.webhook, ch.name, null, 'connection_test',
    testMsg, '', results)));
}

async function handleOverdueBatch(payload, results) {
  const tickets = payload.tickets || [];
  await Promise.all(tickets.map(async (item) => {
    const { ticket, overdueDays } = item;
    const dueDateStr = new Date(ticket.due_date).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
    await sendSlack(
      SLACK_WEBHOOK_COMMON, '#고객지원포탈-공통', ticket.id, 'overdue',
      `⏰ *완료예정일 초과 (+${overdueDays}일)*`,
      buildBaseMessage(ticket, item) + `\n• *완료예정일:* ${dueDateStr}` + `\n• *상세보기:* ${detailLink(ticket.ticket_number)}`,
      results
    );
  }));
}

async function handleTicketInsert(payload, results) {
  const { ticket, attachmentFileNames = [] } = payload;
  const isUrgent = ticket.priority === 'critical';
  const attLine = attachmentFileNames.length > 0
    ? `\n• *첨부파일 (${attachmentFileNames.length}개):* ${attachmentFileNames.join(', ')}`
    : '';

  const categoryLabel = CATEGORY_KO[ticket.category] ?? ticket.category;
  const urgentPrefix = isUrgent ? '[긴급] ' : '';
  const emoji = isUrgent ? '🚨' : '🟦';

  const msgHeader = `${emoji} *${urgentPrefix}${categoryLabel} 등록*`;
  const msgBody = buildBaseMessage(ticket, payload) + attLine + `\n• *상세보기:* ${detailLink(ticket.ticket_number)}`;
  const evtType = isUrgent ? 'urgent' : 'new_ticket';

  await sendSlack(SLACK_WEBHOOK_COMMON, '#고객지원포탈-공통', ticket.id, evtType, msgHeader, msgBody, results);

  if (['contract', 'license'].includes(ticket.category) && SLACK_WEBHOOK_SALES) {
    await sendSlack(SLACK_WEBHOOK_SALES, '#영업-슬랙채널', ticket.id, evtType, msgHeader, msgBody, results);
  }
  if (ticket.category === 'tech_support' && SLACK_WEBHOOK_TECH) {
    await sendSlack(SLACK_WEBHOOK_TECH, '#기술지원-슬랙채널', ticket.id, evtType, msgHeader, msgBody, results);
  }
  if (ticket.category === 'education' && SLACK_WEBHOOK_EDU) {
    await sendSlack(SLACK_WEBHOOK_EDU, '#교육-슬랙채널', ticket.id, evtType, msgHeader, msgBody, results);
  }
}

async function handleTicketAssigned(payload, results) {
  const { ticket, prevAssigneeName } = payload;
  const header = `👤 *담당자 배정* (${prevAssigneeName ?? '미배정'} → ${payload.assigneeName ?? '미배정'})`;
  const body = buildBaseMessage(ticket, payload) + `\n• *상세보기:* ${detailLink(ticket.ticket_number)}`;
  await sendSlack(SLACK_WEBHOOK_COMMON, '#고객지원포탈-공통', ticket.id, 'assigned', header, body, results);
  if (ticket.category === 'education' && SLACK_WEBHOOK_EDU) {
    await sendSlack(SLACK_WEBHOOK_EDU, '#교육-슬랙채널', ticket.id, 'assigned', header, body, results);
  }
}

async function handleTicketStatus(payload, results) {
  const { ticket, prevStatus } = payload;
  const from = STATUS_KO[prevStatus] ?? prevStatus;
  const to = STATUS_KO[ticket.status] ?? ticket.status;
  const emoji = ticket.status === 'completed' ? '✅' : '👀';
  const evtType = ticket.status === 'completed' ? 'completed' : 'pending_customer';
  const header = `${emoji} *상태 변경* (${from} → ${to})`;
  const body = buildBaseMessage(ticket, payload) + `\n• *상세보기:* ${detailLink(ticket.ticket_number)}`;
  await sendSlack(SLACK_WEBHOOK_COMMON, '#고객지원포탈-공통', ticket.id, evtType, header, body, results);
  if (ticket.category === 'education' && SLACK_WEBHOOK_EDU) {
    await sendSlack(SLACK_WEBHOOK_EDU, '#교육-슬랙채널', ticket.id, evtType, header, body, results);
  }
}

async function handleTicketOverdue(payload, results) {
  const { ticket, overdueDays } = payload;
  const dueDateStr = new Date(ticket.due_date).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
  await sendSlack(
    SLACK_WEBHOOK_COMMON, '#고객지원포탈-공통', ticket.id, 'overdue',
    overdueDays != null ? `⏰ *완료예정일 초과 (+${overdueDays}일)*` : `⏰ *완료예정일 초과*`,
    buildBaseMessage(ticket, payload) + `\n• *완료예정일:* ${dueDateStr}` + `\n• *상세보기:* ${detailLink(ticket.ticket_number)}`,
    results
  );
}

export const handler = async (event) => {
  const payload = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || event);
  const results = [];

  switch (payload.type) {
    case 'CONNECTION_TEST': await handleConnectionTest(results); break;
    case 'OVERDUE_BATCH':    await handleOverdueBatch(payload, results); break;
    case 'TICKET_INSERT':    await handleTicketInsert(payload, results); break;
    case 'TICKET_ASSIGNED':  await handleTicketAssigned(payload, results); break;
    case 'TICKET_STATUS':    await handleTicketStatus(payload, results); break;
    case 'TICKET_OVERDUE':   await handleTicketOverdue(payload, results); break;
    default: break;
  }

  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, results }) };
};
