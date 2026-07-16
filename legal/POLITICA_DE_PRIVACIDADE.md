# Política de Privacidade — Cruzeiro

**Última atualização:** 16 de julho de 2026

## 1. Quem somos

O Cruzeiro é um aplicativo de finanças pessoais desenvolvido e mantido por
Thiago Mesquita Nunes ("nós", "Cruzeiro"). Esta política descreve como
tratamos os dados de quem usa o Cruzeiro Desktop (Windows/Mac) e o Cruzeiro
Mobile (iOS/Android).

**Contato:** cruzeiroapp@gmail.com

## 2. Como o Cruzeiro funciona (importante para entender esta política)

O **Cruzeiro Desktop** é a fonte principal dos seus dados financeiros:
contas, cartões, transações, orçamentos, metas, patrimônio e financiamentos
ficam armazenados **localmente, no seu computador**, em um banco de dados no
seu próprio disco — não em um servidor nosso. Você pode, opcionalmente,
proteger esse banco com senha (criptografia local).

O **Cruzeiro Mobile** é um aplicativo complementar: para usá-lo, você cria
uma conta (e-mail e senha) e ativa a sincronização no Desktop. A partir daí,
uma cópia dos dados necessários para o uso no celular (contas, transações,
orçamentos, metas, evolução, lançamentos futuros) é enviada para um banco de
dados na nuvem operado pelo nosso provedor de infraestrutura, Supabase
(região São Paulo, Brasil), para que você possa acessá-los pelo celular. Sem
essa sincronização ativa, o Mobile não tem o que mostrar.

## 3. Dados que coletamos

- **Dados de conta**: e-mail e senha (a senha nunca fica acessível a nós —
  a autenticação é feita pelo Supabase Auth).
- **Dados financeiros que você insere**: contas bancárias e cartões (nome,
  tipo, saldo), transações (data, valor, categoria, memorando), orçamentos,
  metas, patrimônio (investimentos, imóveis, financiamentos), dívidas
  pessoais — apenas os que você opta por sincronizar.
- **Dados de dispositivo**, sempre com sua permissão explícita, pedida pelo
  próprio sistema operacional:
  - *Microfone e reconhecimento de voz*: para o recurso "Lançar com IA" por
    voz. O áudio é processado localmente pelo motor de reconhecimento de
    fala do seu celular (Apple/Google) — não é gravado nem enviado aos
    nossos servidores.
  - *Câmera e galeria de fotos*: para anexar comprovantes às suas
    transações, se você optar por isso.
  - *Face ID / biometria*: para travar o acesso ao app no seu aparelho — a
    biometria é processada inteiramente pelo sistema operacional; nunca
    temos acesso a ela.
- **Não coletamos** dados de localização, contatos, nem usamos ferramentas
  de rastreamento, analytics de terceiros ou publicidade.

## 4. Recurso de Inteligência Artificial ("Lançar com IA")

Esse recurso é opcional. Se você ativá-lo, insere sua **própria chave de
API** de um provedor de IA à sua escolha (OpenRouter, Google Gemini, OpenAI
ou Anthropic). Quando você usa esse recurso, o texto do seu lançamento (ex:
"gastei 50 reais no mercado") é enviado diretamente do seu dispositivo para
o provedor de IA escolhido por você, usando a sua chave — esse texto **não**
passa nem fica armazenado em nenhum servidor do Cruzeiro. O uso da IA está
sujeito à política de privacidade do provedor escolhido por você.

## 5. Com quem compartilhamos dados

Não vendemos nem alugamos seus dados a ninguém. Compartilhamos dados apenas
com:

- **Supabase** (nosso provedor de banco de dados e autenticação na nuvem,
  região São Paulo) — atua como operador dos dados sincronizados, sob
  nossas instruções.
- O provedor de IA que você mesmo escolher e configurar (ver item 4) — só
  se você ativar esse recurso.

Não compartilhamos dados com anunciantes, corretores de dados ("data
brokers") ou qualquer outro terceiro.

## 6. Segurança

- **Em trânsito**: todas as comunicações entre os apps e o Supabase usam
  HTTPS/TLS.
- **Em repouso**: o banco de dados local do Desktop pode ser protegido por
  senha (criptografia XChaCha20-Poly1305 com derivação de chave PBKDF2). No
  Mobile, o token de acesso é armazenado no armazenamento seguro nativo do
  sistema (Keychain no iOS, via `expo-secure-store`).
- Você controla onde o arquivo de dados do Desktop fica salvo (padrão:
  pasta do app; opcionalmente uma pasta própria, como um Dropbox pessoal).

## 7. Por quanto tempo guardamos os dados

Enquanto sua conta estiver ativa. Você pode solicitar a exclusão dos dados
sincronizados a qualquer momento pelo e-mail de contato abaixo; os dados
locais no Desktop continuam sob seu controle total e podem ser apagados
diretamente pelo app ou pelo sistema operacional.

## 8. Seus direitos (LGPD)

Como titular de dados, você pode a qualquer momento solicitar, pelo e-mail
cruzeiroapp@gmail.com: confirmação do tratamento, acesso, correção,
portabilidade, anonimização ou eliminação dos seus dados, e informação
sobre com quem compartilhamos seus dados. Responderemos em até 15 dias.

## 9. Menores de idade

O Cruzeiro não é direcionado a menores de 18 anos e não coletamos
intencionalmente dados de menores.

## 10. Alterações a esta política

Podemos atualizar esta política ocasionalmente. Mudanças relevantes serão
comunicadas dentro do app ou por e-mail. A data no topo desta página sempre
indica a versão mais recente.

## 11. Contato

Dúvidas sobre privacidade: **cruzeiroapp@gmail.com**
