# -*- coding: utf-8 -*-
"""배포 직후 함수별 스모크 — **방금 배포한 그 함수**를 실제로 때린다.

왜 이게 있나
-----------
예전 deploy-fn.sh의 스모크는 api-layer가 아니면 전부 `dget('companies')`였다. 그건
data-api만 때린다. 즉 send-email·storage-api·notify-handler·public-inquiry·
jwt-authorizer를 어떻게 망가뜨려 배포해도 "✅ 배포 성공"이 찍혔다 — 7개 중 5개에서
스모크가 구조적으로 무의미했다.

가장 중요한 신호는 **모듈이 로드됐는가**다. api-layer를 부분 zip으로 올려 db.mjs가
빠졌을 때 로그인 전체가 순단된 적이 있는데(R6, 2026-08-12), 그 실패는 Lambda가
Runtime.ImportModuleError를 뱉는 형태로 나타난다. 그래서 모든 프로브는 "핸들러가
실제로 돌아 구조화된 응답을 냈다"를 확인한다 — 런타임 오류면 무조건 실패다.

비파괴 원칙: 어떤 프로브도 메일·슬랙을 보내지 않고 행을 만들지 않는다.
  · send-email    미지 type → ticket/requesterEmail 없음 400 (발송 분기 진입 전)
  · notify-handler 미지 type → switch default → results 빈 배열 (발송 없음)
  · public-inquiry 허니팟 → DB insert·Slack 이전에 200 반환
  · storage-api    없는 경로 → 404 (S3 미접촉)
  · jwt-authorizer 토큰 없음 → isAuthorized:false (검증 로직만 탐)
  · data-api       companies 1건 조회(읽기)
  · api-layer      없는 계정 로그인 → 401/404 (계정 생성·발송 없음)
"""
import os, sys, json

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from itest import invoke, ctx  # noqa: E402


def _ev(method, path, body=None, role=None, **c):
    """HTTP 형태 이벤트. role을 주면 authorizer 컨텍스트까지 주입한다."""
    e = ctx(role, **c) if role else {'requestContext': {'http': {'method': None}}}
    e['requestContext']['http']['method'] = method
    e['rawPath'] = path
    if body is not None:
        e['body'] = json.dumps(body, ensure_ascii=False)
    return e


def _err(r):
    """Lambda 런타임 오류(모듈 로드 실패 등)면 사유 문자열, 아니면 None.
    이게 R6(부분 zip 배포 → 로그인 순단)의 형태다."""
    if not isinstance(r, dict):
        return '응답 형식 이상: %r' % (r,)
    if r.get('_invoke_error'):
        return 'invoke 실패: %s' % r['_invoke_error']
    raw = r.get('raw')
    if isinstance(raw, dict) and raw.get('errorType'):
        return '%s: %s' % (raw.get('errorType'), str(raw.get('errorMessage'))[:200])
    return None


# ── 함수별 프로브 ─────────────────────────────────────────────────────────
def _p_api():
    r = invoke('api', _ev('POST', '/auth/login', {'email': 'zz-smoke@example.com', 'password': 'x'}))
    return r, r.get('status') in (400, 401, 404), '로그인 엔드포인트 status=%s' % r.get('status')


def _p_data():
    e = _ev('GET', '/data/companies', role='admin')
    e['queryStringParameters'] = {'select': 'id', 'limit': '1'}
    r = invoke('data', e)
    return r, r.get('status') == 200, 'companies 조회 status=%s' % r.get('status')


def _p_inquiry():
    # 허니팟 페이로드 — DB insert·Slack 이전에 200으로 빠진다(비파괴)
    r = invoke('inquiry', _ev('POST', '/public/account-inquiry', {
        'name': '[테스트] smoke', 'company': '[테스트] smoke', 'phone': '0',
        'email': 'smoke@smoke.test', 'website': 'bot-honeypot'}))
    return r, r.get('status') == 200, '계정문의 허니팟 status=%s' % r.get('status')


def _p_email():
    # 미지 type → 발송 분기에 못 들어가고 필수값 검증에서 400. 메일 안 나감.
    # (CONNECTION_TEST는 실제로 MS Graph 토큰을 받으므로 절대 쓰지 않는다.)
    r = invoke('email', {'type': '__SMOKE__'})
    return r, r.get('status') == 400, '필수값 검증 status=%s (발송 없음)' % r.get('status')


def _p_storage():
    r = invoke('storage', _ev('POST', '/storage/__smoke__', {}))
    return r, r.get('status') == 404, '라우팅 status=%s (S3 미접촉)' % r.get('status')


def _p_jwt():
    # 토큰 없음 → isAuthorized:false. statusCode가 없는 응답이라 raw로 온다.
    r = invoke('jwt', {'headers': {}})
    raw = r.get('raw')
    ok = isinstance(raw, dict) and raw.get('isAuthorized') is False
    return r, ok, '무토큰 거부=%s' % (raw if not ok else 'isAuthorized:false')


def _p_notify():
    # 미지 type → switch default → 발송 없이 200 + results 빈 배열.
    r = invoke('notify', {'type': '__SMOKE__'})
    body = r.get('body') if isinstance(r.get('body'), dict) else {}
    ok = r.get('status') == 200 and body.get('results') == []
    return r, ok, 'status=%s results=%r (발송 없음이어야 함)' % (r.get('status'), body.get('results'))


PROBES = {
    'api-layer':      ('로그인 엔드포인트', _p_api),
    'data-api':       ('companies 조회', _p_data),
    'public-inquiry': ('계정문의 허니팟', _p_inquiry),
    'send-email':     ('필수값 검증(발송 없음)', _p_email),
    'storage-api':    ('라우팅(S3 미접촉)', _p_storage),
    'jwt-authorizer': ('무토큰 거부', _p_jwt),
    'notify-handler': ('미지 type 무발송', _p_notify),
}


def smoke(key):
    """(ok, 메시지). 프로브가 없는 키는 실패로 본다 — 스모크 없는 배포를 성공으로
    보고하던 게 원래 문제였으므로, 모르는 함수는 조용히 넘기지 않는다."""
    ent = PROBES.get(key)
    if not ent:
        return False, '%s 용 스모크 프로브가 정의되지 않음 (lib/fnsmoke.py에 추가할 것)' % key
    desc, fn = ent
    try:
        r, ok, detail = fn()
    except Exception as e:                                   # noqa: BLE001
        return False, '%s — 프로브 예외: %r' % (desc, e)
    bad = _err(r)
    if bad:
        return False, '%s — 함수가 런타임 오류를 냄(모듈 로드 실패 의심): %s' % (desc, bad)
    return ok, '%s — %s' % (desc, detail)


def main():
    try: sys.stdout.reconfigure(encoding='utf-8')
    except Exception: pass
    key = os.environ.get('KEY') or (sys.argv[1] if len(sys.argv) > 1 else '')
    ok, msg = smoke(key)
    print('  %s %s' % ('OK  ' if ok else 'FAIL', msg))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
