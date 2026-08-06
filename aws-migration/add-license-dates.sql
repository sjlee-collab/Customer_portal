-- company_licenses에 라이선스 기간 컬럼 추가
--
-- 배경: 라이선스에는 기간 개념이 아예 없었고, 계약(company_contracts)의 start_date/end_date만
--       존재했다. 그런데 Add-on처럼 계약 기간과 라이선스 기간이 다른 경우가 있어서
--       라이선스 자체에 기간을 따로 둔다.
--
-- renewal_date는 "갱신을 완료해야 하는 날"(기한)이다. 실제로 갱신한 날짜를 적는 이력용 컬럼이
-- 아니므로, 화면에서는 이 날짜 기준으로 남은 일수를 표시하고 지나면 경고한다.
--
-- 전부 null 허용이라 기존 행은 값이 비고, 화면에서는 "—"로 표시된다.
-- 여러 번 실행해도 안전하다(IF NOT EXISTS).

alter table public.company_licenses add column if not exists start_date   date;
alter table public.company_licenses add column if not exists end_date     date;
alter table public.company_licenses add column if not exists renewal_date date;

comment on column public.company_licenses.start_date   is '라이선스 시작일. 계약(company_contracts) 기간과 다를 수 있다.';
comment on column public.company_licenses.end_date     is '라이선스 만료일. 계약 기간과 다를 수 있다.';
comment on column public.company_licenses.renewal_date is '갱신을 완료해야 하는 날(기한). 실제 갱신 이력이 아니다.';

-- 확인용
-- select column_name, data_type, is_nullable
--   from information_schema.columns
--  where table_name = 'company_licenses' and column_name in ('start_date','end_date','renewal_date');
