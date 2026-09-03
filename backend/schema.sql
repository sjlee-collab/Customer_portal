-- ============================================================
-- Customer_portal Supabase → RDS 마이그레이션용 스키마
-- 원본: Supabase project ozmuxppuyuyhojmdiism (PostgreSQL 17.6)
-- 생성일: Phase 0 export
-- 순서: 전체 테이블 생성(FK 없이) → 마지막에 FK 일괄 추가 (순환 참조 회피)
--
-- [2026-08-11 추가] 조직(org_units / user_org_units)과 users.unit_id, tickets.unit_id/unit_name은
-- 기능 구현 시 운영 DB에 직접 반영되어 이 파일에 빠져 있었다. 운영 DB를 조회해 뒤늦게 채워넣었고,
-- user_org_units의 제약조건은 pg_constraint로 실제 대조해서 일치를 확인했다(PK/FK ON DELETE CASCADE).
-- org_units 쪽 제약조건은 대조하지 않았으므로 새 환경 적용 전 아래 쿼리로 확인할 것.
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.org_units'::regclass;
-- ============================================================

-- ── 1. companies ──
create table public.companies (
  id                        uuid primary key default gen_random_uuid(),
  name                      text not null,
  salesforce_id             text,
  status                    text not null default 'active'
                            check (status = any (array['active','inactive','prospect','suspended','expiring_soon','expired'])),
  account_manager           text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  tech_support_manager      text,
  products                  text[],
  customer_type             text,
  main_contact_name         text,
  main_contact_phone        text,
  notification_emails       text[],
  email_notification_enabled boolean not null default true
);
comment on table public.companies is '고객사 기본 정보';

-- ── 2. company_contracts ──
create table public.company_contracts (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null,
  contract_name     text not null,
  start_date        date,
  end_date          date,
  contract_type     text,
  status            text not null default '진행중',
  customer_contact  text,
  bixs_contact      text,
  amount            text,
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  file_name         text,
  file_path         text,
  salesforce_id     text
);

-- ── 3. users ──
create table public.users (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid,
  email         text not null unique,
  name          text not null,
  role          text not null default 'customer'
                check (role = any (array['customer','internal','tech_support','sales','education','admin'])),
  phone         text,
  department    text,
  is_active     boolean not null default true,
  last_login    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  password      text,
  contract_id   uuid,
  unit_id       uuid
);
comment on table public.users is '포탈 사용자 (고객사 담당자 및 내부 직원)';
comment on column public.users.role is 'customer=고객사 사용자 / internal=내부 일반 / tech_support=기술지원 담당 / sales=영업 담당 / education=교육 담당 / admin=시스템 관리자';
comment on column public.users.is_active is '계정 활성 여부 (비활성=로그인 불가)';
comment on column public.users.contract_id is '사업부 등으로 계약이 나뉜 고객사의 경우, 이 사용자가 속한 계약(company_contracts). null이면 회사 전체 공유(기존 방식). 조직(unit_id) 도입 후에는 폴백 경로.';
comment on column public.users.unit_id is '대표 조직(org_units) — user_org_units의 is_primary와 같은 값을 편의상 비정규화해 둔 것. 실제 배정 목록은 user_org_units가 기준.';

