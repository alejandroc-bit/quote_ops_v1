-- Unify the control-plane client registry on the RLS-protected Supabase tables.
-- The control-plane API connects directly with its dedicated database role;
-- ordinary portal access remains governed by the policies from 0001.

alter table public.tenants
  add column status text not null default 'onboarding',
  add column authorized_users jsonb not null default '[]'::jsonb,
  add constraint tenants_status_check
    check (status in ('active', 'onboarding', 'blocked', 'suspended')),
  add constraint tenants_authorized_users_array_check
    check (jsonb_typeof(authorized_users) = 'array');

alter table public.installations
  add column license_status text not null default 'pending',
  add column onboarding_status text not null default 'not_started',
  add column ai_key_status text not null default 'missing',
  add column counters jsonb not null default
    '{"total":0,"validated":0,"rejected":0,"pending":0,"failed":0}'::jsonb,
  add constraint installations_license_status_check
    check (license_status in ('active', 'pending', 'suspended', 'expired')),
  add constraint installations_onboarding_status_check
    check (
      onboarding_status in (
        'not_started',
        'authorized',
        'licensed',
        'waiting_local_secrets',
        'ready',
        'blocked'
      )
    ),
  add constraint installations_ai_key_status_check
    check (ai_key_status in ('configured', 'missing')),
  add constraint installations_counters_object_check
    check (jsonb_typeof(counters) = 'object');

-- Older deployments may have the lazy legacy tables while clean installs do
-- not. Dynamic SQL keeps the migration valid in both cases.
do $migration$
begin
  if to_regclass('public.control_plane_clients') is not null then
    execute $backfill_tenants$
      insert into public.tenants (
        client_id,
        authorized_email,
        name,
        created_at,
        status,
        authorized_users
      )
      select
        record ->> 'client_id',
        lower(btrim(record -> 'authorized_users' -> 0 ->> 'email')),
        record ->> 'legal_name',
        coalesce(nullif(record ->> 'created_at', '')::timestamptz, now()),
        case record ->> 'status'
          when 'active' then 'active'
          when 'blocked' then 'blocked'
          when 'suspended' then 'suspended'
          else 'onboarding'
        end,
        case
          when jsonb_typeof(record -> 'authorized_users') = 'array'
            and jsonb_array_length(record -> 'authorized_users') > 0
            then record -> 'authorized_users'
          else jsonb_build_array(
            jsonb_build_object(
              'email', lower(btrim(record -> 'authorized_users' -> 0 ->> 'email')),
              'role', 'owner'
            )
          )
        end
      from public.control_plane_clients
      where nullif(btrim(record ->> 'client_id'), '') is not null
        and nullif(btrim(record ->> 'legal_name'), '') is not null
        and nullif(btrim(record -> 'authorized_users' -> 0 ->> 'email'), '') is not null
      on conflict (client_id) do update set
        status = excluded.status,
        authorized_users = excluded.authorized_users
    $backfill_tenants$;

    execute $backfill_installations$
      insert into public.installations (
        tenant_id,
        installation_id,
        last_heartbeat_at,
        license_status,
        onboarding_status,
        ai_key_status,
        counters
      )
      select
        tenant.id,
        legacy.record -> 'installation' ->> 'installation_id',
        nullif(legacy.record -> 'installation' ->> 'last_heartbeat_at', '')::timestamptz,
        case legacy.record -> 'installation' ->> 'license_status'
          when 'active' then 'active'
          when 'suspended' then 'suspended'
          when 'expired' then 'expired'
          else 'pending'
        end,
        case legacy.record -> 'installation' ->> 'onboarding_status'
          when 'authorized' then 'authorized'
          when 'licensed' then 'licensed'
          when 'waiting_local_secrets' then 'waiting_local_secrets'
          when 'ready' then 'ready'
          when 'blocked' then 'blocked'
          else 'not_started'
        end,
        case legacy.record -> 'installation' ->> 'ai_key_status'
          when 'configured' then 'configured'
          else 'missing'
        end,
        case
          when jsonb_typeof(legacy.record -> 'counters') = 'object'
            then legacy.record -> 'counters'
          else '{"total":0,"validated":0,"rejected":0,"pending":0,"failed":0}'::jsonb
        end
      from public.control_plane_clients legacy
      inner join public.tenants tenant
        on tenant.client_id = legacy.record ->> 'client_id'
      where nullif(
        btrim(legacy.record -> 'installation' ->> 'installation_id'),
        ''
      ) is not null
      on conflict (installation_id) do update set
        last_heartbeat_at = excluded.last_heartbeat_at,
        license_status = excluded.license_status,
        onboarding_status = excluded.onboarding_status,
        ai_key_status = excluded.ai_key_status,
        counters = excluded.counters
    $backfill_installations$;
  end if;
end
$migration$;

drop table if exists public.control_plane_install_tokens;
drop table if exists public.control_plane_clients;

-- Existing 0001 tenants predate the authorized_users projection.
update public.tenants
set authorized_users = jsonb_build_array(
  jsonb_build_object('email', authorized_email, 'role', 'owner')
)
where authorized_users = '[]'::jsonb;

-- The production-only direct database role is created manually so its secret
-- is never versioned. Keep its schema privileges versioned when it exists.
do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'quoteops_cp') then
    grant usage on schema public to quoteops_cp;
    grant select, insert, update, delete on table
      public.tenants,
      public.profiles,
      public.installations,
      public.registration_tokens,
      public.credentials,
      public.usage_events,
      public.sentinel_reports,
      public.releases
    to quoteops_cp;
    grant usage, select on all sequences in schema public to quoteops_cp;
  end if;
end
$grants$;
