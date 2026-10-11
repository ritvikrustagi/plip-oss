-- Run after the student_memory migration in a disposable database. Rolls back test data.
begin;
insert into auth.users(id) values
  ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
set local role anon;
do $$ begin
  begin
    perform public.read_student_memory();
    raise exception 'anon read unexpectedly allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform public.write_student_memory(0, '[]');
    raise exception 'anon write unexpectedly allowed';
  exception when insufficient_privilege then null; end;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
do $$ declare result jsonb; begin
  result := public.read_student_memory();
  assert result = '{"revision":0,"facts":[]}'::jsonb, 'new account must start empty';
  result := public.write_student_memory(0,
    '[{"id":"fact-a","key":"note","value":"use examples","sources":["you"],"sensitive":false,"at":1}]');
  assert result->>'revision' = '1' and result->>'conflict' = 'false', 'first write failed';
  result := public.write_student_memory(0, '[]');
  assert result->>'conflict' = 'true' and result->'facts'->0->>'id' = 'fact-a', 'stale write overwrote data';
  assert (select count(*) from public.student_memory) = 1, 'owner cannot read own row';
  begin
    update public.student_memory set facts = '[]';
    raise exception 'direct write bypassed revision checking';
  exception when insufficient_privilege then null; end;
  begin
    perform public.write_student_memory(1, '[{"id":"incomplete"}]');
    raise exception 'malformed fact accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.write_student_memory(1,
      '[{"id":"secret","key":"note","value":"secret","sources":[],"sensitive":true,"at":1}]');
    raise exception 'sensitive fact accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.write_student_memory(1,
      '[{"id":"bad","key":"note","value":"test","sources":[null],"sensitive":false,"at":1}]');
    raise exception 'malformed source accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.write_student_memory(1,
      '[{"id":"same","key":"note","value":"test","sources":[],"sensitive":false,"at":1},
        {"id":"same","key":"note","value":"test","sources":[],"sensitive":false,"at":1}]');
    raise exception 'duplicate fact IDs accepted';
  exception when invalid_parameter_value then null; end;
end $$;

select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
do $$ declare result jsonb; begin
  assert (select count(*) from public.student_memory) = 0, 'B can see A through the table';
  assert public.read_student_memory()->'facts' = '[]'::jsonb, 'B can see A through RPC';
  result := public.write_student_memory(0, '[]');
  assert result->>'revision' = '1', 'B cannot write its own row';
end $$;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
do $$ begin
  assert (select count(*) from public.student_memory) = 1, 'A can see B';
  assert public.read_student_memory()->'facts'->0->>'id' = 'fact-a', 'B modified A';
  assert public.write_student_memory(1, '[]')->>'revision' = '2', 'delete failed';
  assert public.read_student_memory()->'facts' = '[]'::jsonb, 'deleted content retained';
end $$;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  begin
    perform public.write_student_memory(0, '[]');
    raise exception 'missing JWT accepted';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
delete from auth.users where id = '11111111-1111-4111-8111-111111111111';
do $$ begin
  assert not exists (select 1 from public.student_memory
    where user_id = '11111111-1111-4111-8111-111111111111'), 'account deletion did not cascade';
end $$;
rollback;
