// ─────────────────────────────────────────────────────────────
// supabase-client.js
// Cliente HTTP para a REST API do Supabase.
// Usa require('https') em vez de fetch global,
// compatível com o ambiente Node/Electron do projeto.
// ─────────────────────────────────────────────────────────────

const https = require('https');

const SUPABASE_URL    = 'https://nfpjxmwrtwogctocqtxp.supabase.co';
const SUPABASE_ANON   = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5mcGp4bXdydHdvZ2N0b2NxdHhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE0MDU1ODQsImV4cCI6MjA5Njk4MTU4NH0.26t--V7O8RAPMsURHqwu3x19LHIdjJHjKvHpSHMvhGo';

// ── Estado de sessão (em memória) ──
let _session = null;

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
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
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
  login, logout, refreshSession,
  getSession, getUserId, isLoggedIn,
  upsert, select, update, remove, pruneNotIn, removeOlderThan,
  SUPABASE_URL,
};
