# 고객지원포탈 프로젝트 규칙

## 프로젝트 개요

- **목적:** 빅스데이터 주식회사 B2B 고객지원 포탈 (약 397개 고객사)
- **상태:** 운영 중 (2026-07-31 기준)
- **백엔드:** Supabase → **AWS로 마이그레이션 완료** (RDS + Lambda + API Gateway). Supabase(`ozmuxppuyuyhojmdiism`)는 마이그레이션 이전 데이터 소스였던 레거시 프로젝트로, 더 이상 운영 백엔드가 아님 — 실 데이터 확인은 RDS/API 기준으로 할 것.

---

## GitHub / 배포 구성

배포는 Vercel → AWS Amplify Hosting으로 전환됨 (`amplify.yml` 참고).

| 구분 | GitHub repo | 브랜치 | 배포 URL | Amplify App ID |
|------|-------------|--------|------------|-----------------|
| 운영 | sjlee-collab/Customer_portal | main | https://support.bigxdata.io/ | `d197cwv814vb95` (Customer_portal) |
| 개발 | sjlee-collab/Customer_portal | dev | https://dev.dlayoierdftk6.amplifyapp.com/ | `dlayoierdftk6` (Customer_portal_DEV) |

- 로컬 git remote: `origin` → `sjlee-collab/Customer_portal`
- 메인 소스 파일: 루트 `index.html` (6800+ 라인, 단일 HTML SPA, 빌드 단계 없이 그대로 배포)

---

## AWS 인프라

- **계정:** 605163667429 / **리전:** ap-northeast-2 (서울)
- **RDS:** 인스턴스 식별자 `csdb` (PostgreSQL 18.3, DB명 `customer_portal`), 엔드포인트 `csdb.cngoihiekj6q.ap-northeast-2.rds.amazonaws.com:5432`. 기본적으로 퍼블릭 액세스 꺼짐 + 보안그룹(`sg-034f2d418a20a6f95`)에서 특정 IP만 허용. 마스터 비밀번호는 Secrets Manager 관리형 시크릿(`rds!db-...`).
- **API Gateway:** `https://8xbmazu4ij.execute-api.ap-northeast-2.amazonaws.com` — index.html의 `API_BASE`가 이 주소를 호출.
  - `/data/:table` — `data-api` Lambda, PostgREST 흉내낸 범용 CRUD (허용 테이블 16개, `aws-migration/lambda/data-api/index.mjs` 참고)
  - 티켓 생성/상태변경 등 알림이 걸리는 액션 — `api-layer` Lambda
- **Lambda 배포 함수명 매핑(소스 폴더 ↔ 실제 함수명 다름 주의):** `aws-migration/lambda/data-api` → `customer_portal_data-api` · `jwt-authorizer` → `customer_portal_jwt-authorizer` · `storage-api` → `customer_portal_storage-api` · `notify-handler` → `customer_portal_notify-handler` · `send-email` → `customer_portal_send-email` · **`api-layer` → `customer-portal_slack_status_change`**(이름이 안 맞음).
  - ⚠️ **api-layer 재배포 시 소스 4개(`index.mjs`·`db.mjs`·`notify.mjs`·`jwt.mjs`)를 모두 zip에 넣어야 한다.** `index.mjs`만 교체하면 `db.mjs`의 `withTransaction` 등 누락으로 **로그인 전체 순단**이 난다(2026-08-12 실제 발생). data-api/jwt-authorizer도 각자 소스 파일 전체 동봉.
- **보안 헤더 / CSP:** 레포 루트 `customHttp.yml`이 Amplify에 적용됨 — `default-src/script-src/style-src/font-src 'self'`, img/connect는 API GW·S3 버킷만 허용. 즉 **외부 CDN 폰트·스크립트는 CSP로 차단**되므로 자체 호스팅 또는 인라인(+필요 시 `data:` 허용) 해야 한다. (artifacts와 무관, 운영 사이트 한정)
  - `/storage/*` — `storage-api` Lambda (S3 presigned URL 발급)
  - `/functions/:fnName` — `notify-handler`(Slack), `send-email`(Outlook/MS Graph API) Lambda 호출
