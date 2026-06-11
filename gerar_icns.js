/**
 * gerar_icns.js — Gera o arquivo assets/icon.icns a partir de assets/icon.png
 *
 * Uso: node gerar_icns.js
 *
 * Requer: npm install --save-dev png2icons  (instale uma vez)
 *
 * Se não quiser instalar, use o site https://cloudconvert.com/png-to-icns
 * e salve o resultado como assets/icon.icns
 */

const fs   = require('fs');
const path = require('path');

const pngPath  = path.join(__dirname, 'assets', 'icon.png');
const icnsPath = path.join(__dirname, 'assets', 'icon.icns');

if (!fs.existsSync(pngPath)) {
  console.error('❌ assets/icon.png não encontrado.');
  console.error('   Converta seu assets/icon.ico para PNG primeiro e salve como assets/icon.png');
  process.exit(1);
}

try {
  const png2icons = require('png2icons');
  const input = fs.readFileSync(pngPath);
  const icns  = png2icons.createICNS(input, png2icons.BILINEAR, 0);
  if (!icns) throw new Error('Conversão retornou vazio');
  fs.writeFileSync(icnsPath, icns);
  console.log(`✅ assets/icon.icns gerado com sucesso! (${icns.length} bytes)`);
} catch(e) {
  if (e.code === 'MODULE_NOT_FOUND') {
    console.log('📦 Instalando png2icons...');
    require('child_process').execSync('npm install --save-dev png2icons', { stdio: 'inherit' });
    console.log('\nPronto! Rode novamente: node gerar_icns.js');
  } else {
    console.error('❌ Erro:', e.message);
    console.error('   Alternativa: use https://cloudconvert.com/png-to-icns');
  }
}
