# Cruzeiro Desktop — notas para sessões do Claude Code

App de finanças pessoais em Electron (`src/main.js` processo principal,
`src/renderer.js` renderer, `src/index.html` UI, `src/preload.js` bridge).

## Antes de começar qualquer tarefa

Leia [`CHANGELOG_CLAUDE.md`](./CHANGELOG_CLAUDE.md) — é um registro
detalhado (mais recente primeiro) do que sessões anteriores do Claude
Code fizeram neste projeto, por quê, e quais arquivos/funções foram
tocados. Não é o mesmo que `git log` (que mostra o "o quê" mas não o
"por quê" nem o contexto de decisões tomadas ao longo da conversa).

## Ao concluir qualquer tarefa

Adicione uma entrada nova no TOPO do `CHANGELOG_CLAUDE.md` descrevendo o
que mudou e por quê — mesmo padrão das entradas já existentes lá. Isso
vale pra qualquer mudança de código, não só publicações de versão.
