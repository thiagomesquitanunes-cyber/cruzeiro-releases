const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');

// Settings always stored in original userData (not redirected)
function getSettingsPath() {
  const base = app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..');
  return path.join(base, '_settings.json');
}
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8')); } catch(e) { return {}; }
}
function saveSettings(s) {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(s, null, 2));
}

function getDbPath() {
  const settings = loadSettings();
  const base = settings.dataDir
    ? settings.dataDir
    : (app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..'));
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  return path.join(base, 'cruzeiro_data.db');
}

let SQL, db, win;
let _loggingIn       = false; // true while transitioning from login to main window
let _encryptedDBBuf  = null;  // raw encrypted buffer waiting for password
let _dbPendingDecrypt = false; // true when DB is encrypted and not yet unlocked
const dbPath = (() => {
  // compute early for use in initDB
  return null; // will be computed after app ready
})();

// ── INIT DB ──
async function initDB() {
  const initSqlJs = require('sql.js');
  try {
    // Try packaged path first (asar.unpacked)
    if (app.isPackaged) {
      const wasmPath = path.join(
        process.resourcesPath, 'app.asar.unpacked',
        'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'
      );
      SQL = await initSqlJs({ locateFile: () => wasmPath });
    } else {
      SQL = await initSqlJs();
    }
  } catch(e) {
    // Fallback: try default (works in dev and some packaged configs)
    SQL = await initSqlJs();
  }

  const dp = getDbPath();
  if (fs.existsSync(dp)) {
    const buf = fs.readFileSync(dp);
    // If DB is encrypted, defer loading until password is provided at login
    // (password provided via settings:login-with-password)
    // If not encrypted, load directly
    if (isDBEncrypted(dp)) {
      // Store raw encrypted buffer — will be decrypted after login
      _encryptedDBBuf = buf;
      db = new SQL.Database(); // empty DB until password provided
      _dbPendingDecrypt = true;
    } else {
      db = new SQL.Database(buf);
      _dbPendingDecrypt = false;
    }
  } else {
    db = new SQL.Database();
    _dbPendingDecrypt = false;
  }

  db.run(`PRAGMA foreign_keys = ON;`);
  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      type       TEXT    NOT NULL,
      currency   TEXT    NOT NULL DEFAULT 'BRL',
      hidden     INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id   INTEGER NOT NULL,
      date         TEXT    NOT NULL,
      category     TEXT    NOT NULL DEFAULT '',
      memo         TEXT    NOT NULL DEFAULT '',
      amount       REAL    NOT NULL,
      cleared      INTEGER NOT NULL DEFAULT 0,
      transfer_id  INTEGER,
      recurring_id INTEGER,
      pat_asset_id INTEGER,
      pat_tx_id    INTEGER,
      created_at   TEXT    DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS recurring (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      category   TEXT    NOT NULL DEFAULT '',
      memo       TEXT    NOT NULL DEFAULT '',
      amount     REAL    NOT NULL,
      frequency  TEXT    NOT NULL,
      next_date  TEXT    NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS ml_rules (
      keyword  TEXT PRIMARY KEY,
      memo     TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      count    INTEGER NOT NULL DEFAULT 1,
      sum_val  REAL NOT NULL DEFAULT 0,
      n_val    INTEGER NOT NULL DEFAULT 0,
      min_val  REAL,
      max_val  REAL
    );
    CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_tx_date    ON transactions(date);
  `);
  // Patrimônio tables (added in v2.0)
  db.run(`
    CREATE TABLE IF NOT EXISTS pat_assets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      asset_type  TEXT    NOT NULL DEFAULT 'imovel',
      trend       TEXT    NOT NULL DEFAULT 'ipca',
      sort_order  INTEGER NOT NULL DEFAULT 0,
      sold_month  TEXT,
      sold_value  REAL,
      hidden      INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pat_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id    INTEGER NOT NULL REFERENCES pat_assets(id) ON DELETE CASCADE,
      month       TEXT    NOT NULL,
      value       REAL    NOT NULL,
      manual      INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    DEFAULT (datetime('now')),
      UNIQUE(asset_id, month)
    );
    CREATE TABLE IF NOT EXISTS pat_accounts (
      account_id  INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      included    INTEGER NOT NULL DEFAULT 1,
      sort_order  INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS pat_financing (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id     INTEGER NOT NULL REFERENCES pat_assets(id) ON DELETE CASCADE,
      month        TEXT    NOT NULL,
      installment  REAL    NOT NULL,
      principal    REAL,
      interest     REAL,
      correction   REAL,
      balance_end  REAL,
      is_projection INTEGER NOT NULL DEFAULT 1,
      paid         INTEGER NOT NULL DEFAULT 0,
      UNIQUE(asset_id, month)
    );
    CREATE TABLE IF NOT EXISTS pat_financing_contracts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id          INTEGER NOT NULL UNIQUE REFERENCES pat_assets(id) ON DELETE CASCADE,
      system            TEXT    NOT NULL DEFAULT 'SAC',
      index_type        TEXT    NOT NULL DEFAULT 'none',
      annual_rate       REAL    NOT NULL DEFAULT 0,
      principal         REAL    NOT NULL DEFAULT 0,
      n_installments    INTEGER NOT NULL DEFAULT 0,
      first_month       TEXT    NOT NULL,
      balloon_at_keys   REAL,
      extra_annual_month INTEGER,
      extra_annual_value REAL,
      notes             TEXT,
      created_at        TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pat_history_asset ON pat_history(asset_id, month);
    CREATE TABLE IF NOT EXISTS pat_transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id    INTEGER NOT NULL REFERENCES pat_assets(id) ON DELETE CASCADE,
      month       TEXT    NOT NULL,
      tx_type     TEXT    NOT NULL,
      total_value REAL    NOT NULL,
      notes       TEXT,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pat_tx_asset ON pat_transactions(asset_id, month);
    CREATE TABLE IF NOT EXISTS inv_assets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      code          TEXT,
      category      TEXT    NOT NULL,
      inv_type      TEXT    NOT NULL,
      sort_order    INTEGER NOT NULL DEFAULT 0,
      closed_month  TEXT,
      hidden        INTEGER NOT NULL DEFAULT 0,
      notes         TEXT,
      broker        TEXT,
      maturity_month TEXT,
      liquidity     TEXT    DEFAULT 'vencimento',
      liquidity_days INTEGER,
      benchmark       TEXT    DEFAULT 'cdi',
      created_at    TEXT    DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS inv_transactions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id    INTEGER NOT NULL REFERENCES inv_assets(id) ON DELETE CASCADE,
      month       TEXT    NOT NULL,
      tx_type     TEXT    NOT NULL,
      qty         REAL,
      unit_value  REAL,
      total_value REAL    NOT NULL,
      notes       TEXT,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_inv_tx_asset ON inv_transactions(asset_id, month);
  `)
  try { db.run(`ALTER TABLE inv_assets ADD COLUMN benchmark TEXT DEFAULT 'cdi'`); } catch(e) {};

  // No default account seeds — user creates their own accounts on first run

  // Ensure missing accounts exist (migration for existing databases)
  // Migration: add sold_month/sold_value to pat_assets if missing
  try { db.run('ALTER TABLE pat_assets ADD COLUMN sold_month TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE pat_assets ADD COLUMN sold_value REAL'); } catch(e) {}
  try { db.run('ALTER TABLE pat_assets ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE pat_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE inv_assets ADD COLUMN broker TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE inv_assets ADD COLUMN maturity_month TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE inv_assets ADD COLUMN liquidity TEXT DEFAULT "vencimento"'); } catch(e) {}
  try { db.run('ALTER TABLE inv_assets ADD COLUMN liquidity_days INTEGER'); } catch(e) {}
  try { db.run('ALTER TABLE pat_assets ADD COLUMN financed INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE pat_assets ADD COLUMN financing_total REAL'); } catch(e) {}
  try { db.run('ALTER TABLE pat_financing ADD COLUMN principal REAL'); } catch(e) {}
  try { db.run('ALTER TABLE pat_financing ADD COLUMN interest REAL'); } catch(e) {}
  try { db.run('ALTER TABLE pat_financing ADD COLUMN correction REAL'); } catch(e) {}
  try { db.run('ALTER TABLE pat_financing ADD COLUMN balance_end REAL'); } catch(e) {}
  try { db.run('ALTER TABLE pat_financing ADD COLUMN is_projection INTEGER NOT NULL DEFAULT 1'); } catch(e) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS pat_financing_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL UNIQUE REFERENCES pat_assets(id) ON DELETE CASCADE,
    system TEXT NOT NULL DEFAULT 'SAC', index_type TEXT NOT NULL DEFAULT 'none',
    annual_rate REAL NOT NULL DEFAULT 0, principal REAL NOT NULL DEFAULT 0,
    n_installments INTEGER NOT NULL DEFAULT 0, first_month TEXT NOT NULL,
    balloon_at_keys REAL, extra_annual_month INTEGER, extra_annual_value REAL,
    notes TEXT, created_at TEXT DEFAULT (datetime('now')))`); } catch(e) {}
  // Load financing index data
  try {
    const idxPath = getDbPath().replace('.db', '_financing_indexes.json');
    if (!global._financingIndexes) global._financingIndexes = {};
    if (require('fs').existsSync(idxPath)) global._financingIndexes = JSON.parse(require('fs').readFileSync(idxPath,'utf8'));
  } catch(e) {}
  try { db.run('ALTER TABLE transactions ADD COLUMN pat_asset_id INTEGER'); } catch(e) {}
  try { db.run('ALTER TABLE transactions ADD COLUMN pat_tx_id INTEGER'); } catch(e) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS pat_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL REFERENCES pat_assets(id) ON DELETE CASCADE,
    month TEXT NOT NULL, tx_type TEXT NOT NULL, total_value REAL NOT NULL,
    notes TEXT, created_at TEXT DEFAULT (datetime('now')))`); } catch(e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_pat_tx_asset ON pat_transactions(asset_id, month)'); } catch(e) {}
  // Financial goals table
  db.run(`CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'target',
    -- type: 'target' (save X total), 'monthly' (save X/month), 'emergency' (N months expenses)
    target_amount REAL,
    monthly_amount REAL,
    emergency_months INTEGER,
    account_id INTEGER,
    -- optional linked account whose balance tracks progress
    deadline TEXT,
    -- ISO date YYYY-MM-DD
    icon TEXT DEFAULT '🎯',
    color TEXT DEFAULT '#2563eb',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (date('now'))
  )`);

  // Budget limits table
  db.run(`CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL UNIQUE,
    monthly_limit REAL NOT NULL,
    alert_pct INTEGER DEFAULT 80,
    active INTEGER DEFAULT 1
  )`);

  try { db.run(`CREATE TABLE IF NOT EXISTS pat_financing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL REFERENCES pat_assets(id) ON DELETE CASCADE,
    month TEXT NOT NULL, installment REAL NOT NULL, paid INTEGER NOT NULL DEFAULT 0,
    UNIQUE(asset_id, month))`); } catch(e) {}
  save();
}

// ── DB HELPERS ──
function save() {
  // CRITICAL: never write to disk while DB is pending decryption (would overwrite encrypted file with empty DB)
  if (_dbPendingDecrypt) {
    console.warn('[Cruzeiro] save() skipped — DB not yet decrypted');
    return;
  }
  try {
    const data = db.export();
    const plain = Buffer.from(data);
    const toWrite = _dbKey ? encryptDB(plain, _dbKey, _dbSalt) : plain;
    fs.writeFileSync(getDbPath(), toWrite);
  } catch(e) {
    console.error('[Cruzeiro] Erro ao salvar banco:', e.message);
    if (win) win.webContents.send('db:error', { message: `Erro ao salvar dados: ${e.message}` });
  }
}
function all(sql, params=[]) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch(e) {
    console.error('[Cruzeiro] DB all:', sql.slice(0,80), e.message);
    throw e;
  }
}
function first(sql, params=[]) {
  const rows = all(sql, params);
  return rows[0] || null;
}
function run(sql, params=[]) {
  try {
    db.run(sql, params);
    const newId = db.exec('SELECT last_insert_rowid()')[0]?.values[0][0] || null;
    save();
    return newId;
  } catch(e) {
    console.error('[Cruzeiro] DB run:', sql.slice(0,80), e.message);
    if (win) win.webContents.send('db:error', { message: `Erro ao executar operação: ${e.message}` });
    throw e;
  }
}

// ── IPC ──

// Accounts
ipcMain.handle('accounts:list', () => all('SELECT * FROM accounts ORDER BY sort_order, name'));
ipcMain.handle('accounts:create', (_, { name, type, currency }) => {
  // Assign sort_order = max + 1 within same type group
  const maxOrder = first('SELECT MAX(sort_order) as m FROM accounts WHERE type=?', [type])?.m || 0;
  const id = run('INSERT INTO accounts (name,type,currency,sort_order) VALUES (?,?,?,?)', [name, type, currency||'BRL', maxOrder+1]);
  save();
  return first('SELECT * FROM accounts WHERE id=?', [id]);
});
ipcMain.handle('accounts:update', (_, { id, name, type, currency, hidden }) => {
  run('UPDATE accounts SET name=?,type=?,currency=?,hidden=? WHERE id=?', [name, type, currency, hidden?1:0, id]);
  save();
  return first('SELECT * FROM accounts WHERE id=?', [id]);
});
ipcMain.handle('accounts:delete', (_, id) => {
  run('DELETE FROM transactions WHERE account_id=?', [id]);
  run('DELETE FROM accounts WHERE id=?', [id]);
  save();
  return {ok:true};
});
ipcMain.handle('accounts:reorder', (_, orderedIds) => {
  orderedIds.forEach((id, i) => run('UPDATE accounts SET sort_order=? WHERE id=?', [i, id]));
  save();
  return {ok:true};
});
ipcMain.handle('accounts:balance', (_, id) => {
  const today = new Date().toISOString().slice(0,10);
  return (first('SELECT COALESCE(SUM(amount),0) as bal FROM transactions WHERE account_id=? AND date <= ?', [id, today])?.bal || 0);
});
ipcMain.handle('accounts:balance-before', (_, { accountId, beforeDate }) => {
  return (first('SELECT COALESCE(SUM(amount),0) as bal FROM transactions WHERE account_id=? AND date < ?', [accountId, beforeDate])?.bal || 0);
});

// Transactions
ipcMain.handle('tx:list', (_, { accountId, sortBy, order, fromDate }) => {
  const col = ['date','category','amount'].includes(sortBy) ? sortBy : 'date';
  const dir = order === 'asc' ? 'ASC' : 'DESC';
  let where = 'account_id=?';
  const params = [accountId];
  if (fromDate) { where += ' AND date >= ?'; params.push(fromDate); }
  // Always include future transactions (up to 90 days ahead) regardless of period filter
  // Within same date: income (positive) before expenses (negative)
  // Within same date: income (positive amount) always before expenses (negative)
  const amountSort = col === 'date' ? `, (CASE WHEN amount >= 0 THEN 0 ELSE 1 END) ASC` : '';
  const sql = fromDate
    ? `SELECT * FROM transactions WHERE (${where}) OR (account_id=? AND date > date('now') AND date <= date('now','+90 days')) ORDER BY ${col} ${dir}${amountSort}, id ASC`
    : `SELECT * FROM transactions WHERE (${where}) AND (date <= date('now') OR date <= date('now','+90 days')) ORDER BY ${col} ${dir}${amountSort}, id ASC`;
  if (fromDate) params.push(accountId);
  return all(sql, params);
});
ipcMain.handle('tx:create', (_, tx) => {
  const id = run(`INSERT INTO transactions (account_id,date,category,memo,amount,cleared,transfer_id,recurring_id,pat_asset_id,pat_tx_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [tx.account_id, tx.date, tx.category||'', tx.memo||'', tx.amount, tx.cleared||0, tx.transfer_id||null, tx.recurring_id||null, tx.pat_asset_id||null, tx.pat_tx_id||null]);
  pushUndo(`Criar "${tx.memo||tx.category||'lançamento'}"`, [
    { sql: 'DELETE FROM transactions WHERE id=?', params: [id] }
  ]);
  return first('SELECT * FROM transactions WHERE id=?', [id]);
});
ipcMain.handle('tx:update', (_, { id, date, category, memo, amount, cleared, pat_asset_id, pat_tx_id }) => {
  const old = first('SELECT * FROM transactions WHERE id=?', [id]);
  run('UPDATE transactions SET date=?,category=?,memo=?,amount=?,cleared=?,pat_asset_id=?,pat_tx_id=? WHERE id=?',
    [date, category, memo, amount, cleared?1:0, pat_asset_id||null, pat_tx_id||null, id]);

  // If this is part of a transfer, sync date and memo to the paired leg (invert amount)
  if (old?.transfer_id) {
    const paired = first('SELECT * FROM transactions WHERE transfer_id=? AND id!=?', [old.transfer_id, id]);
    if (paired) {
      run('UPDATE transactions SET date=?,memo=?,amount=? WHERE id=?',
        [date, memo, -amount, paired.id]);
    }
  }

  if (old) pushUndo(`Editar "${old.memo||old.category}"`, [
    { sql: 'UPDATE transactions SET date=?,category=?,memo=?,amount=?,cleared=? WHERE id=?',
      params: [old.date, old.category, old.memo, old.amount, old.cleared, id] },
    // Also restore paired leg if transfer
    ...(old.transfer_id ? [{
      sql: 'UPDATE transactions SET date=?,memo=?,amount=? WHERE transfer_id=? AND id!=?',
      params: [old.date, old.memo, old.amount, old.transfer_id, id]   // old.amount is original paired amount (inverted)
    }] : [])
  ]);
  save();
  return first('SELECT * FROM transactions WHERE id=?', [id]);
});
ipcMain.handle('tx:delete', (_, id) => {
  const tx = first('SELECT * FROM transactions WHERE id=?', [id]);
  if (tx?.transfer_id) run('DELETE FROM transactions WHERE transfer_id=? AND id!=?', [tx.transfer_id, id]);
  // If this is a future uncleared recurring tx, remember the exclusion so sync won't recreate it
  if (tx?.recurring_id && tx.cleared === 0 && tx.date >= new Date().toISOString().slice(0,10)) {
    try {
      migrateRecurring();
      run('INSERT OR IGNORE INTO recurring_excludes (recurring_id, date) VALUES (?,?)', [tx.recurring_id, tx.date]);
    } catch(e) {}
  }
  // Cascade: if linked to a pat_transaction, delete it too
  if (tx?.pat_tx_id) {
    run('DELETE FROM pat_transactions WHERE id=?', [tx.pat_tx_id]);
  }
  run('DELETE FROM transactions WHERE id=?', [id]);
  save();
  if (tx) pushUndo(`Excluir "${tx.memo||tx.category}"`, [
    { sql: 'INSERT INTO transactions (id,account_id,date,category,memo,amount,cleared,transfer_id) VALUES (?,?,?,?,?,?,?,?)',
      params: [tx.id, tx.account_id, tx.date, tx.category, tx.memo, tx.amount, tx.cleared, tx.transfer_id||null] },
    // Also remove the exclusion so undo restores correctly
    { sql: 'DELETE FROM recurring_excludes WHERE recurring_id=? AND date=?',
      params: [tx.recurring_id||0, tx.date] }
  ]);
  return {ok:true};
});

// Transfer
ipcMain.handle('tx:transfer', (_, { fromAccountId, toAccountId, date, amount, memo }) => {
  const maxRow = first('SELECT COALESCE(MAX(transfer_id),0) as m FROM transactions');
  const tid = (maxRow?.m || 0) + 1;
  run('INSERT INTO transactions (account_id,date,category,memo,amount,cleared,transfer_id) VALUES (?,?,?,?,?,0,?)',
    [fromAccountId, date, 'Transferência', memo||'Transferência', -Math.abs(amount), tid]);
  run('INSERT INTO transactions (account_id,date,category,memo,amount,cleared,transfer_id) VALUES (?,?,?,?,?,0,?)',
    [toAccountId, date, 'Transferência', memo||'Transferência', +Math.abs(amount), tid]);
  return {ok:true, transfer_id:tid};
});

// Universal financial file import
ipcMain.handle('financial:import', (_, { text, ext }) => {
  let byAccount = {};
  const extension = (ext||'').toLowerCase().replace('.','');
  
  if (['ofx','qfx','qbo'].includes(extension)) {
    byAccount = parseOFXText(text);
  } else if (extension === 'csv') {
    byAccount = parseCSVFinancial(text);
  } else {
    // Default: QIF (also handles .qif, .qmtf and unknown)
    byAccount = parseQIFMultiAccount(text);
  }

  const existingAccounts = all('SELECT * FROM accounts');
  function normAcc(s) { return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim(); }
  function findAccount(name) {
    const nname = normAcc(name);
    return existingAccounts.find(a => normAcc(a.name) === nname) || null;
  }

  const ins = `INSERT INTO transactions (account_id,date,category,memo,amount,cleared) VALUES (?,?,?,?,?,?)`;
  const checkDup = `SELECT id FROM transactions WHERE account_id=? AND date=? AND ABS(amount-?)<=0.01 AND memo=? LIMIT 1`;
  let totalInserted = 0, skipped = 0, duplicates = 0;
  const unknownAccounts = [];

  db.run('BEGIN');
  try {
    for (const [accName, txns] of Object.entries(byAccount)) {
      const acc = findAccount(accName);
      if (!acc) { unknownAccounts.push(accName); skipped += txns.length; continue; }
      for (const t of txns) {
        if (!t.date) { skipped++; continue; }
        const dup = first(checkDup, [acc.id, t.date, t.amount, t.memo]);
        if (dup) { duplicates++; continue; }
        db.run(ins, [acc.id, t.date, t.category||'', t.memo||'', t.amount, t.cleared?1:0]);
        totalInserted++;
      }
    }
    db.run('COMMIT');
  } catch(e) { db.run('ROLLBACK'); throw e; }
  save();
  return { count: totalInserted, skipped, duplicates, unknownAccounts };
});

// Import QIF — multi-account, batch insert
ipcMain.handle('qif:import', (_, { qifText }) => {
  // Parse into { accountName -> [txns] }
  const byAccount = parseQIFMultiAccount(qifText);

  // Load existing accounts for name matching
  const existingAccounts = all('SELECT * FROM accounts');
  function normAcc(s) { return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim(); }
  function findAccount(name) {
    const nname = normAcc(name);
    return existingAccounts.find(a => normAcc(a.name) === nname) || null;
  }

  const ins = `INSERT INTO transactions (account_id,date,category,memo,amount,cleared) VALUES (?,?,?,?,?,?)`;
  const checkDup = `SELECT id FROM transactions WHERE account_id=? AND date=? AND amount=? AND memo=? LIMIT 1`;
  let totalInserted = 0, skipped = 0, duplicates = 0;
  const unknownAccounts = [];

  // Single transaction wrapping all inserts for performance
  db.run('BEGIN');
  try {
    for (const [accName, txns] of Object.entries(byAccount)) {
      const acc = findAccount(accName);
      if (!acc) { unknownAccounts.push(accName); skipped += txns.length; continue; }
      for (const t of txns) {
        const dup = first(checkDup, [acc.id, t.date, t.amount, t.memo]);
        if (dup) { duplicates++; continue; }
        db.run(ins, [acc.id, t.date, t.category, t.memo, t.amount, t.cleared ? 1 : 0]);
        totalInserted++;
      }
    }
    db.run('COMMIT');
  } catch(e) {
    db.run('ROLLBACK');
    throw e;
  }
  save();
  return { count: totalInserted, skipped, duplicates, unknownAccounts };
});

