// ─────────────────────────────────────────────────────────────
// sync-push.js
// Publica snapshots do SQLite local → Supabase.
// Chamado pelo main.js ao abrir o app e ao fechar.
//
// Princípios:
//   • Nunca modifica o SQLite local
//   • Falhas silenciosas — sync é best-effort, não bloqueia o app
//   • Valores monetários em centavos (integer) para evitar float
//   • desktop_id = PK original do SQLite (garante idempotência)
//   • Hash por tabela: só envia dados se algo mudou desde o último sync
// ─────────────────────────────────────────────────────────────

const sb     = require('./supabase-client');
const crypto_utils = require('./crypto-utils');

// Helper: cifra um valor se a chave estiver disponível, senão passa em claro.
// Isso garante que o sync funciona mesmo antes de a criptografia ser ativada
// (retrocompatibilidade para usuários antigos que ainda não têm chave).
function enc(value) {
  if (!crypto_utils.isUnlocked()) return value;
  return crypto_utils.encrypt(value);
}

function encJSON(obj) {
  if (!crypto_utils.isUnlocked()) return obj;
  return crypto_utils.encryptJSON(obj);
}
const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

// ─────────────────────────────────────────────────────────────
// Cache de hashes por tabela — persiste em arquivo local para
// sobreviver entre sessões. Cada entrada: { hash, syncedAt }.
// Localizado junto ao banco de dados do usuário.
// ─────────────────────────────────────────────────────────────
let _hashCachePath = null;
let _hashCache     = {};

function initHashCache(dbPath) {
  _hashCachePath = dbPath.replace('.db', '_sync_hashes.json');
  try {
    if (fs.existsSync(_hashCachePath)) {
      _hashCache = JSON.parse(fs.readFileSync(_hashCachePath, 'utf8'));
    }
  } catch (e) {
    _hashCache = {};
  }
}

function saveHashCache() {
  if (!_hashCachePath) return;
  try { fs.writeFileSync(_hashCachePath, JSON.stringify(_hashCache)); } catch (e) {}
}

// Calcula hash MD5 de um conjunto de linhas (rápido, não precisa de segurança)
function hashRows(rows) {
  const str = JSON.stringify(rows);
  return crypto.createHash('md5').update(str).digest('hex');
}

// Retorna true se os dados mudaram desde o último sync desta tabela
function hasChanged(table, rows) {
  const h = hashRows(rows);
  if (_hashCache[table] === h) return false; // sem mudança
  _hashCache[table] = h;
  return true;
}

// Invalida o cache de uma tabela (força re-sync na próxima vez)
function invalidateCache(table) {
  delete _hashCache[table];
}

// Converte reais (float) para centavos (integer)
const toCents = v => Math.round((v || 0) * 100);

// Formata data JS para YYYY-MM-DD
const toDate = d => (d ? new Date(d).toISOString().slice(0, 10) : null);

// Retorna YYYY-MM de N meses atrás
function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 7);
}

// ─────────────────────────────────────────────────────────────
// 1. Saldos por conta
// ─────────────────────────────────────────────────────────────
async function pushBalances(all, userId, syncInvestments) {
  const today    = new Date().toISOString().slice(0, 10);
  let accounts = all('SELECT * FROM accounts WHERE hidden=0 ORDER BY sort_order');

  // Por padrão, contas de investimento não são enviadas ao mobile —
  // segurança: o usuário precisa optar explicitamente por isso.
  if (!syncInvestments) {
    accounts = accounts.filter(a => a.type !== 'investment');
  }

  const rows = accounts.map(acc => {
    const bal = all(
      'SELECT COALESCE(SUM(amount),0) as bal FROM transactions WHERE account_id=? AND date<=?',
      [acc.id, today]
    )[0]?.bal || 0;

    return {
      user_id:      userId,
      account_name: acc.name,
      account_type: acc.type,
      balance:      enc(toCents(bal)),
      currency:     acc.currency || 'BRL',
      is_hidden:    acc.hidden === 1,
      sort_order:   acc.sort_order || 0,
      synced_at:    new Date().toISOString(),
    };
  });

  if (!hasChanged('balances', rows.map(r => ({ ...r, synced_at: undefined })))) {
    console.log('[sync:push] balances sem mudança — pulando');
    return;
  }
  const syncedAt = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAt);

  await sb.upsert('mobile_balances', rows, 'user_id,account_name');

  // Se investimentos estão desativados, o prune precisa considerar
  // que contas de investimento NUNCA devem estar na lista atual.
  const allAccountNames = syncInvestments
    ? accounts.map(a => a.name)
    : all('SELECT name FROM accounts WHERE hidden=0 AND type != ?', ['investment']).map(a => a.name);
  await sb.pruneNotIn('mobile_balances', userId, 'account_name', allAccountNames);
}

