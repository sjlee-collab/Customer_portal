// RDS 접속 — 비밀번호는 Secrets Manager에서 읽어온다.
//
// 예전에는 DB_PASSWORD 환경변수에 비밀번호를 박아뒀는데, RDS 마스터 시크릿이 7일마다
// 자동 회전되기 때문에 회전될 때마다 환경변수가 낡아 인증이 깨졌다(2026-08-06에 실제로
// 약 50분간 로그인 장애 발생). 그래서 실행 시점에 시크릿을 읽고, 인증 오류가 나면
// 시크릿을 다시 읽어 한 번 재시도한다 — 회전이 나도 스스로 복구된다.

import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const DB_SECRET_ID = process.env.DB_SECRET_ID;
const sm = DB_SECRET_ID ? new SecretsManagerClient({}) : null;

let pool = null;

// RDS 서버 인증서 검증용 CA(2026-09-18, S-1). 예전엔 rejectUnauthorized:false로 암호화만 하고 상대를
// 확인하지 않아, VPC 안에서 DB 주소를 가로채는 쪽이 있으면 자격증명·데이터가 넘어갈 수 있었다.
// 아래는 AWS 공식 truststore의 ap-northeast-2 리전 번들(루트 CA 3개: RSA2048/RSA4096/ECC384 G1,
// 만료 2061~2121). 이 인스턴스(csdb)는 rds-ca-rsa2048-g1을 쓴다. 배포 도구가 .mjs만 갱신하므로
// 별도 .pem 파일 대신 소스에 그대로 둔다. 갱신 출처: https://truststore.pki.rds.amazonaws.com/ap-northeast-2/ap-northeast-2-bundle.pem
const RDS_CA = `
-----BEGIN CERTIFICATE-----
MIICuDCCAj2gAwIBAgIQSAG6j2WHtWUUuLGJTPb1nTAKBggqhkjOPQQDAzCBmzEL
MAkGA1UEBhMCVVMxIjAgBgNVBAoMGUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4x
EzARBgNVBAsMCkFtYXpvbiBSRFMxCzAJBgNVBAgMAldBMTQwMgYDVQQDDCtBbWF6
b24gUkRTIGFwLW5vcnRoZWFzdC0yIFJvb3QgQ0EgRUNDMzg0IEcxMRAwDgYDVQQH
DAdTZWF0dGxlMCAXDTIxMDUyMDE2MzgyNloYDzIxMjEwNTIwMTczODI2WjCBmzEL
MAkGA1UEBhMCVVMxIjAgBgNVBAoMGUFtYXpvbiBXZWIgU2VydmljZXMsIEluYy4x
EzARBgNVBAsMCkFtYXpvbiBSRFMxCzAJBgNVBAgMAldBMTQwMgYDVQQDDCtBbWF6
b24gUkRTIGFwLW5vcnRoZWFzdC0yIFJvb3QgQ0EgRUNDMzg0IEcxMRAwDgYDVQQH
DAdTZWF0dGxlMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE2eqwU4FOzW8RV1W381Bd
olhDOrqoMqzWli21oDUt7y8OnXM/lmAuOS6sr8Nt61BLVbONdbr+jgCYw75KabrK
ZGg3siqvMOgabIKkKuXO14wtrGyGDt7dnKXg5ERGYOZlo0IwQDAPBgNVHRMBAf8E
BTADAQH/MB0GA1UdDgQWBBS1Acp2WYxOcblv5ikZ3ZIbRCCW+zAOBgNVHQ8BAf8E
BAMCAYYwCgYIKoZIzj0EAwMDaQAwZgIxAJL84J08PBprxmsAKPTotBuVI3MyW1r8
xQ0i8lgCQUf8GcmYjQ0jI4oZyv+TuYJAcwIxAP9Xpzq0Docxb+4N1qVhpiOfWt1O
FnemFiy9m1l+wv6p3riQMPV7mBVpklmijkIv3Q==
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIECTCCAvGgAwIBAgIRAPQAvihfjBg/JDbj6U64K98wDQYJKoZIhvcNAQELBQAw
gZwxCzAJBgNVBAYTAlVTMSIwIAYDVQQKDBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJ
bmMuMRMwEQYDVQQLDApBbWF6b24gUkRTMQswCQYDVQQIDAJXQTE1MDMGA1UEAwws
QW1hem9uIFJEUyBhcC1ub3J0aGVhc3QtMiBSb290IENBIFJTQTIwNDggRzExEDAO
BgNVBAcMB1NlYXR0bGUwIBcNMjEwNTIwMTYyODQxWhgPMjA2MTA1MjAxNzI4NDFa
MIGcMQswCQYDVQQGEwJVUzEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNlcywg
SW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzELMAkGA1UECAwCV0ExNTAzBgNVBAMM
LEFtYXpvbiBSRFMgYXAtbm9ydGhlYXN0LTIgUm9vdCBDQSBSU0EyMDQ4IEcxMRAw
DgYDVQQHDAdTZWF0dGxlMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA
vJ9lgyksCxkBlY40qOzI1TCj/Q0FVGuPL/Z1Mw2YN0l+41BDv0FHApjTUkIKOeIP
nwDwpXTa3NjYbk3cOZ/fpH2rYJ++Fte6PNDGPgKppVCUh6x3jiVZ1L7wOgnTdK1Q
Trw8440IDS5eLykRHvz8OmwvYDl0iIrt832V0QyOlHTGt6ZJ/aTQKl12Fy3QBLv7
stClPzvHTrgWqVU6uidSYoDtzHbU7Vda7YH0wD9IUoMBf7Tu0rqcE4uH47s2XYkc
SdLEoOg/Ngs7Y9B1y1GCyj3Ux7hnyvCoRTw014QyNB7dTatFMDvYlrRDGG14KeiU
UL7Vo/+EejWI31eXNLw84wIDAQABo0IwQDAPBgNVHRMBAf8EBTADAQH/MB0GA1Ud
DgQWBBQkgTWFsNg6wA3HbbihDQ4vpt1E2zAOBgNVHQ8BAf8EBAMCAYYwDQYJKoZI
hvcNAQELBQADggEBAGz1Asiw7hn5WYUj8RpOCzpE0h/oBZcnxP8wulzZ5Xd0YxWO
0jYUcUk3tTQy1QvoY+Q5aCjg6vFv+oFBAxkib/SmZzp4xLisZIGlzpJQuAgRkwWA
6BVMgRS+AaOMQ6wKPgz1x4v6T0cIELZEPq3piGxvvqkcLZKdCaeC3wCS6sxuafzZ
4qA3zMwWuLOzRftgX2hQto7d/2YkRXga7jSvQl3id/EI+xrYoH6zIWgjdU1AUaNq
NGT7DIo47vVMfnd9HFZNhREsd4GJE83I+JhTqIxiKPNxrKgESzyADmNPt0gXDnHo
tbV1pMZz5HpJtjnP/qVZhEK5oB0tqlKPv9yx074=
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIGCTCCA/GgAwIBAgIRAN7Y9G9i4I+ZaslPobE7VL4wDQYJKoZIhvcNAQEMBQAw
gZwxCzAJBgNVBAYTAlVTMSIwIAYDVQQKDBlBbWF6b24gV2ViIFNlcnZpY2VzLCBJ
bmMuMRMwEQYDVQQLDApBbWF6b24gUkRTMQswCQYDVQQIDAJXQTE1MDMGA1UEAwws
QW1hem9uIFJEUyBhcC1ub3J0aGVhc3QtMiBSb290IENBIFJTQTQwOTYgRzExEDAO
BgNVBAcMB1NlYXR0bGUwIBcNMjEwNTIwMTYzMzIzWhgPMjEyMTA1MjAxNzMzMjNa
MIGcMQswCQYDVQQGEwJVUzEiMCAGA1UECgwZQW1hem9uIFdlYiBTZXJ2aWNlcywg
SW5jLjETMBEGA1UECwwKQW1hem9uIFJEUzELMAkGA1UECAwCV0ExNTAzBgNVBAMM
LEFtYXpvbiBSRFMgYXAtbm9ydGhlYXN0LTIgUm9vdCBDQSBSU0E0MDk2IEcxMRAw
DgYDVQQHDAdTZWF0dGxlMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA
4BEPCiIfiK66Q/qa8k+eqf1Q3qsa6Xuu/fPkpuStXVBShhtXd3eqrM0iT4Xxs420
Va0vSB3oZ7l86P9zYfa60n6PzRxdYFckYX330aI7L/oFIdaodB/C9szvROI0oLG+
6RwmIF2zcprH0cTby8MiM7G3v9ykpq27g4WhDC1if2j8giOQL3oHpUaByekZNIHF
dIllsI3RkXmR3xmmxoOxJM1B9MZi7e1CvuVtTGOnSGpNCQiqofehTGwxCN2wFSK8
xysaWlw48G0VzZs7cbxoXMH9QbMpb4tpk0d+T8JfAPu6uWO9UwCLWWydf0CkmA/+
D50/xd1t33X9P4FEaPSg5lYbHXzSLWn7oLbrN2UqMLaQrkoEBg/VGvzmfN0mbflw
+T87bJ/VEOVNlG+gepyCTf89qIQVWOjuYMox4sK0PjzZGsYEuYiq1+OUT3vk/e5K
ag1fCcq2Isy4/iwB2xcXrsQ6ljwdk1fc+EmOnjGKrhuOHJY3S+RFv4ToQBsVyYhC
XGaC3EkqIX0xaCpDimxYhFjWhpDXAjG/zJ+hRLDAMCMhl/LPGRk/D1kzSbPmdjpl
lEMK5695PeBvEBTQdBQdOiYgOU3vWU6tzwwHfiM2/wgvess/q0FDAHfJhppbgbb9
3vgsIUcsvoC5o29JvMsUxsDRvsAfEmMSDGkJoA/X6GECAwEAAaNCMEAwDwYDVR0T
AQH/BAUwAwEB/zAdBgNVHQ4EFgQUgEWm1mZCbGD6ytbwk2UU1aLaOUUwDgYDVR0P
AQH/BAQDAgGGMA0GCSqGSIb3DQEBDAUAA4ICAQBb4+ABTGBGwxK1U/q4g8JDqTQM
1Wh8Oz8yAk4XtPJMAmCctxbd81cRnSnePWw/hxViLVtkZ/GsemvXfqAQyOn1coN7
QeYSw+ZOlu0j2jEJVynmgsR7nIRqE7QkCyZAU+d2FTJUfmee+IiBiGyFGgxz9n7A
JhBZ/eahBbiuoOik/APW2JWLh0xp0W0GznfJ8lAlaQTyDa8iDXmVtbJg9P9qzkvl
FgPXQttzEOyooF8Pb2LCZO4kUz+1sbU7tHdr2YE+SXxt6D3SBv+Yf0FlvyWLiqVk
GDEOlPPTDSjAWgKnqST8UJ0RDcZK/v1ixs7ayqQJU0GUQm1I7LGTErWXHMnCuHKe
UKYuiSZwmTcJ06NgdhcCnGZgPq13ryMDqxPeltQc3n5eO7f1cL9ERYLDLOzm6A9P
oQ3MfcVOsbHgGHZWaPSeNrQRN9xefqBXH0ZPasgcH9WJdsLlEjVUXoultaHOKx3b
UCCb+d3EfqF6pRT488ippOL6bk7zNubwhRa/+y4wjZtwe3kAX78ACJVcjPobH9jZ
ErySads5zdQeaoee5wRKdp3TOfvuCe4bwLRdhOLCHWzEcXzY3g/6+ppLvNom8o+h
Bh5X26G6KSfr9tqhQ3O9IcbARjnuPbvtJnoPY0gz3EHHGPhy0RNW8i2gl3nUp0ah
PtjwbKW0hYAhIttT0Q==
-----END CERTIFICATE-----
`;