// Import batch
ipcMain.handle('tx:import-batch', (_, { accountId, rows }) => {
  rows.forEach(r => run('INSERT INTO transactions (account_id,date,category,memo,amount,cleared) VALUES (?,?,?,?,?,0)',
    [accountId, r.date, r.category||'', r.memo||'', r.amount]));
  return { count: rows.length };
});

// Reports
ipcMain.handle('report:summary', (_, { fromDate, toDate, accountIds, excludeTransfers }) => {
  let where = 'WHERE 1=1';
  const p = [];
  if (fromDate) { where += ' AND t.date>=?'; p.push(fromDate); }
  if (toDate)   { where += ' AND t.date<=?'; p.push(toDate); }
  if (accountIds?.length) { where += ` AND t.account_id IN (${accountIds.map(()=>'?').join(',')})`; p.push(...accountIds); }
  if (excludeTransfers) { where += ` AND t.category NOT IN ('Transferência','Transferências') AND t.transfer_id IS NULL`; }
  return all(`SELECT t.category,
    SUM(CASE WHEN t.amount<0 THEN ABS(t.amount) ELSE 0 END) as expenses,
    SUM(CASE WHEN t.amount>0 THEN t.amount ELSE 0 END) as income,
    COUNT(*) as count
    FROM transactions t ${where} GROUP BY t.category ORDER BY expenses DESC`, p);
});
ipcMain.handle('report:monthly', (_, { fromDate, toDate, accountIds, excludeTransfers }) => {
  let where = 'WHERE 1=1'; const p = [];
  if (fromDate) { where += ' AND date>=?'; p.push(fromDate); }
  if (toDate)   { where += ' AND date<=?'; p.push(toDate); }
  if (accountIds?.length) { where += ` AND account_id IN (${accountIds.map(()=>'?').join(',')})`; p.push(...accountIds); }
  if (excludeTransfers) { where += ` AND category NOT IN ('Transferência','Transferências') AND transfer_id IS NULL`; }
  return all(`SELECT substr(date,1,7) as month,
    SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as expenses,
    SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) as income
    FROM transactions ${where} GROUP BY month ORDER BY month`, p);
});

// Monthly by category for trend chart
ipcMain.handle('report:monthly-by-category', (_, { fromDate, excludeTransfers }) => {
  let where = 'WHERE amount < 0';
  const p = [];
  if (fromDate) { where += ' AND date>=?'; p.push(fromDate); }
  if (excludeTransfers) { where += ` AND category NOT IN ('Transferência','Transferências') AND transfer_id IS NULL`; }
  return all(`SELECT substr(date,1,7) as month, category,
    SUM(ABS(amount)) as total
    FROM transactions ${where}
    GROUP BY month, category ORDER BY month, total DESC`, p);
});

// Future pending (not cleared, date > today)
ipcMain.handle('report:future-pending', () => {
  const today = new Date().toISOString().slice(0,10);
  return all(`SELECT t.*, a.name as account_name FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.date > ? AND t.cleared = 0
    AND t.category NOT IN ('Transferência','Transferências')
    AND t.transfer_id IS NULL
    ORDER BY t.date ASC, (CASE WHEN t.amount < 0 THEN 1 ELSE 0 END) ASC`, [today]);
});
ipcMain.handle('report:net-worth', (_, { date }) => {
  const d = date || new Date().toISOString().slice(0,10);
  return all(`SELECT a.id,a.name,a.type,a.currency,COALESCE(SUM(t.amount),0) as balance
    FROM accounts a LEFT JOIN transactions t ON t.account_id=a.id AND t.date<=?
    WHERE a.hidden=0 GROUP BY a.id ORDER BY a.type,a.sort_order`, [d]);
});

// Net worth over time (monthly snapshots)
ipcMain.handle('report:net-worth-history', () => {
  const months = all(`SELECT DISTINCT substr(date,1,7) as month FROM transactions ORDER BY month`);
  return months.map(({ month }) => {
    const snap = all(`SELECT a.id,a.name,a.type,a.currency,COALESCE(SUM(t.amount),0) as balance
      FROM accounts a LEFT JOIN transactions t ON t.account_id=a.id AND substr(t.date,1,7)<=?
      WHERE a.hidden=0 GROUP BY a.id`, [month]);
    let net = 0;
    snap.filter(r=>r.type!=='credit').forEach(r => {
      // Use 1:1 for simplicity (historical FX not stored)
      net += r.balance;
    });
    return { month, net };
  });
});