- **S3 버킷:** `bigxdata-portal-contract-attachments`, `bigxdata-portal-documents`, `bigxdata-portal-ticket-attachments`
- **스키마/Lambda 소스:** 레포 내 `aws-migration/schema.sql`, `aws-migration/lambda/{api-layer,data-api,notify-handler,send-email,storage-api}/`
- **IAM 사용자:** `customer_portal` (CLI 연동용, 세션마다 자격증명 발급받아 사용)
- **샌드박스 네트워크 제약:** 원격 세션 환경은 443(HTTPS) 아웃바운드만 허용되고 5432 등 다른 포트는 막혀있어 RDS 직접 psql 접속 불가 — DB 데이터 확인은 위 API Gateway(`/data/:table`)를 통해 할 것. 로컬 세션에서는 이 제약이 없음.

---

## 필수 규칙

### 1. index.html 수정 후 자동 배포
수정 완료 즉시 **확인 없이** git add → commit → push 자동 진행.
- 푸시 대상: `sjlee-collab/Customer_portal` (현재 브랜치 기준)

### 2. DB 연동 필수
모든 화면 변경(생성/수정/삭제/상태변경)은 반드시 **RDS(위 API Gateway 경유)에 실제 반영**해야 한다.
- 로컬 상태만 업데이트하는 방식 금지
- 저장 후 해당 데이터를 다시 fetch해서 UI 갱신
- 관련 테이블(총 16개, `data-api`의 `ALLOWED_TABLES` 기준): `companies`, `company_contracts`, `company_licenses`, `users`, `tickets`, `log_notification`, `content_documents`, `ticket_history`, `log_integration`, `ticket_replies`, `ticket_memos`, `ticket_attachments`, `content_notices`, `role_permissions`, `org_units`, `user_org_units`
- `org_units`(조직)·`user_org_units`(사용자↔조직 N:M)·`ticket_memos`·`log_integration`은 **스태프 전용**이라 고객/내부 역할로는 조회조차 안 된다(`data-api`의 `STAFF_ONLY_TABLES`). 고객 화면에서 조직 정보가 필요하면 JWT의 `unit_ids` 클레임과 `tickets.unit_name` 스냅샷을 쓴다.

### 3. 개발현황.html 수정 금지
이 채팅에서 진척 보고 요청이 와도 `개발현황.html` 파일은 건드리지 않는다.
텍스트/마크다운으로만 응답. 파일 반영은 사용자가 명시적으로 요청할 때만.

---

## 기술 스택

- **Frontend:** 바닐라 JS, 단일 HTML 파일 SPA (Supabase 클라이언트 제거 완료, AWS API Gateway 직접 호출)
- **DB:** Amazon RDS (PostgreSQL 18.3). 성능 인덱스 20개(FK/필터 컬럼 — tickets.unit_id/company_id/created_by/status/due_date, 부속테이블 ticket_id, user_org_units, users, contracts/licenses) 2026-08-12 추가(schema.sql 하단). FK엔 자동 인덱스가 없어 seq scan이던 조회를 index scan으로 전환.
- **API:** API Gateway + Lambda (`data-api`=범용 CRUD, `api-layer`=알림 연계 액션, `storage-api`=S3 업로드, `notify-handler`/`send-email`=알림·메일 발송)
- **자동화:** EventBridge Scheduler 3개가 매일 KST 09:00에 `api-layer` Lambda를 직접 호출 — `daily-overdue-ticket-check`(`overdue_batch`, 지연 티켓 Slack 알림), `daily-license-expiry-notice`(`license_expiry_notice`), `daily-contract-expiry-check`(`expire_contracts`). 레거시 Supabase pg_cron 잡 2개는 중복 알람을 일으켜 2026-08-11에 모두 제거함(unschedule) — 레거시 쪽에는 더 이상 크론 없음.

