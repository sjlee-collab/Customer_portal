-- ============================================================
-- Customer_portal Supabase → RDS 마이그레이션용 스키마
-- 원본: Supabase project ozmuxppuyuyhojmdiism (PostgreSQL 17.6)
-- 생성일: Phase 0 export
-- 순서: 전체 테이블 생성(FK 없이) → 마지막에 FK 일괄 추가 (순환 참조 회피)
-- ============================================================

-- ── 1. companies ──
create table public.companies (
  id                        uuid primary key default gen_random_uuid(),
  name                      text not null,
  email_domain              text,
  salesforce_id             text,
  status                    text not null default 'active'
                            check (status = any (array['active','expiring_soon','expired','inactive'])),
  account_manager           text,
  industry                  text,
  notes                     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  tech_support_manager      text,
  products                  text[],
  environment_info          jsonb,
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
  document_url      text,
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
  division      text,
  password      text,
  contract_id   uuid
);
comment on table public.users is '포탈 사용자 (고객사 담당자 및 내부 직원)';
comment on column public.users.role is 'customer=고객사 사용자 / internal=내부 일반 / tech_support=기술지원 담당 / sales=영업 담당 / education=교육 담당 / admin=시스템 관리자';
comment on column public.users.is_active is '계정 활성 여부 (비활성=로그인 불가)';
comment on column public.users.division is '소속 본부 (본사, 세일즈본부, 컨설팅본부, 기술연구소_DATA&AI, 경영지원)';
comment on column public.users.contract_id is '사업부 등으로 계약이 나뉜 고객사의 경우, 이 사용자가 속한 계약(company_contracts). null이면 회사 전체 공유(기존 방식).';

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
  internal_memo       text,
  salesforce_case_id  text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  due_date            date,
  assigned_to_name    text,
  contract_id         uuid,
  company_name        text,
  created_by_name     text
);
comment on table public.tickets is '고객 기술지원 요청 티켓';
comment on column public.tickets.internal_memo is '내부 전용 메모 — 고객 화면에 절대 노출 금지';
comment on column public.tickets.assigned_to_name is '담당자 이름 스냅샷 — assigned_to 계정이 삭제(FK SET NULL)되어도 이력 표시를 위해 보존';
comment on column public.tickets.contract_id is '요청 등록자의 contract_id 스냅샷 — 계약 단위로 요청 목록을 스코프하기 위함.';

-- ── 5. log_notification ──
create table public.log_notification (
  id                uuid primary key default gen_random_uuid(),
  ticket_id         uuid,
  channel           text not null,
  notification_type text default 'Slack',
  recipient         text not null,
  content           text,
  status            text not null default 'pending',
  error_message     text,
  sent_at           timestamptz default now(),
  created_at        timestamptz not null default now(),
  event_type        text,
  retry_count       integer not null default 0
);
comment on table public.log_notification is 'Slack / Outlook 알림 발송 이력';

-- ── 6. content_documents ──
create table public.content_documents (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  description     text,
  category        text not null,
  product         text,
  file_name       text not null,
  file_size       bigint,
  file_type       text,
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
                  check (action = any (array['created','status_changed','assigned','reassigned','message_added','attachment_added','memo_updated','completed','cancelled'])),
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
  reference_id text,
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
                 'ticket_view','ticket_create','ticket_manage',
                 'library_view','library_manage',
                 'company_view','company_manage',
                 'user_view','user_manage',
                 'integration','notify_log','permission'
               ])),
  enabled      boolean not null default false,
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  unique (role, feature_key)
);
comment on table public.role_permissions is '역할별 메뉴/기능 접근 권한 (권한 관리 화면 백엔드)';

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
create trigger trg_tickets_updated_at    before update on public.tickets           for each row execute function public.update_updated_at();
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