// Goals CRUD
ipcMain.handle('goal:list', () => all('SELECT * FROM goals WHERE active=1 ORDER BY id'));
ipcMain.handle('goal:save', (_, d) => {
  if (d.id) {
    run(`UPDATE goals SET name=?,type=?,target_amount=?,monthly_amount=?,emergency_months=?,
         account_id=?,deadline=?,icon=?,color=? WHERE id=?`,
      [d.name, d.type, d.target_amount||null, d.monthly_amount||null,
       d.emergency_months||null, d.account_id||null, d.deadline||null,
       d.icon||'🎯', d.color||'#2563eb', d.id]);
  } else {
    run(`INSERT INTO goals (name,type,target_amount,monthly_amount,emergency_months,account_id,deadline,icon,color)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      [d.name, d.type, d.target_amount||null, d.monthly_amount||null,
       d.emergency_months||null, d.account_id||null, d.deadline||null,
       d.icon||'🎯', d.color||'#2563eb']);
  }
  save();
  return { ok: true };
});
ipcMain.handle('goal:delete', (_, { id }) => {
  run('DELETE FROM goals WHERE id=?', [id]);
  save();
  return { ok: true };
});
// Get current balance of a linked account (for progress tracking)
ipcMain.handle('goal:account-balance', (_, { accountId }) => {
  const row = first(`SELECT SUM(amount) as bal FROM transactions WHERE account_id=?`, [accountId]);
  return row?.bal || 0;
});
// Get average monthly expenses (last 3 months) for emergency fund calculation
ipcMain.handle('goal:avg-monthly-expenses', () => {
  const rows = all(`
    SELECT substr(date,1,7) as month, SUM(ABS(amount)) as total
    FROM transactions
    WHERE amount < 0 AND transfer_id IS NULL
      AND date >= date('now','-3 months')
    GROUP BY month ORDER BY month DESC LIMIT 3`);
  if (!rows.length) return 0;
  return rows.reduce((s,r) => s + r.total, 0) / rows.length;
});
// Get average monthly savings (income - expenses, last 3 months)
ipcMain.handle('goal:avg-monthly-savings', () => {
  // Use up to 12 months of past data (excluding future months)
  const today = new Date().toISOString().slice(0, 7); // YYYY-MM
  const rows = all(`
    SELECT substr(date,1,7) as month,
      SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) as income,
      SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as expenses
    FROM transactions
    WHERE transfer_id IS NULL
      AND substr(date,1,7) <= ?
      AND date >= date('now','-12 months')
    GROUP BY month ORDER BY month DESC LIMIT 12`, [today]);
  if (!rows.length) return 0;
  // Filter months with actual data (both income and expenses > 0)
  const validRows = rows.filter(r => r.income > 0 || r.expenses > 0);
  if (!validRows.length) return 0;
  const avg = validRows.reduce((s,r) => s + (r.income - r.expenses), 0) / validRows.length;
  return avg; // can be negative (spending more than earning)
});

// Budget CRUD
ipcMain.handle('budget:list', () => all('SELECT * FROM budgets WHERE active=1 ORDER BY category'));
ipcMain.handle('budget:save', (_, { id, category, monthly_limit, alert_pct }) => {
  if (id) {
    run('UPDATE budgets SET category=?,monthly_limit=?,alert_pct=? WHERE id=?',
      [category, monthly_limit, alert_pct||80, id]);
  } else {
    run('INSERT OR REPLACE INTO budgets (category,monthly_limit,alert_pct,active) VALUES (?,?,?,1)',
      [category, monthly_limit, alert_pct||80]);
  }
  save();
  return { ok: true };
});
ipcMain.handle('budget:delete', (_, { id }) => {
  run('DELETE FROM budgets WHERE id=?', [id]);
  save();
  return { ok: true };
});
ipcMain.handle('budget:actuals', (_, { month }) => {
  // Return spending per category for a given month (YYYY-MM)
  const from = month + '-01';
  const to   = month + '-31';
  return all(`SELECT category,
    SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as spent,
    SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) as received
    FROM transactions
    WHERE date>=? AND date<=? AND transfer_id IS NULL
    GROUP BY category`, [from, to]);
});

// Budget: monthly budgeted vs actual by category
ipcMain.handle('report:budget', (_, { fromDate, toDate, excludeTransfers }) => {
  let where = 'WHERE 1=1'; const p = [];
  if (fromDate) { where += ' AND date>=?'; p.push(fromDate); }
  if (toDate)   { where += ' AND date<=?'; p.push(toDate); }
  if (excludeTransfers) { where += ` AND category NOT IN ('Transferência','Transferências') AND transfer_id IS NULL`; }
  // Monthly actuals by category
  const rows = all(`SELECT substr(date,1,7) as month, category,
    SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as expenses,
    SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) as income,
    COUNT(*) as count
    FROM transactions ${where}
    GROUP BY month, category ORDER BY month, expenses DESC`, p);
  return rows;
});
ipcMain.handle('ml:predict', (_, { desc, amount }) => {
  const key  = normKey(desc);
  const rules = all('SELECT * FROM ml_rules ORDER BY count DESC');
  let best = null, bestScore = 0;
  for (const r of rules) {
    let ds = 0;
    if (key === r.keyword) ds = 10;
    else if (key.includes(r.keyword)) ds = r.keyword.length / key.length * 8;
    else { const words = r.keyword.split(' ').filter(w=>w.length>3); const hits=words.filter(w=>key.includes(w)).length; if(hits>0) ds=hits/words.length*4; }
    if (!ds) continue;
    let vs = 0.5;
    if (r.n_val > 0) { const mean=r.sum_val/r.n_val; const dist=Math.abs(Math.abs(amount)-Math.abs(mean))/(Math.abs(mean)||1); vs=Math.max(0,1-dist); }
    const score = ds*(0.5+0.5*vs);
    if (score > bestScore) { bestScore=score; best=r; }
  }
  return best;
});
ipcMain.handle('ml:learn', (_, { desc, memo, category, amount }) => {
  const key = normKey(desc).substring(0,50); if (!key) return;
  const abs = Math.abs(amount||0);
  const ex  = first('SELECT * FROM ml_rules WHERE keyword=?', [key]);
  if (ex) {
    run('UPDATE ml_rules SET memo=?,category=?,count=count+1,sum_val=sum_val+?,n_val=n_val+1, min_val=CASE WHEN ?<min_val OR min_val IS NULL THEN ? ELSE min_val END, max_val=CASE WHEN ?>max_val OR max_val IS NULL THEN ? ELSE max_val END WHERE keyword=?',
      [memo||'', category||'', abs, abs, abs, abs, abs, key]);
  } else {
    run('INSERT INTO ml_rules (keyword,memo,category,count,sum_val,n_val,min_val,max_val) VALUES (?,?,?,1,?,1,?,?)',
      [key, memo||'', category||'', abs, abs, abs]);
  }
});
ipcMain.handle('ml:list',   () => all('SELECT * FROM ml_rules ORDER BY count DESC'));
ipcMain.handle('ml:clear',  () => { run('DELETE FROM ml_rules'); return {ok:true}; });
ipcMain.handle('ml:export', () => all('SELECT * FROM ml_rules'));
ipcMain.handle('ml:import', (_, rules) => {
  rules.forEach(r => {
    const ex = first('SELECT * FROM ml_rules WHERE keyword=?', [r.keyword]);
    if (ex) run('UPDATE ml_rules SET count=count+?,sum_val=sum_val+?,n_val=n_val+? WHERE keyword=?', [r.count||1, r.sum_val||0, r.n_val||0, r.keyword]);
    else run('INSERT INTO ml_rules (keyword,memo,category,count,sum_val,n_val,min_val,max_val) VALUES (?,?,?,?,?,?,?,?)',
      [r.keyword, r.memo||'', r.category||'', r.count||1, r.sum_val||0, r.n_val||0, r.min_val||null, r.max_val||null]);
  });
  return {ok:true};
});

// Train ML from all existing transactions that have memo+category
ipcMain.handle('ml:train-history', () => {
  const txns = all(`SELECT memo, category, amount FROM transactions
    WHERE memo != '' AND category != '' AND category != 'Transferência'
    ORDER BY id`);

  db.run('BEGIN');
  let trained = 0;
  try {
    for (const t of txns) {
      const key = normKey(t.memo).substring(0, 50);
      if (!key) continue;
      const abs = Math.abs(t.amount || 0);
      const ex  = first('SELECT * FROM ml_rules WHERE keyword=?', [key]);
      if (ex) {
        db.run(`UPDATE ml_rules SET memo=?, category=?, count=count+1,
          sum_val=sum_val+?, n_val=n_val+1,
          min_val=CASE WHEN ? < min_val OR min_val IS NULL THEN ? ELSE min_val END,
          max_val=CASE WHEN ? > max_val OR max_val IS NULL THEN ? ELSE max_val END
          WHERE keyword=?`,
          [t.memo, t.category, abs, abs, abs, abs, abs, key]);
      } else {
        db.run(`INSERT INTO ml_rules (keyword,memo,category,count,sum_val,n_val,min_val,max_val)
          VALUES (?,?,?,1,?,1,?,?)`,
          [key, t.memo, t.category, abs, abs, abs]);
      }
      trained++;
    }
    db.run('COMMIT');
  } catch(e) {
    db.run('ROLLBACK');
    throw e;
  }
  save();
  return { trained, total: txns.length };
});

// Recurring
// ── RECURRING ──
// Migration: add end_date if missing (safe to call multiple times)
function migrateRecurring() {
  try { db.run('ALTER TABLE recurring ADD COLUMN end_date TEXT'); } catch(e) {}
  // Fix: rename category 'caixa' → 'valor_em_caixa' in inv_assets (modal used wrong value)
  try { db.run("UPDATE inv_assets SET category='valor_em_caixa' WHERE category='caixa'"); } catch(e) {}
  // Fix: remove duplicate uncleared past recurring transactions (keep cleared ones, delete extra uncleared)
  // This cleans up the bug where syncRecurringTxns generated entries from next_date instead of today
  try {
    db.run(`DELETE FROM transactions
      WHERE cleared=0
        AND recurring_id IS NOT NULL
        AND date < date('now')
        AND id NOT IN (
          SELECT MIN(id) FROM transactions
          WHERE cleared=0 AND recurring_id IS NOT NULL AND date < date('now')
          GROUP BY recurring_id, date
        )`);
  } catch(e) {}
  // Track dates manually deleted from a recurring series (so syncRecurring respects them)
  try {
    db.run(`CREATE TABLE IF NOT EXISTS recurring_excludes (
      recurring_id INTEGER NOT NULL,
      date         TEXT    NOT NULL,
      PRIMARY KEY (recurring_id, date)
    )`);
  } catch(e) {}
  // Support transfer_from/to on recurring
  try { db.run('ALTER TABLE recurring ADD COLUMN transfer_to_account_id INTEGER'); } catch(e) {}
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0,10);
}
function addMonthsR(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0,10);
}
function nextOccurrence(dateStr, freq) {
  switch(freq) {
    case 'weekly':    return addDays(dateStr, 7);
    case 'biweekly':  return addDays(dateStr, 14);
    case 'bimonthly': return addMonthsR(dateStr, 2);
    case 'quarterly': return addMonthsR(dateStr, 3);
    case 'yearly':    return addMonthsR(dateStr, 12);
    default:          return addMonthsR(dateStr, 1); // monthly
  }
}

function generateFutureDates(rec) {
  const today  = new Date().toISOString().slice(0,10);
  const cutoff = addDays(today, 90);
  const horizon = rec.end_date ? (rec.end_date < cutoff ? rec.end_date : cutoff) : cutoff;
  const dates  = [];
  // Start from next_date, but advance past any dates before today
  let cur = rec.next_date;
  // Fast-forward to first occurrence >= today
  let safety = 0;
  while (cur < today && safety++ < 500) {
    const next = nextOccurrence(cur, rec.frequency);
    if (next <= cur) break;
    cur = next;
  }
  // Generate future dates up to horizon
  while (cur <= horizon && dates.length < 12) { // max 12 = ~1 year of monthly
    dates.push(cur);
    const next = nextOccurrence(cur, rec.frequency);
    if (next <= cur) break;
    cur = next;
  }
  return dates;
}

function syncRecurringTxns(rec) {
  // Collect excluded (manually deleted) dates for this recurring
  let excludedDates = new Set();
  try {
    const rows = all('SELECT date FROM recurring_excludes WHERE recurring_id=?', [rec.id]);
    rows.forEach(r => excludedDates.add(r.date));
  } catch(e) {}

  // Remove ALL uncleared future transactions for this recurring (including past-next_date)
  run('DELETE FROM transactions WHERE recurring_id=? AND cleared=0 AND date>=date("now")', [rec.id]);

  // Insert fresh, skipping excluded dates
  const dates = generateFutureDates(rec);
  let inserted = 0;
  dates.forEach(date => {
    if (excludedDates.has(date)) return; // skip manually excluded
    if (rec.transfer_to_account_id) {
      // Recurring transfer: create both legs with a shared transfer_id
      const maxRow = first('SELECT COALESCE(MAX(transfer_id),0) as m FROM transactions');
      const tid = (maxRow?.m || 0) + 1;
      run(`INSERT INTO transactions (account_id,date,category,memo,amount,cleared,transfer_id,recurring_id) VALUES (?,?,?,?,?,0,?,?)`,
        [rec.account_id, date, 'Transferência', rec.memo, -Math.abs(rec.amount), tid, rec.id]);
      run(`INSERT INTO transactions (account_id,date,category,memo,amount,cleared,transfer_id,recurring_id) VALUES (?,?,?,?,?,0,?,?)`,
        [rec.transfer_to_account_id, date, 'Transferência', rec.memo, Math.abs(rec.amount), tid, rec.id]);
    } else {
      run(`INSERT INTO transactions (account_id,date,category,memo,amount,cleared,recurring_id) VALUES (?,?,?,?,?,0,?)`,
        [rec.account_id, date, rec.category, rec.memo, rec.amount, rec.id]);
    }
    inserted++;
  });
  return inserted;
}

ipcMain.handle('recurring:list', () => all('SELECT * FROM recurring WHERE active=1 ORDER BY next_date'));

ipcMain.handle('recurring:create', (_, r) => {
  migrateRecurring();
  const id = run('INSERT INTO recurring (account_id,category,memo,amount,frequency,next_date,end_date,transfer_to_account_id) VALUES (?,?,?,?,?,?,?,?)',
    [r.account_id, r.category||'', r.memo||'', r.amount, r.frequency, r.next_date, r.end_date||null, r.transfer_to_account_id||null]);
  const rec = first('SELECT * FROM recurring WHERE id=?', [id]);
  const n = syncRecurringTxns(rec);
  save();
  return { rec, generated: n };
});

ipcMain.handle('recurring:delete', (_, id) => {
  run('DELETE FROM transactions WHERE recurring_id=? AND cleared=0 AND date>=date("now")', [id]);
  run('DELETE FROM recurring_excludes WHERE recurring_id=?', [id]);
  run('DELETE FROM recurring WHERE id=?', [id]);
  save();
  return { ok: true };
});

ipcMain.handle('recurring:update', (_, r) => {
  migrateRecurring();
  const old = first('SELECT * FROM recurring WHERE id=?', [r.id]);
  const amountChanged = old && Math.abs((old.amount || 0) - (r.amount || 0)) > 0.001;

  run('UPDATE recurring SET account_id=?,category=?,memo=?,amount=?,frequency=?,next_date=?,end_date=?,transfer_to_account_id=? WHERE id=?',
    [r.account_id, r.category||'', r.memo||'', r.amount, r.frequency, r.next_date, r.end_date||null, r.transfer_to_account_id||null, r.id]);

  if (amountChanged) {
    // Update amount only on future uncleared transactions (date >= today)
    // NEVER touch past transactions (date < today), regardless of cleared status
    run(`UPDATE transactions SET amount=? WHERE recurring_id=? AND date>=date('now') AND cleared=0`,
      [r.amount, r.id]);
    // For recurring transfers: also update the partner leg (same transfer_id, different account)
    // The partner leg has the inverted amount
    const futureTxns = all(`SELECT * FROM transactions WHERE recurring_id=? AND date>=date('now') AND cleared=0`, [r.id]);
    futureTxns.forEach(tx => {
      if (tx.transfer_id) {
        run(`UPDATE transactions SET amount=? WHERE transfer_id=? AND id!=? AND cleared=0`,
          [-r.amount, tx.transfer_id, tx.id]);
      }
    });
  }

  // Clear old excludes only if frequency/next_date changed (not just amount)
  const scheduleChanged = old && (old.frequency !== r.frequency || old.next_date !== r.next_date);
  if (scheduleChanged) {
    run('DELETE FROM recurring_excludes WHERE recurring_id=?', [r.id]);
  }

  const rec = first('SELECT * FROM recurring WHERE id=?', [r.id]);
  const n = syncRecurringTxns(rec);
  save();
  return { rec, generated: n };
});

ipcMain.handle('recurring:refresh', () => {
  migrateRecurring();
  const recs = all('SELECT * FROM recurring WHERE active=1');
  let total = 0;
  recs.forEach(rec => { total += syncRecurringTxns(rec); });
  save();
  return { ok: true, generated: total };
});

// Dialogs
ipcMain.handle('dialog:confirm', async (_, { message, detail }) => {
  const result = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Cancelar', 'Excluir'],
    defaultId: 1,
    cancelId: 0,
    message: message || 'Confirmar',
    detail: detail || '',
  });
  return result.response === 1;
});

ipcMain.handle('dialog:open-file', async (_, { filters, encoding }) => {
  const res = await dialog.showOpenDialog(win, { properties:['openFile'], filters: filters||[] });
  if (res.canceled) return null;
  const enc = encoding || 'utf8';
  if (enc === 'binary') {
    // Return as base64 so it survives IPC serialization
    return { base64: fs.readFileSync(res.filePaths[0]).toString('base64'), path: res.filePaths[0] };
  }
  // Try utf8 first, fall back to latin1 for OFX/QFX files
  try { return { text: fs.readFileSync(res.filePaths[0], 'utf8'), path: res.filePaths[0] }; }
  catch(e) { return { text: fs.readFileSync(res.filePaths[0], 'latin1'), path: res.filePaths[0] }; }
});
ipcMain.handle('dialog:save-file', async (_, { defaultPath, content }) => {
  const res = await dialog.showSaveDialog(win, { defaultPath });
  if (res.canceled) return false;
  fs.writeFileSync(res.filePath, content, 'utf8');
  return true;
});

// ── OFX / QFX / QBO PARSER ──
function parseOFXText(text) {
  // Handles both SGML OFX (old) and XML OFX (new)
  const byAccount = {};
  
  // Try to find account ID/name
  function getTag(block, tag) {
    const m = new RegExp(`<${tag}>([^<\r\n]+)`, 'i').exec(block);
    return m ? m[1].trim() : '';
  }
  
  // Find all statement transactions (STMTTRN blocks)
  const stmtRegex = /<STMTTRNRS>([\s\S]*?)<\/STMTTRNRS>|<CCSTMTTRNRS>([\s\S]*?)<\/CCSTMTTRNRS>/gi;
  let stmtMatch;
  
  while ((stmtMatch = stmtRegex.exec(text)) !== null) {
    const stmtBlock = stmtMatch[1] || stmtMatch[2];
    
    // Get account ID from this statement
    const acctId = getTag(stmtBlock, 'ACCTID') || getTag(stmtBlock, 'BANKID') || '__default__';
    const acctName = acctId; // will be matched by user
    if (!byAccount[acctName]) byAccount[acctName] = [];
    
    const txRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
    let txMatch;
    while ((txMatch = txRegex.exec(stmtBlock)) !== null) {
      const block = txMatch[1];
      const dateRaw = getTag(block, 'DTPOSTED') || getTag(block, 'DTUSER');
      const amount  = parseFloat(getTag(block, 'TRNAMT').replace(',', '.')) || 0;
      const memo    = getTag(block, 'MEMO') || getTag(block, 'NAME') || getTag(block, 'PAYEE') || '';
      const category= getTag(block, 'SIC') || '';
      if (!dateRaw) continue;
      // Parse OFX date: YYYYMMDD or YYYYMMDDHHMMSS[.000[-TZ]]
      const y = dateRaw.slice(0,4), mo = dateRaw.slice(4,6), d = dateRaw.slice(6,8);
      const date = `${y}-${mo}-${d}`;
      byAccount[acctName].push({ date, memo, amount, category, cleared: true });
    }
  }
  
  // Fallback: SGML-style (no closing tags) — common in older OFX
  if (Object.keys(byAccount).length === 0) {
    const lines = text.split(/\r?\n/);
    let cur = {}, acct = '__default__';
    if (!byAccount[acct]) byAccount[acct] = [];
    for (const line of lines) {
      const m = line.match(/^<([A-Z]+)>(.*)$/);
      if (!m) continue;
      const [, tag, val] = m;
      if (tag === 'DTPOSTED') { const v=val.trim(); cur.date=`${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`; }
      else if (tag === 'TRNAMT') cur.amount = parseFloat(val.replace(',','.')) || 0;
      else if (tag === 'MEMO')   cur.memo = val.trim();
      else if (tag === 'NAME')   cur.memo = cur.memo || val.trim();
      else if (tag === 'ACCTID') acct = val.trim();
      else if (tag === '^' || tag === 'STMTTRN' || tag === '/STMTTRN') {
        if (cur.date) { if (!byAccount[acct]) byAccount[acct]=[]; byAccount[acct].push({...cur, category:'', cleared:true}); }
        cur = {};
      }
    }
    if (cur.date) { if (!byAccount[acct]) byAccount[acct]=[]; byAccount[acct].push({...cur, category:'', cleared:true}); }
  }
  return byAccount;
}

// ── CSV PARSER (generic financial export) ──
function parseCSVFinancial(text) {
  const byAccount = {};
  // Remove BOM
  const clean = text.replace(/^\uFEFF/, '');
  // Detect delimiter
  const firstLine = clean.split(/\r?\n/)[0] || '';
  const sep = firstLine.split(';').length >= firstLine.split(',').length ? ';' : ',';
  const rows = clean.split(/\r?\n/).map(l => l.split(sep).map(c => c.replace(/^"|"$/g,'').trim()));
  if (rows.length < 2) return byAccount;
  
  const headers = rows[0].map(h => (h||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim());
  const find = (...keys) => keys.reduce((found, k) => found >= 0 ? found : headers.findIndex(h => h.includes(k)), -1);
  
  const dateCol  = find('data', 'date', 'dt');
  const memoCol  = find('descri', 'memo', 'histor', 'lancam', 'payee', 'transaction');
  const amtCol   = find('valor', 'amount', 'value', 'montante');
  const catCol   = find('categ', 'category');
  const acctCol  = find('conta', 'account', 'acct');
  
  if (dateCol < 0 || memoCol < 0 || amtCol < 0) return byAccount; // can't parse
  
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length < 2) continue;
    const rawDate = r[dateCol] || '';
    const rawMemo = r[memoCol] || '';
    const rawAmt  = r[amtCol]  || '';
    if (!rawDate || !rawMemo) continue;
    // Parse date
    const dm = rawDate.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    const ym = rawDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
    let date;
    if (ym) date = rawDate.slice(0,10);
    else if (dm) { const [,a,b,y]=dm; const yr=y.length===2?'20'+y:y; date=`${yr}-${b.padStart(2,'0')}-${a.padStart(2,'0')}`; }
    else continue;
    const neg = rawAmt.startsWith('-');
    const num = parseFloat(rawAmt.replace(/[^\d.,-]/g,'').replace('.','').replace(',','.')) * (neg?-1:1);
    const acct = acctCol >= 0 ? (r[acctCol]||'__default__') : '__default__';
    const cat  = catCol  >= 0 ? (r[catCol] ||'') : '';
    if (!byAccount[acct]) byAccount[acct] = [];
    byAccount[acct].push({ date, memo: rawMemo, amount: num, category: cat, cleared: false });
  }
  return byAccount;
}

// ── QIF PARSER ──
// Returns { accountName: [txns] }
function parseQIFMultiAccount(text) {
  const byAccount = {};
  let currentAccount = '__default__';
  let cur = {};
  let inCatSection = false;

  for (const rawLine of text.replace(/\r/g,'').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const tag = line[0], val = line.slice(1).trim();

    // Section headers
    if (tag === '!') {
      if (val === 'Account') { inCatSection = false; cur = {}; continue; }
      if (val.startsWith('Type:Cat')) { inCatSection = true; continue; }
      if (val.startsWith('Type:')) { inCatSection = false; cur = {}; continue; }
      continue;
    }
    if (inCatSection) continue;

    // Account name line (comes right after !Account)
    if (tag === 'N' && cur && Object.keys(cur).length === 0) {
      // Check if this is an account name (not inside a transaction)
      currentAccount = val;
      if (!byAccount[currentAccount]) byAccount[currentAccount] = [];
      continue;
    }

    if (tag === '^') {
      if (cur.date) {
        if (!byAccount[currentAccount]) byAccount[currentAccount] = [];
        byAccount[currentAccount].push({
          date:     cur.date || '',
          category: cur.category || '',
          memo:     cur.memo || '',
          amount:   cur.amount || 0,
          cleared:  cur.cleared || false,
        });
      }
      cur = {};
      continue;
    }

    if (tag === 'D') cur.date     = parseQIFDate(val);
    else if (tag === 'T') cur.amount   = parseQIFAmount(val);
    else if (tag === 'M') cur.memo     = val;
    else if (tag === 'L') cur.category = val.replace(/^\[|\]$/g, '');
    else if (tag === 'C') cur.cleared  = val === 'X' || val === '*';
    // P (payee) and N (check num) ignored
  }
  // Last pending transaction
  if (cur.date) {
    if (!byAccount[currentAccount]) byAccount[currentAccount] = [];
    byAccount[currentAccount].push({ date:cur.date||'', category:cur.category||'', memo:cur.memo||'', amount:cur.amount||0, cleared:cur.cleared||false });
  }
  return byAccount;
}
function parseQIFDate(s) {
  const clean = s.replace(/'/g,'/').trim();
  const m = clean.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) { const [,a,b,y]=m; const year=y.length===2?'20'+y:y; return `${year}-${b.padStart(2,'0')}-${a.padStart(2,'0')}`; }
  return clean;
}
function parseQIFAmount(s) {
  const neg=s.startsWith('-'); const abs=s.replace('-','').replace(/\./g,'').replace(',','.');
  return parseFloat(abs)*(neg?-1:1)||0;
}
function normKey(s) { return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim(); }

// ── WINDOW ──
// ── BACKUP ──
function getBackupDir() {
  const settings = loadSettings();
  const base = settings.dataDir
    ? settings.dataDir
    : (app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..'));
  return path.join(base, 'backups');
}

function doBackup() {
  try {
    const bdir = getBackupDir();
    if (!fs.existsSync(bdir)) fs.mkdirSync(bdir, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    const dest = path.join(bdir, `cruzeiro_data_${ts}.db`);
    fs.copyFileSync(getDbPath(), dest);
    // Keep only last 30 backups
    const files = fs.readdirSync(bdir)
      .filter(f => f.startsWith('cruzeiro_data_') && f.endsWith('.db'))
      .sort();
    if (files.length > 30) {
      files.slice(0, files.length - 30).forEach(f => {
        try { fs.unlinkSync(path.join(bdir, f)); } catch(e) {}
      });
    }
    return dest;
  } catch(e) {
    console.error('Backup error:', e.message);
    return null;
  }
}

ipcMain.handle('backup:now',  () => { const p = doBackup(); return { ok: !!p, path: p }; });
ipcMain.handle('backup:list', () => {
  const bdir = getBackupDir();
  if (!fs.existsSync(bdir)) return [];
  return fs.readdirSync(bdir)
    .filter(f => f.startsWith('cruzeiro_data_') && f.endsWith('.db'))
    .sort().reverse()
    .map(f => ({ name: f, path: path.join(bdir, f), size: fs.statSync(path.join(bdir,f)).size }));
});
ipcMain.handle('backup:restore', async (_, backupPath) => {
  const res = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Restaurar', 'Cancelar'], defaultId: 1,
    title: 'Restaurar backup',
    message: 'Isso substituirá TODOS os dados atuais pelo backup selecionado. Continuar?'
  });
  if (res.response !== 0) return { ok: false };
  doBackup(); // backup current before restore
  const buf = fs.readFileSync(backupPath);
  db = new SQL.Database(buf);
  save();
  return { ok: true };
});
ipcMain.handle('backup:open-folder', () => {
  const bdir = getBackupDir();
  if (!fs.existsSync(bdir)) fs.mkdirSync(bdir, { recursive: true });
  require('electron').shell.openPath(bdir);
  return { ok: true };
});

// ── UNDO ──
// Stack of { sql, params } pairs to reverse the last operation
let _undoStack = [];
const MAX_UNDO = 50;

function pushUndo(description, reverseOps) {
  _undoStack.push({ description, reverseOps, time: Date.now() });
  if (_undoStack.length > MAX_UNDO) _undoStack.shift();
}

ipcMain.handle('undo:peek',  () => _undoStack.length ? _undoStack[_undoStack.length-1].description : null);
ipcMain.handle('undo:apply', () => {
  const op = _undoStack.pop();
  if (!op) return { ok: false };
  db.run('BEGIN');
  try {
    op.reverseOps.forEach(({ sql, params }) => db.run(sql, params || []));
    db.run('COMMIT');
  } catch(e) {
    db.run('ROLLBACK');
    return { ok: false, error: e.message };
  }
  save();
  return { ok: true, description: op.description };
});
ipcMain.handle('undo:clear', () => { _undoStack = []; return { ok: true }; });

// ── GLOBAL SEARCH ──
ipcMain.handle('search:global', (_, { query, limit, accountId, category, type, cleared, dateFrom, dateTo, offset }) => {
  const n  = Math.min(limit || 50, 200);
  const off = offset || 0;
  const conditions = [];
  const params = [];

  if (query && query.trim()) {
    const q = `%${query.trim()}%`;
    conditions.push('(t.memo LIKE ? OR t.category LIKE ? OR t.amount LIKE ?)');
    params.push(q, q, q);
  }
  if (accountId) { conditions.push('t.account_id=?'); params.push(accountId); }
  if (category)  { conditions.push('t.category LIKE ?'); params.push(`%${category}%`); }
  if (dateFrom)  { conditions.push('t.date>=?'); params.push(dateFrom); }
  if (dateTo)    { conditions.push('t.date<=?'); params.push(dateTo); }
  if (type === 'income')   { conditions.push('t.amount>0'); }
  if (type === 'expense')  { conditions.push('t.amount<0 AND t.transfer_id IS NULL'); }
  if (type === 'transfer') { conditions.push('t.transfer_id IS NOT NULL'); }
  if (cleared === 1)  { conditions.push('t.cleared=1'); }
  if (cleared === 0)  { conditions.push('t.cleared=0'); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = all(
    `SELECT t.*, a.name as account_name,
       (SELECT SUM(amount) FROM transactions WHERE account_id=t.account_id AND date<=t.date AND id<=t.id) as running_balance
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     ${where}
     ORDER BY t.date DESC, (CASE WHEN t.amount < 0 THEN 1 ELSE 0 END) ASC, t.id DESC LIMIT ? OFFSET ?`,
    [...params, n, off]
  );
  const total = first(`SELECT COUNT(*) as c FROM transactions t ${where}`, params)?.c || 0;
  return { rows, total };
});

// ── INLINE EDIT (batch update fields) ──
ipcMain.handle('tx:clear-transfer-pair', (_, { transferId, cleared }) => {
  run('UPDATE transactions SET cleared=? WHERE transfer_id=?', [cleared ? 1 : 0, transferId]);
  return { ok: true };
});

ipcMain.handle('inv:monthly-totals', (_, { month }) => {
  // Return total investment value for a given month
  // Sum latest atualizacao tx_type per asset at or before the given month
  const rows = all(`
    SELECT t.asset_id, t.total_value
    FROM inv_transactions t
    INNER JOIN (
      SELECT asset_id, MAX(month) as latest_month
      FROM inv_transactions
      WHERE tx_type='atualizacao' AND month<=?
      GROUP BY asset_id
    ) latest ON t.asset_id=latest.asset_id AND t.month=latest.latest_month AND t.tx_type='atualizacao'
  `, [month]);
  return rows.reduce((sum, r) => sum + (r.total_value || 0), 0);
});

ipcMain.handle('tx:inline-update', (_, { id, field, value }) => {
  const allowed = ['memo','category','date','amount','cleared'];
  if (!allowed.includes(field)) return { ok: false };
  const old = first('SELECT * FROM transactions WHERE id=?', [id]);
  if (!old) return { ok: false };
  db.run(`UPDATE transactions SET ${field}=? WHERE id=?`, [value, id]);

  // Sync transfer pair for date, memo, and amount changes
  if (old.transfer_id && ['date','memo','amount'].includes(field)) {
    const paired = first('SELECT id FROM transactions WHERE transfer_id=? AND id!=?', [old.transfer_id, id]);
    if (paired) {
      const syncValue = field === 'amount' ? -value : value;
      db.run(`UPDATE transactions SET ${field}=? WHERE id=?`, [syncValue, paired.id]);
    }
  }

  save();
  pushUndo(`Editar ${field} de "${old.memo||old.category}"`, [
    { sql: `UPDATE transactions SET ${field}=? WHERE id=?`, params: [old[field], id] }
  ]);
  return { ok: true };
});

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw).digest('hex');
}

// ══ AES-256-GCM DATABASE ENCRYPTION ═════════════════════════════════════
//
// Architecture:
//   - DB encrypted with AES-256-GCM, key = PBKDF2(password, random_salt, 100k)
//   - Key never written to disk — lives only in _dbKey (memory)
//   - Recovery: _dbKey re-encrypted with PBKDF2(email+deviceId, code_salt)
//     stored in _recovery.enc — allows key recovery without knowing old password
//   - Emergency backup: plaintext .db.bak written locally before any key change
//
// File format: MAGIC(9) + salt(32) + iv(12) + authTag(16) + ciphertext
// Recovery format: same AES-GCM format, payload = raw 32-byte key

const DB_MAGIC  = Buffer.from('CRUZEIRO1'); // 9 bytes — detects encrypted files
const REC_MAGIC = Buffer.from('CRUZEROREC');// 10 bytes — recovery file marker

let _dbKey           = null;  // AES-256 key
let _dbSalt          = null;  // salt used to derive _dbKey (must match salt in encrypted file)in memory, never on disk

// ── Key derivation ──────────────────────────────────────────────────────
function deriveKey(password, salt, iterations = 100_000) {
  return crypto.pbkdf2Sync(String(password), salt, iterations, 32, 'sha256');
}

// Stable device identifier (MAC address hash) — used as pepper for recovery key
function getDeviceId() {
  try {
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    const macs = Object.values(nets).flat()
      .filter(n => !n.internal && n.mac && n.mac !== '00:00:00:00:00:00')
      .map(n => n.mac);
    if (macs.length) return crypto.createHash('sha256').update(macs[0]).digest('hex').slice(0, 16);
  } catch(e) {}
  return 'cruzeiro-device-fallback';
}

// ── AES-256-GCM encrypt/decrypt ─────────────────────────────────────────
function aesEncrypt(plainBuf, key, magic = DB_MAGIC, salt = null) {
  // salt must be the SAME salt used to derive the key via deriveKey()
  // If not provided, generate one — but then the caller must re-derive the key from it
  const s    = salt || crypto.randomBytes(32);
  const iv   = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc  = Buffer.concat([cipher.update(plainBuf), cipher.final()]);
  const tag  = cipher.getAuthTag();
  return Buffer.concat([magic, s, iv, tag, enc]);
}

function aesDecrypt(encBuf, key, magic = DB_MAGIC) {
  if (!encBuf.slice(0, magic.length).equals(magic)) {
    throw new Error('Formato inválido ou arquivo não criptografado com este método.');
  }
  let off = magic.length;
  const salt = encBuf.slice(off, off + 32); off += 32;
  const iv   = encBuf.slice(off, off + 12); off += 12;
  const tag  = encBuf.slice(off, off + 16); off += 16;
  const enc  = encBuf.slice(off);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
  // Throws if key is wrong (auth tag mismatch)
}

// ── DB-level helpers ────────────────────────────────────────────────────
function encryptDB(plainBuf, key, salt) {
  // salt must be the same salt that was used to derive key
  return aesEncrypt(plainBuf, key, DB_MAGIC, salt);
}

function decryptDBWithPassword(encBuf, password) {
  if (!encBuf.slice(0, DB_MAGIC.length).equals(DB_MAGIC)) return encBuf; // plaintext
  let off = DB_MAGIC.length;
  const salt = encBuf.slice(off, off + 32);
  const key  = deriveKey(password, salt);
  // aesDecrypt will throw if wrong password (GCM auth tag fails)
  const plain = aesDecrypt(encBuf, key, DB_MAGIC);
  _dbKey  = key;   // cache for subsequent saves
  _dbSalt = salt;  // same salt that's in the file — needed for save()
  return plain;
}

function isDBEncrypted(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const header = Buffer.alloc(DB_MAGIC.length);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, header, 0, DB_MAGIC.length, 0);
    fs.closeSync(fd);
    return header.equals(DB_MAGIC);
  } catch(e) { return false; }
}

// ── Recovery key management ─────────────────────────────────────────────
// Recovery file stores the raw 32-byte _dbKey encrypted with:
//   key = PBKDF2(email + deviceId, randomSalt, 50k)
// This means: knowing the email + having the device = can recover
// The 6-digit code is an additional OTP layer sent by email

function getRecoveryPath() {
  return getDbPath().replace('.db', '_recovery.enc');
}

function saveRecoveryKey(dbKey, email, otpCode) {
  if (!dbKey || !email) return;
  // Derive recovery encryption key from email + deviceId + OTP code
  // OTP makes the recovery file useless without the emailed code
  const deviceId = getDeviceId();
  const salt = crypto.randomBytes(32);
  const recKey = deriveKey(email.toLowerCase().trim() + deviceId + otpCode, salt, 50_000);
  // Store: REC_MAGIC + salt(32) + encrypted(dbKey)
  // We re-use aesEncrypt but with REC_MAGIC and the recKey
  const recBuf = aesEncrypt(dbKey, recKey, REC_MAGIC);
  // Prepend the PBKDF2 salt (needed for decryption)
  const final = Buffer.concat([salt, recBuf]);
  try {
    fs.writeFileSync(getRecoveryPath(), final);
  } catch(e) {
    console.error('[Recovery] Failed to save recovery key:', e.message);
  }
}

function loadRecoveryKey(email, otpCode) {
  const recPath = getRecoveryPath();
  if (!fs.existsSync(recPath)) throw new Error('Arquivo de recuperação não encontrado.');
  const buf = fs.readFileSync(recPath);
  const salt   = buf.slice(0, 32);
  const recBuf = buf.slice(32);
  const deviceId = getDeviceId();
  const recKey = deriveKey(email.toLowerCase().trim() + deviceId + otpCode, salt, 50_000);
  try {
    return aesDecrypt(recBuf, recKey, REC_MAGIC); // returns raw 32-byte dbKey
  } catch(e) {
    throw new Error('Código incorreto ou email não confere.');
  }
}

// ── Emergency plaintext backup ──────────────────────────────────────────
function writeEmergencyBackup(plainBuf) {
  try {
    const bakPath = getDbPath().replace('.db', '_emergency.db.bak');
    fs.writeFileSync(bakPath, plainBuf);
    console.log('[Security] Emergency backup written to:', bakPath);
  } catch(e) {
    console.error('[Security] Could not write emergency backup:', e.message);
  }
}

let loginWin = null;

function createLoginWindow() {
  loginWin = new BrowserWindow({
    width: 460, height: 640, resizable: false, center: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    title: 'Cruzeiro — Acesso',
    webPreferences: { preload: path.join(__dirname,'preload.js'), contextIsolation:true, nodeIntegration:false },
    frame: true, show: false,
  });
  // Inline HTML for login screen
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#1a1f2e;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;padding:32px}
    .card{background:#0f172a;border:1px solid #1e293b;border-radius:14px;padding:32px;width:320px}
    .logo{font-size:32px;font-weight:900;color:#f9a825;text-align:center;margin-bottom:4px}
    .appname{font-size:16px;font-weight:700;color:#60a5fa;text-align:center;margin-bottom:4px}
    .tagline{font-size:11px;color:#64748b;text-align:center;margin-bottom:24px}
    label{font-size:12px;color:#94a3b8;display:block;margin-bottom:4px}
    input{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font-size:14px;outline:none;margin-bottom:10px}
    input:focus{border-color:#3b82f6}
    .btn{width:100%;padding:10px;border-radius:8px;border:none;background:#004d40;color:#fff;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:8px}
    .btn:hover{background:#00695c}
    .btn-green{background:#16a34a}.btn-green:hover{background:#15803d}
    .err{color:#f87171;font-size:12px;min-height:15px;margin-bottom:6px}
    .ok{color:#4ade80;font-size:12px;min-height:15px;margin-bottom:6px}
    .link{background:none;border:none;color:#60a5fa;font-size:12px;cursor:pointer;text-decoration:underline;padding:0;width:100%;text-align:center;display:block;margin-top:4px}
    .link:hover{color:#93c5fd}
    .panel{display:none}.panel.active{display:block}
    hr{border:none;border-top:1px solid #1e293b;margin:16px 0}
    .hint{font-size:11px;color:#64748b;text-align:center;margin-bottom:12px}
    .code-input{text-align:center;letter-spacing:6px;font-size:22px;font-weight:700}
    .lang-pill{background:#1e293b;border:1px solid #334155;color:#94a3b8;border-radius:20px;padding:4px 12px;font-size:12px;cursor:pointer}
    .lang-pill.active{border-color:#3b82f6;color:#60a5fa;background:#1e3a5f}
  </style></head><body>
  <div class="card">
    <div class="logo">C$</div>
    <div class="appname">Cruzeiro</div>
    <div class="tagline" id="tagline">Gestao financeira pessoal</div>

    <!-- Language selector -->
    <div style="display:flex;gap:6px;justify-content:center;margin-bottom:16px">
      <button class="lang-pill" id="lng-pt" onclick="setLoginLang('pt')">🇧🇷 PT</button>
      <button class="lang-pill" id="lng-en" onclick="setLoginLang('en')">🇺🇸 EN</button>
      <button class="lang-pill" id="lng-es" onclick="setLoginLang('es')">🇪🇸 ES</button>
    </div>

    <!-- Panel 1: Login -->
    <div id="p-login" class="panel active">
      <label id="lbl-pw">Senha</label>
      <input type="password" id="pw" placeholder="Digite sua senha" autofocus>
      <div class="err" id="err-login"></div>
      <button class="btn" id="btn-enter" onclick="tryLogin()">Entrar</button>
      <button class="link" id="btn-forgot" onclick="showPanel('p-forgot')">Esqueci minha senha</button>
    </div>

    <!-- Panel 2: Forgot - send code -->
    <div id="p-forgot" class="panel">
      <div class="hint">Um codigo de 6 digitos sera enviado ao email cadastrado.</div>
      <div class="err" id="err-forgot"></div>
      <button class="btn" onclick="sendCode()">Enviar codigo por email</button>
      <hr>
      <div class="hint">Ja recebeu o codigo? Preencha abaixo:</div>
      <label>Codigo recebido</label>
      <input type="text" id="reset-code" class="code-input" placeholder="000000" maxlength="6">
      <label>Nova senha</label>
      <input type="password" id="new-pw" placeholder="Nova senha">
      <label>Confirmar nova senha</label>
      <input type="password" id="new-pw2" placeholder="Confirmar nova senha">
      <div class="err" id="err-reset"></div>
      <div class="ok"  id="ok-reset"></div>
      <button class="btn btn-green" onclick="doReset()">Redefinir senha</button>
      <button class="link" onclick="showPanel('p-login')">Voltar ao login</button>
    </div>
  </div>

  <script>
  const LOGIN_STRINGS = {
    pt: { tagline:'Gestao financeira pessoal', pw:'Senha', placeholder:'Digite sua senha', enter:'Entrar', forgot:'Esqueci minha senha', sendCode:'Enviar codigo por email', hint1:'Um codigo de 6 digitos sera enviado ao email cadastrado.', hint2:'Ja recebeu o codigo? Preencha abaixo:', codeLabel:'Codigo recebido', newPw:'Nova senha', confirmPw:'Confirmar nova senha', reset:'Redefinir senha', back:'Voltar ao login' },
    en: { tagline:'Personal finance management', pw:'Password', placeholder:'Enter your password', enter:'Sign in', forgot:'Forgot password', sendCode:'Send code by email', hint1:'A 6-digit code will be sent to your registered email.', hint2:'Already have the code? Fill in below:', codeLabel:'Received code', newPw:'New password', confirmPw:'Confirm new password', reset:'Reset password', back:'Back to login' },
    es: { tagline:'Gestion financiera personal', pw:'Contrasena', placeholder:'Ingrese su contrasena', enter:'Entrar', forgot:'Olvide mi contrasena', sendCode:'Enviar codigo por email', hint1:'Se enviara un codigo de 6 digitos al email registrado.', hint2:'Ya recibio el codigo? Complete a continuacion:', codeLabel:'Codigo recibido', newPw:'Nueva contrasena', confirmPw:'Confirmar contrasena', reset:'Restablecer contrasena', back:'Volver al login' },
  };
  let _loginLang = 'pt';
  function setLoginLang(lang) {
    _loginLang = lang;
    const s = LOGIN_STRINGS[lang] || LOGIN_STRINGS.pt;
    document.getElementById('tagline').textContent = s.tagline;
    document.getElementById('lbl-pw').textContent  = s.pw;
    document.getElementById('pw').placeholder       = s.placeholder;
    document.getElementById('btn-enter').textContent = s.enter;
    document.getElementById('btn-forgot').textContent = s.forgot;
    const hints = document.querySelectorAll('.hint');
    if (hints[0]) hints[0].textContent = s.hint1;
    if (hints[1]) hints[1].textContent = s.hint2;
    const labels = document.querySelectorAll('#p-forgot label');
    if (labels[0]) labels[0].textContent = s.codeLabel;
    if (labels[1]) labels[1].textContent = s.newPw;
    if (labels[2]) labels[2].textContent = s.confirmPw;
    document.getElementById('new-pw').placeholder  = s.newPw;
    document.getElementById('new-pw2').placeholder = s.confirmPw;
    document.querySelectorAll('[onclick*="sendCode"]')[0].textContent = s.sendCode;
    document.querySelectorAll('[onclick*="doReset"]')[0].textContent  = s.reset;
    document.querySelectorAll('[onclick*="p-login"]')[0].textContent  = s.back;
    document.querySelectorAll('.lang-pill').forEach(b => b.classList.toggle('active', b.id === 'lng-'+lang));
    // Persist language choice via IPC
    window.ff?.saveLang?.(lang).catch(()=>{});
  }
  // Auto-detect on load
  window.addEventListener('DOMContentLoaded', async () => {
    try {
      const s = await window.ff?.getSettings?.();
      const lang = s?.language || navigator.language?.slice(0,2) || 'pt';
      setLoginLang(['pt','en','es'].includes(lang) ? lang : 'pt');
    } catch(e) { setLoginLang('pt'); }
  });
    function showPanel(id) {
      ['p-login','p-forgot'].forEach(p => {
        const el = document.getElementById(p);
        el.className = el.id === id ? 'panel active' : 'panel';
      });
      if (id === 'p-login') document.getElementById('pw').focus();
    }

    document.getElementById('pw').addEventListener('keydown', e => {
      if (e.key === 'Enter') tryLogin();
    });
    document.getElementById('reset-code').addEventListener('keydown', e => {
      if (e.key === 'Enter') doReset();
    });

    async function tryLogin() {
      const pw = document.getElementById('pw').value;
      const ok = await window.ff?.checkPassword(pw);
      if (ok) {
        window.ff?.loginOk();
      } else {
        document.getElementById('err-login').textContent = 'Senha incorreta';
        document.getElementById('pw').value = '';
        document.getElementById('pw').focus();
      }
    }

    async function sendCode() {
      const errEl = document.getElementById('err-forgot');
      errEl.style.color = '#f87171';
      errEl.textContent = 'Enviando...';
      const result = await window.ff?.forgotPassword();
      if (result?.ok) {
        errEl.style.color = '#4ade80';
        errEl.textContent = 'Codigo enviado para ' + result.email + '. Verifique sua caixa de entrada.';
      } else {
        errEl.style.color = '#f87171';
        errEl.textContent = result?.error || 'Erro: nenhum email cadastrado. Defina um email ao configurar a senha.';
      }
    }

    async function doReset() {
      const code = document.getElementById('reset-code').value.trim();
      const pw1  = document.getElementById('new-pw').value;
      const pw2  = document.getElementById('new-pw2').value;
      const errEl = document.getElementById('err-reset');
      const okEl  = document.getElementById('ok-reset');
      errEl.textContent = ''; okEl.textContent = '';
      if (code.length !== 6)  { errEl.textContent = 'O codigo deve ter 6 digitos'; return; }
      if (!pw1)               { errEl.textContent = 'Informe a nova senha'; return; }
      if (pw1 !== pw2)        { errEl.textContent = 'As senhas nao coincidem'; return; }
      const result = await window.ff?.resetPassword({ code, newPassword: pw1 });
      if (result?.ok) {
        okEl.textContent = 'Senha redefinida! Entrando...';
        setTimeout(() => window.ff?.loginOk(), 1500);
      } else {
        errEl.textContent = result?.error || 'Codigo incorreto ou expirado';
      }
    }
  </script></body></html>`;
  const tmpPath = path.join(app.getPath('temp'), 'ff_login.html');
  fs.writeFileSync(tmpPath, html);
  loginWin.loadFile(tmpPath);
  loginWin.once('ready-to-show', () => loginWin.show());
  loginWin.on('closed', () => { console.log('[loginWin.closed] win=', !!win, '_loggingIn=', _loggingIn); if (!win && !_loggingIn) { console.log('[loginWin.closed] calling app.quit()'); app.quit(); } });
}

function createWindow(showImmediately = false) {
  win = new BrowserWindow({
    width:1280, height:800, minWidth:900, minHeight:600,
    webPreferences: { preload: path.join(__dirname,'preload.js'), contextIsolation:true, nodeIntegration:false },
    title:'Cruzeiro',
    show: showImmediately,
    backgroundColor: '#0f172a', // prevent white flash
  });
  win.loadFile(path.join(__dirname,'index.html'));
  if (!showImmediately) {
    win.once('ready-to-show', () => win.show());
  }
  // Log renderer errors instead of crashing
  win.webContents.on('render-process-gone', (e, details) => {
    console.error('[Renderer crashed]', details.reason, details.exitCode);
    if (details.reason !== 'clean-exit') {
      dialog.showErrorBox('Erro no app', `O app encontrou um erro: ${details.reason}\nCódigo: ${details.exitCode}`);
    }
  });
  win.webContents.on('did-fail-load', (e, code, desc) => {
    console.error('[Load failed]', code, desc);
  });
  win.on('closed', () => { if (loginWin) loginWin.close(); });
}

app.whenReady().then(async () => {
  try { await initDB(); } catch(e) { dialog.showErrorBox('Erro ao iniciar banco de dados', e.message); app.quit(); return; }
  if (!_dbPendingDecrypt) doBackup();
  // Only run these if DB is fully loaded (not pending decryption)
  if (!_dbPendingDecrypt) {
    try { migrateRecurring(); } catch(e) {}
    setImmediate(() => {
      try { const recs = all('SELECT * FROM recurring WHERE active=1'); recs.forEach(rec => syncRecurringTxns(rec)); save(); } catch(e) { console.error('syncRecurring startup:', e); }
    });
  }

  const settings = loadSettings();
  // Show login if DB is encrypted OR legacy passwordHash exists
  if (settings.hasEncryptedDB || _dbPendingDecrypt || settings.passwordHash) {
    createLoginWindow();
    // Don't pre-create main window — create it AFTER login so it loads with real DB
  } else {
    createWindow();
    setupAutoUpdater();
  }
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length===0) createWindow(); });
});
app.on('window-all-closed', () => { console.log('[window-all-closed] platform=', process.platform, '_loggingIn=', _loggingIn); if (process.platform!=='darwin' && !_loggingIn) app.quit(); });

