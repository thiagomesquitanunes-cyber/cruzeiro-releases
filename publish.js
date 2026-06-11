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
  // Generate package-lock.json if missing (required by GitHub Actions npm ci)
  const lockPath = path.join(__dirname, 'package-lock.json');
  if (!fs.existsSync(lockPath)) {
    console.log('  📦 Gerando package-lock.json...');
    try {
      execSync('npm install --package-lock-only', { stdio: 'pipe' });
      console.log('  ✅ package-lock.json gerado.\n');
    } catch(e) {
      console.log('  ⚠️  Não foi possível gerar package-lock.json — continuando sem ele.\n');
    }
  }

  // Check git identity — required for commit
  const gitEmail = runSilent('git config --global user.email');
  const gitName  = runSilent('git config --global user.name');
  if (!gitEmail || !gitName) {
    console.error('\n❌ Identidade git não configurada.');
    console.error('   Execute estes dois comandos e tente novamente:\n');
    console.error('   git config --global user.email "seu@email.com"');
    console.error('   git config --global user.name "Seu Nome"\n');
    process.exit(1);
  }

  // Safety: never commit .env or secret files
  const dangerFiles = ['.env', '.env.local', '.env.production'];
  dangerFiles.forEach(f => {
    const fp = path.join(__dirname, f);
    if (fs.existsSync(fp)) {
      // Make sure it's in .gitignore before staging
      const gi = path.join(__dirname, '.gitignore');
      const giContent = fs.existsSync(gi) ? fs.readFileSync(gi,'utf8') : '';
      if (!giContent.includes(f) && !giContent.includes('.env')) {
        fs.appendFileSync(gi, '\n.env\n.env.*\n');
        console.log(`  ✅ ${f} adicionado ao .gitignore`);
      }
    }
  });

  // Stage and commit
  run('git add -A');
  // Verify .env is NOT staged
  const staged = runSilent('git diff --cached --name-only') || '';
  if (staged.includes('.env')) {
    run('git reset HEAD .env');
    console.log('  ⚠️  .env removido do staging (não será commitado)\n');
  }
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
  // Pull remote changes first (in case remote has commits we don't have locally)
  try {
    runSilent('git pull origin main --rebase --allow-unrelated-histories');
    console.log('  ✅ Sincronizado com remote.\n');
  } catch(e) {
    console.log('  (pull ignorado — repositório novo ou sem histórico remoto)\n');
  }
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
