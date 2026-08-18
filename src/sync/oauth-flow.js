// ─────────────────────────────────────────────────────────────
// oauth-flow.js
// Fluxo OAuth (Google/Apple) via PKCE para o Electron: não existe um
// WebView "dono" da página de callback como no navegador, então o
// Electron abre o navegador padrão do sistema (shell.openExternal) e
// escuta a volta num servidor HTTP local temporário — o mesmo padrão
// usado por CLIs (gh, gcloud, etc) para OAuth desktop.
// ─────────────────────────────────────────────────────────────

const http = require('http');
const crypto = require('crypto');

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// Sobe um servidor HTTP só em 127.0.0.1 numa porta livre e devolve a porta
// já escolhida (pra montar a URL de redirect_to) junto com uma Promise que
// resolve com o `code` assim que o navegador voltar pra cá. Timeout de
// 5min — se o usuário fechar a aba sem concluir, não fica um servidor
// pendurado pra sempre.
function startCallbackServer({ timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolveStart, rejectStart) => {
    let settled = false;
    let resolveCode, rejectCode;
    const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error_description') || url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cruzeiro</title>
        <style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
        .box{text-align:center}h1{color:${error ? '#f87171' : '#4ade80'}}</style></head>
        <body><div class="box"><h1>${error ? 'Não foi possível conectar' : 'Conectado!'}</h1>
        <p>${error ? String(error) : 'Pode fechar esta aba e voltar para o Cruzeiro.'}</p></div></body></html>`);

      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) rejectCode(new Error(error));
      else if (!code) rejectCode(new Error('Nenhum código recebido'));
      else resolveCode(code);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.close();
      rejectCode(new Error('Tempo esgotado — login não concluído'));
    }, timeoutMs);

    server.on('error', (e) => {
      clearTimeout(timer);
      rejectStart(e);
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveStart({
        redirectTo: `http://127.0.0.1:${port}/callback`,
        waitForCode: () => codePromise,
        close: () => { if (!settled) { settled = true; clearTimeout(timer); server.close(); } },
      });
    });
  });
}

module.exports = { generatePKCE, startCallbackServer };
