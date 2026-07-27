// ─────────────────────────────────────────────────────────────
// sync-pull.js
// Consome dados do Supabase → SQLite local.
//
// Responsabilidades:
//   1. Importar quick_entries pendentes do mobile como transações
//   2. Atualizar ml_rules com aprendizado vindo do mobile
//   3. Marcar quick_entries como 'imported' após processar
// ─────────────────────────────────────────────────────────────

const sb = require('./supabase-client');
const cryptoUtils = require('./crypto-utils');

// Data de HOJE no fuso do usuário (não UTC). new Date().toISOString() no
// Brasil (UTC−3) devolve o dia SEGUINTE a partir das 21h — o que datava
// lançamentos da noite no dia errado.
const _pad2 = n => String(n).padStart(2, '0');
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`;
}

// Decifra um campo vindo do mobile (quick_entries agora são cifrados
// no aparelho antes do insert). Fallback: se o valor não estiver
// cifrado (app mobile antigo, ou chave indisponível no momento do
// lançamento), retorna como veio. Números cifrados voltam como string.
function dec(value) {
  if (value == null) return value;
  if (!cryptoUtils.isUnlocked()) return value;
  const d = cryptoUtils.decrypt(value);
  return d == null ? value : d;
}

// Normaliza texto para chave de ML (igual ao normKey do main.js)
function normKey(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 50);
}

// ─────────────────────────────────────────────────────────────
// 1. Importar quick_entries pendentes
// ─────────────────────────────────────────────────────────────
async function pullQuickEntries(all, run, first, save, userId) {
  // Busca todas as entradas pendentes do usuário
  const entries = await sb.select('quick_entries',
    { user_id: userId, status: 'pending' },
    { order: 'created_at.asc' }
  );

  if (!entries.length) return { imported: 0, errors: 0 };

  let imported = 0;
  let errors   = 0;

  for (const entry of entries) {
    try {
      // Decifra campos sensíveis (cifrados pelo mobile antes do insert)
      entry.amount = Number(dec(entry.amount));
      entry.memo   = dec(entry.memo);

      const entryType = entry.entry_type || 'expense';

      if (entryType === 'transfer') {
        const txIds = importTransferEntry(all, run, first, entry);
        await sb.update('quick_entries', { id: entry.id }, {
          status:      'imported',
          imported_at: new Date().toISOString(),
          desktop_id:  txIds.join(','), // duas pernas — guarda os dois IDs
        });
        imported++;
        continue;
      }

      // Resolve a conta pelo nome (busca ID)
      let accountId = null;
      if (entry.account_name) {
        const acc = first('SELECT id FROM accounts WHERE name=?', [entry.account_name]);
        accountId = acc?.id || null;
      }

      // Fallback: usa a primeira conta ativa se não encontrou pelo nome
      if (!accountId) {
        const acc = first('SELECT id FROM accounts WHERE hidden=0 ORDER BY sort_order LIMIT 1');
        accountId = acc?.id || null;
      }

      if (!accountId) {
        throw new Error('Nenhuma conta disponível para importar');
      }

      // Converte centavos → reais e aplica o sinal conforme o tipo do
      // lançamento — despesa é sempre negativa, receita sempre positiva
      // (antes o sinal era sempre forçado negativo, então receitas
      // lançadas no mobile viravam despesa no desktop).
      const amount = entryType === 'income'
        ? Math.abs(entry.amount) / 100
        : -(Math.abs(entry.amount) / 100);
      const date   = entry.date || todayLocal();

      // Insere a transação no SQLite
      const txId = run(
        `INSERT INTO transactions
          (account_id, date, category, memo, amount, cleared, recurring_id, pat_asset_id, pat_tx_id, pat_debt_id)
         VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL)`,
        [accountId, date, entry.category || '', entry.memo || '', amount]
      );

      // Aprendizado de ML: memo digitado pelo usuário → categoria confirmada
      learnFromEntry(all, run, first, entry);

      // Marca como importada no Supabase
      await sb.update(
        'quick_entries',
        { id: entry.id },
        {
          status:      'imported',
          imported_at: new Date().toISOString(),
          desktop_id:  String(txId),
        }
      );

      imported++;
    } catch (e) {
      console.error(`[sync:pull] Erro ao importar quick_entry ${entry.id}:`, e.message);

      // Marca como rejeitada para não tentar importar infinitamente
      await sb.update(
        'quick_entries',
        { id: entry.id },
        { status: 'rejected' }
      ).catch(() => {});

      errors++;
    }
  }

  // Persiste alterações no SQLite
  if (imported > 0) save();

  return { imported, errors };
}

// ─────────────────────────────────────────────────────────────
// 1b. Importa uma transferência (duas pernas) — espelha
// exatamente a lógica do handler tx:transfer do desktop.
// ─────────────────────────────────────────────────────────────
function importTransferEntry(all, run, first, entry) {
  const fromAcc = first('SELECT id FROM accounts WHERE name=?', [entry.account_name]);
  const toAcc   = first('SELECT id FROM accounts WHERE name=?', [entry.to_account_name]);

  if (!fromAcc) throw new Error(`Conta de origem não encontrada: ${entry.account_name}`);
  if (!toAcc)   throw new Error(`Conta de destino não encontrada: ${entry.to_account_name}`);

  const maxRow = first('SELECT COALESCE(MAX(transfer_id),0) as m FROM transactions');
  const tid    = (maxRow?.m || 0) + 1;
  const date   = entry.date || todayLocal();
  const amount = Math.abs(entry.amount) / 100;
  const memo   = entry.memo || 'Transferência';

  const fromTxId = run(
    'INSERT INTO transactions (account_id,date,category,memo,amount,cleared,transfer_id) VALUES (?,?,?,?,?,0,?)',
    [fromAcc.id, date, 'Transferência', memo, -amount, tid]
  );
  const toTxId = run(
    'INSERT INTO transactions (account_id,date,category,memo,amount,cleared,transfer_id) VALUES (?,?,?,?,?,0,?)',
    [toAcc.id, date, 'Transferência', memo, amount, tid]
  );

  return [fromTxId, toTxId];
}

// ─────────────────────────────────────────────────────────────
// 2. Aprendizado de ML a partir de entradas do mobile
//
// No mobile o usuário escreve o memo e seleciona a categoria.
// A chave de aprendizado é o memo normalizado → categoria.
// ─────────────────────────────────────────────────────────────
function learnFromEntry(all, run, first, entry) {
  if (!entry.memo || !entry.category) return;

  // Só aprende se o usuário confirmou (ou não havia sugestão)
  // ml_accepted = false significa que o usuário corrigiu a sugestão —
  // nesse caso é ainda mais importante aprender a categoria certa
  const shouldLearn = entry.ml_accepted !== false
    || (entry.ml_accepted === false && entry.category);

  if (!shouldLearn) return;

  const key    = normKey(entry.memo);
  const memo   = (entry.memo || '').trim();
  const cat    = (entry.category || '').trim();
  const amount = Math.abs(entry.amount / 100);

  const existing = first('SELECT * FROM ml_rules WHERE keyword=?', [key]);

  if (existing) {
    run(
      `UPDATE ml_rules
       SET memo=?, category=?, count=count+1,
           sum_val=sum_val+?, n_val=n_val+1,
           min_val=CASE WHEN ? < min_val OR min_val IS NULL THEN ? ELSE min_val END,
           max_val=CASE WHEN ? > max_val OR max_val IS NULL THEN ? ELSE max_val END
       WHERE keyword=?`,
      [memo, cat, amount, amount, amount, amount, amount, key]
    );
  } else {
    run(
      `INSERT INTO ml_rules (keyword, memo, category, count, sum_val, n_val, min_val, max_val)
       VALUES (?, ?, ?, 1, ?, 1, ?, ?)`,
      [key, memo, cat, amount, amount, amount]
    );
  }
}

// ─────────────────────────────────────────────────────────────
// 3. Sincronizar ml_rules do Supabase → desktop
// Incorpora regras criadas no mobile que ainda não existem localmente
// ─────────────────────────────────────────────────────────────
async function pullMlRules(all, run, first, save, userId) {
  const remoteRules = await sb.select('ml_rules',
    { user_id: userId, source: 'mobile' }
  );

  if (!remoteRules.length) return { merged: 0 };

  let merged = 0;

  for (const r of remoteRules) {
    const key      = normKey(r.keyword);
    const existing = first('SELECT * FROM ml_rules WHERE keyword=?', [key]);

    if (existing) {
      // Incorpora contagem adicional do mobile
      if (r.count > 0) {
        run(
          'UPDATE ml_rules SET count=count+? WHERE keyword=?',
          [r.count, key]
        );
      }
    } else {
      // Nova regra vinda exclusivamente do mobile
      run(
        `INSERT INTO ml_rules (keyword, memo, category, count, sum_val, n_val, min_val, max_val)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [key, r.memo || '', r.category || '', r.count || 1,
         r.sum_val || 0, r.n_val || 0, r.min_val || null, r.max_val || null]
      );
    }

    merged++;
  }

  if (merged > 0) save();

  return { merged };
}

