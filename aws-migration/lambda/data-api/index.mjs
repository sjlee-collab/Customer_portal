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

// 같은 컬럼들을 이 범용 CRUD로 "쓰는" 것도 막는다 — 비밀번호는 반드시 api-layer의
// /auth/change-password, /auth/reset-password를 거쳐 서버에서 해시된 값만 저장돼야 한다.
function assertNoBlockedWrite(table, cols) {
  const blocked = BLOCKED_COLUMNS[table];
  if (!blocked) return;
  const hit = cols.find(c => blocked.has(c));
  if (hit) throw new HttpError(400, `"${hit}" 컬럼은 이 API로 직접 쓸 수 없습니다`);
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

// ── 테넌트 격리 / 권한 상승 방지 ──
// 지금까지는 JWT가 유효한지만 확인하고 "행 단위" 제한이 전혀 없었다. 즉 고객(customer)
// 계정으로 로그인만 하면 /data/companies, /data/tickets, /data/users 를 그대로 호출해서
// 전체 고객사·전체 티켓·전체 사용자 정보를 다 읽을 수 있었고, PATCH /data/users/자기id에
// {"role":"admin"} 을 보내면 그대로 관리자로 격상됐다(실제 테스트로 확인됨). 아래에서
// 역할별로 강제 필터/쓰기 제한을 걸어서 사용자가 준 파라미터와 무관하게 항상 적용한다.
const TENANT_ROLES = new Set(['customer', 'internal']); // "내 회사/내 것"만 봐야 하는 역할
// 신뢰할 수 있는 역할만 명시적으로 나열 — API Gateway 인가자를 거치지 않았거나(직접 Lambda
// 호출 등) role이 비어있는/알 수 없는 요청은 항상 가장 좁은 제한을 받는 쪽이 안전하다.
const STAFF_ROLES = new Set(['admin', 'sales', 'tech_support', 'education']);

// 이 테이블들에 대한 쓰기는 "관리자만"이 아니라 권한 관리 화면(role_permissions 테이블)에
// 실제로 설정된 값을 그대로 따라야 한다 — 예를 들어 library_manage는 기본값은 admin만
// 켜져 있지만 실제로는 tech_support에게도 켜져 있는 등, 관리자가 화면에서 커스터마이징한
// 값이 진짜 기준이다. 하드코딩된 admin 체크는 이런 커스터마이징을 무시해서 회귀를 만든다.
const WRITE_PERMISSION_BY_TABLE = {
  companies: 'company_manage',
  company_contracts: 'company_manage',
  company_licenses: 'company_manage',
  log_notification: 'notify_log',
  log_integration: 'integration',
  role_permissions: 'permission',
  content_documents: 'library_manage',
};

// content_notices(공지사항)는 화면에서도 role_permissions와 무관하게 순수 role==='admin'
// 하드코딩(isNoticeAdmin())으로만 노출된다 — library_manage 등 커스터마이징 가능한
// 권한이 아니므로 위 동적 매핑에 넣지 않고 항상 admin만 쓰게 한다.
const ADMIN_ONLY_WRITE_TABLES = new Set(['content_notices']);

// role_permissions 테이블에서 해당 역할에 이 기능이 실제로 켜져 있는지 확인한다.
// admin은 항상 통과(권한 관리 화면 자체를 admin이 잠글 수도 있으므로 스스로는 항상 허용).
async function hasPermission(role, featureKey) {
  if (role === 'admin') return true;
  if (!role) return false;
  const rows = await query(
    'select enabled from role_permissions where role=$1 and feature_key=$2',
    [role, featureKey]
  );
  return !!rows[0]?.enabled;
}

// tickets는 api-layer(/tickets, /tickets/{id}/status, /tickets/{id}/assign 등)가 알림·이력까지
// 포함해서 전담한다. 실제로 클라이언트도 이 범용 CRUD로 tickets를 쓰는 곳이 없으므로,
// 알림/이력 없이 몰래 조작되는 경로를 원천 차단하기 위해 쓰기(POST/PATCH/DELETE)는 막는다.
const NO_DIRECT_WRITE_TABLES = new Set(['tickets']);

// users는 본인 row에 한해서만, 그리고 이 컬럼들만 admin이 아니어도 스스로 바꿀 수 있다.
// role/company_id/contract_id/is_active/email 같은 컬럼은 admin만 바꿀 수 있어야 한다
// (안 그러면 로그인한 사용자가 자기 role을 admin으로 바꾸는 권한 상승이 그대로 통과한다).
const SELF_EDITABLE_USER_COLUMNS = new Set(['name', 'phone', 'department', 'last_login']);

function getAuthz(event) {
  const a = event.requestContext?.authorizer?.lambda || {};
  return { role: a.role || null, userId: a.userId || null, companyId: a.companyId || null, contractId: a.contractId || null };
}

// GET에 항상 덧붙이는 행 단위 제한. 반환값 { sql, params } 를 whereClauses에 AND로 추가한다.
// admin/스태프(sales·tech_support·education)는 대부분 제한이 없다 — 여러 고객사의 요청을
// 함께 처리하는 게 원래 업무라 여기서까지 좁히면 화면이 깨진다.
async function tenantRowFilterSql(table, authz, paramOffset) {
  const { role, userId, companyId, contractId } = authz;

  // 자료실 비공개 문서는 library_manage 권한이 있어야 볼 수 있다(화면과 동일한 기준 —
  // library_manage는 기본값이 admin만이지만 다른 역할에 커스터마이징될 수 있으므로
  // role==='admin' 하드코딩이 아니라 실제 권한 설정을 그대로 따른다).
  if (table === 'content_documents' && !(await hasPermission(role, 'library_manage'))) {
    return { sql: `"is_public" = true`, params: [] };
  }

  if (STAFF_ROLES.has(role)) return null;

  if (table === 'companies') {
    return companyId ? { sql: `"id" = $${paramOffset}`, params: [companyId] } : { sql: '1=0', params: [] };
  }
  if (table === 'company_contracts' || table === 'company_licenses') {
    return companyId ? { sql: `"company_id" = $${paramOffset}`, params: [companyId] } : { sql: '1=0', params: [] };
  }
  // users는 행 자체를 막지 않는다 — 고객이 자기 티켓의 답글/이력에서 담당자 이름을
  // 조회하려면 "본인 아닌" 사용자 row도 봐야 한다(원래 화면 동작). 대신 아래
  // restrictUserColumnsForNonStaff()에서 본인 행이 아니면 컬럼을 id/name/role로만 제한한다.
  if (table === 'tickets') {
    if (role === 'internal') {
      return userId ? { sql: `"created_by" = $${paramOffset}`, params: [userId] } : { sql: '1=0', params: [] };
    }
    if (contractId) return { sql: `"contract_id" = $${paramOffset}`, params: [contractId] };
    return companyId ? { sql: `"company_id" = $${paramOffset}`, params: [companyId] } : { sql: '1=0', params: [] };
  }
  if (table === 'ticket_replies' || table === 'ticket_attachments' || table === 'ticket_history') {
    if (role === 'internal') {
      return userId
        ? { sql: `"ticket_id" in (select id from tickets where created_by = $${paramOffset})`, params: [userId] }
        : { sql: '1=0', params: [] };
    }
    if (contractId) return { sql: `"ticket_id" in (select id from tickets where contract_id = $${paramOffset})`, params: [contractId] };
    return companyId
      ? { sql: `"ticket_id" in (select id from tickets where company_id = $${paramOffset})`, params: [companyId] }
      : { sql: '1=0', params: [] };
  }
  return null;
}

// 스태프가 아닌 역할(고객/internal)이 users를 조회할 때, 본인 행이 아니면 이름/역할
// 정도만(사내 조직도 수준) 남기고 이메일·전화번호·소속회사 등 나머지 컬럼은 지운다.
const PUBLIC_USER_COLUMNS = new Set(['id', 'name', 'role']);
function restrictUserColumnsForNonStaff(table, rows, authz) {
  if (table !== 'users' || STAFF_ROLES.has(authz.role)) return;
  for (const row of rows) {
    if (row.id === authz.userId) continue;
    for (const col of Object.keys(row)) {
      if (!PUBLIC_USER_COLUMNS.has(col)) delete row[col];
    }
  }
}

// ticket_replies/ticket_attachments/ticket_history의 쓰기 — 고객/internal이 아무 ticket_id나
// 넣어서 다른 회사 티켓에 답글/첨부를 주입하거나, 남의 답글·첨부를 수정/삭제할 수 있었다.
// GET에 쓰는 tenantRowFilterSql과 동일한 기준으로 그 ticket_id가 진짜 자기 것인지 확인한다.
const TICKET_SCOPED_TABLES = new Set(['ticket_replies', 'ticket_attachments', 'ticket_history']);

async function ticketBelongsToRequester(ticketId, authz) {
  if (STAFF_ROLES.has(authz.role)) return true;
  if (!ticketId) return false;
  const { role, userId, companyId, contractId } = authz;
  let sql, params;
  if (role === 'internal') { sql = 'select 1 from tickets where id=$1 and created_by=$2'; params = [ticketId, userId]; }
  else if (contractId)     { sql = 'select 1 from tickets where id=$1 and contract_id=$2'; params = [ticketId, contractId]; }
  else if (companyId)      { sql = 'select 1 from tickets where id=$1 and company_id=$2'; params = [ticketId, companyId]; }
  else return false;
  const rows = await query(sql, params);
  return rows.length > 0;
}

async function assertTicketScopedWriteAllowed(table, method, id, body, authz) {
  if (STAFF_ROLES.has(authz.role)) return;
  if (method === 'POST') {
    const records = Array.isArray(body) ? body : [body];
    for (const rec of records) {
      if (!(await ticketBelongsToRequester(rec.ticket_id, authz))) {
        throw new HttpError(403, '이 요청에 접근할 권한이 없습니다');
      }
    }
    return;
  }
  // PATCH/DELETE — 대상 행이 실제로 어느 ticket_id에 속하는지부터 조회해서 확인한다.
  const rows = await query(`select ticket_id from "${table}" where id=$1`, [id]);
  if (!(await ticketBelongsToRequester(rows[0]?.ticket_id, authz))) {
    throw new HttpError(403, '이 요청에 접근할 권한이 없습니다');
  }
}

async function assertWriteAllowed(table, method, authz, id, cols, body) {
  if (authz.role === 'admin') return;

  if (NO_DIRECT_WRITE_TABLES.has(table)) {
    throw new HttpError(403, '이 테이블은 전용 API를 통해서만 수정할 수 있습니다');
  }
  if (ADMIN_ONLY_WRITE_TABLES.has(table)) {
    throw new HttpError(403, '이 작업은 관리자만 할 수 있습니다');
  }
  const permissionKey = WRITE_PERMISSION_BY_TABLE[table];
  if (permissionKey) {
    if (!(await hasPermission(authz.role, permissionKey))) {
      throw new HttpError(403, '이 작업을 할 권한이 없습니다');
    }
    return;
  }
  if (table === 'users') {
    if (method === 'POST' || method === 'DELETE') {
      if (!(await hasPermission(authz.role, 'user_manage'))) {
        throw new HttpError(403, '이 작업을 할 권한이 없습니다');
      }
      return;
    }
    if (method === 'PATCH') {
      if (id === authz.userId) {
        const disallowed = cols.find(c => !SELF_EDITABLE_USER_COLUMNS.has(c));
        if (!disallowed) return; // 본인 행 + 안전한 컬럼만: 누구나 허용
      }
      if (!(await hasPermission(authz.role, 'user_manage'))) {
        throw new HttpError(403, '이 작업을 할 권한이 없습니다');
      }
    }
    return;
  }
  if (TICKET_SCOPED_TABLES.has(table)) {
    await assertTicketScopedWriteAllowed(table, method, id, body, authz);
  }
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

async function handleGet(table, qs, event) {
  const params = [];
  const whereClauses = buildWhere(table, qs, params);

  const authz = getAuthz(event);
  const tenantFilter = await tenantRowFilterSql(table, authz, params.length + 1);
  if (tenantFilter) {
    whereClauses.push(tenantFilter.sql);
    params.push(...tenantFilter.params);
  }

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
  restrictUserColumnsForNonStaff(table, rows, authz);
  for (const embed of embeds) restrictUserColumnsForNonStaff(embed.table, rows.map(r => r[embed.alias]).filter(Boolean), authz);

  if (qs.single) {
    if (!rows.length) throw new HttpError(404, '결과 없음');
    return json(200, rows[0]);
  }
  return json(200, rows);
}

async function handlePost(table, body, onConflict, event) {
  const records = Array.isArray(body) ? body : [body];
  if (!records.length) throw new HttpError(400, '등록할 데이터가 없습니다');
  const cols = Object.keys(records[0]);
  cols.forEach(c => assertIdent(c, 'insert 컬럼'));
  assertNoBlockedWrite(table, cols);
  await assertWriteAllowed(table, 'POST', getAuthz(event), null, cols, body);
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

async function handlePatch(table, id, body, event) {
  const cols = Object.keys(body);
  if (!cols.length) throw new HttpError(400, '수정할 데이터가 없습니다');
  cols.forEach(c => assertIdent(c, 'update 컬럼'));
  assertNoBlockedWrite(table, cols);
  await assertWriteAllowed(table, 'PATCH', getAuthz(event), id, cols, body);
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

async function handleDelete(table, id, event) {
  await assertWriteAllowed(table, 'DELETE', getAuthz(event), id, []);
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

    if (method === 'GET' && noId) return await handleGet(table, qs, event);
    if (method === 'POST' && noId) return await handlePost(table, body, qs.on_conflict, event);
    if (method === 'PATCH' && withId) return await handlePatch(table, withId[2], body, event);
    if (method === 'DELETE' && withId) return await handleDelete(table, withId[2], event);

    throw new HttpError(404, 'not found');
  } catch (err) {
    if (err instanceof HttpError) return json(err.statusCode, { error: err.message });
    console.error('[data-api 오류]', err);
    return json(500, { error: String(err) });
  }
};
