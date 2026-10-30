-- =====================================================================
-- DRE Production — database schema for Supabase
-- Run once in Supabase → SQL Editor → New query → paste → Run.
-- Safe to run again: it only creates what is missing and refreshes rules.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. People and roles
--    master  : owner, everything + manages who has access
--    full    : everything except managing access   (e.g. Prita)
--    ops     : Plotting, Panel, Hari Ini            (production admin)
--    viewer  : only sees Hari Ini                   (employees)
--    pending : signed up, waiting for the master to give a role (sees nothing)
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  name       text,
  role       text not null default 'pending'
             check (role in ('master', 'full', 'ops', 'viewer', 'pending')),
  created_at timestamptz not null default now()
);

-- The signed-in person's role ('pending' when signed out or unknown).
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'pending');
$$;

create or replace function public.has_role(variadic roles text[]) returns boolean
language sql stable as $$
  select public.my_role() = any(roles);
$$;

-- Every new sign-up gets a profile. The owner's email becomes master automatically;
-- everyone else waits as 'pending' until the master gives them a role in the app.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, name, role)
  values (
    new.id,
    new.email,
    coalesce(nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1)),
    case when lower(new.email) = 'affanmnr@gmail.com' then 'master' else 'pending' end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.has_role('master'));

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (public.has_role('master')) with check (public.has_role('master'));

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles for delete to authenticated
  using (public.has_role('master') and id <> auth.uid());

-- ---------------------------------------------------------------------
-- 2. Production data
--    Each row is one record of the app (same shape the app already uses):
--    app_config  : employees, steps, machines, sizes, quick tasks (one row 'main')
--    projects    : one row per project (batches inside)
--    plots       : one row per task placed on an employee + day
--    panels      : one row per board / panel scheduled on a machine + day
--    attendance  : one row per day (who was Telat / Lembur / Gamasuk)
-- ---------------------------------------------------------------------
create table if not exists public.app_config (
  id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists public.projects (
  id text primary key, data jsonb not null, updated_at timestamptz not null default now());
create table if not exists public.plots (
  id text primary key, data jsonb not null, updated_at timestamptz not null default now(),
  date text generated always as (data->>'date') stored);
create table if not exists public.panels (
  id text primary key, data jsonb not null, updated_at timestamptz not null default now(),
  date text generated always as (data->>'date') stored);
create table if not exists public.attendance (
  id text primary key, data jsonb not null, updated_at timestamptz not null default now());

create index if not exists plots_date_idx  on public.plots (date);
create index if not exists panels_date_idx on public.panels (date);

-- Keep updated_at fresh on every change.
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;

do $$
declare t text;
begin
  foreach t in array array['app_config', 'projects', 'plots', 'panels', 'attendance'] loop
    execute format('drop trigger if exists touch_%1$s on public.%1$s', t);
    execute format('create trigger touch_%1$s before update on public.%1$s for each row execute function public.touch_updated_at()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I replica identity full', t);
  end loop;
end $$;

-- Who may read: everyone with a real role. Who may write: depends on the table.
--   app_config : master, full
--   projects   : master, full create/delete; ops may also update
--                (ticking a step as done in Plotting saves it on the project)
--   plots, panels, attendance : master, full, ops
do $$
declare
  t text;
  writers text;
begin
  foreach t in array array['app_config', 'projects', 'plots', 'panels', 'attendance'] loop
    writers := case when t in ('app_config', 'projects') then '''master'', ''full'''
                    else '''master'', ''full'', ''ops''' end;

    execute format('drop policy if exists %1$s_select on public.%1$s', t);
    execute format('create policy %1$s_select on public.%1$s for select to authenticated
                    using (public.has_role(''master'', ''full'', ''ops'', ''viewer''))', t);

    execute format('drop policy if exists %1$s_insert on public.%1$s', t);
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated
                    with check (public.has_role(%2$s))', t, writers);

    execute format('drop policy if exists %1$s_update on public.%1$s', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated
                    using (public.has_role(%2$s)) with check (public.has_role(%2$s))', t,
                   case when t = 'projects' then '''master'', ''full'', ''ops''' else writers end);

    execute format('drop policy if exists %1$s_delete on public.%1$s', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated
                    using (public.has_role(%2$s))', t, writers);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3. Live updates: changes by one person appear on everyone's screen
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['app_config', 'projects', 'plots', 'panels', 'attendance', 'profiles'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Done. Quick check (should list the 6 tables):
select table_name from information_schema.tables
where table_schema = 'public'
  and table_name in ('profiles', 'app_config', 'projects', 'plots', 'panels', 'attendance')
order by table_name;
