-- ─────────────────────────────────────────────────────────────
-- patrimonio_items.sql
-- Itens detalhados de patrimônio pro mobile (aba "Patrimônio") — um
-- upgrade de mobile_patrimonio (que só tinha totais agregados por mês).
-- Cada linha é UM item: um bem, um investimento, um cartão/dívida ou
-- uma conta bancária. user_id + desktop_id identifica a linha (upsert
-- por sb.upsert('mobile_patrimonio_items', rows, 'user_id,desktop_id')
-- em sync-push.js), com prune das linhas removidas/ocultadas no desktop.
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
-- Como rodar: Supabase Dashboard → SQL Editor → colar este arquivo
-- inteiro → Run. É seguro rodar mais de uma vez (idempotente).
-- ─────────────────────────────────────────────────────────────

create table if not exists public.mobile_patrimonio_items (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  desktop_id       text not null,   -- ex: 'bem_12', 'inv_7', 'cartao_3', 'divida_2', 'conta_5'
  section          text not null,   -- 'bem' | 'investimento' | 'cartao_divida' | 'conta' (em claro)

  name             text,  -- cifrado
  subtype          text,  -- cifrado (asset_type / inv_type / tipo de conta)
  category         text,  -- cifrado (categoria do investimento)
  broker           text,  -- cifrado (corretora)
  maturity_month   text,  -- cifrado (vencimento)
  liquidity        text,  -- cifrado
  benchmark        text,  -- cifrado

  current_value    text,  -- cifrado (centavos) — "posição atual"
  debt_balance     text,  -- cifrado (centavos, nullable) — saldo devedor
  interest_rate    text,  -- cifrado (% a.a., nullable) — taxa de juros do financiamento
  tir_nominal      text,  -- cifrado (%, nullable)
  tir_real         text,  -- cifrado (%, nullable)
  gain_loss        text,  -- cifrado (centavos, nullable) — ganho/perda
  benchmark_return text,  -- cifrado (%, nullable) — comparação com benchmark

  synced_at        timestamptz not null,
  created_at       timestamptz not null default now(),

  unique (user_id, desktop_id)
);

create index if not exists mobile_patrimonio_items_user_section_idx
  on public.mobile_patrimonio_items (user_id, section);

alter table public.mobile_patrimonio_items enable row level security;

drop policy if exists "own_rows" on public.mobile_patrimonio_items;
create policy "own_rows" on public.mobile_patrimonio_items
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── Verificação ──
select tablename, rowsecurity as rls_ativo
from pg_tables
where schemaname = 'public' and tablename = 'mobile_patrimonio_items';
