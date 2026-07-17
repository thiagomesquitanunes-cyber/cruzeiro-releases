// ─────────────────────────────────────────────────────────────
// supabase-client.js
// Cliente HTTP para a REST API do Supabase.
// Usa require('https') em vez de fetch global,
// compatível com o ambiente Node/Electron do projeto.
// ─────────────────────────────────────────────────────────────

const https = require('https');
const fs    = require('fs');

const SUPABASE_URL    = 'https://nfpjxmwrtwogctocqtxp.supabase.co';
const SUPABASE_ANON   = 'sb_publishable_rCikC0YRWCUwicYs0v7W8Q_k5sniHIl';

// ── Estado de sessão (em memória) ──
let _session = null;

// ─────────────────────────────────────────────────────────────
// Instrumentação de egress — registra o tamanho de cada RESPOSTA da
// Supabase (é isso que é cobrado como egress, não o que o app envia),
// agrupado por tabela e por dia, num arquivo local. Existe só para
// diagnosticar picos de egress vistos no painel da Supabase — não afeta
// o funcionamento do sync, e falha em silêncio se não conseguir gravar.
// ─────────────────────────────────────────────────────────────
let _egressLogPath = null;

function setEgressLogPath(dbPath) {
  _egressLogPath = dbPath ? dbPath.replace('.db', '_egress_log.json') : null;
}

