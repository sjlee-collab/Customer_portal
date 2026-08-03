// data-api Lambda — 범용 테이블 CRUD API (Supabase sb.from() 방식을 흉내낸 인터페이스)
// 알림이 걸리지 않는 단순 조회/등록/수정/삭제는 전부 이 함수 하나가 처리한다.
// 알림이 걸리는 티켓 생성/상태변경/담당자배정은 api-layer Lambda가 따로 담당한다.
//
// 라우트:
//   GET    /data/:table            목록 조회 (select, 필터, order, limit, single 지원)
//   POST   /data/:table            등록 (body: 객체 또는 배열)
//   PATCH  /data/:table/:id        id로 수정
//   DELETE /data/:table/:id        id로 삭제
//
// 쿼리 파라미터 (PostgREST/Supabase와 비슷한 문법):
//   select=col1,col2,alias:fk_col(col1,col2)
//   order=col.asc 또는 col.desc
//   limit=20
//   single=1                       (결과를 배열이 아닌 객체 하나로)
//   <column>=eq.value              필터 (eq,neq,gt,gte,lt,lte,ilike,in,is 지원)

import { query } from './db.mjs';

const ALLOWED_ORIGINS = ['https://support.bigxdata.io', 'https://dev.dlayoierdftk6.amplifyapp.com'];

function corsHeaders(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin;
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Vary': 'Origin',
  };
}

const ALLOWED_TABLES = new Set([
  'companies', 'company_contracts', 'company_licenses', 'users', 'tickets',
  'log_notification', 'content_documents', 'ticket_history', 'log_integration',
  'ticket_replies', 'ticket_memos', 'ticket_attachments', 'content_notices', 'role_permissions',
]);

// 이 컬럼들은 select=* 나 명시적 요청과 무관하게 응답에서 절대 내려주지 않는다.
// 비밀번호 검증은 api-layer의 /auth/* 엔드포인트가 서버 쪽에서 전담한다.
const BLOCKED_COLUMNS = {
  users: new Set(['password', 'reset_token', 'reset_token_expires_at']),
};

function stripBlockedColumns(table, rows) {
  const blocked = BLOCKED_COLUMNS[table];
  if (!blocked) return;
  for (const row of rows) for (const col of blocked) delete row[col];
}

// 이 테이블은 화면에서 스태프(요청 관리 권한이 있는 역할)에게만 보이도록 UI로만 가려뒀는데,
// 조회 자체엔 아무 제한이 없어서 로그인한 고객 계정이 직접 호출하면 내부 비공개 메모를
// 그대로 읽을 수 있었다. 화면과 동일한 역할 기준으로 테이블 전체를 막는다.
const STAFF_ONLY_TABLES = {
  ticket_memos: new Set(['tech_support', 'sales', 'education', 'admin']),
};

function assertTableAccess(table, event) {
  const allowedRoles = STAFF_ONLY_TABLES[table];
  if (!allowedRoles) return;
  const role = event.requestContext?.authorizer?.lambda?.role;
  if (!allowedRoles.has(role)) throw new HttpError(403, '이 데이터에 접근할 권한이 없습니다');
}

// 임베드(alias:fk_col(cols)) 시 fk 컬럼이 가리키는 테이블
const EMBED_TABLE_MAP = {
  created_by: 'users',
  changed_by: 'users',
  assigned_to: 'users',
  uploaded_by: 'users',
  company_id: 'companies',
  contract_id: 'company_contracts',
  ticket_id: 'tickets',
};

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertIdent(name, label = '식별자') {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new HttpError(400, `잘못된 ${label}: ${name}`);
  }
  return name;
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

let currentEvent = null;

