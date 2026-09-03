# 변경 하네스 설계서

> 역할 분리: **README.md** = 사용법(스크립트·루프·규칙), **CHECKLIST.md** = 변경 유형별 절차,
> **이 문서(DESIGN.md)** = 왜 이렇게 만들었는지(위험 모델·설계 원칙·구조·한계·로드맵).
> 하네스를 고치거나 확장할 때는 이 문서의 원칙과 충돌하지 않는지 먼저 확인한다.

작성 2026-08-31 (기준 커밋 93066ab, 회귀 10종 231건).

---

## 1. 문제 정의 — 무엇으로부터 지키는가

이 시스템의 구조적 조건이 위험을 만든다:

| # | 조건 | 위험 | 하네스의 대응 |
|---|------|------|------|
| R1 | **dev 환경 없음** — 테스트도 운영 백엔드(RDS·Lambda·실 슬랙·실 메일)를 친다 | 테스트 데이터가 운영에 섞임, 테스트 알림이 실 채널·실 고객에게 감 | `[테스트]` 라벨 격리(§3.1) |
| R2 | **병렬 Claude 세션** — 여러 세션이 같은 폴더의 워크트리들을 동시에 씀 | 남의 미커밋 작업을 커밋에 쓸어 담거나(clobber) 되돌림 | `guard-commit.sh`(§3.4) |
| R3 | **다중 브랜치 배포** — main/dev/Design/… 각각이 Amplify 배포 대상 | 브랜치 간 drift, 수동 전파 누락 | `promote.sh` ff-only 전파(§3.4) |
| R4 | **Lambda 수동 배포** — git push로는 반영 안 됨 | 레포↔배포본 drift. *실사례: 2026-08-31 상태알림 확대·마감일 판정이 배포본에만 있었음 — 모르고 재배포했다면 운영 롤백* | `deploy-fn.sh` drift 진단(§3.4), 회귀는 배포본 기준 기대값 |
| R5 | **단일 index.html SPA, 빌드·린트·테스트 없음** | 한 곳 수정이 다른 기능을 조용히 깨뜨림(연쇄 회귀) | 회귀 스위트(§4) + 프론트 스모크 |
| R6 | **로그인 순단 이력** — api-layer 부분 zip 배포로 로그인 전체 중단(2026-08-12 실제 발생) | 배포 실수가 곧 장애 | deploy-fn이 소스 4개 동봉을 자동 처리 + 배포 후 로그인 스모크 |

**목표는 "운영에서 테스트해도 안전한 상태"를 만드는 것**이다. 완전 격리(별도 dev 환경)가
이상적이지만 비용 제약으로 미보유 — 그 전까지의 차선이 이 하네스다(§6.1).

---

## 2. 설계 원칙

1. **격리는 스위치가 아니라 데이터로.** 전역 on/off 스위치는 "켜둔 채 잊으면 운영까지 차단"되는
   실패 모드가 있다(실제로 예전 전역 메일 sink가 운영 메일을 막아서 제거함). 대신 데이터 자체에
   `[테스트]` 라벨을 박고 **코드가 라벨을 보고 상시 자동 분기**한다. 잊었을 때의 기본값이 안전하다
   — 라벨을 잊으면 테스트 알림이 실 채널로 새는 쪽이므로, 라벨 부착을 헬퍼(`tname`/`temail`)로
   강제하고 리뷰에서 잡는다.
2. **판정은 DB에서.** 알림은 `deferNotify`(비동기 Event invoke)라 API 응답으로 관찰 불가.
   `log_notification` 행이 유일한 관찰 지점이며, 웹훅 미설정 환경에서도 failure 행은 남으므로
   "라우팅 결정" 자체는 항상 검증된다. 발송 원문도 `content` 컬럼에 남아 내용 단언이 가능하다.
   **알림 내용은 트리거 시점 스냅샷으로**(2026-09-03) — deferred 핸들러가 라이브 재조회를 하면
   연속 변경 시 밀린 값을 읽는 경합이 생긴다. 트리거가 fresh row를 페이로드에 동봉하고
   핸들러는 그걸 쓴다(구버전 페이로드는 라이브 조회 폴백).
