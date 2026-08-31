# 고객지원포탈 변경 하네스
> 설계 근거(위험 모델·원칙·커버리지 맵·한계·로드맵)는 **[DESIGN.md](DESIGN.md)** 참고. 하네스 자체를 고칠 때는 그 문서 먼저.

운영 변경 시 "한 곳 고치면 다른 데 틀어짐 / 공유 운영 백엔드 / 병렬 세션 clobber / 4브랜치 수동 전파 / 로그인 순단"
같은 리스크를 줄이는 스크립트 + 회귀 테스트 모음. `amplify.yml`이 index.html만 배포하므로 `scripts/`는 웹에 노출되지 않는다.

전제: Git Bash + `aws.exe`(프로파일 `customer_portal`, 리전 ap-northeast-2) + `python`.

## 표준 변경 루프
1. 편집(레포 소스)
2. 프론트 스모크(프리뷰 콘솔·렌더 / `tests/smoke_frontend.js`)
3. 백엔드면 `deploy-fn.sh <fn>` — drift 진단·배포·스모크
4. DDL이면 마이그레이션 경로 적용 + 검증 (CHECKLIST 4번)
5. `run-regression.sh` — L1(권한/격리)+L1(삭제)+L1‑C(고객 전 기능)
6. `guard-commit.sh <파일…>` → commit → `promote.sh`

## 스크립트
| 명령 | 설명 |
|---|---|
| `bash scripts/harness/run-regression.sh` | 회귀 스위트 전체 실행(PASS/FAIL) |
| `bash scripts/harness/deploy-fn.sh <api-layer\|data-api\|public-inquiry\|send-email\|storage-api\|jwt-authorizer\|notify-handler>` | 안전 재배포(drift 진단→배포→스모크) |
| `bash scripts/harness/promote.sh` | main → dev/Design/QA ff 전파 + SHA 일치 검증 |
| `bash scripts/harness/guard-commit.sh [파일…]` | 커밋 전 clobber 점검(origin 최신·의도 파일만) |
| `bash scripts/harness/email-safe.sh on\|off\|status` | 운영 상태 리셋(잔여 리다이렉트/태그 env 제거). 테스트 격리는 자동 — **메일=temail() 싱크 수신자**, **슬랙=`[테스트]` 제목/기업명 자동 라우팅**(SLACK_WEBHOOK_TEST). status로 현재 env 확인 |
| `bash scripts/harness/apigw-route.sh list\|add "METHOD /path"` | API GW 라우트 조회/추가 |
| `bash scripts/harness/sweep.sh [--delete]` | `[테스트]` 라벨 잔여 데이터 미리보기/삭제(중단 뒷정리) |

## 테스트 데이터 규칙 (중요)
하네스가 만드는 **모든** 데이터는 이름/제목 필드에 반드시 `[테스트]` 라벨을 붙인다 —
운영 데이터에 섞여도 사람이 한눈에 "테스트"임을 알아보게 하기 위함. 라벨은 `lib/itest.py`에
중앙화되어 있으므로 새 테스트도 반드시 헬퍼를 쓴다:
- `tname('회사A')` → `"[테스트] 회사A"` (companies.name / tickets.title / contract_name / documents.title / users.name …)
- `temail('custA')` → `"sjlee+custA@bigxdata.io"` (실 고객 발송 방지, sink +태그)
- 정리: 각 테스트가 `finally`로 자기 데이터를 삭제하고, 그래도 남으면 `sweep.sh`가 라벨로 청소.
  라벨로만 지우므로 라벨 없는 운영 데이터는 절대 건드리지 않는다.

