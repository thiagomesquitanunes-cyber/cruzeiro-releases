-- ─────────────────────────────────────────────────────────────
-- enable_rls.sql
-- Habilita Row Level Security em todas as tabelas de sync
-- (mobile_*, quick_entries, ml_rules, user_ai_config, etc.) e
-- cria uma política única por tabela: cada usuário só enxerga/
-- altera suas PRÓPRIAS linhas (auth.uid() = user_id).
--
-- Por quê: o desktop usava a service_role key (acesso admin total,
-- ignora RLS) hardcoded no código-fonte para TODAS as chamadas REST.
-- Como o app é distribuído (Electron/instalador), esse código é
-- extraível — qualquer pessoa com o instalador conseguiria pegar
-- essa chave e ler/editar os dados de QUALQUER usuário no Supabase.
--
-- A correção troca a service_role pela chave anon + o token de
-- sessão do próprio usuário logado (igual ao que o app mobile já
-- faz). Isso só é seguro se RLS estiver ativo — sem RLS, a chave
-- anon sozinha também daria acesso a tudo, bastaria omitir o filtro
-- user_id na consulta.
--
-- Como rodar: Supabase Dashboard → SQL Editor → colar este arquivo
-- inteiro → Run. É seguro rodar mais de uma vez (idempotente).
-- ─────────────────────────────────────────────────────────────

do $$
declare
  tbl text;
  tables text[] := array[
    'mobile_balances',
    'mobile_transactions',
    'mobile_budgets',
    'mobile_goals',
    'mobile_scheduled',
    'mobile_patrimonio',
    'mobile_evolution',
    'ml_rules',
    'user_ai_config',
    'quick_entries',
    'mobile_reconcile_updates',
    'mobile_edit_requests'
  ];
begin
  foreach tbl in array tables loop
    if to_regclass('public.' || tbl) is not null then
      execute format('alter table public.%I enable row level security', tbl);
      execute format('drop policy if exists "own_rows" on public.%I', tbl);
      execute format(
        'create policy "own_rows" on public.%I for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)',
        tbl
      );
      raise notice 'RLS ativado em: %', tbl;
    else
      raise notice 'Tabela % não existe — pulando', tbl;
    end if;
  end loop;
end $$;

-- ── Verificação: confirma que RLS está ativo em todas as tabelas ──
select tablename, rowsecurity as rls_ativo
from pg_tables
where schemaname = 'public'
  and tablename in (
    'mobile_balances', 'mobile_transactions', 'mobile_budgets', 'mobile_goals',
    'mobile_scheduled', 'mobile_patrimonio', 'mobile_evolution', 'ml_rules',
    'user_ai_config', 'quick_entries', 'mobile_reconcile_updates', 'mobile_edit_requests'
  )
order by tablename;
