/**
 * limpar_dados.js — Limpa todos os dados do usuário para distribuição limpa.
 * Uso: npm run clean-data
 * 
 * Suporta banco de dados criptografado (com senha) ou não.
 */

const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const readline  = require('readline');
const initSqlJs = require('./node_modules/sql.js');

const PROJECT_DIR = __dirname;
const DB_PATH     = path.join(PROJECT_DIR, 'cruzeiro_data.db');
const DB_MAGIC    = Buffer.from('CRUZEIRO1');

function isEncrypted(buf) {
  return buf.length > DB_MAGIC.length && buf.slice(0, DB_MAGIC.length).equals(DB_MAGIC);
}

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 100_000, 32, 'sha256');
}

function decryptDB(encBuf, password) {
  let off = DB_MAGIC.length;
  const salt = encBuf.slice(off, off + 32); off += 32;
  const iv   = encBuf.slice(off, off + 12); off += 12;
  const tag  = encBuf.slice(off, off + 16); off += 16;
  const enc  = encBuf.slice(off);
  const key  = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function ask(question) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Hide input for password
    process.stdout.write(question);
    let pw = '';
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', function handler(ch) {
      if (ch === '\n' || ch === '\r' || ch === '\u0003') {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
        process.stdin.removeListener('data', handler);
        process.stdout.write('\n');
        rl.close();
        resolve(pw);
      } else if (ch === '\u007f') {
        pw = pw.slice(0, -1);
      } else {
        pw += ch;
        process.stdout.write('*');
      }
    });
  });
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`❌ Banco de dados não encontrado em: ${DB_PATH}`);
  process.exit(1);
}

(async () => {
  console.log('🧹 Iniciando limpeza de dados...');
  console.log(`   DB: ${DB_PATH}\n`);

  const SQL = await initSqlJs();
  let rawBuf = fs.readFileSync(DB_PATH);

  // Handle encrypted DB
  if (isEncrypted(rawBuf)) {
    console.log('   🔐 Banco de dados está criptografado.');
    let decrypted = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const pw = await ask(`   Senha (tentativa ${attempt}/3): `);
      try {
        decrypted = decryptDB(rawBuf, pw);
        console.log('   ✅ Senha correta.\n');
        break;
      } catch(e) {
        if (attempt === 3) {
          console.error('   ❌ Senha incorreta 3 vezes. Abortando.');
          process.exit(1);
        }
        console.log('   ❌ Senha incorreta, tente novamente.');
      }
    }
    rawBuf = decrypted;
  }

  const db = new SQL.Database(rawBuf);

  // Discover ALL tables dynamically
  const allTables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  const tableNames = allTables[0]?.values.map(r => r[0]) || [];

  let totalRows = 0;
  for (const table of tableNames) {
    try {
      const count = db.exec(`SELECT COUNT(*) FROM "${table}"`)[0]?.values[0][0] || 0;
      db.run(`DELETE FROM "${table}"`);
      try { db.run(`DELETE FROM sqlite_sequence WHERE name=?`, [table]); } catch(e) {}
      const icon = count > 0 ? '✅' : '  ';
      console.log(`   ${icon} ${table}: ${count} registros removidos`);
      totalRows += Number(count);
    } catch (e) {
      console.log(`   ⚠️  ${table}: ${e.message}`);
    }
  }

  // Save clean DB (always plaintext — no point encrypting an empty DB)
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  db.close();
  console.log('');

  // _settings.json
  const settingsPath = path.join(PROJECT_DIR, '_settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      delete s.passwordHash;
      delete s.hasEncryptedDB;
      delete s.recoveryEmail;
      delete s.resetCode;
      delete s.resetExpires;
      delete s.licenseCode;
      delete s.licenseEmail;
      delete s.firstRun;
      s.tourDone   = false;
      s.categories = [];
      s.benchmarks = { cdi: {}, ibov: {}, lastUpdate: null };
      delete s.dataDir;
      fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
      console.log('   ✅ _settings.json: dados pessoais removidos');
    } catch(e) {
      console.log(`   ⚠️  _settings.json: ${e.message}`);
    }
  }

  // Lateral JSON files
  const sideFiles = [
    'cruzeiro_data_financing_indexes.json',
    'cruzeiro_data_import_defaults.json',
    'cruzeiro_data_ml_export.json',
    'cruzeiro_data_benchmarks.json',
    'cruzeiro_data_ipca.json',
    'cruzeiro_data_pat_ipca_monthly.json',
    'cruzeiro_data_overview_config.json',
    'cruzeiro_data_report_config.json',
    'cruzeiro_data_saved_reports.json',
    'cruzeiro_data_cat_types.json',
    'cruzeiro_data_col_config.json',
    'latest.json',
    '_bank_parsers.json',
    '_recovery.enc',
    '_categories.json',
  ];

  for (const fname of sideFiles) {
    const fpath = path.join(PROJECT_DIR, fname);
    if (fs.existsSync(fpath)) {
      fs.unlinkSync(fpath);
      console.log(`   ✅ Removido: ${fname}`);
    }
  }

  // Backups folder
  const backupsDir = path.join(PROJECT_DIR, 'backups');
  if (fs.existsSync(backupsDir)) {
    const files = fs.readdirSync(backupsDir);
    files.forEach(f => {
      try { fs.unlinkSync(path.join(backupsDir, f)); } catch(e) {}
    });
    if (files.length) console.log(`   ✅ backups/: ${files.length} arquivo(s) removido(s)`);
  }

  console.log(`\n✨ Limpeza concluída! ${totalRows} registros removidos.`);
  console.log('   Todas as tabelas estão vazias. App pronto para distribuição.\n');
})();
