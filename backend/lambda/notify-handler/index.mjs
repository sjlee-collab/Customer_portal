// notify-handler Lambda (DB 접속 없음 — VPC 밖에서 실행, NAT 불필요)
//
// 원본(Supabase notify-handler.ts)은 DB 트리거가 직접 호출하며 자체적으로
// Postgres를 조회했지만, 이 버전은 순수 "Slack 발송기"로만 동작한다.
// 회사명/담당자명/첨부파일명 등은 전부 호출자(Phase 4 API 레이어, RDS와 VPC로
// 연결된 Lambda)가 미리 조회해서 payload에 채워 넘겨줘야 한다.
//
// 입력 payload 형태:
// {
//   registrarRole: 'sales' | ... | null,   // 대리 등록자의 역할(api-layer가 조회해서 넣어줌)
//   type: 'TICKET_INSERT' | 'TICKET_ASSIGNED' | 'TICKET_STATUS' | 'TICKET_OVERDUE'
//       | 'TICKET_REPLY' | 'OVERDUE_BATCH' | 'LICENSE_EXPIRY' | 'CONNECTION_TEST',
//   ticket: { id, ticket_number, title, category, priority, created_at, due_date, status },
//   companyName, requesterName, assigneeName,
//   prevAssigneeName,          // TICKET_ASSIGNED 용
//   prevStatus,                // TICKET_STATUS 용
//   attachmentFileNames: string[],   // TICKET_INSERT 용
//   overdueDays,                     // TICKET_OVERDUE / OVERDUE_BATCH 항목별
//   tickets: [{ ticket, companyName, requesterName, assigneeName, overdueDays }]  // OVERDUE_BATCH 전용
//   targetDate, licenses: [{ company_name, contract_name, product_info, end_date, renewal_date, quantities }]
//                                                                                 // LICENSE_EXPIRY 전용
// }
//
// 출력: { ok: true, results: [{ channel:'slack', eventType, recipient, ticketId, status, errorMessage }] }
// results는 caller가 log_notification 테이블에 직접 기록한다 (이 함수는 DB를 모른다).

const SLACK_WEBHOOK_COMMON = process.env.SLACK_WEEBHOOK_COMMON || ''; // 오타 그대로 유지 (원본 환경변수명)
const SLACK_WEBHOOK_SALES  = process.env.SLACK_WEBHOOK_SALES || '';
const SLACK_WEBHOOK_TECH   = process.env.SLACK_WEBHOOK_TECH || '';
const SLACK_WEBHOOK_EDU    = process.env.SLACK_WEBHOOK_EDU || '';
const PORTAL_URL           = process.env.PORTAL_URL || 'https://support.bigxdata.io';
// 테스트 모드 표기 — 하네스 email-safe.sh on 이면 TEST_TAG='[테스트]'가 설정되어 슬랙 헤더에 접두된다.
const TEST_TAG             = process.env.TEST_TAG || '';
// 테스트 모드 슬랙 리다이렉트 — email-safe.sh on 이 SLACK_REDIRECT=1을 설정하면
// 모든 슬랙 알림이 실 채널 대신 테스트 채널(SLACK_WEBHOOK_TEST)로만 간다.
// 웹훅 주소는 비밀값이라 레포에 두지 않고 Lambda 환경변수로만 보관한다.
const SLACK_WEBHOOK_TEST   = process.env.SLACK_WEBHOOK_TEST || '';
const SLACK_REDIRECT       = process.env.SLACK_REDIRECT === '1';

const STATUS_KO = {
  received: '접수', classifying: '분류 중', assigned: '담당자 배정', in_progress: '처리 중',
  pending_customer: '고객 확인 필요', on_hold: '보류', completed: '완료', cancelled: '취소',
};
const CATEGORY_KO = {
  tech_support: '기술지원', contract: '계약 문의', license: '라이선스 문의',
  education: '교육 문의', other: '기타',
};
const PRIORITY_KO = { normal: '일반', high: '빠른 확인 필요', critical: '긴급' };

// 알림 대상 데이터가 테스트용([테스트] 접두)인지 — 제목 또는 고객사명으로 판정.
function isTestTicket(t) {
  const re = /^\[테스트\]/;
  return !!t && (re.test(t.title || '') || re.test(t.company_name || ''));
}

