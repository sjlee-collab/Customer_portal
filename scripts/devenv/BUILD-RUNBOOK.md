# 개발환경(dev 백엔드) 구축 러너북

목적: 운영과 공유 중인 백엔드에서 **개발 전용 백엔드**를 분리한다.
세션이 끊겨도 이 문서만 보고 이어서 진행할 수 있도록 상태를 기록한다.

> **원칙**: 전환(C단계) 전까지 기존 자원은 **한 건도 수정하지 않는다**. 새로 만들기만 한다.
> 모든 신규 자원 이름에 `dev` 표시. 실패 시 정리 = 신규 자원 삭제.

## 결정사항 (2026-09-23 확정)

| 항목 | 결정 |
|---|---|
| DB | 기존 인스턴스 `csdb` 안에 `customer_portal_dev` (추가 비용 0) |
| 데이터 | 운영 전체 복사 (18개 테이블 6,767행) |
| Slack | `SLACK_REDIRECT=1` + 기존 테스트 채널 웹훅만 dev 시크릿에 |
| 메일 | dev는 전부 `sjlee@bigxdata.io`로 강제 |
| 배치 | dev에 EventBridge 스케줄러 없음 (수동 호출만) |
| 실행롤 | dev 전용 신규 생성 (권한 경계까지 분리) |
| 프론트 | `index.html` 수정 없음 — Amplify 리라이트 대상만 변경 |

## 진행 상태

- [x] **A1** dev 시크릿 3종 (`customer-portal/dev-jwt`, `dev-slack-webhooks`, `dev-ms-graph`)
- [x] **A2** dev S3 버킷 3종 (+버저닝·라이프사이클·CORS·암호화)
- [x] **A3** `customer_portal_dev` DB 생성 + 전체 복사 + 시퀀스 동기화
- [x] **B1** dev 실행롤 (VPC용 / 비VPC용)
- [x] **B2** dev Lambda 7종
- [x] **B3** dev API Gateway + 라우트 46개 + authorizer + 액세스 로그
- [x] **--- 중단·보고 완료 ---**
- [x] **C1** 개발 Amplify 앱(`dlayoierdftk6`) 리라이트 2줄 전환
- [x] **C2** 검증 (로그인·티켓 생성·알림·메일 격리)

## A단계 실행 기록 (2026-09-23)

- **A1** 시크릿 3종 생성: `customer-portal/dev-jwt`(운영과 다른 새 랜덤 값) · `dev-slack-webhooks`(테스트 채널 웹훅만, 실 채널 4종 의도적 제외) · `dev-ms-graph`
- **A2** 버킷 3종 생성: `bigxdata-portal-{contract-attachments,documents,ticket-attachments}-dev` — BPA 4종 · 버저닝 · SSE-S3+BucketKey · 라이프사이클(운영과 동일) · CORS는 dev 오리진만
- **A3** `customer_portal_dev` 생성 → schema.sql 적용 → 데이터 7,619행 복사 → 시퀀스 동기화 → **행 수·구조 전부 일치 확인**

### A3에서 발견한 것 (중요)

1. **`backend/schema.sql`이 운영보다 뒤처져 있었다.** 운영에만 있던 것: 테이블 `form_responses`(+PK·UNIQUE·FK·인덱스 2), 컬럼 `users.reset_token`·`users.reset_token_expires_at`·`company_contracts.unit_id`, `org_units` UNIQUE 2종, FK의 `ON DELETE` 절 3건.
   반대로 schema.sql에만 있던 잘못된 제약 `user_org_units UNIQUE (id)`도 발견. → dev DB는 **운영 카탈로그를 기준으로** 20건 보정해 일치시킴. **schema.sql 자체 갱신은 별도 작업으로 남아 있음.**
2. **복사 시 테이블별 `TRUNCATE ... CASCADE` 금지.** 뒤 테이블의 CASCADE가 앞서 복사한 테이블을 비운다(실제 발생, 11개 테이블이 0행이 됐다). 전체를 한 번에 truncate 해야 한다.
3. 운영 DB에 상시 연결이 4개 있어 `CREATE DATABASE ... TEMPLATE` 방식은 쓸 수 없다(운영 연결 차단 위험). 빈 DB + 스키마 + 행 복사 방식이 맞다.

## B단계 실행 기록 (2026-09-23)

- **B1** dev 전용 실행롤 2종 — `customer_portal_dev-vpc-role`(VPC 3종용: 로그·ENI·`customer-portal/dev-*`+RDS 시크릿·dev 함수 invoke) / `customer_portal_dev-basic-role`(비VPC 4종용: 로그·dev 시크릿·`-dev` 버킷·dev 함수 invoke). **운영 시크릿·운영 버킷 접근 불가**.
  - `iam:TagRole` 권한이 없어 태그는 못 붙였다(기능 무관).
