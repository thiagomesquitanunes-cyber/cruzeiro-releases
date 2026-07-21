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

## 2026-07-21 (continuação 2) — Investigação: desconexão intermitente do Supabase

### O quê
Usuário relatou que, de vez em quando, sem ação própria, o app aparece
como "Desconectado" nas Configurações, pedindo email/senha de novo. Usa
o app em 2 computadores; confirmou que "single session per user" está
**desativado** no Supabase (não é a causa). Investigação encontrou um
único ponto de restauração de sessão no boot (`mainStartupFlow`,
main.js) e identificou 3 hipóteses de causa raiz, das quais as duas
primeiras foram corrigidas nesta sessão (a terceira é só monitoramento):

1. **Falha transitória de rede exatamente no boot** (mais provável de
   explicar a frequência "de vez em quando, sem causa aparente"): o app
   só tenta renovar a sessão UMA VEZ no boot; qualquer soluço de
   rede/DNS/VPN/timeout nesse instante único marcava a sessão como
   "Desconectada" pelo resto da execução — mesmo com o token salvo em
   disco continuando 100% válido, sem nenhum retry automático depois.
2. **Corrida entre duas instâncias do Electron na mesma máquina**
   (candidato mais forte pra uma desconexão REAL, não só aparente): o
   app nunca teve trava de instância única
   (`app.requestSingleInstanceLock()`). Se duas cópias abrissem quase
   juntas (clique duplo, atalho + bandeja, processo anterior que não
   fechou), ambas competiriam pelo MESMO `refresh_token` salvo em disco
   — o Supabase rotaciona esse token a cada uso (single-use), então a
   segunda a usá-lo recebe erro e pode invalidar a sessão inteira
   (inclusive o token novo que a primeira acabou de obter).
3. Acesso em 2 computadores por si só **não deveria** causar conflito
   (cada máquina mantém sua própria cadeia de refresh_token, em arquivo
   local — nunca sincronizado via Dropbox) — a menos que uma delas tenha
   uma instância duplicada rodando (item 2).

### Correções (`src/main.js`)
1. **`app.requestSingleInstanceLock()`** adicionado logo no topo do
   arquivo — uma segunda tentativa de abrir o app agora só foca a janela
   já aberta, em vez de rodar `mainStartupFlow()` em paralelo e brigar
   pelo mesmo refresh_token.
2. **Retry com backoff** (até 3 tentativas, 1.5s/3s de espera) no trecho
   de `mainStartupFlow` que chama `sb.refreshSession()`, só pra erro
   TRANSITÓRIO (rede/timeout) — token realmente inválido continua
   falhando rápido, sem retry (não adianta insistir num token morto).
3. **Log persistido em arquivo** (`logAuth()`, novo helper, grava em
   `_auth_log.txt` na pasta de dados, últimas ~200 linhas) pros eventos
   desse fluxo — antes só existia `console.log`/`console.warn`, invisível
   num app empacotado sem DevTools aberto. Se o problema persistir depois
   dessas correções, esse arquivo vai mostrar exatamente qual dos 3
   cenários aconteceu.

### Testado
App reiniciado normalmente (sessão restaurada na 1ª tentativa, log
gravado certo) e testada a trava de instância única de verdade: abrir
uma segunda cópia disparou `second-instance` na primeira (confirmado no
`_auth_log.txt`) em vez de rodar um segundo `mainStartupFlow()`.

### Pendência
Não foi possível confirmar com certeza qual das hipóteses é a causa real
sem reproduzir o bug ao vivo — as correções acima cobrem as duas mais
prováveis. Se o usuário ver "Desconectado" de novo, o arquivo
`_auth_log.txt` (mesma pasta dos dados) vai dizer exatamente o motivo.

---

## 2026-07-21 (continuação) — Bug crítico: "Substituir provisão" duplicava o lançamento depois

### O quê
Usuário reportou (com prints) que, ao importar fatura/extrato e escolher
"🔄 Substituir provisão" pra um lançamento que corresponde a uma
recorrência já cadastrada, a transação real importada ficava DUPLICADA
com a provisão antiga logo depois — não na hora da importação, mas na
próxima vez que o app era aberto/desbloqueado.

### Causa raiz
O `DELETE` que apaga a provisão antiga (`main.js`, handler
`bank:import`, dentro do bloco `if (Array.isArray(replaceIds) &&
replaceIds.length)`) funcionava normalmente — mas a transação real
inserida no lugar **não guardava nenhum vínculo** com a recorrência
(nem `recurring_id`, nem uma linha em `recurring_excludes`). Do ponto de
vista de `syncRecurringTxns()` (que roda em **todo boot/desbloqueio do
app** — `mainStartupFlow`, `login:check`, `settings:check-password`),
aquela ocorrência da recorrência nunca tinha sido atendida — então ela
recriava uma provisão nova (`cleared=0`, valor/data **estimados** do
cadastro da recorrência) do lado da transação real já importada.

