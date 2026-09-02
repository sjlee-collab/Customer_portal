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
3. **로그인 없이 역할 재현.** API Gateway/JWT를 우회해 Lambda를 직접 invoke하면서
   `authorizer.lambda` 컨텍스트(role/userId/companyId/…)를 주입한다. 비밀번호·토큰 관리 없이
   전 역할 매트릭스를 돌릴 수 있고, authorizer 이후의 서버 로직(권한·격리)을 정확히 겨눈다.
   단 authorizer 자체는 이 방식으로 검증되지 않는다(§6.4).
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
| L2-런타임 | 프론트 렌더·핵심 함수 실동작 | `smoke-frontend.js`를 프리뷰 콘솔에 붙여넣기 | **수동** |
| 스모크 | 배포 직후 생존 확인(비파괴) | `smoke.sh` (HTTP), deploy-fn 내장 스모크 | 반자동 |
| L3 | 실브라우저 로그인 E2E | — | **부재**(§6.3) |

### 3.3 테스트 데이터 생성 전략

- 픽스처(회사·유저·티켓 시드)는 **admin 직접 insert**(data-api) — 알림이 안 걸려 조용하다.
- 검증 대상 행위(등록·상태변경·배정·답글)는 **실 api-layer 경로** — 알림·이력까지 실동작을 본다.
- 성공 로그인은 하지 않는다 — `login_events`가 남고 itest로 지울 수 없어 통계를 오염시킨다.
  로그인 핸들러 생존은 401/404 분기로 증명한다(순단이면 500).

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
| **배치 3종(overdue_batch·license_expiry_notice·expire_contracts)** | **❌ 설계상 invoke 금지** | §6.2 |

### 기타 Lambda

| Lambda | 테스트 |
|---|---|
| data-api | test_permissions(격리·직접쓰기 차단), 전 테스트의 픽스처 경로 |
| storage-api | test_storage_rules(확장자·용량·소유권) |
| public-inquiry | smoke.sh(허니팟 비파괴) — L1 테스트는 없음 |
| jwt-authorizer | **❌ 우회 방식이라 구조적으로 미커버**(§6.4) |
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
브랜치)는 전체 원복 후 폐기됐다. 비용 제약(WAF도 비용으로 기각된 이력)을 감안하면
상시 dev 환경보다 **필요 시 기동/폐기하는 임시 환경**(RDS 스냅샷 복원 + Lambda 별칭 +
테스트 전용 스테이지)이 현실적 후보. 그 전까지는 라벨 격리가 유일한 방어선이므로
라벨 규칙 위반을 최우선 리뷰 항목으로 둔다.

### 6.2 배치 3종은 테스트로 invoke하면 안 된다
`overdue_batch` 등은 **전체 티켓을 스캔**하므로 테스트에서 호출하면 실 운영 티켓의 알림이
실 채널로 중복 발송된다. 현재는 배치가 사용하는 판정 함수(`isOverdue` 등)를 상태 변경 경로에서
간접 검증하는 데서 멈춘다. 안전하게 만들려면 배치 핸들러가 `{"task":"...","only_test":true}`
같은 파라미터로 `[테스트]` 라벨 행만 스캔하는 모드를 지원해야 한다(운영 코드 수정 필요 — 미착수).

### 6.3 L2 런타임 자동화·L3 부재 (정적 검사는 l2-smoke.mjs로 확보, 2026-09-01)
프론트 스모크는 콘솔 붙여넣기(수동)다. 실브라우저 로그인 E2E는 초대→재설정 토큰 경로가
필요해 미구현. 도입한다면 테스트 계정의 reset_token을 DB로 직접 심는 방식이 로그인 화면
의존 없이 가능하다. 단 성공 로그인의 login_events 오염 문제(§3.3)를 먼저 풀어야 한다
(테스트 계정 필터링 또는 이벤트 삭제 API).

### 6.4 jwt-authorizer는 구조적 사각지대
invoke 방식이 authorizer를 우회하므로 JWT 검증 자체(서명·만료·클레임 주입)는 미검증.
smoke.sh의 "인증보호" 항목이 무토큰 거부만 확인한다. 보강하려면 실 JWT를 발급받는 경로가
필요한데 이는 성공 로그인 문제와 같은 뿌리다.

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
| P3 | 배치 `only_test` 모드 + 배치 테스트 | 마감일 오판 같은 배치 버그의 직접 검증 수단 확보 | 운영 코드 수정 필요 — 신중 |
| P4 | login_events 테스트 오염 해소 → 성공 로그인·JWT 검증 | §6.3·§6.4의 공통 선결 과제 | 운영 코드 수정 필요 |
| P5 | L2 자동화(헤드리스 브라우저) | 수동 스모크의 자동화 | 도구 도입 |
| P6 | 임시 dev 환경 설계 | 근본 해결이나 비용·운영 부담 최대 | 인프라 |

P1·P2는 2026-08-31 완료(일반 라우트 22/22 커버). P3부터는 운영 Lambda 수정이 필요하므로
변경 자체를 이 하네스의 표준 루프로 진행한다.