// 시크릿을 못 읽는 상황(권한·네트워크 문제)에서도 서비스가 멈추지 않도록
// 기존 DB_PASSWORD 환경변수를 폴백으로 남겨둔다.
async function resolveCredentials() {
  if (sm) {
    try {
      const res = await sm.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ID }));
      const s = JSON.parse(res.SecretString);
      if (s.password) return { user: s.username || process.env.DB_USER, password: s.password };
    } catch (err) {
      console.error('[db] Secrets Manager 조회 실패 — DB_PASSWORD 폴백 사용', err);
    }
  }
  return { user: process.env.DB_USER, password: process.env.DB_PASSWORD };
}

async function createPool() {
  const { user, password } = await resolveCredentials();
  return new pg.Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user,
    password,
    ssl: { rejectUnauthorized: true, ca: RDS_CA }, // 서버 인증서를 리전 CA로 검증 (호스트명은 DB_HOST=RDS 엔드포인트)
    max: 3,
  });
}

export async function getPool() {
  if (!pool) pool = await createPool();
  return pool;
}

// 비밀번호가 회전된 뒤 낡은 자격증명으로 만들어진 풀은 버리고 새로 만든다.
async function resetPool() {
  const old = pool;
  pool = null;
  if (old) { try { await old.end(); } catch (_) {} }
}

// 잘못된 비밀번호는 PostgreSQL 28P01(invalid_password)로 온다.
function isAuthError(err) {
  return !!err && (err.code === '28P01' || /password authentication failed/i.test(err.message || ''));
}

export async function query(sql, params = []) {
  try {
    const { rows } = await (await getPool()).query(sql, params);
    return rows;
  } catch (err) {
    if (!isAuthError(err)) throw err;
    console.warn('[db] 인증 실패 — 비밀번호 회전 가능성. 시크릿을 다시 읽고 1회 재시도합니다.');
    await resetPool();
    const { rows } = await (await getPool()).query(sql, params);
    return rows;
  }
}
