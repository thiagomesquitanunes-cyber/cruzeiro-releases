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

// Retorna true se os dados mudaram desde o último sync BEM-SUCEDIDO desta
// tabela — só COMPARA, não grava nada (ver markSynced abaixo).
function hasChanged(table, rows) {
  return _hashCache[table] !== hashRows(rows);
}

// Confirma que os dados foram sincronizados com sucesso — só chame isso
// DEPOIS do upsert/remove realmente ter concluído sem erro. hasChanged()
// costumava gravar o hash como efeito colateral da própria checagem, ANTES
// de qualquer chamada de rede: se o upload falhasse (erro de rede, timeout),
// o hash já tinha sido commitado como se tivesse dado certo, e a tabela
// nunca mais era re-tentada até algum dado local mudar de novo — uma falha
// de rede podia deixar o Supabase permanentemente desatualizado em silêncio.
function markSynced(table, rows) {
  _hashCache[table] = hashRows(rows);
}

// Invalida o cache de uma tabela (força re-sync na próxima vez)
function invalidateCache(table) {
  delete _hashCache[table];
}

// Converte reais (float) para centavos (integer)
const toCents = v => Math.round((v || 0) * 100);

// Data/mês de HOJE no fuso do usuário. new Date().toISOString() devolve UTC —
// no Brasil (UTC−3) isso faz o app "virar o dia" às 21h, datando lançamentos
// da noite no dia seguinte (e, no último dia do mês, no mês seguinte).
const pad2 = n => String(n).padStart(2, '0');
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function monthLocal() { return todayLocal().slice(0, 7); }
// Hoje ± N dias, também no fuso local — usado como limite das janelas de
// consulta. setDate() com dias (diferente de setMonth com meses) rola
// corretamente de mês/ano, então não precisa de âncora.
function shiftDaysLocal(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Retorna YYYY-MM de N meses atrás.
// Monta a data com DIA 1 fixo: `d.setMonth(d.getMonth() - n)` no dia 31 não
// existe no mês de destino (31/abr) e o JS rola pro mês seguinte, devolvendo
// o mês ERRADO — o que gerava meses duplicados na lista e derrubava o upsert
// de mobile_patrimonio ("ON CONFLICT cannot affect row a second time").
function monthsAgo(n) {
  const [y, m] = monthLocal().split('-').map(Number);
  const d = new Date(y, m - 1 - n, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

// ─────────────────────────────────────────────────────────────
// 1. Saldos por conta
// ─────────────────────────────────────────────────────────────
async function pushBalances(all, userId, syncInvestments) {
  const today    = todayLocal();
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

  const hashableRows = rows.map(r => ({ ...r, synced_at: undefined }));
  if (!hasChanged('balances', hashableRows)) {
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
  markSynced('balances', hashableRows);
}

// ─────────────────────────────────────────────────────────────
// 2. Transações recentes (últimos 90 dias)
// ─────────────────────────────────────────────────────────────
async function pushTransactions(all, userId, syncInvestments) {
  const fromDate = shiftDaysLocal(-90);
  const today = todayLocal();

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

  const hashableRows = rows.map(r => ({ ...r, synced_at: undefined }));
  if (!hasChanged('transactions', hashableRows)) {
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
  markSynced('transactions', hashableRows);
}

// ─────────────────────────────────────────────────────────────
// 3. Orçamentos do mês atual
// ─────────────────────────────────────────────────────────────
async function pushBudgets(all, userId) {
  const month = monthLocal(); // YYYY-MM
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

  const hashableRows = rows.map(r => ({ ...r, synced_at: undefined }));
  if (!hasChanged('budgets', hashableRows)) {
    console.log('[sync:push] budgets sem mudança — pulando');
    return;
  }
  const syncedAtB = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAtB);
  encFields(rows, ['monthly_limit', 'spent']);
  await sb.upsert('mobile_budgets', rows, 'user_id,month,category');
  await sb.pruneNotIn('mobile_budgets', userId, 'category', budgets.map(b => b.category))
    .catch(() => {});
  markSynced('budgets', hashableRows);
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
      const month  = monthLocal();
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

  const hashableRows = rows.map(r => ({ ...r, synced_at: undefined }));
  if (!hasChanged('goals', hashableRows)) {
    console.log('[sync:push] goals sem mudança — pulando');
    return;
  }
  const syncedAtG = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAtG);
  encFields(rows, ['target_amount', 'monthly_amount', 'current_amount']);
  await sb.upsert('mobile_goals', rows, 'user_id,desktop_id');
  await sb.pruneNotIn('mobile_goals', userId, 'desktop_id', goals.map(g => String(g.id)));
  markSynced('goals', hashableRows);
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
  const today   = todayLocal();
  const horizon = shiftDaysLocal(60);
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

  const hashableRows = rows.map(r => ({ ...r, synced_at: undefined }));
  if (!hasChanged('scheduled', hashableRows)) {
    console.log('[sync:push] scheduled sem mudança — pulando');
    return;
  }
  const syncedAtS = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAtS);
  encFields(rows, ['memo', 'amount']);
  await sb.upsert('mobile_scheduled', rows, 'user_id,desktop_id');
  await sb.pruneNotIn('mobile_scheduled', userId, 'desktop_id', rows.map(r => r.desktop_id));
  markSynced('scheduled', hashableRows);
}

// ─────────────────────────────────────────────────────────────
// 6. Patrimônio (últimos 3 meses)
// Só sincroniza se o usuário optou por compartilhar dados de
// investimento com o mobile — patrimônio é fundamentalmente
// sobre ativos/investimentos, então segue a mesma regra.
// ─────────────────────────────────────────────────────────────
const { calcIRR } = require('../lib/irr');

const PAT_TX_CASH_SIGN = {
  compra: -1, parcela_compra: -1, aporte: -1, despesa: -1, parcela_financiamento: -1,
  reducao: +1, aluguel: +1, dividendo: +1, jcp: +1, juros_mutuo: +1, venda: +1, venda_parcela: +1,
};
const INV_TX_EXTERNAL_SIGN   = { compra: -1, aporte: -1, venda: +1, amortizacao: +1 };
const INV_TX_INCOME_SIGN     = { dividendo: +1, juros: +1, taxa: -1, jcp: +1, cupom: +1 };
const INV_TX_CASH_SIGN       = { ...INV_TX_EXTERNAL_SIGN, ...INV_TX_INCOME_SIGN };
const INV_TX_VALUATION_TYPES = new Set(['atualizacao', 'cota', 'incorporacao', 'correcao']);

function monthRange(from, to) {
  const out = [];
  let m = from;
  while (m <= to) {
    out.push(m);
    const [y, mo] = m.split('-').map(Number);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }
  return out;
}

function makeIpcaCumFn(ipcaMonthly, curM) {
  return (m) => {
    let cum = 1, cur = m;
    while (cur < curM) {
      const [y, mo] = cur.split('-').map(Number);
      const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
      cum *= (1 + (ipcaMonthly[next] ?? 0));
      cur = next;
    }
    return cum;
  };
}

// Saldo de uma conta em transactions.amount, como estava no FIM do mês —
// sem esse limite superior, lançamentos FUTUROS (recorrências materializadas
// anos à frente) entravam na soma e distorciam o saldo "atual" pra valores
// completamente irreais (achado ao investigar os bugs de patrimônio no
// mobile: uma conta com saldo real de ~R$9 mil somava -R$2,6 milhões sem
// esse filtro, por causa de parcelas de financiamento projetadas décadas
// à frente).
function accountBalanceAt(all, accountId, month) {
  const row = all(`
    SELECT COALESCE(SUM(amount),0) as total FROM transactions
    WHERE account_id=? AND date < date(? || '-01', '+1 month')
  `, [accountId, month]);
  return row[0]?.total || 0;
}

// Saldo devedor + taxa de juros de um bem financiado, no mês. Usa o
// ÚLTIMO registro de pat_financing até o mês, INDEPENDENTE de paid/
// is_projection — é o mesmo critério que assetTotalByMonth usa no
// renderer (debtByAsset, refreshPatrimonioTable) pra "saldo devedor
// atual". Filtrar por paid=0 AND is_projection=0 (como a versão
// anterior fazia) quase sempre não bate com NENHUMA linha — a maioria
// das parcelas futuras de um financiamento fica marcada is_projection=1
// até o mês chegar — e o saldo devedor saía como zero.
function bemDebtAndRate(all, assetId) {
  const contracts = all("SELECT id, annual_rate FROM pat_financing_contracts WHERE asset_id=? AND status='active'", [assetId]);
  if (!contracts.length) return { debt: null, rate: null, rows: [] };
  let debt = 0;
  const rows = [];
  contracts.forEach(c => {
    const schedule = all('SELECT month, installment, balance_end, is_projection, paid FROM pat_financing WHERE contract_id=? ORDER BY month', [c.id]);
    rows.push(...schedule);
    const upToNow = schedule.filter(r => r.month <= _todayMonth());
    const latest = upToNow[upToNow.length - 1];
    if (latest) debt += latest.balance_end || 0;
  });
  return { debt, rate: contracts[0].annual_rate, rows };
}
function _todayMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Bens: fluxo de caixa de pat_transactions (PAT_TX_CASH_SIGN) — o valor
// atual vem de fora (pat_history), não das transações. `financingRows`
// (schedule completo do(s) contrato(s) ativo(s), se houver) injeta a
// MESMA parcela hipotética que o renderer usa (refreshPatrimonioTable):
// toda parcela projetada e ainda não paga entra como saída de caixa no
// mês dela, exceto quando já existe uma pat_transactions real
// 'parcela_financiamento' naquele mês — sem isso, a TIR de um bem
// financiado ficava sem refletir o financiamento até a parcela ser de
// fato registrada, divergindo da tela do desktop.
function computeBemReturns(txs, currentValue, ipcaCumFn, curM, financingRows) {
  const netCash = {};
  txs.forEach(t => {
    const sign = PAT_TX_CASH_SIGN[t.tx_type];
    if (sign === undefined) return;
    const m = t.month.slice(0, 7);
    netCash[m] = (netCash[m] || 0) + sign * t.total_value;
  });
  if (financingRows && financingRows.length) {
    const realFlowMonths = new Set(txs.filter(t => t.tx_type === 'parcela_financiamento').map(t => t.month.slice(0, 7)));
    financingRows.forEach(r => {
      const m = (r.month || '').slice(0, 7);
      if (r.is_projection === 1 && r.paid !== 1 && !realFlowMonths.has(m)) {
        netCash[m] = (netCash[m] || 0) - Math.abs(r.installment || 0);
      }
    });
  }
  const months = Object.keys(netCash).sort();
  if (!months.length) return { tirNominal: null, tirReal: null, gainLoss: null };
  // A TIR de um bem, na tela do desktop (refreshPatrimonioTable), soma uma
  // "venda hipotética" no mês SEGUINTE ao atual (nextM), não no mês atual —
  // por isso o array de fluxos vai até nextM, não até curM. Sem isso a TIR
  // de bens recém-adquiridos (poucos meses de histórico) divergia
  // perceptivelmente do desktop, já que 1 mês a menos/mais pesa proporcionalmente
  // mais num período curto.
  const [cy, cmo] = curM.split('-').map(Number);
  const nextM = cmo === 12 ? `${cy + 1}-01` : `${cy}-${String(cmo + 1).padStart(2, '0')}`;
  const irrMonths = monthRange(months[0], nextM);
  const nomFlows  = irrMonths.map(m => netCash[m] ?? 0);
  const realFlows = irrMonths.map(m => (netCash[m] ?? 0) * ipcaCumFn(m));
  nomFlows[nomFlows.length - 1]   += currentValue;
  realFlows[realFlows.length - 1] += currentValue;
  const gainLoss = Object.values(netCash).reduce((s, v) => s + v, 0) + currentValue;
  return { tirNominal: calcIRR(nomFlows), tirReal: calcIRR(realFlows), gainLoss };
}

// Investimentos: valor "contábil" derivado das próprias transações
// (aportes/resgates + resets de avaliação), igual à lógica de
// buildInvRows/calcAssetRealIRR no renderer. Compartilhada entre
// pushPatrimonio (total agregado) e pushPatrimonioItems (por item) —
// antes cada uma tinha sua própria versão simplificada (só
// tx_type='atualizacao'), e podiam divergir entre si.
function investmentBookValue(txs, uptoMonth) {
  const byMonth = {};
  txs.forEach(t => { const m = t.month.slice(0, 7); (byMonth[m] = byMonth[m] || []).push(t); });
  const txMonths = Object.keys(byMonth).sort();
  if (!txMonths.length) return { netCash: {}, currentValue: 0, firstMonth: null, allMonths: [] };

  const netCash = {};
  let running = 0;
  const bookValueByMonth = {};
  txMonths.forEach(m => {
    let lastValuation = null;
    byMonth[m].forEach(t => {
      if (t.tx_type in INV_TX_CASH_SIGN) {
        netCash[m] = (netCash[m] || 0) + INV_TX_CASH_SIGN[t.tx_type] * t.total_value;
      } else if (INV_TX_VALUATION_TYPES.has(t.tx_type)) {
        lastValuation = t.total_value;
      }
    });
    // O valor contábil SÓ muda em transações de avaliação (atualizacao/cota/
    // etc.) — um aporte/compra sem uma atualização de valor no mesmo mês NÃO
    // mexe no valor exibido do ativo. É assim que o renderer trata isso
    // (buildInvRows, comentário "bookValue only comes from real valuations
    // (atualizacao) — cashDelta does NOT contribute to displayed asset
    // value"): a versão anterior daqui somava o aporte direto no valor
    // contábil, o que só coincidia com o desktop quando aporte e atualização
    // caem no mesmo mês (como no caso mais comum de "criei o ativo já com
    // saldo") — em qualquer outro caso, divergia.
    if (lastValuation !== null) running = lastValuation;
    bookValueByMonth[m] = running;
  });

  let lastVal = 0;
  const allMonths = monthRange(txMonths[0], uptoMonth);
  allMonths.forEach(m => { if (bookValueByMonth[m] !== undefined) lastVal = bookValueByMonth[m]; });
  const currentValue = bookValueByMonth[uptoMonth] ?? lastVal;
  return { netCash, currentValue, firstMonth: txMonths[0], allMonths };
}

function computeInvReturns(txs, ipcaCumFn, curM) {
  const { netCash, currentValue, allMonths } = investmentBookValue(txs, curM);
  if (!allMonths.length || !Object.keys(netCash).length) return { tirNominal: null, tirReal: null, gainLoss: null, currentValue };
  const nomFlows  = allMonths.map(m => netCash[m] ?? 0);
  const realFlows = allMonths.map(m => (netCash[m] ?? 0) * ipcaCumFn(m));
  nomFlows[nomFlows.length - 1]   += currentValue;
  realFlows[realFlows.length - 1] += currentValue;
  const gainLoss = Object.values(netCash).reduce((s, v) => s + v, 0) + currentValue;
  return { tirNominal: calcIRR(nomFlows), tirReal: calcIRR(realFlows), gainLoss, currentValue };
}

// Comparação com benchmark de UM investimento, EXATAMENTE como o renderer
// calcula (buildInvRows, bloco "Benchmark label" ~linha 25453): não é
// cumulativeReturn/vsCDI da aba Rendimentos (fórmula diferente, e essa nem é
// a que aparece na aba Patrimônio) — aqui o benchmark é anualizado a partir
// da MÉDIA das taxas mensais do período (não do produto composto), e
// comparado contra a TIR NOMINAL (não a real).
function computeBenchmarkDiff(irrNominal, benchmarkMonthly, firstMonth, curM) {
  if (irrNominal === null || !benchmarkMonthly || !firstMonth) return null;
  const rates = [];
  let m = firstMonth;
  while (m <= curM) {
    if (benchmarkMonthly[m] != null) rates.push(benchmarkMonthly[m]);
    const [y, mo] = m.split('-').map(Number);
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }
  if (!rates.length) return null;
  const avgMonthlyRate = rates.reduce((s, r) => s + r, 0) / rates.length;
  const benchmarkAnnualized = Math.pow(1 + avgMonthlyRate, 12) - 1;
  return irrNominal - benchmarkAnnualized;
}

async function pushPatrimonioItems(all, userId, syncInvestments, getDbPath, fs) {
  if (!syncInvestments) {
    if (hasChanged('patrimonio_items', ['sync_disabled'])) {
      await sb.remove('mobile_patrimonio_items', { user_id: userId }).catch(() => {});
      markSynced('patrimonio_items', ['sync_disabled']);
    }
    return;
  }

  const curM = _todayMonth();

  let ipcaMonthly = {};
  let benchmarks = {};
  if (typeof getDbPath === 'function' && fs && typeof fs.existsSync === 'function') {
    try {
      const ipcaPath = getDbPath().replace('.db', '_pat_ipca_monthly.json');
      if (fs.existsSync(ipcaPath)) ipcaMonthly = JSON.parse(fs.readFileSync(ipcaPath, 'utf8')) || {};
    } catch (e) {}
    try {
      const bmPath = getDbPath().replace('.db', '_benchmarks.json');
      if (fs.existsSync(bmPath)) benchmarks = JSON.parse(fs.readFileSync(bmPath, 'utf8')) || {};
    } catch (e) {}
  }
  const ipcaCumFn = makeIpcaCumFn(ipcaMonthly, curM);

  const rows = [];

  // ── Bens e direitos ──
  const patAssets = all('SELECT * FROM pat_assets WHERE hidden=0 AND sold_month IS NULL');
  patAssets.forEach(asset => {
    const hist = all('SELECT value FROM pat_history WHERE asset_id=? ORDER BY month DESC LIMIT 1', [asset.id]);
    const currentValue = hist[0]?.value || 0;
    const txs = all('SELECT tx_type, total_value, month FROM pat_transactions WHERE asset_id=?', [asset.id]);
    const { debt: debtBalance, rate: interestRate, rows: financingRows } = asset.financed
      ? bemDebtAndRate(all, asset.id)
      : { debt: null, rate: null, rows: [] };
    const { tirNominal, tirReal, gainLoss } = computeBemReturns(txs, currentValue, ipcaCumFn, curM, financingRows);

    rows.push({
      user_id: userId, desktop_id: `bem_${asset.id}`, section: 'bem',
      name: asset.name, subtype: asset.asset_type || 'outro',
      category: null, broker: null, maturity_month: null, liquidity: null, benchmark: null,
      current_value: toCents(currentValue),
      debt_balance: debtBalance !== null ? toCents(debtBalance) : null,
      interest_rate: interestRate,
      tir_nominal: tirNominal !== null ? tirNominal * 100 : null,
      tir_real: tirReal !== null ? tirReal * 100 : null,
      gain_loss: gainLoss !== null ? toCents(gainLoss) : null,
      benchmark_return: null,
      synced_at: new Date().toISOString(),
    });
  });

  // ── Investimentos financeiros ──
  const invAssets = all('SELECT * FROM inv_assets WHERE hidden=0 AND closed_month IS NULL');
  invAssets.forEach(asset => {
    // Ativos de "caixa" (valor em caixa da corretora) não mostram TIR/
    // benchmark no desktop — mesma checagem de _isCashAsset() no renderer.
    const isCashAsset = asset.category === 'valor_em_caixa' || asset.category === 'caixa'
      || asset.inv_type === 'Caixa' || asset.name === 'Valores em Caixa';

    const txs = all('SELECT tx_type, total_value, month FROM inv_transactions WHERE asset_id=? AND month<=? ORDER BY month', [asset.id, curM]);
    const { tirNominal, tirReal, gainLoss, currentValue } = computeInvReturns(txs, ipcaCumFn, curM);
    const { firstMonth } = investmentBookValue(txs, curM);

    const bmSeries = benchmarks?.[asset.benchmark || 'cdi'] || null;
    const benchmarkReturn = (isCashAsset || !asset.benchmark || asset.benchmark === 'nenhum')
      ? null
      : computeBenchmarkDiff(tirNominal, bmSeries, firstMonth, curM);

    rows.push({
      user_id: userId, desktop_id: `inv_${asset.id}`, section: 'investimento',
      name: asset.name, subtype: asset.inv_type || null,
      category: asset.category || null, broker: asset.broker || null,
      maturity_month: asset.maturity_month || null, liquidity: asset.liquidity || null,
      benchmark: asset.benchmark || null,
      current_value: toCents(currentValue || 0),
      debt_balance: null, interest_rate: null,
      tir_nominal: (!isCashAsset && tirNominal !== null) ? tirNominal * 100 : null,
      tir_real: (!isCashAsset && tirReal !== null) ? tirReal * 100 : null,
      gain_loss: (!isCashAsset && gainLoss !== null) ? toCents(gainLoss) : null,
      benchmark_return: benchmarkReturn !== null ? benchmarkReturn * 100 : null,
      synced_at: new Date().toISOString(),
    });
  });

  // ── Cartões e dívidas ──
  const cardAccounts = all("SELECT * FROM accounts WHERE type='credit' AND hidden=0");
  cardAccounts.forEach(acc => {
    const owed = Math.max(0, -accountBalanceAt(all, acc.id, curM)); // amount negativo = devendo
    rows.push({
      user_id: userId, desktop_id: `cartao_${acc.id}`, section: 'cartao_divida',
      name: acc.name, subtype: 'cartão de crédito',
      category: null, broker: null, maturity_month: null, liquidity: null, benchmark: null,
      current_value: toCents(owed), debt_balance: toCents(owed), interest_rate: null,
      tir_nominal: null, tir_real: null, gain_loss: null, benchmark_return: null,
      synced_at: new Date().toISOString(),
    });
  });
  // linked_account_id IS NULL: exclui dívidas pessoais que são espelho
  // automático de um cartão de crédito (o app cria um personal_debts pra
  // cada conta type='credit', pra aparecer no relatório de IRPF — ver
  // main.js linha ~5219). Sem esse filtro, o mesmo cartão virava DUAS
  // linhas na seção "cartões e dívidas": uma pela conta, outra pela
  // dívida pessoal espelhada — a causa da duplicação relatada pelo usuário.
  const personalDebts = all('SELECT * FROM personal_debts WHERE hidden=0 AND linked_account_id IS NULL');
  personalDebts.forEach(debt => {
    const contract = all('SELECT annual_rate FROM personal_debt_contracts WHERE debt_id=?', [debt.id]);
    // Último registro até o mês, independente de paid/is_projection — mesmo
    // critério de bemDebtAndRate (ver comentário lá) e do próprio renderer
    // (computeDebtBalByMonth), em vez de exigir paid=0 AND is_projection=0
    // (que raramente bate com alguma linha e dava saldo zero).
    const row = all('SELECT balance_end FROM personal_debt_installments WHERE debt_id=? AND month<=? ORDER BY month DESC LIMIT 1', [debt.id, curM]);
    const owed = row[0]?.balance_end || 0;
    rows.push({
      user_id: userId, desktop_id: `divida_${debt.id}`, section: 'cartao_divida',
      name: debt.name, subtype: 'dívida pessoal',
      category: null, broker: null, maturity_month: null, liquidity: null, benchmark: null,
      current_value: toCents(owed), debt_balance: toCents(owed),
      interest_rate: contract[0]?.annual_rate ?? null,
      tir_nominal: null, tir_real: null, gain_loss: null, benchmark_return: null,
      synced_at: new Date().toISOString(),
    });
  });

  // ── Contas bancárias ── (mesmo valor que aparece na coluna do mês
  // corrente da aba Patrimônio do desktop: saldo acumulado até o fim do mês)
  const bankAccounts = all("SELECT * FROM accounts WHERE type IN ('bank','cash') AND hidden=0");
  bankAccounts.forEach(acc => {
    rows.push({
      user_id: userId, desktop_id: `conta_${acc.id}`, section: 'conta',
      name: acc.name, subtype: acc.type,
      category: null, broker: null, maturity_month: null, liquidity: null, benchmark: null,
      current_value: toCents(accountBalanceAt(all, acc.id, curM)),
      debt_balance: null, interest_rate: null,
      tir_nominal: null, tir_real: null, gain_loss: null, benchmark_return: null,
      synced_at: new Date().toISOString(),
    });
  });

  const hashableRows = rows.map(r => ({ ...r, synced_at: undefined }));
  if (!hasChanged('patrimonio_items', hashableRows)) {
    console.log('[sync:push] patrimonio_items sem mudança — pulando');
    return;
  }
  const syncedAtPI = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAtPI);
  encFields(rows,
    ['name', 'subtype', 'category', 'broker', 'maturity_month', 'liquidity', 'benchmark',
     'current_value', 'debt_balance', 'interest_rate', 'tir_nominal', 'tir_real', 'gain_loss', 'benchmark_return'],
    []
  );
  // DELETE + INSERT em vez de upsert com on_conflict: a tabela
  // mobile_patrimonio_items já existia no Supabase antes de eu rodar meu
  // próprio SQL de criação nesta sessão (motivo desconhecido) — não dá pra
  // garantir que a constraint única (user_id,desktop_id) que meu upsert
  // depende bate exatamente com a da tabela real. DELETE tudo do usuário e
  // INSERT de novo elimina esse risco (e qualquer duplicata que já exista
  // de execuções anteriores), ao custo de reescrever a tabela inteira a
  // cada sync em vez de só o delta.
  await sb.remove('mobile_patrimonio_items', { user_id: userId }).catch(() => {});
  if (rows.length) await sb.upsert('mobile_patrimonio_items', rows);
  markSynced('patrimonio_items', hashableRows);
}

// ─────────────────────────────────────────────────────────────
// 6. Patrimônio (últimos 3 meses) — totais agregados por mês
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
      markSynced('patrimonio', ['sync_disabled']);
    }
    return;
  }

  const months = [];
  for (let i = 0; i < 3; i++) months.push(monthsAgo(i));

  const patAssets = all('SELECT * FROM pat_assets WHERE hidden=0 AND sold_month IS NULL');
  const invAssets = all('SELECT * FROM inv_assets WHERE hidden=0 AND closed_month IS NULL');
  // Contas que contam pro patrimônio: só as que o usuário marcou como
  // incluídas na aba Patrimônio (pat_accounts.included=1) — mesma escolha
  // que o "Total Patrimônio" do desktop usa (pat:account-balances). Antes
  // este push somava TODAS as contas não-cartão, o que (a) ignorava a
  // escolha do usuário e (b) misturava contas type='investment' cujo saldo
  // já está representado nos próprios inv_assets, contando o mesmo dinheiro
  // duas vezes.
  const includedAccountIds = all('SELECT account_id FROM pat_accounts WHERE included=1').map(r => r.account_id);

  const rows = months.map(month => {
    const breakdown = {};
    let totalBens = 0;

    patAssets.forEach(asset => {
      const hist = all('SELECT value FROM pat_history WHERE asset_id=? AND month<=? ORDER BY month DESC LIMIT 1', [asset.id, month]);
      const value = hist[0]?.value || 0;
      const type  = asset.asset_type || 'outros';
      breakdown[type] = (breakdown[type] || 0) + value;
      totalBens += value;
      if (asset.financed) totalBens -= (bemDebtAndRate(all, asset.id).debt || 0);
    });

    // Investimentos — valor "contábil" completo (aportes/resgates + resets
    // de avaliação), mesma função usada por pushPatrimonioItems — antes
    // este total usava só a última transação tx_type='atualizacao', que
    // não reflete aportes feitos sem uma atualização de valor logo depois.
    let totalInv = 0;
    invAssets.forEach(asset => {
      const txs = all('SELECT tx_type, total_value, month FROM inv_transactions WHERE asset_id=? AND month<=? ORDER BY month', [asset.id, month]);
      totalInv += investmentBookValue(txs, month).currentValue || 0;
    });
    if (totalInv) breakdown.investimentos = (breakdown.investimentos || 0) + totalInv;

    // Saldo em conta — só as contas incluídas na aba Patrimônio do desktop,
    // saldo acumulado até o FIM do mês (sem isso, lançamentos futuros
    // distorciam o saldo "atual" pra valores irreais — ver accountBalanceAt).
    let totalAcc = 0;
    includedAccountIds.forEach(id => { totalAcc += accountBalanceAt(all, id, month); });
    if (totalAcc) breakdown.contas = (breakdown.contas || 0) + totalAcc;

    const totalAssets = totalBens + totalInv + totalAcc;

    // Cartões e dívidas — saldo devedor de cartão de crédito (amount
    // negativo = valor devido na fatura) + financiamentos ativos (já
    // subtraídos de totalBens acima) + dívidas pessoais.
    const cardAccounts = all("SELECT id FROM accounts WHERE type='credit' AND hidden=0");
    let cardDebt = 0;
    cardAccounts.forEach(acc => { cardDebt += Math.max(0, -accountBalanceAt(all, acc.id, month)); });

    // linked_account_id IS NULL: mesma exclusão de espelho de cartão — ver
    // comentário equivalente em pushPatrimonioItems.
    const personalDebts = all('SELECT id FROM personal_debts WHERE hidden=0 AND linked_account_id IS NULL');
    let personalDebtTotal = 0;
    personalDebts.forEach(d => {
      const row = all('SELECT balance_end FROM personal_debt_installments WHERE debt_id=? AND month<=? ORDER BY month DESC LIMIT 1', [d.id, month]);
      personalDebtTotal += row[0]?.balance_end || 0;
    });

    const totalDebts = cardDebt + personalDebtTotal;

    const breakdownCents = {};
    Object.entries(breakdown).forEach(([k, v]) => { breakdownCents[k] = toCents(v); });

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

  const hashableRows = rows.map(r => ({ ...r, synced_at: undefined }));
  if (!hasChanged('patrimonio', hashableRows)) {
    console.log('[sync:push] patrimonio sem mudança — pulando');
    return;
  }
  const syncedAtP = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAtP);
  encFields(rows, ['total_assets', 'total_debts', 'net_worth'], ['breakdown']);
  await sb.upsert('mobile_patrimonio', rows, 'user_id,month');
  markSynced('patrimonio', hashableRows);
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

  const hashableRows = rows.map(r => ({ ...r, synced_at: undefined }));
  if (!hasChanged('evolution', hashableRows)) {
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
  markSynced('evolution', hashableRows);

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

  const hashableRows = rows.map(r => ({ ...r, synced_at: undefined }));
  if (!hasChanged('ml_rules', hashableRows)) {
    console.log('[sync:push] ml_rules sem mudança — pulando');
    return;
  }
  const syncedAtML = new Date().toISOString();
  rows.forEach(r => r.synced_at = syncedAtML);
  await sb.upsert('ml_rules', rows, 'user_id,keyword');
  markSynced('ml_rules', hashableRows);
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
    ['patrimonio_items', () => pushPatrimonioItems(all, userId, syncInvestments, getDbPath, fs)],
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
