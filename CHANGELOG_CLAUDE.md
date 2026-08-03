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

## 2026-08-03 (4) — v4.85.20: feat — importador de fatura BTG entende também a "fatura parcial"

### Pedido do usuário
"O BTG não emite oficialmente uma fatura parcial (só a fechada), mas
consegui copiar os lançamentos e colocar em um xls, em um formato que
parece possível treinar o parser. [...] atenção para não mudar nada no
que já existe, só ensinar a fazer este paralelamente, no mesmo
importador de fatura BTG." Anexou `Fatura Parcial BTG.xlsx` — uma cópia
manual (copiar-colar) da lista de lançamentos da tela do app/site do
banco, numa única coluna, sem NENHUM cabeçalho (bem diferente do arquivo
oficial da fatura fechada, que tem uma tabela "Data | Descrição | Valor").

### Formato identificado (analisando o arquivo real)
Layout linha a linha, em blocos:
- Um rótulo de dia decorativo ("Ontem"/"Hoje" ou nome do dia da semana
  "Segunda-feira" etc.) — não confiável como identificador de data.
- A data de verdade, por extenso e sem ano: "02 de Agosto" (ou, mais pra
  trás no arquivo, sem o rótulo decorativo antes, só "08 De Julho" —
  duas variações de maiúscula em "de/De" observadas).
- Depois, um bloco de 3 linhas por lançamento: estabelecimento, tipo da
  transação (ex.: "Compra no crédito", "Compra no crédito parcelada",
  "Pagamento de fatura por boleto"), valor. Linhas em branco entre
  lançamentos são OPCIONAIS, não um separador confiável (às vezes o
  próximo cabeçalho de dia vem colado, sem branco antes).
