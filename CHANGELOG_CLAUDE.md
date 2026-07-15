# Changelog — sessões Claude Code

Registro detalhado de mudanças feitas por sessões do Claude Code neste
projeto (Cruzeiro Desktop). Entradas mais recentes primeiro. Cada entrada
deve conter: o que mudou, por quê, e os arquivos/funções principais
tocadas — o suficiente pra uma sessão nova entender o estado atual sem
precisar reconstituir o histórico da conversa original.

**Regra pra quem edita este arquivo**: ao concluir qualquer tarefa (ou
publicar uma versão), adicione uma entrada nova no TOPO deste changelog,
antes de considerar o trabalho terminado.

---

## 2026-07-15 (continuação 6) — v4.77.0: bug crítico de saldo (pernas de transferência apagadas), MA12 mobile, UX da tabela de transações e orçamento

### Bug crítico introduzido pela própria v4.76.2: pernas de transferência recorrente sendo apagadas
A migração de deduplicação de recorrências (adicionada na v4.76.2) agrupava
duplicatas só por `(recurring_id, date)` — mas uma recorrência de
TRANSFERÊNCIA sempre tem 2 linhas legítimas por data (uma em cada conta,
mesmo `recurring_id`). A migração tratava esse par como duplicata e
apagava uma das pernas a cada boot, quebrando a transferência (saldo de
uma das contas ficava errado). Um segundo bug relacionado, em
`migrateRecurring()` (mais antigo, pré-existente), tinha exatamente o
mesmo problema e desfazia até a tentativa de reparo. Corrigido:
- `ensureLateColumns()`: dedup agora agrupa por
  `(recurring_id, date, account_id)` — só remove duplicata de verdade
  (mesma conta), nunca as 2 pernas legítimas de uma transferência.
- `migrateRecurring()`: mesmo fix (`GROUP BY recurring_id, date, account_id`).
- Nova migração de reparo: detecta pernas de transferência órfãs
  (`transfer_id` sem par) causadas pela versão anterior e recria a perna
  que falta a partir da definição da recorrência (`account_id`/
  `transfer_to_account_id`), só em pernas ainda não conferidas.
- Testado ao vivo contra o banco real: achadas 3 pernas órfãs (valores
  de R$2.900 e R$14 duas vezes), reparadas, e confirmada estabilidade
  total em boots subsequentes (0 duplicatas falsas, 0 órfãs).

### Categoria "categoria" fantasma — causa raiz real
A correção anterior (tombstone em `_categories_excluded.json`) resolvia
a categoria reaparecer na aba Categorias, mas não impedia o
AUTO-PREENCHIMENTO por ML sugerir "categoria" de novo em lançamentos
NOVOS — a causa era uma regra órfã em `ml_rules` (aprendida antes do
fix, ex: para o memo "Ajuste de saldo inicial") que nunca foi limpa.
Corrigido: `categories:exclude` agora zera a categoria de qualquer regra
de ML que aponte pra um nome excluído, e uma migração retroativa faz o
mesmo para exclusões já registradas antes desse fix (achada e limpa 1
regra órfã no banco real: memo "ajuste de saldo inicial" → categoria
"Categoria").

### Mobile: MA12 lucro da meta de aposentadoria pegando mês errado
Causa raiz: a query de `pushEvolution` (sync-push.js) não tinha limite
superior de data — recorrências materializam lançamentos até ~2 anos à
frente (ex: mesada com fim em 2028), e esses meses futuros entravam no
cálculo. Como o mobile (`metas.js`) escolhe "o mês atual" pegando a
linha de maior `month` já sincronizada, ele acabava pegando um mês
muito no futuro (poucos lançamentos projetados, longe da realidade) em
vez do mês corrente — dando uma MA12 bem menor que a real (usuário
reportou R$24.590,16 no mobile vs R$49.850,94 no desktop). Corrigido
com `AND date <= date('now')` na query de `pushEvolution` (mesmo
padrão já usado em `pushTransactions`). Validado numericamente contra o
banco real: sem o filtro, o "mês mais recente" era 2028-06 (MA12 de
R$766); com o filtro, passa a ser o mês corrente com o valor correto.

### Tabela de transações: seleção, duplo-clique e Esc
Três bugs com a MESMA causa raiz: a barra de multi-seleção (`#multi-bar`)
usava `position:sticky`, que ainda ocupa espaço no fluxo normal do
documento — ao aparecer (0→1 selecionado), ela EMPURRAVA toda a tabela
pra baixo. Resultado: a linha clicada saía debaixo do cursor (parecia
que a seleção "não tinha efeito visual", mesmo a cor mudando — só que
numa posição diferente da que o usuário olhava) e o 2º clique de um
duplo-clique caía numa linha diferente da 1ª (o alvo se moveu entre os
2 cliques), fazendo o duplo-clique nunca completar na 1ª tentativa.
Corrigido trocando `position:sticky` por `position:fixed` (overlay que
flutua por cima do conteúdo em vez de deslocá-lo). Testado ao vivo via
CDP: duplo-clique real agora abre o modal de edição corretamente na 1ª
tentativa, com deslocamento residual de ~4px (antes: ~40-50px).
Adicionado também: tecla Esc agora cancela a seleção de transações
(handler novo, respeita modais abertos por cima).

### Orçamento — gráficos: separador receita/despesa + ordenação
Na visualização "Gráficos" da aba Orçamento (modo "Mês único"):
adicionado separador visual "📉 Despesas" entre os cards de receita
(sempre no topo) e despesa (sempre embaixo) — antes ficavam misturados
na ordem que vinham do banco. Adicionada ordenação configurável (botões
"%"/"R$"/"A-Z", clique de novo inverte direção), mesma lógica já usada
no mobile: padrão decrescente por % já transcorrido do planejado.
`BUDGET_CHART_SORT_KEYS`, `budgetChartToggleSort()`, ambos os grupos
(receita/despesa) ordenados independentemente pelo mesmo critério.

