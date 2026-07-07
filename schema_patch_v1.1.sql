-- ============================================================
-- 고객지원 포탈 DB 스키마 보완 패치
-- 버전: 1.1
-- 작성일: 2026-06-29
-- 대상: Supabase (PostgreSQL)
-- 실행: schema.sql 실행 후 이 파일을 SQL Editor에서 실행
-- ============================================================


-- ────────────────────────────────────────
-- 1. companies 컬럼 추가
--    담당 기술지원, 제품 정보, 고객사 환경 정보
-- ────────────────────────────────────────
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS tech_support_manager text,
  ADD COLUMN IF NOT EXISTS products             text[],   -- 예: ARRAY['Tableau Server', 'ArcGIS']
  ADD COLUMN IF NOT EXISTS environment_info     jsonb;    -- 예: {"os": "Windows", "version": "2023.1"}

COMMENT ON COLUMN companies.tech_support_manager IS '담당 기술지원 담당자명';
COMMENT ON COLUMN companies.products             IS '계약 제품 목록 (배열)';
COMMENT ON COLUMN companies.environment_info     IS '고객사 환경 정보 (자유 형식 JSON)';


-- ────────────────────────────────────────
-- 2. attachments 컬럼 추가
--    다운로드 권한
-- ────────────────────────────────────────
ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS access_level text NOT NULL DEFAULT 'all'
    CHECK (access_level IN (
      'all',       -- 고객·내부 모두 접근 가능
      'internal',  -- 내부 직원만 접근 가능
      'completed'  -- 처리 완료 후에만 고객 접근 가능
    ));

COMMENT ON COLUMN attachments.access_level IS '다운로드 권한: all=전체 / internal=내부만 / completed=완료 후 고객 허용';


-- ────────────────────────────────────────
-- 3. ticket_history 테이블 신규 생성
--    요청 이력: 상태 변경, 담당자 변경, 답변 등록 등 모든 변경 기록
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_history (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     uuid        NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  changed_by    uuid        REFERENCES users(id) ON DELETE SET NULL,
  action        text        NOT NULL
                            CHECK (action IN (
                              'created',          -- 티켓 생성
                              'status_changed',   -- 상태 변경
                              'assigned',         -- 담당자 배정
                              'reassigned',       -- 담당자 변경
                              'message_added',    -- 답변/메시지 등록
                              'attachment_added', -- 첨부파일 추가
                              'memo_updated',     -- 내부 메모 수정
                              'completed',        -- 완료 처리
                              'cancelled'         -- 취소 처리
                            )),
  field_name    text,       -- 변경된 필드명 (예: 'status', 'assigned_to')
  old_value     text,       -- 변경 전 값
  new_value     text,       -- 변경 후 값
  note          text,       -- 변경 시 추가 메모
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  ticket_history            IS '티켓 변경 이력 (상태·담당자·답변 등 모든 변경 기록)';
COMMENT ON COLUMN ticket_history.action     IS '변경 유형';
COMMENT ON COLUMN ticket_history.old_value  IS '변경 전 값 (상태 변경 시: 이전 상태값)';
COMMENT ON COLUMN ticket_history.new_value  IS '변경 후 값 (상태 변경 시: 새 상태값)';

ALTER TABLE ticket_history ENABLE ROW LEVEL SECURITY;

-- 티켓 생성 시 자동으로 history 기록
CREATE OR REPLACE FUNCTION log_ticket_created()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO ticket_history (ticket_id, changed_by, action, new_value)
  VALUES (NEW.id, NEW.created_by, 'created', NEW.status);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_ticket_history_created
  AFTER INSERT ON tickets
  FOR EACH ROW
  EXECUTE FUNCTION log_ticket_created();

-- 티켓 상태·담당자 변경 시 자동으로 history 기록
CREATE OR REPLACE FUNCTION log_ticket_changed()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status <> NEW.status THEN
    INSERT INTO ticket_history (ticket_id, action, field_name, old_value, new_value)
    VALUES (NEW.id, 'status_changed', 'status', OLD.status, NEW.status);
  END IF;

  IF (OLD.assigned_to IS DISTINCT FROM NEW.assigned_to) THEN
    INSERT INTO ticket_history (ticket_id, action, field_name, old_value, new_value)
    VALUES (
      NEW.id,
      CASE WHEN OLD.assigned_to IS NULL THEN 'assigned' ELSE 'reassigned' END,
      'assigned_to',
      OLD.assigned_to::text,
      NEW.assigned_to::text
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_ticket_history_changed
  AFTER UPDATE ON tickets
  FOR EACH ROW
  EXECUTE FUNCTION log_ticket_changed();


-- ────────────────────────────────────────
-- 4. integration_logs 테이블 신규 생성
--    Salesforce / Outlook / Slack 연동 성공·실패 이력
--    (notification_logs는 알림 발송 이력, 이것은 시스템 연동 이력)
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS integration_logs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  system       text        NOT NULL
                           CHECK (system IN ('salesforce', 'slack', 'outlook', 'notion')),
  action       text        NOT NULL,  -- 예: 'sync_company', 'create_case', 'send_notification'
  direction    text        NOT NULL
                           CHECK (direction IN ('inbound', 'outbound')),
  status       text        NOT NULL
                           CHECK (status IN ('success', 'failed', 'pending')),
  reference_id text,       -- 연동 대상 ID (티켓 ID, 고객사 ID 등)
  request      jsonb,      -- 외부 시스템으로 보낸 요청 데이터
  response     jsonb,      -- 외부 시스템 응답 데이터
  error_message text,
  duration_ms  int,        -- 처리 소요 시간 (ms)
  created_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  integration_logs           IS 'Salesforce·Slack·Outlook·Notion 연동 성공/실패 이력';
COMMENT ON COLUMN integration_logs.direction IS 'inbound=외부→포탈 / outbound=포탈→외부';
COMMENT ON COLUMN integration_logs.request   IS '외부 시스템으로 전송한 요청 데이터 (민감 정보 제외)';
COMMENT ON COLUMN integration_logs.response  IS '외부 시스템 응답 데이터';

ALTER TABLE integration_logs ENABLE ROW LEVEL SECURITY;