// ─────────────────────────────────────────────────────────────
// 2. Transações recentes (últimos 90 dias)
// ─────────────────────────────────────────────────────────────
async function pushTransactions(all, userId, syncInvestments) {
  const from = new Date();
  from.setDate(from.getDate() - 90);
  const fromDate = from.toISOString().slice(0, 10);

  // Por padrão, exclui transações de contas de investimento (mesma regra
  // de pushBalances) — evita vazar extrato de aportes/resgates mesmo que
  // o saldo da conta já não esteja sendo enviado.
  const investmentFilter = syncInvestments ? '' : `AND a.type != 'investment'`;

  const txns = all(`
    SELECT t.*, a.name as account_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.date >= ? AND t.transfer_id IS NULL ${investmentFilter}
    ORDER BY t.date DESC
  `, [fromDate]);

  const rows = txns.map(t => {
    // Separa categoria e subcategoria (formato "Categoria:Subcategoria")
    const [category, subcategory] = (t.category || '').split(':');
    return {
      user_id:       userId,
      desktop_id:    String(t.id),
      date:          t.date,
      description:   enc(t.memo || t.category || ''),
      amount:        enc(toCents(t.amount)),
      category:      category || null,
      subcategory:   subcategory || null,
      account_name:  t.account_name,
      memo:          enc(t.memo || null),
      is_reconciled: t.cleared === 1,
      synced_at:     new Date().toISOString(),
    };
  });

  if (!hasChanged('transactions', rows.map(r => ({ ...r, synced_at: undefined })))) {
    console.log('[sync:push] transactions sem mudança — pulando');
    return;
  }
  const syncedAt = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAt);

  // Upsert em lotes de 500 para não estourar limites HTTP
  for (let i = 0; i < rows.length; i += 500) {
    await sb.upsert('mobile_transactions', rows.slice(i, i + 500), 'user_id,desktop_id');
  }

  // Remove transações antigas que saíram da janela de 90 dias
  await sb.pruneNotIn('mobile_transactions', userId, 'desktop_id', rows.map(r => r.desktop_id))
    .catch(() => {});
}

// ─────────────────────────────────────────────────────────────
// 3. Orçamentos do mês atual
// ─────────────────────────────────────────────────────────────
async function pushBudgets(all, userId) {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const from  = `${month}-01`;
  const to    = `${month}-31`;

  const budgets = all('SELECT * FROM budgets WHERE active=1');
  const actuals = all(`
    SELECT category, SUM(ABS(amount)) as spent
    FROM transactions
    WHERE date>=? AND date<=? AND amount<0 AND transfer_id IS NULL
    GROUP BY category
  `, [from, to]);

  const spentByCategory = {};
  actuals.forEach(r => { spentByCategory[r.category] = r.spent; });

  const rows = budgets.map(b => ({
    user_id:       userId,
    month,
    category:      b.category,
    monthly_limit: enc(toCents(b.monthly_limit)),
    spent:         enc(toCents(spentByCategory[b.category] || 0)),
    alert_pct:     b.alert_pct || 80,
    synced_at:     new Date().toISOString(),
  }));

  if (!hasChanged('budgets', rows.map(r => ({ ...r, synced_at: undefined })))) {
    console.log('[sync:push] budgets sem mudança — pulando');
    return;
  }
  const syncedAtB = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAtB);
  await sb.upsert('mobile_budgets', rows, 'user_id,month,category');
  await sb.pruneNotIn('mobile_budgets', userId, 'category', budgets.map(b => b.category))
    .catch(() => {});
}

