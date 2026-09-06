# -*- coding: utf-8 -*-
"""배포 스모크 프로브 검증 — 프로브가 '그 함수'를 때리고, 깨진 배포를 잡는지 본다.

왜 이 파일이 있나
----------------
예전 deploy-fn.sh 스모크는 api-layer가 아니면 전부 `dget('companies')`(=data-api)였다.
send-email·storage-api·notify-handler·public-inquiry·jwt-authorizer를 망가뜨려 배포해도
"✅ 배포 성공"이 나왔다 — 7개 중 5개에서 스모크가 구조적으로 통과할 수밖에 없었다.

그래서 여기서 확인하는 것은 두 가지다.
  ① **대상 정확성** — 각 프로브가 실제로 그 함수를 invoke 하는가(다시 data-api로 새지 않는가).
  ② **민감도** — 모듈 로드 실패(R6, 부분 zip 배포 → 로그인 순단의 형태)와 예상 밖 응답에
     대해 반드시 FAIL 하는가. 무엇에도 통과하는 스모크는 없는 것만 못하다.
  ③ 덤으로 **비파괴성** — 프로브가 보내는 페이로드가 발송·기록 분기로 못 들어가는 모양인지.

AWS를 쓰지 않는다 — fnsmoke.invoke를 모의로 갈아끼운다.
"""
import os, sys

_LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib')
sys.path.insert(0, _LIB)
import fnsmoke  # noqa: E402
from itest import Checker, FN  # noqa: E402

# 배포 대상 키 → (invoke 되어야 할 FN 키, 정상 응답)
EXPECT = {
    'api-layer':      ('api',     {'status': 401, 'body': {'error': 'no'}}),
    'data-api':       ('data',    {'status': 200, 'body': []}),
    'public-inquiry': ('inquiry', {'status': 200, 'body': {'ok': True}}),
    'send-email':     ('email',   {'status': 400, 'body': 'missing ticket/requesterEmail'}),
    'storage-api':    ('storage', {'status': 404, 'body': {'error': 'not found'}}),
    'jwt-authorizer': ('jwt',     {'raw': {'isAuthorized': False}}),
    'notify-handler': ('notify',  {'status': 200, 'body': {'ok': True, 'results': []}}),
}

# 어떤 함수에서도 반드시 실패해야 하는 응답들
BAD = [
    ('모듈 로드 실패(R6 형태)', {'raw': {'errorType': 'Runtime.ImportModuleError',
                                        'errorMessage': "Cannot find module 'db.mjs'"}}),
    ('핸들러 예외', {'raw': {'errorType': 'TypeError', 'errorMessage': 'x is not a function'}}),
    ('invoke 실패(자격증명 등)', {'_invoke_error': 'ExpiredToken'}),
    ('예상 밖 5xx', {'status': 500, 'body': 'boom'}),
    ('빈 응답', {}),
]


def _spy(resp, seen):
    def _f(fn, event):
        seen.append((fn, event))
        return resp
    return _f


def run():
    t = Checker('배포 스모크 프로브')

    # 배포 대상 7개 전부에 프로브가 있는가 (없는 키는 smoke()가 실패로 처리해야 한다)
    t.check('프로브가 배포 대상 7종을 모두 덮음',
            set(fnsmoke.PROBES) == set(EXPECT), '차이=%s' % (set(fnsmoke.PROBES) ^ set(EXPECT)))
    ok, msg = fnsmoke.smoke('없는함수')
    t.check('프로브 없는 키는 실패로 처리(조용히 성공 금지)', ok is False, msg)

    for key, (want_fn, good) in sorted(EXPECT.items()):
        # ① 대상 정확성 + 정상 응답에 통과
        seen = []
        orig = fnsmoke.invoke
        try:
            fnsmoke.invoke = _spy(good, seen)
            ok, msg = fnsmoke.smoke(key)
        finally:
            fnsmoke.invoke = orig
        t.check('[%s] 정상 응답에 통과' % key, ok, msg)
        t.check('[%s] 자기 함수(%s)를 invoke — data-api로 새지 않음' % (key, want_fn),
                len(seen) == 1 and seen[0][0] == want_fn,
                '실제 호출=%s' % [s[0] for s in seen])

        # ② 민감도 — 깨진 배포에 반드시 실패
        fails = []
        for label, bad in BAD:
            orig = fnsmoke.invoke
            try:
                fnsmoke.invoke = _spy(bad, [])
                bok, _ = fnsmoke.smoke(key)
            finally:
                fnsmoke.invoke = orig
            if bok:
                fails.append(label)
        t.check('[%s] 깨진 배포 %d종에 전부 실패' % (key, len(BAD)), not fails,
                '통과해버린 응답: %s' % fails)

    # ③ 비파괴성 — 프로브 페이로드가 발송·기록 분기에 못 들어가는 모양인지
    def sent_event(key):
        seen = []
        orig = fnsmoke.invoke
        try:
            fnsmoke.invoke = _spy(EXPECT[key][1], seen)
            fnsmoke.smoke(key)
        finally:
            fnsmoke.invoke = orig
        return seen[0][1] if seen else {}

    em = sent_event('send-email')
    t.check('send-email 프로브가 CONNECTION_TEST가 아님(실제 MS Graph 토큰 요청 방지)',
            em.get('type') != 'CONNECTION_TEST', 'type=%s' % em.get('type'))
    t.check('send-email 프로브에 ticket/requesterEmail 없음(발송 분기 진입 불가)',
            not em.get('ticket') and not em.get('requesterEmail'), '%r' % em)

    nt = sent_event('notify-handler')
    t.check('notify-handler 프로브가 발송 type이 아님(switch default로 빠짐)',
            nt.get('type') not in ('CONNECTION_TEST', 'OVERDUE_BATCH', 'LICENSE_EXPIRY',
                                   'TICKET_INSERT', 'TICKET_ASSIGNED', 'TICKET_STATUS',
                                   'TICKET_OVERDUE', 'TICKET_REPLY'), 'type=%s' % nt.get('type'))

    iq = sent_event('public-inquiry')
    import json as _json
    body = _json.loads(iq.get('body') or '{}')
    t.check('public-inquiry 프로브가 허니팟(website 채움 → insert·Slack 이전 반환)',
            bool(body.get('website')), 'website=%r' % body.get('website'))

    st = sent_event('storage-api')
    t.check('storage-api 프로브가 실제 업로드/삭제 경로가 아님',
            st.get('rawPath') not in ('/storage/upload-url', '/storage/signed-url', '/storage/remove'),
            'rawPath=%s' % st.get('rawPath'))

    # FN 매핑이 실제로 7개 함수를 알고 있는지(jwt·notify는 이번에 추가됨)
    t.all_of('itest.FN이 프로브가 쓰는 함수 키를 모두 앎',
             [f for f, _ in EXPECT.values()], lambda f: f in FN, min_n=7)

    return t.report(min_checks=25)


if __name__ == '__main__':
    try: sys.stdout.reconfigure(encoding='utf-8')
    except Exception: pass
    sys.exit(0 if run() else 1)