async function sendSlack(webhookUrl, recipientName, ticketId, eventType, header, body, results, isTest = false) {
  // 테스트 알림([테스트] 데이터, 또는 예전 SLACK_REDIRECT 모드)이면 실 채널이 아닌 테스트 채널로.
  // 운영 알림은 항상 실 채널로 간다. 원래 어느 채널로 갈 알림이었는지는 본문에 남긴다.
  const toTest = isTest || SLACK_REDIRECT;
  const target = toTest ? SLACK_WEBHOOK_TEST : webhookUrl;
  const origin = toTest ? ' _(원래 대상: '+recipientName+')_' : '';
  if (!target) {
    // 테스트 알림인데 테스트 웹훅이 없으면 실 채널로 새지 않도록 skip.
    results.push({ channel: 'slack', eventType, recipient: recipientName, ticketId, status: 'failure', isTest: toTest,
      errorMessage: toTest ? 'test webhook not set (skipped)' : `webhook not set (${recipientName})` });
    return;
  }
  const tag = toTest ? '[테스트]' : (TEST_TAG || '');
  // 실제 보낼 메시지 텍스트(mrkdwn). 알림 로그 상세에서 "보낸 슬랙 메시지"로 보여주려고
  // 동일 값을 results.content로 반환한다(caller가 log_notification.content에 저장).
  const msgText = `${tag ? tag + ' ' : ''}${header}${origin}\n${body}`;
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: [
          { type: 'divider' },
          { type: 'section', text: { type: 'mrkdwn', text: msgText } },
        ],
      }),
    });
    if (!res.ok) {
      const msg = await res.text();
      results.push({ channel: 'slack', eventType, recipient: recipientName, ticketId, status: 'failure', isTest: toTest, errorMessage: `HTTP ${res.status}: ${msg}`, content: msgText });
    } else {
      results.push({ channel: 'slack', eventType, recipient: recipientName, ticketId, status: 'success', isTest: toTest, content: msgText });
    }
  } catch (e) {
    results.push({ channel: 'slack', eventType, recipient: recipientName, ticketId, status: 'failure', isTest: toTest, errorMessage: e?.message ?? String(e), content: msgText });
  }
}

function buildBaseMessage(ticket, names) {
  // 초 단위는 노이즈라 분까지만 표기 (예: 2026. 9. 1. 16:11)
  const createdAt = new Date(ticket.created_at).toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  // 등록자 — 누가 접수했는지 별도 항목으로 구분: 대리 등록이면 등록 직원, 아니면 고객 본인.
  const registrar = ticket.registered_by
    ? `${ticket.registered_by_name ?? '-'} (빅스데이터 직원)`
    : `${names.requesterName ?? '-'} (고객 본인)`;
  return (
    `• *요청번호:* ${ticket.ticket_number}\n` +
    `• *제목:* ${ticket.title}\n` +
    `• *고객사:* ${names.companyName ?? '-'}\n` +
    `• *요청자:* ${names.requesterName ?? '-'}\n` +
    `• *등록자:* ${registrar}\n` +
    `• *카테고리:* ${CATEGORY_KO[ticket.category] ?? ticket.category}\n` +
    `• *긴급도:* ${PRIORITY_KO[ticket.priority] ?? ticket.priority}\n` +
    `• *담당자:* ${names.assigneeName ?? '미배정'}\n` +
    `• *등록일시:* ${createdAt}`
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
      results, isTestTicket(ticket)
    );
  }));
}

// 라이선스 만료/갱신 7일 전 알림 — 공통 채널에만 보낸다.
// 건수가 많을 수 있어 티켓 배치처럼 건별로 쪼개지 않고 한 종류를 한 메시지에 모아 보낸다.
//
// 만료 건과 갱신 건은 kind로 나뉘어 각각 따로 호출된다. 두 날짜는 서로 다른 날일 수
// 있어서, 이번에 걸린 날짜를 앞세우고 나머지 날짜는 참고로 뒤에 적는다 — 그러지 않으면
// 한참 뒤인 다른 날짜까지 임박한 것처럼 읽힌다.
const licenseDay = (v) => (v ? String(v).slice(0, 10) : null);
const LICENSE_KIND = {
  end:     { header: '⏰ *라이선스 만료 7일 전*',      primary: '만료일', secondary: '갱신일' },
  renewal: { header: '🔁 *라이선스 갱신 기한 7일 전*', primary: '갱신일', secondary: '만료일' },
};

