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
