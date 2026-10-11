-- Account-linked memory. Authenticated guests keep the same UUID when Google is linked.
-- Clients use their own bearer token, never a service_role key.
create table public.student_memory (
  user_id uuid primary key references auth.users(id) on delete cascade,
  facts jsonb not null default '[]'::jsonb,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now(),
  constraint memory_array check (jsonb_typeof(facts) = 'array'),
  constraint memory_size check (octet_length(facts::text) <= 1048576)
);
alter table public.student_memory enable row level security;
revoke all on public.student_memory from public, anon, authenticated;
grant select on public.student_memory to authenticated;
create policy memory_owner_read on public.student_memory for select to authenticated
  using ((select auth.uid()) = user_id);

create function public.read_student_memory()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('revision', revision, 'facts', facts)
     from public.student_memory where user_id = auth.uid()),
    jsonb_build_object('revision', 0, 'facts', '[]'::jsonb))
$$;

-- Compare-and-swap prevents two devices from overwriting each other's changes.
-- This is the only write path. Ownership is derived from the JWT, never from input.
create function public.write_student_memory(expected_revision bigint, new_facts jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid := auth.uid();
  current_row public.student_memory%rowtype;
  fact jsonb;
begin
  if owner_id is null then
    raise insufficient_privilege using message = 'An authenticated account is required';
  end if;
  if expected_revision is null or expected_revision < 0
     or new_facts is null or jsonb_typeof(new_facts) <> 'array' then
    raise invalid_parameter_value using message = 'Invalid memory document';
  end if;
  if jsonb_array_length(new_facts) > 2000 or octet_length(new_facts::text) > 1048576 then
    raise invalid_parameter_value using message = 'Memory document is too large';
  end if;
  for fact in select value from jsonb_array_elements(new_facts) loop
    if jsonb_typeof(fact) <> 'object'
       or not (fact ?& array['id', 'key', 'value', 'sources', 'sensitive', 'at'])
       or (fact - array['id', 'key', 'value', 'sources', 'sensitive', 'at']) <> '{}'::jsonb
       or jsonb_typeof(fact->'id') <> 'string' or length(fact->>'id') not between 1 and 64
       or jsonb_typeof(fact->'key') <> 'string' or length(fact->>'key') not between 1 and 100
       or jsonb_typeof(fact->'value') <> 'string' or length(fact->>'value') not between 1 and 500
       or jsonb_typeof(fact->'sources') <> 'array'
       or fact->'sensitive' <> 'false'::jsonb
       or jsonb_typeof(fact->'at') <> 'number' then
      raise invalid_parameter_value using message = 'Invalid memory fact';
    end if;
    if jsonb_array_length(fact->'sources') > 20 or exists (
      select 1 from jsonb_array_elements(fact->'sources') s
      where jsonb_typeof(s) <> 'string' or length(s #>> '{}') > 64
    ) then
      raise invalid_parameter_value using message = 'Invalid memory sources';
    end if;
  end loop;
  if (select count(distinct value->>'id') from jsonb_array_elements(new_facts))
     <> jsonb_array_length(new_facts) then
    raise invalid_parameter_value using message = 'Duplicate memory fact IDs';
  end if;

  insert into public.student_memory(user_id) values (owner_id) on conflict do nothing;
  select * into current_row from public.student_memory where user_id = owner_id for update;
  if current_row.revision <> expected_revision then
    return jsonb_build_object('conflict', true, 'revision', current_row.revision, 'facts', current_row.facts);
  end if;
  update public.student_memory set facts = new_facts, revision = revision + 1, updated_at = now()
    where user_id = owner_id returning * into current_row;
  return jsonb_build_object('conflict', false, 'revision', current_row.revision, 'facts', current_row.facts);
end
$$;
revoke all on function public.read_student_memory() from public, anon, authenticated;
revoke all on function public.write_student_memory(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.read_student_memory() to authenticated;
grant execute on function public.write_student_memory(bigint, jsonb) to authenticated;
