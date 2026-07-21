import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GMAIL_CLIENT_ID      = Deno.env.get("GMAIL_CLIENT_ID")      ?? "";
const GMAIL_CLIENT_SECRET  = Deno.env.get("GMAIL_CLIENT_SECRET")  ?? "";
const GMAIL_REFRESH_TOKEN  = Deno.env.get("GMAIL_REFRESH_TOKEN")  ?? "";
const GMAIL_FROM           = Deno.env.get("GMAIL_FROM")           ?? "";
const PORTAL_URL           = Deno.env.get("PORTAL_URL")           ?? "";
const INTERNAL_GROUP_EMAIL = Deno.env.get("INTERNAL_GROUP_EMAIL") ?? ""; // 신규 요청 그룹메일

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")              ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
);

// ── 매핑 ──────────────────────────────────────────────────
const CATEGORY_KO: Record<string, string> = {
  tech_support: "기술지원",
  contract:     "계약 문의",
  license:      "라이선스 문의",
  education:    "교육 문의",
  other:        "기타 문의",
};

const PRIORITY_KO: Record<string, string> = {
  normal:   "일반",
  high:     "빠른 확인 필요",
  critical: "긴급",
};

const STATUS_KO: Record<string, string> = {
  received:         "접수",
  classifying:      "분류 중",
  assigned:         "담당자 배정",
  in_progress:      "처리 중",
  pending_customer: "고객 확인 필요",
  on_hold:          "보류",
  completed:        "완료",
  cancelled:        "취소",
};

// ── DB 조회 헬퍼 ──────────────────────────────────────────
async function getAdminEmails(): Promise<string[]> {
  const { data } = await supabase
    .from("users").select("email")
    .eq("role", "admin").eq("is_active", true);
  return (data ?? []).map((u: any) => u.email).filter(Boolean);
}

async function getSalesEmails(): Promise<string[]> {
  const { data } = await supabase
    .from("users").select("email")
    .eq("role", "sales").eq("is_active", true);
  return (data ?? []).map((u: any) => u.email).filter(Boolean);
}

async function getAssignedEmail(assignedTo: string | null): Promise<string | null> {
  if (!assignedTo) return null;
  const { data } = await supabase
    .from("users").select("email").eq("id", assignedTo).single();
  return (data as any)?.email ?? null;
}

// ── 인코딩 유틸 ───────────────────────────────────────────
function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function rfc2047(text: string): string {
  return `=?UTF-8?B?${utf8ToBase64(text)}?=`;
}

function toBase64Url(str: string): string {
  return utf8ToBase64(str)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ── Gmail Access Token 발급 ───────────────────────────────
async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type:    "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Access token 발급 실패: " + JSON.stringify(data));
  return data.access_token;
}

// ── Gmail API 단건 발송 ───────────────────────────────────
async function sendMail(to: string, subject: string, html: string): Promise<void> {
  const accessToken = await getAccessToken();
  const message = [
    `From: ${rfc2047("빅스데이터 고객지원")} <${GMAIL_FROM}>`,
    `To: ${to}`,
    `Subject: ${rfc2047(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    utf8ToBase64(html),
  ].join("\r\n");

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ raw: toBase64Url(message) }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail API 오류 ${res.status}: ${err}`);
  }
}

async function sendToMany(emails: string[], subject: string, html: string): Promise<void> {
  const unique = [...new Set(emails.filter(Boolean))];
  await Promise.all(unique.map(email => sendMail(email, subject, html)));
}

// ── 알림 로그 기록 ────────────────────────────────────────
async function logNotification(
  ticketId: string,
  notificationType: string,
  recipient: string,
  subject: string,
  status: "sent" | "failed",
  errorMessage?: string
): Promise<void> {
  try {
    await supabase.from("notification_logs").insert({
      ticket_id:         ticketId,
      channel:           "email",
      notification_type: notificationType,
      recipient:         recipient,
      content:           subject,
      status:            status,
      error_message:     errorMessage ?? null,
      sent_at:           status === "sent" ? new Date().toISOString() : null,
    });
  } catch (e) {
    console.error("[send-email] 로그 기록 실패:", e);
  }
}

async function sendAndLog(
  to: string,
  subject: string,
  html: string,
  ticketId: string,
  notificationType: string
): Promise<void> {
  try {
    await sendMail(to, subject, html);
    await logNotification(ticketId, notificationType, to, subject, "sent");
  } catch (err) {
    await logNotification(ticketId, notificationType, to, subject, "failed", String(err));
    throw err;
  }
}

