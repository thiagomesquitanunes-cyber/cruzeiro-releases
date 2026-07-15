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
