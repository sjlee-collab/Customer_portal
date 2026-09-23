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

- [ ] **A1** dev 시크릿 3종 (`customer-portal/dev-jwt`, `dev-slack-webhooks`, `dev-ms-graph`)
- [ ] **A2** dev S3 버킷 3종 (+버저닝·라이프사이클·CORS·암호화)
- [ ] **A3** `customer_portal_dev` DB 생성 + 전체 복사 + 시퀀스 동기화
- [ ] **B1** dev 실행롤 (VPC용 / 비VPC용)
- [ ] **B2** dev Lambda 7종
- [ ] **B3** dev API Gateway + 라우트 46개 + authorizer + 액세스 로그
- [ ] **--- 여기서 중단하고 보고 ---**
- [ ] **C1** 개발 Amplify 앱(`dlayoierdftk6`) 리라이트 2줄 전환
- [ ] **C2** 검증 (로그인·티켓 생성·알림·메일 격리)

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