- **B2** dev Lambda 7종 — 운영 배포본 zip에 레포 `.mjs`를 덮어써 패키징(deploy-fn.sh와 동일 방식).
  | dev 함수 | 원본 | 핵심 env |
  |---|---|---|
  | `customer_portal_api-layer-dev` | slack_status_change | `DB_NAME=customer_portal_dev`, `SECRET_JWT=customer-portal/dev-jwt`, NOTIFY/SEND_EMAIL → dev |
  | `customer_portal_data-api-dev` | data-api | `DB_NAME=customer_portal_dev` |
  | `customer_portal_public-inquiry-dev` | public-inquiry | dev DB, `SLACK_REDIRECT=1`, dev slack 시크릿 |
  | `customer_portal_jwt-authorizer-dev` | jwt-authorizer | `SECRET_JWT=customer-portal/dev-jwt` |
  | `customer_portal_notify-handler-dev` | notify-handler | `SLACK_REDIRECT=1`, dev slack 시크릿, `PORTAL_URL`=dev |
  | `customer_portal_send-email-dev` | send-email | `TEST_EMAIL_OVERRIDE=sjlee@bigxdata.io`, dev ms-graph 시크릿 |
  | `customer_portal_storage-api-dev` | storage-api | `BUCKET_*`=-dev 3종, `DATA_API_FN`=data-api-dev |
- **B3** dev API Gateway `customer-portal-api-dev` = **`p4ozzm0omb`** → `https://p4ozzm0omb.execute-api.ap-northeast-2.amazonaws.com`
  - 라우트 46개(운영과 동일), authorizer `jwt-authorizer`(REQUEST/2.0/simple/TTL 300) → `jwt-authorizer-dev`, CORS는 dev 오리진만, `$default` 스테이지 auto-deploy
  - 액세스 로그 **ON (2026-09-23)** — 로그그룹 `/aws/apigateway/p4ozzm0omb-access`(보존 90일). `customer_portal` 사용자에게 `logs:CreateLogGroup`·`logs:CreateLogDelivery`가 없어 콘솔에서 설정했다. 포맷은 운영과 완전 동일(13개 필드, 쿼리스트링 미포함).

### B단계 검증 결과 (전부 통과)

| 검증 | 결과 |
|---|---|
| data-api-dev → dev DB 연결 | 200, companies 407 |
| DB 격리 (dev에 1행 추가) | dev 407→408, **운영 407 유지** |
| dev 사이트 미인증 요청 | 401 |
| 잘못된 비밀번호 | 401 (균일 메시지) |
| dev API 정상 로그인 | 200, 토큰 발급 |
| 토큰으로 dev 데이터 조회 | companies 407 · tickets 44 |
| **같은 토큰을 운영 API에 제시** | **403 거부 — JWT 분리 확인** |

- dev 전용 검증 계정: `devtest+harness@bigxdata.io` (role=admin, dev DB에만 존재)
- `scripts/devenv/migrate.mjs` = DB 생성·복사·구조대조 도구. 재사용 시 data-api 배포본 zip에 이 파일과 `schema.sql`, CA를 넣어 일회용 Lambda로 띄운 뒤 삭제한다(이번에도 그렇게 하고 삭제함).

## C단계 실행 기록 (2026-09-23) — 구축 완료

- **C1** 개발 Amplify 앱(`dlayoierdftk6`) 리라이트 2줄 전환:
  - `/api/<*>` → `https://p4ozzm0omb.execute-api.ap-northeast-2.amazonaws.com/<*>`
  - `/files/ticket-attachments/<*>` → `https://bigxdata-portal-ticket-attachments-dev.s3.ap-northeast-2.amazonaws.com/<*>`
  - 운영 앱(`d197cwv814vb95`) 규칙은 그대로 확인함. **전환 전 규칙은 `dev-app-rules-BEFORE.json`에 백업**(롤백 시 위 2줄을 `8xbmazu4ij` / 운영 버킷으로 되돌리면 끝).
  - `index.html`·`customHttp.yml` **수정 없음** — 동일출처 `/api` 구조 덕분.
- **C2** 종단 검증 (dev API 직접 호출 기준, 전부 통과):

| 검증 | 결과 |
|---|---|
| 정상 로그인 → 토큰 발급 | 200 |
| 티켓 생성 | 201 `TK-20260923-6661` |
| **dev tickets 44 → 45 / 운영 tickets 44 유지** | 데이터 격리 확인 |
| Slack 알림 | `is_test=true`, 본문에 `[테스트]` + `_(원래 대상: #고객지원포탈-공통)_` → **테스트 채널로만** |
| 메일 | `is_test=true`, `TEST_EMAIL_OVERRIDE=sjlee@bigxdata.io` 적용(로그의 recipient는 설계상 원래 대상을 남김) |
| dev 토큰을 운영 API에 제시 | 403 거부 |
| dev Lambda 7종 격리 env 감사 | 7/7 일치 |
| 운영 Lambda 환경변수 | 무변경 확인(`SECRET_*` 없음 = 기본값 사용) |

- 검증용 티켓은 삭제함(dev tickets 44로 복귀).

### 남은 것

