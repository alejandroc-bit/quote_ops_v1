-- quote_ops_v1 control-plane schema + RLS.
-- Appliance writes NEVER use anon/user keys: they go through control-plane-api
-- (service role) after validating the installation registration token.

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  tenant_id uuid references public.tenants (id) on delete cascade,
  role text not null check (role in ('owner', 'member', 'vendor_admin'))
);

create table public.installations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  installation_id text not null unique,
  version text,
  last_heartbeat_at timestamptz,
  settings jsonb not null default '{}'
);

create table public.registration_tokens (
  token text primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table public.credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  kind text not null,
  metadata jsonb not null default '{}',
  secret_ciphertext text,
  updated_at timestamptz not null default now()
);

create table public.usage_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  day date not null,
  quotes int not null default 0,
  routes int not null default 0,
  channel text not null,
  unique (tenant_id, day, channel)
);

create table public.sentinel_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  installation_id text not null,
  week_start date not null,
  body_md text not null,
  stats jsonb not null default '{}',
  status text not null default 'new',
  created_at timestamptz not null default now()
);

create table public.releases (
  version text primary key,
  notes text,
  published_at timestamptz not null default now()
);

-- Security-definer helpers avoid recursive RLS lookups on profiles.
create or replace function public.user_tenant_ids()
returns setof uuid
language sql stable security definer set search_path = public
as $$ select tenant_id from public.profiles where user_id = auth.uid() $$;

create or replace function public.is_vendor_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role = 'vendor_admin'
  )
$$;

alter table public.tenants enable row level security;
alter table public.profiles enable row level security;
alter table public.installations enable row level security;
alter table public.registration_tokens enable row level security;
alter table public.credentials enable row level security;
alter table public.usage_events enable row level security;
alter table public.sentinel_reports enable row level security;
alter table public.releases enable row level security;

-- tenants: members read their tenant; vendor_admin manages all.
create policy tenants_member_select on public.tenants
  for select to authenticated
  using (id in (select public.user_tenant_ids()));
create policy tenants_vendor_all on public.tenants
  for all to authenticated
  using (public.is_vendor_admin()) with check (public.is_vendor_admin());

-- profiles: users see their own row; vendor_admin manages all.
create policy profiles_self_select on public.profiles
  for select to authenticated
  using (user_id = auth.uid());
create policy profiles_vendor_all on public.profiles
  for all to authenticated
  using (public.is_vendor_admin()) with check (public.is_vendor_admin());

-- tenant-scoped tables: select/insert/update within own tenant; vendor_admin all.
do $$
declare t text;
begin
  foreach t in array array[
    'installations', 'registration_tokens', 'credentials', 'usage_events', 'sentinel_reports'
  ] loop
    execute format($p$
      create policy %1$s_tenant_select on public.%1$s
        for select to authenticated
        using (tenant_id in (select public.user_tenant_ids()));
      create policy %1$s_tenant_insert on public.%1$s
        for insert to authenticated
        with check (tenant_id in (select public.user_tenant_ids()));
      create policy %1$s_tenant_update on public.%1$s
        for update to authenticated
        using (tenant_id in (select public.user_tenant_ids()))
        with check (tenant_id in (select public.user_tenant_ids()));
      create policy %1$s_vendor_all on public.%1$s
        for all to authenticated
        using (public.is_vendor_admin()) with check (public.is_vendor_admin());
    $p$, t);
  end loop;
end $$;

-- releases: readable by all authenticated users; only vendor_admin writes.
create policy releases_authenticated_select on public.releases
  for select to authenticated using (true);
create policy releases_vendor_all on public.releases
  for all to authenticated
  using (public.is_vendor_admin()) with check (public.is_vendor_admin());

-- No anon access: RLS is enabled everywhere and no policy targets anon.