// ── AUTO UPDATE (electron-updater) ──
let _autoUpdaterInitialized = false;
function setupAutoUpdater() {
  if (_autoUpdaterInitialized) return; // prevent double registration
  _autoUpdaterInitialized = true;
  // Only run in packaged app, not in dev mode
  if (!app.isPackaged) {
    console.log('[updater] Dev mode — skipping auto-update');
    return;
  }

  let autoUpdater;
  try {
    autoUpdater = require('electron-updater').autoUpdater;
  } catch(e) {
    console.log('[updater] electron-updater not available:', e.message);
    return;
  }

  _autoUpdaterRef = autoUpdater;
  autoUpdater.autoDownload = true;        // download silently in background
  autoUpdater.autoInstallOnAppQuit = true; // install when user quits

  autoUpdater.on('checking-for-update', () => {
    console.log('[updater] Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    win?.webContents.send('update-status', {
      type: 'available',
      version: info.version,
      message: `Nova versão ${info.version} disponível — baixando em background...`
    });
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[updater] App is up to date');
  });

  autoUpdater.on('download-progress', (progress) => {
    win?.webContents.send('update-status', {
      type: 'progress',
      percent: Math.round(progress.percent),
      message: `Baixando atualização... ${Math.round(progress.percent)}%`
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    win?.webContents.send('update-status', {
      type: 'ready',
      version: info.version,
      message: `Atualização ${info.version} pronta!`
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[updater] Error:', err.message);
  });

  // Check after 3 seconds (non-blocking)
  setTimeout(() => autoUpdater.checkForUpdates().catch(e => console.log('[updater]', e.message)), 3000);

  // (update:install registered globally below)
}

// Always register update:install so button never silently fails
let _autoUpdaterRef = null;
ipcMain.handle('update:install', () => {
  if (_autoUpdaterRef) {
    // isSilent=false: show progress, isForceRunAfter=true: relaunch after install
    // Must close all windows first so NSIS can replace files without "file in use" error
    if (win) win.hide();
    if (loginWin) loginWin.hide();
    setTimeout(() => {
      _autoUpdaterRef.quitAndInstall(false, true);
    }, 300); // small delay to let windows hide before installer runs
  }
});

ipcMain.handle('app:version', () => app.getVersion());

// ── IMPORT DEFAULTS (persist per-bank account selection) ──
ipcMain.handle('import-defaults:get', () => {
  try {
    const p = getDbPath().replace('.db','_import_defaults.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
  } catch(e) { return {}; }
});
ipcMain.handle('import-defaults:save', (_, defaults) => {
  try {
    fs.writeFileSync(getDbPath().replace('.db','_import_defaults.json'), JSON.stringify(defaults));
    return {ok:true};
  } catch(e) { return {ok:false}; }
});
// The renderer reads the file using FileReader + XLSX (already in index.html via CDN)
// and sends parsed rows here for DB insertion with duplicate detection.
// ── Round-2 duplicate check: same memo + category, ±7 days, any amount ──
// Targets recurring placeholders (uncleared future txns) whose amount varies
// month to month (condomínio, contas de consumo, etc).
ipcMain.handle('bank:check-memo-dups', (_, { accountId, rows }) => {
  const matches = [];
  for (let i = 0; i < (rows || []).length; i++) {
    const r = rows[i];
    if (!r || !r.memo || !r.dateISO) continue;
    try {
      const existing = all(
        `SELECT id, date, amount, memo, category FROM transactions
         WHERE account_id=? AND cleared=0
           AND LOWER(TRIM(memo)) = LOWER(TRIM(?))
           AND LOWER(TRIM(COALESCE(category,''))) = LOWER(TRIM(?))
           AND ABS(julianday(date) - julianday(?)) <= 7
         LIMIT 3`,
        [accountId, r.memo, r.category || '', r.dateISO]
      );
      if (existing.length) matches.push({ rowIndex: i, existing });
    } catch(e) { /* skip row on error */ }
  }
  return { matches };
});

ipcMain.handle('bank:import', (_, { accountId, rows, checkDailySaldo, skipIds, dryRun }) => {
  // dryRun: only check for dups, don't insert anything
  // skipIds = array of row indices the user chose to skip (confirmed duplicates)
  const skipSet = new Set(skipIds || []);

  // Find potential duplicates against DB (same account, date, amount)
  // We do NOT auto-skip — we report them so the user can decide
  const potentialDups = [];
  const toInsert = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const date = toISO(r.date);
    if (!date) continue;

    if (skipSet.has(i)) continue; // user chose to skip this one

    // Check DB for same account + similar amount (±R$1,00) within ±7 days
    // Tolerance of R$1 catches last-installment cent adjustments
    const existing = all(
      `SELECT id, memo FROM transactions WHERE account_id=?
       AND ABS(julianday(date) - julianday(?)) <= 7
       AND ABS(amount-?)<=1.00 LIMIT 3`,
      [accountId, date, r.amount]
    );

    if (existing.length > 0 && !skipSet.has(i)) {
      // Flag as potential dup — don't insert yet
      potentialDups.push({
        rowIndex: i,
        date: r.date,
        memo: r.memo || r.desc || '',
        amount: r.amount,
        existing: existing.map(e => ({ id: e.id, memo: e.memo })),
      });
    } else {
      toInsert.push({ i, date, r });
    }
  }

  // If there are unresolved potential dups, return them for user decision
  if (potentialDups.length > 0) {
    return { needsConfirmation: true, potentialDups, totalRows: rows.length };
  }

  // If dry run, just return the dup info without inserting
  if (dryRun) {
    return potentialDups.length > 0
      ? { needsConfirmation: true, potentialDups, totalRows: rows.length }
      : { needsConfirmation: false, potentialDups: [], totalRows: rows.length };
  }

  // Insert all approved rows
  let inserted = 0;
  db.run('BEGIN');
  try {
    for (const { date, r } of toInsert) {
      db.run('INSERT INTO transactions (account_id,date,category,memo,amount,cleared) VALUES (?,?,?,?,?,0)',
        [accountId, date, r.category || '', r.memo || r.desc || '', r.amount]);
      inserted++;
    }
    db.run('COMMIT');
  } catch(e) {
    db.run('ROLLBACK');
    throw e;
  }

  // Daily balance check (Itaú only — when rows contain saldo field)
  const dailyMismatches = [];
  if (checkDailySaldo) {
    const saldoRows = rows.filter(r => r.saldo !== undefined && r.saldo !== null);
    for (const r of saldoRows) {
      const date = toISO(r.date);
      if (!date) continue;
      const dbBal = first(
        'SELECT COALESCE(SUM(amount),0) as bal FROM transactions WHERE account_id=? AND date<=?',
        [accountId, date]
      )?.bal || 0;
      const diff = Math.abs(dbBal - r.saldo);
      if (diff > 0.02) {
        dailyMismatches.push({ date: r.date, expected: r.saldo, got: dbBal, diff });
      }
    }
  }

  save();
  return { inserted, duplicates: 0, dailyMismatches };
});

function toISO(dmy) {
  if (!dmy) return null;
  // DD/MM/YYYY → YYYY-MM-DD
  const m = String(dmy).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(dmy)) return dmy;
  return null;
}

// ── SAVED REPORTS ──
ipcMain.handle('saved-reports:list', () => {
  try { const p = getDbPath().replace('.db','_saved_reports.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : []; } catch(e) { return []; }
});
ipcMain.handle('saved-reports:save', (_, reports) => {
  try { fs.writeFileSync(getDbPath().replace('.db','_saved_reports.json'), JSON.stringify(reports,null,2)); return {ok:true}; } catch(e) { return {ok:false}; }
});

// ── HIERARCHICAL SUMMARY ──
ipcMain.handle('report:summary-hierarchical', (_, { fromDate, toDate, accountIds, excludeTransfers }) => {
  let where = 'WHERE 1=1'; const p = [];
  if (fromDate) { where += ' AND t.date>=?'; p.push(fromDate); }
  if (toDate)   { where += ' AND t.date<=?'; p.push(toDate); }
  if (accountIds?.length) { where += ` AND t.account_id IN (${accountIds.map(()=>'?').join(',')})`; p.push(...accountIds); }
  if (excludeTransfers) { where += ` AND t.category NOT IN ('Transferência','Transferências') AND t.transfer_id IS NULL`; }
  const rows = all(`SELECT t.category,
    SUM(CASE WHEN t.amount<0 THEN ABS(t.amount) ELSE 0 END) as expenses,
    SUM(CASE WHEN t.amount>0 THEN t.amount ELSE 0 END) as income,
    COUNT(*) as count FROM transactions t ${where} GROUP BY t.category ORDER BY t.category`, p);
  const tree = {};
  rows.forEach(r => {
    const parts = (r.category||'').split(':');
    const parent = parts[0];
    if (!tree[parent]) tree[parent] = { category:parent, expenses:0, income:0, count:0, children:[] };
    tree[parent].expenses += r.expenses; tree[parent].income += r.income; tree[parent].count += r.count;
    if (parts.length > 1) tree[parent].children.push(r);
  });
  const totalExp = rows.reduce((s,r)=>s+r.expenses,0);
  const totalInc = rows.reduce((s,r)=>s+r.income,0);
  return { tree: Object.values(tree).sort((a,b)=>a.category.localeCompare(b.category,'pt-BR')), totalExp, totalInc };
});


// ── OVERVIEW SETTINGS PERSISTENCE ──
ipcMain.handle('overview-config:get', () => {
  try {
    const p = getDbPath().replace('.db','_overview_config.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : null;
  } catch(e) { return null; }
});
ipcMain.handle('overview-config:save', (_, config) => {
  try {
    fs.writeFileSync(getDbPath().replace('.db','_overview_config.json'), JSON.stringify(config));
    return { ok: true };
  } catch(e) { return { ok: false }; }
});

// ── CATEGORY DETAIL REPORT ──
ipcMain.handle('report:category-detail', (_, { category, fromDate, toDate }) => {
  const params = [];
  let where = 'WHERE 1=1';
  if (category !== null && category !== undefined) {
    const cats = Array.isArray(category) ? category : [category];
    if (cats.length) {
      where += ` AND t.category IN (${cats.map(()=>'?').join(',')})`;
      params.push(...cats);
    }
  }
  if (fromDate) { where += ' AND t.date>=?'; params.push(fromDate); }
  if (toDate)   { where += ' AND t.date<=?'; params.push(toDate); }
  const rows = all(`
    SELECT t.id, t.date, t.category, t.memo, t.amount, t.cleared,
           a.name as account_name,
           CASE WHEN t.transfer_id IS NOT NULL THEN 1 ELSE 0 END as is_transfer
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    ${where}
    ORDER BY t.date ASC, (CASE WHEN t.amount < 0 THEN 1 ELSE 0 END) ASC, t.id ASC
  `, params);
  const totalInc = rows.filter(r=>r.amount>=0).reduce((s,r)=>s+r.amount,0);
  const totalExp = rows.filter(r=>r.amount<0).reduce((s,r)=>s+Math.abs(r.amount),0);
  return { rows, totalInc, totalExp, net: totalInc - totalExp };
});

// ── EVOLUÇÃO — IPCA e dados mensais ──
// IPCA stored in DB as monthly rates
ipcMain.handle('evolucao:ipca-get', () => {
  try {
    const p = getDbPath().replace('.db','_ipca.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
  } catch(e) { return {}; }
});
ipcMain.handle('evolucao:ipca-save', (_, data) => {
  try { fs.writeFileSync(getDbPath().replace('.db','_ipca.json'), JSON.stringify(data)); return {ok:true}; }
  catch(e) { return {ok:false}; }
});

// Fetch IPCA ANUAL from BCB API
// Série 433 = IPCA variação mensal (%)
// We fetch monthly data and compound to get annual rates for each complete year
// Also computes 2025 if enough months available
ipcMain.handle('evolucao:ipca-fetch', async () => {
  const https = require('https');
  const url = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados?formato=json';
  return new Promise((resolve) => {
    const req = https.get(url, { headers:{'User-Agent':'Cruzeiro/1.0'} }, res => {
      // Follow redirect if needed
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, { headers:{'User-Agent':'Cruzeiro/1.0'} }, res2 => {
          let body = '';
          res2.on('data', d => body += d);
          res2.on('end', () => processBody(body, resolve));
        }).on('error', e => resolve({ ok:false, error:e.message }));
        return;
      }
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => processBody(body, resolve));
    });
    req.on('error', e => resolve({ ok:false, error:e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ ok:false, error:'timeout' }); });
  });

  function processBody(body, resolve) {
    try {
      const arr = JSON.parse(body);
      // arr = [{data:"01/01/2012", valor:"0,86"}, ...]
      // Group monthly rates by year, then compound to annual
      const byYear = {}; // {2012: [0.0086, 0.0069, ...], ...}
      arr.forEach(item => {
        const parts = item.data.split('/');
        if (parts.length < 3) return;
        const year  = parseInt(parts[2]);
        const rate  = parseFloat(item.valor.replace(',', '.')) / 100;
        if (year < 2000 || isNaN(rate)) return;
        if (!byYear[year]) byYear[year] = [];
        byYear[year].push(rate);
      });

      // Compound monthly rates into annual
      const result = {};
      const currentYear = new Date().getFullYear();
      Object.entries(byYear).forEach(([year, rates]) => {
        const y = parseInt(year);
        // Only use complete years (12 months) OR current year with available months
        if (rates.length === 12) {
          // Full year: compound all 12
          result[y] = rates.reduce((acc, r) => acc * (1 + r), 1) - 1;
        } else if (y === currentYear && rates.length >= 1) {
          // Current year: compound available months (partial)
          result[y] = rates.reduce((acc, r) => acc * (1 + r), 1) - 1;
        }
      });

      resolve({ ok:true, data:result, count:Object.keys(result).length });
    } catch(e) {
      resolve({ ok:false, error:e.message });
    }
  }
});

// Monthly summary for Evolução tab
ipcMain.handle('evolucao:monthly-summary', (_, { excludedCats, includedCats, consolidatedParents }) => {
  let where = "WHERE date >= '2000-01-01' AND transfer_id IS NULL AND (category IS NOT NULL AND category != '') AND category NOT IN ('Transferência','Transferências','Transferencia','Transferencias')";
  const p = [];
  if (excludedCats?.length) {
    where += ` AND category NOT IN (${excludedCats.map(()=>'?').join(',')})`;
    p.push(...excludedCats);
  }
  if (includedCats?.length || consolidatedParents?.length) {
    const parts = [];
    // Exact matches
    if (includedCats?.length) {
      parts.push(`category IN (${includedCats.map(()=>'?').join(',')})`);
      p.push(...includedCats);
    }
    // Consolidated parents: match parent AND all its subcats
    if (consolidatedParents?.length) {
      consolidatedParents.forEach(parent => {
        parts.push(`category LIKE ?`);
        p.push(parent + ':%');
      });
    }
    if (parts.length) where += ` AND (${parts.join(' OR ')})`;
  }
  return all(`SELECT substr(date,1,7) as month,
    SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as expenses,
    SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) as income,
    COUNT(*) as count
    FROM transactions ${where}
    GROUP BY month ORDER BY month`, p);
});

ipcMain.handle('evolucao:monthly-by-category', (_, { excludedCats, includedCats, consolidatedParents }) => {
  let where = "WHERE date >= '2000-01-01' AND transfer_id IS NULL AND (category IS NOT NULL AND category != '') AND category NOT IN ('Transferência','Transferências','Transferencia','Transferencias')";
  const p = [];
  if (excludedCats?.length) {
    where += ` AND category NOT IN (${excludedCats.map(()=>'?').join(',')})`;
    p.push(...excludedCats);
  }
  if (includedCats?.length || consolidatedParents?.length) {
    const parts = [];
    if (includedCats?.length) {
      parts.push(`category IN (${includedCats.map(()=>'?').join(',')})`);
      p.push(...includedCats);
    }
    if (consolidatedParents?.length) {
      consolidatedParents.forEach(parent => {
        parts.push(`category LIKE ?`);
        p.push(parent + ':%');
      });
    }
    if (parts.length) where += ` AND (${parts.join(' OR ')})`;
  }
  return all(`SELECT substr(date,1,7) as month, category,
    SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as expenses,
    SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) as income
    FROM transactions ${where}
    GROUP BY month, category ORDER BY month, expenses DESC`, p);
});

// ── CATEGORY TYPES (income/expense classification) ──
ipcMain.handle('cat-types:get', () => {
  try {
    const p = getDbPath().replace('.db','_cat_types.json');
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
  } catch(e) { return {}; }
});
ipcMain.handle('cat-types:save', (_, data) => {
  try { fs.writeFileSync(getDbPath().replace('.db','_cat_types.json'), JSON.stringify(data)); return {ok:true}; }
  catch(e) { return {ok:false}; }
});

// ══ PATRIMÔNIO ══

// ── Assets (Patrimônio Imobilizado) ──
ipcMain.handle('pat:assets-list', () =>
  all('SELECT * FROM pat_assets ORDER BY sort_order, id')
);

ipcMain.handle('pat:asset-save', (_, { id, name, asset_type, trend, sort_order, sold_month, sold_value, hidden, financed, financing_total }) => {
  if (id) {
    run('UPDATE pat_assets SET name=?,asset_type=?,trend=?,sort_order=?,sold_month=?,sold_value=?,hidden=?,financed=?,financing_total=? WHERE id=?',
      [name, asset_type, trend, sort_order ?? 0, sold_month||null, sold_value||null, hidden?1:0, financed?1:0, financing_total??null, id]);
    if (sold_month) {
      db.run('DELETE FROM pat_history WHERE asset_id=? AND month>? AND manual=0', [id, sold_month]);
      save();
    }
    return { id };
  } else {
    const newId = run('INSERT INTO pat_assets (name,asset_type,trend,sort_order,sold_month,sold_value,hidden,financed,financing_total) VALUES (?,?,?,?,?,?,?,?,?)',
      [name, asset_type, trend, sort_order ?? 0, sold_month||null, sold_value||null, hidden?1:0, financed?1:0, financing_total??null]);
    const resolvedId = newId || first('SELECT id FROM pat_assets WHERE name=? ORDER BY id DESC LIMIT 1', [name])?.id;
    return { id: resolvedId };
  }
});

ipcMain.handle('pat:asset-delete', (_, { id }) => {
  run('DELETE FROM pat_assets WHERE id=?', [id]);
  save();
  return { ok: true };
});

// ── Broker (corretora) import handler ──
ipcMain.handle('broker:import', (_, { base64, brokerId, customConfig }) => {
  const buf = Buffer.from(base64, 'base64');

  // We parse in the renderer (XLSX) but store results here
  // This handler receives already-parsed data and writes to DB
  throw new Error('Use broker:save-parsed instead');
});

ipcMain.handle('broker:create-adjustment', (_, { accountId, month, totalLiquido, broker }) => {
  // Find the most recent balance for this account before or at month end
  const monthEnd = month + '-31'; // close enough for string comparison
  const lastTx = first(
    `SELECT SUM(amount) as total FROM transactions WHERE account_id=? AND date<=?`,
    [accountId, monthEnd]
  );
  const currentBalance = lastTx?.total || 0;
  const diff = totalLiquido - currentBalance;

  // Only create adjustment if meaningful (>1 cent difference)
  if (Math.abs(diff) < 0.01) {
    return { inserted: false, amount: 0, accountName: '' };
  }

  const account = first('SELECT name FROM accounts WHERE id=?', [accountId]);
  const adjDate = month + '-28'; // safe last day for any month
  const memo = `Ajuste de saldo — extrato ${broker} ${month}`;

  // Check for existing adjustment for this month to avoid duplicates
  const existing = first(
    `SELECT id FROM transactions WHERE account_id=? AND date=? AND memo=?`,
    [accountId, adjDate, memo]
  );
  if (existing) {
    // Update it
    run(`UPDATE transactions SET amount=? WHERE id=?`, [diff, existing.id]);
  } else {
    run(`INSERT INTO transactions (account_id,date,category,memo,amount,cleared) VALUES (?,?,?,?,?,1)`,
      [accountId, adjDate, 'Renda Financeira', memo, diff]);
  }
  save();
  return { inserted: true, amount: diff, accountName: account?.name || '' };
});

ipcMain.handle('broker:save-parsed', (_, { month, assets, caixaValue, broker }) => {
  // month: 'YYYY-MM'
  // assets: [{name, code, category, inv_type, broker, maturity_month, liquidity, liquidity_days,
  //           valor, movimentacoes: [{amount, type}], liquidacaoTotal}]
  // caixaValue: number | null (for valor_em_caixa — ADDITIVE)
  
  const MONTH_ISO = month; // e.g. '2026-05'
  let createdAssets = 0, updatedAssets = 0, txInserted = 0;
  const CAT_MAP = {
    fundos: 'fundos', renda_fixa: 'renda_fixa', tesouro: 'tesouro',
    previdencia: 'previdencia', renda_variavel: 'renda_variavel',
    valor_em_caixa: 'valor_em_caixa',
  };

  // Pre-aggregate: if same asset name appears multiple times, sum valores and merge movimentações
  const assetMap = new Map();
  for (const a of (assets || [])) {
    const key = (a.name||'').toLowerCase().trim();
    if (assetMap.has(key)) {
      const existing = assetMap.get(key);
      existing.valor = (existing.valor || 0) + (a.valor || 0);
      existing.movimentacoes = [...(existing.movimentacoes||[]), ...(a.movimentacoes||[])];
      if (a.liquidacaoTotal) existing.liquidacaoTotal = true;
    } else {
      assetMap.set(key, { ...a, movimentacoes: [...(a.movimentacoes||[])] });
    }
  }
  const mergedAssets = [...assetMap.values()];

  db.run('BEGIN');
  try {
    for (const a of mergedAssets) {
      // Find or create asset by name + broker
      let existing = first(
        'SELECT id FROM inv_assets WHERE lower(name)=lower(?) AND (broker IS NULL OR lower(broker)=lower(?))',
        [a.name, a.broker || '']
      ) || first('SELECT id FROM inv_assets WHERE lower(name)=lower(?)', [a.name]);

      let assetId;
      if (existing) {
        assetId = existing.id;
        // Update metadata if provided
        // Never overwrite category of existing asset — only update non-identity metadata
        db.run(`UPDATE inv_assets SET
          inv_type=COALESCE(?,inv_type),
          broker=COALESCE(?,broker), maturity_month=COALESCE(?,maturity_month),
          liquidity=COALESCE(?,liquidity), liquidity_days=COALESCE(?,liquidity_days),
          code=COALESCE(?,code)
          WHERE id=?`,
          [a.inv_type||null, a.broker||null,
           a.maturity_month||null, a.liquidity||null, a.liquidity_days||null,
           a.code||null, assetId]);
        updatedAssets++;
      } else {
        const sortOrder = all('SELECT COUNT(*) as c FROM inv_assets')[0]?.c || 0;
        db.run(`INSERT INTO inv_assets (name,code,category,inv_type,broker,maturity_month,liquidity,liquidity_days,sort_order)
          VALUES (?,?,?,?,?,?,?,?,?)`,
          [a.name, a.code||null, a.category||'renda_fixa', a.inv_type||null,
           a.broker||null, a.maturity_month||null, a.liquidity||'vencimento',
           a.liquidity_days||null, sortOrder]);
        const idRes = db.exec('SELECT last_insert_rowid()');
        assetId = idRes[0]?.values[0][0];
        createdAssets++;
      }
      if (!assetId) continue;

      // Auto-create initial purchase if asset is NEW and has no external flow transactions this month
      // This handles the case where user imports mid-history without prior purchase records
      const isNewAsset = !existing;
      if (isNewAsset && a.valor > 0) {
        const hasExternal = (a.movimentacoes || []).some(m => m.flow_type === 'external' || (!m.flow_type && m.amount < 0));
        if (!hasExternal) {
          // Check if asset already has ANY external flow transaction (not just this month)
          const anyExternal = first(
            `SELECT id FROM inv_transactions WHERE asset_id=? AND tx_type IN ('compra','aporte','venda','amortizacao')`,
            [assetId]
          );
          if (!anyExternal) {
            // Create auto-purchase = current value (money out of pocket)
            db.run(`INSERT INTO inv_transactions (asset_id,month,tx_type,total_value,notes) VALUES (?,?,?,?,?)`,
              [assetId, MONTH_ISO, 'compra', a.valor, '__auto_purchase__']);
            txInserted++;
          }
        }
      }

      // Upsert valor (atualizacao) for this month
      if (a.valor != null && a.valor > 0) {
        db.run(`DELETE FROM inv_transactions WHERE asset_id=? AND month=? AND tx_type='atualizacao' AND notes='__broker_import__'`,
          [assetId, MONTH_ISO]);
        db.run(`INSERT INTO inv_transactions (asset_id,month,tx_type,total_value,notes) VALUES (?,?,?,?,?)`,
          [assetId, MONTH_ISO, 'atualizacao', a.valor, '__broker_import__']);
        txInserted++;
      }

      // Insert movimentações — use flow_type when available for correct tx_type
      for (const mov of (a.movimentacoes || [])) {
        if (!mov.amount || mov.flow_type === 'ignore') continue;
        let txType;
        if (mov.flow_type === 'external') {
          // External capital flow: compra (money out) or venda (money in)
          txType = mov.amount < 0 ? 'compra' : 'venda';
        } else if (mov.flow_type === 'income') {
          // Income/cost: dividendo (positive) or taxa (negative)
          txType = mov.amount >= 0 ? 'dividendo' : 'taxa';
        } else {
          // Legacy fallback (no flow_type): use sign convention
          txType = mov.amount < 0 ? 'compra' : 'dividendo';
        }
        // Check for existing identical tx this month
        const dup = first(`SELECT id FROM inv_transactions WHERE asset_id=? AND month=? AND tx_type=? AND ABS(total_value-?)<=0.01 AND notes='__broker_import__'`,
          [assetId, MONTH_ISO, txType, Math.abs(mov.amount)]);
        if (dup) continue;
        db.run(`INSERT INTO inv_transactions (asset_id,month,tx_type,total_value,notes) VALUES (?,?,?,?,?)`,
          [assetId, MONTH_ISO, txType, Math.abs(mov.amount), '__broker_import__']);
        txInserted++;
      }

      // Liquidação total → set closed_month and zero value
      if (a.liquidacaoTotal) {
        db.run(`UPDATE inv_assets SET closed_month=? WHERE id=?`, [MONTH_ISO, assetId]);
        db.run(`DELETE FROM inv_transactions WHERE asset_id=? AND month=? AND tx_type='atualizacao' AND notes='__broker_import__'`,
          [assetId, MONTH_ISO]);
        db.run(`INSERT INTO inv_transactions (asset_id,month,tx_type,total_value,notes) VALUES (?,?,?,?,?)`,
          [assetId, MONTH_ISO, 'atualizacao', 0, '__broker_import__']);
        txInserted++;
      }
    }

    // Valor em caixa — ADDITIVE (find or create "Valores em Caixa" asset, SUM by broker)
    if (caixaValue != null && caixaValue > 0) {
      const caixaName = 'Valores em Caixa';
      let caixaAsset = first('SELECT id FROM inv_assets WHERE name=? AND (broker IS NULL OR broker=?)', [caixaName, broker||'']);
      if (!caixaAsset) caixaAsset = first('SELECT id FROM inv_assets WHERE name=?', [caixaName]);
      let caixaId;
      if (caixaAsset) {
        caixaId = caixaAsset.id;
      } else {
        const sortOrder = all('SELECT COUNT(*) as c FROM inv_assets')[0]?.c || 0;
        db.run(`INSERT INTO inv_assets (name,category,inv_type,broker,sort_order) VALUES (?,?,?,?,?)`,
          [caixaName, 'valor_em_caixa', 'Caixa', broker||null, sortOrder]);
        const idRes = db.exec('SELECT last_insert_rowid()');
        caixaId = idRes[0]?.values[0][0];
        createdAssets++;
      }
      if (caixaId) {
        // Get existing value for this month and ADD to it
        const existing_val = first(`SELECT total_value FROM inv_transactions WHERE asset_id=? AND month=? AND tx_type='atualizacao' AND notes='__broker_import__'`,
          [caixaId, MONTH_ISO]);
        const newVal = (existing_val?.total_value || 0) + caixaValue;
        db.run(`DELETE FROM inv_transactions WHERE asset_id=? AND month=? AND tx_type='atualizacao' AND notes='__broker_import__'`,
          [caixaId, MONTH_ISO]);
        db.run(`INSERT INTO inv_transactions (asset_id,month,tx_type,total_value,notes) VALUES (?,?,?,?,?)`,
          [caixaId, MONTH_ISO, 'atualizacao', newVal, '__broker_import__']);
        txInserted++;
      }
    }

    db.run('COMMIT');
  } catch(e) { db.run('ROLLBACK'); throw e; }
  save();
  return { createdAssets, updatedAssets, txInserted };
});

ipcMain.handle('broker:ml-learn', (_, { items }) => {
  for (const item of (items || [])) {
    if (!item.desc || !item.category) continue;
    const amount = item.amount || 0;
    const existing = first('SELECT id FROM ml_rules WHERE desc=?', [item.desc]);
    if (existing) {
      run('UPDATE ml_rules SET memo=?, category=?, amount=?, count=count+1 WHERE id=?',
        [item.memo||item.desc, item.category, amount, existing.id]);
    } else {
      run('INSERT INTO ml_rules (desc, memo, category, amount, count) VALUES (?,?,?,?,1)',
        [item.desc, item.memo||item.desc, item.category, amount]);
    }
  }
  save();
  return { ok: true };
});

// ── BCB Series fetch (via main process — no CORS) ──
ipcMain.handle('bcb:fetch-olinda', async (_, { indicator, date }) => {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const enc = encodeURIComponent;
    const path = `/olinda/servico/Expectativas/versao/v1/odata/ExpectativaMercadoAnuais(Indicador=@I,Data=@D)?@I='${enc(indicator)}'&@D='${enc(date)}'&$top=5&$orderby=Data%20desc&$format=json&$select=Indicador,Data,Mediana`;
    const options = {
      hostname: 'olinda.bcb.gov.br',
      path, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
        'Accept': 'application/json',
        'Referer': 'https://www.bcb.gov.br/',
      },
      timeout: 15000,
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('BCB Olinda JSON inválido')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout BCB Olinda')); });
    req.end();
  });
});