-- ── 4. tickets ──
create table public.tickets (
  id                  uuid primary key default gen_random_uuid(),
  ticket_number       text not null unique default '',
  company_id          uuid,
  created_by          uuid,
  assigned_to         uuid,
  title               text not null,
  description         text,
  category            text not null
                      check (category = any (array['tech_support','contract','license','education','customer','other'])),
  product             text,
  priority            text not null default 'normal'
                      check (priority = any (array['normal','high','critical'])),
  status              text not null default 'received'
                      check (status = any (array['received','classifying','in_progress','pending_customer','on_hold','completed','cancelled'])),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  due_date            date,
  assigned_to_name    text,
  contract_id         uuid,
  company_name        text,
  created_by_name     text,
  unit_id             uuid,
  unit_name           text,
  cc_emails           text[],
  satisfaction_rating smallint constraint tickets_satisfaction_rating_check check (satisfaction_rating is null or satisfaction_rating between 1 and 5),
  satisfaction_comment text,
  rated_at            timestamptz,
  registered_by       uuid references public.users(id) on delete set null,
  registered_by_name  text,
  is_internal         boolean not null default false
);
comment on table public.tickets is '고객 기술지원 요청 티켓';
comment on column public.tickets.is_internal is '내부 검토 요청(대리 등록 전용). true면 고객 화면(목록·상세·자식행)에서 완전 은닉되고 고객 메일도 발송하지 않는다. 스태프가 일반으로 전환 가능(역방향 불가).';
comment on column public.tickets.registered_by is '대리 등록한 내부직원 계정 id. 값이 있으면 대리 등록(내부직원이 고객 대신 접수), null이면 고객이 직접 등록. 계정 삭제 시 SET NULL.';
comment on column public.tickets.registered_by_name is '대리 등록자 이름 스냅샷 — registered_by 계정이 삭제돼도 "대리" 배지/이력 표시를 위해 보존.';
comment on column public.tickets.cc_emails is '상태변경 메일의 추가 수신자(참조) 주소. 요청 관리 모달에서 마지막으로 입력한 값을 티켓별로 기억한다.';
comment on column public.tickets.satisfaction_rating is '완료 건 만족도 별점(1~5). 요청 등록 고객이 완료 후 1회 제출.';
comment on column public.tickets.satisfaction_comment is '만족도 한줄평(선택, 최대 200자).';
comment on column public.tickets.rated_at is '만족도 제출 시각. 제출 후 수정 불가, 재오픈돼도 보존.';
comment on column public.tickets.assigned_to_name is '담당자 이름 스냅샷 — assigned_to 계정이 삭제(FK SET NULL)되어도 이력 표시를 위해 보존';
comment on column public.tickets.contract_id is '요청 등록자의 contract_id 스냅샷 — 계약 단위로 요청 목록을 스코프하기 위함. 조직(unit_id) 도입 후에는 폴백 경로.';
comment on column public.tickets.unit_id is '요청을 등록한 조직(org_units). 요청 목록 격리의 기준 — 계약이 갱신돼도 이 값은 바뀌지 않는다.';
comment on column public.tickets.unit_name is '조직명 스냅샷 — 조직이 이름을 바꾸거나 삭제돼도 과거 요청에 당시 조직명을 보존.';

-- ── 5. log_notification ──
create table public.log_notification (
  id                uuid primary key default gen_random_uuid(),
  ticket_id         uuid,
  channel           text not null,
  recipient         text not null,
  content           text,
  status            text not null default 'pending',
  error_message     text,
  sent_at           timestamptz default now(),
  created_at        timestamptz not null default now(),
  event_type        text,
  retry_count       integer not null default 0,
  is_test           boolean not null default false
);
comment on table public.log_notification is 'Slack / Outlook 알림 발송 이력';
comment on column public.log_notification.content is '발송한 메일 본문 HTML(이메일 알림 전용, 알림 로그 상세 미리보기용). 슬랙은 NULL';
comment on column public.log_notification.is_test is '테스트 알림 여부 — 하네스/QA가 만든 알림([테스트] 라벨·테스트 슬랙 채널·테스트 메일 sink)이면 true. 알림 로그 화면의 운영/테스트 탭 분리 기준.';

