-- ============================================================
-- CRUZEIRO MOBILE — Schema Supabase (Final)
-- ============================================================
--
-- FLUXO GERAL:
--   Desktop → Supabase : snapshots de leitura (balances,
--     transactions, budgets, goals, scheduled, ml_rules)
--   Mobile  → Supabase : quick_entries (despesas manuais)
--   Supabase → Desktop : quick_entries pending → importação
--
-- CONVENÇÕES:
--   • Valores monetários em INTEGER (centavos) — sem float
--   • user_id sempre referencia auth.users(id)
--   • desktop_id = PK original do SQLite (para deduplicação)
--   • Desktop usa service_role key (bypassa RLS)
--   • Mobile usa JWT do usuário (RLS aplicada)
-- ============================================================


-- ------------------------------------------------------------
-- EXTENSÕES
-- ------------------------------------------------------------
create extension if not exists "pg_cron";
create extension if not exists "pg_net";


-- ============================================================
-- 1. SNAPSHOT: DESKTOP → SUPABASE (leitura no mobile)
-- ============================================================

-- ------------------------------------------------------------
-- 1a. Saldos por conta
-- ------------------------------------------------------------
create table mobile_balances (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,

  account_name  text    not null,
  account_type  text    not null,   -- 'checking' | 'savings' | 'investment' | 'wallet'
  balance       integer not null,   -- centavos (pode ser negativo)
  currency      char(3) not null default 'BRL',
  is_hidden     boolean not null default false,
  sort_order    integer not null default 0,

  synced_at     timestamptz not null default now()
);

create index on mobile_balances(user_id);
create unique index on mobile_balances(user_id, account_name);


-- ------------------------------------------------------------
-- 1b. Transações recentes (últimos 90 dias)
-- ------------------------------------------------------------
create table mobile_transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,

  desktop_id      text not null,
  date            date        not null,
  description     text        not null,
  amount          integer     not null,   -- centavos; negativo = despesa
  category        text,
  subcategory     text,
  account_name    text        not null,
  memo            text,
  is_reconciled   boolean     not null default false,

  synced_at       timestamptz not null default now()
);

create index on mobile_transactions(user_id, date desc);
create unique index on mobile_transactions(user_id, desktop_id);


-- ------------------------------------------------------------
-- 1c. Orçamento mensal por categoria
-- ------------------------------------------------------------
create table mobile_budgets (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,

  month           char(7)  not null,           -- 'YYYY-MM'
  category        text     not null,
  monthly_limit   integer  not null,           -- centavos
  spent           integer  not null default 0, -- centavos (calculado pelo desktop)
  alert_pct       integer  not null default 80,

  synced_at       timestamptz not null default now()
);

create index on mobile_budgets(user_id, month);
create unique index on mobile_budgets(user_id, month, category);


-- ------------------------------------------------------------
-- 1d. Metas (goals)
-- Espelho da tabela goals do SQLite + progresso calculado
-- ------------------------------------------------------------
create table mobile_goals (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,

  desktop_id          text not null,
  name                text not null,
  type                text not null,   -- 'target' | 'monthly' | 'emergency'
  icon                text default '🎯',
  color               text default '#2563eb',

  -- configuração (espelho do desktop)
  target_amount       integer,         -- centavos
  monthly_amount      integer,         -- centavos
  emergency_months    integer,
  deadline            date,

  -- progresso calculado pelo desktop no momento do sync
  current_amount      integer not null default 0,  -- centavos
  progress_pct        numeric(5,2)     default 0,  -- 0.00–100.00

  active              boolean not null default true,

  synced_at           timestamptz not null default now()
);

create index on mobile_goals(user_id, active);
create unique index on mobile_goals(user_id, desktop_id);


-- ------------------------------------------------------------
-- 1e. Lançamentos futuros / recorrentes
-- Espelho da tabela recurring do SQLite
-- ------------------------------------------------------------
create table mobile_scheduled (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,

  desktop_id      text not null,
  next_date       date        not null,
  memo            text        not null,
  amount          integer     not null,   -- centavos
  category        text,
  account_name    text,
  frequency       text        not null,   -- 'monthly' | 'weekly' | 'yearly' | ...
  end_date        date,

  -- controle de notificação (gerenciado pela Edge Function)
  reminder_sent_at  timestamptz,

  synced_at       timestamptz not null default now()
);

create index on mobile_scheduled(user_id, next_date);
create unique index on mobile_scheduled(user_id, desktop_id);


