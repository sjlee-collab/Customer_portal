// send-email Lambda (DB 접속 없음 — VPC 밖에서 실행, NAT 불필요)
//
// Microsoft Graph API로 메일만 발송한다. 수신자 이메일/회사명/담당영업 이메일/
// 관리자 이메일 목록 등은 전부 호출자(Phase 4 API 레이어)가 미리 조회해서
// payload에 채워 넘겨줘야 한다.
//
// 입력 payload 형태:
// {
//   type: 'INSERT' | 'STATUS_CHANGE' | 'CONNECTION_TEST',
//   ticket: { id, ticket_number, title, category, priority, status, created_at },
//   companyName, requesterEmail, requesterName,
//   prevStatus,                 // STATUS_CHANGE 용
//   ccEmails: string[],         // STATUS_CHANGE 용 (선택)
//   accountManagerEmail,        // isInsert && contract/license 일 때 (없으면 생략)
//   adminEmails: string[],      // isInsert && priority==='critical' 일 때
// }
//
// 출력: { ok: true, results: [{ channel:'email', eventType, recipient, subject, ticketId, status, errorMessage }] }
// results는 caller가 log_notification 테이블에 직접 기록한다.

const MS_TENANT_ID     = process.env.MS_TENANT_ID || '';
const MS_CLIENT_ID     = process.env.MS_CLIENT_ID || '';
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || '';
const MS_FROM          = process.env.MS_FROM || 'hr@bigxdata.io';
const PORTAL_URL       = process.env.PORTAL_URL || '';
// 통합테스트용: 설정돼있으면 실제 수신자 대신 이 주소로만 발송 (원래 수신자는 제목에 표시).
// 테스트 끝나면 이 환경변수를 지워서 꺼야 한다.
const TEST_EMAIL_OVERRIDE = process.env.TEST_EMAIL_OVERRIDE || '';

const CATEGORY_KO = {
  tech_support: '기술지원', contract: '계약 문의', license: '라이선스 문의',
  education: '교육 문의', other: '기타 문의',
};
const PRIORITY_KO = { normal: '일반', high: '빠른 확인 필요', critical: '긴급' };
const STATUS_KO = {
  received: '접수', classifying: '분류 중', assigned: '담당자 배정', in_progress: '처리 중',
  pending_customer: '고객 확인 필요', on_hold: '보류', completed: '완료', cancelled: '취소',
};

async function getAccessToken() {
  const res = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`MS 토큰 발급 실패: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function sendMail(to, subject, html) {
  const accessToken = await getAccessToken();
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${MS_FROM}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        from: { emailAddress: { name: '빅스데이터 고객지원', address: MS_FROM } },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: false,
    }),
  });
  if (!res.ok) throw new Error(`Graph API 전송 실패: ${await res.text()}`);
}

async function sendAndLog(to, subject, html, ticketId, eventType, results) {
  const actualTo = TEST_EMAIL_OVERRIDE || to;
  const actualSubject = TEST_EMAIL_OVERRIDE ? `[TEST→${to}] ${subject}` : subject;
  try {
    await sendMail(actualTo, actualSubject, html);
    results.push({ channel: 'email', eventType, recipient: to, subject, ticketId, status: 'sent' });
  } catch (err) {
    results.push({ channel: 'email', eventType, recipient: to, subject, ticketId, status: 'failed', errorMessage: String(err) });
  }
}

async function sendToManyAndLog(emails, subject, html, ticketId, eventType, results) {
  const unique = [...new Set((emails || []).filter(Boolean))];
  await Promise.all(unique.map(e => sendAndLog(e, subject, html, ticketId, eventType, results)));
}

function layout(subtitle, body) {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><style>
  body{margin:0;padding:0;background:#f4f6f8;font-family:'Malgun Gothic',sans-serif;font-size:14px;color:#1a1a2e;}
  .wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);}
  .hd{background:#2d3a8c;padding:24px 32px;} .hd-title{color:#fff;font-size:18px;font-weight:700;margin:0;} .hd-sub{color:#a8b4e8;font-size:12px;margin-top:4px;}
  .bd{padding:28px 32px;} .lbl{font-size:13px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;}
  table.info{width:100%;border-collapse:collapse;} table.info td{padding:9px 12px;font-size:13px;border-bottom:1px solid #f0f0f0;}
  table.info td:first-child{color:#6b7280;width:130px;white-space:nowrap;} table.info td:last-child{color:#1a1a2e;font-weight:500;}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;}
  .b-green{background:#d1fae5;color:#065f46;} .b-amber{background:#fef3c7;color:#92400e;} .b-red{background:#fee2e2;color:#991b1b;} .b-gray{background:#f3f4f6;color:#374151;}
  .btn{display:inline-block;margin-top:20px;padding:11px 24px;background:#2d3a8c;color:#fff!important;border-radius:6px;text-decoration:none;font-size:13px;font-weight:700;}
  .alert-box{margin:0 0 20px;padding:14px 16px;border-radius:8px;font-size:13px;line-height:1.6;}
  .alert-amber{background:#fffbeb;border-left:4px solid #f59e0b;color:#92400e;} .alert-green{background:#f0fdf4;border-left:4px solid #22c55e;color:#166534;} .alert-red{background:#fff1f2;border-left:4px solid #ef4444;color:#991b1b;}
  .ft{background:#f9fafb;padding:16px 32px;font-size:11px;color:#9ca3af;text-align:center;border-top:1px solid #f0f0f0;}
</style></head><body><div class="wrap"><div class="hd"><div class="hd-title">빅스데이터 고객지원 포탈</div><div class="hd-sub">${subtitle}</div></div><div class="bd">${body}</div><div class="ft">본 메일은 발신 전용입니다. 문의는 고객지원 포탈을 이용해주세요.<br>© 빅스데이터 주식회사</div></div></body></html>`;
}

