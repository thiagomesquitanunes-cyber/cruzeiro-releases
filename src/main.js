const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');

// ── Trava de instância única ────────────────────────────────────────────
// Sem isso, nada impedia abrir duas cópias do app ao mesmo tempo na mesma
// máquina (clique duplo no atalho enquanto ainda carrega, ícone da
// bandeja + atalho, processo anterior que não fechou de vez). Cada cópia
// roda seu próprio mainStartupFlow() e chama sb.refreshSession() com o
// MESMO refresh_token salvo em disco — o Supabase Auth faz rotação
// single-use desse token, então a segunda chamada a usá-lo recebe
// invalid_grant e pode invalidar a sessão inteira (inclusive o token novo
// que a primeira cópia acabou de obter), forçando login de novo do nada.
// Com a trava, a segunda tentativa de abrir só foca a janela já aberta.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    try { logAuth('SEGUNDA_INSTANCIA bloqueada — outra cópia do app já estava aberta'); } catch(e) {}
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

// ── SYNC MOBILE (Supabase) ──
const sb          = require('./sync/supabase-client');
const syncPush    = require('./sync/sync-push');
const syncPull    = require('./sync/sync-pull');
const cryptoUtils = require('./sync/crypto-utils');

// Estado do sync (em memória)
let _syncRunning = false;
// Promise do sync em andamento — permite que outro ponto do código (o
// handler de fechamento do app) ESPERE um sync já em curso terminar em vez
// de só checar a flag e desistir. Ver uso em 'before-quit'.
let _syncPromise = null;

// ── Multi-usuário (mesmo desktop) ──
// Cada usuário cadastrado tem seu próprio conjunto de arquivos (banco,
// configurações, índices, etc.) — diferenciados por um sufixo no nome do
// arquivo. O usuário "padrão" (id=null, o que já existia antes desta
// funcionalidade) continua usando exatamente os mesmos nomes de arquivo de
// sempre — só usuários adicionais ganham o sufixo. Isso significa que quem
// já usa o app com um único usuário não precisa de nenhuma migração.
let _currentUserId = null;

function getUserRegistryPath() {
  const base = app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..');
  return path.join(base, '_users_registry.json');
}
function loadUserRegistry() {
  try {
    return JSON.parse(fs.readFileSync(getUserRegistryPath(), 'utf8'));
  } catch(e) {
    // Primeira vez: registra implicitamente o usuário "padrão" (arquivos
    // sem sufixo) — não precisa de nenhuma ação do usuário pra continuar
    // funcionando como sempre funcionou.
    return { users: [{ id: null, name: 'Principal' }] };
  }
}
function saveUserRegistry(r) {
  fs.writeFileSync(getUserRegistryPath(), JSON.stringify(r, null, 2));
}

// Settings always stored in original userData (not redirected)
function getSettingsPath(forUserId) {
  const uid = forUserId !== undefined ? forUserId : _currentUserId;
  const base = app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..');
  return path.join(base, uid ? `_settings_${uid}.json` : '_settings.json');
}
function loadSettings(forUserId) {
  try { return JSON.parse(fs.readFileSync(getSettingsPath(forUserId), 'utf8')); } catch(e) { return {}; }
}
function saveSettings(s, forUserId) {
  fs.writeFileSync(getSettingsPath(forUserId), JSON.stringify(s, null, 2));
}
// Log persistido em arquivo pro fluxo de restaurar sessão Supabase no
// boot — os console.log/warn desse trecho só aparecem com o DevTools
// aberto; num app empacotado, uma desconexão "do nada" não deixava
// nenhum rastro consultável depois. Guarda só as últimas ~200 linhas
// (não precisa de rotação sofisticada, é só pra diagnosticar o próximo
// episódio, não um log de produção de verdade).
function logAuth(msg) {
  try {
    const base = app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..');
    const logPath = path.join(base, '_auth_log.txt');
    const line = `[${new Date().toISOString()}] pid=${process.pid} ${msg}\n`;
    let existing = '';
    try { existing = fs.readFileSync(logPath, 'utf8'); } catch(e) {}
    const lines = (existing + line).split('\n').filter(Boolean);
    const trimmed = lines.slice(-200).join('\n') + '\n';
    fs.writeFileSync(logPath, trimmed);
  } catch(e) {}
}

function getImportStatePath() {
  const settings = loadSettings();
  const base = settings.dataDir
    ? settings.dataDir
    : (app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..'));
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  return path.join(base, '_import_pending.json');
}

function getDbPath() {
  const settings = loadSettings();
  const base = settings.dataDir
    ? settings.dataDir
    : (app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..'));
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  return path.join(base, _currentUserId ? `cruzeiro_data_${_currentUserId}.db` : 'cruzeiro_data.db');
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

  // _dbKey/_dbSalt são variáveis de módulo únicas, compartilhadas por TODOS
  // os usuários locais deste Desktop. Sem resetar aqui, trocar para um
  // usuário local cujo banco NÃO é criptografado herdava silenciosamente a
  // chave do usuário anterior — e o próximo save() criptografava o banco em
  // texto puro do novo usuário com a chave (e senha) de outra pessoa,
  // tornando os dados dele inacessíveis pra ele mesmo. Se o banco desta
  // conta FOR criptografado, o fluxo abaixo (_dbPendingDecrypt) já define
  // um _dbKey novo e correto assim que a senha certa for informada.
  _dbKey  = null;
  _dbSalt = null;

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
      pat_debt_id  INTEGER,
      pat_installment_month TEXT,
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
      contract_id  INTEGER REFERENCES pat_financing_contracts(id) ON DELETE CASCADE,
      month        TEXT    NOT NULL,
      installment  REAL    NOT NULL,
      principal    REAL,
      interest     REAL,
      correction   REAL,
      balance_end  REAL,
      is_projection INTEGER NOT NULL DEFAULT 1,
      paid         INTEGER NOT NULL DEFAULT 0,
      linked_tx_id INTEGER,
      UNIQUE(contract_id, month)
    );
    CREATE TABLE IF NOT EXISTS pat_financing_contracts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id          INTEGER NOT NULL REFERENCES pat_assets(id) ON DELETE CASCADE,
      label             TEXT,
      status            TEXT    NOT NULL DEFAULT 'active',
      closed_month      TEXT,
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
      sync_account_id   INTEGER,
      sync_day          INTEGER,
      sync_category     TEXT,
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
      tx_date     TEXT,
      account_id  INTEGER,
      linked_tx_id INTEGER,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_pat_tx_asset ON pat_transactions(asset_id, month);
    CREATE TABLE IF NOT EXISTS personal_debts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      notes       TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      hidden      INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS personal_debt_contracts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      debt_id           INTEGER NOT NULL UNIQUE REFERENCES personal_debts(id) ON DELETE CASCADE,
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
      sync_account_id   INTEGER,
      sync_day          INTEGER,
      sync_category     TEXT,
      created_at        TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS personal_debt_installments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      debt_id      INTEGER NOT NULL REFERENCES personal_debts(id) ON DELETE CASCADE,
      month        TEXT    NOT NULL,
      installment  REAL    NOT NULL,
      principal    REAL,
      interest     REAL,
      correction   REAL,
      balance_end  REAL,
      is_projection INTEGER NOT NULL DEFAULT 1,
      paid         INTEGER NOT NULL DEFAULT 0,
      linked_tx_id INTEGER,
      UNIQUE(debt_id, month)
    );
    CREATE INDEX IF NOT EXISTS idx_debt_installments ON personal_debt_installments(debt_id, month);
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
  try { db.run('ALTER TABLE ml_rules ADD COLUMN transfer_account_id INTEGER'); } catch(e) {};

  // No default account seeds — user creates their own accounts on first run

  // Ensure missing accounts exist (migration for existing databases)
  // Migration: add sold_month/sold_value to pat_assets if missing
  try { db.run('ALTER TABLE pat_assets ADD COLUMN sold_month TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE pat_assets ADD COLUMN sold_value REAL'); } catch(e) {}
  try { db.run('ALTER TABLE pat_assets ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE pat_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
  try { db.run("ALTER TABLE pat_financing_contracts ADD COLUMN extra_annual_effect TEXT NOT NULL DEFAULT 'moment'"); } catch(e) {}
  try { db.run("ALTER TABLE personal_debt_contracts ADD COLUMN extra_annual_effect TEXT NOT NULL DEFAULT 'moment'"); } catch(e) {}
  try { db.run("ALTER TABLE pat_financing_contracts ADD COLUMN correction_ref_month TEXT NOT NULL DEFAULT 'minus2'"); } catch(e) {}
  try { db.run("ALTER TABLE personal_debt_contracts ADD COLUMN correction_ref_month TEXT NOT NULL DEFAULT 'minus2'"); } catch(e) {}
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
  try { db.run('ALTER TABLE pat_financing ADD COLUMN linked_tx_id INTEGER'); } catch(e) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS pat_financing_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL UNIQUE REFERENCES pat_assets(id) ON DELETE CASCADE,
    system TEXT NOT NULL DEFAULT 'SAC', index_type TEXT NOT NULL DEFAULT 'none',
    annual_rate REAL NOT NULL DEFAULT 0, principal REAL NOT NULL DEFAULT 0,
    n_installments INTEGER NOT NULL DEFAULT 0, first_month TEXT NOT NULL,
    balloon_at_keys REAL, extra_annual_month INTEGER, extra_annual_value REAL,
    notes TEXT, created_at TEXT DEFAULT (datetime('now')))`); } catch(e) {}
  try { db.run('ALTER TABLE pat_financing_contracts ADD COLUMN sync_account_id INTEGER'); } catch(e) {}
  try { db.run('ALTER TABLE pat_financing_contracts ADD COLUMN sync_day INTEGER'); } catch(e) {}
  try { db.run('ALTER TABLE pat_financing_contracts ADD COLUMN sync_category TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE pat_financing_contracts ADD COLUMN label TEXT'); } catch(e) {}
  try { db.run("ALTER TABLE pat_financing_contracts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"); } catch(e) {}
  try { db.run('ALTER TABLE pat_financing_contracts ADD COLUMN closed_month TEXT'); } catch(e) {}
  // Migration: pat_financing_contracts previously had UNIQUE(asset_id), which
  // SQLite can't drop via ALTER TABLE. Rebuild the table without that constraint
  // so an asset can have multiple contracts (sequential financing history).
  try {
    const tableInfo = first("SELECT sql FROM sqlite_master WHERE type='table' AND name='pat_financing_contracts'");
    if (tableInfo?.sql && tableInfo.sql.includes('UNIQUE')) {
      db.run('ALTER TABLE pat_financing_contracts RENAME TO pat_financing_contracts_old');
      db.run(`CREATE TABLE pat_financing_contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL REFERENCES pat_assets(id) ON DELETE CASCADE,
        label TEXT, status TEXT NOT NULL DEFAULT 'active', closed_month TEXT,
        system TEXT NOT NULL DEFAULT 'SAC', index_type TEXT NOT NULL DEFAULT 'none',
        annual_rate REAL NOT NULL DEFAULT 0, principal REAL NOT NULL DEFAULT 0,
        n_installments INTEGER NOT NULL DEFAULT 0, first_month TEXT NOT NULL,
        balloon_at_keys REAL, extra_annual_month INTEGER, extra_annual_value REAL,
        notes TEXT, sync_account_id INTEGER, sync_day INTEGER, sync_category TEXT,
        created_at TEXT DEFAULT (datetime('now')))`);
      db.run(`INSERT INTO pat_financing_contracts
        (id,asset_id,label,status,closed_month,system,index_type,annual_rate,principal,n_installments,
         first_month,balloon_at_keys,extra_annual_month,extra_annual_value,notes,sync_account_id,sync_day,sync_category,created_at)
        SELECT id,asset_id,label,COALESCE(status,'active'),closed_month,system,index_type,annual_rate,principal,n_installments,
         first_month,balloon_at_keys,extra_annual_month,extra_annual_value,notes,sync_account_id,sync_day,sync_category,created_at
        FROM pat_financing_contracts_old`);
      db.run('DROP TABLE pat_financing_contracts_old');
    }
  } catch(e) {}
  try { db.run('ALTER TABLE pat_financing ADD COLUMN contract_id INTEGER REFERENCES pat_financing_contracts(id) ON DELETE CASCADE'); } catch(e) {}
  // Backfill contract_id for existing installments (each asset had exactly one
  // contract before this migration, so map by asset_id).
  try {
    run(`UPDATE pat_financing SET contract_id = (
           SELECT id FROM pat_financing_contracts WHERE pat_financing_contracts.asset_id = pat_financing.asset_id LIMIT 1
         ) WHERE contract_id IS NULL`);
  } catch(e) {}
  // Cleanup: if the same asset/month ended up with two pat_financing rows (one
  // paid, one still-projected) due to a contract_id mismatch from an earlier
  // version, drop the stale projected duplicate and keep the paid one.
  try {
    run(`DELETE FROM pat_financing
         WHERE paid=0 AND is_projection=1
         AND EXISTS (
           SELECT 1 FROM pat_financing p2
           WHERE p2.asset_id = pat_financing.asset_id AND p2.month = pat_financing.month
           AND p2.paid=1 AND p2.id != pat_financing.id
         )`);
  } catch(e) {}
  // Migration: pat_financing previously had UNIQUE(asset_id, month). Rebuild
  // without that constraint so multiple contracts (sequential history) can
  // each have their own installment for the same calendar month if needed.
  try {
    const tableInfo = first("SELECT sql FROM sqlite_master WHERE type='table' AND name='pat_financing'");
    if (tableInfo?.sql && tableInfo.sql.includes('UNIQUE(asset_id')) {
      db.run('ALTER TABLE pat_financing RENAME TO pat_financing_old');
      db.run(`CREATE TABLE pat_financing (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL REFERENCES pat_assets(id) ON DELETE CASCADE,
        contract_id INTEGER REFERENCES pat_financing_contracts(id) ON DELETE CASCADE,
        month TEXT NOT NULL, installment REAL NOT NULL, principal REAL, interest REAL,
        correction REAL, balance_end REAL, is_projection INTEGER NOT NULL DEFAULT 1,
        paid INTEGER NOT NULL DEFAULT 0, linked_tx_id INTEGER,
        UNIQUE(contract_id, month))`);
      db.run(`INSERT INTO pat_financing
        (id,asset_id,contract_id,month,installment,principal,interest,correction,balance_end,is_projection,paid,linked_tx_id)
        SELECT id,asset_id,contract_id,month,installment,principal,interest,correction,balance_end,is_projection,paid,linked_tx_id
        FROM pat_financing_old`);
      db.run('DROP TABLE pat_financing_old');
    }
  } catch(e) {}
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
  try { db.run('ALTER TABLE pat_transactions ADD COLUMN tx_date TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE pat_transactions ADD COLUMN account_id INTEGER'); } catch(e) {}
  try { db.run('ALTER TABLE pat_transactions ADD COLUMN linked_tx_id INTEGER'); } catch(e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_pat_tx_asset ON pat_transactions(asset_id, month)'); } catch(e) {}
  try { db.run('ALTER TABLE transactions ADD COLUMN pat_debt_id INTEGER'); } catch(e) {}
  try { db.run('ALTER TABLE transactions ADD COLUMN pat_installment_month TEXT'); } catch(e) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS personal_debts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, notes TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`); } catch(e) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS personal_debt_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    debt_id INTEGER NOT NULL UNIQUE REFERENCES personal_debts(id) ON DELETE CASCADE,
    system TEXT NOT NULL DEFAULT 'SAC', index_type TEXT NOT NULL DEFAULT 'none',
    annual_rate REAL NOT NULL DEFAULT 0, principal REAL NOT NULL DEFAULT 0,
    n_installments INTEGER NOT NULL DEFAULT 0, first_month TEXT NOT NULL,
    balloon_at_keys REAL, extra_annual_month INTEGER, extra_annual_value REAL,
    notes TEXT, created_at TEXT DEFAULT (datetime('now')))`); } catch(e) {}
  try { db.run('ALTER TABLE personal_debt_contracts ADD COLUMN sync_account_id INTEGER'); } catch(e) {}
  try { db.run('ALTER TABLE personal_debt_contracts ADD COLUMN sync_day INTEGER'); } catch(e) {}
  try { db.run('ALTER TABLE personal_debt_contracts ADD COLUMN sync_category TEXT'); } catch(e) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS personal_debt_installments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    debt_id INTEGER NOT NULL REFERENCES personal_debts(id) ON DELETE CASCADE,
    month TEXT NOT NULL, installment REAL NOT NULL, principal REAL, interest REAL,
    correction REAL, balance_end REAL, is_projection INTEGER NOT NULL DEFAULT 1,
    paid INTEGER NOT NULL DEFAULT 0, UNIQUE(debt_id, month))`); } catch(e) {}
  try { db.run('ALTER TABLE personal_debt_installments ADD COLUMN linked_tx_id INTEGER'); } catch(e) {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_debt_installments ON personal_debt_installments(debt_id, month)'); } catch(e) {}
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
  // v4.5.9 / v4.7.2: late feature columns (also re-applied after DB decryption)
  ensureLateColumns();
  _backfillMissingFinancingTx();
  _backfillMissingCompraTx();
  save();
}

// Idempotent column migrations for features added after initial schema.
// Safe to call multiple times and after DB decryption (encrypted DBs miss
// migrations that ran against the still-locked placeholder DB at startup).
function ensureLateColumns() {
  // Garante que as tabelas existem antes de tentar alterar suas colunas — necessário
  // porque, em bancos criptografados, o CREATE TABLE original (em initDB) pode ter
  // rodado contra o banco ainda bloqueado e nunca chegado a criar a tabela de fato.
  const createIfMissing = [
    `CREATE TABLE IF NOT EXISTS pat_financing_contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES pat_assets(id) ON DELETE CASCADE,
      label TEXT, status TEXT NOT NULL DEFAULT 'active', closed_month TEXT,
      system TEXT NOT NULL DEFAULT 'SAC', index_type TEXT NOT NULL DEFAULT 'none',
      annual_rate REAL NOT NULL DEFAULT 0, principal REAL NOT NULL DEFAULT 0,
      n_installments INTEGER NOT NULL DEFAULT 0, first_month TEXT NOT NULL,
      balloon_at_keys REAL, extra_annual_month INTEGER, extra_annual_value REAL,
      notes TEXT, created_at TEXT DEFAULT (datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS pat_financing (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER NOT NULL REFERENCES pat_assets(id) ON DELETE CASCADE,
      month TEXT NOT NULL, installment REAL NOT NULL, paid INTEGER NOT NULL DEFAULT 0,
      UNIQUE(asset_id, month))`,
  ];
  createIfMissing.forEach(sql => { try { db.run(sql); } catch(e) {} });

  const alters = [
    'ALTER TABLE accounts ADD COLUMN credit_limit REAL DEFAULT 0',
    'ALTER TABLE budgets ADD COLUMN rollover INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE budgets ADD COLUMN rollover_months INTEGER NOT NULL DEFAULT 3',
    "ALTER TABLE budgets ADD COLUMN type TEXT NOT NULL DEFAULT 'expense'",
    'ALTER TABLE budgets ADD COLUMN consolidate_subs INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE personal_debts ADD COLUMN linked_account_id INTEGER',
    'ALTER TABLE pat_assets ADD COLUMN ownership_pct REAL',
    // Colunas de financiamento — também precisam existir mesmo se o banco
    // estava criptografado no startup (ver comentário em ensureLateColumns).
    'ALTER TABLE pat_assets ADD COLUMN financed INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE pat_assets ADD COLUMN financing_total REAL',
    'ALTER TABLE pat_assets ADD COLUMN total_value REAL',
    'ALTER TABLE pat_financing ADD COLUMN principal REAL',
    'ALTER TABLE pat_financing ADD COLUMN interest REAL',
    'ALTER TABLE pat_financing ADD COLUMN correction REAL',
    'ALTER TABLE pat_financing ADD COLUMN balance_end REAL',
    'ALTER TABLE pat_financing ADD COLUMN is_projection INTEGER NOT NULL DEFAULT 1',
    'ALTER TABLE pat_financing ADD COLUMN linked_tx_id INTEGER',
    'ALTER TABLE pat_financing_contracts ADD COLUMN sync_account_id INTEGER',
    'ALTER TABLE pat_financing_contracts ADD COLUMN sync_day INTEGER',
    'ALTER TABLE pat_financing_contracts ADD COLUMN sync_category TEXT',
    'ALTER TABLE pat_financing_contracts ADD COLUMN label TEXT',
    "ALTER TABLE pat_financing_contracts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    'ALTER TABLE pat_financing_contracts ADD COLUMN closed_month TEXT',
    // Mútuo — empréstimo concedido a terceiros, com juros e indexador
    // próprios (bem diferente de um bem físico financiado).
    'ALTER TABLE pat_assets ADD COLUMN mutuo_taxa_juros REAL',
    "ALTER TABLE pat_assets ADD COLUMN mutuo_indexador_base TEXT DEFAULT 'mensal'",
    'ALTER TABLE pat_assets ADD COLUMN mutuo_mes_incidencia INTEGER',
    'ALTER TABLE pat_assets ADD COLUMN mutuo_data_termino TEXT',
    'ALTER TABLE pat_assets ADD COLUMN mutuo_sync_account_id INTEGER',
    "ALTER TABLE pat_assets ADD COLUMN mutuo_juros_tipo TEXT DEFAULT 'simples'",
    "ALTER TABLE pat_assets ADD COLUMN mutuo_index_type TEXT DEFAULT 'none'",
    'ALTER TABLE pat_assets ADD COLUMN mutuo_dia_incidencia INTEGER DEFAULT 1',
    'ALTER TABLE pat_assets ADD COLUMN mutuo_sync_category TEXT',
    'ALTER TABLE pat_assets ADD COLUMN irpf_codigo TEXT',
    'ALTER TABLE pat_assets ADD COLUMN irpf_discriminacao TEXT',
    'ALTER TABLE personal_debts ADD COLUMN irpf_codigo TEXT',
    'ALTER TABLE accounts ADD COLUMN irpf_codigo TEXT',
    'ALTER TABLE accounts ADD COLUMN irpf_discriminacao TEXT',
    'ALTER TABLE inv_assets ADD COLUMN irpf_codigo TEXT',
    'ALTER TABLE inv_assets ADD COLUMN irpf_discriminacao TEXT',
    'ALTER TABLE pat_financing_contracts ADD COLUMN keys_balance REAL',
    'ALTER TABLE pat_financing_contracts ADD COLUMN keys_balance_month TEXT',
    // Mês de aquisição (compra) — distinto do mês da 1ª parcela (first_month),
    // usado como base real para a correção monetária. Estava sendo perdido ao
    // salvar o contrato (não fazia parte do INSERT/UPDATE), fazendo a UI cair
    // de volta para first_month ao reabrir o ativo.
    'ALTER TABLE pat_financing_contracts ADD COLUMN purchase_month TEXT',
    "ALTER TABLE pat_financing_contracts ADD COLUMN extra_annual_effect TEXT NOT NULL DEFAULT 'moment'",
    "ALTER TABLE pat_financing_contracts ADD COLUMN correction_ref_month TEXT NOT NULL DEFAULT 'minus2'",
    'ALTER TABLE pat_financing ADD COLUMN contract_id INTEGER REFERENCES pat_financing_contracts(id) ON DELETE CASCADE',
    // personal_debt_contracts nunca recebeu a coluna status (só
    // pat_financing_contracts tinha), mas o código já consulta
    // "WHERE status='active'" nela — gerando "no such column: status" e
    // interrompendo o recálculo de cronogramas de dívidas a cada fetch de
    // índices. Como debt_id é UNIQUE nessa tabela (1 contrato por dívida),
    // o default 'active' replica exatamente o comportamento já existente.
    "ALTER TABLE personal_debt_contracts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'",
    // Vínculo de recorrência a bem/direito / dívida pessoal
    'ALTER TABLE recurring ADD COLUMN pat_asset_id INTEGER',
    'ALTER TABLE recurring ADD COLUMN pat_tx_type TEXT',
    'ALTER TABLE recurring ADD COLUMN pat_debt_id INTEGER',
  ];
  alters.forEach(sql => { try { db.run(sql); } catch(e) {} });

  // Backfill único: mútuos que já tinham conta vinculada (mutuo_sync_account_id)
  // antes de mutuo_sync_category existir ficariam sem gerar mais transações
  // de juros (syncMutuoToBank agora exige os dois) — preserva o comportamento
  // anterior usando o nome que já era hardcoded, mas agora como categoria de
  // verdade (registrada via ensureCategoryExists, visível na aba Categorias).
  // Idempotente: só afeta linhas ainda sem categoria definida.
  try {
    const needsBackfill = all(`SELECT id FROM pat_assets WHERE asset_type='mutuo' AND mutuo_sync_account_id IS NOT NULL AND (mutuo_sync_category IS NULL OR mutuo_sync_category='')`);
    if (needsBackfill.length) {
      ensureCategoryExists('Juros Recebidos');
      run(`UPDATE pat_assets SET mutuo_sync_category='Juros Recebidos' WHERE asset_type='mutuo' AND mutuo_sync_account_id IS NOT NULL AND (mutuo_sync_category IS NULL OR mutuo_sync_category='')`);
    }
  } catch(e) {}

  // Limpeza retroativa: consolida duplicatas de (recurring_id, date,
  // account_id) já existentes por causa do bug corrigido nesta versão em
  // syncRecurringTxns (regenerava uma transação nova pra uma data que já
  // tinha uma, mesmo já conferida, a cada boot/login). O agrupamento
  // inclui account_id de propósito — uma recorrência de TRANSFERÊNCIA
  // sempre tem 2 linhas legítimas por data (uma em cada conta, mesmo
  // recurring_id), o que não é bug nenhum; agrupar só por
  // (recurring_id, date) tratava esse par legítimo como duplicata e
  // apagava uma perna da transferência a cada boot (o boot seguinte,
  // via syncRecurringTxns, recriava a perna que faltava — dando a
  // impressão de que a "limpeza" nunca convergia). Conservadora: NUNCA
  // apaga uma transação já conferida (cleared=1) — só remove as extras
  // NÃO conferidas de um grupo, mantendo no máximo 1 por
  // (recurring_id, date, account_id). Grupos onde todas as linhas já
  // estão conferidas ficam intocados (arriscado demais adivinhar qual
  // apagar) — só logados, pra revisão manual se necessário. Idempotente:
  // depois da 1ª limpeza não há mais duplicatas de verdade a achar.
  try {
    const dupGroups = all(`
      SELECT recurring_id, date, account_id, COUNT(*) as n, SUM(cleared) as clearedCount
      FROM transactions
      WHERE recurring_id IS NOT NULL
      GROUP BY recurring_id, date, account_id
      HAVING COUNT(*) > 1
    `);
    let removedDups = 0, skippedAllCleared = 0;
    dupGroups.forEach(g => {
      if (g.clearedCount >= g.n) { skippedAllCleared++; return; }
      const rows = all('SELECT id, cleared FROM transactions WHERE recurring_id=? AND date=? AND account_id=? ORDER BY cleared DESC, id ASC', [g.recurring_id, g.date, g.account_id]);
      rows.slice(1).forEach(r => {
        if (r.cleared === 1) return; // nunca apaga uma conferida
        run('DELETE FROM transactions WHERE id=?', [r.id]);
        removedDups++;
      });
    });
    if (removedDups > 0) console.log(`[migração] removidas ${removedDups} transação(ões) duplicada(s) de recorrência (não conferidas)`);
    if (skippedAllCleared > 0) console.log(`[migração] ${skippedAllCleared} grupo(s) de duplicatas com todas as linhas conferidas — não mexidas, revisar manualmente`);
  } catch(e) {}

  // Repara pernas órfãs de transferência recorrente: efeito colateral da
  // PRIMEIRA versão da limpeza acima (antes de incluir account_id no
  // agrupamento), que tratava as 2 pernas legítimas de uma transferência
  // recorrente (mesma data, mesmo recurring_id, contas diferentes) como
  // duplicata e apagava uma delas — quebrando a transferência (1 perna
  // sumida, saldo de uma das contas batendo errado). Recria a perna que
  // falta a partir da recorrência original (conta em falta = a que não é
  // a da perna sobrevivente, dentre account_id/transfer_to_account_id).
  // Só mexe em pernas ainda não conferidas (cleared=1 fica pra revisão
  // manual — não há como saber com segurança o valor certo da perna que
  // faltou). Idempotente: depois da 1ª execução não há mais órfã a achar.
  try {
    const orphanLegs = all(`
      SELECT t1.id, t1.recurring_id, t1.date, t1.account_id, t1.transfer_id, t1.cleared, t1.amount, t1.memo, t1.category
      FROM transactions t1
      WHERE t1.transfer_id IS NOT NULL AND t1.recurring_id IS NOT NULL
        AND (SELECT COUNT(*) FROM transactions t2 WHERE t2.transfer_id = t1.transfer_id) = 1
    `);
    let repairedOrphans = 0, skippedClearedOrphans = 0;
    orphanLegs.forEach(o => {
      if (o.cleared === 1) { skippedClearedOrphans++; return; }
      const rec = first('SELECT account_id, transfer_to_account_id FROM recurring WHERE id=?', [o.recurring_id]);
      if (!rec || !rec.transfer_to_account_id) return;
      const missingAccountId = o.account_id === rec.account_id ? rec.transfer_to_account_id : rec.account_id;
      run(`INSERT INTO transactions (account_id,date,category,memo,amount,cleared,transfer_id,recurring_id) VALUES (?,?,?,?,?,?,?,?)`,
        [missingAccountId, o.date, o.category, o.memo, -o.amount, o.cleared, o.transfer_id, o.recurring_id]);
      repairedOrphans++;
    });
    if (repairedOrphans > 0) console.log(`[migração] recriada(s) ${repairedOrphans} perna(s) órfã(s) de transferência recorrente`);
    if (skippedClearedOrphans > 0) console.log(`[migração] ${skippedClearedOrphans} perna(s) órfã(s) já conferida(s) — não mexidas, revisar manualmente`);
  } catch(e) {}

  // Reconciliação única: qualquer categoria que já exista em transações
  // reais (lançadas manualmente ou por alguma sincronização automática
  // antiga, incluindo bugs já corrigidos tipo a categoria literal
  // "Categoria") mas que nunca tenha sido registrada na aba Categorias —
  // registra agora. Não mexe nas transações em si, só torna a categoria
  // visível/gerenciável (renomear, mesclar, apagar) pela tela de
  // Categorias, em vez de aparecer "do nada" em telas como Evolução (que
  // lista categorias direto da tabela transactions, sem checar contra a
  // lista gerenciada pelo usuário). Idempotente — ensureCategoryExists já
  // não duplica o que já está lá.
  //
  // Exclui nomes que batem com uma conta cadastrada: bug identificado do
  // importador QIF (ver parseQIFMultiAccount) gravava o nome da conta
  // CONTRAPARTE de uma transferência como se fosse categoria — sem essa
  // exclusão, essa reconciliação ficava reintroduzindo contas bancárias,
  // cartões e contas de investimento na aba Categorias como se fossem
  // categorias de verdade.
  // Categorias que o usuário já excluiu deliberadamente pela aba Categorias
  // (deleteCategory) — nunca eram lembradas: como essa reconciliação só
  // olha pra `transactions.category` (nunca alterada pelo excluir, de
  // propósito, pra não reescrever histórico), qualquer transação antiga
  // que ainda tivesse aquele texto literal (ex: "categoria", de um bug já
  // corrigido há muito tempo) fazia a categoria REAPARECER no boot
  // seguinte — parecia que o app "recriava sozinha" toda vez que o
  // usuário apagava.
  try {
    let excludedList = [];
    const excludedPath = getExcludedCatsPath();
    if (fs.existsSync(excludedPath)) {
      try { excludedList = JSON.parse(fs.readFileSync(excludedPath, 'utf8')) || []; } catch(e) { excludedList = []; }
    }
    // "categoria" (minúscula, sem acento) é literalmente o resíduo do bug
    // antigo de placeholder — trata como excluída sempre, mesmo que o
    // usuário nunca tenha passado pela tela de exclusão nesta instalação.
    excludedList = Array.from(new Set([...(Array.isArray(excludedList) ? excludedList : []), 'categoria']));
    fs.writeFileSync(excludedPath, JSON.stringify(excludedList));
    const excludedCats = new Set(excludedList.map(c => String(c).toLowerCase()));
    const accountNames = new Set(all('SELECT name FROM accounts').map(a => String(a.name).toLowerCase()));
    const usedCats = all(`SELECT DISTINCT category FROM transactions WHERE category IS NOT NULL AND category != ''`);
    usedCats
      .filter(r => !accountNames.has(String(r.category).toLowerCase()) && !excludedCats.has(String(r.category).toLowerCase()))
      .forEach(r => ensureCategoryExists(r.category));

    // Limpeza única: remove da lista JÁ PERSISTIDA (_categories.json)
    // qualquer entrada que hoje bata com o nome de uma conta — cobre quem
    // já tinha rodado a reconciliação antiga (sem essa exclusão) e ficou
    // com contas "presas" na aba Categorias. Não mexe nas transações.
    const catsPath = getCatsPath();
    if (fs.existsSync(catsPath)) {
      const cats = JSON.parse(fs.readFileSync(catsPath, 'utf8')) || [];
      if (Array.isArray(cats)) {
        const cleaned = cats.filter(c => !accountNames.has(String(c).toLowerCase()));
        if (cleaned.length !== cats.length) fs.writeFileSync(catsPath, JSON.stringify(cleaned));
      }
    }

    // Limpeza retroativa das regras de ML: qualquer regra aprendida
    // ANTES do fix acima que ainda sugira uma categoria hoje excluída (ex:
    // "categoria") continuava fazendo o auto-preenchimento "trazer de
    // volta" a categoria fantasma em lançamentos novos, mesmo com a
    // transação de origem já sem esse texto — o gatilho não era a
    // transação em si, era a regra de sugestão automática por memorando.
    const badMlRules = all('SELECT keyword, category FROM ml_rules WHERE category IS NOT NULL AND category != \'\'')
      .filter(r => excludedCats.has(String(r.category).toLowerCase()));
    if (badMlRules.length) {
      badMlRules.forEach(r => run('UPDATE ml_rules SET category=\'\' WHERE keyword=?', [r.keyword]));
      console.log(`[migração] ${badMlRules.length} regra(s) de ML com categoria excluída limpa(s)`);
    }
  } catch(e) {}
}