-- ------------------------------------------------------------
-- 1f. Agregados de patrimônio (últimos 3 meses)
-- Desktop calcula e publica totais; mobile só exibe
-- ------------------------------------------------------------
create table mobile_patrimonio (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,

  month           char(7) not null,       -- 'YYYY-MM'
  total_assets    integer not null,       -- centavos
  total_debts     integer not null,       -- centavos (positivo)
  net_worth       integer not null,       -- total_assets - total_debts

  -- breakdown por tipo de ativo (para gráfico)
  breakdown       jsonb,
  -- ex: {"imovel": 50000000, "veiculo": 8000000, "investimento": 12000000}

  synced_at       timestamptz not null default now()
);

create index on mobile_patrimonio(user_id, month desc);
create unique index on mobile_patrimonio(user_id, month);


-- ------------------------------------------------------------
-- 1g. Agregados de evolução (para gráficos)
-- Desktop publica totais mensais de receita/despesa/saldo
-- ------------------------------------------------------------
create table mobile_evolution (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,

  month           char(7) not null,   -- 'YYYY-MM'
  income          integer not null,   -- centavos
  expenses        integer not null,   -- centavos (positivo)
  balance         integer not null,   -- income - expenses

  -- breakdown de despesas por categoria (para gráfico de categorias)
  by_category     jsonb,
  -- ex: {"Alimentação": 120000, "Transporte": 45000, ...}

  synced_at       timestamptz not null default now()
);

create index on mobile_evolution(user_id, month desc);
create unique index on mobile_evolution(user_id, month);


-- ============================================================
-- 2. REGRAS DE ML
-- Sincronização bidirecional desktop ↔ Supabase ↔ mobile
-- ============================================================
create table ml_rules (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,

  keyword     text    not null,   -- lowercase; match por substring na descrição
  memo        text    not null default '',
  category    text    not null default '',
  count       integer not null default 1,  -- reforço: maior = mais confiante

  -- estatísticas de valor (informativas, não usadas na classificação mobile)
  sum_val     numeric,
  n_val       integer,
  min_val     numeric,
  max_val     numeric,

  -- origem da regra
  source      text not null default 'desktop',  -- 'desktop' | 'mobile'

  synced_at   timestamptz not null default now(),

  unique(user_id, keyword)
);

create index on ml_rules(user_id, count desc);


-- ============================================================
-- 3. ENTRADAS DO MOBILE → DESKTOP
-- ============================================================

-- ------------------------------------------------------------
-- 3a. Despesas registradas no celular
-- ------------------------------------------------------------
create table quick_entries (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,

  -- dados da transação (preenchidos pelo usuário)
  date            date        not null default current_date,
  memo            text        not null,    -- escrito pelo usuário
  amount          integer     not null,    -- centavos; sempre positivo (despesa)
  category        text        not null,    -- selecionado pelo usuário
  account_name    text,
  notes           text,

  -- rastreamento do ML
  ml_suggested_category  text,     -- o que o ML sugeriu (pode ser null se sem match)
  ml_accepted            boolean,  -- true = aceitou sugestão / false = corrigiu / null = sem sugestão

  -- ciclo de vida
  status          text not null default 'pending'
                  check (status in ('pending', 'imported', 'rejected')),
  imported_at     timestamptz,
  desktop_id      text,            -- ID gerado pelo desktop após importar

  created_at      timestamptz not null default now()
);

create index on quick_entries(user_id, status, created_at desc);


-- ============================================================
-- 4. NOTIFICAÇÕES E DISPOSITIVOS
-- ============================================================

-- ------------------------------------------------------------
-- 4a. Tokens Expo Push por dispositivo
-- ------------------------------------------------------------
create table push_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,

  token       text not null unique,
  device_name text,
  platform    text,   -- 'ios' | 'android'
  is_active   boolean not null default true,

  created_at  timestamptz not null default now(),
  last_used   timestamptz not null default now()
);

create index on push_tokens(user_id, is_active);


-- ------------------------------------------------------------
-- 4b. Preferências de notificação por usuário
-- ------------------------------------------------------------
create table notification_preferences (
  user_id                 uuid primary key references auth.users(id) on delete cascade,

  -- lembretes de lançamentos futuros
  reminders_enabled       boolean   not null default true,
  reminder_days_before    integer[] not null default '{1, 3, 7}',
  reminder_hour           integer   not null default 8
                          check (reminder_hour between 0 and 23),
  reminder_timezone       text      not null default 'America/Sao_Paulo',

  -- alertas de orçamento
  budget_alerts_enabled   boolean not null default true,
  budget_threshold_pct    integer not null default 80
                          check (budget_threshold_pct between 1 and 100),

  channel_push            boolean not null default true,

  updated_at  timestamptz not null default now()
);


