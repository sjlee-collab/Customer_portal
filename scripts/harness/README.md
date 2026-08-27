# 고객지원포탈 변경 하네스

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
| `bash scripts/harness/email-safe.sh on\|off\|status` | 테스트 모드 토글 — 메일 싱크 리다이렉트(무발송) + 슬랙·메일 `[테스트]` 태그(TEST_TAG) + **슬랙 테스트 채널 리다이렉트**(SLACK_REDIRECT) |
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
- `tests/test_customer_e2e.py` — **고객 계정 전 기능 정상성**(등록·목록·상세·수정·답글·첨부·계약/자료 조회·내정보) + 보안 차단
- `tests/smoke_frontend.js` — 프리뷰 콘솔에 붙여 프론트 핵심 확인(L2)
- 데이터 원칙: `[테스트]` 라벨 + admin 직접 insert(알림 없음) + 종료 시 정리(+ 잔여물 `sweep`). 개별 실행: `python scripts/harness/tests/test_customer_e2e.py`
- **슬랙 테스트 채널(필수)**: `email-safe.sh on` 이면 `SLACK_REDIRECT=1`이 설정되어 notify-handler·public-inquiry의 모든 슬랙 알림이
  실 채널(공통/영업/기술지원/교육) 대신 **테스트 전용 채널로만** 간다. 메시지 본문에 `(원래 대상: 채널명)`이 붙어 어디로 갈 알림이었는지 알 수 있다.
  테스트 채널 웹훅 주소는 **비밀값이라 레포에 두지 않고** 두 Lambda의 환경변수 `SLACK_WEBHOOK_TEST`에만 보관한다(등록 여부는 `email-safe.sh status`로 확인).
  주소를 바꾸려면 해당 Lambda의 환경변수만 교체하면 되고, 코드·스크립트 수정은 필요 없다.
- **알림 표기 원칙(필수)**: 테스트로 슬랙·메일이 나가면 "테스트용"임이 명시돼야 함 → 알림 트리거 테스트는 `email-safe.sh on`(메일 무발송 + `[테스트]` 태그)에서 실행하고 끝나면 `off`. 상세는 CHECKLIST "알림 안전" 참고.

## 한계
- 완전 격리는 별도 dev 환경이 있어야 완성(현재 공유 운영). 그전까진 안전 패턴(`[테스트]` 라벨·admin insert·cleanup/sweep·OVERRIDE)으로 최소화.
- 실 브라우저 클릭 E2E는 로그인 필요 → L2는 파싱/렌더/로직까지. 실로그인(비번) 테스트는 초대→재설정 토큰 경로 필요(미포함).
