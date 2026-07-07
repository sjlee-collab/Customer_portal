-- ============================================================
-- 고객지원 포탈 DB 스키마
-- 버전: 1.0
-- 작성일: 2026-06-26
-- 대상: Supabase (PostgreSQL)
-- 실행: Supabase 대시보드 > SQL Editor 에서 전체 복사 후 Run
-- ============================================================


-- ────────────────────────────────────────
-- 1. 고객사 (companies)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS companies (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text        NOT NULL,
  email_domain    text,
  salesforce_id   text,
  status          text        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'expiring_soon', 'expired', 'inactive')),
  contract_type   text        CHECK (contract_type IN ('enterprise', 'standard', 'starter')),
  contract_start  date,
  contract_end    date,
  total_seats     int,
  used_seats      int         NOT NULL DEFAULT 0,
  support_tier    text        CHECK (support_tier IN ('priority', 'standard', 'basic')),
  account_manager text,
  industry        text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE companies IS '고객사 기본 정보';


-- ────────────────────────────────────────
-- 2. 사용자 (users)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid        REFERENCES companies(id) ON DELETE SET NULL,
  email       text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  role        text        NOT NULL DEFAULT 'customer'
                          CHECK (role IN ('customer', 'internal', 'tech_support', 'sales', 'admin')),
  phone       text,
  department  text,
  is_active   boolean     NOT NULL DEFAULT true,
  last_login  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  users           IS '포탈 사용자 (고객사 담당자 및 내부 직원)';
COMMENT ON COLUMN users.role      IS 'customer=고객사 사용자 / internal=내부 일반 / tech_support=기술지원 담당 / sales=영업 담당 / admin=시스템 관리자';
COMMENT ON COLUMN users.is_active IS '계정 활성 여부 (비활성=로그인 불가)';


-- ────────────────────────────────────────
-- 3. 기술지원 티켓 (tickets)
-- ────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS ticket_seq START 1;