### Nova transação: data padrão passa a lembrar a última usada por conta
Antes, o campo de data de um lançamento novo sempre sugeria "hoje".
Agora: a primeira transação de uma conta ainda sugere hoje, mas depois
que o usuário muda a data uma vez, as próximas transações NOVAS nessa
mesma conta passam a sugerir essa última data usada — até o usuário
mudar de novo. Estado em memória (`_lastTxDateByAccount`, por
`account_id`), não persiste entre reinícios do app de propósito (é uma
conveniência de sessão, não uma preferência permanente).

### Publicação
Versão 4.76.2 → 4.77.0 (minor — inclui funcionalidade nova visível,
não só correção de bug). Arquivos: `src/main.js`, `src/renderer.js`,
`src/index.html`, `src/sync/sync-push.js`.

---

## 2026-07-15 (continuação 5) — v4.76.2: transações recorrentes duplicando + categoria fantasma "categoria" + retentativa de assinatura macOS

### Transações recorrentes duplicando sozinhas
`syncRecurringTxns` (main.js) apaga as transações futuras não conferidas
(`cleared=0`) de uma recorrência e regenera a partir de
`generateFutureDates()`, que recalcula as datas a partir de uma âncora
que nunca avança. Isso por si só não duplicava nada — o problema
aparecia quando já existia uma transação NÃO-futura pra aquela mesma
data (ex: o usuário importou um extrato bancário e a importação criou
uma linha pra aquela recorrência, ou uma linha já tinha sido conferida
antes de virar "passada"): o regen recriava a data sem checar se já
havia uma transação daquela recorrência naquele dia, gerando duplicata
— inclusive quando o usuário resolvia um conflito de importação
("pular" ou "substituir"), porque a duplicata surgia depois, no próximo
boot/sync, não na hora do import. Corrigido com um `existingDates` (via
`SELECT DISTINCT date FROM transactions WHERE recurring_id=?`) checado
antes de cada insert do loop de geração, ao lado do `excludedDates` que
já existia.

Além do fix preventivo, adicionada uma migração retroativa em
`ensureLateColumns()` que limpa duplicatas já existentes: agrupa por
`(recurring_id, date)`, ignora grupos onde TODAS as linhas já estão
conferidas (arriscado demais adivinhar qual manter — fica só um aviso
no log pedindo revisão manual), e nos demais grupos mantém a linha de
maior prioridade (`ORDER BY cleared DESC, id ASC`) apagando o resto,
nunca apagando uma linha conferida. Testado ao vivo contra o banco real
de dev: 42 duplicatas encontradas, 36 removidas automaticamente, 6
grupos (100% conferidos) deixados pra revisão manual — validado que a
migração é idempotente (rodar de novo não remove nada a mais) e que o
fix preventivo realmente impede novas duplicatas depois de um ciclo
completo de boot/sync.