-- ── 6. content_documents ──
create table public.content_documents (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  description     text,
  category        text not null,
  product         text,
  file_name       text not null,
  file_size       bigint,
  storage_path    text not null,
  is_public       boolean not null default true,
  download_count  integer not null default 0,
  uploaded_by     uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.content_documents is '자료실 파일 (Storage 경로 참조)';

-- ── 7. ticket_history ──
create table public.ticket_history (
  id              uuid primary key default gen_random_uuid(),
  ticket_id       uuid not null,
  changed_by      uuid,
  action          text not null
                  check (action = any (array['created','status_changed','assigned','reassigned','message_added','attachment_added','memo_updated','completed','cancelled','visibility_changed','requester_changed','company_changed'])),
  field_name      text,
  old_value       text,
  new_value       text,
  note            text,
  created_at      timestamptz not null default now(),
  changed_by_name text
);
comment on table public.ticket_history is '티켓 변경 이력 (상태·담당자·답변 등 모든 변경 기록)';
comment on column public.ticket_history.action is '변경 유형';
comment on column public.ticket_history.old_value is '변경 전 값 (상태 변경 시: 이전 상태값)';
comment on column public.ticket_history.new_value is '변경 후 값 (상태 변경 시: 새 상태값)';
comment on column public.ticket_history.changed_by_name is '조치자 이름 스냅샷 — changed_by 계정이 삭제(FK SET NULL)되어도 이력 표시를 위해 보존';

-- ── 8. log_integration ──
create table public.log_integration (
  id           uuid primary key default gen_random_uuid(),
  system       text not null check (system = any (array['salesforce','slack','outlook','notion'])),
  action       text not null,
  direction    text not null check (direction = any (array['inbound','outbound'])),
  status       text not null check (status = any (array['success','failed','pending'])),
  request      jsonb,
  response     jsonb,
  error_message text,
  duration_ms  integer,
  created_at   timestamptz not null default now()
);
comment on table public.log_integration is 'Salesforce·Slack·Outlook·Notion 연동 성공/실패 이력';
comment on column public.log_integration.direction is 'inbound=외부→포탈 / outbound=포탈→외부';
comment on column public.log_integration.request is '외부 시스템으로 전송한 요청 데이터 (민감 정보 제외)';
comment on column public.log_integration.response is '외부 시스템 응답 데이터';

-- ── 9. ticket_replies ──
create table public.ticket_replies (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null,
  note        text not null,
  changed_by  uuid,
  created_at  timestamptz not null default now()
);

-- ── 10. ticket_memos ──
create table public.ticket_memos (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null,
  note        text not null,
  changed_by  uuid,
  created_at  timestamptz not null default now()
);

-- ── 11. ticket_attachments ──
create table public.ticket_attachments (
  id            uuid primary key default gen_random_uuid(),
  ticket_id     uuid not null,
  file_name     text not null,
  file_size     bigint,
  storage_path  text not null,
  mime_type     text,
  uploaded_by   uuid,
  created_at    timestamptz not null default now()
);

-- ── 12. company_licenses ──
create table public.company_licenses (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null,
  product_info  text not null,
  license_key   text,
  quantity      integer,
  license_type  text,
  status        text not null default '활성',
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  file_name     text,
  file_path     text,
  contract_id   uuid,
  start_date    date,
  end_date      date,
  renewal_date  date
);
comment on column public.company_licenses.contract_id is '사업부 등으로 계약이 나뉜 경우, 이 라이선스가 속한 계약(company_contracts). null이면 고객사 공통(계약 미지정) 라이선스.';
comment on column public.company_licenses.start_date   is '라이선스 시작일. 계약(company_contracts) 기간과 다를 수 있다.';
comment on column public.company_licenses.end_date     is '라이선스 만료일. 계약 기간과 다를 수 있다.';
comment on column public.company_licenses.renewal_date is '갱신을 완료해야 하는 날(기한). 실제 갱신 이력이 아니다.';

-- ── 13. content_notices ──
create table public.content_notices (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text,
  category    text not null default '안내',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── 14. role_permissions ──
create table public.role_permissions (
  id           uuid primary key default gen_random_uuid(),
  role         text not null
               check (role = any (array['customer','internal','tech_support','sales','education','admin'])),
  feature_key  text not null
               check (feature_key = any (array[
                 'ticket_view','ticket_create','ticket_delete','ticket_manage','ticket_correct',
                 'library_view','library_manage',
                 'company_view','company_manage',
                 'user_view','user_manage',
                 'integration','notify_log','permission',
                 'stats_view'
               ])),
  enabled      boolean not null default false,
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  unique (role, feature_key)
);
comment on table public.role_permissions is '역할별 메뉴/기능 접근 권한 (권한 관리 화면 백엔드)';

-- ── login_events (로그인 이벤트 로그 / 감사로그) ──
-- 사용 통계의 DAU/WAU/MAU + 로그인 이력 화면용. 로그인 성공 시 api-layer가 1행 insert(비차단).
-- 감사로그라 user_name/company_name을 로그인 시점 스냅샷으로 남기고, 사용자 삭제 시 user_id만
-- SET NULL 되어 이력(당시 이름 포함)은 보존된다(사용자 삭제도 FK로 막히지 않음).
-- 민감정보(전 사용자 접속시각)라 data-api ALLOWED_TABLES에 넣지 않고 GET /stats/* 로만 노출.
create table public.login_events (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references public.users(id) on delete set null,
  user_name    text,
  role         text,
  company_id   uuid,
  company_name text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_login_events_created on public.login_events (created_at desc);
create index if not exists idx_login_events_user    on public.login_events (user_id);

-- ── 15. org_units (조직) ──
-- 고객사 안에서 사업부·팀·최종고객 등으로 요청을 갈라 봐야 할 때 쓰는 단위.
-- 계약(company_contracts)은 연도마다 갱신되며 교체되지만 조직은 그대로 유지되므로,
-- 사용자와 티켓을 계약이 아니라 이 조직에 붙여서 갱신의 영향을 받지 않게 한다.
create table public.org_units (
  id          uuid primary key default gen_random_uuid(),
  unit_no     text not null,
  company_id  uuid not null,
  unit_name   text not null,
  status      text not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.org_units is '고객사 내 조직(사업부/팀/최종고객). 계약 갱신과 무관하게 유지되는 요청 격리 단위.';
comment on column public.org_units.unit_no is '조직 고유번호 (ORG-0001 형식). 화면에서 조직명과 함께 표시.';
comment on column public.org_units.status is 'active=사용 중. 조직 자체를 지우지 않고 상태로 관리.';

-- ── 16. user_org_units (사용자↔조직 배정, N:M) ──
-- 한 사용자가 여러 조직에 속할 수 있고(예: 겸직), 그중 하나를 대표 조직으로 지정한다.
create table public.user_org_units (
  user_id     uuid not null,
  unit_id     uuid not null,
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  id          uuid not null default gen_random_uuid(),
  primary key (user_id, unit_id),
  unique (id)
);
comment on table public.user_org_units is '사용자-조직 다중 배정. 요청 조회 범위는 배정된 조직 전체 + 본인이 등록한 요청.';
comment on column public.user_org_units.is_primary is '대표 조직. 요청 등록 시 기본으로 선택되는 조직.';
comment on column public.user_org_units.id is '행 지목용 대리키. 실제 유일성은 (user_id, unit_id) 복합 PK가 보장한다. data-api의 PATCH/DELETE가 /data/:table/:id 경로만 지원해서 추가됨(add-user-org-units-id.sql).';

-- ============================================================
-- 외래키 일괄 추가 (순환 참조 회피를 위해 테이블 생성 후 한번에)
-- ============================================================

alter table public.company_contracts
  add constraint contracts_company_id_fkey foreign key (company_id) references public.companies(id);

alter table public.users
  add constraint users_company_id_fkey foreign key (company_id) references public.companies(id),
  add constraint users_contract_id_fkey foreign key (contract_id) references public.company_contracts(id);

alter table public.tickets
  add constraint tickets_company_id_fkey  foreign key (company_id)  references public.companies(id),
  add constraint tickets_created_by_fkey  foreign key (created_by)  references public.users(id) on delete set null,
  add constraint tickets_assigned_to_fkey foreign key (assigned_to) references public.users(id) on delete set null,
  add constraint tickets_contract_id_fkey foreign key (contract_id) references public.company_contracts(id);

alter table public.log_notification
  add constraint notification_logs_ticket_id_fkey foreign key (ticket_id) references public.tickets(id);

alter table public.content_documents
  add constraint documents_uploaded_by_fkey foreign key (uploaded_by) references public.users(id) on delete set null;

alter table public.ticket_history
  add constraint ticket_history_ticket_id_fkey  foreign key (ticket_id)  references public.tickets(id),
  add constraint ticket_history_changed_by_fkey foreign key (changed_by) references public.users(id) on delete set null;

alter table public.ticket_replies
  add constraint ticket_replies_ticket_id_fkey  foreign key (ticket_id)  references public.tickets(id),
  add constraint ticket_replies_changed_by_fkey foreign key (changed_by) references public.users(id) on delete set null;

alter table public.ticket_memos
  add constraint ticket_memos_ticket_id_fkey  foreign key (ticket_id)  references public.tickets(id),
  add constraint ticket_memos_changed_by_fkey foreign key (changed_by) references public.users(id) on delete set null;

alter table public.ticket_attachments
  add constraint ticket_attachments_ticket_id_fkey  foreign key (ticket_id)   references public.tickets(id),
  add constraint ticket_attachments_uploaded_by_fkey foreign key (uploaded_by) references public.users(id) on delete set null;

alter table public.company_licenses
  add constraint licenses_company_id_fkey        foreign key (company_id)  references public.companies(id),
  add constraint company_licenses_contract_id_fkey foreign key (contract_id) references public.company_contracts(id);

alter table public.role_permissions
  add constraint role_permissions_updated_by_fkey foreign key (updated_by) references public.users(id);

-- 조직(org_units / user_org_units) — 사용자·티켓이 조직을 참조한다.
-- tickets.unit_id는 unit_name 스냅샷이 함께 있으므로 조직이 지워져도 과거 요청 표시가 유지된다.
alter table public.org_units
  add constraint org_units_company_id_fkey foreign key (company_id) references public.companies(id);

alter table public.user_org_units
  add constraint user_org_units_user_id_fkey foreign key (user_id) references public.users(id) on delete cascade,
  add constraint user_org_units_unit_id_fkey foreign key (unit_id) references public.org_units(id) on delete cascade;

alter table public.users
  add constraint users_unit_id_fkey foreign key (unit_id) references public.org_units(id);

alter table public.tickets
  add constraint tickets_unit_id_fkey foreign key (unit_id) references public.org_units(id);

-- ============================================================
-- 시퀀스 / 트리거 함수 / 트리거
-- (테이블 컬럼 introspection만으로는 안 잡히는 객체들 — pg_trigger로 재확인해서 추가)
-- ============================================================

create sequence if not exists public.ticket_seq;

create or replace function public.generate_ticket_number()
 returns trigger
 language plpgsql
as $function$
BEGIN
  NEW.ticket_number := 'TK-' || to_char(now(), 'YYYYMMDD') || '-'
                       || LPAD(CAST(nextval('ticket_seq') AS text), 4, '0');
  RETURN NEW;
END;
$function$;

create trigger trg_ticket_number
  before insert on public.tickets
  for each row execute function public.generate_ticket_number();

create or replace function public.update_updated_at()
 returns trigger
 language plpgsql
as $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

create or replace function public.update_updated_at_column()
 returns trigger
 language plpgsql
as $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

create trigger trg_companies_updated_at  before update on public.companies         for each row execute function public.update_updated_at();
create trigger trg_users_updated_at      before update on public.users             for each row execute function public.update_updated_at();
-- tickets는 전용 함수를 쓴다: 만족도 컬럼만 바뀐 갱신(평가 제출)은 updated_at을 올리지 않는다.
create or replace function public.tickets_bump_updated_at()
 returns trigger
 language plpgsql
as $fn$
BEGIN
  IF (to_jsonb(NEW) - 'satisfaction_rating' - 'satisfaction_comment' - 'rated_at' - 'updated_at')
     IS NOT DISTINCT FROM
     (to_jsonb(OLD) - 'satisfaction_rating' - 'satisfaction_comment' - 'rated_at' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$;
create trigger trg_tickets_updated_at    before update on public.tickets           for each row execute function public.tickets_bump_updated_at();
create trigger trg_documents_updated_at  before update on public.content_documents for each row execute function public.update_updated_at();
create trigger contracts_updated_at      before update on public.company_contracts for each row execute function public.update_updated_at_column();
create trigger licenses_updated_at       before update on public.company_licenses   for each row execute function public.update_updated_at_column();

create or replace function public.log_ticket_created()
 returns trigger
 language plpgsql
as $function$
BEGIN
  INSERT INTO ticket_history (ticket_id, changed_by, action, new_value)
  VALUES (NEW.id, NEW.created_by, 'created', NEW.status);
  RETURN NEW;
END;
$function$;

create trigger trg_ticket_history_created
  after insert on public.tickets
  for each row execute function public.log_ticket_created();

-- 참고: 원본에는 이 외에 tickets/ticket_history에 "on-ticket-change" /
-- "on-ticket-status-change" 트리거가 있는데, 이건 supabase_functions.http_request()로
-- notify-handler Edge Function을 직접 호출하는 Supabase 전용 메커니즘이라 RDS에는
-- 이식 불가. Phase 3/4(Lambda API 레이어)에서 티켓 생성/상태변경 API 안에서
-- 알림 발송 로직을 직접 호출하는 방식으로 대체 예정.

-- ============================================================
-- 참고: RLS는 원본에서 log_notification/ticket_history/log_integration/
-- ticket_attachments 4개 테이블만 켜져 있고 정책은 없음(사실상 무의미).
-- 나머지 10개는 RLS 자체가 꺼져있는 상태 — RDS에서는 애초에 브라우저가
-- DB에 직접 접근하지 않고 API 레이어를 거치므로 RLS 이전 불필요.
-- ============================================================

-- ============================================================
-- 성능 인덱스 (2026-08-12 추가) — FK/필터 컬럼. Postgres는 FK에 자동 인덱스를
-- 만들지 않아 테넌트 격리·티켓 상세·라이선스 조회가 seq scan이던 것을 index scan으로.
-- ============================================================
create index if not exists idx_tickets_unit_id on public.tickets (unit_id);
create index if not exists idx_tickets_company_id on public.tickets (company_id);
create index if not exists idx_tickets_created_by on public.tickets (created_by);
create index if not exists idx_tickets_assigned_to on public.tickets (assigned_to);
create index if not exists idx_tickets_contract_id on public.tickets (contract_id);
create index if not exists idx_tickets_status on public.tickets (status);
create index if not exists idx_tickets_due_date on public.tickets (due_date);
create index if not exists idx_ticket_replies_ticket_id on public.ticket_replies (ticket_id);
create index if not exists idx_ticket_memos_ticket_id on public.ticket_memos (ticket_id);
create index if not exists idx_ticket_attachments_ticket_id on public.ticket_attachments (ticket_id);
create index if not exists idx_ticket_history_ticket_id on public.ticket_history (ticket_id);
create index if not exists idx_log_notification_ticket_id on public.log_notification (ticket_id);
create index if not exists idx_log_notification_is_test on public.log_notification (is_test);
create index if not exists idx_user_org_units_user_id on public.user_org_units (user_id);
create index if not exists idx_user_org_units_unit_id on public.user_org_units (unit_id);
create index if not exists idx_users_company_id on public.users (company_id);
create index if not exists idx_users_unit_id on public.users (unit_id);
create index if not exists idx_users_contract_id on public.users (contract_id);
create index if not exists idx_company_contracts_company_id on public.company_contracts (company_id);
create index if not exists idx_company_licenses_company_id on public.company_licenses (company_id);
create index if not exists idx_company_licenses_contract_id on public.company_licenses (contract_id);

-- ── account_inquiries (2026-08-14) ──
-- 로그인 전(비인증) "담당자에게 문의" 폼 접수 내역. 공개 엔드포인트
-- POST /public/account-inquiry → Lambda customer_portal_public-inquiry가 insert.
-- data-api ALLOWED_TABLES에는 아직 미등록(관리자 조회 화면은 Phase 2).
create table if not exists public.account_inquiries (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  company     text,
  phone       text,
  email       text,
  message     text,
  status      text not null default 'new' check (status in ('new','handled','spam')),
  handled_by  uuid,
  handled_at  timestamptz,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_account_inquiries_created on public.account_inquiries (created_at desc);

-- ── document_downloads (자료 다운로드 이벤트 로그, 2026-08-31) ──
-- 자료실 통계의 "누가 받았나"용. content_documents.download_count는 누적 카운터일 뿐이라
-- 주체·시각이 남지 않아서, 다운로드 시 api-layer(POST /docs/download-event)가 카운터 증가와
-- 함께 1행을 남긴다. login_events와 같은 스냅샷 패턴 — 사용자·자료가 삭제돼도 이력은 보존.
-- 기록 시작 이전의 누적 다운로드는 주체를 알 수 없다(소급 불가).
create table if not exists public.document_downloads (
  id           uuid primary key default gen_random_uuid(),
  doc_id       uuid not null,
  doc_title    text,
  user_id      uuid,
  user_name    text,
  role         text,
  company_id   uuid,
  company_name text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_document_downloads_doc     on public.document_downloads (doc_id);
create index if not exists idx_document_downloads_created on public.document_downloads (created_at desc);
create index if not exists idx_document_downloads_user    on public.document_downloads (user_id);
