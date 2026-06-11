/**
 * Cruzeiro build script
 * Gera o executável sem precisar de privilégios de administrador.
 * Baixa o rcedit automaticamente se não estiver em cache.
 */

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const https = require('https');

const OUT = 'C:\\Cruzeiro-dist';

const cacheDir = path.join(
  process.env.LOCALAPPDATA,
  'electron-builder', 'Cache', 'winCodeSign', 'winCodeSign-2.6.0'
);
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

const rceditPath = path.join(cacheDir, 'rcedit-x64.exe');

async function downloadRcedit() {
  if (fs.existsSync(rceditPath)) return true;
  console.log('⬇ Baixando rcedit (necessário para aplicar ícone)...');
  const url = 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe';
  return new Promise((resolve) => {
    const file = fs.createWriteStream(rceditPath);
    const req = https.get(url, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        // Follow redirect
        https.get(res.headers.location, res2 => {
          res2.pipe(file);
          file.on('finish', () => { file.close(); resolve(true); });
        }).on('error', () => resolve(false));
      } else {
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(true); });
      }
    }).on('error', () => {
      fs.unlink(rceditPath, () => {});
      resolve(false);
    });
    req.setTimeout(15000, () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  const hasRcedit = await downloadRcedit();
  if (hasRcedit) console.log('✓ rcedit disponível — ícone será aplicado');
  else console.log('ℹ rcedit não disponível — ícone padrão do Electron será usado');

  console.log('🔨 Iniciando build...\n');

  const env = {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  };

  const result = spawnSync(
    'node_modules\\.bin\\electron-builder',
    [
      '--win', '--x64',
      '--publish=never',
      `--config.directories.output=${OUT}`,
    ],
    { stdio: 'inherit', env, shell: true }
  );

  const version = require('./package.json').version;
  const setupPath  = path.join(OUT, `Cruzeiro-Setup-${version}.exe`);
  const exePath    = path.join(OUT, 'win-unpacked', 'Cruzeiro.exe');
  const portablePath = path.join(OUT, 'Cruzeiro.exe');

  if (result.status !== 0) {
    console.error('\n❌ Build falhou (código de saída:', result.status + ')');
    if (result.error) console.error('Erro:', result.error.message);
    process.exit(1);
  }

  if (fs.existsSync(setupPath)) {
    console.log('\n✅ Build concluído! Instalador em:', setupPath);
  } else if (fs.existsSync(portablePath)) {
    console.log('\n✅ Build concluído! Executável em:', portablePath);
  } else if (fs.existsSync(exePath)) {
    console.log('\n✅ Build concluído! Executável em:', exePath);
  } else {
    // List what was actually generated
    const outFiles = fs.existsSync(OUT) ? fs.readdirSync(OUT) : [];
    console.log('\nArquivos gerados em', OUT + ':', outFiles);
    const winUnpacked = path.join(OUT, 'win-unpacked');
    if (fs.existsSync(winUnpacked)) {
      console.log('win-unpacked:', fs.readdirSync(winUnpacked));
    }
    console.error('\n❌ Build falhou — executável não encontrado no caminho esperado.');
    process.exit(1);
  }
  console.log(`\nArquivos em: ${OUT}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
