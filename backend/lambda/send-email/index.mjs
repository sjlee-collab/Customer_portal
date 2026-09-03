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
// 테스트 모드 표기 — 하네스 email-safe.sh on 이면 '[테스트]'가 설정되어 제목에 접두된다(없으면 기존 [TEST]).
const TEST_TAG = process.env.TEST_TAG || '';
// 테스트 모드(email-safe on)면 이 실행의 모든 메일 로그를 테스트로 표시한다.
const EMAIL_IS_TEST = !!(TEST_EMAIL_OVERRIDE || TEST_TAG);

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

// 제목에 원래 수신자 이메일을 그대로 노출하면(예: "[TEST→a@b.com] ...") Microsoft 365
// 사칭/피싱 방지 필터에 걸려 Graph API는 202를 반환해도 실제로는 조용히 격리(quarantine)되는
// 문제가 있었다. 그래서 원래 수신자 정보는 제목이 아니라 본문 상단 배너로 표시한다.
function withTestBanner(html, originalTo) {
  if (!TEST_EMAIL_OVERRIDE) return html;
  const banner = `<div style="background:#111827;color:#fbbf24;font:12px/1.6 monospace;padding:8px 16px;text-align:center;">TEST MODE (원래 수신자: ${originalTo})</div>`;
  return html.replace('<body>', `<body>${banner}`);
}

