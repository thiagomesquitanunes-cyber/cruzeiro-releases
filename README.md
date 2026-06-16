# Site do Cruzeiro

Site institucional do app Cruzeiro — finanças pessoais. Construído com Vite + React + Tailwind CSS, com suporte a português, inglês e espanhol.

## Rodando localmente

```bash
npm install
npm run dev       # ambiente de desenvolvimento
npm run build     # gera a versão de produção em /dist
npm run preview   # serve a versão de produção localmente
```

## Estrutura

- `src/locales/{pt,en,es}.json` — todo o conteúdo textual do site, por idioma
- `src/i18n.js` — configuração de idiomas (detecta o idioma do navegador, com PT como padrão)
- `src/components/` — Header, Footer, ícones, e a constelação do Cruzeiro do Sul (assinatura visual do site)
- `src/components/sections/` — seções da home (Hero, História, Funcionalidades, Como funciona, Planos)
- `src/pages/` — páginas: Home, Download, Assinar (`/assinar`), Fale conosco (`/contato`)

## Configurações pendentes antes de publicar

### 1. Formulário de contato (Fale conosco)

O formulário em `src/pages/Contact.jsx` envia os dados via `fetch` para um endpoint do
[Formspree](https://formspree.io) (gratuito até 50 envios/mês).

1. Crie uma conta em formspree.io
2. Crie um novo formulário, configurando o destinatário como `cruzeiroapp@gmail.com`
3. Copie o endpoint (algo como `https://formspree.io/f/abcd1234`)
4. Substitua `FORM_ENDPOINT` no topo de `src/pages/Contact.jsx`

Alternativa: [Web3Forms](https://web3forms.com) (também gratuito, funciona de forma parecida).

### 2. Pagamento via PIX

Em `src/pages/Subscribe.jsx`:

1. Defina `PIX_KEY` com sua chave PIX real (e-mail, CPF/CNPJ, telefone ou chave aleatória)
2. Gere o QR code estático da sua chave PIX (no app do seu banco, em "Receber com PIX" ou
   similar — a maioria permite exportar/baixar a imagem do QR code) e salve em
   `public/pix-qrcode.png` (ou ajuste `PIX_QR_IMAGE` para o nome do arquivo)

### 3. Pagamento via cartão (Mercado Pago)

1. Crie uma conta no [Mercado Pago](https://www.mercadopago.com.br) (pessoa física ou CNPJ)
2. No painel, crie dois "links de pagamento" ou "assinaturas recorrentes":
   - Plano mensal (ex: R$ 19,90/mês)
   - Plano anual (ex: R$ 179,00/ano)
3. Copie os links gerados e substitua `MP_LINK_MONTHLY` e `MP_LINK_ANNUAL` em
   `src/pages/Subscribe.jsx`

Atenção: os preços exibidos em `src/locales/*.json` (`pricing.premium.price_monthly` /
`price_annual`) devem corresponder aos valores configurados no Mercado Pago.

### 4. Download do instalador (GitHub Releases)

Em `src/pages/Download.jsx`:

1. Crie um repositório no GitHub (ex: `cruzeiroapp/cruzeiro`)
2. Publique uma "Release" com os arquivos `.exe` (Windows) e `.dmg` (Mac) como anexos
3. Ajuste `RELEASE_BASE` e `VERSION` no topo do arquivo para os nomes reais dos arquivos
   publicados

O link `.../releases/latest/download/<nome-do-arquivo>` sempre aponta para o arquivo mais
recente, então novas versões só exigem subir o novo arquivo com o mesmo nome (ou atualizar
o `VERSION`).

## Deploy

Recomendado: [Vercel](https://vercel.com) ou [Netlify](https://netlify.com) (gratuitos para
sites estáticos).

1. Suba este projeto para um repositório Git
2. Conecte o repositório na Vercel/Netlify
3. Build command: `npm run build` — output directory: `dist`
4. Configure o domínio `cruzeiroapp.com.br` apontando para o projeto (DNS via CNAME/A record,
   conforme instruções da plataforma escolhida)

## Conteúdo / textos

Todo o texto do site está em `src/locales/pt.json` (português, canônico), `en.json` (inglês)
e `es.json` (espanhol). Para alterar qualquer texto — preços, descrições de funcionalidades,
etc. — edite o arquivo JSON correspondente; não é necessário tocar nos componentes.
