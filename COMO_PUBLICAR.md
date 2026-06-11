# Como publicar uma nova versão do Cruzeiro

## Setup inicial (fazer uma vez)

### 1. Configurar o repositório git local
```bash
cd "C:\Users\W11\Dropbox\App de Controle de Gastos\Cruzeiro"
git init
git remote add origin https://github.com/thiagomesquitanunes-cyber/cruzeiro-releases.git
git add -A
git commit -m "Commit inicial"
git push -u origin main
```

### 2. Criar o GH_TOKEN no GitHub
1. Acesse https://github.com/settings/tokens
2. Clique em "Generate new token (classic)"
3. Nome: `CRUZEIRO_BUILD`
4. Marque: `repo` (acesso completo)
5. Clique "Generate token" e **copie o valor**

### 3. Adicionar o token como secret no repositório
1. Acesse https://github.com/thiagomesquitanunes-cyber/cruzeiro-releases/settings/secrets/actions
2. Clique "New repository secret"
3. Nome: `GH_TOKEN`
4. Valor: cole o token copiado acima

### 4. Gerar o ícone macOS (uma vez)
```bash
# Opção A: script automático
node gerar_icns.js

# Opção B: converter manualmente
# 1. Converta assets/icon.ico para PNG (use https://convertio.co/ico-png/)
# 2. Salve como assets/icon.png
# 3. Acesse https://cloudconvert.com/png-to-icns
# 4. Salve como assets/icon.icns
```

---

## Publicar uma nova versão

### 1. Limpar dados de teste (antes do build)
```bash
npm run clean-data
```

### 2. Atualizar a versão no package.json
Edite a linha `"version"` no `package.json`.

### 3. Publicar (cria a tag e dispara o build automático)
```bash
npm run publish
```

O GitHub Actions vai buildar automaticamente:
- `Cruzeiro-Setup-X.X.X.exe` (Windows)
- `Cruzeiro-X.X.X-x64.dmg` (macOS Intel)
- `Cruzeiro-X.X.X-arm64.dmg` (macOS Apple Silicon)

Acompanhe em: https://github.com/thiagomesquitanunes-cyber/cruzeiro-releases/actions

---

## Notas sobre macOS

- **Sem assinatura**: usuários Mac precisam clicar com botão direito → Abrir na primeira vez
  (mensagem "aplicativo de desenvolvedor não identificado")
- Para eliminar esse aviso, seria necessário uma conta Apple Developer (US$99/ano) —
  deixamos para quando a distribuição Mac for maior
- Compatível com Intel (x64) e Apple Silicon (arm64/M1/M2/M3)