async function handleLicenseExpiry(payload, results) {
  const licenses = payload.licenses || [];
  if (!licenses.length) return;
  // only_test 호출이거나 목록에 [테스트] 회사가 섞였으면 테스트 채널로만 보낸다
  // (운영 배치는 api-layer에서 [테스트]를 이미 제외하지만, 이중 안전망).
  const isTest = payload.isTest === true || licenses.some(l => /^\[테스트\]/.test(l.company_name || ''));
  const target = payload.targetDate;
  const kind = LICENSE_KIND[payload.kind] || LICENSE_KIND.end;
  const isEnd = (payload.kind || 'end') === 'end';

  const lines = licenses.map((l) => {
    const hitDay  = licenseDay(isEnd ? l.end_date : l.renewal_date);
    const restDay = licenseDay(isEnd ? l.renewal_date : l.end_date);

    // 담당영업(계약의 bixs_contact)이 있으면 채널에서 바로 호명할 수 있게 첫 줄에 붙인다.
    const head = [`*${l.company_name}*`, l.bixs_contact ? `담당영업 *${l.bixs_contact}*` : null]
      .filter(Boolean).join(' · ');

    // 계약 미지정 라이선스는 계약 줄 자체를 생략한다.
    // 계약기간은 "계약은 남았는데 라이선스만 먼저 끝나는 건"을 구분하는 근거라 같이 적는다.
    let contractLine = '';
    if (l.contract_name) {
      const period = l.contract_start && l.contract_end ? `${l.contract_start} ~ ${l.contract_end}`
                   : l.contract_start ? `${l.contract_start} ~`
                   : l.contract_end   ? `~ ${l.contract_end}` : null;
      const meta = [l.contract_status, period].filter(Boolean).join(', ');
      contractLine = `\n   계약 *${l.contract_name}*${meta ? ` (${meta})` : ''}`;
    }

    const qty = l.quantities ? ` (${l.quantities})` : '';
    const restLine = restDay ? `\n   _(참고 — ${kind.secondary} ${restDay})_` : '';
    return `• ${head}${contractLine}\n   ${l.product_info}${qty}\n   *${kind.primary} ${hitDay}* 까지 7일${restLine}`;
  });

  await sendSlack(
    SLACK_WEBHOOK_COMMON, '#고객지원포탈-공통', null,
    isEnd ? 'license_expiry' : 'license_renewal',
    `${kind.header} — ${target} 기준 ${licenses.length}건`,
    lines.join('\n'),
    results, isTest
  );
}

// 영업이 대리 등록한 건 — 카테고리와 무관하게 영업 채널 대상.
// registrarRole은 DB를 못 보는 이 Lambda 대신 api-layer가 조회해 payload로 넘겨준다.
function registeredBySales(payload) { return payload?.registrarRole === 'sales'; }

// 영업 채널 대상 여부 — 계약·라이선스 카테고리이거나, 영업이 대리 등록한 건.
// 두 조건을 한 곳에서 판정해 카테고리와 등록자가 겹칠 때 중복 발송되지 않게 한다.
function needsSalesChannel(ticket, payload) {
  return ['contract', 'license'].includes(ticket.category) || registeredBySales(payload);
}

async function handleTicketInsert(payload, results) {
  const { ticket, attachmentFileNames = [] } = payload;
  const isUrgent = ticket.priority === 'critical';
  const attLine = attachmentFileNames.length > 0
    ? `\n• *첨부파일 (${attachmentFileNames.length}개):* ${attachmentFileNames.join(', ')}`
    : '';

  const categoryLabel = CATEGORY_KO[ticket.category] ?? ticket.category;
  const urgentPrefix = isUrgent ? '[긴급] ' : '';

  // 등록 주체 구분 — 헤더에서 한눈에: 내부 검토(🔒·고객 비공개) / 대리 등록(👤) / 고객 직접(🙋).
  // 등록자 상세는 buildBaseMessage의 "등록자" 항목에 나온다(예전 "…가 대신 접수" 줄 대체).
  const isProxy = !!ticket.registered_by;
  const isInternal = !!ticket.is_internal;
  const emoji = isUrgent ? '🚨' : isInternal ? '🔒' : '🟦';
  const originTag = isInternal ? ' · *내부 검토* (고객 비공개)'
                  : isProxy ? ' · 👤 *대리 등록*'
                  : ' · 🙋 *고객 직접*';

  const msgHeader = `${emoji} *${urgentPrefix}${categoryLabel} 등록*${originTag}`;
  const msgBody = buildBaseMessage(ticket, payload) + attLine + `\n• *상세보기:* ${detailLink(ticket.ticket_number)}`;
  const evtType = isUrgent ? 'urgent' : 'new_ticket';
  const isTest = isTestTicket(ticket);

  await sendSlack(SLACK_WEBHOOK_COMMON, '#고객지원포탈-공통', ticket.id, evtType, msgHeader, msgBody, results, isTest);

  if (needsSalesChannel(ticket, payload) && SLACK_WEBHOOK_SALES) {
    await sendSlack(SLACK_WEBHOOK_SALES, '#영업-슬랙채널', ticket.id, evtType, msgHeader, msgBody, results, isTest);
  }
  if (ticket.category === 'tech_support' && SLACK_WEBHOOK_TECH) {
    await sendSlack(SLACK_WEBHOOK_TECH, '#기술지원-슬랙채널', ticket.id, evtType, msgHeader, msgBody, results, isTest);
  }
  if (ticket.category === 'education' && SLACK_WEBHOOK_EDU) {
    await sendSlack(SLACK_WEBHOOK_EDU, '#교육-슬랙채널', ticket.id, evtType, msgHeader, msgBody, results, isTest);
  }
}

