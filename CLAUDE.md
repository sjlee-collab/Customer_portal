# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 고객지원포탈 프로젝트 규칙

## 프로젝트 개요

- **목적:** 빅스데이터 주식회사 B2B 고객지원 포탈 (약 397개 고객사)
- **상태:** 운영 중 (2026-07-31 기준)
- **백엔드:** Supabase → **AWS로 마이그레이션 완료** (RDS + Lambda + API Gateway). Supabase(`ozmuxppuyuyhojmdiism`)는 마이그레이션 이전 데이터 소스였던 레거시 프로젝트로, 더 이상 운영 백엔드가 아님 — 실 데이터 확인은 RDS/API 기준으로 할 것.
- 마이그레이션 당시 데이터 규모/버킷 현황은 `aws-migration/PHASE0-INVENTORY.md` 참고.

---

## GitHub / 배포 구성

배포는 Vercel → AWS Amplify Hosting으로 전환됨 (`amplify.yml` 참고).

| 구분 | GitHub repo | 브랜치 | 배포 URL | Amplify App ID |
|------|-------------|--------|------------|-----------------|
| 운영 | sjlee-collab/Customer_portal | main | https://support.bigxdata.io/ | `d197cwv814vb95` (Customer_portal) |
| 개발 | sjlee-collab/Customer_portal | dev | https://dev.dlayoierdftk6.amplifyapp.com/ | `dlayoierdftk6` (Customer_portal_DEV) |

- 로컬 git remote: `origin` → `sjlee-collab/Customer_portal`
- 메인 소스 파일: 루트 `index.html` (약 8,600 라인, 단일 HTML SPA)
- **빌드/린트/테스트 없음** — `amplify.yml`은 빌드 커맨드 없이 `index.html`을 그대로 아티팩트로 올린다. 배포 = 해당 브랜치에 git push.
- 보안 헤더/CSP는 `customHttp.yml`(Amplify 커스텀 헤더)에서 관리 — `connect-src`/`img-src`가 API Gateway·S3 도메인에 고정돼 있어 **API 엔드포인트나 버킷이 바뀌면 이 파일도 같이 수정**해야 한다.

---

## AWS 인프라

- **계정:** 605163667429 / **리전:** ap-northeast-2 (서울)
- **RDS:** 인스턴스 식별자 `csdb` (PostgreSQL 18.3, DB명 `customer_portal`), 엔드포인트 `csdb.cngoihiekj6q.ap-northeast-2.rds.amazonaws.com:5432`. 기본적으로 퍼블릭 액세스 꺼짐 + 보안그룹(`sg-034f2d418a20a6f95`)에서 특정 IP만 허용. 마스터 비밀번호는 Secrets Manager 관리형 시크릿(`rds!db-...`).
- **API Gateway:** `https://8xbmazu4ij.execute-api.ap-northeast-2.amazonaws.com` — index.html의 `API_BASE`가 이 주소를 호출.
  - `/data/:table` — `data-api` Lambda, PostgREST 흉내낸 범용 CRUD (허용 테이블 16개, `backend/lambda/data-api/index.mjs` 참고)
  - `/tickets`, `/tickets/{id}/status|assign|reply|manage`, `/auth/*`, `/my/account-manager` — `api-layer` Lambda (알림·이력이 걸리는 액션 + 인증)
  - `/storage/upload-url|remove|signed-url` — `storage-api` Lambda (S3 presigned URL 발급)