// ─────────────────────────────────────────────────────────────
// 4. Aplica alterações de conferência (cleared) feitas no mobile
// ─────────────────────────────────────────────────────────────
async function pullReconcileUpdates(all, run, first, save, userId) {
  const updates = await sb.select('mobile_reconcile_updates',
    { user_id: userId, status: 'pending' }
  );

  if (!updates.length) return { applied: 0, errors: 0 };

  let applied = 0;
  let errors  = 0;

  for (const upd of updates) {
    try {
      // desktop_id pode conter múltiplos ids separados por vírgula (transferências)
      const ids = String(upd.desktop_id).split(',').map(s => s.trim()).filter(Boolean);
      let anyFound = false;
      for (const id of ids) {
        const exists = first('SELECT id FROM transactions WHERE id=?', [id]);
        if (!exists) {
          console.log(`[sync:pull] reconciliação ${upd.id}: transação ${id} não encontrada (pode ter sido recriada por recorrência) — pulando`);
          continue;
        }
        anyFound = true;
        run('UPDATE transactions SET cleared=? WHERE id=?', [upd.is_reconciled ? 1 : 0, id]);
      }

      if (!anyFound) {
        // Nenhuma das transações referenciadas existe mais — provavelmente foi
        // recriada por syncRecurringTxns com outro ID. Marca como rejeitada
        // (em vez de applied) para deixar claro que não foi efetivamente aplicada.
        await sb.update('mobile_reconcile_updates', { id: upd.id }, {
          status: 'rejected',
        });
        errors++;
        continue;
      }

      await sb.update('mobile_reconcile_updates', { id: upd.id }, {
        status: 'applied',
        applied_at: new Date().toISOString(),
      });
      applied++;
    } catch (e) {
      console.error(`[sync:pull] Erro ao aplicar reconciliação ${upd.id}:`, e.message);
      await sb.update('mobile_reconcile_updates', { id: upd.id }, { status: 'rejected' }).catch(() => {});
      errors++;
    }
  }

  if (applied > 0) save();
  return { applied, errors };
}