## 테스트
- `tests/test_permissions.py` — 역할별 권한/테넌트 격리/직접쓰기 차단/스태프 교차조회
- `tests/test_ticket_delete.py` — 요청 삭제 권한(ticket_delete) + cascade + 권한관리 동적 토글
- `tests/test_ticket_status.py` — **요청 상태 변경(접수 제외 6개 상태)**: 두 경로(`/status`·`/manage`) 전이 저장 · 6개 상태 전부 슬랙 발송 + event_type 분포(`completed`/`pending_customer` 고유, 나머지 4개 `status_change`) · 메일도 전 상태 발송(manage는 `send_email` 플래그) · 이력(`status_changed`)은 manage 경로만 기록 · 완료예정일 초과(기한 지남=추가 1건·당일=미발송·완료 전환=미발송) · content 원문 저장 · 고객 403 · 동일 상태 재저장 · 잘못된 상태값 거부. 알림은 `log_notification` 행으로 판정(비동기라 최대 30초 대기)
- `tests/test_ticket_assign.py` — **담당자 배정(`/assign`)**: 배정/재배정 저장·이름 스냅샷 · `assigned` 슬랙 + content의 (이전→새 담당) 표기 · 동일 담당자 무알림 · assign 경로 이력 미기록(현행) · 400/404/403
- `tests/test_notify_routing.py` — **슬랙 카테고리 팬아웃**: 등록·답글이 공통+카테고리 채널(영업/기술/교육)로 가는지 `recipient`로 판정 · 답글 알림은 고객 작성만(스태프 무알림) · 등록 접수 메일 1통
- `tests/test_stats_view.py` — 사용 통계 6개 엔드포인트(`active-users`/`login-history`/`tickets`/`companies`/`documents`/`company-detail`): 구조·고객 403·필터·집계 반영 + `stats_view` 동적 토글
- `tests/test_auth.py` — 인증: 로그인 분기(404/401) · 비밀번호 변경/확인 · 재설정(무효 토큰·관리자 재설정·권한상승 차단) · 초대 · 담당영업 조회
- `tests/test_customer_e2e.py` — **고객 계정 전 기능 정상성**(등록·목록·상세·수정·답글·첨부·계약/자료 조회·내정보) + 보안 차단
- `tests/smoke_frontend.js` — 프리뷰 콘솔에 붙여 프론트 핵심 확인(L2)
- 데이터 원칙: `[테스트]` 라벨 + admin 직접 insert(알림 없음) + 종료 시 정리(+ 잔여물 `sweep`). 개별 실행: `python scripts/harness/tests/test_customer_e2e.py`
- **슬랙 원칙 — `[테스트]` 라벨로 자동 라우팅(필수)**: notify-handler·public-inquiry는 알림 대상 데이터의 **제목/기업명이 `[테스트]`로 시작하면**
  실 채널(공통/영업/기술지원/교육) 대신 **테스트 전용 채널로만** 보낸다(운영 알림은 항상 실 채널). 메시지 본문에 `(원래 대상: 채널명)`이 붙어 어디로 갈 알림이었는지 알 수 있다.
  즉 `email-safe.sh on/off`와 무관하게 코드가 라벨로 상시 자동 구분하므로, 알림-트리거 테스트는 **반드시 `tname()`/`temail()`로 `[테스트]` 라벨**을 붙여야 실 채널로 새지 않는다.
  테스트 채널 웹훅 주소는 **비밀값이라 레포에 두지 않고** 두 Lambda의 환경변수 `SLACK_WEBHOOK_TEST`에만 보관한다(등록 여부는 `email-safe.sh status`로 확인). 주소 변경 시 환경변수만 교체하면 되고 코드·스크립트 수정은 불필요.
- **메일 원칙(필수)**: 운영 메일은 항상 정상 발송(실수신자), **테스트 메일만 sjlee**. send-email엔 전역 리다이렉트를 걸지 않으며(운영 차단 방지), 테스트 메일은 `temail()` 싱크 수신자(`sjlee+태그@bigxdata.io`)로 보내므로 그것만 sjlee로 간다. ⚠️ 알림-트리거 테스트는 **반드시 temail() 싱크 수신자** 사용. `email-safe.sh on/off`는 예전 리다이렉트/태그 잔여값을 지워 **운영 상태로 리셋**하는 용도(테스트 격리는 메일=싱크·슬랙=라벨로 자동). 상세는 CHECKLIST "알림 안전" 참고.

## 한계
- 완전 격리는 별도 dev 환경이 있어야 완성(현재 공유 운영). 그전까진 안전 패턴(`[테스트]` 라벨·admin insert·cleanup/sweep·OVERRIDE)으로 최소화.
- 실 브라우저 클릭 E2E는 로그인 필요 → L2는 파싱/렌더/로직까지. 실로그인(비번) 테스트는 초대→재설정 토큰 경로 필요(미포함).
