import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SLACK_WEBHOOK_COMMON = Deno.env.get('SLACK_WEEBHOOK_COMMON') ?? '';
const SLACK_WEBHOOK_SALES  = Deno.env.get('SLACK_WEBHOOK_SALES') ?? '';
const SLACK_WEBHOOK_TECH   = Deno.env.get('SLACK_WEBHOOK_TECH') ?? '';
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const PORTAL_URL           = Deno.env.get('PORTAL_URL') ?? 'https://support-one-blue.vercel.app';

const STATUS_KO: Record<string, string> = {
  received:         '접수',
  classifying:      '분류 중',
  in_progress:      '처리 중',
  pending_customer: '고객 확인 필요',
  on_hold:          '보류',
  completed:        '완료',
  cancelled:        '취소',
};
const CATEGORY_KO: Record<string, string> = {
  tech_support: '기술지원',
  contract:     '계약 문의',
  license:      '라이선스 문의',
  education:    '교육 문의',
  other:        '기타',
};
const PRIORITY_KO: Record<string, string> = {
  normal:   '일반',
  high:     '빠른 확인 필요',
  critical: '긴급',
};

async function writeLog(
  supabase: any,
  ticketId: string | null,
  channel: string,
  eventType: string,
  recipient: string,
  status: 'success' | 'failure',
  errorMessage?: string
) {
  await supabase.from('log_notification').insert({
    ticket_id:     ticketId,
    channel,
    event_type:    eventType,
    recipient,
    status,
    error_message: errorMessage ?? null,
  });
}

async function sendSlack(
  supabase: any,
  ticketId: string | null,
  eventType: string,
  header: string,
  body: string,
  webhookUrl: string = SLACK_WEBHOOK_COMMON,
  recipientName: string = '#고객지원포탈-공통'
) {
  if (!webhookUrl) {
    await writeLog(supabase, ticketId, 'slack', eventType, recipientName, 'failure', `webhook not set (${recipientName})`);
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
      await writeLog(supabase, ticketId, 'slack', eventType, recipientName, 'failure', `HTTP ${res.status}: ${msg}`);
    } else {
      await writeLog(supabase, ticketId, 'slack', eventType, recipientName, 'success');
    }
  } catch (e: any) {
    await writeLog(supabase, ticketId, 'slack', eventType, recipientName, 'failure', e?.message ?? String(e));
  }
}

async function getNames(supabase: any, ticket: any) {
  const [{ data: company }, { data: requester }, { data: assignee }] = await Promise.all([
    ticket.company_id
      ? supabase.from('companies').select('name').eq('id', ticket.company_id).single()
      : Promise.resolve({ data: null }),
    ticket.created_by
      ? supabase.from('users').select('name').eq('id', ticket.created_by).single()
      : Promise.resolve({ data: null }),
    ticket.assigned_to
      ? supabase.from('users').select('name').eq('id', ticket.assigned_to).single()
      : Promise.resolve({ data: null }),
  ]);
  return {
    companyName:   company?.name   ?? '-',
    requesterName: requester?.name ?? '-',
    assigneeName:  assignee?.name  ?? '미배정',
  };
}

