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

// Cifra os campos sensíveis das linhas DEPOIS da checagem de mudança.
// Motivo: encrypt() usa um nonce ALEATÓRIO a cada chamada, então cifrar o mesmo
// dado duas vezes gera bytes totalmente diferentes. Enquanto o hash de mudança
// era calculado sobre as linhas JÁ cifradas, hasChanged() dava "mudou" em TODA
// sincronização (mesmo sem nenhuma alteração real) — o que (a) reenviava tudo ao
// Supabase sempre e (b) reescrevia o arquivo de hashes a cada sync, fazendo o
// Dropbox re-sincronizá-lo sem parar e divergir entre máquinas. Cifrando só
// depois do hash (que agora é calculado sobre o texto em claro), o hash fica
// estável entre execuções e IDÊNTICO entre máquinas com os mesmos dados.
// Campos null/undefined são preservados como estão (não são cifrados).
function encFields(rows, scalarFields, jsonFields) {
  for (const r of rows) {
    (scalarFields || []).forEach(f => { if (r[f] !== null && r[f] !== undefined) r[f] = enc(r[f]); });
    (jsonFields   || []).forEach(f => { if (r[f] !== null && r[f] !== undefined) r[f] = encJSON(r[f]); });
  }
  return rows;
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

// userId é opcional (retrocompatibilidade com chamadores antigos) — quando
// informado, protege contra o seguinte cenário real: o usuário troca a
// "Pasta de dados" (ou o usuário local) e sincroniza um banco diferente
// (ex: um usuário de teste/fake) com a MESMA conta Supabase por engano, e
// depois volta pro banco/usuário certo. Como o cache de hash é só "os dados
// LOCAIS mudaram desde o último push?", sem saber pra QUAL conta Supabase
// aquele push foi feito, ele não percebia que o Supabase estava com os
// dados errados (do banco de teste) — os dados locais corretos não tinham
// mudado desde o ÚLTIMO push bem-sucedido deles mesmos, então o hash batia
// e o push seguinte era pulado inteiro, deixando os dados errados intactos
// na nuvem. Guardando o userId junto com o hash: se o próximo push for pra
// uma conta DIFERENTE da última vez que este arquivo de cache foi escrito,
// o cache inteiro é descartado — força reenvio completo, que já sobrescreve
// (upsert) e limpa (pruneNotIn) qualquer resquício da sincronização errada.
function initHashCache(dbPath, userId) {
  _hashCachePath = dbPath.replace('.db', '_sync_hashes.json');
  try {
    if (fs.existsSync(_hashCachePath)) {
      _hashCache = JSON.parse(fs.readFileSync(_hashCachePath, 'utf8'));
    } else {
      _hashCache = {};
    }
  } catch (e) {
    _hashCache = {};
  }
  // "!== userId" (não só a checagem de mismatch) cobre também caches
  // antigos, de antes desta correção existir, que nunca guardaram
  // __userId — sem essa cobertura, um cache pré-existente "contaminado"
  // (como o do usuário que gerou este fix) nunca seria invalidado
  // automaticamente, exigindo apagar o arquivo manualmente.
  if (userId && _hashCache.__userId !== userId) {
    console.log('[sync:push] conta Supabase mudou (ou cache antigo sem identidade registrada) — forçando reenvio completo');
    _hashCache = {};
  }
  if (userId) _hashCache.__userId = userId;
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
      balance:      toCents(bal),
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
  encFields(rows, ['balance']);

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
  const today = new Date().toISOString().slice(0, 10);

  // Por padrão, exclui transações de contas de investimento (mesma regra
  // de pushBalances) — evita vazar extrato de aportes/resgates mesmo que
  // o saldo da conta já não esteja sendo enviado.
  const investmentFilter = syncInvestments ? '' : `AND a.type != 'investment'`;

  // Inclui transferências (t.transfer_id pode ser não-nulo) — precisam
  // aparecer no extrato de cada conta no mobile (são movimentações reais
  // da conta), só não entram nos cálculos de receita/despesa/lucro nem na
  // aba Evolução (isso é filtrado à parte, em pushEvolution). O campo
  // is_transfer deixa o mobile identificar e excluir essas linhas de
  // qualquer soma que fizer.
  // t.date <= hoje é essencial: sem esse limite, lançamentos futuros
  // (recorrências já materializadas, juros de mútuo projetados etc.)
  // vazavam pra cá também — futuros só devem aparecer via pushScheduled
  // (mobile_scheduled), na aba "lançamentos futuros" do mobile.
  const txns = all(`
    SELECT t.*, a.name as account_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.date >= ? AND t.date <= ? ${investmentFilter}
    ORDER BY t.date DESC
  `, [fromDate, today]);

  const rows = txns.map(t => {
    // Separa categoria e subcategoria (formato "Categoria:Subcategoria")
    const [category, subcategory] = (t.category || '').split(':');
    return {
      user_id:       userId,
      desktop_id:    String(t.id),
      date:          t.date,
      description:   t.memo || t.category || '',
      amount:        toCents(t.amount),
      category:      category || null,
      subcategory:   subcategory || null,
      account_name:  t.account_name,
      memo:          t.memo || null,
      is_transfer:   t.transfer_id !== null,
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
  encFields(rows, ['description', 'amount', 'memo']);

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
  // Realizado por categoria: despesa E estorno, já excluindo transferências
  // (reais e categorizadas manualmente). Antes só somava despesas com match
  // exato da categoria e incluía transferências — o "gasto" no mobile não batia
  // com o do desktop quando havia subcategorias, estornos ou transferências.
  const actuals = all(`
    SELECT category,
      SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as spent,
      SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) as received
    FROM transactions
    WHERE date>=? AND date<=? AND transfer_id IS NULL
      AND (category IS NULL OR LOWER(category) NOT LIKE '%transfer%')
    GROUP BY category
  `, [from, to]);

  // Gasto/recebido líquido por orçamento, somando subcategorias (quando
  // consolidate_subs) e descontando estornos — mesma regra da aba
  // Orçamento do desktop (actualFor em renderer.js). CRÍTICO: type-aware,
  // igual ao desktop — para orçamento de DESPESA, líquido é
  // gasto-recebido; para RECEITA, é recebido-gasto. Antes sempre
  // calculava Math.max(0, spent-received) independente do tipo, o que
  // pra uma categoria de receita (spent baixo, received alto) sempre
  // dava zero (Math.max de um número bem negativo) — "Salário"/"Renda
  // Financeira" apareciam com 0% realizado no mobile.
  const spentForBudget = (b) => {
    const consolidate = b.consolidate_subs !== 0;
    let spent = 0, received = 0;
    actuals.forEach(r => {
      const c = r.category || '';
      if (c === b.category || (consolidate && c.startsWith(b.category + ':'))) {
        spent += r.spent || 0; received += r.received || 0;
      }
    });
    return b.type === 'income' ? Math.max(0, received - spent) : Math.max(0, spent - received);
  };

  const rows = budgets.map(b => ({
    user_id:       userId,
    month,
    category:      b.category,
    // budget_type: sem isso, o mobile não tinha como distinguir orçamento
    // de receita vs despesa — tratava TODOS como despesa, o que inflava o
    // "total planejado" (somava receita+despesa juntos) e escondia a
    // seção de receitas por completo (o filtro budget_type==='income'
    // nunca batia, já que o campo nunca chegava).
    budget_type:   b.type || 'expense',
    monthly_limit: toCents(b.monthly_limit),
    spent:         toCents(spentForBudget(b)),
    alert_pct:     b.alert_pct || 80,
    synced_at:     new Date().toISOString(),
  }));

  if (!hasChanged('budgets', rows.map(r => ({ ...r, synced_at: undefined })))) {
    console.log('[sync:push] budgets sem mudança — pulando');
    return;
  }
  const syncedAtB = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAtB);
  encFields(rows, ['monthly_limit', 'spent']);
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
        AND (category IS NULL OR LOWER(category) NOT LIKE '%transfer%')
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
    } else if (g.type === 'retirement') {
      // Meta automática de Aposentadoria: target_amount (longo prazo,
      // patrimônio) e monthly_amount (curto prazo, poupança mensal
      // necessária) já vêm prontos de syncRetirementGoal. Os valores
      // "atuais" (patrimônio hoje, poupança realizada) são CALCULADOS
      // AO VIVO no mobile a partir de mobile_patrimonio e mobile_evolution
      // — igual ao próprio desktop, que também não persiste esses valores
      // (eles mudam a cada sync e dependem de dados de outras telas).
      // current_amount/progress_pct ficam null aqui de propósito.
      currentAmount = null;
      progressPct   = null;
    }

    return {
      user_id:        userId,
      desktop_id:     String(g.id),
      name:           g.name,
      type:           g.type,
      icon:           g.icon || '🎯',
      color:          g.color || '#2563eb',
      target_amount:  g.target_amount  ? toCents(g.target_amount)  : null,
      monthly_amount: g.monthly_amount ? toCents(g.monthly_amount) : null,
      emergency_months: g.emergency_months || null,
      deadline:       g.deadline || null,
      current_amount: currentAmount === null ? null : toCents(currentAmount),
      progress_pct:   progressPct === null ? null : Math.round(progressPct * 100) / 100,
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
  encFields(rows, ['target_amount', 'monthly_amount', 'current_amount']);
  await sb.upsert('mobile_goals', rows, 'user_id,desktop_id');
  await sb.pruneNotIn('mobile_goals', userId, 'desktop_id', goals.map(g => String(g.id)));
}

// ─────────────────────────────────────────────────────────────
// 5. Lançamentos futuros (transações com data > hoje, até 60 dias à frente)
//
// Antes só sincronizava a tabela `recurring` (definições abstratas de
// recorrência), o que deixava de fora lançamentos futuros digitados
// manualmente (sem vínculo com recorrência) e pernas de financiamento
// projetadas. A tabela `transactions` já contém TODAS as instâncias
// futuras reais — a recorrência já materializa suas ocorrências lá,
// igual ao handler report:future-pending do desktop — então usar a
// mesma fonte garante paridade total com o que a aba "Contas" mostra
// como futuro.
//
// LIMITE DE 60 DIAS: a materialização de parcelas de financiamento/
// mútuo cria uma linha de `transactions` por mês do CONTRATO INTEIRO
// (ex: um financiamento de 30 anos gera ~360 linhas futuras reais na
// tabela). Sem limite superior de data, TODAS essas linhas eram
// enviadas pro Supabase a cada sync — a maior fonte identificada de
// egress desnecessário do app (o mobile só precisa mostrar um
// horizonte curto de "o que vem por aí", não o cronograma completo de
// décadas). 60 dias é mais que suficiente pro caso de uso mobile.
// ─────────────────────────────────────────────────────────────
async function pushScheduled(all, userId, syncInvestments) {
  const today   = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const investmentFilter = syncInvestments ? '' : `AND a.type != 'investment'`;

  const txns = all(`
    SELECT t.*, a.name as account_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.date > ? AND t.date <= ? ${investmentFilter}
    ORDER BY t.date ASC
  `, [today, horizon]);

  const rows = txns.map(t => ({
    user_id:      userId,
    desktop_id:   String(t.id),
    next_date:    t.date,
    memo:         t.memo || t.category || '',
    amount:       toCents(t.amount),
    category:     t.category || null,
    account_name: t.account_name,
    is_transfer:  t.transfer_id !== null,
    synced_at:    new Date().toISOString(),
  }));

  if (!hasChanged('scheduled', rows.map(r => ({ ...r, synced_at: undefined })))) {
    console.log('[sync:push] scheduled sem mudança — pulando');
    return;
  }
  const syncedAtS = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAtS);
  encFields(rows, ['memo', 'amount']);
  await sb.upsert('mobile_scheduled', rows, 'user_id,desktop_id');
  await sb.pruneNotIn('mobile_scheduled', userId, 'desktop_id', rows.map(r => r.desktop_id));
}

// ─────────────────────────────────────────────────────────────
// 6. Patrimônio (últimos 3 meses)
// Só sincroniza se o usuário optou por compartilhar dados de
// investimento com o mobile — patrimônio é fundamentalmente
// sobre ativos/investimentos, então segue a mesma regra.
// ─────────────────────────────────────────────────────────────
async function pushPatrimonio(all, userId, syncInvestments) {
  if (!syncInvestments) {
    // Não basta pular o push: se o usuário JÁ tinha sincronizado
    // patrimônio antes e depois desativou a opção, os dados antigos
    // ficariam parados no Supabase para sempre (vazando pra meta de
    // aposentadoria de longo prazo no mobile, que não deveria nem
    // aparecer nesse caso). hasChanged() evita repetir esse DELETE em
    // todo sync — só dispara na primeira vez que o estado vira "off".
    if (hasChanged('patrimonio', ['sync_disabled'])) {
      await sb.remove('mobile_patrimonio', { user_id: userId }).catch(() => {});
      console.log('[sync:push] patrimonio: sync de investimentos desativado — dados remotos removidos');
    }
    return;
  }

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
      total_assets: toCents(totalAssets),
      total_debts:  toCents(totalDebts),
      net_worth:    toCents(totalAssets - totalDebts),
      breakdown:    breakdownCents,
      synced_at:    new Date().toISOString(),
    };
  });

  if (!hasChanged('patrimonio', rows.map(r => ({ ...r, synced_at: undefined })))) {
    console.log('[sync:push] patrimonio sem mudança — pulando');
    return;
  }
  const syncedAtP = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAtP);
  encFields(rows, ['total_assets', 'total_debts', 'net_worth'], ['breakdown']);
  await sb.upsert('mobile_patrimonio', rows, 'user_id,month');
}

