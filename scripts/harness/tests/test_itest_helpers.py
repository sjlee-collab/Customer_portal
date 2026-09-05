# -*- coding: utf-8 -*-
"""하네스 헬퍼 자체 검증 — 거짓통과·정리누락을 막는 장치들이 진짜로 막는지 본다.

왜 이 파일이 있나
----------------
감사 T2가 "거짓통과 봉쇄"로 넣은 양성대조가 `len(docs) >= 0`(항상 참)이었다. 즉
**고쳤다고 기록됐지만 실제로는 안 막는 코드**가 들어갔고, 다음 감사까지 아무도 몰랐다.
그래서 이번 장치들(must_id·all_of·report 하한·Fixtures·permission)은 "막는다"고
주장만 하지 않고, 막지 못하면 실패하는 테스트를 함께 둔다.

AWS를 쓰지 않는다 — dpost/ddel/dget/dpatch를 모의로 갈아끼우고 순수 로직만 본다.
그래서 자격증명·네트워크 없이 어디서나 돌고, 운영 데이터를 만들지 않는다.
(각 스위트는 별도 프로세스로 실행되므로 모의 주입이 다른 스위트에 새지 않는다.)
"""
import os, sys, io, contextlib

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib'))
import itest  # noqa: E402
from itest import Checker, must_id, HarnessError, Fixtures, permission  # noqa: E402


def _quiet(fn, *a, **k):
    """report()는 stdout에 찍으므로 삼켜서 결과값만 본다."""
    with contextlib.redirect_stdout(io.StringIO()) as buf:
        r = fn(*a, **k)
    return r, buf.getvalue()


