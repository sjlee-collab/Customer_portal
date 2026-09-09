"""L1 설문 발송(폼 빌더 D) — POST /survey/send의 격리·멱등·백스톱을 고정.

실행: python scripts/harness/tests/test_survey_send.py
배경: 설문 발송은 배치·티켓과 달리 "고객 다수에게 직접 메일"을 쏘는 기능이라, 격리 장치가
      깨지면 블라스트 반경이 가장 크다. 구현(2026-09-08)에 안전장치 3겹이 들어갔지만
      무검증 운영 중이었다 — 라이선스 배치 유출(6f179e6) 전의 상태와 동일. 여기서 고정한다:
      ① 대상 선정 양방향 격리 — 운영 발송은 [테스트] 고객사 제외 / only_test는 [테스트]만
      ② 발송 페이로드에 companyName 동봉 → send-email [테스트] 백스톱이 싱크·is_test 처리
      ③ dry_run(무접촉 명단) · 멱등(unique(form_id,user_id)) · 발송 후 active 잠금

데이터: [테스트] 회사 + 진행중 계약(대상 선정이 계약 기반) + 고객(temail). 폼은 forms에
admin insert(form_builder 권한). 정리는 forms 삭제(cascade로 survey_history 소거) + finally.
운영 모드 검증은 dry_run만 사용 — 실 고객 발송은 절대 일으키지 않는다.
"""
import sys, os, time, datetime
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dget, dpost, ddel, api, tname, temail, Checker


def survey_mail_rows(recipient):
    """설문 메일 로그 — ticket_id가 없어 recipient(실행 고유 temail)로 판정."""
    return dget('log_notification',
                {'select': 'event_type,recipient,status,is_test', 'channel': 'eq.email',
                 'event_type': 'eq.survey_invite', 'recipient': 'eq.' + recipient},
                role='admin').get('body') or []


