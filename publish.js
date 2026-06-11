/**
 * publish.js — Cria a tag git e faz push para disparar o build automático.
 * Uso: npm run publish
 */

const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const pkg  = require('./package.json');
const version = pkg.version;
const tag     = `v${version}`;

function run(cmd, opts = {}) {
  console.log(`  > ${cmd}`);
  try {
    return execSync(cmd, { stdio: 'inherit', ...opts });
  } catch(e) {
    const msg = e.stderr?.toString?.() || e.message;
    throw new Error(`Comando falhou: ${cmd}\n${msg}`);
  }
}

function runSilent(cmd) {
  try { return execSync(cmd, { stdio: 'pipe' }).toString().trim(); } catch(e) { return null; }
}

// ── Check git available ──────────────────────────────────────────────────
const gitVersion = runSilent('git --version');
if (!gitVersion) {
  console.error('\n❌ Git não encontrado no PATH.');
  console.error('   Instale em: https://git-scm.com/download/win');
  console.error('   Após instalar, feche e reabra o terminal.\n');
  process.exit(1);
}
console.log(`\n🚀 Publicando Cruzeiro ${tag}...\n`);
console.log(`   Git: ${gitVersion}\n`);

// ── Check / init git repo ────────────────────────────────────────────────
const isRepo = runSilent('git rev-parse --git-dir');
if (!isRepo) {
  console.log('  ⚠️  Repositório git não encontrado. Inicializando...');
  run('git init');
  run('git branch -M main');

  // Check if remote already exists
  const remotes = runSilent('git remote') || '';
  if (!remotes.includes('origin')) {
    run('git remote add origin https://github.com/thiagomesquitanunes-cyber/cruzeiro-releases.git');
    console.log('  ✅ Remote "origin" configurado.\n');
  }

  // Create .gitignore if not exists
  const gitignorePath = path.join(__dirname, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, [
      'node_modules/',
      'dist/',
      '*.db',
      '*_recovery.enc',
      '*_emergency.db.bak',
      'backups/',
      '*.log',
    ].join('\n'));
    console.log('  ✅ .gitignore criado.\n');
  }
}

try {
  // Stage and commit
  run('git add -A');
  const status = runSilent('git status --short');
  if (status) {
    run(`git commit -m "Release ${tag}"`);
  } else {
    console.log('  (nenhuma alteração pendente)\n');
    runSilent(`git commit --allow-empty -m "Release ${tag}"`);
  }

  // Remove old tag if exists
  if (runSilent(`git tag -l ${tag}`)) {
    runSilent(`git tag -d ${tag}`);
    runSilent(`git push origin :refs/tags/${tag}`);
    console.log(`  Tag ${tag} anterior removida.\n`);
  }

  // Create and push tag
  run(`git tag ${tag}`);
  run('git push origin HEAD --set-upstream');
  run(`git push origin ${tag}`);

  console.log(`\n✨ Tag ${tag} publicada com sucesso!`);
  console.log(`\n   Arquivos que serão gerados automaticamente:`);
  console.log(`   • Windows:          Cruzeiro-Setup-${version}.exe`);
  console.log(`   • macOS Intel:      Cruzeiro-${version}-x64.dmg`);
  console.log(`   • macOS Apple Si:   Cruzeiro-${version}-arm64.dmg`);
  console.log(`\n   Acompanhe: https://github.com/thiagomesquitanunes-cyber/cruzeiro-releases/actions\n`);

} catch(e) {
  console.error('\n❌ Erro:', e.message);
  console.error('\n   Dicas:');
  console.error('   1. Verifique se git está no PATH: git --version');
  console.error('   2. Verifique o remote: git remote -v');
  console.error('   3. Se a pasta não tiver .git, rode: git init');
  console.error('      Depois: git remote add origin https://github.com/thiagomesquitanunes-cyber/cruzeiro-releases.git\n');
  process.exit(1);
}