- **Lambda 배포 함수명 매핑(소스 폴더 ↔ 실제 함수명 다름 주의):** `backend/lambda/data-api` → `customer_portal_data-api` · `jwt-authorizer` → `customer_portal_jwt-authorizer` · `storage-api` → `customer_portal_storage-api` · `notify-handler` → `customer_portal_notify-handler` · `send-email` → `customer_portal_send-email` · `public-inquiry` → `customer_portal_public-inquiry` · **`api-layer` → `customer-portal_slack_status_change`**(이름이 안 맞음).
- **계정 문의(공개 엔드포인트)** (2026-08-14): 로그인 전 "담당자에게 문의" 폼 → `POST /public/account-inquiry`(**인증 NONE** — 공개 라우트). Lambda `customer_portal_public-inquiry`(data-api와 동일 VPC/서브넷 `subnet-0749…`/SG `sg-01c9…`/DB 시크릿·실행역할 재사용, 메모리 512MB, env에 공통 웹훅 `SLACK_WEEBHOOK_COMMON`)가 검증→`account_inquiries` insert→**공통 Slack 채널(#고객지원포탈-공통)** 발송(전용 채널 계획은 철회)→**관리자(role=admin) 이메일 알림**(2026-08-14 추가: DB에서 admin 이메일 조회 후 `send-email` Lambda를 비동기(Event) direct-invoke, type `ACCOUNT_INQUIRY`). send-email 호출 위해 공유 실행역할(`customer_portal_data-api-role-vcnec06f`)에 인라인 정책 `invoke-send-email`(send-email ARN 한정) 추가, public-inquiry에 `@aws-sdk/client-lambda` 의존성 추가. 남용 방지: 허니팟(`website` 필드)·필수/이메일/길이 검증. 테이블 생성은 이 Lambda 직접 invoke `{"__migrate":true}`(HTTP 경유 아닐 때만). 관리자 조회 화면은 미구현(Phase 2, data-api ALLOWED_TABLES 미등록).
  - ⚠️ **api-layer 재배포 시 소스 4개(`index.mjs`·`db.mjs`·`notify.mjs`·`jwt.mjs`)를 모두 zip에 넣어야 한다.** `index.mjs`만 교체하면 `db.mjs`의 `withTransaction` 등 누락으로 **로그인 전체 순단**이 난다(2026-08-12 실제 발생). data-api/jwt-authorizer도 각자 소스 파일 전체 동봉.
- **보안 헤더 / CSP:** 레포 루트 `customHttp.yml`이 Amplify에 적용됨 — `default-src/script-src/style-src/font-src 'self'`, img/connect는 API GW·S3 버킷만 허용. 즉 **외부 CDN 폰트·스크립트는 CSP로 차단**되므로 자체 호스팅 또는 인라인(+필요 시 `data:` 허용) 해야 한다. (artifacts와 무관, 운영 사이트 한정)
  - `/functions/:fnName` — `notify-handler`(Slack), `send-email`(Outlook/MS Graph API) Lambda 호출
- **S3 버킷:** `bigxdata-portal-contract-attachments`(비공개), `bigxdata-portal-documents`(공개), `bigxdata-portal-ticket-attachments`(공개)
- **NAT 인스턴스** `customer-portal-nat`(t3.micro): `lambda-private-subnet`(172.31.100.0/24)의 인터넷 아웃바운드 전용 (NAT Gateway 대신 비용 절감)
- **스키마/Lambda 소스:** 레포 내 `backend/schema.sql`, `backend/lambda/{api-layer,data-api,jwt-authorizer,notify-handler,send-email,storage-api}/`
- **IAM 사용자:** `customer_portal` (CLI 연동용, 세션마다 자격증명 발급받아 사용)
- **샌드박스 네트워크 제약:** 원격 세션 환경은 443(HTTPS) 아웃바운드만 허용되고 5432 등 다른 포트는 막혀있어 RDS 직접 psql 접속 불가 — DB 데이터 확인은 위 API Gateway(`/data/:table`)를 통해 할 것. 로컬 세션에서는 이 제약이 없음.

### Lambda 함수 구성

| 함수 | 위치 | 역할 | 주요 환경변수 |
|------|------|------|----------------|
| `api-layer` | VPC 안 (RDS 직결) | 티켓 생성/상태변경/배정/답글/관리 + `/auth/*` (로그인, 초대, 비밀번호 재설정/변경) + EventBridge 배치 태스크 | `JWT_SECRET`, `DB_HOST/PORT/NAME/USER`, `DB_SECRET_ID` |
| `data-api` | VPC 안 (RDS 직결) | 범용 테이블 CRUD | `DB_*` (api-layer와 동일) |
| `jwt-authorizer` | VPC 밖 | API Gateway Lambda Authorizer — JWT 검증 후 `userId/role/companyId/contractId/unitIds` 컨텍스트 전달 | `JWT_SECRET` |
| `storage-api` | VPC 밖 | S3 presigned URL 발급, 삭제 | `BUCKET_*`, `DATA_API_FN` |
| `notify-handler` | VPC 밖 | Slack 웹훅 발송 | `SLACK_*`, `PORTAL_URL` |
| `send-email` | VPC 밖 | MS Graph API 메일 발송 | `MS_TENANT_ID/CLIENT_ID/CLIENT_SECRET/FROM`, `PORTAL_URL`, `TEST_EMAIL_OVERRIDE` |

**Lambda 배포:** 각 `aws-migration/lambda/<함수명>/`에서 `npm install --omit=dev && zip -rq ../<함수명>.zip .` 후 콘솔/CLI로 업로드. `notify-handler`/`send-email`/`jwt-authorizer`는 외부 의존성 없음.

### 인증/권한 아키텍처

- 로그인(`POST /auth/login`, api-layer) → JWT 발급(TTL 8시간, 클라이언트 `SESSION_ABSOLUTE_LIMIT_MS`와 동기화됨) → 이후 모든 요청에 `Authorization: Bearer` 헤더.
- API Gateway의 `jwt-authorizer`가 토큰 검증. 인증 실패 시 **403**을 반환하므로(401 아님) 프런트의 만료 판단은 401/403을 함께 본다. 조직 도입 후 JWT에 `unit_ids` 클레임 포함(구토큰은 빈 값 → contract/company 기준 폴백).
- 비밀번호는 scrypt 해시로 api-layer만 다룬다. `data-api`는 `users.password/reset_token/reset_token_expires_at`을 읽기/쓰기 모두 차단(`BLOCKED_COLUMNS`).
- `data-api`에 서버측 접근 제어가 계층적으로 걸려 있음 — 수정 시 우회 경로를 만들지 말 것:
  - `ALLOWED_TABLES` 16개 외 테이블 접근 불가
  - `STAFF_ONLY_TABLES`: `ticket_memos`, `log_integration`, `org_units`, `user_org_units`는 스태프 역할만
  - 테넌트 격리: `customer`/`internal` 역할은 자기 회사/자기 것만 조회·수정 가능 (역할 상승 방지 포함)
  - 쓰기 권한은 `role_permissions` 테이블의 실제 설정을 따름(`WRITE_PERMISSION_BY_TABLE`) — admin 하드코딩 체크 금지. 예외: `content_notices`는 항상 admin 전용(`ADMIN_ONLY_WRITE_TABLES`)
  - `tickets` 쓰기는 data-api에서 차단 — 반드시 api-layer 경유(알림·이력 보장)
- **CORS:** `api-layer`/`data-api`/`storage-api` 세 곳 모두에 `ALLOWED_ORIGINS = ['https://support.bigxdata.io', 'https://dev.dlayoierdftk6.amplifyapp.com']`가 하드코딩돼 있다. **새 오리진(예: 새 개발 환경)을 추가하려면 세 Lambda 모두 수정·재배포** 필요.

---

## index.html 내부 구조

- 단일 파일 안에 CSS → 화면 마크업 → JS 순서. 화면은 `screen-login`/`screen-forgot-password` 등 `screen-*` div, 로그인 후 페이지는 `p-*` div + `showPage(tabEl, pageId)`로 전환 (URL 해시 `#p-xxx`로 새로고침 시 페이지 유지).
- 내비게이션 탭은 `data-roles`(역할 기반 노출)와 `data-perm`(role_permissions 기능 키 기반 노출)으로 제어. `data-roles="admin"`은 관리자 전용.
- DB 접근은 Supabase `sb.from()` 인터페이스를 흉내낸 쿼리 빌더(내부적으로 `${API_BASE}/data/:table` 호출)로 통일 — `select/order/limit/single/eq.` 등 PostgREST 유사 문법. 새 CRUD 코드는 이 빌더를 재사용할 것.
- 인증 헤더는 `authHeaders()` 헬퍼 사용.
- 알림이 필요한 티켓 액션과 인증은 쿼리 빌더가 아닌 `${API_BASE}/tickets*`, `${API_BASE}/auth/*` 직접 fetch.

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

### 변경 하네스 (운영 변경 시 표준 절차) — `scripts/harness/`
운영 백엔드가 dev와 공유되고 병렬 세션이 같은 워크트리를 쓰기 때문에, 변경은 아래 루프를 따른다.
설계·상세는 **[scripts/harness/README.md](scripts/harness/README.md)**, 변경 유형별 절차는 **[scripts/harness/CHECKLIST.md](scripts/harness/CHECKLIST.md)** 에 있다. 작업 전 이 두 문서를 먼저 읽을 것.

표준 루프: 편집 → 프론트 스모크 → (백엔드면) `deploy-fn.sh <fn>` → (DDL이면 마이그레이션 경로) → `run-regression.sh` → `guard-commit.sh <파일…>` → commit → `promote.sh`

| 명령 | 용도 |
|---|---|
| `bash scripts/harness/run-regression.sh` | 회귀 스위트 전체(권한/격리·요청삭제·고객 전 기능) |
| `bash scripts/harness/deploy-fn.sh <fn>` | Lambda 안전 재배포(drift 진단→배포→스모크). api-layer 소스 4개 동봉 문제를 자동 처리 |
| `bash scripts/harness/guard-commit.sh [파일…]` | 커밋 전 clobber 점검 — 병렬 세션 변경이 섞였는지 확인 |
| `bash scripts/harness/promote.sh` | main → dev/Design/QA ff 전파 + SHA 일치 검증 |
| `bash scripts/harness/email-safe.sh on\|off\|status` | 운영 상태 리셋(잔여 리다이렉트/태그 env 제거). 테스트 격리는 자동 — **메일=temail() 싱크 수신자**, **슬랙=`[테스트]` 제목/기업명 자동 라우팅**(`SLACK_WEBHOOK_TEST`) |
| `bash scripts/harness/sweep.sh [--delete]` | `[테스트]` 라벨 잔여 데이터 청소 |

**테스트 데이터 규칙(필수)**: 하네스가 만드는 모든 데이터는 이름/제목에 `[테스트]` 라벨을 붙인다(`lib/itest.py`의 `tname()`/`temail()`). 실 고객에게 메일이 가면 안 되므로 주소는 `temail()`의 sink를 쓴다. 정리는 각 테스트의 `finally` + `sweep.sh`이며, 라벨 없는 운영 데이터는 절대 건드리지 않는다.

### 스모크 테스트(회귀 안전망)
배포/리팩터 후 핵심 경로가 살아있는지 빠르게(비파괴) 점검한다. `amplify.yml`이 `index.html`만 배포하므로 `scripts/`는 웹에 노출되지 않는다.
- **백엔드**: `bash scripts/harness/smoke.sh` (비인증 경로) / `SMOKE_EMAIL=.. SMOKE_PASSWORD=.. bash scripts/harness/smoke.sh` (로그인·조회까지). 로그인 엔드포인트·계정신청(허니팟 비파괴)·인증보호·(선택)티켓조회 확인, 실패 시 종료코드 1.
- **프론트**: `scripts/harness/smoke-frontend.js` 내용을 브라우저 콘솔에 붙여넣기 → 폼 옵션 채움·통합 함수(openDocModal/filterPop*)·렌더러·핵심 DOM 존재를 즉시 확인. 로컬 검증은 `.claude/launch.json`의 static 서버(preview)로 로그인 없이 가능.

### 3. 개발현황.html 수정 금지
이 채팅에서 진척 보고 요청이 와도 `개발현황.html` 파일은 건드리지 않는다.
텍스트/마크다운으로만 응답. 파일 반영은 사용자가 명시적으로 요청할 때만.

---

## 기술 스택

- **Frontend:** 바닐라 JS, 단일 HTML 파일 SPA (Supabase 클라이언트 제거 완료, AWS API Gateway 직접 호출)
- **DB:** Amazon RDS (PostgreSQL 18.3). 성능 인덱스 20개(FK/필터 컬럼 — tickets.unit_id/company_id/created_by/status/due_date, 부속테이블 ticket_id, user_org_units, users, contracts/licenses) 2026-08-12 추가(schema.sql 하단). FK엔 자동 인덱스가 없어 seq scan이던 조회를 index scan으로 전환.
- **API:** API Gateway + Lambda (`data-api`=범용 CRUD, `api-layer`=알림 연계 액션+인증, `jwt-authorizer`=토큰 검증, `storage-api`=S3 업로드, `notify-handler`/`send-email`=알림·메일 발송)
- **자동화:** EventBridge Scheduler 3개가 매일 KST 09:00에 `api-layer` Lambda를 직접 호출 — `daily-overdue-ticket-check`(`overdue_batch`, 지연 티켓 Slack 알림), `daily-license-expiry-notice`(`license_expiry_notice`), `daily-contract-expiry-check`(`expire_contracts`). 레거시 Supabase pg_cron 잡 2개는 중복 알람을 일으켜 2026-08-11에 모두 제거함(unschedule) — 레거시 쪽에는 더 이상 크론 없음.

## Slack 웹훅 환경변수

| 변수명 | 채널 | 비고 |
|--------|------|------|
| `SLACK_WEEBHOOK_COMMON` | 공통 | **오타 주의** (WEEBHOOK) — 코드도 오타 변수명을 그대로 읽음 |
| `SLACK_WEBHOOK_SALES` | 영업 | contract/license/education |
| `SLACK_WEBHOOK_TECH` | 기술지원 | tech_support |
| `SLACK_WEBHOOK_EDU` | 교육 | notify-handler에서 사용 |

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
