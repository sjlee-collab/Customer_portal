// storage-api Lambda — S3 업로드/다운로드/삭제 (VPC 밖, DB 접속 없음)
// 브라우저가 S3에 직접 자격증명 없이 접근할 수 없으므로, presigned URL 발급을 대신해준다.
// index.html의 sb.storage.from(bucket) 호출을 흉내낸 인터페이스.
//
// 라우트:
//   POST /storage/upload-url   { bucket, path, contentType } -> { uploadUrl, path }
//   POST /storage/signed-url   { bucket, path, expiresIn }   -> { signedUrl }
//   POST /storage/remove       { bucket, paths: [...] }      -> { removed: [...] }

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-northeast-2' });
const lambda = new LambdaClient({});
const DATA_API_FN = process.env.DATA_API_FN || 'customer_portal_data-api';

// Supabase 시절 버킷 이름 -> 실제 S3 버킷 이름
const BUCKET_MAP = {
  documents: process.env.BUCKET_DOCUMENTS,
  'ticket-attachments': process.env.BUCKET_TICKET_ATTACHMENTS,
  'contract-attachments': process.env.BUCKET_CONTRACT_ATTACHMENTS,
};

const ALLOWED_ORIGINS = ['https://support.bigxdata.io', 'https://dev.dlayoierdftk6.amplifyapp.com'];

function corsHeaders(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin;
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Vary': 'Origin',
  };
}

let currentEvent = null;

function json(statusCode, body) {
  return { statusCode, headers: { ...corsHeaders(currentEvent), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function resolveBucket(logicalName) {
  const bucket = BUCKET_MAP[logicalName];
  if (!bucket) throw new Error(`알 수 없는 버킷: ${logicalName}`);
  return bucket;
}

// 허용 확장자 — accept 속성은 우회 가능한 UI 힌트일 뿐이라 서버에서도 한 번 더 막아야
// 실제 통제가 됨. 각 버킷의 클라이언트 accept/실제 용도 기준으로 맞춤.
const ALLOWED_EXTENSIONS_BY_BUCKET = {
  documents: ['.pdf', '.docx', '.pptx', '.xlsx', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.mp4'],
  'ticket-attachments': ['.pdf', '.log', '.txt', '.zip', '.xlsx', '.docx', '.pptx', '.twbx', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'],
  'contract-attachments': ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.gif', '.zip'],
};
const MAX_UPLOAD_SIZE = 20 * 1024 * 1024; // 20MB — 클라이언트 accept/hint는 우회 가능하므로 서버에서도 확인

// 업로드 시점에는(다운로드/삭제와 달리) 아직 메타데이터 행이 없으므로 storage_path로
// 기존 행을 찾아 소유권을 확인하는 checkAccess()를 그대로 쓸 수 없다. 대신 경로의 첫
// 세그먼트(티켓ID)가 요청자가 실제로 접근 가능한 티켓인지 data-api에 위임해서 확인한다.
async function checkTicketOwnership(ticketId, event) {
  if (!ticketId) return false;
  const innerEvent = {
    requestContext: { http: { method: 'GET' }, authorizer: event.requestContext?.authorizer },
    rawPath: '/data/tickets',
    queryStringParameters: { id: `eq.${ticketId}`, select: 'id', limit: '1' },
  };
  try {
    const res = await lambda.send(new InvokeCommand({
      FunctionName: DATA_API_FN, InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(innerEvent)),
    }));
    const payload = JSON.parse(Buffer.from(res.Payload).toString('utf-8'));
    if (payload.statusCode !== 200) return false;
    const rows = JSON.parse(payload.body);
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    console.error('[storage-api 티켓 소유권확인 실패]', err);
    return false;
  }
}

// company_contracts/content_documents 쓰기 권한(company_manage/library_manage)은
// role_permissions 테이블이 기준이다(화면에서 커스터마이징 가능) — storage-api는 DB가
// 없으므로 data-api에 조회를 위임해서 같은 기준을 그대로 따른다.
async function checkFeaturePermission(role, featureKey, event) {
  if (role === 'admin') return true;
  if (!role) return false;
  const innerEvent = {
    requestContext: { http: { method: 'GET' }, authorizer: event.requestContext?.authorizer },
    rawPath: '/data/role_permissions',
    queryStringParameters: { role: `eq.${role}`, feature_key: `eq.${featureKey}`, select: 'enabled', limit: '1' },
  };
  try {
    const res = await lambda.send(new InvokeCommand({
      FunctionName: DATA_API_FN, InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(innerEvent)),
    }));
    const payload = JSON.parse(Buffer.from(res.Payload).toString('utf-8'));
    if (payload.statusCode !== 200) return false;
    const rows = JSON.parse(payload.body);
    return rows[0]?.enabled === true;
  } catch (err) {
    console.error('[storage-api 권한확인 실패]', err);
    return false;
  }
}

// 업로드 경로별 소유권/권한 검사 — signed-url/remove의 checkAccess()와 대칭되는 쓰기 쪽 검사.
async function checkUploadAllowed(bucket, path, event) {
  const role = event.requestContext?.authorizer?.lambda?.role || null;
  if (bucket === 'ticket-attachments') {
    const ticketId = String(path).split('/')[0];
    return await checkTicketOwnership(ticketId, event);
  }
  if (bucket === 'contract-attachments') {
    return await checkFeaturePermission(role, 'company_manage', event);
  }
  if (bucket === 'documents') {
    return await checkFeaturePermission(role, 'library_manage', event);
  }
  return false; // 알 수 없는 버킷은 기본적으로 거부
}

async function handleUploadUrl(body, event) {
  const { bucket, path, contentType, contentLength } = body;

  const allowedExts = ALLOWED_EXTENSIONS_BY_BUCKET[bucket];
  const ext = '.' + (String(path).split('.').pop() || '').toLowerCase();
  if (!allowedExts || !allowedExts.includes(ext)) {
    return json(400, { error: `허용되지 않는 파일 형식입니다: ${ext}` });
  }
  if (typeof contentLength === 'number' && contentLength > MAX_UPLOAD_SIZE) {
    return json(400, { error: `파일이 너무 큽니다. 최대 20MB까지 업로드할 수 있습니다.` });
  }

  const allowed = await checkUploadAllowed(bucket, path, event);
  if (!allowed) return json(403, { error: '이 경로에 업로드할 권한이 없습니다' });

  const Bucket = resolveBucket(bucket);
  const cmdParams = { Bucket, Key: path, ContentType: contentType || 'application/octet-stream' };
  if (typeof contentLength === 'number') cmdParams.ContentLength = contentLength;
  const cmd = new PutObjectCommand(cmdParams);
  const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 300 });
  return json(200, { uploadUrl, path });
}

// signed-url(다운로드)은 "이 경로에 해당하는 메타데이터 행을 이 요청자가 볼 수 있는가"를
// data-api에 그대로 위임해서 확인한다 — storage-api 자체는 DB 접속이 없으므로 직접
// 판단하지 않고, 요청자와 동일한 인증 컨텍스트로 data-api를 내부 호출(Lambda invoke)해서
// 그쪽의 테넌트 격리 로직(고객은 자기 회사 것만, 비공개 문서는 admin만 등)을 재사용한다.
const OWNERSHIP_TABLE_BY_BUCKET = {
  'ticket-attachments': { table: 'ticket_attachments', column: 'storage_path' },
  documents: { table: 'content_documents', column: 'storage_path' },
  'contract-attachments': { table: 'company_contracts', column: 'file_path' },
};

// FAQ 답변에 붙여넣는 이미지는 content_documents의 독립된 행이 아니라 답변 본문 HTML
// 안에 data-storage-path로만 남아있어서 메타데이터 조회로는 소유권을 확인할 수 없다.
// 실제 다운로드 가능한 문서 파일보다 민감도가 낮다고 보고 검사에서 제외한다.
function isExemptPath(bucket, path) {
  return bucket === 'documents' && path.startsWith('faq-images/');
}

async function checkAccess(bucket, path, event) {
  if (isExemptPath(bucket, path)) return true;
  const mapping = OWNERSHIP_TABLE_BY_BUCKET[bucket];
  if (!mapping) return false; // 알 수 없는 버킷은 기본적으로 거부

  const innerEvent = {
    requestContext: {
      http: { method: 'GET' },
      authorizer: event.requestContext?.authorizer,
    },
    rawPath: `/data/${mapping.table}`,
    queryStringParameters: { [mapping.column]: `eq.${path}`, select: 'id', limit: '1' },
  };

  try {
    const res = await lambda.send(new InvokeCommand({
      FunctionName: DATA_API_FN,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(innerEvent)),
    }));
    const payload = JSON.parse(Buffer.from(res.Payload).toString('utf-8'));
    if (payload.statusCode !== 200) return false;
    const rows = JSON.parse(payload.body);
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    console.error('[storage-api 권한확인 실패]', err);
    return false; // 확인 자체가 실패하면 안전하게 거부
  }
}