// ─────────────────────────────────────────────────────────────
// 5. Aplica edições (e exclusões) de transações feitas no mobile
// (tela "Editar transação" grava aqui; até agora nada lia essa tabela,
// então editar no mobile nunca refletia no desktop). Exclusão usa a
// mesma tabela com `is_delete=true` — as colunas new_* ficam vazias
// nesse caso. A transação deletada some de mobile_transactions
// sozinha no próximo push (pruneNotIn já remove qualquer desktop_id
// que não exista mais no SQLite local).
// ─────────────────────────────────────────────────────────────
async function pullEditRequests(all, run, first, save, userId) {
  const requests = await sb.select('mobile_edit_requests',
    { user_id: userId, status: 'pending' }
  );

  if (!requests.length) return { applied: 0, errors: 0 };

  let applied = 0;
  let errors  = 0;

  for (const req of requests) {
    try {
      const tx = first('SELECT id, transfer_id FROM transactions WHERE id=?', [req.desktop_id]);
      if (!tx) {
        console.log(`[sync:pull] edição ${req.id}: transação ${req.desktop_id} não encontrada — rejeitando`);
        await sb.update('mobile_edit_requests', { id: req.id }, { status: 'rejected' });
        errors++;
        continue;
      }
      // Perna de transferência: editar (ou excluir) só um lado desalinharia
      // o par — não suportado por enquanto.
      if (tx.transfer_id != null) {
        console.log(`[sync:pull] edição/exclusão ${req.id}: transação ${req.desktop_id} é perna de transferência — rejeitando`);
        await sb.update('mobile_edit_requests', { id: req.id }, { status: 'rejected' });
        errors++;
        continue;
      }

      if (req.is_delete) {
        run('DELETE FROM transactions WHERE id=?', [req.desktop_id]);
        await sb.update('mobile_edit_requests', { id: req.id }, { status: 'applied' });
        applied++;
        continue;
      }

      const newMemo   = req.new_memo   != null ? dec(req.new_memo) : null;
      const newAmount = req.new_amount != null ? Number(dec(req.new_amount)) / 100 : null;

      const sets   = [];
      const params = [];
      if (req.new_date)             { sets.push('date=?');     params.push(req.new_date); }
      if (newMemo != null)          { sets.push('memo=?');     params.push(newMemo); }
      if (newAmount != null && !isNaN(newAmount)) { sets.push('amount=?'); params.push(newAmount); }
      if (req.new_category)         { sets.push('category=?'); params.push(req.new_category); }

      if (sets.length) {
        params.push(req.desktop_id);
        run(`UPDATE transactions SET ${sets.join(', ')} WHERE id=?`, params);
      }

      // Não seta applied_at aqui (ao contrário de mobile_reconcile_updates)
      // por não haver certeza de que essa coluna existe em
      // mobile_edit_requests — só status, que com certeza existe (é
      // usado pelo próprio insert do mobile).
      await sb.update('mobile_edit_requests', { id: req.id }, { status: 'applied' });
      applied++;
    } catch (e) {
      console.error(`[sync:pull] Erro ao aplicar edição ${req.id}:`, e.message);
      await sb.update('mobile_edit_requests', { id: req.id }, { status: 'rejected' }).catch(() => {});
      errors++;
    }
  }

  if (applied > 0) save();
  return { applied, errors };
}

// ─────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────
async function pullAll(all, run, first, save, userId) {
  const results = {};

  try {
    results.quickEntries = await pullQuickEntries(all, run, first, save, userId);
  } catch (e) {
    console.error('[sync:pull] quickEntries falhou:', e.message);
    results.quickEntries = { error: e.message };
  }

  try {
    results.mlRules = await pullMlRules(all, run, first, save, userId);
  } catch (e) {
    console.error('[sync:pull] mlRules falhou:', e.message);
    results.mlRules = { error: e.message };
  }

  try {
    results.reconcile = await pullReconcileUpdates(all, run, first, save, userId);
  } catch (e) {
    console.error('[sync:pull] reconcile falhou:', e.message);
    results.reconcile = { error: e.message };
  }

  try {
    results.editRequests = await pullEditRequests(all, run, first, save, userId);
  } catch (e) {
    console.error('[sync:pull] editRequests falhou:', e.message);
    results.editRequests = { error: e.message };
  }

  console.log('[sync:pull] concluído:', results);
  return results;
}

module.exports = { pullAll };