def run():
    t = Checker('하네스 헬퍼 자체 검증')

    # ── must_id — 생성 실패가 KeyError 대신 진단 가능한 예외로 ──
    t.check('must_id: 정상 응답에서 id 추출',
            must_id({'status': 201, 'body': {'id': 'abc'}}) == 'abc')
    for bad, label in [({'status': 500, 'body': None}, '500'),
                       ({'_invoke_error': 'creds'}, 'invoke 오류'),
                       ({'status': 200, 'body': {}}, 'id 없음')]:
        try:
            must_id(bad, '회사')
            t.check('must_id: %s → 예외' % label, False, '예외가 안 남')
        except HarnessError as e:
            t.check('must_id: %s → HarnessError(원인 포함)' % label, '회사 생성 실패' in str(e))
        except Exception as e:                                    # noqa: BLE001
            t.check('must_id: %s → HarnessError' % label, False, '다른 예외: %r' % e)

    # ── all_of — 빈 목록에 공허하게 참이 되지 않는가(거짓통과의 주범) ──
    c = Checker()
    c.all_of('빈 목록', [], lambda x: True)
    c.all_of('전부 만족', [{'ok': 1}, {'ok': 1}], lambda x: x['ok'])
    c.all_of('하나 위반', [{'ok': 1}, {'ok': 0}], lambda x: x['ok'])
    res = [ok for _, ok, _ in c.results]
    t.check('all_of: 빈 목록은 FAIL (raw all()은 여기서 통과했었음)', res[0] is False)
    t.check('all_of: 전부 만족하면 PASS', res[1] is True)
    t.check('all_of: 하나라도 위반하면 FAIL', res[2] is False)

    # ── report — 검사 0건이 통과가 되지 않는가 ──
    r0, out0 = _quiet(Checker('빈스위트').report)
    t.check('report: 검사 0건은 FAIL (예전엔 0==0 으로 통과)', r0 is False)
    t.check('report: 0건이어도 "N/M PASS" 줄 유지(nightly 요약 파서 호환)', '0/0 PASS' in out0)
    cok = Checker(); cok.check('a', True); cok.check('b', True)
    t.check('report: 정상 스위트는 그대로 PASS', _quiet(cok.report)[0] is True)
    t.check('report: min_checks 미달이면 FAIL', _quiet(cok.report, 5)[0] is False)

    # ── Fixtures — 중간에 실패해도 이미 만든 운영 행을 회수하는가 ──
    made, deleted = [], []
    seq = [{'status': 201, 'body': {'id': 'co1'}},
           {'status': 201, 'body': {'id': 'u1'}},
           {'status': 500, 'body': None}]                          # 세 번째에서 실패
    orig_fns = (itest.dpost, itest.ddel, itest.dget, itest.dpatch)
    try:
        itest.dpost = lambda tbl, obj, role='admin', **k: (made.append(tbl), seq.pop(0))[1]
        itest.ddel = lambda tbl, rid, role='admin', **k: (deleted.append((tbl, rid)), {'status': 200})[1]
        itest.dget = lambda tbl, qs, role='admin', **k: {'status': 200, 'body': []}

        fx = Fixtures()
        try:
            fx.company('회사A')
            fx.user('고객A', 'custA', 'customer', company_id='co1')
            fx.user('고객B', 'custB', 'customer', company_id='co1')   # HarnessError
            t.check('Fixtures: 생성 실패가 예외로 표면화', False, '예외가 안 남')
        except HarnessError:
            t.check('Fixtures: 생성 실패가 예외로 표면화', True)
        failed = fx.cleanup()
        t.check('Fixtures: 중간 실패해도 앞서 만든 2건 회수 (예전엔 등록 전이라 운영에 유출)',
                ('users', 'u1') in deleted and ('companies', 'co1') in deleted, '삭제됨=%s' % deleted)
        t.check('Fixtures: 정리 실패를 목록으로 반환(조용한 실패 방지)', failed == [], '%s' % failed)

        # 정리 실패가 실제로 보고되는가 (양성대조)
        itest.ddel = lambda tbl, rid, role='admin', **k: {'status': 403}
        fx2 = Fixtures(); fx2.track('companies', 'co9')
        t.check('Fixtures: 삭제가 403이면 실패로 보고', fx2.cleanup() == [('companies', 'co9', 'status=403')])

        # ── permission — 하드코딩이 아니라 캡처한 원래 값으로 복원하는가 ──
        for orig in (True, False):
            writes = []
            itest.dget = lambda tbl, qs, role='admin', _o=orig, **k: {
                'status': 200, 'body': [{'id': 'p1', 'enabled': _o}]}
            itest.dpatch = lambda tbl, rid, obj, role='admin', **k: (
                writes.append(obj['enabled']), {'status': 200})[1]
            with permission('sales', 'stats_view', False):
                pass
            if orig is True:
                t.check('permission: 원래 True면 껐다가 True로 복원(설정 보존)',
                        writes == [False, True], '%s' % writes)
            else:
                t.check('permission: 원래 False면 운영에 아예 쓰지 않음',
                        writes == [], '%s' % writes)

        writes = []
        itest.dget = lambda tbl, qs, role='admin', **k: {'status': 200, 'body': [{'id': 'p1', 'enabled': True}]}
        itest.dpatch = lambda tbl, rid, obj, role='admin', **k: (writes.append(obj['enabled']), {'status': 200})[1]
        try:
            with permission('sales', 'ticket_delete', False):
                raise RuntimeError('테스트 도중 실패')
        except RuntimeError:
            pass
        t.check('permission: 블록에서 예외가 나도 원래 값으로 복원', writes == [False, True], '%s' % writes)

        itest.dget = lambda tbl, qs, role='admin', **k: {'status': 200, 'body': []}
        try:
            with permission('sales', 'nope', True):
                pass
            t.check('permission: 시드행 없으면 HarnessError', False, '예외가 안 남')
        except HarnessError:
            t.check('permission: 시드행 없으면 HarnessError', True)
    finally:
        itest.dpost, itest.ddel, itest.dget, itest.dpatch = orig_fns

    # ── batch — only_test 기본값이 살아있는가(운영 전체 스캔 방지) ──
    sent = {}
    orig_invoke = itest.invoke
    try:
        itest.invoke = lambda fn, event: (sent.update(event), {'status': 200})[1]
        itest.batch('overdue_batch')
        t.check('batch: only_test 기본이 True (안 주면 운영 전체 스캔했었음)',
                sent.get('only_test') is True, '%s' % sent)
        itest.batch('expire_contracts', only_test=False)
        t.check('batch: 명시하면 False도 전달(의도적 운영 스캔은 가능)', sent.get('only_test') is False)
    finally:
        itest.invoke = orig_invoke

    return t.report(min_checks=20)


if __name__ == '__main__':
    try: sys.stdout.reconfigure(encoding='utf-8')
    except Exception: pass
    sys.exit(0 if run() else 1)