function buildBaseMessage(ticket: any, names: any) {
  const createdAt = new Date(ticket.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  return (
    `• *요청번호:* ${ticket.ticket_number}\n` +
    `• *제목:* ${ticket.title}\n` +
    `• *고객사:* ${names.companyName}\n` +
    `• *요청자:* ${names.requesterName}\n` +
    `• *카테고리:* ${CATEGORY_KO[ticket.category] ?? ticket.category}\n` +
    `• *긴급도:* ${PRIORITY_KO[ticket.priority] ?? ticket.priority}\n` +
    `• *등록일시:* ${createdAt}\n` +
    `• *담당자:* ${names.assigneeName}`
  );
}

function detailLink(ticketNumber: string): string {
  return `<${PORTAL_URL}?ticket=${ticketNumber}|${ticketNumber}>`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  const payload = await req.json();
  const { table, type, record, old_record } = payload;

  if (type === 'CONNECTION_TEST') {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── 지연 요청 배치 알림 (pg_cron 호출) ──
  if (type === 'OVERDUE_BATCH') {
    const today = new Date().toISOString().slice(0, 10);
    const { data: overdueTickets } = await supabase
      .from('tickets')
      .select('*')
      .lt('due_date', today)
      .not('status', 'in', '("completed","cancelled")')
      .not('due_date', 'is', null);

    if (overdueTickets && overdueTickets.length > 0) {
      for (const ticket of overdueTickets) {
        const names = await getNames(supabase, ticket);
        const dueDateStr = new Date(ticket.due_date).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
        const overdueDays = Math.floor((new Date().getTime() - new Date(ticket.due_date).getTime()) / (24 * 60 * 60 * 1000));
        await sendSlack(
          supabase, ticket.id, 'overdue',
          `⏰ *완료예정일 초과 (+${overdueDays}일)*`,
          buildBaseMessage(ticket, names) +
          `\n• *완료예정일:* ${dueDateStr}` +
          `\n• *상세보기:* ${detailLink(ticket.ticket_number)}`
        );
      }
    }

    return new Response(JSON.stringify({ processed: overdueTickets?.length ?? 0 }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  // ── 신규 요청 등록 알림 ──
  if (table === 'tickets' && type === 'INSERT') {
    const names = await getNames(supabase, record);
    const isUrgent = record.priority === 'critical';
    const { data: attFiles } = await supabase
      .from('ticket_attachments')
      .select('file_name')
      .eq('ticket_id', record.id);
    const attLine = attFiles && attFiles.length > 0
      ? `\n• *첲부파일 (${attFiles.length}개):* ${attFiles.map((f: any) => f.file_name).join(', ')}`
      : '';

    const categoryLabel = CATEGORY_KO[record.category] ?? record.category;
    const urgentPrefix  = isUrgent ? '[긴급] ' : '';
    const emoji         = isUrgent ? '🚨' : '🟦';

    const msgHeader = `${emoji} *${urgentPrefix}${categoryLabel} 등록*`;
    const msgBody   = buildBaseMessage(record, names) + attLine + `\n• *상세보기:* ${detailLink(record.ticket_number)}`;
    const evtType   = isUrgent ? 'urgent' : 'new_ticket';

    // 공통 채널
    await sendSlack(supabase, record.id, evtType, msgHeader, msgBody);

    // 카테고리별 전용 채널 추가 발송
    if (['contract', 'license', 'education'].includes(record.category) && SLACK_WEBHOOK_SALES) {
      await sendSlack(supabase, record.id, evtType, msgHeader, msgBody, SLACK_WEBHOOK_SALES, '#영업-슬랙채널');
    }
    if (record.category === 'tech_support' && SLACK_WEBHOOK_TECH) {
      await sendSlack(supabase, record.id, evtType, msgHeader, msgBody, SLACK_WEBHOOK_TECH, '#기술지원-슬랙채널');
    }
  }

  // ── 상태 변경 알림 ──
  else if (table === 'tickets' && type === 'UPDATE') {

    // 1. 담당자 배정
    if (record.assigned_to !== old_record?.assigned_to && record.assigned_to) {
      const names = await getNames(supabase, record);
      const { data: prevAssignee } = old_record?.assigned_to
        ? await supabase.from('users').select('name').eq('id', old_record.assigned_to).single()
        : { data: null };
      const from = prevAssignee?.name ?? '미배정';
      await sendSlack(
        supabase, record.id, 'assigned',
        `👤 *담당자 배정* (${from} → ${names.assigneeName})`,
        buildBaseMessage(record, names) + `\n• *상세보기:* ${detailLink(record.ticket_number)}`
      );
    }

    // 2. 고객 확인 필요 / 완료 상태 변경
    if (
      record.status !== old_record?.status &&
      ['pending_customer', 'completed'].includes(record.status)
    ) {
      const names = await getNames(supabase, record);
      const from  = STATUS_KO[old_record?.status] ?? old_record?.status;
      const to    = STATUS_KO[record.status] ?? record.status;
      const emoji = record.status === 'completed' ? '✅' : '👀';
      await sendSlack(
        supabase, record.id,
        record.status === 'completed' ? 'completed' : 'pending_customer',
        `${emoji} *상태 변경* (${from} → ${to})`,
        buildBaseMessage(record, names) + `\n• *상세보기:* ${detailLink(record.ticket_number)}`
      );
    }

    // 3. 완료예정일 초과 (상태 변경 시 due_date 확인)
    if (
      record.status !== old_record?.status &&
      !['completed', 'cancelled'].includes(record.status) &&
      record.due_date &&
      new Date(record.due_date) < new Date()
    ) {
      const names = await getNames(supabase, record);
      const dueDateStr = new Date(record.due_date).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' });
      await sendSlack(
        supabase, record.id, 'overdue',
        `⏰ *완료예정일 초과*`,
        buildBaseMessage(record, names) +
        `\n• *완료예정일:* ${dueDateStr}` +
        `\n• *상세보기:* ${detailLink(record.ticket_number)}`
      );
    }
  }

  return new Response('ok', { status: 200, headers: CORS_HEADERS });
});