ipcMain.handle('bcb:fetch-series', async (_, { series, n }) => {
  return new Promise((resolve, reject) => {
    const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${series}/dados/ultimos/${n||60}?formato=json`;
    const https = require('https');
    const options = {
      hostname: 'api.bcb.gov.br',
      path: `/dados/serie/bcdata.sgs.${series}/dados/ultimos/${n||60}?formato=json`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
        'Accept': 'application/json',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        'Referer': 'https://www.bcb.gov.br/',
      },
      timeout: 15000,
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON from BCB')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('BCB request timed out')); });
    req.end();
  });
});

// ── Open manual PDF ──
ipcMain.handle('manual:open', (_, { lang }) => {
  const validLangs = ['pt','en','es'];
  const l = validLangs.includes(lang) ? lang.toUpperCase() : 'PT';
  const manualPath = path.join(__dirname, '..', 'assets', 'manuals', `Cruzeiro_Manual_${l}.pdf`);
  if (fs.existsSync(manualPath)) {
    require('electron').shell.openPath(manualPath);
    return { ok: true };
  }
  return { ok: false, error: 'Manual not found: ' + manualPath };
});

// ── Broker name mappings ──
function getBrokerMappingsPath() {
  const base = app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..');
  return path.join(base, '_broker_mappings.json');
}
function loadBrokerMappings() {
  try { return JSON.parse(fs.readFileSync(getBrokerMappingsPath(), 'utf8')); } catch(e) { return {}; }
}
function saveBrokerMappings(m) {
  fs.writeFileSync(getBrokerMappingsPath(), JSON.stringify(m, null, 2));
}
ipcMain.handle('broker:mappings-get', () => loadBrokerMappings());
ipcMain.handle('broker:account-pref-get', (_, { broker }) => {
  const s = loadSettings();
  return (s.brokerAccountPrefs || {})[broker] || null;
});
ipcMain.handle('broker:account-pref-set', (_, { broker, accountId }) => {
  const s = loadSettings();
  if (!s.brokerAccountPrefs) s.brokerAccountPrefs = {};
  s.brokerAccountPrefs[broker] = accountId;
  saveSettings(s);
  return { ok: true };
});
ipcMain.handle('broker:mapping-learn', (_, { broker, original, mapped }) => {
  const m = loadBrokerMappings();
  if (!m[broker]) m[broker] = {};
  m[broker][original] = mapped;
  saveBrokerMappings(m);
  return { ok: true };
});

// ── Custom bank parsers config ──
function getBankParsersPath() {
  const base = app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..');
  return path.join(base, '_bank_parsers.json');
}
function loadBankParsers() {
  try { return JSON.parse(fs.readFileSync(getBankParsersPath(), 'utf8')); } catch(e) { return []; }
}
function saveBankParsers(parsers) {
  fs.writeFileSync(getBankParsersPath(), JSON.stringify(parsers, null, 2));
}

ipcMain.handle('bank:parsers-list', () => loadBankParsers());
ipcMain.handle('bank:parser-save', (_, parser) => {
  const parsers = loadBankParsers();
  const idx = parsers.findIndex(p => p.id === parser.id);
  if (idx >= 0) parsers[idx] = parser;
  else parsers.push(parser);
  saveBankParsers(parsers);
  return { ok: true };
});
ipcMain.handle('bank:parser-delete', (_, { id }) => {
  const parsers = loadBankParsers().filter(p => p.id !== id);
  saveBankParsers(parsers);
  return { ok: true };
});

// ── Financing installments ──
ipcMain.handle('pat:financing-get', (_, { assetId }) =>
  all('SELECT * FROM pat_financing WHERE asset_id=? ORDER BY month', [assetId])
);
ipcMain.handle('pat:financing-save', (_, { assetId, installments }) => {
  // installments = [{month, installment}]
  db.run('DELETE FROM pat_financing WHERE asset_id=?', [assetId]);
  const curM = new Date().toISOString().slice(0,7);
  installments.forEach(({ month, installment }) => {
    if (!month || installment == null) return;
    const paid = month <= curM ? 1 : 0;
    db.run('INSERT OR REPLACE INTO pat_financing (asset_id,month,installment,paid) VALUES (?,?,?,?)',
      [assetId, month, installment, paid]);
  });
  save();
  return { ok: true };
});
ipcMain.handle('pat:financing-paid-value', (_, { assetId }) => {
  // Sum of installments up to current month (what's been "paid" = equity)
  const curM = new Date().toISOString().slice(0,7);
  const rows = all('SELECT SUM(installment) as total FROM pat_financing WHERE asset_id=? AND month<=?', [assetId, curM]);
  return { total: rows[0]?.total || 0 };
});

// ── Financing contract + schedule generation ──

// SAC: equal principal, decreasing installment
// PRICE: equal installment (French method)
// SAM: average of SAC and PRICE
function generateSchedule({ system, annual_rate, principal, n_installments, first_month, balloon_at_keys, extra_annual_month, extra_annual_value }) {
  const r = annual_rate / 100 / 12; // monthly rate
  const schedule = [];

  // Balloon at keys (upfront payment, reduces principal)
  let remainingPrincipal = principal - (balloon_at_keys || 0);
  if (remainingPrincipal < 0) remainingPrincipal = 0;

  // PLANTA: equal installments with no interest (amortization only, correction applied at payment)
  if (system === 'PLANTA') {
    const monthlyInstall = remainingPrincipal / n_installments;
    let balance = remainingPrincipal;
    let cur = first_month;
    for (let i = 0; i < n_installments && balance > 0.01; i++) {
      let amort = monthlyInstall;
      const extra = (extra_annual_month && extra_annual_value && parseInt(cur.split('-')[1]) === extra_annual_month) ? extra_annual_value : 0;
      balance = Math.max(0, balance - amort - extra);
      schedule.push({
        month: cur, installment: Math.round((amort + extra)*100)/100,
        principal: Math.round((amort+extra)*100)/100, interest: 0, correction: 0,
        balance_end: Math.round(balance*100)/100, is_projection: 1,
      });
      const [y, m] = cur.split('-').map(Number);
      cur = m === 12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,'0')}`;
      if (balance <= 0.01) break;
    }
    return schedule;
  }

  // Compute PRICE fixed installment once
  let priceInstallment = 0;
  if (system === 'PRICE' || system === 'SAM') {
    if (r > 0) {
      priceInstallment = remainingPrincipal * r * Math.pow(1+r, n_installments) / (Math.pow(1+r, n_installments) - 1);
    } else {
      priceInstallment = remainingPrincipal / n_installments;
    }
  }

  let balance = remainingPrincipal;
  let cur = first_month;

  for (let i = 0; i < n_installments; i++) {
    const interest = balance * r;
    let amortization, installment;

    if (system === 'SAC') {
      amortization = remainingPrincipal / n_installments;
      installment  = amortization + interest;
    } else if (system === 'PRICE') {
      installment  = priceInstallment;
      amortization = installment - interest;
    } else { // SAM
      const sacAm   = remainingPrincipal / n_installments;
      const sacInst = sacAm + interest;
      installment   = (sacInst + priceInstallment) / 2;
      amortization  = installment - interest;
    }

    // Extra annual installment (balão)
    let extra = 0;
    if (extra_annual_month && extra_annual_value) {
      const mo = parseInt(cur.split('-')[1]);
      if (mo === extra_annual_month) extra = extra_annual_value;
    }

    balance = Math.max(0, balance - amortization - extra);

    schedule.push({
      month:        cur,
      installment:  Math.round((installment + extra) * 100) / 100,
      principal:    Math.round((amortization + extra) * 100) / 100,
      interest:     Math.round(interest * 100) / 100,
      correction:   0,
      balance_end:  Math.round(balance * 100) / 100,
      is_projection: 1,
    });

    // Advance month
    const [y, m] = cur.split('-').map(Number);
    cur = m === 12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,'0')}`;
    if (balance <= 0.01) break;
  }
  return schedule;
}

ipcMain.handle('pat:financing-contract-get', (_, { assetId }) =>
  first('SELECT * FROM pat_financing_contracts WHERE asset_id=?', [assetId]) || null
);

ipcMain.handle('pat:financing-contract-save', (_, { assetId, contract }) => {
  const { system, index_type, annual_rate, principal, n_installments, first_month,
          balloon_at_keys, extra_annual_month, extra_annual_value, notes } = contract;

  // Upsert contract
  run(`INSERT INTO pat_financing_contracts
    (asset_id,system,index_type,annual_rate,principal,n_installments,first_month,balloon_at_keys,extra_annual_month,extra_annual_value,notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(asset_id) DO UPDATE SET
      system=excluded.system, index_type=excluded.index_type, annual_rate=excluded.annual_rate,
      principal=excluded.principal, n_installments=excluded.n_installments, first_month=excluded.first_month,
      balloon_at_keys=excluded.balloon_at_keys, extra_annual_month=excluded.extra_annual_month,
      extra_annual_value=excluded.extra_annual_value, notes=excluded.notes`,
    [assetId, system, index_type||'none', annual_rate, principal, n_installments, first_month,
     balloon_at_keys||null, extra_annual_month||null, extra_annual_value||null, notes||null]);

  // Generate and save schedule (only projected rows — don't overwrite paid rows)
  const schedule = generateSchedule(contract);
  const curM = new Date().toISOString().slice(0,7);

  // Keep existing paid rows, replace projected ones
  run('DELETE FROM pat_financing WHERE asset_id=? AND is_projection=1', [assetId]);
  schedule.forEach(row => {
    // Don't overwrite months that have been paid
    const existing = first('SELECT id FROM pat_financing WHERE asset_id=? AND month=? AND is_projection=0', [assetId, row.month]);
    if (!existing) {
      run(`INSERT OR REPLACE INTO pat_financing (asset_id,month,installment,principal,interest,correction,balance_end,is_projection,paid)
           VALUES (?,?,?,?,?,?,?,1,0)`,
        [assetId, row.month, row.installment, row.principal, row.interest, row.correction, row.balance_end]);
    }
  });

  // Update financing_total on asset
  run('UPDATE pat_assets SET financing_total=?, financed=1 WHERE id=?', [principal, assetId]);

  save();
  return { ok: true, schedule };
});

// Mark installment as paid (called when a pat_transaction of type parcela_financiamento is saved)
ipcMain.handle('pat:financing-mark-paid', (_, { assetId, month, amount }) => {
  const contract = first('SELECT * FROM pat_financing_contracts WHERE asset_id=?', [assetId]);
  const r = contract ? (contract.annual_rate / 100 / 12) : 0;

  // Find balance BEFORE this month (balance_end of previous row)
  const rows = all('SELECT * FROM pat_financing WHERE asset_id=? ORDER BY month', [assetId]);
  const idx  = rows.findIndex(row => row.month.slice(0,7) === month);
  const prevBal = idx > 0 ? (rows[idx-1].balance_end ?? 0) : (contract?.principal ?? 0);

  // Split: interest on prev balance, principal = payment − interest
  const interest   = Math.round(prevBal * r * 100) / 100;
  const principal  = Math.max(0, Math.round((amount - interest) * 100) / 100);
  const balanceEnd = Math.max(0, Math.round((prevBal - principal) * 100) / 100);

  const existing = first('SELECT * FROM pat_financing WHERE asset_id=? AND month=?', [assetId, month]);
  if (existing) {
    run('UPDATE pat_financing SET is_projection=0, paid=1, installment=?, principal=?, interest=?, balance_end=? WHERE asset_id=? AND month=?',
      [amount, principal, interest, balanceEnd, assetId, month]);
  } else {
    run('INSERT INTO pat_financing (asset_id,month,installment,principal,interest,correction,balance_end,is_projection,paid) VALUES (?,?,?,?,?,0,?,0,1)',
      [assetId, month, amount, principal, interest, balanceEnd]);
  }
  _rebalanceSchedule(assetId);
  save();
  return { ok: true };
});

// Restore a paid installment back to projection (called when payment is deleted)
ipcMain.handle('pat:financing-unpay', (_, { assetId, month }) => {
  // Re-generate what the projection for this month should be
  const contract = first('SELECT * FROM pat_financing_contracts WHERE asset_id=?', [assetId]);
  if (!contract) {
    // No contract — just delete the row entirely
    run('DELETE FROM pat_financing WHERE asset_id=? AND month=? AND is_projection=0', [assetId, month]);
  } else {
    // Rebuild the full projected schedule and find this month's row
    const fullSchedule = generateSchedule(contract);
    const projRow = fullSchedule.find(r => r.month.slice(0,7) === month.slice(0,7));
    if (projRow) {
      run(`INSERT OR REPLACE INTO pat_financing
           (asset_id,month,installment,principal,interest,correction,balance_end,is_projection,paid)
           VALUES (?,?,?,?,?,0,?,1,0)`,
        [assetId, projRow.month, projRow.installment, projRow.principal, projRow.interest, projRow.balance_end]);
    } else {
      // Beyond schedule end — just delete
      run('DELETE FROM pat_financing WHERE asset_id=? AND month=?', [assetId, month]);
    }
  }
  _rebalanceSchedule(assetId);
  save();
  return { ok: true };
});

// Fetch financing indexes (INCC, IGP-M, TR, IPC-FIPE)
ipcMain.handle('financing:fetch-indexes', async () => {
  const result = { updated: [], errors: [] };
  const idxPath = getDbPath().replace('.db', '_financing_indexes.json');
  if (!global._financingIndexes) global._financingIndexes = {};

  const fetch = (url) => new Promise((res, rej) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    mod.get(url, { headers: { 'User-Agent': 'Cruzeiro/1.0' } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location)
        return mod.get(r.headers.location, { headers: { 'User-Agent': 'Cruzeiro/1.0' } }, r2 => {
          let d = ''; r2.on('data', c => d+=c); r2.on('end', () => res(d));
        }).on('error', rej);
      let d = ''; r.on('data', c => d+=c); r.on('end', () => res(d)); r.on('error', rej);
    }).on('error', rej);
  });

  // BCB series (monthly rates, already in %):
  // IGP-M = 189 (% ao mês)
  // INCC  = 192 (% ao mês)
  // TR    = 4347 (acumulada mensal, em % ao mês)
  // IPCA  = 433  (% ao mês) — backup if needed
  const bcbSeries = {
    'IGP-M': { code: 189,  divisor: 100 },
    'INCC':  { code: 192,  divisor: 100 },
    'TR':    { code: 4347, divisor: 100 },
  };
  for (const [name, { code, divisor }] of Object.entries(bcbSeries)) {
    try {
      const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados?formato=json&dataInicial=01/01/2000`;
      const raw = await fetch(url);
      const rows = JSON.parse(raw);
      const monthly = {};
      rows.forEach(r => {
        // BCB date format: DD/MM/YYYY
        const parts = r.data.split('/');
        const y = parts[2], m = parts[1];
        const val = parseFloat(r.valor.replace(',','.'));
        if (isFinite(val)) monthly[`${y}-${m}`] = val / divisor;
      });
      global._financingIndexes[name] = monthly;
      result.updated.push(name);
    } catch(e) { result.errors.push(`${name}: ${e.message}`); }
  }

  require('fs').writeFileSync(idxPath, JSON.stringify(global._financingIndexes));
  return result;
});

