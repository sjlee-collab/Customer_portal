# AWS 마이그레이션 인프라 코드

Supabase → AWS(RDS + S3 + Lambda + API Gateway) 마이그레이션 작업용 코드.
`index.html`은 Phase 6(마지막)에서만 수정하며, 그 전까지 이 디렉토리에는 백엔드 인프라 코드만 쌓인다.

## 구성

- `schema.sql` — RDS(PostgreSQL) 전체 스키마 (테이블, FK, 시퀀스, 트리거, 함수)
- `fix-sequence-and-triggers.sql` — Phase 1 마이그레이션 중 schema.sql에서 누락된 시퀀스/트리거 보강 패치 (참고용, 이미 RDS에 적용됨)
- `lambda/notify-handler/` — Slack 알림 발송 (VPC 밖, DB 접속 없음)
- `lambda/send-email/` — Microsoft Graph API 이메일 발송 (VPC 밖, DB 접속 없음)
- `lambda/api-layer/` — 티켓 생성/상태변경/담당자배정 API (VPC 안, RDS 직접 연결)

## 배포 방법

각 `lambda/<함수명>/` 디렉토리에서:

```bash
npm install --omit=dev
zip -rq ../<함수명>.zip .
```

생성된 zip을 Lambda 콘솔에서 업로드. `notify-handler`/`send-email`은 의존성이 없어 zip에 `index.mjs`, `package.json`만 있으면 된다.

## 인프라 요약

- RDS: PostgreSQL, VPC 프라이빗 서브넷, 퍼블릭 액세스 비활성화
- S3: `bigxdata-portal-documents`(공개), `bigxdata-portal-ticket-attachments`(공개), `bigxdata-portal-contract-attachments`(비공개)
- NAT 인스턴스(`customer-portal-nat`, t3.micro): `lambda-private-subnet`(172.31.100.0/24)의 인터넷 아웃바운드 전용, NAT Gateway 대신 사용해 비용 절감
- API Gateway(`customer-portal-api`) → `api-layer` Lambda(VPC) → RDS 직접 쓰기 + `notify-handler`/`send-email` Lambda 직접 호출(Invoke)
- 지연 티켓 알림(`OVERDUE_BATCH`)은 pg_cron 대신 EventBridge Scheduler로 대체 예정
