import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { query } from './db.mjs';

const lambda = new LambdaClient({});
const NOTIFY_HANDLER_FN = process.env.NOTIFY_HANDLER_FN; // Lambda 함수 이름
const SEND_EMAIL_FN     = process.env.SEND_EMAIL_FN;

async function invokeFn(functionName, payload) {
  if (!functionName) return null;
  const res = await lambda.send(new InvokeCommand({
    FunctionName: functionName,
    InvocationType: 'RequestResponse',
    Payload: Buffer.from(JSON.stringify(payload)),
  }));
  const text = Buffer.from(res.Payload).toString('utf-8');
  try {
    const parsed = JSON.parse(text);
    return typeof parsed.body === 'string' ? JSON.parse(parsed.body) : parsed;
  } catch {
    return null;
  }
}

async function writeLogs(results) {
  for (const r of results || []) {
    try {
      await query(
        `insert into log_notification (ticket_id, channel, event_type, recipient, status, error_message, content)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [r.ticketId ?? null, r.channel, r.eventType, r.recipient, r.status, r.errorMessage ?? null, r.content ?? null]
      );
    } catch (e) {
      console.error('[log_notification 기록 실패]', e);
    }
  }
}

export async function notifySlack(payload) {
  const result = await invokeFn(NOTIFY_HANDLER_FN, payload);
  await writeLogs(result?.results);
  return result;
}

export async function notifyEmail(payload) {
  const result = await invokeFn(SEND_EMAIL_FN, payload);
  await writeLogs((result?.results || []).map(r => ({ ...r, channel: 'email' })));
  return result;
}