async function handleTicketAssigned(payload, results) {
  const { ticket, prevAssigneeName } = payload;
  const header = `👤 *담당자 배정* (${prevAssigneeName ?? '미배정'} → ${payload.assigneeName ?? '미배정'})${ticket.is_internal ? ' · 🔒 *내부 검토*' : ''}`;
  const body = buildBaseMessage(ticket, payload) + `\n• *상세보기:* ${detailLink(ticket.ticket_number)}`;
  const isTest = isTestTicket(ticket);
  await sendSlack(SLACK_WEBHOOK_COMMON, '#고객지원포탈-공통', ticket.id, 'assigned', header, body, results, isTest);
  // 배정 알림은 원래 카테고리 팬아웃이 교육뿐이었다 — 기존 동작은 그대로 두고,
  // 영업이 대리 등록한 건만 영업 채널을 추가한다(계약·라이선스 카테고리 규칙은 미적용).
  if (registeredBySales(payload) && SLACK_WEBHOOK_SALES) {
    await sendSlack(SLACK_WEBHOOK_SALES, '#영업-슬랙채널', ticket.id, 'assigned', header, body, results, isTest);
  }
  if (ticket.category === 'education' && SLACK_WEBHOOK_EDU) {
    await sendSlack(SLACK_WEBHOOK_EDU, '#교육-슬랙채널', ticket.id, 'assigned', header, body, results, isTest);
  }
}

async function handleTicketStatus(payload, results) {
  const { ticket, prevStatus } = payload;
  const from = STATUS_KO[prevStatus] ?? prevStatus;
  const to = STATUS_KO[ticket.status] ?? ticket.status;
  // 완료·고객확인은 기존 라벨 유지, 그 외 상태변경(분류중·처리중·보류·취소 등)은 status_change로 기록.
  const emoji = ticket.status === 'completed' ? '✅' : ticket.status === 'pending_customer' ? '👀' : '🔄';
  const evtType = ticket.status === 'completed' ? 'completed'
                : ticket.status === 'pending_customer' ? 'pending_customer'
                : 'status_change';
  const header = `${emoji} *상태 변경* (${from} → ${to})${ticket.is_internal ? ' · 🔒 *내부 검토*' : ''}`;
  const body = buildBaseMessage(ticket, payload) + `\n• *상세보기:* ${detailLink(ticket.ticket_number)}`;
  const isTest = isTestTicket(ticket);
  await sendSlack(SLACK_WEBHOOK_COMMON, '#고객지원포탈-공통', ticket.id, evtType, header, body, results, isTest);
  // 카테고리 채널 추가 발송 — 신규 등록과 동일한 팬아웃(기술지원→기술, 계약/라이선스→영업, 교육→교육).
  // 영업이 대리 등록한 건은 카테고리와 무관하게 영업 채널에도 보낸다(needsSalesChannel).
  if (needsSalesChannel(ticket, payload) && SLACK_WEBHOOK_SALES) {
    await sendSlack(SLACK_WEBHOOK_SALES, '#영업-슬랙채널', ticket.id, evtType, header, body, results, isTest);
  }
  if (ticket.category === 'tech_support' && SLACK_WEBHOOK_TECH) {
    await sendSlack(SLACK_WEBHOOK_TECH, '#기술지원-슬랙채널', ticket.id, evtType, header, body, results, isTest);
  }
  if (ticket.category === 'education' && SLACK_WEBHOOK_EDU) {
    await sendSlack(SLACK_WEBHOOK_EDU, '#교육-슬랙채널', ticket.id, evtType, header, body, results, isTest);
  }
}

