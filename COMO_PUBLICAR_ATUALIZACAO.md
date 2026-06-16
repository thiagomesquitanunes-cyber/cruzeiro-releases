# Como publicar uma atualização do Cruzeiro

## Configuração inicial (só na primeira vez)

### 1. Instalar dependências
Abra o Prompt de Comando na pasta do projeto e rode:
```
npm install
```
Isso instala o `electron-updater` e demais dependências.

### 2. Verificar o arquivo .env
Confirme que existe um arquivo `.env` na pasta do projeto com:
```
GH_TOKEN=ghp_seu_token_aqui
```
**Nunca compartilhe esse arquivo. Nunca suba para o GitHub.**

---

## Publicando uma nova versão

### 1. Atualize a versão no package.json
Mude `"version": "1.2.0"` para a nova versão (ex: `"1.3.0"`).

Use versionamento semântico:
- Bug fix pequeno → aumenta o 3º número (1.2.1)
- Nova funcionalidade → aumenta o 2º número (1.3.0)  
- Mudança grande → aumenta o 1º número (2.0.0)

### 2. Publique
```
npm run publish
```

Isso irá:
- Gerar o instalador `Cruzeiro-Setup-1.3.0.exe`
- Criar automaticamente um Release no GitHub
- Fazer upload do instalador
- Criar o arquivo `latest.yml` que os apps instalados usam para verificar atualizações

### 3. Pronto!
Os usuários que já têm o app instalado receberão uma barra azul na próxima abertura:
> "Nova versão 1.3.0 disponível — baixando em background..."
> 
> [↻ Reiniciar e instalar]

---

## Como funciona para os usuários

**Primeira instalação:**
1. Você manda o arquivo `Cruzeiro-Setup-X.X.X.exe`
2. Eles clicam, passam pelo instalador (pode aparecer aviso do Windows — clicar "Mais informações" → "Executar assim mesmo")
3. App instala com atalho no Desktop
4. Dados ficam em `C:\Users\[nome]\AppData\Roaming\Cruzeiro`

**Atualizações:**
1. App abre normalmente
2. Em background verifica GitHub
3. Se há versão nova: baixa silenciosamente
4. Quando pronto: aparece barra azul embaixo com botão "Reiniciar e instalar"
5. Usuário clica → app reinicia já atualizado

---

## Estrutura do repositório GitHub após publicar
```
cruzeiro-releases/
├── latest.json          (mantido para backward compat)
└── releases/
    ├── v1.2.0/
    │   ├── Cruzeiro-Setup-1.2.0.exe
    │   └── latest.yml
    └── v1.3.0/
        ├── Cruzeiro-Setup-1.3.0.exe
        └── latest.yml
```