3. **로그인 없이 역할 재현.** API Gateway/JWT를 우회해 Lambda를 직접 invoke하면서
   `authorizer.lambda` 컨텍스트(role/userId/companyId/…)를 주입한다. 비밀번호·토큰 관리 없이
   전 역할 매트릭스를 돌릴 수 있고, authorizer 이후의 서버 로직(권한·격리)을 정확히 겨눈다.
   authorizer 자체는 test_jwt가 실 HTTP(API GW 경유)로 별도 검증한다(2026-09-03).
4. **남의 작업은 절대 강제하지 않는다.** 전파는 ff-only — 형제 세션 브랜치가 갈라져 있으면
   보고만 하고 건드리지 않는다. 커밋 전에는 변경 파일이 "내가 의도한 것뿐인지" 대조한다.
5. **현행 고정(pin).** 의도인지 버그인지 불명확한 동작(예: assign 경로만 이력 미기록,
   슬랙·메일 발송 기준 불일치)도 일단 테스트로 고정한다. 목적은 정당화가 아니라 **조용한 변화의
   감지** — 누가 고치면 테스트가 깨져서 "의도된 변경인가?"를 묻게 만든다. 테스트 이름에
   `(현행)`을 붙여 규범이 아님을 표시한다.
6. **각자 정리 + 안전망.** 모든 테스트는 `finally`로 자기 데이터를 지우고, 중단 잔여물은
   `sweep.sh`가 라벨 기반으로만 청소한다(라벨 없는 운영 데이터는 구조적으로 못 지움).
7. **레포는 배포본의 거울.** 회귀 기대값은 배포본(=실동작) 기준으로 쓴다. 레포가 뒤처졌으면
   레포를 역동기화하는 게 먼저고, 그 다음 재배포가 안전해진다(R4 실사례).

---

## 3. 아키텍처

```
┌─ 테스트 계층 ──────────────────────────────────────────────┐
│ tests/ (10종 231건)                                        │
│   └── lib/itest.py                                         │
│        invoke(fn, event) ─ aws lambda invoke + authorizer  │
│        ctx/api/dget/dpost/dpatch/ddel ─ 역할 주입 헬퍼      │
│        tname/temail ─ [테스트] 라벨·sink 메일 (격리의 축)   │
│        notif_rows/wait_notif ─ 알림 판정(log_notification) │
│        wipe_ticket/sweep_test_data ─ 정리                  │
├─ 운영 스크립트 계층 ────────────────────────────────────────┤
│ run-regression.sh  스위트 실행 + 종료 시 sweep --delete     │
│ deploy-fn.sh       drift 진단 → 전체 소스 zip → 배포 → 스모크│
│ guard-commit.sh    origin 대비 + 의도 파일 검증 (R2)        │
│ promote.sh         main → 형제 브랜치 ff-only 전파 (R3)     │
│ email-safe.sh      잔여 env 리셋 + 상태 확인                │
│ sweep.sh           라벨 잔여물 미리보기/삭제                 │
│ apigw-route.sh     라우트 조회/추가                          │
├─ Lambda 측 협력 장치 (운영 코드 안에 있는 격리 지원) ────────┤
│ notify-handler/public-inquiry: 제목·기업명 [테스트] 접두 →  │
│   실 채널 대신 SLACK_WEBHOOK_TEST로만 발송(원대상 표기)      │
│ send-email: 전역 리다이렉트 없음 — temail() sink 수신자만    │
│   sjlee로 감(운영 메일은 항상 정상 발송)                     │
│ notify.mjs: 발송 결과+원문을 log_notification에 기록(판정점) │
└────────────────────────────────────────────────────────────┘
```

### 3.1 격리 메커니즘 — `[테스트]` 라벨 하나가 세 가지를 결정

| 결정 | 메커니즘 |
|---|---|
| 슬랙 목적지 | notify-handler·public-inquiry가 제목/기업명 접두를 보고 테스트 채널로만 발송 |
| 메일 수신자 | `temail('tag')` → `sjlee+tag@bigxdata.io` sink (실 고객 도달 불가) |
| 청소 대상 | `sweep.sh`가 라벨 ilike 검색으로만 삭제 |

테스트 채널 웹훅은 비밀값이라 레포에 없고 Lambda env `SLACK_WEBHOOK_TEST`에만 있다.

### 3.2 검증 레벨