async function sendAndLog(to, subject, html, ticketId, eventType, results) {
  const actualTo = TEST_EMAIL_OVERRIDE || to;
  const actualSubject = TEST_TAG ? `${TEST_TAG} ${subject}` : (TEST_EMAIL_OVERRIDE ? `[TEST] ${subject}` : subject);
  const actualHtml = withTestBanner(html, to);
  try {
    await sendMail(actualTo, actualSubject, actualHtml);
    // 알림 로그 상세에서 "실제 보낸 메일"을 그대로 보여주기 위해 생성한 본문 HTML을 함께 반환한다.
    // (log_notification.content 컬럼에 저장 — 기존 미사용 컬럼 재사용) 테스트 배너는 운영에선 없고
    // 있어도 저장 불필요하므로 순수 html을 넘긴다.
    results.push({ channel: 'email', eventType, recipient: to, subject, ticketId, status: 'sent', isTest: EMAIL_IS_TEST, content: html });
  } catch (err) {
    results.push({ channel: 'email', eventType, recipient: to, subject, ticketId, status: 'failed', isTest: EMAIL_IS_TEST, errorMessage: String(err), content: html });
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
  .hd{background:#534AB7;padding:22px 32px;} .hd-title{color:#fff;font-size:18px;font-weight:700;margin:0;} .hd-sub{color:#CFCBF3;font-size:12px;margin-top:4px;}
  /* 로고 마크 — 이미지가 아니라 사각형+글자라 이미지 차단과 무관하게 항상 그려진다.
     세로 가운데 정렬은 flex 대신 line-height로 한다(Outlook 데스크톱은 flex를 무시한다).
     Outlook에서는 border-radius도 무시돼 정사각형으로 보이는데, 그대로 둬도 무방하다. */
  .mark{width:36px;height:36px;border-radius:9px;background:#ffffff;color:#534AB7;font-size:20px;font-weight:800;line-height:36px;text-align:center;}
  .bd{padding:28px 32px;} .lbl{font-size:13px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;}
  table.info{width:100%;border-collapse:collapse;} table.info td{padding:9px 12px;font-size:13px;border-bottom:1px solid #f0f0f0;}
  table.info td:first-child{color:#6b7280;width:130px;white-space:nowrap;} table.info td:last-child{color:#1a1a2e;font-weight:500;}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;}
  .b-green{background:#d1fae5;color:#065f46;} .b-amber{background:#fef3c7;color:#92400e;} .b-red{background:#fee2e2;color:#991b1b;} .b-gray{background:#f3f4f6;color:#374151;}
  .btn{display:inline-block;margin-top:20px;padding:11px 24px;background:#534AB7;color:#fff!important;border-radius:6px;text-decoration:none;font-size:13px;font-weight:700;}
  .alert-box{margin:0 0 20px;padding:14px 16px;border-radius:8px;font-size:13px;line-height:1.6;}
  .alert-amber{background:#fffbeb;border-left:4px solid #f59e0b;color:#92400e;} .alert-green{background:#f0fdf4;border-left:4px solid #22c55e;color:#166534;} .alert-red{background:#fff1f2;border-left:4px solid #ef4444;color:#991b1b;}
  .ft{background:#f9fafb;padding:16px 32px;font-size:11px;color:#9ca3af;text-align:center;border-top:1px solid #f0f0f0;}
</style></head><body><div class="wrap"><div class="hd"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding-right:12px;vertical-align:middle;"><div class="mark" style="width:36px;height:36px;border-radius:9px;background:#ffffff;color:#534AB7;font-size:20px;font-weight:800;line-height:36px;text-align:center;">B</div></td><td style="vertical-align:middle;"><div class="hd-title" style="color:#fff;font-size:18px;font-weight:700;">빅스데이터 고객지원 포탈</div><div class="hd-sub" style="color:#CFCBF3;font-size:12px;margin-top:4px;">${subtitle}</div></td></tr></table></div><div class="bd">${body}</div><div class="ft">본 메일은 발신 전용입니다. 문의는 고객지원 포탈을 이용해주세요.<br>© 빅스데이터 주식회사</div></div></body></html>`;
}

function portalLinkBtn(ticketNumber, label) {
  if (!PORTAL_URL) return '';
  const url = `${PORTAL_URL}?ticket=${ticketNumber}`;
  const display = url.replace(/^https?:\/\//, '');
  return `<a class="btn" href="${url}">${label}</a><div style="font-size:11px;color:#9ca3af;margin-top:8px;">${display}</div>`;
}

// 완료 안내 메일 하단의 만족도 별점 블록. 메일 클라이언트는 폼 제출을 막으므로
// 별 5개는 각각 포탈로 이동하는 링크이고, 누른 별점(&rate=N)이 미리 선택된 채 열린다.
function surveyBlockHtml(ticketNumber) {
  if (!PORTAL_URL) return '';
  const star = (n) =>
    `<a href="${PORTAL_URL}?ticket=${ticketNumber}&rate=${n}" style="display:inline-block;font-size:30px;line-height:1;color:#F59E0B;text-decoration:none;padding:0 3px;">&#9733;</a>`;
  // survey=1: 프론트가 상세 대신 홈에서 평가 팝업(별점 미선택)을 연다
  const url = `${PORTAL_URL}?ticket=${ticketNumber}&survey=1`;
  return `<div style="margin-top:22px;border-top:1px solid #E5E7EB;padding-top:18px;text-align:center;">
    <div style="font-size:14px;font-weight:700;color:#111827;">이번 지원은 어떠셨나요?</div>
    <div style="font-size:12px;color:#6B7280;margin-top:3px;">별점을 누르면 포탈에서 평가가 이어집니다</div>
    <div style="margin:12px 0 4px;">${[1,2,3,4,5].map(star).join('')}</div>
    <div style="font-size:11px;color:#9CA3AF;">매우 불만족 &#8592; &#8594; 매우 만족</div>
    <a class="btn" href="${url}" style="display:inline-block;margin-top:16px;padding:11px 24px;background:#534AB7;color:#fff;border-radius:6px;text-decoration:none;font-size:13px;font-weight:700;">별점 남기기</a>
  </div>`;
}

function customerStatusChangeHtml(ticket, companyName, requesterName, prevStatus) {
  const btn = portalLinkBtn(ticket.ticket_number, '요청 상세 보기');
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
  return layout(subtitle, `${alertHtml}<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">안녕하세요, <strong>${requesterName}</strong>님.<br>요청 처리 상태가 변경되었습니다.</p><div class="lbl">변경 정보</div><table class="info"><tr><td>요청번호</td><td><strong>${ticket.ticket_number ?? '—'}</strong></td></tr><tr><td>제목</td><td>${ticket.title ?? '—'}</td></tr><tr><td>고객사</td><td>${companyName}</td></tr><tr><td>이전 상태</td><td>${prevKo}</td></tr><tr><td>변경 상태</td><td><span class="badge ${badgeCls}">${newKo}</span></td></tr><tr><td>변경 일시</td><td>${dateStr}</td></tr></table>${isCompleted ? surveyBlockHtml(ticket.ticket_number) : btn}`);
}

function customerNewTicketHtml(ticket, companyName, requesterName, registeredByName) {
  const btn = portalLinkBtn(ticket.ticket_number, '요청 확인하기');
  const dateStr = ticket.created_at ? new Date(ticket.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '—';
  // 대리 등록(빅스데이터 담당자가 고객 대신 접수)이면 인사 문구를 바꾼다. 접수 정보 표는 동일.
  const intro = registeredByName
    ? `안녕하세요, <strong>${requesterName}</strong>님.<br>고객지원 요청이 등록되었습니다.<br>빅스데이터 담당자(${registeredByName})가 등록했습니다.`
    : `안녕하세요, <strong>${requesterName}</strong>님.<br>고객지원 요청이 정상적으로 접수되었습니다.<br>담당자 배정 후 순차적으로 처리해 드리겠습니다.`;
  return layout('요청 접수 확인', `<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">${intro}</p><div class="lbl">접수 정보</div><table class="info"><tr><td>요청번호</td><td><strong>${ticket.ticket_number ?? '—'}</strong></td></tr><tr><td>제목</td><td>${ticket.title ?? '—'}</td></tr><tr><td>고객사</td><td>${companyName}</td></tr><tr><td>카테고리</td><td>${CATEGORY_KO[ticket.category] ?? ticket.category ?? '—'}</td></tr><tr><td>긴급도</td><td>${PRIORITY_KO[ticket.priority] ?? ticket.priority ?? '—'}</td></tr><tr><td>접수일시</td><td>${dateStr}</td></tr></table>${btn}`);
}

function internalSalesHtml(ticket, companyName, requesterName, requesterEmail) {
  const btn = portalLinkBtn(ticket.ticket_number, '문의 확인하기');
  const dateStr = ticket.created_at ? new Date(ticket.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '—';
  return layout('계약/라이선스 문의 접수', `<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">담당 고객사로부터 ${CATEGORY_KO[ticket.category] ?? '문의'}가 접수되었습니다.</p><div class="lbl">문의 정보</div><table class="info"><tr><td>요청번호</td><td><strong>${ticket.ticket_number ?? '—'}</strong></td></tr><tr><td>제목</td><td>${ticket.title ?? '—'}</td></tr><tr><td>고객사</td><td>${companyName}</td></tr><tr><td>요청자</td><td>${requesterName} (${requesterEmail})</td></tr><tr><td>카테고리</td><td>${CATEGORY_KO[ticket.category] ?? ticket.category ?? '—'}</td></tr><tr><td>등록일시</td><td>${dateStr}</td></tr></table>${btn}`);
}

function internalUrgentHtml(ticket, companyName, requesterName) {
  const btn = portalLinkBtn(ticket.ticket_number, '즉시 확인하기');
  const dateStr = ticket.created_at ? new Date(ticket.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '—';
  return layout('긴급 요청 알림', `<div class="alert-box alert-red"><strong>긴급 요청이 접수되었습니다.</strong> 즉각적인 대응이 필요합니다.</div><div class="lbl">요청 정보</div><table class="info"><tr><td>요청번호</td><td><strong>${ticket.ticket_number ?? '—'}</strong></td></tr><tr><td>제목</td><td>${ticket.title ?? '—'}</td></tr><tr><td>고객사</td><td>${companyName}</td></tr><tr><td>요청자</td><td>${requesterName}</td></tr><tr><td>카테고리</td><td>${CATEGORY_KO[ticket.category] ?? ticket.category ?? '—'}</td></tr><tr><td>긴급도</td><td><span class="badge b-red">긴급</span></td></tr><tr><td>등록일시</td><td>${dateStr}</td></tr></table>${btn}`);
}

// 신규 계정 초대 — 관리자가 계정을 만들면 사용자가 직접 비밀번호를 정하도록 안내한다.
// 임시 비밀번호를 만들어 전달하지 않으므로 평문 비밀번호가 오가는 구간이 없다.
function accountInviteHtml(userName, setupUrl, validDays) {
  const display = setupUrl.replace(/^https?:\/\//, '');
  return layout('계정 생성 안내', `<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">안녕하세요, <strong>${userName}</strong>님.<br>빅스데이터 고객지원 포탈 계정이 생성되었습니다.<br>아래 버튼을 눌러 사용하실 비밀번호를 직접 설정해주세요.</p><a class="btn" href="${setupUrl}">비밀번호 설정하기</a><div style="font-size:11px;color:#9ca3af;margin-top:8px;">${display}</div><p style="margin:20px 0 0;font-size:12px;color:#9ca3af;">이 링크는 ${validDays}일간 유효합니다. 기간이 지나면 로그인 화면의 "비밀번호를 잊으셨나요?"로 다시 설정하실 수 있습니다.</p>`);
}

// 신규 계정 신청(로그인 화면 폼) — 관리자에게 신청 정보를 전달. 입력은 외부(비회원) 값이라 이스케이프.
function accountInquiryHtml(d) {
  const esc = s => String(s ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  const rows = [['성함', d.name], ['기업명', d.company], ['연락처', d.phone], ['이메일', d.email]];
  if (d.message) rows.push(['내용', d.message]);
  rows.push(['접수시각', now]);
  const table = rows.map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join('');
  return layout('신규 계정 신청', `<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">로그인 화면에서 신규 계정 신청이 접수되었습니다.<br>아래 정보를 확인한 뒤 계정을 생성해주세요.</p><div class="lbl">신청 정보</div><table class="info">${table}</table>`);
}

function passwordResetHtml(userName, resetUrl) {
  const display = resetUrl.replace(/^https?:\/\//, '');
  return layout('비밀번호 재설정', `<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">안녕하세요, <strong>${userName}</strong>님.<br>비밀번호 재설정을 요청하셨습니다. 아래 버튼을 눌러 새 비밀번호를 설정해주세요.</p><a class="btn" href="${resetUrl}">비밀번호 재설정하기</a><div style="font-size:11px;color:#9ca3af;margin-top:8px;">${display}</div><p style="margin:20px 0 0;font-size:12px;color:#9ca3af;">이 링크는 30분간 유효합니다. 본인이 요청하지 않았다면 이 메일을 무시해주세요.</p>`);
}

// API Gateway(공개 라우트)로 들어온 요청인지 구분 — api-layer의 내부 직접 invoke는
// requestContext가 없는 순수 payload 객체 그대로 넘어온다. 공개 라우트로 온 요청은
// "연동 관리" 화면의 연결테스트(CONNECTION_TEST)만, 그것도 스태프 role만 허용한다 —
// 그 외 타입(PASSWORD_RESET 등)은 임의의 로그인 사용자가 회사 명의로 임의 수신자에게
// 이메일을 보낼 수 있는 취약점이었다.
const STAFF_ROLES = new Set(['admin', 'sales', 'tech_support', 'education']);
function isPublicGatewayRequest(event) { return !!event?.requestContext; }
function getRequesterRole(event) { return event?.requestContext?.authorizer?.lambda?.role || null; }

export const handler = async (event) => {
  const results = [];
  try {
    const payload = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || event);

    if (isPublicGatewayRequest(event)) {
      const role = getRequesterRole(event);
      if (payload.type !== 'CONNECTION_TEST' || !STAFF_ROLES.has(role)) {
        return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: '이 기능은 내부 시스템에서만 호출할 수 있습니다' }) };
      }
    }

    if (payload.type === 'ACCOUNT_INVITE') {
      const { toEmail, userName, token, validDays } = payload;
      if (!toEmail || !token) return { statusCode: 400, body: 'missing toEmail/token' };
      const setupUrl = `${PORTAL_URL}?reset=${token}`;
      await sendAndLog(toEmail, '[빅스데이터 고객지원] 포탈 계정이 생성되었습니다 — 비밀번호를 설정해주세요',
        accountInviteHtml(userName || '고객', setupUrl, validDays || 7), null, 'account_invite', results);
      const sent = results.filter(r => r.status === 'sent').length;
      return ok({ ok: true, sent, results });
    }

    if (payload.type === 'PASSWORD_RESET') {
      const { toEmail, userName, token } = payload;
      if (!toEmail || !token) return { statusCode: 400, body: 'missing toEmail/token' };
      const resetUrl = `${PORTAL_URL}?reset=${token}`;
      await sendAndLog(toEmail, '[빅스데이터 고객지원] 비밀번호 재설정 안내', passwordResetHtml(userName || '고객', resetUrl), null, 'password_reset', results);
      const sent = results.filter(r => r.status === 'sent').length;
      return ok({ ok: true, sent, results });
    }

    if (payload.type === 'ACCOUNT_INQUIRY') {
      const { adminEmails, name, company, phone, email, message } = payload;
      const list = Array.isArray(adminEmails) ? adminEmails.filter(e => typeof e === 'string' && e.includes('@')) : [];
      if (!list.length) return ok({ ok: true, sent: 0, note: 'no admin recipients' });
      await sendToManyAndLog(list, '[빅스데이터 고객지원] 신규 계정 신청',
        accountInquiryHtml({ name, company, phone, email, message }), null, 'account_inquiry', results);
      const sent = results.filter(r => r.status === 'sent').length;
      return ok({ ok: true, sent, results });
    }

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
      prevStatus, ccEmails, accountManagerEmail, adminEmails, registeredByName,
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
        customerNewTicketHtml(ticket, companyName, requesterName, registeredByName),
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