async function sendToManyAndLog(
  emails: string[],
  subject: string,
  html: string,
  ticketId: string,
  notificationType: string
): Promise<void> {
  const unique = [...new Set(emails.filter(Boolean))];
  await Promise.all(unique.map(email => sendAndLog(email, subject, html, ticketId, notificationType)));
}

// ── HTML 레이아웃 ─────────────────────────────────────────
function layout(subtitle: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f4f6f8;font-family:'Malgun Gothic',sans-serif;font-size:14px;color:#1a1a2e;}
  .wrap{max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);}
  .hd{background:#2d3a8c;padding:24px 32px;}
  .hd-title{color:#fff;font-size:18px;font-weight:700;margin:0;}
  .hd-sub{color:#a8b4e8;font-size:12px;margin-top:4px;}
  .bd{padding:28px 32px;}
  .lbl{font-size:13px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;}
  table.info{width:100%;border-collapse:collapse;}
  table.info td{padding:9px 12px;font-size:13px;border-bottom:1px solid #f0f0f0;}
  table.info td:first-child{color:#6b7280;width:130px;white-space:nowrap;}
  table.info td:last-child{color:#1a1a2e;font-weight:500;}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;}
  .b-blue{background:#e0e7ff;color:#3730a3;}
  .b-green{background:#d1fae5;color:#065f46;}
  .b-amber{background:#fef3c7;color:#92400e;}
  .b-red{background:#fee2e2;color:#991b1b;}
  .b-gray{background:#f3f4f6;color:#374151;}
  .btn{display:inline-block;margin-top:20px;padding:11px 24px;background:#2d3a8c;color:#fff!important;border-radius:6px;text-decoration:none;font-size:13px;font-weight:700;}
  .alert-box{margin:0 0 20px;padding:14px 16px;border-radius:8px;font-size:13px;line-height:1.6;}
  .alert-amber{background:#fffbeb;border-left:4px solid #f59e0b;color:#92400e;}
  .alert-green{background:#f0fdf4;border-left:4px solid #22c55e;color:#166534;}
  .alert-red{background:#fff1f2;border-left:4px solid #ef4444;color:#991b1b;}
  .ft{background:#f9fafb;padding:16px 32px;font-size:11px;color:#9ca3af;text-align:center;border-top:1px solid #f0f0f0;}
</style>
</head>
<body>
<div class="wrap">
  <div class="hd">
    <div class="hd-title">빅스데이터 고객지원 포탈</div>
    <div class="hd-sub">${subtitle}</div>
  </div>
  <div class="bd">${body}</div>
  <div class="ft">본 메일은 발신 전용입니다. 문의는 고객지원 포탈을 이용해주세요.<br>© 빅스데이터 주식회사</div>
</div>
</body>
</html>`;
}

// ── [고객] 요청 접수 ──────────────────────────────────────
function customerNewTicketHtml(ticket: any, companyName: string, requesterName: string): string {
  const detailUrl = PORTAL_URL ? PORTAL_URL + "?ticket=" + ticket.ticket_number : "";
  const btnHtml   = detailUrl ? '<a class="btn" href="' + detailUrl + '">요청 상세 보기</a>' : "";
  const dateStr   = ticket.created_at
    ? new Date(ticket.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "—";

  const body = `
<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">
  안녕하세요, <strong>${requesterName}</strong>님.<br>
  고객지원 요청이 정상적으로 접수되었습니다. 담당자 검토 후 빠르게 처리해드리겠습니다.
</p>
<div class="lbl">요청 정보</div>
<table class="info">
  <tr><td>요청번호</td><td><strong>${ticket.ticket_number ?? "—"}</strong></td></tr>
  <tr><td>제목</td><td>${ticket.title ?? "—"}</td></tr>
  <tr><td>고객사</td><td>${companyName}</td></tr>
  <tr><td>카테고리</td><td>${CATEGORY_KO[ticket.category] ?? ticket.category ?? "—"}</td></tr>
  <tr><td>긴급도</td><td>${PRIORITY_KO[ticket.priority] ?? ticket.priority ?? "—"}</td></tr>
  <tr><td>등록일시</td><td>${dateStr}</td></tr>
</table>
${btnHtml}`;
  return layout("요청 접수 확인", body);
}

// ── [고객] 상태 변경 ──────────────────────────────────────
function customerStatusChangeHtml(
  ticket: any, companyName: string, requesterName: string, prevStatus: string
): string {
  const detailUrl = PORTAL_URL ? PORTAL_URL + "?ticket=" + ticket.ticket_number : "";
  const btnHtml   = detailUrl ? '<a class="btn" href="' + detailUrl + '">요청 상세 보기</a>' : "";
  const prevKo    = STATUS_KO[prevStatus] ?? prevStatus ?? "—";
  const newKo     = STATUS_KO[ticket.status] ?? ticket.status ?? "—";
  const dateStr   = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

  const isPendingCustomer = ticket.status === "pending_customer";
  const isCompleted       = ticket.status === "completed";

  const badgeCls =
    isCompleted                ? "b-green" :
    isPendingCustomer          ? "b-amber" :
    ticket.status === "on_hold"? "b-amber" :
    ticket.status === "received"? "b-blue" : "b-gray";

  const alertHtml = isPendingCustomer
    ? `<div class="alert-box alert-amber">
        담당자가 추가 확인을 요청했습니다. 포탈에 접속하여 내용을 확인하고 회신해 주세요.
       </div>`
    : isCompleted
    ? `<div class="alert-box alert-green">
        요청이 완료 처리되었습니다. 처리 내용에 궁금한 사항이 있으시면 포탈을 통해 문의해 주세요.
       </div>`
    : "";

  const body = `
${alertHtml}
<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">
  안녕하세요, <strong>${requesterName}</strong>님.<br>
  요청 처리 상태가 변경되었습니다.
</p>
<div class="lbl">변경 정보</div>
<table class="info">
  <tr><td>요청번호</td><td><strong>${ticket.ticket_number ?? "—"}</strong></td></tr>
  <tr><td>제목</td><td>${ticket.title ?? "—"}</td></tr>
  <tr><td>고객사</td><td>${companyName}</td></tr>
  <tr><td>이전 상태</td><td>${prevKo}</td></tr>
  <tr><td>변경 상태</td><td><span class="badge ${badgeCls}">${newKo}</span></td></tr>
  <tr><td>변경 일시</td><td>${dateStr}</td></tr>
</table>
${btnHtml}`;

  const subtitle = isCompleted        ? "처리 완료 안내"
                 : isPendingCustomer  ? "고객 확인 요청"
                 : "처리 상태 변경 알림";
  return layout(subtitle, body);
}

// ── [내부] 신규 요청 ──────────────────────────────────────
function internalNewTicketHtml(ticket: any, companyName: string, requesterName: string, requesterEmail: string): string {
  const detailUrl = PORTAL_URL ? PORTAL_URL + "?ticket=" + ticket.ticket_number : "";
  const btnHtml   = detailUrl ? '<a class="btn" href="' + detailUrl + '">티켓 처리하기</a>' : "";
  const dateStr   = ticket.created_at
    ? new Date(ticket.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "—";

  const priorityBadge = ticket.priority === "critical"
    ? '<span class="badge b-red">긴급</span>'
    : ticket.priority === "high"
    ? '<span class="badge b-amber">빠른 확인 필요</span>'
    : '<span class="badge b-gray">일반</span>';

  const body = `
<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">
  신규 고객지원 요청이 등록되었습니다. 담당자 배정 및 처리 부탁드립니다.
</p>
<div class="lbl">요청 정보</div>
<table class="info">
  <tr><td>요청번호</td><td><strong>${ticket.ticket_number ?? "—"}</strong></td></tr>
  <tr><td>제목</td><td>${ticket.title ?? "—"}</td></tr>
  <tr><td>고객사</td><td>${companyName}</td></tr>
  <tr><td>요청자</td><td>${requesterName} (${requesterEmail})</td></tr>
  <tr><td>카테고리</td><td>${CATEGORY_KO[ticket.category] ?? ticket.category ?? "—"}</td></tr>
  <tr><td>긴급도</td><td>${priorityBadge}</td></tr>
  <tr><td>등록일시</td><td>${dateStr}</td></tr>
</table>
${btnHtml}`;
  return layout("신규 요청 접수", body);
}

// ── [내부] 긴급 요청 알림 ─────────────────────────────────
function internalUrgentHtml(ticket: any, companyName: string, requesterName: string): string {
  const detailUrl = PORTAL_URL ? PORTAL_URL + "?ticket=" + ticket.ticket_number : "";
  const btnHtml   = detailUrl ? '<a class="btn" href="' + detailUrl + '">즉시 확인하기</a>' : "";
  const dateStr   = ticket.created_at
    ? new Date(ticket.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "—";

  const body = `
<div class="alert-box alert-red">
  <strong>긴급 요청이 접수되었습니다.</strong> 즉각적인 대응이 필요합니다.
</div>
<div class="lbl">요청 정보</div>
<table class="info">
  <tr><td>요청번호</td><td><strong>${ticket.ticket_number ?? "—"}</strong></td></tr>
  <tr><td>제목</td><td>${ticket.title ?? "—"}</td></tr>
  <tr><td>고객사</td><td>${companyName}</td></tr>
  <tr><td>요청자</td><td>${requesterName}</td></tr>
  <tr><td>카테고리</td><td>${CATEGORY_KO[ticket.category] ?? ticket.category ?? "—"}</td></tr>
  <tr><td>긴급도</td><td><span class="badge b-red">긴급</span></td></tr>
  <tr><td>등록일시</td><td>${dateStr}</td></tr>
</table>
${btnHtml}`;
  return layout("긴급 요청 알림", body);
}

// ── [내부] 지연 요청 알림 ─────────────────────────────────
function internalOverdueHtml(ticket: any, companyName: string, requesterName: string): string {
  const detailUrl  = PORTAL_URL ? PORTAL_URL + "?ticket=" + ticket.ticket_number : "";
  const btnHtml    = detailUrl ? '<a class="btn" href="' + detailUrl + '">티켓 확인하기</a>' : "";
  const dueDateStr = ticket.due_date
    ? new Date(ticket.due_date).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }) : "—";

  const body = `
<div class="alert-box alert-amber">
  <strong>처리 기한이 초과된 요청입니다.</strong> 즉시 처리 현황을 확인해 주세요.
</div>
<div class="lbl">요청 정보</div>
<table class="info">
  <tr><td>요청번호</td><td><strong>${ticket.ticket_number ?? "—"}</strong></td></tr>
  <tr><td>제목</td><td>${ticket.title ?? "—"}</td></tr>
  <tr><td>고객사</td><td>${companyName}</td></tr>
  <tr><td>요청자</td><td>${requesterName}</td></tr>
  <tr><td>현재 상태</td><td>${STATUS_KO[ticket.status] ?? ticket.status ?? "—"}</td></tr>
  <tr><td>처리 기한</td><td><strong style="color:#dc2626;">${dueDateStr}</strong></td></tr>
</table>
${btnHtml}`;
  return layout("지연 요청 알림", body);
}

// ── [내부] 계약/라이선스 문의 알림 ───────────────────────
function internalSalesHtml(ticket: any, companyName: string, requesterName: string, requesterEmail: string): string {
  const detailUrl = PORTAL_URL ? PORTAL_URL + "?ticket=" + ticket.ticket_number : "";
  const btnHtml   = detailUrl ? '<a class="btn" href="' + detailUrl + '">문의 확인하기</a>' : "";
  const dateStr   = ticket.created_at
    ? new Date(ticket.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "—";

  const body = `
<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">
  담당 고객사로부터 ${CATEGORY_KO[ticket.category] ?? "문의"}가 접수되었습니다. 확인 후 연락 바랍니다.
</p>
<div class="lbl">문의 정보</div>
<table class="info">
  <tr><td>요청번호</td><td><strong>${ticket.ticket_number ?? "—"}</strong></td></tr>
  <tr><td>제목</td><td>${ticket.title ?? "—"}</td></tr>
  <tr><td>고객사</td><td>${companyName}</td></tr>
  <tr><td>요청자</td><td>${requesterName} (${requesterEmail})</td></tr>
  <tr><td>카테고리</td><td>${CATEGORY_KO[ticket.category] ?? ticket.category ?? "—"}</td></tr>
  <tr><td>등록일시</td><td>${dateStr}</td></tr>
</table>
${btnHtml}`;
  return layout("계약/라이선스 문의 접수", body);
}

// ── 메인 핸들러 ───────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin":  "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    const { type, record, old_record, requester_email: emailOverride, requester_name: nameOverride } = await req.json();
    if (!record) return new Response("no record", { status: 400 });

    const isInsert       = type === "INSERT";
    const isStatusChange = type === "UPDATE" && old_record?.status !== record.status;

    if (!isInsert && !isStatusChange) {
      return new Response(JSON.stringify({ skipped: true }), { status: 200 });
    }

    let requesterEmail: string;
    let requesterName: string;

    if (emailOverride) {
      // 프론트엔드 직접 호출: 내 정보에 저장된 이메일 사용
      requesterEmail = emailOverride;
      requesterName  = nameOverride || "고객";
    } else {
      // 웹훅 호출: DB에서 조회
      const { data: requester } = await supabase
        .from("users").select("name, email").eq("id", record.created_by).single();

      if (!requester?.email) {
        console.warn("[send-email] 요청자 이메일 없음. ticket_id:", record.id);
        return new Response(JSON.stringify({ skipped: "no email" }), { status: 200 });
      }
      requesterEmail = requester.email;
      requesterName  = requester.name ?? "고객";
    }

    // 고객사 조회
    const { data: company } = record.company_id
      ? await supabase.from("companies").select("name").eq("id", record.company_id).single()
      : { data: null };

    const companyName = (company as any)?.name ?? "—";

    const jobs: Promise<void>[] = [];

    // ──────────────────────────────────────────────────────
    // [고객 알림] 요청 접수 / 상태 변경 / 고객 확인 필요 / 완료
    // ──────────────────────────────────────────────────────
    if (isInsert) {
      const subject = "[빅스데이터 고객지원] 요청 접수 확인 - " + record.ticket_number;
      const html    = customerNewTicketHtml(record, companyName, requesterName);
      jobs.push(sendAndLog(requesterEmail, subject, html, record.id, "new_ticket"));
    }

    if (isStatusChange) {
      const isCompleted       = record.status === "completed";
      const isPendingCustomer = record.status === "pending_customer";
      const notifyType  = isCompleted ? "completed" : isPendingCustomer ? "pending_customer" : "status_changed";
      const subjectLabel = isCompleted       ? "처리 완료 안내"
                         : isPendingCustomer ? "고객 확인 요청"
                         : "처리 상태 변경";
      const subject = "[빅스데이터 고객지원] " + subjectLabel + " - " + record.ticket_number;
      const html    = customerStatusChangeHtml(record, companyName, requesterName, old_record.status);
      jobs.push(sendAndLog(requesterEmail, subject, html, record.id, notifyType));
    }

    // ──────────────────────────────────────────────────────
    // [내부 알림]
    // ──────────────────────────────────────────────────────

    // 1. 신규 요청 → 그룹메일
    if (isInsert && INTERNAL_GROUP_EMAIL) {
      const subject = "[내부] 신규 요청 접수 - " + record.ticket_number + " (" + companyName + ")";
      const html    = internalNewTicketHtml(record, companyName, requesterName, requesterEmail);
      jobs.push(sendAndLog(INTERNAL_GROUP_EMAIL, subject, html, record.id, "internal_new"));
    }

    // 2. 계약/라이선스 문의 → 영업 담당자
    if (isInsert && (record.category === "contract" || record.category === "license")) {
      const salesEmails = await getSalesEmails();
      if (salesEmails.length > 0) {
        const subject = "[내부-영업] " + CATEGORY_KO[record.category] + " 접수 - " + record.ticket_number + " (" + companyName + ")";
        const html    = internalSalesHtml(record, companyName, requesterName, requesterEmail);
        jobs.push(sendToManyAndLog(salesEmails, subject, html, record.id, "internal_sales"));
      }
    }

    // 3. 긴급 요청 (priority=critical) → 담당자 + 관리자 + 요청자
    if (record.priority === "critical" && isInsert) {
      const adminEmails    = await getAdminEmails();
      const assignedEmail  = await getAssignedEmail(record.assigned_to);
      const recipients     = [...adminEmails, assignedEmail, requesterEmail].filter(Boolean) as string[];
      if (recipients.length > 0) {
        const subject = "[긴급] 긴급 요청 접수 - " + record.ticket_number + " (" + companyName + ")";
        const html    = internalUrgentHtml(record, companyName, requesterName);
        jobs.push(sendToManyAndLog(recipients, subject, html, record.id, "urgent"));
      }
    }

    // 4. 지연 요청 (due_date 초과 + 미완료) → 담당자 + 관리자 + 요청자
    const isOverdue =
      record.due_date &&
      new Date(record.due_date) < new Date() &&
      !["completed", "cancelled"].includes(record.status);

    if (isStatusChange && isOverdue) {
      const adminEmails   = await getAdminEmails();
      const assignedEmail = await getAssignedEmail(record.assigned_to);
      const recipients    = [...adminEmails, assignedEmail, requesterEmail].filter(Boolean) as string[];
      if (recipients.length > 0) {
        const subject = "[지연] 처리 기한 초과 요청 - " + record.ticket_number + " (" + companyName + ")";
        const html    = internalOverdueHtml(record, companyName, requesterName);
        jobs.push(sendToManyAndLog(recipients, subject, html, record.id, "overdue"));
      }
    }

    // 모든 메일 병렬 발송
    const results = await Promise.allSettled(jobs);
    const errors  = results.filter(r => r.status === "rejected").map(r => (r as any).reason?.message);
    if (errors.length > 0) console.error("[send-email] 일부 발송 실패:", errors);

    const sent = results.filter(r => r.status === "fulfilled").length;
    console.log("[send-email] 완료. 성공:", sent, "/ 전체:", results.length);

    return new Response(JSON.stringify({ ok: true, sent, errors }), {
      headers: { "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[send-email 오류]", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