async function handleSignedUrl(body, event) {
  const { bucket, path, expiresIn } = body;
  const allowed = await checkAccess(bucket, path, event);
  if (!allowed) return json(403, { error: '이 파일에 접근할 권한이 없습니다' });
  const Bucket = resolveBucket(bucket);
  const cmd = new GetObjectCommand({ Bucket, Key: path });
  const signedUrl = await getSignedUrl(s3, cmd, { expiresIn: expiresIn || 60 });
  return json(200, { signedUrl });
}

async function handleRemove(body, event) {
  const { bucket, paths } = body;
  if (!Array.isArray(paths) || !paths.length) return json(200, { removed: [] });

  for (const path of paths) {
    if (!(await checkAccess(bucket, path, event))) {
      return json(403, { error: '이 파일을 삭제할 권한이 없습니다' });
    }
  }

  const Bucket = resolveBucket(bucket);
  await s3.send(new DeleteObjectsCommand({
    Bucket,
    Delete: { Objects: paths.map(Key => ({ Key })) },
  }));
  return json(200, { removed: paths });
}

export const handler = async (event) => {
  currentEvent = event;
  const method = event.requestContext?.http?.method ?? event.httpMethod;
  const path = event.rawPath ?? event.path ?? '';

  if (method === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(event), body: '' };

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    if (method === 'POST' && path === '/storage/upload-url') return await handleUploadUrl(body, event);
    if (method === 'POST' && path === '/storage/signed-url') return await handleSignedUrl(body, event);
    if (method === 'POST' && path === '/storage/remove') return await handleRemove(body, event);
    return json(404, { error: 'not found' });
  } catch (err) {
    console.error('[storage-api 오류]', err);
    return json(500, { error: String(err) });
  }
};