function getExcludedCatsPath() {
  return getDbPath().replace('.db', '_categories_excluded.json');
}

// Cria retroativamente a movimentação "parcela_financiamento" para qualquer
// parcela de financiamento já marcada como paga (pat_financing.paid=1) que
// não tenha uma pat_transactions correspondente. Isso acontecia quando a
// parcela era marcada como paga pela edição inline na tabela (em vez do
// formulário de lançamento) — faltava criar essa movimentação, fazendo a
// parcela desaparecer do fluxo de caixa e inflar a TIR do ativo conforme
// mais parcelas eram pagas por esse caminho. Idempotente — só insere o que
// realmente falta, seguro de rodar a cada início.
function _backfillMissingFinancingTx() {
  try {
    const missing = all(`
      SELECT pf.asset_id, pf.month, pf.installment
      FROM pat_financing pf
      WHERE pf.paid = 1 AND pf.installment > 0
        AND NOT EXISTS (
          SELECT 1 FROM pat_transactions pt
          WHERE pt.asset_id = pf.asset_id
            AND substr(pt.month,1,7) = substr(pf.month,1,7)
            AND pt.tx_type = 'parcela_financiamento'
        )
    `);
    missing.forEach(row => {
      run(`INSERT INTO pat_transactions (asset_id, month, tx_type, total_value, notes)
           VALUES (?, ?, 'parcela_financiamento', ?, ?)`,
        [row.asset_id, row.month.slice(0,7), row.installment, 'Parcela paga (registro retroativo)']);
    });
    if (missing.length) console.log(`[financing backfill] ${missing.length} movimentação(ões) de parcela paga restauradas`);
  } catch(e) { console.warn('[financing backfill] falhou:', e.message); }
}

// Acha o mês manual MAIS ANTIGO de cada ativo (a compra/principal) que não
// tenha NENHUM pat_transactions registrado pra aquele mês, e cria o
// lançamento 'compra' que faltou — mesmo valor do histórico. Sem isso, a
// tabela de movimentações mostra uma linha "fantasma" (sem id, sem
// total_value, só com o valor do histórico pra exibição) cujo tipo nunca
// fica salvo de fato, por mais que o usuário troque o tipo na tela — porque
// ela nunca tem um total_value pra disparar o salvamento real.
function _backfillMissingCompraTx(assetId) {
  try {
    const missing = all(`
      SELECT ph.asset_id, ph.month, ph.value
      FROM pat_history ph
      WHERE ph.manual = 1
        AND ph.month = (SELECT MIN(month) FROM pat_history WHERE asset_id = ph.asset_id AND manual = 1)
        AND ph.value > 0
        ${assetId ? 'AND ph.asset_id = ?' : ''}
        AND NOT EXISTS (
          SELECT 1 FROM pat_transactions pt
          WHERE pt.asset_id = ph.asset_id AND substr(pt.month,1,7) = substr(ph.month,1,7)
        )
    `, assetId ? [assetId] : []);
    missing.forEach(row => {
      run(`INSERT INTO pat_transactions (asset_id, month, tx_type, total_value, notes)
           VALUES (?, ?, 'compra', ?, ?)`,
        [row.asset_id, row.month, row.value, 'Valor de compra do ativo (registro retroativo)']);
    });
    if (missing.length) { save(); console.log(`[compra backfill] ${missing.length} movimentação(ões) de compra restauradas`); }
  } catch(e) { console.warn('[compra backfill] falhou:', e.message); }
}

// ── DATA LOCAL ──
// Data/mês de HOJE no fuso do usuário. Todo o app usava a serialização ISO
// em UTC para descobrir "hoje" — e no Brasil (UTC−3)
// isso faz o app "virar o dia" às 21h — um lançamento feito às 22h era datado
// no dia seguinte, e no último dia do mês o orçamento/relatórios pulavam pro
// mês seguinte 3h antes da hora. Estas duas montam a data no relógio local.
const _pad2 = n => String(n).padStart(2, '0');
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`;
}
function monthLocal() { return todayLocal().slice(0, 7); }

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
ipcMain.handle('accounts:create', (_, { name, type, currency, credit_limit, bank_slug, bank_name, bank_icon_b64 }) => {
  try { db.run('ALTER TABLE accounts ADD COLUMN credit_limit REAL DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE accounts ADD COLUMN bank_slug TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE accounts ADD COLUMN bank_name TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE accounts ADD COLUMN bank_icon_b64 TEXT'); } catch(e) {}
  const maxOrder = first('SELECT MAX(sort_order) as m FROM accounts WHERE type=?', [type])?.m || 0;
  let id;
  try {
    id = run('INSERT INTO accounts (name,type,currency,sort_order,credit_limit,bank_slug,bank_name,bank_icon_b64) VALUES (?,?,?,?,?,?,?,?)',
      [name, type, currency||'BRL', maxOrder+1, credit_limit||0, bank_slug||null, bank_name||null, bank_icon_b64||null]);
  } catch(e) {
    id = run('INSERT INTO accounts (name,type,currency,sort_order) VALUES (?,?,?,?)', [name, type, currency||'BRL', maxOrder+1]);
  }
  save();
  return first('SELECT * FROM accounts WHERE id=?', [id]);
});
ipcMain.handle('accounts:update', (_, { id, name, type, currency, hidden, credit_limit, bank_slug, bank_name, bank_icon_b64 }) => {
  try { db.run('ALTER TABLE accounts ADD COLUMN credit_limit REAL DEFAULT 0'); } catch(e) {}
  try { db.run('ALTER TABLE accounts ADD COLUMN bank_slug TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE accounts ADD COLUMN bank_name TEXT'); } catch(e) {}
  try { db.run('ALTER TABLE accounts ADD COLUMN bank_icon_b64 TEXT'); } catch(e) {}
  try {
    run('UPDATE accounts SET name=?,type=?,currency=?,hidden=?,credit_limit=?,bank_slug=?,bank_name=?,bank_icon_b64=? WHERE id=?',
      [name, type, currency, hidden?1:0, credit_limit||0, bank_slug||null, bank_name||null, bank_icon_b64||null, id]);
  } catch(e) {
    run('UPDATE accounts SET name=?,type=?,currency=?,hidden=? WHERE id=?', [name, type, currency, hidden?1:0, id]);
  }
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
  const today = todayLocal();
  return (first('SELECT COALESCE(SUM(amount),0) as bal FROM transactions WHERE account_id=? AND date <= ?', [id, today])?.bal || 0);
});
ipcMain.handle('accounts:balance-including-future', (_, id) => {
  const row = first('SELECT COALESCE(SUM(amount),0) as bal FROM transactions WHERE account_id=?', [id]);
  return row?.bal ?? 0;
});
ipcMain.handle('accounts:balance-before', (_, { accountId, beforeDate }) => {
  return (first('SELECT COALESCE(SUM(amount),0) as bal FROM transactions WHERE account_id=? AND date < ?', [accountId, beforeDate])?.bal || 0);
});

// Transactions
ipcMain.handle('tx:list', (_, { accountId, sortBy, order, fromDate }) => {
  // Sem conta válida não há o que listar — evita "bind undefined" no SQLite
  // (o handler era chamado com accountId undefined em alguns momentos de
  // render, ex.: dashboard antes de a conta estar pronta).
  if (accountId == null) return [];
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
  const id = run(`INSERT INTO transactions (account_id,date,category,memo,amount,cleared,transfer_id,recurring_id,pat_asset_id,pat_tx_id,pat_debt_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [tx.account_id, tx.date, tx.category||'', tx.memo||'', tx.amount, tx.cleared||0, tx.transfer_id||null, tx.recurring_id||null, tx.pat_asset_id||null, tx.pat_tx_id||null, tx.pat_debt_id||null]);
  pushUndo(`Criar "${tx.memo||tx.category||'lançamento'}"`, [
    { sql: 'DELETE FROM transactions WHERE id=?', params: [id] }
  ]);
  return first('SELECT * FROM transactions WHERE id=?', [id]);
});
ipcMain.handle('tx:update', (_, { id, date, category, memo, amount, cleared, pat_asset_id, pat_tx_id, pat_debt_id }) => {
  const old = first('SELECT * FROM transactions WHERE id=?', [id]);

  // Esta perna pertencia a uma transferência real (transfer_id) e deixou de
  // ter categoria de transferência: desfaz as DUAS pernas e recria como um
  // único lançamento comum, em vez de deixar uma perna órfã/inconsistente.
  if (old?.transfer_id && !isTransferCat(category)) {
    const paired = first('SELECT * FROM transactions WHERE transfer_id=? AND id!=?', [old.transfer_id, id]);
    run('DELETE FROM transactions WHERE transfer_id=?', [old.transfer_id]);
    const newId = run('INSERT INTO transactions (account_id,date,category,memo,amount,cleared,pat_asset_id,pat_tx_id,pat_debt_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [old.account_id, date, category, memo, amount, cleared?1:0, pat_asset_id||null, pat_tx_id||null, pat_debt_id||null]);
    pushUndo(`Editar "${old.memo||old.category}"`, [
      { sql: 'DELETE FROM transactions WHERE id=?', params: [newId] },
      { sql: 'INSERT INTO transactions (id,account_id,date,category,memo,amount,cleared,transfer_id) VALUES (?,?,?,?,?,?,?,?)',
        params: [old.id, old.account_id, old.date, old.category, old.memo, old.amount, old.cleared, old.transfer_id] },
      ...(paired ? [{ sql: 'INSERT INTO transactions (id,account_id,date,category,memo,amount,cleared,transfer_id) VALUES (?,?,?,?,?,?,?,?)',
        params: [paired.id, paired.account_id, paired.date, paired.category, paired.memo, paired.amount, paired.cleared, paired.transfer_id] }] : [])
    ]);
    save();
    return first('SELECT * FROM transactions WHERE id=?', [newId]);
  }

  run('UPDATE transactions SET date=?,category=?,memo=?,amount=?,cleared=?,pat_asset_id=?,pat_tx_id=?,pat_debt_id=? WHERE id=?',
    [date, category, memo, amount, cleared?1:0, pat_asset_id||null, pat_tx_id||null, pat_debt_id||null, id]);

  // If "cleared" changed on a transaction linked to a financing/debt installment
  // (auto-synced from Patrimônio), reflect the paid status there too.
  if (old && old.cleared !== (cleared?1:0) && old.pat_installment_month) {
    const updated = first('SELECT * FROM transactions WHERE id=?', [id]);
    if (cleared) _onInstallmentTxCleared(updated);
    else _onInstallmentTxUncleared(updated);
  }

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
    // Also restore paired leg if transfer — the paired leg's original amount is -old.amount
    ...(old.transfer_id ? [{
      sql: 'UPDATE transactions SET date=?,memo=?,amount=? WHERE transfer_id=? AND id!=?',
      params: [old.date, old.memo, -old.amount, old.transfer_id, id]   // paired leg = inverse of edited leg
    }] : [])
  ]);
  save();
  return first('SELECT * FROM transactions WHERE id=?', [id]);
});
ipcMain.handle('tx:delete', (_, id) => {
  const tx = first('SELECT * FROM transactions WHERE id=?', [id]);
  // Capture the paired transfer leg BEFORE deleting, so undo can restore both legs
  let pairedLeg = null;
  if (tx?.transfer_id) {
    pairedLeg = first('SELECT * FROM transactions WHERE transfer_id=? AND id!=?', [tx.transfer_id, id]);
    run('DELETE FROM transactions WHERE transfer_id=? AND id!=?', [tx.transfer_id, id]);
  }
  // If this is a future uncleared recurring tx, remember the exclusion so sync won't recreate it
  if (tx?.recurring_id && tx.cleared === 0 && tx.date >= todayLocal()) {
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
    // Restore the paired transfer leg too
    ...(pairedLeg ? [{
      sql: 'INSERT INTO transactions (id,account_id,date,category,memo,amount,cleared,transfer_id) VALUES (?,?,?,?,?,?,?,?)',
      params: [pairedLeg.id, pairedLeg.account_id, pairedLeg.date, pairedLeg.category, pairedLeg.memo, pairedLeg.amount, pairedLeg.cleared, pairedLeg.transfer_id]
    }] : []),
    // Also remove the exclusion so undo restores correctly
    { sql: 'DELETE FROM recurring_excludes WHERE recurring_id=? AND date=?',
      params: [tx.recurring_id||0, tx.date] }
  ]);
  return {ok:true};
});

// Transfer
ipcMain.handle('tx:get-transfer-pair', (_, { txId }) => {
  const tx = first('SELECT * FROM transactions WHERE id=?', [txId]);
  if (!tx?.transfer_id) return null;
  const paired = first('SELECT * FROM transactions WHERE transfer_id=? AND id!=?', [tx.transfer_id, txId]);
  return paired ? { account_id: paired.account_id, amount: paired.amount } : null;
});
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

  const ins = `INSERT INTO transactions (account_id,date,category,memo,amount,cleared,transfer_id) VALUES (?,?,?,?,?,?,?)`;
  const checkDup = `SELECT id FROM transactions WHERE account_id=? AND date=? AND ABS(amount-?)<=0.01 AND memo=? LIMIT 1`;
  let totalInserted = 0, skipped = 0, duplicates = 0;
  const unknownAccounts = [];

  // ── Detecta e vincula transferências marcadas pelo QIF (L[Conta]) ──
  // Achata todas as transações de todas as contas numa lista só, pra poder
  // casar cada perna de transferência com sua contraparte em OUTRA conta do
  // mesmo arquivo (mesma data, valor oposto, e a conta bate com o nome
  // marcado). Pares casados ganham um transfer_id novo compartilhado — igual
  // a uma transferência criada manualmente pela UI (tx:transfer). Perna sem
  // contraparte encontrada (conta não fez parte deste import, ou não foi
  // reconhecida) cai pra lançamento avulso, sem contaminar a categoria com o
  // nome da conta — fica sem categoria, pra o usuário classificar depois,
  // igual a qualquer lançamento importado sem categoria reconhecida.
  const flat = [];
  Object.entries(byAccount).forEach(([accName, txns]) => {
    txns.forEach(t => flat.push({ ...t, _accName: accName }));
  });
  let nextTransferId = first('SELECT COALESCE(MAX(transfer_id),0) as m FROM transactions')?.m || 0;
  flat.forEach(t => { t._used = false; });
  flat.forEach(t => {
    if (t._used || !t.transferAccount) return;
    const counterpart = flat.find(o =>
      !o._used && o !== t && o.date === t.date &&
      Math.abs(Math.abs(o.amount) - Math.abs(t.amount)) <= 0.01 &&
      Math.sign(o.amount) === -Math.sign(t.amount) &&
      normAcc(o._accName) === normAcc(t.transferAccount)
    );
    if (counterpart) {
      nextTransferId++;
      t._used = true; counterpart._used = true;
      t._transferId = nextTransferId; counterpart._transferId = nextTransferId;
      t.category = ''; counterpart.category = '';
    }
  });

  db.run('BEGIN');
  try {
    for (const t of flat) {
      if (!t.date) { skipped++; continue; }
      const acc = findAccount(t._accName);
      if (!acc) { if (!unknownAccounts.includes(t._accName)) unknownAccounts.push(t._accName); skipped++; continue; }
      const dup = first(checkDup, [acc.id, t.date, t.amount, t.memo]);
      if (dup) { duplicates++; continue; }
      // Transferência sem contraparte encontrada: não usa o nome da conta
      // como categoria (era o bug) — fica sem categoria, e o memo guarda a
      // pista de qual conta seria, pra facilitar reconciliação manual.
      const category = t._transferId ? '' : (t.transferAccount ? '' : (t.category || ''));
      const memo = (!t._transferId && t.transferAccount)
        ? `${t.memo || 'Transferência'} (${t.transferAccount})`
        : (t.memo || '');
      db.run(ins, [acc.id, t.date, category, memo, t.amount, t.cleared?1:0, t._transferId || null]);
      totalInserted++;
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
        // Não usa t.transferAccount como categoria — ver financial:import
        // (caminho ativo da UI) pra explicação completa e o vínculo por
        // transfer_id feito lá. Este handler parece não ser mais usado pela
        // UI atual, mas mantém a mesma correção defensivamente.
        const category = t.transferAccount ? '' : (t.category || '');
        const memo = t.transferAccount ? `${t.memo || 'Transferência'} (${t.transferAccount})` : (t.memo || '');
        db.run(ins, [acc.id, t.date, category, memo, t.amount, t.cleared ? 1 : 0]);
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
  if (excludeTransfers) { where += ` AND (t.category IS NULL OR LOWER(t.category) NOT LIKE '%transfer%') AND t.transfer_id IS NULL`; }
  return all(`SELECT t.category,
    SUM(CASE WHEN t.amount<0 THEN ABS(t.amount) ELSE 0 END) as expenses,
    SUM(CASE WHEN t.amount>0 THEN t.amount ELSE 0 END) as income,
    COUNT(*) as count
    FROM transactions t ${where} GROUP BY t.category ORDER BY expenses DESC`, p);
});
ipcMain.handle('report:monthly', (_, { fromDate, toDate, accountIds, excludeTransfers, categories }) => {
  let where = "WHERE category IS NOT NULL AND category != ''"; const p = [];
  if (fromDate) { where += ' AND date>=?'; p.push(fromDate); }
  if (toDate)   { where += ' AND date<=?'; p.push(toDate); }
  if (accountIds?.length) { where += ` AND account_id IN (${accountIds.map(()=>'?').join(',')})`; p.push(...accountIds); }
  if (excludeTransfers) { where += ` AND (category IS NULL OR LOWER(category) NOT LIKE '%transfer%') AND transfer_id IS NULL`; }
  if (categories?.length) { where += ` AND category IN (${categories.map(()=>'?').join(',')})`; p.push(...categories); }
  // Agrupa por (mês, categoria) — não só por mês — pra permitir que o
  // front-end classifique cada categoria pelo saldo líquido dela (igual ao
  // relatório "Resumo"), em vez de somar bruto. Sem isso, uma categoria com
  // receita E despesa no mesmo mês (ex.: juros com um ajuste negativo)
  // inflava os dois totais simultaneamente, mesmo a diferença batendo.
  return all(`SELECT substr(date,1,7) as month, category,
    SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as expenses,
    SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) as income
    FROM transactions ${where} GROUP BY month, category ORDER BY month`, p);
});

// Monthly by category for trend chart
ipcMain.handle('report:monthly-by-category', (_, { fromDate, excludeTransfers }) => {
  let where = 'WHERE amount < 0';
  const p = [];
  if (fromDate) { where += ' AND date>=?'; p.push(fromDate); }
  if (excludeTransfers) { where += ` AND (category IS NULL OR LOWER(category) NOT LIKE '%transfer%') AND transfer_id IS NULL`; }
  return all(`SELECT substr(date,1,7) as month, category,
    SUM(ABS(amount)) as total
    FROM transactions ${where}
    GROUP BY month, category ORDER BY month, total DESC`, p);
});

// Por padrão, a lista de "lançamentos futuros" (Visão Geral) não mostra
// parcelamentos/assinaturas de cartão de crédito — não há nada de útil que
// o usuário possa fazer com esse aviso (ao contrário de conta corrente, onde
// ele pode precisar se preparar pra ter saldo suficiente).
function getIncludeCreditFuturePref() {
  const s = loadSettings();
  return s.includeCreditInFuturePending === true;
}
ipcMain.handle('settings:get-include-credit-future', () => getIncludeCreditFuturePref());
ipcMain.handle('settings:set-include-credit-future', (_, enabled) => {
  const s = loadSettings();
  s.includeCreditInFuturePending = !!enabled;
  saveSettings(s);
  return { ok: true };
});

// Future pending (not cleared, date > today)
ipcMain.handle('report:future-pending', () => {
  const today = todayLocal();
  const creditFilter = getIncludeCreditFuturePref() ? '' : "AND a.type != 'credit'";
  return all(`SELECT t.*, a.name as account_name FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    WHERE t.date > ? AND t.cleared = 0
    AND (t.category IS NULL OR LOWER(t.category) NOT LIKE '%transfer%')
    AND t.transfer_id IS NULL
    ${creditFilter}
    ORDER BY t.date ASC, (CASE WHEN t.amount < 0 THEN 1 ELSE 0 END) ASC`, [today]);
});
// ── Cash-flow projection: starting balances + all future-dated transactions ──
// Returns: { accounts:[{id,name,type,currency,startBal}], events:[{date,account_id,memo,category,amount,cleared,isTransfer}] }
// Future transactions already include recurring instances and financing sync legs,
// so we just union starting balances with everything dated after today.
ipcMain.handle('report:cashflow-projection', (_, opts) => {
  const today    = todayLocal();
  const horizon  = opts?.horizonMonths || 6;
  const accIds   = (opts?.accountIds && opts.accountIds.length) ? opts.accountIds : null;
  const includeCredit = opts?.includeCredit ?? false;
  const includeInvestment = opts?.includeInvestment ?? false;

  // End date = today + horizon months
  const d = new Date(today + 'T00:00:00');
  d.setMonth(d.getMonth() + horizon);
  const endDate = d.toISOString().slice(0,10);

  // Eligible accounts
  let accWhere = 'hidden=0';
  if (!includeCredit) accWhere += " AND type != 'credit'";
  if (!includeInvestment) accWhere += " AND type != 'investment'";
  if (accIds) accWhere += ` AND id IN (${accIds.map(()=>'?').join(',')})`;
  const accounts = all(`SELECT id,name,type,currency FROM accounts WHERE ${accWhere} ORDER BY type, sort_order`,
    accIds ? accIds : []);
  const eligibleIds = accounts.map(a => a.id);
  if (!eligibleIds.length) return { accounts: [], events: [], startTotal: 0 };

  const idList = eligibleIds.map(()=>'?').join(',');

  // Starting balance per account (everything up to and including today)
  accounts.forEach(a => {
    const row = first('SELECT COALESCE(SUM(amount),0) as bal FROM transactions WHERE account_id=? AND date<=?', [a.id, today]);
    a.startBal = row?.bal || 0;
  });
  const startTotal = accounts.reduce((s,a) => s + a.startBal, 0);

  // Future-dated events within horizon (include cleared + uncleared; they all affect the balance)
  const events = all(`SELECT t.date, t.account_id, t.memo, t.category, t.amount, t.cleared,
      (CASE WHEN t.transfer_id IS NOT NULL THEN 1 ELSE 0 END) as isTransfer
    FROM transactions t
    WHERE t.account_id IN (${idList}) AND t.date > ? AND t.date <= ?
    ORDER BY t.date ASC, (CASE WHEN t.amount < 0 THEN 1 ELSE 0 END) ASC`,
    [...eligibleIds, today, endDate]);

  return { accounts, events, startTotal, today, endDate, horizonMonths: horizon };
});