1. **`backend/schema.sql` 갱신** — 운영과 20건 차이(A3 기록 참고). dev DB는 이미 맞춰져 있으나 파일은 그대로다.
3. **브라우저 최종 확인** — 원격 세션은 네트워크 정책상 `*.amplifyapp.com`에 접근할 수 없어, Amplify 리라이트 홉만 설정 확인에 머물렀다. dev 사이트에서 로그인 1회로 확정 가능.
4. **하네스를 dev로 옮길지 결정** — 옮기면 회귀가 더 이상 운영 DB를 치지 않는다(DESIGN.md §6.1 한계 해소).

## 하네스 dev 전환 (2026-09-23)

`HARNESS_ENV` 스위치 도입, **기본값 dev**. 운영을 치려면 `HARNESS_ENV=prod` 명시.
배포 도구(`deploy-fn.sh`·`drift-check.sh`·`apigw-route.sh`)는 성격이 달라 운영 대상 그대로 둔다.

### dev 대상 회귀에서 드러난 것 3가지

1. **dev Slack 시크릿에 채널 키를 비워두면 안 된다.** `notify-handler`는 `if (... && SLACK_WEBHOOK_SALES)`
   처럼 **웹훅 값이 비어 있으면 그 채널 발송을 통째로 건너뛴다.** 테스트 채널 웹훅만 넣었더니 공통
   채널만 발송돼 팬아웃 검증이 12건 실패했다. → **채널 키 4종(COMMON/SALES/TECH/EDU)에 전부
   테스트 채널 URL을 넣는다.** 값이 실 채널이 아니므로 `SLACK_REDIRECT`가 없어도 실 채널로 샐 수
   없고(이중 안전), 팬아웃 로직은 정상 검증된다. 조치 후 `notify_routing` 31/31 통과.
2. **시크릿을 바꾸면 콜드스타트를 유도해야 한다.** `secrets.mjs`가 컨테이너당 1회만 조회·캐시하므로
   값만 바꾸고 바로 돌리면 옛 값으로 동작한다(재실행이 같은 이유로 또 실패했다).
   설정 변경(환경변수 하나 추가/변경)으로 새 실행환경을 강제하면 된다.
3. **테스트가 운영 주소를 기본값으로 박고 있던 곳 2군데** — `test_jwt.py`(API 주소),
   `test_storage_rules.py`(버킷 이름). `itest.API_BASE`/`BUCKET_SUFFIX`를 따르도록 수정.

### dev 대상 전체 회귀 결과 (2026-09-23)

`suites=28 checks=512/532` — 25종 통과. 실패 3종 중 2종은 **이 원격 세션 환경 제약**이다:

| 스위트 | 판정 |
|---|---|
| `notify_routing` | 최초 19/31 → 위 1·2번 조치 후 **31/31 통과** |
| `deploy_gate` | 리눅스에서 `.exe` 스텁이 PATH에 안 잡힘(Windows Git Bash 전제). 로컬에선 정상 |
| `l2_runtime` | 헤드리스 브라우저의 로그인 fetch가 샌드박스 프록시에 막힘. dev 전환 이전(2026-09-21 운영 대상 실행)에도 같은 증상이었으므로 이번 변경과 무관 |

## 운영 설정 스냅샷 (2026-09-23 조회)

### Lambda 7종
| 함수 | 런타임 | 메모리 | 타임아웃 | VPC |
|---|---|---|---|---|
| `customer-portal_slack_status_change` (api-layer) | nodejs24.x | 512 | 30 | O |
| `customer_portal_data-api` | nodejs24.x | 128 | 30 | O |
| `customer_portal_public-inquiry` | nodejs24.x | 512 | 15 | O |
| `customer_portal_jwt-authorizer` | nodejs22.x | 128 | 5 | X |
| `customer_portal_notify-handler` | nodejs24.x | 128 | 30 | X |
| `customer_portal_send-email` | nodejs24.x | 128 | 30 | X |
| `customer_portal_storage-api` | nodejs24.x | 128 | 30 | X |

- VPC: subnet `subnet-0749129aa60c4fa18` / SG `sg-01c9a980db122761c`
- RDS: `csdb.cngoihiekj6q.ap-northeast-2.rds.amazonaws.com:5432`
- API Gateway: `8xbmazu4ij` — 라우트 46개, authorizer `jwt-authorizer`(REQUEST/2.0/simple/TTL 300s, `$request.header.Authorization`)
- S3 버킷 3종: 전부 비공개(BPA 4종 ON, 버킷 정책 없음), SSE-S3 + BucketKey, CORS는 운영·dev 오리진 허용

## 롤백

| 단계 | 롤백 |
|---|---|
| A·B | 신규 자원 삭제만 하면 됨 (운영 무영향 — 아직 아무도 호출하지 않음) |
| C | 개발 Amplify 앱 리라이트 2줄을 운영 대상으로 되돌림 (즉시 반영) |

## 주의

- 마이그레이션 Lambda는 **운영 DB에서 SELECT만**, 쓰기는 dev DB에만.
- dev Lambda 환경변수 `DB_NAME`이 `customer_portal_dev`인지 반드시 확인 (운영 DB를 보면 안 됨).
- JWT 시크릿은 운영과 **다른 값**이어야 한다 (토큰 상호 통용 방지).
