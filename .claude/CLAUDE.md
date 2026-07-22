# 고객지원포탈 프로젝트 규칙

## 프로젝트 개요

- **목적:** 빅스데이터 주식회사 B2B 고객지원 포탈 (약 302개 고객사)
- **상태:** 운영 중 (2026-07-22 기준)
- **Supabase project ID:** `ozmuxppuyuyhojmdiism`

---

## GitHub / Vercel 구성

| 구분 | GitHub repo | 브랜치 | Vercel URL |
|------|-------------|--------|------------|
| 운영 | sjlee-collab/Customer_portal | main | support-one-blue.vercel.app |
| 개발 | sjlee-collab/Customer_portal | dev | develope-five.vercel.app |

- 로컬 git remote: `origin` → `sjlee-collab/Customer_portal`
- 메인 소스 파일: `개발/2.설계/index.html` (6000+ 라인, 단일 HTML SPA)
- 루트 `index.html`은 위 파일의 복사본 — 항상 동기화 필요

---

## 필수 규칙

### 1. index.html 수정 후 자동 배포
`개발/2.설계/index.html` 수정 완료 즉시 **확인 없이** git add → commit → push 자동 진행.
- 루트 `index.html`도 동일하게 복사 반영
- 푸시 대상: `sjlee-collab/Customer_portal` (현재 브랜치 기준)

### 2. DB 연동 필수
모든 화면 변경(생성/수정/삭제/상태변경)은 반드시 **Supabase DB에 실제 반영**해야 한다.
- 로컬 상태만 업데이트하는 방식 금지
- Supabase client가 null일 때만 샘플 데이터 폴백 허용
- 저장 후 해당 데이터를 다시 fetch해서 UI 갱신
- 관련 테이블: `tickets`, `users`, `companies`, `ticket_history`, `documents`, `faq`, `log_notification`

### 3. 개발현황.html 수정 금지
이 채팅에서 진척 보고 요청이 와도 `개발현황.html` 파일은 건드리지 않는다.
텍스트/마크다운으로만 응답. 파일 반영은 사용자가 명시적으로 요청할 때만.

---

## 기술 스택

- **Frontend:** 바닐라 JS, 단일 HTML 파일 SPA
- **DB:** Supabase (PostgreSQL)
- **Edge Functions:** `notify-handler` (Slack 알림), `send-email` (이메일)
- **자동화:** pg_cron → 매일 KST 09:00 지연 티켓 Slack 알림 (`OVERDUE_BATCH`)

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
- 지연 알림 자동화 (pg_cron, 매일 KST 09:00)
- 권한 관리 화면 (역할×기능 매트릭스, `data-roles="admin"` — 관리자만 표시)
- 공지사항, 자료실, 고객사/사용자 관리, 연동 관리, 알림 로그

## 대기 중 작업

- 노션 기술지원 내역 → 포탈 배치 연동 (노션 DB 구조 확인 필요)
