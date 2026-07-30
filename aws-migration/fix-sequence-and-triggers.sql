-- RDS에 이미 적용된 schema.sql에 빠져있던 시퀀스/트리거 보강 패치
-- (테이블 컬럼만 보고 만든 schema.sql에는 안 잡혔던 객체들)

create sequence if not exists public.ticket_seq;

create or replace function public.generate_ticket_number()
 returns trigger
 language plpgsql
as $function$
BEGIN
  NEW.ticket_number := 'TK-' || to_char(now(), 'YYYYMMDD') || '-'
                       || LPAD(CAST(nextval('ticket_seq') AS text), 4, '0');
  RETURN NEW;
END;
$function$;

drop trigger if exists trg_ticket_number on public.tickets;
create trigger trg_ticket_number
  before insert on public.tickets
  for each row execute function public.generate_ticket_number();

create or replace function public.update_updated_at()
 returns trigger
 language plpgsql
as $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

create or replace function public.update_updated_at_column()
 returns trigger
 language plpgsql
as $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;

drop trigger if exists trg_companies_updated_at on public.companies;
create trigger trg_companies_updated_at before update on public.companies for each row execute function public.update_updated_at();

drop trigger if exists trg_users_updated_at on public.users;
create trigger trg_users_updated_at before update on public.users for each row execute function public.update_updated_at();

drop trigger if exists trg_tickets_updated_at on public.tickets;
create trigger trg_tickets_updated_at before update on public.tickets for each row execute function public.update_updated_at();

drop trigger if exists trg_documents_updated_at on public.content_documents;
create trigger trg_documents_updated_at before update on public.content_documents for each row execute function public.update_updated_at();

drop trigger if exists contracts_updated_at on public.company_contracts;
create trigger contracts_updated_at before update on public.company_contracts for each row execute function public.update_updated_at_column();

drop trigger if exists licenses_updated_at on public.company_licenses;
create trigger licenses_updated_at before update on public.company_licenses for each row execute function public.update_updated_at_column();

create or replace function public.log_ticket_created()
 returns trigger
 language plpgsql
as $function$
BEGIN
  INSERT INTO ticket_history (ticket_id, changed_by, action, new_value)
  VALUES (NEW.id, NEW.created_by, 'created', NEW.status);
  RETURN NEW;
END;
$function$;

drop trigger if exists trg_ticket_history_created on public.tickets;
create trigger trg_ticket_history_created
  after insert on public.tickets
  for each row execute function public.log_ticket_created();

-- 마지막으로, 아까 실패했던 setval을 정확한 값으로 재실행
select pg_catalog.setval('public.ticket_seq', 304, true);
