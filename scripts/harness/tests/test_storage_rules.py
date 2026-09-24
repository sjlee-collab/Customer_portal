"""L1 백엔드 계약 테스트 — 첨부 업로드 규칙(storage-api /storage/upload-url).

실행: python scripts/harness/tests/test_storage_rules.py
검증(ticket-attachments 버킷):
  - 비허용 확장자(.exe) → 400 / 용량 초과(>10MB) → 400
  - 허용 확장자(pdf·pptx·twbx·twb·xls·png) → 형식·용량 게이트 통과 후 소유권 403(가짜 티켓)
  - 실제 [테스트] 티켓 경로 + admin → 200 + uploadUrl(전 경로 통과)
데이터: [테스트] 티켓 1개(data-api 직접 insert — 알림 트리거 없음), 종료 시 삭제.
"""
import sys, os, json, re
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import ctx, invoke, dpost, ddel, wipe_ticket, tname, Checker
from itest import BUCKET_SUFFIX

FAKE = '00000000-0000-0000-0000-000000000000'
MB = 1024 * 1024


def upload_url(path, size, role='admin', userId='zz-admin', origin=None):
    e = ctx(role, userId=userId); e['requestContext']['http']['method'] = 'POST'
    e['rawPath'] = '/storage/upload-url'
    if origin: e['headers'] = {'origin': origin}  # Same-Origin 프록시 치환은 요청 Origin으로 판단한다
    e['body'] = json.dumps({'bucket': 'ticket-attachments', 'path': path,
                            'contentType': 'application/octet-stream', 'contentLength': size})
    return invoke('storage', e)


def signed_url(path, expires=None, role='admin', userId='zz-admin'):
    e = ctx(role, userId=userId); e['requestContext']['http']['method'] = 'POST'
    e['rawPath'] = '/storage/signed-url'
    body = {'bucket': 'ticket-attachments', 'path': path}
    if expires is not None: body['expiresIn'] = expires
    e['body'] = json.dumps(body)
    return invoke('storage', e)


def expires_of(url):
    m = re.search(r'X-Amz-Expires=(\d+)', url or '')
    return int(m.group(1)) if m else None


def run():
    t = Checker('L1 첨부 업로드 규칙(storage-api)')
    tid = aid = None
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
            S3H = 'https://bigxdata-portal-ticket-attachments%s.s3.ap-northeast-2.amazonaws.com/' % BUCKET_SUFFIX
            DEV = 'https://dev.dlayoierdftk6.amplifyapp.com'
            u0 = (upload_url(tid + '/p0.pdf', MB, role='admin').get('body') or {}).get('uploadUrl') or ''
            t.check('Origin 없음 → S3 직접 주소', u0.startswith(S3H), 'url=%s' % u0[:70])
            u1 = (upload_url(tid + '/p1.pdf', MB, role='admin', origin=DEV).get('body') or {}).get('uploadUrl') or ''
            t.check('dev Origin → 프록시 주소(/files/ticket-attachments/)', u1.startswith(DEV + '/files/ticket-attachments/' + tid + '/p1.pdf?'), 'url=%s' % u1[:90])
            t.check('프록시 URL에 서명 쿼리 보존', 'X-Amz-Signature=' in u1 and 'X-Amz-Credential=' in u1, 'url=%s' % u1[-60:])
            PROD = 'https://support.bigxdata.io'
            u2 = (upload_url(tid + '/p2.pdf', MB, role='admin', origin=PROD).get('body') or {}).get('uploadUrl') or ''
            t.check('운영 Origin → 프록시 주소 (2026-09-18 전환)', u2.startswith(PROD + '/files/ticket-attachments/' + tid + '/p2.pdf?'), 'url=%s' % u2[:90])
            u3 = (upload_url(tid + '/p3.pdf', MB, role='admin', origin='https://evil.example').get('body') or {}).get('uploadUrl') or ''
            t.check('허용 외 Origin → S3 직접 주소', u3.startswith(S3H), 'url=%s' % u3[:70])

            # ── presign 만료 상한(2026-09-15 하드닝): 다운로드 URL의 expiresIn은 1~300초로
            #    클램프된다 — 상한이 없으면 임시 자격증명 수명(수 시간)짜리 링크가 외부로
            #    넘어갈 수 있었다. signed-url은 메타데이터 행(checkAccess)을 요구하므로
            #    ticket_attachments 픽스처를 만들어 통과시킨 뒤 X-Amz-Expires 값을 본다.
            att = dpost('ticket_attachments', {'ticket_id': tid, 'file_name': 'exp.pdf',
                                               'storage_path': tid + '/exp.pdf'}, role='admin').get('body') or {}
            aid = (att[0] if isinstance(att, list) else att).get('id')
            t.check('픽스처: 첨부 메타행 생성', bool(aid), 'att=%s' % att)
            if aid:
                r = signed_url(tid + '/exp.pdf', expires=999999)
                u = (r.get('body') or {}).get('signedUrl') or ''
                t.check('과대 만료 요청(999999초) → 300초 클램프',
                        r.get('status') == 200 and expires_of(u) == 300,
                        'status=%s X-Amz-Expires=%s' % (r.get('status'), expires_of(u)))
                r = signed_url(tid + '/exp.pdf')
                u = (r.get('body') or {}).get('signedUrl') or ''
                t.check('만료 미지정 → 기본 60초', expires_of(u) == 60, 'X-Amz-Expires=%s' % expires_of(u))
                r = signed_url(tid + '/exp.pdf', expires=-5)
                u = (r.get('body') or {}).get('signedUrl') or ''
                t.check('음수 만료 → 하한 클램프(1초 이상)', (expires_of(u) or 0) >= 1, 'X-Amz-Expires=%s' % expires_of(u))
    finally:
        # 첨부 메타행이 생기면서 단순 ddel(tickets)는 FK에 막힌다 — 자식행까지 지우는 표준 경로 사용.
        if tid: wipe_ticket(tid)
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