-- ------------------------------------------------------------
-- 4c. Log de notificações enviadas
-- ------------------------------------------------------------
create table notification_log (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,

  type            text not null,
  -- 'reminder' | 'budget_warning' | 'budget_exceeded'

  reference_id    uuid,
  reference_type  text,
  -- 'mobile_scheduled' | 'mobile_budgets'

  channel         text not null default 'push',
  push_token      text,
  payload         jsonb,

  status          text not null default 'sent'
                  check (status in ('sent', 'failed', 'bounced')),
  error_message   text,

  sent_at         timestamptz not null default now()
);

create index on notification_log(user_id, sent_at desc);
create index on notification_log(reference_id);


-- ============================================================
-- 5. ROW LEVEL SECURITY
-- ============================================================
alter table mobile_balances          enable row level security;
alter table mobile_transactions      enable row level security;
alter table mobile_budgets           enable row level security;
alter table mobile_goals             enable row level security;
alter table mobile_scheduled         enable row level security;
alter table mobile_patrimonio        enable row level security;
alter table mobile_evolution         enable row level security;
alter table ml_rules                 enable row level security;
alter table quick_entries            enable row level security;
alter table push_tokens              enable row level security;
alter table notification_preferences enable row level security;
alter table notification_log         enable row level security;

-- Usuário acessa apenas seus próprios dados
do $$ declare
  t text;
begin
  foreach t in array array[
    'mobile_balances','mobile_transactions','mobile_budgets',
    'mobile_goals','mobile_scheduled','mobile_patrimonio',
    'mobile_evolution','ml_rules','quick_entries',
    'push_tokens','notification_preferences','notification_log'
  ] loop
    execute format(
      'create policy "user_own_data" on %I for all using (auth.uid() = user_id)', t
    );
  end loop;
end $$;

-- Nota: Desktop usa SUPABASE_SERVICE_ROLE_KEY → bypassa RLS


-- ============================================================
-- 6. TRIGGERS AUTOMÁTICOS
-- ============================================================

-- Cria preferências padrão para todo novo usuário
create or replace function handle_new_user_preferences()
returns trigger language plpgsql security definer as $$
begin
  insert into notification_preferences(user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created_preferences
  after insert on auth.users
  for each row execute procedure handle_new_user_preferences();


-- Atualiza last_used do push_token ao fazer upsert
create or replace function update_push_token_last_used()
returns trigger language plpgsql as $$
begin
  new.last_used = now();
  return new;
end;
$$;

create trigger push_token_last_used
  before update on push_tokens
  for each row execute procedure update_push_token_last_used();


-- ============================================================
-- 7. CRON — disparo diário de notificações (08:00 BRT)
-- ============================================================
select cron.schedule(
  'cruzeiro-daily-notifications',
  '0 11 * * *',   -- 11:00 UTC = 08:00 BRT
  $$
    select net.http_post(
      url     := current_setting('app.supabase_functions_url') || '/send-notifications',
      body    := '{}',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || current_setting('app.service_role_key')
      )
    );
  $$
);


-- ============================================================
-- 8. FUNÇÃO AUXILIAR — verificar licença ativa
-- ============================================================
create or replace function is_license_active(p_user_id uuid)
returns boolean language sql security definer as $$
  select exists (
    select 1 from licenses
    where user_id = p_user_id
      and status = 'active'
      and (expires_at is null or expires_at > now())
  );
$$;


-- ============================================================
-- RESUMO DAS TABELAS
-- ============================================================
--
-- DESKTOP → SUPABASE (sync de leitura):
--   mobile_balances      saldo por conta
--   mobile_transactions  últimos 90 dias de lançamentos
--   mobile_budgets       orçamento vs gasto por categoria/mês
--   mobile_goals         metas e progresso calculado
--   mobile_scheduled     lançamentos recorrentes/futuros
--   mobile_patrimonio    totais de patrimônio (últimos 3 meses)
--   mobile_evolution     receita/despesa/saldo mensal + breakdown
--   ml_rules             regras de categorização automática
--
-- MOBILE → SUPABASE → DESKTOP:
--   quick_entries        despesas inseridas no celular
--
-- INFRAESTRUTURA:
--   push_tokens              dispositivos registrados
--   notification_preferences configurações por usuário
--   notification_log         histórico de envios
-- ============================================================