// ─────────────────────────────────────────────────────────────
// 4. Metas com progresso calculado
// ─────────────────────────────────────────────────────────────
async function pushGoals(all, userId) {
  const goals = all('SELECT * FROM goals WHERE active=1');

  // Média de despesas mensais (últimos 3 meses) — para metas de emergência
  const avgExpenses = (() => {
    const rows = all(`
      SELECT SUM(ABS(amount)) as total
      FROM transactions
      WHERE amount<0 AND transfer_id IS NULL
        AND date >= date('now','-3 months')
    `);
    return rows[0]?.total / 3 || 0;
  })();

  const rows = goals.map(g => {
    let currentAmount = 0;
    let progressPct   = 0;

    if (g.account_id) {
      currentAmount = all(
        'SELECT COALESCE(SUM(amount),0) as bal FROM transactions WHERE account_id=?',
        [g.account_id]
      )[0]?.bal || 0;
    }

    if (g.type === 'target' && g.target_amount) {
      progressPct = Math.min(100, (currentAmount / g.target_amount) * 100);
    } else if (g.type === 'emergency' && g.emergency_months) {
      const target = avgExpenses * g.emergency_months;
      progressPct  = target > 0 ? Math.min(100, (currentAmount / target) * 100) : 0;
    } else if (g.type === 'monthly' && g.monthly_amount) {
      // Progresso do mês atual
      const month  = new Date().toISOString().slice(0, 7);
      const saved  = all(`
        SELECT COALESCE(SUM(amount),0) as s
        FROM transactions
        WHERE account_id=? AND substr(date,1,7)=? AND amount>0
      `, [g.account_id, month])[0]?.s || 0;
      progressPct = Math.min(100, (saved / g.monthly_amount) * 100);
      currentAmount = saved;
    }

    return {
      user_id:        userId,
      desktop_id:     String(g.id),
      name:           g.name,
      type:           g.type,
      icon:           g.icon || '🎯',
      color:          g.color || '#2563eb',
      target_amount:  g.target_amount  ? enc(toCents(g.target_amount))  : null,
      monthly_amount: g.monthly_amount ? enc(toCents(g.monthly_amount)) : null,
      emergency_months: g.emergency_months || null,
      deadline:       g.deadline || null,
      current_amount: enc(toCents(currentAmount)),
      progress_pct:   Math.round(progressPct * 100) / 100,
      active:         g.active === 1,
      synced_at:      new Date().toISOString(),
    };
  });

  if (!hasChanged('goals', rows.map(r => ({ ...r, synced_at: undefined })))) {
    console.log('[sync:push] goals sem mudança — pulando');
    return;
  }
  const syncedAtG = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAtG);
  await sb.upsert('mobile_goals', rows, 'user_id,desktop_id');
  await sb.pruneNotIn('mobile_goals', userId, 'desktop_id', goals.map(g => String(g.id)));
}

// ─────────────────────────────────────────────────────────────
// 5. Lançamentos recorrentes / futuros
// ─────────────────────────────────────────────────────────────
async function pushScheduled(all, userId) {
  const recurring = all('SELECT * FROM recurring WHERE active=1');
  const accounts  = all('SELECT id, name FROM accounts');
  const accMap    = Object.fromEntries(accounts.map(a => [a.id, a.name]));

  const rows = recurring.map(r => ({
    user_id:      userId,
    desktop_id:   String(r.id),
    next_date:    r.next_date,
    memo:         enc(r.memo || ''),
    amount:       enc(toCents(r.amount)),
    category:     r.category || null,
    account_name: accMap[r.account_id] || null,
    frequency:    r.frequency,
    end_date:     r.end_date || null,
    synced_at:    new Date().toISOString(),
  }));

  if (!hasChanged('scheduled', rows.map(r => ({ ...r, synced_at: undefined })))) {
    console.log('[sync:push] scheduled sem mudança — pulando');
    return;
  }
  const syncedAtS = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAtS);
  await sb.upsert('mobile_scheduled', rows, 'user_id,desktop_id');
  await sb.pruneNotIn('mobile_scheduled', userId, 'desktop_id', recurring.map(r => String(r.id)));
}