function customerStatusChangeHtml(ticket, companyName, requesterName, prevStatus) {
  const btn = PORTAL_URL ? `<a class="btn" href="${PORTAL_URL}?ticket=${ticket.ticket_number}">요청 상세 보기</a>` : '';
  const prevKo = STATUS_KO[prevStatus] ?? prevStatus ?? '—';
  const newKo = STATUS_KO[ticket.status] ?? ticket.status ?? '—';
  const dateStr = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const isCompleted = ticket.status === 'completed';
  const isPending = ticket.status === 'pending_customer';
  const badgeCls = isCompleted ? 'b-green' : isPending ? 'b-amber' : 'b-gray';
  const alertHtml = isCompleted
    ? `<div class="alert-box alert-green">요청이 완료 처리되었습니다.</div>`
    : isPending ? `<div class="alert-box alert-amber">담당자가 추가 확인을 요청했습니다.</div>` : '';
  const subtitle = isCompleted ? '처리 완료 안내' : isPending ? '고객 확인 요청' : '처리 상태 변경 알림';
  return layout(subtitle, `${alertHtml}<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">안녕하세요, <strong>${requesterName}</strong>님.<br>요청 처리 상태가 변경되었습니다.</p><div class="lbl">변경 정보</div><table class="info"><tr><td>요청번호</td><td><strong>${ticket.ticket_number ?? '—'}</strong></td></tr><tr><td>제목</td><td>${ticket.title ?? '—'}</td></tr><tr><td>고객사</td><td>${companyName}</td></tr><tr><td>이전 상태</td><td>${prevKo}</td></tr><tr><td>변경 상태</td><td><span class="badge ${badgeCls}">${newKo}</span></td></tr><tr><td>변경 일시</td><td>${dateStr}</td></tr></table>${btn}`);
}