## Slack 웹훅 환경변수

| 변수명 | 채널 | 비고 |
|--------|------|------|
| `SLACK_WEEBHOOK_COMMON` | 공통 | **오타 주의** (WEEBHOOK) |
| `SLACK_WEBHOOK_SALES` | 영업 | contract/license/education |
| `SLACK_WEBHOOK_TECH` | 기술지원 | tech_support |

---

## 구현 완료 기능

- 티켓 관리 (등록/조회/상태변경/담당자배정)
- Slack 알림: 신규등록/긴급/담당자배정/상태변경/완료예정일초과
- 권한 관리 화면 (역할×기능 매트릭스, `data-roles="admin"` — 관리자만 표시)
- 공지사항, 자료실, 고객사/사용자 관리, 연동 관리, 알림 로그
- **AWS 마이그레이션** (Supabase → RDS/Lambda/API Gateway/S3/Amplify), 고객사 업종 분류(397개), 계약/라이선스 UI 개선(라이선스 모델·유형, 접기/펼치기 등)
- **조직(org_units) 도입** (2026-08-12): 회사 → 조직(사업부/부서/팀) → 계약 3계층. 조직 시드는 엑셀 "고객지원포탈" 시트 부서 컬럼 기준(계약별). 사용자는 조직 **다중 배정**(`user_org_units` N:M, `is_primary`=대표), 티켓 가시성은 JWT `unit_ids` 기반(`unit_id = ANY` + `created_by` 폴백), `tickets.unit_id`+`unit_name` 스냅샷. 사용자 폼=조직 인라인 체크리스트, 계약 폼=조직 선택(+즉석 생성). 고객 계정 일괄 등록·계약명 동일고객사 중복방지 포함.
- **제품 목록 통일** (2026-08-12): 고객사 사용제품·라이선스 제품 목록을 `Tableau Server / Cloud Enterprise / Cloud Standard / Cloud Plus / Tableau Plus / Tableau Next` + `DataWorks`·`AgentWorks`로 통일(Tableau Desktop 제거, 표기 DataWorks). 구 `products='Tableau Cloud'` 153개사 → `Tableau Cloud Standard` 일괄 변경. ⚠️ `company_licenses.product_info`는 초기 임포트분이 **축약형(`Server`/`Cloud`)**, 폼 입력분은 전체이름으로 **혼재**(에디션 정보 없음) — 그룹핑 시 주의.

## 대기 중 작업

- 노션 기술지원 내역 → 포탈 배치 연동 (노션 DB 구조 확인 필요)
- **안 쓰는 DB 컬럼 정리 — 완료** (2026-07-31 조사 → 2026-08-12 실행):
  - **[2026-08-12 운영 RDS DROP 완료, 총 11개]** 코드·스키마의존 0으로 확인된 컬럼 삭제:
    - 데이터도 0이던 9개: `companies.email_domain/industry/notes/environment_info`, `company_contracts.document_url`, `tickets.internal_memo/salesforce_case_id`, `content_documents.file_type`, `log_integration.reference_id`.
    - 데이터 있었으나 코드 미사용이라 백업 후 삭제한 2개: `users.division`(내부직원 소속 38건 → `scratchpad/itest/dropped-columns-backup.json`), `log_notification.notification_type`(기본값 'Slack' 위주 866건 → `backup-notification_type.json`).
  - 실행: VPC 프라이빗이라 data-api와 동일 VPC/역할의 일회용 마이그레이션 Lambda로 DROP 후 함수 삭제. 사전 레거시DB DROP+ROLLBACK로 의존성 0 실증, RDS CRUD 무영향 확인. schema.sql 갱신됨.
  - 참고: `company_licenses.license_key`는 2026-08-06 기능 추가로 사용 중(삭제 금지). 미사용 개념의 실제 대체: 업종→`companies.customer_type`, 환경→`products`, 알림유형→`channel`+`event_type`, 내부메모→`ticket_memos` 테이블, 계약문서→S3 첨부(`file_path`).