ipcMain.handle('report:net-worth', (_, { date }) => {
  const d = date || todayLocal();
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
      AND (category IS NULL OR LOWER(category) NOT LIKE '%transfer%')
      AND date >= date('now','-3 months')
    GROUP BY month ORDER BY month DESC LIMIT 3`);
  if (!rows.length) return 0;
  return rows.reduce((s,r) => s + r.total, 0) / rows.length;
});
// Get average monthly savings (income - expenses, last 3 months)
ipcMain.handle('goal:avg-monthly-savings', () => {
  // Use up to 12 months of past data (excluding future months)
  const today = monthLocal(); // YYYY-MM
  const rows = all(`
    SELECT substr(date,1,7) as month,
      SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) as income,
      SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as expenses
    FROM transactions
    WHERE transfer_id IS NULL
      AND (category IS NULL OR LOWER(category) NOT LIKE '%transfer%')
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
ipcMain.handle('budget:list', () => all('SELECT * FROM budgets WHERE active=1 ORDER BY type DESC, category'));
ipcMain.handle('budget:save', (_, { id, category, monthly_limit, alert_pct, rollover, rollover_months, type, consolidate_subs }) => {
  const rv = rollover ? 1 : 0;
  const rm = Math.max(1, Math.min(60, parseInt(rollover_months) || 3));
  const ty = type === 'income' ? 'income' : 'expense';
  const cs = consolidate_subs === false ? 0 : 1;
  if (id) {
    run('UPDATE budgets SET category=?,monthly_limit=?,alert_pct=?,rollover=?,rollover_months=?,type=?,consolidate_subs=? WHERE id=?',
      [category, monthly_limit, alert_pct||80, rv, rm, ty, cs, id]);
  } else {
    run('INSERT OR REPLACE INTO budgets (category,monthly_limit,alert_pct,rollover,rollover_months,type,consolidate_subs,active) VALUES (?,?,?,?,?,?,?,1)',
      [category, monthly_limit, alert_pct||80, rv, rm, ty, cs]);
  }
  save();
  return { ok: true };
});
// Rollover: accumulated leftover (limit - spent) from all prior months since the budget existed,
// only for categories with rollover enabled. Positive = surplus carried forward; negative = overspend carried.
ipcMain.handle('budget:rollover-balance', (_, { beforeMonth }) => {
  const rolloverCats = all('SELECT category, monthly_limit, rollover_months, consolidate_subs FROM budgets WHERE active=1 AND rollover=1');
  if (!rolloverCats.length) return {};

  // Helper: build the N months immediately before beforeMonth (capped window)
  function priorMonths(n) {
    const arr = [];
    let [y, mo] = beforeMonth.split('-').map(Number);
    for (let i = 0; i < n; i++) {
      mo--; if (mo < 1) { mo = 12; y--; }
      arr.push(`${y}-${String(mo).padStart(2,'0')}`);
    }
    return arr; // most-recent-first; order doesn't matter for a sum
  }

  const result = {};
  rolloverCats.forEach(({ category, monthly_limit, rollover_months, consolidate_subs }) => {
    const win = Math.max(1, Math.min(60, rollover_months || 3));
    const months = priorMonths(win);
    // Precisa considerar as SUBCATEGORIAS (mesma regra usada em todo o
    // resto do Orçamento, via consolidate_subs) — sem isso, um gasto
    // lançado em "Categoria:Subcategoria" nunca contava como "gasto" aqui
    // (só o match exato da categoria-mãe era considerado), fazendo o
    // rollover acumular o limite mensal INTEIRO todo mês, mesmo quando a
    // pessoa realmente gastava (só que na subcategoria).
    const catFilter = consolidate_subs === 0
      ? 'category=?'
      : "(category=? OR category LIKE ? || ':%')";
    let acc = 0;
    months.forEach(ym => {
      const from = ym + '-01', to = ym + '-31';
      const params = consolidate_subs === 0 ? [category, from, to] : [category, category, from, to];
      const row = first(`SELECT SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as spent
        FROM transactions WHERE ${catFilter} AND date>=? AND date<=? AND transfer_id IS NULL`,
        params);
      const spent = row?.spent || 0;
      acc += (monthly_limit - spent); // leftover for the month (can be negative)
    });
    result[category] = acc;
  });
  return result;
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
      AND (category IS NULL OR LOWER(category) NOT LIKE '%transfer%')
    GROUP BY category`, [from, to]);
});

// Budget: 3-month average spending per category
ipcMain.handle('budget:avg3m', (_, { beforeMonth }) => {
  const d = new Date(beforeMonth + '-01');
  const months = [];
  for (let i = 1; i <= 3; i++) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    months.push(`${m.getFullYear()}-${String(m.getMonth()+1).padStart(2,'0')}`);
  }
  return all(`SELECT category, SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END)/3.0 as avg_spent
    FROM transactions WHERE substr(date,1,7) IN (${months.map(()=>'?').join(',')})
    AND transfer_id IS NULL AND amount<0
    AND (category IS NULL OR LOWER(category) NOT LIKE '%transfer%')
    GROUP BY category`, months);
});

// Budget: monthly budgeted vs actual by category
ipcMain.handle('report:budget', (_, { fromDate, toDate, excludeTransfers }) => {
  let where = 'WHERE 1=1'; const p = [];
  if (fromDate) { where += ' AND date>=?'; p.push(fromDate); }
  if (toDate)   { where += ' AND date<=?'; p.push(toDate); }
  if (excludeTransfers) { where += ` AND (category IS NULL OR LOWER(category) NOT LIKE '%transfer%') AND transfer_id IS NULL`; }
  // Monthly actuals by category
  const rows = all(`SELECT substr(date,1,7) as month, category,
    SUM(CASE WHEN amount<0 THEN ABS(amount) ELSE 0 END) as expenses,
    SUM(CASE WHEN amount>0 THEN amount ELSE 0 END) as income,
    COUNT(*) as count
    FROM transactions ${where}
    GROUP BY month, category ORDER BY month, expenses DESC`, p);
  return rows;
});
// ── ML de categorização — núcleo compartilhado ─────────────────────────
// Tokeniza descrições ignorando "ruído" típico de extratos: códigos de
// autorização, sufixos de cartão, datas, marcadores de parcela e palavras
// genéricas de banco que não identificam o estabelecimento.
const ML_STOPWORDS = new Set([
  'pagamento','compra','cartao','debito','credito','pix','ted','doc','transf',
  'transferencia','recebida','enviada','loja','ltda','me','sa','eireli','epp',
  'brasil','br','com','de','do','da','dos','das','em','no','na','para','via',
]);
function mlTokens(desc) {
  const normed = normKey(desc);
  return normed.split(/[\s\/\-\*\.,:;()]+/).filter(t => {
    if (t.length < 3) return false;
    if (/^\d+$/.test(t)) return false;                    // só números
    if (/^\d{2}[\/\-]\d{2}/.test(t)) return false;        // datas
    if (/^parc/.test(t)) return false;                    // parcela/parc
    if (/^\d+x\d*$/.test(t)) return false;                // 3x, 10x2
    if (/\d{4,}/.test(t)) return false;                   // códigos com 4+ dígitos
    if (/[a-z]/.test(t) && (t.match(/\d/g)||[]).length >= 2) return false; // códigos alfanuméricos (8k3j2)
    if (ML_STOPWORDS.has(t)) return false;
    return true;
  });
}
// Pontua uma regra contra uma descrição+valor. Retorna score numérico.
// tokens/tokSet do desc são pré-computados pelo chamador (batch-friendly).
function mlScoreRule(rule, key, tokSet, amount) {
  let ds = 0;
  if (key === rule.keyword) {
    ds = 10; // match exato
  } else if (rule.keyword && key.includes(rule.keyword)) {
    ds = rule.keyword.length / key.length * 8;
  } else {
    // Sobreposição de tokens ponderada por comprimento (tokens mais longos
    // e específicos valem mais — "starbucks" > "pao")
    const rTokens = rule._tokens || (rule._tokens = mlTokens(rule.keyword));
    if (!rTokens.length) return 0;
    let hitW = 0, totW = 0, hits = 0;
    for (const t of rTokens) {
      totW += t.length;
      if (tokSet.has(t)) { hitW += t.length; hits++; }
    }
    if (hitW === 0) return 0;
    const coverage = hitW / totW;
    ds = coverage * 6;
    // Cobertura mínima: evita generalizar a partir de um único token
    // genérico em comum ("posto", "mercado"). Regras multi-token exigem
    // 2+ tokens batendo (ou um token dominante ≥60% do peso, caso de
    // regras tipo "netflix assinatura" onde só o nome importa).
    if (hitW < 4 || coverage < 0.45) return 0;
    if (rTokens.length > 1 && hits < 2 && coverage < 0.6) return 0;
  }
  // Similaridade de valor (0.5–1.0): transações do mesmo estabelecimento
  // tendem a ter valores parecidos (assinaturas) ou ao menos mesma ordem
  let vs = 0.5;
  if (rule.n_val > 0) {
    const mean = rule.sum_val / rule.n_val;
    const dist = Math.abs(Math.abs(amount) - Math.abs(mean)) / (Math.abs(mean) || 1);
    vs = Math.max(0, 1 - dist);
  }
  // Reforço por frequência: regra usada 20x é mais confiável que usada 1x
  const freq = 1 + Math.log10((rule.count || 1)) * 0.25;
  return ds * (0.5 + 0.5 * vs) * freq;
}
// Threshold de confiança: abaixo disso, melhor não sugerir do que errar.
const ML_MIN_SCORE = 1.6;

ipcMain.handle('ml:predict', (_, { desc, amount }) => {
  const key = normKey(desc);
  const tokSet = new Set(mlTokens(desc));
  const rules = all('SELECT * FROM ml_rules ORDER BY count DESC');
  let best = null, bestScore = 0;
  for (const r of rules) {
    const score = mlScoreRule(r, key, tokSet, amount);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  if (!best || bestScore < ML_MIN_SCORE) return null;
  return { ...best, _score: Math.round(bestScore * 100) / 100 };
});

// Predição em lote — uma chamada IPC para todas as linhas da importação.
// Carrega as regras uma única vez e tokeniza cada uma apenas na 1ª vez.
ipcMain.handle('ml:predict-batch', (_, { rows }) => {
  if (!Array.isArray(rows) || !rows.length) return [];
  const rules = all('SELECT * FROM ml_rules ORDER BY count DESC');
  return rows.map(({ desc, amount }) => {
    const key = normKey(desc);
    const tokSet = new Set(mlTokens(desc));
    let best = null, bestScore = 0;
    for (const r of rules) {
      const score = mlScoreRule(r, key, tokSet, amount);
      if (score > bestScore) { bestScore = score; best = r; }
    }
    if (!best || bestScore < ML_MIN_SCORE) return null;
    return { memo: best.memo || '', category: best.category || '', score: Math.round(bestScore * 100) / 100, transfer_account_id: best.transfer_account_id || null };
  });
});
ipcMain.handle('ml:learn', (_, { desc, memo, category, amount, transfer_account_id }) => {
  const key = normKey(desc).substring(0,50); if (!key) return;
  const abs = Math.abs(amount||0);
  // transfer_account_id só é gravado quando a categoria aprendida é de fato
  // "Transferência" — nos demais casos zera qualquer associação antiga (evita
  // reaproveitar destino de uma transferência velha numa regra reaprendida
  // depois como categoria comum).
  const tAcc = isTransferCat(category) ? (transfer_account_id || null) : null;
  const ex  = first('SELECT * FROM ml_rules WHERE keyword=?', [key]);
  if (ex) {
    run('UPDATE ml_rules SET memo=?,category=?,count=count+1,sum_val=sum_val+?,n_val=n_val+1, min_val=CASE WHEN ?<min_val OR min_val IS NULL THEN ? ELSE min_val END, max_val=CASE WHEN ?>max_val OR max_val IS NULL THEN ? ELSE max_val END, transfer_account_id=? WHERE keyword=?',
      [memo||'', category||'', abs, abs, abs, abs, abs, tAcc, key]);
  } else {
    run('INSERT INTO ml_rules (keyword,memo,category,count,sum_val,n_val,min_val,max_val,transfer_account_id) VALUES (?,?,?,1,?,1,?,?,?)',
      [key, memo||'', category||'', abs, abs, abs, tAcc]);
  }
});
ipcMain.handle('ml:list',   () => all('SELECT * FROM ml_rules ORDER BY count DESC'));
ipcMain.handle('ml:clear',  () => { run('DELETE FROM ml_rules'); return {ok:true}; });
ipcMain.handle('ml:update', (_, { keyword, memo, category }) => {
  run('UPDATE ml_rules SET memo=?, category=? WHERE keyword=?', [memo||'', category||'', keyword]);
  save();
  return { ok: true };
});
ipcMain.handle('ml:delete', (_, { keyword }) => {
  run('DELETE FROM ml_rules WHERE keyword=?', [keyword]);
  save();
  return { ok: true };
});
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
  // O agrupamento inclui account_id de propósito — uma recorrência de
  // TRANSFERÊNCIA tem 2 linhas legítimas por (recurring_id, date), uma em
  // cada conta; agrupar só por (recurring_id, date) tratava esse par como
  // duplicata e apagava uma perna a cada login, desfazendo o reparo de
  // pernas órfãs feito em ensureLateColumns() (que roda logo antes desta
  // função, no mesmo fluxo de login:check).
  try {
    db.run(`DELETE FROM transactions
      WHERE cleared=0
        AND recurring_id IS NOT NULL
        AND date < date('now')
        AND id NOT IN (
          SELECT MIN(id) FROM transactions
          WHERE cleared=0 AND recurring_id IS NOT NULL AND date < date('now')
          GROUP BY recurring_id, date, account_id
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
  const today  = todayLocal();
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

  // Datas que JÁ têm uma transação real pra essa recorrência (qualquer
  // status) — sobretudo as CONFERIDAS (cleared=1), que o DELETE acima
  // nunca apaga de propósito. Sem checar isso, o loop abaixo regenerava
  // a mesma data de novo (o algoritmo sempre recalcula a partir de
  // next_date, que nunca avança/persiste, sem saber que aquela ocorrência
  // já existe) — criava uma segunda transação `cleared=0` do lado da
  // original já conferida. Essa função roda em toda abertura do app com
  // senha local (via login:check), então o problema reaparecia sozinho.
  let existingDates = new Set();
  try {
    const rows = all('SELECT DISTINCT date FROM transactions WHERE recurring_id=?', [rec.id]);
    rows.forEach(r => existingDates.add(r.date));
  } catch(e) {}

  // Insert fresh, skipping excluded and já existentes
  const dates = generateFutureDates(rec);
  let inserted = 0;
  dates.forEach(date => {
    if (excludedDates.has(date)) return; // skip manually excluded
    if (existingDates.has(date)) return; // já existe uma transação pra essa data (ex: conferida)
    if (rec.transfer_to_account_id) {
      // Recurring transfer: create both legs with a shared transfer_id
      const maxRow = first('SELECT COALESCE(MAX(transfer_id),0) as m FROM transactions');
      const tid = (maxRow?.m || 0) + 1;
      run(`INSERT INTO transactions (account_id,date,category,memo,amount,cleared,transfer_id,recurring_id) VALUES (?,?,?,?,?,0,?,?)`,
        [rec.account_id, date, 'Transferência', rec.memo, -Math.abs(rec.amount), tid, rec.id]);
      run(`INSERT INTO transactions (account_id,date,category,memo,amount,cleared,transfer_id,recurring_id) VALUES (?,?,?,?,?,0,?,?)`,
        [rec.transfer_to_account_id, date, 'Transferência', rec.memo, Math.abs(rec.amount), tid, rec.id]);
    } else if (rec.pat_asset_id || rec.pat_debt_id) {
      // Recorrência vinculada a ativo/dívida: grava pat_installment_month para que,
      // ao conciliar (cleared 0→1), o mecanismo já existente (_onInstallmentTxCleared)
      // marque automaticamente a parcela correspondente como paga.
      const month = date.slice(0, 7);
      run(`INSERT INTO transactions (account_id,date,category,memo,amount,cleared,recurring_id,pat_asset_id,pat_debt_id,pat_installment_month) VALUES (?,?,?,?,?,0,?,?,?,?)`,
        [rec.account_id, date, rec.category, rec.memo, rec.amount, rec.id, rec.pat_asset_id||null, rec.pat_debt_id||null, month]);
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
  const id = run('INSERT INTO recurring (account_id,category,memo,amount,frequency,next_date,end_date,transfer_to_account_id,pat_asset_id,pat_debt_id) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [r.account_id, r.category||'', r.memo||'', r.amount, r.frequency, r.next_date, r.end_date||null, r.transfer_to_account_id||null, r.pat_asset_id||null, r.pat_debt_id||null]);
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

  run('UPDATE recurring SET account_id=?,category=?,memo=?,amount=?,frequency=?,next_date=?,end_date=?,transfer_to_account_id=?,pat_asset_id=?,pat_debt_id=? WHERE id=?',
    [r.account_id, r.category||'', r.memo||'', r.amount, r.frequency, r.next_date, r.end_date||null, r.transfer_to_account_id||null, r.pat_asset_id||null, r.pat_debt_id||null, r.id]);

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
          transferAccount: cur.transferAccount || null,
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
    else if (tag === 'L') {
      // Convenção QIF: "L[Nome da Conta]" (com colchetes) marca o lançamento
      // como TRANSFERÊNCIA para/de outra conta — não é uma categoria de
      // verdade. Um arquivo com múltiplas contas grava a mesma transferência
      // duas vezes (uma em cada conta), cada perna com o nome da conta
      // CONTRAPARTE entre colchetes. Sem essa distinção, o nome da conta
      // contraparte acabava virando "categoria" (ex: "Itaú", "Cartão BTG"
      // aparecendo na aba Categorias como se fossem gastos de verdade).
      const bracketed = val.match(/^\[(.*)\]$/);
      if (bracketed) { cur.transferAccount = bracketed[1].trim(); cur.category = ''; }
      else { cur.category = val; }
    }
    else if (tag === 'C') cur.cleared  = val === 'X' || val === '*';
    // P (payee) and N (check num) ignored
  }
  // Last pending transaction
  if (cur.date) {
    if (!byAccount[currentAccount]) byAccount[currentAccount] = [];
    byAccount[currentAccount].push({ date:cur.date||'', category:cur.category||'', transferAccount:cur.transferAccount||null, memo:cur.memo||'', amount:cur.amount||0, cleared:cur.cleared||false });
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
function isTransferCat(cat) { return normKey(cat).includes('transfer'); }

// ── WINDOW ──
// ── BACKUP ──
function getBackupDir() {
  const settings = loadSettings();
  // backupDir é opcional e independente de dataDir — permite manter backup
  // em local FISICAMENTE diferente dos dados (ex: dados numa pasta local,
  // backup numa pasta de nuvem, ou vice-versa), pra não ter dados e backup
  // sujeitos ao mesmo risco de perda (mesmo disco/pasta).
  if (settings.backupDir) return settings.backupDir;
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
    // Inclui o id do usuário atual no nome — sem isso, backups de usuários
    // diferentes caem na mesma pasta com o mesmo padrão de nome, e a
    // limpeza de "manter só os últimos 30" trataria todos como um único
    // pool, podendo apagar backups de um usuário pra abrir espaço pro outro.
    const prefix = _currentUserId ? `cruzeiro_data_${_currentUserId}_` : 'cruzeiro_data_';
    const dest = path.join(bdir, `${prefix}${ts}.db`);
    fs.copyFileSync(getDbPath(), dest);
    // Keep only last 30 backups DESTE usuário (não mexe nos de outros)
    const files = fs.readdirSync(bdir)
      .filter(f => {
        if (!f.startsWith(prefix) || !f.endsWith('.db')) return false;
        if (_currentUserId) return true; // prefixo já inclui o id, é específico o bastante
        // Usuário padrão: "cruzeiro_data_" é prefixo de QUALQUER usuário
        // nomeado também ("cruzeiro_data_usr_123_...") — sem esta checagem
        // extra, a limpeza do padrão contaria/apagaria backups de outros.
        return !/^usr_/.test(f.slice(prefix.length));
      })
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

  // Esta perna pertencia a uma transferência real e a categoria deixou de ser
  // de transferência: desfaz as DUAS pernas e recria como lançamento comum
  // (mesma lógica de tx:update — evita perna órfã/inconsistente).
  if (field === 'category' && old.transfer_id && !isTransferCat(value)) {
    const paired = first('SELECT * FROM transactions WHERE transfer_id=? AND id!=?', [old.transfer_id, id]);
    run('DELETE FROM transactions WHERE transfer_id=?', [old.transfer_id]);
    const newId = run('INSERT INTO transactions (account_id,date,category,memo,amount,cleared,pat_asset_id,pat_tx_id,pat_debt_id) VALUES (?,?,?,?,?,?,?,?,?)',
      [old.account_id, old.date, value, old.memo, old.amount, old.cleared, old.pat_asset_id||null, old.pat_tx_id||null, old.pat_debt_id||null]);
    pushUndo(`Editar category de "${old.memo||old.category}"`, [
      { sql: 'DELETE FROM transactions WHERE id=?', params: [newId] },
      { sql: 'INSERT INTO transactions (id,account_id,date,category,memo,amount,cleared,transfer_id) VALUES (?,?,?,?,?,?,?,?)',
        params: [old.id, old.account_id, old.date, old.category, old.memo, old.amount, old.cleared, old.transfer_id] },
      ...(paired ? [{ sql: 'INSERT INTO transactions (id,account_id,date,category,memo,amount,cleared,transfer_id) VALUES (?,?,?,?,?,?,?,?)',
        params: [paired.id, paired.account_id, paired.date, paired.category, paired.memo, paired.amount, paired.cleared, paired.transfer_id] }] : [])
    ]);
    save();
    return { ok: true, id: newId };
  }

  db.run(`UPDATE transactions SET ${field}=? WHERE id=?`, [value, id]);

  // Sync transfer pair for date, memo, and amount changes.
  // pairedUndo guarda a operação que restaura a OUTRA perna. Sem ela, o undo
  // revertia só a perna editada e deixava a transferência dessincronizada
  // (ex: -100 de um lado e +150 do outro), corrompendo o saldo das duas contas
  // em silêncio. `field` já passou pela whitelist `allowed` no topo do handler,
  // então interpolá-lo no SELECT é seguro.
  let pairedUndo = null;
  if (old.transfer_id && ['date','memo','amount'].includes(field)) {
    const paired = first(`SELECT id, ${field} as oldValue FROM transactions WHERE transfer_id=? AND id!=?`, [old.transfer_id, id]);
    if (paired) {
      const syncValue = field === 'amount' ? -value : value;
      db.run(`UPDATE transactions SET ${field}=? WHERE id=?`, [syncValue, paired.id]);
      pairedUndo = { sql: `UPDATE transactions SET ${field}=? WHERE id=?`, params: [paired.oldValue, paired.id] };
    }
  }

  // If this toggled "cleared" on a transaction linked to a financing/debt
  // installment (auto-synced from Patrimônio), reflect the paid status there too.
  if (field === 'cleared' && old.pat_installment_month) {
    const updated = first('SELECT * FROM transactions WHERE id=?', [id]);
    if (value === 1 || value === true) _onInstallmentTxCleared(updated);
    else _onInstallmentTxUncleared(updated);
  }

  save();
  pushUndo(`Editar ${field} de "${old.memo||old.category}"`, [
    { sql: `UPDATE transactions SET ${field}=? WHERE id=?`, params: [old[field], id] },
    ...(pairedUndo ? [pairedUndo] : [])
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

let selectUserWin = null;
function createUserSelectWindow(users) {
  selectUserWin = new BrowserWindow({
    width: 420, height: 420, resizable: false, center: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    title: 'Cruzeiro — Selecionar usuário',
    webPreferences: { preload: path.join(__dirname,'preload.js'), contextIsolation:true, nodeIntegration:false },
    frame: true, show: false,
  });
  const optionsHtml = users.map(u => `<option value="${u.id ?? ''}">${u.name.replace(/[<>&"]/g,'')}</option>`).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#1a1f2e;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;padding:32px}
    .card{background:#0f172a;border:1px solid #1e293b;border-radius:14px;padding:32px;width:320px}
    .logo{font-size:32px;font-weight:900;color:#f9a825;text-align:center;margin-bottom:4px}
    .appname{font-size:16px;font-weight:700;color:#60a5fa;text-align:center;margin-bottom:4px}
    .tagline{font-size:11px;color:#64748b;text-align:center;margin-bottom:24px}
    label{font-size:12px;color:#94a3b8;display:block;margin-bottom:4px}
    select{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font-size:14px;outline:none;margin-bottom:16px}
    select:focus{border-color:#3b82f6}
    .btn{width:100%;padding:10px;border-radius:8px;border:none;background:#004d40;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
    .btn:hover{background:#00695c}
  </style></head><body>
  <div class="card">
    <div class="logo">C$</div>
    <div class="appname">Cruzeiro</div>
    <div class="tagline">Quem está usando o app agora?</div>
    <label>Usuário</label>
    <select id="user-sel">${optionsHtml}</select>
    <button class="btn" onclick="continuar()">Continuar</button>
  </div>
  <script>
    async function continuar() {
      const id = document.getElementById('user-sel').value || null;
      await window.ff?.usersSelect({ id });
    }
  </script></body></html>`;
  const tmpPath = path.join(app.getPath('temp'), 'ff_select_user.html');
  fs.writeFileSync(tmpPath, html);
  selectUserWin.loadFile(tmpPath);
  selectUserWin.once('ready-to-show', () => selectUserWin.show());
  selectUserWin.on('closed', () => { if (!win && !loginWin && !_loggingIn) app.quit(); });
}

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
  </style></head><body>
  <div class="card">
    <div class="logo">C$</div>
    <div class="appname">Cruzeiro</div>
    <div class="tagline" id="tagline">Gestao financeira pessoal</div>

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
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
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
  win.on('closed', () => { win = null; if (loginWin) loginWin.close(); });
}

async function mainStartupFlow() {
  try { await initDB(); } catch(e) { dialog.showErrorBox('Erro ao iniciar banco de dados', e.message); app.quit(); return; }
  if (!_dbPendingDecrypt) doBackup();
  // Only run these if DB is fully loaded (not pending decryption)
  if (!_dbPendingDecrypt) {
    try { migrateRecurring(); } catch(e) {}
    // IMPORTANTE: aguarda (não usa setImmediate solto) para garantir que
    // termina ANTES do bloco de sync mobile mais abaixo. Antes, os dois
    // rodavam em paralelo sem ordem garantida: se a reconciliação do
    // mobile chegasse primeiro, ela marcava como conferida uma transação
    // que este passo iria apagar e recriar com outro ID — gerando
    // duplicatas (uma órfã conferida + uma nova não conferida).
    await new Promise(resolve => {
      setImmediate(() => {
        try { const recs = all('SELECT * FROM recurring WHERE active=1'); recs.forEach(rec => syncRecurringTxns(rec)); save(); } catch(e) { console.error('syncRecurring startup:', e); }
        resolve();
      });
    });
    // Carrega índices de financiamento já salvos localmente (cache offline)
    // e dispara atualização em background — igual ao padrão usado para o IPCA.
    setImmediate(async () => {
      try {
        const idxPath = getDbPath().replace('.db', '_financing_indexes.json');
        if (fs.existsSync(idxPath)) {
          global._financingIndexes = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
        }
      } catch(e) { console.warn('[financing indexes] cache load failed:', e.message); }

      try {
        const result = await _fetchFinancingIndexesInternal();
        console.log('[financing indexes] atualizados:', result.updated.join(', ') || 'nenhum',
          result.errors.length ? ' | erros: ' + result.errors.join(', ') : '');
        // Recalcula os cronogramas de todos os contratos ativos (ativo + dívida
        // pessoal) para refletir a correção monetária com os índices atualizados.
        const activeAssetContracts = all("SELECT id, asset_id FROM pat_financing_contracts WHERE status='active'");
        activeAssetContracts.forEach(c => { try { _regenerateProjectedSchedule(c.asset_id, c.id); } catch(e) {} });
        const activeDebts = all("SELECT DISTINCT debt_id FROM personal_debt_contracts WHERE status='active'");
        activeDebts.forEach(r => { try { _regenerateProjectedDebtSchedule(r.debt_id); } catch(e) {} });
        if (activeAssetContracts.length || activeDebts.length) save();
      } catch(e) { console.warn('[financing indexes] fetch failed:', e.message); }
    });
  }

  // ── Tenta restaurar sessão Supabase ANTES de decidir se exibe login ──
  const settings = loadSettings();
  let sessionRestored = false;
  if (!_dbPendingDecrypt && settings.supabaseRefreshToken) {
    // Retry com backoff pra erro TRANSITÓRIO (rede/timeout/servidor fora
    // do ar no exato instante do boot — ex: laptop acordando do sleep
    // antes do Wi-Fi reconectar, VPN corporativa demorando a subir). Sem
    // isso, um único hiccup de rede nesse momento marcava a sessão como
    // "Desconectada" pelo resto da execução do app — mesmo com o token
    // salvo em disco continuando 100% válido — e a única saída visível
    // pro usuário era digitar a senha de novo, mesmo sem necessidade
    // nenhuma. Token realmente inválido (rejeitado pelo Supabase) continua
    // falhando rápido, sem retry — não adianta insistir num token morto.
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const refreshed = await sb.refreshSession(settings.supabaseRefreshToken);
        console.log(`[sync] sessão restaurada para ${settings.supabaseEmail} (tentativa ${attempt}/${MAX_ATTEMPTS})`);
        logAuth(`OK sessão restaurada para ${settings.supabaseEmail} (tentativa ${attempt}/${MAX_ATTEMPTS})`);
        sessionRestored = true;

        // Persiste o NOVO refresh token — o Supabase usa tokens rotativos:
        // cada uso invalida o anterior e gera um novo. Sem persistir aqui,
        // a próxima abertura do app tentaria usar um token já expirado.
        if (refreshed?.refresh_token) {
          const s2 = loadSettings();
          s2.supabaseRefreshToken = refreshed.refresh_token;
          saveSettings(s2);
        } else {
          console.warn('[sync] refreshSession não retornou refresh_token novo — token salvo pode ficar desatualizado até a próxima renovação');
        }

        if (sb.getUserId()) await _ensureFirstRun(sb.getUserId()).catch(() => {});

        // Restaura chave de criptografia usando senha guardada pelo safeStorage
        if (safeStorage.isEncryptionAvailable() && settings.supabaseEncryptedPassword) {
          try {
            const password = safeStorage.decryptString(
              Buffer.from(settings.supabaseEncryptedPassword, 'base64')
            );
            await initEncryptionKey(sb.getUserId(), password);
          } catch (e) {
            console.warn('[crypto] não foi possível restaurar chave de dados:', e.message);
          }
        }

        runMobileSync('startup').catch(() => {});
        break; // sucesso — não tenta de novo
      } catch(e) {
        const errMsg = e.message || '';
        const isTokenInvalid = errMsg.includes('invalid') || errMsg.includes('expired')
          || errMsg.includes('401') || errMsg.includes('not found');

        if (isTokenInvalid) {
          // Token realmente inválido ou expirado — precisa re-login, sem retry
          console.log('[sync] token inválido, re-login necessário:', errMsg);
          logAuth(`TOKEN_INVALIDO re-login necessário: ${errMsg}`);
          const s2 = loadSettings();
          delete s2.supabaseRefreshToken;
          delete s2.supabaseEmail;
          saveSettings(s2);
          sessionRestored = false;
          break;
        } else if (attempt < MAX_ATTEMPTS) {
          console.warn(`[sync] falha transitória ao restaurar sessão (tentativa ${attempt}/${MAX_ATTEMPTS}), tentando de novo:`, errMsg);
          logAuth(`TRANSITORIO tentativa ${attempt}/${MAX_ATTEMPTS} falhou, retry: ${errMsg}`);
          await new Promise(r => setTimeout(r, 1500 * attempt));
        } else {
          // Erro transitório mesmo após todas as tentativas — mantém o
          // token salvo pra tentar de novo na próxima abertura do app.
          console.warn('[sync] falha transitória ao restaurar sessão após todas as tentativas (token preservado):', errMsg);
          logAuth(`TRANSITORIO todas as ${MAX_ATTEMPTS} tentativas falharam, token preservado: ${errMsg}`);
          sessionRestored = false;
        }
      }
    }
  }

  // Mostra a tela de login (senha) SÓ quando o arquivo estiver de fato
  // protegido por senha — DB criptografado (precisa decriptar) ou senha
  // local configurada (modo legado). A ausência de sessão Supabase válida
  // NÃO deve, por si só, forçar essa tela: essa tela só tem campo de senha
  // local, não tem como o usuário "resolver" a falta de sessão de sync por
  // ali — o app entra direto e a sincronização é tratada normalmente nas
  // telas de Configurações.
  const isPasswordProtected = !!(settings.hasEncryptedDB || _dbPendingDecrypt || settings.passwordHash);
  if (isPasswordProtected) {
    createLoginWindow();
    // Don't pre-create main window — create it AFTER login so it loads with real DB
  } else {
    createWindow();
    setupAutoUpdater();
  }
}

app.whenReady().then(async () => {
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length===0) createWindow(); });
  // Só mostra a tela de seleção de usuário se houver MAIS de um cadastrado —
  // com 0 ou 1, segue exatamente como sempre funcionou, sem tela extra.
  const registry = loadUserRegistry();
  if (registry.users.length <= 1) {
    _currentUserId = registry.users[0]?.id ?? null;
    await mainStartupFlow();
  } else {
    createUserSelectWindow(registry.users);
  }
});

// Sync final ao fechar o app (garante que últimas alterações cheguem ao mobile)
//
// _quitFinalizing evita um loop infinito: app.quit() dispara 'before-quit';
// se ainda logado, cancelávamos o quit (preventDefault), rodávamos o sync
// final e chamávamos app.quit() de novo — mas esse segundo app.quit()
// disparava 'before-quit' MAIS UMA VEZ, e como _syncRunning já tinha
// voltado a false (resetado dentro do próprio runMobileSync antes deste
// handler terminar), a condição de guarda nunca barrava a recursão: o app
// ficava rodando sync completo sem parar, pra sempre, sem nenhuma janela
// visível, só terminando se o processo fosse morto manualmente. Com a
// flag, a segunda (e demais) chamada de 'before-quit' cai direto no early
// return e deixa o quit seguir de verdade.
//
// Antes, se já houvesse um sync em andamento no momento do fechamento (ex:
// o de 'startup', que roda toda vez que o app abre), este handler apenas
// desistia (`_syncRunning` true → early return, sem preventDefault) e o
// processo terminava imediatamente — matando a requisição em andamento no
// meio E sem rodar nenhum sync próprio depois. Resultado real reportado:
// abrir o app, editar algo rapidamente e fechar em seguida (antes do sync
// de abertura terminar) fazia a edição nunca chegar ao Supabase — só
// aparecia no mobile depois de reabrir o Desktop. Agora, em vez de
// desistir, esperamos o sync já em andamento terminar e SÓ ENTÃO rodamos
// o sync final de 'quit' (que revalida os hashes e reenvia qualquer coisa
// editada durante ou depois daquele sync em andamento).
let _quitFinalizing = false;
app.on('before-quit', async (e) => {
  if (_quitFinalizing) return;
  if (!sb.isLoggedIn()) return;
  _quitFinalizing = true;
  e.preventDefault();
  try {
    if (_syncRunning && _syncPromise) await _syncPromise.catch(() => {});
    await runMobileSync('quit');
  } catch (err) { console.error('[sync] before-quit:', err); }
  app.quit();
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

ipcMain.handle('app:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

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

// ── Password-protected Office file support (e.g. BTG fatura XLSX) ──
// Decryption needs Node's `crypto` + file-format parsing (cfb/xml2js), which
// aren't available in the sandboxed renderer (contextIsolation/nodeIntegration
// off), so it's done here in the main process via officecrypto-tool.
ipcMain.handle('office:is-encrypted', (_, arrayBuffer) => {
  try {
    const officeCrypto = require('officecrypto-tool');
    return officeCrypto.isEncrypted(Buffer.from(arrayBuffer));
  } catch (e) {
    return false; // if the check itself fails, treat as not encrypted (fall through to normal parsing)
  }
});

ipcMain.handle('office:decrypt', async (_, { buffer: arrayBuffer, password }) => {
  try {
    const officeCrypto = require('officecrypto-tool');
    const decrypted = await officeCrypto.decrypt(Buffer.from(arrayBuffer), { password });
    // Return as a plain array so it survives IPC structured-clone as an ArrayBuffer on the renderer side
    return { ok: true, buffer: decrypted.buffer.slice(decrypted.byteOffset, decrypted.byteOffset + decrypted.byteLength) };
  } catch (e) {
    return { ok: false, error: e.message || 'Senha incorreta ou arquivo corrompido.' };
  }
});

// The renderer reads the file using FileReader + XLSX (already in index.html via CDN)
// and sends parsed rows here for DB insertion with duplicate detection.
// ── Round-2 duplicate check: same memo + category, ±7 days, any amount ──
// Targets recurring placeholders (uncleared future txns) whose amount varies
// month to month (condomínio, contas de consumo, etc).
// Também serve de segunda camada de segurança contra duplicatas comuns
// (mesmo memo+categoria, data próxima) que o detector principal não pegou
// — por isso NÃO se limita a lançamentos não conferidos: um lançamento já
// conferido com o mesmo memo/categoria/data é o sinal mais forte possível
// de que é a mesma transação sendo reimportada.
ipcMain.handle('bank:check-memo-dups', (_, { accountId, rows }) => {
  const matches = [];
  for (let i = 0; i < (rows || []).length; i++) {
    const r = rows[i];
    if (!r || !r.memo || !r.dateISO) continue;
    try {
      const existing = all(
        `SELECT id, date, amount, memo, category, cleared, recurring_id FROM transactions
         WHERE account_id=?
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

// ── Movimentações de corretora não atribuídas a nenhum ativo: checa se já
// não estão registradas na conta de investimentos (mesmo espírito do
// check acima, só que mais simples — sem categoria/ML, já que essas
// movimentações não têm categoria própria ainda). Datas podem chegar como
// YYYY-MM-DD (quando o extrato tem a data exata) ou só YYYY-MM (quando o
// parser só sabe o mês) — nesse caso, casa por mês em vez de janela de
// dias. Só SURFACE os candidatos pro usuário decidir — nunca pula sozinho.
ipcMain.handle('broker:check-unresolved-dups', (_, { accountId, rows }) => {
  const matches = [];
  for (let i = 0; i < (rows || []).length; i++) {
    const r = rows[i];
    if (!r || r.amount == null || !r.date) continue;
    try {
      const isFullDate = /^\d{4}-\d{2}-\d{2}$/.test(r.date);
      const existing = isFullDate
        ? all(
            `SELECT id, date, amount, memo FROM transactions
             WHERE account_id=? AND ABS(julianday(date) - julianday(?)) <= 5 AND ABS(amount-?) <= 0.02
             LIMIT 3`,
            [accountId, r.date, r.amount])
        : all(
            `SELECT id, date, amount, memo FROM transactions
             WHERE account_id=? AND substr(date,1,7)=? AND ABS(amount-?) <= 0.02
             LIMIT 3`,
            [accountId, r.date.slice(0,7), r.amount]);
      if (existing.length) matches.push({ rowIndex: i, existing });
    } catch(e) { /* skip row on error */ }
  }
  return { matches };
});

ipcMain.handle('bank:import', (_, { accountId, rows, checkDailySaldo, skipIds, dryRun, replaceIds }) => {
  // dryRun: only check for dups, don't insert anything
  // skipIds = array of row indices the user chose to skip (confirmed duplicates)
  const skipSet = new Set(skipIds || []);

  // Find potential duplicates against DB (same account, date, amount)
  // We do NOT auto-skip — we report them so the user can decide
  const potentialDups = [];
  const toInsert = [];

  // Regras de ML carregadas uma vez: usadas para traduzir o texto bruto do
  // extrato para o APELIDO que o usuário dá (ex.: "UBER *TRIP 8K3J2" → "Uber"),
  // permitindo reconhecer duplicatas mesmo quando o lançamento existente já
  // foi renomeado pelo usuário.
  const dupMlRules = dryRun ? all('SELECT * FROM ml_rules ORDER BY count DESC') : [];
  const mlNickname = (desc, amount) => {
    const key = normKey(desc);
    const tokSet = new Set(mlTokens(desc));
    let best = null, bestScore = 0;
    for (const rr of dupMlRules) {
      const s = mlScoreRule(rr, key, tokSet, amount);
      if (s > bestScore) { bestScore = s; best = rr; }
    }
    return (best && bestScore >= ML_MIN_SCORE && best.memo) ? best.memo : null;
  };

  // ── Conferência por saldo diário (bloco) ──────────────────────────────
  // Extratos que trazem o saldo do dia (ex.: Itaú) permitem uma checagem
  // muito mais confiável que comparar linha a linha: se o saldo acumulado
  // do Cruzeiro bate com o saldo informado pelo banco numa certa data,
  // TUDO até essa data já está corretamente registrado — não importa se
  // cada transação individual "parece" duplicata ou não. Isso resolve o
  // caso de reimportar um extrato antigo com muitas linhas que mudaram de
  // categoria/memo desde então (o que atrapalharia o matcher por texto).
  const SALDO_TOL = 0.05; // poucos centavos — cobre rendimento automático de c/c
  let autoSkipUntilISO = null;
  const autoSkippedLocal = [];
  if (dryRun) {
    const withSaldo = rows
      .map((r, i) => ({ i, iso: toISO(r.date), saldo: r.saldo }))
      .filter(x => x.iso && x.saldo !== undefined && x.saldo !== null)
      .sort((a, b) => a.iso.localeCompare(b.iso));
    for (const x of withSaldo) {
      const dbBal = first(
        'SELECT COALESCE(SUM(amount),0) as bal FROM transactions WHERE account_id=? AND date<=?',
        [accountId, x.iso]
      )?.bal || 0;
      if (Math.abs(dbBal - x.saldo) <= SALDO_TOL) {
        autoSkipUntilISO = x.iso; // guarda a data batida MAIS RECENTE encontrada
      }
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const date = toISO(r.date);
    if (!date) continue;

    // Dentro do período em que o saldo bateu: NÃO pula mais o processamento
    // automaticamente (fazia isso antes — excluía a linha da importação sem
    // o usuário nunca ver). Continua passando pelo matcher linha a linha
    // normal abaixo; se ele não achar nada (o cenário que a conferência por
    // saldo existe pra cobrir — ex.: memo/categoria mudou desde a 1ª
    // importação), uma recomendação "pular" é adicionada mais abaixo, com a
    // ação já pré-marcada como pular mas totalmente editável pelo usuário.
    const inSaldoSafePeriod = dryRun && autoSkipUntilISO && date <= autoSkipUntilISO;
    if (inSaldoSafePeriod) autoSkippedLocal.push(i); // só contagem informativa pro banner

    if (skipSet.has(i)) continue; // user chose to skip this one

    // A checagem de duplicata só importa na fase de DRY RUN (pré-decisão do usuário).
    // Na chamada real (dryRun=false), o usuário JÁ resolveu as duplicatas na tela
    // anterior — re-checar aqui causaria falsos positivos (ex.: uma transferência
    // recém-criada manualmente no mesmo lote) e bloquearia a importação inteira
    // sem inserir nada, mesmo após o usuário já ter confirmado.
    if (dryRun) {
      // ── Detecção de duplicatas multi-sinal ────────────────────────────
      // Candidatos: mesma conta, ±10 dias, e valor dentro de uma banda
      // generosa (±R$1 exata OU até 30% de diferença com mesmo sinal —
      // cobre recorrências lançadas com valor estimado, tipo condomínio).
      const candidates = all(
        `SELECT id, date, memo, amount, cleared, recurring_id, category FROM transactions
         WHERE account_id=?
         AND ABS(julianday(date) - julianday(?)) <= 10
         AND ( ABS(amount-?) <= 1.00
               OR (amount * ? > 0 AND ABS(amount-?) <= 0.30 * MAX(ABS(amount), ABS(?)))
               OR (recurring_id IS NOT NULL AND cleared=0 AND amount * ? > 0
                   AND ABS(amount-?) <= 0.60 * MAX(ABS(amount), ABS(?))) )
         LIMIT 12`,
        [accountId, date, r.amount, r.amount, r.amount, r.amount, r.amount, r.amount, r.amount]
      );

      let bestMatch = null, bestScore = 0, bestReason = '', bestDays = 0;
      const impTokens = mlTokens(r.memo || r.desc || '');
      const impTokSet = new Set(impTokens);
      // Apelido aprendido pelo ML para este texto de extrato (se houver)
      const impNickname = mlNickname(r.memo || r.desc || '', r.amount);
      const impNickKey  = impNickname ? normKey(impNickname) : null;
      const impNickTokSet = impNickname ? new Set(mlTokens(impNickname)) : null;

      for (const c of candidates) {
        const days = Math.abs((new Date(date) - new Date(c.date)) / 86400000);
        const diff = Math.abs(r.amount - c.amount);
        const relDiff = diff / Math.max(Math.abs(r.amount), Math.abs(c.amount), 0.01);

        // Similaridade de valor: 1.0 exato → decai com a diferença relativa
        const vs = diff <= 0.01 ? 1 : diff <= 1.00 ? 0.95 : Math.max(0, 1 - relDiff * 2.2);
        // Proximidade de data: mesmo dia = 1, decai até 0 em ~12 dias
        const ds = Math.max(0, 1 - days / 12);
        // Similaridade de texto: sobreposição de tokens ponderada (Dice)
        const cTokens = mlTokens(c.memo || '');
        const cKey = normKey(c.memo || '');
        const diceSim = (aTokens, aSet, bTokens) => {
          if (!aTokens.length || !bTokens.length) return null;
          let hitW = 0;
          const wSum = arr => arr.reduce((s, t) => s + t.length, 0);
          for (const t of bTokens) if (aSet.has(t)) hitW += t.length;
          const totW = (wSum(aTokens) + wSum(bTokens)) / 2;
          return totW > 0 ? Math.min(1, hitW / totW) : 0;
        };
        let ts = 0.5; // neutro quando um dos lados não tem descrição útil
        const tsRaw = diceSim(impTokens, impTokSet, cTokens);
        if (tsRaw !== null) ts = tsRaw;
        // Tradução via ML: se o apelido aprendido para o texto do extrato
        // bate com o memo do lançamento existente, é forte indício de que
        // é a MESMA transação (extrato bruto vs apelido do usuário).
        if (impNickKey && cKey) {
          if (impNickKey === cKey) ts = Math.max(ts, 1);
          else {
            const tsNick = diceSim(mlTokens(impNickname), impNickTokSet, cTokens);
            if (tsNick !== null) ts = Math.max(ts, tsNick);
          }
        }

        // Provisão de recorrência: transação gerada pelo motor de
        // recorrências (recurring_id) ainda não conciliada = valor/data
        // ESTIMADOS. É o candidato mais forte a "mesma transação".
        const isProvision = c.recurring_id && !c.cleared;

        let score = 0.45 * vs + 0.30 * ts + 0.25 * ds + (isProvision ? 0.15 : 0);
        let reason = '';
        let isDup = false;

        if (isProvision && ts >= 0.30 && vs >= 0.35 && days <= 10) {
          // Recorrência provisionada: texto parecido basta, mesmo com
          // valor/data estimados diferentes do real
          isDup = true;
          reason = 'recorrencia';
        } else if (vs >= 0.95 && days <= 3) {
          // Valor (quase) exato em data próxima — duplicata clássica.
          // Guarda anti-falso-positivo: se as duas descrições têm tokens
          // significativos e NENHUM em comum (estabelecimentos claramente
          // diferentes), só marca se for valor idêntico NO MESMO dia.
          const bothMeaningful = impTokens.length >= 1 && cTokens.length >= 1;
          if (bothMeaningful && ts === 0) {
            if (diff <= 0.01 && days === 0) { isDup = true; reason = 'mesmo-dia-valor'; }
          } else {
            isDup = true;
            reason = days === 0 ? 'exata' : 'valor-igual-data-proxima';
          }
        } else if (score >= 0.80) {
          isDup = true;
          reason = 'similaridade-alta';
        }

        if (isDup && score > bestScore) {
          bestScore = score;
          bestMatch = c;
          bestReason = reason;
          bestDays = Math.round(days);
        }
      }

      if (bestMatch) {
        potentialDups.push({
          rowIndex: i,
          date: r.date,
          memo: r.memo || r.desc || '',
          amount: r.amount,
          reason: bestReason,
          daysDiff: bestDays,
          nickname: impNickname || null,
          score: Math.round(bestScore * 100) / 100,
          existing: [{
            id: bestMatch.id, memo: bestMatch.memo, category: bestMatch.category || '',
            date: bestMatch.date, amount: bestMatch.amount,
            recurring: !!bestMatch.recurring_id, cleared: !!bestMatch.cleared,
          }],
        });
        continue;
      }

      // O matcher linha a linha não achou nada, mas esta linha está dentro
      // do período em que o saldo do extrato já bateu com o saldo do
      // Cruzeiro — exatamente o caso que a conferência por saldo existe pra
      // cobrir (ex.: memo/categoria mudou desde a 1ª importação, e por isso
      // o matcher por texto não reconheceu). Sinaliza como recomendação de
      // pular, mas sem um lançamento específico pareado — o usuário decide.
      if (inSaldoSafePeriod) {
        potentialDups.push({
          rowIndex: i,
          date: r.date,
          memo: r.memo || r.desc || '',
          amount: r.amount,
          reason: 'saldo-bate',
          daysDiff: 0,
          nickname: impNickname || null,
          score: 0,
          existing: [],
        });
        continue;
      }
    }
    toInsert.push({ i, date, r });
  }

  // Dry run: apenas reporta o que pareceria duplicado, sem inserir nada
  if (dryRun) {
    const autoSkippedByBalance = autoSkippedLocal.length
      ? { untilDate: autoSkipUntilISO, indices: autoSkippedLocal }
      : null;
    return (potentialDups.length > 0 || autoSkippedByBalance)
      ? { needsConfirmation: true, potentialDups, totalRows: rows.length, autoSkippedByBalance }
      : { needsConfirmation: false, potentialDups: [], totalRows: rows.length, autoSkippedByBalance: null };
  }

  // Substituição de provisões de recorrência: antes de inserir a transação
  // REAL importada, remove a provisão correspondente (que tinha valor/data
  // apenas estimados). Sem isso, ou ficaria duplicado, ou ficaria o valor errado.
  //
  // `replaceIds` e `rows` (portanto `toInsert`, que preserva o índice
  // original `i`) são arrays PARALELOS — replaceIds[k] é a provisão que a
  // linha rows[k] deveria substituir (ver applyDirectReplacements no
  // renderer, que monta os dois juntos, na mesma ordem). Isso permite
  // linkar uma falha de exclusão à linha exata que ela deveria liberar.
  let replaced = 0;
  const failedReplaceRowIdx = new Set();
  if (Array.isArray(replaceIds) && replaceIds.length) {
    for (let k = 0; k < replaceIds.length; k++) {
      const rid = replaceIds[k];
      try {
        // Guarda recurring_id+date ANTES de apagar — precisa pra gravar a
        // exclusão logo abaixo (mesmo padrão de tx:delete, main.js ~L1008).
        // Sem isso, o DELETE some com a provisão na hora, mas
        // syncRecurringTxns (que roda em todo boot/desbloqueio do app,
        // não só na importação) não tem como saber que aquela ocorrência
        // já foi atendida pela transação real importada — e recria uma
        // provisão nova (valor/data estimados) do lado da real na
        // próxima vez que o app abre, duplicando o lançamento.
        const provisionRow = first('SELECT recurring_id, date FROM transactions WHERE id=? AND recurring_id IS NOT NULL AND cleared=0', [rid]);
        db.run('DELETE FROM transactions WHERE id=? AND recurring_id IS NOT NULL AND cleared=0', [rid]);
        // getRowsModified() confirma se o DELETE realmente apagou algo —
        // sem isso, se a provisão já tivesse sido CONFERIDA (cleared=1,
        // protegida contra exclusão) ou substituída/regenerada com outro
        // id (ex: syncRecurringTxns rodou de novo entre o dry-run e a
        // confirmação), o DELETE virava um no-op silencioso (SQLite não
        // reclama de WHERE sem match) — mas a transação nova era inserida
        // do mesmo jeito, resultando na provisão antiga (agora órfã) + a
        // nova, duplicadas. Agora, quando isso acontece, a linha
        // correspondente NÃO é inserida (a provisão já conferida já
        // representa o lançamento real — inserir de novo duplicaria).
        // Captura o resultado AGORA — a próxima instrução (INSERT em
        // recurring_excludes) também roda no mesmo `db`, e getRowsModified()
        // reflete sempre só a ÚLTIMA instrução executada.
        const deleted = db.getRowsModified() > 0;
        if (deleted) {
          replaced++; save();
          if (provisionRow) {
            try {
              migrateRecurring();
              run('INSERT OR IGNORE INTO recurring_excludes (recurring_id, date) VALUES (?,?)', [provisionRow.recurring_id, provisionRow.date]);
            } catch(e) {}
          }
        } else {
          console.warn(`[bank:import] "substituir" não encontrou a provisão id=${rid} (já conferida ou removida) — pulando a linha correspondente pra não duplicar`);
          failedReplaceRowIdx.add(k);
        }
      } catch(e) {}
    }
  }
  const blockedByReplace = failedReplaceRowIdx.size
    ? toInsert.filter(t => failedReplaceRowIdx.has(t.i)).map(t => ({ date: t.date, memo: t.r.memo || t.r.desc || '', amount: t.r.amount }))
    : [];
  const toInsertFiltered = failedReplaceRowIdx.size
    ? toInsert.filter(t => !failedReplaceRowIdx.has(t.i))
    : toInsert;

  // Insert all approved rows
  let inserted = 0;
  db.run('BEGIN');
  try {
    for (const { date, r } of toInsertFiltered) {
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
  return { inserted, replaced: (typeof replaced !== 'undefined' ? replaced : 0), duplicates: 0, dailyMismatches, blockedByReplace };
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
  if (excludeTransfers) { where += ` AND (t.category IS NULL OR LOWER(t.category) NOT LIKE '%transfer%') AND t.transfer_id IS NULL`; }
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
ipcMain.handle('report:category-detail', (_, { category, fromDate, toDate, accountIds }) => {
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
  if (accountIds?.length) { where += ` AND t.account_id IN (${accountIds.map(()=>'?').join(',')})`; params.push(...accountIds); }
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
  const todayBr = (() => { const d = new Date(); return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`; })();
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados?formato=json&dataInicial=01/01/2000&dataFinal=${todayBr}`;
  return new Promise((resolve) => {
    const req = https.get(url, { headers:{'User-Agent':'Cruzeiro/1.0', 'Accept':'application/json'} }, res => {
      // Follow redirect if needed
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, { headers:{'User-Agent':'Cruzeiro/1.0', 'Accept':'application/json'} }, res2 => {
          let body = '';
          res2.on('data', d => body += d);
          res2.on('end', () => processBody(body, res2.statusCode, resolve));
        }).on('error', e => resolve({ ok:false, error:e.message }));
        return;
      }
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => processBody(body, res.statusCode, resolve));
    });
    req.on('error', e => resolve({ ok:false, error:e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ ok:false, error:'timeout' }); });
  });

  function processBody(body, statusCode, resolve) {
    if (statusCode < 200 || statusCode >= 300) {
      resolve({ ok: false, error: `HTTP ${statusCode}${body ? ' — ' + body.slice(0,200) : ''}` });
      return;
    }
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
  let where = "WHERE date >= '2000-01-01' AND transfer_id IS NULL AND (category IS NOT NULL AND category != '') AND (category IS NULL OR LOWER(category) NOT LIKE '%transfer%')";
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
  let where = "WHERE date >= '2000-01-01' AND transfer_id IS NULL AND (category IS NOT NULL AND category != '') AND (category IS NULL OR LOWER(category) NOT LIKE '%transfer%')";
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

// ── Assets (Bens e Direitos) ──
ipcMain.handle('pat:assets-list', () =>
  all('SELECT * FROM pat_assets ORDER BY sort_order, id')
);

ipcMain.handle('pat:asset-save', (_, { id, name, asset_type, trend, sort_order, sold_month, sold_value, hidden, financed, financing_total, ownership_pct,
  mutuo_taxa_juros, mutuo_indexador_base, mutuo_mes_incidencia, mutuo_data_termino, mutuo_sync_account_id, mutuo_sync_category, mutuo_juros_tipo, mutuo_index_type, mutuo_dia_incidencia }) => {
  const ownPct = (asset_type === 'societario' && ownership_pct != null && ownership_pct !== '') ? parseFloat(ownership_pct) : null;
  const isMutuo = asset_type === 'mutuo';
  const mJuros   = isMutuo ? (parseFloat(mutuo_taxa_juros) || 0) : null;
  const mBase    = isMutuo ? (mutuo_indexador_base || 'mensal') : null;
  const mMes     = isMutuo && mBase === 'anual' ? (parseInt(mutuo_mes_incidencia) || null) : null;
  const mFim     = isMutuo ? (mutuo_data_termino || null) : null; // null = indefinida
  const mConta   = isMutuo ? (mutuo_sync_account_id || null) : null;
  const mCat     = isMutuo ? (mutuo_sync_category || null) : null;
  const mTipo    = isMutuo ? (mutuo_juros_tipo || 'simples') : null;
  const mIndex   = isMutuo ? (mutuo_index_type || 'none') : null;
  const mDia     = isMutuo ? (Math.min(31, Math.max(1, parseInt(mutuo_dia_incidencia) || 1))) : null;
  if (id) {
    run(`UPDATE pat_assets SET name=?,asset_type=?,trend=?,sort_order=?,sold_month=?,sold_value=?,hidden=?,financed=?,financing_total=?,ownership_pct=?,
      mutuo_taxa_juros=?,mutuo_indexador_base=?,mutuo_mes_incidencia=?,mutuo_data_termino=?,mutuo_sync_account_id=?,mutuo_sync_category=?,mutuo_juros_tipo=?,mutuo_index_type=?,mutuo_dia_incidencia=? WHERE id=?`,
      [name, asset_type, trend, sort_order ?? 0, sold_month||null, sold_value||null, hidden?1:0, financed?1:0, financing_total??null, ownPct,
       mJuros, mBase, mMes, mFim, mConta, mCat, mTipo, mIndex, mDia, id]);
    if (sold_month) {
      db.run('DELETE FROM pat_history WHERE asset_id=? AND month>? AND manual=0', [id, sold_month]);
      save();
    }
    if (isMutuo) syncMutuoToBank(id);
    return { id };
  } else {
    const newId = run(`INSERT INTO pat_assets (name,asset_type,trend,sort_order,sold_month,sold_value,hidden,financed,financing_total,ownership_pct,
      mutuo_taxa_juros,mutuo_indexador_base,mutuo_mes_incidencia,mutuo_data_termino,mutuo_sync_account_id,mutuo_sync_category,mutuo_juros_tipo,mutuo_index_type,mutuo_dia_incidencia) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [name, asset_type, trend, sort_order ?? 0, sold_month||null, sold_value||null, hidden?1:0, financed?1:0, financing_total??null, ownPct,
       mJuros, mBase, mMes, mFim, mConta, mCat, mTipo, mIndex, mDia]);
    const resolvedId = newId || first('SELECT id FROM pat_assets WHERE name=? ORDER BY id DESC LIMIT 1', [name])?.id;
    if (isMutuo && resolvedId) syncMutuoToBank(resolvedId);
    return { id: resolvedId };
  }
});

ipcMain.handle('pat:mutuo-sync', (_, { assetId }) => syncMutuoToBank(assetId));

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
  // Precisa ser o ÚLTIMO DIA DO MÊS de verdade (não um "dia 28 seguro") —
  // senão qualquer movimentação registrada entre o dia 28 e o fim do mês
  // real fica de fora da comparação de saldo, e o ajuste sai errado.
  const [adjYear, adjMonthNum] = month.split('-').map(Number);
  const lastDayOfMonth = new Date(adjYear, adjMonthNum, 0).getDate();
  const adjDate = `${month}-${String(lastDayOfMonth).padStart(2, '0')}`;
  const memo = `Ajuste de saldo — extrato ${broker} ${month}`;

  // Procura um ajuste já existente pra este mês por MEMO + PREFIXO de data
  // (não data exata) — versões anteriores deste código gravavam sempre no
  // dia 28 (bug corrigido acima); buscar por prefixo encontra esse ajuste
  // antigo também e o migra pra data certa, em vez de criar um duplicado
  // ao lado dele.
  const existing = first(
    `SELECT id FROM transactions WHERE account_id=? AND memo=? AND date LIKE ?`,
    [accountId, memo, month + '-%']
  );
  if (existing) {
    // Update it (inclui a data — migra o dia 28 antigo pro último dia real)
    run(`UPDATE transactions SET amount=?, date=? WHERE id=?`, [diff, adjDate, existing.id]);
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
  let createdAssets = 0, updatedAssets = 0, txInserted = 0, skippedDuplicates = 0;
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
      // Find or create asset by name + broker.
      // "Valores em Caixa" é especial: cada corretora tem o seu próprio
      // saldo em caixa — são baldes de dinheiro DIFERENTES, não o mesmo
      // ativo. Por isso NUNCA cai no fallback "por nome em qualquer
      // corretora" — isso é o que causava uma corretora sobrescrever o
      // saldo em caixa de outra em vez de cada uma ficar com sua própria
      // linha (que depois são somadas normalmente em qualquer totalização).
      const isCashAsset = a.category === 'valor_em_caixa' || (a.name||'').toLowerCase().trim() === 'valores em caixa';
      let existing = isCashAsset
        ? first('SELECT id FROM inv_assets WHERE lower(name)=lower(?) AND lower(COALESCE(broker,\'\'))=lower(?)', [a.name, a.broker || ''])
        : (first(
            'SELECT id FROM inv_assets WHERE lower(name)=lower(?) AND (broker IS NULL OR lower(broker)=lower(?))',
            [a.name, a.broker || '']
          ) || first('SELECT id FROM inv_assets WHERE lower(name)=lower(?)', [a.name]));

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
        if (dup) { skippedDuplicates++; continue; }
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

    // Valor em caixa — ADDITIVE dentro do MESMO mês/corretora (find or
    // create "Valores em Caixa" desta corretora especificamente — nunca cai
    // no nome de qualquer corretora, pelo mesmo motivo do loop principal:
    // cada corretora tem seu próprio saldo em caixa).
    // != null (não > 0!) — caixa zerado é um valor real do extrato (ex:
    // usuário resgatou tudo naquele mês) e precisa ser lançado como 0,
    // senão o Patrimônio simplesmente repete o valor do mês anterior por
    // não ter nenhum registro pra este mês.
    if (caixaValue != null) {
      const caixaName = 'Valores em Caixa';
      let caixaAsset = first('SELECT id FROM inv_assets WHERE name=? AND lower(COALESCE(broker,\'\'))=lower(?)', [caixaName, broker||'']);
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
        // Idempotente — sobrescreve pro valor desta importação, igual a
        // qualquer outro ativo. Cada corretora já tem sua própria linha
        // (corrigido anteriormente), então não há mais motivo pra somar ao
        // valor existente aqui: isso só causaria o caixa dobrar se a mesma
        // corretora/mês fosse reimportada — exatamente o tipo de duplicação
        // que a proteção abaixo evita pras movimentações.
        db.run(`DELETE FROM inv_transactions WHERE asset_id=? AND month=? AND tx_type='atualizacao' AND notes='__broker_import__'`,
          [caixaId, MONTH_ISO]);
        db.run(`INSERT INTO inv_transactions (asset_id,month,tx_type,total_value,notes) VALUES (?,?,?,?,?)`,
          [caixaId, MONTH_ISO, 'atualizacao', caixaValue, '__broker_import__']);
        txInserted++;
      }
    }

    db.run('COMMIT');
  } catch(e) { db.run('ROLLBACK'); throw e; }
  save();
  return { createdAssets, updatedAssets, txInserted, skippedDuplicates };
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
  // In packaged builds, "assets" is copied via extraResources to resourcesPath/assets
  // (outside app.asar — shell.openPath can't open files inside the asar archive).
  // In development, assets/ lives alongside src/ in the project root.
  const manualPath = app.isPackaged
    ? path.join(process.resourcesPath, 'assets', 'manuals', `Cruzeiro_Manual_${l}.pdf`)
    : path.join(__dirname, '..', 'assets', 'manuals', `Cruzeiro_Manual_${l}.pdf`);
  if (fs.existsSync(manualPath)) {
    require('electron').shell.openPath(manualPath);
    return { ok: true };
  }
  return { ok: false, error: 'Manual not found: ' + manualPath };
});

// ── Broker name mappings ──
function getBrokerMappingsPath() {
  // Respeita a pasta de dados customizada (ex.: Dropbox), igual ao DB e aos
  // backups — sem isso, o arquivo ficava preso na pasta local do Windows
  // (userData) e nunca era sincronizado entre computadores.
  const settings = loadSettings();
  const base = settings.dataDir
    ? settings.dataDir
    : (app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..'));
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
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
// Rótulo de "corretora" (livre, ex: "BTG 1"/"BTG 2") que o usuário quer
// atribuir aos ativos NOVOS criados a partir desta importação — guardado
// por conta de investimentos (não por corretora nativa), já que é a
// conta quem distingue duas contas diferentes na mesma corretora.
ipcMain.handle('broker:label-pref-get', (_, { accountId }) => {
  const s = loadSettings();
  return (s.brokerLabelPrefs || {})[accountId] || null;
});
ipcMain.handle('broker:label-pref-set', (_, { accountId, label }) => {
  if (!accountId) return { ok: true }; // sem conta selecionada, não há chave estável pra guardar
  const s = loadSettings();
  if (!s.brokerLabelPrefs) s.brokerLabelPrefs = {};
  s.brokerLabelPrefs[accountId] = label;
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

// ── Broker "learned items" — valores que o parser embutido não sabe
// localizar sozinho (ex: uma aba/categoria nova que a corretora passou a
// expor), ensinados pelo usuário por TEXTO-ÂNCORA (não coordenada de
// célula) — o texto é reencontrado por busca a cada importação futura,
// então sobrevive a variações de layout entre exportações do mesmo
// relatório (já vimos a BTG mudar isso mais de uma vez). Arquivo separado
// de _broker_mappings.json de propósito — formato diferente, evita
// qualquer risco de migração no arquivo já em uso.
function getBrokerLearnedItemsPath() {
  const settings = loadSettings();
  const base = settings.dataDir
    ? settings.dataDir
    : (app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..'));
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
  return path.join(base, '_broker_learned_items.json');
}
function loadBrokerLearnedItems() {
  try { return JSON.parse(fs.readFileSync(getBrokerLearnedItemsPath(), 'utf8')); } catch(e) { return {}; }
}
function saveBrokerLearnedItems(m) {
  fs.writeFileSync(getBrokerLearnedItemsPath(), JSON.stringify(m, null, 2));
}
ipcMain.handle('broker:learned-items-get', () => loadBrokerLearnedItems());
ipcMain.handle('broker:learned-item-save', (_, { broker, item }) => {
  const m = loadBrokerLearnedItems();
  if (!m[broker]) m[broker] = [];
  const idx = m[broker].findIndex(it => it.id === item.id);
  if (idx >= 0) m[broker][idx] = item; else m[broker].push(item);
  saveBrokerLearnedItems(m);
  return { ok: true };
});
ipcMain.handle('broker:learned-item-delete', (_, { broker, id }) => {
  const m = loadBrokerLearnedItems();
  if (m[broker]) m[broker] = m[broker].filter(it => it.id !== id);
  saveBrokerLearnedItems(m);
  return { ok: true };
});

// ── Custom bank parsers config ──
function getBankParsersPath() {
  const settings = loadSettings();
  const base = settings.dataDir
    ? settings.dataDir
    : (app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..'));
  if (!fs.existsSync(base)) fs.mkdirSync(base, { recursive: true });
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
  const curM = monthLocal();
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
  const curM = monthLocal();
  const rows = all('SELECT SUM(installment) as total FROM pat_financing WHERE asset_id=? AND month<=?', [assetId, curM]);
  return { total: rows[0]?.total || 0 };
});

// ── Financing contract + schedule generation ──

// SAC: equal principal, decreasing installment
// PRICE: equal installment (French method)
// SAM: average of SAC and PRICE
// Calcula o índice mensal (em fração, ex: 0.005 = 0.5%) para um mês "YYYY-MM"
// e um index_type ('INCC','TR','IGP-M','IPCA','none'). Retorna 0 se não houver
// dado disponível (evita travar o cálculo por falta de atualização do índice).
function _monthlyIndexRate(indexType, monthKey) {
  if (!indexType || indexType === 'none') return 0;
  const idx = global._financingIndexes && global._financingIndexes[indexType];
  if (!idx) return 0;
  const v = idx[monthKey];
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

// Mês de referência inicial para correção: desloca purchaseMonth pelo offset
// ('minus2' = 2 meses antes, 'minus1' = 1 mês antes, 'same' = mesmo mês).
function _correctionRefMonth(purchaseMonth, refMode) {
  if (!purchaseMonth) return purchaseMonth;
  const offset = refMode === 'minus1' ? -1 : refMode === 'same' ? 0 : -2; // default minus2
  const [y, m] = purchaseMonth.split('-').map(Number);
  const total = (y * 12 + (m - 1)) + offset;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2,'0')}`;
}

// Fator de correção acumulado entre o mês de referência e o mês alvo (ambos
// deslocados pelo mesmo offset, conforme correction_ref_month). Composição
// mensal: produto de (1 + taxa_do_mês) para cada mês no intervalo.
function _accumulatedCorrectionFactor(indexType, refMonthOffset, targetMonth) {
  if (!indexType || indexType === 'none') return 1;
  const refForTarget = _correctionRefMonth(targetMonth, refMonthOffset);
  const refForBase    = _correctionRefMonth(_correctionBaseMonth, refMonthOffset);
  if (refForTarget <= refForBase) return 1;
  let factor = 1;
  let [y, m] = refForBase.split('-').map(Number);
  let cur = `${y}-${String(m).padStart(2,'0')}`;
  while (cur < refForTarget) {
    const rate = _monthlyIndexRate(indexType, cur);
    factor *= (1 + rate);
    m++; if (m > 12) { m = 1; y++; }
    cur = `${y}-${String(m).padStart(2,'0')}`;
  }
  return factor;
}
let _correctionBaseMonth = null; // setado por generateSchedule a cada chamada

function generateSchedule({ system, annual_rate, principal, n_installments, first_month, purchase_month, balloon_at_keys, extra_annual_month, extra_annual_value, extra_annual_effect, index_type, correction_ref_month }) {
  // Mês-base para correção monetária = mês de aquisição (compra), quando informado;
  // cai para first_month (mês da 1ª parcela) se purchase_month não vier preenchido.
  _correctionBaseMonth = purchase_month || first_month;
  const _idxType = index_type || 'none';
  const _refMode = correction_ref_month || 'minus2';
  const r = annual_rate / 100 / 12; // monthly rate
  const schedule = [];
  // extra_annual_effect:
  //   'origin'  → parcela anual reduz o saldo ANTES de calcular as mensais:
  //               base_principal = principal - (n_anuais * extra_annual_value)
  //               mensais são calculadas sobre base_principal e ficam fixas.
  //   'moment'  → parcela anual reduz o saldo NO MOMENTO em que cai:
  //               mensais recalculadas a cada pagamento anual (comportamento atual).
  const effect = extra_annual_effect || 'moment';

  // Balloon at keys (upfront payment, reduces principal)
  let remainingPrincipal = principal - (balloon_at_keys || 0);
  if (remainingPrincipal < 0) remainingPrincipal = 0;

  // PLANTA: equal installments with no interest (amortization only, correction applied at payment)
  if (system === 'PLANTA') {
    // Se efeito 'origin': calcula quantas parcelas anuais caem no período e
    // subtrai do saldo base antes de dimensionar as mensais.
    let basePrincipal = remainingPrincipal;
    if (effect === 'origin' && extra_annual_month && extra_annual_value) {
      // Conta quantos meses do cronograma têm parcela anual
      let tmpCur = first_month;
      let nAnuais = 0;
      for (let i = 0; i < n_installments; i++) {
        if (parseInt(tmpCur.split('-')[1]) === extra_annual_month) nAnuais++;
        const [y2, m2] = tmpCur.split('-').map(Number);
        tmpCur = m2 === 12 ? `${y2+1}-01` : `${y2}-${String(m2+1).padStart(2,'0')}`;
      }
      basePrincipal = Math.max(0, remainingPrincipal - nAnuais * extra_annual_value);
    }

    let balance = remainingPrincipal;
    let cur = first_month;
    // Para 'origin': amort mensal fixo calculado sobre basePrincipal / n_installments
    const fixedMonthlyAmort = effect === 'origin' ? basePrincipal / n_installments : 0;
    let prevFactor = 1; // fator de correção acumulado até o mês anterior

    for (let i = 0; i < n_installments; i++) {
      const monthsRemaining = n_installments - i;

      // Correção monetária: aplica a variação do índice entre o mês anterior
      // e este mês sobre o saldo devedor, ANTES de calcular a amortização.
      const curFactor = _accumulatedCorrectionFactor(_idxType, _refMode, cur);
      const correctionAmt = balance * (curFactor / prevFactor - 1);
      balance = balance + correctionAmt;
      prevFactor = curFactor;

      let amort;
      if (effect === 'origin') {
        // 'origin': a parcela fixa também é corrigida pelo mesmo fator acumulado
        amort = fixedMonthlyAmort * curFactor;
      } else {
        // 'moment': recalculado a cada mês sobre o saldo real (já corrigido)
        amort = balance / monthsRemaining;
      }
      const isExtraMonth = (extra_annual_month && extra_annual_value && parseInt(cur.split('-')[1]) === extra_annual_month);
      const extra = isExtraMonth ? (extra_annual_value * curFactor) : 0;
      balance = Math.max(0, balance - amort - extra);
      // Linha única por mês — soma mensal + anual (quando o mês coincide com a
      // parcela anual extra). Duas linhas separadas para o mesmo mês colidem
      // com a constraint UNIQUE(contract_id, month) de pat_financing e fazem
      // uma sobrescrever a outra, perdendo dados ao persistir.
      schedule.push({
        month: cur, installment: Math.round((amort+extra)*100)/100,
        principal: Math.round((amort+extra)*100)/100, interest: 0, correction: Math.round(correctionAmt*100)/100,
        balance_end: Math.round(balance*100)/100, is_projection: 1,
        annual_component: Math.round(extra*100)/100,
      });
      const [y, m] = cur.split('-').map(Number);
      cur = m === 12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,'0')}`;
    }
    return schedule;
  }

  // Parcela PRICE recalculada a cada mês com base no saldo e meses restantes —
  // necessário para que pagamentos extras (parcela anual) acelerem a quitação
  // sem nunca encurtar o número de parcelas mensais previstas.
  function priceInstallmentFor(bal, rate, monthsLeft) {
    if (monthsLeft <= 0) return 0;
    return rate > 0
      ? bal * rate * Math.pow(1+rate, monthsLeft) / (Math.pow(1+rate, monthsLeft) - 1)
      : bal / monthsLeft;
  }

  // Para efeito 'origin' em SAC/PRICE: subtrai o total de parcelas anuais do
  // saldo base antes de dimensionar as mensais, tornando-as todas iguais.
  let baseBalance = remainingPrincipal;
  if (effect === 'origin' && extra_annual_month && extra_annual_value) {
    let tmpCur = first_month;
    let nAnuais = 0;
    for (let i = 0; i < n_installments; i++) {
      if (parseInt(tmpCur.split('-')[1]) === extra_annual_month) nAnuais++;
      const [y2, m2] = tmpCur.split('-').map(Number);
      tmpCur = m2 === 12 ? `${y2+1}-01` : `${y2}-${String(m2+1).padStart(2,'0')}`;
    }
    baseBalance = Math.max(0, remainingPrincipal - nAnuais * extra_annual_value);
  }
  let balance = remainingPrincipal; // saldo real (afetado por pagamentos anuais)
  let baseForCalc = baseBalance;    // saldo base para cálculo das mensais (fixo em 'origin')
  let cur = first_month;
  let prevFactorSac = 1; // fator de correção acumulado até o mês anterior

  for (let i = 0; i < n_installments; i++) {
    const monthsRemaining = n_installments - i;

    // Correção monetária: aplica a variação do índice entre o mês anterior e
    // este mês sobre o saldo (real e base), ANTES de calcular juros/amort.
    const curFactorSac = _accumulatedCorrectionFactor(_idxType, _refMode, cur);
    const factorStep = curFactorSac / prevFactorSac;
    const correctionAmt = balance * (factorStep - 1);
    balance = balance * factorStep;
    baseForCalc = baseForCalc * factorStep;
    prevFactorSac = curFactorSac;

    const interest = (effect === 'origin' ? baseForCalc : balance) * r;
    let amortization, installment;

    if (system === 'SAC') {
      // Recalculado a cada mês com base no saldo e nos meses restantes — garante
      // que pagamentos extras (parcela anual) NÃO encurtem o número de parcelas:
      // eles aceleram a quitação do saldo, e a amortização regular se ajusta
      // para que as N parcelas sempre fechem o saldo exatamente na última.
      amortization = (effect === 'origin' ? baseForCalc : balance) / monthsRemaining;
      installment  = amortization + interest;
    } else if (system === 'PRICE') {
      installment  = priceInstallmentFor(effect === 'origin' ? baseForCalc : balance, r, monthsRemaining);
      amortization = installment - interest;
    } else { // SAM
      const b = effect === 'origin' ? baseForCalc : balance;
      const sacAm   = b / monthsRemaining;
      const sacInst = sacAm + interest;
      const priceInst = priceInstallmentFor(b, r, monthsRemaining);
      installment   = (sacInst + priceInst) / 2;
      amortization  = installment - interest;
    }

    // Extra annual installment (balão)
    // 'origin': já descontado do saldo base — a mensal não muda quando a anual cai.
    // 'moment': desconta do saldo no momento, recalculando mensais subsequentes.
    let extra = 0;
    if (extra_annual_month && extra_annual_value) {
      const mo = parseInt(cur.split('-')[1]);
      if (mo === extra_annual_month) extra = effect === 'origin' ? 0 : (extra_annual_value * curFactorSac);
    }

    balance = Math.max(0, balance - amortization - extra);

    // Linha única por mês — soma mensal + anual extra (quando coincidem), pelo
    // mesmo motivo do branch PLANTA: linhas separadas para o mesmo mês colidem
    // com a constraint UNIQUE(contract_id, month) e perdem dados ao persistir.
    schedule.push({
      month:        cur,
      installment:  Math.round((installment + extra) * 100) / 100,
      principal:    Math.round((amortization + extra) * 100) / 100,
      interest:     Math.round(interest * 100) / 100,
      correction:   Math.round(correctionAmt * 100) / 100,
      balance_end:  Math.round(balance * 100) / 100,
      is_projection: 1,
      annual_component: Math.round(extra*100)/100,
    });

    // Advance month
    const [y, m] = cur.split('-').map(Number);
    cur = m === 12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,'0')}`;
    // Sem break antecipado: as N parcelas são sempre geradas por completo.
    // Com a amortização recalculada a cada mês (saldo/meses restantes), o
    // saldo zera exatamente na última parcela, nunca antes.
  }
  return schedule;
}

// ══ BANK SYNC: auto-create future bank transactions for financing/debt installments ══
// Given a schedule (asset financing or personal debt), a target account, and a
// fixed "day of month" for the due date, create uncleared bank transactions for
// every FUTURE (today or later) projected installment that doesn't already have
// a linked transaction. Idempotent: re-running won't create duplicates, since it
// checks `pat_installment_month` for an existing link before inserting.
// Lança a transação futura única do "saldo nas chaves" (pagamento à vista do
// restante do imóvel na entrega das chaves, comum em compras na planta) na
// conta sincronizada, na data prevista. Pagamento único — não é recorrente.
function _syncKeysBalanceToBank({ assetId, contractId, accountId, syncDay, category, keysBalance, keysBalanceMonth, memoPrefix }) {
  if (!accountId || !keysBalance || !keysBalanceMonth) return { created: 0 };
  const today = todayLocal();
  const month = keysBalanceMonth.slice(0,7);
  const [y, mo] = month.split('-').map(Number);
  const lastDay = new Date(y, mo, 0).getDate();
  const day = Math.min(syncDay || 1, lastDay);
  const dueDate = `${month}-${String(day).padStart(2,'0')}`;

  if (dueDate < today) return { created: 0 }; // não cria retroativo

  // Usa um marcador de mês exclusivo para o saldo nas chaves, distinto das
  // parcelas mensais regulares, para nunca colidir/duplicar com elas.
  const keysMarker = `keys:${month}`;
  const existing = first('SELECT id FROM transactions WHERE pat_asset_id=? AND pat_installment_month=?', [assetId, keysMarker]);
  if (existing) return { created: 0 };

  ensureCategoryExists(category || 'Financiamento');
  run(`INSERT INTO transactions (account_id,date,category,memo,amount,cleared,pat_asset_id,pat_installment_month)
       VALUES (?,?,?,?,?,0,?,?)`,
    [accountId, dueDate, category || 'Financiamento', `${memoPrefix} — Saldo nas chaves`, -Math.abs(keysBalance),
     assetId, keysMarker]);
  save();
  return { created: 1 };
}

// Mútuo — projeta a evolução futura do saldo e, se "simples", os juros
// pagos periodicamente. Modelo (igual a um contrato real "corrigido pelo
// índice X + juros de Y%"), em UM ÚNICO avanço mês a mês:
//
//   1) CORREÇÃO MONETÁRIA pelo indexador escolhido (IPCA/INCC/IGP-M/TR),
//      acumulada mês a mês e aplicada ao saldo no mês de incidência —
//      sempre acontece, independente do tipo de juros (é correção de
//      valor, não juro).
//   2) JUROS calculados sobre o saldo JÁ corrigido:
//      • SIMPLES: pagos nesse momento (lançamento na conta vinculada +
//        pat_transactions) — o saldo NÃO inclui o juro, só a correção.
//      • COMPOSTOS: incorporados ao saldo — nada é lançado agora; o valor
//        só é recebido por inteiro ao encerrar o mútuo (manualmente, igual
//        a vender/encerrar qualquer outro bem).
//
// O pat_transactions do juros simples é criado de forma PROATIVA (na hora
// em que o cronograma é gerado, não quando alguém "confirma" algo) — é isso
// que faz aparecer corretamente no fluxo de caixa nominal/real do ativo
// desde já, sem repetir o problema que tivemos com parcela de
// financiamento (que só existia quando alguém marcava "pago", e se esse
// gatilho falhasse, a parcela "desaparecia" do fluxo).
function syncMutuoToBank(assetId) {
  const asset = first('SELECT * FROM pat_assets WHERE id=?', [assetId]);
  if (!asset || asset.asset_type !== 'mutuo') return { created: 0, updated: 0 };

  // Usa o principal ORIGINAL (primeira entrada manual) como base do
  // cálculo — nunca o valor mais recente, que em sincronizações anteriores
  // já pode incluir correção/juros acumulados (senão dobraríamos o cálculo
  // a cada chamada).
  const principalRow = first('SELECT month, value FROM pat_history WHERE asset_id=? AND manual=1 ORDER BY month ASC LIMIT 1', [assetId]);
  if (!principalRow) return { created: 0, updated: 0 };

  const taxa = (asset.mutuo_taxa_juros || 0) / 100;
  const indexType = asset.mutuo_index_type || 'none';
  if (!taxa && indexType === 'none') return { created: 0, updated: 0 }; // nada pra projetar

  const base = asset.mutuo_indexador_base || 'mensal';
  const mesIncidencia = asset.mutuo_mes_incidencia;
  const dataTermino = asset.mutuo_data_termino; // 'YYYY-MM' ou null (indefinida)
  const jurosTipo = asset.mutuo_juros_tipo || 'simples';
  const diaIncidencia = asset.mutuo_dia_incidencia || 1;
  // Dia configurado, mas nunca além do último dia real do mês (ex: dia 31
  // configurado cai no dia 30 em abril, ou 28/29 em fevereiro).
  const diaDoMes = (y, mo) => Math.min(diaIncidencia, new Date(y, mo, 0).getDate());

  const now = new Date();
  const todayMonth = now.toISOString().slice(0,7);
  const HORIZON_MONTHS = 24; // teto razoável quando o mútuo é indefinido
  const startMonth = principalRow.month.slice(0,7);
  const [sy, smo] = startMonth.split('-').map(Number);

  let balance = principalRow.value;
  let pendingIndexFactor = 1; // acumula a correção mês a mês até a próxima incidência
  let created = 0, updated = 0;
  const cursor = new Date(sy, smo - 1, 1);
  const endCursor = new Date(now.getFullYear(), now.getMonth() + HORIZON_MONTHS, 1);

  while (cursor < endCursor) {
    const y = cursor.getFullYear(), mo = cursor.getMonth() + 1;
    const monthStr = `${y}-${String(mo).padStart(2,'0')}`;
    if (dataTermino && monthStr > dataTermino) break;

    if (monthStr !== startMonth) {
      // Acumula a correção TODO mês (mesmo fora do mês de incidência) —
      // necessário pra incidência anual, que precisa somar os 12 meses
      // desde a última correção, não só o mês da incidência em si.
      if (indexType !== 'none') {
        pendingIndexFactor *= (1 + _monthlyIndexRate(indexType, monthStr));
      }

      const isIncidencia = base === 'mensal' || (mesIncidencia && mo === mesIncidencia);
      if (isIncidencia) {
        if (indexType !== 'none') {
          balance = balance * pendingIndexFactor;
          pendingIndexFactor = 1;
        }
        const juros = balance * taxa;
        if (jurosTipo === 'compostos') {
          balance = balance + juros;
        } else if (juros > 0.005) {
          // SIMPLES: o juro deste período entra no fluxo nominal do ativo
          // (pat_transactions) MESMO SE FOR PASSADO — um mútuo antigo
          // precisa contar os juros pretéritos pra TIR/rentabilidade saírem
          // corretas. A transação BANCÁRIA, porém, nunca é retroativa: criar
          // uma transação "do passado" fabricaria histórico real de conta
          // que nunca existiu de fato.
          // Categoria é escolhida pelo usuário no formulário do mútuo (campo
          // "Categoria dos juros recebidos") — sem ela, não sabemos como
          // classificar, então não criamos a transação bancária ainda (só
          // quando a conta E a categoria estiverem definidas). Antes, a
          // categoria vinha hardcoded como 'Juros recebidos', que nunca era
          // cadastrada de verdade na aba Categorias — por isso aparecia "do
          // nada" em telas como Evolução.
          if (asset.mutuo_sync_account_id && asset.mutuo_sync_category && monthStr >= todayMonth) {
            const dueDate = `${monthStr}-${String(diaDoMes(y, mo)).padStart(2,'0')}`;
            const existingTx = first('SELECT id, amount, cleared, date, category FROM transactions WHERE pat_asset_id=? AND pat_installment_month=?', [assetId, monthStr]);
            if (existingTx) {
              // Além de valor/data, também realinha a categoria — se o
              // usuário trocou a "Categoria dos juros recebidos" no
              // formulário do mútuo, os lançamentos futuros já criados
              // precisam refletir a nova escolha. Lançamentos já
              // conferidos (cleared=1) nunca são tocados, propositalmente.
              if (existingTx.cleared !== 1 && (Math.abs((existingTx.amount ?? 0) - juros) > 0.005
                  || existingTx.date !== dueDate || existingTx.category !== asset.mutuo_sync_category)) {
                run('UPDATE transactions SET amount=?, date=?, category=? WHERE id=?', [juros, dueDate, asset.mutuo_sync_category, existingTx.id]);
                updated++;
              }
            } else {
              run(`INSERT INTO transactions (account_id,date,category,memo,amount,cleared,pat_asset_id,pat_installment_month)
                   VALUES (?,?,?,?,?,0,?,?)`,
                [asset.mutuo_sync_account_id, dueDate, asset.mutuo_sync_category, `Juros mútuo — ${asset.name}`, juros, assetId, monthStr]);
              created++;
            }
          }
          // pat_transactions sempre recebe account_id (mesmo pra meses
          // passados, sem transação bancária real) — é o que faz a tabela
          // de movimentações do ativo mostrar a conta vinculada em vez de
          // "(sem conta)".
          const newPatMonth = `${monthStr}-${String(diaDoMes(y, mo)).padStart(2,'0')}`;
          const existingPatTx = first(
            `SELECT id, total_value, account_id, month FROM pat_transactions WHERE asset_id=? AND substr(month,1,7)=? AND tx_type='juros_mutuo'`,
            [assetId, monthStr]);
          if (existingPatTx) {
            if (Math.abs(existingPatTx.total_value - juros) > 0.005 || existingPatTx.account_id !== asset.mutuo_sync_account_id || existingPatTx.month !== newPatMonth) {
              run('UPDATE pat_transactions SET total_value=?, account_id=?, month=? WHERE id=?', [juros, asset.mutuo_sync_account_id, newPatMonth, existingPatTx.id]);
            }
          } else {
            run(`INSERT INTO pat_transactions (asset_id, month, tx_type, total_value, notes, account_id) VALUES (?,?,?,?,?,?)`,
              [assetId, newPatMonth, 'juros_mutuo', juros, 'Juros previstos (mútuo, simples)', asset.mutuo_sync_account_id]);
          }
        }
      }
    }

    // Posição (saldo) deste mês — inclui meses PASSADOS de propósito: um
    // mútuo cadastrado com início antigo precisa que o histórico inteiro
    // siga o modelo do próprio mútuo (taxa + indexador), não a tendência
    // genérica de IPCA usada pros demais bens (ver pat:auto-project, que
    // agora pula ativos do tipo mútuo de propósito). Continua nunca
    // sobrescrevendo um valor que o usuário tenha definido manualmente.
    {
      const existing = first('SELECT id, value, manual FROM pat_history WHERE asset_id=? AND month=?', [assetId, monthStr]);
      if (!existing) {
        run('INSERT INTO pat_history (asset_id, month, value, manual) VALUES (?,?,?,0)', [assetId, monthStr, balance]);
        created++;
      } else if (!existing.manual && Math.abs(existing.value - balance) > 0.005) {
        run('UPDATE pat_history SET value=? WHERE id=?', [balance, existing.id]);
        updated++;
      }
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }

  if (created || updated) save();
  return { created, updated };
}

function _syncInstallmentsToBank({ schedule, accountId, syncDay, category, assetId, contractId, debtId, memoPrefix }) {
  if (!accountId || !syncDay) return { created: 0, updated: 0 };
  const today = todayLocal();
  let created = 0;
  let updated = 0;

  schedule.forEach(row => {
    const month = row.month.slice(0,7); // "YYYY-MM"
    // Build the due date using the configured day-of-month, clamped to the
    // actual number of days in that month (e.g. day 31 in April -> 30).
    const [y, mo] = month.split('-').map(Number);
    const lastDay = new Date(y, mo, 0).getDate();
    const day = Math.min(syncDay, lastDay);
    const dueDate = `${month}-${String(day).padStart(2,'0')}`;

    if (dueDate < today) return; // never create retroactive/unconfirmed past entries

    // Skip months already marked as paid in the DB (the freshly-generated
    // `schedule` array always has is_projection=1, so we must check the DB).
    const dbRow = assetId
      ? first('SELECT paid FROM pat_financing WHERE contract_id=? AND month=?', [contractId, row.month])
      : first('SELECT paid FROM personal_debt_installments WHERE debt_id=? AND month=?', [debtId, row.month]);
    if (dbRow?.paid === 1) return;

    // Check if a linked transaction already exists for this asset/debt + month
    const whereLink = assetId
      ? 'pat_asset_id=? AND pat_installment_month=?'
      : 'pat_debt_id=? AND pat_installment_month=?';
    const existing = first(`SELECT id, amount, cleared FROM transactions WHERE ${whereLink}`, [assetId || debtId, month]);
    if (existing) {
      // Mantém o valor sincronizado com o cronograma recalculado (correção
      // monetária mensal) — só enquanto a transação ainda não foi conferida
      // pelo usuário. Uma vez confirmada como realmente paga, o valor nunca
      // é alterado retroativamente.
      const newAmount = -Math.abs(row.installment);
      if (existing.cleared !== 1 && Math.abs((existing.amount ?? 0) - newAmount) > 0.005) {
        run('UPDATE transactions SET amount=? WHERE id=?', [newAmount, existing.id]);
        updated++;
      }
      return;
    }

    ensureCategoryExists(category || 'Financiamento');
    run(`INSERT INTO transactions (account_id,date,category,memo,amount,cleared,pat_asset_id,pat_debt_id,pat_installment_month)
         VALUES (?,?,?,?,?,0,?,?,?)`,
      [accountId, dueDate, category || 'Financiamento', memoPrefix, -Math.abs(row.installment),
       assetId || null, debtId || null, month]);
    created++;
  });

  if (created || updated) save();
  return { created, updated };
}

// Garante que existe (ou não) um pat_transactions 'parcela_financiamento'
// pra esta parcela, de acordo com o status "paid" — cria/atualiza se paga,
// remove se desmarcada. Chamado em TODO write-path que altera o status de
// uma parcela de financiamento, pra nunca mais depender de um backfill
// posterior pra ela aparecer no fluxo de caixa nominal/real do ativo (foi
// exatamente a falta disso que causou parcelas pagas "desaparecendo").
function _syncFinancingInstallmentPatTx(assetId, month, paid, amount) {
  const monthStr = (month || '').slice(0,7);
  if (!assetId || !monthStr) return;
  if (paid) {
    const existing = first(
      `SELECT id, total_value FROM pat_transactions WHERE asset_id=? AND substr(month,1,7)=? AND tx_type='parcela_financiamento'`,
      [assetId, monthStr]);
    if (existing) {
      if (amount != null && Math.abs(existing.total_value - Math.abs(amount)) > 0.005) {
        run('UPDATE pat_transactions SET total_value=? WHERE id=?', [Math.abs(amount), existing.id]);
      }
    } else if (amount != null) {
      run(`INSERT INTO pat_transactions (asset_id, month, tx_type, total_value, notes) VALUES (?,?,?,?,?)`,
        [assetId, monthStr+'-01', 'parcela_financiamento', Math.abs(amount), 'Parcela paga']);
    }
  } else {
    run(`DELETE FROM pat_transactions WHERE asset_id=? AND substr(month,1,7)=? AND tx_type='parcela_financiamento'`, [assetId, monthStr]);
  }
}

// When a synced installment transaction is marked cleared (conferido), mark the
// corresponding pat_financing / personal_debt_installments row as paid.
function _onInstallmentTxCleared(tx) {
  if (!tx || tx.cleared !== 1 || !tx.pat_installment_month) return;
  const month = tx.pat_installment_month;
  if (tx.pat_asset_id) {
    const contract = _activeFinancingContract(tx.pat_asset_id);
    const row = first('SELECT * FROM pat_financing WHERE contract_id=? AND month LIKE ?', [contract?.id ?? null, month+'%']);
    if (row && row.paid !== 1) {
      run('UPDATE pat_financing SET is_projection=0, paid=1, linked_tx_id=? WHERE id=?', [tx.id, row.id]);
      _syncFinancingInstallmentPatTx(tx.pat_asset_id, month, true, row.installment);
    }
  } else if (tx.pat_debt_id) {
    const row = first('SELECT * FROM personal_debt_installments WHERE debt_id=? AND month LIKE ?', [tx.pat_debt_id, month+'%']);
    if (row && row.paid !== 1) {
      run('UPDATE personal_debt_installments SET is_projection=0, paid=1, linked_tx_id=? WHERE id=?', [tx.id, row.id]);
      _rebalanceDebtSchedule(tx.pat_debt_id);
    }
  }
}

// When a synced installment transaction is UNmarked (cleared 1->0), revert the
// corresponding installment row back to "projection" (undo the mark-as-paid).
function _onInstallmentTxUncleared(tx) {
  if (!tx || tx.cleared !== 0 || !tx.pat_installment_month) return;
  const month = tx.pat_installment_month;
  if (tx.pat_asset_id) {
    const contract = _activeFinancingContract(tx.pat_asset_id);
    const row = first('SELECT * FROM pat_financing WHERE contract_id=? AND month LIKE ?', [contract?.id ?? null, month+'%']);
    if (row && row.paid === 1) {
      run('UPDATE pat_financing SET is_projection=1, paid=0, linked_tx_id=NULL WHERE id=?', [row.id]);
      _syncFinancingInstallmentPatTx(tx.pat_asset_id, month, false, null);
      _rebalanceSchedule(tx.pat_asset_id);
    }
  } else if (tx.pat_debt_id) {
    const row = first('SELECT * FROM personal_debt_installments WHERE debt_id=? AND month LIKE ?', [tx.pat_debt_id, month+'%']);
    if (row && row.paid === 1) {
      run('UPDATE personal_debt_installments SET is_projection=1, paid=0, linked_tx_id=NULL WHERE id=?', [row.id]);
      _rebalanceDebtSchedule(tx.pat_debt_id);
    }
  }
}

// List all financing contracts for an asset (active + closed), most recent first
// Cronograma REAL persistido (com id e status "paid" verdadeiros) — diferente
// do retorno de pat:financing-contract-save, que é só o cálculo em memória.
// Usado pelo modal de visualização/edição de status do cronograma completo.
ipcMain.handle('pat:financing-schedule-real', (_, { assetId, contractId }) => {
  const cId = contractId || _activeFinancingContract(assetId)?.id || null;
  if (!cId) return [];
  return all('SELECT * FROM pat_financing WHERE contract_id=? ORDER BY month', [cId]);
});

// Alterna o status pago/pendente de uma ou mais parcelas de financiamento,
// por id — permite edição manual e seleção múltipla no modal de cronograma.
ipcMain.handle('pat:financing-toggle-paid', (_, { ids, paid }) => {
  if (!ids || !ids.length) return { ok: false };
  const affectedAssets = new Set();
  ids.forEach(id => {
    const row = first('SELECT * FROM pat_financing WHERE id=?', [id]);
    if (!row) return;
    run('UPDATE pat_financing SET paid=?, is_projection=? WHERE id=?', [paid?1:0, paid?0:1, id]);
    _syncFinancingInstallmentPatTx(row.asset_id, row.month, !!paid, row.installment);
    affectedAssets.add(row.asset_id);
  });
  affectedAssets.forEach(assetId => _rebalanceSchedule(assetId));
  save();
  return { ok: true };
});

ipcMain.handle('pat:financing-contracts-list', (_, { assetId }) =>
  all("SELECT * FROM pat_financing_contracts WHERE asset_id=? ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END, id DESC", [assetId])
);

// Get a specific contract by id, or the active one for an asset if contractId omitted
ipcMain.handle('pat:financing-contract-get', (_, { assetId, contractId }) => {
  if (contractId) return first('SELECT * FROM pat_financing_contracts WHERE id=?', [contractId]) || null;
  return first("SELECT * FROM pat_financing_contracts WHERE asset_id=? AND status='active' ORDER BY id DESC LIMIT 1", [assetId]) || null;
});

// Close a contract (e.g. financing paid off / replaced by a new one), keeping
// its history visible in the table.
ipcMain.handle('pat:financing-contract-close', (_, { contractId, closedMonth }) => {
  run("UPDATE pat_financing_contracts SET status='closed', closed_month=? WHERE id=?", [closedMonth || null, contractId]);
  save();
  return { ok: true };
});

ipcMain.handle('pat:financing-contract-save', (_, { assetId, contractId, contract }) => {
  const { label, system, index_type, annual_rate, principal, n_installments, first_month, purchase_month,
          balloon_at_keys, extra_annual_month, extra_annual_value, extra_annual_effect, correction_ref_month, notes,
          sync_account_id, sync_day, sync_category, keys_balance, keys_balance_month } = contract;

  let cId = contractId;
  if (cId) {
    // Update existing contract
    run(`UPDATE pat_financing_contracts SET
        label=COALESCE(?, label), system=?, index_type=?, annual_rate=?, principal=?, n_installments=?, first_month=?, purchase_month=?,
        balloon_at_keys=?, extra_annual_month=?, extra_annual_value=?, extra_annual_effect=?, correction_ref_month=?, notes=?,
        sync_account_id=COALESCE(?, sync_account_id), sync_day=COALESCE(?, sync_day), sync_category=COALESCE(?, sync_category),
        keys_balance=?, keys_balance_month=?
      WHERE id=?`,
      [label||null, system, index_type||'none', annual_rate, principal, n_installments, first_month, purchase_month||first_month,
       balloon_at_keys||null, extra_annual_month||null, extra_annual_value||null, extra_annual_effect||'moment', correction_ref_month||'minus2', notes||null,
       sync_account_id||null, sync_day||null, sync_category||null, keys_balance||null, keys_balance_month||null, cId]);
  } else {
    // New contract — insert as the active one
    cId = run(`INSERT INTO pat_financing_contracts
      (asset_id,label,status,system,index_type,annual_rate,principal,n_installments,first_month,purchase_month,balloon_at_keys,extra_annual_month,extra_annual_value,extra_annual_effect,correction_ref_month,notes,sync_account_id,sync_day,sync_category,keys_balance,keys_balance_month)
      VALUES (?,?,'active',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [assetId, label||null, system, index_type||'none', annual_rate, principal, n_installments, first_month, purchase_month||first_month,
       balloon_at_keys||null, extra_annual_month||null, extra_annual_value||null, extra_annual_effect||'moment', correction_ref_month||'minus2', notes||null,
       sync_account_id||null, sync_day||null, sync_category||null, keys_balance||null, keys_balance_month||null]);
  }

  // Generate and save schedule (only projected rows — don't overwrite paid rows)
  const schedule = generateSchedule(contract);

  // Keep existing paid rows, replace projected ones — scoped to this contract
  run('DELETE FROM pat_financing WHERE contract_id=? AND is_projection=1', [cId]);
  schedule.forEach(row => {
    // Don't overwrite months that have been paid
    const existing = first('SELECT id FROM pat_financing WHERE contract_id=? AND month=? AND is_projection=0', [cId, row.month]);
    if (!existing) {
      run(`INSERT OR REPLACE INTO pat_financing (asset_id,contract_id,month,installment,principal,interest,correction,balance_end,is_projection,paid)
           VALUES (?,?,?,?,?,?,?,?,1,0)`,
        [assetId, cId, row.month, row.installment, row.principal, row.interest, row.correction, row.balance_end]);
    }
  });

  // Update financing_total on asset (reflects the active contract's principal)
  run('UPDATE pat_assets SET financing_total=?, financed=1 WHERE id=?', [principal, assetId]);

  // Auto-sync future installments to the configured bank account (if set)
  const asset = first('SELECT name FROM pat_assets WHERE id=?', [assetId]);
  _syncInstallmentsToBank({
    schedule, assetId, contractId: cId,
    accountId: sync_account_id, syncDay: sync_day, category: sync_category,
    memoPrefix: `Parcela financiamento — ${label ? label+' — ' : ''}${asset?.name || 'ativo'}`,
  });

  // Auto-sync the one-time "saldo nas chaves" payment, if a date was provided
  _syncKeysBalanceToBank({
    assetId, contractId: cId,
    accountId: sync_account_id, syncDay: sync_day, category: sync_category,
    keysBalance: keys_balance, keysBalanceMonth: keys_balance_month,
    memoPrefix: `${label ? label+' — ' : ''}${asset?.name || 'ativo'}`,
  });

  save();
  return { ok: true, schedule, contractId: cId };
});

// Mark installment as paid (called when a pat_transaction of type parcela_financiamento is saved)
// Resolve the active financing contract for an asset (or null)
function _activeFinancingContract(assetId) {
  return first("SELECT * FROM pat_financing_contracts WHERE asset_id=? AND (status='active' OR status IS NULL) ORDER BY id DESC LIMIT 1", [assetId]);
}

ipcMain.handle('pat:financing-mark-paid', (_, { assetId, month, amount }) => {
  const contract = _activeFinancingContract(assetId);
  const r = contract ? (contract.annual_rate / 100 / 12) : 0;
  const cId = contract?.id ?? null;

  // Find balance BEFORE this month (balance_end of previous row, within this contract)
  const rows = all('SELECT * FROM pat_financing WHERE contract_id=? ORDER BY month', [cId]);
  const idx  = rows.findIndex(row => row.month.slice(0,7) === month);
  const prevBal = idx > 0 ? (rows[idx-1].balance_end ?? 0) : (contract?.principal ?? 0);

  // Split: interest on prev balance, principal = payment − interest
  const interest   = Math.round(prevBal * r * 100) / 100;
  const principal  = Math.max(0, Math.round((amount - interest) * 100) / 100);
  const balanceEnd = Math.max(0, Math.round((prevBal - principal) * 100) / 100);

  const existing = first('SELECT * FROM pat_financing WHERE contract_id=? AND month=?', [cId, month]);
  if (existing) {
    run('UPDATE pat_financing SET is_projection=0, paid=1, installment=?, principal=?, interest=?, balance_end=? WHERE contract_id=? AND month=?',
      [amount, principal, interest, balanceEnd, cId, month]);
  } else {
    run('INSERT INTO pat_financing (asset_id,contract_id,month,installment,principal,interest,correction,balance_end,is_projection,paid) VALUES (?,?,?,?,?,?,0,?,0,1)',
      [assetId, cId, month, amount, principal, interest, balanceEnd]);
  }
  _syncFinancingInstallmentPatTx(assetId, month, true, amount);
  _rebalanceSchedule(assetId);
  save();
  return { ok: true };
});

// Restore a paid installment back to projection (called when payment is deleted)
ipcMain.handle('pat:financing-unpay', (_, { assetId, month }) => {
  const contract = _activeFinancingContract(assetId);
  const cId = contract?.id ?? null;
  if (!contract) {
    // No active contract — just delete the row entirely
    run('DELETE FROM pat_financing WHERE asset_id=? AND month=? AND is_projection=0', [assetId, month]);
  } else {
    // Rebuild the full projected schedule and find this month's row
    const fullSchedule = generateSchedule(contract);
    const projRow = fullSchedule.find(r => r.month.slice(0,7) === month.slice(0,7));
    if (projRow) {
      run(`INSERT OR REPLACE INTO pat_financing
           (asset_id,contract_id,month,installment,principal,interest,correction,balance_end,is_projection,paid)
           VALUES (?,?,?,?,?,?,0,?,1,0)`,
        [assetId, cId, projRow.month, projRow.installment, projRow.principal, projRow.interest, projRow.balance_end]);
    } else {
      // Beyond schedule end — just delete
      run('DELETE FROM pat_financing WHERE contract_id=? AND month=?', [cId, month]);
    }
  }
  _syncFinancingInstallmentPatTx(assetId, month, false, null);
  _rebalanceSchedule(assetId);
  save();
  return { ok: true };
});

// Direct manual edit of a single installment (amount and/or paid status) —
// used by inline editing in the Patrimônio table. Unlike mark-paid/unpay,
// this doesn't recompute principal/interest split from a payment amount;
// it just sets the values directly and rebalances downstream months.
ipcMain.handle('pat:financing-installment-set', (_, { assetId, month, installment, paid }) => {
  const contract = _activeFinancingContract(assetId);
  const cId = contract?.id ?? null;
  let existing = first('SELECT * FROM pat_financing WHERE contract_id=? AND month=?', [cId, month]);
  if (!existing) {
    // Fallback: a row for this asset/month exists but wasn't backfilled with the
    // right contract_id (legacy data) — update it in place instead of inserting
    // a duplicate row for the same month.
    existing = first('SELECT * FROM pat_financing WHERE asset_id=? AND month=?', [assetId, month]);
    if (existing && cId != null) run('UPDATE pat_financing SET contract_id=? WHERE id=?', [cId, existing.id]);
  }
  if (existing) {
    run('UPDATE pat_financing SET installment=?, paid=?, is_projection=? WHERE id=?',
      [installment, paid ? 1 : 0, paid ? 0 : existing.is_projection, existing.id]);
  } else {
    run(`INSERT INTO pat_financing (asset_id,contract_id,month,installment,principal,interest,correction,balance_end,is_projection,paid)
         VALUES (?,?,?,?,0,0,0,?,?)`,
      [assetId, cId, month, installment, paid ? 0 : 1, paid ? 1 : 0]);
  }
  _syncFinancingInstallmentPatTx(assetId, month, !!paid, installment);
  _rebalanceSchedule(assetId);
  save();
  return { ok: true };
});


// ══ RELATÓRIO IRPF — BENS E DIREITOS / DÍVIDAS E ÔNUS REAIS ══════════════
// Mapeamento pro código/grupo da Receita Federal mais próximo de cada tipo
// de ativo do app (tabela vigente na declaração 2026/ano-base 2025).
// "imovel" e "societario" usam um código padrão "genérico" do grupo (99/02)
// porque o tipo do ativo no app não distingue apartamento/casa/terreno nem
// ações/quotas — por isso o relatório permite sobrescrever por ativo.
const IRPF_CODIGO_MAP = {
  imovel:     { grupo: '01', codigo: '99', label: 'Outros bens imóveis (ajuste o código se for apartamento/casa/terreno/etc)' },
  veiculo:    { grupo: '02', codigo: '01', label: 'Veículo automotor terrestre' },
  barco:      { grupo: '02', codigo: '03', label: 'Embarcação' },
  clube:      { grupo: '99', codigo: '02', label: 'Título de clube e assemelhado' },
  societario: { grupo: '03', codigo: '02', label: 'Quotas ou quinhões de capital (ajuste se for ações)' },
  mutuo:      { grupo: '05', codigo: '01', label: 'Empréstimos concedidos' },
  outro:      { grupo: '99', codigo: '99', label: 'Outros bens e direitos' },
};
// Conta bancária comum não distingue corrente/poupança no app — código
// padrão é conta-corrente (mais frequente); o usuário ajusta se for o caso.
const IRPF_ACCOUNT_CODIGO_MAP = {
  bank:       { grupo: '06', codigo: '01', label: 'Depósito em conta-corrente (ajuste pro Grupo 04/código 01 se for conta poupança)' },
  cash:       { grupo: '06', codigo: '10', label: 'Dinheiro em espécie — moeda nacional' },
  investment: { grupo: '04', codigo: '99', label: 'Outras aplicações e investimentos — especifique o tipo' },
};
// Categoria do app -> grupo/código mais provável. "renda_fixa" e "fundos"
// têm submodalidades isentas/tributadas que o app não distingue — por isso
// o rótulo já avisa qual ajuste considerar.
const IRPF_INV_CODIGO_MAP = {
  tesouro:        { grupo: '04', codigo: '02', label: 'Títulos públicos sujeitos a tributação (Tesouro Direto)' },
  renda_fixa:     { grupo: '04', codigo: '02', label: 'Títulos sujeitos a tributação (CDB/RDB) — use código 03 se for isento (LCI/LCA/CRI/CRA/debênture incentivada)' },
  fundos:         { grupo: '07', codigo: '04', label: 'Fundos de investimento — ajuste conforme o tipo (FII=03, multimercado=13, Fiagro=02, etc)' },
  renda_variavel: { grupo: '03', codigo: '01', label: 'Ações (inclusive listadas em bolsa) — use Grupo 04/código 04 se forem opções, BDR ou outro derivativo' },
  previdencia:    { grupo: '99', codigo: '06', label: 'VGBL — atenção: PGBL tem tratamento diferente da Receita, não usar este código se for PGBL' },
  private_equity: { grupo: '07', codigo: '06', label: 'FIP / Private Equity' },
  valor_em_caixa: { grupo: '06', codigo: '99', label: 'Saldo em conta de corretora' },
};
const IRPF_CREDOR_CODIGOS = {
  '11': 'Banco comercial', '12': 'Financeira/instituição não bancária',
  '13': 'Outra pessoa jurídica', '14': 'Pessoa física',
};

function _irpfValueAtYearEnd(asset, year) {
  const yearEndMonth = `${year}-12`;
  // Vendido até o fim daquele ano -> não compõe mais o patrimônio em 31/12.
  if (asset.sold_month && asset.sold_month <= yearEndMonth) return 0;

  // Bem financiado ou mútuo: o crescimento do valor é LEGÍTIMO (parcelas
  // realmente pagas, ou juros/correção de um crédito) — usa o histórico
  // como está, incluindo entradas não-manuais (manual=0) geradas por essas
  // sincronizações.
  if (asset.financed || asset.asset_type === 'mutuo') {
    const exact = first('SELECT value FROM pat_history WHERE asset_id=? AND month=?', [asset.id, yearEndMonth]);
    if (exact) return exact.value;
    const before = first('SELECT value FROM pat_history WHERE asset_id=? AND month<=? ORDER BY month DESC LIMIT 1', [asset.id, yearEndMonth]);
    return before ? before.value : 0;
  }

  // Bem comum (imóvel, veículo, societário, etc., sem financiamento): a
  // Receita exige custo histórico de aquisição, NUNCA valor de mercado —
  // por isso só considera entradas MANUAIS (manual=1). Entradas manual=0
  // pra esses tipos só existem por causa da projeção automática por
  // tendência/IPCA (pat:auto-project), que serve pra exibição/gráfico, não
  // pra declaração — usar isso aqui inflaria o valor declarado ano a ano
  // mesmo sem ter havido nenhuma melhoria real no bem.
  const exact = first('SELECT value FROM pat_history WHERE asset_id=? AND month=? AND manual=1', [asset.id, yearEndMonth]);
  if (exact) return exact.value;
  const before = first('SELECT value FROM pat_history WHERE asset_id=? AND month<=? AND manual=1 ORDER BY month DESC LIMIT 1', [asset.id, yearEndMonth]);
  return before ? before.value : 0;
}

// Texto exigido pela Receita pra "dar baixa" de um bem vendido/encerrado no
// ano: data, valor recebido e identificação do comprador — sem isso a
// Receita pode entender que o bem "desapareceu" sem explicação.
function _irpfVendaTexto(verbo, dataMes, valor) {
  const valorTxt = valor != null ? `R$ ${Number(valor).toLocaleString('pt-BR',{minimumFractionDigits:2})}` : '[informar o valor recebido]';
  return `${verbo} em ${dataMes} por ${valorTxt}, para [preencher: nome e CPF/CNPJ do comprador]. Verifique se há apuração de ganho de capital a fazer (Programa GCAP).`;
}

function _irpfSuggestDiscriminacao(asset) {
  if (asset.irpf_discriminacao) return asset.irpf_discriminacao; // usuário já refinou manualmente
  const parts = [asset.name + '.'];
  if (asset.asset_type === 'mutuo') {
    const base = asset.mutuo_indexador_base === 'anual' ? 'a.a.' : 'a.m.';
    const tipoJuros = asset.mutuo_juros_tipo === 'compostos' ? 'juros compostos' : 'juros simples';
    const indexador = asset.mutuo_index_type && asset.mutuo_index_type !== 'none' ? ` + ${asset.mutuo_index_type}` : '';
    parts.push(`Empréstimo concedido a terceiro, ${tipoJuros}, taxa de ${asset.mutuo_taxa_juros||0}% ${base}${indexador}.`);
    parts.push('[Preencher: nome completo e CPF/CNPJ do devedor]');
  } else if (asset.financed) {
    parts.push('Bem financiado — valor refere-se apenas ao montante já pago até 31/12 (a Receita orienta não incluir aqui o saldo devedor restante, que não entra em Dívidas e Ônus Reais por ter o próprio bem como garantia).');
  } else {
    parts.push('Valor pelo custo histórico de aquisição (não ajustado por valorização de mercado, conforme exigido pela Receita).');
  }
  if (asset.sold_month) {
    parts.push(_irpfVendaTexto('Vendido', asset.sold_month, asset.sold_value));
  }
  return parts.join(' ');
}

function _debtBalanceAtYearEnd(debtId, year) {
  const yearEndMonth = `${year}-12`;
  const exact = first('SELECT balance_end FROM personal_debt_installments WHERE debt_id=? AND month=?', [debtId, yearEndMonth]);
  if (exact && exact.balance_end != null) return exact.balance_end;
  const before = first('SELECT balance_end FROM personal_debt_installments WHERE debt_id=? AND month<=? ORDER BY month DESC LIMIT 1', [debtId, yearEndMonth]);
  return (before && before.balance_end != null) ? before.balance_end : 0;
}

// Saldo de conta bancária/dinheiro em 31/12 — mesma fórmula já usada em
// outros pontos do app (soma de todas as transações até a data, sem filtro
// de "conferido", já que a data é o que determina se entra na posição).
function _accountBalanceAtYearEnd(accountId, year) {
  const yearEnd = `${year}-12-31`;
  const row = first('SELECT COALESCE(SUM(amount),0) as bal FROM transactions WHERE account_id=? AND date<=?', [accountId, yearEnd]);
  return row ? row.bal : 0;
}

function _irpfSuggestAccountDiscriminacao(acc) {
  if (acc.irpf_discriminacao) return acc.irpf_discriminacao;
  if (acc.type === 'cash') return `${acc.name}. Dinheiro em espécie.`;
  return `${acc.name}. [Preencher: nome do banco/instituição financeira, agência e número da conta${acc.type==='bank' ? ' — se a conta for conjunta, nome e CPF do co-titular' : ''}]`;
}

// Custo de aquisição acumulado (compras/aportes menos vendas/resgates) — é
// isso que a Receita exige pra ações e participações, NUNCA o valor de
// mercado da posição (que é o que "atualizacao" representa).
function _invCostBasisAtYearEnd(assetId, year) {
  const yearEndMonth = `${year}-12`;
  const row = first(`
    SELECT COALESCE(SUM(
      CASE WHEN tx_type IN ('compra','aporte') THEN total_value
           WHEN tx_type IN ('venda','amortizacao') THEN -total_value
           ELSE 0 END
    ), 0) as cost
    FROM inv_transactions WHERE asset_id=? AND month<=?`, [assetId, yearEndMonth]);
  return row ? Math.max(0, row.cost) : 0;
}

// Posição de investimento em 31/12. A base de valor depende da categoria:
//  - ações/renda variável: custo de aquisição (nunca valor de mercado) —
//    a Receita é explícita sobre isso, e o "atualizacao" importado da
//    corretora normalmente É o valor de mercado da posição.
//  - renda fixa/tesouro/previdência/caixa de corretora: usa o saldo
//    informado ("atualizacao") — convenção comum pra esses produtos, que
//    não têm risco de mercado especulativo (o saldo já reflete o valor a
//    resgatar, não uma cotação flutuante).
//  - fundos/private equity: a orientação encontrada foi genuinamente
//    divergente entre fontes (algumas pedem custo, outras pedem saldo) —
//    por isso usa o saldo, mas o relatório avisa explicitamente sobre essa
//    divergência na discriminação, em vez de decidir silenciosamente.
function _invValueAtYearEnd(asset, year) {
  const yearEndMonth = `${year}-12`;
  if (asset.closed_month && asset.closed_month <= yearEndMonth) return 0;
  if (asset.category === 'renda_variavel') {
    return _invCostBasisAtYearEnd(asset.id, year);
  }
  const row = first(
    `SELECT total_value FROM inv_transactions WHERE asset_id=? AND tx_type='atualizacao' AND month<=? ORDER BY month DESC LIMIT 1`,
    [asset.id, yearEndMonth]);
  return row ? row.total_value : 0;
}

function _irpfSuggestInvDiscriminacao(asset) {
  if (asset.irpf_discriminacao) return asset.irpf_discriminacao;
  const parts = [`${asset.name}${asset.broker ? ` (${asset.broker})` : ''}.`];
  if (asset.inv_type) parts.push(`Tipo: ${asset.inv_type}.`);
  if (asset.category === 'renda_variavel') {
    parts.push('Valor pelo custo de aquisição acumulado (compras − vendas), não pelo valor de mercado, conforme exigido pela Receita para ações/participações.');
  } else if (asset.category === 'fundos' || asset.category === 'private_equity') {
    parts.push('⚠️ Atenção: para fundos, há orientações divergentes entre usar o custo de aquisição ou o saldo/cota atual — confira no seu informe de rendimentos qual o fundo/administradora recomenda antes de declarar.');
  }
  parts.push('[Preencher: CNPJ da instituição financeira/emissor, e número da conta/aplicação se houver]');
  if (asset.closed_month) {
    parts.push(_irpfVendaTexto('Resgatado/encerrado', asset.closed_month, null));
  }
  return parts.join(' ');
}

// ── Rendimentos no ano — não é uma ficha oficial em si, é um resumo das
// movimentações que o PRÓPRIO USUÁRIO já classificou no app (tipo de
// movimentação + categoria do investimento), agrupado pelo destino mais
// provável na declaração. Sempre exibido com aviso de que depende da
// classificação feita pelo usuário — o app não sabe, por exemplo, se um
// "aluguel" foi recebido de pessoa física ou jurídica, ou se um título é
// isento de fato.
const IRPF_REND_FICHA = {
  aluguel:     { ficha: 'tributavel', label: 'Tributável recebido de PF — carnê-leão mensal, se aplicável' },
  dividendo:   { ficha: 'isento',     label: 'Isento (dividendo)' },
  jcp:         { ficha: 'exclusiva',  label: 'Tributação exclusiva (JCP, 15% retido na fonte)' },
  juros_mutuo: { ficha: 'tributavel', label: 'Tributável — juros de empréstimo a pessoa física, carnê-leão mensal, se aplicável' },
};

function _irpfRendFichaInv(category, txType, irpfCodigo) {
  if (txType === 'dividendo') return { ficha: 'isento', label: 'Isento (dividendo)' };
  if (txType === 'jcp') return { ficha: 'exclusiva', label: 'Tributação exclusiva (JCP, 15% retido na fonte)' };
  if (txType === 'cupom') {
    return irpfCodigo === '03'
      ? { ficha: 'isento', label: 'Isento (cupom de título isento)' }
      : { ficha: 'exclusiva', label: 'Tributação exclusiva (cupom de título tributado)' };
  }
  if (txType === 'juros') {
    if (category === 'renda_fixa' && irpfCodigo === '03') return { ficha: 'isento', label: 'Isento (juros de título isento — LCI/LCA/etc)' };
    return { ficha: 'exclusiva', label: 'Tributação exclusiva (rendimento de aplicação financeira, IR retido na fonte)' };
  }
  return { ficha: 'outro', label: 'Verificar classificação — tipo não mapeado' };
}

ipcMain.handle('irpf:report', (_, { year }) => {
  const y = parseInt(year);
  const bens = [];

  // 1) Ativos do Patrimônio (imóvel, veículo, mútuo, societário, etc.)
  const assets = all('SELECT * FROM pat_assets ORDER BY sort_order, id'); // inclui ocultados — bem ocultado pode ser exatamente o que precisa de baixa na declaração
  for (const asset of assets) {
    const valorAnoAnterior = _irpfValueAtYearEnd(asset, y - 1);
    const valorAnoAtual = _irpfValueAtYearEnd(asset, y);
    if (valorAnoAnterior <= 0 && valorAnoAtual <= 0) continue; // sem posição relevante no período
    const map = IRPF_CODIGO_MAP[asset.asset_type] || IRPF_CODIGO_MAP.outro;
    bens.push({
      source: 'pat', id: asset.id, name: asset.name, assetType: asset.asset_type,
      grupoSugerido: map.grupo, codigoSugerido: asset.irpf_codigo || map.codigo, codigoLabel: map.label,
      discriminacao: _irpfSuggestDiscriminacao(asset),
      valorAnoAnterior, valorAnoAtual,
      financed: !!asset.financed, encerrado: asset.sold_month || null,
    });
  }

  // 2) Contas bancárias e dinheiro em espécie — cartão de crédito não entra
  // aqui (não é bem/direito).
  const accounts = all("SELECT * FROM accounts WHERE type IN ('bank','cash','investment') ORDER BY sort_order, id"); // inclui ocultadas
  for (const acc of accounts) {
    const valorAnoAnterior = _accountBalanceAtYearEnd(acc.id, y - 1);
    const valorAnoAtual = _accountBalanceAtYearEnd(acc.id, y);
    if (valorAnoAnterior <= 0 && valorAnoAtual <= 0) continue;
    const map = IRPF_ACCOUNT_CODIGO_MAP[acc.type] || IRPF_ACCOUNT_CODIGO_MAP.bank;
    bens.push({
      source: 'account', id: acc.id, name: acc.name, assetType: 'conta',
      grupoSugerido: map.grupo, codigoSugerido: acc.irpf_codigo || map.codigo, codigoLabel: map.label,
      discriminacao: _irpfSuggestAccountDiscriminacao(acc),
      valorAnoAnterior, valorAnoAtual,
      financed: false, encerrado: null,
    });
  }

  // 3) Investimentos financeiros (posições de corretora importadas/lançadas)
  const invAssets = all('SELECT * FROM inv_assets ORDER BY sort_order, id'); // inclui ocultados
  for (const inv of invAssets) {
    const valorAnoAnterior = _invValueAtYearEnd(inv, y - 1);
    const valorAnoAtual = _invValueAtYearEnd(inv, y);
    if (valorAnoAnterior <= 0 && valorAnoAtual <= 0) continue;
    const map = IRPF_INV_CODIGO_MAP[inv.category] || IRPF_INV_CODIGO_MAP.renda_fixa;
    bens.push({
      source: 'inv', id: inv.id, name: inv.name, assetType: inv.category,
      grupoSugerido: map.grupo, codigoSugerido: inv.irpf_codigo || map.codigo, codigoLabel: map.label,
      discriminacao: _irpfSuggestInvDiscriminacao(inv),
      valorAnoAnterior, valorAnoAtual,
      financed: false, encerrado: inv.closed_month || null,
    });
  }

  // Dívidas e ônus reais — só entram as que cruzam o limite de R$5.000 da
  // Receita em pelo menos um dos dois anos (financiamento de bem com
  // garantia NÃO entra aqui — já foi tratado em Bens e Direitos acima).
  const debts = all('SELECT * FROM personal_debts ORDER BY sort_order, id'); // inclui ocultados
  const dividas = [];
  for (const debt of debts) {
    const balAnoAnterior = _debtBalanceAtYearEnd(debt.id, y - 1);
    const balAnoAtual = _debtBalanceAtYearEnd(debt.id, y);
    if (balAnoAnterior <= 5000 && balAnoAtual <= 5000) continue;
    dividas.push({
      debtId: debt.id, name: debt.name,
      codigoSugerido: debt.irpf_codigo || '11', codigoLabel: IRPF_CREDOR_CODIGOS[debt.irpf_codigo || '11'],
      notes: debt.notes || '',
      balAnoAnterior, balAnoAtual,
    });
  }

  // Rendimentos no ano — soma por ativo+tipo de movimentação, filtrando só
  // pelo ANO (não 31/12 — rendimento é o que entrou DURANTE o ano, não uma
  // posição num instante).
  const rendimentos = [];
  for (const asset of assets) {
    const rows = all(`SELECT tx_type, SUM(total_value) as total FROM pat_transactions
      WHERE asset_id=? AND tx_type IN ('aluguel','dividendo','jcp','juros_mutuo') AND substr(month,1,4)=?
      GROUP BY tx_type HAVING total > 0`, [asset.id, String(y)]);
    rows.forEach(r => {
      const map = IRPF_REND_FICHA[r.tx_type] || { ficha: 'outro', label: 'Verificar classificação' };
      rendimentos.push({ source: 'pat', name: asset.name, txType: r.tx_type, valor: r.total, ficha: map.ficha, fichaLabel: map.label });
    });
  }
  for (const inv of invAssets) {
    const rows = all(`SELECT tx_type, SUM(total_value) as total FROM inv_transactions
      WHERE asset_id=? AND tx_type IN ('dividendo','juros','jcp','cupom') AND substr(month,1,4)=?
      GROUP BY tx_type HAVING total > 0`, [inv.id, String(y)]);
    rows.forEach(r => {
      const map = _irpfRendFichaInv(inv.category, r.tx_type, inv.irpf_codigo);
      rendimentos.push({ source: 'inv', name: inv.name, txType: r.tx_type, valor: r.total, ficha: map.ficha, fichaLabel: map.label });
    });
  }

  return { year: y, bens, dividas, rendimentos };
});

// Handler único pra salvar override de código/discriminação, qualquer que
// seja a origem do item (ativo do patrimônio, conta bancária, ou posição de
// investimento) — evita triplicar o mesmo handler por tabela.
ipcMain.handle('irpf:save-override', (_, { source, id, irpf_codigo, irpf_discriminacao }) => {
  const table = source === 'account' ? 'accounts' : source === 'inv' ? 'inv_assets' : 'pat_assets';
  run(`UPDATE ${table} SET irpf_codigo=?, irpf_discriminacao=? WHERE id=?`,
    [irpf_codigo || null, irpf_discriminacao || null, id]);
  return { ok: true };
});

ipcMain.handle('irpf:save-debt-override', (_, { debtId, irpf_codigo }) => {
  run('UPDATE personal_debts SET irpf_codigo=? WHERE id=?', [irpf_codigo || null, debtId]);
  return { ok: true };
});

// Exportação genérica de HTML pra PDF — usa uma janela invisível só pra
// renderizar o HTML e gerar o PDF via printToPDF, depois pede ao usuário
// onde salvar. O app não tinha nenhum mecanismo de exportar PDF ainda.
ipcMain.handle('report:export-pdf', async (_, { html, suggestedName }) => {
  let pdfWin;
  try {
    pdfWin = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    const tmpHtmlPath = path.join(app.getPath('temp'), `ff_report_${Date.now()}.html`);
    fs.writeFileSync(tmpHtmlPath, html, 'utf8');
    await pdfWin.loadFile(tmpHtmlPath);
    const pdfBuffer = await pdfWin.webContents.printToPDF({
      printBackground: true, pageSize: 'A4',
      margins: { marginType: 'custom', top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
    });
    fs.unlinkSync(tmpHtmlPath);

    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Salvar relatório em PDF',
      defaultPath: suggestedName || 'relatorio.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, pdfBuffer);
    require('electron').shell.showItemInFolder(filePath);
    return { ok: true, filePath };
  } catch(e) {
    return { ok: false, error: e.message };
  } finally {
    if (pdfWin) pdfWin.destroy();
  }
});

ipcMain.handle('debt:sync-credit-cards', () => {
  // Inclui cartões OCULTOS também — o saldo continua contando para o
  // patrimônio total, mas a dívida sincronizada herda o mesmo status de
  // oculto da conta (só aparece com "Mostrar ocultos" marcado).
  const cards = all("SELECT * FROM accounts WHERE type='credit'");

  // Limpeza de órfãs: dívidas sincronizadas cujo cartão foi excluído
  // (ou mudou de tipo) — sem isso, a dívida fantasma fica para sempre.
  const cardIds = new Set(cards.map(c => c.id));
  all('SELECT id, linked_account_id FROM personal_debts WHERE linked_account_id IS NOT NULL')
    .forEach(d => {
      if (!cardIds.has(d.linked_account_id)) {
        run('DELETE FROM personal_debt_installments WHERE debt_id=?', [d.id]);
        run('DELETE FROM personal_debts WHERE id=?', [d.id]);
      }
    });

  let syncedMonths = 0;
  cards.forEach(acc => {
    // Encontra ou cria a dívida pessoal vinculada a este cartão.
    let debt = first('SELECT * FROM personal_debts WHERE linked_account_id=?', [acc.id]);
    if (!debt) {
      const newId = run('INSERT INTO personal_debts (name,notes,sort_order,hidden,linked_account_id) VALUES (?,?,?,?,?)',
        [acc.name, 'Sincronizado automaticamente com o cartão de crédito', 0, acc.hidden ? 1 : 0, acc.id]);
      debt = first('SELECT * FROM personal_debts WHERE id=?', [newId]) ||
             first('SELECT * FROM personal_debts WHERE linked_account_id=?', [acc.id]);
    } else {
      // Mantém o nome e o status de oculto sincronizados com a conta.
      if (debt.name !== acc.name || debt.hidden !== (acc.hidden ? 1 : 0)) {
        run('UPDATE personal_debts SET name=?, hidden=? WHERE id=?', [acc.name, acc.hidden ? 1 : 0, debt.id]);
      }
    }
    if (!debt) return;

    // Saldo corrente, mês a mês, na ordem cronológica — mesma técnica do
    // saldo de fim de dia das contas bancárias. Cartão de crédito funciona
    // como conta corrente comum no banco (gasto = saída negativa, pagamento
    // de fatura = entrada positiva); saldo negativo = dívida em aberto.
    const txs = all('SELECT date, amount FROM transactions WHERE account_id=? ORDER BY date, id', [acc.id]);
    const balByMonth = {};
    let running = 0;
    txs.forEach(t => {
      running += t.amount;
      balByMonth[t.date.slice(0,7)] = running; // sobrescreve a cada lançamento do mês — sobra o saldo após o ÚLTIMO
    });

    // Preenche os meses sem lançamento algum repetindo o saldo do mês
    // anterior (senão um mês "parado" desapareceria da série).
    const months = Object.keys(balByMonth).sort();
    if (!months.length) return;
    const allMonths = [];
    { let cur = months[0];
      const last = months[months.length-1];
      while (cur <= last) {
        allMonths.push(cur);
        const d = new Date(cur + '-02'); d.setMonth(d.getMonth()+1);
        cur = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      }
    }
    let carryBal = 0;
    allMonths.forEach(m => {
      if (balByMonth[m] !== undefined) carryBal = balByMonth[m];
      const debtAmount = carryBal < 0 ? -carryBal : 0;
      const existing = first('SELECT * FROM personal_debt_installments WHERE debt_id=? AND month=?', [debt.id, m]);
      if (existing) {
        run('UPDATE personal_debt_installments SET balance_end=?, is_projection=0, paid=1 WHERE id=?', [debtAmount, existing.id]);
      } else {
        run(`INSERT INTO personal_debt_installments (debt_id,month,installment,principal,interest,correction,balance_end,is_projection,paid)
             VALUES (?,?,0,0,0,0,?,0,1)`, [debt.id, m, debtAmount]);
      }
      syncedMonths++;
    });
  });
  save();
  return { ok: true, cardsCount: cards.length, syncedMonths };
});

ipcMain.handle('debt:list', () =>
  all('SELECT * FROM personal_debts ORDER BY sort_order, id')
);

ipcMain.handle('debt:save', (_, { id, name, notes, sort_order, hidden }) => {
  if (id) {
    const existing = first('SELECT sort_order FROM personal_debts WHERE id=?', [id]);
    const so = sort_order ?? existing?.sort_order ?? 0;
    run('UPDATE personal_debts SET name=?,notes=?,sort_order=?,hidden=? WHERE id=?',
      [name, notes||null, so, hidden?1:0, id]);
    return { id };
  } else {
    const newId = run('INSERT INTO personal_debts (name,notes,sort_order,hidden) VALUES (?,?,?,?)',
      [name, notes||null, sort_order ?? 0, hidden?1:0]);
    const resolvedId = newId || first('SELECT id FROM personal_debts WHERE name=? ORDER BY id DESC LIMIT 1', [name])?.id;
    return { id: resolvedId };
  }
});

ipcMain.handle('debt:delete', (_, { id }) => {
  run('DELETE FROM personal_debts WHERE id=?', [id]);
  save();
  return { ok: true };
});

ipcMain.handle('debt:installments-get', (_, { debtId }) =>
  all('SELECT * FROM personal_debt_installments WHERE debt_id=? ORDER BY month', [debtId])
);

ipcMain.handle('debt:contract-get', (_, { debtId }) =>
  first('SELECT * FROM personal_debt_contracts WHERE debt_id=?', [debtId]) || null
);

ipcMain.handle('debt:contract-save', (_, { debtId, contract }) => {
  const { system, index_type, annual_rate, principal, n_installments, first_month,
          balloon_at_keys, extra_annual_month, extra_annual_value, extra_annual_effect, correction_ref_month, notes,
          sync_account_id, sync_day, sync_category } = contract;

  // Upsert contract
  run(`INSERT INTO personal_debt_contracts
    (debt_id,system,index_type,annual_rate,principal,n_installments,first_month,balloon_at_keys,extra_annual_month,extra_annual_value,extra_annual_effect,correction_ref_month,notes,sync_account_id,sync_day,sync_category)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(debt_id) DO UPDATE SET
      system=excluded.system, index_type=excluded.index_type, annual_rate=excluded.annual_rate,
      principal=excluded.principal, n_installments=excluded.n_installments, first_month=excluded.first_month,
      balloon_at_keys=excluded.balloon_at_keys, extra_annual_month=excluded.extra_annual_month,
      extra_annual_value=excluded.extra_annual_value, extra_annual_effect=excluded.extra_annual_effect,
      correction_ref_month=excluded.correction_ref_month, notes=excluded.notes,
      sync_account_id=COALESCE(excluded.sync_account_id, personal_debt_contracts.sync_account_id),
      sync_day=COALESCE(excluded.sync_day, personal_debt_contracts.sync_day),
      sync_category=COALESCE(excluded.sync_category, personal_debt_contracts.sync_category)`,
    [debtId, system, index_type||'none', annual_rate, principal, n_installments, first_month,
     balloon_at_keys||null, extra_annual_month||null, extra_annual_value||null, extra_annual_effect||'moment', correction_ref_month||'minus2', notes||null,
     sync_account_id||null, sync_day||null, sync_category||null]);

  // Generate and save schedule (only projected rows — don't overwrite paid rows)
  const schedule = generateSchedule(contract);

  run('DELETE FROM personal_debt_installments WHERE debt_id=? AND is_projection=1', [debtId]);
  schedule.forEach(row => {
    const existing = first('SELECT id FROM personal_debt_installments WHERE debt_id=? AND month=? AND is_projection=0', [debtId, row.month]);
    if (!existing) {
      run(`INSERT OR REPLACE INTO personal_debt_installments (debt_id,month,installment,principal,interest,correction,balance_end,is_projection,paid)
           VALUES (?,?,?,?,?,?,?,1,0)`,
        [debtId, row.month, row.installment, row.principal, row.interest, row.correction, row.balance_end]);
    }
  });

  // Auto-sync future installments to the configured bank account (if set)
  const debt = first('SELECT name FROM personal_debts WHERE id=?', [debtId]);
  _syncInstallmentsToBank({
    schedule, debtId,
    accountId: sync_account_id, syncDay: sync_day, category: sync_category,
    memoPrefix: `Parcela dívida — ${debt?.name || 'dívida pessoal'}`,
  });

  save();
  return { ok: true, schedule };
});

// Mark installment as paid (called when a transaction is linked as "parcela desta dívida")
// Cronograma REAL persistido de dívida pessoal (com id e status "paid" verdadeiros)
ipcMain.handle('debt:schedule-real', (_, { debtId }) =>
  all('SELECT * FROM personal_debt_installments WHERE debt_id=? ORDER BY month', [debtId])
);

// Alterna o status pago/pendente de parcelas de dívida pessoal, por id
ipcMain.handle('debt:toggle-paid', (_, { ids, paid }) => {
  if (!ids || !ids.length) return { ok: false };
  const affectedDebts = new Set();
  ids.forEach(id => {
    const row = first('SELECT * FROM personal_debt_installments WHERE id=?', [id]);
    if (!row) return;
    run('UPDATE personal_debt_installments SET paid=?, is_projection=? WHERE id=?', [paid?1:0, paid?0:1, id]);
    affectedDebts.add(row.debt_id);
  });
  affectedDebts.forEach(debtId => _rebalanceDebtSchedule(debtId));
  save();
  return { ok: true };
});

ipcMain.handle('debt:mark-paid', (_, { debtId, month, amount }) => {
  const contract = first('SELECT * FROM personal_debt_contracts WHERE debt_id=?', [debtId]);
  const r = contract ? (contract.annual_rate / 100 / 12) : 0;

  const rows = all('SELECT * FROM personal_debt_installments WHERE debt_id=? ORDER BY month', [debtId]);
  const idx  = rows.findIndex(row => row.month.slice(0,7) === month);
  const prevBal = idx > 0 ? (rows[idx-1].balance_end ?? 0) : (contract?.principal ?? 0);

  const interest   = Math.round(prevBal * r * 100) / 100;
  const principal  = Math.max(0, Math.round((amount - interest) * 100) / 100);
  const balanceEnd = Math.max(0, Math.round((prevBal - principal) * 100) / 100);

  const existing = first('SELECT * FROM personal_debt_installments WHERE debt_id=? AND month=?', [debtId, month]);
  if (existing) {
    run('UPDATE personal_debt_installments SET is_projection=0, paid=1, installment=?, principal=?, interest=?, balance_end=? WHERE debt_id=? AND month=?',
      [amount, principal, interest, balanceEnd, debtId, month]);
  } else {
    run('INSERT INTO personal_debt_installments (debt_id,month,installment,principal,interest,correction,balance_end,is_projection,paid) VALUES (?,?,?,?,?,0,?,0,1)',
      [debtId, month, amount, principal, interest, balanceEnd]);
  }
  _rebalanceDebtSchedule(debtId);
  save();
  return { ok: true };
});

// Restore a paid installment back to projection (called when payment is deleted/unlinked)
ipcMain.handle('debt:unpay', (_, { debtId, month }) => {
  const contract = first('SELECT * FROM personal_debt_contracts WHERE debt_id=?', [debtId]);
  if (!contract) {
    run('DELETE FROM personal_debt_installments WHERE debt_id=? AND month=? AND is_projection=0', [debtId, month]);
  } else {
    const fullSchedule = generateSchedule(contract);
    const projRow = fullSchedule.find(r => r.month.slice(0,7) === month.slice(0,7));
    if (projRow) {
      run(`INSERT OR REPLACE INTO personal_debt_installments
           (debt_id,month,installment,principal,interest,correction,balance_end,is_projection,paid)
           VALUES (?,?,?,?,?,0,?,1,0)`,
        [debtId, projRow.month, projRow.installment, projRow.principal, projRow.interest, projRow.balance_end]);
    } else {
      run('DELETE FROM personal_debt_installments WHERE debt_id=? AND month=?', [debtId, month]);
    }
  }
  _rebalanceDebtSchedule(debtId);
  save();
  return { ok: true };
});

// Direct manual edit of a single debt installment (amount and/or paid status) —
// used by inline editing in the Patrimônio table.
ipcMain.handle('debt:installment-set', (_, { debtId, month, installment, paid }) => {
  const existing = first('SELECT * FROM personal_debt_installments WHERE debt_id=? AND month=?', [debtId, month]);
  if (existing) {
    run('UPDATE personal_debt_installments SET installment=?, paid=?, is_projection=? WHERE id=?',
      [installment, paid ? 1 : 0, paid ? 0 : existing.is_projection, existing.id]);
  } else {
    run(`INSERT INTO personal_debt_installments (debt_id,month,installment,principal,interest,correction,balance_end,is_projection,paid)
         VALUES (?,?,?,0,0,0,0,?,?)`,
      [debtId, month, installment, paid ? 0 : 1, paid ? 1 : 0]);
  }
  _rebalanceDebtSchedule(debtId);
  save();
  return { ok: true };
});

function _rebalanceDebtSchedule(debtId) {
  const rows     = all('SELECT * FROM personal_debt_installments WHERE debt_id=? ORDER BY month', [debtId]);
  const contract = first('SELECT * FROM personal_debt_contracts WHERE debt_id=?', [debtId]);
  const r = contract ? (contract.annual_rate / 100 / 12) : 0;

  let balance = null;
  rows.forEach(row => {
    if (balance === null) {
      balance = row.balance_end ?? 0;
      return;
    }
    const interest   = Math.round(balance * r * 100) / 100;
    const principal  = Math.max(0, Math.round((row.installment - interest) * 100) / 100);
    const newBal     = Math.max(0, Math.round((balance - principal) * 100) / 100);
    run('UPDATE personal_debt_installments SET principal=?, interest=?, balance_end=? WHERE id=?',
      [principal, interest, newBal, row.id]);
    balance = newBal;
  });
}

// Fetch financing indexes (INCC, IGP-M, TR, IPC-FIPE)
// Lógica de busca dos índices, extraída para reuso no startup automático
// e no botão manual "Atualizar índices" (financing:fetch-indexes).
async function _fetchFinancingIndexesInternal() {
  const result = { updated: [], errors: [] };
  const idxPath = getDbPath().replace('.db', '_financing_indexes.json');
  if (!global._financingIndexes) global._financingIndexes = {};

  const fetchUrl = (url) => new Promise((res, rej) => {
    const mod = url.startsWith('https') ? require('https') : require('http');
    const headers = { 'User-Agent': 'Cruzeiro/1.0', 'Accept': 'application/json' };
    const handleResponse = r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => {
        if (r.statusCode < 200 || r.statusCode >= 300) {
          rej(new Error(`HTTP ${r.statusCode}${d ? ' — ' + d.slice(0, 200) : ''}`));
        } else {
          res(d);
        }
      });
    };
    mod.get(url, { headers }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location)
        return mod.get(r.headers.location, { headers }, handleResponse).on('error', rej);
      handleResponse(r);
    }).on('error', rej);
  });

  // BCB series (monthly rates, already in %):
  // IGP-M = 189 (% ao mês)
  // INCC  = 192 (% ao mês)
  // TR    = 226 (Taxa Referencial mensal, % ao mês) — a série 4347 usada antes
  //         era "TR para financiamentos imobiliários prefixados do SFH", uma
  //         série específica e descontinuada (parou de ser publicada em 2019).
  // O Bacen serve a série 226 como periodicidade DIÁRIA (mesmo representando
  // uma taxa mensal) — por isso uma consulta de ~26 anos (2000 até hoje) é
  // rejeitada com HTTP 406 ("janela de consulta de, no máximo, 10 anos em
  // séries de periodicidade diária"). IGP-M/INCC não têm essa limitação.
  const bcbSeries = {
    'IGP-M': { code: 189, divisor: 100 },
    'INCC':  { code: 192, divisor: 100 },
    'TR':    { code: 226, divisor: 100, dailyLimited: true },
  };
  const todayBr   = (() => { const d = new Date(); return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`; })();
  const todayYear = new Date().getFullYear();
  const parseBcbRows = (raw, divisor, monthly) => {
    JSON.parse(raw).forEach(r => {
      const parts = r.data.split('/');
      const y = parts[2], m = parts[1];
      const val = parseFloat(r.valor.replace(',','.'));
      if (isFinite(val)) monthly[`${y}-${m}`] = val / divisor;
    });
  };
  for (const [name, { code, divisor, dailyLimited }] of Object.entries(bcbSeries)) {
    try {
      const monthly = {};
      if (dailyLimited) {
        // Bacen não só limita a JANELA de datas (10 anos) como também tem um
        // limite de VOLUME de linhas por requisição (aviso oficial deles sobre
        // "volume de dados retornados será limitado"). Como essa série é
        // diária (não mensal), um bloco de vários anos gera milhares de
        // linhas e a resposta vem CORTADA silenciosamente, sem erro — foi
        // exatamente isso que mantinha a TR sempre parada num mesmo mês,
        // mesmo com o fetch "funcionando". Blocos de 1 ano (~365 linhas)
        // ficam bem abaixo de qualquer limite plausível de volume.
        for (let startYear = 2000; startYear <= todayYear; startYear += 1) {
          const dataInicial = `01/01/${startYear}`;
          const dataFinal = (startYear === todayYear) ? todayBr : `31/12/${startYear}`;
          const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados?formato=json&dataInicial=${dataInicial}&dataFinal=${dataFinal}`;
          parseBcbRows(await fetchUrl(url), divisor, monthly);
        }
      } else {
        const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${code}/dados?formato=json&dataInicial=01/01/2000&dataFinal=${todayBr}`;
        parseBcbRows(await fetchUrl(url), divisor, monthly);
      }
      global._financingIndexes[name] = monthly;
      result.updated.push(name);
    } catch(e) { result.errors.push(`${name}: ${e.message}`); }
  }

  require('fs').writeFileSync(idxPath, JSON.stringify(global._financingIndexes));
  return result;
}

ipcMain.handle('financing:fetch-indexes', async () => {
  const result = await _fetchFinancingIndexesInternal();
  // Recalcula cronogramas ativos com os índices recém-atualizados
  try {
    const activeAssetContracts = all("SELECT id, asset_id FROM pat_financing_contracts WHERE status='active'");
    activeAssetContracts.forEach(c => { try { _regenerateProjectedSchedule(c.asset_id, c.id); } catch(e) {} });
    const activeDebts = all("SELECT DISTINCT debt_id FROM personal_debt_contracts WHERE status='active'");
    activeDebts.forEach(r => { try { _regenerateProjectedDebtSchedule(r.debt_id); } catch(e) {} });
    if (activeAssetContracts.length || activeDebts.length) save();
  } catch(e) { console.warn('[financing indexes] rebalance failed:', e.message); }
  return result;
});

ipcMain.handle('financing:get-indexes', () => global._financingIndexes || {});

// Regenera as linhas PROJETADAS (não pagas) do cronograma de um contrato,
// preservando linhas já pagas. Usado após atualização dos índices de
// correção monetária, para refletir os novos valores nas parcelas futuras.
function _regenerateProjectedSchedule(assetId, contractId) {
  const contract = first('SELECT * FROM pat_financing_contracts WHERE id=?', [contractId]);
  if (!contract) return;
  const schedule = generateSchedule(contract);
  run('DELETE FROM pat_financing WHERE contract_id=? AND is_projection=1', [contractId]);
  schedule.forEach(row => {
    const existing = first('SELECT id FROM pat_financing WHERE contract_id=? AND month=? AND is_projection=0', [contractId, row.month]);
    if (!existing) {
      run(`INSERT OR REPLACE INTO pat_financing (asset_id,contract_id,month,installment,principal,interest,correction,balance_end,is_projection,paid)
           VALUES (?,?,?,?,?,?,?,?,1,0)`,
        [assetId, contractId, row.month, row.installment, row.principal, row.interest, row.correction, row.balance_end]);
    }
  });
  // Mantém as transações futuras já lançadas na conta sincronizada
  // atualizadas com o cronograma recém-recalculado (correção monetária
  // mensal) — sem isso, elas ficavam congeladas no valor de quando foram
  // criadas, mesmo com o índice (TR/IGP-M/INCC) atualizando todo mês.
  if (contract.sync_account_id && contract.sync_day) {
    const asset = first('SELECT name FROM pat_assets WHERE id=?', [assetId]);
    _syncInstallmentsToBank({
      schedule, assetId, contractId,
      accountId: contract.sync_account_id, syncDay: contract.sync_day, category: contract.sync_category,
      memoPrefix: `Parcela financiamento — ${contract.label ? contract.label+' — ' : ''}${asset?.name || 'ativo'}`,
    });
  }
}

function _regenerateProjectedDebtSchedule(debtId) {
  const contract = first('SELECT * FROM personal_debt_contracts WHERE debt_id=?', [debtId]);
  if (!contract) return;
  const schedule = generateSchedule(contract);
  run('DELETE FROM personal_debt_installments WHERE debt_id=? AND is_projection=1', [debtId]);
  schedule.forEach(row => {
    const existing = first('SELECT id FROM personal_debt_installments WHERE debt_id=? AND month=? AND is_projection=0', [debtId, row.month]);
    if (!existing) {
      run(`INSERT OR REPLACE INTO personal_debt_installments (debt_id,month,installment,principal,interest,correction,balance_end,is_projection,paid)
           VALUES (?,?,?,?,?,?,?,1,0)`,
        [debtId, row.month, row.installment, row.principal, row.interest, row.correction, row.balance_end]);
    }
  });
  // Mesmo motivo do bem/direito acima — mantém as transações futuras
  // já lançadas sincronizadas com o cronograma recalculado.
  if (contract.sync_account_id && contract.sync_day) {
    const debt = first('SELECT name FROM personal_debts WHERE id=?', [debtId]);
    _syncInstallmentsToBank({
      schedule, debtId,
      accountId: contract.sync_account_id, syncDay: contract.sync_day, category: contract.sync_category,
      memoPrefix: `Parcela dívida — ${debt?.name || 'dívida pessoal'}`,
    });
  }
}

function _rebalanceSchedule(assetId) {
  const contract = _activeFinancingContract(assetId);
  const cId = contract?.id ?? null;
  const rows = all('SELECT * FROM pat_financing WHERE contract_id=? ORDER BY month', [cId]);
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
  compra:          'set',  // set value = total_value
  // parcela_compra NÃO altera o valor do ativo — posição já foi fixada na compra
  venda:           'set',  // set value = total_value (then zeroed by sold_month logic)
  aporte:          'add',  // value += total_value
  reducao:         'sub',  // value -= total_value
};

// Cash-flow sign convention, mirroring PAT_TX_CASH in renderer.js
const PAT_TX_CASH_SIGN = {
  compra: -1, parcela_compra: -1, aporte: -1, despesa: -1, parcela_financiamento: -1,
  reducao: +1, aluguel: +1, dividendo: +1, jcp: +1, venda: +1, venda_parcela: +1,
};
const PAT_TX_LABELS = {
  compra: 'Compra', parcela_compra: 'Parcela de compra',
  aporte: 'Aporte de capital', despesa: 'Despesa do ativo',
  parcela_financiamento: 'Parcela de financiamento', reducao: 'Redução de capital',
  aluguel: 'Aluguel recebido', dividendo: 'Dividendo', jcp: 'JCP',
  venda: 'Venda', venda_parcela: 'Parcela de venda',
};

ipcMain.handle('pat:tx-list', (_, { assetId }) => {
  _backfillMissingCompraTx(assetId);
  return all('SELECT * FROM pat_transactions WHERE asset_id=? ORDER BY month, id', [assetId]);
});

ipcMain.handle('pat:tx-save', (_, { id, assetId, month, tx_type, total_value, notes, tx_date, account_id, skipHistoryEffect }) => {
  // If updating, read the OLD values first so we can reverse their effect
  const oldTx = id ? first('SELECT * FROM pat_transactions WHERE id=?', [id]) : null;
  const oldAssetId = oldTx?.asset_id ?? assetId;
  const oldMonth   = oldTx?.month?.slice(0,7) ?? month;
  const oldType    = oldTx?.tx_type ?? tx_type;
  const oldVal     = oldTx?.total_value ?? 0;

  if (id) {
    run('UPDATE pat_transactions SET month=?,tx_type=?,total_value=?,notes=?,tx_date=?,account_id=? WHERE id=?',
      [month, tx_type, total_value, notes||null, tx_date||null, account_id||null, id]);
  } else {
    run('INSERT INTO pat_transactions (asset_id,month,tx_type,total_value,notes,tx_date,account_id) VALUES (?,?,?,?,?,?,?)',
      [assetId, month, tx_type, total_value, notes||null, tx_date||null, account_id||null]);
  }

  // If this is an UPDATE, first reverse the OLD effect on pat_history
  if (oldTx && !skipHistoryEffect) {
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

  // Apply NEW effect on pat_history (unless explicitly skipped — e.g. the
  // down-payment "compra" row for a financed asset, where pat_history is
  // managed independently via the financing contract's full asset value)
  const effect = skipHistoryEffect ? null : PAT_TX_AFFECTS_VALUE[tx_type];
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
    } else if (account_id && tx_date) {
      // Forward sync: create a future bank transaction for this movement, if the
      // date is today or later (never retroactive) and one doesn't already exist.
      const today = todayLocal();
      if (tx_date >= today) {
        const sign = PAT_TX_CASH_SIGN[tx_type] ?? 1;
        const asset = first('SELECT name FROM pat_assets WHERE id=?', [assetId]);
        ensureCategoryExists('Patrimônio');
        const txId = run(`INSERT INTO transactions (account_id,date,category,memo,amount,cleared,pat_asset_id,pat_tx_id)
             VALUES (?,?,?,?,?,0,?,?)`,
          [account_id, tx_date, 'Patrimônio', notes || `${PAT_TX_LABELS[tx_type]||tx_type} — ${asset?.name||''}`,
           sign * Math.abs(total_value), assetId, savedId]);
      }
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
    if (asset.asset_type === 'mutuo') {
      // Mútuo tem seu próprio modelo de projeção (taxa + indexador + tipo de
      // juros, via syncMutuoToBank) — nunca deve seguir a tendência genérica
      // de IPCA usada pros demais bens.
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
       AND (category IS NULL OR LOWER(category) NOT LIKE '%transfer%')
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
  // NOTA: transferências ENTRAM no saldo. Excluí-las é correto em resumos de
  // receita/despesa, mas ERRADO para saldo de conta: dinheiro transferido
  // (p.ex. pagamento de fatura, aporte em corretora) realmente sai da conta.
  const placeholders = includedIds.map(() => '?').join(',');
  const txRows = all(
    `SELECT account_id, substr(date,1,7) as month, SUM(amount) as net
     FROM transactions
     WHERE account_id IN (${placeholders})
     GROUP BY account_id, month
     ORDER BY account_id, month`,
    includedIds
  );

  // Build cumulative balances per account per month
  const accountMeta = {};
  all(`SELECT * FROM accounts WHERE id IN (${placeholders})`, includedIds)
    .forEach(a => accountMeta[a.id] = a);

  const byAccount = {};
  txRows.forEach(r => {
    if (!byAccount[r.account_id]) byAccount[r.account_id] = { months: {} };
    byAccount[r.account_id].months[r.month] = r.net;
  });

  // Convert to cumulative — MUST respect includedIds order (sort_order)
  const result = [];
  for (const accId of includedIds) {
    const meta = accountMeta[accId] || {};
    const base = {
      account_id: parseInt(accId),
      name: meta.name || '',
      bank_slug: meta.bank_slug || null,
      bank_name: meta.bank_name || null,
      bank_icon_b64: meta.bank_icon_b64 || null,
      type: meta.type || null,
    };
    const data = byAccount[accId];
    if (!data) {
      // Account has no transactions — still include with zero balance
      result.push({ ...base, history: [] });
      continue;
    }
    const months = Object.keys(data.months).sort();
    let cumulative = 0;
    const history = months.map(m => {
      cumulative += data.months[m];
      return { month: m, balance: Math.round(cumulative * 100) / 100 };
    });
    result.push({ ...base, history });
  }
  return result;
});

// Monthly IPCA (série 433 mensal) — separate from annual IPCA used in Evolução
ipcMain.handle('pat:ipca-monthly-fetch', async () => {
  const https = require('https');
  const todayBr = (() => { const d = new Date(); return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`; })();
  const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados?formato=json&dataInicial=01/01/2000&dataFinal=${todayBr}`;
  return new Promise((resolve) => {
    const req = https.get(url, { headers: {'User-Agent':'Cruzeiro/2.0', 'Accept':'application/json'} }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve({ ok: false, error: `HTTP ${res.statusCode}${body ? ' — ' + body.slice(0,200) : ''}` });
          return;
        }
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
        } catch(e) { resolve({ ok: false, error: `Resposta inesperada do Bacen (não é JSON válido): ${e.message}` }); }
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
function getCatsPath() {
  return getDbPath().replace('.db', '_categories.json');
}

// Garante que uma categoria usada automaticamente pelo app (ex: sync de
// Patrimônio pro banco) exista de fato na lista gerenciada pelo usuário
// (aba Categorias) — sem isso, a categoria aparecia em telas como Evolução
// (que lista DISTINCT category direto da tabela transactions) mas nunca na
// aba Categorias, parecendo "fantasma"/sem explicação.
function ensureCategoryExists(name) {
  if (!name) return;
  try {
    const filePath = getCatsPath();
    let cats = [];
    if (fs.existsSync(filePath)) {
      try { cats = JSON.parse(fs.readFileSync(filePath, 'utf8')) || []; } catch(e) { cats = []; }
    }
    if (!Array.isArray(cats)) cats = [];
    if (!cats.some(c => String(c).toLowerCase() === name.toLowerCase())) {
      cats.push(name);
      fs.writeFileSync(filePath, JSON.stringify(cats));
    }
  } catch(e) { console.error('[ensureCategoryExists]', e); }
}

ipcMain.handle('categories:get', () => {
  // Primary: file next to DB (follows dataDir / Dropbox)
  const filePath = getCatsPath();
  if (fs.existsSync(filePath)) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch(e) {}
  }
  // Fallback: legacy location in _settings.json
  const s = loadSettings();
  if (s.categories && s.categories.length > 0) {
    // Migrate to new location silently
    try {
      fs.writeFileSync(filePath, JSON.stringify(s.categories));
      delete s.categories;
      saveSettings(s);
      console.log('[Cruzeiro] categories migrated from settings to', filePath);
    } catch(e) {}
    return s.categories;
  }
  return null;
});
ipcMain.handle('categories:save', (_, { categories }) => {
  try {
    fs.writeFileSync(getCatsPath(), JSON.stringify(categories));
    // Remove from settings if still there (cleanup migration)
    const s = loadSettings();
    if (s.categories) { delete s.categories; saveSettings(s); }
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

// Registra nomes que o usuário excluiu deliberadamente pela aba Categorias
// — a reconciliação de "categorias usadas em transações" (ensureLateColumns)
// passa a nunca mais recriar esses nomes sozinha, mesmo que transações
// antigas ainda tenham esse texto literal no campo category (não reescrito
// de propósito, pra não alterar histórico). Sem isso, apagar uma categoria
// "fantasma" (ex: "categoria", de um bug antigo) parecia não funcionar —
// ela reaparecia sozinha no próximo boot.
ipcMain.handle('categories:exclude', (_, { names }) => {
  try {
    const excludedPath = getExcludedCatsPath();
    let excluded = [];
    if (fs.existsSync(excludedPath)) {
      try { excluded = JSON.parse(fs.readFileSync(excludedPath, 'utf8')) || []; } catch(e) { excluded = []; }
    }
    if (!Array.isArray(excluded)) excluded = [];
    (names || []).forEach(n => {
      if (n && !excluded.some(e => String(e).toLowerCase() === String(n).toLowerCase())) excluded.push(n);
    });
    fs.writeFileSync(excludedPath, JSON.stringify(excluded));
    // Limpa também as regras de ML (ml_rules) que sugeririam essa categoria
    // sozinhas em transações futuras/novas — sem isso, apagar a categoria
    // "some" da aba Categorias mas continua sendo AUTO-SUGERIDA pelo
    // preenchimento automático (predição por memorando) toda vez que o
    // usuário digita um memo parecido, dando a impressão de que ela "volta
    // sozinha" mesmo em lançamentos completamente novos.
    (names || []).forEach(n => {
      if (!n) return;
      run('UPDATE ml_rules SET category=\'\' WHERE LOWER(category)=LOWER(?)', [n]);
    });
    save();
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('users:list', () => {
  const registry = loadUserRegistry();
  return registry.users.map(u => {
    const s = loadSettings(u.id);
    return { id: u.id, name: u.name, hasPassword: !!(s.passwordHash || s.hasEncryptedDB) };
  });
});

ipcMain.handle('users:add', (_, { name, password }) => {
  const registry = loadUserRegistry();
  const trimmed = (name||'').trim();
  if (!trimmed) return { ok: false, error: 'Informe um nome' };
  const id = 'usr_' + Date.now();
  registry.users.push({ id, name: trimmed });
  saveUserRegistry(registry);
  if (password) {
    const s = loadSettings(id); // {} — arquivo ainda não existe
    s.passwordHash = hashPassword(password);
    saveSettings(s, id);
  }
  return { ok: true, id };
});

ipcMain.handle('users:rename', (_, { id, name }) => {
  const registry = loadUserRegistry();
  const u = registry.users.find(u => u.id === id);
  if (!u) return { ok: false };
  u.name = (name||'').trim() || u.name;
  saveUserRegistry(registry);
  return { ok: true };
});

// Define qual usuário está entrando e dispara o fluxo de inicialização
// completo pra ele — a partir daqui, getSettingsPath()/getDbPath() (sem
// argumento) já leem/escrevem os arquivos certos automaticamente, então
// TODA a lógica de senha/criptografia/banco continua exatamente igual,
// sem precisar saber que existe mais de um usuário.
ipcMain.handle('users:select', async (_, { id }) => {
  _currentUserId = id || null;
  _loggingIn = true;
  if (selectUserWin) { selectUserWin.destroy(); selectUserWin = null; }
  // sb._session é uma variável de módulo única, compartilhada por todos os
  // usuários locais deste Desktop — sem limpar aqui, um usuário local que
  // nunca configurou o sync mobile herdaria silenciosamente a sessão
  // Supabase do usuário anterior (ver clearSession() em supabase-client.js).
  sb.clearSession();
  try {
    await mainStartupFlow();
  } finally {
    _loggingIn = false;
  }
  return { ok: true };
});

// Apaga TODOS os arquivos de dados de um usuário (banco + sidecars — todos
// derivados de getDbPath() com sufixos diferentes: categorias, senha de
// recuperação, backup de emergência, cache de hash do sync, etc.). Usa o
// mesmo prefixo que doBackup() já usa pra distinguir os arquivos de cada
// usuário na mesma pasta ("cruzeiro_data_<id>..." vs "cruzeiro_data...",
// tomando cuidado pro usuário padrão não apagar os sidecars de um usuário
// nomeado cujo prefixo também começa com "cruzeiro_data"). Backups (pasta
// separada) e "_import_pending.json" (arquivo global, não tem sufixo de
// usuário) são deliberadamente preservados — não fazem parte da "identidade"
// do usuário, e apagar os backups removeria a única rede de segurança caso
// a exclusão tenha sido um erro.
function deleteUserDataFiles(id) {
  const settings = loadSettings(id);
  const base = settings.dataDir
    ? settings.dataDir
    : (app.isPackaged ? app.getPath('userData') : path.join(__dirname, '..'));
  if (fs.existsSync(base)) {
    const prefix = id ? `cruzeiro_data_${id}` : 'cruzeiro_data';
    fs.readdirSync(base).forEach(f => {
      if (!f.startsWith(prefix)) return;
      if (!id && /^_usr_/.test(f.slice(prefix.length))) return; // sidecar de outro usuário
      try { fs.unlinkSync(path.join(base, f)); } catch(e) {}
    });
  }
  try {
    const sp = getSettingsPath(id);
    if (fs.existsSync(sp)) fs.unlinkSync(sp);
  } catch(e) {}
}

// Exclui definitivamente o usuário ATUALMENTE LOGADO (nunca outro — sem
// isso, bastaria conhecer o id de outro usuário registrado neste mesmo PC
// pra apagar os dados dele sem saber a senha). Exige a senha do usuário se
// ele tiver uma configurada (mesma checagem usada em settings:set-password).
ipcMain.handle('users:delete', (_, { id, password }) => {
  if (id !== _currentUserId) {
    return { ok: false, error: 'Só é possível excluir o usuário que está logado no momento.' };
  }
  const s = loadSettings();
  if (_dbKey || s.passwordHash) {
    if (_dbKey) {
      const dp = getDbPath();
      if (fs.existsSync(dp) && isDBEncrypted(dp)) {
        try {
          decryptDBWithPassword(fs.readFileSync(dp), password || '');
        } catch(e) {
          return { ok: false, error: 'Senha incorreta' };
        }
      }
    } else if (s.passwordHash) {
      if (hashPassword(password || '') !== s.passwordHash) {
        return { ok: false, error: 'Senha incorreta' };
      }
    }
  }

  deleteUserDataFiles(id);

  const registry = loadUserRegistry();
  const remaining = registry.users.filter(u => u.id !== id);
  if (remaining.length) {
    saveUserRegistry({ users: remaining });
  } else {
    // Nenhum usuário restante — remove o registro inteiro. Sem o arquivo,
    // loadUserRegistry() volta a assumir o único usuário "Principal"
    // implícito, exatamente como numa instalação nova.
    try {
      const rp = getUserRegistryPath();
      if (fs.existsSync(rp)) fs.unlinkSync(rp);
    } catch(e) {}
  }

  return { ok: true };
});

ipcMain.handle('settings:get', () => {
  const s = loadSettings();
  return {
    hasPassword: !!s.passwordHash || !!s.hasEncryptedDB,
    dataDir: s.dataDir || null,
    tourDone: !!s.tourDone,
    currentUserId: _currentUserId,
    benchmarks: s.benchmarks || null,
    hasRecoveryEmail: !!s.recoveryEmail,
    recoveryEmailMasked: s.recoveryEmail ? s.recoveryEmail.replace(/(.{2}).*(@.*)/, '$1***$2') : null,
    termsAcceptedVersion: s.termsAcceptedVersion || null,
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

// ── SEGURANÇA: LICENSE_SECRET removido do app desktop ──────────────────────
// A validação de licença agora é feita pelo servidor (Supabase Edge Function).
// O segredo nunca é distribuído com o instalador.
const VALIDATE_LICENSE_URL = 'https://nfpjxmwrtwogctocqtxp.supabase.co/functions/v1/validate-license';
const SUPABASE_ANON_KEY    = 'sb_publishable_rCikC0YRWCUwicYs0v7W8Q_k5sniHIl';

const FREE_MONTHS       = 6;
const INCOME_THRESHOLD  = 3000;
const EXPENSE_THRESHOLD = 5000;
const WEALTH_THRESHOLD  = 100000;

// ── Cache de validação (válido por 24h para não exigir internet a cada abertura) ──
function _getLicenseCache() {
  const s = loadSettings();
  return s._licenseCache || null;
}
function _setLicenseCache(email, code, valid) {
  const s = loadSettings();
  s._licenseCache = { email, code, valid, validatedAt: new Date().toISOString() };
  saveSettings(s);
}
function _isCacheValid(cache) {
  if (!cache) return false;
  const age = Date.now() - new Date(cache.validatedAt).getTime();
  return age < 24 * 60 * 60 * 1000; // 24 horas
}

// ── Valida licença no servidor (async, com fallback para cache offline) ──
async function validateLicenseServerSide(email, code) {
  const cache = _getLicenseCache();
  if (_isCacheValid(cache) && cache.email === email.toLowerCase().trim() && cache.code === code.trim().toUpperCase()) {
    return cache.valid;
  }
  try {
    const https = require('https');
    const body  = JSON.stringify({ email: email.toLowerCase().trim(), code: code.trim().toUpperCase() });
    const url   = new URL(VALIDATE_LICENSE_URL);

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path:     url.pathname,
        method:   'POST',
        headers: {
          'Content-Type':  'application/json',
          'apikey':        SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Resposta inválida do servidor')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(body);
      req.end();
    });

    const valid = result?.valid === true;
    _setLicenseCache(email, code, valid);
    return valid;
  } catch (err) {
    console.warn('[license] Servidor indisponível, usando cache offline:', err.message);
    if (cache && cache.email === email.toLowerCase().trim() && cache.code === code.trim().toUpperCase()) {
      return cache.valid;
    }
    const s = loadSettings();
    return !!(s.licenseCode && s.licenseEmail);
  }
}

// Wrapper síncrono para uso em computeLicenseStatus (que não pode ser async)
function validateLicenseCode(code) {
  const s = loadSettings();
  if (!s.licenseCode || !s.licenseEmail) return false;
  if (code.trim().toUpperCase() !== s.licenseCode.trim().toUpperCase()) return false;

  const cache = _getLicenseCache();
  if (_isCacheValid(cache) &&
      cache.email === s.licenseEmail.toLowerCase().trim() &&
      cache.code  === s.licenseCode.trim().toUpperCase()) {
    return cache.valid;
  }
  validateLicenseServerSide(s.licenseEmail, s.licenseCode).catch(() => {});
  return true; // benefício da dúvida enquanto revalida
}

function computeLicenseStatus() {
  const s = loadSettings();

  // ── DEBUG OVERRIDE (testing only) ──
  // Set settings.debugLicenseOverride to 'trial' | 'free_social' | 'payment_required' | 'licensed'
  // to simulate that status regardless of actual dates/thresholds. Remove or set
  // to null/undefined for normal behavior. Exposed via Settings for easy testing.
  if (s.debugLicenseOverride === 'payment_required') {
    return {
      status: 'payment_required',
      reason: 'Licença necessária (modo de teste)',
      daysLeft: 0,
      avgIncome: 0, avgExpense: 0, totalWealth: 0,
    };
  }
  if (s.debugLicenseOverride === 'free_social') {
    return { status: 'free_social', reason: 'Gratuito (modo de teste)', daysLeft: 0, avgIncome: 0, avgExpense: 0, totalWealth: 0 };
  }
  if (s.debugLicenseOverride === 'trial') {
    return { status: 'trial', reason: 'Período gratuito (modo de teste)', daysLeft: 30 };
  }

  // 1. If valid license code stored → always unlocked
  if (s.licenseCode && validateLicenseCode(s.licenseCode)) {
    return { status: 'licensed', reason: 'Licença válida', daysLeft: null };
  }

  // 2. Check free trial period
  if (!s.firstRun) {
    s.firstRun = todayLocal();
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
       AND (category IS NULL OR LOWER(category) NOT LIKE '%transfer%')
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

// ── DEBUG: override license status for testing (see computeLicenseStatus) ──
ipcMain.handle('license:debug-override', (_, { value }) => {
  const s = loadSettings();
  if (value) s.debugLicenseOverride = value;
  else delete s.debugLicenseOverride;
  saveSettings(s);
  return computeLicenseStatus();
});

ipcMain.handle('license:activate', async (_, { code, email }) => {
  if (!code || !email) return { ok: false, error: 'Código e email são obrigatórios.' };
  let valid = false;
  try {
    valid = await validateLicenseServerSide(email, code);
  } catch (err) {
    return { ok: false, error: 'Não foi possível verificar a licença. Verifique sua conexão com a internet.' };
  }
  if (!valid) {
    return { ok: false, error: 'Código de licença inválido para este e-mail.' };
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

// Nota: geração de licenças agora é feita pelo servidor. O CLI --gen-license
// foi removido pois o segredo não está mais no app desktop.
if (process.argv[2] === '--gen-license') {
  console.log('Geração de licenças migrada para o servidor. Use o cruzeiro_license_generator.html.');
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

ipcMain.handle('import:save-pending', (_, state) => {
  try {
    if (!state) {
      const p = getImportStatePath();
      if (fs.existsSync(p)) fs.unlinkSync(p);
      return { ok: true };
    }
    fs.writeFileSync(getImportStatePath(), JSON.stringify({ ...state, savedAt: Date.now() }));
    return { ok: true };
  } catch(e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('import:load-pending', () => {
  try {
    const p = getImportStatePath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch(e) { return null; }
});
ipcMain.handle('import:clear-pending', () => {
  try {
    const p = getImportStatePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return { ok: true };
  } catch(e) { return { ok: false }; }
});

ipcMain.handle('app:open-external', (_, url) => {
  try {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      require('electron').shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false };
  } catch(e) { return { ok: false }; }
});
ipcMain.handle('settings:save-data', (_, data) => {
  const s = loadSettings();
  Object.assign(s, data);
  saveSettings(s);
  return { ok: true };
});

// Por padrão, contas de investimento NÃO são sincronizadas com o mobile
// (segurança: dados de patrimônio financeiro só trafegam/ficam no Supabase
// se o usuário optar explicitamente por isso).
function getSyncInvestmentsPref() {
  const s = loadSettings();
  return s.syncInvestmentsToMobile === true;
}

ipcMain.handle('sync:get-investments-pref', () => getSyncInvestmentsPref());

ipcMain.handle('sync:set-investments-pref', async (_, enabled) => {
  const s = loadSettings();
  const wasEnabled = s.syncInvestmentsToMobile === true;
  s.syncInvestmentsToMobile = !!enabled;
  saveSettings(s);

  // Se o usuário acabou de DESATIVAR, precisa também remover do Supabase
  // o que já tinha sido enviado anteriormente — não basta parar de enviar
  // dados novos, é preciso limpar o que já está lá.
  if (wasEnabled && !enabled && sb.isLoggedIn()) {
    try {
      const userId = sb.getUserId();
      await sb.remove('mobile_balances', { user_id: userId, account_type: 'investment' });
      await sb.remove('mobile_patrimonio', { user_id: userId });

      // mobile_transactions não tem account_type — remove por nome de conta
      const investmentAccounts = all("SELECT name FROM accounts WHERE type='investment'");
      for (const acc of investmentAccounts) {
        await sb.remove('mobile_transactions', { user_id: userId, account_name: acc.name }).catch(() => {});
      }

      console.log('[sync] dados de investimento removidos do Supabase (opt-out)');
    } catch (e) {
      console.error('[sync] erro ao remover dados de investimento:', e.message);
    }
  }

  return { ok: true };
});

// ── AI: Anthropic API key (stored locally in settings) ──
// ════════ AI: multi-provider (Gemini grátis / Anthropic / OpenAI) ════════
// O usuário escolhe o provedor e cola a própria chave. Recomendado: Google Gemini,
// que oferece chave gratuita sem cartão de crédito (1500 req/dia no Flash).
function getAiConfig() {
  const s = loadSettings();
  return {
    provider: s.aiProvider || 'openrouter',
    key: s.aiApiKey || s.anthropicApiKey || '', // migra chave antiga
  };
}

ipcMain.handle('ai:get-key-status', () => {
  const { provider, key } = getAiConfig();
  return {
    hasKey: !!key,
    provider,
    masked: key ? key.slice(0,6) + '...' + key.slice(-4) : null,
  };
});
ipcMain.handle('ai:set-key', (_, payload) => {
  const s = loadSettings();
  // payload pode ser string (legado) ou { provider, key }
  const provider = (typeof payload === 'object' && payload?.provider) || 'openrouter';
  const key = (typeof payload === 'object' ? payload?.key : payload) || '';
  s.aiProvider = provider;
  s.aiApiKey = key.trim();
  delete s.anthropicApiKey; // consolida na nova chave
  saveSettings(s);
  return { ok: true, hasKey: !!s.aiApiKey, provider };
});
ipcMain.handle('ai:clear-key', () => {
  const s = loadSettings();
  delete s.aiApiKey;
  delete s.anthropicApiKey;
  saveSettings(s);
  return { ok: true };
});

// Chamada central: recebe system + user prompt, devolve texto da resposta.
async function callLLM(systemPrompt, userPrompt) {
  const { provider, key } = getAiConfig();
  if (!key) return { ok: false, error: 'NO_KEY' };

  // Conhecido (jun/2026): o Google AI Studio passou a emitir, para algumas contas/projetos,
  // chaves com prefixo "AQ." em vez do formato padrão "AIza...". Essas chaves são um tipo de
  // credencial diferente (token OAuth) e são REJEITADAS pelo endpoint REST simples usado aqui
  // (erro ACCESS_TOKEN_TYPE_UNSUPPORTED / 401), independente do SDK ou da implementação.
  // Detectamos e orientamos o usuário a gerar uma chave no formato correto.
  if (provider === 'gemini' && key.startsWith('AQ.')) {
    return { ok: false, error: 'GEMINI_AQ_KEY' };
  }

  try {
    if (provider === 'gemini') {
      // Google Gemini (AI Studio) — chave gratuita sem cartão
      const model = 'gemini-2.0-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(()=> '');
        if (res.status === 401 || t.includes('ACCESS_TOKEN_TYPE_UNSUPPORTED')) return { ok: false, error: 'GEMINI_AQ_KEY' };
        if (res.status === 400 || res.status === 403) return { ok: false, error: 'BAD_KEY' };
        return { ok: false, error: 'API_ERROR', detail: `${res.status} ${t.slice(0,200)}` };
      }
      const data = await res.json();
      const txt = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      return { ok: true, text: txt };
    }

    if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
          temperature: 0.2, max_tokens: 1024,
        }),
      });
      if (!res.ok) {
        if (res.status === 401) return { ok: false, error: 'BAD_KEY' };
        const t = await res.text().catch(()=> '');
        return { ok: false, error: 'API_ERROR', detail: `${res.status} ${t.slice(0,200)}` };
      }
      const data = await res.json();
      return { ok: true, text: (data.choices?.[0]?.message?.content || '').trim() };
    }

    if (provider === 'openrouter') {
      // OpenRouter: API gratuita compatível com OpenAI, com modelos :free sem custo
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model: 'openrouter/free', // roteador automático para modelos gratuitos disponíveis
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
          temperature: 0.2, max_tokens: 1024,
        }),
      });
      if (!res.ok) {
        if (res.status === 401) return { ok: false, error: 'BAD_KEY' };
        const t = await res.text().catch(()=> '');
        return { ok: false, error: 'API_ERROR', detail: `${res.status} ${t.slice(0,200)}` };
      }
      const data = await res.json();
      return { ok: true, text: (data.choices?.[0]?.message?.content || '').trim() };
    }

    // Anthropic
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!res.ok) {
      if (res.status === 401) return { ok: false, error: 'BAD_KEY' };
      const t = await res.text().catch(()=> '');
      return { ok: false, error: 'API_ERROR', detail: `${res.status} ${t.slice(0,200)}` };
    }
    const data = await res.json();
    const txt = (data.content || []).map(b => b.type === 'text' ? b.text : '').join('').trim();
    return { ok: true, text: txt };
  } catch(e) {
    return { ok: false, error: 'NETWORK', detail: String(e).slice(0,200) };
  }
}

function stripJsonFence(raw) {
  return (raw || '').replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
}

// ── AI: natural-language transaction parsing ──
ipcMain.handle('ai:parse-transaction', async (_, { text, accounts, categories, today }) => {
  if (!text || !text.trim()) return { ok: false, error: 'EMPTY' };
  const accList = (accounts || []).map(a => `- id:${a.id} | ${a.name} (${a.type})`).join('\n');
  const catList = (categories || []).join(', ');
  const sys = `Você é um assistente que converte descrições em linguagem natural (português do Brasil) em lançamentos financeiros estruturados.
Hoje é ${today}.
Contas disponíveis:
${accList}
Categorias disponíveis: ${catList}

REGRA MAIS IMPORTANTE — SINAL DO VALOR:
- O DEFAULT é DESPESA (amount NEGATIVO). A grande maioria dos lançamentos do dia a dia são gastos.
- Só use amount POSITIVO (receita) se houver uma palavra explícita de entrada de dinheiro: "recebi", "caiu", "depositei", "salário", "pix recebido", "reembolso", "vendi", "ganhei", "transferência recebida".
- Compras, pagamentos, consumo em geral (mercado, restaurante, almoço, jantar, uber, gasolina, conta, boleto, assinatura, remédio, etc.) são SEMPRE despesa (negativo), mesmo sem a palavra "paguei" ou "gastei" explícita.
- Exemplos:
  "almoço 45 reais" → amount: -45 (despesa, é consumo)
  "recebi 45 de fulano" → amount: 45 (receita, tem "recebi")
  "uber 22" → amount: -22 (despesa)
  "salário 5000" → amount: 5000 (receita, é entrada de renda)
  "mercado 230" → amount: -230 (despesa)
  "vendi um item por 100" → amount: 100 (receita, tem "vendi")

Outras regras:
- Escolha a conta mais provável pelo texto; se não houver pista, use a primeira conta da lista.
- Escolha a categoria mais próxima da lista; se nenhuma encaixar, use "".
- Datas relativas (ontem, hoje, semana passada, dia 5) viram data absoluta YYYY-MM-DD baseada em hoje.
- Pode haver mais de um lançamento numa única frase.
- Responda SOMENTE com JSON válido, sem markdown, sem texto extra, no formato:
{"transactions":[{"date":"YYYY-MM-DD","account_id":<int>,"category":"<str>","memo":"<str>","amount":<number>}],"confidence":"high|medium|low","note":"<curta explicação opcional>"}`;

  const r = await callLLM(sys, text.trim());
  if (!r.ok) return r;
  let parsed;
  try { parsed = JSON.parse(stripJsonFence(r.text)); }
  catch(e) { return { ok: false, error: 'PARSE_FAIL', detail: (r.text||'').slice(0,300) }; }
  return { ok: true, result: parsed };
});

// ── AI: categorização em lote de transações importadas ──
// Recebe linhas sem categoria + lista de categorias do usuário; devolve
// um mapeamento índice→categoria. Uma única chamada para até ~60 linhas.
// ── Auditoria de saldo pós-fatura: detecção de duplicatas reais no banco ──
// Procura grupos de transações com mesma data+valor+memo aparecendo 2+
// vezes na conta dentro do período — usado quando a auditoria do livro-razão
// (na renderer) não encontra uma linha "sem destino" que explique sozinha
// a diferença, sugerindo que algo pode ter sido inserido duas vezes.
// Soma de transações de uma conta num intervalo de datas — a "verdade
// terrena" (consulta fresca ao banco, não a contabilidade em memória do
// renderer) usada como um dos lados da comparação na auditoria de saldo
// pós-fatura.
ipcMain.handle('tx:sum-in-range', (_, { accountId, dateFrom, dateTo }) => {
  const row = first(
    'SELECT COALESCE(SUM(amount),0) as total, COUNT(*) as n FROM transactions WHERE account_id=? AND date BETWEEN ? AND ?',
    [accountId, dateFrom, dateTo]
  );
  return { total: row?.total || 0, count: row?.n || 0 };
});

ipcMain.handle('tx:find-duplicates-in-range', (_, { accountId, dateFrom, dateTo }) => {
  const rows = all(
    `SELECT id, date, amount, memo, COUNT(*) OVER (PARTITION BY date, amount, LOWER(TRIM(memo))) as grp_count
     FROM transactions
     WHERE account_id=? AND date BETWEEN ? AND ?
     ORDER BY date, memo`,
    [accountId, dateFrom, dateTo]
  );
  const groups = {};
  rows.filter(r => r.grp_count > 1).forEach(r => {
    const key = `${r.date}|${r.amount}|${normKey(r.memo)}`;
    (groups[key] = groups[key] || []).push({ id: r.id, date: r.date, amount: r.amount, memo: r.memo });
  });
  return Object.values(groups);
});

// ── AI: diagnóstico de divergência de saldo na fatura ──
// Fallback usado quando a auditoria determinística (livro-razão por linha +
// checagem de duplicatas no banco) não consegue explicar sozinha a
// diferença entre o total da fatura e o total registrado.
ipcMain.handle('ai:diagnose-fatura-gap', async (_, { diff, unaccountedRows, dbDuplicateGroups }) => {
  const sys = `Você audita faturas de cartão de crédito importadas para um app financeiro.
O total da fatura (soma das linhas do arquivo importado) não bateu com o total efetivamente
registrado na conta. Diferença: R$ ${diff.toFixed(2)} (positivo = faltou dinheiro registrado;
negativo = foi registrado a mais que o esperado).

Linhas da fatura sem destino identificado (podem ser a causa de "faltou"):
${JSON.stringify(unaccountedRows || [], null, 0)}

Grupos de transações duplicadas encontradas na conta (podem ser a causa de "sobrou"):
${JSON.stringify(dbDuplicateGroups || [], null, 0)}

Responda SOMENTE com JSON válido, sem markdown:
{"explicacao": "frase curta e direta explicando a causa mais provável",
 "confianca": "alta"|"media"|"baixa"}`;
  const r = await callLLM(sys, 'Diagnostique a diferença.');
  if (!r.ok) return r;
  try {
    const parsed = JSON.parse(stripJsonFence(r.text));
    return { ok: true, ...parsed };
  } catch(e) {
    return { ok: false, error: 'PARSE_FAIL' };
  }
});

ipcMain.handle('ai:categorize-batch', async (_, { rows, categories }) => {
  if (!Array.isArray(rows) || !rows.length) return { ok: false, error: 'EMPTY' };
  const catList = (categories || []).join(', ');
  const lines = rows.slice(0, 60).map((r, i) =>
    `${i}|${String(r.memo || '').slice(0, 80)}|${r.amount}`).join('\n');
  const sys = `Você categoriza transações bancárias brasileiras.
Categorias disponíveis (use EXATAMENTE um destes nomes): ${catList}

Receberá linhas no formato: indice|descricao|valor (valor negativo = despesa, positivo = receita).
Para cada linha, escolha a categoria mais provável da lista. Se realmente não der para inferir, use "".
Responda SOMENTE com JSON válido, sem markdown: {"cats":{"0":"Categoria","1":"Outra", ...}}`;
  const r = await callLLM(sys, lines);
  if (!r.ok) return r;
  try {
    const parsed = JSON.parse(stripJsonFence(r.text));
    const cats = parsed.cats || parsed;
    // Sanitiza: só aceita categorias que existem na lista do usuário
    const valid = new Set(categories || []);
    const out = {};
    Object.entries(cats).forEach(([k, v]) => {
      if (valid.has(v)) out[k] = v;
    });
    return { ok: true, cats: out };
  } catch(e) {
    return { ok: false, error: 'PARSE_FAIL', detail: (r.text || '').slice(0, 300) };
  }
});

// ── Insights: maiores transações do mês (para dar concretude à análise da IA) ──
// Retorna as N maiores DESPESAS e as N maiores RECEITAS do mês (líquidas por
// lançamento, já excluindo transferências — tanto as com transfer_id quanto as
// categorizadas manualmente como "⇄ Transferência: X"). Serve para a IA citar
// exemplos reais ("a maior despesa do mês foi R$ X em Y") em vez de só tendências.
ipcMain.handle('insights:top-transactions', (_, { month, limit }) => {
  const from = month + '-01';
  const to   = month + '-31';
  const n = Math.max(1, Math.min(20, parseInt(limit) || 5));
  const base = `FROM transactions t
    WHERE t.date>=? AND t.date<=? AND t.transfer_id IS NULL
      AND (t.category IS NULL OR LOWER(t.category) NOT LIKE '%transfer%')`;
  const expenses = all(`SELECT t.date, t.category, t.memo, t.amount ${base}
    AND t.amount < 0 ORDER BY t.amount ASC LIMIT ?`, [from, to, n]);
  const income = all(`SELECT t.date, t.category, t.memo, t.amount ${base}
    AND t.amount > 0 ORDER BY t.amount DESC LIMIT ?`, [from, to, n]);
  const clean = r => ({ date: r.date, category: r.category || '(sem categoria)',
    memo: (r.memo || '').slice(0, 60), amount: Math.round(Math.abs(r.amount)) });
  return { expenses: expenses.map(clean), income: income.map(clean) };
});

// ── AI: proactive financial insights ──
ipcMain.handle('ai:generate-insights', async (_, { summary }) => {
  if (!summary) return { ok: false, error: 'EMPTY' };
  const sys = `Você é um consultor financeiro pessoal analisando os dados de um usuário brasileiro.
Receberá um resumo em JSON com gastos/receitas por categoria. IMPORTANTE: os valores de "current"
e "avgPrior" por categoria JÁ ESTÃO corrigidos pela inflação (IPCA, valores em R$ de hoje) E JÁ
ESTÃO suavizados por média móvel de 12 meses (MA12) — ou seja, NÃO são o valor bruto daquele mês
específico, são uma tendência de 12 meses centrada naquele mês. Isso é intencional: evita que você
aponte um "salto" em categorias episódicas (viagens, presentes sazonais, manutenções pontuais) que
naturalmente variam mês a mês sem indicar um problema real — a suavização já filtrou esse ruído.
Trate "pctChange" como uma variação de TENDÊNCIA ano a ano, não como um pico isolado.

Cada categoria traz TRÊS números: "current" e "avgPrior" (tendência MA12, R$ de hoje — use-os
com linguagem de TENDÊNCIA: "na tendência dos últimos 12 meses", "na média recente") e
"actualThisMonth" (o valor NOMINAL que REALMENTE aconteceu no mês analisado — este SIM pode ser
descrito como "neste mês você gastou/recebeu R$ X"). Use "actualThisMonth" quando quiser citar o
fato concreto do mês, e "current"/"pctChange" quando quiser falar de tendência. NÃO confunda os
dois nem descreva a tendência MA12 como se fosse o gasto pontual do mês.

CUIDADO COM POUCOS DADOS: cada categoria traz "monthsWithData" (quantos meses do período tiveram
movimento). Se for baixo (1 ou 2), NÃO afirme tendências fortes ("disparou", "triplicou") sobre
ela — pode ser um gasto pontual. Prefira categorias com histórico consistente para conclusões.

CRÍTICO — cada categoria já vem com "type" ("receita" ou "despesa") e "trend" pré-calculados pelo
app. SEMPRE confie nesses dois campos para decidir o tom — NUNCA tente adivinhar pelo nome da
categoria ou pelo sinal dos números se algo é ganho ou gasto. Os valores de "current"/"avgPrior"
são sempre positivos quando aquilo cresce (mais gasto OU mais ganho), então o sinal por si só NÃO
diz se é bom ou mau — só o "type" diz. Uma categoria com type="despesa" e trend="aumentando" é uma
notícia RUIM (gastou mais) e deve ser descrita com linguagem de gasto/custo ("gastos com X
aumentaram", nunca "ganhos com X aumentaram"). Uma categoria com type="receita" e trend="subindo" é
uma notícia BOA (ganhou mais) e deve ser descrita com linguagem de receita/ganho.

O resumo também traz, para o MÊS ANALISADO (valores NOMINAIS reais, sem IPCA/MA12):
- "totalIncome" = total de RECEITAS do mês; "totalExpenses" = total de DESPESAS do mês;
  "netResult" = receitas − despesas (a poupança do mês; se negativo, houve DÉFICIT);
  "savingsRate" = % da receita que sobrou (netResult/totalIncome). Ao falar de "quanto gastou",
  use SEMPRE "totalExpenses" — NUNCA o netResult (que já desconta receitas). A taxa de poupança é
  um ótimo indicador de saúde financeira: comente-a (ex.: "você poupou 18% da renda") e compare com
  "avgMonthlyIncome"/"avgMonthlyExpenses" (médias dos meses anteriores) para dizer se melhorou ou piorou.
- "budgets": cada orçamento traz "limit", "spent" (gasto LÍQUIDO no mês, já somando subcategorias e
  descontando estornos), "pctUsed" (% do limite usado) e "status" ("acima" = estourou, "perto" = ≥85%,
  "ok", "sem_limite"). SEMPRE que houver orçamentos, gere ao menos um insight comparando ORÇADO vs
  REALIZADO, priorizando os de status "acima" e "perto", citando o % e os valores reais.
- "topTransactions": as maiores DESPESAS ("expenses") e RECEITAS ("income") individuais do mês, cada
  uma com categoria, memo e valor. Use-as para dar CONCRETUDE ("a maior despesa do mês foi R$ X em Y")
  em vez de só falar em agregados. Não invente transações que não estejam nessa lista.
- dívidas pessoais cadastradas (com taxa de juros real), juros de rotativo/cheque especial detectados
  recentemente em importações, e o saldo líquido disponível hoje ("liquidBalanceToday").

Campos de controle da análise (respeite-os com prioridade):
- "categoriesFilter": se for uma lista (não "todas"), a análise deve focar SOMENTE nessas categorias.
- "focus": indica a ênfase pedida — "gastos" (onde está gastando mais), "receitas" (como estão as
  receitas), "tendencia" (variações e tendências), "orcamento" (comparação com limites), "ambos" (livre).
- "userRequest": se não for null, é um pedido em linguagem natural do PRÓPRIO USUÁRIO — priorize
  responder exatamente a esse pedido nos insights gerados, usando os números do resumo para isso.

Gere de 3 a 5 insights CURTOS, ESPECÍFICOS e ACIONÁVEIS em português do Brasil.
Cada insight deve citar números concretos do resumo (ex: "Mercado subiu 32% na tendência de 12 meses").
Foque em: variações relevantes de gasto, categorias acima do orçamento, tendências, oportunidades de economia, e elogios quando o usuário está indo bem.

REGRA ESPECIAL — DÍVIDA CARA (gatilhos independentes, qualquer um já é suficiente):
(a) há itens em recentDebtInterest (juros de rotativo de cartão ou cheque especial detectados
    recentemente), OU
(b) há itens em personalDebts cuja annualRate seja claramente alta (acima de ~40% a.a., faixa
    típica de cheque especial/rotativo no Brasil).
Se (a) ou (b) ocorrer, gere SEMPRE um insight do tipo "alert" com sugestão de alternativa mais
barata, baseada nos dados REAIS do usuário:
- Se liquidBalanceToday for suficiente para cobrir o valor do encargo ou abater a dívida cara,
  sugira quitar com o saldo disponível em vez de manter o rotativo/dívida cara (cite o valor
  exato do saldo).
- Se houver outra entrada em personalDebts com annualRate MENOR que a dívida cara em questão,
  sugira consolidar nela, citando as duas taxas reais do resumo.
- Caso nenhuma das duas opções acima seja possível com os dados disponíveis, cite a ORDEM TÍPICA
  de custo das modalidades de crédito no Brasil, da mais barata para a mais cara — consignado,
  empréstimo pessoal com garantia, empréstimo pessoal sem garantia, parcelamento direto da fatura
  com o banco, cheque especial, rotativo do cartão — e recomende que o usuário pesquise as taxas
  reais oferecidas a ele nessas modalidades mais baratas antes de continuar pagando a atual.
  NUNCA cite um número de taxa (%) para essas modalidades alternativas — apenas a ordem relativa
  de custo. Números de taxa só podem vir do que já está no resumo (personalDebts, recentDebtInterest).
NÃO sugira alternativas genéricas como "negocie com o banco" sem conectar a um dado concreto do resumo.
NÃO invente dados que não estão no resumo. NÃO dê conselhos genéricos fora dessa regra especial.

FORMATO DE RESPOSTA — siga EXATAMENTE este exemplo de estrutura (mas com seu próprio conteúdo,
nunca copie os valores de exemplo abaixo, eles são só para mostrar o formato):
{"insights":[
  {"icon":"📈","type":"trend","title":"Mercado subiu 24%","detail":"Texto com números reais aqui."},
  {"icon":"🛒","type":"alert","title":"Gasto alto em mercado","detail":"Texto com números reais aqui."}
]}
Regras OBRIGATÓRIAS do formato:
- "icon": exatamente UM caractere emoji (ex: 📈 ou 🛒 ou 💰 ou ⚠️ ou ✅), nunca texto, nunca a palavra "emoji".
- "type": escolha UMA destas quatro palavras exatas, em minúsculas, sem aspas extras dentro do valor:
  alert (para alertas/problemas), positive (para elogios/boas notícias), tip (para dicas/sugestões),
  trend (para tendências/variações). NUNCA escreva as quatro opções juntas — escolha apenas uma.
- Responda SOMENTE com o JSON, sem texto antes ou depois, sem markdown, sem comentários.`;

  const r = await callLLM(sys, JSON.stringify(summary));
  if (!r.ok) return r;
  let parsed;
  try { parsed = JSON.parse(stripJsonFence(r.text)); }
  catch(e) { return { ok: false, error: 'PARSE_FAIL', detail: (r.text||'').slice(0,300) }; }
  return { ok: true, result: parsed };
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
  try { ensureLateColumns(); _backfillMissingFinancingTx(); _backfillMissingCompraTx(); } catch(e) {}

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
      try { ensureLateColumns(); _backfillMissingFinancingTx(); _backfillMissingCompraTx(); save(); } catch(e) {}
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

ipcMain.handle('settings:set-backup-dir', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Escolher pasta de backup (separada da pasta de dados)',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { ok: false };
  const dir = result.filePaths[0];

  const s = loadSettings();
  s.backupDir = dir;
  saveSettings(s);

  // Faz um backup imediato na nova pasta, pra não ficar sem nenhum backup
  // ali até o próximo backup automático programado.
  try { doBackup(); } catch(e) {}

  return { ok: true, dir };
});

ipcMain.handle('settings:clear-backup-dir', () => {
  const s = loadSettings();
  delete s.backupDir;
  saveSettings(s);
  return { ok: true };
});

ipcMain.handle('login:get-mode', () => {
  // 'local' = DB criptografado (exige senha local)
  // 'supabase' = login com e-mail + senha do Supabase
  const s = loadSettings();
  if (s.hasEncryptedDB || _dbPendingDecrypt || s.passwordHash) return 'local';
  return 'supabase';
});

ipcMain.handle('login:supabase', async (_, { email, password }) => {
  try {
    const result = await sb.login(email, password);
    const s = loadSettings();
    s.supabaseEmail        = result.user.email;
    s.supabaseRefreshToken = result.refresh_token;
    saveSettings(s);
    await _ensureFirstRun(result.user.id);
    return { ok: true };
  } catch(e) {
    const msg = e.message || '';
    if (msg.includes('Invalid login') || msg.includes('invalid_grant') || msg.includes('400')) {
      return { ok: false, error: 'E-mail ou senha incorretos.' };
    }
    return { ok: false, error: 'Não foi possível conectar. Verifique sua internet.' };
  }
});

// Garante que o firstRun do usuário está registrado no Supabase (controla
// o trial de 6 meses de forma server-side, resistente a reinstalação)
async function _ensureFirstRun(userId) {
  try {
    const rows = await sb.select('user_first_run', { user_id: userId });
    if (!rows.length) {
      const today = todayLocal();
      await sb.upsert('user_first_run', [{ user_id: userId, first_run: today }], 'user_id');
      console.log('[firstRun] registrado:', today);
    }
  } catch(e) {
    console.warn('[firstRun] não foi possível registrar no servidor:', e.message);
  }
}

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
      try { ensureLateColumns(); _backfillMissingFinancingTx(); _backfillMissingCompraTx(); save(); } catch(e) {}
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
      // Preenche categoria/tipo se estiverem vazios — não sobrescreve uma
      // escolha já feita manualmente, só corrige o caso de ter ficado em
      // branco (ex: ativo criado sem categoria antes desta importação).
      run("UPDATE inv_assets SET category = CASE WHEN category IS NULL OR category = '' THEN ? ELSE category END, " +
          "inv_type = CASE WHEN inv_type IS NULL OR inv_type = '' THEN ? ELSE inv_type END WHERE id = ?",
          [categoria, inv_type, assetId]);
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

// ══════════════════════════════════════════════════════════════
// SYNC MOBILE (Supabase)
// ══════════════════════════════════════════════════════════════

// Função central de sync — pull primeiro (importa entradas do mobile),
// depois push (publica snapshot atualizado com as novas transações)
// ─────────────────────────────────────────────────────────────
// Inicialização da chave de criptografia de dados
//
// Fluxo:
//   1. Busca no Supabase se já existe uma chave para este user
//   2a. Se sim: decifra com a senha fornecida → chave disponível
//   2b. Se não: gera nova chave aleatória, cifra com a senha,
//       salva no Supabase → primeira configuração
//   3. Caso a chave não abra com a senha atual: a senha foi
//      trocada. Invalida o cache de sync e aguarda re-sync.
// ─────────────────────────────────────────────────────────────
async function initEncryptionKey(userId, password) {
  try {
    const rows = await sb.select('user_encryption_keys', { user_id: userId });
    const existing = rows?.[0];

    if (existing) {
      const ok = cryptoUtils.unlockDataKey(password, existing.encrypted_key, existing.salt);
      if (!ok) {
        console.log('[crypto] senha diferente da original — re-cifrando chave de dados');
        const { encryptedKey, salt } = cryptoUtils.reencryptDataKey(password);
        await sb.update('user_encryption_keys', { user_id: userId }, {
          encrypted_key: encryptedKey,
          salt,
          updated_at: new Date().toISOString(),
        });
        syncPush.invalidateCacheTables(['balances','transactions','budgets','goals','scheduled','patrimonio','evolution','ml_rules']);
        console.log('[crypto] chave re-cifrada, cache invalidado — próximo sync será completo');
      } else {
        console.log('[crypto] chave de dados desbloqueada com sucesso');
      }
    } else {
      console.log('[crypto] primeira configuração — gerando chave de dados');
      const { encryptedKey, salt } = cryptoUtils.generateAndEncryptDataKey(password);
      await sb.upsert('user_encryption_keys', [{
        user_id:       userId,
        encrypted_key: encryptedKey,
        salt,
        version:       1,
        created_at:    new Date().toISOString(),
        updated_at:    new Date().toISOString(),
      }], 'user_id');
      cryptoUtils.unlockDataKey(password, encryptedKey, salt);
      console.log('[crypto] chave de dados gerada e ativada');
    }
  } catch (e) {
    console.error('[crypto] erro ao inicializar chave de dados:', e.message);
    // Falha silenciosa — sync continua sem criptografia (RLS ainda protege)
  }
}

async function runMobileSync(trigger = 'manual') {
  if (!sb.isLoggedIn()) {
    console.log(`[sync] pulado (trigger: ${trigger}) — sem sessão Supabase`);
    return { skipped: 'not_logged_in' };
  }
  if (_syncRunning)     return { skipped: 'already_running' };

  _syncRunning = true;
  console.log(`[sync] iniciando (trigger: ${trigger})`);
  _syncPromise = (async () => {

  try {
    const userId = sb.getUserId();
    sb.setEgressLogPath(getDbPath());
    const pull   = await syncPull.pullAll(all, run, first, save, userId);
    const push   = await syncPush.pushAll(all, userId, getAiConfig, getSyncInvestmentsPref, getDbPath, fs);
    const result = { ok: true, trigger, pull, push, at: new Date().toISOString() };
    console.log('[sync] concluído:', result);
    sb.printEgressSummary();

    // Notifica o renderer para recarregar dados (se janela aberta)
    if (win && !win.isDestroyed()) {
      win.webContents.send('sync:completed', result);
    }

    return result;
  } catch (e) {
    console.error('[sync] erro geral:', e.message);
    return { ok: false, error: e.message };
  }

  })();

  try {
    return await _syncPromise;
  } finally {
    _syncRunning = false;
    _syncPromise = null;
  }
}

// ── IPC: Login Supabase ──────────────────────────────────────
ipcMain.handle('sync:login', async (_, { email, password }) => {
  try {
    const result = await sb.login(email, password);
    const userId = result.user.id;

    // Inicializa/carrega a chave de criptografia de dados do usuário
    await initEncryptionKey(userId, password);

    // Guarda a senha via safeStorage (Keychain/DPAPI do SO) para
    // restaurar a chave de criptografia nas próximas aberturas do app
    // sem precisar que o usuário redigite a senha.
    const s = loadSettings();
    if (safeStorage.isEncryptionAvailable()) {
      s.supabaseEncryptedPassword = safeStorage.encryptString(password).toString('base64');
    }
    s.supabaseEmail        = result.user.email;
    s.supabaseRefreshToken = result.refresh_token;
    saveSettings(s);

    // Se o usuário já tinha aceitado os Termos ANTES de logar (ordem comum:
    // aceita no primeiro boot, só configura o Mobile depois em
    // Configurações), este é o primeiro momento em que temos e-mail/sessão
    // pra registrar o comprovante remoto — ver _recordTermsAcceptance.
    if (s.termsAcceptedVersion) {
      _recordTermsAcceptance(s.termsAcceptedVersion, s.termsAcceptedAt).catch(() => {});
    }

    // Dispara sync imediato após login
    runMobileSync('login').catch(() => {});
    return { ok: true, email: result.user.email };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── IPC: Logout Supabase ─────────────────────────────────────
ipcMain.handle('sync:logout', async () => {
  try {
    await sb.logout();
    cryptoUtils.lockDataKey(); // limpa chave de dados da memória
    const s = loadSettings();
    delete s.supabaseEmail;
    delete s.supabaseRefreshToken;
    delete s.supabaseEncryptedPassword; // remove senha salva
    saveSettings(s);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ── Registra comprovante de aceite dos Termos de Uso no Supabase ──
// Best-effort: o aceite em si já fica salvo localmente (settings:save-data)
// — isso aqui é só o registro remoto, auditável, pra quem já está logado
// (tem e-mail/sessão). Quem usa o Desktop 100% local nunca teve conta
// criada, então não há "quem" registrar além do que já está local — nesse
// caso simplesmente não grava nada remoto. Ver supabase/terms_acceptances.sql
// pro schema (tabela append-only, RLS).
//
// Chamada em DOIS pontos, porque aceite e login podem acontecer em ordens
// diferentes: (1) direto ao aceitar, se o usuário já estiver logado; (2) ao
// logar, se ele já tinha aceitado os termos localmente ANTES de configurar
// a sincronização — sem esse segundo ponto, quem aceita primeiro e loga
// depois nunca gerava registro remoto nenhum. `acceptedAt` é sempre o
// momento real do aceite (settings.termsAcceptedAt), não o momento em que
// esta função roda, pra não distorcer o comprovante.
async function _recordTermsAcceptance(version, acceptedAt) {
  if (!version) return { ok: false, reason: 'no-version' };
  if (!sb.isLoggedIn()) return { ok: false, reason: 'not-logged-in' };
  const s = loadSettings();
  const userId = sb.getUserId();
  if (!userId || !s.supabaseEmail) return { ok: false, reason: 'no-identity' };
  await sb.upsert('terms_acceptances', [{
    user_id:     userId,
    email:       s.supabaseEmail,
    version:     String(version),
    accepted_at: acceptedAt || new Date().toISOString(),
    app_version: app.getVersion(),
    platform:    process.platform,
  }]);
  return { ok: true };
}

ipcMain.handle('terms:record-acceptance', async (_, version) => {
  try {
    return await _recordTermsAcceptance(version, new Date().toISOString());
  } catch (e) {
    console.warn('[terms] falha ao registrar aceite no Supabase:', e.message);
    return { ok: false, error: e.message };
  }
});

// ── IPC: Status da sessão e último sync ──────────────────────
ipcMain.handle('sync:status', () => {
  const s = loadSettings();
  return {
    loggedIn:     sb.isLoggedIn(),
    email:        s.supabaseEmail || null,
    syncRunning:  _syncRunning,
  };
});

// ── IPC: Disparar sync manual (botão na UI) ──────────────────
ipcMain.handle('sync:run-now', async () => {
  if (!sb.isLoggedIn()) return { ok: false, error: 'Faça login para sincronizar' };
  return runMobileSync('manual');
});

