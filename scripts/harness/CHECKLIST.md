# 변경 체크리스트 (유형별)

모든 변경 공통 마무리: `guard-commit.sh` → commit → `promote.sh`(4브랜치) → `run-regression.sh`.

## 1) 프론트만 (index.html)
- [ ] 편집
- [ ] 로컬 프리뷰(.claude/launch.json)로 콘솔 에러 0 / 핵심 렌더 확인 (L2: tests/smoke_frontend.js)
- [ ] `guard-commit.sh index.html` → commit → `promote.sh`

## 2) data-api 변경 (범용 CRUD/권한/격리 로직)
- [ ] `aws-migration/lambda/data-api/index.mjs` 편집
- [ ] `deploy-fn.sh data-api` (drift 진단 → 배포 → data-api 스모크)
- [ ] `run-regression.sh` (권한/격리/삭제/고객 전 기능 재검증)
- [ ] guard-commit(소스+필요시 index.html) → commit → promote

## 3) api-layer 변경 (티켓 액션/알림/인증)
- [ ] `aws-migration/lambda/api-layer/index.mjs` 편집 (⚠ db/notify/jwt.mjs는 그대로 두면 됨 — deploy-fn이 4개 다 포함)
- [ ] `deploy-fn.sh api-layer` (로그인 스모크까지)
- [ ] `run-regression.sh`
- [ ] commit → promote

## 4) DDL (스키마/제약 변경) — 5432 직접접속 불가
- [ ] `aws-migration/schema.sql` 갱신(소스 동기화)
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

## 메일 안전 (알림 트리거되는 테스트)
- 켜기: `email-safe.sh on` → 테스트 → **끄기: `email-safe.sh off`** (공유 운영이라 켠 동안 실고객 메일도 리다이렉트됨 — 창을 짧게)
- 테스트 데이터는 이름/제목에 `[테스트]` 라벨(lib/itest.py `tname()`/`temail()`) + admin 직접 insert(알림 없음) + 종료 시 정리.
- 중단 등으로 남은 잔여물은 `bash scripts/harness/sweep.sh`(미리보기) / `--delete`(삭제)로 라벨 기반 청소.
