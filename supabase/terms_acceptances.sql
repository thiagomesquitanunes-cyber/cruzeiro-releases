-- ─────────────────────────────────────────────────────────────
-- terms_acceptances.sql
-- Registro (comprovante) de aceite dos Termos de Uso — uma linha por
-- vez que um usuário logado aceita uma versão dos Termos no app
-- Desktop (ver checkTermsConsent()/acceptTermsConsent() em
-- renderer.js e o handler 'terms:record-acceptance' em main.js).
--
-- Só é gravado para usuários que já têm sessão Supabase ativa (ou
-- seja, que já fizeram login pra sincronização com o Mobile) — quem
-- usa o Desktop 100% local, sem conta, não tem e-mail nenhum
-- associado, então não há como registrar "quem" aceitou; nesse caso
-- o aceite fica só localmente (settings.termsAcceptedVersion).
--
-- Tabela append-only de propósito: só existem políticas de INSERT e
-- SELECT (nunca UPDATE/DELETE) — nem o próprio usuário consegue
-- alterar ou apagar um registro já gravado pelo cliente autenticado
-- (só o dono do projeto, via Dashboard/service_role, consegue).
--
-- Como rodar: Supabase Dashboard → SQL Editor → colar este arquivo
-- inteiro → Run. É seguro rodar mais de uma vez (idempotente).
-- ─────────────────────────────────────────────────────────────

create table if not exists public.terms_acceptances (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  email        text not null,
  version      text not null,
  accepted_at  timestamptz not null,
  app_version  text,
  platform     text,
  created_at   timestamptz not null default now()
);

alter table public.terms_acceptances enable row level security;

drop policy if exists "insert_own" on public.terms_acceptances;
create policy "insert_own" on public.terms_acceptances
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "select_own" on public.terms_acceptances;
create policy "select_own" on public.terms_acceptances
  for select to authenticated
  using (auth.uid() = user_id);

-- Índice pra consultar rápido "quem aceitou a versão X" no Dashboard.
create index if not exists terms_acceptances_version_idx
  on public.terms_acceptances (version);

-- ── Verificação ──
select tablename, rowsecurity as rls_ativo
from pg_tables
where schemaname = 'public' and tablename = 'terms_acceptances';