### Categoria apagada virando "categoria" fantasma sozinha
Ao apagar a categoria de um lançamento deliberadamente (deixando em
branco), ela reaparecia sozinha depois. Causa: `deleteCategory()` nunca
tocava `transactions.category` — só removia a categoria da lista
gerenciada. A rotina de reconciliação em `ensureLateColumns()`
(a mesma que re-registra categorias "orgânicas" achadas nas transações,
adicionada pro bug #10 desta mesma sessão) via o texto residual em
transações antigas e recriava a categoria como se fosse nova, na
próxima inicialização. Corrigido com um mecanismo de "tombstone":
`deleteCategory()` agora coleta os nomes removidos e chama o novo IPC
`categories:exclude`, que grava num arquivo `_categories_excluded.json`
(dedup case-insensitive). A reconciliação de `ensureLateColumns()` passa
a excluir tanto nomes de conta quanto nomes na lista de exclusão antes
de auto-registrar qualquer categoria "órfã" encontrada nas transações.
Novo helper `getExcludedCatsPath()`. Bridges no preload:
`categoriesExclude`.

### Segunda tentativa de corrigir o travamento do build macOS
O build travou de novo no mesmo passo (~13min, cancelado pelo usuário)
mesmo depois do fix anterior (keychain sem prompt de GUI). Diagnóstico
revisado: o `.p12` usado no signing foi gerado localmente via OpenSSL a
partir de um `.cer` baixado direto do portal da Apple — diferente de um
`.p12` exportado pelo Keychain Access num Mac, esse não carrega o
certificado intermediário da cadeia de confiança ("Developer ID
Certification Authority" G2). Sem essa peça na keychain, o `codesign`
tenta buscar o intermediário NA REDE (AIA fetch) toda vez que assina —
e esse tipo de busca de rede é conhecido por travar/demorar demais em
runners headless de CI. Corrigido baixando e importando
`DeveloperIDG2CA.cer` (URL oficial da Apple) na keychain ANTES de
importar o certificado final. Também adicionado `timeout-minutes: 25`
no job `build-macos` como rede de segurança independente da causa raiz
(se travar de novo por qualquer motivo, falha rápido em vez de rodar
até o limite de 6h do GitHub Actions). Ainda não testado pelo usuário
neste momento — próximo passo é o usuário disparar um novo build (tag
de versão) e reportar o resultado.

### Publicação
Versão 4.76.1 → 4.76.2 (patch — só correções de bug, sem funcionalidade
nova visível). Arquivos tocados: `src/main.js`, `src/renderer.js`
(coleta de nomes removidos em `deleteCategory`), `src/preload.js`
(bridge `categoriesExclude`), `.github/workflows/build.yml`.

---

## 2026-07-15 (continuação 4) — Lote de bugs pós-fix de sincronização + Moedinha/banner

### Regressão própria: lançamentos futuros vazando pro extrato mobile
`pushTransactions` (sync-push.js) nunca teve limite superior de data —
`WHERE t.date >= ?` sem `AND t.date <= hoje`. Lançamentos futuros reais
(recorrências materializadas, juros de mútuo projetados) apareciam na
aba "lançamentos" do mobile em vez de só em "lançamentos futuros".
Corrigido com `AND t.date <= ?` (hoje).

### MA12 do lucro divergindo entre desktop e mobile
Causa raiz: o desktop (`computeEvMA12LucroData`) calcula o LUCRO líquido
mês a mês primeiro (receita−despesa) e só então tira a média móvel de
12 meses — não a diferença de duas médias calculadas separadamente. Meu
`pushEvolution` fazia `income_ma - expenses_ma` com cada uma usando seu
próprio filtro de "descartar mês com valor zero" (a mesma função
`movAvg12` do desktop, mas aplicada separadamente a cada série) — os dois
filtros podem descartar meses DIFERENTES, quebrando a equivalência
matemática. Corrigido: calcula a MA do lucro líquido primeiro (idêntica
ao desktop) e deriva `income_ma`/`expenses_ma` usando a MESMA máscara de
meses dessa MA, garantindo que a subtração sempre bata com o valor do
desktop. Validado numericamente contra os dados reais (diferença ~0,
antes era uma divergência de dezenas de milhares de reais). A diferença
residual esperada agora é só a correção de IPCA (desktop corrige, mobile
mostra nominal por decisão desta sessão).

### Mudança de categoria do mútuo não propagava pros lançamentos futuros
`syncMutuoToBank` (main.js) já verificava `cleared!==1` antes de
atualizar uma transação futura existente, mas o UPDATE só tocava
`amount`/`date` — nunca `category`. Trocar a "categoria dos juros
recebidos" no formulário do mútuo não refletia nos lançamentos já
criados. Corrigido: UPDATE agora inclui `category`, e a condição de
"precisa atualizar" também considera categoria divergente. Lançamentos
já conferidos continuam intocados, como já era.

### Aba Categorias mostrando contas bancárias/cartões/investimentos
Achada via agente de investigação: bug no parser QIF genérico
(`parseQIFMultiAccount`, usado pelo importador universal). No formato
QIF, `L[Nome]` (com colchetes) é a convenção padrão pra marcar
transferência entre contas — o parser removia os colchetes
incondicionalmente e tratava o nome como categoria normal. Um QIF
multi-conta (ex: export do Quicken/GnuCash) grava cada transferência
duas vezes, uma em cada conta, cada perna com o nome da conta
CONTRAPARTE entre colchetes — por isso apareciam pares como
Itaú↔"Cartão BTG"/Cartão BTG↔"Itaú" (pagamento de fatura) e
Itaú↔"XP"/XP↔"Itaú" (resgate de investimento) na aba Categorias.
- Parser: colchetes agora viram `transferAccount` em vez de `category`.
- `financial:import`: nova lógica de pareamento — casa as duas pernas
  (mesma data, valor oposto, conta bate com o nome marcado) e cria um
  `transfer_id` compartilhado, igual a uma transferência manual. Perna
  sem par encontrado fica sem categoria (nunca mais com nome de conta),
  com a conta mencionada no memo pra facilitar reconciliação manual.
  Mesma correção defensiva em `qif:import` (parece não ser mais chamado
  pela UI atual, mas por segurança).
- Reconciliação de categorias "fantasma" (`ensureLateColumns`): agora
  exclui nomes que batem com conta cadastrada, e faz uma limpeza única
  do `_categories.json` já persistido, removendo entradas contaminadas
  por imports anteriores a este fix. Não mexe nos dados históricos das
  transações em si — só some da lista gerenciada.

### Pasta de backup separada da pasta de dados
Novo card em Configurações (`⚙️ → 📦 Pasta de backup`) — `backupDir`
independente de `dataDir` em settings. `getBackupDir()` prioriza
`backupDir` quando definido. Handlers `settings:set-backup-dir`/
`settings:clear-backup-dir` (mesmo padrão de `set-data-dir`).

### Aposentadoria — juros reais (4%) não considerado sem interação
`apos2-rate-real` mostrava "4.0" só como placeholder (nunca é o `.value`
real de um input) — cálculo lia string vazia (rate=0) até o usuário
digitar algo, mesmo já vendo "4.0" na tela. Visão 1 (Rumo à
Aposentadoria) já tinha essa proteção; Pós-Aposentadoria não.
`apos2Init()` agora preenche de verdade com '4.0' quando não há valor
salvo, igual ao texto exibido.

### Moedinha aprende Pós-Aposentadoria + banner de boas-vindas
Ver entradas de changelog anteriores (mesmo dia) para detalhes — batch
de conteúdo educativo + novo modal de primeira abertura.

### Mobile (Android + iOS): ordenação de categorias no Orçamento
`app/(tabs)/orcamento.js`: padrão passa a ser % já transcorrido do
planejado, decrescente. Chips "%"/"R$"/"A-Z" pra trocar critério — tocar
de novo no já ativo inverte a direção (↓/↑).

**Arquivos tocados**: `src/sync/sync-push.js` (pushTransactions,
pushEvolution), `src/main.js` (syncMutuoToBank, parseQIFMultiAccount,
financial:import, qif:import, ensureLateColumns, getBackupDir + 2 novos
handlers), `src/renderer.js` (apos2Init, pickBackupDir/clearBackupDir,
refreshBackup, GUIDE_PAGES/GUIDE_TIPS.aposentadoria — este último já
documentado antes), `src/index.html` (card de pasta de backup),
`src/preload.js` (2 novos bridges). Mobile: `app/(tabs)/orcamento.js`
(Android + iOS, idêntico).

**Validado ao vivo** via CDP: card de backup renderiza corretamente,
campo de juros reais confirmado com `.value` real ("4", não vazio),
aba Categorias sem nenhum nome de conta (verificado contra os dados
reais do dev, que tinham a contaminação reproduzida). MA12 validado
numericamente (diferença ~0 entre metodologia nova e a do desktop).

---

## 2026-07-15 (continuação 3) — Preparação da assinatura de código macOS

Usuário obteve conta paga de desenvolvedor Apple. Preparado (mas ainda
NÃO ativo — falta o usuário cadastrar os secrets) o pipeline de
assinatura + notarização do build macOS:

- Gerado localmente (via openssl, já que a máquina é Windows): chave
  privada + CSR → usuário fez upload no portal da Apple → baixou o
  certificado "Developer ID Application: Thiago Mesquita Nunes
  (5LRFP45LW2)" → convertido pra `.p12` (senha aleatória) → base64.
  Entregue ao usuário em `C:\Users\tmnunes\Desktop\CruzeiroSigningSetup\`
  (CSC_LINK.txt, CSC_KEY_PASSWORD.txt, LEIA-ME.txt com instruções) —
  arquivos sensíveis, não versionados, o usuário deve apagar depois de
  cadastrar como secrets no GitHub e depois de baixados.
- `.github/workflows/build.yml`: job `build-macos` agora passa
  `CSC_LINK`/`CSC_KEY_PASSWORD` (assinatura) e
  `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` OU
  `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` (notarização,
  qualquer um dos dois métodos — electron-builder detecta o que estiver
  preenchido). Removido `CSC_IDENTITY_AUTO_DISCOVERY: false` (que
  desativava a assinatura explicitamente).
- `package.json` → `build.mac`: adicionado `hardenedRuntime: true`,
  `gatekeeperAssess: false` e `entitlements`/`entitlementsInherit`
  apontando pro novo `assets/entitlements.mac.plist` — exigências da
  Apple pra notarização funcionar.
- **Pendente do usuário**: cadastrar os secrets no GitHub (ver
  LEIA-ME.txt) e escolher entre os dois métodos de notarização (senha
  de app específica — mais fácil de achar — ou API Key do App Store
  Connect). Só depois disso um novo `npm run publish` vai gerar o build
  macOS já assinado/notarizado.

---

## 2026-07-15 (continuação 2) — Moedinha ensina Pós-Aposentadoria + banner de boas-vindas

### Moedinha: conteúdo sobre "Pós-Aposentadoria"
`GUIDE_PAGES.aposentadoria` (`src/renderer.js:13842`) e `GUIDE_TIPS.aposentadoria`
(`src/renderer.js:14326`) atualizados. A visão "📉 Pós-Aposentadoria" (drawdown,
implementada em sessão anterior) não tinha nenhum conteúdo educativo na
Moedinha ainda. Adicionadas 4 novas perguntas no cardápio de dicas: o que é
a visão, como funciona o botão 🧮 de campo calculável (só 1 de 3 por vez:
renda não financeira / idade limite / despesa mensal), como preencher o
"Patrimônio desejado na idade limite" (digitar ou selecionar ativos a
preservar), e o que faz "Escolher quais bens e direitos geram renda".
Termos usados batem exatamente com os rótulos da UI (conferido em
`src/index.html:1747-1808`).

### Banner de boas-vindas (primeira abertura)
Antes, a primeira abertura do app só disparava `guideFirstRun()` — um
balão de chat pequeno da Moedinha no canto, com uma mensagem fixa de
3 passos. Pedido do usuário: um banner maior, visual, usando as cores do
app e a imagem da Moedinha, cobrindo além dos passos básicos (criar conta,
criar categoria) também as 4 configurações iniciais recomendadas antes de
importar dados/lançar transações (pasta de dados em nuvem, senha de
acesso, chave de IA, login do app mobile).

- `src/index.html`: novo bloco `#welcome-banner` (modal centralizado,
  backdrop escurecido, SVG grande da Moedinha reaproveitado do
  `#guide-mascot`, cards numerados 1/2 e i-iv, link direto pra
  Configurações). CSS correspondente logo após o CSS existente da
  Moedinha.
- `src/renderer.js`: `checkFirstRun()` agora chama `showWelcomeBanner()`
  no lugar de `guideFirstRun()` na primeira execução (a Moedinha
  continua disponível minimizada no canto por trás do banner, via
  `guideInit()`, sem precisar do balão de apresentação — ficaria
  redundante). Novas funções `showWelcomeBanner()`/`closeWelcomeBanner()`.
  `guideFirstRun()` continua existindo no código (não removida), só não é
  mais chamada no boot — pode ser removida numa limpeza futura se
  confirmado que não há mais uso.
- Testado ao vivo via CDP (reset temporário de `tourDone` no
  `_settings.json` local, screenshot do banner completo, restaurado ao
  final) — renderiza corretamente, scroll interno funciona, todos os
  links de ação (criar conta, ver categorias, ir pra Configurações)
  presentes.

---

## 2026-07-15 (continuação) — Limpeza do histórico git + fim da remediação do vazamento

Sequência final da remediação do vazamento da service_role key (ver
entrada abaixo): usuário confirmou ter clicado em "Disable legacy API
keys" no Supabase — a chave vazada está definitivamente inválida agora,
independente de qualquer coisa no código ou histórico.

Como reforço de higiene (a chave já estava morta, mas continuava visível
em texto puro no histórico público do repo `cruzeiro-releases`, o que
geraria alertas de scanner pra sempre): usei `git-filter-repo`
(`pip install git-filter-repo`, `--replace-text` com a chave antiga →
placeholder) num clone temporário, cobrindo TODOS os commits e as 67 tags
do repositório. Diferente do reset de histórico anterior ("Reinicia
histórico sem dados sensíveis"), essa abordagem preserva a estrutura de
commits e todas as tags — só troca o conteúdo do blob que continha a
chave. Verificado antes do push que nenhum commit em `--all` continha
mais o trecho característico do JWT (`"role":"service_role"` em base64).
Force-push de `main` e de todas as 67 tags. Confirmado depois, via API do
GitHub, que os Releases e seus assets (instaladores .exe/.dmg que os apps
já instalados usam pro auto-update) continuam intactos — Releases
referenciam tags pelo NOME, e os assets binários ficam armazenados à
parte do git, então reescrever os commits por trás das tags não afeta
downloads/auto-update já publicados.

---

## 2026-07-15 — Migração da anon key legada para publishable key + remediação do vazamento

Depois de publicar o fix da service_role key (entrada abaixo), o usuário
recebeu um alerta do GitGuardian: a service_role key ainda estava exposta
no histórico git do repositório PÚBLICO `cruzeiro-releases` (eu só tinha
removido do código atual, nunca reescrevi histórico). Como o repo é
público, isso é uma exposição real e ativa, não só teórica — qualquer
scanner de segredo consegue achar.

Investigando a página de API Keys do Supabase, o projeto já tinha migrado
pro novo sistema de chaves (`publishable`/`secret`, substituindo
`anon`/`service_role` legadas), com uma `sb_publishable_...` e uma
`sb_secret_...` já geradas. Isso simplificou a remediação: em vez de
rotacionar o JWT secret legado (que invalidaria anon E service_role juntos,
exigindo uma dança de coordenação), bastou trocar a anon key legada pela
nova publishable key nos 4 lugares onde estava hardcoded — a secret key
(substituta do service_role) nem precisou ser usada, já que o desktop
parou de depender de service_role no fix anterior.

- `src/sync/supabase-client.js` (`SUPABASE_ANON`) e `src/main.js`
  (`SUPABASE_ANON_KEY`, usada pra chamar a edge function
  `validate-license`): trocadas de JWT legado pra
  `sb_publishable_rCikC0YRWCUwicYs0v7W8Q_k5sniHIl`.
- Mesma troca em `Cruzeiro Android/src/lib/supabase.js` e
  `Cruzeiro iOS/src/lib/supabase.js` (`createClient(SUPABASE_URL,
  SUPABASE_ANON, ...)`).
- **Validado ao vivo** antes de publicar: rodei o desktop localmente com a
  nova key — login (sessão restaurada), pull e push completos, tudo `ok`.
  A publishable key funciona como substituta direta da anon key legada,
  tanto no `_request()` manual do desktop (headers `apikey`/`Authorization:
  Bearer`) quanto no SDK oficial (`@supabase/supabase-js`) usado pelo
  mobile.
- Depois de publicar esta versão e fazer `eas update` em Android+iOS, o
  usuário precisa clicar em "Disable legacy API keys" no Supabase (Settings
  → API → aba "Legacy anon, service_role API keys") — isso invalida a
  service_role key vazada de vez, de forma definitiva. Só recomendar isso
  DEPOIS que os 3 apps já estiverem rodando com a publishable key, senão
  quebra o sync de quem ainda não atualizou.

---

## 2026-07-14 (continuação 2) — Lote grande de correções de sincronização mobile

Usuário reportou vários bugs comparando desktop x mobile (card de resumo com
receita/despesa/lucro completamente diferentes do desktop, categorias de
receita sumidas na Evolução, meta de aposentadoria vazando patrimônio sem
opt-in, edição no mobile não refletindo no desktop, receita não podia ser
lançada no mobile). Todos rastreados até `src/sync/sync-push.js` e
`src/sync/sync-pull.js`; corrigidos nesta sessão, um a um:

### 1. Card de resumo mobile com números errados (causa raiz do lote)
`pushEvolution()` classificava receita/despesa por SUBcategoria direto — o
desktop (via `groupAndClassifyByParent()`/`computeSummaryFromByCat()` no
`renderer.js`, usado de forma IDÊNTICA no Resumo, na Comparação mensal e na
Evolução) agrupa por categoria-MÃE primeiro (somando os valores brutos de
todas as subcategorias) e SÓ ENTÃO classifica pelo saldo líquido do grupo —
uma subcategoria positiva dentro de uma mãe negativa reduz a despesa da mãe,
em vez de virar receita separada. Sem esse agrupamento, cada subcategoria
virava um grupo próprio e inflava receita E despesa em vez de se cancelarem
dentro da mãe. Reescrito `pushEvolution()` pra agrupar por
`(mês, categoria-mãe)` antes de classificar — idêntico ao renderer.

### 2. Transferências sumidas do extrato mobile
`pushTransactions()` tinha `AND t.transfer_id IS NULL`, excluindo QUALQUER
transferência do `mobile_transactions` — a conta no mobile nunca mostrava
transferências reais. Removido o filtro (transferências agora sincronizam
normalmente) e adicionado campo `is_transfer` em cada linha, pra continuar
sendo excluído de cálculos de receita/despesa (isso já era feito à parte,
correto, em `pushEvolution`).

### 3. Lançamentos futuros só cobriam recorrências registradas
`pushScheduled()` lia só a tabela `recurring` (definições abstratas), sem
pegar lançamentos futuros digitados manualmente ou pernas de financiamento
projetadas. Reescrito pra ler `transactions WHERE date > hoje` (mesma fonte
do handler `report:future-pending` do próprio desktop — a recorrência já
materializa suas ocorrências ali), com `is_transfer` também.

### 4. Evolução: 12 meses, sem correção IPCA, MA sempre real
`pushEvolution()`: (a) corta a saída para os últimos 12 meses (calcula a
MA12 sobre o histórico completo ANTES de cortar, pra não ficar incompleta
no início da janela); (b) removida a correção de IPCA inteiramente — mobile
mostra valores nominais agora, mais simples e menos egress; (c)
`income_ma`/`expenses_ma` passam a ser SEMPRE a média móvel real,
independente do toggle `ev_ma` (que é só uma preferência de EXIBIÇÃO da aba
Evolução do desktop, não deveria condicionar o que o mobile recebe — isso
também corrigiu a meta de aposentadoria de curto prazo, que dependia desses
campos). Mobile (`app/(tabs)/evolucao.js`, Android+iOS): filtro
`.gte('month', ...)` pros últimos 12 meses e aviso de "valores nominais,
sem correção pela inflação" na tela.

### 5. Meta de aposentadoria vazando patrimônio sem opt-in
`pushPatrimonio()` só pulava o push quando `syncInvestments=false`, mas não
apagava dados JÁ sincronizados antes de o usuário desativar a opção —
ficavam parados no Supabase indefinidamente, vazando pra meta de longo
prazo no mobile. Agora, quando desativado, apaga ativamente
`mobile_patrimonio` do usuário (uma vez, via `hasChanged()` guardando o
estado `'sync_disabled'`).

### 6. `by_category` só guardava categorias de despesa
`catByMonth` só era populado quando `net<0` (despesa) — categorias de
receita (Salário, Juros recebidos etc.) nunca apareciam na aba Evolução >
Por categoria do mobile, e ficavam "zeradas". Corrigido junto com o item 1
(agora guarda qualquer categoria-mãe com movimento, magnitude sempre
positiva).

### 7. Edição de transação no mobile não aplicava no desktop
`mobile_edit_requests` nunca era lida por `sync-pull.js` (a tela já gravava
lá desde antes, sem efeito nenhum). Novo `pullEditRequests()`: lê pendentes,
decifra `new_memo`/`new_amount`, aplica `UPDATE transactions` por
`desktop_id`, marca `status='applied'`/`'rejected'`. Rejeita edição de
pernas de transferência (editar só um lado desalinharia o par). Testado ao
vivo nesta sessão — aplicou 2 edições reais pendentes no primeiro sync.

### 8. Receita não podia ser lançada no mobile
`pullQuickEntries()` forçava sinal negativo (despesa) sempre, mesmo com
`entry_type='income'` — receita virava despesa no desktop. Corrigido: sinal
positivo quando `entry_type==='income'`. Mobile (`nova-despesa.js`,
Android+iOS): removido o bloqueio "Em breve" no toggle Receita — agora
funcional. `lancar-ia.js` (Android+iOS): `entry_type` agora inferido do
sinal original do parse da IA (`preview.amount`), antes nunca era enviado.

**Arquivos tocados**: `src/sync/sync-push.js` (pushTransactions,
pushScheduled, pushPatrimonio, pushEvolution — reescrita grande),
`src/sync/sync-pull.js` (pullQuickEntries, novo pullEditRequests, wire em
pullAll). Mobile Android+iOS: `app/(tabs)/evolucao.js`, `app/nova-despesa.js`,
`app/lancar-ia.js` (mudanças idênticas nas duas plataformas).

**Validado ao vivo** nesta sessão: sync completo (pull+push, 9 passos)
rodou sem erros contra dados reais no Supabase, usando a sessão já
autenticada do usuário (sem service_role — ver entrada anterior). O
pushEvolution recalculado bateu 12 meses corretamente; pushPatrimonio
detectou `syncInvestments=false` e limpou dados remotos como esperado;
pullEditRequests aplicou 2 edições reais pendentes.

---

## 2026-07-14 (continuação) — Segurança: remoção da service_role key hardcoded

### Problema
`src/sync/supabase-client.js` tinha a chave `service_role` do Supabase
(acesso admin total, ignora RLS) hardcoded no código-fonte, usada em
TODAS as chamadas REST (`_rest()` sempre passava `useService: true`).
Como o Desktop é um app distribuído (instalador Electron), esse código é
extraível — qualquer pessoa com o instalador conseguiria essa chave e
ler/editar dados de QUALQUER usuário no Supabase, não só os próprios.

### Correção
- `src/sync/supabase-client.js`: removida a constante `SUPABASE_SERVICE`
  inteiramente. `_request()` não recebe mais `useService` — sempre usa
  `SUPABASE_ANON` como `apikey`, e `Authorization: Bearer <token>` usa o
  `access_token` da sessão do usuário logado (`_session.access_token`)
  quando disponível, caindo para a anon key sem token em `/auth/v1`
  (login/refresh, onde ainda não há sessão). `_rest()` agora injeta
  `token: _session?.access_token` automaticamente em toda chamada
  (`upsert`/`select`/`update`/`remove`/`pruneNotIn`/`removeOlderThan`).
- Isso só é seguro porque o isolamento entre usuários passa a depender de
  Row Level Security no Supabase — sem RLS, a chave anon sozinha também
  daria acesso total (bastaria omitir o filtro `user_id`). Criado
  `supabase/enable_rls.sql` (novo arquivo, idempotente): habilita RLS e
  cria uma política `auth.uid() = user_id` (FOR ALL, role `authenticated`)
  em `mobile_balances`, `mobile_transactions`, `mobile_budgets`,
  `mobile_goals`, `mobile_scheduled`, `mobile_patrimonio`,
  `mobile_evolution`, `ml_rules`, `user_ai_config`, `quick_entries`,
  `mobile_reconcile_updates`, `mobile_edit_requests` — todas as tabelas
  tocadas por `sync-push.js`/`sync-pull.js`. Esse script precisa ser
  rodado manualmente pelo usuário no SQL Editor do Supabase ANTES desta
  mudança de código ter efeito em produção (sem RLS ativo, o sync para de
  funcionar depois da troca, já que a anon key sem RLS nem sem
  service_role não teria permissão nenhuma nas tabelas).
- Desktop e mobile já autenticam como o MESMO usuário via Supabase Auth
  (mesmo email/senha), então a política `auth.uid() = user_id` funciona
  identicamente para as chamadas feitas pelo desktop e pelas já feitas
  pelo app mobile (que nunca usou service_role).
- Não foi necessário nenhum tratamento especial para exposição passada —
  por instrução explícita do usuário, o único requisito era garantir que
  a chave pare de ficar disponível daqui pra frente.

---

## 2026-07-14 — v4.72.0 → v4.72.1 → v4.73.0

### Aba Aposentadoria — nova visão "Pós-Aposentadoria" (drawdown)
Além da visão já existente ("Rumo à Aposentadoria" — projeta quanto poupar
até atingir uma meta), agora há um toggle no topo da página pra alternar
pra "📉 Pós-Aposentadoria": simula o consumo do patrimônio DEPOIS de
aposentado.

- Campos: idade inicial, patrimônio inicial (+ "usar atual"), juros reais
  esperados, renda não financeira mensal (+ categoria/média 12m), idade
  limite, despesa mensal (+ média 12m), e patrimônio desejado na idade
  limite (herança/reserva — pode ser 0).
- Exatamente 3 campos são "calculáveis" via rádio (🧮): renda não
  financeira, idade limite, despesa mensal. Patrimônio inicial e juros
  reais são SEMPRE informados manualmente (não entram na rotação de
  cálculo). O campo marcado fica `readonly`; tentar editá-lo faz o rótulo
  do rádio "chacoalhar" (classe CSS `.apos2-shake`, `apos2TryEdit()`).
- Matemática: fórmulas de anuidade (`apos2FV`, `apos2SolveW`,
  `apos2SolveN` em `renderer.js`) generalizadas pra mirar num patrimônio
  final `Pf` (não necessariamente zero). `apos2SolveN` usa bisseção
  (função monótona) em vez de fórmula fechada, pra lidar com todos os
  casos-limite de `Pf` positivo, negativo, cenários "nunca esgota" vs
  "nunca alcança".
- **Patrimônio desejado (Pf)**: pode ser digitado manualmente OU calculado
  automaticamente selecionando ativos específicos da aba Patrimônio pra
  preservar (checkbox list, `apos2TogglePreserveAssetsPanel`/
  `apos2GetPatAssetsWithValues`) — nesse caso o campo trava e mostra a
  soma dos ativos escolhidos (`apos2UpdatePatFinalDisplay`).
- **Patrimônio inicial (P0) — "usar atual"**: agora soma investimentos
  financeiros + contas bancárias (sempre) + bens e direitos que o usuário
  marcar como "geradores de renda" no seletor (`apos2ToggleIncomeAsset*`)
  — por padrão nenhum bem e direito conta (ex: imóvel de moradia não gera
  renda, precisa ser marcado manualmente se for o caso).
- Persistência: mesmo arquivo `overview-config` (JSON por usuário) já
  usado pela visão 1, com chaves `apos2_*` e `apos_mode`.
- Funções principais: `apos2Calc`, `apos2BuildRows`, `renderApos2KPIs`,
  `renderApos2Table`, `renderApos2Charts`, `aposTglMode`. HTML em
  `index.html` dentro de `#apos-view-inverso`.

### Bug corrigido: saldo de contas sempre somava zero
Em `aposPullPatrimonio()` (visão 1) e no equivalente da visão 2, o
fallback de "patrimônio atual" fazia `accounts.reduce((s,a)=>s+(a.balance||0),0)`
— mas o array global `accounts` só tem metadados (nome, tipo, banco...),
NUNCA teve campo `.balance`. Saldo por conta vive em
`_pat.accountBalances[].history` (mesma fonte que a aba Patrimônio usa pro
card "Contas"). Corrigido nos dois lugares pra usar
`_pat.accountBalances`. Esse bug só não aparecia normalmente porque o
caminho principal (via `window._patGrandTotal`) quase sempre está
disponível primeiro — o fallback quebrado era raramente exercitado.

### Atalhos de teclado — Enter/Esc nos modais
- Esc já funcionava genericamente pra todo modal (`.overlay.open`) via um
  listener central em `renderer.js` (~linha 12700) — não precisou mexer.
- Enter dependia de cada modal ter um `onkeydown` na própria `.modal` div
  — mas o `openModal()` nunca movia o foco pra DENTRO do modal, então se o
  foco ficasse em algum elemento de fora (comum ao abrir `modal-transfer`
  a partir da importação, ou `modal-tx`), o evento de teclado nunca
  chegava no handler. Corrigido centralizando um `setTimeout(...).focus()`
  dentro do próprio `openModal(id)` pros ids `modal-transfer`/`modal-tx`.
  Adicionado também o `onkeydown` de Enter no `modal-tx` (só existia no
  `modal-transfer` antes).

### Aba Patrimônio
- **Scrollbar vertical invisível** (tabela): `#pat-scroll-container::-webkit-scrollbar`
  só definia `height:20px` (barra horizontal), a vertical herdava
  `width:8px` da regra global — e o "thumb" tinha `border:4px solid`
  (8px total), consumindo TODA a largura e deixando zero pixel da cor de
  preenchimento visível. Corrigido acrescentando `width:20px` na mesma
  regra (`index.html`, seletor `#pat-scroll-container::-webkit-scrollbar`).
- **Bug de ordenação ao editar ativo**: `savePatAsset()` nunca reenviava
  `sort_order` pro backend, que tratava `undefined` como `?? 0` — ou seja,
  QUALQUER edição de um ativo existente jogava ele pro topo da lista,
  ignorando a ordenação manual (drag-and-drop). Corrigido preservando o
  `sort_order` atual do ativo (ou `_pat.assets.length` se for novo).
- **Novos gráficos** (visão "Gráficos"): linha de referência do IPCA
  (patrimônio inicial corrigido pela inflação acumulada) sobreposta ao
  gráfico "Total Patrimônio"; novo gráfico de barras "Delta Patrimonial
  Real" (`cur − prev×(1+ipca_do_mês)`, mês a mês).
- **Popup de alerta na importação de corretora**: antes de abrir o fluxo
  de importação (`pickBroker`), lembra o usuário de já ter lançado todas
  as movimentações de $ na conta de investimentos (senão o "ajuste de
  saldo" automático sai errado) e recomenda importar banco antes de
  corretora.

### Formato de data (DD/MM/AAAA)
Vários lugares mostravam data crua em ISO (`AAAA-MM-DD`) em vez do padrão
BR: prévia de importação (`renderImportEditTable`, a tabela principal
"revise e confirme"), prévia simplificada de banco/cartão
(`renderBankPreview`), banner de juros de dívida pessoal, comparação de
duplicatas, as 4 telas do assistente de parser customizado, e a legenda
do gráfico de projeção de saldo de conta. Corrigido usando `fmtDate`/
`fmtBRDate` (funções já existentes) em vez de interpolar a string crua.

### Parser de extrato bancário BTG (novo)
Novo item em `BUILTIN_BANKS` (`id: 'btg_extrato'`) + função
`parseBankBTGExtrato(buffer)` em `renderer.js`. Formato `.xls` (OLE2
binário antigo, lido nativamente pelo SheetJS "full" já usado no projeto
— não precisou de lib nova). Layout: tabela "Data e hora | Categoria |
Transação | ... | Descrição | ... | Valor", ignorando linhas "Saldo
Diário" (saldo acumulado do dia, não é uma transação). Diferente da
fatura de cartão BTG (`parseBankBTG`), aqui o valor já vem com o sinal
certo pra convenção do Cruzeiro (positivo = entrada) — NÃO inverte.
Testado com dois extratos reais (jan/fev 2026) via script standalone com
SheetJS — 6 e 7 transações extraídas corretamente em cada arquivo.

### Correção da data de parcelas — fatura Santander (`parseSantanderFaturaPDF`)
Nas seções "Parcelamentos", a coluna "Data" do PDF é a data da 1ª parcela
(sem ano) — não uma data dentro do período da fatura. `resolveDate`
assumia (errado) que toda data caía num dos 2 meses do período. Corrigido
(`resolveInstallmentDate`): mês desta parcela = mês da 1ª parcela +
(parcela atual − 1), escolhendo o ano da 1ª parcela de forma que o
resultado caia dentro do período desta fatura.

### Correção do cálculo "despesa média 12m" (Aposentadoria)
O cálculo somava `expenses` por categoria direto (`ff.evolucaoByCat`),
sem aplicar a mesma classificação líquida por categoria-mãe que a aba
Evolução usa (`computeSummaryFromByCat`) — estornos/reembolsos inflavam o
total (chegou a dar R$192k contra o valor correto de R$72k). Corrigido
com `apos2GetDespesaMA12()`, que reaproveita exatamente a mesma lógica da
coluna "Média 12M desp." da aba Evolução — confirmado bit-a-bit idêntico
via teste ao vivo.

### Importadores — organizar e ocultar bancos/corretoras
O botão "↕ Reordenar lista…" nos 3 importadores (banco/cartão/corretora)
virou "↕ Organizar lista…", e o mesmo modal ganhou um toggle 👁/🙈 por
item pra ocultar da lista de importação bancos/corretoras que o usuário
não usa (persistido em `_builtinOverrides[id].hidden` ou no parser
customizado salvo).

### Publicação
Publicadas 3 versões nesta sessão: v4.72.0 (gráficos IPCA/Delta
Patrimonial, popup de alerta na importação, correção de data da fatura
Santander, formato DD/MM/AAAA), v4.72.1 (scrollbar vertical, botão
"calcular" removido de patrimônio/juros, correção da despesa média 12m,
trava visual + chacoalhar), v4.73.0 (visão Pós-Aposentadoria completa,
Enter/Esc nos modais, correção do saldo de contas).

**Nota de processo**: pra testar essas mudanças de verdade (não só ler o
código), usei o protocolo de debug remoto do Chrome embutido no Electron
(`electron.exe --remote-debugging-port=N`) — abre uma conexão WebSocket
que permite rodar JS de verdade na janela do app (preencher campos, rodar
funções de cálculo, tirar screenshot, ler o DOM) sem precisar de
intervenção manual do usuário. Útil pra próximas sessões que precisem
verificar UI/lógica de verdade em vez de só inspecionar o código-fonte.
