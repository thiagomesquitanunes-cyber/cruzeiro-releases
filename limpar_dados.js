/**
 * limpar_dados.js — Limpa todos os dados do usuário para distribuição limpa.
 * Uso: npm run clean-data
 */

const path      = require('path');
const fs        = require('fs');
const initSqlJs = require('./node_modules/sql.js');

const PROJECT_DIR = __dirname;
const DB_PATH     = path.join(PROJECT_DIR, 'cruzeiro_data.db');

if (!fs.existsSync(DB_PATH)) {
  console.error(`❌ Banco de dados não encontrado em: ${DB_PATH}`);
  process.exit(1);
}

(async () => {
  console.log('🧹 Iniciando limpeza de dados...');
  console.log(`   DB: ${DB_PATH}\n`);

  const SQL = await initSqlJs();
  const db  = new SQL.Database(fs.readFileSync(DB_PATH));

  // Descobrir TODAS as tabelas do banco dinamicamente
  const allTables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  const tableNames = allTables[0]?.values.map(r => r[0]) || [];

  // Tabelas a preservar (estrutura mantida, mas dados apagados em todas)
  // Não há exceção — tudo é dado do usuário
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

  // Salva banco limpo (estrutura preservada, dados apagados)
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  db.close();
  console.log('');

  // ── _settings.json ────────────────────────────────────────────────────────
  const settingsPath = path.join(PROJECT_DIR, '_settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      delete s.passwordHash;
      delete s.recoveryEmail;
      delete s.resetCode;
      delete s.resetExpires;
      s.tourDone   = false;
      s.categories = [];
      s.benchmarks = { cdi: {}, ibov: {}, lastUpdate: null };
      // Preserva: language, (dataDir é removido pois aponta para pasta do dev)
      delete s.dataDir;
      fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
      console.log('   ✅ _settings.json: dados pessoais removidos');
    } catch(e) {
      console.log(`   ⚠️  _settings.json: ${e.message}`);
    }
  }

  // ── Arquivos JSON laterais ────────────────────────────────────────────────
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
  ];

  for (const fname of sideFiles) {
    const fpath = path.join(PROJECT_DIR, fname);
    if (fs.existsSync(fpath)) {
      fs.unlinkSync(fpath);
      console.log(`   ✅ Removido: ${fname}`);
    }
  }

  // ── Pasta de backups ──────────────────────────────────────────────────────
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
