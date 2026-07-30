# Phase 0 — 현황 Export 요약

Supabase project `ozmuxppuyuyhojmdiism` (PostgreSQL 17.6) 기준.

## 1. DB 스키마 (14개 테이블)

| 테이블 | 행 수 | 용도 |
|---|---:|---|
| companies | 397 | 고객사 기본 정보 |
| users | 89 | 포탈 사용자 |
| tickets | 170 | 기술지원 요청 티켓 |
| company_contracts | 1,219 | 계약 정보 |
| company_licenses | 2,261 | 라이선스 정보 |
| ticket_history | 490 | 티켓 변경 이력 |
| log_notification | 480 | Slack/Outlook 알림 발송 이력 |
| log_integration | 52 | Salesforce 등 외부 연동 이력 |
| content_documents | 28 | 자료실 파일 메타 |
| ticket_memos | 38 | 내부 메모 |
| ticket_replies | 33 | 고객 회신 |
| ticket_attachments | 19 | 티켓 첨부파일 메타 |
| content_notices | 11 | 공지사항 |
| role_permissions | 72 | 역할별 권한 (6개 역할 × 12개 기능) |

→ 전체 CREATE TABLE + FK DDL: `schema.sql` (RDS에 그대로 실행 가능하도록 작성, 순환참조 회피를 위해 FK는 마지막에 일괄 추가)

**보안 참고**: 14개 중 4개(`log_notification`,`ticket_history`,`log_integration`,`ticket_attachments`)만 RLS 켜져있고 정책은 없음(사실상 무의미), 나머지 10개는 RLS 자체가 꺼져있어 anon key로 전체 접근 가능한 상태. RDS 이전 후에는 브라우저가 DB에 직접 붙지 않고 API 레이어(Lambda)를 거치게 되므로, 접근 제어는 RLS 대신 **API 레이어에서 구현**하면 됩니다 — 오히려 지금보다 나아지는 지점입니다.

## 2. Storage (3개 버킷)

| 버킷 | 공개여부 | 파일 수 | 용량 |
|---|---|---:|---:|
| documents | 공개 | 17 | 5.4 MB |
| ticket-attachments | 공개 | 30 | 13.7 MB |
| contract-attachments | 비공개 | 8 | 0.68 MB |

→ 총 55개 파일, 약 19.8 MB — 규모가 작아서 마이그레이션 자체는 간단합니다 (S3로 다운로드 후 업로드하는 스크립트 하나로 충분).

**S3 매핑 방향**:
- `documents`, `ticket-attachments` → 공개 버킷 정책 (지금처럼 `getPublicUrl` 대응)
- `contract-attachments` → 비공개, presigned URL 방식 (`createSignedUrl` 대응)

## 3. Edge Functions

| 함수 | 용도 | 외부 연동 |
|---|---|---|
| `notify-handler` | 티켓 이벤트별 Slack 알림 (신규/긴급/담당자배정/상태변경/지연) | Slack Webhook (공통/영업/기술지원/교육 4채널) |
| `send-email` | 티켓 이벤트별 이메일 발송 (접수확인/상태변경/영업알림/긴급알림) | Microsoft Graph API |

→ 원본 소스 그대로 저장: `edge-functions/notify-handler.ts`, `edge-functions/send-email.ts`
→ 둘 다 Deno 런타임 코드라, Lambda로 옮길 때 Node.js로 재작성 필요 (로직 자체는 fetch 기반이라 이식 어렵지 않음)

**제외 확정**: `test-salesforce-jwt`, `sf-introspect-temp`, `sf-soql-temp`, `doc-upload-temp` — 실험/테스트용 함수로 확인되어 마이그레이션 대상에서 제외.

## 4. 확인 불필요 항목
- **Realtime**: 코드에서 전혀 사용 안 함
- **Auth(GoTrue)**: 전혀 사용 안 함 (users 테이블에 자체 password 컬럼으로 커스텀 로그인) — Cognito 등으로 옮길 필요 없음

---
다음 단계(Phase 1: RDS)로 넘어가도 될까요? 그 전에 위 "4개 temp 함수 제외" 여부만 확인 부탁드립니다.
