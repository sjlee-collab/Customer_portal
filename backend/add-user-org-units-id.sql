-- user_org_units에 id 대리키(surrogate key) 추가
--
-- 배경: 조직 기능(a5af024) 도입 시 user_org_units는 (user_id, unit_id) 복합 PK로만 만들어졌다.
--       그런데 화면의 조직 배정 저장 로직(index.html의 syncUserOrgs)은 이 테이블을 id로
--       조회·삭제·수정한다:
--           select('id, unit_id, is_primary') / delete().eq('id', ...) / update().eq('id', ...)
--       id 컬럼이 없어서 첫 조회가 500(column "id" does not exist)으로 실패하고, 그 결과
--       "배정된 조직이 하나도 없다"고 오판해서 아래 동작이 조용히 누락됐다:
--         · 조직 체크를 풀어도 삭제되지 않음
--         · 대표 조직(is_primary) 변경이 반영되지 않음
--         (조직 "추가"만 정상 동작 — insert는 id를 요구하지 않기 때문)
--
--       data-api의 PATCH/DELETE는 `/data/:table/:id` 경로에 `where id = $1`로 고정돼 있어
--       id 컬럼이 없는 테이블은 애초에 이 범용 API로 수정·삭제할 수 없다. 따라서 화면 코드를
--       바꾸는 대신 테이블에 id를 추가하는 쪽이 변경 범위가 가장 작다.
--
-- (user_id, unit_id) 복합 PK는 그대로 유지한다 — 같은 사용자를 같은 조직에 두 번 배정하는
-- 중복을 계속 막아주기 때문. id는 unique 인덱스만 걸어 행 지목용으로만 쓴다.
--
-- gen_random_uuid()는 volatile 함수라 기존 행마다 서로 다른 UUID가 채워진다(테이블 재작성).
-- 현재 259행 규모라 부담 없다. 여러 번 실행해도 안전하다(IF NOT EXISTS).

alter table public.user_org_units
  add column if not exists id uuid not null default gen_random_uuid();

create unique index if not exists user_org_units_id_key
  on public.user_org_units (id);

comment on column public.user_org_units.id is
  '행 지목용 대리키. 실제 유일성은 (user_id, unit_id) 복합 PK가 보장한다. data-api의 PATCH/DELETE가 id 경로만 지원해서 추가됨.';

-- 확인용
-- select count(*) as 전체, count(distinct id) as id_유일 from public.user_org_units;
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--  where conrelid = 'public.user_org_units'::regclass;
