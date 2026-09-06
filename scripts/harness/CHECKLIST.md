# 변경 체크리스트 (유형별)

모든 변경 공통 마무리: `guard-commit.sh` → commit → `promote.sh` → `run-regression.sh`.
`promote.sh`는 main을 dev/Design/notion-migration/stats에 **ff-only**로 전파한다 — 대상이 앞서 있거나
갈라져 있으면 건드리지 않고 보고만 한다(rc 1). 밀기 전에 확인하려면 `--dry-run`.

## 1) 프론트만 (index.html)
- [ ] 편집
- [ ] `node scripts/harness/l2-smoke.mjs` — 문법·핸들러·DOM id 정적 검사(1초, 필수)
- [ ] `run-regression.sh l2_runtime` — 헤드리스로 콘솔 에러 0·렌더·실로그인 자동 확인 (수동 대안: 로컬 프리뷰 + smoke-frontend.js 붙여넣기)
- [ ] `guard-commit.sh index.html` → commit → `promote.sh`

## 2) data-api 변경 (범용 CRUD/권한/격리 로직)
- [ ] `backend/lambda/data-api/index.mjs` 편집
- [ ] `deploy-fn.sh data-api` (drift 진단 → 배포 → data-api 스모크)
      ⚠ **종료코드 3 = 파괴적 drift**(배포본에만 있는 줄이 사라짐 — 운영 핫픽스를 덮는 상황).
      `drift-check.sh data-api`로 전체 diff를 보고, 배포본이 앞서면 **레포를 먼저 역동기화**할 것.
      의도한 삭제가 확실할 때만 `--force`. 판정만 보려면 `--dry-run`
- [ ] `run-regression.sh` (권한/격리/삭제/고객 전 기능 재검증)
- [ ] guard-commit(소스+필요시 index.html) → commit → promote

## 3) api-layer 변경 (티켓 액션/알림/인증)
- [ ] `backend/lambda/api-layer/index.mjs` 편집 (⚠ db/notify/jwt.mjs는 그대로 두면 됨 — deploy-fn이 4개 다 포함)
- [ ] `deploy-fn.sh api-layer` (로그인 스모크까지)
- [ ] `run-regression.sh`
- [ ] commit → promote

## 4) DDL (스키마/제약 변경) — 5432 직접접속 불가
- [ ] `backend/schema.sql` 갱신(소스 동기화)
- [ ] 마이그레이션 경로로 실제 적용: public-inquiry `__migrate` 임시 패치 → invoke `{"__migrate":true}` → **원복**
      (단일 statement씩 실행, 제약 변경은 기존목록의 상위집합으로 ADD해야 안전)
- [ ] 적용 검증(대상 테이블 조회)
- [ ] `run-regression.sh`

## 5) 권한(role_permissions) 변경 / 새 기능키
- [ ] 프론트 `PERM_COLS` / `PERM_DEFAULT` + 매트릭스 헤더 라벨 + `sepCols` 인덱스
- [ ] 새 feature_key면: role_permissions **feature_key CHECK 제약에 추가(DDL, 4번 경로)** + 역할별 시드 행 INSERT
      (⚠ 백엔드 hasPermission은 DB를 읽으므로 시드 행이 없으면 non-admin은 거부됨)
- [ ] `data-perm="키"`(정적) 또는 `permState[role]?.키`(동적 렌더)로 노출 게이팅
- [ ] api-layer/data-api에서 `hasPermission(role,'키')`로 서버 강제
- [ ] `run-regression.sh`

## 6) 하네스 자체 수정 (테스트·헬퍼 추가/변경)
- [ ] 설계 원칙 확인 — [DESIGN.md](DESIGN.md) §4.1(결함 클래스 봉쇄) · §5(확장 규칙)
- [ ] 픽스처는 `Fixtures`, 목록 단언은 `t.all_of`, 권한 토글은 `with permission(...)`,
      id 추출은 `must_id()` — 옛 패턴은 `test_harness_lint`가 막는다
- [ ] `python scripts/harness/tests/test_harness_lint.py` (AWS 불필요, 1초)
- [ ] `python scripts/harness/tests/test_itest_helpers.py` (헬퍼를 고쳤다면 필수)
- [ ] 부채를 줄였으면 `test_harness_lint.py --update-baseline`으로 기준선 낮추기
- [ ] 새 스위트면 `run-regression.sh`의 `ALL`(+알림 무관하면 `PAR_SAFE`)와 README 목록에 등록

## 알림 안전 (슬랙·메일이 트리거되는 테스트) — 필수 규칙
원칙: **운영 메일은 항상 정상 발송(실수신자), 테스트성 메일만 sjlee로.**
1. **메일 — 수신자 주소로 구분(전역 리다이렉트 없음)**: send-email은 on/off 무관하게 **항상 운영**(TEST_EMAIL_OVERRIDE/TEST_TAG 비움). 테스트가 만드는 메일은 `lib/itest.py`의 `temail()`이 수신자를 sjlee 싱크(`sjlee+태그@bigxdata.io`)로 지정하므로 **그 메일만 sjlee로** 간다. ⚠️ **알림-트리거 테스트는 반드시 `temail()` 싱크 수신자를 쓸 것**(실주소를 쓰면 실발송됨). 예전의 전역 sink 리다이렉트는 운영 메일까지 막아서 제거함.
2. **슬랙 — `[테스트]` 제목/기업명으로 자동 라우팅(전역 스위치 없음)**: notify-handler·public-inquiry는 알림 대상 데이터의 **제목 또는 기업명이 `[테스트]`로 시작하면** 실 채널 대신 테스트 채널(`SLACK_WEBHOOK_TEST`)로만 발송(본문에 `(원래 대상: 채널명)` 표기 + `[테스트]` 헤더 접두). **운영 알림은 항상 실 채널.** 즉 `email-safe.sh on/off`와 무관하게 코드가 라벨로 자동 구분한다. 테스트웹훅 주소는 Lambda 환경변수(`SLACK_WEBHOOK_TEST`)에만 보관(레포에 없음). ⚠️ **알림-트리거 테스트는 반드시 `tname()`/`temail()`로 `[테스트]` 라벨을 붙일 것**(안 붙이면 실 채널로 감).
3. **데이터 라벨**: 테스트 데이터는 이름/제목에 `[테스트]` 라벨(`tname()`/`temail()`) → 슬랙 라우팅 판정·본문·메일 제목에 그대로 반영. + admin 직접 insert(알림 없음) + 종료 시 정리.
- 라벨 라우팅은 상시 동작이라 별도 on/off 창이 필요 없다. `email-safe.sh on/off`는 예전 `SLACK_REDIRECT`/`TEST_EMAIL_OVERRIDE` 잔여값을 지워 **운영 상태로 리셋**하는 용도(둘 다 동일 동작). 매일 09:00 배치도 실 티켓이면 실 채널로 정상 발송. 상태 확인: `email-safe.sh status`.
- 중단 등으로 남은 잔여물은 `bash scripts/harness/sweep.sh`(미리보기) / `--delete`(삭제)로 라벨 기반 청소.

## 알림 Lambda(notify-handler/send-email) 변경 시
- `TEST_TAG` env가 있으면 슬랙 헤더·메일 제목에 그 값을 접두하도록 유지(테스트 표기 규칙 2의 근거).
- 배포는 `deploy-fn.sh notify-handler` / `deploy-fn.sh send-email`(drift 진단 → 배포). notify-handler도 매핑에 포함됨.
