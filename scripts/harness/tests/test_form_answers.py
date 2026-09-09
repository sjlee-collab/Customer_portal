"""L1 form_answers(VOC 요청 폼 추가 문항) — 접수 스냅샷·서버 검증 필터·동결·쓰기 차단.

실행: python scripts/harness/tests/test_form_answers.py
배경: tickets.form_answers(폼 빌더 C단계)는 접수 시 활성 request 폼의 문항 정의+답변을
      스냅샷으로 저장한다(폼을 나중에 고쳐도 과거 티켓 상세가 안 깨지게 정의까지 동결).
      buildFormAnswers의 서버 검증(활성 폼 대조·카테고리 일치·위조 문항 drop·비선택지
      필터·길이 컷)이 운영 배포됐지만 무검증이었다 — 여기서 고정한다.

운영 무간섭 설계(중요):
  - buildFormAnswers는 "활성 request 폼 전역 최신 1개"를 집는다. 테스트 폼을 active로
    두는 동안 실 접수가 끼어들 수 있으므로 ① 문항에 required를 두지 않고(실 접수가
    400으로 차단될 여지 제거 — required 400 분기는 코드 리뷰로 갈음) ② 폼 대상
    카테고리를 'other'로 두고(실 voc 접수는 카테고리 불일치 → fa=null, 완전 무영향)
    ③ active 창을 try/finally로 최소화한다.
  - 운영에 활성 request 폼이 이미 있으면(C-5 개통 후) 내 폼을 active로 얹는 것 자체가
    그 폼을 가리므로, active-창 검증을 통째로 건너뛰고 무접촉 검증만 수행한다(축소 모드).

데이터: [테스트] 회사·고객(temail)·request 폼(draft로 생성, 검증 창에만 active). 티켓은
실 POST /tickets 경로(접수확인 메일은 temail 싱크 1통/티켓). 정리는 wipe+forms 삭제.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'lib'))
from itest import dget, dpost, dpatch, ddel, api, wipe_ticket, tname, temail, Checker, must_id


def fa_of(tid):
    rows = dget('tickets', {'select': 'form_answers', 'id': 'eq.' + tid}, role='admin').get('body') or []
    return rows[0].get('form_answers') if rows else None


def run():
    t = Checker('L1 form_answers(접수 스냅샷)')
    created = {'companies': [], 'users': [], 'forms': [], 'tickets': []}
    try:
        # 운영 활성 request 폼 존재 시 축소 모드 — 내 폼이 그걸 가리면 실 접수에 간섭한다.
        prod_active = dget('forms', {'select': 'id', 'form_type': 'eq.request', 'status': 'eq.active'},
                           role='admin').get('body') or []
        full_mode = len(prod_active) == 0

        co = must_id(dpost('companies', {'name': tname('FA 회사'), 'status': 'active'}, role='admin'), '회사')
        created['companies'].append(co)
        cu = must_id(dpost('users', {'email': temail('faCust'), 'name': tname('FA고객'), 'role': 'customer',
                                     'company_id': co, 'is_active': True}, role='admin'), '고객')
        created['users'].append(cu)
        C = dict(role='customer', userId=cu, companyId=co)

        # request 폼 — 대상 카테고리 'other'(운영 voc 접수와 절대 안 겹침), required 없음.
        fields = [
            {'id': 'c1', 'label': '증상 설명', 'type': 'text'},
            {'id': 'c2', 'label': '유형', 'type': 'single', 'options': ['A', 'B']},
            {'id': 'c3', 'label': '항목들', 'type': 'multi', 'options': ['X', 'Y', 'Z']},
        ]
        fm = must_id(dpost('forms', {'title': tname('FA 요청 폼'), 'form_type': 'request',
                                     'status': 'draft', 'fields': fields,
                                     'target': {'category': 'other'}}, role='admin'), 'request 폼')
        created['forms'].append(fm)

        def post_ticket(cat, fa_body=None, tag=''):
            b = {'title': tname('FA ' + (tag or cat)), 'category': cat, 'description': 'fa', 'priority': 'normal'}
            if fa_body is not None:
                b['form_answers'] = fa_body
            r = api('POST', '/tickets', b, **C)
            tid = ((r.get('body') or {}).get('ticket') or {}).get('id')
            if tid:
                created['tickets'].append(tid)
            return r, tid

        if not full_mode:
            print('⚠ 운영 활성 request 폼 존재(%d개) — active 창 검증 생략(축소 모드): '
                  '실 접수 간섭을 피하기 위함. 무접촉 검증만 수행.' % len(prod_active))
        else:
            # ── active 창(최소화): 스냅샷·필터 검증 ── 복귀는 finally로 보장.
            try:
                r = dpatch('forms', fm, {'status': 'active'}, role='admin')
                t.check('픽스처: 폼 활성화', r.get('status') in (200, 204), 'status=%s' % r.get('status'))

                # ① 정상 접수: 정의 스냅샷 + 답변 저장 (위조 키·비선택지·중복·길이까지 한 번에)
                long_text = 'ㄱ' * 5000
                r, tid = post_ticket('other', {'answers': {
                    'c1': long_text,                    # 4000자 컷 기대
                    'c2': 'A',                          # 정상 선택
                    'c3': ['X', 'X', 'bogus', 'Y'],     # 중복·비선택지 제거 → ['X','Y']
                    'zz': '위조 문항',                   # 폼에 없는 키 → drop
                }}, tag='정상')
                t.check('접수 201', r.get('status') == 201, 'status=%s' % r.get('status'))
                fa = fa_of(tid) or {}
                t.check('스냅샷: form_id·captured_at 기록', fa.get('form_id') == fm and bool(fa.get('captured_at')),
                        'form_id=%s' % fa.get('form_id'))
                snap_ids = [f.get('id') for f in (fa.get('fields') or [])]
                t.check('스냅샷: 문항 정의 3개 동결', snap_ids == ['c1', 'c2', 'c3'], 'fields=%s' % snap_ids)
                ans = fa.get('answers') or {}
                t.check('답변: 텍스트 4000자 컷', len(ans.get('c1') or '') == 4000, 'len=%s' % len(ans.get('c1') or ''))
                t.check('답변: 선택형 정상 저장', ans.get('c2') == 'A')
                t.check('답변: multi 중복·비선택지 제거', ans.get('c3') == ['X', 'Y'], 'c3=%s' % ans.get('c3'))
                t.check('답변: 위조 문항 키 drop', 'zz' not in ans, 'keys=%s' % sorted(ans.keys()))

                # ② 비선택지 단일값 → drop(답 없음)
                r, tid2 = post_ticket('other', {'answers': {'c2': 'C'}}, tag='비선택지')
                ans2 = (fa_of(tid2) or {}).get('answers') or {}
                t.check('답변: single 비선택지 값 drop', r.get('status') == 201 and 'c2' not in ans2,
                        'answers=%s' % ans2)

                # ③ 카테고리 불일치(폼 대상은 other) → fa null — 다른 카테고리 접수는 무영향
                r, tid3 = post_ticket('tech_support', {'answers': {'c1': '무관'}}, tag='카테고리불일치')
                t.check('카테고리 불일치 → form_answers null', r.get('status') == 201 and fa_of(tid3) is None,
                        'fa=%s' % fa_of(tid3))

                # ④ 스냅샷 동결: 폼 정의를 바꿔도 기존 티켓의 fa는 불변
                dpatch('forms', fm, {'fields': [{'id': 'c9', 'label': '변경된 문항', 'type': 'text'}]}, role='admin')
                fa_after = fa_of(tid) or {}
                t.check('폼 수정 후에도 티켓 스냅샷 불변(동결)',
                        [f.get('id') for f in (fa_after.get('fields') or [])] == ['c1', 'c2', 'c3'],
                        'fields=%s' % [f.get('id') for f in (fa_after.get('fields') or [])])
            finally:
                dpatch('forms', fm, {'status': 'draft'}, role='admin')   # active 창 종료(간섭 원천 회수)
            st = (dget('forms', {'select': 'status', 'id': 'eq.' + fm}, role='admin').get('body') or [{}])[0]
            t.check('폼 draft 복귀(운영 무간섭 종료)', st.get('status') == 'draft', 'status=%s' % st.get('status'))

        # ── 무접촉 검증(모드 무관) ──
        # ⑤ 활성 request 폼이 하나도 없으면(full_mode에선 복귀 후 상태) fa=null로 접수
        if full_mode:
            r, tid4 = post_ticket('other', {'answers': {'c1': '폼 없음'}}, tag='폼없음')
            t.check('활성 폼 없음 → form_answers null(문항 없이 접수)',
                    r.get('status') == 201 and fa_of(tid4) is None, 'fa=%s' % fa_of(tid4))

        # ⑥ 고객이 form_answers를 직접 조작 불가(tickets는 전용 API 외 쓰기 차단)
        r, tid5 = post_ticket('other', None, tag='조작대상')
        r = dpatch('tickets', tid5, {'form_answers': {'form_id': 'forged', 'answers': {'c1': '위조'}}}, **C)
        t.check('고객 form_answers 직접 PATCH 차단', r.get('status') == 403, 'status=%s' % r.get('status'))
        t.check('양성대조: 조작 시도 후에도 fa 불변(null)', fa_of(tid5) is None, 'fa=%s' % fa_of(tid5))
    finally:
        for x in created['tickets']:
            if len(dget('tickets', {'select': 'id', 'id': 'eq.' + x}, role='admin').get('body') or []):
                wipe_ticket(x)
        for f in created['forms']: ddel('forms', f, role='admin')
        for u in created['users']: ddel('users', u, role='admin')
        for c in created['companies']: ddel('companies', c, role='admin')
    return t.report(min_checks=3)


if __name__ == '__main__':
    sys.exit(0 if run() else 1)
