-- ─────────────────────────────────────────────────────────────
-- patrimonio_items.sql
-- Itens detalhados de patrimônio pro mobile (aba "Patrimônio") — um
-- upgrade de mobile_patrimonio (que só tinha totais agregados por mês).
-- Cada linha é UM item: um bem, um investimento, um cartão/dívida ou
-- uma conta bancária. sync-push.js agora faz DELETE (por user_id) +
-- INSERT a cada sync, em vez de upsert por constraint única — por isso
-- este script não depende mais de nenhuma UNIQUE(user_id,desktop_id)
-- pra funcionar corretamente.
--
-- Segue o mesmo padrão de criptografia E2E das demais tabelas mobile_*:
-- quase todo campo é TEXT porque pode conter tanto um valor em claro
-- (usuário sem senha/criptografia ativada) quanto uma string cifrada em
-- base64 (encFields() em sync-push.js) — nunca number/numeric direto,
-- senão o insert falharia pro caso cifrado. `section` fica em claro de
-- propósito: é só o rótulo estrutural (bem/investimento/cartao_divida/
-- conta), igual pra todo mundo, sem conteúdo financeiro — precisa estar
-- legível pro mobile filtrar por seção sem decifrar a linha inteira.
--
-- Escrito de forma defensiva (ADD COLUMN IF NOT EXISTS coluna a coluna,
-- em vez de só CREATE TABLE IF NOT EXISTS) porque, numa sessão anterior,
-- um push contra esta tabela já teve sucesso ANTES de eu rodar este
-- script — ou seja, ela já existia no Supabase por algum motivo que não
-- investiguei a fundo, e não tenho certeza de que o formato batia
-- exatamente com o daqui. Rodar este script agora garante que todas as
-- colunas esperadas existem, sem apagar nada que já estivesse lá.
--
-- Como rodar: Supabase Dashboard → SQL Editor → colar este arquivo
-- inteiro → Run. É seguro rodar mais de uma vez (idempotente).
-- ─────────────────────────────────────────────────────────────

create table if not exists public.mobile_patrimonio_items (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  desktop_id text not null,   -- ex: 'bem_12', 'inv_7', 'cartao_3', 'divida_2', 'conta_5'
  section    text not null,   -- 'bem' | 'investimento' | 'cartao_divida' | 'conta' (em claro)
  synced_at  timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.mobile_patrimonio_items add column if not exists name             text;  -- cifrado
alter table public.mobile_patrimonio_items add column if not exists subtype          text;  -- cifrado
alter table public.mobile_patrimonio_items add column if not exists category         text;  -- cifrado
alter table public.mobile_patrimonio_items add column if not exists broker           text;  -- cifrado
alter table public.mobile_patrimonio_items add column if not exists maturity_month   text;  -- cifrado
alter table public.mobile_patrimonio_items add column if not exists liquidity        text;  -- cifrado
alter table public.mobile_patrimonio_items add column if not exists benchmark        text;  -- cifrado
alter table public.mobile_patrimonio_items add column if not exists current_value    text;  -- cifrado (centavos)
alter table public.mobile_patrimonio_items add column if not exists debt_balance     text;  -- cifrado (centavos, nullable)
alter table public.mobile_patrimonio_items add column if not exists interest_rate    text;  -- cifrado (% a.a., nullable)
alter table public.mobile_patrimonio_items add column if not exists tir_nominal      text;  -- cifrado (%, nullable)
alter table public.mobile_patrimonio_items add column if not exists tir_real         text;  -- cifrado (%, nullable)
alter table public.mobile_patrimonio_items add column if not exists gain_loss        text;  -- cifrado (centavos, nullable)
alter table public.mobile_patrimonio_items add column if not exists benchmark_return text;  -- cifrado (%, nullable)

create index if not exists mobile_patrimonio_items_user_section_idx
  on public.mobile_patrimonio_items (user_id, section);

alter table public.mobile_patrimonio_items enable row level security;

drop policy if exists "own_rows" on public.mobile_patrimonio_items;
create policy "own_rows" on public.mobile_patrimonio_items
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── Verificação ──
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'mobile_patrimonio_items'
order by ordinal_position;
