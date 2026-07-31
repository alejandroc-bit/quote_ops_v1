-- Freeze the exact safe installer payload and immutable appliance release at
-- registration-token issuance. Existing token rows remain nullable so this
-- migration is additive, but the application rejects them with
-- registration_token_reissue_required. Operators must issue a fresh token.

alter table public.registration_tokens
  add column if not exists release_version text,
  add column if not exists bundle_sha256 text,
  add column if not exists install_pack jsonb,
  add column if not exists pack_sha256 text;

alter table public.releases
  add column if not exists bundle_sha256 text,
  add column if not exists manifest jsonb,
  add column if not exists manifest_bytes bytea,
  add column if not exists archive bytea,
  add column if not exists published_at timestamptz default now();

create unique index if not exists releases_bundle_sha256_unique
  on public.releases (bundle_sha256)
  where bundle_sha256 is not null;