const REPLY_ROLE_KO = {
  customer: '고객', internal: '내부직원', admin: '관리자',
  sales: '영업', tech_support: '기술지원', education: '교육',
};

async function handleTicketReply(payload, results) {
  const { ticket, replyAuthorName, replyAuthorRole } = payload;
  // 고객 답글은 기존 헤더 유지, 직원(스태프·내부) 답글은 구분해 표시(2026-09-02 확대).
  const isCustomerReply = !replyAuthorRole || replyAuthorRole === 'customer';
  const header = isCustomerReply ? `💬 *고객 답글 등록*` : `💬 *직원 답글 등록*`;
  const authorLine = replyAuthorName
    ? `\n• *작성자:* ${replyAuthorName}${REPLY_ROLE_KO[replyAuthorRole] ? ` (${REPLY_ROLE_KO[replyAuthorRole]})` : ''}`
    : '';
  const body = buildBaseMessage(ticket, payload) + authorLine + `\n• *상세보기:* ${detailLink(ticket.ticket_number)}`;
  const isTest = isTestTicket(ticket);
  await sendSlack(SLACK_WEBHOOK_COMMON, '#고객지원포탈-공통', ticket.id, 'reply', header, body, results, isTest);
  if (needsSalesChannel(ticket, payload) && SLACK_WEBHOOK_SALES) {
    await sendSlack(SLACK_WEBHOOK_SALES, '#영업-슬랙채널', ticket.id, 'reply', header, body, results, isTest);
  }
  if (ticket.category === 'tech_support' && SLACK_WEBHOOK_TECH) {
    await sendSlack(SLACK_WEBHOOK_TECH, '#기술지원-슬랙채널', ticket.id, 'reply', header, body, results, isTest);
  }
  if (ticket.category === 'education' && SLACK_WEBHOOK_EDU) {
    await sendSlack(SLACK_WEBHOOK_EDU, '#교육-슬랙채널', ticket.id, 'reply', header, body, results, isTest);
  }
}

async function handleTicketOverdue(payload, results) {
  const { ticket, overdueDays } = payload;
  const dueDateStr = new Date(ticket.due_date).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
  await sendSlack(
    SLACK_WEBHOOK_COMMON, '#고객지원포탈-공통', ticket.id, 'overdue',
    overdueDays != null ? `⏰ *완료예정일 초과 (+${overdueDays}일)*` : `⏰ *완료예정일 초과*`,
    buildBaseMessage(ticket, payload) + `\n• *완료예정일:* ${dueDateStr}` + `\n• *상세보기:* ${detailLink(ticket.ticket_number)}`,
    results, isTestTicket(ticket)
  );
}

// API Gateway(공개 라우트)로 들어온 요청인지 구분 — api-layer의 내부 직접 invoke는
// requestContext가 없는 순수 payload 객체 그대로 넘어온다. 공개 라우트로 온 요청은
// "연동 관리" 화면의 연결테스트(CONNECTION_TEST)만, 그것도 스태프 role만 허용한다 —
// 그 외 타입(TICKET_INSERT 등)은 임의의 로그인 사용자가 실제 Slack 채널에 임의 내용을
// 발송할 수 있는 취약점이었다.
const STAFF_ROLES = new Set(['admin', 'sales', 'tech_support', 'education']);
function isPublicGatewayRequest(event) { return !!event?.requestContext; }
function getRequesterRole(event) { return event?.requestContext?.authorizer?.lambda?.role || null; }

export const handler = async (event) => {
  const payload = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || event);
  const results = [];

  if (isPublicGatewayRequest(event)) {
    const role = getRequesterRole(event);
    if (payload.type !== 'CONNECTION_TEST' || !STAFF_ROLES.has(role)) {
      return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '이 기능은 내부 시스템에서만 호출할 수 있습니다' }) };
    }
  }

  switch (payload.type) {
    case 'CONNECTION_TEST': await handleConnectionTest(results); break;
    case 'OVERDUE_BATCH':    await handleOverdueBatch(payload, results); break;
    case 'LICENSE_EXPIRY':   await handleLicenseExpiry(payload, results); break;
    case 'TICKET_INSERT':    await handleTicketInsert(payload, results); break;
    case 'TICKET_ASSIGNED':  await handleTicketAssigned(payload, results); break;
    case 'TICKET_STATUS':    await handleTicketStatus(payload, results); break;
    case 'TICKET_OVERDUE':   await handleTicketOverdue(payload, results); break;
    case 'TICKET_REPLY':     await handleTicketReply(payload, results); break;
    default: break;
  }

  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, results }) };
};