function json(statusCode, body) {
  return { statusCode, headers: { ...corsHeaders(currentEvent), 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// "col1,col2,alias:fk(col1,col2)" 를 최상위 콤마 기준으로 분리 (괄호 안 콤마는 무시)
function splitTopLevel(str) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function parseSelect(selectParam) {
  const raw = selectParam ? splitTopLevel(selectParam) : ['*'];
  const plainCols = [];
  const embeds = []; // { alias, fkCol, cols }
  for (const part of raw) {
    const m = part.match(/^(\w+):(\w+)\(([^)]*)\)$/);
    if (m) {
      const [, alias, fkCol, colsRaw] = m;
      assertIdent(alias, 'select alias');
      assertIdent(fkCol, 'select fk 컬럼');
      const cols = colsRaw.split(',').map(c => c.trim()).filter(Boolean);
      cols.forEach(c => assertIdent(c, 'select 컬럼'));
      if (!EMBED_TABLE_MAP[fkCol]) throw new HttpError(400, `임베드 미지원 fk 컬럼: ${fkCol}`);
      const embedTable = EMBED_TABLE_MAP[fkCol];
      const embedBlocked = BLOCKED_COLUMNS[embedTable];
      const safeCols = embedBlocked ? cols.filter(c => !embedBlocked.has(c)) : cols;
      embeds.push({ alias, fkCol, cols: safeCols, table: embedTable });
    } else if (part === '*') {
      plainCols.push('*');
    } else {
      assertIdent(part, 'select 컬럼');
      plainCols.push(part);
    }
  }
  return { plainCols: plainCols.length ? plainCols : ['*'], embeds };
}

const OPS = {
  eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', ilike: 'ilike',
};

function buildWhere(table, queryParams, params) {
  const clauses = [];
  const reserved = new Set(['select', 'order', 'limit', 'single', 'count', 'head', 'on_conflict']);
  for (const [col, rawVal] of Object.entries(queryParams || {})) {
    if (reserved.has(col)) continue;
    assertIdent(col, '필터 컬럼');
    const dotIdx = rawVal.indexOf('.');
    const op = dotIdx === -1 ? 'eq' : rawVal.slice(0, dotIdx);
    const val = dotIdx === -1 ? rawVal : rawVal.slice(dotIdx + 1);

    if (op === 'is') {
      if (val === 'null') clauses.push(`"${col}" is null`);
      else if (val === 'not.null') clauses.push(`"${col}" is not null`);
      else throw new HttpError(400, `is 필터는 null/not.null만 지원합니다: ${col}`);
    } else if (op === 'in') {
      const list = val.split(',').map(v => v.trim());
      params.push(list);
      clauses.push(`"${col}" = ANY($${params.length})`);
    } else if (OPS[op]) {
      params.push(val);
      clauses.push(`"${col}" ${OPS[op]} $${params.length}`);
    } else {
      throw new HttpError(400, `지원하지 않는 필터 연산자: ${op}`);
    }
  }
  return clauses;
}

async function resolveEmbeds(rows, embeds) {
  for (const embed of embeds) {
    const ids = [...new Set(rows.map(r => r[embed.fkCol]).filter(Boolean))];
    let byId = {};
    if (ids.length) {
      const cols = ['id', ...embed.cols].map(c => `"${c}"`).join(',');
      const found = await query(`select ${cols} from "${embed.table}" where id = ANY($1)`, [ids]);
      byId = Object.fromEntries(found.map(f => [f.id, f]));
    }
    for (const row of rows) {
      const fk = row[embed.fkCol];
      row[embed.alias] = fk ? (byId[fk] ?? null) : null;
    }
  }
}

async function handleGet(table, qs) {
  const params = [];
  const whereClauses = buildWhere(table, qs, params);

  // count=1 (Supabase의 {count:'exact', head:true} 대응) — 실제 행 대신 개수만 반환
  if (qs.count) {
    let sql = `select count(*) as count from "${table}"`;
    if (whereClauses.length) sql += ` where ${whereClauses.join(' and ')}`;
    const rows = await query(sql, params);
    return json(200, { count: parseInt(rows[0].count, 10) });
  }

  const { plainCols, embeds } = parseSelect(qs.select);

  // 임베드에 필요한 fk 컬럼이 select에 명시되지 않았으면 조회용으로만 슬쩍 추가하고,
  // 나중에 결과에서 다시 빼준다 (호출자가 요청한 컬럼만 응답에 남도록).
  const fetchAllCols = plainCols.includes('*');
  const requestedSet = new Set(plainCols);
  const extraFkCols = fetchAllCols ? [] : embeds.map(e => e.fkCol).filter(fk => !requestedSet.has(fk));
  const fetchCols = fetchAllCols ? ['*'] : [...plainCols, ...new Set(extraFkCols)];

  const colsSql = fetchAllCols ? '*' : fetchCols.map(c => `"${c}"`).join(',');
  let sql = `select ${colsSql} from "${table}"`;
  if (whereClauses.length) sql += ` where ${whereClauses.join(' and ')}`;

  if (qs.order) {
    const [col, dir] = qs.order.split('.');
    assertIdent(col, 'order 컬럼');
    const dirSql = dir === 'desc' ? 'desc' : 'asc';
    sql += ` order by "${col}" ${dirSql}`;
  }
  const limit = qs.single ? 1 : (qs.limit ? Math.min(parseInt(qs.limit, 10) || 100, 1000) : 200);
  sql += ` limit ${limit}`;

  const rows = await query(sql, params);
  if (embeds.length) await resolveEmbeds(rows, embeds);
  if (!fetchAllCols && extraFkCols.length) {
    for (const row of rows) for (const fk of extraFkCols) delete row[fk];
  }
  stripBlockedColumns(table, rows);
  for (const embed of embeds) stripBlockedColumns(embed.table, rows.map(r => r[embed.alias]).filter(Boolean));

  if (qs.single) {
    if (!rows.length) throw new HttpError(404, '결과 없음');
    return json(200, rows[0]);
  }
  return json(200, rows);
}

async function handlePost(table, body, onConflict) {
  const records = Array.isArray(body) ? body : [body];
  if (!records.length) throw new HttpError(400, '등록할 데이터가 없습니다');
  const cols = Object.keys(records[0]);
  cols.forEach(c => assertIdent(c, 'insert 컬럼'));
  const colsSql = cols.map(c => `"${c}"`).join(',');

  let conflictCols = null;
  let conflictSql = '';
  if (onConflict) {
    conflictCols = onConflict.split(',').map(c => c.trim());
    conflictCols.forEach(c => assertIdent(c, 'on_conflict 컬럼'));
    const updateSql = cols.filter(c => !conflictCols.includes(c)).map(c => `"${c}" = excluded."${c}"`).join(',');
    conflictSql = ` on conflict (${conflictCols.map(c => `"${c}"`).join(',')}) do update set ${updateSql}`;
  }

  const results = [];
  for (const rec of records) {
    const params = cols.map(c => rec[c] ?? null);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
    const inserted = await query(
      `insert into "${table}" (${colsSql}) values (${placeholders})${conflictSql} returning *`,
      params
    );
    results.push(inserted[0]);
  }
  stripBlockedColumns(table, results);
  return json(201, Array.isArray(body) ? results : results[0]);
}

async function handlePatch(table, id, body) {
  const cols = Object.keys(body);
  if (!cols.length) throw new HttpError(400, '수정할 데이터가 없습니다');
  cols.forEach(c => assertIdent(c, 'update 컬럼'));
  const setSql = cols.map((c, i) => `"${c}" = $${i + 1}`).join(',');
  const params = cols.map(c => body[c] ?? null);
  params.push(id);
  const updated = await query(
    `update "${table}" set ${setSql} where id = $${params.length} returning *`,
    params
  );
  if (!updated.length) throw new HttpError(404, '대상을 찾을 수 없습니다');
  stripBlockedColumns(table, updated);
  return json(200, updated[0]);
}

async function handleDelete(table, id) {
  const deleted = await query(`delete from "${table}" where id = $1 returning id`, [id]);
  if (!deleted.length) throw new HttpError(404, '대상을 찾을 수 없습니다');
  return json(200, { id: deleted[0].id });
}

export const handler = async (event) => {
  currentEvent = event;
  const method = event.requestContext?.http?.method ?? event.httpMethod;
  const path = event.rawPath ?? event.path ?? '';
  const qs = event.queryStringParameters || {};

  if (method === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(event), body: '' };

  try {
    const withId = path.match(/^\/data\/([a-zA-Z_][a-zA-Z0-9_]*)\/([^/]+)$/);
    const noId = path.match(/^\/data\/([a-zA-Z_][a-zA-Z0-9_]*)$/);

    const table = (withId ?? noId)?.[1];
    if (!table || !ALLOWED_TABLES.has(table)) throw new HttpError(404, '알 수 없는 테이블입니다');
    assertTableAccess(table, event);

    const body = event.body ? JSON.parse(event.body) : undefined;

    if (method === 'GET' && noId) return await handleGet(table, qs);
    if (method === 'POST' && noId) return await handlePost(table, body, qs.on_conflict);
    if (method === 'PATCH' && withId) return await handlePatch(table, withId[2], body);
    if (method === 'DELETE' && withId) return await handleDelete(table, withId[2]);

    throw new HttpError(404, 'not found');
  } catch (err) {
    if (err instanceof HttpError) return json(err.statusCode, { error: err.message });
    console.error('[data-api 오류]', err);
    return json(500, { error: String(err) });
  }
};
