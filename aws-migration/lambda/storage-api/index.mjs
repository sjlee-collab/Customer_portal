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

const s3 = new S3Client({ region: process.env.AWS_REGION || 'ap-northeast-2' });

// Supabase 시절 버킷 이름 -> 실제 S3 버킷 이름
const BUCKET_MAP = {
  documents: process.env.BUCKET_DOCUMENTS,
  'ticket-attachments': process.env.BUCKET_TICKET_ATTACHMENTS,
  'contract-attachments': process.env.BUCKET_CONTRACT_ATTACHMENTS,
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

function json(statusCode, body) {
  return { statusCode, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function resolveBucket(logicalName) {
  const bucket = BUCKET_MAP[logicalName];
  if (!bucket) throw new Error(`알 수 없는 버킷: ${logicalName}`);
  return bucket;
}

async function handleUploadUrl(body) {
  const { bucket, path, contentType } = body;
  const Bucket = resolveBucket(bucket);
  const cmd = new PutObjectCommand({ Bucket, Key: path, ContentType: contentType || 'application/octet-stream' });
  const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 300 });
  return json(200, { uploadUrl, path });
}

async function handleSignedUrl(body) {
  const { bucket, path, expiresIn } = body;
  const Bucket = resolveBucket(bucket);
  const cmd = new GetObjectCommand({ Bucket, Key: path });
  const signedUrl = await getSignedUrl(s3, cmd, { expiresIn: expiresIn || 60 });
  return json(200, { signedUrl });
}

async function handleRemove(body) {
  const { bucket, paths } = body;
  const Bucket = resolveBucket(bucket);
  if (!Array.isArray(paths) || !paths.length) return json(200, { removed: [] });
  await s3.send(new DeleteObjectsCommand({
    Bucket,
    Delete: { Objects: paths.map(Key => ({ Key })) },
  }));
  return json(200, { removed: paths });
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? event.httpMethod;
  const path = event.rawPath ?? event.path ?? '';

  if (method === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };

  try {
    const body = event.body ? JSON.parse(event.body) : {};
    if (method === 'POST' && path === '/storage/upload-url') return await handleUploadUrl(body);
    if (method === 'POST' && path === '/storage/signed-url') return await handleSignedUrl(body);
    if (method === 'POST' && path === '/storage/remove') return await handleRemove(body);
    return json(404, { error: 'not found' });
  } catch (err) {
    console.error('[storage-api 오류]', err);
    return json(500, { error: String(err) });
  }
};