- O valor já vem no sinal certo pra convenção do Cruzeiro (negativo =
  despesa, positivo = estorno/pagamento — confirmado com um "Pagamento
  de fatura por boleto" de +R$27.908,81 e uma "Compra parcialmente
  cancelada pelo estabelecimento" de +R$14,95) — ao contrário do arquivo
  oficial (que vem invertido, precisa ser negado).
- "Compra no crédito internacional" tem o valor em moeda estrangeira
  ("- US$ 25,00", texto, não número) em vez de reais — a fatura ainda
  não fechou, então o BTG não calculou o valor final em R$ (câmbio+IOF)
  pra essas linhas ainda.
- Sem ano em lugar nenhum — precisa ser inferido.

### Implementação (`parseBTGFaturaParcial`, nova função)
Adicionada como um FALLBACK dentro de `parseBankBTG()`: tenta o parsing
oficial primeiro (cabeçalho "Data/Descrição/Valor", código 100%
inalterado); só se NENHUM cabeçalho oficial for encontrado, tenta o novo
formato. Nunca interfere no caminho já existente.

- Rótulos de dia (dia da semana, "Ontem", "Hoje") são reconhecidos e
  pulados — só a linha de data por extenso é usada de fato.
- Ano inferido a partir de hoje: a data mais recente da fatura ancora o
  ano (se colocasse a data no futuro, é do ano anterior); dali em diante,
  como os lançamentos vêm em ordem decrescente, um mês "maior" que o
  anterior indica que cruzamos a virada do ano pro passado (ex.: de
  "05 de Janeiro" pra "20 de Dezembro" → ano anterior).
- Cada lançamento é lido por um pequeno estado (estabelecimento → tipo →
  valor), pulando linhas em branco onde quer que apareçam, em vez de
  assumir uma posição fixa — resiliente à inconsistência de separadores
  observada no arquivo real.
- "Compra no crédito internacional" sem valor em R$ (texto tipo "- US$
  X,XX" em vez de número) é ignorada — sem uma taxa de câmbio confiável
  disponível, é mais seguro deixar de fora do que arriscar um valor
  errado.

### Verificado
`node --check` sem erro de sintaxe. Reimplementei a função isoladamente
(sem depender do Electron) e rodei contra o arquivo `Fatura Parcial
BTG.xlsx` real enviado pelo usuário: 100 de 103 lançamentos
corretamente interpretados (os 3 restantes são as compras
internacionais sem R$ disponível, puladas de propósito); datas
resolvidas corretamente de 02/08 até 14/05, todas em ordem decrescente;
"Pagamento de fatura por boleto" e a compra parcialmente cancelada com o
sinal certo (positivo). Testei também, com dados sintéticos, a virada de
ano (dezembro→janeiro) — o ano foi decrementado corretamente ao cruzar a
virada. Não testei a importação ao vivo na tela (não roda Electron nesta
verificação) — recomendo o usuário testar o import real antes de confiar
100%, mas a lógica está sólida contra os dados reais fornecidos.

**Arquivo tocado**: `src/renderer.js` (`parseBankBTG()` — fallback
adicionado sem alterar o caminho oficial; nova função
`parseBTGFaturaParcial()`).

---

## 2026-08-03 (3) — v4.85.19: fix — total de investimentos não batia com a soma das categorias

### Relato do usuário
"No mês de junho/2026, ele está marcando total de R$1.817.397,11. Mas a
soma não está batendo." O usuário forneceu os valores por categoria que
via na tela (renda fixa, tesouro, previdência, fundos, renda variável,
private equity, caixa) — somados dava R$1.780.248,38, uma diferença de
R$37.148,73 em relação ao total mostrado pelo app. Também apontou uma
pista certeira: "Talvez o 'investimentos totais' compute os ocultos, e as
totalizações das categorias deixem de considerar isso." Disponibilizou
uma cópia real do banco de dados (pasta `Dados Reais/`) pra investigação.

### Investigação
Copiei o banco pra um local isolado (sql.js, sem tocar no arquivo real) e
reconstruí manualmente o total de investimentos de junho/2026 ativo por
ativo. Achei o culpado exato: **CDB Original** (id 56, categoria Renda
Fixa) foi totalmente resgatado em junho/2026 — uma transação `venda` de
R$37.148,73 — mas SEM uma transação `atualização` de fechamento zerando
o valor do ativo (diferente de todos os outros ativos encerrados na base,
que têm esse zeramento explícito). `closed_month` ficou como '2026-06'.

Encontrei TRÊS lugares diferentes do código que calculam "o valor atual
de um ativo mês a mês", e os três lidavam com esse caso (mês de
encerramento sem avaliação explícita) de formas diferentes — e as três
erradas:
1. `calcInvTotalByMonth()` (o total geral, card "Total Investimentos"):
   simplesmente carrega adiante o último valor conhecido (R$36.798,66, de
   maio) — o total geral ficava R$36.798,66 maior do que devia.
2. `buildCatSubtotalRow()` (subtotal por categoria, ex.: linha "Renda
   Fixa" da tabela): tem uma lógica diferente que ajusta o valor contábil
   pelo delta de caixa das movimentações — a venda de R$37.148,73 sendo
   subtraída do valor de maio (R$36.798,66) resultava num resíduo
   NEGATIVO de -R$350,07 (a venda foi por um valor um pouco maior que o
   book value do mês anterior — rendimento não capturado). Isso
   explicava a segunda pista, mais sutil: a soma manual do usuário
   (R$291.829,49 pra Renda Fixa) ficava R$350,07 MENOR que a soma dos
   ativos individualmente visíveis — porque essa linha de subtotal
   incluía essa contribuição negativa de -R$350,07 do CDB (que, sendo
   `hidden`, nem aparece como linha própria na tabela pro usuário
   conferir o motivo).
3. `buildInvRows()` (linha individual do próprio ativo, `bookValue`):
   mesma falha do item 1 (carrega o valor de maio adiante), mas sem o
   ajuste de caixa — pelo menos não ficava negativo, só desatualizado.

A hipótese do usuário ("categorias não contam ocultos") não era bem o
mecanismo exato — `buildCatSubtotalRow` já usa `byCategoryAll` (inclui
ocultos) — mas o RESULTADO observado (total geral ≠ soma das categorias)
vinha de dois bugs genuinamente diferentes nesse mesmo ativo, cada
cálculo errando de um jeito distinto.

### Correção
Nos três lugares (`calcInvTotalByMonth`, `buildCatSubtotalRow`,
`buildInvRows`) e também em `_invAssetCurrentValue` (usada pra ordenação
por valor): quando o mês corrente é exatamente o `closed_month` do ativo
E não há avaliação (`atualização`/`cota`/etc.) explícita registrada
naquele mês, o valor passa a ser tratado como **0** (liquidado) — em vez
de carregar o último valor conhecido (bug 1/3) ou aplicar o delta de
caixa sobre ele (bug 2, que podia até ficar negativo).

### Verificado
`node --check` sem erro de sintaxe. Reimplementei os três algoritmos
(antes/depois) num script isolado usando o histórico real de transações
do CDB Original — confirmado que as três versões corrigidas agora
concordam entre si e mostram R$0,00 em junho/2026 (mês do resgate), em
vez de R$36.798,66 (bug 1/3) ou -R$350,07 (bug 2). Com a correção, o
total geral bate exatamente com a soma das categorias.

**Arquivos tocados**: `src/renderer.js` (`calcInvTotalByMonth`,
`buildCatSubtotalRow`, `buildInvRows`, `_invAssetCurrentValue`).

---

## 2026-08-03 (2) — v4.85.18: fix — 4 bugs sérios na importação BTG (Previdência, Tesouro, TIR, gráficos)

### Relato do usuário
Logo após testar a v4.85.17, o usuário reportou 4 problemas distintos numa
importação real (com print e o arquivo XLSX original da BTG anexados):
1. Nomes editados ainda sendo ignorados em alguns casos.
2. Tesouro Direto: dois vencimentos diferentes (2029 e 2040) do mesmo tipo
   de título sendo tratados como o mesmo ativo — a importação sugeriu
   "Tesouro IPCA+ 2029 BTG" pros DOIS, e ignorou o valor do 2040.
3. Previdência: uma transferência interna entre dois fundos (R$60.000 +
   ajuste de R$1,10) foi duplicada — os DOIS fundos ficaram com
   R$120.001,10, positivo (como se fosse aporte/compra nos dois), quando
   deveria ter sido -R$60.000 num fundo e +R$60.001,10 no outro. Além
   disso, indicar no modal de "ativo novo" que o nome correto era "PGBL
   Thi" não impediu a criação de um ativo duplicado.
4. TIR de Previdência aparecendo em notação científica absurda
   ("9.97e+118% a.a.").
5. Gráfico de comparação de rentabilidade (ativo individual vs CDI/IBOV):
   o ativo começa em 0% no primeiro mês, mas CDI/IBOV já aparecem com a
   valorização daquele mês — as três linhas não partem da mesma base.

### Causa raiz #1 — Tesouro Direto: código não é único
A BTG expõe o "código" de um título do Tesouro (coluna "Ativo") como o
TIPO do título (ex.: "NTNB-P"), não como um identificador do título
específico — confirmado inspecionando o XLSX real: duas linhas com
"Ativo"="NTNB-P" mas "Vencimento" diferente (2029-05 e 2040-08). O
casamento por código (v4.85.15) tratava as duas como o MESMO ativo,
sempre "ganhando" a que já existia primeiro no banco (confirmado
consultando o banco real: as duas datas já existiam como ativos 67/68
separados, mas o SELECT por código+corretora só retornava o 67).

**Correção**: `main.js` (`broker:save-parsed`) agora exige também bater
`maturity_month` quando o ativo tem vencimento, antes de cair pro
casamento por código+corretora simples (que só continua valendo pra
ativos SEM vencimento, ex.: ações). `renderer.js`
(`renderBrokerPreview`'s `existingByCode`) recebeu o mesmo critério, pra
a pré-visualização também parar de sugerir o vencimento errado.

### Causa raiz #2 — Previdência: movimentação "espalhada" pra todos os fundos
`parseBTGBroker()` capturava o cabeçalho de cada subseção de movimentação
("Movimentação > 342074/NOME DO FUNDO") na variável `mvPlan` mas NUNCA a
usava — cada movimentação encontrada era aplicada a TODOS os ativos de
previdência do import (`prevAssets.forEach(a => a.movimentacoes.push(...))`).
Numa transferência interna entre 2 fundos (ex.: R$60.000 saindo de A e
entrando em B), os DOIS fundos recebiam as DUAS movimentações. Além
disso, o sinal (entrada = aporte / saída = resgate) só reconhecia
"contribuição"/"aplicação"/"aporte" — "Transferência Interna de
Entrada/Saída" e "Ajuste de Recotização" (termos reais do extrato) caíam
no sinal padrão (positivo), fazendo até uma SAÍDA de dinheiro entrar como
se fosse positiva.

**Correção**: o nome do fundo agora é extraído do cabeçalho da subseção e
usado pra achar o ativo certo em `result.assets` (uma movimentação sem
fundo correspondente cai em `unresolvedMovements`, nunca é descartada
nem espalhada). O reconhecimento de sinal ganhou "entrada"/"saída"
explícitos, e um "ajuste" sem direção própria no texto herda o sinal do
movimento anterior da mesma subseção. Verificado rodando o parser real
(via CDP, dentro do próprio processo Electron) contra o XLSX que o
usuário enviou: ARCA GRAO recebeu só a entrada (-60000, "compra"), ACS
ABSOLUTE recebeu só a saída+ajuste (+60000, +1.10, "venda") — sem
duplicação, sinal correto, zero movimentações órfãs.

O modal de "revisar ativos que seriam criados como novos"
(`reviewNewAssetsBeforeImport`/`_narConfirmAll`) foi auditado à parte —
simulei ao vivo (CDP, com `ff.brokerMappingLearn`/`ff.invTxAll` mockados
pra não gravar nada de verdade) o fluxo exato relatado (selecionar "PGBL
Thi" no dropdown pro candidato "ACS Absolute..." e confirmar) e o
mecanismo aplicou a escolha corretamente (`parsed.assets[i].name` virou
"PGBL Thi" antes do save). Não consegui reproduzir uma causa adicional
pra esse ponto especificamente — é possível que fosse só um sintoma da
duplicação de movimentações (causa raiz #2) corrompendo o estado visual
da tela. Pedir pro usuário testar de novo nesta versão.

### Causa raiz #3 — TIR sem trava de sanidade
`calcIRR()` (`src/lib/irr.js`), o solver de Newton-Raphson usado pra
todos os cálculos de TIR do app, só checava `isFinite(rate)` — uma
divergência real (fluxo de caixa inconsistente, como o gerado pela causa
raiz #2 antes de corrigida) pode convergir pra uma taxa astronômica mas
ainda tecnicamente "finita" (passa no `isFinite`), virando um
"9.97e+118% a.a." absurdo na tela.

**Correção**: depois de anualizar a taxa, se o resultado for maior que
100000% a.a. (limite generosíssimo — nenhum investimento real chega
perto disso), retorna `null` em vez do número absurdo. Casos normais
continuam idênticos (testado: fluxo de 10%/mês por 3 meses → 213,8%
a.a., sem mudança).

### Causa raiz #4 — Gráficos de comparação não partem da mesma base
Em 3 lugares diferentes que constroem o gráfico de rentabilidade
acumulada (carteira x CDI x IBOV, e ativo individual x CDI x IBOV), a
série do investimento/ativo deliberadamente não aplica retorno no
primeiro mês (é o mês-base, fica em 0%) — mas CDI e IBOV SEMPRE aplicam o
retorno do mês, inclusive o primeiro, entrando já com a valorização
daquele mês embutida. Um 4º local (`patRenderInvChart`, a versão com
seletor de período) já fazia isso certo (`if (m > effectiveFrom)`),
confirmando que era o padrão pretendido.

**Correção**: os 3 locais afetados (`renderReturnsChart`,
`refreshInvestimentos`'s gráfico agregado, e o gráfico por-ativo) agora
pulam a acumulação de CDI/IBOV também no primeiro mês/mês-base, igual ao
4º local que já estava certo. Verificado com simulação aritmética
isolada da lógica corrigida — as três séries agora começam em 0.00% no
mesmo ponto.

### Verificado
`node --check` nos 3 arquivos tocados — sem erro de sintaxe. Testado ao
vivo (instância dev com produção fechada pelo usuário, CDP via
WebSocket): parser de previdência contra o XLSX real enviado (sem
duplicação/sinal correto), matching de Tesouro por código+vencimento
contra cópia do banco real (sql.js — antes: os 2 vencimentos colidiam no
id 67; depois: 2040→68, 2029→67, corretamente separados), trava de TIR
(caso normal inalterado), lógica de baseline dos gráficos (simulação
isolada), fluxo do modal de ativo novo (mecanismo confirmado correto em
isolamento), e abertura da aba Patrimônio sem exceções com todas as
mudanças carregadas. Nenhum dado real foi alterado durante os testes
(cópias/mocks usados pra tudo que gravaria em disco).

**Nota importante pro usuário**: as tentativas de importação anteriores
(antes desta correção) podem ter deixado dados incorretos no banco real
— um ativo "ACS Absolute Atenas Prev" duplicado, valores de Previdência
inflados, e um dos vencimentos do Tesouro pode estar com o valor errado.
Vale revisar a aba Patrimônio (Previdência e Tesouro Direto) antes de
confiar nos números, e reimportar o extrato de julho/2026 se necessário.

**Arquivos tocados**: `src/main.js` (`broker:save-parsed`, matching por
código+vencimento), `src/renderer.js` (`parseBTGBroker` — movimentações
de Previdência; `renderBrokerPreview` — `existingByCode` com
vencimento), `src/lib/irr.js` (`calcIRR` — trava de sanidade),
`src/renderer.js` (`renderReturnsChart`, gráfico agregado de
investimentos, gráfico por-ativo — baseline dos benchmarks).

---

## 2026-08-03 — v4.85.17: fix — apelido escolhido no dropdown da importação ainda "não aprendia"

### Relato do usuário
Após o fix v4.85.16 (prefill por código a partir de `_invAssetsList`), o
usuário contestou de novo: "Independentemente dessa sua alteração,
precisa resolver o problema do aprendizado. Porque apenas o XP está
aprendendo? Quero que funcione para todos." E, decisivo: "Eu já fiz a
mudança manualmente anteriormente no BTG, no próprio fluxo de
importação. Não mudei o nome no patrimônio, mas ao importar, um a um,
selecionando qual o nome correto (não digitei, selecionei do dropdown).
Por alguma razão ele não aprendeu ao fazer isso." Isso derrubava a
hipótese do v4.85.16 (usuário renomeando só pela aba Patrimônio) — o
usuário usou exatamente o mecanismo pensado pra "aprender" (o dropdown de
apelidos, `_openBrokerNameDrop`/`_pickBrokerName`) e mesmo assim falhou.

### Causa raiz real
`renderBrokerPreview()` é chamada de novo (rebuild completo da tabela)
por VÁRIAS ações que não têm nada a ver com o campo de nome: reclassificar
uma movimentação "❓" (`_reclassifyBrokerFlow`), remover/restaurar um
ativo (`_toggleBrokerAssetRemoved`), resolver uma movimentação não
atribuída (`_unresolvedAssignSingle`/split/ignore), ou a checagem
automática de duplicatas (`checkUnresolvedAgainstAccount`). Cada rebuild
reconstrói o HTML inteiro a partir do `parsed` original — e o nome
escolhido no dropdown só é de fato gravado em `parsed.assets[i].name` no
momento de clicar "Importar" (`confirmBrokerImport`). Ou seja: qualquer
rebuild ANTES do clique final revertia silenciosamente a escolha do
usuário de volta pro nome cru do extrato, sem nenhum aviso visual.

Isso bate exatamente com o relato: extratos BTG costumam ter várias
movimentações "❓" pra classificar — um fluxo típico de "renomear os
ativos um a um" quase sempre inclui pelo menos uma reclassificação no
meio do caminho, disparando o rebuild e apagando as escolhas já feitas.
No confirm final, o campo lido já estava revertido pro nome original, e
`ff.brokerMappingLearn(origName, newName)` era chamado com
`origName === newName` — um no-op que nunca gravava nada. Isso explica
por que só a XP "aprendia": o fluxo de combinação dos 2 arquivos da XP
(`showXPBrokerWizard`) não tem essa mesma sequência de reclassificações
manuais no meio da pré-visualização.

Mesmo bug afeta (silenciosamente) os campos de Categoria, Tipo, Valor,
Ext. e Rend. editados manualmente na mesma tela — qualquer edição nesses
campos também era descartada por um rebuild disparado por OUTRA linha, e
o valor perdido ia pro banco assim mesmo (não é só um problema visual:
`confirmBrokerImport()` lê o valor final direto do DOM).

### Correção (`renderer.js`)
Nova função `syncBrokerPreviewEdits(p)`: lê o valor atual de todos os
campos editáveis da tabela (`.broker-name-inp`, `.broker-cat-sel`,
`.broker-type-sel`, `.broker-valor-inp`, `.broker-ext-inp`,
`.broker-inc-inp`) e grava de volta em `p.assets[i]` (`_editedName`,
`_editedCategory`, `_editedType`, `_editedValorInp`, `_editedExtInp`,
`_editedIncInp`) — chamada no início de TODO handler que dispara
`renderBrokerPreview(p)` de novo (`_reclassifyBrokerFlow`,
`_toggleBrokerAssetRemoved`, os handlers de movimentação não atribuída,
`checkUnresolvedAgainstAccount`, `completeBrokerAssetLink`). O template
de cada linha agora prioriza esses campos `_edited*` sobre o
prefill/aprendizado original, então uma edição em andamento sobrevive a
um rebuild disparado por outra linha da tabela.

### Verificado
`node --check` sem erro de sintaxe. Testado AO VIVO: abri uma instância
dev (`electron . --remote-debugging-port=9222`, com a produção fechada
pelo usuário pra liberar o lock de instância única) e usei o Chrome
DevTools Protocol via WebSocket (script Node, `scratchpad/run_case.js` +
`test_case.txt`/`test_case2.txt`) pra simular, dentro do processo
renderer real: (1) escolher um nome via dropdown pro ativo 0, reclassificar
uma movimentação "❓" do ativo 1 (dispara rebuild) e confirmar que o nome
do ativo 0 sobreviveu (`sobreviveu: true`); (2) confirmar que o prefill
por código (v4.85.15/16) continua funcionando numa 1ª renderização, e que
remover+restaurar um ativo (outro rebuild) não apaga uma edição feita em
OUTRA linha nem quebra o prefill do próprio ativo removido/restaurado.
Não usei dados reais do usuário nesse teste (ativos e nomes fictícios,
sem chamar `ff.brokerMappingLearn` de verdade) pra não poluir o
`_broker_mappings.json` real.

**Arquivos tocados**: `src/renderer.js` (`syncBrokerPreviewEdits()` nova;
`renderBrokerPreview()`; `_reclassifyBrokerFlow`,
`_toggleBrokerAssetRemoved`, `_unresolvedAssignSingle`,
`_unresolvedToggleSplit`, `_unresolvedSplitAddRow/RemoveRow/SetAsset/
SetAmount/Confirm`, `_unresolvedIgnore`, `checkUnresolvedAgainstAccount`,
`completeBrokerAssetLink`).

---

## 2026-08-01 (6) — v4.85.16: fix — importação de corretora "esquecia" 100% dos apelidos de ativos já dados

### Relato do usuário
"eu coloquei um apelido para cada um dos meus ativos de corretora. Ao
tentar importar um novo mês, ele não 'lembra' nenhum nome, ele mantém
todos exatamente com o nome do extrato, e dá um baita trabalho apagar um
a um e colocar o nome certo." Quando sugeri que fosse o mesmo problema de
nome variável da BTG (v4.85.15), o usuário corretamente contestou: "Não
deve ser por conta da mudança do nome, pq ele está ignorando 100% das
vezes. Fosse a mudança do nome, em alguns pelo menos ele deveria acertar."

### Investigação — causa raiz real (confirmada, não hipótese)
Inspecionei o `_broker_mappings.json` real do usuário (pasta do Dropbox,
`dataDir` configurado) — o arquivo de "apelidos aprendidos" só tinha
entradas da corretora **XP**, nenhuma da **BTG**, apesar do usuário
claramente ter renomeado ativos da BTG (todo o resto desta sessão girou
em torno de bugs específicos de ativos BTG). Isso apontou pra causa real:
o cache de "apelidos aprendidos" (`_brokerMappings`, escrito em
`broker:mapping-learn`) só é alimentado quando o usuário edita o nome
**dentro do campo de renomear da própria tela de importação**. Mas o
jeito mais natural de dar um apelido a um ativo é editar direto na aba
**Patrimônio** — isso atualiza `inv_assets.name` no banco imediatamente,
sem NUNCA passar pelo mecanismo de "aprendizado" da tela de importação.

A pré-visualização da próxima importação, por sua vez, só sabia consultar
esse cache separado (`_brokerMappings`) — nunca o nome ATUAL de verdade
do ativo já cadastrado. Resultado: qualquer apelido dado fora da tela de
importação (o caso mais comum) era 100% invisível pra ela, sempre — não
dependia de a BTG ter mudado o nome bruto ou não, por isso "ignorava
sempre", confirmando a observação do usuário.

Importante: os DADOS em si nunca ficaram errados — o casamento por código
(v4.85.15) já garantia que o valor importado ia pro ativo certo (o
renomeado), sem criar duplicata. O bug era só a pré-visualização mostrar
o nome cru do extrato em vez do nome já dado ao ativo, obrigando
retrabalho manual desnecessário.

### Correção (`renderer.js`)
`renderBrokerPreview()`: antes de consultar o cache de apelidos
aprendidos, busca primeiro em `_invAssetsList` (já carregada) um ativo
com o MESMO CÓDIGO — se achar, usa o nome ATUAL dele (a fonte de verdade
real) como prefill. Só cai pro cache de apelidos aprendidos (por código,
depois nome exato, depois nome normalizado) quando o ativo ainda não
existe cadastrado (1ª importação daquele papel) ou não tem código
confiável.

Mantive também o fix complementar já em andamento (chave por código no
cache de aprendizado, `broker:mapping-learn` em main.js + os dois pontos
de `ff.brokerMappingLearn(...)` em renderer.js) — cobre o caso de um
ativo recém-criado NESTA importação (ainda não em `_invAssetsList`) cujo
nome o usuário edita na própria tela.

### Verificado
`node --check` — sem erro de sintaxe. Não foi possível testar ao vivo
nesta sessão — o app de produção instalado estava aberto (mesmo
`app.requestSingleInstanceLock()`, `npm start` não consegue abrir uma 2ª
instância enquanto isso). Lógica confirmada por leitura de código e
inspeção direta do arquivo `_broker_mappings.json` real do usuário.

**Arquivo tocado**: `src/renderer.js` (`renderBrokerPreview()`).

---

## 2026-08-01 (5) — conciliação de transferências: conferir uma perna não conferia a outra

### Relato do usuário
"uma coisa que costumava funcionar, mas por alguma razão não tem
funcionado, é a conciliação de transferências (ao marcar uma conferida,
a outra perna ficar conferida automaticamente)"

### Causa raiz
Existem TRÊS caminhos que marcam uma transação como "conferida" (✅):
1. Clique no ícone da coluna "C" na tabela (`toggleCleared()`, renderer.js) — chama `ff.inlineUpdate` E, separadamente, `ff.clearTransferPair` — este SEMPRE funcionou.
2. Menu de contexto (botão direito → "marcar como conferido", inclusive em lote com várias linhas selecionadas) e o modal de edição de lançamento — ambos usam `tx:update` (main.js).
3. Busca avançada (resultado da pesquisa) — usa `tx:inline-update` (main.js) diretamente, sem o segundo passo que o caminho 1 tem.

`tx:update` já sincronizava `date`/`memo`/`amount` da OUTRA perna da
transferência havia tempo (UPDATE dedicado, com undo correto) — mas
**nunca incluiu `cleared`** nesse UPDATE. `tx:inline-update` tinha uma
lista genérica de campos sincronizados (`['date','memo','amount']`) que
também **nunca incluiu `'cleared'`** — só funcionava pra conferir por
coincidência de o caminho 1 (checkbox da tabela) chamar um segundo IPC
dedicado (`tx:clear-transfer-pair`) só pra isso. Ou seja: conciliar pela
tabela funcionava (sempre funcionou); conciliar pelo menu de contexto, em
lote, pelo modal de edição, ou pela busca avançada, nunca sincronizava a
outra perna — o usuário só notava quando usava um desses outros caminhos
(plausível que o hábito de uso tenha migrado pra conciliação em lote via
menu de contexto após importações, daí a impressão de regressão).

### Correção (`main.js`)
- `tx:inline-update`: `'cleared'` adicionado à lista de campos que
  sincronizam a perna pareada (`['date','memo','amount','cleared']`) —
  a lógica de sync já era genérica por campo, só faltava incluir esse.
- `tx:update`: o UPDATE da perna pareada e o bloco de undo agora também
  incluem `cleared` (antes só `date,memo,amount`).

Cobre AUTOMATICAMENTE os 3 caminhos — `ctxToggleCleared` (menu de
contexto) e o modal de edição usam `tx:update`; a busca avançada
(`advToggleCleared`) usa `tx:inline-update`; ambos corrigidos na raiz
(main.js), sem precisar de mudança em cada função do renderer que os
chama.

### Verificado
`node --check` — sem erro de sintaxe. Escrevi um script isolado (sql.js
em memória) simulando um par de transferência e os dois caminhos
corrigidos (`tx:inline-update` e `tx:update`) — ambos confirmaram as duas
pernas ficando conferidas juntas. Não testado na UI real nesta sessão
(app de produção aberto, mesma limitação do fix seguinte).

**Arquivo tocado**: `src/main.js` (`tx:inline-update`, `tx:update`).

---

## 2026-08-01 (4) — v4.85.15: fix raiz — renda variável (BTG) casando por CÓDIGO em vez de nome, elimina duplicatas/fantasmas de vez

### Relato do usuário
"Ainda está dando problema na importação, confundindo nomes." — com 5
prints da aba Patrimônio mostrando várias linhas por ticker (ex.:
"PETROBRAS PN N2" / "PETROBRAS PN ATZ N2" / "PETROBRAS PN ERJ N2", todas
com código PETR4) e os 5 arquivos reais BTG de Jan a Mai/2026.

### Causa raiz (achada analisando os arquivos reais)
A BTG insere uma "flag" transitória de 2-3 letras no meio do nome
completo de cada ação/BDR — "ATZ", "ERJ", "EJ", "ED" — que **muda de mês
pra mês pro MESMO papel**, sem relação com identidade do ativo (parece
algum indicador de evento societário passageiro do sistema da BTG).
Exemplo real extraído dos arquivos do usuário, mesmo código PETR4 nos 5
meses:
```
Jan: PETROBRAS   PN      N2
Fev: PETROBRAS   PN  ATZ N2
Mar: PETROBRAS   PN  ATZ N2
Abr: PETROBRAS   PN  ERJ N2
Mai: PETROBRAS   PN  ATZ N2
```
PRIO3 teve o caso mais extremo: a própria BTG trocou o nome da empresa de
"PETRORIO" pra "PRIO" no meio do período, combinado com a flag variável —
4 variações de nome pro mesmo código em 5 meses.

O parser da BTG sempre usou esse nome completo (com a flag) como `name`
do ativo — e `broker:save-parsed` (main.js) sempre casou ativos por
**nome**, não por código. Cada mudança de flag = ativo "novo" pro app =
duplicata, com o anterior virando fantasma (parado, repetindo o último
valor). As correções anteriores desta sessão (v4.85.11: revisão de
"ativos novos"; v4.85.13: "Valores em Trânsito") atacaram sintomas
relacionados mas não esta causa — a revisão de v4.85.11 dependia do
usuário confirmar manualmente a cada import, o que não escala pra um
problema que acontece quase todo mês em quase todo papel.

### Correção
O **código** (ticker, ex.: PETR4) é uma identidade muito mais estável que
o nome completo — nunca muda entre os 5 arquivos analisados, mesmo
quando o nome muda 4 vezes.

- `main.js` (`broker:save-parsed`): ativos NÃO-caixa agora casam por
  **código primeiro** (broker exato, depois qualquer broker), só caindo
  pro casamento por nome (comportamento antigo, inalterado) quando o
  ativo não tem código. `name` continua imutável após a criação (como já
  era) — a primeira variação de flag capturada fica congelada no nome de
  exibição pra sempre, o que é cosmético, não um bug de dados.
- `renderer.js` (`reviewNewAssetsBeforeImport` → `willCreateNew()`):
  mesma prioridade de código aplicada na checagem de "isto vai criar um
  ativo novo?" — evita que a revisão de v4.85.11 sinalize como "novo" um
  ativo que já vai bater sozinho pelo código, reduzindo ruído.

### Verificado (com os arquivos reais do usuário)
Escrevi um script isolado (`sql.js` em memória, mesma engine SQLite do
app) que reimplementa a extração de posições de Renda Variável e simula
as 5 importações sequenciais (Jan→Mai) com a lógica ANTIGA e a NOVA lado
a lado:
```
LÓGICA ANTIGA (só nome): 25 linhas criadas p/ 14 tickers reais
  ⚠️ DUPLICADO ASML34: 2 linhas   ⚠️ DUPLICADO BBAS3: 3 linhas
  ⚠️ DUPLICADO ITUB4: 2 linhas    ⚠️ DUPLICADO PETR4: 3 linhas
  ⚠️ DUPLICADO PRIO3: 4 linhas    ⚠️ DUPLICADO VALE3: 2 linhas
  ⚠️ DUPLICADO VBBR3: 2 linhas
LÓGICA NOVA (código primeiro): 14 linhas criadas, 56 atualizações
  ✅ Nenhum código duplicado — 1 linha por ticker
```
Bate exatamente com os prints do usuário (mesmos tickers duplicados,
mesma contagem de variações no PRIO3). `node --check` nos dois arquivos —
sem erro de sintaxe. `npm start` — app abre normal.

### Dado já existente
Este fix impede duplicatas NOVAS a partir de agora, mas não limpa as que
já foram criadas nas importações anteriores (as linhas "fantasma" visíveis
nos prints do usuário, ex.: "PETROBRAS PN N2" parada desde Jan enquanto
"PETROBRAS PN ATZ N2" seguia sendo atualizada). Não mexi nos dados de
produção nesta sessão — recomendo ao usuário revisar a aba Patrimônio,
identificar as linhas duplicadas por ticker (mesmo "Código", nomes
parecidos, uma delas com valor congelado há meses) e excluir as
fantasmas manualmente, mantendo a que tem o histórico mais completo/atual.

**Arquivos tocados**: `src/main.js`, `src/renderer.js`.

---

## 2026-08-01 (3) — v4.85.14: importação de corretora — "vincular a ativo" também nas movimentações fora de ativos

### Relato do usuário
"Não está dando a opção de vincular a um ativo, como tínhamos combinado"
— com print do modal "Lançamentos não relacionados a ativos" (ex.: "VLR.
AMORTIZ. - DEB AUTOPISTA LITORAL SUL", "CASHBACK GESTÃO DE CARTEIRA"),
mostrando só Categoria (sem opção de vincular a ativo).

### Contexto
O pedido original ("permitir que o usuário identifique que é uma
movimentação vinculada a algum investimento financeiro sim") foi
implementado em v4.85.11, mas só no fluxo de **"movimentações não
identificadas"** (`unresolvedMovements` — itens que o parser suspeita
serem de algum ativo mas não conseguiu casar com segurança). Existe um
SEGUNDO fluxo, separado, pra **"lançamentos não relacionados a ativos"**
(`nonAssetMovements` — itens que o parser tem confiança de que NÃO são de
nenhum ativo, tipo PIX/TED avulsos) — esse modal (`showBrokerNonAssetReview`)
nunca ganhou a opção de vincular, só Memorando/Categoria (fluxo igual ao
importador bancário comum). Os itens do print (amortização de debênture,
cashback) claramente pertencem a um ativo específico — o parser só não
tinha confiança pra atribuir sozinho.

### Correção (`renderer.js`, `index.html`)
Diferença importante de arquitetura: a revisão de `nonAssetMovements` roda
**DEPOIS** de `ff.brokerSaveParsed()` já ter persistido os ativos desta
importação (ao contrário de `unresolvedMovements`, que roda antes) — não
dá mais pra simplesmente empurrar pra `parsed.assets`. A vinculação aqui
grava direto via `ff.invTxSave()`, mesmo mecanismo já usado pela inserção
manual (`applyManualEntryToAsset`).

- `showBrokerNonAssetReview()`: recarrega `_invAssetsList` (`loadInvAssetsList()`) antes de renderizar, pra incluir ativos recém-criados nesta mesma importação como opção.
- `renderBrokerNonAssetRows()`: cada linha ganhou um `<select>` "🔗 Vincular a ativo…" com todos os ativos cadastrados. Ao escolher um, a linha muda de modo — mostra o nome do ativo + um segundo `<select>` com o tipo de movimentação (Compra/Aporte, Venda, Amortização/Resgate, Dividendo, Juros, Taxa, JCP, Cupom — mesmo conjunto de `INV_TX_CASH`, com um palpite inicial baseado no sinal do valor: positivo→Dividendo, negativo→Taxa, sempre editável) e um botão "✕" pra desvincular.
- `resolveBrokerNonAsset()`: linhas vinculadas não entram mais no lançamento avulso da conta — para cada uma, chama `ff.invTxSave({asset_id, month, tx_type, total_value: Math.abs(amount), notes:'__broker_import__'})`. O efeito de caixa dessas movimentações continua coberto pelo ajuste de saldo calculado depois (mesma lógica de itens ignorados) — o que muda é que agora ficam registradas no histórico do ativo específico, em vez de aparecerem como lançamento genérico da conta ou desaparecerem no ajuste sem rastro.
- `index.html`: modal `#modal-broker-nonasset` alargado (820px→900px) e cabeçalho da tabela ganhou a coluna "Vincular a ativo".

### Verificado
`node --check` — sem erro de sintaxe. `npm start` — app abre normal, sem
erro no console do processo principal. Não testado fim-a-fim com um
extrato real nesta sessão.

**Arquivos tocados**: `src/renderer.js`, `src/index.html`.

---

## 2026-08-01 (2) — v4.85.13: fix — "Valores em Trânsito" (BTG) continuava duplicando/criando ativo fantasma

### Relato do usuário
"Ainda estamos com um pequenos problema ao importar extrato de
corretoras. O campo 'valores em trânsito' ainda está 'duplicando' e
mantendo valores fantasma. Mesmo problema que tinha acontecido com ativos
que tinham mudado ligeiramente de nome" — ou seja, mesmo depois do fix de
v4.85.11 (revisão de "ativos novos" antes de salvar).

### Causa raiz
"Valores em Trânsito" é um ativo agregado (categoria `valor_em_caixa`)
que o parser da BTG sempre cria com `broker: 'BTG'` **fixo** (linha do
parser, nunca muda). Só que `broker:save-parsed` (main.js) casa ativos de
caixa por **nome + corretora EXATOS**, sem o fallback broker-agnóstico que
ativos normais têm:
```
isCashAsset ? WHERE lower(name)=? AND lower(broker)=?   ← exige os dois
            : WHERE lower(name)=? AND (broker IS NULL OR lower(broker)=?)
                 OR WHERE lower(name)=?                  ← ativo normal cai aqui se broker não bater
```
`confirmBrokerImport()` (renderer.js) aplica o rótulo customizado de
corretora (ex.: "BTG 1") em qualquer ativo cujo NOME ainda não fosse
conhecido — na 1ª importação de "Valores em Trânsito", o nome era novo,
então esse ativo (que deveria SEMPRE usar o broker nativo 'BTG', igual a
"Valores em Caixa"/`caixaValue`) acabava sendo criado com `broker='BTG 1'`
em vez de `'BTG'`. Nas importações seguintes, o parser volta a emitir
`broker:'BTG'` (nunca 'BTG 1') — como o nome já era "conhecido", o rótulo
customizado não era mais aplicado (comportamento correto pra ativos
normais), mas o valor gravado (`'BTG'`) nunca batia com a linha já criada
(`'BTG 1'`) — toda importação seguinte criava OUTRA linha nova sob
`broker='BTG'`, e a antiga (`'BTG 1'`) virava fantasma, congelada.

A revisão de "ativos novos" de v4.85.11 não pegava isso porque checava só
o NOME pra decidir "já existe" (replicando a regra de ativos normais) —
mas ativos de caixa também precisam bater a corretora, então um ativo já
"conhecido pelo nome" ainda podia virar duplicata silenciosamente, sem
passar pela revisão.

### Correção (`renderer.js`)
- `confirmBrokerImport()`: o bloco que aplica o rótulo customizado agora
  **pula ativos com `category === 'valor_em_caixa'` incondicionalmente**
  (mesmo na 1ª criação) — eles sempre usam o broker nativo do parser,
  igual a "Valores em Caixa".
- `reviewNewAssetsBeforeImport()`: a checagem de "já existe" agora exige
  corretora exata também pra ativos de caixa (`willCreateNew()`), não só
  nome — cobre qualquer drift futuro (ex.: se o usuário tivesse trocado o
  rótulo antes deste fix) como candidato revisável, em vez de passar
  batido.
- `_narConfirmAll()`: ao confirmar "é o mesmo ativo", agora também copia
  `broker` do ativo existente (antes só renomeava) — sem isso, confirmar
  o match de um ativo de caixa não seria suficiente pra fazer a próxima
  gravação bater (corretora ainda divergente).

### Dado já existente
Este fix impede NOVAS duplicatas, mas não apaga a linha fantasma que já
foi criada antes dele (ex.: uma "Valores em Trânsito" sob "BTG 1" parada
há alguns meses, e outra sob "BTG" sendo atualizada). Recomendo ao usuário
localizar as duas linhas na aba Patrimônio (filtrando por "Valores em
Trânsito"), conferir qual está desatualizada, e excluir a fantasma
manualmente — não mexi nos dados de produção nesta sessão.

### Verificado
`node --check` — sem erro de sintaxe. `npm start` — janela abre
normalmente, sem crash. Não foi possível reproduzir com um extrato BTG
real nesta sessão (exigiria dados de produção); a correção foi validada
por leitura de código cruzando a lógica de matching de main.js com o
fluxo de renderer.js ponto a ponto.

**Arquivo tocado**: `src/renderer.js` (`confirmBrokerImport()`,
`reviewNewAssetsBeforeImport()`, `_narConfirmAll()`).

---

## 2026-08-01 — v4.85.12: fix — clicar no cabeçalho da coluna (aba Contas) não reordenava a tabela de fato

### Relato do usuário
"queria poder, na visualização de contas, poder ordenar as colunas por
outro critério (não só pelo padrão por datas), clicando na coluna"

### Investigação
A funcionalidade parecia já existir: `buildLedgerHeader()` (`renderer.js`)
já marcava as colunas Data/Categoria/Memorando/Despesa/Receita/Saldo como
`sortable`, com `onclick="toggleSort(col.id)"`, seta visual (↑/↓) e classe
`sorted` no cabeçalho ativo. `toggleSort()` atualizava `sortBy`/`sortOrder`
corretamente.

O bug real estava em `renderLedgerBody()`: a função que decide a ORDEM
FINAL das linhas na tela **ignorava `sortBy` por completo** — sempre
recalculava a ordem separando passado/futuro e ordenando cronologicamente
(`sameDateSort`), não importa qual coluna estivesse marcada como ativa no
cabeçalho. Resultado: clicar em "Categoria", "Despesa", "Receita" etc.
destacava visualmente a coluna (seta, borda) mas a ordem das linhas na
tabela nunca mudava — sempre continuava cronológica. Isso valia até para
"Valor" (via o dropdown antigo `#sort-select`, que já tinha uma opção
"Por valor"), então o bug não era exclusivo de colunas novas — era
qualquer ordenação que não fosse por data.

Bug secundário: `toggleSort()` nunca invertia a direção num segundo clique
na mesma coluna que não fosse Data — sempre resetava pra `'asc'`,
diferente do padrão de qualquer planilha (clicar de novo inverte).

### Correção
- `toggleSort(col)`: clicar de novo na MESMA coluna agora inverte
  `sortOrder` (asc↔desc), igual ao comportamento já existente pra Data
  (que mantém seu próprio ciclo desc→asc→futuras). Colunas "Despesa"/
  "Receita" nascem numa direção que mostra o valor mais relevante primeiro
  (maior despesa / maior receita) em vez de um "asc" genérico sem sentido
  pra quem acabou de clicar nelas.
- `renderLedgerBody(txs, startingBalance)`: novo ramo pra `sortBy !==
  'date'` — ordena TODAS as transações (passadas e futuras juntas, sem a
  divisória "Lançamentos futuros", que só faz sentido em ordem
  cronológica) por Categoria/Memorando (localeCompare pt-BR)/Despesa/
  Receita/Valor (todos por `amount`) ou Saldo (pelo saldo corrente já
  calculado em `balMap`, mesmo valor exibido na coluna). Cada comparador
  usa `sameDateSort` como critério de desempate. Ordenação por data
  (branch original, intocado) continua com o mesmo comportamento de
  sempre — passado/futuro separados, ciclo desc/asc/futuras-primeiro.

### Verificado
`node --check` no arquivo tocado — sem erro de sintaxe. Extraí a lógica
dos comparadores pra um script Node isolado com 5 transações fake
(datas/categorias/valores variados) e conferi manualmente cada resultado
— ordenação por categoria (asc/desc, com empate resolvido por data),
despesa (maior primeiro), receita (maior primeiro) e saldo corrente (usando
o mesmo `balMap` calculado em ordem cronológica) — todos bateram com o
esperado. `npm start`: app abre normal, sync de startup sem erro. Não foi
possível clicar de fato no cabeçalho da tabela nesta sessão (sem
automação de UI pro Electron disponível) — recomenda-se o usuário testar
na aba Contas e reportar qualquer coluna que não se comporte como
esperado.

**Arquivo tocado**: `src/renderer.js` (`toggleSort()`, `renderLedgerBody()`).

---

## 2026-07-31 (5) — v4.85.11: importação de corretora — corretora obrigatória com dropdown, revisão de ativos novos, e melhorias nas movimentações não identificadas

Três pedidos do usuário sobre o fluxo de importação de corretora, todos na mesma tela (`renderBrokerPreview`/`confirmBrokerImport` em `renderer.js`).

### 1. Campo "Nome da corretora" virou dropdown obrigatório, sem valor pré-preenchido
Era um `<input>` de texto livre, pré-preenchido automaticamente com o
rótulo salvo pra conta (ou o nome padrão da corretora) — risco real de o
usuário confirmar sem prestar atenção e atribuir o nome errado de
corretora a ativos novos (pedido explícito do usuário: "não arriscar um
preenchimento errado de corretora por falta de atenção").

- `index.html`: `#broker-label` virou `<input list="broker-label-datalist">` + `<datalist id="broker-label-datalist">` — continua aceitando texto livre (nome de corretora novo), mas agora sugere as já usadas.
- `renderer.js`: nova `populateBrokerLabelDatalist()` (lê `ff.invBrokersList()`, já existia como IPC mas não era usado na UI) — chamada em `pickBroker()`. `onBrokerAccountChanged()` não pré-preenche mais o valor — só o `placeholder` (dica visual, nunca vai junto do formulário sem o usuário confirmar). `confirmBrokerImport()` agora **bloqueia a importação** com um toast se o campo estiver vazio.

### 2. Revisão de ativos "novos" antes de salvar — evita o ativo "fantasma"
Relato do usuário: ao importar um novo mês, se o nome de um ativo mudasse
sutilmente entre um extrato e outro (acento, abreviação, espaçamento), o
app criava um ativo NOVO em vez de reconhecer que era o mesmo — o antigo
ficava "fantasma" (nunca mais atualizado, repetindo o último valor pra
sempre) e um novo nascia do zero. Causa raiz: `broker:save-parsed`
(main.js) casa ativos por **nome exato** (case-insensitive); qualquer
variação de texto vira um INSERT em vez de um UPDATE.

Pedido: antes de criar, mostrar uma janela com os ativos que seriam
criados como novos; se algum for parecido (nome + valor) com um já
cadastrado, sugerir a confirmação de que é o mesmo — "sopesando valor e
descrição... 99% das vezes".

- `renderer.js`, novo bloco antes de `confirmBrokerImport()`:
  - `scoreAssetSimilarity(name, value, existing, existingValue)` — generaliza `fuzzyMatchXPAsset` (que só existia dentro do parser da XP, comparando só nome) pra nome (sobreposição de tokens, 65% do peso) + valor (proximidade relativa, 35% do peso), usável fora do parsing.
  - `reviewNewAssetsBeforeImport(parsed)` — roda dentro de `confirmBrokerImport()`, depois de todas as edições da tela já aplicadas e antes de `ff.brokerSaveParsed()`. Filtra os ativos sem correspondência exata em `_invAssetsList`; pra cada um, busca o último valor conhecido de cada ativo já cadastrado via `ff.invTxAll()` (mesma lógica de `_invAssetCurrentValue`, usada na aba Patrimônio) e calcula a melhor sugestão. Só abre a janela se houver pelo menos 1 candidato.
  - `renderNewAssetReviewModal()` + `window._narConfirmMatch/_narConfirmNew/_narPickFromSelect/_narCancel/_narConfirmAll` — reaproveita o modal genérico `#modal-custom-parser` (mesmo shell já usado por `openBrokerLearnModal`/custom parser wizard). Cada linha: se há sugestão (score ≥ 0.55), botões "✓ É o mesmo" / "Não, é novo"; sempre disponível um `<select>` com TODOS os ativos cadastrados pra vincular manualmente, e "🆕 Confirmar novo". Ativos sem decisão explícita são criados como novos — comportamento idêntico ao de antes desta feature, nunca pior.
  - Ao confirmar um "é o mesmo": renomeia `parsed.assets[i].name` pro nome do ativo existente (assim `broker:save-parsed` casa por nome exato = UPDATE, não INSERT) e chama `ff.brokerMappingLearn()` — mesmo mecanismo já usado quando o usuário renomeia manualmente na tabela — então a PRÓXIMA importação já reconhece sozinha, sem passar pela revisão de novo.
  - `confirmBrokerImport()`: `const brokerLabel` movido pro topo da função (validação do item 1); a aplicação do rótulo customizado nos ativos novos (`a.broker = brokerLabel`) roda DEPOIS da revisão, então um ativo que acabou de ser vinculado a um existente (nome já bate) corretamente NÃO recebe o rótulo customizado — preserva o broker original, como o comentário já existente no código exigia.

### 3. Movimentações não identificadas: dedup contra a conta + vínculo a qualquer ativo já cadastrado
Dois problemas apontados pelo usuário nas "movimentações não atribuídas a
nenhum ativo" (feature já existente, task #86 de uma sessão anterior):

**(i) Detectar se já está registrada na conta.** Antes, cada movimentação
não identificada sempre pedia uma decisão do usuário, mesmo se ele já
tivesse lançado manualmente aquela mesma transação na conta de
investimentos (que também pode ser usada como conta corrente).
- `main.js`: novo `ipcMain.handle('broker:check-unresolved-dups', ...)` — mesmo espírito de `bank:check-memo-dups` (usado no importador de extrato bancário), mas mais simples: casa por conta+valor (±R$0,02) e data (±5 dias se a movimentação tem data completa YYYY-MM-DD; mesmo mês via `substr` se só tem YYYY-MM, já que alguns pontos do parser só sabem o mês). Só SURFACE candidatos, nunca pula sozinho.
- `preload.js`: `brokerCheckUnresolvedDups`.
- `renderer.js`: `checkUnresolvedAgainstAccount(p, accountId)` — roda uma vez por conta selecionada (fire-and-forget dentro de `renderBrokerPreview`), marca `mv._existingMatch` e re-renderiza. `buildUnresolvedHtml()` mostra um banner verde "☑️ Já parece estar registrada nesta conta: DD/MM · R$X · memo — provavelmente pode 🚫 Ignorar" quando há match.

**(ii) Vincular a QUALQUER ativo cadastrado, não só aos desta importação.**
O `<select>` de "atribuir a um ativo" só listava `parsed.assets` (os
ativos que o PARSER encontrou neste extrato específico) — se a
movimentação fosse de um ativo que não teve variação de posição no mês
(por isso não apareceu no parse), não tinha como escolhê-lo.
- `renderer.js`: `buildUnresolvedHtml()` — `assetOptions()` agora combina `parsed.assets` (prefixo `"p:N"`) com `_invAssetsList` menos os já presentes na importação e não fechados (prefixo `"db:ID"`, num `<optgroup>` "Já cadastrados"). Nova `_resolveUnresolvedAssetTarget(val, p)` decodifica o prefixo — pra `"db:ID"`, cria (ou reaproveita) uma entrada em `parsed.assets` com `valor:0` (não mexe na posição do ativo, só a movimentação entra) e `liquidacaoTotal:false`. `_unresolvedAssignSingle`, `_unresolvedSplitSetAsset`, `_unresolvedSplitConfirm` atualizados pra usar o resolver em vez de indexar `p.assets` diretamente.

### Verificação
`node --check` nos 3 arquivos JS tocados (`main.js`, `renderer.js`,
`preload.js`) — sem erro de sintaxe. `npm start`: app abre, sync de
startup roda normal, sem erro no console do processo principal. Não foi
possível testar o fluxo fim-a-fim (revisão de ativo novo, dedup de
movimentação) com um arquivo de extrato real nesta sessão — recomenda-se
o usuário testar na próxima importação de corretora e reportar qualquer
comportamento inesperado.

**Arquivos tocados**: `src/index.html`, `src/main.js`, `src/preload.js`, `src/renderer.js`.

---

## 2026-07-31 (4) — v4.85.10: fix — edição feita logo após abrir o app podia não chegar ao Supabase ao fechar

### Relato do usuário
"Está faltando um sync com o Supabase ao final da sessão (antes de fechar o
app). hoje atualizei alguns dados, fechei o app, e, ao abrir o mobile, as
mudanças não estavam lá. Só apareceram quando abri novamente o desktop."

### Investigação
O sync final ao fechar (`app.on('before-quit', ...)`) já existia desde a
correção do loop infinito em 2026-07-20 (ver entrada abaixo) e continuava
funcionando no caso comum — validado ao vivo nesta sessão fechando a janela
normalmente (`CloseMainWindow`) e conferindo o log: exatamente 1 ciclo de
sync com `trigger: 'quit'`, processo terminou sozinho, sem regressão.

O bug real estava numa condição de corrida diferente: o handler tinha
`if (!sb.isLoggedIn() || _syncRunning) return;` — ou seja, se JÁ houvesse
outro sync em andamento no momento exato de fechar (o único outro gatilho
automático é o de `'startup'`, disparado toda vez que o app abre e que leva
alguns segundos pra completar pull+push de ~10 tabelas), o handler
simplesmente desistia: nem esperava aquele sync terminar, nem rodava um
sync próprio depois — só deixava o `app.quit()` seguir, o que MATA
imediatamente qualquer requisição de rede ainda em andamento.

Cenário real: abrir o app, editar algo rapidamente (ex: corrigir um saldo)
e fechar em seguida, antes do sync de abertura terminar. A edição nunca
chegava ao Supabase (nem pelo sync de startup, interrompido no meio, nem
por nenhum sync depois) — só aparecia no mobile na próxima vez que o
Desktop fosse aberto (quando o sync de `'startup'` seguinte, dessa vez sem
concorrência, rodava até o fim).

### Correção
`runMobileSync()` agora guarda a Promise da execução em andamento em
`_syncPromise` (variável em memória, ao lado de `_syncRunning`). O handler
de `before-quit` deixou de desistir quando `_syncRunning` é `true`: agora
sempre faz `preventDefault()` (se logado), espera a Promise do sync em
andamento terminar (`await _syncPromise`, com fallback silencioso se ela
falhar) e SÓ ENTÃO roda seu próprio `runMobileSync('quit')` — que revalida
os hashes por tabela e reenvia qualquer coisa editada durante ou depois
daquele sync que já estava rodando. A flag `_quitFinalizing` (do fix de
2026-07-20) continua intacta, evitando qualquer risco de reintroduzir o
loop infinito.

### Validado ao vivo
`npm start`, deixei o sync de `'startup'` completar normalmente e fechei a
janela via `CloseMainWindow()` (equivalente a clicar no X) — log mostrou
`window-all-closed` → `[sync] iniciando (trigger: quit)` → conclusão com
sucesso → processo `electron.exe` encerrado sozinho, sem sobra. Não foi
possível forçar deliberadamente a janela exata da corrida (sync de startup
ainda em andamento) neste teste, mas a correção em si é uma sequenciação
direta de Promise, sem lógica condicional nova — a mudança de
comportamento é: "esperar" no lugar de "desistir".

**Arquivo tocado**: `src/main.js` (`runMobileSync()`, handler
`app.on('before-quit', ...)`).

---

## 2026-07-31 (3) — v4.85.9: nome de corretora customizado por conta na importação (ex: "BTG 1"/"BTG 2")

### O quê
Pedido do usuário: na tela de importação de extrato de corretora, além
do campo "Conta de investimentos (ajuste de saldo)" que já existia,
adicionar um campo pra digitar o nome que ele quer atribuir ao campo
"Corretora" dos ativos NOVOS criados por aquela importação. Caso de uso:
duas contas diferentes na mesma corretora (ex: "BTG 1" e "BTG 2") — hoje
o parser sempre gravava o nome fixo da corretora nativa ("BTG"/"XP") em
todo ativo novo, sem jeito de diferenciar de qual conta ele veio.

### Como funciona
Novo campo "Nome da corretora (ativos novos)" ao lado do seletor de
conta. Ao confirmar a importação, esse rótulo só é aplicado a ativos
CUJO NOME AINDA NÃO EXISTE em nenhum ativo cadastrado (sob nenhum
broker) — ativos já conhecidos mantêm o broker original. Isso é
proposital: `broker:save-parsed` (main.js) casa "é o mesmo ativo de
antes" por nome+corretora — se o rótulo sobrescrevesse o broker de um
ativo já existente, a importação seguinte criaria um ativo DUPLICADO em
vez de atualizar o mesmo (uma migração retroativa pra ativos antigos, se
o usuário quiser, continua sendo manual — editar o campo "Corretora" na
tela do ativo).

O rótulo é lembrado por CONTA de investimentos (não pela corretora
nativa) — é a conta quem distingue "BTG 1" de "BTG 2"; ao trocar a conta
selecionada, o campo já pré-preenche com o rótulo salvo daquela conta
(ou o nome padrão da corretora nativa, se nunca foi customizado).

### Ressalva conhecida (documentada, não resolvida)
Ativos "agregados tipo caixa" (Valores em Caixa da Conta Corrente,
Valores em Trânsito) são casados por nome+broker EXATOS (cada corretora
tem seu próprio saldo — ver comentário em `broker:save-parsed`). Se o
usuário usar duas contas do MESMO broker nativo e uma delas já tinha
gerado esse tipo de ativo ANTES desta feature existir (com broker
padrão "BTG", sem rótulo), o rótulo customizado da segunda conta só se
aplica corretamente se o nome ainda não existir sob nenhum broker — em
cenários combinando "conta antiga sem rótulo" + "conta nova com rótulo"
pro mesmo tipo de ativo agregado, pode exigir ajuste manual pontual.
Não é o caso de uso principal (ativos com nome/ticker próprio, que é
onde o pedido do usuário se aplica), mas fica registrado pra não
reabrir a investigação à toa numa sessão futura.

### Arquivos
- `src/index.html` — novo input `#broker-label` ao lado de
  `#broker-account`, com `onchange="onBrokerAccountChanged()"` no
  seletor de conta.
- `src/renderer.js` — `_brokerDefaultLabel`, nova
  `onBrokerAccountChanged()`, `pickBroker()` chama ela ao restaurar a
  conta preferida, `confirmBrokerImport()` aplica o rótulo a ativos
  novos e persiste a preferência por conta.
- `src/main.js` — `broker:label-pref-get`/`broker:label-pref-set`
  (guardados em `settings.brokerLabelPrefs`, por accountId).
- `src/preload.js` — `brokerLabelPrefGet`/`brokerLabelPrefSet`.
- `package.json` — 4.85.8 → 4.85.9.

Verificado com `node --check` nos 3 arquivos.

---

## 2026-07-31 (2) — v4.85.8: aba "Valores em Trânsito" da BTG + fluxo de aprendizado por texto-âncora

### O quê
Duas frentes pedidas pelo usuário depois da v4.85.7:
1. Implementar de verdade a aba "Valores em Trânsito" da BTG (até aqui só
   virava aviso de diferença, sem importar automaticamente).
2. Construir o fluxo de "ensinar onde encontrar" um valor que falta, "da
   forma mais robusta" — não por coordenada de célula (já vimos a BTG
   variar isso 2x nesta mesma investigação), e sim por busca de conteúdo.

### 1. Aba "Valores em Trânsito" (BTG)
São proventos (dividendos/JCP) já declarados pela empresa mas ainda não
creditados na conta — uma tabela de lançamentos individuais com um total
no fim. Não são posições negociáveis próprias (os nomes na descrição são
do papel que gerou o provento, já listado em Renda Variável) — por isso
entra como UM ativo agregado, categoria `valor_em_caixa` (mesmo padrão do
`caixaValue`/Conta Corrente): é dinheiro a caminho, não uma posição.
Resultado: o extrato de janeiro que motivou toda essa investigação agora
bate EXATO — declarado R$ 7.441.763,67 = importado R$ 7.441.763,67,
diferença zero (antes: -R$ 18.726,70).

### 2. Fluxo de aprendizado por texto-âncora
Novo botão "🔧 Ensinar onde encontrar" no aviso de diferença
(`brokerCompletenessCheckHtml`). Fluxo:
- Usuário digita um texto que reconhece perto do valor faltante (um
  rótulo, nome de seção, ou só "Total").
- `findValueByAnchor()` procura esse texto em TODAS as abas do arquivo
  (ou só na sugerida) e retorna candidatos: todo número encontrado à
  direita (mesma linha) e abaixo (mesma coluna) da célula que bate — não
  só o primeiro. Isso importa de verdade: tabelas comparativas tipo
  "Sumário" têm vários meses lado a lado na mesma linha, e testar contra
  o arquivo real mostrou que pegar só "o primeiro número" pegava o mês
  ERRADO (dezembro em vez de janeiro) — corrigido pra listar TODAS as
  colunas como candidatos separados, com o usuário escolhendo qual é a
  certa.
- Usuário escolhe o valor certo, classifica (categoria/tipo), salva.
- `applyLearnedBrokerItems()` reaplica automaticamente em importações
  futuras — refazendo a MESMA busca por texto (não por coordenada), então
  sobrevive a mudanças de layout entre exportações do mesmo relatório.
  Aplicado imediatamente na importação atual também (não precisa
  reimportar pra ver o resultado).

Persistido num arquivo novo (`_broker_learned_items.json`, separado de
`_broker_mappings.json` — sem risco de migração no que já existe).

### Investigação da diferença na XP (não era bug)
A checagem de completude também apontou uma diferença de ~R$ 7.151 na
XP. Investigando com o `findValueByAnchor()` recém-criado (testado contra
`Posicao XP.xlsx` + `Extrato XP.xlsx` reais, mesmo `Data da consulta`):
o parser da XP já prioriza de propósito a coluna "Valor líquido" sobre
"Posição" quando ambas existem (lógica pré-existente, comentário no
código já explicava a intenção) — FIPs/fundos alternativos frequentemente
têm custo de resgate antecipado, e "Valor líquido" reflete isso, "Posição"
não. A diferença bate com essa distinção bruto vs. líquido, não com um
bug de parsing. Deixei registrado aqui pra não reabrir essa investigação
à toa numa sessão futura.

### Arquivos
- `src/renderer.js` — `parseBTGBroker()`: nova seção "Valores em
  Trânsito". Novo `findValueByAnchor()`, `applyLearnedBrokerItems()`,
  `openBrokerLearnModal()` + funções de UI (`renderBrokerLearnStep1/2`,
  `_blSearch`, `_blRenderResults`, `_blPick`, `_blCatChanged`, `_blSave`).
  `_brokerLearnedItems` (cache, carregado em `loadInvAssetsList()`).
  `brokerCompletenessCheckHtml()`: botão "Ensinar onde encontrar".
  `processBrokerFile()`/`showXPBrokerWizard()`: chamam
  `applyLearnedBrokerItems()` e anexam `parsed._teachBuffer`.
- `src/main.js` — `getBrokerLearnedItemsPath()`,
  `loadBrokerLearnedItems()`, `saveBrokerLearnedItems()`, handlers
  `broker:learned-items-get/-save/-delete`.
- `src/preload.js` — `brokerLearnedItemsGet/Save/Delete`.
- `package.json` — 4.85.7 → 4.85.8.

Verificado com `node --check` nos 3 arquivos e testes isolados
(`findValueByAnchor` contra os arquivos reais da BTG e da XP — validado
que agora retorna as 4 colunas do Sumário como candidatos separados, não
só a primeira).

---

## 2026-07-31 — v4.85.7: corrige seção Renda Variável (BDR/Fundos Listados sumindo) + checagem de completude (total declarado vs. importado)

### O quê
Usuário testou o mesmo arquivo BTG (`BTG_RIC_JAN_26.xlsx`, já corrigido
na v4.85.6) e reportou que a aba "Renda Variável" só trouxe as Ações —
BDR's e Fundos Listados, que também estão nessa mesma aba, não vieram, e
o app não avisou nada (falha silenciosa). Ele também pediu, com razão,
que o app pare de falhar silenciosamente: comparar o total que CADA
extrato já declara (BTG: aba Sumário; XP: "este é o seu patrimônio") com
a soma do que foi de fato importado, e avisar quando não bater.

### Causa raiz (Renda Variável)
A aba Renda Variável da BTG intercala posição e movimentação POR TIPO de
ativo — não é "todas as posições primeiro, todas as movimentações
depois": a ordem real é Posição>Ações, Movimentação>Ações, Posição>BDR's,
Posição>Fundos Listados, Movimentação>Fundos Listados. O código cortava
o loop de posições no primeiro marcador "Movimentação" encontrado (que
aparece logo depois de Ações) — tudo que vem depois (BDR's, Fundos
Listados) nunca era escaneado.

### Fix (Renda Variável)
Reescrevi o loop pra rastrear o modo atual (posição/movimentação) pelos
próprios cabeçalhos de seção em vez de um corte fixo — a intercalação
deixa de importar. Também adicionei reconhecimento explícito de "BDR" e
"Fundos Listados" como subtipos (antes caíam ambos genericamente como
"FII"). Testado contra o arquivo real: Renda Variável foi de 10 pra 14
ativos (2 BDR's + 2 Fundos Listados a mais), sem regressão no extrato de
abril que já funcionava (continua 2/2).

### Checagem de completude (novo)
Adicionado `declaredTotal` aos parsers da BTG (extraído da aba Sumário,
coluna "Saldo Líquido" do mês corrente) e da XP (extraído da célula
"<nome>, este é o seu patrimônio" + valor na linha de baixo). Nova
`brokerCompletenessCheckHtml()` compara esse valor contra a soma dos
ativos + caixa efetivamente importados e mostra um aviso destacado
(com o valor da diferença) quando não bate, apontando o usuário pro
botão "+ Inserir dados manualmente" já existente. Verificado contra os
3 arquivos reais disponíveis:
- BTG abril (extrato "completo"): declarado R$ 934.437,30 = importado
  R$ 934.437,30 — diferença zero, sem aviso falso-positivo.
- BTG janeiro (mesmo arquivo do bug): mesmo após o fix de Renda
  Variável, ainda falta R$ 18.726,70 — bate EXATAMENTE com a linha
  "Valores em Trânsito" do Sumário, uma categoria que a BTG expõe numa
  aba própria (`Valores em Trânsito`) que o parser ainda não lê. Antes
  dessa mudança, isso simplesmente desaparecia sem aviso; agora o app
  avisa a diferença exata.
- XP (extrato de posição próprio): declarado R$ 395.347,95 vs. importado
  R$ 388.196,06 (diferença ~R$ 7.151,89, causa ainda não investigada).

### Pendências conhecidas (não resolvidas nesta versão)
- BTG: aba "Valores em Trânsito" ainda não tem parser dedicado — hoje
  vira aviso de diferença, não importação automática.
- XP: causa da diferença de ~R$7.151 ainda não investigada.
- A parte de "ensinar o app onde achar a célula" (auto-aprendizado por
  coordenada, pedida pelo usuário) NÃO foi implementada — coordenadas de
  célula são frágeis (já vimos a BTG variar o layout entre exportações
  do mesmo relatório), então antes de construir isso vale alinhar um
  design mais robusto com o usuário em vez de implementar às cegas.

### Arquivos
- `src/renderer.js` — `parseBTGBroker()`: loop de Renda Variável
  reescrito, `declaredTotal` na extração do Sumário. `parseXPBroker()`:
  nova extração de `declaredTotal`. Novo
  `brokerCompletenessCheckHtml()`, chamado em `renderBrokerPreview()`.
- `package.json` — 4.85.6 → 4.85.7.

---

## 2026-07-30 — v4.85.6: corrige bug real "0 ativos" na importação BTG — variação de layout de coluna no extrato

### O quê
Causa raiz do bug "0 ativos" (v4.85.5 só tinha instrumentado
diagnóstico, não corrigido) — usuário mandou o print do novo painel de
diagnóstico E o arquivo real que reproduzia o problema
(`BTG_RIC_JAN_26.xlsx`). Com o arquivo em mãos, reproduzi
instantaneamente: `assets found: 0`, com `fundos: {rows:65, pushed:0}`,
`rendaFixa: {rows:288, pushed:0}`, `rendaVariavel: {rows:51, pushed:0}`
— ou seja, as abas existiam e tinham conteúdo, mas nenhuma linha batia
com o padrão que o parser esperava.

### Causa raiz confirmada
Comparando byte-a-byte o arquivo que falha com um extrato real que
funciona (mesmas abas Fundos/Renda Fixa/Renda Variável): o extrato que
funciona tem uma **coluna A vazia** antes dos dados de verdade (ex: nome
do ativo na coluna B, saldo líquido na coluna I) — provavelmente uma
coluna de espaçamento/ícone que o Excel preserva ao exportar. O extrato
que falha **não tem essa coluna A vazia** — os mesmos dados começam
direto na coluna A (nome do ativo na coluna A, saldo líquido na coluna
H). `parseBTGBroker()` (`src/renderer.js`) tinha os índices de coluna
TODOS hardcoded assumindo sempre a coluna A vazia (`colB=row[1]`,
`colI=row[8]` etc, repetido nas 4 seções de posição + conta corrente +
sumário) — no arquivo sem essa coluna, cada leitura vinha 1 coluna
adiantada, nunca batendo com o conteúdo esperado, e a seção inteira
ficava silenciosamente vazia. Confirmado que são dois formatos de
exportação DIFERENTES e legítimos da própria BTG (não corrupção nem
erro do usuário) — a hipótese inicial de "só acontece com mês já
importado antes" era coincidência: a pessoa por acaso só tinha testado
reimportação com arquivos desse formato "sem coluna A".

### Fix
Adicionei `detectColOffset(rows)`: olha as primeiras ~40 linhas não
vazias da planilha e decide se a coluna A costuma estar vazia (padrão
"com espaçadora") ou não (padrão "sem espaçadora"). A partir disso,
`sc(n)` converte qualquer índice de coluna escrito assumindo o padrão
"com espaçadora" pro índice real da planilha atual — aplicado em TODAS
as leituras de coluna hardcoded nas seções Fundos, Renda Fixa,
Previdência, Renda Variável, Conta Corrente e Sumário (posições E
movimentações, mais os marcadores de seção tipo "Total em fundos"/
"Movimentação >").

### Verificação
Testei a função real (extraída do código atual) contra os DOIS
arquivos: o extrato de abril que já funcionava (sem regressão — 17
ativos, mesma composição por seção: fundos 4, renda fixa 10, previdência
1, renda variável 2) e o extrato de janeiro que falhava (agora encontra
46 ativos: fundos 1, renda fixa 35, renda variável 10 — bateu com a
contagem manual das seções CDB/CRA/CRI/Debênture do arquivo). `node
--check` ok.

### Arquivos
- `src/renderer.js` — `parseBTGBroker()`: nova `detectColOffset()`,
  `sc()` aplicado em todas as 6 subseções.
- `package.json` — 4.85.5 → 4.85.6.

---

## 2026-07-29 (2) — v4.85.5: diagnóstico pra bug "0 ativos" na reimportação de extrato BTG (não resolvido, instrumentado)

### O quê
Usuário (testando pra outra pessoa) reportou: importar um extrato de
corretora BTG (XLSX de posição, abas Capa/Fundos/Renda Fixa/Previdência
Individual/Renda Variavel), depois apagar 100% dos investimentos e
lançamentos da conta vinculada, e tentar reimportar o MESMO extrato de
um mês já importado antes resulta em "0 ativo(s) encontrado(s)" na
pré-visualização — mas um extrato de um mês NUNCA importado antes
funciona normalmente. Reinício do app não resolve.

### Investigação
Li a função inteira `parseBTGBroker()` (`src/renderer.js`) e confirmei
que ela é uma função pura do buffer do arquivo — nenhuma das 4 seções
de posição (Fundos/Renda Fixa/Previdência/Renda Variável) tem qualquer
dependência do banco de dados ou de arquivos persistidos
(`_bank_parsers.json`, `_broker_mappings.json`, localStorage) para
CRIAR os ativos; essas fontes só afetam texto de exibição (nome
sugerido, classificação de movimentação), nunca a contagem. Testei essa
mesma função extraída ao vivo do código atual contra 3 extratos reais
da BTG (abril/maio/junho 2026, cedidos pelo usuário principal desta
conversa, não relacionados ao caso do bug) simulando `_invAssetsList =
[]` (equivalente a "tudo apagado") — os 3 encontraram os ativos
corretamente (17, conferido com `_debug` seção-a-seção). Ou seja: não
consegui reproduzir o bug com os arquivos que tinha em mãos, porque são
de uma pessoa diferente da que está com o problema — não tenho acesso
ao arquivo real que falha nem ao banco de dados onde isso acontece.

Não encontrei nenhum mecanismo de "já importei este arquivo/mês antes,
não deixa de novo" em lugar nenhum do código (nem no parser, nem no
salvamento `broker:save-parsed` em `main.js`, que só roda depois da
pré-visualização de qualquer forma — o "0 ativos" acontece ANTES disso,
só de selecionar o arquivo).

### Ação tomada: instrumentação de diagnóstico (sem fix ainda)
Como não consigo reproduzir localmente, adicionei um painel de
diagnóstico que só aparece quando a pré-visualização vem com 0 ativos:
mostra quais abas o `XLSX.read()` encontrou de fato no arquivo
selecionado, e pra cada uma das 4 seções (Fundos/Renda Fixa/Previdência/
Renda Variável) se a aba foi encontrada, quantas linhas tinha, e quantos
ativos foram extraídos dela. Isso transforma um "0 ativos" opaco em um
relatório acionável — da próxima vez que acontecer, o usuário só precisa
mandar print desse painel (em vez de eu precisar adivinhar às cegas).

### Arquivos
- `src/renderer.js` — `parseBTGBroker()` (novo campo `result._debug` por
  seção), nova função `brokerZeroAssetsDebugHtml()`, chamada em
  `renderBrokerPreview()`.
- `package.json` — 4.85.4 → 4.85.5.

Verificado com `node --check` e reexecução do teste contra os 3 extratos
reais (ainda 17/17/? ativos corretos, sem regressão) — `_debug` populado
corretamente (fundos:4, rendaFixa:10, previdencia:1, rendaVariavel:2 =
17, batendo com o total).

**Pendência real**: o bug em si NÃO foi corrigido — só instrumentado.
Aguardando o usuário reproduzir de novo (mês já importado + apagado) e
mandar o print do novo painel de diagnóstico pra eu localizar a causa
exata.

---

## 2026-07-29 — v4.85.4: corrige numeração de parcelas futuras (BTG ok, XP sem indicador, Itaú travado em 1/x)

### O quê
Usuário reportou comportamento diferente por banco na criação automática
de parcelas futuras de compra parcelada: BTG funciona perfeitamente
(memorando preservado + indicador progride 1/x, 2/x, 3/x...); XP não
mostra indicador nenhum nas parcelas seguintes (só repete o mesmo
memorando); Itaú (PDF) preserva o memorando mas o indicador fica travado
em "1/x" pra sempre, sem progredir.

### Causa raiz — investigada com arquivos reais de fatura do usuário
Inspecionei os parsers de cada banco (`src/renderer.js`) e faturas reais
baixadas pelo usuário (BTG XLSX/PDF, XP CSV, ambos em
`~/Downloads`) pra confirmar o formato exato que cada um usa pra indicar
parcela no texto cru extraído do arquivo:
- **BTG**: `"AMAZON 1/10"` — barra, sem zero à esquerda.
- **Itaú (PDF)**: `"AMAZON BR 01/06"` — barra, **com** zero à esquerda
  (a extração usa `\d{2}\/\d{2}` de largura fixa).
- **XP (CSV, coluna "Parcela")**: `"SPA*C BLINDADOS S.A. Parcela 1 de 6"`
  — confirmado em fatura real (`Fatura2026-07-10.csv`), formato por
  extenso ("N de M"), não barra.

Havia DUAS lógicas de substituição de número de parcela, cada uma com um
bug diferente que só a BTG (por coincidência de formato) escapava:

1. **`confirmBankImport()`** (geração inicial das parcelas futuras):
   usava `.replace(/\b1\s*[\/de]+\s*\d+/, ...)` — a âncora `\b1` exige
   fronteira de palavra ANTES do "1", que não existe em "01" (o "0"
   anterior é caractere de palavra). Resultado: pra Itaú, essa
   substituição nunca batia, e o memorando de TODAS as parcelas futuras
   ficava travado no texto original "01/06" — exatamente o bug
   reportado.
2. **`doImportFromTable()`** (reconstrução final usando o memorando que
   o usuário editou na tela de importação): extraía a fração só com
   `/(\d+)\s*\/\s*(\d+)/` — regex exige barra. Pra XP, cujo formato é
   "N de M" (sem barra), essa extração nunca batia, então o indicador
   nunca era reanexado ao memorando final — some por completo.

### Fix
Reescrevi as duas funções pra usar uma lógica única e robusta,
independente do formato de cada banco:
- `detectParcela()` agora retorna também `fullMatch` (o trecho exato
  casado, ex: `"01/06"` ou `"Parcela 1 de 6"`) e `parcelText` (o texto
  exato do número, preservando zero à esquerda).
- Nova função `withParcelNumber(memo, detected, novaParcela)` troca
  cirurgicamente só o número dentro do trecho já detectado — usa
  `padStart` pra preservar a largura original (zero à esquerda tipo
  "01"→"02"...→"10"), sem depender de regex frágil por formato de banco.
- As duas chamadas (geração inicial e reconstrução com memorando editado)
  passaram a usar essa mesma função. `stripParcel()` (usado só pra achar
  qual linha da tabela corresponde a qual parcela futura) também foi
  ajustado pra remover o padrão "Parcela N de M" por inteiro, não só o
  "Parcela N" deixando " de M" sobrando.

Validei a lógica isoladamente (fora do Electron, só as duas funções) com
casos exatos dos 3 bancos — BTG, Itaú (zero-padded) e XP ("de") — antes e
depois do fix, incluindo o caso de memorando customizado pelo usuário sem
nenhuma fração original, e o caso de virada de dígito (09→10/12).
Resultado: os 3 bancos agora progridem corretamente (1/N, 2/N, 3/N...)
preservando o memorando escolhido pelo usuário, igual ao comportamento
que já era correto na BTG.

### Arquivos
- `src/renderer.js` — `detectParcela()`, nova `withParcelNumber()`,
  `confirmBankImport()`, `doImportFromTable()` (`stripParcel` e rebuild
  de `updatedInstallments`).
- `package.json` — 4.85.3 → 4.85.4.

Verificado com `node --check` e um script standalone reproduzindo os 3
formatos reais de banco (incluindo o caso "09→10" de virada de dígito).
Fatura real de XP (`Fatura2026-07-10.csv`, baixada pelo usuário) foi
usada pra confirmar o formato exato "N de M" antes de escrever o fix —
não foi um chute.

---

## 2026-07-28 (4) — v4.85.3: corrige "cache" de importação (2ª fatura repetia dados da 1ª)

### O quê
Usuário reportou: ao importar um extrato/fatura e, na mesma sessão do
app (sem reiniciar), importar outro arquivo (ex: mês seguinte), os
valores do arquivo ANTERIOR reapareciam/se misturavam — "como se
tivesse ficado na memória do parser". Só fechar e reabrir o app
resolvia.

### Causa raiz
`_finishImportWithPatLinksInner()` (`src/renderer.js`), a função que
roda ao final de uma importação bem-sucedida, nunca limpava o estado da
importação: `_pendingImport`, `_bankParsed`, `_importEditRows`
continuavam com os dados do arquivo já importado, e
`clearPersistedImportState()` (que apaga o "resume" salvo em disco via
`ff.importSavePending`) nunca era chamada.

Existe um mecanismo de retomada (`restorePendingImportIfAny()`,
chamado por `initImportPage()`) que restaura esse estado salvo quando a
tela de importação é reaberta — pensado pra sobreviver a um fechamento
acidental do app no meio de uma importação. Como o estado da importação
CONCLUÍDA nunca era limpo, ele ficava "pendurado" em disco e podia ser
restaurado de volta na tela ao reabrir a aba Importar pra uma segunda
importação, repondo os valores do arquivo anterior por cima dos dados
do novo arquivo — exatamente o sintoma relatado. Um branch irmão
(`confirmDupAndImport`, caminho de "só havia substituições diretas")já
fazia essa limpeza corretamente; o caminho principal de sucesso não.

### Fix
Adicionado ao final de `_finishImportWithPatLinksInner()` (depois de
`showImportSummaryModal`/`runFaturaBalanceAudit`) o mesmo reset já usado
em `cancelBankImport()`: `_bankParsed = []`, `_pendingImport = null`,
`_importEditRows = []`, esconder `#bank-preview`, limpar
`#bank-result`/`#bank-file-name`, `hideCardHolderAccountSelectors()` e
`clearPersistedImportState()`.

### Arquivos
- `src/renderer.js` — `_finishImportWithPatLinksInner()`.
- `package.json` — 4.85.2 → 4.85.3.

Verificado com `node --check src/renderer.js` (sintaxe OK). Fix é
puramente de gerenciamento de estado no processo renderer — não requer
teste específico de conta/sync pra validar o mecanismo.

---

## 2026-07-28 (3) — Verificação final do sync de patrimônio: era conta de teste, não bug

### O quê
Terceira rodada do relatório de bugs da aba Patrimônio do mobile. O
usuário disponibilizou a pasta de dados real (`Dropbox/App de Controle
de Gastos/Dados Cruzeiro`) pra eu testar contra os números exatos que
ele via no desktop (CRI Brookfield, Tesouro Prefixado 2032, Song Plus,
Empréstimo Zé).

### Achado: eu vinha testando contra a conta errada
O app Desktop **instalado de verdade** (`AppData\Local\Programs\
Cruzeiro\Cruzeiro.exe`, o mesmo do atalho na área de trabalho) usa
`dataDir` apontando pro Dropbox e está logado como
`thiagomesquitanunes@gmail.com` — diferente da pasta de projeto
(`Cruzeiro Desktop/`, dataDir null) que eu vinha usando com `npm start`
pra testar, logada como `cruzeiroapp@gmail.com` (conta de
desenvolvimento/teste). As duas rodadas anteriores de fix ficaram
corretas no CÓDIGO, mas eu nunca tinha disparado uma sincronização
contra a conta real do usuário — só contra a de teste.

### Verificação com os dados reais
Reproduzi os cálculos (TIR/benchmark) isoladamente com sql.js contra o
banco real do Dropbox, comparando com os números que o usuário via ao
vivo no desktop:

| Ativo | Métrica | Desktop | Reproduzido |
|---|---|---|---|
| CRI Brookfield | nominal / real | 13,7% / 8,7% | 13,68% / 8,63% |
| Tesouro Prefixado 2032 | vs. CDI | -2,2% | -2,24% |
| Song Plus | nominal / real | -7,3% / -10,8% | -7,33% / -10,84% |
| Empréstimo Zé | nominal / real | 12,6% / 5,8% | 12,56% / 5,54% |

3 de 4 bateram quase exatamente (diferenças de arredondamento) — incluindo
o caso mais grave da rodada anterior (vs. CDI mostrando -16,1% no
mobile), que na fórmula corrigida já reproduz -2,24% ≈ -2,2% do desktop.
Usuário confirmou: a diferença residual em Empréstimo Zé é só
arredondamento, sem problema.

### Ação tomada
Não precisei mudar código nesta rodada — as correções da entrada
anterior já estavam certas. O problema era só que o app Desktop
instalado não tinha reiniciado desde a publicação da v4.85.2, então
continuava rodando a sincronização com a fórmula antiga contra a conta
real. Abri o `Cruzeiro.exe` instalado diretamente (confirmei que já
estava na v4.85.2 via auto-update) e disparei uma sincronização real —
`patrimonio_items: 'ok'`, valores corrigidos agora na conta do usuário.

### Lição para sessões futuras
Ao testar sync/patrimônio deste projeto, **`npm start` na pasta do
repositório usa uma conta de desenvolvimento (`cruzeiroapp@gmail.com`),
não a conta real do usuário** (`thiagomesquitanunes@gmail.com`, dados em
`Dropbox/App de Controle de Gastos/Dados Cruzeiro`, settings reais em
`AppData/Roaming/Cruzeiro/_settings.json`). Pra testar/sincronizar contra
dados reais, é preciso rodar o app instalado
(`AppData/Local/Programs/Cruzeiro/Cruzeiro.exe`), não o `npm start` do
projeto — e o app instalado só aplica um fix novo depois de reiniciado
(auto-update não é instantâneo dentro de uma sessão já aberta).

---

## 2026-07-28 (2) — TIR/benchmark de investimentos: fórmula errada, não bug de transporte

### O quê
Segunda rodada do relatório de bugs da aba Patrimônio do mobile. O
usuário esclareceu que o número de referência da rodada anterior
(R$3.473.248,30) era de OUTRO banco de dados, ao qual não tenho acesso
— então a investigação daquele número específico não se aplicava mais.
Focei nos itens que continuavam errados de verdade.

### Achado principal: eu estava usando a fórmula ERRADA de benchmark
Reli o código real que a aba Patrimônio do desktop usa por ativo
(`buildInvRows`, ~linha 25453 de `renderer.js` — não a aba "Rendimentos",
que tem sua própria fórmula, mais simples, num lugar diferente da tela).
A comparação com benchmark de cada investimento ali:
- NÃO é `cumulativeReturn`/`vsCDI` (produto composto das taxas mensais)
  como eu tinha implementado — é a MÉDIA das taxas mensais do período,
  anualizada (`(1+média)^12 - 1`);
- é comparada contra a **TIR NOMINAL** (`irrNominal`), não contra o
  retorno total simples.
Nova função `computeBenchmarkDiff()` em `sync-push.js` replica essa
conta exatamente. Isso explica "comparação com benchmark muito
diferente do desktop" — a fórmula antiga simplesmente não era a mesma
conta que a tela mostra.

### Achado secundário: valor contábil de investimento inflava com aportes
Reli também de onde vem o "valor atual" de um investimento no desktop
(mesmo trecho de `buildInvRows`, comentário explícito no código:
*"bookValue only comes from real valuations (atualizacao) — cashDelta
does NOT contribute to displayed asset value"*). `investmentBookValue()`
(usada tanto por `pushPatrimonio` quanto por `pushPatrimonioItems`)
estava somando o valor de aportes/compras diretamente no valor contábil
(`running += cd`) — só coincidia com o desktop quando aporte e uma
atualização de valor caem no mesmo mês (o caso mais comum, por isso os 3
investimentos de teste não mostravam diferença visível nessa parte
específica, mas outros dados do usuário podiam mostrar). Corrigido:
o valor contábil agora só muda em transações de avaliação
(`atualizacao`/`cota`/`incorporacao`/`correcao`), igual ao desktop.

### TIR de bens e direitos — fix do "1 mês a menos"
Reli `refreshPatrimonioTable` (bens) de novo: a TIR de um bem soma uma
"venda hipotética" no mês SEGUINTE ao atual (`nextM`), não no mês atual
— diferente de investimentos, que somam no próprio mês atual. Meu
`computeBemReturns` usava `curM` pros dois casos. Corrigido pra usar
`nextM` especificamente pra bens — isso pesa mais em bens com pouco
histórico (poucos meses desde a compra), onde 1 mês a mais/menos no
denominador da anualização muda a TIR perceptivelmente.

### Verificação (sql.js contra os 3 investimentos reais do usuário)
```
Poupança:      TIR nominal 7.6%  | TIR real 2.7%  | CDI 12.9% a.a. | vs CDI -5.3%
Tesouro SELIC: TIR nominal 12.6% | TIR real 7.4%  | CDI 12.9% a.a. | vs CDI -0.3%
CDB:           TIR nominal 14.0% | TIR real 8.8%  | CDI 12.9% a.a. | vs CDI +1.1%
```
Números plausíveis e agora usando a MESMA fórmula do código-fonte real
do desktop (não uma reprodução aproximada) — não tenho como comparar
lado a lado com a tela renderizada de verdade (sem GUI automation pro
Electron nem simulador mobile aqui), mas a fórmula está auditada
linha a linha contra `renderer.js`.

### Mobile: filtros e ordenação por categoria de investimentos
`app/(tabs)/patrimonio.js` (iOS + Android, espelhados):
- `INV_CATEGORY_LABEL` tinha chaves erradas (`fundo`/`fii`/`cripto`, que
  não existem no desktop) — corrigido pras chaves reais de
  `INV_CATEGORIES`/`INV_CAT_ORDER` em `renderer.js` (`renda_fixa`,
  `tesouro`, `previdencia`, `fundos`, `renda_variavel`,
  `private_equity`, `caixa`, `valor_em_caixa`).
- Categorias de investimento agora aparecem na MESMA ordem do desktop
  (`INV_CAT_ORDER`), com itens dentro de cada categoria ordenados por
  nome.
- Filtros por categoria/tipo/corretora: chips horizontais (toque
  seleciona, toque de novo limpa) acima da lista de investimentos — só
  aparecem as opções que existem nos dados do usuário. Os totais por
  categoria e da seção respeitam o filtro ativo.

### Verificação
`node --check` no `sync-push.js`. Validei sintaxe do JSX mobile
compilando com o Babel do próprio projeto nos dois repositórios,
confirmando os arquivos compartilhados byte-idênticos. Rodei o app
(`npm start`) — `sync:push` completou com `patrimonio_items: 'ok'` e
`ai_config: 'ok'` desta vez (sem timeout), tudo limpo. Não pude testar
a UI do mobile renderizada de verdade.

---

## 2026-07-28 — Correções após relatório de bugs: Orçamento, Visão Geral, sync de Patrimônio

### O quê
O usuário reportou 9 problemas de uma vez, testando as mudanças da sessão
anterior (nova aba Patrimônio no mobile). Corrigi o que consegui verificar
com confiança; documentei o que fica incerto sem acesso interativo ao
app rodando de verdade (GUI do Electron) ou ao mobile (sem simulador
disponível aqui).

### 1. Orçamento: categoria-mãe + subcategoria contava planejado em dobro
`totalIncomePlanned`/`totalExpensePlanned` (e os totais "realizado"
equivalentes) somavam `budgets.reduce((s,b)=>s+b.monthly_limit,0)` sobre
TODAS as linhas de orçamento — se o usuário cadastrasse um valor
planejado tanto pra categoria-mãe quanto pra uma subcategoria dela, as
duas linhas eram somadas, embora o valor da subcategoria já esteja
embutido no da mãe (via `actualFor(...,consolidate=true)` no lado
"realizado"). Nova função `dedupBudgetsForTotal()` em `renderer.js`:
remove da soma qualquer linha de subcategoria cuja mãe também tenha
orçamento cadastrado E consolide subcategorias (`consolidate_subs !== 0`,
o padrão) — usada em `refreshBudget()` (aba Orçamento) e
`renderDashBudgetGauges()` (os dois gauges "Receitas/Despesas vs.
planejado" na Visão Geral, que tinham o mesmo bug).

### 2. Legenda nos gauges "Receitas/Despesas vs. planejado" (Visão Geral)
`index.html`: ícone ⓘ com tooltip ao lado dos dois títulos, explicando
que o cálculo só considera categorias com planejamento cadastrado —
importante porque, se nem toda categoria tiver planejamento, esse número
não bate com os cards de receita/despesa total do mês.

### 3-8. Reescrita do sync de patrimônio pro mobile (`sync-push.js`)
Investigação profunda usando sql.js direto no banco real do usuário
(`cruzeiro_data.db`) pra reproduzir os números reportados como errados.
Achados e correções:

- **Contas bancárias/cartões somavam TODAS as transações sem limite de
  data.** Uma conta com saldo real de ~R$9 mil somava
  **-R$2,66 milhões** sem esse limite — por causa de lançamentos
  futuros (recorrências materializadas anos à frente). Nova função
  `accountBalanceAt()`: soma só até o fim do mês pedido
  (`date < date(mes||'-01','+1 month')`). Isso sozinho explica os
  "cartões zerados"/"contas com valor errado" — cartão de crédito tinha
  o mesmo problema.
- **"Cartões e dívidas" apareciam em dobro.** O app cria automaticamente
  uma linha em `personal_debts` espelhando cada conta de cartão de
  crédito (`linked_account_id`, usado pro relatório de IRPF — ver
  `main.js` ~linha 5219). Meu código somava a conta `type='credit'` E
  essa dívida pessoal espelhada como duas linhas separadas. Fix: filtro
  `linked_account_id IS NULL` nas duas queries de `personal_debts`
  (`pushPatrimonio` e `pushPatrimonioItems`).
- **Saldo devedor de financiamento saía zero.** O filtro `paid=0 AND
  is_projection=0` quase nunca bate com nenhuma linha do cronograma
  (a maioria das parcelas futuras fica `is_projection=1` até o mês
  chegar). Nova função `bemDebtAndRate()`: usa o ÚLTIMO registro de
  `pat_financing` até o mês, independente de paid/projection — mesmo
  critério que `debtByAsset`/`assetTotalByMonth` usam no renderer.
  Mesmo ajuste em `personal_debt_installments` pra dívidas pessoais
  reais.
- **"Saldo em conta" do total agregado (`pushPatrimonio`) somava TODAS
  as contas não-cartão**, ignorando a escolha do usuário
  (`pat_accounts.included`, a mesma lista que a aba Patrimônio do
  desktop usa pro "Total Patrimônio") — e contava contas
  `type='investment'` cujo saldo já está representado nos próprios
  `inv_assets`, contando o mesmo dinheiro duas vezes. Agora usa só
  `pat_accounts WHERE included=1`.
- **Valor de investimento inconsistente entre as duas funções de push.**
  `pushPatrimonio` usava só a última transação `tx_type='atualizacao'`
  (ignorando aportes feitos sem atualização de valor logo depois);
  `pushPatrimonioItems` já tinha a lógica completa (aportes/resgates +
  resets de avaliação). Extraí pra uma função só, `investmentBookValue()`,
  usada pelas duas.
- **TIR de bens financiados não refletia o financiamento** até existir
  uma `pat_transactions` real do tipo `parcela_financiamento`.
  `computeBemReturns()` agora injeta o mesmo fluxo de caixa hipotético
  que o renderer usa (`refreshPatrimonioTable`): toda parcela projetada
  e ainda não paga entra como saída de caixa no mês dela.
- **Comparação com benchmark muito diferente do desktop.** Eu calculava
  um "retorno anualizado do benchmark no período" — a aba "Rendimentos"
  do desktop (`refreshReturns`/`cumulativeReturn`) usa uma conta bem
  mais simples: retorno TOTAL acumulado (não anualizado) do investimento
  menos o retorno acumulado do benchmark no mesmo período (`vsCDI =
  totalRet - periodCDI`). Reescrevi `benchmark_return` pra seguir essa
  mesma matemática.
- **Estratégia de envio trocada de upsert para DELETE+INSERT.** A tabela
  `mobile_patrimonio_items` já existia no Supabase antes de eu rodar meu
  próprio SQL de criação (motivo que não consegui determinar — não fui eu
  quem criou, nem achei outro indício de quem/quando) — não dava pra
  confiar que a constraint única que meu `upsert(...,'user_id,desktop_id')`
  dependia batia exatamente com a da tabela real, o que é a explicação
  mais provável pra "cartões aparecem duas vezes" e outras inconsistências.
  Agora `pushPatrimonioItems` faz `DELETE` de todas as linhas do usuário
  e `INSERT` limpo a cada sync — elimina esse risco por completo, ao
  custo de reescrever a tabela inteira em vez de só o delta.
  `supabase/patrimonio_items.sql` reescrito com `ALTER TABLE ADD COLUMN
  IF NOT EXISTS` coluna a coluna (em vez de só `CREATE TABLE IF NOT
  EXISTS`), pra garantir que todas as colunas existem mesmo numa tabela
  que já existia com formato diferente. **Preciso que o usuário rode
  este SQL de novo no Supabase Dashboard.**

**TIR real "dando erro" nos investimentos**: reproduzi o cálculo
isoladamente com sql.js pros 3 investimentos reais do usuário e os
números saíram corretos e plausíveis (2,7%/7,4%/8,8% reais) — não
encontrei um bug concreto na fórmula em si. Minha hipótese é que isso
era um efeito colateral do mesmo problema de schema/upsert do item
acima (linha duplicada ou tipo de coluna incompatível corrompendo
especificamente esse campo) — deve estar resolvido pela troca pra
DELETE+INSERT, mas não consigo confirmar sem visualizar o app mobile de
verdade.

**Número exato do patrimônio total não bateu com a referência dada
(R$3.473.248,30).** Depois de todas as correções acima, meu cálculo pro
banco real do usuário deu R$558.642,10 (bens líquidos R$333.480,58 +
investimentos R$226.706 + conta incluída R$9.215,52 − dívidas
R$5.380). Achei uma pista relevante: `pat_history` e
`pat_financing_contracts` têm linhas ÓRFÃS pros `asset_id` 2 e 3, que
não existem mais em `pat_assets` (só os ids 1 e 4 existem hoje) — dados
de um bem de teste que parece ter sido apagado sem os registros
relacionados serem limpos junto (apesar de `PRAGMA foreign_keys = ON`
estar ativo). Não toquei nesses dados órfãos — não tenho certeza se são
só lixo de teste ou algo que o usuário quer manter, e apagar dado sem
confirmação não é algo que eu faça sozinho. Mas é possível que a
referência de R$3,47 milhões que o usuário tinha em mente venha de um
cálculo (talvez `computeLicenseStatus`, que usa `pat_history`/
`inv_transactions` sem filtrar por asset válido) que inclui esse dado
órfão — vale o usuário confirmar o total mostrado ao vivo na aba
Patrimônio do desktop antes de eu investigar mais.

### 9. Totalização por seção/categoria no mobile
`app/(tabs)/patrimonio.js` (iOS + Android, espelhados): cada seção
(bens, cartões/dívidas, contas, investimentos) agora mostra o total no
cabeçalho. Investimentos ficam agrupados por `category`
(`groupByCategory`), cada grupo com sua totalização (valor, TIR real —
média ponderada pelo valor de cada item, já que o mobile só recebe a
TIR pronta por item, não as transações originais pra recalcular uma TIR
real de categoria — e ganho/perda somado).

### Verificação
`node --check` em todos os arquivos JS tocados. Reproduzi a lógica nova
de `pushPatrimonio`/`pushPatrimonioItems` isoladamente com sql.js contra
o banco real (não só um teste sintético) pra validar os números antes
de rodar o app de verdade. Rodei o app (`npm start`) depois de aplicar
tudo — `sync:push` completou com `patrimonio: 'ok'` e
`patrimonio_items: 'ok'`, sem erro (o `ai_config` deu timeout de rede,
sem relação com esta mudança). Validei sintaxe do JS/JSX mobile
compilando com o Babel do próprio projeto nos dois repositórios
(iOS/Android), confirmando os arquivos compartilhados byte-idênticos —
não pude testar a UI do mobile de verdade (sem simulador) nem clicar na
aba Patrimônio do desktop pra comparar visualmente os números (sem
automação de GUI nativa disponível aqui).

---

## 2026-07-27 — Nova aba "Patrimônio" no mobile: sync de itens detalhados

### O quê
A pedido do usuário: o mobile vai ganhar uma aba "Patrimônio" própria
(implementação da tela ainda pendente nos repos iOS/Android — ver tasks
#112/#113), mostrando item a item: bens e direitos, cartões e dívidas,
contas bancárias e investimentos financeiros, cada um com seus campos
específicos (TIR nominal/real, ganho/perda, saldo devedor, comparação com
benchmark etc.). Esta entrada cobre o lado Desktop: o novo sync que
alimenta essa tela.

### `src/lib/irr.js` (novo arquivo)
Extraí `calcIRR()` (Newton-Raphson mensal, depois anualizado) de
`renderer.js` para um módulo único (padrão UMD: `window.calcIRR` no
renderer via `<script>`, `require('./irr')` no processo principal) — o
usuário pediu explicitamente pra não duplicar o motor de cálculo da aba
Patrimônio. `renderer.js` teve sua definição local removida; `index.html`
ganhou `<script src="lib/irr.js"></script>` antes de `renderer.js`.

### `src/sync/sync-push.js` — nova função `pushPatrimonioItems()`
Registrada no `pushAll()` como passo `patrimonio_items`, logo depois de
`patrimonio` (mesmo gate `syncInvestments`/opt-in, mesmo comportamento de
limpar dados remotos se o usuário desativar a opção). Constrói UMA linha
por item:

- **Bens** (`pat_assets`, não ocultos/não vendidos): valor de
  `pat_history`; TIR nominal/real e ganho/perda calculados a partir de
  `pat_transactions` (nova função `computeBemReturns`, usa
  `PAT_TX_CASH_SIGN` — cópia dos sinais de `PAT_TX_CASH` do renderer);
  saldo devedor e taxa de juros de `pat_financing_contracts`/
  `pat_financing` quando `financed=1` (simplificação: usa o primeiro
  contrato ativo — múltiplos contratos por bem são raros e eu não achei
  valor em fazer uma média ponderada agora).
- **Investimentos** (`inv_assets`, não ocultos/não fechados): valor
  "contábil" reconstruído das próprias transações (aportes/resgates +
  resets de avaliação — `computeInvReturns`, mesma lógica de
  `buildInvRows`/`calcAssetRealIRR` do renderer, com `INV_TX_CASH_SIGN`/
  `INV_TX_VALUATION_TYPES` espelhando `INV_TX_EXTERNAL`/`INV_TX_INCOME`/
  `INV_TX_VALUATION`); comparação com benchmark (`computeBenchmarkReturn`)
  usa o cache local de CDI/IBOV (`<db>_benchmarks.json`, já buscado pela
  função `benchmarks:fetch-all` existente) acumulado desde o primeiro
  mês com transação do ativo até hoje, anualizado.
- **Cartões e dívidas**: contas `type='credit'` (saldo devedor = valor
  absoluto do saldo negativo da conta) + `personal_debts`/
  `personal_debt_contracts`/`personal_debt_installments` (dívidas
  pessoais/mútuos tomados — considero "ativa" toda dívida com
  `hidden=0`, já que essa tabela não tem coluna `status`).
- **Contas bancárias**: contas `type IN ('bank','cash')`, só saldo atual
  (`SUM(transactions.amount)` da conta).

TIR/ganho-perda aqui é **mais simples que a versão da tela** de
propósito: só transações reais (sem parcela de financiamento projetada
como fluxo hipotético) e sem o caso de "venda hipotética" de ativo já
vendido (esses nem entram, já filtrados por `hidden=0`/`sold_month IS
NULL`/`closed_month IS NULL`). Documentei essa divergência no comentário
da função — TIR no mobile pode ficar levemente diferente da tela do
desktop para bens financiados com parcelas futuras ainda não pagas.

Todo campo sensível (nome, valores, taxas, TIR, ganho/perda etc.) passa
por `encFields()` igual às outras tabelas — só `user_id`/`desktop_id`/
`section`/`synced_at`/`created_at` ficam em claro (necessário pro mobile
filtrar por seção sem decifrar linha por linha).

### `supabase/patrimonio_items.sql` (novo arquivo)
Nova tabela `mobile_patrimonio_items` (RLS por `auth.uid()=user_id`,
mesmo padrão de `enable_rls.sql`/`terms_acceptances.sql`). **Resultado
inesperado**: ao testar com `npm start` de verdade, o push terminou com
`patrimonio_items: 'ok'` — ou seja, a tabela **já existe** no Supabase
de produção (não sei por quê; não fui eu que rodei esse SQL nesta
sessão). Recomendo rodar o arquivo mesmo assim (é idempotente,
`create table if not exists`) só pra garantir que a política de RLS
bate exatamente com o que descrevi — não tenho como inspecionar o
schema real do Supabase por aqui pra confirmar 100%.

### Verificação
`node --check` em todos os arquivos tocados. Rodei o app de verdade
(`npm start`) depois de matar instâncias antigas do Electron que
ficaram penduradas de testes anteriores nesta sessão (o app usa
`requestSingleInstanceLock`, então uma instância antiga escondia se o
código novo realmente rodava) — `sync:push` completou com
`patrimonio_items: 'ok'`, egress real registrado (`mobile_patrimonio_items
[DELETE] 0.2 KB`), sem erro.

---

## 2026-07-27 — Fix: "patrimônio total" sincronizado só mandava bens e direitos

### O quê
`pushPatrimonio()` em `src/sync/sync-push.js` calculava `total_assets` (e por
consequência `net_worth`) somando **só `pat_assets`** (bens e direitos:
imóvel, veículo, barco, clube, societário, mútuo, outro). O mobile lê
`net_worth` da tabela `mobile_patrimonio` pra alimentar a meta de
aposentadoria de longo prazo (`app/(tabs)/metas.js` no iOS/Android), então
o "patrimônio atual" mostrado lá vinha bem abaixo do patrimônio real —
faltavam investimentos financeiros (`inv_assets`) e saldo em conta
(`transactions`).

### Correção
`total_assets` agora soma três fontes, mesma composição que
`computeLicenseStatus()` já usa em `main.js` pra "totalWealth" (o cálculo
de licença/plano gratuito):
1. **Bens e direitos** (`pat_assets` + `pat_history`) — igual já era.
2. **Investimentos financeiros** (`inv_assets` + `inv_transactions`,
   pegando a última linha `tx_type='atualizacao'` até o mês) — novo.
3. **Saldo em conta** (banco, cartão, dinheiro — `SUM(transactions.amount)`
   até o fim do mês, com `Math.max(0, ...)` igual ao cálculo de licença)
   — novo.

`breakdown` (JSON por categoria, hoje só armazenado — nada no mobile lê
chaves específicas dele ainda) ganhou duas chaves novas: `investimentos` e
`contas`, além das chaves de `asset_type` que já existiam.

**Ajuste seguinte, a pedido do usuário**: `total_debts` deixou de ser só
financiamento — agora é **cartão de crédito (saldo devedor da fatura,
contas `type='credit'`) + financiamentos ativos**. E `total_assets`
(saldo em conta) passou a excluir contas `type='credit'` explicitamente
(`WHERE a.type != 'credit'`) — antes somava TODAS as contas sem
distinção, o que ia contar o cartão duas vezes (uma como "saldo", outra
implícita na dívida). Dívidas pessoais informais
(`personal_debt_contracts`) ainda não entram no cálculo — não achei um
jeito limpo de saber quais estão "ativas" (essa tabela não tem coluna
`status` como `pat_financing_contracts` tem) sem investigar mais a fundo;
fica como limitação conhecida, não uma correção que eu quis arriscar sem
mais certeza.

### Verificação
`node --check` no arquivo tocado. Testei a lógica isoladamente com sql.js
duas vezes (uma antes e outra depois do ajuste de cartão): schema mínimo
replicando accounts/pat_assets/inv_assets/transactions/pat_financing —
bem de R$500.000, investimento de R$100.000, conta banco de R$20.000,
cartão devendo R$3.000, financiamento com saldo devedor de R$200.000 →
`total_assets=620.000`, `total_debts=203.000`, `net_worth=417.000`,
batendo o esperado nos dois casos. Rodei o app de verdade (`npm start`)
depois de cada mudança — `sync:push` concluiu com `patrimonio: 'ok'` nas
duas vezes, sem erro (o único erro no log foi um timeout transitório de
rede em `ai_config`, sem relação com esta mudança). Não validei
end-to-end contra o app mobile lendo o valor atualizado — isso depende
do próximo `sync:pull` do lado mobile.

---

## 2026-07-27 — Comprovante de aceite dos Termos gravado no Supabase

### O quê
Complemento ao modal de consentimento (entrada abaixo, mesmo dia): o
usuário pediu um "comprovante" de que o usuário X aceitou os termos.
Cheguei a desenhar (e depois descartar, a pedido do usuário) uma versão
bem mais invasiva — exigir login/cadastro obrigatório na primeira
abertura do app, antes até dos Termos, pra sempre ter um e-mail
associado. Levantei os riscos reais disso antes de implementar: (a)
usuários já instalados usando 100% local ficariam bloqueados na próxima
atualização, (b) o Supabase deste projeto exige confirmação por e-mail
antes de liberar sessão (confirmado lendo `Signup.jsx` do site — depois
de criar conta, `data.session` vem `null` até o clique no link do
e-mail), então um "gate" de conta obrigatória travaria o primeiro uso
até o usuário confirmar o e-mail, e (c) sem internet no primeiro boot o
app ficaria inutilizável. Perguntei ao usuário como resolver essas 3
tensões antes de mexer em algo tão sensível (autenticação/onboarding) —
ele preferiu cancelar essa parte e pediu só o registro do aceite no
banco, sem mudar o fluxo de login/conta.

### O que foi feito
`supabase/terms_acceptances.sql` (novo arquivo) — tabela
`terms_acceptances` (append-only: só políticas de INSERT/SELECT pro
próprio usuário via RLS, sem UPDATE/DELETE — nem o usuário logado
consegue alterar/apagar um registro já gravado). Colunas: `user_id`
(FK pra `auth.users`, cascade), `email`, `version`, `accepted_at`,
`app_version`, `platform`. **Precisa ser rodado manualmente uma vez no
Supabase Dashboard → SQL Editor** (mesmo processo do
`enable_rls.sql` já existente) — não rodei automaticamente porque não
tenho acesso direto ao painel do Supabase deste projeto.

`src/main.js`: novo handler `ipcMain.handle('terms:record-acceptance', ...)`
(perto de `sync:status`) — só grava se `sb.isLoggedIn()` E existir
`s.supabaseEmail` (ou seja, só para quem já tem conta configurada em
Configurações → App Mobile); best-effort, nunca lança erro pro chamador.
`src/preload.js`: exposto como `ff.termsRecordAcceptance(version)`.
`src/renderer.js`: chamado dentro de `acceptTermsConsent()`, logo após
salvar `termsAcceptedVersion` localmente — fire-and-forget (`.catch(()=>{})`),
não bloqueia o fechamento do modal nem depende do resultado.

### Limitação conhecida (aceita, não é bug)
Quem usa o Desktop sem nunca ter feito login (uso 100% local, sem
sincronização mobile) não tem e-mail nenhum associado à instalação —
pra esse perfil de usuário, o único registro de aceite continua sendo
local (`settings.termsAcceptedVersion`/`termsAcceptedAt`, já gravado
antes desta mudança). Não há como ter um "comprovante" remoto de quem
nunca se identificou.

---

## 2026-07-27 — Termos de Uso completos + modal de consentimento obrigatório

### O quê
A pedido do usuário: reescrita completa dos Termos de Uso (antes 8 seções
curtas, agora 22 seções detalhadas), com ênfase especial em isenção de
responsabilidade sobre dados financeiros e nos riscos de sincronização em
nuvem via Supabase — e implementação de um fluxo de aceite obrigatório no
boot do app. **Não sou advogado**; recomendei ao usuário revisão jurídica
profissional antes deste texto valer como termo definitivo em produção,
mas o conteúdo foi escrito com cuidado deliberado (LGPD, CDC — em
especial o Art. 51 que veda isenção total de responsabilidade em relação
de consumo —, Marco Civil da Internet).

### Conteúdo (fonte única, 3 destinos)
Escrito uma vez em Python (`terms_pt.py`/`terms_en.py`, scripts de sessão,
não versionados no repo) e propagado para:
- `Cruzeiro Site/src/locales/pt.json` e `en.json` (`terms.sections`) —
  consumido por `Terms.jsx` via `dangerouslySetInnerHTML`.
- `legal/TERMOS_DE_USO.md` (versão Markdown, referência canônica do
  Desktop).
- `src/legal-terms-content.js` (novo arquivo) — expõe `window.TERMS_VERSION`
  (`"2026-07-27"`), `window.TERMS_UPDATED_LABEL` e `window.TERMS_HTML`
  (as 22 seções em HTML), carregado via `<script>` em `index.html` antes
  de `renderer.js`.

Estrutura das 22 seções: aceitação/capacidade, definições, descrição do
serviço, cadastro/conta, planos/pagamento/cancelamento, natureza da
ferramenta (sem aconselhamento financeiro/contábil/jurídico), precisão
dos dados, proteção local/senha/backup, **sincronização em nuvem —
segurança e riscos** (infraestrutura Supabase, medidas de segurança
adotadas, reconhecimento expresso de que nenhum sistema é 100% seguro,
o que a arquitetura sem Open Finance reduz e o que não elimina,
notificação de incidentes conforme LGPD, boas práticas do usuário),
recurso de IA, integrações de terceiros, propriedade intelectual, uso
aceitável, isenção de garantias, limitação de responsabilidade (com teto
monetário e ressalva expressa pra dolo/culpa grave e direitos
irrenunciáveis do CDC), indenização, suspensão/encerramento,
atualizações de software, alterações aos termos, lei aplicável/foro,
disposições gerais, contato.

### Modal de consentimento obrigatório (Desktop)
`src/index.html`: novo `#terms-consent-backdrop`/`#terms-consent-modal`
(z-index 99998/99999, acima de tudo no app, incluindo os modais de
confirm/prompt que usam 21000) — **sem** `onclick` no backdrop e sem
botão de fechar, diferente de todo outro modal do app: só sai aceitando
(checkbox + botão "Aceitar e continuar", desabilitado até marcar).

`src/renderer.js`: `checkTermsConsent()` (nova função) é a primeira
linha dentro da IIFE de boot (`// ── INIT ──`, antes de
`fetchFxRates()`) — compara `s.termsAcceptedVersion` (via
`ff.settingsGet()`) contra `window.TERMS_VERSION`; se diferente, injeta
`window.TERMS_HTML` em `#terms-consent-text`, mostra o modal e **retorna
uma Promise que só resolve quando `acceptTermsConsent()` roda** — ou
seja, o resto do boot do app fica bloqueado até o usuário aceitar.
`onTermsConsentCheckChange()` habilita/desabilita o botão conforme o
checkbox. `acceptTermsConsent()` persiste `termsAcceptedVersion` +
`termsAcceptedAt` via `ff.settingsSave()`.

`src/main.js`: `ipcMain.handle('settings:get', ...)` (linha ~6481)
retorna um objeto **whitelisted** (não é passthrough) — precisei
adicionar `termsAcceptedVersion: s.termsAcceptedVersion || null,`
explicitamente pro renderer conseguir ler de volta o que foi salvo (a
gravação em si já funcionava sem mudança nenhuma, porque
`settings:save-data` faz `Object.assign(s, data)` com qualquer chave
nova).

Efeito prático: qualquer usuário existente (sem `termsAcceptedVersion`
salvo) vê o modal na próxima abertura do app, antes de qualquer outra
tela. Ao lançar uma futura revisão dos Termos, basta trocar
`TERMS_VERSION` no gerador (`terms_pt.py`) e regenerar os 3 destinos —
todo mundo vê o modal de novo.

### Não feito nesta sessão
Não propaguei um fluxo de consentimento equivalente para iOS/Android
(o usuário só pediu "no instalador", entendido como o instalador
Desktop) nem criei versionamento automatizado do texto — trocar
`TERMS_VERSION` e regenerar os 3 arquivos continua manual.

---

## 2026-07-27 — Auditoria de código: 3 bugs (sync de patrimônio, undo de transferência, data em UTC)

### O quê
Varredura geral do código do Desktop procurando bugs/inconsistências (a
pedido do usuário), seguida da correção dos 3 problemas reais encontrados.

### Bug 1 — `monthsAgo()` derrubava o sync de patrimônio 7x por ano
`src/sync/sync-push.js`. A função fazia `d.setMonth(d.getMonth() - n)`
partindo de HOJE. Rodando no dia 31, o mês de destino não tem dia 31
(31/abr não existe) e o JS rola pro mês seguinte — `monthsAgo(1)` em
31/mai devolvia `"2026-05"` em vez de `"2026-04"`.

Consequência: a lista `months` usada em `pushPatrimonio()` ficava
`["2026-05","2026-05","2026-03"]` — mês duplicado e abril faltando. Como
o destino é `sb.upsert('mobile_patrimonio', rows, 'user_id,month')`, o
Postgres rejeita batch com chave de conflito repetida (*"ON CONFLICT DO
UPDATE cannot affect row a second time"*) e o `pushPatrimonio` inteiro
lançava exceção. O `pushAll` tem try/catch por step, então o erro só ia
pro console: o usuário não via nada e o mobile ficava com patrimônio
desatualizado. Acontecia em jan/mar/mai/jul/ago/out/dez, recuperando
sozinho no dia seguinte.

Correção: `monthsAgo()` agora monta a data com DIA 1 fixo
(`new Date(y, m - 1 - n, 1)`), que nunca transborda. É o mesmo cuidado
que o resto do código já tinha (o renderer ancora no dia 2 —
`new Date(mes + '-02')` — em `budgetChartPrevMonth`, `apos2Compute12mAvg`
etc.); essa função era a única fora do padrão.

### Bug 2 — undo de edição inline em transferência restaurava só uma perna
`src/main.js`, handler `tx:inline-update`. Editar data/memo/valor de uma
transferência atualiza as DUAS pernas (a perna espelho recebe o valor
com sinal invertido), mas o `pushUndo` registrava apenas a operação de
reversão da perna editada. Dar Ctrl+Z depois de editar o valor deixava,
por exemplo, -100 de um lado e +150 do outro: as duas contas ficavam com
saldo errado, em silêncio. (O branch de `category` logo acima já tratava
as duas pernas corretamente — a inconsistência estava dentro do mesmo
handler.)

Correção: o SELECT da perna espelho agora também lê o valor ANTIGO do
campo (`SELECT id, ${field} as oldValue`) e monta um `pairedUndo`, que é
anexado aos `reverseOps` do `pushUndo`. Validado contra uma instância
real de sql.js: após editar -100→-150 e desfazer, as pernas voltam a
-100/+100 e somam zero.

### Bug 3 — o app inteiro considerava "hoje" em UTC, não no fuso local
`new Date().toISOString().slice(0,10)` serializa em UTC. No Brasil
(UTC−3) isso faz o app "virar o dia" às 21h: um lançamento feito às 22h
nascia datado no dia seguinte, e no último dia do mês o mês corrente
(orçamento, resumo, projeções) pulava pro seguinte 3 horas antes da
meia-noite. Verificado com `TZ=America/Sao_Paulo`: às 21h30 de 31/jul o
app entendia data `2026-08-01` e mês `2026-08`.

Como o erro era consistente em todo o código, não gerava divergência
interna — por isso passou despercebido — mas estava errado contra o
calendário do usuário.

Correção: helpers `todayLocal()`/`monthLocal()` (e `shiftDaysLocal()` no
sync, para as janelas de −90/+60 dias) que montam a data pelos getters
locais (`getFullYear`/`getMonth`/`getDate`). Substituídas TODAS as 27
ocorrências de uma vez, de propósito: trocar só algumas criaria mistura
de fusos, que seria pior que o bug original.

- `main.js`: 12 × `todayLocal()`, 3 × `monthLocal()`
- `renderer.js`: corpo de `todayStr()` + 7 × `todayStr()`, 3 × `.slice(0,7)`
- `sync/sync-push.js`: 5 + janelas de 90/60 dias
- `sync/sync-pull.js`: 2 (data de fallback de quick_entry vinda do mobile)
- `sync/supabase-client.js`: 2 (chave diária do log de egress)

Os `synced_at: new Date().toISOString()` foram mantidos em UTC de
propósito — são timestamps absolutos, não datas de calendário.

Detalhe de implementação: em `renderer.js` o `_pad2` é `function`
declaration (não `const`), porque `todayStr()` é chamada de pontos do
arquivo anteriores à linha da definição e só declarações de função são
içadas — um `const` ficaria na zona morta temporal.

### Arquivos tocados
`src/main.js`, `src/renderer.js`, `src/sync/sync-push.js`,
`src/sync/sync-pull.js`, `src/sync/supabase-client.js`

### Verificação
`node --check` nos 7 arquivos, teste do undo contra sql.js real, teste
de `monthsAgo` nas datas que falhavam (31/jan, 31/mar, 31/mai, 31/jul
21h30) e `npm start` completo — sync subiu com todos os steps `ok`,
incluindo `patrimonio`.

### Pendências conhecidas (não corrigidas, baixa severidade)
- `report:export-pdf` (`main.js`): se `printToPDF` falhar, o HTML
  temporário do relatório não é apagado (o `finally` só destrói a
  janela), deixando dados financeiros em `%TEMP%`.
- `onDbReloaded` exposto em `preload.js` sem nenhum consumidor no
  renderer.

---

## 2026-07-24 (continuação) — Fix crítico: crash "Object has been destroyed" trava o app após auto-update

### O quê
Usuário reportou, após a atualização automática para a v4.84.0/4.84.1,
que o app "não abria mais" — mostrava um diálogo de erro nativo do
Electron: `TypeError: Object has been destroyed at App.<anonymous>
(main.js:22:15)`.

### Causa raiz
Em `src/main.js`, a variável de módulo `win` (janela principal) nunca
era zerada quando a janela era fechada/destruída — só o handler
`win.on('closed', ...)` existia, sem `win = null`. O handler de
`second-instance` (que foca a janela existente quando uma segunda
cópia do app tenta abrir) fazia só `if (win) { win.isMinimized()... }`
— um objeto já destruído continua truthy em JS, então a checagem
passava e a chamada de método na janela morta lançava a exceção.

O gatilho real: o fluxo de auto-update (`update:install` →
`win.hide()` → `quitAndInstall(false, true)`) fecha/destrói a janela e
relança o app. Nesse meio-tempo, um evento `second-instance` disparado
no processo antigo (ainda fechando) batia direto nesse bug e
crashava com uma exceção não tratada no processo principal — o que
podia deixar um processo "zumbi" preso segurando o lock de instância
única (`requestSingleInstanceLock`), fazendo TODA tentativa seguinte
de abrir o app crashar da mesma forma (o processo zumbi respondia ao
`second-instance` e crashava de novo).

### Correção (`src/main.js`)
- `win.on('closed', ...)`: agora zera `win = null` antes de fechar a
  `loginWin`.
- Handler de `app.on('second-instance', ...)`: checagem trocada de
  `if (win)` para `if (win && !win.isDestroyed())`, blindando contra
  qualquer outra referência a uma janela já destruída que passe pelo
  mesmo caminho no futuro.

### Ação imediata pro usuário afetado
Caso o app trave dessa forma: finalizar qualquer processo "Cruzeiro"
remanescente no Gerenciador de Tarefas (ou reiniciar o Windows) para
liberar o lock de instância única, e abrir o app de novo — a versão
já publicada com esse fix substitui o binário problemático.

---

## 2026-07-24 — Fix no modal de lançamentos não relacionados a ativos (importação de corretora)

### O quê
Bug reportado pelo usuário com print: o modal "Lançamentos não
relacionados a ativos" (surgido da task #86, que detecta movimentações
do extrato de corretora que não batem com nenhum ativo e deixa o
usuário registrá-las manualmente) tinha dois problemas:

1. As colunas de Memorando e Categoria não tinham cabeçalho — ficava
   sem contexto o que cada campo da linha significava.
2. O dropdown de sugestão de categoria (`#global-cat-drop`, acionado ao
   focar o campo de categoria) renderizava atrás do próprio modal,
   impossibilitando selecionar qualquer categoria da lista.

### Causa
O `#modal-broker-nonasset` tinha `z-index:21000` (mesmo nível de
`modal-confirm`/`modal-prompt`, modais de alerta "topo de tudo"),
enquanto `#global-cat-drop` — o dropdown global de categorias, usado
por vários campos do app — tem `z-index:9999`. Como 9999 < 21000, o
dropdown sempre ficava coberto pelo modal.

### Correção (`src/index.html`)
- `#modal-broker-nonasset`: `z-index` baixado de `21000` para `8000`
  (mesmo nível de outros modais de importação/revisão como
  `modal-goal`, `modal-budget`, `modal-custom-parser`), abaixo do
  `global-cat-drop` (9999) — dropdown agora aparece por cima.
- Adicionada uma linha de cabeçalho acima de `#broker-nonasset-rows`
  (Data / Valor / Memorando / Categoria), com as mesmas larguras/flex
  das linhas geradas por `renderBrokerNonAssetRows()` em `renderer.js`,
  pra alinhar corretamente com as colunas.

App rodado localmente (`npm start`) pra validação visual pelo usuário.

---

## 2026-07-23 (continuação 2) — Lançamentos futuros excluem cartão de crédito por padrão (desktop + mobile) + fix do card de orçamento mobile

### O quê
Três pedidos do usuário nesta continuação:

1. A lista de "lançamentos futuros" (Visão Geral do desktop, card
   "Próximos lançamentos" na Home do mobile, e o alerta noturno às
   19h do mobile) mostrava TODOS os lançamentos futuros, inclusive
   parcelamentos/assinaturas de cartão de crédito — o usuário não vê
   utilidade nisso pra cartão (nada a se preparar, diferente de conta
   corrente). Pedido: excluir cartão de crédito por padrão nesses 3
   pontos, mas manter o lançamento sincronizando normalmente pro
   mobile (continua aparecendo dentro da própria conta do cartão), e
   dar uma opção nas Configurações (desktop e mobile) pra reverter.
2. Bug no card de resumo da Home do mobile (app Android e iOS): o
   sub-card de orçamento somava `spent`/`monthly_limit` de TODOS os
   `budgets` (despesa E receita) num único número — reproduzido pelo
   usuário com números reais (R$168.016,18/R$205.800,00 = soma de
   R$57.894,32/R$83.800,00 de despesa + R$110.121,86/R$122.000,00 de
   receita). Pedido inicial: mostrar só despesa; correção do próprio
   usuário no meio da tarefa: mostrar as DUAS barras, separadas.
3. Site: 2 screenshots faltando na seção mobile da home (ver próxima
   entrada do changelog, feito em seguida por uma sessão separada
   trabalhando no repo do site).

Esta entrada cobre os itens 1 e 2 (mobile + desktop). O item 2 também
gerou, a pedido do usuário, um `CLAUDE.md` novo no repo
`Cruzeiro Android`, espelhando as orientações que já existiam no
`CLAUDE.md` do repo `Cruzeiro iOS` (adaptado pras particularidades do
Android: `versionCode` em vez de `buildNumber`,
`react-native-android-widget` em vez de `expo-widgets`+SwiftUI, etc.).

### Causa
- **Item 1**: `report:future-pending` (`main.js`) não filtrava por
  `accounts.type` — só existia esse filtro num relatório IRMÃO
  (`report:cashflow-projection`, que já tinha exatamente o padrão
  `includeCredit`/`accWhere` certo pra copiar). No mobile,
  `mobile_scheduled` (que já sincroniza SEM filtro de tipo — a parte
  "continua sincronizando" já funcionava de graça) não carrega
  `account_type` direto, só `account_name`; a Home busca
  `mobile_balances` (que tem `account_type`) na MESMA chamada, então
  dá pra filtrar client-side por nome sem mudar o schema do Supabase
  nem o push do desktop.
- **Item 2**: `loadMonthData()` em `app/(tabs)/index.js` (Android e
  iOS) buscava `mobile_budgets` sem sequer selecionar `budget_type`, e
  somava tudo num `reduce()` só. A aba "Orçamento" (`orcamento.js`) já
  fazia a separação certa (`budget_type !== 'income'` vs
  `=== 'income'`) — a Home nunca replicou essa lógica.

### Correção
**Desktop** (`src/main.js`, `src/preload.js`, `src/index.html`,
`src/renderer.js`):
- Nova preferência local (arquivo `_settings*.json`, igual ao padrão
  já usado por `syncInvestmentsToMobile`): `includeCreditInFuturePending`
  (default `false`). Getter/setter: `getIncludeCreditFuturePref()`,
  IPC `settings:get-include-credit-future` / `settings:set-include-credit-future`.
- `report:future-pending` agora aplica `AND a.type != 'credit'`
  quando a preferência estiver desligada (mesmo idioma de
  `report:cashflow-projection`).
- Novo card "🔮 Lançamentos futuros" em Configurações (antes do card
  "Assistente Moedinha"), com o toggle `#include-credit-future-toggle`
  → `toggleIncludeCreditFuture()`. Ao trocar, se a Visão Geral estiver
  aberta, recarrega a lista na hora (`refreshFuturePending()`).

**Mobile** (`app/(tabs)/index.js`, `app/(tabs)/configuracoes.js`,
`src/lib/notifications.js` — espelhado nos dois repos, Android e iOS):
- `notifications.js` ganhou `isIncludeCreditFutureEnabled()` /
  `setIncludeCreditFutureEnabled()` (SecureStore, chave
  `cruzeiro_include_credit_future` — preferência local do aparelho,
  não sincroniza com o desktop, mesmo padrão de `cruzeiro_notif_enabled`).
- `index.js`: a query de `mobile_scheduled` passou a selecionar
  também `account_name` (não selecionava antes) e o limite subiu de 8
  pra 20 linhas (parte pode ser filtrada como cartão logo em seguida —
  sem isso o card podia mostrar menos de 8 itens à toa mesmo havendo
  mais lançamentos de conta corrente adiante na lista). Depois de
  buscar `mobile_balances` (que já tem `account_type`) na mesma
  chamada, filtra `mobile_scheduled` por nome de conta cujo tipo seja
  `'credit'` (quando a preferência estiver desligada), corta pra 8 e
  usa esse array filtrado tanto pro `setScheduled()` (card da Home)
  quanto pro `scheduleFromData()` (agendamento das notificações de
  véspera) — um filtro só, dois consumidores.
- `configuracoes.js`: novo `Switch` "Incluir cartão de crédito nos
  lançamentos futuros" dentro do card "Notificações" já existente.
- Mesma tela (`index.js`), correção do item 2 (bug do orçamento):
  `budget` state ganhou `incomeSpent`/`incomeTotal`; `loadMonthData()`
  agora separa `expenseBuds`/`incomeBuds` por `budget_type` (mesma
  lógica de `orcamento.js`) e soma cada um separadamente; o card
  "Orçamento" da Home agora mostra duas barras (Despesas e Receitas),
  cada uma com sua cor/percentual/rótulo próprios, em vez de uma barra
  só com número errado.

### Publicação
- **Android**: `eas update --branch production --platform android`
  (commit `fe5aa7a` pro fix do orçamento + CLAUDE.md, `57d99ee` pro
  filtro de cartão nos futuros). ⚠️ Nota: a primeira tentativa de
  publicar usei `eas update --auto` (sem `--branch`/`--platform`
  explícitos) rodando do repo Android — isso publicou pra branch
  `main` (nome da branch git atual), que NÃO está ligada a nenhum
  canal ativo (`eas channel:list` só mostra `production`→`production`
  e `preview`→`preview`) — ou seja, não chegou a nenhum usuário real,
  mas também não substituiu nada. Recomendo sempre `--branch
  production --platform <ios|android>` explícitos daqui pra frente
  (documentado agora no `CLAUDE.md` novo do Android).
- **iOS**: `eas update --branch production --environment production
  --platform ios` (commits `59033fa` com o fix de orçamento
  INCOMPLETO — só despesa, esquecido de espelhar a correção do
  usuário — depois `65888de` completando com receita+despesa
  separadas E o filtro de cartão). Publicado 2x: uma vez só com o fix
  de despesa (antes de eu perceber a lacuna), outra vez já com tudo
  certo — o usuário só recebe a versão final publicada por último.

### Teste
`node --check` não serve pra JSX — usei
`@babel/core.transformFileSync` com `babel-preset-expo` (já presente
em `node_modules` de cada repo mobile) pra confirmar que os 3 arquivos
editados em cada repo (Android e iOS) parseiam sem erro de sintaxe.
Confirmei os dois repos com `diff` que `app/(tabs)/index.js`,
`app/(tabs)/configuracoes.js` e `src/lib/notifications.js` ficaram
byte-a-byte idênticos entre Android e iOS depois de todas as edições
(inclusive a correção da lacuna do item 2). Não testado manualmente em
dispositivo real nesta sessão — recomenda-se conferir no app depois
que o OTA chegar (pode levar alguns minutos/reabrir o app).

### Arquivos
Desktop: `src/main.js`, `src/preload.js`, `src/index.html`,
`src/renderer.js`. Mobile (Android + iOS, espelhado):
`app/(tabs)/index.js`, `app/(tabs)/configuracoes.js`,
`src/lib/notifications.js`. Novo: `Cruzeiro Android/CLAUDE.md`.

---

## 2026-07-23 (continuação) — Importação de corretora: detecta lançamentos não relacionados a ativos (XP/BTG)

### O quê
Pedido do usuário: a conta de investimento pode, para alguns usuários, ser
usada também como conta corrente (PIX, TED, taxas avulsas — não só
dividendos/aportes/resgates de ativos). Antes desta mudança, qualquer
lançamento do extrato que não fosse reconhecido como movimentação de um
ativo específico era silenciosamente absorvido no ajuste de saldo de fim
de mês (ou, no caso específico de TED de retirada na XP, nem chegava a
ser considerado — descartado direto). Agora o app detecta esses
lançamentos e oferece ao usuário a opção de importá-los individualmente
como transações normais na conta, com memorando/categoria e sugestão de
ML — igual à importação de extrato bancário.

### Causa / o que já existia
- BTG: o parser (`parseBTGBroker`, `renderer.js:7844`) só lia o SALDO da
  aba "Conta Corrente" (`caixaValue`) — a tabela de "Movimentações"
  daquela mesma aba (que lista PIX, TED, cashback, taxa de consultoria
  etc., junto com os efeitos em caixa de cupom/rendimento/vencimento de
  ativos) nunca era percorrida.
- XP: o parser (`parseXPBroker`, `renderer.js:8330`) já classificava cada
  linha do extrato (`classifyXPFlowLocal`), mas a linha "TED BCO ...
  RETIRADA EM C/C" (saída de dinheiro pro banco, sem relação com ativos)
  tinha `flow:'ignore'` — descartada sem deixar rastro, ao contrário de
  outras linhas não-reconhecidas (que já iam pra `unresolvedMovements`,
  um mecanismo existente, mas para um problema diferente: linha que É de
  um ativo mas cujo ativo não foi encontrado na posição).

### Correção
- **Parsers**: cada resultado de parse ganhou um novo array
  `nonAssetMovements` (`{date, desc, amount}`), separado do
  `unresolvedMovements` já existente (esse continua servindo só pro caso
  "é de um ativo mas não achei qual").
  - BTG: nova varredura da tabela "Movimentações" da aba "Conta
    Corrente". Um classificador local (`isCCAssetFlow`, termos: cupom,
    rendimento, dividendo, provento, JCP, juros, resgate, aplicação,
    aporte, compra, contribuição, venda, amortização, aquisição de
    cotas, vencimento, IRRF, IOF, "liq bolsa") decide se a linha é
    consequência de um evento de ativo já refletido em outra seção do
    extrato (excluída) ou não (vai pra `nonAssetMovements`). A linha
    "Saldo Anterior" é descartada (é só o saldo inicial, não um
    lançamento).
  - XP: a linha "TED BCO ... RETIRADA EM C/C" passou de `flow:'ignore'`
    pra `flow:'nonasset'`, indo pra `nonAssetMovements` com a data exata
    (novo helper `serialToISO`, ao lado do já existente `serialToMonth`)
    em vez de simplesmente desaparecer.
- **Revisão pós-importação** (`confirmBrokerImport`, `renderer.js`):
  depois de salvar os ativos (`brokerSaveParsed`) e ANTES de calcular o
  ajuste de saldo (`brokerCreateAdjustment`), se houver
  `nonAssetMovements`, abre um novo modal (`showBrokerNonAssetReview`,
  `#modal-broker-nonasset` em `index.html`) listando cada lançamento com
  checkbox (selecionado por padrão), memorando e categoria editáveis —
  memorando/categoria pré-preenchidos via `ff.mlPredictBatch` (mesma
  sugestão de ML da importação bancária, incluindo sugestão de
  transferência real quando aplicável — reaproveita o trabalho da tarefa
  anterior desta sessão). Duas opções: "Ignorar tudo" (comportamento
  antigo — só o ajuste de saldo absorve a diferença) ou "Importar
  selecionadas" (cria as transações escolhidas via `ff.bankImport`, ou
  `ff.transfer` quando a categoria escolhida for uma transferência —
  aprendendo com `ff.mlLearn` em ambos os casos).
- Como a revisão acontece ANTES do cálculo do ajuste, e o ajuste já
  funciona por diferença (`totalLiquido` vs. saldo atual da conta —
  fix da tarefa #82 desta sessão), nenhuma mudança foi necessária na
  lógica de ajuste em si: os lançamentos importados individualmente já
  entram no saldo corrente da conta, e o ajuste final cobre só a
  diferença residual — exatamente o comportamento pedido.
- `renderBrokerPreview`: linha de resumo no topo da pré-visualização
  ganhou um contador "💳 N lançamento(s) fora de ativos (revisão ao
  confirmar)" quando aplicável, pra avisar o usuário antes de chegar na
  tela de revisão.

### Teste
Script isolado em Node (`test_nonasset_classify.js`) rodando os
classificadores novos (copiados literalmente do código) contra as
descrições REAIS de dois extratos que o usuário enviou nesta sessão
("004919725.xlsx"/"004919725 (1).xlsx" da BTG, "Extrato XP.xlsx" da XP)
— 15 casos, todos corretos: CUPOM/IRRF/VENCIMENTO/RENDIMENTO/LIQ
BOLSA/APORTE PREVIDÊNCIA/AQUISIÇÃO DE COTAS excluídos (asset), CASHBACK/
TAXA DE CONSULTORIA/TRANSFERÊNCIA VIA PIX/TED RETIRADA surgidos como
`nonasset` corretamente. `node --check` em `main.js`/`renderer.js` sem
erro.

Não testado manualmente na UI (fluxo completo: selecionar arquivo →
preview → confirmar → modal de revisão → importar) nesta sessão — a
lógica de dados foi validada isoladamente com os arquivos reais
fornecidos pelo usuário; recomenda-se um teste end-to-end no app antes
de confiar cegamente numa importação real de produção.

### Arquivos
`src/renderer.js` (`parseBTGBroker` seção "Conta Corrente",
`parseXPBroker`/`classifyXPFlowLocal`, novo `serialToISO`,
`showBrokerNonAssetReview`/`renderBrokerNonAssetRows`/
`toggleAllBrokerNonAsset`/`resolveBrokerNonAsset`, `confirmBrokerImport`,
`renderBrokerPreview`), `src/index.html` (novo modal
`#modal-broker-nonasset`).

---

## 2026-07-23 — ML sugere transferência real (não só a categoria) + corrige duplicação ao converter categoria de/para transferência

### O quê
Duas melhorias relacionadas pedidas pelo usuário:

1. Quando o machine learning aprendia que um padrão de lançamento
   costumava ser transferência entre contas, ele só sugeria a categoria
   genérica `"Transferência"` (texto), tanto na importação quanto no
   lançamento manual. Isso cria uma transação solta com essa categoria,
   **sem** as duas pernas (`transfer_id` ligando origem e destino) —
   exatamente o estado de "transferência fantasma" que o resto do app
   trata como corrompido (ver migração de pernas órfãs em `main.js:719`).
2. Editar um lançamento pra transformá-lo em transferência (ou uma perna
   de transferência real pra deixar de ser) duplicava dados: no primeiro
   caso, o lançamento original ficava para trás junto com a transferência
   nova; no segundo, a perna editada ficava com categoria nova mas ainda
   ligada por `transfer_id` à perna antiga (agora órfã/inconsistente).

### Causa
- `ml_rules` não tinha nenhum conceito de "conta destino" — só
  `keyword/memo/category`. Então uma regra aprendida de uma transferência
  real só conseguia guardar o texto da categoria, nunca pra qual conta.
- `openTransferFromCat()` (`renderer.js:12827`) só sabia recuperar o
  lançamento de origem a excluir quando disparado a partir de uma linha
  da tabela (`tr[data-id]`) — quando disparado pelo campo de categoria do
  modal "Editar Lançamento" (`#tx-category`, sem `<tr>` ancestral), o
  `hidField` de origem nunca era preenchido, então `saveTransfer()` nunca
  chamava `ff.deleteTx()` no lançamento original.
- `tx:update` e `tx:inline-update` (`main.js`) já sincronizavam
  data/memo/valor entre as duas pernas de uma transferência ao editar,
  mas nunca verificavam se a **categoria** deixou de indicar transferência
  — nesse caso simplesmente ignoravam `transfer_id`, deixando a perna
  editada com categoria nova mas ainda "grudada" na perna antiga.

### Correção
- Nova coluna `ml_rules.transfer_account_id` (nullable). `ml:learn`
  (`main.js`) só grava um valor nela quando a categoria aprendida é
  transferência (`isTransferCat()`, novo helper); ao reaprender o mesmo
  padrão como categoria comum, a coluna é explicitamente limpa (evita
  reaproveitar destino de uma transferência antiga numa regra que não é
  mais transferência).
- `saveTransfer()` (renderer.js) agora chama `ff.mlLearn()` com
  `category:'Transferência', transfer_account_id` após criar uma
  transferência manual pelo modal — é o ponto central de aprendizado.
- `doImport()`: o loop de aprendizado ao final da importação agora
  aprende `transfer_account_id` (resolvido, não o texto `"⇄
  Transferência: Nome"`) pras linhas que viraram transferência real.
- Sugestão de transferência (nunca mais categoria `"Transferência"` pura):
  - `mlSuggest()` (lançamento manual): quando a regra tem
    `transfer_account_id`, resolve o nome ATUAL da conta (não guarda
    nome — sobrevive a renomeação) e preenche o campo com o marcador
    `"⇄ Transferência: Nome"` + `dataset.isTransfer`/`transferDest`.
  - Importação em lote (`withML`, dentro de `confirmBankImport`):
    mesma lógica, reconstrói o marcador a partir do `transfer_account_id`
    salvo. Se a regra tem categoria "Transferência" mas SEM
    `transfer_account_id` (dado antigo, de antes desta correção, ou
    conta destino excluída), a sugestão é suprimida em vez de reproduzir
    o bug antigo.
  - `saveTx()` agora intercepta, antes de salvar, um campo de categoria
    marcado como transferência (`dataset.isTransfer==='1'` + texto no
    formato `"⇄ Transferência: Nome"`) e redireciona pro fluxo real de
    transferência (`openTransferFromCat`) em vez de salvar o texto
    literal como categoria comum.
- `openTransferFromCat()`: agora também preenche o `hidField` de origem
  quando disparado do campo `#tx-category` **e** existe `editingTxId`
  (edição em andamento) — assim `saveTransfer()` exclui corretamente o
  lançamento original nesse caminho também. Também zera esse campo no
  início da função (evitava um valor de uma chamada anterior vazar pra
  uma chamada seguinte sem lançamento de origem).
- `tx:update` e `tx:inline-update` (main.js): quando a transação editada
  pertencia a uma transferência real (`transfer_id` setado) e a nova
  categoria deixou de indicar transferência, agora excluem as DUAS pernas
  antigas e recriam um único lançamento comum com os dados editados —
  com undo completo (restaura as duas pernas originais).

### Teste
Script isolado com `sql.js` contra cópia do banco fake (não altera dados
reais), 5 cenários — todos passaram:
1. `tx:update` convertendo perna de transferência pra categoria normal:
   as duas pernas antigas somem, sobra 1 lançamento novo com a categoria
   editada e `transfer_id=null`.
2. Mesmo cenário via `tx:inline-update` (edição inline na tabela da conta).
3. `ml:learn` gravando `transfer_account_id` ao aprender uma transferência.
4. `ml:learn` limpando `transfer_account_id` ao reaprender o mesmo padrão
   como categoria comum depois.
5. (Reaproveitado de sessão anterior) `node --check` em `main.js` e
   `renderer.js` — sem erro de sintaxe.

Os fluxos de UI (modal "Editar Lançamento" → transferência, sugestão do
ML aparecendo no campo, importação em lote) não foram testados
manualmente na interface nesta sessão — a lógica de dados foi validada
isoladamente; recomenda-se um teste manual rápido no app antes de confiar
cegamente em cenários de produção incomuns (ex.: conta destino oculta).

### Arquivos
`src/main.js` (`ml:learn`, `ml:predict-batch`, `tx:update`,
`tx:inline-update`, novo helper `isTransferCat`, migração
`ALTER TABLE ml_rules ADD COLUMN transfer_account_id`), `src/renderer.js`
(`mlSuggest`, `saveTx`, `saveTransfer`, `openTransferFromCat`, `doImport`).

---

## 2026-07-22 (continuação 2) — Bug: estorno em fatura Santander virava despesa em vez de crédito

### O quê
Usuário testou o fix anterior (período da fatura) e achou outro problema
na mesma fatura: valores negativos no PDF (estornos/devoluções) estavam
todos virando débito na importação.

### Causa
`pushRow()` em `parseSantanderFaturaPDF()` (`src/renderer.js:11376`)
forçava `amount = -Math.abs(amount)` pras seções "Despesas"/
"Parcelamentos", com o comentário "são sempre despesas" — descartando o
sinal real do PDF. Na fatura do usuário, 3 linhas dentro dessas seções
tinham valor NEGATIVO no PDF (estorno de compra, ex: "AMAZON
MARKETPLACE-220,50", "AMAZONMKTPLC*ORALPROXS-0,02") — o `Math.abs()`
convertia esses estornos em mais uma despesa, em vez de reconhecer como
crédito.

### Correção
Removida a distinção — agora as 3 seções (Pagamento, Parcelamentos,
Despesas) usam a mesma regra: `amount = -amount` (inversão simples do
sinal do PDF pra nossa convenção). Compra normal (PDF positivo) continua
virando despesa (negativo); estorno (PDF negativo) agora vira crédito
(positivo) corretamente, igual já acontecia na seção Pagamento.

### Teste
Reproduzido e confirmado com o mesmo PDF real do usuário: as 3 linhas
identificadas (`AMAZONMKTPLC*ORALPROXS-0,02` ×2 datas diferentes,
`AMAZON MARKETPLACE-220,50`) agora saem com `amount` positivo
(0.02/0.02/220.50), enquanto as parcelas normais da mesma loja
continuam negativas — total ainda 61 transações, nenhuma perdida/
duplicada.

---

## 2026-07-23 — Importação de corretora: data do ajuste + caixa zerado

### O quê
Usuário reportou dois bugs no importador de corretora (início de uma
leva maior de melhorias no importador, pedidas em lote):
1. O ajuste de saldo ao final da importação sempre caía no dia 28 do
   mês, mesmo em meses com 29/30/31 dias — qualquer movimentação real
   entre o dia 28 e o fim do mês ficava de fora da comparação de saldo.
2. Quando o saldo em caixa do extrato da corretora é exatamente zero, o
   app pulava o lançamento (tratava como "sem dado"), e o Patrimônio
   repetia o valor do mês anterior em vez de mostrar zero.

### Correção
**Bug 1** — `broker:create-adjustment` em `src/main.js` (~linha 3623):
`adjDate` calculado de verdade (`new Date(ano, mes, 0).getDate()`, mesmo
idiom já usado em outros pontos do arquivo pra "último dia do mês") em
vez do literal `month + '-28'`. A busca por ajuste já existente (pra não
duplicar numa reimportação) também mudou de "data exata" pra "mesmo mês,
por prefixo" — isso tem o efeito colateral bom de MIGRAR automaticamente
qualquer ajuste antigo gravado no dia 28 (pelo bug) pra data certa, na
próxima vez que aquele mês for reimportado, em vez de criar um duplicado
ao lado dele.

**Bug 2** — três lugares tratavam `caixaValue` com checagem "truthy"
(`caixaValue > 0`, `if (!v)`, `if (caixaValue)`), que descarta
incorretamente o número `0`: no parser BTG (`src/renderer.js`, seção
"Conta Corrente"), no parser XP (seção "Saldo Disponível histórico"), e
no handler `broker:save-parsed` em `src/main.js`. Todos trocados pra
checagem "existe" (`!= null`), preservando zero como valor real.
Também corrigida a linha da PRÉVIA da importação (antes de confirmar)
que escondia a linha "Valores em Caixa" quando o valor era zero.

### Teste
Bug 1 testado com script isolado (sql.js) contra cópia do banco fake:
mês de 30 dias, fevereiro normal (28), fevereiro bissexto (29),
reimportação do mesmo mês (não duplica, atualiza a mesma linha), e
migração de um ajuste antigo simulado no dia 28 (migra pra data certa,
sem duplicar) — todos corretos. Bug 2 verificado por leitura do código
(sintaxe conferida) — sem extrato real com caixa zerado disponível pra
teste end-to-end nesta sessão.

---

## 2026-07-22 (continuação 7) — Conferência por saldo diário vira recomendação, não exclusão automática

### O quê
Usuário reportou: a conferência por saldo diário (quando o saldo do
extrato bate com o saldo já registrado no Cruzeiro numa data) descartava
silenciosamente TODOS os lançamentos até essa data, presumindo que já
foram importados. Isso quebra em extratos com pouca movimentação onde um
valor X entra e o MESMO valor X sai depois — o saldo não muda, mas a
movimentação existiu e era descartada sem o usuário nunca ver.

### Correção
`ipcMain.handle('bank:import', ...)` em `src/main.js` (~linha 3054) —
o bloco de conferência por saldo continua encontrando a data mais
recente em que os saldos batem (`autoSkipUntilISO`), mas não pula mais
o processamento das linhas dentro desse período. Elas passam pelo
matcher linha a linha normal; se ele achar uma correspondência
específica, usa o motivo normal (como sempre). Se NÃO achar nada — o
cenário que a conferência por saldo existe pra cobrir —, a linha agora
entra em `potentialDups` com o motivo novo `'saldo-bate'`, em vez de
desaparecer.

Do lado do `src/renderer.js`: removida a remoção-em-bloco que existia
DEPOIS do dry-run (`bankImportRows`, ~linha 5690) — ela ainda excluía
essas linhas de `keptRows` mesmo com o fix acima no main.js, então
precisou sair também. A UI de resolução de duplicatas
(`showDupResolutionUI`) ganhou o rótulo do motivo `'saldo-bate'` e o
banner foi reescrito de "já foram presumidos como importados e não
aparecem na lista" pra "recomendamos pular — já vêm marcados assim,
mas você pode importar mesmo assim". O padrão de cada linha continua
sendo "pular" (like antes), só que agora editável — igual qualquer
outra duplicata na tela, linha a linha ou via "✅ Importar todas".

### Teste
Testado ao vivo via CDP contra o app real, com `dryRun:true` (só leitura,
sem inserir nada) usando dados sintéticos numa conta real: linha no dia
exato do saldo batido → `'saldo-bate'`; linha fictícia dentro do
período sem correspondência na base → também `'saldo-bate'` (o cenário
relatado); linha fora do período → não marcada, segue normal. Os 3
casos confirmados corretos.

---

## 2026-07-22 (continuação 6) — Bug: extrato BTG (conta corrente) não reconhecido — layout novo

### O quê
Usuário reportou "nenhuma transação encontrada" ao importar um extrato
de conta corrente BTG (.xlsx).

### Causa
`parseBankBTGExtrato()` (`src/renderer.js:7472`) só reconhecia o layout
antigo do extrato ("Data e hora | Categoria | Transação | ... |
Descrição | ... | Valor"). O BTG mudou o formato de exportação — o
arquivo do usuário trazia "Data de lançamento | Descrição do lançamento
| Entradas / Saídas (R$) | Saldo (R$)": sem coluna "Transação" separada,
e a coluna de valor renomeada de "Valor" pra "Entradas / Saídas". A
detecção de cabeçalho exigia encontrar as duas colunas ("transa" E
"valor") na mesma linha — no arquivo novo, nenhuma bate, então a função
nunca achava a tabela e retornava vazio.

### Correção
Detecção e mapeamento de colunas agora aceitam os dois layouts: coluna
de valor casa com "valor" OU "entrada" OU "saida"; coluna "Transação" é
opcional (só usada se existir, layout antigo); e a coluna "Saldo" (só no
layout novo) agora é capturada e preenchida no campo `saldo` de cada
lançamento (antes sempre `null`).

### Teste
Reproduzido e confirmado com o arquivo real do usuário (extrato PJ
R2T2 Participações, outubro/2025): 7 transações extraídas corretamente
via CDP contra o app rodando — datas, valores (incluindo Pix
enviado/recebido, boleto, devolução) e saldo por linha todos batendo com
o arquivo original.

---

## 2026-07-22 (continuação 5) — Ajuste 2: campo+botões da Pós-aposentadoria ao lado, não empilhados

### O quê
A correção anterior (empilhar campo em cima, botões embaixo) resolveu o
aperto horizontal mas criou um vão vazio grande — a coluna "Patrimônio
inicial" ficou muito mais alta que as colunas vizinhas ("Idade inicial",
"Juros reais") no mesmo grid, empurrando a linha seguinte pra baixo.
Usuário pediu: campo de valor de um lado, e os botões + link "escolher
bens" empilhados numa coluna estreita do outro lado (não embaixo).

### Correção
`src/index.html` (~linha 1799-1809): volta a ser `display:flex` em
linha, mas agora com uma coluna fixa de 118px à direita do campo
contendo os 2 botões + o link, empilhados verticalmente (fonte/padding
reduzidos, sem `white-space:nowrap` — o texto "usar patrimônio
pretendido" quebra em 2 linhas dentro da coluna estreita, o que é
aceitável). A dica de texto embaixo ("Usados só no 'usar atual'...")
continua ocupando a largura toda, fora do flex row.

### Teste
Confirmado por screenshot ao vivo via CDP — altura da coluna agora bate
com as vizinhas, sem vão vazio.

---

## 2026-07-22 (continuação 4) — Ajuste: layout do "usar patrimônio pretendido" espremido

### O quê
Usuário testou o botão novo (entrada anterior) e o layout ficou
espremido: campo de valor + 2 botões numa linha só, texto do segundo
botão cortado.

### Correção
`src/index.html` (~linha 1799): campo "Patrimônio inicial" agora ocupa
a largura toda sozinho; os dois botões ("usar atual" / "usar patrimônio
pretendido") ficam empilhados verticalmente abaixo, um em cima do
outro. Confirmado por screenshot ao vivo via CDP.

---

## 2026-07-22 (continuação 3) — Pós-aposentadoria: botão "usar patrimônio pretendido"

### O quê
Novo botão na visão "Pós-aposentadoria" (aba Aposentadoria), ao lado do
já existente "usar atual": puxa como patrimônio inicial da simulação o
patrimônio que o usuário PRETENDE ter na aposentadoria (a meta
configurada na visão "Rumo à Aposentadoria"), em vez do patrimônio
atual. Permite simular o consumo do patrimônio-alvo, não do que já foi
acumulado até hoje.

### Arquivos
- `src/renderer.js`, `aposCalc()` (~linha 25757): expõe
  `window._aposMetaPatrimonio = metaPatrimonio` logo após calcular a
  meta (limpa pra `null` no early-return se a visão 1 estiver
  incompleta — evita usar um valor obsoleto de uma sessão anterior).
- `src/renderer.js`, nova função `apos2PullPatrimonioMeta()` (perto de
  `apos2PullPatrimonio()`): lê o global acima, avisa com toast se ainda
  não disponível (pede pra preencher a meta na visão 1 primeiro),
  senão preenche `apos2-pat-inicial` e recalcula.
- `src/index.html` (~linha 1804): novo botão "usar patrimônio
  pretendido" ao lado do "usar atual".

### Teste
Sintaxe verificada. Testado ao vivo via CDP: com o global setado
manualmente (sem tocar na config real do usuário — `aposCalc()` grava
no disco ao rodar, e a meta real do usuário estava vazia), o botão
preencheu `apos2-pat-inicial` corretamente e o `rawValue()` bateu com o
valor esperado. Restaurado o valor original do campo depois do teste
(o clique de teste, ao chamar `apos2Calc()`, tinha sobrescrito a
config salva do usuário com o valor de teste — corrigido antes de
encerrar).

---

## 2026-07-22 (continuação) — Bug: fatura Santander recusada ("Não foi possível identificar o período")

### O quê
Usuário reportou erro ao importar uma fatura Santander específica:
"Não foi possível identificar o período da fatura Santander ('Esta
Fatura')."

### Causa
`parseSantanderFaturaPDF()` (`src/renderer.js:11203`) procura a linha
"Esta Fatura" na página 1 pra extrair o período de cobrança, usando
`/EstaFatura/i` (sem espaço) sobre o texto "denso" (glifos concatenados
sem espaços — técnica normal pra esse PDF fragmentado). Nesta fatura em
específico, o pdf.js extraiu "Esta Fatura" como um item de texto ÚNICO
com o espaço interno preservado (em vez de fragmentos glifo-a-glifo sem
espaço, como no resto do documento) — o regex sem tolerância a espaço
nunca batia. O mesmo valia pro regex de extração das datas
(`DD/MM/YYaDD/MM/YY`, sem espaço ao redor do "a") — o texto real trazia
"30/05/26 a 30/06/26", com espaços.

### Correção
Os dois regex agora toleram espaço opcional: `/Esta\s*Fatura/i` e
`/(\d{2}\/\d{2}\/\d{2})\s*a\s*(\d{2}\/\d{2}\/\d{2})/`. Comportamento
pro formato antigo (sem espaço) continua idêntico — `\s*` casa
string vazia também.

### Teste
Reproduzido com o PDF real do usuário (extração do texto bruto da
página 1 via pdf.js, ao vivo no app rodando, confirmando a hipótese
antes de mexer no código) e depois validado rodando
`parseSantanderFaturaPDF()` de ponta a ponta com o mesmo arquivo: 61
transações extraídas corretamente, datas dentro do período correto
(30/05 a 30/06/26), parcelas resolvidas certinho (ex: "TATIANNA
PERAZOLO DERM 09/10").

---

## 2026-07-22 — Windows Store: corrige "Tile" com ícone padrão (certificação recusada)

### O quê
Microsoft recusou a certificação (Product ID `9P0JHTVM816H`) com o motivo
"10.1.1.11 On Device Tiles — The available product tile icons include a
default image", pacote com violação: "Tile".

### Causa
`build.appx` no `package.json` nunca configurou uma pasta de assets
customizados pro appx (`assets/appx/`) — sem ela, o `electron-builder`
usa suas PRÓPRIAS imagens de amostra genéricas
(`node_modules/app-builder-lib/templates/appxAssets/SampleAppx.*.png`)
pra `StoreLogo.png`, `Square150x150Logo.png`, `Square44x44Logo.png` e
`Wide310x150Logo.png` (ver `AppXTarget.js`, `vendorAssetsForDefaultAssets`)
— literalmente o ícone genérico do electron-builder, não o logo do
Cruzeiro. Além disso, `Square310x310Logo` (tile grande) e
`Square71x71Logo` (tile pequeno) nunca eram declarados no
`AppxManifest.xml` — o template só inclui esses dois SE existirem
`LargeTile.png`/`SmallTile.png` na pasta de assets (`AppxTarget.js`,
`defaultTileTag()`), e como nunca existiram, essas duas variantes de
tile simplesmente não tinham NENHUM ícone customizado — fonte provável
do "default image" reportado pela Microsoft.

### Correção
Criada `assets/appx/` (pasta que o electron-builder já procura
automaticamente — `APPX_ASSETS_DIR_NAME = "appx"` relativo a
`directories.buildResources`, que já era `"assets"`) com os 6 ícones
gerados a partir do mesmo `assets/icon.svg` (círculo dourado "C$" +
barras verdes, fundo `#004d40`, cantos arredondados):
- `StoreLogo.png` (50×50), `Square44x44Logo.png` (44×44),
  `SmallTile.png` (71×71), `Square150x150Logo.png` (150×150),
  `LargeTile.png` (310×310) — ícone centralizado com pequena margem.
- `Wide310x150Logo.png` (310×150) — ícone centralizado sobre fundo
  sólido da marca (`#0d3b2e`, mesma cor de `appx.backgroundColor`).

Gerados via Chromium headless (canvas 2D, sem dependência de
ImageMagick/sharp/Inkscape — nenhum instalado nesta máquina): SVG
carregado como `<img>`, desenhado em `<canvas>` no tamanho exato de
cada asset, exportado com `toDataURL('image/png')`. Script descartável
em scratchpad de sessão, não faz parte do repo.

### Teste
Build local do appx não roda nesta máquina (falha reconhecida, ver
entrada anterior sobre `winCodeSign`/symlink — corporativo, sem Modo de
Desenvolvedor). Verificação feita por leitura direta do código do
`electron-builder` (`AppXTarget.computeUserAssets`/`defaultTileTag`):
com os 6 arquivos agora presentes em `assets/appx/`, nenhum dos 4
fallbacks de amostra é usado (`isDefaultAssetIncluded` encontra os 4
nomes), e as duas tags que faltavam (`Square310x310Logo`,
`Square71x71Logo`) passam a ser incluídas no manifesto. Confirmação
definitiva só via o workflow manual `build-appx-test.yml` (Actions →
"Build Windows Store (.appx) — teste manual" → Run workflow) — precisa
ser disparado pelo usuário (sem `gh` CLI disponível nesta sessão pra
disparar via API).

### Próximo passo
Rodar o workflow, baixar o `.appx` gerado (artefato do run), reenviar
pro Partner Center. Informar o Product ID (`9P0JHTVM816H`) se precisar
contatar o suporte da Microsoft.

---

## 2026-07-21 (continuação 8) — Refeito o vídeo #5 (Orçamento): narração atrasada

### O quê
Usuário achou que "toda a narração ficou um pouco atrasada" na v2 do
vídeo de Orçamento (entrada anterior). Encurtou o texto de 3 das 7 falas
e antecipou o início da 1ª (00:49→00:19), reduzindo o quanto cada fala
precisa do empurrão em cascata (mecanismo de 2026-07-20 que evita
sobreposição de narrações). Publicado direto no site (`orcamento.mp4`),
sem espera de aprovação — usuário confirmou que vai revisar direto lá.

### Resultado
Atraso acumulado máximo caiu de 8.56s (v2) pra 6.53s (v3), e o vídeo
voltou a caber no tamanho natural (48.40s) sem precisar esticar o
encerramento (o fix de 2026-07-21 continuação 7 pra isso continua
disponível, só não foi necessário desta vez).

---

## 2026-07-21 (continuação 7) — Vídeo promocional #5 (Orçamento) + fix no pipeline de narração

### O quê
Novo vídeo narrado da aba Orçamento, publicado no site
(`Cruzeiro Site/public/videos/orcamento.mp4`, referenciado em
`Features.jsx` na entrada `'orcamento'`) e salvo localmente em
`store-assets/videos/05-orcamento-narrado.mp4` (fora do git, mesmo
padrão dos outros 4 vídeos). Usuário autorizou publicar sem aprovação
prévia dessa vez.

### Bug encontrado no pipeline (`assemble_narrated.js`, scratchpad)
Esse vídeo tem 7 falas de narração bem mais densas/longas que os
anteriores, encaixadas numa gravação de só 41s — o empurrão em cascata
(quando uma narração ainda não terminou e a próxima "deveria" começar,
ver entrada de 2026-07-20 sobre esse mecanismo) acumulou atraso
suficiente pra a ÚLTIMA fala ("Nunca mais perca o controle do seu
planejamento") terminar DEPOIS do fim natural do vídeo (abertura +
gravação + encerramento no tamanho padrão) — o `-shortest` do mux final
cortaria a frase pela metade, sem nenhum aviso.

**Correção no script**: depois de calcular a cascata de delays (que
precisa rodar antes, já que depende só da duração da abertura), mede se
a última narração ultrapassa a duração natural do vídeo e, se sim,
estica o encerramento com `tpad=stop_mode=clone` (mesma técnica já usada
na abertura) até sobrar uma folga de 1.2s. Sem essa folga, o vídeo
teria: 48.40s naturais vs. última fala terminando em 49.64s — corrigido
esticando o encerramento em 2.43s (log de aviso adicionado também, pro
caso de precisar mais que isso numa próxima vez).

### Teste
Rodado o pipeline com o fix, sem cortes: vídeo final com 50.83s, última
narração terminando em 49.64s (dentro do total, com folga).

---

## 2026-07-21 (continuação 6) — Ajuste: Rollover verde ilegível na linha de totalização

### O quê
Na linha de totalização de "Despesas" (aba Orçamento, fundo vermelho
sólido), o valor da coluna Rollover usava a mesma cor verde/vermelha da
linha de categoria individual — verde sobre fundo vermelho, ilegível.

### Correção
`groupRow()` (`src/renderer.js:16261`, usada só nas linhas de
totalização Receitas/Despesas) não coloca mais um `<span>` colorido
dentro da célula — o texto herda a cor branca já aplicada no `<td>` pai
(mesmo padrão das outras células dessa linha). A cor verde/vermelha por
sinal continua normal na linha de cada categoria (fundo claro, onde faz
sentido).

### Teste
Confirmado ao vivo via CDP: célula da linha "Despesas" com
`color: rgb(255, 255, 255)`, sem `<span>` interno.

---

## 2026-07-21 (continuação 5) — Ajuste: coluna "Rollover" mais larga na aba Orçamento

### O quê
Usuário pediu para aumentar a largura da coluna "Rollover" na tabela da
aba Orçamento (`src/index.html`/`src/renderer.js`), que estava apertada
demais pra valores maiores.

### Causa (não era só CSS)
A tabela usa `table-layout:fixed` com um `<colgroup>` gerado
dinamicamente em JS (`STICKY_W`, `renderBudgetPage()` em
`src/renderer.js:16214`) — em layout fixo, a largura do `<col>` tem
prioridade sobre a largura declarada na classe CSS do `<th>`/`<td>`
(`.budget-sticky-3` em `src/index.html:391`). Mudar só o CSS não tinha
efeito nenhum visualmente porque o colgroup sobrescrevia.

### Correção
Dois lugares, mesma largura (90px → 130px), pra ficar consistente:
- `src/index.html:391` — `.budget-sticky-3{width:130px}` (e ajustado o
  `left` das colunas seguintes, `.budget-sticky-4`/`-5`, que empilham
  horizontalmente via `position:sticky`).
- `src/renderer.js:16214` — `STICKY_W = [170, 120, 130, 80, 80]`
  (o valor que realmente manda no layout fixo).

### Teste
Verificado ao vivo via CDP contra o app real: `offsetWidth` da coluna
Rollover confirmado em 130px (era 90px) após a correção, colunas
seguintes reposicionadas corretamente sem sobreposição, sem clipping de
conteúdo.

---

## 2026-07-21 (continuação 4) — Bug: gauges de meta na Visão Geral travavam em 200%

### O quê
Usuário notou que, na aba Visão Geral, o gauge de "Curto prazo" (meta de
aposentadoria) parava de subir em 200% mesmo quando o progresso real era
maior (ex: 222%, valor que a própria aba Metas já mostrava corretamente
sem teto). Pediu para nenhum gauge de meta ter teto.

### Causa
`renderDashGoals()` (`src/renderer.js`, linha ~1783), usada só na Visão
Geral, tinha três `Math.min(pct, 200)` que a aba Metas (`renderRetirementGoalCard`/
`renderGoalCard`, mesmo arquivo) nunca teve — essa última já calcula o
percentual sem teto, e só o anel visual do gauge (`lap1`/`lap2`, 2 voltas
no máximo) satura visualmente em 200%; o número exibido acima do anel
sempre foi o valor real. Os três limites removidos:
- `pctLong` (longo prazo — patrimônio) e `pctShort` (curto prazo —
  poupança mensal) do card duplo da meta de aposentadoria.
- `pct` do card simples de metas normais (`target`/`monthly`/`emergency`).

### Correção
Removidos os três `Math.min(_, 200)`, deixando os percentuais exibidos
sem teto — mesmo comportamento que a aba Metas já tinha. O anel do
gauge continua com o mesmo visual de antes (satura em 2 voltas = "200%
cheio" na cor verde), só o número acima dele agora sobe livremente.

### Teste
Sintaxe verificada (`node -c`) e app testado ao vivo via CDP na aba
Visão Geral sem erros — os valores atuais do usuário estavam abaixo de
200% no momento do teste (dado ao vivo, muda com o tempo), então a
correção foi confirmada por leitura do código (nenhum `Math.min(_,200)`
remanescente) e pela ausência de erros ao renderizar.

---

## 2026-07-21 (continuação 3) — Bug: calculadora do campo de valor perdia os centavos ao usar operador

### O quê
Usuário relatou: ao digitar um valor com centavos no campo de valor (que
funciona como calculadora embutida — aceita `+`, `-`, `*`, `/`) e em
seguida apertar um operador, os centavos somem e o valor passa a ser
tratado como se fosse em reais — 100x maior que o digitado. Ex: `R$
150,45` seguido de `+` virava, na prática, `15045` (interpretado como
150,45 reais na formatação errada), resultando num total 100x maior que
o esperado.

### Causa
`setupCurrencyInput()` (`src/renderer.js:17794`) formata dígitos como
moeda "caixa eletrônico" enquanto o usuário digita (dígitos empurram os
centavos da direita pra esquerda). Ao detectar o primeiro operador
matemático, o código precisa reconverter esse operando pro formato que a
expressão espera — e uma correção anterior (2026-07-20, ver "Modal de
lançamento/transferência: calculadora embutida") já havia resolvido o
caso de valores pequenos (digitar "48" e ficar preso em "R$0,48" em vez
de virar "48" na expressão). Mas essa correção reduzia QUALQUER operando
para dígitos crus antes do operador — inclusive valores que já tinham
reais E centavos reais (ex: `R$ 150,45` → dígitos crus `15045`), o que
descarta a vírgula decimal e multiplica o valor final por 100 quando a
expressão é avaliada.

### Correção
Mesmo trecho (`src/renderer.js`, dentro do listener `input` de
`setupCurrencyInput`): agora só reduz a dígitos crus quando o valor é
menor que R$1,00 (só centavos, sem parte inteira — o caso original que a
correção anterior visava). Para valores de R$1,00 pra cima, preserva
como decimal com vírgula (ex: `R$150,45` → `150,45`), consistente com o
formato que o resto da expressão espera (segundo operando digitado
livremente pelo usuário, com vírgula manual).

### Teste
Verificado ao vivo via CDP contra o app real rodando (sem alterar dados,
só manipulando o campo do modal "Novo lançamento" e fechando sem salvar):
- `48+50` → `R$ 98,00` (comportamento do caso pequeno, inalterado)
- `150,45+10,00` → `R$ 160,45` (caso do bug relatado, antes daria
  `R$ 15.055,00` — confirmado corrigido)
- `R$1,00` exato (fronteira de 100 centavos) também preserva a vírgula
  corretamente.

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