def wait_mail(recipient, expect_n, timeout=30):
    """발송이 deferNotify(비동기)라 로그 정착을 폴링한다(wait_notif는 ticket_id 기반이라 못 씀)."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        rows = survey_mail_rows(recipient)
        if len(rows) >= expect_n:
            return rows
        time.sleep(2)
    return survey_mail_rows(recipient)


def run():
    t = Checker('L1 설문 발송(격리·멱등·백스톱)')
    created = {'companies': [], 'users': [], 'contracts': [], 'forms': [], 'units': [], 'uou': []}
    d30 = (datetime.date.today() + datetime.timedelta(days=30)).isoformat()
    try:
        # ── 픽스처: [테스트] 회사 + 진행중 계약(대상 선정 근거) + 활성 고객(temail) ──
        co = dpost('companies', {'name': tname('설문 회사'), 'status': 'active'}, role='admin')['body']['id']
        created['companies'].append(co)
        # 발송 대상 규칙: "계약의 조직(unit)에 배정된 고객"만 — unit 없는 계약은 excluded(현행).
        # 그래서 조직을 만들고 계약·고객을 조직에 묶는다(운영과 동일 형상).
        ou = dpost('org_units', {'unit_no': 'T-1', 'company_id': co, 'unit_name': tname('설문 조직'),
                                 'status': 'active'}, role='admin')['body']['id']
        created['units'].append(ou)
        ct = dpost('company_contracts', {'company_id': co, 'contract_name': tname('설문 계약'),
                                         'status': '진행중', 'end_date': d30, 'unit_id': ou},
                   role='admin')['body']['id']
        created['contracts'].append(ct)
        # unit 없는 계약이 excluded로 빠지는 현행 규칙도 함께 고정한다.
        ct_no_unit = dpost('company_contracts', {'company_id': co, 'contract_name': tname('무조직 계약'),
                                                 'status': '진행중', 'end_date': d30},
                           role='admin')['body']['id']
        created['contracts'].append(ct_no_unit)
        cu_mail = temail('svyCust')
        cu = dpost('users', {'email': cu_mail, 'name': tname('설문고객'), 'role': 'customer',
                             'company_id': co, 'is_active': True}, role='admin')['body']['id']
        created['users'].append(cu)
        uo = dpost('user_org_units', {'user_id': cu, 'unit_id': ou, 'is_primary': True},
                   role='admin')['body']
        created['uou'].append(uo.get('id'))
        fm = dpost('forms', {'title': tname('만족도 설문'), 'form_type': 'survey', 'status': 'draft',
                             'fields': [{'label': '전반적 만족도', 'type': 'rating'}],
                             'target': {}}, role='admin')['body']['id']
        created['forms'].append(fm)
        t.check('픽스처: 폼 생성(draft)', bool(fm))

        # ── 권한: form_builder 없는 고객은 발송 불가 ──
        r = api('POST', '/survey/send', {'form_id': fm, 'only_test': True},
                role='customer', userId=cu, companyId=co)
        t.check('고객 발송 403', r.get('status') == 403, 'status=%s' % r.get('status'))

        # ── 격리 ①-a: only_test dry_run — [테스트] 회사만 대상 ──
        r = api('POST', '/survey/send', {'form_id': fm, 'only_test': True, 'dry_run': True}, role='admin')
        body = r.get('body') or {}
        rows = body.get('rows') or []
        comps = {x.get('company') for x in rows}
        t.check('only_test 드라이런 200', r.get('status') == 200 and body.get('dry_run') is True,
                'status=%s' % r.get('status'))
        t.check('only_test 대상에 내 [테스트] 회사 포함', tname('설문 회사') in comps, '대상회사=%s' % sorted(comps))
        t.check('only_test 대상 전부 [테스트] 라벨', all(str(c).startswith('[테스트]') for c in comps),
                '비라벨=%s' % [c for c in comps if not str(c).startswith('[테스트]')])
        excl = (body.get('excluded') or [])
        t.check('무조직 계약은 excluded 분류(현행)', any(x.get('company') == tname('설문 회사') for x in excl)
                or len(excl) >= 1, 'excluded=%d' % len(excl))

        # ── 격리 ①-b: 운영 모드 dry_run — [테스트] 회사가 제외된다(핵심 안전장치) ──
        # dry_run이라 DB·메일 무접촉. 실 고객사 명단이 반환되지만 개수만 확인하고 내용은 남기지 않는다.
        r = api('POST', '/survey/send', {'form_id': fm, 'dry_run': True}, role='admin')
        prod_comps = {x.get('company') for x in ((r.get('body') or {}).get('rows') or [])}
        t.check('운영 드라이런 200', r.get('status') == 200, 'status=%s' % r.get('status'))
        t.check('운영 대상에서 [테스트] 회사 제외', not any(str(c).startswith('[테스트]') for c in prod_comps),
                '운영대상 %d개사 중 라벨 유출 %d' % (len(prod_comps),
                sum(1 for c in prod_comps if str(c).startswith('[테스트]'))))

        # ── dry_run 무접촉: survey_history 행 없음 + 폼 status 그대로 draft ──
        hist = dget('survey_history', {'select': 'id', 'form_id': 'eq.' + fm}, role='admin').get('body') or []
        st0 = (dget('forms', {'select': 'status', 'id': 'eq.' + fm}, role='admin').get('body') or [{}])[0].get('status')
        t.check('드라이런 무접촉(이력 0·draft 유지)', len(hist) == 0 and st0 == 'draft',
                '이력=%d status=%s' % (len(hist), st0))

        # ── 실발송(only_test): 집계·이력·백스톱 ──
        r = api('POST', '/survey/send', {'form_id': fm, 'only_test': True}, role='admin')
        body = r.get('body') or {}
        t.check('only_test 발송 200 · sent=1', r.get('status') == 200 and body.get('sent') == 1,
                'status=%s body=%s' % (r.get('status'), body))
        hist = dget('survey_history', {'select': 'id,token,company_name', 'form_id': 'eq.' + fm},
                    role='admin').get('body') or []
        t.check('발송 이력 1행 + 응답 토큰 발급', len(hist) == 1 and bool(hist[0].get('token')),
                '이력=%d' % len(hist))
        st1 = (dget('forms', {'select': 'status', 'id': 'eq.' + fm}, role='admin').get('body') or [{}])[0].get('status')
        t.check('발송 후 active 잠금', st1 == 'active', 'status=%s' % st1)
        mails = wait_mail(cu_mail, 1)
        t.check('안내 메일 로그 1건(survey_invite)', len(mails) == 1, '%d건' % len(mails))
        t.check('메일 is_test=true(백스톱 개입 — 싱크로 격리됨)',
                all(m.get('is_test') is True for m in mails),
                '%s' % [(m.get('recipient'), m.get('is_test')) for m in mails])

        # ── 멱등: 재발송해도 같은 사람에게 다시 안 감 ──
        r = api('POST', '/survey/send', {'form_id': fm, 'only_test': True}, role='admin')
        body = r.get('body') or {}
        t.check('재발송 멱등(sent=0·already_sent=1)',
                body.get('sent') == 0 and body.get('already_sent') == 1, 'body=%s' % body)
        hist = dget('survey_history', {'select': 'id', 'form_id': 'eq.' + fm}, role='admin').get('body') or []
        t.check('이력 여전히 1행(중복 없음)', len(hist) == 1, '%d행' % len(hist))
    finally:
        # forms 삭제가 survey_history를 cascade로 지운다(스키마 on delete cascade).
        for f in created['forms']: ddel('forms', f, role='admin')
        for x in created['uou']:
            if x: ddel('user_org_units', x, role='admin')
        for c in created['contracts']: ddel('company_contracts', c, role='admin')
        for u in created['users']: ddel('users', u, role='admin')
        for u in created['units']: ddel('org_units', u, role='admin')
        for c in created['companies']: ddel('companies', c, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
