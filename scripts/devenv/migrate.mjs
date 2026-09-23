// 일회용 개발환경 구축 Lambda — 운영 DB는 SELECT만, 쓰기는 dev DB에만.
import pg from 'pg';
import fs from 'node:fs';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { RDS_CA } from './_ca.mjs';

const HOST = process.env.DB_HOST, PORT = Number(process.env.DB_PORT || 5432);
const SECRET = process.env.DB_SECRET_ID;
const PROD_DB = 'customer_portal', DEV_DB = 'customer_portal_dev';
const sm = new SecretsManagerClient({});
let creds = null;

async function getCreds() {
  if (creds) return creds;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: SECRET }));
  const s = JSON.parse(r.SecretString);
  creds = { user: s.username || process.env.DB_USER, password: s.password };
  return creds;
}
async function conn(db) {
  const c = await getCreds();
  const cl = new pg.Client({ host: HOST, port: PORT, database: db, user: c.user, password: c.password,
                             ssl: { rejectUnauthorized: true, ca: RDS_CA } });
  await cl.connect();
  return cl;
}
// 테이블별 컬럼명+정확한 타입 (배열/도메인 포함)
const COLS_SQL = `
  select a.attname as col, format_type(a.atttypid, a.atttypmod) as typ
    from pg_attribute a
   where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
   order by a.attnum`;
const TABLES_SQL = `
  select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind='r' order by c.relname`;

