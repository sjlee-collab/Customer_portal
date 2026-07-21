import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GMAIL_CLIENT_ID     = Deno.env.get("GMAIL_CLIENT_ID")     ?? "";
const GMAIL_CLIENT_SECRET = Deno.env.get("GMAIL_CLIENT_SECRET") ?? "";
const GMAIL_REFRESH_TOKEN = Deno.env.get("GMAIL_REFRESH_TOKEN") ?? "";
const GMAIL_FROM          = Deno.env.get("GMAIL_FROM")          ?? "";
const PORTAL_URL          = Deno.env.get("PORTAL_URL")          ?? "";
const INTERNAL_NEW_TICKET_EMAIL = Deno.env.get("INTERNAL_NEW_TICKET_EMAIL") ?? "";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")              ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
);

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

function toBase64(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}
function toBase64Url(str: string): string {
  return toBase64(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN, grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`토큰 발급 실패: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function sendMail(to: string, subject: string, html: string): Promise<void> {
  const accessToken    = await getAccessToken();
  const encodedSubject = `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`;
  const encodedFrom    = `=?UTF-8?B?${btoa(unescape(encodeURIComponent("빅스데이터 고객지원")))}?=`;
  const raw = toBase64Url([
    `From: "${encodedFrom}" <${GMAIL_FROM}>`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    toBase64(html),
  ].join("\r\n"));
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail 전송 실패: ${await res.text()}`);
}

async function getAdminEmails(): Promise<string[]> {
  const { data } = await supabase.from("users").select("email").eq("role", "admin").eq("is_active", true);
  return (data ?? []).map((u: any) => u.email).filter(Boolean);
}

async function getAccountManagerEmail(companyId: string | null): Promise<string | null> {
  if (!companyId) return null;
  const { data: company } = await supabase.from("companies").select("account_manager").eq("id", companyId).single();
  const managerName = (company as any)?.account_manager;
  if (!managerName) return null;
  const { data: user } = await supabase.from("users").select("email").eq("name", managerName).eq("is_active", true).single();
  return (user as any)?.email ?? null;
}

async function logNotification(ticketId: string, eventType: string, recipient: string, subject: string, status: "sent" | "failed", errorMessage?: string) {
  try {
    await supabase.from("log_notification").insert({
      ticket_id: ticketId, channel: "email", event_type: eventType,
      recipient, status, error_message: errorMessage ?? null,
    });
  } catch (e) { console.error("[기록 실패]", e); }
}
async function sendAndLog(to: string, subject: string, html: string, ticketId: string, eventType: string) {
  try {
    await sendMail(to, subject, html);
    await logNotification(ticketId, eventType, to, subject, "sent");
  } catch (err) {
    await logNotification(ticketId, eventType, to, subject, "failed", String(err));
    throw err;
  }
}
async function sendToManyAndLog(emails: string[], subject: string, html: string, ticketId: string, eventType: string) {
  const unique = [...new Set(emails.filter(Boolean))];
  await Promise.all(unique.map(e => sendAndLog(e, subject, html, ticketId, eventType)));
}