// ─────────────────────────────────────────────────────────────
// 6. Patrimônio (últimos 3 meses)
// Só sincroniza se o usuário optou por compartilhar dados de
// investimento com o mobile — patrimônio é fundamentalmente
// sobre ativos/investimentos, então segue a mesma regra.
// ─────────────────────────────────────────────────────────────
async function pushPatrimonio(all, userId, syncInvestments) {
  if (!syncInvestments) return;

  const months = [];
  for (let i = 0; i < 3; i++) months.push(monthsAgo(i));

  const patAssets = all('SELECT * FROM pat_assets WHERE hidden=0 AND sold_month IS NULL');

  const rows = months.map(month => {
    // Valor de cada ativo no mês (último registro de pat_history até o mês)
    const breakdown = {};
    let totalAssets = 0;

    patAssets.forEach(asset => {
      const hist = all(`
        SELECT value FROM pat_history
        WHERE asset_id=? AND month<=?
        ORDER BY month DESC LIMIT 1
      `, [asset.id, month]);
      const value = hist[0]?.value || 0;
      const type  = asset.asset_type || 'outros';
      breakdown[type] = (breakdown[type] || 0) + value;
      totalAssets += value;
    });

    // Dívidas de financiamentos ativos — saldo devedor da última parcela não paga
    const debts = all(`
      SELECT COALESCE(SUM(pf.balance_end),0) as total
      FROM pat_financing pf
      JOIN pat_financing_contracts pfc ON pfc.id = pf.contract_id
      WHERE pfc.status='active'
        AND pf.paid=0
        AND pf.is_projection=0
    `);
    const totalDebts = debts[0]?.total || 0;

    // Converte breakdown para centavos
    const breakdownCents = {};
    Object.entries(breakdown).forEach(([k, v]) => {
      breakdownCents[k] = toCents(v);
    });

    return {
      user_id:      userId,
      month,
      total_assets: enc(toCents(totalAssets)),
      total_debts:  enc(toCents(totalDebts)),
      net_worth:    enc(toCents(totalAssets - totalDebts)),
      breakdown:    encJSON(breakdownCents),
      synced_at:    new Date().toISOString(),
    };
  });

  if (!hasChanged('patrimonio', rows.map(r => ({ ...r, synced_at: undefined })))) {
    console.log('[sync:push] patrimonio sem mudança — pulando');
    return;
  }
  const syncedAtP = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAtP);
  await sb.upsert('mobile_patrimonio', rows, 'user_id,month');
}

// ─────────────────────────────────────────────────────────────
// 7. Evolução mensal (últimos 6 meses)
// ─────────────────────────────────────────────────────────────
async function pushEvolution(all, userId, getDbPath, fs) {
  // Janela: últimos 6 meses SEM teto de data — o desktop não limita datas
  // futuras (lançamentos confirmados com data à frente aparecem normalmente).
  const from = monthsAgo(6) + '-01';

  // Lê a configuração real de filtros do usuário (mesmo arquivo que
  // a tela de Evolução do desktop usa via overview-config:get).
  let excludedCats = [];
  if (typeof getDbPath === 'function' && fs && typeof fs.existsSync === 'function') {
    try {
      const cfgPath = getDbPath().replace('.db', '_overview_config.json');
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        excludedCats = cfg?.excludedCats || [];
      }
    } catch (e) {
      console.error('[sync:push:evolution] erro ao ler overview_config:', e.message);
    }
  }

  const excPlaceholders = excludedCats.length
    ? ` AND category NOT IN (${excludedCats.map(() => '?').join(',')})`
    : '';

  const baseWhere = `
    date >= ?
    AND transfer_id IS NULL
    AND category IS NOT NULL AND category != ''
    AND category NOT IN ('Transferência','Transferências','Transferencia','Transferencias')
    ${excPlaceholders}
  `;
  const baseParams = [from, ...excludedCats];

  const monthly = all(`
    SELECT substr(date,1,7) as month,
      SUM(CASE WHEN amount>0 THEN amount ELSE 0 END)      as income,
      SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as expenses
    FROM transactions
    WHERE ${baseWhere}
    GROUP BY month ORDER BY month
  `, baseParams);

  const byCategory = all(`
    SELECT substr(date,1,7) as month, category,
      SUM(ABS(amount)) as total
    FROM transactions
    WHERE ${baseWhere} AND amount < 0
    GROUP BY month, category
  `, baseParams);

  const catByMonth = {};
  byCategory.forEach(r => {
    if (!catByMonth[r.month]) catByMonth[r.month] = {};
    catByMonth[r.month][r.category] = toCents(r.total);
  });

  const rows = monthly.map(r => ({
    user_id:     userId,
    month:       r.month,
    income:      enc(toCents(r.income)),
    expenses:    enc(toCents(r.expenses)),
    balance:     enc(toCents(r.income - r.expenses)),
    by_category: encJSON(catByMonth[r.month] || {}),
    synced_at:   new Date().toISOString(),
  }));

  if (!hasChanged('evolution', rows.map(r => ({ ...r, synced_at: undefined })))) {
    console.log('[sync:push] evolution sem mudança — pulando');
    return;
  }
  // Apaga TUDO e reinsere do zero — garante que dados com filtros
  // incorretos de versões anteriores não sobrevivam no Supabase.
  const syncedAtE = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAtE);
  await sb.remove('mobile_evolution', { user_id: userId });
  if (rows.length) {
    await sb.upsert('mobile_evolution', rows, 'user_id,month');
  }

  console.log(`[sync:push:evolution] ${rows.length} meses sincronizados (${from} em diante)`);
}