ipcMain.handle('financing:get-indexes', () => global._financingIndexes || {});

function _rebalanceSchedule(assetId) {
  const rows     = all('SELECT * FROM pat_financing WHERE asset_id=? ORDER BY month', [assetId]);
  const contract = first('SELECT * FROM pat_financing_contracts WHERE asset_id=?', [assetId]);
  const r = contract ? (contract.annual_rate / 100 / 12) : 0;

  let balance = null;
  rows.forEach(row => {
    if (balance === null) {
      // Seed from first row's balance_end
      balance = row.balance_end ?? 0;
      return;
    }
    if (row.is_projection === 0) {
      // Real payment — recompute split with actual amount paid
      const interest   = Math.round(balance * r * 100) / 100;
      const principal  = Math.max(0, Math.round((row.installment - interest) * 100) / 100);
      const newBal     = Math.max(0, Math.round((balance - principal) * 100) / 100);
      run('UPDATE pat_financing SET principal=?, interest=?, balance_end=? WHERE id=?',
        [principal, interest, newBal, row.id]);
      balance = newBal;
    } else {
      // Projected — recalculate based on new balance
      const interest   = Math.round(balance * r * 100) / 100;
      const principal  = Math.max(0, Math.round((row.installment - interest) * 100) / 100);
      const newBal     = Math.max(0, Math.round((balance - principal) * 100) / 100);
      run('UPDATE pat_financing SET principal=?, interest=?, balance_end=? WHERE id=?',
        [principal, interest, newBal, row.id]);
      balance = newBal;
    }
  });
}

// ── Asset history ──
ipcMain.handle('pat:history-list', (_, { assetId }) =>
  all('SELECT * FROM pat_history WHERE asset_id=? ORDER BY month', [assetId])
);

ipcMain.handle('pat:history-all', () =>
  all(`SELECT ph.*, pa.name, pa.trend, pa.asset_type
       FROM pat_history ph JOIN pat_assets pa ON pa.id=ph.asset_id
       ORDER BY ph.asset_id, ph.month`)
);

// Upsert a month value (manual=1 means user-edited, overrides auto-calc)
ipcMain.handle('pat:history-set', (_, { assetId, month, value, manual }) => {
  run(`INSERT INTO pat_history (asset_id,month,value,manual) VALUES (?,?,?,?)
       ON CONFLICT(asset_id,month) DO UPDATE SET value=excluded.value, manual=excluded.manual`,
    [assetId, month, value, manual ? 1 : 0]);
  save();
  return { ok: true };
});

// Auto-update: given monthly IPCA rate, project forward all non-manual months
// Called on app startup and when IPCA is updated
// Delete a specific manual entry (used when editing sold_month to clear old entry)
ipcMain.handle('pat:history-delete-manual', (_, { assetId, month }) => {
  run('DELETE FROM pat_history WHERE asset_id=? AND month=? AND manual=1', [assetId, month]);
  save();
  return { ok: true };
});

// Delete manual entries that are sale-related (except initial value, tx-affected months, and new sale month)
ipcMain.handle('pat:history-clear-manual-sale', (_, { assetId, keepMonth }) => {
  const firstRow = first('SELECT MIN(month) as m FROM pat_history WHERE asset_id=?', [assetId]);
  const firstM = firstRow?.m;
  // Get all months that have pat_transactions (these manual entries must be preserved)
  const txMonths = all('SELECT DISTINCT substr(month,1,7) as m FROM pat_transactions WHERE asset_id=?', [assetId])
    .map(r => r.m);
  // Build exclusion list: first month + tx months + new sale month
  const keepMonths = new Set([firstM, ...(keepMonth ? [keepMonth] : []), ...txMonths].filter(Boolean));
  // Delete manual entries not in the keep list
  const all_manual = all('SELECT month FROM pat_history WHERE asset_id=? AND manual=1', [assetId]);
  all_manual.forEach(h => {
    const m = h.month.slice(0,7);
    if (!keepMonths.has(m)) {
      run('DELETE FROM pat_history WHERE asset_id=? AND month=? AND manual=1', [assetId, m]);
    }
  });
  save();
  return { ok: true };
});

// ── pat_transactions handlers ──
const PAT_TX_SIGN = {
  compra: -1, aporte: -1, despesa: -1, parcela_financiamento: -1,
  reducao: +1, aluguel: +1, dividendo: +1, jcp: +1, venda: +1
};
// Types that also affect pat_history value
const PAT_TX_AFFECTS_VALUE = {
  compra:  'set',    // set value = total_value
  venda:   'set',    // set value = total_value (then zeroed by sold_month logic)
  aporte:  'add',    // value += total_value
  reducao: 'sub',    // value -= total_value
};

ipcMain.handle('pat:tx-list', (_, { assetId }) =>
  all('SELECT * FROM pat_transactions WHERE asset_id=? ORDER BY month, id', [assetId])
);

ipcMain.handle('pat:tx-save', (_, { id, assetId, month, tx_type, total_value, notes }) => {
  // If updating, read the OLD values first so we can reverse their effect
  const oldTx = id ? first('SELECT * FROM pat_transactions WHERE id=?', [id]) : null;
  const oldAssetId = oldTx?.asset_id ?? assetId;
  const oldMonth   = oldTx?.month?.slice(0,7) ?? month;
  const oldType    = oldTx?.tx_type ?? tx_type;
  const oldVal     = oldTx?.total_value ?? 0;

  if (id) {
    run('UPDATE pat_transactions SET month=?,tx_type=?,total_value=?,notes=? WHERE id=?',
      [month, tx_type, total_value, notes||null, id]);
  } else {
    run('INSERT INTO pat_transactions (asset_id,month,tx_type,total_value,notes) VALUES (?,?,?,?,?)',
      [assetId, month, tx_type, total_value, notes||null]);
  }

  // If this is an UPDATE, first reverse the OLD effect on pat_history
  if (oldTx) {
    const oldEffect = PAT_TX_AFFECTS_VALUE[oldType];
    if (oldEffect) {
      const hist = first('SELECT value FROM pat_history WHERE asset_id=? AND month=?', [oldAssetId, oldMonth]);
      const curVal = hist?.value ?? 0;
      let restoredVal;
      if (oldEffect === 'set') restoredVal = null;
      else if (oldEffect === 'add') restoredVal = Math.max(0, curVal - oldVal);
      else if (oldEffect === 'sub') restoredVal = curVal + oldVal;
      if (restoredVal === null) {
        run('DELETE FROM pat_history WHERE asset_id=? AND month=? AND manual=1', [oldAssetId, oldMonth]);
      } else {
        run(`INSERT INTO pat_history (asset_id,month,value,manual) VALUES (?,?,?,1)
             ON CONFLICT(asset_id,month) DO UPDATE SET value=excluded.value, manual=1`,
          [oldAssetId, oldMonth, restoredVal]);
      }
    }
  }

  // Apply NEW effect on pat_history
  const effect = PAT_TX_AFFECTS_VALUE[tx_type];
  if (effect) {
    const existing = first('SELECT value FROM pat_history WHERE asset_id=? AND month=?', [assetId, month]);
    const prevVal = existing?.value ?? 0;
    let newVal;
    if (effect === 'set') newVal = total_value;
    else if (effect === 'add') newVal = prevVal + total_value;
    else if (effect === 'sub') newVal = Math.max(0, prevVal - total_value);
    run(`INSERT INTO pat_history (asset_id,month,value,manual) VALUES (?,?,?,1)
         ON CONFLICT(asset_id,month) DO UPDATE SET value=excluded.value, manual=1`,
      [assetId, month, newVal]);
  }

  const savedId = id || first('SELECT id FROM pat_transactions WHERE asset_id=? AND month=? AND tx_type=? ORDER BY id DESC LIMIT 1', [assetId, month, tx_type])?.id;

  // Sync linked bank transaction amount if it exists
  if (savedId) {
    const linkedTx = first('SELECT * FROM transactions WHERE pat_tx_id=?', [savedId]);
    if (linkedTx) {
      // Keep same sign (income positive, expense negative), just update magnitude
      const newAmount = linkedTx.amount >= 0 ? total_value : -total_value;
      run('UPDATE transactions SET amount=?,memo=? WHERE id=?',
        [newAmount, notes || linkedTx.memo, linkedTx.id]);
    }
  }

  save();
  return { ok: true, id: savedId };
});

ipcMain.handle('pat:tx-delete', (_, { id, assetId, month, tx_type, total_value }) => {
  run('DELETE FROM pat_transactions WHERE id=?', [id]);
  // Reverse the effect on pat_history if applicable
  const effect = PAT_TX_AFFECTS_VALUE[tx_type];
  if (effect) {
    const existing = first('SELECT value FROM pat_history WHERE asset_id=? AND month=?', [assetId, month]);
    const curVal = existing?.value ?? 0;
    let restoredVal;
    if (effect === 'set') restoredVal = null; // remove manual entry
    else if (effect === 'add') restoredVal = Math.max(0, curVal - total_value);
    else if (effect === 'sub') restoredVal = curVal + total_value;
    if (restoredVal === null) {
      run('DELETE FROM pat_history WHERE asset_id=? AND month=? AND manual=1', [assetId, month]);
    } else {
      run(`INSERT INTO pat_history (asset_id,month,value,manual) VALUES (?,?,?,1)
           ON CONFLICT(asset_id,month) DO UPDATE SET value=excluded.value, manual=1`,
        [assetId, month, restoredVal]);
    }
  }
  save();
  return { ok: true };
});

ipcMain.handle('pat:tx-all', () =>
  all('SELECT * FROM pat_transactions ORDER BY asset_id, month, id')
);

ipcMain.handle('pat:auto-project', (_, { ipcaMonthly }) => {
  const assets = all('SELECT * FROM pat_assets');
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  let projected = 0;
  for (const asset of assets) {
    if (asset.sold_month) {
      // Don't project past the sale month
      continue;
    }
    const history = all('SELECT * FROM pat_history WHERE asset_id=? ORDER BY month', [asset.id]);
    if (!history.length) continue;

    const histMap = {};
    history.forEach(h => histMap[h.month] = h);

    // Find the FIRST entry (manual or auto) as starting point
    const firstEntry = history[0];
    let baseMonth = firstEntry.month;
    let baseValue = firstEntry.value;

    // Walk month by month from first+1 to currentMonth
    // At each manual entry, reset base and continue
    let cur = nextMonth(baseMonth);
    while (cur <= currentMonth) {
      if (histMap[cur]?.manual) {
        // User-set value: use as new base, don't overwrite
        baseMonth = cur;
        baseValue = histMap[cur].value;
        cur = nextMonth(cur);
        continue;
      }

      // Recalculate this month from current base
      const rate = ipcaMonthly[cur];
      const multiplier = rate !== undefined ? getTrendMultiplier(asset.trend, rate) : 0;
      const newValue = baseValue * (1 + multiplier);

      db.run(`INSERT INTO pat_history (asset_id,month,value,manual) VALUES (?,?,?,0)
              ON CONFLICT(asset_id,month) DO UPDATE SET value=excluded.value WHERE manual=0`,
        [asset.id, cur, newValue]);

      baseValue = newValue;
      cur = nextMonth(cur);
      projected++;
    }
  }
  if (projected > 0) save();
  return { projected };
});

function getTrendMultiplier(trend, ipcaRate) {
  switch (trend) {
    case 'minus2x': return -2 * ipcaRate;
    case 'minus1x': return -ipcaRate;
    case 'stable':  return 0;
    case 'plus1x':  return ipcaRate;
    case 'plus2x':  return 2 * ipcaRate;
    default:        return ipcaRate;
  }
}

function nextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12
    ? `${y+1}-01`
    : `${y}-${String(m+1).padStart(2,'0')}`;
}

// ── Account selection for patrimônio ──
ipcMain.handle('pat:accounts-get', () =>
  all(`SELECT a.id, a.name, a.type, COALESCE(pa.included,0) as included, COALESCE(pa.sort_order,999) as sort_order
       FROM accounts a LEFT JOIN pat_accounts pa ON pa.account_id=a.id
       WHERE a.hidden=0 ORDER BY COALESCE(pa.included,0) DESC, COALESCE(pa.sort_order,999), a.sort_order, a.id`)
);

ipcMain.handle('pat:accounts-set', (_, { accountIds }) => {
  run('DELETE FROM pat_accounts');
  accountIds.forEach((id, i) => run('INSERT INTO pat_accounts (account_id,included,sort_order) VALUES (?,1,?)', [id, i]));
  save();
  return { ok: true };
});