Isso explica os dois sintomas do print do usuário: duas linhas pro mesmo
lançamento, com valores levemente diferentes (real vs. estimado), e o
ícone de recorrência só numa das duas (a recriada). É um bug irmão —
mas distinto — do corrigido em 2026-07-16 (v4.77.5, "Corrigir
duplicação quando 'substituir provisão' falha"): aquele cobria o DELETE
falhando NA HORA da substituição; este é o DELETE funcionando
perfeitamente na hora, mas o "buraco" reaparecendo depois, na próxima
sincronização de recorrências.

### Correção (`src/main.js`, handler `bank:import`)
Antes de apagar a provisão, guarda seu `recurring_id`+`date`; depois do
`DELETE` confirmado (mesmo padrão já usado em `tx:delete`, que faz o
mesmo pra exclusão manual), grava `INSERT OR IGNORE INTO
recurring_excludes (recurring_id, date)` pra aquela ocorrência —
sinalizando pro motor de recorrência que ela já foi atendida e não deve
ser regenerada.

### Verificação
Testado com um script isolado (`sql.js` puro, sem Electron) contra uma
CÓPIA do banco de dados fake (`Usuário Fake/cruzeiro_data.db`) — nunca o
banco real do usuário: reproduzido o bug exato (2 linhas após rodar de
novo a lógica de `syncRecurringTxns`) sem o fix, e confirmada a correção
(1 linha só) com o fix aplicado, usando o mesmo SQL do código real.

### ⚠️ Pendência: limpar os 3 lançamentos já duplicados
O fix evita duplicatas NOVAS — não desfaz as que já foram criadas. Os 3
lançamentos que o usuário reportou (Latam - Passagem Roma, Globoplay,
Mercado Livre - Presente Dudu) continuam duplicados na base real dele.
Ele precisa excluir manualmente, pra cada par, a linha com o ícone de
recorrência (🔄, a provisão recriada com valor estimado) — a linha SEM
o ícone é a transação real importada da fatura/extrato, essa fica.

---

## 2026-07-21 — Evolução: contas apareciam como categoria no "⚙ Configurar"

### O quê
No botão "⚙ Configurar" da aba Evolução (`openEvCatSelector`), contas
bancárias, cartões e contas de investimento apareciam listadas junto com
as categorias de verdade. Bug parecido com o já corrigido antes na aba
Categorias (2026-07-xx, "Aba Categorias mostrando contas
bancárias/cartões/investimentos"), só que numa fonte de dados diferente
que aquele fix não cobria.

### Causa
Aquele fix anterior limpou a **lista gerenciada** de categorias
(`_categories.json`, usada pela aba Categorias) e evita que nomes de
conta sejam auto-registrados nela dali pra frente — mas, por design,
nunca tocou `transactions.category` em si (dados históricos). A
Evolução, diferente da aba Categorias, nunca leu da lista gerenciada:
sempre monta `_ev.allCats` direto de `SELECT DISTINCT category FROM
transactions` (via `ff.evolucaoByCat`/`evolucao:monthly-by-category`,
main.js). Transações antigas — de antes do fix do parser de import que
separava conta de categoria — ainda têm o nome da própria conta gravado
em `category`, e por isso continuavam vazando pra essa lista.

O mesmo filtro que resolveria isso já existia no código, só não estava
sendo usado nesse ponto: `evLoadAllCatsStable()` e `openCatTypesConfig()`
(ambos em renderer.js) já filtram `accountNames = new
Set(accounts.map(a=>a.name))` antes de montar a lista — só que populam
variáveis diferentes (`_ev.allCatsStable`, não `_ev.allCats`), então o
modal "⚙ Configurar" (que lê `_ev.allCats`) continuava exposto.

### Correção (`src/renderer.js`)
Aplicado o mesmo filtro (`!accountNames.has(c) && !isTransferCategory(c)`)
nos dois pontos que populam `_ev.allCats` sem filtro:
`getEvolucaoData()` e o fallback dentro de `computeOverviewMonthSummary()`.

### Verificação
Testado ao vivo via CDP (`--remote-debugging-port`) contra os dados
reais já sincronizados: confirmado que `_ev.allCats` não tem mais
interseção com `accounts.map(a=>a.name)`, e que o modal "⚙ Configurar"
renderizado mostra só as categorias de verdade (nenhuma conta/cartão).

---

## 2026-07-20 (continuação 15) — Ajuste: bens pré-selecionados por padrão nas duas visões

### O quê
Ajuste no seletor "quais bens e direitos geram renda" (as duas visões da
aba Aposentadoria): ao abrir o painel, todos os bens agora vêm
**pré-marcados** — o usuário clica pra DESmarcar o que não gera renda
(ex: a casa onde mora), em vez de precisar marcar um por um. Isso já era
o comportamento da visão principal (implementada agora há pouco), mas a
Pós-Aposentadoria (`_apos2IncomeAssetIds`) sempre começou vazia (usuário
tinha que marcar um por um) — alinhado agora com `_apos2IncomeAssetIdsConfigured`,
mesmo padrão da visão principal.

### Caso de borda encontrado testando com dados reais
A config salva do usuário já tinha `apos2_incomeAssetIds: []` (array
vazio, de uso anterior da feature antes desta mudança). Um array vazio
salvo, tratado como "escolha explícita de zero bens", teria bloqueado o
novo padrão pra sempre. Ajustado pra só considerar "configurado" (e
respeitar a lista salva como está) quando o array salvo NÃO for vazio —
um array vazio agora é tratado como "nunca configurado de verdade", caindo
no novo padrão (todos marcados). Mesmo ajuste aplicado nas duas visões.

---

## 2026-07-20 (continuação 14) — Aposentadoria (visão principal): seletor de bens que geram renda + bug de valor bruto

### O quê
Pedido do usuário: a visão principal "Rumo à Aposentadoria" somava o
patrimônio atual inteiro (via `window._patGrandTotal`, aba Patrimônio)
como se TODO bem gerasse renda — sem a opção de excluir, por exemplo, o
imóvel onde mora, que já existia na visão Pós-Aposentadoria
(`_apos2IncomeAssetIds`, `apos2ToggleIncomeAssetsPanel`). Adicionado o
mesmo seletor nesta visão, reaproveitando as funções genéricas já
existentes (`apos2GetPatAssetsWithValues`, `apos2RenderAssetPicker`).

### Implementação (`src/renderer.js`, `src/index.html`)
- Novo estado `_aposIncomeAssetIds` / `_aposIncomeAssetIdsConfigured` e
  funções `aposToggleIncomeAssetsPanel()`/`aposToggleIncomeAsset(id)`
  (mesmo padrão da visão 2).
- `aposPullPatrimonio()` recomposto a partir dos componentes (investimentos
  + contas sempre, bens/direitos só se marcados, menos dívidas pessoais) em
  vez de usar `_patGrandTotal` bruto — igual à lógica já usada em
  `apos2PullPatrimonio()`.
- **Compatibilidade importante**: diferente da visão 2 (que sempre foi
  opt-in, começando vazia), aqui o padrão pra quem nunca mexeu no seletor
  é TODOS os bens contarem — preserva o comportamento de antes da feature
  existir (soma tudo). Só quando o usuário desmarca algo explicitamente
  (`_aposIncomeAssetIdsConfigured=true`) é que a seleção salva passa a
  valer. `aposInit()` popula esse "todos por padrão" logo depois que
  `refreshPatrimonio()` carrega `_pat.assets`.
- Link "▾ Escolher quais bens e direitos geram renda" + painel adicionados
  no HTML, no mesmo bloco do campo "Patrimônio atual".

### Bug real encontrado durante o teste: valor bruto em vez de líquido
Testando com dados reais (via CDP, sem mutar nada — só leitura), o
patrimônio recalculado deu **quase o dobro** do valor antigo correto
(R$955mil vs. R$483mil esperado). Causa: `apos2GetPatAssetsWithValues()`
lia o valor **bruto** de cada bem direto de `_pat.historyAll`, sem
descontar o saldo devedor de financiamento — um apartamento financiado
entrava pelo valor de mercado cheio, não pelo patrimônio líquido real
(valor − dívida). Esse bug já existia na visão Pós-Aposentadoria também
(criada antes, usa a mesma função), só nunca tinha ficado tão visível.

Corrigido expondo `window._patAssetNetByMonth` (valor líquido por bem,
por mês — calculado durante a renderização da aba Patrimônio,
`refreshPatrimonio()`, já que o desconto de financiamento por
contrato/parcela é complexo demais pra duplicar) e usando isso como
fonte primária em `apos2GetPatAssetsWithValues()`, com fallback pro valor
bruto só se a aba Patrimônio ainda não tiver renderizado nesta sessão.
Depois da correção, o valor recalculado bateu exatamente com o antigo
(R$482.915,53 nos dois), e o Apartamento passou a mostrar R$209.097,69
(líquido) em vez de R$681.945,96 (bruto) no seletor.

### Verificação
Testado ao vivo via CDP (`--remote-debugging-port`) contra os dados reais
já sincronizados — sem clicar em nenhum checkbox (evita gravar
configuração), só leitura/inspeção do DOM e das funções JS.

---

## 2026-07-20 (continuação 13) — Mobile: exclusão otimista de lançamento (feedback do usuário)

### O quê
Usuário testou o botão de excluir lançamento (feature da entrada
anterior) e apontou: depois de excluir, o item continuava aparecendo
normal na lista da conta até o próximo sync real do desktop — sem
feedback de que a exclusão estava em andamento. Corrigido nos dois
repositórios mobile (iOS/Android) com o mesmo padrão já usado pro
lançamento otimista (`pendingEntries.js`), só que invertido:
`markPendingDelete(id)` grava localmente que aquele id está sendo
excluído; a tela da conta (`conta/[name].js`) marca a linha com
`_pendingDelete`, mostrando memorando riscado, ícone 🗑️, texto
"Excluindo…" e desabilitando a interação — some sozinha quando o sync
real confirma (id não aparece mais na lista) ou depois de 15min.

### Também nesta sessão: reformulação da narração do vídeo #3
A frase "Sugestões que realmente ajudam" (já trocada de "Insights" numa
entrada anterior) continuava saindo com sotaque estranho na voz Thalita
— confirmado que **repetir a mesma frase/voz produz sempre o mesmo áudio**
(edge-tts é determinístico), então retry não resolve, só reformulação do
texto. Usuário recusou trocar de voz no meio do vídeo ("vai ficar
horrível"), então geradas 3 variações de texto (mesma voz Thalita) pro
usuário escolher fora do computador (enviadas como arquivo, não por
caminho local, já que estava sem acesso à máquina) — decisão final ainda
pendente.

---

## 2026-07-20 (continuação 12) — Mobile: excluir lançamento (sync) + achado importante sobre o bug de moeda

### Achado: o fix de máscara de moeda do mobile nunca tinha sido publicado
Investigando o relato do usuário (lançou R$55 de receita pelo mobile,
apareceu como transação pendente de R$0,55, mas sincronizou certinho como
R$55,00 no desktop) — achei que o `CurrencyInput` (componente de máscara
estilo caixa eletrônico, que resolve exatamente esse bug de unidade
reais-vs-centavos) **existia só como alteração local não commitada** nos
dois repositórios mobile (`Cruzeiro iOS` e `Cruzeiro Android`) —
`src/components/CurrencyInput.js` nem estava rastreado pelo git. Uma
sessão anterior aparentemente implementou o fix mas nunca chegou a
commitar/publicar de fato, então o app que o usuário testa (TestFlight
build 12) continua com o código antigo, que tinha exatamente essa
inconsistência: `quick_entries.amount` ia em centavos (`amountVal*100`)
mas o lançamento otimista local (`pendingEntries`) recebia o valor em
reais direto — dá exatamente R$0,55 na tela (otimista, errado) vs
R$55,00 depois do sync real (certo). Commitado e publicado agora via
`eas update` nos dois repositórios (ver changelogs deles).

### Nova feature: excluir lançamento pelo mobile
Pedido do usuário: `editar-transacao/[id].js` (tela de edição, mobile)
não tinha botão de excluir. Adicionado — reaproveita a mesma tabela
`mobile_edit_requests` já usada pra edição, com uma coluna nova
`is_delete boolean`. Quando marcado, o desktop
(`sync-pull.js:pullEditRequests`) roda `DELETE FROM transactions` em vez
do `UPDATE` — a transação some de `mobile_transactions` sozinha no
próximo push (o `pruneNotIn` já existente cuida disso, não precisou de
mudança no lado do push). Pernas de transferência não podem ser
excluídas pelo app (mesma restrição que já existia pra edição) — a tela
mostra um aviso em vez do botão nesse caso.

**Pré-requisito: rodar esta SQL no Supabase antes do botão funcionar**
(sem ela, o insert falha com erro de coluna desconhecida):
```sql
alter table public.mobile_edit_requests add column if not exists is_delete boolean not null default false;
```

### Arquivos
`src/sync/sync-pull.js` (`pullEditRequests`) — trata `is_delete`.

---

## 2026-07-20 (continuação 11) — Detecção de cancelamento de parcelada: de texto por banco pra valor genérico

### O quê
A detecção de cancelamento de compra parcelada na importação (feature
#81, ver entrada mais abaixo) dependia de reconhecer a frase exata
"cancelamento/estorno de compra parcelada" — só testada contra o texto
real do BTG. Usuário pediu algo genérico, que não dependesse de ter
exemplo de fatura de cada banco. Reescrito com duas mudanças em
[src/renderer.js](src/renderer.js):

1. **`detectCancelamento` (linha ~5501)**: agora dispara com qualquer
   ocorrência de "cancelamento" ou "estorno" no texto do lançamento —
   não exige mais a frase completa. A frase específica ainda é tentada,
   só pra extrair o nome do comerciante quando disponível (deixa o texto
   de confirmação mais claro), mas não é mais obrigatória.
2. **Casamento por VALOR em vez de nome do comerciante**: o agrupamento
   de linhas de cancelamento (`cancelGroups`, no loop de
   `confirmBankImport`) passou a ser por `conta + valor exato do
   crédito`, não mais por texto normalizado do comerciante. E
   `findCancelamentoMatches` busca parcelas futuras já lançadas
   comparando o VALOR (`Math.abs(t.amount) === g.amount`, com tolerância
   de 1 centavo) em vez de checar se o memo contém o nome do
   comerciante.

### Por que isso é seguro apesar do texto amplo
Alargar o gatilho de texto (só "cancelamento"/"estorno", sem exigir a
frase inteira) aumentaria muito o risco de falso positivo se disparasse
sozinho — mas duas travas continuam garantindo que só cancela parcela de
verdade:
- Só conta como candidato a cancelamento uma linha que seja **crédito**
  (`r.amount > 0`) — descarta na hora coisas como "taxa de cancelamento"
  cobrada (que seria débito).
- Uma parcela futura só entra na lista de sugestão se: (a) tiver o
  **valor exatamente igual** ao crédito da fatura, E (b) o memo já
  reconhecido tiver o padrão `(N/M)` de parcela (`detectParcela`) — ou
  seja, precisa já ser uma parcela futura de uma compra parcelada, não
  qualquer lançamento futuro que coincida de ter o mesmo valor.
- E o usuário ainda revisa e confirma linha por linha antes de qualquer
  exclusão (`showCancelamentoConfirmUI` — isso não mudou).

Com essas duas travas, o texto genérico funciona pra qualquer banco sem
precisar de um dicionário de frases por instituição.

---

## 2026-07-20 (continuação 10) — 2 correções nos vídeos promocionais (todos os 6)

### O quê
1. **Vídeo 3 (Visão Geral), narração**: a palavra "Insights" (inglês,
   nome do recurso na UI) fazia a voz `pt-BR-ThalitaMultilingualNeural`
   trocar de idioma no meio da frase e sair falando em sotaque
   espanhol/estranho. Trocado o texto da legenda 6 de "Insights que
   realmente ajudam" pra "Sugestões que realmente ajudam" — em
   `captions_03_visaogeral.json` (scratchpad), usado tanto pela versão
   com legenda quanto pela narrada.
2. **Tela de abertura curta demais** nos 3 vídeos — usuário pediu 4
   segundos no total (a animação de entrada em si dura menos de 1s,
   depois trava no frame final rápido demais pra dar tempo de ler
   "Cruzeiro — Clareza para navegar seu dinheiro"). Corrigido com
   `tpad=stop_mode=clone:stop_duration=X` no filtro do clipe de abertura
   (calculado dinamicamente: `4.0 - (nº de frames / 30fps)`) — aplicado
   nos 3 scripts de montagem (`assemble_real.js`, `assemble_video.js`,
   `assemble_narrated.js`, todos em scratchpad). Testado isolado antes
   de aplicar em massa (2 bugs de ffmpeg já encontrados nesta build
   deixaram a cautela como hábito) — `tpad` funcionou de primeira, sem
   surpresas.

Todos os 6 arquivos em `store-assets/videos/` (3 com legenda + 3
narrados) foram regerados com as duas correções.

---

## 2026-07-20 (continuação 9) — Narração por voz (TTS) como alternativa às legendas

### O quê
Usuário quis testar narração profissional em vez de legenda + música
("tom sério mas convidativo"). Gerados
`store-assets/videos/{01-contas,02-evolucao,03-visao-geral}-narrado.mp4`
— mesma abertura/encerramento, vídeo real SEM legenda, com narração
falada (voz `pt-BR-ThalitaMultilingualNeural`, ritmo -8%) entrando nos
mesmos instantes em que cada legenda apareceria, e a trilha sonora bem
mais baixa que antes (volume 0.09 em vez de 0.32) só como ambientação.
Aprovado pelo usuário ("ficou perfeito") no teste do vídeo #1 antes de
replicar pros outros 2. As versões com legenda (`01-contas.mp4` etc.)
foram mantidas intactas pra comparação — usuário ainda não decidiu qual
usar como definitiva.

### TTS usado: Edge TTS (voz neural do Microsoft Edge), não SAPI/OneCore
Primeira tentativa usou as vozes offline do Windows (OneCore/WinRT
`Windows.Media.SpeechSynthesis`, vozes "Daniel"/"Maria" pt-BR) — o
usuário achou o resultado "extremamente robótico". Trocado pro serviço
de voz neural que o Microsoft Edge usa no "Ler em voz alta" (pacote
Python `edge-tts`, `pip install edge-tts` — sem chave de API, sem custo,
qualidade bem superior). Vozes pt-BR disponíveis:
`pt-BR-AntonioNeural` (masculina), `pt-BR-FranciscaNeural` (feminina),
`pt-BR-ThalitaMultilingualNeural` (feminina, multilíngue) — usuário
escolheu Thalita depois de ouvir amostras das 3.

Em paralelo o usuário testou o ElevenLabs (Text to Speech, não
Dubbing) pra comparar — orientação dada: gerar as 4 frases do vídeo
"Contas" em arquivos MP3 separados (um por frase, nessa ordem, pra
encaixar cada fala no tempo certo do vídeo). Resultado dessa comparação
ainda não voltou/não foi decisivo — Thalita já foi aprovada e usada pros
3 vídeos.

### Pipeline novo: `assemble_narrated.js` (scratchpad)
Reaproveita as mesmas legendas (`captions_0N_*.json`, mesmos arquivos
usados pro pipeline de legenda) como roteiro de fala — cada `text` vira
uma chamada separada ao `edge-tts` (um mp3 por trecho), medido e
posicionado com `adelay` no mesmo instante (`start`) em que a legenda
visual apareceria, todos somados com `amix` num único trilho de
narração, que depois é misturado com a trilha de fundo (também com
`amix`, volumes controlados manualmente com `normalize=0` pra não perder
nível) e por fim mixado no vídeo (sem legenda, sem `drawtext`).

### Bugs encontrados e corrigidos
1. **`amix ... duration=first` cortava o vídeo inteiro no fim da última
   fala.** A narração é bem mais curta que o vídeo (só tem áudio até a
   última frase); usar `duration=first` (referenciando a entrada da
   narração) truncava a saída ali — vídeo de 50.73s virava 40s. Trocado
   pra `duration=longest`, referenciando a trilha de fundo (que já foi
   cortada com `atrim` pro tamanho certo do vídeo inteiro).
2. **Áudio saía em mono.** O Edge TTS gera mono; sem forçar
   `aformat=channel_layouts=stereo` nos dois ramos (narração e música)
   antes do `amix`, o resultado herdava o layout do primeiro input
   (mono) e a trilha de fundo perdia a largura estéreo.
3. **Narrações se sobrepondo.** As legendas visuais foram cronometradas
   pra leitura rápida de texto na tela — falar em voz alta o mesmo
   trecho leva mais tempo, então em alguns pontos (ex: vídeo #3, 1ª e 2ª
   falas) a narração anterior ainda não tinha terminado quando a
   próxima "deveria" começar (pelo tempo original da legenda),
   resultando em duas vozes sobrepostas. Corrigido com uma lógica de
   fila em cascata: cada narração usa `max(tempo original, fim da
   anterior + 0.25s de respiro)` como início real — sem problema
   perceptível nisso, já que não existe mais legenda na tela pra
   desincronizar visualmente.

---

## 2026-07-20 (continuação 6) — Vídeo promocional #1 ("Contas"): legendas modernas + bug de ffmpeg

### O quê
Usuário rejeitou o estilo de legenda anterior ("não gostei do formato,
com a caixa em volta... precisava de algo mais moderno, mais
profissional"). Redesenhado pra texto branco com sombra suave, sem caixa
de fundo — mesma linguagem visual usada em vídeos de produto de apps como
Linear/Stripe. `store-assets/videos/01-contas.mp4` foi regravado com o
resultado final (fonte da gravação real do usuário no Pane Studio, 1080p
— não é mais o vídeo sintético/roteirizado das tentativas anteriores).

Pipeline de montagem inteiro (não faz parte do app — ferramentas em
scratchpad de sessão, fora do repo) usa ffmpeg-static pra: gerar abertura
e encerramento a partir de frames PNG (`store-assets/video-build/{opening,closing}.html`),
sobrepor as 4 legendas com fade in/out na gravação real, concatenar tudo
e misturar a trilha sonora (`Wavecont-Inspiring-Full.mp3`) por cima.

### Bug de ffmpeg encontrado: `drawbox` ignora expressões em x=/y=
A primeira tentativa do novo estilo incluía uma barrinha de destaque
(cor de marca) acima do texto, com posição em expressão:
`x=(w-64)/2:y=h-172`. A barra simplesmente não aparecia — nenhum erro,
nenhum aviso. Isolando o filtro (testado sozinho, fora da cadeia com
`drawtext`) e variando cada coordenada separadamente, confirmei: com
`x`/`y` numéricos literais o `drawbox` funciona perfeitamente (inclusive
com `t=fill`); com qualquer um dos dois como expressão (mesmo algo
trivial tipo `(w-64)/2`), a caixa desaparece por completo nesta build do
ffmpeg-static (Windows). Não é o mesmo bug do `t=fill` já documentado
numa sessão anterior — esse já estava corrigido (`t=4` numérico) e ainda
assim a barra não aparecia, o que apontou pra esse segundo bug distinto.

Na prática, mesmo corrigindo a barra (coordenadas numéricas calculadas em
JS), não sobrava espaço limpo pra ela nesta gravação: a janela do app
ocupa quase o quadro inteiro (borda inferior por volta de y≈940 em
1920x1080), colando quase direto no topo do texto da legenda (y≈942) —
qualquer posição pra barra ou ficava atrás do conteúdo da janela ou
colada/sobreposta ao texto. Decisão: removida a barra, mantido só texto
com sombra (`shadowcolor=black@0.75:shadowx=0:shadowy=3`) — já atende o
pedido do usuário (sem caixa) e continua legível mesmo quando a legenda
cai sobre conteúdo claro da UI (testado nas 4 legendas do roteiro
"Contas", incluindo uma caindo em cima de um modal).

### Arquivos (fora do repo, scratchpad de sessão)
`assemble_real.js` — script de montagem principal, com `barY`/`barX`
agora calculados em JS (`W`/`H` são constantes 1920x1080) em vez de
expressões ffmpeg, e a barra de destaque removida do `drawtexts`.

### Ajuste seguinte: legenda dourada em vez de branca
Usuário achou o texto branco "escondido" — trocado `fontcolor` pra
`0xf9a825` (mesmo dourado do ícone/gráficos do app) e adicionado contorno
escuro fino (`borderw=2.5:bordercolor=black@0.55`) além da sombra já
existente, pra manter contraste tanto no fundo escuro do Windows quanto
em cima de conteúdo claro da UI (testado nas 4 legendas, incluindo a que
cai em cima de um modal).

### Próximos passos (não feitos ainda)
Replicar o mesmo pipeline (abertura/encerramento + legendas dourada +
trilha) pros outros 7 vídeos do roteiro (`roteiros videos Cruzeiro.pdf`),
na ordem sugerida: Dashboard → Orçamento → Evolução → Importação →
Patrimônio (investimentos) → Patrimônio (ativo financiado) →
Aposentadoria. Aguardando confirmação do usuário sobre o vídeo #1 antes
de prosseguir.

---

## 2026-07-20 (continuação 7) — Vídeo promocional #2 ("Evolução")

### O quê
`store-assets/videos/02-evolucao.mp4` — mesmo pipeline do vídeo #1
(abertura/encerramento + legendas douradas + trilha), aplicado à gravação
real do usuário da aba Evolução (`Cruzeiro Evolução 1080p.mp4`, 45.23s).

### Pipeline generalizado (`assemble_video.js`, scratchpad)
O script do vídeo #1 (`assemble_real.js`) só aceitava uma gravação com
tempos de legenda *escalados* a partir de um roteiro-alvo (não tínhamos
os tempos reais ainda naquela primeira tentativa). Pra este vídeo o
usuário já cronometrou a própria gravação e mandou os tempos exatos de
cada legenda — criado `assemble_video.js`, versão genérica que lê as
legendas de um JSON externo (`captionsFile`, tempos reais, sem escala) em
vez de calcular a partir de um alvo de roteiro. Este será o script
reaproveitado pros vídeos #3–8.

Legenda 3 ("Com correção por IPCA e média móvel de 12 meses, o Cruzeiro
te ajuda a ver as tendências reais") é longa demais pra uma linha em
1920px — quebrada em 2 linhas manualmente no texto (`\n`) com fontsize
reduzido (40 em vez de 46); testado visualmente, cabe sem cortar nas
bordas do quadro. `assemble_video.js` aceita um `fontsize` opcional por
legenda no JSON pra isso.

### Arquivos
`captions_02_evolucao.json` (scratchpad) — as 5 legendas com tempos reais
passados pelo usuário.

---

## 2026-07-20 (continuação 8) — Vídeo promocional #3 ("Visão Geral")

### O quê
`store-assets/videos/03-visao-geral.mp4` — mesmo pipeline reaproveitado
(`assemble_video.js`) aplicado à gravação real da aba Visão Geral
(`Cruzeiro Visão Geral 1080p.mp4`, 65.97s), com as 7 legendas do roteiro
e tempos reais passados pelo usuário
(`captions_03_visaogeral.json`, scratchpad). Todas conferidas
visualmente — sincronismo bateu bem com o conteúdo em tela (ex: "Metas
sob controle" aparece exatamente sobre o card de Metas; "Insights que
realmente ajudam" sobre o painel de Insights). Nenhum bug novo encontrado
neste vídeo — o pipeline gerado nos vídeos #1/#2 já resolveu os problemas
de fonte/posicionamento.

---

## 2026-07-20 (continuação 5) — Novo relatório: Fluxo do dinheiro (Sankey)

### O quê
Nova opção "Fluxo do dinheiro (Sankey)" no seletor de Relatórios. Mostra,
pro período selecionado, de onde o dinheiro veio (categorias de receita,
à esquerda) passando por um nó central "Receita total" até pra onde foi
(categorias de despesa + "Sobra (poupança)" quando sobra dinheiro, à
direita) — usa os mesmos filtros de conta/categoria/excluir transferência
já existentes nos outros relatórios.

### Implementação (`renderSankeyReport`, `src/renderer.js`)
Desenhado à mão em SVG (sem lib externa — o app não tinha nenhuma lib de
gráfico com suporte a Sankey, e adicionar uma só pra isso não valia a
pena). Cada categoria vira um segmento vertical proporcional ao valor
numa coluna, empilhados; cada fluxo é uma "fita" (duas curvas de Bézier
espelhadas) ligando o segmento de origem ao de destino. Reaproveita
`ff.reportSummary` (mesmo endpoint do "Mapa de despesas") e a paleta
`DASH_COLORS` já usada nos outros gráficos.

Quando despesas > receita no período (não há como desenhar mais do que
100% do que entrou saindo do nó central), mostra um aviso e desenha as
despesas proporcionais entre si (não em relação à receita) em vez de
travar ou distorcer o gráfico.

### Bug encontrado e corrigido durante o teste: rótulos cortados
Primeira versão reservava só 40px de margem fixa nas laterais pros
rótulos (nome da categoria + valor) — qualquer nome mais longo (ex:
"Alimentação:Supermercado") ultrapassava x=0 (ou a borda direita do
viewBox) e o SVG cortava silenciosamente o texto (comportamento padrão
de overflow:hidden em `<svg>`). Corrigido reservando 220px de cada lado,
calculados a partir da largura real do container.

### Testado
Via CDP contra a instância de desenvolvimento: casos de superávit
(nó "Sobra" aparece, cor verde), déficit (aviso aparece, sem nó de
sobra) e sem dados no período (estado vazio) — todos renderizando a
contagem certa de nós/fitas. Capturado screenshot confirmando
visualmente que os rótulos ficam legíveis (incluindo nomes longos de
subcategoria) depois da correção de margem.

**Arquivos tocados**: `src/index.html` (nova `<option value="sankey">`),
`src/renderer.js` (`renderSankeyReport`, chamada em `runReport`).

---

## 2026-07-20 (continuação 4) — Cancelamento de compra parcelada não duplica mais parcelas futuras

### Contexto
Ao importar uma fatura de cartão com o cancelamento de uma compra
parcelada, o banco (ex: BTG) lista o cancelamento como uma linha de
crédito POR PARCELA restante revertida — ex: uma compra em 5x cancelada
após a 1ª parcela cobrada gera 4-5 linhas de crédito idênticas
("Cancelamento de compra parcelada - Usaflex") na mesma fatura. Nenhuma
delas tem o padrão "N/M" que `detectParcela()` reconhece, então eram
importadas como lançamentos novos comuns — enquanto as parcelas futuras
já lançadas na importação ORIGINAL da compra (1/5, 2/5...) continuavam
agendadas normalmente, cobrando de novo algo que a própria fatura já
mostra como cancelado. Exemplos reais confirmados numa fatura BTG
anexada pelo usuário (casos "Usaflex" 15/12 e "Antolie" 04/01, cada um
com 5 linhas de crédito idênticas no mesmo dia).

### Detecção (`detectCancelamento`, ao lado de `detectParcela`)
Reconhece `"Cancelamento de compra parcelada - <comerciante>"` (ou
"estorno de compra parcelada"), extraindo o nome do comerciante após o
traço.

### Fluxo (`confirmBankImport` → `finishImportWithPatLinks`)
Durante a importação, linhas de cancelamento são agrupadas por
comerciante (`cancelGroups`, guardado em `_pendingImport` e preservado
através das reatribuições de `_pendingImport` no fluxo de resolução de
duplicatas). Antes de gravar de fato (`finishImportWithPatLinks`, agora
um wrapper — a lógica antiga virou `_finishImportWithPatLinksInner`),
`findCancelamentoMatches()` busca via `ff.listTx` transações FUTURAS na
mesma conta cujo memo contenha o nome do comerciante E o padrão de
parcela "(N/M)" — até o mesmo número de linhas de cancelamento na
fatura, mais próximas primeiro.

Se encontrar, `showCancelamentoConfirmUI()` mostra um modal (reaproveita
o container `modal-custom-parser`) listando cada parcela futura
encontrada com checkbox pré-marcado, pausando o fluxo.
`cancelamentoResumeImport(doDelete)` retoma: se confirmado, deleta as
selecionadas via `ff.deleteTx` (já suporta desfazer — undo nativo do
`tx:delete`) e só então importa a fatura normalmente (as linhas de
crédito de cancelamento SÃO importadas como lançamentos reais — só as
parcelas futuras agora obsoletas é que são removidas). Resumo final
mostra quantas parcelas foram canceladas.

### Testado
Via CDP contra a instância de desenvolvimento: criadas 2 transações
futuras sintéticas ("Loja Teste (2/3)"/"(3/3)"), confirmado que
`detectCancelamento` + `findCancelamentoMatches` acham exatamente as 2
certas (por id), e que `showCancelamentoConfirmUI` renderiza o modal
corretamente (2 checkboxes, título certo). Dados de teste removidos
depois. Não testado via fluxo de UI completo (seleção de arquivo →
tabela de edição → confirmação) por falta de tempo — a lógica nova
(detecção + busca + modal) foi validada isoladamente; o encanamento que
já existia (`doImport`, resolução de duplicatas) não foi alterado em
comportamento, só recebeu o novo agrupamento por comerciante.

**Arquivos tocados**: `src/renderer.js` (`detectCancelamento`,
`finishImportWithPatLinks` virou wrapper + `_finishImportWithPatLinksInner`,
`findCancelamentoMatches`, `showCancelamentoConfirmUI`,
`cancelamentoResumeImport`, `showImportSummaryModal` — novo campo
`cancelledCount`).

---

## 2026-07-20 (continuação 3) — Windows Store: identidade real + build de teste + ficha pronta

### Identidade do appx
Usuário reservou o app no Partner Center. `package.json` (`build.appx`)
atualizado com os valores reais: `identityName: CruzeiroApp.CruzeiroFinanasPessoais`,
`publisher: CN=F273678E-4760-4FBB-A6D9-CDDE2A4A3870`,
`publisherDisplayName: Cruzeiro App` — substituindo os placeholders TODO.

### Build local do .appx bloqueado — resolvido via CI
`npm run build:winstore` falha nesta máquina (corporativa): o
electron-builder precisa criar links simbólicos ao extrair o
`winCodeSign`, e isso exige Modo de Desenvolvedor do Windows (indisponível
aqui). Solução: novo workflow `.github/workflows/build-appx-test.yml`
(`workflow_dispatch` manual, sem publicar em release) que builda o .appx
num runner do GitHub (sem essa restrição) e sobe como artefato pra
download. Precisou de um ajuste (`--publish never`) porque o
electron-builder detecta `CI=true` automaticamente e tenta publicar num
release por padrão, mesmo sem pedir. Build de teste (v4.79.3) rodou com
sucesso.

### Ficha da loja preparada (`store-assets/`)
`listing-pt-br.md`: nome, subtítulo, descrição curta/completa, lista de
recursos, termos de busca e notas de lançamento — prontos pra colar no
Partner Center. `screenshots/`: 9 capturas já existentes do site
(`Cruzeiro Site/public/screenshots/`), reaproveitadas sem gerar nada
novo, renomeadas em ordem sugerida (visão geral → orçamento →
patrimônio → aposentadoria → evolução → IA insights → relatórios →
importação → recorrentes).

Submissão final ao Partner Center (upload do .appx + preenchimento da
ficha) é manual — Claude não tem acesso à conta.

**Arquivos tocados**: `package.json`, `.github/workflows/build-appx-test.yml` (novo),
`store-assets/listing-pt-br.md` (novo), `store-assets/screenshots/*` (novo).

---

## 2026-07-20 (continuação) — Causa raiz real encontrada: loop infinito no quit (`main.js`)

### Correção da investigação anterior (mesmo dia, entrada abaixo)
A conclusão anterior ("o código não reescreve os arquivos sozinho") estava
**incompleta** — só testei o app parado/idle, nunca o momento de FECHAR.
O usuário reportou que matar manualmente 2 processos zumbis do Cruzeiro no
Gerenciador de Tarefas fez as escritas pararem, o que apontava pra um bug
no ciclo de saída, não em nenhum timer.

### Causa raiz: `app.on('before-quit', ...)` se rechamava para sempre
Em `main.js` (~linha 2761), o handler de sync final ao fechar tinha uma
recursão infinita não intencional:

1. Fechar a janela → `window-all-closed` → `app.quit()`.
2. Dispara `before-quit`. Logado e sem sync em andamento → `e.preventDefault()`
   (cancela o quit), roda `runMobileSync('quit')` (escreve
   `cruzeiro_data_sync_hashes.json` e `cruzeiro_data_egress_log.json`), e ao
   final chama `app.quit()` de novo pra realmente fechar.
3. Esse `app.quit()` dispara `before-quit` **outra vez**. Como `_syncRunning`
   já tinha voltado a `false` (resetado dentro do próprio `runMobileSync`
   antes deste handler terminar), a condição de guarda nunca barrava — caía
   no mesmo caminho, rodava outro ciclo de sync completo, chamava
   `app.quit()` de novo, e assim indefinidamente.

Resultado: ao fechar o app (com sessão Supabase logada), o processo nunca
morria de verdade — ficava rodando sync completo em loop, sem nenhuma
janela visível, reescrevendo os dois arquivos a cada iteração, até alguém
matar o processo manualmente no Gerenciador de Tarefas. Cada iteração de
teste mediu ~1.85 MB de egress (banco de teste pequeno/vazio) — num banco
de produção real, rodando sem parar por horas ou dias, isso sozinho
provavelmente explica a maior parte do egress alto investigado no início
desta sessão (creditado incorretamente na época a "muito teste manual").

### Correção
Nova flag `_quitFinalizing` — a primeira chamada de `before-quit` marca a
flag, roda o sync final e chama `app.quit()`; a segunda chamada (disparada
por esse `app.quit()`) cai direto no early return e deixa o quit seguir de
verdade, sem novo `preventDefault()`.

### Validado ao vivo
Reiniciei o app com `--remote-debugging-port`, confirmei sessão logada via
CDP, fechei a janela remotamente (`window.close()`) e monitorei
`tasklist`: exatamente 1 ciclo de sync rodou (log confirma
`trigger: 'quit'`) e o processo terminou sozinho — `tasklist` não encontrou
mais nenhum `electron.exe` depois. Antes da correção, isso nunca acontecia.

**Arquivo tocado**: `src/main.js` (handler `before-quit`).

---

## 2026-07-20 — Investigação: "cruzeiro_data_sync_hashes.json fica sincronizando o Dropbox sem parar"

### Contexto
Usuário reportou que `cruzeiro_data_sync_hashes.json` (produção, pasta
sincronizada com Dropbox) aparenta ser reescrito continuamente, como se
fosse atualizado a cada poucos segundos, mesmo com o app fechado —
suspeitando de relação com o alto egress do Supabase. Observou o mesmo
padrão nesta pasta de desenvolvimento (não sincronizada com Dropbox):
`cruzeiro_data_sync_hashes.json` e `cruzeiro_data_egress_log.json`
apareciam como "modificados hoje" sem o app ter sido aberto no dia.

### Investigação
Revisão de código não encontrou nenhum mecanismo periódico que escreva
nesses arquivos: `saveHashCache()` (`sync-push.js`) só é chamado a partir
de `pushAll()`, que só roda dentro de `runMobileSync()`
(`main.js`), que por sua vez só é disparado em 4 gatilhos pontuais —
`startup`, `login`, `sync:run-now` (botão manual) e `before-quit` — não
há `setInterval`, `setTimeout` recursivo, `fs.watch`/`chokidar`, nem
subscription Realtime do Supabase em lugar nenhum do app (confirmado via
grep em `main.js`, `renderer.js` e no pacote `electron-updater`, que
também não faz polling próprio além do único check inicial de 3s).

Para confirmar empiricamente, instrumentou-se temporariamente
`saveHashCache()` e `_logEgress()` para gravar stack trace a cada
execução, e o app foi reiniciado do zero (processo limpo, sem os 3 dias
de instância anterior ainda aberta). Resultado: exatamente **uma única
escrita** em cada arquivo, no momento do `startup`, e nenhuma escrita
adicional em 7 minutos de app parado e monitorado ao vivo.

### Conclusão
O código atual não reescreve esses arquivos sozinho — cada escrita
corresponde a um sync real e pontual. As datas "de hoje" observadas nesta
pasta de desenvolvimento vieram das próprias sessões de teste manual
feitas mais cedo nesta conversa (chamadas a `ff.syncRunNow()` durante o
teste do bug de `hasChanged`/`markSynced`), não de um processo autônomo.
A percepção de "sincronizando toda hora" no Dropbox de produção é mais
provável de ser o próprio Dropbox reindexando/reverificando o arquivo
periodicamente (comportamento comum do cliente Dropbox em pastas com
Smart Sync ou antivírus monitorando), e não o app gravando o arquivo —
recomendado ao usuário conferir o "Modificado em" do arquivo pelo
Explorer do Windows com o app fechado por um tempo, para confirmar que
o timestamp não avança sozinho.

A instrumentação de diagnóstico foi revertida após a confirmação (não
ficou no código — não havia mais nada a capturar).

---

## 2026-07-17 (continuação 2) — v4.79.2: instrumentação de egress + bug de integridade no cache de sync

### Contexto
Usuário reportou egress muito alto no painel da Supabase (806MB num único
dia, com apenas 1-2 usuários de teste). Investigação extensa (push, pull,
todas as queries do mobile, checagem de Realtime) não encontrou nenhum
bug isolado óbvio — confirmado via busca que a Supabase só cobra egress
por dados que SAEM dela (respostas), não pelo que o app envia; as
escritas do app já usam `Prefer: return=minimal` corretamente (resposta
vazia = zero egress, confirmado ao vivo). A causa mais provável são
sessões intensas de teste (do usuário e desta própria sessão, que
reiniciou o Electron dezenas de vezes hoje — cada reinício dispara um
sync completo).

### Instrumentação de egress (`supabase-client.js`)
Novo: `setEgressLogPath(dbPath)` + `printEgressSummary()`. Toda resposta
HTTP da Supabase (`_request()`) agora tem seu tamanho real em bytes
registrado por tabela e por dia em `cruzeiro_data_egress_log.json` (local,
nunca versionado — já coberto pelo padrão `cruzeiro_data_*.json` do
.gitignore). Ao final de cada ciclo de sync (`runMobileSync` em
`main.js`), imprime um resumo no console ordenado por maior consumo.
Existe só para diagnóstico — não afeta o funcionamento do sync.

### Bug real encontrado durante o teste: cache de hash "mentia" em falha de rede
Ao testar a instrumentação, um push de `balances`/`transactions` deu
timeout/socket hang up — e o `hasChanged()` já tinha gravado o hash como
"sincronizado" como efeito colateral da própria checagem, ANTES de
qualquer chamada de rede. Resultado: uma falha de rede marcava a tabela
como sincronizada com sucesso, e ela nunca mais era re-tentada até algum
dado local mudar de novo — podendo deixar o Supabase desatualizado em
silêncio por tempo indefinido. Corrigido em `sync-push.js`: `hasChanged()`
agora só COMPARA (sem mutação); novo `markSynced(table, rows)` grava o
hash, chamado explicitamente só DEPOIS de cada push (balances,
transactions, budgets, goals, scheduled, patrimonio ×2, evolution,
ml_rules) ter concluído com sucesso. Validado ao vivo via CDP.

### Reforço de segurança em arquivos locais
`.gitignore`: nova regra geral `_*.json` (cobre qualquer arquivo futuro
com esse padrão de nome, sem depender de lembrar de listar cada um —
foi assim que `_import_pending.json` vazou num commit antes desta sessão).
`publish.js`: `_sync_hashes.json`/`_egress_log.json` adicionados à lista
de arquivos sensíveis verificados (defesa extra, já cobertos pelo padrão
`cruzeiro_data_*.json` existente, mas os nomes originais que eu supunha
para esses arquivos — antes de descobrir o `.replace('.db', ...)` real —
não estavam cobertos por nada).

---

## 2026-07-17 (continuação) — v4.79.1: "Poupança realizada" vira barra no gráfico da Aposentadoria

No gráfico "Poupança necessária (futura) e realizada (histórica)" da
aba Aposentadoria (visão gráfico, `_aposChart2`), a série "Poupança
realizada/mês (Média 12m)" era renderizada como linha âmbar sobre as
barras empilhadas de "Rendimento do patrimônio" e "Poupança por outros
meios" — pedido do usuário pra virar barra âmbar também, consistente
com as outras duas séries. `renderer.js` ~L25672: removido `type:'line'`
(o dataset agora herda o `type:'bar'` do gráfico) e trocado o estilo de
linha (gradiente, tension, pointRadius) pelo mesmo padrão de barra das
outras duas séries (`backgroundColor`/`borderColor` sólidos, `borderRadius`,
`maxBarThickness`, mesmo `stack:'future'` — os períodos são mutuamente
exclusivos no tempo, então não há conflito de empilhamento real).
Validado via CDP: as 3 séries agora reportam `type:"bar"`, com a série
de poupança realizada renderizando barras nos 3 anos passados com dado
disponível.

---

## 2026-07-17 — v4.79.0: 4 melhorias na aba Aposentadoria/Orçamento/Contas/lançamentos

### Aposentadoria: view não "grudava" (voltava sempre pra pós-aposentadoria)
Toda vez que o usuário reabria a aba Aposentadoria, ela ia sozinha pra
visualização "📉 Pós-Aposentadoria", mesmo que a última escolhida tivesse
sido "🚀 Rumo à Aposentadoria". Causa raiz: `aposTglMode()` dispara DOIS
saves concorrentes sem aguardar um pelo outro — `apos2SaveConfig()`
(direto) e `aposSaveConfig()` (via `aposCalc()`) — ambos persistem no
MESMO arquivo (`_overview_config.json`). `aposSaveConfig()`'s `aposFields`
não incluía `apos_mode`, então numa corrida onde o save dele "ganhava" por
último, revertia silenciosamente o modo pro valor antigo (lido antes da
troca). Fix: `aposSaveConfig()` (renderer.js ~L24973) agora também inclui
`apos_mode: _aposMode`, então os dois writers concorrentes sempre
concordam no mesmo valor, não importa qual "vence" a corrida. Validado
via CDP reproduzindo a corrida nos dois sentidos, antes (bug confirmado)
e depois (correto, inclusive sobrevivendo navegação real entre abas).

### Orçamento (gráficos): clicar abre a lista de transações, como na tabela
Nas duas sub-visões de "Orçamento → Gráficos" (cards de rosca por mês
único e barras da série mensal), clicar num gráfico agora abre o mesmo
modal de detalhe (`openCatDetail`) que já existia ao clicar numa célula
da tabela. `renderBudgetSingleMonth`'s `cardHtml` (~L16325) ganhou
`onclick`+cursor:pointer quando `actual !== 0`. `renderBudgetSeries`
(~L16395, gráfico Chart.js `type:'bar'`) ganhou `options.onClick` (só
reage a cliques no dataset "Realizado", índice 0, ignora a linha "Meta")
+ `options.onHover` pra mostrar cursor de mão — calcula o mês exato da
barra clicada e abre `openCatDetail(categoria, mFrom, mTo)` daquele mês.

### Contas: soma dos valores selecionados na barra azul
Ao selecionar várias transações na tabela de uma conta, a barra de ação
em lote (`#multi-bar`) agora mostra "Soma: R$ X,XX" (soma líquida, sinal
já considerado) ao lado da contagem. Novo `<span id="multi-sum">` em
index.html + cálculo em `updateSelectionUI()` (renderer.js ~L3233).

### Calculadora embutida no campo de valor (novo lançamento/transferência)
Pedido do usuário: digitar "48+50" num campo de valor deveria resultar em
98 (e aceitar -, *, / também). Essa lógica (`evalMathExpr`, detecção de
"modo calculadora" via operadores) já existia no código, mas **nunca
funcionou de verdade em uso real** — só passava em testes automatizados
via CDP porque avaliação via DevTools Protocol é isenta de CSP.
Causa raiz real: o CSP do app (`script-src 'self' 'unsafe-inline' ...`,
SEM `'unsafe-eval'`) bloqueia silenciosamente `Function()`/`eval` quando
chamado de dentro de um handler de evento real de página (blur, keydown)
— por isso a digitação real do usuário sempre caía no `catch` e retornava
`null`, silenciosamente formatando só os dígitos como centavos ("50+20"
virava "R$ 50,20", ignorando o operador). Só foi possível reproduzir
capturando o console em tempo real enquanto o usuário digitava de
verdade no app (testes via `Runtime.evaluate` do CDP sempre mascaravam o
bug). Fix: nova função `safeEvalArith()` (renderer.js, logo antes de
`setupCurrencyInput`) — um parser aritmético recursivo-descendente escrito
à mão (sem `eval`/`Function()`), suportando `+ - * /` e parênteses com
precedência correta. `evalMathExpr()` passou a chamar `safeEvalArith()`
em vez de `Function()`. Também corrigido: a detecção de "entrou em modo
calculadora" (`hasMath`/`isMathMode()`) não reconhecia `(` como gatilho,
então um parêntese digitado ANTES de qualquer operador era silenciosamente
descartado pela formatação normal de moeda, corrompendo a expressão
(ex: "(50+20)*2" virava "R$ 502,02" em vez de "R$ 140,00") — agora `(`
também dispara o modo calculadora. Testado exaustivamente com teclado e
blur/Enter REAIS via CDP (não só leitura via `Runtime.evaluate`, que
mascararia o bug de novo) nos campos de despesa, receita e transferência.
Limitação conhecida (fora do escopo pedido): decimal com vírgula digitado
ANTES do primeiro operador (ex: "48,5+1,5") não é suportado — a
formatação "caixa eletrônico" não distingue "usuário digitando decimal"
de "usuário continuando a digitar dígitos" nesse ponto.

---

## 2026-07-16 (continuação 15) — v4.78.2: push do sync não sobrescrevia dados errados no Supabase após trocar de conta/pasta de dados

### O que aconteceu (relato do usuário)
Usuário, sem querer, tinha a "Pasta de dados" apontando pro banco de
teste ("Usuário Fake", criado numa sessão anterior pra tirar screenshots
da App Store) e digitou o e-mail/senha da conta REAL dele em
Configurações → App Mobile — isso empurrou os dados fake pro Supabase da
conta real. Ao voltar a pasta de dados pro banco real e logar de novo com
o mesmo e-mail/senha, esperando que o sync sobrescrevesse os dados fake
com os reais, **o sync não substituía nada** — os dados fake continuavam
lá.

### Causa raiz
`sync-push.js` usa um cache de hash por tabela (`_sync_hashes.json`,
salvo do lado do arquivo do banco local) pra não reenviar dados que não
mudaram desde o último push — otimização de egress. Esse cache só sabe
"os dados LOCAIS mudaram desde a última vez que ESTE banco local fez
push?" — ele não tem noção de qual conta Supabase (`user_id`) recebeu
aquele push. Sequência exata do bug:
1. Com a pasta de dados no banco fake, o push usa o hash-cache DAQUELE
   banco (arquivo físico diferente) — vazio/novo, então envia tudo pro
   Supabase da conta real.
2. Ao voltar a pasta de dados pro banco real, o push volta a usar o
   hash-cache DO BANCO REAL — que já existia de sincronizações
   anteriores (antes do imprevisto), com o hash dos dados reais.
3. Como os dados reais LOCAIS não mudaram desde a última vez que o banco
   real sincronizou (o problema todo aconteceu só com o banco fake), o
   hash bate → `hasChanged()` diz "nada mudou" → o push inteiro é
   pulado, silenciosamente — os dados fake continuam intactos no
   Supabase.

Esse bug pode acontecer com QUALQUER troca de identidade Supabase (troca
de pasta de dados, troca de usuário local do Desktop, ou até o "trocar de
usuário" do mobile implementado nesta mesma sessão) sempre que os dados
locais do lado que "volta" não tiverem mudado desde o último push
legítimo deles.

### Fix
`initHashCache(dbPath, userId)` (`sync-push.js`) agora recebe também o
`userId` (já disponível em `pushAll`, vem de `sb.getUserId()`) e guarda
esse id dentro do próprio cache (`_hashCache.__userId`). Se o `userId` do
push atual for diferente do que está gravado no cache (incluindo caches
antigos, de antes desse fix, que nunca guardaram `__userId` —
tratados como "diferente" por segurança), o cache inteiro é descartado
antes de continuar — força um reenvio completo de todas as tabelas, que
já sobrescreve (upsert) e limpa (`pruneNotIn`) qualquer resquício da
sincronização errada. Autocorretivo: não exige apagar arquivo nenhum
manualmente — a primeira sincronização depois de atualizar pra essa
versão já resolve sozinha.

### Arquivos tocados
`src/sync/sync-push.js` (`initHashCache`, chamada em `pushAll`).

---

## 2026-07-16 (continuação 14) — v4.78.1: trocar de usuário no mobile + bug crítico de sessão Supabase cruzada entre usuários locais do Desktop

### O que foi pedido
"O app mobile precisa permitir a troca de usuário (se o login tiver
múltiplos usuários) nas configurações (exigindo a senha quando
pertinente), e o sync precisa ocorrer sempre com o dado do usuário que se
logar (no desktop ou no mobile)."

### Mobile (iOS + Android — código compartilhado em app/ e src/)
`src/hooks/useAuth.js`: nova lista `knownAccounts` (só e-mails, NUNCA
senha/token, em `SecureStore` sob `cruzeiro_known_accounts`) de contas já
usadas neste aparelho. Não mantemos sessões paralelas em memória — trocar
de conta (`switchAccount(email, pwd)`) é sempre um `signOut()` limpo
(tranca a chave de criptografia, apaga a senha guardada, desativa
biometria da conta anterior) seguido de um `signIn()` novo, que SEMPRE
pede a senha de novo. Isso é deliberado: evita ter que gerenciar múltiplos
refresh tokens Supabase em paralelo (superfície de bug muito maior) e
garante que nenhum estado da conta anterior (regras de ML, config de IA,
chave de criptografia) sobrevive pra sessão nova, já que `loadUserData()`
dentro de `signIn()` recarrega tudo do zero.

`app/(tabs)/configuracoes.js`: card "Conta" ganhou lista "Trocar de
usuário" (contas conhecidas, exceto a atual, com botões Entrar/Esquecer) e
"+ Adicionar outra conta" — formulário inline reaproveitando os estilos já
usados pela edição da chave de IA.

Investigação prévia (sem bugs encontrados, documentada pra não repetir a
checagem): `_rules` (ml.js) e `_aiConfig` (ai.js) são caches em memória no
nível do módulo, mas já são sobrescritos a cada `loadUserData()`/`signIn`
— seguros. `_dataKey` (crypto-utils.js) já é travado por `lockDataKey()`
no `signOut()` existente — seguro. Sem AsyncStorage nem React Query no
projeto. Snapshot dos widgets de tela inicial é resetado na próxima vez
que a Home carrega após a troca (pode ficar 1-2s desatualizado até o app
reabrir — aceitável).

### Desktop — bug crítico encontrado durante a investigação (não fazia
### parte do pedido original, mas é exatamente o mesmo risco do lado desktop)

Ao investigar "o sync precisa ocorrer sempre com o dado do usuário que se
logar... no desktop", percebi que a troca de usuário LOCAL do Desktop
(`users:select`, feature da v4.78.0) tinha o mesmo problema estrutural:
duas variáveis de módulo ÚNICAS, compartilhadas por TODOS os usuários
locais do mesmo Desktop, nunca eram resetadas ao trocar de usuário:

1. **`sb._session`** (`sync/supabase-client.js`): se o usuário local pro
   qual você trocasse nunca tivesse configurado o sync mobile (sem
   `supabaseRefreshToken` salvo nas settings dele), `mainStartupFlow()`
   simplesmente pulava o bloco de restauração de sessão — e a sessão
   Supabase do usuário ANTERIOR ficava ativa. Qualquer sincronização
   disparada nesse estado escreveria os dados financeiros do usuário
   atual na conta Supabase de OUTRA PESSOA. Fix: novo `sb.clearSession()`
   (limpa só em memória, sem chamar o endpoint de logout — não queremos
   invalidar o refresh token do usuário anterior), chamado no início do
   handler `users:select`, antes de `mainStartupFlow()`.
2. **`_dbKey`/`_dbSalt`** (main.js — chave de criptografia do banco
   LOCAL): se o usuário anterior tinha o banco protegido por senha
   (`_dbKey` setado) e você trocasse para um usuário local cujo banco NÃO
   é criptografado, `initDB()` nunca resetava essas variáveis — o próximo
   `save()` criptografaria silenciosamente o banco em texto puro do novo
   usuário usando a CHAVE (e senha) de outra pessoa, tornando os dados
   dele inacessíveis pra ele mesmo. Fix: `initDB()` agora reseta
   `_dbKey = null; _dbSalt = null;` logo no início, antes de checar se o
   banco da conta atual está criptografado (se estiver, o fluxo de
   `_dbPendingDecrypt` já define uma chave nova e correta assim que a
   senha certa é informada).

Ambos os bugs só se manifestam com 2+ usuários locais no mesmo Desktop
(feature nova da v4.78.0) — não afetam quem usa um único usuário
"Principal", que é o caso da esmagadora maioria dos usuários atuais.

### Arquivos tocados
- `Cruzeiro iOS` / `Cruzeiro Android` (espelhados): `src/hooks/useAuth.js`,
  `app/(tabs)/configuracoes.js`.
- `Cruzeiro Desktop`: `src/sync/supabase-client.js` (`clearSession`),
  `src/main.js` (`initDB()`, handler `users:select`).

---

## 2026-07-16 (continuação 13) — v4.78.0: excluir usuário (multi-usuário do mesmo Desktop)

### O que foi pedido
"O app precisa permitir excluir um usuário criado (com 2 alertas sobre a
definitividade da exclusão). Só permite excluir o usuário que estiver
logado (para um usuário não excluir outro, sem a senha dele), e, ao
excluir, o app reinicia."

### Como funciona
- Botão "🗑 Excluir" só aparece na PRÓPRIA linha do usuário logado, na
  lista de usuários em Configurações (`renderUsersList()`, renderer.js
  ~17168) — para isso, `settings:get` (main.js) passou a incluir
  `currentUserId: _currentUserId` na resposta.
- `deleteUserPrompt()` (renderer.js ~17198): 2 `showConfirmDialog()`
  sequenciais avisando que a exclusão é permanente e irreversível; se o
  usuário tiver senha configurada, pede a senha via `showPasswordPrompt()`
  (com loop de nova tentativa em caso de senha errada); ao concluir,
  chama `ff.appRelaunch()` — reaproveita o handler `app:relaunch` já
  existente (usado pelo updater).
- `ipcMain.handle('users:delete', ...)` (main.js ~6172): recusa
  qualquer `id` diferente de `_currentUserId` (retorna erro sem apagar
  nada) — é a proteção contra um usuário excluir outro. Verifica a
  senha com a MESMA lógica já usada em `settings:set-password` (cobre
  tanto o modo legado `passwordHash` quanto o DB criptografado via
  `_dbKey`/`decryptDBWithPassword`). Se passar, chama
  `deleteUserDataFiles(id)` e remove o usuário do `_users_registry.json`
  (se não sobrar ninguém, apaga o registro inteiro — volta ao estado de
  instalação nova).
- `deleteUserDataFiles(id)` (main.js ~6172): apaga o banco e TODOS os
  arquivos "sidecar" desse usuário (categorias, senha de recuperação,
  backup de emergência, cache de hash do sync, etc. — todos derivados de
  `getDbPath()` com sufixos diferentes) usando o mesmo padrão de prefixo
  que `doBackup()` já usa pra não colidir entre usuários na mesma pasta
  (usuário nomeado: prefixo `cruzeiro_data_<id>`; usuário padrão:
  prefixo `cruzeiro_data` excluindo o que começa com `_usr_`, senão
  apagaria sidecars de outros usuários nomeados). **Backups (pasta
  separada) e `_import_pending.json` (arquivo global, sem sufixo de
  usuário) são deliberadamente preservados** — não são "identidade" do
  usuário, e apagar os backups tiraria a única rede de segurança em caso
  de exclusão por engano.

### Validação (CDP, contra o app real)
1. Criado usuário de teste sem senha, confirmado tentativa de excluí-lo
   estando logado como outro usuário → recusado corretamente
   (`"Só é possível excluir o usuário que está logado no momento."`),
   nada apagado.
2. Trocado para o usuário de teste (`users:select`), confirmado
   `settings:get().currentUserId` bate, excluído (`users:delete` →
   `ok:true`), confirmado via `users:list()` (de outra janela) que ele
   sumiu do registro.
3. Confirmado no disco que o `.db` do usuário de teste foi realmente
   apagado, e que os arquivos do usuário "Principal" (dados reais)
   ficaram intocados o tempo todo.
4. Observação: o app fica com estado inconsistente em memória
   (`_currentUserId` aponta pra um usuário que acabou de deixar de
   existir) até reiniciar — confirma que o `app.relaunch()` chamado
   pelo fluxo real (`deleteUserPrompt()`) é necessário, não só
   cosmético.
5. Edge case observado (não corrigido, impacto nulo): se a exclusão
   acontecer poucos segundos depois de logar num usuário novo, tarefas
   de fundo do `mainStartupFlow` ainda em andamento (fetch de índices
   de financiamento/benchmarks) podem recriar 1-2 arquivos json
   pequenos e órfãos DEPOIS da exclusão. Não afeta o banco de dados em
   si (que é sempre apagado com sucesso) e, no fluxo real, o
   `app.exit(0)` do relaunch mata o processo antes disso acontecer na
   prática (exclusão só é alcançável depois de navegar até
   Configurações, o que já dá tempo de sobra pras tarefas de fundo
   terminarem).

### Arquivos tocados
`src/main.js` (`settings:get`, `deleteUserDataFiles`, `users:delete`),
`src/preload.js` (`usersDelete`), `src/renderer.js`
(`renderUsersList`, `deleteUserPrompt`).

---

## 2026-07-16 (continuação 12) — v4.77.6: transferência criada a partir de "Nova Transação" travava o modal e duplicava a transferência a cada clique

### Causa raiz (2 bugs compostos)
Usuário relatou: cria uma transação, escolhe categoria "⇄ Transferência:
X", o modal de transferência abre, ao clicar em "Registrar" o modal não
some; repetindo o clique algumas vezes e desistindo, o app tinha criado
várias transferências idênticas (uma por clique).

1. **Bug principal (o que realmente causava a duplicação)**:
   `saveTransfer()` (renderer.js) já criava a transferência de verdade
   via `ff.transfer()` com sucesso, mas em seguida crashava com
   `TypeError: Cannot read properties of null` na checagem
   `G('tr-import-row-idx')?.value !== ''` — o campo `tr-import-row-idx`
   só existe no DOM depois que `openTransferFromImportRow()` roda pelo
   menos uma vez na sessão (não existe estático no HTML); antes disso
   `G(...)` retorna `null`, e `null?.value` vira `undefined`, que é
   `!== ''` → entra no bloco e crasha em `importIdxField.value` (sem
   `?.`) na linha seguinte. Como o crash acontecia DEPOIS do
   `ff.transfer()` já ter sido concluído mas ANTES do
   `toast()`/`closeModal('modal-transfer')`, o modal ficava
   visualmente "preso" aberto e o botão voltava a ficar clicável (reset
   no `finally`) — cada novo clique em "Registrar" criava uma
   transferência real adicional, pois nada impedia uma nova tentativa
   limpa. Fix: `if (importIdxField && importIdxField.value !== '')`.
2. **Bug secundário (contribuía pra confusão visual)**: ao abrir o
   modal de transferência a partir do campo de categoria de "Novo
   Lançamento" (`openTransferFromCat`), o modal "Novo Lançamento"
   (`modal-tx`) nunca era fechado — ficava aberto por baixo, mesmo
   z-index. Ao fechar o modal de transferência (por sucesso ou
   Cancelar), o "Novo Lançamento" reaparecia sozinho, ainda com
   data/memo/valor preenchidos e a categoria mostrando o texto literal
   "⇄ Transferência: X" — se o usuário salvasse esse formulário por
   engano, criava um lançamento "fantasma" com essa categoria literal.
   Fix: `openTransferFromCat` agora fecha `modal-tx` (sem os efeitos
   colaterais de `closeModal()`, como interromper a fila de "Lançar com
   IA") antes de abrir `modal-transfer`, e ele não reabre sozinho.

### Arquivos/funções tocadas
- `src/renderer.js`: `saveTransfer()` (~3661) — null-check corrigido;
  `openTransferFromCat()` (~12578) — fecha `modal-tx` antes de abrir
  `modal-transfer`.

### Validação
Testado ao vivo via CDP: `openTxModal()` → preencher
data/memo/valor → `pickGlobalCat('⇄ Transferência: <conta>')` →
`saveTransfer()`. Confirmado: `modal-tx` fecha ao escolher a
categoria, `modal-transfer` fecha sozinho após salvar (sem crash),
exatamente 1 par de transações de transferência criado (2 linhas,
mesmo `transfer_id`), nenhum lançamento com categoria literal
"⇄ Transferência: ..." criado.

---

## 2026-07-16 (continuação 11) — v4.77.5: "substituir provisão" duplicava lançamento quando a provisão já estava conferida

### Causa raiz
Usuário identificou o padrão exato: ao importar um extrato, quando o
app detecta que uma linha bate com uma provisão de recorrência (ainda
não conferida) e o usuário confirma "🔄 Substituir provisão", o
backend (`bank:import`) tenta apagar a provisão antes de inserir a
transação real. Um fix de sessão anterior já detectava quando esse
DELETE não apagava nada (`db.getRowsModified() === 0` — ex: a provisão
já tinha sido conferida nesse meio-tempo, protegida contra exclusão, OU
já tinha sido regenerada com outro id), mas só logava um aviso no
console — a transação nova era inserida DO MESMO JEITO, ficando
duplicada ao lado da provisão antiga (agora órfã, já conferida).

### Fix
`bank:import` (main.js): `replaceIds` e `rows` são arrays PARALELOS
(mesmo índice — ver `applyDirectReplacements` no renderer, que monta os
dois juntos). Agora, quando o DELETE de um `replaceIds[k]` não apaga
nada, a linha correspondente `rows[k]` é EXCLUÍDA da inserção (via
`toInsertFiltered`), em vez de só logar um aviso — evita a duplicata na
origem. O resultado retorna um novo campo `blockedByReplace` (data/
memo/valor de cada linha bloqueada), e o renderer agora mostra um
diálogo explicando ao usuário quais linhas não foram importadas e por
quê (antes ficava silencioso — pareceria que a importação "esqueceu"
essas linhas sem explicação).

Validado ao vivo via IPC direto: um lançamento recorrente já conferido
(`cleared=1`) usado como alvo de "substituir" — antes do fix teria
duplicado; depois do fix, `inserted:0`, `blockedByReplace` populado
corretamente, contagem de transações da conta inalterada, transação
original intocada.

### Publicação
Versão 4.77.4 → 4.77.5 (patch — bug crítico de dados). Arquivos:
`src/main.js`, `src/renderer.js`.

---

## 2026-07-16 (continuação 10) — v4.77.4: card "Despesas vs. planejado" da Visão Geral divergindo do Orçamento + prep Windows Store

### Card "📉 Despesas vs. planejado" (Visão Geral) com o mesmo bug já corrigido no Orçamento
`renderDashBudgetGauges` (renderer.js) tinha DOIS problemas que faziam
esse gauge divergir do gráfico/tabela da aba Orçamento pra mesma
categoria/mês:
1. `totalExpensePlanned` usava `effLimitOf(b)` (soma rollover ao
   planejado) — a regra em toda a aba Orçamento é % sempre contra o
   planejado MENSAL puro, rollover é exibido à parte, nunca somado
   (mesmo bug já corrigido nos gráficos do Orçamento, task anterior
   desta sessão).
2. `actualFor` só somava `d.expenses` bruto — sem descontar
   `d.income` (estornos/receita lançada na mesma categoria) — todo
   resto do app usa o líquido (`expenses - income`).
Corrigido: agora usa `b.monthly_limit` puro pro planejado e
`actualFor` líquido (mesma fórmula da aba Orçamento). Validado ao
vivo: os dois lugares agora mostram exatamente "R$ 54.834,74 de
R$ 86.800,00 (63%)" pra despesas.

### Preparação pra distribuição na Microsoft Store (Windows)
Usuário confirmou (após pesquisa) que a Microsoft Store NÃO exige
certificado de assinatura próprio (a Microsoft assina o pacote na
certificação) e aceita conta de desenvolvedor Individual sem CNPJ.
Adicionado suporte a build MSIX/AppX:
- `package.json`: bloco `build.appx` com identidade placeholder
  (`identityName`/`publisher`/`publisherDisplayName` — usuário precisa
  preencher com os valores reais depois de reservar o nome "Cruzeiro"
  no Partner Center). Novo script `build:winstore`
  (`electron-builder --win appx`).
- IMPORTANTE: `appx` NÃO foi adicionado à lista `win.target` (que seria
  usada por `publish:win`/CI a cada release) — isso quebraria o build
  de produção atual (.exe via GitHub Actions) tentando gerar o pacote
  da Store com identidade placeholder a cada tag. O build da Store só
  roda via `build:winstore`, isolado, quando explicitamente invocado.
- Testado localmente: pipeline de geração do AppX funciona (ícone,
  empacotamento, manifesto) até a etapa de assinatura — falta (a) a
  identidade real do Partner Center e (b) o "Modo de Desenvolvedor" do
  Windows ativado nesta máquina (o `makeappx.exe` vem dentro de um
  pacote com links simbólicos, que o Windows só extrai com essa
  permissão). Usuário sem documento físico pra verificação de
  identidade no momento — pausado, retomar quando disponível.

### Publicação
Versão 4.77.3 → 4.77.4 (patch). Arquivos: `src/renderer.js`,
`package.json`.

---

## 2026-07-16 (continuação 9) — v4.77.3: bug crítico no orçamento mobile (budget_type nunca sincronizado) + throttle 1x/sessão

### `budget_type` nunca era enviado ao Supabase — bug crítico na aba Orçamento mobile
Usuário reportou: total planejado de despesas no mobile mostrando
R$208.800 (desktop mostra corretamente R$86.800), e categorias de
receita (Salário, Renda Financeira) sempre em 0%. Causa raiz:
`pushBudgets` (sync-push.js) nunca incluía o campo `budget_type` na
linha enviada — mesmo o código do mobile já esperando esse campo há
tempo (comentário em `orcamento.js`: "O sync v2 envia também metas de
RECEITA (budget_type='income')"). Sem esse campo, TODO orçamento
(receita ou despesa) era tratado como despesa no mobile:
- `expenseBudgets = budgets.filter(b => b.budget_type !== 'income')` —
  como `budget_type` vinha `undefined`, a condição `undefined !== 'income'`
  é sempre verdadeira, então orçamentos de receita entravam na lista de
  despesas.
- Total planejado somava despesas (R$86.800) + receitas (R$122.000) =
  R$208.800 — bateu exatamente com o valor errado reportado.
- `incomeBudgets` ficava sempre vazio (nunca via `budget_type==='income'`),
  então a seção "Receitas" nunca aparecia.
- Um segundo bug na mesma função: `spentForBudget` sempre calculava
  `Math.max(0, spent-received)`, fórmula correta só pra despesa — pra
  receita (spent baixo, received alto) isso sempre dava 0, explicando
  o "0%" em Salário/Renda Financeira mesmo se o campo fosse corrigido.

Corrigido: `pushBudgets` agora envia `budget_type: b.type || 'expense'`,
e `spentForBudget` ficou type-aware (`received-spent` pra receita,
`spent-received` pra despesa, igual ao `actualFor` do desktop). Validado
com simulação direta contra o banco real antes de publicar — valores de
"Contas" (R$10.861,28) e "Educação" (R$9.719,69) batendo com o desktop;
os valores divergentes que o usuário via (R$2.507,08 e R$19.439,38,
respectivamente) eram dado obsoleto no Supabase de antes deste fix — o
push desta versão já força a correção (hash mudou, reenvio automático).

### Mobile: card do topo da aba Orçamento agora mostra receitas também
`orcamento.js` (Android + iOS): hero card antes só mostrava %/total de
despesas. Adicionado bloco "Receitas" (rótulo, % e "recebido de
planejado") no mesmo card, abaixo do de despesas — a separação
receita/despesa nas categorias abaixo já existia no código mas nunca
funcionava por causa do bug de `budget_type` acima.

### Mobile: throttle de 20s trocado por "1x por sessão"
Discussão com o usuário sobre egress: como o desktop só sincroniza no
abrir/fechar/clique manual (nunca continuamente), o cooldown de 20s nas
telas mobile (Home, Conta, Configurações, Evolução, Metas, Orçamento)
quase nunca trazia dado realmente novo — só repetia leitura. Trocado
por "carrega 1x por sessão do app" (recarrega só em mutação própria ou
pull-to-refresh manual), reduzindo egress sem perder a atualização
imediata após uma ação do usuário no próprio app.

### Decisão registrada: diff por linha no push NÃO reduz egress
Usuário sugeriu diff por linha (evitar reenviar tabela inteira a cada
edição pontual) como próximo passo de egress. Investigação: o `upsert`
do desktop já usa `Prefer: return=minimal` — a resposta do Supabase já
é praticamente vazia independente do tamanho do payload enviado. Egress
(dado que SAI do Supabase) vem das LEITURAS (`select`), não das
escritas — então diff por linha no push não teria efeito relevante no
egress medido. Adiado (task registrada, sem prioridade imediata).

### Publicação
Versão 4.77.2 → 4.77.3 (patch — inclui um bug crítico de dados, por
isso não é minor apesar de mexer em bastante coisa). Arquivo:
`src/sync/sync-push.js`. Mobile (Android/iOS): `app/(tabs)/orcamento.js`,
`app/(tabs)/index.js`, `app/conta/[name].js`, `app/(tabs)/configuracoes.js`,
`app/(tabs)/evolucao.js`, `app/(tabs)/metas.js` — publicado via
`eas update --branch production`.

---

## 2026-07-15 (continuação 8) — v4.77.2: reduz egress do Supabase (horizonte de 60 dias em `mobile_scheduled`)

### Contexto
Usuário reportou egress do Supabase ainda alto (440MB/dia, depois
177MB/dia) mesmo após otimizações anteriores. Investigação (agente
Explore) identificou a causa principal: `pushScheduled` (sync-push.js)
enviava TODAS as transações futuras sem limite de data — e a
materialização de parcelas de financiamento/mútuo cria uma linha de
`transactions` por mês do CONTRATO INTEIRO (um financiamento de 30 anos
gera ~360 linhas futuras). Toda essa massa de dados ia pro Supabase a
cada sync do desktop, mesmo o mobile só precisando mostrar um horizonte
curto de "o que vem por aí".

### Fix: horizonte de 60 dias em `pushScheduled`
`src/sync/sync-push.js`, `pushScheduled`: query agora tem
`AND t.date <= ?` (hoje + 60 dias), além do `date > hoje` que já
existia. `pruneNotIn` (já existente) cuida de remover do Supabase
qualquer linha que saia da janela de 60 dias em syncs futuros. Testado
contra o banco real: de 230 lançamentos futuros sem limite pra 123 com
o corte de 60 dias — ~46% de redução só nessa tabela, ainda maior em
contas com financiamentos de prazo mais longo.

### Legendas explicando os limites de sincronização (mobile)
Pra não parecer que dados "sumiram", adicionadas legendas explicando os
cortes temporais já existentes:
- `app/conta/[name].js` (Android + iOS): aba "Futuros" da tela de conta
  ganhou a legenda "Mostrando os próximos 60 dias — lançamentos futuros
  mais distantes ficam só no desktop." (novo estilo `syncHint`).
- `app/(tabs)/evolucao.js` (Android + iOS): complementado o disclaimer
  já existente (sobre valores nominais/sem IPCA) com uma linha sobre o
  corte de 12 meses já em vigor (`pushEvolution` — ver changelog de
  sessões anteriores).

### Não implementado nesta rodada (registrado como pendente)
Segunda otimização discutida mas ainda não feita: o push usa hash da
tabela inteira pra detectar mudança (`hasChanged`), então uma edição
pontual tende a reenviar `balances`/`budgets`/`goals`/`evolution`
completos de novo, não só a linha alterada. Diffing por linha reduziria
egress ainda mais, mas é uma mudança de arquitetura maior — avaliar se
ainda é necessária depois de medir o efeito do fix desta versão.
Migração pra Supabase Realtime (task #11 da lista do projeto) segue
como alternativa de mais longo prazo, ainda não iniciada.

### Publicação
Versão 4.77.1 → 4.77.2 (patch). Arquivo: `src/sync/sync-push.js`.
Mobile (Android/iOS, mesmo commit lógico nos dois): `app/conta/[name].js`,
`app/(tabs)/evolucao.js` — publicado via `eas update --branch production`
(OTA, sem novo build).

---

## 2026-07-15 (continuação 7) — v4.77.1: lista de ML truncada, seleção em linhas futuras, gráficos de orçamento com rollover vazando

### Aba Aprendizado ML mostrando bem menos regras que o total
O card de estatísticas no topo já mostrava a contagem certa
(`rules.length`), mas a listagem por grupo de confiança (alta/média/
baixa) tinha um `.slice(0,20)` hardcoded — cada grupo só renderizava as
20 primeiras regras, mesmo quando existiam muito mais. Removido o corte;
a lista agora mostra todas as regras de cada grupo.

### Seleção de transação não iluminava linhas "futuras"
Achado ao investigar o relato de que Ctrl+clique pra multi-seleção
"conta certo mas não ilumina": `table.ledger tbody tr.future td` e
`table.ledger tbody tr.selected td` (CSS) têm a MESMA especificidade —
empatadas, vence quem vem depois no arquivo, e `.future` vem depois de
`.selected`. Resultado: qualquer linha futura (recorrência ainda não
realizada — maioria numa conta com muitas recorrências) que fosse
selecionada nunca ficava azul, mesmo com a seleção logicamente correta
(contador certo, exclusão funcionando). Adicionada uma regra mais
específica `tr.future.selected td` que sempre vence as duas de cima,
independente da ordem no arquivo. Validado ao vivo via CDP: antes do
fix, linha futura selecionada tinha fundo cinza (`--future-bg`); depois,
fundo azul (`--accent-lt`) como qualquer outra linha selecionada.
(A investigação também confirmou, via simulação de Ctrl realista com
Input.dispatchKeyEvent segurando a tecla, que o mecanismo de
multi-seleção em si já estava correto desde o fix anterior — o problema
era só essa colisão de CSS.)

### Gráficos do Orçamento usavam planejamento COM rollover (tabela usa sem)
Bug introduzido pela própria feature de gráficos desta sessão: a tabela
de Orçamento (`renderBudgetTable`/`catRow`) sempre calcula o "% atual"
contra `b.monthly_limit` puro, de propósito — rollover é tratado como
extra à parte, nunca somado no denominador do percentual (comentário já
existente no código explicando essa decisão). Os gráficos novos
(`renderBudgetSingleMonth`), porém, usavam `effLimitOf(b)` (que inclui o
rollover) — fazendo o % de uma categoria com rollover ativo divergir
entre tabela e gráfico pra mesma categoria/mês. Corrigido: gráficos
agora usam `b.monthly_limit` puro também, igual à tabela. Validado ao
vivo comparando a categoria "Carro" (rollover ativo): 4% em ambas as
visões após o fix.

### Decisão registrada: `npm run clean-data` NÃO roda antes de publicar
O usuário pediu inicialmente pra rodar `clean-data` antes de toda
publicação (medo de dados pessoais irem no build). Investigação:
`build.files` no `package.json` (electron-builder) é uma allowlist
explícita que não inclui a raiz do projeto onde ficam os dados, esses
arquivos já estão no `.gitignore`, e o build de verdade roda via GitHub
Actions com clone limpo — não há caminho real de vazamento. Como esta
máquina usa o banco de dados REAL do usuário no dia a dia, rodar
`clean-data` aqui apagaria dados reais pra proteger contra um risco que
não existe. Decisão do usuário, ao ser confrontado com essa análise: não
rodar automaticamente (ver memória permanente salva sobre isso).

### Publicação
Versão 4.77.0 → 4.77.1 (patch — só correções de bug). Arquivos:
`src/index.html`, `src/renderer.js`.

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