| 레벨 | 대상 | 방식 | 자동화 |
|---|---|---|---|
| L1 | 백엔드 계약(권한·격리·전이·알림 라우팅) | Lambda direct invoke | `run-regression.sh` |
| L1-C | 고객 계정 전 기능 경로 | 〃 (실 api-layer 경로) | 〃 |
| L2-정적 | 프론트 문법·핸들러·DOM id 참조 | `l2-smoke.mjs` (실행 없이 검사, 의존성 0) | run-regression 첫 단계 |
| L2-런타임 | 프론트 렌더·핵심 함수·실로그인 후 화면 | `l2-runtime.mjs`(headless chromium) ← `test_l2_runtime` | 자동(P5, 2026-09-03) |
| 스모크 | 배포 직후 생존 확인(비파괴) | `smoke.sh` (HTTP), deploy-fn 내장 스모크 | 반자동 |
| L3 | 실브라우저 로그인 E2E | — | **부재**(§6.3) |

### 3.2b 실행 속도 (2026-09-02)
전체 회귀가 10~13분이던 것을 세 가지로 줄였다:
- **boto3 재사용** — `invoke()`가 `aws.exe` subprocess(호출당 ~1초) 대신 boto3 단일 세션을
  쓴다. boto3가 없으면 CLI로 자동 폴백. 개별 호출 오버헤드가 지배적이던 스위트가 수십 배 빨라졌다.
- **부분 실행** — `run-regression.sh <스위트…>`로 영향 범위만 검증(개발 루프용). index.html만
  고쳤으면 `node l2-smoke.mjs`(1초)로 충분하다.
- **선택적 병렬** — 알림 발송을 단언하지 않는 스위트(`PAR_SAFE`)만 동시 실행한다.
  알림 테스트는 병렬로 돌리지 않는다: notify-handler가 비동기로 "현재 티켓 상태"를 읽어
  event_type을 정하는데, 병렬 CPU 부하에서 전이와 비동기 발송이 경합해 분포가 어긋난다(실측).

**주의 — 고정 이메일 금지.** `users.email`은 unique 제약이 있어 테스트가 고정 주소를 쓰면
중단된 실행의 잔재 계정과 충돌해 재생성이 500→KeyError로 죽는다. `temail()`이 실행 토큰을
섞어 실행마다 고유하게 만들어 이 문제를 없앴다(잔여 계정은 라벨로 sweep이 정리).

### 3.3 테스트 데이터 생성 전략

- 픽스처(회사·유저·티켓 시드)는 **admin 직접 insert**(data-api) — 알림이 안 걸려 조용하다.
- 검증 대상 행위(등록·상태변경·배정·답글)는 **실 api-layer 경로** — 알림·이력까지 실동작을 본다.
- 성공 로그인은 **테스트 계정([테스트] 이름/temail)으로만** 한다(P4, 2026-09-03) — 이벤트 행은
  남지만 LE_REAL 필터가 전 통계·이력 화면에서 제외한다(감사 보존). 실계정 로그인은 여전히 금지.

### 3.4 git 안전장치의 분업

- `guard-commit.sh`: 커밋 **전** — origin/main 최신 여부 + 워킹트리 변경이 의도 파일뿐인지.
  노이즈 필터에는 무시 대상(node_modules·__pycache__)과 로컬 전용(launch.json·scratchpad)만
  둔다. **추적되는 파일을 필터에 넣으면 안 된다**(clobber 감지가 무뎌짐 — package-lock을 추적으로
  바꾸며 필터에서 뺀 이유).
- `promote.sh`: 커밋 **후** — ff-only라 형제 브랜치의 고유 커밋을 절대 덮지 않는다.
  워크트리가 없는 브랜치는 건너뛰고 보고한다(브랜치 목록은 형제 세션이 늘리고 줄일 수 있음).

---

## 4. 커버리지 맵 (2026-08-31, 231건)

### api-layer 라우트 22개