// Retirement planning: yearly patrimônio and savings data
ipcMain.handle('apos:yearly-data', () => {
  // NOTE: patrimônio totals are computed in the renderer (window._patTotalByMonth)
  // This IPC only provides the evolução data (Média 12m Lucro) per year
  // The renderer's aposCalc() reads _patTotalByMonth directly for the pat values

  const now      = new Date();
  const curYear  = now.getFullYear();
  const curMonth = String(now.getMonth()+1).padStart(2,'0');
  const curM     = `${curYear}-${curMonth}`;

  // Evolução: monthly lucro for Média 12m (excl. transfers)
  const evRows = all(
    `SELECT substr(date,1,7) as month,
       SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) as income,
       SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as expenses
     FROM transactions
     WHERE transfer_id IS NULL
       AND category NOT IN ('Transferência','Transferências')
     GROUP BY month ORDER BY month`
  );

  const evByM = {};
  evRows.forEach(r => { evByM[r.month] = r.income - r.expenses; });

  // Moving 12m average of lucro
  const evMonths = Object.keys(evByM).sort();
  const lucroArr = evMonths.map(m => evByM[m] ?? 0);
  const ma12ByM  = {};
  evMonths.forEach((m, i) => {
    const w = lucroArr.slice(Math.max(0,i-11), i+1).filter(v => !isNaN(v));
    ma12ByM[m] = w.length ? w.reduce((s,v)=>s+v,0)/w.length : 0;
  });

  // Compile yearly: ma12Lucro at December (or last available month)
  const years = [...new Set(evMonths.map(m => m.slice(0,4)))].sort();
  const yearlyEv = {};
  years.forEach(y => {
    const yMonths = evMonths.filter(m => m.startsWith(y));
    if (!yMonths.length) return;
    const decM = `${y}-12`;
    const refM = yMonths.includes(decM) ? decM : yMonths[yMonths.length-1];
    yearlyEv[y] = { ma12Lucro: ma12ByM[refM] ?? null, refM };
  });

  return { yearlyEv, curM, curYear: String(curYear) };
});


ipcMain.handle('pat:account-balances', () => {
  const includedIds = all('SELECT account_id FROM pat_accounts WHERE included=1 ORDER BY sort_order, account_id').map(r => r.account_id);
  if (!includedIds.length) return [];

  // For each account, get balance at end of each month (cumulative sum of transactions)
  const placeholders = includedIds.map(() => '?').join(',');
  const txRows = all(
    `SELECT account_id, substr(date,1,7) as month, SUM(amount) as net
     FROM transactions
     WHERE account_id IN (${placeholders}) AND transfer_id IS NULL
     GROUP BY account_id, month
     ORDER BY account_id, month`,
    includedIds
  );

  // Build cumulative balances per account per month
  const accountNames = {};
  all(`SELECT id, name FROM accounts WHERE id IN (${placeholders})`, includedIds)
    .forEach(a => accountNames[a.id] = a.name);

  const byAccount = {};
  txRows.forEach(r => {
    if (!byAccount[r.account_id]) byAccount[r.account_id] = { name: accountNames[r.account_id], months: {} };
    byAccount[r.account_id].months[r.month] = r.net;
  });

  // Convert to cumulative — MUST respect includedIds order (sort_order)
  const result = [];
  for (const accId of includedIds) {
    const data = byAccount[accId];
    if (!data) {
      // Account has no transactions — still include with zero balance
      result.push({ account_id: parseInt(accId), name: accountNames[accId] || '', history: [] });
      continue;
    }
    const months = Object.keys(data.months).sort();
    let cumulative = 0;
    const history = months.map(m => {
      cumulative += data.months[m];
      return { month: m, balance: Math.round(cumulative * 100) / 100 };
    });
    result.push({ account_id: parseInt(accId), name: data.name, history });
  }
  return result;
});