function customerNewTicketHtml(ticket, companyName, requesterName) {
  const btn = PORTAL_URL ? `<a class="btn" href="${PORTAL_URL}?ticket=${ticket.ticket_number}">요청 확인하기</a>` : '';
  const dateStr = ticket.created_at ? new Date(ticket.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '—';
  return layout('요청 접수 확인', `<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">안녕하세요, <strong>${requesterName}</strong>님.<br>고객지원 요청이 정상적으로 접수되었습니다.<br>담당자 배정 후 순차적으로 처리해 드리겠습니다.</p><div class="lbl">접수 정보</div><table class="info"><tr><td>요청번호</td><td><strong>${ticket.ticket_number ?? '—'}</strong></td></tr><tr><td>제목</td><td>${ticket.title ?? '—'}</td></tr><tr><td>고객사</td><td>${companyName}</td></tr><tr><td>카테고리</td><td>${CATEGORY_KO[ticket.category] ?? ticket.category ?? '—'}</td></tr><tr><td>긴급도</td><td>${PRIORITY_KO[ticket.priority] ?? ticket.priority ?? '—'}</td></tr><tr><td>접수일시</td><td>${dateStr}</td></tr></table>${btn}`);
}

function internalSalesHtml(ticket, companyName, requesterName, requesterEmail) {
  const btn = PORTAL_URL ? `<a class="btn" href="${PORTAL_URL}?ticket=${ticket.ticket_number}">문의 확인하기</a>` : '';
  const dateStr = ticket.created_at ? new Date(ticket.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '—';
  return layout('계약/라이선스 문의 접수', `<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">담당 고객사로부터 ${CATEGORY_KO[ticket.category] ?? '문의'}가 접수되었습니다.</p><div class="lbl">문의 정보</div><table class="info"><tr><td>요청번호</td><td><strong>${ticket.ticket_number ?? '—'}</strong></td></tr><tr><td>제목</td><td>${ticket.title ?? '—'}</td></tr><tr><td>고객사</td><td>${companyName}</td></tr><tr><td>요청자</td><td>${requesterName} (${requesterEmail})</td></tr><tr><td>카테고리</td><td>${CATEGORY_KO[ticket.category] ?? ticket.category ?? '—'}</td></tr><tr><td>등록일시</td><td>${dateStr}</td></tr></table>${btn}`);
}

function internalUrgentHtml(ticket, companyName, requesterName) {
  const btn = PORTAL_URL ? `<a class="btn" href="${PORTAL_URL}?ticket=${ticket.ticket_number}">즉시 확인하기</a>` : '';
  const dateStr = ticket.created_at ? new Date(ticket.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '—';
  return layout('긴급 요청 알림', `<div class="alert-box alert-red"><strong>긴급 요청이 접수되었습니다.</strong> 즉각적인 대응이 필요합니다.</div><div class="lbl">요청 정보</div><table class="info"><tr><td>요청번호</td><td><strong>${ticket.ticket_number ?? '—'}</strong></td></tr><tr><td>제목</td><td>${ticket.title ?? '—'}</td></tr><tr><td>고객사</td><td>${companyName}</td></tr><tr><td>요청자</td><td>${requesterName}</td></tr><tr><td>카테고리</td><td>${CATEGORY_KO[ticket.category] ?? ticket.category ?? '—'}</td></tr><tr><td>긴급도</td><td><span class="badge b-red">긴급</span></td></tr><tr><td>등록일시</td><td>${dateStr}</td></tr></table>${btn}`);
}

export const handler = async (event) => {
  const results = [];
  try {
    const payload = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || event);

    if (payload.type === 'CONNECTION_TEST') {
      if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
        return ok({ ok: false, error: 'MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET 환경변수 미설정' });
      }
      try {
        await getAccessToken();
        return ok({ ok: true });
      } catch (e) {
        return ok({ ok: false, error: e?.message ?? String(e) });
      }
    }

    const {
      type, ticket, companyName, requesterEmail, requesterName,
      prevStatus, ccEmails, accountManagerEmail, adminEmails,
    } = payload;
    if (!ticket || !requesterEmail) return { statusCode: 400, body: 'missing ticket/requesterEmail' };

    const isInsert = type === 'INSERT';
    const isStatusChange = type === 'STATUS_CHANGE';
    const jobs = [];

    if (isStatusChange) {
      const statusLabel = STATUS_KO[ticket.status] ?? ticket.status;
      const ccList = Array.isArray(ccEmails) ? ccEmails.filter(e => typeof e === 'string' && e.includes('@')) : [];
      const recipients = [requesterEmail, ...ccList];
      jobs.push(sendToManyAndLog(
        recipients,
        `[빅스데이터 고객지원] 상태 변경: ${statusLabel} - ${ticket.ticket_number}`,
        customerStatusChangeHtml(ticket, companyName, requesterName, prevStatus),
        ticket.id, 'status_change', results
      ));
    }

    if (isInsert) {
      jobs.push(sendAndLog(
        requesterEmail,
        `[빅스데이터 고객지원] 요청 접수 확인 - ${ticket.ticket_number}`,
        customerNewTicketHtml(ticket, companyName, requesterName),
        ticket.id, 'new_ticket_customer', results
      ));
    }

    if (isInsert && ['contract', 'license'].includes(ticket.category) && accountManagerEmail) {
      jobs.push(sendAndLog(
        accountManagerEmail,
        `[내부-영업] ${CATEGORY_KO[ticket.category]} 접수 - ${ticket.ticket_number}`,
        internalSalesHtml(ticket, companyName, requesterName, requesterEmail),
        ticket.id, 'internal_sales', results
      ));
    }

    if (isInsert && ticket.priority === 'critical') {
      const recipients = [...new Set([accountManagerEmail, ...(adminEmails || [])].filter(Boolean))];
      if (recipients.length > 0) jobs.push(sendToManyAndLog(
        recipients,
        `[긴급] 긴급 요청 접수 - ${ticket.ticket_number}`,
        internalUrgentHtml(ticket, companyName, requesterName),
        ticket.id, 'urgent', results
      ));
    }

    await Promise.allSettled(jobs);
    const sent = results.filter(r => r.status === 'sent').length;
    return ok({ ok: true, sent, results });

  } catch (err) {
    console.error('[send-email 오류]', err);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(err) }) };
  }
};

function ok(body) {
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