function layout(subtitle: string, body: string): string {
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

function customerStatusChangeHtml(ticket: any, companyName: string, requesterName: string, prevStatus: string): string {
  const btn = PORTAL_URL ? `<a class="btn" href="${PORTAL_URL}?ticket=${ticket.ticket_number}">요청 상세 보기</a>` : "";
  const prevKo = STATUS_KO[prevStatus]??prevStatus??"—";
  const newKo  = STATUS_KO[ticket.status]??ticket.status??"—";
  const dateStr = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const isCompleted = ticket.status === "completed";
  const isPending   = ticket.status === "pending_customer";
  const badgeCls  = isCompleted ? "b-green" : isPending ? "b-amber" : "b-gray";
  const alertHtml = isCompleted ? `<div class="alert-box alert-green">요청이 완료 처리되었습니다.</div>`
    : isPending ? `<div class="alert-box alert-amber">담당자가 추가 확인을 요청했습니다.</div>` : "";
  const subtitle = isCompleted ? "처리 완료 안내" : isPending ? "고객 확인 요청" : "처리 상태 변경 알림";
  return layout(subtitle, `${alertHtml}<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">안녕하세요, <strong>${requesterName}</strong>님.<br>요청 처리 상태가 변경되었습니다.</p><div class="lbl">변경 정보</div><table class="info"><tr><td>요청번호</td><td><strong>${ticket.ticket_number??"—"}</strong></td></tr><tr><td>제목</td><td>${ticket.title??"—"}</td></tr><tr><td>고객사</td><td>${companyName}</td></tr><tr><td>이전 상태</td><td>${prevKo}</td></tr><tr><td>변경 상태</td><td><span class="badge ${badgeCls}">${newKo}</span></td></tr><tr><td>변경 일시</td><td>${dateStr}</td></tr></table>${btn}`);
}

function internalNewTicketHtml(ticket: any, companyName: string, requesterName: string, requesterEmail: string): string {
  const btn = PORTAL_URL ? `<a class="btn" href="${PORTAL_URL}?ticket=${ticket.ticket_number}">요청 확인하기</a>` : "";
  const dateStr = ticket.created_at ? new Date(ticket.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "—";
  return layout("신규 요청 접수 알림", `<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">신규 고객지원 요청이 접수되었습니다.</p><div class="lbl">요청 정보</div><table class="info"><tr><td>요청번호</td><td><strong>${ticket.ticket_number??"—"}</strong></td></tr><tr><td>제목</td><td>${ticket.title??"—"}</td></tr><tr><td>고객사</td><td>${companyName}</td></tr><tr><td>요청자</td><td>${requesterName} (${requesterEmail})</td></tr><tr><td>카테고리</td><td>${CATEGORY_KO[ticket.category]??ticket.category??"—"}</td></tr><tr><td>긴급도</td><td>${PRIORITY_KO[ticket.priority]??ticket.priority??"—"}</td></tr><tr><td>등록일시</td><td>${dateStr}</td></tr></table>${btn}`);
}

function internalSalesHtml(ticket: any, companyName: string, requesterName: string, requesterEmail: string): string {
  const btn = PORTAL_URL ? `<a class="btn" href="${PORTAL_URL}?ticket=${ticket.ticket_number}">문의 확인하기</a>` : "";
  const dateStr = ticket.created_at ? new Date(ticket.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "—";
  return layout("계약/라이선스 문의 접수", `<p style="margin:0 0 20px;font-size:14px;line-height:1.7;color:#374151;">담당 고객사로부터 ${CATEGORY_KO[ticket.category]??"문의"}가 접수되었습니다.</p><div class="lbl">문의 정보</div><table class="info"><tr><td>요청번호</td><td><strong>${ticket.ticket_number??"—"}</strong></td></tr><tr><td>제목</td><td>${ticket.title??"—"}</td></tr><tr><td>고객사</td><td>${companyName}</td></tr><tr><td>요청자</td><td>${requesterName} (${requesterEmail})</td></tr><tr><td>카테고리</td><td>${CATEGORY_KO[ticket.category]??ticket.category??"—"}</td></tr><tr><td>등록일시</td><td>${dateStr}</td></tr></table>${btn}`);
}

function internalUrgentHtml(ticket: any, companyName: string, requesterName: string): string {
  const btn = PORTAL_URL ? `<a class="btn" href="${PORTAL_URL}?ticket=${ticket.ticket_number}">즉시 확인하기</a>` : "";
  const dateStr = ticket.created_at ? new Date(ticket.created_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "—";
  return layout("긴급 요청 알림", `<div class="alert-box alert-red"><strong>긴급 요청이 접수되었습니다.</strong> 즉각적인 대응이 필요합니다.</div><div class="lbl">요청 정보</div><table class="info"><tr><td>요청번호</td><td><strong>${ticket.ticket_number??"—"}</strong></td></tr><tr><td>제목</td><td>${ticket.title??"—"}</td></tr><tr><td>고객사</td><td>${companyName}</td></tr><tr><td>요청자</td><td>${requesterName}</td></tr><tr><td>카테고리</td><td>${CATEGORY_KO[ticket.category]??ticket.category??"—"}</td></tr><tr><td>긴급도</td><td><span class="badge b-red">긴급</span></td></tr><tr><td>등록일시</td><td>${dateStr}</td></tr></table>${btn}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const body = await req.json();

    if (body.type === "CONNECTION_TEST") {
      if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN)
        return new Response(JSON.stringify({ ok: false, error: "Gmail OAuth 환경변수 미설정" }), { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      try {
        await getAccessToken();
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      } catch (e: any) {
        return new Response(JSON.stringify({ ok: false, error: e?.message ?? String(e) }), { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }
    }

    const { type, record, old_record, requester_email: emailOverride, requester_name: nameOverride } = body;
    if (!record) return new Response("no record", { status: 400, headers: CORS_HEADERS });

    const isInsert       = type === "INSERT";
    const isStatusChange = type === "UPDATE" && old_record?.status !== record.status;
    if (!isInsert && !isStatusChange)
      return new Response(JSON.stringify({ skipped: true }), { status: 200, headers: CORS_HEADERS });

    let requesterEmail: string, requesterName: string;
    if (emailOverride) {
      requesterEmail = emailOverride; requesterName = nameOverride || "고객";
    } else {
      const { data: requester } = await supabase.from("users").select("name, email").eq("id", record.created_by).single();
      if (!requester?.email) return new Response(JSON.stringify({ skipped: "no email" }), { status: 200, headers: CORS_HEADERS });
      requesterEmail = requester.email; requesterName = requester.name ?? "고객";
    }

    const { data: company } = record.company_id
      ? await supabase.from("companies").select("name").eq("id", record.company_id).single()
      : { data: null };
    const companyName = (company as any)?.name ?? "—";
    const jobs: Promise<void>[] = [];

    // ── 고객 메일: 상태 변경 ──
    if (isStatusChange) {
      const statusLabel = STATUS_KO[record.status] ?? record.status;
      jobs.push(sendAndLog(requesterEmail,
        `[빅스데이터 고객지원] 상태 변경: ${statusLabel} - ` + record.ticket_number,
        customerStatusChangeHtml(record, companyName, requesterName, old_record.status),
        record.id, "status_change"));
    }

    // ── 내부 메일: 신규 요청 → INTERNAL_NEW_TICKET_EMAIL ──
    if (isInsert && INTERNAL_NEW_TICKET_EMAIL) {
      const recipients = INTERNAL_NEW_TICKET_EMAIL.split(",").map(e => e.trim()).filter(Boolean);
      if (recipients.length > 0) jobs.push(sendToManyAndLog(recipients,
        "[내부] 신규 요청 접수 - " + record.ticket_number,
        internalNewTicketHtml(record, companyName, requesterName, requesterEmail),
        record.id, "internal_new"));
    }

    // ── 내부 메일: 계약/라이선스 문의 → 고객사 담당영업 ──
    if (isInsert && ["contract", "license"].includes(record.category)) {
      const managerEmail = await getAccountManagerEmail(record.company_id);
      if (managerEmail) jobs.push(sendAndLog(managerEmail,
        "[내부-영업] " + (CATEGORY_KO[record.category]) + " 접수 - " + record.ticket_number,
        internalSalesHtml(record, companyName, requesterName, requesterEmail),
        record.id, "internal_sales"));
    }

    // ── 내부 메일: 긴급 요청 → 고객사 담당영업 + 관리자 ──
    if (isInsert && record.priority === "critical") {
      const [managerEmail, adminEmails] = await Promise.all([
        getAccountManagerEmail(record.company_id),
        getAdminEmails()
      ]);
      const recipients = [...new Set([managerEmail, ...adminEmails].filter(Boolean) as string[])];
      if (recipients.length > 0) jobs.push(sendToManyAndLog(recipients,
        "[긴급] 긴급 요청 접수 - " + record.ticket_number,
        internalUrgentHtml(record, companyName, requesterName),
        record.id, "urgent"));
    }

    const results = await Promise.allSettled(jobs);
    const errors  = results.filter(r => r.status === "rejected").map(r => (r as any).reason?.message);
    const sent    = results.filter(r => r.status === "fulfilled").length;
    return new Response(JSON.stringify({ ok: true, sent, errors }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[send-email 오류]", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: CORS_HEADERS });
  }
});