CREATE TABLE IF NOT EXISTS tickets (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number      text        NOT NULL UNIQUE DEFAULT '',
  company_id         uuid        REFERENCES companies(id) ON DELETE SET NULL,
  created_by         uuid        REFERENCES users(id) ON DELETE SET NULL,
  assigned_to        uuid        REFERENCES users(id) ON DELETE SET NULL,
  title              text        NOT NULL,
  description        text,
  category           text        NOT NULL
                                 CHECK (category IN (
                                   'tech_support',  -- 기술지원
                                   'contract',      -- 계약 문의
                                   'license',       -- 라이선스 문의
                                   'education',     -- 교육 문의
                                   'customer',      -- 고객 문의
                                   'other'          -- 기타 문의
                                 )),
  product            text,
  priority           text        NOT NULL DEFAULT 'normal'
                                 CHECK (priority IN ('normal', 'high', 'critical')),
  status             text        NOT NULL DEFAULT 'received'
                                 CHECK (status IN (
                                   'received',       -- 접수됨
                                   'classifying',    -- 분류 중
                                   'in_progress',    -- 처리 중
                                   'pending_customer', -- 고객 확인 요청
                                   'on_hold',        -- 보류
                                   'completed',      -- 완료
                                   'cancelled'       -- 취소
                                 )),
  internal_memo      text,
  salesforce_case_id text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE tickets IS '고객 기술지원 요청 티켓';
COMMENT ON COLUMN tickets.internal_memo IS '내부 전용 메모 — 고객 화면에 절대 노출 금지';

-- 티켓 번호 자동 생성 (예: TK-20260626-0001)
CREATE OR REPLACE FUNCTION generate_ticket_number()
RETURNS TRIGGER AS $$
BEGIN
  NEW.ticket_number := 'TK-' || to_char(now(), 'YYYYMMDD') || '-'
                       || LPAD(CAST(nextval('ticket_seq') AS text), 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_ticket_number
  BEFORE INSERT ON tickets
  FOR EACH ROW
  EXECUTE FUNCTION generate_ticket_number();


-- ────────────────────────────────────────
-- 4. 티켓 메시지 (ticket_messages)
--    고객 ↔ 담당자 대화 이력
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_messages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid        NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender_id   uuid        REFERENCES users(id) ON DELETE SET NULL,
  sender_type text        NOT NULL CHECK (sender_type IN ('customer', 'internal', 'system')),
  content     text        NOT NULL,
  is_internal boolean     NOT NULL DEFAULT false,  -- true=내부 메모(고객 비노출)
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  ticket_messages             IS '티켓 대화 메시지';
COMMENT ON COLUMN ticket_messages.is_internal IS 'true이면 내부 메모 — 고객 화면에 노출 금지';


-- ────────────────────────────────────────
-- 5. 첨부파일 (attachments)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attachments (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    uuid        REFERENCES tickets(id) ON DELETE CASCADE,
  uploaded_by  uuid        REFERENCES users(id) ON DELETE SET NULL,
  file_name    text        NOT NULL,
  file_size    bigint,
  file_type    text,
  storage_path text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE attachments IS '티켓 첨부파일 (Supabase Storage 경로 참조)';


-- ────────────────────────────────────────
-- 6. 알림 로그 (notification_logs)
--    Slack / Outlook 발송 이력
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_logs (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id         uuid        REFERENCES tickets(id) ON DELETE SET NULL,
  channel           text        NOT NULL CHECK (channel IN ('slack', 'email')),
  notification_type text        NOT NULL,  -- 'new_ticket', 'status_changed', 'completed' 등
  recipient         text        NOT NULL,
  content           text,
  status            text        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'sent', 'failed')),
  error_message     text,
  sent_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE notification_logs IS 'Slack / Outlook 알림 발송 이력';


-- ────────────────────────────────────────
-- 7. 자료실 (documents)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS documents (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text        NOT NULL,
  description    text,
  category       text        NOT NULL,  -- 'deploy_guide', 'training', 'release_note', 'api_doc', 'template' 등
  product        text,
  file_name      text        NOT NULL,
  file_size      bigint,
  file_type      text,
  storage_path   text        NOT NULL,
  is_public      boolean     NOT NULL DEFAULT true,
  download_count int         NOT NULL DEFAULT 0,
  uploaded_by    uuid        REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE documents IS '자료실 파일 (Supabase Storage 경로 참조)';


-- ────────────────────────────────────────
-- 공통: updated_at 자동 갱신 트리거
-- ────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_companies_updated_at
  BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_tickets_updated_at
  BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE TRIGGER trg_documents_updated_at
  BEFORE UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ────────────────────────────────────────
-- RLS (Row Level Security) 활성화
-- 고객사별 데이터 접근 분리 필수
-- ────────────────────────────────────────
ALTER TABLE companies          ENABLE ROW LEVEL SECURITY;
ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets            ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_messages    ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_logs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents          ENABLE ROW LEVEL SECURITY;


-- ────────────────────────────────────────
-- 카테고리 CHECK 제약 변경 마이그레이션
-- 기존 테이블에 이미 tickets가 있는 경우 실행
-- ────────────────────────────────────────
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_category_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_category_check
  CHECK (category IN (
    'tech_support', 'contract', 'license', 'education', 'customer', 'other'
  ));


-- ────────────────────────────────────────
-- ⚠️  개발용 임시 RLS 정책 — 운영 배포 전 반드시 삭제
-- ────────────────────────────────────────
CREATE POLICY "dev_all_companies"         ON companies         FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "dev_all_users"             ON users             FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "dev_all_tickets"           ON tickets           FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "dev_all_ticket_messages"   ON ticket_messages   FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "dev_all_attachments"       ON attachments       FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "dev_all_notification_logs" ON notification_logs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "dev_all_documents"         ON documents         FOR ALL USING (true) WITH CHECK (true);
