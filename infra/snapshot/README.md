# 인프라 구성 스냅샷

AWS 콘솔에만 있던 **설정**을 JSON으로 떠서 레포에 둔 것이다. 손으로 쓰지 않는다 —
`bash scripts/harness/infra-snapshot.sh` 가 덮어쓴다.

## 왜 있나

이 인프라에는 CloudFormation 스택이 없다(전부 콘솔·CLI 수작업). Lambda 소스와
`backend/schema.sql`은 레포에 있지만 **설정은 어디에도 없었다** — Lambda 환경변수,
API Gateway 라우트 46개, Amplify 리라이트(특정 고객사의 접속 가능 여부에 직결),
EventBridge 스케줄, S3 버킷 정책. 이게 사라지면 "원래 뭐였는지"를 알 길이 없다.

이 폴더는 **복원을 자동화하지 않는다.** 대신 두 가지를 해준다.

1. 전부 날아가도 **무엇이었는지**는 남는다 (손으로 복원할 수 있다)
2. 누가 콘솔에서 설정을 바꾸면 **다음 스냅샷의 git diff에 드러난다**

## 무엇이 들어 있나

| 파일 | 내용 |
|---|---|
| `lambda.json` | 함수 14개(운영 7 + dev 7) — 환경변수·메모리·타임아웃·VPC·역할 ARN·리소스 정책 |
| `apigateway.json` | HTTP API 2개 — 라우트 46개씩, 통합, 권한부여자, 스테이지 |
| `scheduler.json` | EventBridge 스케줄 3개 (매일 09:00 KST 배치) |
| `amplify.json` | 앱 2개 — **customRules(리라이트)**, 브랜치, 커스텀 도메인 |
| `s3.json` | 버킷 6개 — 정책·CORS·버저닝·라이프사이클·암호화·퍼블릭액세스블록 |
| `secrets.json` | Secrets Manager **이름과 메타만** (값은 가져오지 않는다) |
| `rds.json` | 인스턴스 설정 + 파라미터그룹에서 **기본값과 다른 것만** |
| `network.json` | Lambda·RDS가 실제로 쓰는 보안그룹 규칙과 서브넷 |
| `iam.json` | 실행 역할 8개 — 붙은 정책과 인라인 정책 문서 |
| `_meta.json` | 떠낸 시각·계정·수집 건수·실패 목록 |

## 비밀은 담지 않는다

- **값은 Secrets Manager에만 있다.** 여기 적히는 것은 그 *주소*(`customer-portal/jwt` 등)뿐이다.
- Lambda 환경변수 중 키 이름이 민감 패턴(SECRET/KEY/TOKEN/WEBHOOK…)에 걸리면서
  값이 시크릿 주소 형태가 아니면, 값 대신 **sha256 앞 12자와 길이**만 남긴다.
  값이 바뀐 것은 diff에 드러나지만 값 자체는 복원되지 않는다.
- 키 이름과 무관하게 값이 비밀 형태(슬랙 웹훅 URL, AKIA…, PEM, JWT)면 어디에 있든 가린다.

커밋 전에 한 번 더 확인하려면:

```bash
grep -rliE "hooks\.slack\.com|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-" infra/snapshot/
```

## 읽는 법 — 복원할 때

실수로 지웠거나 전부 날아갔을 때 보는 순서다.

1. `lambda.json` — 함수별 환경변수·메모리·타임아웃·VPC. **소스는 레포**(`backend/lambda/`)에 있으니
   둘을 합치면 함수를 되살릴 수 있다. 비밀값만 Secrets Manager에서 다시 넣는다.
2. `apigateway.json` — `routes[].RouteKey`가 경로, `Target`이 통합 id,
   `integrations[]`에서 그 id가 어느 Lambda를 가리키는지 본다.
3. `amplify.json` — `app.customRules`가 리라이트다. **순서가 중요하다**
   (`/api` → `/files/...` → SPA 폴백 `/<*>`). 순서가 바뀌면 프록시가 동작하지 않는다.
4. `iam.json` → `network.json` → `s3.json` 순으로 권한·네트워크·버킷 설정을 맞춘다.

## 바뀐 게 있는지만 보려면

```bash
bash scripts/harness/infra-snapshot.sh --check
```

갱신 후 `_meta.json`을 뺀 나머지에 변화가 있으면 그 목록을 찍고 **종료코드 1**로 끝난다.
변화가 의도한 것이면 그대로 커밋하고, 아니라면 콘솔에서 누가 무엇을 바꿨는지 확인한다.

## 한계

- **데이터는 담지 않는다.** RDS는 자동 백업 7일 + PITR, S3는 버저닝 + 90일 라이프사이클로 따로 보호된다.
- **복원은 수동이다.** 자동 복원이 필요하면 이 스냅샷을 입력 삼아 Terraform으로 옮기는 길(C안)이 있다.
- 계정 전체가 아니라 **이름에 `customer_portal`/`bigxdata`가 든 리소스만** 담는다.