| 라우트 | 테스트 | 비고 |
|---|---|---|
| POST /auth/login | test_auth | 401/404 분기(성공 로그인 금지) |
| POST /auth/verify-password | test_auth | |
| PATCH /auth/change-password | test_auth | currentPassword 재확인 |
| POST /auth/reset-password | test_auth | 무효 토큰 거부 |
| POST /auth/request-reset | test_auth | 발송 로그는 recipient로 판정(토큰 왕복은 data-api 차단으로 불가) · 미등록 404는 현행(열거 갭) 고정 |
| POST /auth/invite | test_auth | 404/403 포함 |
| POST /auth/admin-reset-password | test_auth | 권한상승 차단(비관리자→내부직원 403) |
| GET /my/account-manager | test_auth | |
| GET /stats/* (8개) | test_stats_view | 구조·403·필터·집계 정합 |
| GET /proxy/bootstrap·customers | test_proxy_register | |
| POST /tickets | test_customer_e2e·notify_routing | 사칭 방지 + 카테고리 팬아웃 |
| PATCH /tickets/{id}/status | test_ticket_status | 접수 제외 6개 상태 × 알림 |
| PATCH /tickets/{id}/assign | test_ticket_assign | |
| PATCH /tickets/{id}/manage | test_ticket_status | 이력·overdue·send_email |
| POST /tickets/{id}/reply | test_customer_e2e·notify_routing | 고객만 알림 |
| PATCH·DELETE /tickets/{id} | test_customer_e2e·ticket_delete | cascade 포함 · make_public은 test_internal_review |
| POST /tickets/{id}/rate | test_ticket_rate | 본인·완료·중복방지·범위 |
| (횡단) is_internal 은닉 | test_internal_review | **보안 경계** — 고객 완전 은닉 + 메일 억제 |
| (횡단) enum CHECK 계약 | test_schema_contract | schema.sql 허용값 ↔ 라이브 DB ↔ 테스트 커버리지 (드리프트 감지) |
| 배치 3종(overdue_batch·license_expiry_notice·expire_contracts) | test_batch | only_test 모드로 [테스트] 라벨만 스캔 — 안전 검증 |

### 기타 Lambda

| Lambda | 테스트 |
|---|---|
| data-api | test_permissions(격리·직접쓰기 차단), 전 테스트의 픽스처 경로 |
| storage-api | test_storage_rules(확장자·용량·소유권) |
| public-inquiry | smoke.sh(허니팟 비파괴) — L1 테스트는 없음 |
| jwt-authorizer | test_jwt — 실 HTTP 경유(로그인·클레임 스코프·위조/변조 거부) |
| notify-handler·send-email | 직접 테스트는 없고 api-layer 경유로 라우팅·수신자 검증 |

---

## 5. 확장 규칙 — 새 테스트를 추가할 때

1. 파일은 `tests/test_<대상>.py`, `run()` + `Checker` + `finally` 정리 패턴을 따른다.
2. 데이터는 반드시 `tname()`/`temail()` — 특히 **알림이 트리거되면 예외 없이**.
3. 알림 단언은 `notif_rows`/`wait_notif`(itest 공용) — 기대 건수를 채운 뒤 grace로
   초과 발송까지 잡는다. 채널 분기는 `recipient`, 내용은 `content`로.
4. 픽스처는 admin insert(무알림), 검증 행위는 실 경로 — §3.3.
5. `run-regression.sh`의 TESTS 배열과 README 테스트 목록에 등록한다.
6. 권한 토글(role_permissions)을 만지면 `finally`에서 **기본값으로** 원복(테스트 시작값이
   아니라 규정 기본값 — 이전 실행이 잘못 남긴 값을 물려받지 않기 위해).
7. 쿼리스트링은 `api(..., qs={...})` — rawPath에 붙이면 라우팅이 404를 낸다.
8. 실행 순서 독립: 다른 테스트가 만든 데이터를 전제하지 않는다(순서 재배열·단독 실행 가능).

---

## 6. 알려진 한계와 미해결 설계 과제

### 6.1 공유 운영 환경 (근본 한계)
완전 격리는 별도 dev 백엔드가 있어야 한다. 과거 시도(`claude/dev-environment-harness-design`
브랜치)는 전체 원복 후 폐기됐다. 임시 환경(RDS 스냅샷 복원 + Lambda 별칭 + 테스트 전용
스테이지)이 이론상 후보이나, 비용·운영 부담이 커 **채택하지 않기로 결정했다(2026-09-03, P6
드롭)** — `[테스트]` 라벨 격리가 실무상 충분히 안전하다는 판단. 따라서 라벨 격리가 유일한
방어선이며, **라벨 규칙 위반을 최우선 리뷰 항목으로 둔다**(이 결정의 대가). 재검토가 필요할
만큼 라벨 사고가 반복되면 그때 P6를 다시 연다.

### 6.2 배치 3종 — only_test 모드로 해소 (2026-09-03)
배치는 전체 스캔이라 테스트 invoke가 불가능했으나, 배치 핸들러에 `only_test` 모드
([테스트] 라벨 행만 스캔)를 추가해 test_batch로 안전 검증한다. 운영 스캔은 반대로
[테스트] 회사를 제외하고, 라이선스 알림은 isTest 이중 안전망까지 갖췄다(6f179e6).

### 6.3 L2 런타임 자동화 — test_l2_runtime로 해소 (2026-09-03, P5)
정적 검사(l2-smoke)만 자동이고 렌더·로그인 후 화면은 수동(콘솔 붙여넣기)이었다. P4로
실로그인이 가능해져, 헤드리스 크로미움(playwright)이 페이지를 띄워 부팅 콘솔 에러·
smoke-frontend 자동 주입·실로그인→메인 렌더·로그인 후 콘솔 에러 0을 검증한다.
로컬 정적 서버로 서빙하고 CORS는 --disable-web-security로 우회(프론트 렌더가 목표,
API 계약은 L1이 담당). playwright 미설치 장비에선 스위트가 자동 skip돼 회귀가 안 깨진다.

### 6.4 jwt-authorizer — test_jwt로 해소 (2026-09-03)
P4(LE_REAL로 테스트 로그인을 전 화면에서 제외) 완성으로 실로그인이 가능해져, test_jwt가
API GW 실경유로 문지기를 검증한다: 발급·클레임 스코프 흐름·무토큰 401·위조/변조 403.
만료 토큰은 JWT_SECRET 없이는 제작 불가라 코드 리뷰로 갈음(서명 검증이 만료 위조도 막는다).

### 6.5 drift 감지 — `drift-check.sh`로 해소 (2026-08-31)
`deploy-fn.sh`의 배포 직전 진단만으로는 커밋·리뷰 시점 drift를 못 잡았다(R4 실사례는 우연히 발견).
`drift-check.sh [fn]`이 배포본 zip을 받아 `.mjs`를 CRLF 무시 diff한다 — 읽기 전용, 종료코드로
훅·주기 점검에 연결 가능. 남은 판단: pre-push 훅에 상시로 걸지(느림 — 7함수 다운로드) 여부.

### 6.6 수동 실행 의존 (CI 부재)
회귀는 사람이 돌려야 한다. 레포에 CI가 없고(빌드 자체가 없음), AWS 자격증명이 필요해
GitHub Actions 도입 시 시크릿 관리가 선행돼야 한다. 최소 대안: 로컬 pre-push 훅으로
guard-commit + (선택) 회귀를 거는 것. 운영 DB를 치는 테스트라 무인 주기 실행은
메일/슬랙 발생량(실행당 메일 ~10통, 슬랙 ~30건이 테스트 채널·sink로)과 함께 판단할 것.

---

## 7. 로드맵 제안 (우선순위순)

| 순위 | 항목 | 근거 | 비용 |
|---|---|---|---|
| ~~P1~~ | ~~`drift-check.sh`~~ — **완료(2026-08-31)** | R4 실사례 — 모르는 drift가 롤백 사고로 직결 | 완료 |
| ~~P2~~ | ~~`/auth/request-reset` 테스트~~ — **완료(2026-08-31)** | 마지막 미커버 일반 라우트 | 완료 |
| ~~P3~~ | ~~배치 only_test + test_batch~~ — **완료(2026-09-03)** | 배치 사각지대 해소 | 완료 |
| ~~P4~~ | ~~login_events 오염 해소(LE_REAL) + JWT 검증~~ — **완료(2026-09-03)** | §6.3·§6.4 공통 선결 과제 | 완료 |
| ~~P5~~ | ~~L2 런타임 자동화(헤드리스 브라우저)~~ — **완료(2026-09-03)** | 수동 스모크의 자동화 | 완료 |
| ~~P6~~ | ~~임시 dev 환경 설계~~ — **채택 안 함(2026-09-03)** | 라벨 격리로 충분, 비용·운영 부담 최대 | — |

> 정교화 로드맵(A flaky·B 스냅샷·B' 배치·C 스키마·P1~P5) **전 항목 완료**. P6(임시 dev
> 환경)는 근본 격리책이나, 현재 `[테스트]` 라벨 격리가 실무상 충분히 안전하고 인프라 비용·
> 운영 부담이 커 **채택하지 않는다**(재론 시 §6.1). 남은 것은 상시 자동화(§6.6 CI)뿐.

P1·P2는 2026-08-31 완료(일반 라우트 22/22 커버). P3부터는 운영 Lambda 수정이 필요하므로
변경 자체를 이 하네스의 표준 루프로 진행한다.
