"""L1 백엔드 계약 테스트 — 첨부 업로드 규칙(storage-api /storage/upload-url).

실행: python scripts/harness/tests/test_storage_rules.py
검증(ticket-attachments 버킷):
  - 비허용 확장자(.exe) → 400 / 용량 초과(>10MB) → 400
  - 허용 확장자(pdf·pptx·twbx·twb·xls·png) → 형식·용량 게이트 통과 후 소유권 403(가짜 티켓)
  - 실제 [테스트] 티켓 경로 + admin → 200 + uploadUrl(전 경로 통과)
데이터: [테스트] 티켓 1개(data-api 직접 insert — 알림 트리거 없음), 종료 시 삭제.
"""
import sys, os, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import ctx, invoke, dpost, ddel, tname, Checker

FAKE = '00000000-0000-0000-0000-000000000000'
MB = 1024 * 1024


def upload_url(path, size, role='admin', userId='zz-admin', origin=None):
    e = ctx(role, userId=userId); e['requestContext']['http']['method'] = 'POST'
    e['rawPath'] = '/storage/upload-url'
    if origin: e['headers'] = {'origin': origin}  # Same-Origin 프록시 치환은 요청 Origin으로 판단한다
    e['body'] = json.dumps({'bucket': 'ticket-attachments', 'path': path,
                            'contentType': 'application/octet-stream', 'contentLength': size})
    return invoke('storage', e)


def run():
    t = Checker('L1 첨부 업로드 규칙(storage-api)')
    tid = None
    try:
        # 형식 거부
        r = upload_url(FAKE + '/x.exe', 3 * MB)
        t.check('비허용 확장자(.exe) 400', r.get('status') == 400, 'status=%s' % r.get('status'))
        # 용량 초과
        r = upload_url(FAKE + '/big.pdf', 11 * MB)
        t.check('용량 초과(11MB) 400', r.get('status') == 400, 'status=%s' % r.get('status'))
        # 허용 확장자 → 형식·용량 통과 후 소유권 403(가짜 티켓)
        for ext in ['pdf', 'pptx', 'twbx', 'twb', 'xls', 'png']:
            r = upload_url(FAKE + '/a.' + ext, 5 * MB)
            t.check('허용 확장자(%s) 형식통과→소유권403' % ext, r.get('status') == 403, 'status=%s' % r.get('status'))
        # 실제 [테스트] 티켓 + admin → 200 + uploadUrl
        tk = dpost('tickets', {'title': tname('첨부규칙'), 'ticket_number': 'TK-TEST-ATT',
                               'category': 'customer', 'status': 'received'}, role='admin').get('body')
        tid = (tk[0] if isinstance(tk, list) else tk or {}).get('id')
        t.check('테스트 티켓 생성', bool(tid), 'tk=%s' % tk)
        if tid:
            r = upload_url(tid + '/ok.pdf', 5 * MB, role='admin')
            b = r.get('body') or {}
            t.check('허용 티켓 경로 200', r.get('status') == 200, 'status=%s body=%s' % (r.get('status'), r.get('body')))
            t.check('uploadUrl 발급', bool(b.get('uploadUrl')), 'keys=%s' % list(b)[:5])
            # ── Same-Origin 프록시 치환(2026-09-18): 규칙이 있는 오리진(dev)에서만 포탈 도메인으로,
            #    Origin 없음(직접 invoke)·아직 규칙 없는 오리진은 S3 직접 주소 그대로.
            #    운영 전환(FILE_PROXY_ORIGINS에 support 추가) 시 아래 '운영 Origin' 기대값을 프록시로 바꿀 것.
            S3H = 'https://bigxdata-portal-ticket-attachments.s3.ap-northeast-2.amazonaws.com/'
            DEV = 'https://dev.dlayoierdftk6.amplifyapp.com'
            u0 = (upload_url(tid + '/p0.pdf', MB, role='admin').get('body') or {}).get('uploadUrl') or ''
            t.check('Origin 없음 → S3 직접 주소', u0.startswith(S3H), 'url=%s' % u0[:70])
            u1 = (upload_url(tid + '/p1.pdf', MB, role='admin', origin=DEV).get('body') or {}).get('uploadUrl') or ''
            t.check('dev Origin → 프록시 주소(/files/ticket-attachments/)', u1.startswith(DEV + '/files/ticket-attachments/' + tid + '/p1.pdf?'), 'url=%s' % u1[:90])
            t.check('프록시 URL에 서명 쿼리 보존', 'X-Amz-Signature=' in u1 and 'X-Amz-Credential=' in u1, 'url=%s' % u1[-60:])
            u2 = (upload_url(tid + '/p2.pdf', MB, role='admin', origin='https://support.bigxdata.io').get('body') or {}).get('uploadUrl') or ''
            t.check('운영 Origin(전환 전) → S3 직접 주소', u2.startswith(S3H), 'url=%s' % u2[:70])
            u3 = (upload_url(tid + '/p3.pdf', MB, role='admin', origin='https://evil.example').get('body') or {}).get('uploadUrl') or ''
            t.check('허용 외 Origin → S3 직접 주소', u3.startswith(S3H), 'url=%s' % u3[:70])
    finally:
        if tid: ddel('tickets', tid, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