// ─────────────────────────────────────────────────────────────
// 8. Regras de ML
// ─────────────────────────────────────────────────────────────
async function pushMlRules(all, userId) {
  const rules = all('SELECT * FROM ml_rules');

  const rows = rules.map(r => ({
    user_id:   userId,
    keyword:   r.keyword,
    memo:      r.memo || '',
    category:  r.category || '',
    count:     r.count || 1,
    sum_val:   r.sum_val || null,
    n_val:     r.n_val || null,
    min_val:   r.min_val || null,
    max_val:   r.max_val || null,
    source:    'desktop',
    synced_at: new Date().toISOString(),
  }));

  if (!hasChanged('ml_rules', rows.map(r => ({ ...r, synced_at: undefined })))) {
    console.log('[sync:push] ml_rules sem mudança — pulando');
    return;
  }
  const syncedAtML = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAtML);
  await sb.upsert('ml_rules', rows, 'user_id,keyword');
}

// ─────────────────────────────────────────────────────────────
// 9. Configuração de IA (provider + chave)
// Sincroniza a chave que o usuário já colou no desktop,
// para o mobile não precisar pedir de novo (importante pois
// o OpenRouter só mostra a chave uma única vez ao gerar).
// ─────────────────────────────────────────────────────────────
async function pushAiConfig(getAiConfig, userId) {
  const { provider, key } = getAiConfig();
  if (!key) {
    console.log('[sync:ai_config] nenhuma chave configurada no desktop — nada a sincronizar');
    return;
  }

  console.log(`[sync:ai_config] enviando chave: provider=${provider}, tamanho=${key.length} caracteres, início="${key.slice(0,6)}", fim="${key.slice(-4)}"`);

  await sb.upsert('user_ai_config', [{
    user_id:   userId,
    provider:  provider || 'openrouter',
    api_key:   key,
    synced_at: new Date().toISOString(),
  }], 'user_id');

  console.log('[sync:ai_config] upsert concluído');
}

// ─────────────────────────────────────────────────────────────
// ENTRY POINT — executa todos os pushes em sequência
// Falhas individuais são logadas mas não interrompem o processo
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// ENTRY POINT — executa todos os pushes em sequência
// Falhas individuais são logadas mas não interrompem o processo
// ─────────────────────────────────────────────────────────────
async function pushAll(all, userId, getAiConfig, getSyncInvestmentsPref, getDbPath, fs) {
  const syncInvestments = typeof getSyncInvestmentsPref === 'function' ? getSyncInvestmentsPref() : false;

  // Inicializa cache de hashes (persiste entre sessões para evitar re-envio
  // de dados que não mudaram — reduz drasticamente o Egress do Supabase).
  if (typeof getDbPath === 'function') {
    initHashCache(getDbPath());
  }

  const steps = [
    ['balances',     () => pushBalances(all, userId, syncInvestments)],
    ['transactions', () => pushTransactions(all, userId, syncInvestments)],
    ['budgets',      () => pushBudgets(all, userId)],
    ['goals',        () => pushGoals(all, userId)],
    ['scheduled',    () => pushScheduled(all, userId)],
    ['patrimonio',   () => pushPatrimonio(all, userId, syncInvestments)],
    ['evolution',    () => pushEvolution(all, userId, getDbPath, fs)],
    ['ml_rules',     () => pushMlRules(all, userId)],
  ];

  if (typeof getAiConfig === 'function') {
    steps.push(['ai_config', () => pushAiConfig(getAiConfig, userId)]);
  }

  const results = {};
  for (const [name, fn] of steps) {
    try {
      await fn();
      results[name] = 'ok';
    } catch (e) {
      console.error(`[sync:push] ${name} falhou:`, e.message);
      results[name] = `erro: ${e.message}`;
    }
  }

  // Persiste hashes para a próxima sessão
  saveHashCache();

  console.log('[sync:push] concluído:', results);
  return results;
}

// Permite que main.js invalide tabelas específicas do cache
// (ex: quando o filtro de investimentos muda)
function invalidateCacheTables(tables) {
  tables.forEach(t => invalidateCache(t));
  saveHashCache();
}

module.exports = { pushAll, invalidateCacheTables };
