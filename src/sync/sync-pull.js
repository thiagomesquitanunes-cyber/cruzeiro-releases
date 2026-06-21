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

      // Converte centavos → reais e garante sinal negativo (despesa)
      const amount = -(Math.abs(entry.amount) / 100);
      const date   = entry.date || new Date().toISOString().slice(0, 10);

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
  const date   = entry.date || new Date().toISOString().slice(0, 10);
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

  console.log('[sync:pull] concluído:', results);
  return results;
}

module.exports = { pullAll };
