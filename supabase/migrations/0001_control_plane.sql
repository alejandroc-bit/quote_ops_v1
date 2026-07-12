-- quote_ops_v1 control-plane schema + RLS.
-- Appliance writes NEVER use anon/user keys: they go through control-plane-api
-- (service role) after validating the installation registration token.

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  authorized_email text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  check (authorized_email = lower(btrim(authorized_email)) and authorized_email <> '')
);

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  tenant_id uuid references public.tenants (id) on delete cascade,
  role text not null check (role in ('owner', 'member', 'vendor_admin')),
  email text not null,
  check (email = lower(btrim(email)) and email <> ''),
  check (role = 'vendor_admin' or tenant_id is not null)
);

create table public.installations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  installation_id text not null unique,
  version text,
  last_heartbeat_at timestamptz,
  settings jsonb not null default '{}',
  unique (tenant_id, installation_id),
  check (jsonb_typeof(settings) = 'object')
);

create table public.registration_tokens (
  token text primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  installation_id text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  foreign key (tenant_id, installation_id)
    references public.installations (tenant_id, installation_id) on delete cascade
);

create table public.credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  kind text not null,
  metadata jsonb not null default '{}',
  secret_ciphertext text,
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(metadata) = 'object')
);

create table public.usage_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  day date not null,
  quotes int not null default 0,
  routes int not null default 0,
  channel text not null,
  unique (tenant_id, day, channel),
  check (quotes >= 0),
  check (routes >= 0)
);

create table public.sentinel_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  installation_id text not null,
  week_start date not null,
  body_md text not null,
  stats jsonb not null,
  status text not null default 'new',
  created_at timestamptz not null default now(),
  constraint sentinel_reports_stats_aggregate_only check (
    case
      when jsonb_typeof(stats) = 'object'
        -- exactly these four keys: all present, and removing them leaves {}
        then stats ?& array['runs', 'errors', 'interrupts', 'avg_node_ms']::text[]
          and (stats - 'runs' - 'errors' - 'interrupts' - 'avg_node_ms') = '{}'::jsonb
      else false
    end
    and case
      when jsonb_typeof(stats -> 'runs') = 'number'
        then (stats ->> 'runs') ~ '^[0-9]+$' and (stats ->> 'runs')::numeric >= 0
      else false
    end
    and case
      when jsonb_typeof(stats -> 'errors') = 'number'
        then (stats ->> 'errors') ~ '^[0-9]+$' and (stats ->> 'errors')::numeric >= 0
      else false
    end
    and case
      when jsonb_typeof(stats -> 'interrupts') = 'number'
        then (stats ->> 'interrupts') ~ '^[0-9]+$' and (stats ->> 'interrupts')::numeric >= 0
      else false
    end
    and case
      when jsonb_typeof(stats -> 'avg_node_ms') = 'number'
        then (stats ->> 'avg_node_ms')::numeric >= 0
          and lower(stats ->> 'avg_node_ms') not in ('nan', 'infinity', '-infinity')
      else false
    end
  )
);

create table public.releases (
  version text primary key,
  notes text,
  published_at timestamptz not null default now(),
  check (version ~ '^v[0-9]+\.[0-9]+\.[0-9]+$')
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

-- Supabase normally grants table privileges to anon/authenticated. RLS would
-- still deny anon because no anon policy exists, but explicit revokes make the
-- appliance/control-plane boundary independently auditable.
revoke all on table public.tenants from anon;
revoke all on table public.profiles from anon;
revoke all on table public.installations from anon;
revoke all on table public.registration_tokens from anon;
revoke all on table public.credentials from anon;
revoke all on table public.usage_events from anon;
revoke all on table public.sentinel_reports from anon;
revoke all on table public.releases from anon;
revoke all on function public.user_tenant_ids() from public, anon;
revoke all on function public.is_vendor_admin() from public, anon;
grant execute on function public.user_tenant_ids() to authenticated;
grant execute on function public.is_vendor_admin() to authenticated;

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

-- installations: tenant isolation through profiles/auth.uid; vendor admin all.
create policy installations_tenant_select on public.installations
  for select to authenticated
  using (tenant_id in (select public.user_tenant_ids()));
create policy installations_tenant_insert on public.installations
  for insert to authenticated
  with check (tenant_id in (select public.user_tenant_ids()));
create policy installations_tenant_update on public.installations
  for update to authenticated
  using (tenant_id in (select public.user_tenant_ids()))
  with check (tenant_id in (select public.user_tenant_ids()));
create policy installations_vendor_all on public.installations
  for all to authenticated
  using (public.is_vendor_admin()) with check (public.is_vendor_admin());

-- Registration tokens are control-plane credentials, never ordinary tenant
-- portal data. Only vendor admins may access rows through authenticated RLS;
-- appliance validation uses the service/direct database connection.
create policy registration_tokens_vendor_all on public.registration_tokens
  for all to authenticated
  using (public.is_vendor_admin()) with check (public.is_vendor_admin());

-- credentials.
create policy credentials_tenant_select on public.credentials
  for select to authenticated
  using (tenant_id in (select public.user_tenant_ids()));
create policy credentials_tenant_insert on public.credentials
  for insert to authenticated
  with check (tenant_id in (select public.user_tenant_ids()));
create policy credentials_tenant_update on public.credentials
  for update to authenticated
  using (tenant_id in (select public.user_tenant_ids()))
  with check (tenant_id in (select public.user_tenant_ids()));
create policy credentials_vendor_all on public.credentials
  for all to authenticated
  using (public.is_vendor_admin()) with check (public.is_vendor_admin());

-- aggregate usage only.
create policy usage_events_tenant_select on public.usage_events
  for select to authenticated
  using (tenant_id in (select public.user_tenant_ids()));
create policy usage_events_tenant_insert on public.usage_events
  for insert to authenticated
  with check (tenant_id in (select public.user_tenant_ids()));
create policy usage_events_tenant_update on public.usage_events
  for update to authenticated
  using (tenant_id in (select public.user_tenant_ids()))
  with check (tenant_id in (select public.user_tenant_ids()));
create policy usage_events_vendor_all on public.usage_events
  for all to authenticated
  using (public.is_vendor_admin()) with check (public.is_vendor_admin());

-- Tenant users can read sanitized reports. Appliance inserts use the service
-- role/direct connection in control-plane-api; only vendor admins may mutate.
create policy sentinel_reports_tenant_select on public.sentinel_reports
  for select to authenticated
  using (tenant_id in (select public.user_tenant_ids()));
create policy sentinel_reports_vendor_all on public.sentinel_reports
  for all to authenticated
  using (public.is_vendor_admin()) with check (public.is_vendor_admin());

-- releases: readable by all authenticated users; only vendor_admin writes.
create policy releases_authenticated_select on public.releases
  for select to authenticated using (true);
create policy releases_vendor_all on public.releases
  for all to authenticated
  using (public.is_vendor_admin()) with check (public.is_vendor_admin());

-- No anon access: RLS is enabled everywhere and no policy targets anon.