// Monthly IPCA (série 433 mensal) — separate from annual IPCA used in Evolução
ipcMain.handle('pat:ipca-monthly-fetch', async () => {
  const https = require('https');
  const url = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados?formato=json';
  return new Promise((resolve) => {
    const req = https.get(url, { headers: {'User-Agent':'Cruzeiro/2.0'} }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const arr = JSON.parse(body);
          const result = {};
          arr.forEach(item => {
            const parts = item.data.split('/');
            if (parts.length < 3) return;
            const month = `${parts[2]}-${parts[1].padStart(2,'0')}`;
            const rate = parseFloat(item.valor.replace(',', '.')) / 100;
            if (!isNaN(rate)) result[month] = rate;
          });
          resolve({ ok: true, data: result });
        } catch(e) { resolve({ ok: false, error: e.message }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
});

ipcMain.handle('pat:ipca-monthly-save', (_, data) => {
  try {
    const p = getDbPath().replace('.db', '_pat_ipca_monthly.json');
    require('fs').writeFileSync(p, JSON.stringify(data));
    return { ok: true };
  } catch(e) { return { ok: false }; }
});

ipcMain.handle('pat:ipca-monthly-get', () => {
  try {
    const p = getDbPath().replace('.db', '_pat_ipca_monthly.json');
    return require('fs').existsSync(p) ? JSON.parse(require('fs').readFileSync(p, 'utf8')) : {};
  } catch(e) { return {}; }
});

// ── Benchmark data fetch functions ───────────────────────────────────────────
function httpsGetBM(hostname, path2, extraHeaders) {
  const https = require('https');
  const zlib  = require('zlib');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: path2, method: 'GET',
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      }, extraHeaders || {}),
      timeout: 30000,
    }, res => {
      const enc = res.headers['content-encoding'] || '';
      let stream = res;
      if (enc.includes('gzip'))    stream = res.pipe(zlib.createGunzip());
      else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// CDI: BCB série 4389 (taxa CDI % a.d.) via date-range, accumulated to monthly
// Fallback: série 4391 (CDI acumulado no mês, %)
async function fetchCDIMonthly() {
  const today = new Date();
  const dd   = String(today.getDate()).padStart(2,'0');
  const mm   = String(today.getMonth()+1).padStart(2,'0');
  const yyyy = today.getFullYear();
  const dateRange = `dataInicial=01%2F01%2F2000&dataFinal=${dd}%2F${mm}%2F${yyyy}`;

  // Try série 4389 (daily CDI %) first
  let rows = null;
  let lastErr = '';
  for (const serie of ['4389', '4391']) {
    try {
      const r = await httpsGetBM('api.bcb.gov.br',
        `/dados/serie/bcdata.sgs.${serie}/dados?formato=json&${dateRange}`);
      if (r.status !== 200) { lastErr = `BCB série ${serie} HTTP ${r.status}`; continue; }
      const parsed = JSON.parse(r.body);
      if (!Array.isArray(parsed) || !parsed.length) { lastErr = `BCB série ${serie}: vazio`; continue; }
      rows = parsed;
      console.log(`[CDI] Using série ${serie}, ${rows.length} records`);
      break;
    } catch(e) { lastErr = e.message; }
  }
  if (!rows) throw new Error(`BCB CDI indisponível: ${lastErr}`);

  // Both series 4389 and 4391 return % a.d. (e.g. "0.05130" = 0.05130% per day)
  // Accumulate daily rates into monthly compound rate
  const acc = {};
  rows.forEach(d => {
    const parts = d.data.split('/');
    const month = `${parts[2]}-${parts[1]}`;
    if (!acc[month]) acc[month] = 1;
    const dailyPct = parseFloat(String(d.valor).replace(',', '.'));
    if (!isNaN(dailyPct)) acc[month] *= (1 + dailyPct / 100);
  });
  const result = {};
  Object.entries(acc).forEach(([m, prod]) => { result[m] = parseFloat((prod - 1).toFixed(8)); });
  return result;
}

// IBOV: Yahoo Finance monthly — uses close prices, skips current incomplete month
async function fetchIBOVMonthly() {
  const from = Math.floor(new Date('2000-01-01').getTime() / 1000);
  const to   = Math.floor(Date.now() / 1000);
  const r = await httpsGetBM('query1.finance.yahoo.com',
    `/v8/finance/chart/%5EBVSP?interval=1mo&period1=${from}&period2=${to}&includeAdjustedClose=true`);
  if (r.status !== 200) throw new Error(`Yahoo IBOV HTTP ${r.status}: ${r.body.slice(0,200)}`);
  const json = JSON.parse(r.body);
  const ts     = json?.chart?.result?.[0]?.timestamp;
  const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close;
  if (!ts || !closes) throw new Error('Yahoo IBOV: estrutura inesperada');
  const today = new Date();
  const curMonth = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;
  const result = {};
  for (let i = 1; i < ts.length; i++) {
    if (closes[i] == null || closes[i-1] == null || closes[i-1] === 0) continue;
    // Yahoo timestamps are start-of-month; the close is the month-end price
    // Use previous candle's close as the month-end of that month
    const d = new Date(ts[i] * 1000);
    // The return for month M = close[M] / close[M-1] - 1
    // But ts[i] points to the START of month M+1, so close[i] = end of month M
    const prevD = new Date(ts[i-1] * 1000);
    const month = `${prevD.getFullYear()}-${String(prevD.getMonth()+1).padStart(2,'0')}`;
    if (month === curMonth) continue; // skip incomplete current month
    result[month] = parseFloat((closes[i] / closes[i-1] - 1).toFixed(8));
  }
  return result;
}

ipcMain.handle('benchmarks:save', (_, data) => {
  try {
    const p = getDbPath().replace('.db', '_benchmarks.json');
    require('fs').writeFileSync(p, JSON.stringify(data));
    return { ok: true };
  } catch(e) { return { ok: false }; }
});

ipcMain.handle('benchmarks:get', () => {
  try {
    const p = getDbPath().replace('.db', '_benchmarks.json');
    return require('fs').existsSync(p) ? JSON.parse(require('fs').readFileSync(p, 'utf8')) : null;
  } catch(e) { return null; }
});

ipcMain.handle('benchmarks:fetch-all', async () => {
  const [cdiRes, ibovRes] = await Promise.allSettled([fetchCDIMonthly(), fetchIBOVMonthly()]);
  return {
    cdi:       cdiRes.status  === 'fulfilled' ? cdiRes.value        : null,
    ibov:      ibovRes.status === 'fulfilled' ? ibovRes.value       : null,
    cdiError:  cdiRes.status  === 'rejected'  ? cdiRes.reason.message  : null,
    ibovError: ibovRes.status === 'rejected'  ? ibovRes.reason.message : null,
  };
});

// ── Patrimônio: import from Excel history ──
ipcMain.handle('pat:import-history', (_, { entries }) => {
  // entries = [{assetId, month, value}]
  let imported = 0;
  for (const e of entries) {
    run(`INSERT INTO pat_history (asset_id,month,value,manual) VALUES (?,?,?,1)
         ON CONFLICT(asset_id,month) DO UPDATE SET value=excluded.value, manual=1`,
      [e.assetId, e.month, e.value]);
    imported++;
  }
  if (imported > 0) save();
  return { imported };
});

// Import with auto-create of assets (rows 13-20 from Excel, no pre-existing asset required)
ipcMain.handle('pat:import-history-full', (_, { assets }) => {
  let importedAssets = 0, importedValues = 0;
  for (const a of assets) {
    // Find existing asset by name (case-insensitive)
    let existing = first('SELECT id FROM pat_assets WHERE lower(name)=lower(?)', [a.name]);
    let assetId;
    if (existing) {
      assetId = existing.id;
    } else {
      // Insert and get ID using db.exec directly to avoid save() inside loop
      db.run('INSERT INTO pat_assets (name,asset_type,trend,sort_order) VALUES (?,?,?,0)',
        [a.name, a.asset_type || 'outro', a.trend || 'stable']);
      const idResult = db.exec('SELECT last_insert_rowid()');
      assetId = idResult[0]?.values[0][0];
      if (!assetId) continue; // skip if insert failed
      importedAssets++;
    }
    for (const h of a.history) {
      db.run(`INSERT INTO pat_history (asset_id,month,value,manual) VALUES (?,?,?,1)
              ON CONFLICT(asset_id,month) DO UPDATE SET value=excluded.value, manual=1`,
        [assetId, h.month, h.value]);
      importedValues++;
    }
  }
  if (importedValues > 0) save();
  return { importedAssets, importedValues };
});

// ── SETTINGS: PASSWORD & DATA DIR ──
ipcMain.handle('categories:get', () => {
  const s = loadSettings();
  return s.categories || null; // null means use default hardcoded list
});
ipcMain.handle('categories:save', (_, { categories }) => {
  const s = loadSettings();
  s.categories = categories;
  saveSettings(s);
  return { ok: true };
});

ipcMain.handle('settings:get', () => {
  const s = loadSettings();
  return {
    hasPassword: !!s.passwordHash || !!s.hasEncryptedDB,
    dataDir: s.dataDir || null,
    tourDone: !!s.tourDone,
    benchmarks: s.benchmarks || null,
    hasRecoveryEmail: !!s.recoveryEmail,
    recoveryEmailMasked: s.recoveryEmail ? s.recoveryEmail.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
  };
});

// ══ LICENSING ════════════════════════════════════════════════════════════
//
// Rules:
//   - 6 months free from first_run date
//   - After that, free if ALL of the following are true:
//       avg monthly income  (last 3 months) < R$3,000
//       avg monthly expense (last 3 months) < R$5,000
//       total patrimônio                    < R$100,000
//   - Otherwise requires a valid license code
//   - License codes: SHA-256 HMAC signed with APP_SECRET, format XXXX-XXXX-XXXX-XXXX

const LICENSE_SECRET    = 'cruzeiro-lic-2026-thiago'; // keep private
const FREE_MONTHS       = 6;
const INCOME_THRESHOLD  = 3000;
const EXPENSE_THRESHOLD = 5000;
const WEALTH_THRESHOLD  = 100000;

function generateLicenseCode(email) {
  // Produces a deterministic 16-char code for a given email
  const raw = crypto.createHmac('sha256', LICENSE_SECRET)
    .update(email.toLowerCase().trim()).digest('hex');
  // Format as XXXX-XXXX-XXXX-XXXX (uppercase alphanumeric)
  const chars = raw.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0, 16);
  return `${chars.slice(0,4)}-${chars.slice(4,8)}-${chars.slice(8,12)}-${chars.slice(12,16)}`;
}

function validateLicenseCode(code) {
  // A code is valid if it matches the HMAC pattern for ANY email
  // We store the email alongside the code so we can verify
  const s = loadSettings();
  if (!s.licenseCode || !s.licenseEmail) return false;
  const expected = generateLicenseCode(s.licenseEmail);
  return code.trim().toUpperCase() === expected;
}

function computeLicenseStatus() {
  const s = loadSettings();

  // 1. If valid license code stored → always unlocked
  if (s.licenseCode && validateLicenseCode(s.licenseCode)) {
    return { status: 'licensed', reason: 'Licença válida', daysLeft: null };
  }

  // 2. Check free trial period
  if (!s.firstRun) {
    s.firstRun = new Date().toISOString().slice(0, 10);
    saveSettings(s);
  }
  const firstRun   = new Date(s.firstRun);
  const now        = new Date();
  const daysSince  = Math.floor((now - firstRun) / (1000 * 60 * 60 * 24));
  const trialDays  = FREE_MONTHS * 30;
  const daysLeft   = Math.max(0, trialDays - daysSince);

  if (daysLeft > 0) {
    return { status: 'trial', reason: `Período gratuito — ${daysLeft} dias restantes`, daysLeft };
  }

  // 3. Trial expired — check social income/wealth thresholds
  const today = new Date();
  const m3ago = new Date(today); m3ago.setMonth(m3ago.getMonth() - 3);
  const from3 = m3ago.toISOString().slice(0, 10);
  const toDay = today.toISOString().slice(0, 10);

  const monthly = all(
    `SELECT substr(date,1,7) as month,
       SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) as income,
       SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as expense
     FROM transactions
     WHERE date>=? AND date<=?
       AND category NOT IN ('Transferência','Transferências')
       AND transfer_id IS NULL
     GROUP BY month ORDER BY month DESC LIMIT 3`,
    [from3, toDay]
  );

  let avgIncome = 0, avgExpense = 0;
  if (monthly.length > 0) {
    avgIncome  = monthly.reduce((s, r) => s + r.income,  0) / monthly.length;
    avgExpense = monthly.reduce((s, r) => s + r.expense, 0) / monthly.length;
  }

  // Patrimônio: sum of all account balances + inv_assets + pat_assets
  const accBal = first(
    `SELECT COALESCE(SUM(t.amount),0) as total FROM transactions t`
  )?.total || 0;

  const invVal = first(
    `SELECT COALESCE(SUM(total_value),0) as total
     FROM inv_transactions WHERE tx_type='atualizacao'
       AND id IN (SELECT MAX(id) FROM inv_transactions
                  WHERE tx_type='atualizacao' GROUP BY asset_id)`
  )?.total || 0;

  const patVal = first(
    `SELECT COALESCE(SUM(ph.value),0) as total
     FROM pat_history ph
     WHERE ph.month=(SELECT MAX(month) FROM pat_history ph2 WHERE ph2.asset_id=ph.asset_id)`
  )?.total || 0;

  const totalWealth = Math.max(0, accBal) + invVal + patVal;

  // Free if ALL thresholds are below limits
  const overIncome  = avgIncome  >= INCOME_THRESHOLD;
  const overExpense = avgExpense >= EXPENSE_THRESHOLD;
  const overWealth  = totalWealth >= WEALTH_THRESHOLD;

  if (!overIncome && !overExpense && !overWealth) {
    return {
      status: 'free_social',
      reason: 'Gratuito — perfil de renda/patrimônio dentro do limite social',
      daysLeft: 0,
      avgIncome: Math.round(avgIncome),
      avgExpense: Math.round(avgExpense),
      totalWealth: Math.round(totalWealth),
    };
  }

  // License required
  const reasons = [];
  if (overIncome)  reasons.push(`renda média R$${Math.round(avgIncome).toLocaleString('pt-BR')}/mês`);
  if (overExpense) reasons.push(`despesa média R$${Math.round(avgExpense).toLocaleString('pt-BR')}/mês`);
  if (overWealth)  reasons.push(`patrimônio R$${Math.round(totalWealth).toLocaleString('pt-BR')}`);

  return {
    status: 'payment_required',
    reason: `Licença necessária (${reasons.join('; ')})`,
    daysLeft: 0,
    avgIncome: Math.round(avgIncome),
    avgExpense: Math.round(avgExpense),
    totalWealth: Math.round(totalWealth),
  };
}

ipcMain.handle('license:status', () => computeLicenseStatus());

ipcMain.handle('license:activate', (_, { code, email }) => {
  if (!code || !email) return { ok: false, error: 'Código e email são obrigatórios.' };
  const expected = generateLicenseCode(email.toLowerCase().trim());
  if (code.trim().toUpperCase() !== expected) {
    return { ok: false, error: 'Código de licença inválido.' };
  }
  const s = loadSettings();
  s.licenseCode  = code.trim().toUpperCase();
  s.licenseEmail = email.toLowerCase().trim();
  saveSettings(s);
  return { ok: true };
});

ipcMain.handle('license:deactivate', () => {
  const s = loadSettings();
  delete s.licenseCode;
  delete s.licenseEmail;
  saveSettings(s);
  return { ok: true };
});

// Admin tool: generate a code for a given email (run from Node, not exposed to renderer)
// Usage: node -e "require('./src/main-stub').genCode('email@example.com')"
if (process.argv[2] === '--gen-license') {
  const email = process.argv[3];
  if (email) {
    const code = generateLicenseCode(email);
    console.log(`License for ${email}: ${code}`);
  }
  process.exit(0);
}

ipcMain.handle('export:data', () => {
  try {
    // Export all user data as structured JSON
    const accounts     = all('SELECT * FROM accounts');
    const transactions = all(`
      SELECT t.*, a.name as account_name FROM transactions t
      LEFT JOIN accounts a ON a.id=t.account_id
      ORDER BY t.date, (CASE WHEN t.amount < 0 THEN 1 ELSE 0 END) ASC, t.id`);
    const categories   = (() => { const s = loadSettings(); return s.categories || []; })();
    const recurring    = all('SELECT * FROM recurring');
    const budgets      = all('SELECT * FROM budgets');
    const goals        = all('SELECT * FROM goals');
    const mlRules      = all('SELECT * FROM ml_rules');
    const patAssets    = all('SELECT * FROM pat_assets');
    const patHistory   = all('SELECT * FROM pat_history');
    const patTx        = all('SELECT * FROM pat_transactions');
    const invAssets    = all('SELECT * FROM inv_assets');
    const invTx        = all('SELECT * FROM inv_transactions');
    return {
      ok: true,
      data: {
        accounts, transactions, categories, recurring,
        budgets, goals, mlRules,
        patrimonio: { assets: patAssets, history: patHistory, transactions: patTx },
        investments: { assets: invAssets, transactions: invTx },
      }
    };
  } catch(e) {
    return { ok: false, error: e.message };
  }
});

// Alias for legacy/mismatched preload versions
ipcMain.handle('settings:save', (_, data) => {
  const s = loadSettings();
  if (data && typeof data === 'object') Object.assign(s, data);
  saveSettings(s);
  return { ok: true };
});

ipcMain.handle('settings:save-data', (_, data) => {
  const s = loadSettings();
  Object.assign(s, data);
  saveSettings(s);
  return { ok: true };
});

ipcMain.handle('settings:set-tour-done', () => {
  const s = loadSettings();
  s.tourDone = true;
  saveSettings(s);
  return { ok: true };
});

ipcMain.handle('settings:set-password', async (_, { current, newPassword, email }) => {
  const s = loadSettings();

  // ── Verify current password ──────────────────────────────────────────
  if (_dbKey || s.passwordHash) {
    // If DB is encrypted, verify by trying to decrypt a test token
    // OR fall back to legacy hash check
    if (_dbKey) {
      // DB is encrypted — verify current password by re-deriving key
      const dp = getDbPath();
      if (fs.existsSync(dp)) {
        const buf = fs.readFileSync(dp);
        if (isDBEncrypted(dp)) {
          try {
            decryptDBWithPassword(buf, current || '');
            // decryptDBWithPassword succeeded — but we already have _dbKey in memory
            // Just check the derived key matches
          } catch(e) {
            // Try legacy hash as fallback during transition
            if (s.passwordHash && hashPassword(current || '') !== s.passwordHash) {
              return { ok: false, error: 'Senha atual incorreta' };
            } else if (!s.passwordHash) {
              return { ok: false, error: 'Senha atual incorreta' };
            }
          }
        }
      }
    } else if (s.passwordHash) {
      if (hashPassword(current || '') !== s.passwordHash) {
        return { ok: false, error: 'Senha atual incorreta' };
      }
    }
  }

  const recoveryEmail = (typeof email === 'string' && email.trim()) ? email.trim() : s.recoveryEmail;

  if (newPassword) {
    // ── Set new password: encrypt DB ──────────────────────────────────
    const plain = Buffer.from(db.export());

    // Write emergency plaintext backup before encrypting
    writeEmergencyBackup(plain);

    // Derive new key — same salt goes into both key derivation and the encrypted file
    const newSalt = crypto.randomBytes(32);
    const newKey  = deriveKey(newPassword, newSalt);
    _dbKey  = newKey;
    _dbSalt = newSalt; // save() will pass this to encryptDB so salts match

    // Save encrypted DB immediately
    save();

    // Generate OTP for recovery key (sent by email separately)
    const otpCode = String(Math.floor(100000 + Math.random() * 900000));
    s.recoveryOtpHash    = hashPassword(otpCode); // store hash only
    s.recoveryOtpExpires = Date.now() + 15 * 60 * 1000;

    // Save recovery key encrypted with email + deviceId + otp
    if (recoveryEmail) {
      saveRecoveryKey(newKey, recoveryEmail, otpCode);
    }

    // Remove legacy passwordHash — security now relies on DB encryption
    delete s.passwordHash;
    s.hasEncryptedDB = true;
    if (recoveryEmail) s.recoveryEmail = recoveryEmail;
    saveSettings(s);

    // OTP is NOT sent on password creation — only on "forgot password"
    // The recovery key is saved locally encrypted with email+deviceId+otp
    // User needs to use "Esqueci minha senha" to get the OTP by email
    return { ok: true };

  } else {
    // ── Remove password: decrypt DB ────────────────────────────────────
    const plain = Buffer.from(db.export());

    // Write plaintext DB to disk
    _dbKey = null;
    fs.writeFileSync(getDbPath(), plain);

    // Remove recovery files
    try { if (fs.existsSync(getRecoveryPath())) fs.unlinkSync(getRecoveryPath()); } catch(e) {}

    delete s.passwordHash;
    delete s.hasEncryptedDB;
    delete s.recoveryOtpHash;
    delete s.recoveryOtpExpires;
    saveSettings(s);
    return { ok: true };
  }
});

// Password reset: generate a 6-digit code and open email client
ipcMain.handle('settings:forgot-password', async () => {
  const s = loadSettings();
  if (!s.recoveryEmail) return { ok: false, error: 'Nenhum email de recuperação cadastrado' };

  // Generate a new OTP code
  const code = String(Math.floor(100000 + Math.random() * 900000));

  // If we have the DB key in memory (user is logged in), re-encrypt recovery with new code
  if (_dbKey) {
    saveRecoveryKey(_dbKey, s.recoveryEmail, code);
  }
  // If DB is encrypted but not yet decrypted (user is at login screen),
  // we still save the resetCode — reset-password will use the emergency backup
  
  s.resetCode    = code;
  s.resetExpires = Date.now() + 30 * 60 * 1000; // 30 minutes
  saveSettings(s);

  // Send via EmailJS
  const sendEmailJS = async (c) => {
    const payload = JSON.stringify({
      service_id: 'cruzeiro+app', template_id: 'template_4blb05j',
      user_id: 'diEtlrbHPVvCKu0hx',
      template_params: { to_email: s.recoveryEmail, code: c },
    });
    return new Promise((resolve, reject) => {
      const https = require('https');
      const req = https.request({
        hostname: 'api.emailjs.com', path: '/api/v1.0/email/send', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, res => {
        let b=''; res.on('data', d=>b+=d);
        res.on('end', () => res.statusCode===200?resolve():reject(new Error(`${res.statusCode}: ${b}`)));
      });
      req.on('error', reject); req.write(payload); req.end();
    });
  };

  try {
    await sendEmailJS(code);
    return { ok: true, email: s.recoveryEmail.replace(/(.{2}).*(@.*)/, '$1***$2') };
  } catch(e) {
    console.error('[EmailJS forgot]', e.message);
    // Fallback: open mail client
    const subj = encodeURIComponent('Cruzeiro - Código de recuperação');
    const body = encodeURIComponent(`Código: ${code}\n\nExpira em 30 minutos.`);
    require('electron').shell.openExternal(`mailto:${s.recoveryEmail}?subject=${subj}&body=${body}`);
    return { ok: true, email: s.recoveryEmail.replace(/(.{2}).*(@.*)/, '$1***$2'), fallback: true };
  }
});


ipcMain.handle('settings:reset-password', async (_, { code, newPassword }) => {
  const s = loadSettings();
  if (!s.resetCode || !s.resetExpires) return { ok: false, error: 'Nenhum código ativo. Solicite um novo.' };
  if (Date.now() > s.resetExpires) {
    delete s.resetCode; delete s.resetExpires; saveSettings(s);
    return { ok: false, error: 'Código expirado. Solicite um novo.' };
  }
  if (s.resetCode !== String(code).trim()) return { ok: false, error: 'Código incorreto.' };

  // ── Get plaintext DB ─────────────────────────────────────────────────
  let plainDB;
  if (s.hasEncryptedDB) {
    // Option 1: use recovery file encrypted with this same OTP (generated by forgot-password)
    const recPath = getRecoveryPath();
    if (fs.existsSync(recPath)) {
      try {
        const recoveredKey = loadRecoveryKey(s.recoveryEmail, String(code).trim());
        const encBuf = fs.readFileSync(getDbPath());
        plainDB = aesDecrypt(encBuf, recoveredKey, DB_MAGIC);
        console.log('[Recovery] DB decrypted with recovery key');
      } catch(e) {
        console.warn('[Recovery] Recovery file failed, trying emergency backup:', e.message);
      }
    }
    // Option 2: if DB is still in memory and pending decrypt, try current encrypted buffer
    if (!plainDB && _encryptedDBBuf) {
      // We can't decrypt without the key — but if user just generated an OTP while logged in,
      // _dbKey should still be in memory
      if (_dbKey) {
        try {
          plainDB = aesDecrypt(_encryptedDBBuf, _dbKey, DB_MAGIC);
          console.log('[Recovery] DB decrypted with in-memory key');
        } catch(e) {}
      }
    }
    // Option 3: emergency plaintext backup
    if (!plainDB) {
      const bakPath = getDbPath().replace('.db', '_emergency.db.bak');
      if (fs.existsSync(bakPath)) {
        plainDB = fs.readFileSync(bakPath);
        console.log('[Recovery] Using emergency plaintext backup');
      }
    }
    // Option 4: try all backups (most recent first)
    if (!plainDB) {
      try {
        const bdir = getBackupDir();
        if (fs.existsSync(bdir)) {
          const files = fs.readdirSync(bdir)
            .filter(f => f.endsWith('.db'))
            .sort()
            .reverse();
          for (const f of files) {
            const p = path.join(bdir, f);
            const buf = fs.readFileSync(p);
            if (!isDBEncrypted(p)) { plainDB = buf; console.log('[Recovery] Using backup:', f); break; }
            // Try to decrypt with recovery key
            try {
              const rk = loadRecoveryKey(s.recoveryEmail, String(code).trim());
              plainDB = aesDecrypt(buf, rk, DB_MAGIC);
              console.log('[Recovery] Decrypted backup:', f);
              break;
            } catch(e) {}
          }
        }
      } catch(e) {}
    }
    if (!plainDB) {
      delete s.resetCode; delete s.resetExpires; saveSettings(s);
      return { ok: false, error: 'Não foi possível acessar os dados. Restaure um backup manualmente na aba Configurações.' };
    }
  } else {
    // Legacy plaintext DB
    plainDB = fs.readFileSync(getDbPath());
  }

  // ── Re-encrypt with new password ────────────────────────────────────
  const newSalt = crypto.randomBytes(32);
  const newKey  = deriveKey(newPassword, newSalt);
  _dbKey = newKey;

  // Reload DB in memory
  db = new SQL.Database(plainDB);
  db.run('PRAGMA foreign_keys = ON;');
  _dbPendingDecrypt = false;

  // Save re-encrypted DB
  save();

  // Generate new recovery key with same email
  const newOtp = String(Math.floor(100000 + Math.random() * 900000));
  if (s.recoveryEmail) {
    saveRecoveryKey(newKey, s.recoveryEmail, newOtp);
    // Recovery OTP for new key saved locally — user must click forgot-password to get it by email
    try {
      void 0; // placeholder
    } catch(e) { console.error('[EmailJS recovery refresh]', e.message); }
  }

  delete s.resetCode; delete s.resetExpires;
  delete s.passwordHash; // ensure legacy hash is gone
  s.hasEncryptedDB = true;
  saveSettings(s);
  return { ok: true };
});

ipcMain.handle('settings:has-recovery-email', () => {
  const s = loadSettings();
  return { hasEmail: !!s.recoveryEmail, email: s.recoveryEmail ? s.recoveryEmail.replace(/(.{2}).*(@.*)/, '$1***$2') : null };
});

ipcMain.handle('settings:check-password', (_, pw) => {
  const s = loadSettings();

  // ── Encrypted DB: verify by decryption attempt ───────────────────────
  if (_dbPendingDecrypt && _encryptedDBBuf) {
    try {
      const plain = decryptDBWithPassword(_encryptedDBBuf, pw);
      db = new SQL.Database(plain);
      db.run('PRAGMA foreign_keys = ON;');
      _encryptedDBBuf  = null;
      _dbPendingDecrypt = false;
      // Run deferred startup tasks that were skipped during pending decrypt
      try { migrateRecurring(); } catch(e) {}
      setImmediate(() => {
        try { const recs = all('SELECT * FROM recurring WHERE active=1'); recs.forEach(rec => syncRecurringTxns(rec)); save(); } catch(e) {}
      });
      // _dbKey is now cached by decryptDBWithPassword
      return true;
    } catch(e) {
      return false; // Wrong password — GCM auth failed
    }
  }

  // ── Legacy: plaintext DB with hash in settings.json ──────────────────
  if (!s.passwordHash) return true;
  return hashPassword(pw) === s.passwordHash;
});

ipcMain.handle('settings:login-ok', () => {
  console.log('[login-ok] START, win=', !!win, 'loginWin=', !!loginWin);
  _loggingIn = true;
  if (loginWin) {
    loginWin.destroy();
    loginWin = null;
    console.log('[login-ok] loginWin destroyed');
  }
  console.log('[login-ok] about to createWindow, app.isReady=', app.isReady());
  try {
    if (!win) {
      createWindow(true);
      console.log('[login-ok] createWindow called, win=', !!win);
      if (win) {
        console.log('[login-ok] win.isDestroyed=', win.isDestroyed(), 'win.isVisible=', win.isVisible());
      }
      try { setupAutoUpdater(); } catch(e) { console.error('[login-ok] autoUpdater:', e.message); }
    } else {
      win.show();
      try { setupAutoUpdater(); } catch(e) {}
      win.webContents.send('db:reloaded');
    }
  } catch(e) {
    console.error('[login-ok] FATAL error:', e);
  } finally {
    _loggingIn = false;
    console.log('[login-ok] END');
  }
  return { ok: true };
});

ipcMain.handle('settings:set-data-dir', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Escolher pasta de dados (ex: Dropbox)',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  const dir = result.filePaths[0];

  // Copy current DB to new location if it doesn't exist there yet
  const currentDb = getDbPath();
  const newDb = path.join(dir, 'cruzeiro_data.db');
  if (!fs.existsSync(newDb) && fs.existsSync(currentDb)) {
    fs.copyFileSync(currentDb, newDb);
  }

  const s = loadSettings();
  s.dataDir = dir;
  saveSettings(s);

  // Reload DB from new location
  if (fs.existsSync(newDb)) {
    const buf = fs.readFileSync(newDb);
    db = new SQL.Database(buf);
  }

  return { ok: true, dir };
});

ipcMain.handle('settings:clear-data-dir', () => {
  const s = loadSettings();
  delete s.dataDir;
  saveSettings(s);
  return { ok: true };
});

// Check password from login window
ipcMain.handle('login:check', (_, pw) => {
  const s = loadSettings();
  // Encrypted DB: verify by actually decrypting
  if (_dbPendingDecrypt && _encryptedDBBuf) {
    try {
      const plain = decryptDBWithPassword(_encryptedDBBuf, pw);
      db = new SQL.Database(plain);
      db.run('PRAGMA foreign_keys = ON;');
      _encryptedDBBuf  = null;
      _dbPendingDecrypt = false;
      // Run deferred startup tasks
      try { migrateRecurring(); } catch(e) {}
      setImmediate(() => {
        try {
          const recs = all('SELECT * FROM recurring WHERE active=1');
          recs.forEach(rec => syncRecurringTxns(rec));
          save();
        } catch(e) { console.error('syncRecurring post-login:', e); }
      });
      return true;
    } catch(e) {
      return false; // Wrong password
    }
  }
  // Legacy: plaintext DB with hash
  if (!s.passwordHash) return true;
  return hashPassword(pw) === s.passwordHash;
});
ipcMain.handle('login:ok', () => {
  // Show main window FIRST, then destroy login window
  // (destroying login win triggers its 'closed' event which checks win.isVisible())
  if (win) {
    win.show();
    win.focus();
    setupAutoUpdater();
  }
  if (loginWin) {
    // Remove the closed listener before destroying to avoid quit race condition
    loginWin.removeAllListeners('closed');
    loginWin.destroy();
    loginWin = null;
  }
  return { ok: true };
});

// ══ INVESTIMENTOS FINANCEIROS ══

ipcMain.handle('inv:assets-list', () =>
  all(`SELECT *,
    CASE category
      WHEN 'renda_fixa'      THEN 1
      WHEN 'tesouro'         THEN 2
      WHEN 'previdencia'     THEN 3
      WHEN 'fundos'          THEN 4
      WHEN 'renda_variavel'  THEN 5
      WHEN 'private_equity'  THEN 6
      WHEN 'caixa'           THEN 7
      WHEN 'valor_em_caixa'  THEN 7
      ELSE 8
    END AS _cat_order
  FROM inv_assets
  ORDER BY _cat_order, inv_type, COALESCE(broker,''), name`)
);

ipcMain.handle('inv:brokers-list', () => {
  const rows = all('SELECT DISTINCT broker FROM inv_assets WHERE broker IS NOT NULL AND broker != "" ORDER BY broker');
  return rows.map(r => r.broker);
});

ipcMain.handle('inv:asset-save', (_, { id, name, code, category, inv_type, sort_order, closed_month, hidden, notes, broker, maturity_month, liquidity, liquidity_days, benchmark }) => {
  if (id) {
    run('UPDATE inv_assets SET name=?,code=?,category=?,inv_type=?,sort_order=?,closed_month=?,hidden=?,notes=?,broker=?,maturity_month=?,liquidity=?,liquidity_days=?,benchmark=? WHERE id=?',
      [name, code||null, category, inv_type, sort_order??0, closed_month||null, hidden?1:0, notes||null,
       broker||null, maturity_month||null, liquidity||'vencimento', liquidity_days||null, benchmark||'cdi', id]);
    return { id };
  } else {
    const newId = run('INSERT INTO inv_assets (name,code,category,inv_type,sort_order,closed_month,hidden,notes,broker,maturity_month,liquidity,liquidity_days,benchmark) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [name, code||null, category, inv_type, sort_order??0, closed_month||null, hidden?1:0, notes||null,
       broker||null, maturity_month||null, liquidity||'vencimento', liquidity_days||null, benchmark||'cdi']);
    const resolvedId = newId || first('SELECT id FROM inv_assets WHERE name=? ORDER BY id DESC LIMIT 1', [name])?.id;
    return { id: resolvedId };
  }
});

ipcMain.handle('inv:asset-delete', (_, { id }) => {
  run('DELETE FROM inv_assets WHERE id=?', [id]);
  return { ok: true };
});

ipcMain.handle('inv:tx-list', (_, { assetId }) =>
  all('SELECT * FROM inv_transactions WHERE asset_id=? ORDER BY month, id', [assetId])
);

ipcMain.handle('inv:tx-all', () =>
  all(`SELECT t.*, a.name, a.code, a.category, a.inv_type
       FROM inv_transactions t JOIN inv_assets a ON a.id=t.asset_id
       ORDER BY t.asset_id, t.month, t.id`)
);

ipcMain.handle('inv:tx-reclassify', (_, { id, new_tx_type }) => {
  // Reclassify a single inv_transaction to a different tx_type
  const tx = first('SELECT * FROM inv_transactions WHERE id=?', [id]);
  if (!tx) return { ok: false, error: 'Transação não encontrada' };
  // Only allow reclassification between external and income types
  const RECLASSIFIABLE = ['compra','aporte','venda','amortizacao','dividendo','juros','jcp','cupom','taxa'];
  if (!RECLASSIFIABLE.includes(new_tx_type)) return { ok: false, error: 'Tipo inválido' };
  run('UPDATE inv_transactions SET tx_type=? WHERE id=?', [new_tx_type, id]);
  save();
  return { ok: true };
});

ipcMain.handle('inv:tx-save', (_, { id, asset_id, month, tx_type, qty, unit_value, total_value, notes }) => {
  if (id) {
    run('UPDATE inv_transactions SET month=?,tx_type=?,qty=?,unit_value=?,total_value=?,notes=? WHERE id=?',
      [month, tx_type, qty||null, unit_value||null, total_value, notes||null, id]);
    return { id };
  } else {
    const newId = run('INSERT INTO inv_transactions (asset_id,month,tx_type,qty,unit_value,total_value,notes) VALUES (?,?,?,?,?,?,?)',
      [asset_id, month, tx_type, qty||null, unit_value||null, total_value, notes||null]);
    const resolvedId = newId || first('SELECT id FROM inv_transactions WHERE asset_id=? AND month=? AND tx_type=? ORDER BY id DESC LIMIT 1', [asset_id, month, tx_type])?.id;
    return { id: resolvedId };
  }
});

ipcMain.handle('inv:tx-delete', (_, { id }) => {
  run('DELETE FROM inv_transactions WHERE id=?', [id]);
  return { ok: true };
});

// Etapa 5: auto-insert purchase if no significant negative flow in first month
ipcMain.handle('inv:ensure-purchase', (_, { assetId }) => {
  // Get all transactions for this asset ordered by month
  const txs = all('SELECT * FROM inv_transactions WHERE asset_id=? ORDER BY month, id', [assetId]);
  if (!txs.length) return { inserted: false, reason: 'no transactions' };

  // Find the first month that has any transaction
  const firstMonth = txs[0].month.slice(0, 7);

  // Get the position value in the first month (latest atualizacao)
  const valueTxs = txs.filter(t => t.month.slice(0,7) === firstMonth && t.tx_type === 'atualizacao');
  if (!valueTxs.length) return { inserted: false, reason: 'no valuation in first month' };
  const positionValue = valueTxs[valueTxs.length - 1].total_value;
  if (!positionValue || positionValue <= 0) return { inserted: false, reason: 'zero position value' };

  // Sum all negative cash flows in the first month (compra, aporte, taxa)
  const NEGATIVE_TYPES = ['compra', 'aporte', 'taxa'];
  const firstMonthTxs = txs.filter(t => t.month.slice(0,7) === firstMonth);
  const totalNegative = firstMonthTxs
    .filter(t => NEGATIVE_TYPES.includes(t.tx_type))
    .reduce((s, t) => s + t.total_value, 0);

  // If negative flows >= 10% of position value, assume purchase is already registered
  if (totalNegative >= positionValue * 0.10) {
    return { inserted: false, reason: 'purchase already registered', totalNegative, positionValue };
  }

  // Insert synthetic purchase at position value
  run(
    'INSERT INTO inv_transactions (asset_id, month, tx_type, total_value, notes) VALUES (?,?,?,?,?)',
    [assetId, firstMonth, 'compra', positionValue, '__auto_purchase__']
  );
  return { inserted: true, month: firstMonth, value: positionValue };
});

// ── Investimentos: importação histórica da planilha Excel ──
ipcMain.handle('inv:bulk-import-history', (_, { assets }) => {
  // assets = [{name, broker, maturity_month, categoria, tipo, valores: {month: val}, aportes: {month: val}}]
  let createdAssets = 0, updatedAssets = 0, createdTx = 0;

  // Normalize any existing YYYY-MM-DD months to YYYY-MM (fix previous bad imports)
  db.run("UPDATE inv_transactions SET month = substr(month,1,7) WHERE length(month) > 7");

  const CAT_MAP = {
    renda_fixa: 'renda_fixa',
    tesouro: 'tesouro',
    previdencia: 'previdencia',
    fundos: 'fundos',
    renda_variavel: 'renda_variavel',
    valor_em_caixa: 'valor_em_caixa',
  };

  for (const a of assets) {
    const categoria = CAT_MAP[a.categoria] || 'renda_fixa';
    const inv_type  = a.tipo || 'CDB';

    // Find or create asset
    let existing = first('SELECT id FROM inv_assets WHERE lower(name)=lower(?)', [a.name]);
    let assetId;

    if (existing) {
      assetId = existing.id;
      updatedAssets++;
    } else {
      db.run(
        'INSERT INTO inv_assets (name, category, inv_type, sort_order, broker, maturity_month, liquidity) VALUES (?,?,?,0,?,?,?)',
        [a.name, categoria, inv_type, a.broker || null, a.maturity_month || null, 'vencimento']
      );
      const idResult = db.exec('SELECT last_insert_rowid()');
      assetId = idResult[0]?.values[0][0];
      if (!assetId) continue;
      createdAssets++;
    }

    // Delete old imported transactions for this asset to avoid duplicates on re-run
    db.run("DELETE FROM inv_transactions WHERE asset_id=? AND (notes='__importado_historico__' OR 1=1)", [assetId]);
    db.run('DELETE FROM inv_transactions WHERE asset_id=?', [assetId]);

    // Insert valor (marcação a mercado) as 'atualizacao' — tipo reconhecido pelo INV_TX_VALUATION
    for (const [month, value] of Object.entries(a.valores || {})) {
      if (value == null || value === 0) continue;
      db.run(
        "INSERT INTO inv_transactions (asset_id, month, tx_type, total_value, notes) VALUES (?,?,?,?,?)",
        [assetId, month.slice(0,7), 'atualizacao', value, '__importado_historico__']
      );
      createdTx++;
    }

    // Insert fluxos de caixa.
    // Após a inversão feita no renderer: value<0 = saída de caixa (compra/aporte); value>0 = entrada (dividendo/juros/venda)
    for (const [month, value] of Object.entries(a.aportes || {})) {
      if (value == null || value === 0) continue;
      const txType = value < 0 ? 'aporte' : 'dividendo';
      db.run(
        "INSERT INTO inv_transactions (asset_id, month, tx_type, total_value, notes) VALUES (?,?,?,?,?)",
        [assetId, month.slice(0,7), txType, Math.abs(value), '__importado_historico__']
      );
      createdTx++;
    }
  }

  // Auto-insert purchase if missing for each imported asset
  let autoPurchases = 0;
  for (const a of assets) {
    const existing = first('SELECT id FROM inv_assets WHERE lower(name)=lower(?)', [a.name]);
    if (existing) {
      const r = ensurePurchaseTx(existing.id);
      if (r.inserted) autoPurchases++;
    }
  }

  save();
  return { createdAssets, updatedAssets, createdTx, autoPurchases };
});
