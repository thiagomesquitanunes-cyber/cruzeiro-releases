/**
 * limpar_dados.js — Apaga por completo os dados de TODOS os usuários
 * cadastrados (multi-usuário no mesmo desktop), para distribuição limpa.
 * Uso: npm run clean-data
 *
 * Em vez de abrir o banco e esvaziar as tabelas (o que exigia decifrar um
 * banco criptografado antes), simplesmente APAGA os arquivos por completo —
 * banco, configurações, arquivos auxiliares e backups de cada usuário. O
 * app recria tudo do zero na próxima abertura, exatamente como uma
 * instalação nova. Mais simples, mais confiável (não depende de enumerar
 * cada campo a limpar) e não precisa mais de senha nenhuma.
 */

const path = require('path');
const fs   = require('fs');

const PROJECT_DIR   = __dirname;
const REGISTRY_PATH = path.join(PROJECT_DIR, '_users_registry.json');

// Varre a pasta do projeto por arquivos de usuários que não estejam (mais)
// no registro — ex: se o registro já foi apagado numa limpeza anterior,
// mas o banco/configuração de outro usuário ainda existem no disco. Tanto
// "cruzeiro_data_X.db" quanto "_settings_X.json" sempre ficam na pasta do
// projeto (nunca seguem dataDir customizado), então varrer aqui é
// suficiente pra encontrar QUALQUER usuário, mesmo órfão do registro.
function discoverOrphanUserIds() {
  const ids = new Set();
  try {
    const files = fs.readdirSync(PROJECT_DIR);
    files.forEach(f => {
      const m1 = f.match(/^cruzeiro_data_(.+)\.db$/);
      const m2 = f.match(/^_settings_(.+)\.json$/);
      if (m1) ids.add(m1[1]);
      if (m2) ids.add(m2[1]);
    });
  } catch (e) {}
  return ids;
}

// Descobre TODOS os usuários cadastrados (mesmo princípio do main.js: sem
// arquivo de registro, existe implicitamente um único usuário "Principal",
// usando os nomes de arquivo originais sem sufixo) — combinado com a
// varredura de órfãos acima, pra nunca depender SÓ do registro.
function loadUsers() {
  const seen = new Map();
  try {
    const r = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    (r.users || []).forEach(u => seen.set(u.id || null, u));
  } catch (e) {}
  if (!seen.has(null)) seen.set(null, { id: null, name: 'Principal' });
  discoverOrphanUserIds().forEach(uid => {
    if (!seen.has(uid)) seen.set(uid, { id: uid, name: `(encontrado na pasta, sem registro: ${uid})` });
  });
  return Array.from(seen.values());
}

// Resolve a mesma pasta de dados que o main.js usaria (getDbPath) PARA UM
// USUÁRIO ESPECÍFICO — cada usuário pode ter sua própria "Pasta de dados"
// customizada (Configurações > Pasta de dados).
function resolveDataDir(uid) {
  const settingsPath = path.join(PROJECT_DIR, uid ? `_settings_${uid}.json` : '_settings.json');
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (s.dataDir && fs.existsSync(s.dataDir)) return s.dataDir;
  } catch (e) {}
  return PROJECT_DIR;
}

function removeIfExists(fpath, label) {
  if (fs.existsSync(fpath)) {
    fs.unlinkSync(fpath);
    console.log(`   ✅ Removido: ${label || path.basename(fpath)}`);
    return true;
  }
  return false;
}

// Apaga por completo os arquivos de UM usuário.
function cleanUser(user) {
  const uid = user.id || null;
  const label = user.name || 'Principal';
  const dataDir = resolveDataDir(uid);
  const dbPath = path.join(dataDir, uid ? `cruzeiro_data_${uid}.db` : 'cruzeiro_data.db');
  const settingsPath = path.join(PROJECT_DIR, uid ? `_settings_${uid}.json` : '_settings.json');
  const dbPrefix = uid ? `cruzeiro_data_${uid}` : 'cruzeiro_data';

  console.log(`\n👤 Usuário: ${label}${uid ? '' : ' (padrão)'}`);
  console.log(`   Pasta de dados: ${dataDir}${dataDir !== PROJECT_DIR ? ' (customizada)' : ' (pasta do projeto)'}`);

  const hadDb = removeIfExists(dbPath, `${path.basename(dbPath)} (banco de dados)`);
  if (!hadDb) console.log('   ℹ️  Sem banco de dados ainda — nada a apagar aqui.');
  removeIfExists(settingsPath, `${path.basename(settingsPath)} (configurações)`);

  // Arquivos JSON "laterais" — todos derivados de getDbPath() no main.js
  // (mesmo prefixo do banco deste usuário específico, trocando a extensão).
  const sideFileSuffixes = [
    'financing_indexes.json', 'import_defaults.json', 'ml_export.json', 'benchmarks.json',
    'ipca.json', 'pat_ipca_monthly.json', 'overview_config.json', 'report_config.json',
    'saved_reports.json', 'cat_types.json', 'col_config.json', 'categories.json',
    'recovery.enc', 'emergency.db.bak',
  ];
  for (const suffix of sideFileSuffixes) {
    removeIfExists(path.join(dataDir, `${dbPrefix}_${suffix}`));
  }

  // Backups DESTE usuário — pro usuário padrão, exclui explicitamente
  // arquivos de outros usuários (já que "cruzeiro_data_" é prefixo de
  // "cruzeiro_data_usr_X_").
  const backupsDir = path.join(dataDir, 'backups');
  if (fs.existsSync(backupsDir)) {
    const allFiles = fs.readdirSync(backupsDir);
    const mine = allFiles.filter(f => {
      if (!f.startsWith(dbPrefix + '_') || !f.endsWith('.db')) return false;
      if (uid) return true;
      return !/^usr_/.test(f.slice(dbPrefix.length + 1));
    });
    mine.forEach(f => { try { fs.unlinkSync(path.join(backupsDir, f)); } catch (e) {} });
    if (mine.length) console.log(`   ✅ backups/: ${mine.length} arquivo(s) deste usuário removido(s)`);
  }
}

(() => {
  console.log('🧹 Iniciando limpeza de dados...');

  const users = loadUsers();
  console.log(`   ${users.length} usuário(s) cadastrado(s): ${users.map(u => u.name).join(', ')}`);

  for (const user of users) {
    cleanUser(user);
  }

  // Arquivos verdadeiramente compartilhados entre usuários (não seguem
  // dataDir nem sufixo de usuário — ex: parsers de banco customizados,
  // que fazem sentido ficarem disponíveis pra qualquer um no mesmo PC).
  console.log('');
  const projectDirFiles = ['latest.json', '_bank_parsers.json', '_categories.json'];
  for (const fname of projectDirFiles) {
    if (removeIfExists(path.join(PROJECT_DIR, fname), `${fname} (compartilhado)`)) {}
  }

  // Reseta o registro de usuários — uma distribuição limpa não deve levar
  // os perfis extras criados durante desenvolvimento/testes; na próxima
  // abertura, volta a ser o fluxo de usuário único de sempre.
  removeIfExists(REGISTRY_PATH, '_users_registry.json (volta a abrir como usuário único)');

  console.log(`\n✨ Limpeza concluída para ${users.length} usuário(s).`);
  console.log('   Todos os arquivos foram apagados — o app recria tudo do zero na próxima abertura, como uma instalação nova.\n');
})();
