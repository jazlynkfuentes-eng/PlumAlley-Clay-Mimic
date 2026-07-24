-- Plum Alley Clay Mimic — run this in the Supabase SQL Editor once.
-- Dashboard → SQL → New query → paste → Run

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  name text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists projects_updated_at_idx on public.projects (updated_at desc);
create index if not exists projects_owner_email_idx on public.projects (owner_email);

alter table public.projects enable row level security;

-- Any authenticated team member can see/load all projects (shared workspace).
drop policy if exists "projects_select_authenticated" on public.projects;
create policy "projects_select_authenticated"
  on public.projects for select
  to authenticated
  using (true);

drop policy if exists "projects_insert_authenticated" on public.projects;
create policy "projects_insert_authenticated"
  on public.projects for insert
  to authenticated
  with check (auth.jwt() ->> 'email' is not null);

drop policy if exists "projects_update_authenticated" on public.projects;
create policy "projects_update_authenticated"
  on public.projects for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "projects_delete_authenticated" on public.projects;
create policy "projects_delete_authenticated"
  on public.projects for delete
  to authenticated
  using (true);

grant select, insert, update, delete on public.projects to authenticated;

-- Optional: keep updated_at fresh
create or replace function public.set_projects_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_set_updated_at on public.projects;
create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_projects_updated_at();
