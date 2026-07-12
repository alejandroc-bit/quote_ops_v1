export const schemaSql = `
create table if not exists workflow_runs (
  run_id text primary key,
  client_id text not null,
  rfq_id text not null,
  status text not null,
  approval_required boolean not null,
  route_source text,
  base_rate_mxn numeric,
  recommended_rate_mxn numeric,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists approval_decisions (
  run_id text primary key references workflow_runs(run_id) on delete cascade,
  action text not null check (action in ('approve', 'adjust', 'reject', 'request_review')),
  rate_mxn numeric,
  reason text,
  email_sent boolean not null default false,
  decided_at timestamptz not null
);

create table if not exists heartbeats (
  id bigserial primary key,
  client_id text not null,
  installation_id text not null,
  version text not null,
  payload jsonb not null,
  received_at timestamptz not null
);

create table if not exists quote_runs (
  run_id text primary key,
  channel text not null check (channel in ('email', 'whatsapp')),
  status text not null check (status in ('running', 'waiting_approval', 'done', 'error')),
  summary text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists quote_run_steps (
  run_id text not null references quote_runs(run_id) on delete cascade,
  seq integer not null,
  node text not null,
  status text not null check (status in ('start', 'end', 'error')),
  summary text not null,
  data jsonb,
  ts timestamptz not null,
  primary key (run_id, seq)
);

create table if not exists schema_migrations (
  migration_id text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);

create table if not exists appliance_license (
  installation_id text primary key,
  client_id text not null,
  license_payload jsonb not null,
  signature text not null,
  status text not null,
  checked_at timestamptz not null default now()
);

create table if not exists client_tms_configs (
  client_id text primary key,
  endpoint_url text not null,
  auth_method text not null,
  api_key_env text,
  transport text not null,
  mapping_engine text not null,
  schema_hash text not null,
  mappings jsonb not null,
  runtime_ai_calls_allowed boolean not null default false check (runtime_ai_calls_allowed = false),
  drift_status text not null default 'ok',
  last_validated_at timestamptz
);

create table if not exists tms_schema_drift_events (
  id bigserial primary key,
  client_id text not null,
  entity_type text not null,
  schema_hash text not null,
  reason_codes jsonb not null,
  rfq_effect text not null,
  sample_fingerprint text not null,
  created_at timestamptz not null default now()
);

create table if not exists knowledge_documents (
  document_id text primary key,
  client_id text not null,
  filename text not null,
  content_type text not null,
  checksum text not null,
  uploaded_by text,
  created_at timestamptz not null default now(),
  unique (document_id, client_id)
);

create table if not exists knowledge_chunks (
  chunk_id text primary key,
  document_id text not null,
  client_id text not null,
  chunk_index integer not null,
  chunk_text text not null,
  embedding jsonb not null,
  source_section text,
  created_at timestamptz not null default now(),
  foreign key (document_id, client_id) references knowledge_documents(document_id, client_id) on delete cascade,
  unique (document_id, chunk_index)
);

create table if not exists knowledge_ingestion_jobs (
  job_id text primary key,
  client_id text not null,
  status text not null,
  embedding_provider text not null,
  embedding_model text not null,
  document_count integer not null default 0,
  error_code text,
  started_at timestamptz not null,
  completed_at timestamptz
);

create index if not exists workflow_runs_client_updated_idx on workflow_runs(client_id, updated_at desc);
create index if not exists heartbeats_client_received_idx on heartbeats(client_id, received_at desc);
create index if not exists quote_runs_updated_idx on quote_runs(updated_at desc);
create index if not exists quote_run_steps_run_seq_idx on quote_run_steps(run_id, seq);
`;
