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

  // ── Limpeza automática de dados pessoais e arquivos sensíveis ──────────
  // Garante que nenhum dado do usuário (banco, configurações, chaves de API)
  // seja publicado, mesmo que o .gitignore tenha sido editado por engano
  // ou que esses arquivos já estivessem rastreados de uma versão anterior.
  console.log('  🧹 Verificando dados sensíveis...');
  const SENSITIVE_FILES = [
    '_settings.json', '_bank_parsers.json', '_broker_mappings.json',
    'cruzeiro_data.db', 'cruzeiro_data_emergency.db.bak',
    'cruzeiro_data_financing_indexes.json', 'cruzeiro_data_import_defaults.json',
    'cruzeiro_data_ml_export.json', 'cruzeiro_data_benchmarks.json',
    'cruzeiro_data_ipca.json', 'cruzeiro_data_pat_ipca_monthly.json',
    'cruzeiro_data_overview_config.json', 'cruzeiro_data_report_config.json',
    'cruzeiro_data_saved_reports.json', 'cruzeiro_data_cat_types.json',
    'cruzeiro_data_col_config.json', 'cruzeiro_data_categories.json',
    'latest.json', '_recovery.enc', '_categories.json',
  ];
  const trackedFiles = (runSilent('git ls-files') || '').split('\n').filter(Boolean);
  let untracked = 0;
  SENSITIVE_FILES.forEach(f => {
    if (trackedFiles.includes(f)) {
      runSilent(`git rm --cached "${f}"`);
      console.log(`  ⚠️  ${f} estava versionado — removido do índice do Git (arquivo mantido no disco)`);
      untracked++;
    }
  });
  // Pega também variações tipo "cruzeiro_data_*.json" e cópias de conflito do Dropbox
  trackedFiles.forEach(f => {
    const base = path.basename(f);
    if (/^cruzeiro_data_.*\.json$/i.test(base) || / \(Cópia em conflito/i.test(base)) {
      if (!SENSITIVE_FILES.includes(base)) {
        runSilent(`git rm --cached "${f}"`);
        console.log(`  ⚠️  ${f} estava versionado — removido do índice do Git (arquivo mantido no disco)`);
        untracked++;
      }
    }
  });
  if (untracked > 0) {
    console.log(`  ✅ ${untracked} arquivo(s) sensível(is) destravado(s) do Git.\n`);
    console.log('  ⚠️  IMPORTANTE: se algum desses arquivos já tinha sido publicado antes,');
    console.log('     ele continua exposto no HISTÓRICO do repositório. Revise com seu');
    console.log('     assistente se é necessário reescrever o histórico (git filter-repo)');
    console.log('     ou revogar chaves/senhas que possam ter sido expostas.\n');
  } else {
    console.log('  ✅ Nenhum dado sensível rastreado.\n');
  }

  // ── Varredura simples por padrões de chave de API antes de commitar ────
  // Não substitui boas práticas, mas pega o caso comum de uma chave colada
  // em algum arquivo de configuração por engano.
  const SECRET_PATTERNS = [
    { name: 'OpenRouter API Key', re: /sk-or-[a-zA-Z0-9-]{16,}/ },
    { name: 'OpenAI API Key',      re: /sk-[a-zA-Z0-9]{32,}/ },
    { name: 'Anthropic API Key',   re: /sk-ant-[a-zA-Z0-9-]{16,}/ },
    { name: 'Google API Key',      re: /AIza[0-9A-Za-z\-_]{20,}/ },
    {
      name: 'Supabase Service-Role JWT',
      re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
      // JWTs do Supabase com role "anon" (ou "authenticated") são as chaves
      // PÚBLICAS, feitas para ir no app cliente — a segurança real vem das
      // políticas de RLS no servidor, não de manter essa chave em segredo.
      // Só "service_role" é um segredo de verdade (acesso total ao banco,
      // ignora RLS). Decodifica o payload do JWT e só alarma nesse caso —
      // sem isso, a própria anon key legítima do app trava a publicação.
      isDangerous(match) {
        try {
          const payloadB64 = match.split('.')[1];
          const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/')
            + '='.repeat((4 - payloadB64.length % 4) % 4);
          const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
          return !!payload.role && payload.role !== 'anon' && payload.role !== 'authenticated';
        } catch (e) {
          return true; // não conseguiu decodificar — assume o pior, por segurança
        }
      },
    },
  ];
  const stagedNow = (runSilent('git diff --cached --name-only') || '').split('\n').filter(Boolean);
  const filesAboutToStage = (runSilent('git status --porcelain') || '')
    .split('\n').filter(Boolean)
    .map(l => l.slice(3).trim())
    .filter(f => fs.existsSync(path.join(__dirname, f)) && fs.statSync(path.join(__dirname, f)).isFile())
    // Ignora arquivos que o próprio Git já decidiu não rastrear (.gitignore) —
    // eles podem aparecer no "git status" como untracked mesmo assim, mas
    // "git add -A" nunca vai pegá-los, então escanear é apenas ruído/falso positivo.
    .filter(f => {
      const res = runSilent(`git check-ignore -q "${f}"`);
      // check-ignore retorna null (sem stdout) tanto em "não ignorado" quanto em erro;
      // usamos o exit code real via execSync para diferenciar com segurança.
      try {
        execSync(`git check-ignore -q "${f}"`, { stdio: 'ignore' });
        return false; // exit code 0 = está no .gitignore → ignora do scan
      } catch(e) {
        return true; // exit code != 0 = não está no .gitignore → escaneia
      }
    });
  let foundSecret = false;
  filesAboutToStage.forEach(f => {
    if (/\.(png|jpg|jpeg|ico|icns|svg|pdf|db|exe|dmg)$/i.test(f)) return; // arquivos binários, pula
    let content = '';
    try { content = fs.readFileSync(path.join(__dirname, f), 'utf8'); } catch(e) { return; }
    SECRET_PATTERNS.forEach(p => {
      const m = content.match(p.re);
      if (m && (!p.isDangerous || p.isDangerous(m[0]))) {
        console.error(`  🚨 Possível ${p.name} encontrada em "${f}" — publicação ABORTADA.`);
        foundSecret = true;
      }
    });
  });
  if (foundSecret) {
    console.error('\n❌ Publicação cancelada para sua segurança. Remova a chave do arquivo,');
    console.error('   confirme que ele está no .gitignore, e rode "npm run publish" de novo.\n');
    process.exit(1);
  }

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