export const handler = async (ev) => {
  const action = ev.action;
  if (action === 'inspect') {
    const cl = await conn('postgres');
    const dbs = await cl.query(`select datname from pg_database where datistemplate=false order by 1`);
    const act = await cl.query(`select datname, count(*)::int n from pg_stat_activity where datname is not null group by 1 order by 1`);
    await cl.end();
    return { databases: dbs.rows.map(r => r.datname), connections: act.rows };
  }
  if (action === 'create_db') {
    const cl = await conn('postgres');
    const ex = await cl.query(`select 1 from pg_database where datname=$1`, [DEV_DB]);
    let created = false;
    if (ex.rowCount === 0) { await cl.query(`create database "${DEV_DB}"`); created = true; }
    await cl.end();
    return { db: DEV_DB, created, already: !created };
  }
  if (action === 'apply_schema') {
    const sql = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
    const cl = await conn(DEV_DB);
    try { await cl.query(sql); }
    catch (e) { await cl.end(); return { ok: false, error: e.message, position: e.position, detail: e.detail }; }
    const t = await cl.query(TABLES_SQL);
    await cl.end();
    return { ok: true, tables: t.rows.map(r => r.relname) };
  }
  if (action === 'copy_data') {
    const prod = await conn(PROD_DB), dev = await conn(DEV_DB);
    const out = [];
    try {
      const tl = (await dev.query(TABLES_SQL)).rows.map(r => r.relname);
      await dev.query(`set session_replication_role = replica`);   // 트리거·FK 검사 끔(복사 중에만)
      await dev.query('begin');
      // 전체를 한 번에 비운다. 테이블마다 CASCADE로 비우면 뒤 테이블의 CASCADE가
      // 앞서 복사한 테이블까지 지워버린다(실제 발생).
      if (ev.truncate !== false && tl.length)
        await dev.query(`truncate table ${tl.map(x => `public."${x}"`).join(',')} cascade`);
      for (const t of tl) {
        const cols = (await dev.query(COLS_SQL, [`public.${t}`])).rows;
        const names = cols.map(c => `"${c.col}"`).join(',');
        const sel = cols.map(c => `"${c.col}"::text`).join(',');   // 텍스트 표현으로 읽어 타입 왕복 오류 차단
        let rows;
        try { rows = (await prod.query(`select ${sel} from public."${t}"`)).rows; }
        catch (e) { out.push({ table: t, skipped: '운영에 없음', error: e.message.slice(0, 80) }); continue; }
        let n = 0;
        const B = 200;
        for (let i = 0; i < rows.length; i += B) {
          const chunk = rows.slice(i, i + B);
          const params = [];
          const tuples = chunk.map(r => {
            const ph = cols.map((c, j) => { params.push(r[c.col]); return `$${params.length}::${c.typ}`; });
            return `(${ph.join(',')})`;
          });
          await dev.query(`insert into public."${t}" (${names}) values ${tuples.join(',')}`, params);
          n += chunk.length;
        }
        out.push({ table: t, copied: n });
      }
      await dev.query('commit');
    } catch (e) {
      try { await dev.query('rollback'); } catch {}
      await prod.end(); await dev.end();
      return { ok: false, error: e.message, done: out };
    }
    await prod.end(); await dev.end();
    return { ok: true, tables: out };
  }
  if (action === 'sync_sequences') {
    const dev = await conn(DEV_DB);
    const seqs = (await dev.query(`select sequencename from pg_sequences where schemaname='public'`)).rows;
    const res = [];
    for (const s of seqs) {
      // 시퀀스를 쓰는 컬럼을 찾아 최대값+1로 맞춤. 못 찾으면 운영 시퀀스 현재값을 따라감.
      const dep = (await dev.query(`
        select c.relname as tbl, a.attname as col
          from pg_depend d
          join pg_class s on s.oid=d.objid and s.relkind='S'
          join pg_class c on c.oid=d.refobjid
          join pg_attribute a on a.attrelid=c.oid and a.attnum=d.refobjsubid
         where s.relname=$1`, [s.sequencename])).rows[0];
      if (dep) {
        const m = (await dev.query(`select coalesce(max("${dep.col}"),0)::bigint as mx from public."${dep.tbl}"`)).rows[0].mx;
        await dev.query(`select setval('public."${s.sequencename}"', greatest($1::bigint,1), $2)`, [m, Number(m) > 0]);
        res.push({ seq: s.sequencename, from: `${dep.tbl}.${dep.col}`, setTo: m });
      } else {
        const prod = await conn(PROD_DB);
        const v = (await prod.query(`select last_value, is_called from public."${s.sequencename}"`)).rows[0];
        await prod.end();
        await dev.query(`select setval('public."${s.sequencename}"', $1::bigint, $2)`, [v.last_value, v.is_called]);
        res.push({ seq: s.sequencename, from: '운영 시퀀스 현재값', setTo: String(v.last_value) });
      }
    }
    await dev.end();
    return { ok: true, sequences: res };
  }

  if (action === 'fix_schema') {
    const prod = await conn(PROD_DB), dev = await conn(DEV_DB);
    const applied = [], failed = [];
    const run = async (sql, label) => {
      try { await dev.query(sql); applied.push(label); }
      catch (e) { failed.push({ label, error: e.message }); }
    };
    const tsql = `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
                   where n.nspname='public' and c.relkind='r'`;
    const pt = (await prod.query(tsql)).rows.map(r => r.relname);
    const dt = (await dev.query(tsql)).rows.map(r => r.relname);
    const colsql = `select a.attname col, format_type(a.atttypid,a.atttypmod) typ, a.attnotnull nn,
                           pg_get_expr(d.adbin, d.adrelid) def
                      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
                     where a.attrelid=$1::regclass and a.attnum>0 and not a.attisdropped order by a.attnum`;
    // (1) 운영에만 있는 테이블 생성
    for (const t of pt.filter(x => !dt.includes(x))) {
      const cols = (await prod.query(colsql, [`public.${t}`])).rows;
      const defs = cols.map(c => `"${c.col}" ${c.typ}${c.def ? ' default ' + c.def : ''}${c.nn ? ' not null' : ''}`);
      await run(`create table public."${t}" (${defs.join(', ')})`, `테이블 생성 ${t}`);
    }
    // (2) 기존 테이블의 누락 컬럼 추가
    for (const t of pt.filter(x => dt.includes(x))) {
      const pc = (await prod.query(colsql, [`public.${t}`])).rows;
      const dc = (await dev.query(colsql, [`public.${t}`])).rows.map(r => r.col);
      for (const c of pc.filter(x => !dc.includes(x.col)))
        await run(`alter table public."${t}" add column "${c.col}" ${c.typ}${c.def ? ' default ' + c.def : ''}`,
                  `컬럼 추가 ${t}.${c.col}`);
    }
    // (3) 제약: dev에만 있는 것 제거 → 운영에만 있는 것 추가 (NOT NULL 제외)
    const consql = `select conrelid::regclass::text tbl, conname nm, pg_get_constraintdef(oid) def, contype
                      from pg_constraint where connamespace='public'::regnamespace and contype <> 'n'`;
    const pcon = (await prod.query(consql)).rows;
    const dcon = (await dev.query(consql)).rows;
    const key = r => `${r.tbl}:${r.def}`;
    const pkeys = new Set(pcon.map(key));
    for (const r of dcon.filter(x => !pkeys.has(key(x))))
      await run(`alter table ${r.tbl} drop constraint "${r.nm}"`, `제약 제거 ${r.tbl}.${r.nm}`);
    const dkeys2 = new Set((await dev.query(consql)).rows.map(key));
    for (const r of pcon.filter(x => !dkeys2.has(key(x))))
      await run(`alter table ${r.tbl} add constraint "${r.nm}" ${r.def}`, `제약 추가 ${r.tbl}.${r.nm}`);
    // (4) 인덱스: 제약이 만든 것 제외하고 누락분 생성
    const idxsql = `select i.indexrelid::regclass::text nm, pg_get_indexdef(i.indexrelid) def
                      from pg_index i join pg_class c on c.oid=i.indrelid
                      join pg_namespace n on n.oid=c.relnamespace
                     where n.nspname='public' and not exists (
                       select 1 from pg_constraint k where k.conindid=i.indexrelid)`;
    const pidx = (await prod.query(idxsql)).rows;
    const didx = new Set((await dev.query(idxsql)).rows.map(r => r.def));
    for (const r of pidx.filter(x => !didx.has(x.def)))
      await run(r.def, `인덱스 생성 ${r.nm}`);
    await prod.end(); await dev.end();
    return { applied, failed };
  }


  if (action === 'dev_exec') {          // dev DB 전용 — 운영 DB에는 연결조차 하지 않는다
    const dev = await conn(DEV_DB);
    try {
      const r = await dev.query(ev.sql, ev.params || []);
      await dev.end();
      return { ok: true, rowCount: r.rowCount, rows: r.rows };
    } catch (e) { await dev.end(); return { ok: false, error: e.message }; }
  }

  if (action === 'verify') {
    const prod = await conn(PROD_DB), dev = await conn(DEV_DB);
    const pt = (await prod.query(TABLES_SQL)).rows.map(r => r.relname);
    const dt = (await dev.query(TABLES_SQL)).rows.map(r => r.relname);
    const counts = [];
    for (const t of pt) {
      const p = (await prod.query(`select count(*)::int n from public."${t}"`)).rows[0].n;
      let d = null;
      if (dt.includes(t)) d = (await dev.query(`select count(*)::int n from public."${t}"`)).rows[0].n;
      counts.push({ table: t, prod: p, dev: d, match: p === d });
    }
    // 구조 대조: 컬럼(이름·타입·NULL 허용) / 인덱스 / 제약
    const structSql = `
      select table_name||'.'||column_name||':'||data_type||':'||is_nullable as sig
        from information_schema.columns where table_schema='public' order by 1`;
    const ps = (await prod.query(structSql)).rows.map(r => r.sig);
    const ds = (await dev.query(structSql)).rows.map(r => r.sig);
    const idxSql = `select tablename||':'||indexdef as sig from pg_indexes where schemaname='public' order by 1`;
    const pi = (await prod.query(idxSql)).rows.map(r => r.sig);
    const di = (await dev.query(idxSql)).rows.map(r => r.sig);
    const conSql = `select conrelid::regclass::text||':'||pg_get_constraintdef(oid) as sig
                      from pg_constraint where connamespace='public'::regnamespace order by 1`;
    const pc = (await prod.query(conSql)).rows.map(r => r.sig);
    const dc = (await dev.query(conSql)).rows.map(r => r.sig);
    const trgSql = `select tgrelid::regclass::text||':'||tgname as sig from pg_trigger where not tgisinternal order by 1`;
    const pg_ = (await prod.query(trgSql)).rows.map(r => r.sig);
    const dg = (await dev.query(trgSql)).rows.map(r => r.sig);
    await prod.end(); await dev.end();
    const diff = (a, b) => ({ onlyProd: a.filter(x => !b.includes(x)), onlyDev: b.filter(x => !a.includes(x)) });
    return { counts,
      tablesOnlyProd: pt.filter(x => !dt.includes(x)), tablesOnlyDev: dt.filter(x => !pt.includes(x)),
      columns: diff(ps, ds), indexes: diff(pi, di), constraints: diff(pc, dc), triggers: diff(pg_, dg) };
  }
  return { error: 'unknown action', got: action };
};