function _logEgress(pathname, method, bytes) {
  if (!_egressLogPath || !bytes) return;
  try {
    const table = pathname.replace(/^\/rest\/v1\//, '').split('?')[0] || '(outro)';
    const today = new Date().toISOString().slice(0, 10);
    let log = {};
    try { log = JSON.parse(fs.readFileSync(_egressLogPath, 'utf8')); } catch (e) {}
    if (!log[today]) log[today] = {};
    const key = `${table} [${method}]`;
    log[today][key] = (log[today][key] || 0) + bytes;
    fs.writeFileSync(_egressLogPath, JSON.stringify(log));
  } catch (e) { /* diagnóstico best-effort — nunca deve quebrar o sync */ }
}

// Imprime no console um resumo do egress de hoje, maior tabela primeiro —
// chamado ao final de cada ciclo de sync (ver runMobileSync em main.js).
function printEgressSummary() {
  if (!_egressLogPath) return;
  try {
    const log = JSON.parse(fs.readFileSync(_egressLogPath, 'utf8'));
    const today = new Date().toISOString().slice(0, 10);
    const todayLog = log[today];
    if (!todayLog) return;
    const rows = Object.entries(todayLog).sort((a, b) => b[1] - a[1]);
    const total = rows.reduce((s, [, v]) => s + v, 0);
    const fmt = n => n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB';
    console.log(`[egress] hoje (${today}), total medido pelo app: ${fmt(total)}`);
    rows.slice(0, 10).forEach(([key, bytes]) => console.log(`[egress]   ${fmt(bytes).padStart(10)}  ${key}`));
  } catch (e) { /* best-effort */ }
}

// ─────────────────────────────────────────────────────────────
// HTTP helper usando https nativo
//
// Nunca usa service_role aqui — só a chave anon + (quando disponível)
// o access_token da sessão do usuário logado via Supabase Auth. O
// isolamento entre usuários é garantido pelas políticas de RLS no
// Supabase (auth.uid() = user_id em cada tabela mobile_*/quick_entries/
// etc. — ver supabase/enable_rls.sql), não por uma chave admin no app.
// ─────────────────────────────────────────────────────────────
function _request(urlStr, { method = 'GET', body, token } = {}) {
  return new Promise((resolve, reject) => {
    const auth = `Bearer ${token || SUPABASE_ANON}`;

    const bodyStr = body ? JSON.stringify(body) : null;
    const url     = new URL(urlStr);

    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SUPABASE_ANON,
        'Authorization': auth,
        'Prefer':        method === 'POST' ? 'return=minimal,resolution=merge-duplicates' : '',
      },
    };

    if (bodyStr) {
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(options, (res) => {
      let data = '';
      let bytes = 0;
      // chunk é um Buffer (sem res.setEncoding()), então chunk.length já é
      // o tamanho real em bytes — string.length divergiria em acentos/UTF-8.
      res.on('data', chunk => { data += chunk; bytes += chunk.length; });
      res.on('end', () => {
        // Registra o egress independentemente de sucesso ou erro — uma
        // resposta de erro também consome banda, e é exatamente esse
        // número (bytes que SAEM da Supabase) que é cobrado.
        _logEgress(url.pathname, method, bytes);
        if (res.statusCode >= 400) {
          reject(new Error(`Supabase ${method} ${url.pathname} → ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(data ? JSON.parse(data) : null);
        } catch (e) {
          resolve(null);
        }
      });
    });

    // Sem isso, uma conexão que trava (rede instável, servidor não responde)
    // deixa a Promise pendurada pra sempre — nem resolve nem rejeita — e
    // como o sync roda toda a fila de pushAll() em sequência (await por
    // tabela), UM request travado congela a sincronização inteira sem
    // nenhum erro no log, dando a impressão de que "não está fazendo nada".
    req.setTimeout(30000, () => req.destroy(new Error(`Supabase ${method} ${url.pathname} → timeout (30s)`)));

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function _rest(path, opts) {
  return _request(`${SUPABASE_URL}/rest/v1${path}`, { ...opts, token: opts?.token || _session?.access_token });
}

function _auth(path, opts) {
  return _request(`${SUPABASE_URL}/auth/v1${path}`, opts);
}

// ─────────────────────────────────────────────────────────────
// Autenticação
// ─────────────────────────────────────────────────────────────

async function login(email, password) {
  const data = await _auth('/token?grant_type=password', {
    method: 'POST',
    body: { email, password },
  });
  _session = data;
  return { ok: true, user: data.user, refresh_token: data.refresh_token };
}

async function logout() {
  if (_session?.access_token) {
    await _auth('/logout', {
      method: 'POST',
      token: _session.access_token,
    }).catch(() => {});
  }
  _session = null;
  return { ok: true };
}

async function refreshSession(storedToken) {
  const token = storedToken || _session?.refresh_token;
  if (!token) throw new Error('Sem refresh token disponível');
  const data = await _auth('/token?grant_type=refresh_token', {
    method: 'POST',
    body: { refresh_token: token },
  });
  _session = data;
  // Retorna explicitamente o novo refresh_token para que o chamador
  // possa persistir — o Supabase usa tokens rotativos (cada uso
  // invalida o anterior). Sem persistir, a próxima abertura falha.
  return { ...data, refresh_token: data.refresh_token };
}

function getSession() { return _session; }
function getUserId()  { return _session?.user?.id || null; }
function isLoggedIn() { return !!_session?.access_token; }

// Descarta a sessão em memória SEM chamar o endpoint de logout do Supabase
// (isso invalidaria o refresh token, derrubando o usuário do mobile também,
// o que não é a intenção aqui). Usado só ao trocar de usuário local no
// mesmo Desktop (ver users:select em main.js) — _session é uma variável de
// módulo única, compartilhada por TODOS os usuários locais desse Desktop;
// sem limpá-la explicitamente antes de tentar restaurar a sessão do novo
// usuário, um usuário que nunca configurou o sync mobile (sem
// supabaseRefreshToken) herdava silenciosamente a sessão do usuário
// anterior, e uma sincronização nesse estado escreveria os dados dele na
// conta Supabase de OUTRA pessoa.
function clearSession() { _session = null; }

// ─────────────────────────────────────────────────────────────
// Operações REST
// ─────────────────────────────────────────────────────────────

async function upsert(table, rows, onConflict) {
  if (!rows.length) return;
  const qs = onConflict ? `?on_conflict=${onConflict}` : '';
  await _rest(`/${table}${qs}`, { method: 'POST', body: rows });
}

async function select(table, filters = {}, { order, limit } = {}) {
  let qs = Object.entries(filters)
    .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`)
    .join('&');
  if (order) qs += `${qs ? '&' : ''}order=${order}`;
  if (limit) qs += `${qs ? '&' : ''}limit=${limit}`;
  return await _rest(`/${table}${qs ? '?' + qs : ''}`) || [];
}

async function update(table, filters, data) {
  const qs = Object.entries(filters)
    .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`)
    .join('&');
  await _rest(`/${table}?${qs}`, { method: 'PATCH', body: data });
}

async function remove(table, filters) {
  const qs = Object.entries(filters)
    .map(([k, v]) => `${k}=eq.${encodeURIComponent(v)}`)
    .join('&');
  await _rest(`/${table}?${qs}`, { method: 'DELETE' });
}

// Remove do Supabase as linhas do usuário cujo synced_at é anterior ao
// timestamp do sync atual — ou seja, tudo que NÃO foi tocado no upsert
// desta rodada (linhas excluídas no desktop, fora da janela, ou de
// versões antigas do sync). Mais robusto que pruneNotIn para tabelas
// grandes: não estoura o limite de tamanho da URL com listas de IDs.
async function removeOlderThan(table, userId, syncedAtIso) {
  const qs = `user_id=eq.${encodeURIComponent(userId)}&synced_at=lt.${encodeURIComponent(syncedAtIso)}`;
  await _rest(`/${table}?${qs}`, { method: 'DELETE' });
}

// Remove do Supabase tudo que NÃO está mais na lista de valores atuais
// (usado para limpar contas/metas/recorrentes excluídas no desktop)
async function pruneNotIn(table, userId, column, currentValues) {
  if (!currentValues.length) {
    // Nenhum valor atual: remove tudo do usuário nessa tabela
    await remove(table, { user_id: userId });
    return;
  }
  const list = currentValues.map(v => `"${String(v).replace(/"/g, '\\"')}"`).join(',');
  const qs = `user_id=eq.${encodeURIComponent(userId)}&${column}=not.in.(${list})`;
  await _rest(`/${table}?${qs}`, { method: 'DELETE' });
}

module.exports = {
  login, logout, refreshSession, clearSession,
  getSession, getUserId, isLoggedIn,
  upsert, select, update, remove, pruneNotIn, removeOlderThan,
  setEgressLogPath, printEgressSummary,
  SUPABASE_URL,
};
