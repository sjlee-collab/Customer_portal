// ─────────────────────────────────────────────────────────────────────────────
// 고객지원포탈 프론트 스모크 — 브라우저 콘솔에 붙여넣어 실행.
//
// 쓰는 법: 운영/ dev 사이트(로그인 후) 또는 로컬 프리뷰에서 F12 → Console → 붙여넣기 → Enter.
// 목적: 리팩터(중복 제거) 후 "핵심 함수·폼 옵션·렌더러가 그대로 살아있나"를 즉시 확인.
//       빨간 항목(❌)이 있으면 그 부분이 깨진 것.
// 성격: 읽기전용(상태 변경/네트워크 호출 없음).
// ─────────────────────────────────────────────────────────────────────────────
(function frontendSmoke() {
  const r = [];
  const t = (name, cond) => r.push((cond ? '✅' : '❌') + ' ' + name);
  const fn = (name) => t(name + '() 존재', typeof window[name] === 'function');
  const opts = (id) => { const el = document.getElementById(id); return el && el.options && el.options.length > 1; };

  // A. 폼 옵션 단일 출처 — populateStaticSelects가 채웠는지
  t('f-product 옵션 채워짐',    opts('f-product'));
  t('f-category 옵션 채워짐',   opts('f-category'));
  t('edit-product 옵션 채워짐', opts('edit-product'));
  t('edit-category 옵션 채워짐',opts('edit-category'));

  // B-1. 자료 수정 통합 함수
  fn('openDocModal');

  // B-2. 필터 팝업 공용 코어 + 위임자
  fn('filterPopApply'); fn('filterPopClear'); fn('filterUpdateButtons');
  fn('applyTkFilter'); fn('applyArFilter'); fn('clearTkFilter'); fn('clearArFilter');

  // 티켓 렌더러 3종(C 대상 — 존재 확인)
  fn('renderTickets'); fn('renderAllTickets'); fn('renderDashRecentTable');

  // 핵심 DOM 존재
  ['modal-doc','modal-new','ticket-tbody','ar-tbody','dash-recent-tbody','tk-pop-category','ar-pop-status']
    .forEach(id => t('#' + id + ' 존재', !!document.getElementById(id)));

  const fails = r.filter(x => x[0] === '❌');
  console.log('%c== 프론트 스모크 ==', 'font-weight:bold');
  console.log(r.join('\n'));
  console.log(fails.length ? `%c❌ ${fails.length}건 실패` : '%c✅ 전부 통과',
              'font-weight:bold;color:' + (fails.length ? 'crimson' : 'green'));
  return fails;
})();
