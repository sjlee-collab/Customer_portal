"""L1 폼·설문 접근 규칙 — forms/survey_history의 역할별 스코프·쓰기 차단·응답 계약.

실행: python scripts/harness/tests/test_form_access.py
배경: 폼 빌더가 forms/survey_history를 data-api ALLOWED_TABLES에 추가하면서 새 접근 규칙이
      생겼는데 무검증이었다. 규칙(data-api 주석 기준):
      - forms: 비스태프 READ는 status='active'만(초안·마감 폼은 존재 자체 은닉 — 검토 중
        문항 유출 방지). WRITE는 form_builder 권한.
      - survey_history: 비스태프 READ는 본인(user_id) 초대만(남의 응답·수신 여부 비공개).
        직접 쓰기는 전면 차단(NO_DIRECT_WRITE, admin 예외) — 초대 위조·응답 위조·남의
        초대 삭제(응답률 조작)를 막고, 응답은 api-layer POST /survey/answer가 전담.
      - /survey/answer: 본인 초대 + 미응답 + active 폼만, 1회 제출 강제.

데이터: [테스트] 회사 + 고객 2명(temail). 초대 행은 admin 직접 insert(발송 없음 — 메일 0통,
알림 무단언이라 병렬 안전). 정리는 forms 삭제(cascade)+finally.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dget, dpost, dpatch, ddel, api, tname, temail, Checker, _RUN


def run():
    t = Checker('L1 폼·설문 접근 규칙')
    created = {'companies': [], 'users': [], 'forms': []}
    try:
        # ── 픽스처: 회사 + 고객 A/B + 폼 3상태(draft/active/closed) + 초대 행 ──
        co = dpost('companies', {'name': tname('폼접근 회사'), 'status': 'active'}, role='admin')['body']['id']
        created['companies'].append(co)
        uA = dpost('users', {'email': temail('formA'), 'name': tname('폼고객A'), 'role': 'customer',
                             'company_id': co, 'is_active': True}, role='admin')['body']['id']
        uB = dpost('users', {'email': temail('formB'), 'name': tname('폼고객B'), 'role': 'customer',
                             'company_id': co, 'is_active': True}, role='admin')['body']['id']
        created['users'] += [uA, uB]
        A = dict(role='customer', userId=uA, companyId=co)

        def mkform(st):
            f = dpost('forms', {'title': tname('폼 ' + st), 'form_type': 'survey', 'status': st,
                                'fields': [{'label': '만족도', 'type': 'rating'}], 'target': {}},
                      role='admin')['body']['id']
            created['forms'].append(f)
            return f
        f_draft, f_active, f_closed = mkform('draft'), mkform('active'), mkform('closed')
        # 초대 행: A/B 각각 active 폼, A는 draft 폼에도 하나(active 아닌 폼 응답 차단 검증용).
        # token은 unique — 실행 토큰으로 고유화.
        invA = dpost('survey_history', {'form_id': f_active, 'user_id': uA, 'token': 'tk-A-' + _RUN,
                                        'company_id': co, 'company_name': tname('폼접근 회사')},
                     role='admin')['body']['id']
        invB = dpost('survey_history', {'form_id': f_active, 'user_id': uB, 'token': 'tk-B-' + _RUN,
                                        'company_id': co, 'company_name': tname('폼접근 회사')},
                     role='admin')['body']['id']
        invA_draft = dpost('survey_history', {'form_id': f_draft, 'user_id': uA, 'token': 'tk-Ad-' + _RUN},
                           role='admin')['body']['id']
        t.check('픽스처: 폼 3상태 + 초대 3행', all([f_draft, f_active, f_closed, invA, invB, invA_draft]))

        # ── forms 읽기: 비스태프에겐 active만, 초안·마감은 존재 은닉 ──
        vis = {x['id'] for x in (dget('forms', {'select': 'id', 'limit': '500'}, **A).get('body') or [])}
        t.check('고객: active 폼 보임', f_active in vis, 'visible=%d' % len(vis))
        t.check('고객: draft 폼 은닉(목록)', f_draft not in vis)
        t.check('고객: closed 폼 은닉(목록)', f_closed not in vis)
        direct = dget('forms', {'select': 'id', 'id': 'eq.' + f_draft}, **A).get('body') or []
        t.check('고객: draft 직접조회도 0건', len(direct) == 0, '%d건' % len(direct))
        adm = {x['id'] for x in (dget('forms', {'select': 'id', 'id': 'in.%s,%s,%s' % (f_draft, f_active, f_closed)},
                                      role='admin').get('body') or [])}
        t.check('양성대조: admin은 3상태 모두 보임', adm == {f_draft, f_active, f_closed}, '%d/3' % len(adm))

        # ── forms 쓰기: form_builder 권한 없는 고객 차단 ──
        r = dpost('forms', {'title': tname('위조 폼'), 'form_type': 'survey', 'fields': []}, **A)
        t.check('고객 forms POST 차단', r.get('status') == 403, 'status=%s' % r.get('status'))
        r = dpatch('forms', f_active, {'title': tname('변조')}, **A)
        t.check('고객 forms PATCH 차단', r.get('status') == 403, 'status=%s' % r.get('status'))

        # ── survey_history 읽기: 본인 초대만 ──
        mine = {x['id'] for x in (dget('survey_history', {'select': 'id', 'limit': '500'}, **A).get('body') or [])}
        t.check('고객A: 자기 초대만 보임', invA in mine and invA_draft in mine and invB not in mine,
                'A보유=%d B노출=%s' % (len(mine), invB in mine))
        rB = dget('survey_history', {'select': 'id,answers', 'id': 'eq.' + invB}, **A).get('body') or []
        t.check('고객A: B의 초대 직접조회 0건', len(rB) == 0, '%d건' % len(rB))

        # ── survey_history 쓰기: 전용 API 외 전면 차단(위조·조작 방지) ──
        r = dpost('survey_history', {'form_id': f_active, 'user_id': uA, 'token': 'tk-forge-' + _RUN}, **A)
        t.check('고객: 초대 위조(POST) 차단', r.get('status') == 403, 'status=%s' % r.get('status'))
        r = dpatch('survey_history', invA, {'answers': {'만족도': 5}}, **A)
        t.check('고객: 응답 위조(PATCH) 차단', r.get('status') == 403, 'status=%s' % r.get('status'))
        r = ddel('survey_history', invB, **A)
        t.check('고객: 남의 초대 삭제 차단', r.get('status') == 403, 'status=%s' % r.get('status'))
        still = dget('survey_history', {'select': 'id', 'id': 'eq.' + invB}, role='admin').get('body') or []
        t.check('양성대조: B 초대 실제로 남아있음', len(still) == 1)

        # ── /survey/answer 계약: 본인·미응답·active만, 1회 제출 ──
        r = api('POST', '/survey/answer', {'invite_id': invB, 'answers': {'만족도': 1}}, **A)
        t.check('남의 초대로 응답 404(도용 불가)', r.get('status') == 404, 'status=%s' % r.get('status'))
        r = api('POST', '/survey/answer', {'invite_id': invA_draft, 'answers': {'만족도': 3}}, **A)
        t.check('active 아닌 폼 응답 404', r.get('status') == 404, 'status=%s' % r.get('status'))
        r = api('POST', '/survey/answer', {'invite_id': invA, 'answers': {'만족도': 5}}, **A)
        t.check('본인 응답 제출 200', r.get('status') == 200, 'status=%s body=%s' % (r.get('status'), r.get('body')))
        row = (dget('survey_history', {'select': 'answers,responded_at', 'id': 'eq.' + invA},
                    role='admin').get('body') or [{}])[0]
        t.check('응답 저장 + 제출시각 기록', (row.get('answers') or {}).get('만족도') == 5
                and bool(row.get('responded_at')), 'row=%s' % row)
        r = api('POST', '/survey/answer', {'invite_id': invA, 'answers': {'만족도': 1}}, **A)
        t.check('재제출 404(1회 강제)', r.get('status') == 404, 'status=%s' % r.get('status'))
        row2 = (dget('survey_history', {'select': 'answers', 'id': 'eq.' + invA},
                     role='admin').get('body') or [{}])[0]
        t.check('재제출 시도에도 원 응답 불변', (row2.get('answers') or {}).get('만족도') == 5)
    finally:
        # forms 삭제가 survey_history를 cascade로 지운다.
        for f in created['forms']: ddel('forms', f, role='admin')
        for u in created['users']: ddel('users', u, role='admin')
        for c in created['companies']: ddel('companies', c, role='admin')
    return t.report()


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