// ─────────────────────────────────────────────────────────────
// 7. Evolução mensal (últimos 12 meses)
// ─────────────────────────────────────────────────────────────
async function pushEvolution(all, userId, getDbPath, fs) {
  // ─────────────────────────────────────────────────────────────
  // FIDELIDADE COM O RESUMO/EVOLUÇÃO DO DESKTOP
  //
  // O mobile não tem dados/configuração suficientes para recalcular a
  // Evolução por conta própria, então o sync precisa aplicar aqui
  // EXATAMENTE a mesma lógica usada por groupAndClassifyByParent() /
  // computeSummaryFromByCat() no renderer — a função ÚNICA que o Resumo,
  // a Comparação mensal E a Evolução do desktop usam para chegar no
  // mesmo número de receitas/despesas:
  //   1. Query por mês+SUBcategoria (evolucao:monthly-by-category no
  //      desktop) — já exclui transferências (transfer_id + texto).
  //   2. Aplica ev_catConfig por SUBCATEGORIA (exclusão manual) ANTES
  //      do agrupamento pela mãe.
  //   3. Agrupa por categoria-MÃE somando os valores BRUTOS de todas as
  //      subcategorias — e SÓ ENTÃO classifica pelo saldo líquido do
  //      grupo. Uma subcategoria positiva dentro de uma categoria-mãe
  //      negativa funciona como "redutora de despesa" da mãe, em vez de
  //      contar como receita separada. SEM esse agrupamento por mãe
  //      (bug anterior: classificava por subcategoria direto), o total
  //      de receitas e despesas no mobile inflava em relação ao
  //      desktop — cada subcategoria virava um grupo próprio em vez de
  //      se cancelar dentro da mãe.
  //   4. Sem correção de IPCA — o mobile mostra valores NOMINAIS (sem
  //      correção pela inflação), com um aviso na tela explicando isso,
  //      em vez de replicar a lógica de correção do desktop (mais
  //      simples e reduz processamento/egress).
  //   5. Média móvel de 12 meses SEMPRE calculada (income_ma/
  //      expenses_ma) — independente do toggle "ev_ma" do desktop, que
  //      é só uma preferência de EXIBIÇÃO da aba Evolução lá. Esses
  //      campos alimentam funcionalidades do mobile (ex: progresso de
  //      curto prazo da meta de aposentadoria) que precisam sempre de
  //      uma média real, não de uma cópia condicional dos valores
  //      nominais.
  //   6. Sincroniza só os ÚLTIMOS 12 MESES (reduz storage/egress no
  //      Supabase) — a média móvel usa o histórico completo
  //      internamente ANTES desse corte, para não ficar incompleta nos
  //      meses do início da janela enviada.
  // ─────────────────────────────────────────────────────────────

  let cfg = {};
  if (typeof getDbPath === 'function' && fs && typeof fs.existsSync === 'function') {
    try {
      const cfgPath = getDbPath().replace('.db', '_overview_config.json');
      if (fs.existsSync(cfgPath)) cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) || {};
    } catch (e) {
      console.error('[sync:push:evolution] erro ao ler overview_config:', e.message);
    }
  }

  const catConfig = cfg.ev_catConfig || [];

  // ── 1. Query por mês+SUBcategoria — idêntica ao desktop ──
  // AND date <= date('now') de propósito: sem esse limite, meses FUTUROS
  // (recorrências materializadas até ~5 anos à frente, ex: mesada com
  // fim em 2028) entravam no array `months` — e como o mobile
  // (metas.js) escolhe o "mês atual" pegando a linha de maior `month`
  // já sincronizada (order by month desc limit 1), acabava pegando um
  // mês bem no futuro (pouquíssimos lançamentos projetados) em vez do
  // mês corrente de verdade — dando uma MA12 completamente diferente
  // da que o desktop mostra (computeEvMA12LucroData já filtra
  // `m <= curM2` por este mesmo motivo).
  const catRows = all(`
    SELECT substr(date,1,7) as month, category,
      SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as expenses,
      SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) as income
    FROM transactions
    WHERE date >= '2000-01-01' AND date <= date('now') AND transfer_id IS NULL
      AND (category IS NOT NULL AND category != '')
      AND LOWER(category) NOT LIKE '%transfer%'
    GROUP BY month, category
  `, []);

  // ── 2. Exclusão manual por subcategoria (ev_catConfig) ──
  const modeOf = {};
  catConfig.forEach(({ cat, mode }) => { modeOf[cat] = mode; });
  const catConfigActive = catConfig.length > 0;

  // ── 3. Agrupa por categoria-MÃE e SÓ ENTÃO classifica — idêntico a
  // groupAndClassifyByParent() do renderer ──
  const byMonthParent = {};
  for (const r of catRows) {
    const mode = modeOf[r.category];
    if (mode === 'excluded') continue;
    if (catConfigActive && mode === undefined) continue;

    const parent = (r.category || '').split(':')[0];
    const key = r.month + '' + parent;
    if (!byMonthParent[key]) byMonthParent[key] = { month: r.month, parent, income: 0, expenses: 0 };
    byMonthParent[key].income   += r.income   || 0;
    byMonthParent[key].expenses += r.expenses || 0;
  }

  const byMonth    = {}; // month -> { income, expenses }
  const catByMonth = {}; // month -> { categoriaMae: valorCents } (receita OU despesa, magnitude)
  Object.values(byMonthParent).forEach(g => {
    const net = g.income - g.expenses;
    const m = byMonth[g.month] || (byMonth[g.month] = { income: 0, expenses: 0 });
    if (net > 0) m.income += net;
    else if (net < 0) m.expenses += -net;

    // Ao contrário da versão anterior (que só guardava categorias com
    // net<0, ou seja, só despesa), agora guarda QUALQUER categoria-mãe
    // com movimento — incluindo receitas (Salário, Juros recebidos
    // etc.), que antes nunca apareciam na aba Evolução > Por categoria
    // do mobile.
    if (net !== 0) {
      if (!catByMonth[g.month]) catByMonth[g.month] = {};
      catByMonth[g.month][g.parent] = toCents(Math.abs(net));
    }
  });

  let months = Object.keys(byMonth).sort();
  if (!months.length) {
    await sb.remove('mobile_evolution', { user_id: userId });
    console.log('[sync:push:evolution] nenhum mês com dados');
    return;
  }

  // ── Média móvel de 12 meses — SEMPRE, sobre o histórico completo
  // (antes de cortar para os últimos 12 meses enviados) ──
  //
  // O desktop (computeEvMA12LucroData, usado pela Aposentadoria/"Poupança
  // realizada") calcula o LUCRO líquido mês a mês primeiro (receita menos
  // despesa) e SÓ ENTÃO tira a média móvel desse saldo — não a média de
  // receita menos a média de despesa. movAvg12 descarta meses com valor
  // exatamente 0 da janela; aplicado separadamente a receita e despesa,
  // cada série pode descartar um conjunto de meses DIFERENTE (ex: um mês
  // com despesa zerada mas receita normal), fazendo
  // income_ma - expenses_ma divergir do valor real do desktop. Para
  // garantir que a diferença bata exatamente, calcula-se a MA do lucro
  // líquido primeiro (idêntico ao desktop) e depois deriva-se income_ma/
  // expenses_ma usando o MESMO conjunto de meses (máscara) dessa MA —
  // assim a subtração sempre resulta no valor correto, mesmo mantendo os
  // dois campos separados (necessários pro gráfico da Evolução no mobile).
  function movAvg12(arr, i) {
    const w = arr.slice(Math.max(0, i - 11), i + 1).filter(v => v !== 0 && !isNaN(v));
    return w.length ? w.reduce((s, v) => s + v, 0) / w.length : 0;
  }
  function movAvg12Masked(arr, maskArr, i) {
    const idxs = [];
    for (let j = Math.max(0, i - 11); j <= i; j++) {
      if (maskArr[j] !== 0 && !isNaN(maskArr[j])) idxs.push(j);
    }
    return idxs.length ? idxs.reduce((s, j) => s + arr[j], 0) / idxs.length : 0;
  }
  const incArr    = months.map(m => byMonth[m].income);
  const expArr    = months.map(m => byMonth[m].expenses);
  const lucroArr  = incArr.map((v, i) => v - expArr[i]);
  const incMA = months.map((_, i) => movAvg12Masked(incArr, lucroArr, i));
  const expMA = months.map((_, i) => movAvg12Masked(expArr, lucroArr, i));

  // ── 6. Corta para os últimos 12 meses só agora, na montagem das
  // linhas enviadas — a MA acima já usou o histórico completo ──
  const last12 = months.slice(-12);
  const rows = last12.map(m => {
    const i = months.indexOf(m);
    return {
      user_id:     userId,
      month:       m,
      income:      toCents(incArr[i]),
      expenses:    toCents(expArr[i]),
      balance:     toCents(incArr[i] - expArr[i]),
      income_ma:   toCents(incMA[i]),
      expenses_ma: toCents(expMA[i]),
      by_category: catByMonth[m] || {},
      synced_at:   new Date().toISOString(),
    };
  });

  if (!hasChanged('evolution', rows.map(r => ({ ...r, synced_at: undefined })))) {
    console.log('[sync:push] evolution sem mudança — pulando');
    return;
  }
  const syncedAtE = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAtE);
  encFields(rows, ['income', 'expenses', 'balance', 'income_ma', 'expenses_ma'], ['by_category']);

  // DELETE + INSERT: elimina dados de versões antigas e meses fora da
  // janela de 12 meses atual
  await sb.remove('mobile_evolution', { user_id: userId });
  if (rows.length) await sb.upsert('mobile_evolution', rows, 'user_id,month');

  console.log(`[sync:push:evolution] ${rows.length} meses (últimos 12, MA sempre ativa, sem correção IPCA)`);
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
    initHashCache(getDbPath(), userId);
  }

  const steps = [
    ['balances',     () => pushBalances(all, userId, syncInvestments)],
    ['transactions', () => pushTransactions(all, userId, syncInvestments)],
    ['budgets',      () => pushBudgets(all, userId)],
    ['goals',        () => pushGoals(all, userId)],
    ['scheduled',    () => pushScheduled(all, userId, syncInvestments)],
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
