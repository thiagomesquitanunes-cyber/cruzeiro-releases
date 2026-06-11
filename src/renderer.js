// ══ CATEGORIES ══
// Generic default categories — user can add, edit or remove in Settings
let CATS_RAW = [
  "Alimentação","Alimentação:Restaurante","Alimentação:Supermercado",
  "Casa","Contas","Diversos","Educação","Lazer","Outras Rendas",
  "Presentes","Renda Financeira","Roupas","Salário","Saúde",
  "Saúde:Farmácia","Saúde:Médicos","Tarifas","Transferência","Transferências",
  "Transporte","Viagens"
];

// ══ CATEGORY MANAGEMENT ══
async function loadPersistedCategories() {
  try {
    const saved = await ff.categoriesGet();
    if (saved && Array.isArray(saved)) CATS_RAW.splice(0, CATS_RAW.length, ...saved);
  } catch(e) {}
}

async function saveCategories() {
  try { await ff.categoriesSave({ categories: [...CATS_RAW].sort((a,b) => a.localeCompare(b,'pt-BR')) }); }
  catch(e) { console.error('Failed to save categories', e); }
}

function refreshCategories() {
  const el = G('cat-manage-list');
  if (!el) return;
  const sorted = [...CATS_RAW].sort((a,b) => a.localeCompare(b,'pt-BR'));

  // Group by top-level
  const groups = {};
  sorted.forEach(c => {
    const top = c.split(':')[0];
    if (!groups[top]) groups[top] = [];
    groups[top].push(c);
  });

  let html = '';
  Object.entries(groups).sort(([a],[b]) => a.localeCompare(b,'pt-BR')).forEach(([top, cats]) => {
    html += `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;margin-bottom:10px;overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--bg3);border-bottom:1px solid var(--border)">
        <span style="font-weight:600;font-size:13px">${esc(top)}</span>
        <div style="display:flex;gap:6px">
          <button class="btn xs" onclick="openAddCategory(true,'${esc2(top)}')">+ Sub</button>
          <button class="btn xs" onclick="openRenameCategory('${esc2(top)}','${esc2(top)}')">✎</button>
          <button class="btn-icon" style="color:var(--red);font-size:11px" onclick="deleteCategory('${esc2(top)}')">✕</button>
        </div>
      </div>`;
    cats.filter(c => c !== top).forEach(c => {
      const sub = c.split(':').slice(1).join(':');
      html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px 8px 28px;border-bottom:1px solid var(--border);font-size:13px">
        <span style="color:var(--text2)">${esc(sub)}</span>
        <div style="display:flex;gap:6px">
          <button class="btn-icon" style="font-size:11px" onclick="openRenameCategory('${esc2(c)}','${esc2(c)}')">✎</button>
          <button class="btn-icon" style="color:var(--red);font-size:11px" onclick="deleteCategory('${esc2(c)}')">✕</button>
        </div>
      </div>`;
    });
    html += '</div>';
  });

  el.innerHTML = html || '<div class="info-box">Nenhuma categoria.</div>';
}

function openAddCategory(isSub, parentName) {
  const title = isSub
    ? (parentName ? `Nova subcategoria em "${parentName}"` : 'Nova subcategoria (ex: Alimentação:Restaurante)')
    : 'Nova categoria';
  showCatInputModal(title, '', val => {
    if (!val?.trim()) return;
    const full = (isSub && parentName) ? `${parentName}:${val.trim()}` : val.trim();
    if (CATS_RAW.includes(full)) { toast('Categoria já existe'); return; }
    if (isSub && parentName && !CATS_RAW.includes(parentName)) CATS_RAW.push(parentName);
    CATS_RAW.push(full);
    saveCategories();
    refreshCategories();
    toast(`✅ "${full}" adicionada`);
  });
}

function openRenameCategory(oldName, currentName) {
  showCatInputModal(`Renomear "${currentName}"`, currentName, val => {
    if (!val?.trim() || val.trim() === currentName) return;
    const newFull = val.trim();
    for (let i = 0; i < CATS_RAW.length; i++) {
      if (CATS_RAW[i] === oldName) CATS_RAW[i] = newFull;
      else if (CATS_RAW[i].startsWith(oldName + ':'))
        CATS_RAW[i] = newFull + CATS_RAW[i].slice(oldName.length);
    }
    saveCategories();
    refreshCategories();
    toast(`✅ Renomeada para "${newFull}"`);
  });
}

// Inline text input modal (replaces prompt() which is blocked in Electron)
function _catModalConfirm() {
  const v = G('cat-modal-input')?.value;
  closeModal('modal-custom-parser');
  window._catModalCb?.(v);
}

function showCatInputModal(title, defaultVal, onConfirm) {
  G('custom-parser-title').textContent = title;
  G('custom-parser-body').innerHTML = `<div class="field"><input class="inp" id="cat-modal-input" type="text" value="${esc(defaultVal)}" style="width:100%" placeholder="Nome da categoria" onkeydown="if(event.key==='Enter')_catModalConfirm()"></div>`;
  G('custom-parser-footer').innerHTML = `<button class="btn" onclick="closeModal('modal-custom-parser')">Cancelar</button><button class="btn primary" id="cat-modal-ok">Confirmar</button>`;
  // Attach via JS to avoid HTML attribute escaping issues
  setTimeout(() => {
    const btn = G('cat-modal-ok');
    if (btn) btn.onclick = _catModalConfirm;
  }, 10);
  window._catModalCb = onConfirm;
  openModal('modal-custom-parser');
  setTimeout(() => G('cat-modal-input')?.focus(), 80);
}

async function deleteCategory(name) {
  // Blur active element first to prevent focus trap after confirm dialog
  if (document.activeElement?.blur) document.activeElement.blur();
  const isParent = CATS_RAW.some(c => c.startsWith(name + ':'));
  const msg = isParent
    ? `Excluir "${name}" e todas as suas subcategorias?`
    : `Excluir a categoria "${name}"?`;
  if (!await showConfirmDialog(msg, '', 'Confirmar', true)) return;
  const before = CATS_RAW.length;
  // Remove the category and any sub-categories
  for (let i = CATS_RAW.length - 1; i >= 0; i--) {
    if (CATS_RAW[i] === name || CATS_RAW[i].startsWith(name + ':')) {
      CATS_RAW.splice(i, 1);
    }
  }
  saveCategories();
  refreshCategories();
  toast(`🗑 ${before - CATS_RAW.length} categoria(s) removida(s)`);
}

// ══ STATE ══
let accounts    = [];
let currentAccountId = null;
let currentPage = 'overview';
let sortBy      = 'date';
let sortOrder   = 'desc';
let editingTxId = null;
let editingAccId= null;
let selBank     = 'itau';
let selectedRows= new Set();
let searchQuery = '';
let fxRates     = {};
let periodDays  = 90; // default period

// Column config: id, label, width, visible
let colConfig = [
  { id:'date',     label:'date',      width:100, visible:true },
  { id:'category', label:'category',  width:170, visible:true },
  { id:'memo',     label:'memo',      width:220, visible:true },
  { id:'expense',  label:'expense',   width:110, visible:true },
  { id:'income',   label:'income',    width:110, visible:true },
  { id:'balance',  label:'balance',   width:120, visible:true },
  { id:'cleared',  label:'C',         width:44,  visible:true },
  { id:'actions',  label:'',          width:64,  visible:true },
];

// ── INIT ──
(async () => {
  try {
  await fetchFxRates();
  await loadAccounts();
  await loadOverviewSettings();
  // Check license status on startup (non-blocking)
  setTimeout(() => checkLicense().catch(()=>{}), 2000);
  renderCatFilterChips();
  try { const ver = await ff.appVersion(); const vEl = G('app-version'); if (vEl) vEl.textContent = `v${ver}`; } catch(e) {}
  try { window._importDefaults = await ff.importDefaultsGet(); } catch(e) { window._importDefaults = {}; }
  await loadCatTypes().catch(()=>{});
  await initPatrimonio().catch(()=>{});
  await loadCatTypes();
  // Listen for update notifications from main process
  try {
    ff.onUpdateStatus(data => {
      const bar = G('update-bar');
      const msg = G('update-msg');
      const btn = G('update-install-btn');
      if (!bar) return;
      bar.style.display = 'flex';
      msg.textContent = data.message;
      btn.style.display = data.type === 'ready' ? '' : 'none';
    });
  } catch(e) {}
  try {
    ff.onDbError(data => {
      toast(`⚠️ ${data.message}`);
      console.error('[DB Error]', data.message);
    });
  } catch(e) {}


  // No aggressive focus recovery — it causes more freezes than it fixes

  // Expose installUpdate globally for the update bar button
  window.installUpdate = async function() {
    const btn = G('update-install-btn');
    if (btn) { btn.textContent = '⏳ Aguarde...'; btn.disabled = true; }
    const msg = G('update-msg');
    if (msg) msg.textContent = 'Fechando app e iniciando instalação...';
    try {
      await ff.installUpdate();
    } catch(e) {
      console.error('[update]', e);
      if (btn) { btn.textContent = '↻ Reiniciar e instalar'; btn.disabled = false; }
      if (msg) msg.textContent = 'Erro ao instalar. Tente fechar e abrir o app.';
    }
  };

  // Ctrl+F → open advanced search (override browser default)
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
      e.preventDefault();
      goPage('search');
      setTimeout(() => G('adv-query')?.focus(), 80);
    }
  });

  // Delete key on document: delete selected transactions
  document.addEventListener('keydown', async e => {
    if ((e.key === 'Delete') && selectedRows.size > 0 && currentPage === 'account') {
      // Don't fire if focus is inside an input
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
      e.preventDefault();
      if (!await showConfirmDialog(`Excluir ${selectedRows.size} lançamento(s)?`, 'Esta ação pode ser desfeita com Ctrl+Z.', 'Excluir', true)) return;
      const ids = [...selectedRows];
      for (const id of ids) await ff.deleteTx(id);
      selectedRows.clear(); _selAnchor = null;
      toast(`${ids.length} lançamento(s) excluído(s)`);
      await loadAccounts();
      if (currentPage === 'account') refreshAccount();
      if (currentPage === 'overview') await refreshOverview();
      if (currentPage === 'evolucao') refreshEvolucao();
      refreshUndoBtn();
    }
  });
  await loadEvolucaoConfig();
  await loadPersistedCategories();
  goPage('overview');

  // Initialize language
  await initLanguage();

  // Auto-update IPCA and benchmarks in background on startup
  setTimeout(async () => {
    try { await patFetchIPCA(); } catch(e) { console.warn('Auto IPCA pat:', e); }
    try { await fetchIPCA();    } catch(e) { console.warn('Auto IPCA ev:',  e); }
    try { await fetchBenchmarks(true); } catch(e) { console.warn('Auto benchmarks:', e); }
    try { await ff.financingFetchIndexes(); } catch(e) { console.warn('Auto financing indexes:', e); }
  }, 1500);

  // Check first run → show tour
  setTimeout(checkFirstRun, 800);

  // Load Chart.js for returns charts
  if (typeof Chart === 'undefined') {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
    document.head.appendChild(s);
  }

  // Load cached benchmarks
  loadBenchmarks();
  setDefaultDates();
  initSidebarResize();
  refreshUndoBtn();
  } catch(e) {
    console.error('[Cruzeiro] Init error:', e);
    // Show error in UI rather than blank screen
    const body = document.body;
    if (body) {
      const errDiv = document.createElement('div');
      errDiv.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1e293b;color:#f87171;padding:32px;border-radius:12px;font-family:monospace;max-width:600px;z-index:9999;white-space:pre-wrap';
      errDiv.textContent = 'Erro ao iniciar o Cruzeiro:\n\n' + (e.stack || e.message);
      body.appendChild(errDiv);
    }
  }
})();

function initSidebarResize() {
  const sidebar  = G('sidebar');
  const handle   = G('sidebar-resize');
  if (!sidebar || !handle) return;
  let dragging = false, startX = 0, startW = 0;
  handle.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startW = sidebar.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const newW = Math.min(420, Math.max(160, startW + (e.clientX - startX)));
    sidebar.style.width = newW + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}

function setDefaultDates() {
  const now  = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  G('rep-from').value = from.toISOString().slice(0,10);
  G('rep-to').value   = now.toISOString().slice(0,10);
  G('tx-date').value  = todayStr();
  G('tr-date').value  = todayStr();
  G('rec-next').value = todayStr();
}

// ══ FX RATES ══
async function fetchFxRates() {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/BRL');
    const d = await r.json();
    if (d.rates) {
      // rates are X per BRL, we want BRL per X
      fxRates.USD = 1 / d.rates.USD;
      fxRates.EUR = 1 / d.rates.EUR;
    }
  } catch(e) {
    // fallback approximate rates
    fxRates.USD = 5.10;
    fxRates.EUR = 5.55;
  }
}

function toBRL(amount, currency) {
  if (!currency || currency === 'BRL') return amount;
  const rate = fxRates[currency] || 1;
  return amount * rate;
}
function fxHint(currency) {
  if (!currency || currency === 'BRL') return '';
  const rate = fxRates[currency] || 0;
  return rate ? `1 ${currency} ≈ ${fmtBRL(rate)}` : '';
}

// ══ ACCOUNTS ══
async function loadAccounts() {
  accounts = await ff.listAccounts();
  renderSidebar();
  populateAccountSelects();
}

const TYPE_ORDER  = { bank:0, credit:1, cash:2, investment:3 };
const TYPE_LABELS = { bank:'Contas bancárias', credit:'Cartões de crédito', cash:'Caixa', investment:'Investimentos' };
const TYPE_ICONS  = { bank:'🏦', credit:'💳', cash:'💵', investment:'📈' };
const CURR_SYMBOL = { BRL:'R$', USD:'US$', EUR:'€' };

function currSymbol(currency) { return CURR_SYMBOL[currency] || currency; }

async function renderSidebar() {
  const balances = {};
  await Promise.all(accounts.map(async a => {
    balances[a.id] = await ff.getBalance(a.id); // raw value in account's own currency
  }));

  const visible = accounts.filter(a => !a.hidden);
  const groups  = {};
  visible.forEach(a => { if (!groups[a.type]) groups[a.type] = []; groups[a.type].push(a); });

  let html = '';
  // Nav
  const navItems = [
    { page:'overview',   icon:'🏠', label:t('nav_overview') },
    { page:'reports',    icon:'📊', label:t('nav_reports') },
    { page:'import',     icon:'📥', label:t('nav_import') },
    { page:'search',     icon:'🔍', label:t('nav_search') },
    { page:'goals',      icon:'🎯', label:t('nav_goals') },
    { page:'aposentadoria', icon:'🏖️', label:'Aposentadoria' },
    { page:'budget',     icon:'💰', label:t('nav_budget') },
    { page:'recurring',  icon:`<svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:-2px"><path d="M13 8A5 5 0 0 1 3 8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><polyline points="1.5,6.5 3,8 4.5,6.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M3 8A5 5 0 0 1 13 8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><polyline points="11.5,9.8 13,8 14.5,9.8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`, label:t('nav_recurring') },
    { page:'evolucao',   icon:'📈', label:t('nav_evolucao') },
    { page:'patrimonio', icon:'🏛', label:t('nav_patrimonio') },
    { page:'categories', icon:'🏷', label:t('nav_categories') },
    { page:'ml',         icon:'🧠', label:t('nav_ml') },
    { page:'backup',     icon:'⚙️', label:t('nav_backup') },
  ];
  navItems.forEach(n => {
    const active = currentPage === n.page && !currentAccountId ? 'active' : '';
    const navLabel = (t('nav_' + n.page) !== 'nav_' + n.page) ? t('nav_' + n.page) : n.label;
    html += `<div class="nav-item ${active}" onclick="goPage('${n.page}')" data-page="${n.page}">
      <span class="icon">${n.icon}</span>${navLabel}
    </div>`;
  });

  // Account groups — strictly sorted by TYPE_ORDER
  const sortedTypes = Object.keys(TYPE_LABELS).sort((a,b) => TYPE_ORDER[a] - TYPE_ORDER[b]);
  sortedTypes.forEach(type => {
    const accs = groups[type];
    if (!accs || !accs.length) return;
    html += `<div class="nav-section">${TYPE_LABELS[type]}</div>`;
    accs.forEach(a => {
      const bal    = balances[a.id] || 0; // in account's currency
      const balCls = bal > 0 ? 'pos' : bal < 0 ? 'neg' : 'zero';
      const sym    = currSymbol(a.currency);
      const absVal = Math.abs(bal);
      const sign   = bal < 0 ? '-' : '';
      const balStr = sign + sym + ' ' + absVal.toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
      const isActive = currentAccountId === a.id && currentPage === 'account';
      html += `<div class="nav-item ${isActive ? 'active' : ''}" onclick="openAccount(${a.id})">
        <span class="icon">${TYPE_ICONS[a.type]||'💰'}</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">${esc(a.name)}</span>
        <span class="nav-bal ${balCls}">${balStr}</span>
      </div>`;
    });
  });

  G('sidebar-accounts').innerHTML = html;
}

function populateAccountSelects() {
  const visible = accounts.filter(a => !a.hidden);
  const opts = visible.map(a => `<option value="${a.id}">${esc(a.name)}${a.currency!=='BRL'?' ('+a.currency+')':''}</option>`).join('');
  ['tx-account','tr-from','tr-to','rec-account','qif-account','bank-account'].forEach(id => {
    const el = G(id); if (el) el.innerHTML = opts;
  });
  // Restore import default for current bank
  const bankSel = G('bank-account');
  if (bankSel) {
    const def = (window._importDefaults || {})[window._selBank || 'itau'];
    if (def) bankSel.value = def;
    bankSel.onchange = () => {
      if (!window._importDefaults) window._importDefaults = {};
      window._importDefaults[window._selBank || 'itau'] = bankSel.value;
      ff.importDefaultsSave(window._importDefaults).catch(()=>{});
    };
  }
}

// ══ NAV ══
async function goPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  G('page-' + name)?.classList.add('active');
  currentPage = name;
  if (name !== 'account') currentAccountId = null;
  const titles = {
    overview:   t('page_overview'),
    import:     t('page_import'),
    search:     t('page_search'),
    returns:    t('page_returns'),
    goals:      t('page_goals'),
    budget:     t('page_budget'),
    patrimonio: t('page_patrimonio'),
    evolucao:   t('page_evolucao'),
    recurring:  t('page_recurring'),
    ml:         t('page_ml'),
    categories: t('page_categories'),
    backup:     t('page_backup'),
    aposentadoria: '🏖️ Aposentadoria',
    reports:    'Relatórios',
  };
  G('page-title').textContent = titles[name] || name;
  G('search-wrap').style.display = name === 'account' ? 'flex' : 'none';
  G('search-input').value = ''; searchQuery = '';
  renderSidebar();
  clearSelection();
  if (name === 'overview')  refreshOverview();
  if (name === 'ml')        refreshML();
  if (name === 'recurring')  refreshRecurring();
  if (name === 'evolucao')   refreshEvolucao();
  if (name === 'patrimonio') { patSetView(_patView); refreshPatrimonio(); }
  if (name === 'import') initImportPage();
  if (name === 'categories') refreshCategories();
  if (name === 'search') initSearchPage();
  if (name === 'goals')  refreshGoals();
  if (name === 'budget') refreshBudget();
  if (name === 'import')    populateAccountSelects();
  if (name === 'reports')   { await initReportFilters(); onReportTypeChange(); }
  if (name === 'backup') {
    refreshBackup();
    // Update license badge in settings
    ff.licenseStatus().then(s => {
      const el = G('settings-lic-status');
      if (!el) return;
      const map = { trial:'🟡 Período gratuito', free_social:'🟢 Gratuito', licensed:'✅ Licenciado', payment_required:'🔴 Licença necessária' };
      el.textContent = map[s.status] || s.status;
      el.style.color = s.status === 'payment_required' ? 'var(--red)' : s.status === 'licensed' ? 'var(--green)' : 'var(--text3)';
    }).catch(()=>{});
  }
  if (name === 'aposentadoria') aposInit();
}

async function openAccount(id) {
  currentAccountId = id;
  _acctView = 'table'; // reset to table on account switch
  currentPage = 'account';
  const acc = accounts.find(a => a.id === id);
  G('acct-name').textContent = acc?.name || 'Conta';
  G('page-title').textContent = acc?.name || 'Conta';
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  G('page-account').classList.add('active');
  G('search-wrap').style.display = 'flex';
  G('search-input').value = ''; searchQuery = '';
  // Default to date ascending (oldest first, scroll to today)
  sortBy = 'date'; sortOrder = 'asc';
  const sortSel = G('sort-select'); if (sortSel) sortSel.value = 'date-asc';
  renderSidebar();
  clearSelection();
  buildLedgerHeader();
  await refreshAccount();
  // Scroll to today after render
  setTimeout(() => scrollToToday(), 200);
}

// ══ OVERVIEW ══
let _overviewYear  = new Date().getFullYear();
let _overviewMonth = new Date().getMonth() + 1;
let _monthlyByCat  = [];

// Suggested categories to exclude (accounts used as categories, transfers)
const SUGGESTED_EXCLUDE = new Set([
  'Cartão BTG','Cartão XP','Mastercard','Pão de Açúcar','Mastercard Thi',
  'BB Naty','BB Thi','BTG C/C Naty','BTG C/C Thi','Conta Papai','Itaú',
  'BTG','BTG Naty','XP','XP (Inv. Ri)','R2T2','Investimento Corradi',
  'Investimentos Itaú','Empréstimo Zé','Empréstimo Porps','Investimento Loteamento',
  'Itaú Corretora','Euro','Reais','Wise','Transferência','Transferências',
]);
// Pre-populate with suggested so overview works immediately on first run
let _excludedCats = new Set(SUGGESTED_EXCLUDE);

const CHART_COLORS = [
  '#2563eb','#16a34a','#dc2626','#d97706','#7c3aed','#0891b2',
  '#db2777','#65a30d','#ea580c','#0284c7','#9333ea','#059669'
];

function overviewMonthStr() {
  return `${_overviewYear}-${String(_overviewMonth).padStart(2,'0')}`;
}
function overviewPrevMonth() {
  _overviewMonth--;
  if (_overviewMonth < 1) { _overviewMonth = 12; _overviewYear--; }
  refreshOverview();
}
function overviewNextMonth() {
  _overviewMonth++;
  if (_overviewMonth > 12) { _overviewMonth = 1; _overviewYear++; }
  refreshOverview();
}
function overviewToday() {
  const n = new Date();
  _overviewYear = n.getFullYear(); _overviewMonth = n.getMonth() + 1;
  refreshOverview();
}

function persistOverviewSettings() {
  ff.overviewConfigSave({
    excludedCats:      [..._excludedCats],
    selectedTrendCats: [..._selectedTrendCats],
    chartSettings:     _chartSettings,
  }).catch(() => {});
}

async function loadOverviewSettings() {
  try {
    const cfg = await ff.overviewConfigGet();
    if (!cfg) return;
    if (cfg.excludedCats)      _excludedCats      = new Set(cfg.excludedCats);
    if (cfg.selectedTrendCats) _selectedTrendCats = new Set(cfg.selectedTrendCats);
    if (cfg.chartSettings)     _chartSettings     = cfg.chartSettings;
  } catch(e) {}
}

async function refreshOverview() {
  const monthStr  = overviewMonthStr();
  const fromDate  = `${monthStr}-01`;
  const lastDay   = new Date(_overviewYear, _overviewMonth, 0).getDate();
  const toDate    = `${monthStr}-${String(lastDay).padStart(2,'0')}`;
  const monthNames = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  G('overview-month-label').textContent = `${monthNames[_overviewMonth-1]} ${_overviewYear}`;

  // Patrimônio líquido = mesmos valores da aba Patrimônio
  const curM_ov = `${_overviewYear}-${String(_overviewMonth).padStart(2,'0')}`;

  // grandTotal_ov removed

  // Patrimônio card removed — see Patrimônio tab for full details

  // Month summary
  const rows = await ff.reportSummary({ fromDate, toDate, excludeTransfers: true });
  let income = 0, expenses = 0;
  rows.forEach(r => {
    if (_excludedCats.has(r.category)) return;
    income   += r.income;
    expenses += r.expenses;
  });
  // Override with Evolução-consistent calculation if catConfig set
  if (_ev.catConfig.length) {
    const ev = await computeOverviewMonthSummary(fromDate, toDate);
    income   = ev.income;
    expenses = ev.expenses;
  }

  G('overview-stats').innerHTML = `

    <div class="stat-card"><div class="stat-lbl">Entradas no mês</div><div class="stat-val green">${fmtBRL(income)}</div></div>
    <div class="stat-card"><div class="stat-lbl">Saídas no mês</div><div class="stat-val red">${fmtBRL(expenses)}</div></div>
    <div class="stat-card"><div class="stat-lbl">Resultado</div><div class="stat-val ${income-expenses>=0?'green':'red'}">${fmtBRL(income-expenses)}</div></div>`;

  // Pie charts — net per category (income - expenses), apply excluded filter
  const catNet = {};
  rows.forEach(r => {
    if (_excludedCats.has(r.category)) return;
    const cat = r.category || 'Outros';
    if (!catNet[cat]) catNet[cat] = 0;
    catNet[cat] += r.income - r.expenses;
  });
  const netExp = Object.entries(catNet).filter(([,v])=>v<0).sort((a,b)=>a[1]-b[1]).map(([label,v])=>({label,value:Math.abs(v)}));
  const netInc = Object.entries(catNet).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]).map(([label,v])=>({label,value:v}));
  drawPie('pie-expenses', 'pie-expenses-legend', netExp, fromDate, toDate);
  drawPie('pie-income',   'pie-income-legend',   netInc, fromDate, toDate);
  renderCatFilterChips();

  // Future pending
  await refreshFuturePending();

  // Trend charts data
  _monthlyByCat = await ff.reportMonthlyByCategory({ excludeTransfers: true });
  renderTrendCharts();
}

function drawPie(canvasId, legendId, data, fromDate, toDate) {
  const canvas = G(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, cx = W/2, cy = H/2, R = Math.min(W,H)/2 - 6;
  ctx.clearRect(0, 0, W, H);

  if (!data.length) {
    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2*Math.PI); ctx.fill();
    G(legendId).innerHTML = '<span style="color:var(--text3)">Sem dados</span>';
    return;
  }

  const total = data.reduce((s,d) => s+d.value, 0);
  const threshold = total * 0.02;
  const main  = data.filter(d => d.value >= threshold);
  const other = data.filter(d => d.value < threshold);
  const items = [...main];
  if (other.length) items.push({ label: 'Outros', value: other.reduce((s,d)=>s+d.value,0), isOther: true });

  let angle = -Math.PI/2;
  items.forEach((d, i) => {
    const slice = (d.value / total) * 2 * Math.PI;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, angle, angle+slice); ctx.closePath();
    ctx.fillStyle = CHART_COLORS[i % CHART_COLORS.length];
    ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    angle += slice;
  });
  ctx.beginPath(); ctx.arc(cx, cy, R*0.45, 0, 2*Math.PI);
  ctx.fillStyle = '#fff'; ctx.fill();

  // Legend — clickable via data attributes (safe with colons in category names)
  const legendEl = G(legendId);
  legendEl.innerHTML = items.slice(0,10).map((d,i) =>
    `<div class="pie-leg-item" data-cat="${esc(d.label)}" data-from="${fromDate||''}" data-to="${toDate||''}"
      style="display:flex;align-items:center;gap:6px;white-space:nowrap;cursor:${d.isOther?'default':'pointer'};padding:2px 4px;border-radius:4px">
      <span style="width:10px;height:10px;border-radius:50%;background:${CHART_COLORS[i%CHART_COLORS.length]};flex-shrink:0;display:inline-block"></span>
      <span style="overflow:hidden;text-overflow:ellipsis;max-width:140px" title="${esc(d.label)}">${esc(d.label)}</span>
      <span style="margin-left:auto;font-family:'DM Mono',monospace;color:var(--text2);padding-left:8px">${fmtBRL(d.value)}</span>
    </div>`
  ).join('');

  // Attach click via event listeners (not inline JS — safe for colons in names)
  legendEl.querySelectorAll('.pie-leg-item').forEach(el => {
    const cat = el.dataset.cat;
    if (cat === 'Outros') return;
    el.addEventListener('mouseover', () => el.style.background = 'var(--bg3)');
    el.addEventListener('mouseout',  () => el.style.background = '');
    el.addEventListener('click', () => openCatDetail(cat, el.dataset.from, el.dataset.to));
  });
}

async function refreshFuturePending() {
  const pending = await ff.reportFuturePending();
  G('future-pending-count').textContent = pending.length ? `${pending.length} lançamento${pending.length>1?'s':''}` : '';

  if (!pending.length) {
    G('overview-future-body').innerHTML = '<tr><td colspan="7" class="empty" style="padding:1.5rem"><p>Nenhum lançamento futuro pendente</p></td></tr>';
    return;
  }

  let html = '';
  pending.forEach(t => {
    const exp = t.amount < 0 ? fmtBRL(Math.abs(t.amount)) : '';
    const inc = t.amount >= 0 ? fmtBRL(t.amount) : '';
    html += `<tr>
      <td style="font-size:13px;color:var(--text2);white-space:nowrap">${fmtDate(t.date)}</td>
      <td style="font-size:12px;color:var(--text3)">${esc(t.account_name||'')}</td>
      <td style="font-size:13px">${esc(t.category)}</td>
      <td style="font-size:13px">${esc(t.memo)}</td>
      <td class="amt-exp">${exp}</td>
      <td class="amt-inc">${inc}</td>
      <td class="center">
        <input type="checkbox" class="cleared-check" title="Marcar como conciliado"
          onchange="conciliateFuture(${t.id},this.checked)">
      </td>
    </tr>`;
  });
  G('overview-future-body').innerHTML = html;
}

async function conciliateFuture(id, checked) {
  // Find transaction across all accounts and mark cleared
  for (const a of accounts) {
    const txs = await ff.listTx({ accountId: a.id, sortBy: 'date', order: 'asc', fromDate: todayStr() });
    const found = txs.find(t => t.id === id);
    if (found) {
      await ff.updateTx({ ...found, cleared: checked ? 1 : 0 });
      break;
    }
  }
  await refreshFuturePending();
  await loadAccounts();
}

// ── CATEGORY DETAIL (click on pie legend) ──
async function openCatDetail(category, fromDate, toDate) {
  G('cat-detail-title').textContent = `${category}`;
  G('cat-detail-period').textContent = fromDate ? `${fmtDate(fromDate)} a ${fmtDate(toDate)}` : '';
  G('cat-detail-body').innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3)">⏳ Carregando…</div>';
  openModal('modal-cat-detail');

  // Include subcategories of this category (e.g. "Carro" includes "Carro:Combustível")
  const allCats = await ff.reportSummary({ fromDate, toDate, excludeTransfers: false });
  const subcats = allCats.map(r=>r.category).filter(c => c === category || c.startsWith(category + ':'));

  const { rows, totalInc, totalExp, net } = await ff.categoryDetail({ category: subcats, fromDate, toDate });

  if (!rows.length) {
    G('cat-detail-body').innerHTML = '<div class="empty" style="padding:2rem"><p>Nenhuma transação encontrada</p></div>';
    return;
  }

  const netCls   = net >= 0 ? 'amt-inc' : 'amt-exp';
  const netLabel = net >= 0 ? 'Rendimento líquido' : 'Despesa líquida';

  let html = `<table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead>
      <tr style="border-bottom:2px solid var(--border2)">
        <th style="padding:8px 16px;text-align:left;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Categoria</th>
        <th style="padding:8px 16px;text-align:left;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Data</th>
        <th style="padding:8px 16px;text-align:left;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Memorando</th>
        <th style="padding:8px 16px;text-align:left;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Conta</th>
        <th style="padding:8px 16px;text-align:right;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Montante</th>
      </tr>
    </thead>
    <tbody>`;

  // Group by subcategory to match Moneyspire style
  const bySubcat = {};
  rows.forEach(r => {
    const k = r.category || category;
    if (!bySubcat[k]) bySubcat[k] = [];
    bySubcat[k].push(r);
  });

  Object.entries(bySubcat).sort(([a],[b])=>a.localeCompare(b,'pt-BR')).forEach(([subcat, txs]) => {
    const subtotal = txs.reduce((s,r)=>s+r.amount, 0);
    // Category header row
    html += `<tr style="background:var(--bg3)">
      <td colspan="4" style="padding:6px 16px;font-weight:700;font-size:12px">${esc(subcat)}</td>
      <td></td>
    </tr>`;
    // Transaction rows
    txs.forEach(t => {
      const cls = t.amount >= 0 ? 'color:#16a34a' : 'color:#dc2626';
      html += `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:6px 14px;color:var(--text3);font-size:12px">${esc(t.category)}</td>
        <td style="padding:6px 14px;white-space:nowrap">${fmtDate(t.date)}</td>
        <td style="padding:6px 14px">${esc(t.memo)}</td>
        <td style="padding:6px 14px;color:var(--text2);font-size:12px">${esc(t.account_name)}</td>
        <td style="padding:6px 14px;text-align:right;font-family:'DM Mono',monospace;${cls}">${fmtBRL(t.amount)}</td>
      </tr>`;
    });
    // Subtotal for subcategory (only if multiple txs)
    if (txs.length > 1) {
      const scls = subtotal >= 0 ? 'color:#16a34a' : 'color:#dc2626';
      html += `<tr style="background:var(--bg4)">
        <td colspan="4" style="padding:6px 14px;font-size:12px;font-style:italic;color:var(--text3)">Subtotal ${esc(subcat)}</td>
        <td style="padding:6px 14px;text-align:right;font-family:'DM Mono',monospace;font-size:13px;${scls}">${fmtBRL(subtotal)}</td>
      </tr>`;
    }
  });

  html += '</tbody></table>';

  // Summary footer
  html += `<div style="border-top:1px solid var(--border2);padding:14px 16px;background:var(--bg3)">
    <div style="display:flex;justify-content:space-between;margin-bottom:4px">
      <span style="font-size:13px;color:var(--text2)">Rendimento total</span>
      <span style="font-family:'DM Mono',monospace;font-size:13px;color:#16a34a">${fmtBRL(totalInc)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;margin-bottom:10px">
      <span style="font-size:13px;color:var(--text2)">Despesas totais</span>
      <span style="font-family:'DM Mono',monospace;font-size:13px;color:#dc2626">${fmtBRL(-totalExp)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);padding-top:10px">
      <span style="font-size:13px;font-weight:600">${netLabel}</span>
      <span style="font-size:14px;font-family:'DM Mono',monospace;font-weight:600;${net>=0?'color:#16a34a':'color:#dc2626'}">${fmtBRL(net)}</span>
    </div>
  </div>`;

  G('cat-detail-body').innerHTML = html;
}
let _allTrendCats      = [];
let _selectedTrendCats = new Set(); // selected cats for trend mini-charts
let _chartSettings     = {}; // { [cat]: { consolidate:'none'|'parent', aggregate:'month'|'year' } }
let _catsShown         = []; // order of currently shown cats

function getChartSetting(cat, key) {
  return (_chartSettings[cat] || {})[key] || (key === 'consolidate' ? 'none' : 'month');
}
function setChartSetting(cat, key, val) {
  if (!_chartSettings[cat]) _chartSettings[cat] = {};
  _chartSettings[cat][key] = val;
  persistOverviewSettings();
  // Redraw only this chart
  const idx = _catsShown.indexOf(cat);
  if (idx < 0) return;
  const canvas = G(`trend-mini-${idx}`);
  if (!canvas) return;
  const filtered = _monthlyByCat.filter(r => !_excludedCats.has(r.category));
  const allMonths = [...new Set(filtered.map(r=>r.month))].sort();
  drawMiniChartForCat(canvas, cat, filtered, allMonths, CHART_COLORS[idx % CHART_COLORS.length]);
}

function computeChartValues(cat, filtered, allMonths) {
  const consolidate = getChartSetting(cat, 'consolidate');
  const aggregate   = getChartSetting(cat, 'aggregate');
  const parent      = cat.split(':')[0];

  // Build source data: either just this cat, or all subcats of parent
  let sourceRows = consolidate === 'parent'
    ? filtered.filter(r => r.category.split(':')[0] === parent)
    : filtered.filter(r => r.category === cat);

  if (aggregate === 'year') {
    const byYear = {};
    sourceRows.forEach(r => { const y = r.month.slice(0,4); byYear[y] = (byYear[y]||0) + r.total; });
    const years = [...new Set(filtered.map(r=>r.month.slice(0,4)))].sort();
    let pairs = years.map(y => ({ month: y, value: byYear[y]||0 }));
    const fnz = pairs.findIndex(p=>p.value>0);
    if (fnz > 0) pairs = pairs.slice(fnz);
    return pairs;
  } else {
    const byMonth = {};
    sourceRows.forEach(r => { byMonth[r.month] = (byMonth[r.month]||0) + r.total; });
    let pairs = allMonths.map(m => ({ month: m, value: byMonth[m]||0 }));
    const fnz = pairs.findIndex(p=>p.value>0);
    if (fnz > 0) pairs = pairs.slice(fnz);
    return pairs;
  }
}

function drawMiniChartForCat(canvas, cat, filtered, allMonths, color) {
  const pairs = computeChartValues(cat, filtered, allMonths);
  drawMiniLine(canvas, pairs.map(p=>p.month), pairs.map(p=>p.value), color);
}

function renderTrendCharts() {
  const grid = G('trend-charts-grid');
  if (!grid) return;

  const filtered = _monthlyByCat.filter(r => !_excludedCats.has(r.category));
  const catTotals = {};
  filtered.forEach(r => { catTotals[r.category] = (catTotals[r.category]||0) + r.total; });
  _allTrendCats = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).map(([c])=>c);

  const catsToShow = _selectedTrendCats.size > 0
    ? _allTrendCats.filter(c => _selectedTrendCats.has(c))
    : _allTrendCats.slice(0, 12);

  const allMonths = [...new Set(filtered.map(r=>r.month))].sort();
  _catsShown = catsToShow;

  if (!catsToShow.length || !allMonths.length) {
    grid.innerHTML = '<div class="empty"><div class="ei">📊</div><p>Sem dados suficientes</p></div>';
    return;
  }

  // Build cards with per-chart controls
  const inner = document.createElement('div');
  inner.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:14px';

  catsToShow.forEach((cat, ci) => {
    const s = _chartSettings[cat] || {};
    const consolidate = s.consolidate || 'none';
    const aggregate   = s.aggregate   || 'month';
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:12px';
    card.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <div style="font-size:11px;font-weight:600;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" title="${esc(cat)}">${esc(cat)}</div>
        <select class="mini-sel" data-ci="${ci}" data-key="consolidate"
          style="font-size:10px;padding:1px 3px;border:1px solid var(--border2);border-radius:3px;background:var(--bg2);color:var(--text2);cursor:pointer">
          <option value="none" ${consolidate==='none'?'selected':''}>Subcats</option>
          <option value="parent" ${consolidate==='parent'?'selected':''}>Consolidar</option>
        </select>
        <select class="mini-sel" data-ci="${ci}" data-key="aggregate"
          style="font-size:10px;padding:1px 3px;border:1px solid var(--border2);border-radius:3px;background:var(--bg2);color:var(--text2);cursor:pointer">
          <option value="month" ${aggregate==='month'?'selected':''}>Mensal</option>
          <option value="year"  ${aggregate==='year'?'selected':''}>Anual</option>
        </select>
      </div>
      <canvas id="trend-mini-${ci}" height="90" style="width:100%;display:block"></canvas>`;
    inner.appendChild(card);
  });
  grid.innerHTML = '';
  grid.appendChild(inner);

  // Attach change handlers via event delegation
  inner.querySelectorAll('.mini-sel').forEach(sel => {
    sel.addEventListener('change', () => {
      const ci  = parseInt(sel.dataset.ci);
      const key = sel.dataset.key;
      const cat = _catsShown[ci];
      if (cat) setChartSetting(cat, key, sel.value);
    });
  });

  // Draw after layout
  requestAnimationFrame(() => requestAnimationFrame(() => {
    catsToShow.forEach((cat, ci) => {
      const canvas = G(`trend-mini-${ci}`);
      if (canvas) drawMiniChartForCat(canvas, cat, filtered, allMonths, CHART_COLORS[ci % CHART_COLORS.length]);
    });
  }));
}

function openTrendCatSelector() {
  const existing = G('trend-cat-modal');
  if (existing) { existing.remove(); return; }
  if (!_allTrendCats.length) {
    // Try refreshing overview first
    refreshOverview().then(() => {
      if (_allTrendCats.length) openTrendCatSelector();
      else toast('Sem dados de categorias disponíveis');
    });
    return;
  }

  const panel = document.createElement('div');
  panel.id = 'trend-cat-modal';
  panel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--bg2);border:1px solid var(--border2);border-radius:12px;z-index:500;width:560px;max-height:80vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.18)';
  panel.innerHTML = `
    <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
      <strong style="font-size:14px;flex:1">Selecionar categorias para os gráficos de tendência</strong>
      <button class="btn-icon" onclick="G('trend-cat-modal').remove()">✕</button>
    </div>
    <div style="padding:14px 18px;overflow-y:auto;flex:1">
      <div style="display:flex;gap:8px;margin-bottom:12px">
        <button class="btn xs" id="tcs-all-btn">Todas</button>
        <button class="btn xs" id="tcs-none-btn">Nenhuma</button>
        <span style="font-size:12px;color:var(--text3);align-self:center">Deixe em branco = top 16 por valor</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">
        ${_allTrendCats.map((c,i) => `
          <label style="display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:5px;cursor:pointer">
            <input type="checkbox" class="tcs-chk" data-i="${i}" ${_selectedTrendCats.has(c)||_selectedTrendCats.size===0?'checked':''} style="cursor:pointer">
            <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(c)}">${esc(c)}</span>
          </label>`).join('')}
      </div>
    </div>
    <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px;flex-shrink:0">
      <button class="btn" onclick="G('trend-cat-modal').remove()">Cancelar</button>
      <button class="btn primary" id="tcs-apply-btn">Aplicar</button>
    </div>`;
  document.body.appendChild(panel);

  G('tcs-all-btn').onclick  = () => panel.querySelectorAll('.tcs-chk').forEach(e => e.checked = true);
  G('tcs-none-btn').onclick = () => panel.querySelectorAll('.tcs-chk').forEach(e => e.checked = false);
  G('tcs-apply-btn').onclick = () => {
    _selectedTrendCats = new Set();
    panel.querySelectorAll('.tcs-chk').forEach(e => {
      if (e.checked) _selectedTrendCats.add(_allTrendCats[parseInt(e.dataset.i)]);
    });
    if (_selectedTrendCats.size === _allTrendCats.length) _selectedTrendCats = new Set();
    G('trend-cat-modal').remove();
    persistOverviewSettings();
    renderTrendCharts();
  };
}

function drawMiniLine(canvas, months, values, color) {
  const dpr = window.devicePixelRatio || 1;
  const parentW = canvas.parentElement?.clientWidth || 0;
  const W = (parentW > 40 ? parentW - 24 : 260);
  const H   = 90;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const maxVal = Math.max(...values, 1);
  const PAD_L = 52, PAD_R = 8, PAD_T = 6, PAD_B = 22;
  const cW = W - PAD_L - PAD_R;
  const cH = H - PAD_T - PAD_B;

  function drawChart() {
    ctx.clearRect(0, 0, W, H);
    // Grid
    ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 0.5;
    [0.5, 1].forEach(f => {
      const y = PAD_T + cH - f*cH;
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L+cW, y); ctx.stroke();
      ctx.fillStyle = '#94a3b8'; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
      ctx.fillText(fmtBRLshort(f * maxVal), PAD_L - 3, y + 3);
    });
    // Fill
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = PAD_L + (i / (months.length-1||1)) * cW;
      const y = PAD_T + cH - (v/maxVal)*cH;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.lineTo(PAD_L + cW, PAD_T + cH); ctx.lineTo(PAD_L, PAD_T + cH); ctx.closePath();
    ctx.fillStyle = color + '20'; ctx.fill();
    // Line
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.5;
    values.forEach((v, i) => {
      const x = PAD_L + (i / (months.length-1||1)) * cW;
      const y = PAD_T + cH - (v/maxVal)*cH;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    // X labels
    const step = Math.max(1, Math.floor(months.length / 4));
    ctx.fillStyle = '#94a3b8'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    months.forEach((m, i) => {
      if (i % step !== 0 && i !== months.length-1) return;
      ctx.fillText(m.slice(0,4), PAD_L + (i/(months.length-1||1))*cW, H - 4);
    });
    // Last value dot
    const lv = values[values.length-1];
    const lx = PAD_L + cW;
    const ly = PAD_T + cH - (lv/maxVal)*cH;
    if (lv > 0) {
      ctx.beginPath(); ctx.arc(lx, ly, 3, 0, 2*Math.PI);
      ctx.fillStyle = color; ctx.fill();
      ctx.fillStyle = '#1a2332'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(fmtBRLshort(lv), lx, Math.max(ly - 5, PAD_T + 9));
    }
  }

  drawChart();

  // Tooltip on hover
  canvas.onmousemove = (e) => {
    if (!months.length) return;
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left);
    const idx = Math.round((mx - PAD_L) / (cW / (months.length-1||1)));
    const i = Math.max(0, Math.min(months.length-1, idx));
    drawChart();
    // Draw crosshair
    const x = PAD_L + (i / (months.length-1||1)) * cW;
    const y = PAD_T + cH - (values[i]/maxVal)*cH;
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
    ctx.moveTo(x, PAD_T); ctx.lineTo(x, PAD_T+cH); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(x, y, 4, 0, 2*Math.PI);
    ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke();
    // Tooltip box
    const label = `${months[i]}  ${fmtBRL(values[i])}`;
    ctx.font = 'bold 10px sans-serif';
    const tw = ctx.measureText(label).width + 12;
    let tx = x - tw/2; tx = Math.max(PAD_L, Math.min(PAD_L+cW-tw, tx));
    const ty = Math.max(PAD_T+2, y - 28);
    ctx.fillStyle = 'rgba(26,35,50,.85)';
    ctx.beginPath(); ctx.roundRect(tx, ty, tw, 18, 4); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
    ctx.fillText(label, tx+6, ty+13);
  };
  canvas.onmouseleave = () => drawChart();
}

// ── Category filter ──
function renderCatFilterChips() {
  const chips = G('cat-filter-chips');
  if (!chips) return;
  if (_excludedCats.size === 0) {
    chips.innerHTML = '<span style="font-size:12px;color:var(--text3)">Nenhuma excluída — clique em ⚙ para configurar</span>';
    return;
  }
  chips.innerHTML = [..._excludedCats].slice(0,6).map(c =>
    `<span style="background:var(--red-bg);color:var(--red);font-size:11px;padding:2px 8px;border-radius:99px;border:1px solid #fca5a5">${esc(c)}</span>`
  ).join('') + (_excludedCats.size > 6 ? `<span style="font-size:11px;color:var(--text3)">+${_excludedCats.size-6} mais</span>` : '');
}

let _allCatsForFilter = [];
async function openCatFilterModal() {
  // Get all categories from history
  const allRows = await ff.reportSummary({ excludeTransfers: false });
  _allCatsForFilter = [...new Set(allRows.map(r => r.category).filter(Boolean))].sort();

  let html = _allCatsForFilter.map((c,i) => {
    const checked = _excludedCats.has(c);
    const isSuggested = SUGGESTED_EXCLUDE.has(c);
    return `<label style="display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:5px;cursor:pointer;${isSuggested?'background:var(--red-bg)':''}">
      <input type="checkbox" class="cf-chk" data-i="${i}" ${checked?'checked':''} style="cursor:pointer">
      <span style="font-size:13px;${isSuggested?'color:var(--red)':''}">${esc(c)}</span>
      ${isSuggested?'<span style="font-size:10px;color:var(--red);margin-left:auto">conta</span>':''}
    </label>`;
  }).join('');
  G('cat-filter-list').innerHTML = html;
  openModal('modal-cat-filter');
}

function catFilterSelectAll(val) {
  document.querySelectorAll('.cf-chk').forEach(e => e.checked = val);
}
function catFilterSelectSuggested() {
  document.querySelectorAll('.cf-chk').forEach(e => {
    e.checked = SUGGESTED_EXCLUDE.has(_allCatsForFilter[parseInt(e.dataset.i)]);
  });
}
function saveCatFilter() {
  _excludedCats = new Set();
  document.querySelectorAll('.cf-chk').forEach(e => {
    if (e.checked) _excludedCats.add(_allCatsForFilter[parseInt(e.dataset.i)]);
  });
  closeModal('modal-cat-filter');
  persistOverviewSettings();
  refreshOverview();
}

// ══ LEDGER COLUMNS ══
function buildLedgerHeader() {
  const cg   = G('ledger-colgroup');
  const hrow = G('ledger-head-row');
  cg.innerHTML = colConfig.filter(c=>c.visible).map(c => `<col style="width:${c.width}px">`).join('');

  let hhtml = '';
  colConfig.filter(c=>c.visible).forEach((col, idx) => {
    const sortable = ['date','category','memo','expense','income','balance'].includes(col.id);
    const sorted   = sortBy === col.id ? 'sorted' : '';
    const arrow    = sortBy === col.id ? (sortOrder==='asc'?'↑':'↓') : '';
    hhtml += `<th data-col="${col.id}" data-idx="${idx}"
      class="${sortable?'sortable':''} ${sorted}"
      draggable="true"
      ondragstart="colDragStart(event,${idx})"
      ondragover="colDragOver(event,${idx})"
      ondrop="colDrop(event,${idx})"
      ondragleave="colDragLeave(event)"
      ${sortable?`onclick="toggleSort('${col.id}')"`:''}>
      ${col.id==='cleared'||col.id==='actions'?col.label:t('col_'+col.id)||col.label}${arrow?`<span class="sort-arrow">${arrow}</span>`:''}
      ${col.id==='cleared'?`<input type="checkbox" title="Selecionar todos" onclick="selectAll(event)" style="margin-left:4px;cursor:pointer">` : ''}
      <div class="col-resize" onmousedown="startResize(event,${idx})"></div>
    </th>`;
  });
  hrow.innerHTML = hhtml;
}

// Column resize
let _resizing = null;
function startResize(e, idx) {
  e.preventDefault(); e.stopPropagation();
  const startX = e.clientX;
  const startW = colConfig[idx].width;
  _resizing = { idx, startX, startW };
  document.addEventListener('mousemove', doResize);
  document.addEventListener('mouseup', stopResize);
}
function doResize(e) {
  if (!_resizing) return;
  const dx = e.clientX - _resizing.startX;
  colConfig[_resizing.idx].width = Math.max(50, _resizing.startW + dx);
  const cols = G('ledger-colgroup').querySelectorAll('col');
  const visIdx = colConfig.filter(c=>c.visible).findIndex((_,i)=>i===_resizing.idx);
  if (cols[_resizing.idx]) cols[_resizing.idx].style.width = colConfig[_resizing.idx].width + 'px';
}
function stopResize() { _resizing = null; document.removeEventListener('mousemove',doResize); document.removeEventListener('mouseup',stopResize); }

// Column drag-to-reorder
let _dragColIdx = null;
function colDragStart(e, idx) { _dragColIdx = idx; e.dataTransfer.effectAllowed = 'move'; }
function colDragOver(e, idx)  { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function colDragLeave(e)      { e.currentTarget.classList.remove('drag-over'); }
function colDrop(e, idx) {
  e.preventDefault(); e.currentTarget.classList.remove('drag-over');
  if (_dragColIdx === null || _dragColIdx === idx) return;
  const moved = colConfig.splice(_dragColIdx, 1)[0];
  colConfig.splice(idx, 0, moved);
  _dragColIdx = null;
  buildLedgerHeader();
  renderLedgerBody(window._lastTxs || []);
}

// ══ ACCOUNT PAGE ══
async function refreshAccount() {
  // Don't re-render while any input inside the account page has focus
  const active = document.activeElement;
  if (active && (
    active.classList.contains('cell-edit-input') ||
    active.tagName === 'INPUT' ||
    active.tagName === 'TEXTAREA' ||
    active.isContentEditable
  ) && active.closest('#page-account')) {
    setTimeout(refreshAccount, 400);
    return;
  }
  if (!currentAccountId) return;
  const acc = accounts.find(a => a.id === currentAccountId);

  // Compute fromDate based on period selector
  let fromDate = null;
  if (periodDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() - periodDays);
    fromDate = d.toISOString().slice(0,10);
  }

  const dbSortBy    = ['date','category','amount'].includes(sortBy) ? sortBy : 'date';
  const dbSortOrder = (sortOrder === 'asc' || sortOrder === 'future') ? 'asc' : 'desc';
  const all = await ff.listTx({ accountId: currentAccountId, sortBy: dbSortBy, order: dbSortOrder, fromDate });
  window._lastTxs = all;

  // Filter by search
  const txs = searchQuery
    ? all.filter(t =>
        norm(t.memo).includes(norm(searchQuery)) ||
        norm(t.category).includes(norm(searchQuery)) ||
        t.date.includes(searchQuery) ||
        String(Math.abs(t.amount)).includes(searchQuery))
    : all;

  // Stats — exclude future transactions from totals
  const today2 = todayStr();
  const bal     = await ff.getBalance(currentAccountId);
  const balBRL  = toBRL(bal, acc?.currency);
  const income  = all.filter(t=>t.amount>0 && t.date<=today2).reduce((s,t)=>s+t.amount,0);
  const expense = all.filter(t=>t.amount<0 && t.date<=today2).reduce((s,t)=>s+t.amount,0);
  G('acct-stats').innerHTML = `
    <div class="stat-card"><div class="stat-lbl">Saldo atual</div><div class="stat-val ${bal>=0?'green':'red'}">${fmtBRL(bal)}</div>${acc?.currency!=='BRL'?`<div class="stat-sub">${fmtBRL(balBRL)} BRL</div>`:''}</div>
    <div class="stat-card"><div class="stat-lbl">Lançamentos</div><div class="stat-val accent">${all.length}</div></div>
    <div class="stat-card"><div class="stat-lbl">Total entradas</div><div class="stat-val green">${fmtBRL(income)}</div></div>
    <div class="stat-card"><div class="stat-lbl">Total saídas</div><div class="stat-val red">${fmtBRL(Math.abs(expense))}</div></div>`;

  // Get balance before the displayed period (to start running balance correctly)
  const periodStart = fromDate || '1900-01-01';
  const balBefore = await ff.getBalanceBefore({ accountId: currentAccountId, beforeDate: periodStart });

  renderLedgerBody(txs, balBefore);

  // If chart mode is active, refresh the chart too
  if (_acctView === 'chart') refreshAccountChart();

  // Restore toggle UI state (in case account page was rebuilt)
  acctSetView(_acctView);
}

function renderLedgerBody(txs, startingBalance = 0) {
  const today   = todayStr();
  const tbody   = G('acct-tbody');
  if (!txs.length) {
    tbody.innerHTML = `<tr><td colspan="${colConfig.filter(c=>c.visible).length}" class="empty"><div class="ei">📭</div><p>Sem lançamentos</p></td></tr>`;
    return;
  }

  // Tiebreaker within same date: income (positive) before expenses (negative), then by id
  const sameDateSort = (a, b) =>
    a.date.localeCompare(b.date) ||
    (a.amount >= 0 ? 0 : 1) - (b.amount >= 0 ? 0 : 1) ||
    a.id - b.id;

  // Compute running balance from startingBalance, sorted chronologically
  const sorted = [...txs].sort(sameDateSort);
  const balMap = {};
  let running = startingBalance;
  sorted.forEach(t => { running += t.amount; balMap[t.id] = running; });

  // Group by past/future
  const past   = txs.filter(t => t.date <= today).sort(sameDateSort);
  const future = txs.filter(t => t.date >  today).sort(sameDateSort);

  let ordered;
  if (sortOrder === 'future') {
    // Futuras primeiro (asc), depois passadas mais recentes primeiro (desc)
    ordered = [...future, ...[...past].reverse()];
  } else if (sortOrder === 'asc') {
    // Antigas → recentes → futuras
    ordered = [...past, ...future];
  } else {
    // Recentes → antigas → futuras (default desc)
    ordered = [...[...past].reverse(), ...future];
  }

  let html = '';
  let futureDividerShown = false;
  let pastDividerShown   = false;

  ordered.forEach((t, i) => {
    const isFuture = t.date > today;
    const ncols = colConfig.filter(c=>c.visible).length;

    // Show divider when transitioning between past and future
    if (isFuture && !futureDividerShown && future.length > 0) {
      futureDividerShown = true;
      if (sortOrder !== 'future' || i > 0) {
        html += `<tr class="future-divider"><td colspan="${ncols}">📅 Lançamentos futuros</td></tr>`;
      }
    }
    if (!isFuture && pastDividerShown === false && sortOrder === 'future' && i > 0 && future.length > 0) {
      pastDividerShown = true;
      html += `<tr class="future-divider" style="background:#f0fdf4;border-color:var(--green);color:var(--green)"><td colspan="${ncols}">✅ Lançamentos realizados</td></tr>`;
    }

    const exp     = t.amount < 0 ? fmtBRL(Math.abs(t.amount)) : '';
    const inc     = t.amount >= 0 ? fmtBRL(t.amount) : '';
    const runBal  = balMap[t.id] ?? 0;
    const balCls  = runBal >= 0 ? 'pos' : 'neg';
    const sel     = selectedRows.has(t.id) ? 'selected' : '';
    const futCls  = isFuture ? 'future' : '';
    let badge = '';
    if (t.transfer_id)  badge = '<span class="badge badge-transfer" style="font-size:10px">⇄</span> ';
    if (t.recurring_id) badge += '<span class="badge badge-recurring" style="font-size:10px;padding:2px 5px"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:inline-block;vertical-align:-1px"><path d="M13 8A5 5 0 0 1 3 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><polyline points="1.5,6.5 3,8 4.5,6.2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M3 8A5 5 0 0 1 13 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><polyline points="11.5,9.8 13,8 14.5,9.8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></span> ';

    const cells = colConfig.filter(c=>c.visible).map(col => {
      switch(col.id) {
        case 'date':     return `<td style="font-size:13px;color:var(--text2);white-space:nowrap" data-col="date">${makeInlineEdit(t.id,'date',t.date,fmtDate(t.date))}</td>`;
        case 'category': return `<td style="font-size:13px" title="${esc(t.category)}" data-col="category">${makeInlineEdit(t.id,'category',t.category,t.category)}</td>`;
        case 'memo':     return `<td style="font-size:13px" title="${esc(t.memo)}" data-col="memo">${badge}${makeInlineEdit(t.id,'memo',t.memo,t.memo)}</td>`;
        case 'expense':  return `<td class="amt-exp" data-col="expense">${makeInlineEdit(t.id,'expense',t.amount<0?Math.abs(t.amount):0,exp)}</td>`;
        case 'income':   return `<td class="amt-inc" data-col="income">${makeInlineEdit(t.id,'income',t.amount>=0?t.amount:0,inc)}</td>`;
        case 'balance':  return `<td class="amt-bal ${balCls}">${fmtBRL(runBal)}</td>`;
        case 'cleared':  return `<td class="center"><span class="cleared-toggle" onclick="event.stopPropagation();toggleCleared(${t.id},${!t.cleared})" title="${t.cleared?'Conferido — clique para desmarcar':'Clique para marcar como conferido'}" style="cursor:pointer;font-size:16px;user-select:none">${t.cleared?'✅':'○'}</span></td>`;
        case 'actions':  return `<td class="center" style="white-space:nowrap"><button class="btn-icon" onclick="editTx(${t.id})" title="Editar">✏️</button><button class="btn-icon" onclick="deleteTx(${t.id})" title="Excluir">🗑</button></td>`;
        default:         return '<td></td>';
      }
    }).join('');

    html += `<tr class="${sel} ${futCls}" data-id="${t.id}" data-date="${t.date}"
      onclick="rowClick(event,${t.id})"
      oncontextmenu="rowCtxMenu(event,${t.id})"
      onkeydown="rowKey(event,${t.id})"
      tabindex="0"
      style="user-select:none">${cells}</tr>`;
  });

  tbody.innerHTML = html;
}

// ── Row selection ──
// Track anchor row for shift+click range selection
let _selAnchor = null;

function rowClick(e, id) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.classList.contains('cleared-toggle')) return;

  if (e.shiftKey && _selAnchor != null) {
    // Extend selection from anchor to here, without clearing anchor
    e.preventDefault();
    const rows = [...G('acct-tbody').querySelectorAll('tr[data-id]')];
    const ids  = rows.map(r => parseInt(r.dataset.id));
    const from = ids.indexOf(_selAnchor);
    const to   = ids.indexOf(id);
    selectedRows.clear();
    ids.slice(Math.min(from,to), Math.max(from,to)+1).forEach(i => selectedRows.add(i));
  } else if (e.ctrlKey || e.metaKey) {
    // Toggle individual, update anchor
    selectedRows.has(id) ? selectedRows.delete(id) : selectedRows.add(id);
    _selAnchor = id;
  } else {
    // Plain click: if clicking an editable cell, let dblclick handle edit
    if (e.target.classList.contains('cell-editable') && !e.shiftKey) return;
    // Set this row as sole selection + new anchor
    selectedRows.clear();
    selectedRows.add(id);
    _selAnchor = id;
  }
  updateSelectionUI();
}
function rowKey(e, id) {
  if (e.key === ' ') {
    e.preventDefault();
    selectedRows.has(id) ? selectedRows.delete(id) : selectedRows.add(id);
    updateSelectionUI();
  }
  // Delete handled at document level to avoid double-prompt
}
function selectAll(e) {
  const rows = [...G('acct-tbody').querySelectorAll('tr[data-id]')];
  if (e.target.checked) rows.forEach(r => selectedRows.add(parseInt(r.dataset.id)));
  else selectedRows.clear();
  updateSelectionUI();
}
function clearSelection() { selectedRows.clear(); _selAnchor = null; updateSelectionUI(); }

// ── Right-click context menu ──
let _ctxTargetId = null; // the row that was right-clicked

function rowCtxMenu(e, id) {
  e.preventDefault();
  e.stopPropagation();
  // If row not in selection, make it the only selection
  if (!selectedRows.has(id)) {
    selectedRows.clear();
    selectedRows.add(id);
    _selAnchor = id;
    updateSelectionUI();
  }
  _ctxTargetId = id;
  const menu = G('row-ctx-menu');
  if (!menu) return;
  menu.style.display = 'block';
  const x = Math.min(e.clientX, window.innerWidth  - menu.offsetWidth  - 8);
  const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

document.addEventListener('click', () => {
  const menu = G('row-ctx-menu');
  if (menu) menu.style.display = 'none';
}, true);
document.addEventListener('contextmenu', e => {
  if (!e.target.closest('tr[data-id]')) {
    const menu = G('row-ctx-menu');
    if (menu) menu.style.display = 'none';
  }
});

async function ctxDuplicate(useToday) {
  G('row-ctx-menu').style.display = 'none';
  const ids = selectedRows.size > 0 ? [...selectedRows] : (_ctxTargetId ? [_ctxTargetId] : []);
  if (!ids.length) return;
  const txs = window._lastTxs || [];
  if (_licStatus?.status === 'payment_required') {
    toast('⚠️ Licença necessária para registrar novos lançamentos. Acesse Configurações → Licença.');
    return;
  }
  for (const id of ids) {
    const tx = txs.find(t => t.id === id);
    if (!tx) continue;
    await ff.createTx({
      account_id: currentAccountId,
      date:       useToday ? todayStr() : tx.date,
      amount:     tx.amount,
      memo:       tx.memo,
      category:   tx.category || '',
    });
  }
  toast(`${ids.length} lançamento(s) duplicado(s)`);
  await loadAccounts();
  if (currentPage === 'account') refreshAccount();
}
function ctxDuplicateToday() { ctxDuplicate(true); }

async function ctxToggleCleared(cleared) {
  G('row-ctx-menu').style.display = 'none';
  const ids = selectedRows.size > 0 ? [...selectedRows] : (_ctxTargetId ? [_ctxTargetId] : []);
  const txs = window._lastTxs || [];
  for (const id of ids) {
    const tx = txs.find(t => t.id === id);
    if (!tx) continue;
    // tx:update requires all fields
    await ff.updateTx({ id: tx.id, date: tx.date, category: tx.category||'', memo: tx.memo||'', amount: tx.amount, cleared: cleared ? 1 : 0 });
  }
  toast(`${ids.length} lançamento(s) ${cleared ? 'marcado(s) como conferido(s)' : 'desmarcado(s)'}`);
  await loadAccounts();
  if (currentPage === 'account') refreshAccount();
}

async function ctxDelete() {
  G('row-ctx-menu').style.display = 'none';
  const ids = selectedRows.size > 0 ? [...selectedRows] : (_ctxTargetId ? [_ctxTargetId] : []);
  if (!ids.length || !await showConfirmDialog(`Excluir ${ids.length} lançamento(s)?`, 'Esta ação pode ser desfeita com Ctrl+Z.', 'Excluir', true)) return;
  for (const id of ids) await ff.deleteTx(id);
  selectedRows.clear();
  toast(`${ids.length} lançamento(s) excluído(s)`);
  await loadAccounts();
  if (currentPage === 'account') refreshAccount();
  if (currentPage === 'overview') await refreshOverview();
  if (currentPage === 'evolucao') refreshEvolucao();
  refreshUndoBtn();
}

async function ctxCreateRecurring() {
  G('row-ctx-menu').style.display = 'none';
  const id = _ctxTargetId || [...selectedRows][0];
  if (!id) return;
  const tx = window._lastTxs?.find(t => t.id === id);
  if (!tx) return;
  // Pre-fill recurring modal from this transaction
  openRecurringModal();
  setTimeout(() => {
    G('rec-account').value  = currentAccountId;
    G('rec-memo').value     = tx.memo || '';
    G('rec-category').value = tx.category || '';
    if (tx.amount < 0) { G('rec-expense').setValue?.(Math.abs(tx.amount)); }
    else               { G('rec-income').setValue?.(tx.amount); }
    const day = tx.date ? parseInt(tx.date.slice(8,10)) : new Date().getDate();
    G('rec-day').value = day;
    G('rec-next').value = tx.date || todayStr();
  }, 50);
}
function updateSelectionUI() {
  // Re-render selection state without full re-render
  G('acct-tbody').querySelectorAll('tr[data-id]').forEach(r => {
    const id = parseInt(r.dataset.id);
    r.classList.toggle('selected', selectedRows.has(id));
  });
  const bar = G('multi-bar');
  if (selectedRows.size > 0) {
    bar.classList.add('show');
    G('multi-count').textContent = `${selectedRows.size} selecionado${selectedRows.size>1?'s':''}`;
  } else {
    bar.classList.remove('show');
  }
}
async function clearAllSelected(btn, val) {
  const count = selectedRows.size;
  for (const id of selectedRows) {
    const tx = window._lastTxs?.find(t=>t.id===id);
    if (tx) await ff.updateTx({...tx, cleared: val?1:0});
  }
  clearSelection();
  await loadAccounts();
  refreshAccount();
  toast(`${count} lançamento${count>1?'s':''} ${val?'marcado(s) como conferido':'desmarcado(s)s'}`);
}
async function deleteSelected() {
  if (!await showConfirmDialog(`Excluir ${selectedRows.size} lançamento(s)?`, 'Esta ação pode ser desfeita com Ctrl+Z.', 'Excluir', true)) return;
  const ids2 = [...selectedRows];
  for (const id of ids2) await ff.deleteTx(id);
  clearSelection();
  await loadAccounts();
  if (currentPage === 'account') refreshAccount();
  if (currentPage === 'overview') await refreshOverview();
  if (currentPage === 'evolucao') refreshEvolucao();
  refreshUndoBtn();
  toast('Excluídos');
}

function onSearch(q) { searchQuery = q; refreshAccount(); }
function setPeriod(val) { periodDays = parseInt(val); refreshAccount(); }
function setSortBy(val) {
  if (val === 'date-desc')   { sortBy = 'date'; sortOrder = 'desc'; }
  else if (val === 'date-asc')    { sortBy = 'date'; sortOrder = 'asc'; }
  else if (val === 'date-future') { sortBy = 'date'; sortOrder = 'future'; }
  else if (val === 'category')    { sortBy = 'category'; sortOrder = 'asc'; }
  else if (val === 'amount')      { sortBy = 'amount'; sortOrder = 'desc'; }
  refreshAccount();
}
function toggleSort(col) {
  if (col === 'date') {
    if (sortBy === 'date' && sortOrder === 'desc') { sortOrder = 'asc'; G('sort-select').value = 'date-asc'; }
    else if (sortBy === 'date' && sortOrder === 'asc') { sortOrder = 'future'; G('sort-select').value = 'date-future'; }
    else { sortOrder = 'desc'; G('sort-select').value = 'date-desc'; }
    sortBy = 'date';
  } else {
    sortBy = col; sortOrder = 'asc';
  }
  buildLedgerHeader();
  refreshAccount();
}

// ══ TX MODAL ══
function openTxModal(tx=null) {
  editingTxId = tx?.id || null;
  G('modal-tx-title').textContent = tx ? 'Editar lançamento' : 'Novo lançamento';
  G('tx-date').value     = tx ? tx.date : todayStr();
  G('tx-expense').value  = tx && tx.amount < 0 ? Math.abs(tx.amount) : '';
  G('tx-income').value   = tx && tx.amount >= 0 ? tx.amount : '';
  G('tx-memo').value     = tx?.memo || '';
  G('tx-category').value = tx?.category || '';
  if (tx?.account_id) G('tx-account').value = tx.account_id;
  else if (currentAccountId) G('tx-account').value = currentAccountId;
  G('ml-suggestion').textContent = '';
  updateFxHints();
  setupCurrencyInput(G('tx-expense'));
  setupCurrencyInput(G('tx-income'));
  // Re-set values after setup (setValue handles formatting)
  if (tx) {
    if (tx.amount < 0) G('tx-expense').setValue(Math.abs(tx.amount));
    else               G('tx-income').setValue(tx.amount);
  }
  // Populate pat asset dropdown and reset toggle
  const patSel = G('tx-pat-asset');
  const patSection = G('tx-pat-section');
  const patToggle  = G('tx-pat-toggle');
  if (patSel) {
    patSel.innerHTML = '<option value="">— Nenhum —</option>' +
      _pat.assets.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
    patSel.value = tx?.pat_asset_id || '';
    if (tx?.pat_tx_type) G('tx-pat-type').value = tx.pat_tx_type;
  }
  const hasPatLink = !!(tx?.pat_asset_id);
  if (patToggle) patToggle.checked = hasPatLink;
  if (patSection) patSection.style.display = hasPatLink ? '' : 'none';
  // Load saved pat type if editing
  if (hasPatLink && tx?.pat_tx_id) {
    // Look up the pat_tx_type from _pat.txAll
    const existingPatTx = _pat.txAll.find(t => t.id === tx.pat_tx_id);
    if (existingPatTx && G('tx-pat-type')) G('tx-pat-type').value = existingPatTx.tx_type;
  }

  openModal('modal-tx');
}

function onImportPatAssetChange(sel, i) {
  // Auto-suggest type based on memo of this row
  const memoInp = G('bank-preview-body')?.querySelectorAll('.import-memo-inp')[i];
  const typeInp = G('bank-preview-body')?.querySelectorAll('.import-pat-type-inp')[i];
  if (!memoInp || !typeInp || !sel.value) return;
  const memo = memoInp.value.toLowerCase();
  if (memo.includes('aluguel'))              typeInp.value = 'aluguel';
  else if (memo.includes('dividendo'))        typeInp.value = 'dividendo';
  else if (memo.includes('jcp') || memo.includes('juros sobre capital')) typeInp.value = 'jcp';
  else if (memo.includes('compra') || memo.includes('aquisi')) typeInp.value = 'compra';
  else if (memo.includes('venda'))            typeInp.value = 'venda';
  else if (memo.includes('parcel') || memo.includes('financ')) typeInp.value = 'parcela_financiamento';
}

function onTxPatAssetChange() {
  // Auto-suggest tx type based on memo content when asset is selected
  const memo = (G('tx-memo')?.value || '').toLowerCase();
  const sel  = G('tx-pat-type');
  if (!sel || G('tx-pat-asset')?.value === '') return;
  if (memo.includes('aluguel'))  sel.value = 'aluguel';
  else if (memo.includes('dividendo')) sel.value = 'dividendo';
  else if (memo.includes('jcp') || memo.includes('juros sobre capital')) sel.value = 'jcp';
  else if (memo.includes('compra') || memo.includes('aquisi')) sel.value = 'compra';
  else if (memo.includes('venda')) sel.value = 'venda';
  else if (memo.includes('parcel') || memo.includes('financ')) sel.value = 'parcela_financiamento';
}

function onAmtInput(type) {
  // Clear the other field
  if (type === 'expense' && G('tx-expense').rawValue?.()) { G('tx-income').value = ''; }
  if (type === 'income'  && G('tx-income').rawValue?.())  { G('tx-expense').value = ''; }
  updateFxHints();
  mlSuggest();
}

function updateFxHints() {
  const accId = parseInt(G('tx-account')?.value);
  const acc   = accounts.find(a => a.id === accId);
  const hint  = fxHint(acc?.currency);
  G('tx-expense-fx').textContent = hint;
  G('tx-income-fx').textContent  = hint;
}

let _mlSuggestTimer = null;
async function mlSuggest() {
  clearTimeout(_mlSuggestTimer);
  _mlSuggestTimer = setTimeout(async () => {
    const memo   = G('tx-memo').value;
    const expVal = (G('tx-expense')?.rawValue ? G('tx-expense').rawValue() : parseFloat(G('tx-expense').value)||0);
    const incVal = (G('tx-income')?.rawValue ? G('tx-income').rawValue() : parseFloat(G('tx-income').value)||0);
    const amount = expVal > 0 ? -expVal : incVal;
    if (!memo || memo.length < 2) { G('ml-suggestion').textContent=''; return; }
    // Check split rules first
    const splitRule = SPLIT_RULES_DEF.find(r => r.match({ memo, amount, date: G('tx-date').value }));
    if (splitRule) {
      G('ml-suggestion').innerHTML = `✂️ <strong>Regra de divisão:</strong> ${esc(splitRule.name)}`;
      return;
    }
    const pred = await ff.mlPredict({ desc: memo, amount });
    if (pred) {
      G('ml-suggestion').textContent = `🧠 ML: ${pred.category||'—'} · "${pred.memo||''}" (${pred.count} usos)`;
      if (!G('tx-category').value && pred.category) G('tx-category').value = pred.category;
    } else {
      G('ml-suggestion').textContent = '';
    }
  }, 200);
}

// ── Split rules ──
const SPLIT_RULES_DEF = [
  {
    name: 'PIX TRANSF RICARDO (dias 13–18) → Auxílio Papai + Escola Crianças',
    match(t) {
      const datePart = (t.date||'').includes('/') ? t.date.split('/')[0] : (t.date||'').split('-')[2];
      const day = parseInt(datePart||'0', 10);
      return norm(t.memo||'').includes('pix transf ricardo') && day >= 13 && day <= 18;
    },
    split(t) {
      const entrada = 12000;
      const saida   = -(entrada + Math.abs(t.amount));
      return [
        { ...t, amount: entrada, memo: 'Auxílio Papai',   category: 'Contas' },
        { ...t, amount: -saida,  memo: 'Escola Crianças', category: 'Educação' },
      ];
    }
  }
];

async function saveTx() {
  // Block NEW transactions when license is required (editing existing is still allowed)
  if (_licStatus?.status === 'payment_required' && !editingTxId) {
    toast('⚠️ Licença necessária para registrar novos lançamentos. Acesse Configurações → Licença.');
    return;
  }
  const account_id = parseInt(G('tx-account').value);
  const date       = G('tx-date').value;
  const memo       = G('tx-memo').value.trim();
  const category   = G('tx-category').value.trim();
  const expVal     = (G('tx-expense')?.rawValue ? G('tx-expense').rawValue() : parseFloat(G('tx-expense').value)||0);
  const incVal     = (G('tx-income')?.rawValue ? G('tx-income').rawValue() : parseFloat(G('tx-income').value)||0);
  if (!date || (expVal===0 && incVal===0)) { toast('Preencha data e valor'); return; }
  const amount = expVal > 0 ? -expVal : incVal;

  // Resolve pat asset linkage BEFORE createTx/updateTx (need IDs upfront)
  const patAssetId = parseInt(G('tx-pat-asset')?.value || '0');
  const patTxType  = G('tx-pat-type')?.value;
  let patTxId = null;
  if (patAssetId && patTxType) {
    const txMonth = date.slice(0, 7);
    const existingPatTxId = editingTxId
      ? (window._lastTxs?.find(t => t.id === editingTxId)?.pat_tx_id || null)
      : null;
    const patResult = await ff.patTxSave({
      id: existingPatTxId, assetId: patAssetId, month: txMonth,
      tx_type: patTxType, total_value: Math.abs(amount),
      notes: memo || null,
    });
    // If it's a financing installment, mark it as paid (handles both create and edit)
    if (patTxType === 'parcela_financiamento') {
      // If editing and the month changed, unpay the old month first
      if (editingTxId && existingPatTxId) {
        const oldTx = _pat.txAll.find(t => t.id === existingPatTxId);
        if (oldTx && oldTx.month.slice(0,7) !== txMonth) {
          await ff.patFinancingUnpay({ assetId: patAssetId, month: oldTx.month }).catch(() => {});
        }
      }
      await ff.patFinancingMarkPaid({ assetId: patAssetId, month: txMonth, amount: Math.abs(amount) }).catch(() => {});
    }
    patTxId = patResult?.id || existingPatTxId;
    await ff.patTxAll().then(txs => { _pat.txAll = txs; }).catch(() => {});
    if (currentPage === 'patrimonio') refreshPatrimonioTable();
  }

  if (editingTxId) {
    await ff.updateTx({ id:editingTxId, date, amount, memo, category, cleared:0,
      pat_asset_id: patAssetId||null, pat_tx_id: patTxId||null });
    toast(t('msg_tx_updated'));
  } else {
    await ff.createTx({ account_id, date, amount, memo, category,
      pat_asset_id: patAssetId||null, pat_tx_id: patTxId||null });
    toast(t('msg_tx_created'));
  }
  if (memo || category) ff.mlLearn({ desc: memo, memo, category, amount });

  closeModal('modal-tx');
  await loadAccounts();
  refreshUndoBtn();
  // Always refresh account view to update running balances; also update overview/evolucao if visible
  refreshAccount();
  if (currentPage === 'overview') refreshOverview();
  if (currentPage === 'evolucao') refreshEvolucao();
}

async function editTx(id) {
  const tx = window._lastTxs?.find(t=>t.id===id);
  if (tx) openTxModal(tx);
}
async function deleteTx(id) {
  // Use Electron dialog instead of window.confirm() to avoid UI freeze
  const confirmed = await showConfirmDialog('Excluir lançamento?', 'Esta ação pode ser desfeita com Ctrl+Z.', 'Excluir', true);
  if (!confirmed) return;
  const tx = window._lastTxs?.find(t => t.id === id);
  const hasPatLink = !!(tx?.pat_asset_id);
  // If linked to financing installment, restore projection before deleting
  if (hasPatLink && tx?.pat_tx_id) {
    const patTx = _pat.txAll.find(t => t.id === tx.pat_tx_id);
    if (patTx?.tx_type === 'parcela_financiamento') {
      await ff.patFinancingUnpay({ assetId: tx.pat_asset_id, month: patTx.month }).catch(() => {});
    }
  }
  await ff.deleteTx(id);
  if (hasPatLink) {
    await refreshPatrimonio(); // reloads txAll, financing, historyAll
    await loadAccounts();
    if (currentPage === 'account') refreshAccount();
    return;
  }
  await loadAccounts();
  if (currentPage === 'account') refreshAccount();
}
async function toggleCleared(id, val) {
  // Fetch from DB directly (handles future txs not in _lastTxs window)
  await ff.inlineUpdate({ id, field: 'cleared', value: val ? 1 : 0 });
  // Also clear the linked transfer leg
  const tx = window._lastTxs?.find(t=>t.id===id);
  if (tx?.transfer_id) {
    // Find the other leg (same transfer_id, different id)
    await ff.clearTransferPair({ transferId: tx.transfer_id, cleared: val ? 1 : 0 });
  }
  await loadAccounts();
  if (currentPage === 'account') refreshAccount();
}

// ══ TRANSFER ══
function openTransferModal() {
  G('tr-date').value=''; G('tr-memo').value='';
  G('tr-date').value = todayStr();
  setupCurrencyInput(G('tr-amount'));
  G('tr-amount').setValue(null);
  // Set hidden field for origin tx deletion after transfer
  let hidField = G('tr-origin-tx-id');
  if (!hidField) {
    hidField = document.createElement('input');
    hidField.type = 'hidden';
    hidField.id = 'tr-origin-tx-id';
    G('modal-transfer')?.appendChild(hidField);
  }
  // Find origin tx from inline edit context
  const inp2 = _globalCatActiveInput;
  if (inp2) {
    const row2 = inp2.closest('tr[data-id]');
    if (row2) hidField.value = row2.dataset.id || '';
    else hidField.value = '';
  } else {
    hidField.value = '';
  }
  openModal('modal-transfer');
}
async function saveTransfer() {
  const fromAccountId = parseInt(G('tr-from').value);
  const toAccountId   = parseInt(G('tr-to').value);
  const date   = G('tr-date').value;
  const amount = G('tr-amount').rawValue ? G('tr-amount').rawValue() : parseFloat(G('tr-amount').value);
  const memo   = G('tr-memo').value.trim();
  // Track whether this was triggered by an inline edit (to delete the original tx)
  const originTxId = G('tr-origin-tx-id')?.value ? parseInt(G('tr-origin-tx-id').value) : null;
  if (!date||isNaN(amount)||amount<=0) { toast('Preencha data e valor'); return; }
  if (fromAccountId===toAccountId) { toast('Contas iguais'); return; }
  await ff.transfer({ fromAccountId, toAccountId, date, amount, memo });
  // Delete the original transaction if this was triggered from an inline edit
  if (originTxId) {
    await ff.deleteTx(originTxId).catch(() => {});
    const hidField = G('tr-origin-tx-id');
    if (hidField) hidField.value = '';
  }
  toast('Transferência registrada');
  closeModal('modal-transfer');
  await loadAccounts();
  if (currentPage==='account') refreshAccount();
  if (currentPage==='overview') refreshOverview();
}

// ══ ACCOUNTS CRUD ══
function openNewAccount() {
  editingAccId = null;
  G('modal-account-title').textContent = 'Nova conta';
  G('acc-name').value=''; G('acc-type').value='bank'; G('acc-currency').value='BRL';
  openModal('modal-account');
}
async function saveAccount() {
  const name=G('acc-name').value.trim(), type=G('acc-type').value, currency=G('acc-currency').value;
  if (!name) { toast('Informe o nome'); return; }
  if (editingAccId) await ff.updateAccount({ id:editingAccId, name, type, currency, hidden:0 });
  else await ff.createAccount({ name, type, currency });
  toast(editingAccId?'Conta atualizada':'Conta criada');
  closeModal('modal-account');
  await loadAccounts();
  openManageAccounts();
}
async function openManageAccounts() {
  const accs = await ff.listAccounts();
  const groups = {};
  accs.forEach(a => { if(!groups[a.type]) groups[a.type]=[]; groups[a.type].push(a); });

  let html = '';
  Object.entries(groups).sort((a,b)=>(TYPE_ORDER[a[0]]||9)-(TYPE_ORDER[b[0]]||9)).forEach(([type,list])=>{
    html+=`<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin:12px 0 6px">${TYPE_LABELS[type]}</div>`;
    list.forEach(a=>{
      html+=`<div class="acc-manage-row" data-id="${a.id}" draggable="true"
        style="display:flex;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px solid var(--border);cursor:grab;user-select:none">
        <span style="color:var(--text3);font-size:14px;flex-shrink:0">⠿</span>
        <span>${TYPE_ICONS[a.type]||'💰'}</span>
        <span style="flex:1;font-size:14px;${a.hidden?'color:var(--text3);text-decoration:line-through':''}">${esc(a.name)}</span>
        <span style="font-size:11px;color:var(--text3)">${a.currency}</span>
        <button class="btn xs" onclick="toggleHide(${a.id},${a.hidden?0:1})">${a.hidden?'👁':'🙈'}</button>
        <button class="btn xs" onclick="editAccount(${a.id})">✏️</button>
        <button class="btn xs danger" onclick="deleteAccountConfirm(${a.id})">🗑</button>
      </div>`;
    });
  });
  G('manage-accounts-list').innerHTML = html;
  openModal('modal-manage-accounts');
  initAccountDragSort();
}

function initAccountDragSort() {
  const rows = [...document.querySelectorAll('.acc-manage-row')];
  let dragEl = null;

  rows.forEach(row => {
    row.addEventListener('dragstart', e => {
      dragEl = row;
      row.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', async () => {
      row.style.opacity = '';
      dragEl = null;
      // Save new order
      const newOrder = [...document.querySelectorAll('.acc-manage-row')].map(r => parseInt(r.dataset.id));
      await ff.reorderAccounts(newOrder);
      await loadAccounts();
    });
    row.addEventListener('dragover', e => {
      e.preventDefault();
      if (!dragEl || dragEl === row) return;
      const rect = row.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      row.parentNode.insertBefore(dragEl, after ? row.nextSibling : row);
    });
  });
}

async function toggleHide(id, hidden) {
  const a = accounts.find(x=>x.id===id);
  if (!a) return;
  await ff.updateAccount({...a, id, hidden});
  await loadAccounts();
  openManageAccounts();
}

async function editAccount(id) {
  const a = accounts.find(x=>x.id===id);
  if (!a) return;
  editingAccId = id;
  G('modal-account-title').textContent = 'Editar conta';
  G('acc-name').value = a.name;
  G('acc-type').value = a.type;
  G('acc-currency').value = a.currency;
  closeModal('modal-manage-accounts');
  openModal('modal-account');
}

async function deleteAccountConfirm(id) {
  const a = accounts.find(x=>x.id===id);
  if (!await showConfirmDialog(`Excluir "${a?.name}"?`, 'Todos os lançamentos serão removidos. Esta ação não pode ser desfeita.', 'Excluir', true)) return;
  await ff.deleteAccount(id);
  await loadAccounts();  // reload accounts list first
  // If we were viewing this account, go to overview
  if (currentAccountId === id) await goPage('overview');
  openManageAccounts();
}

// ══ REPORTS ══
let _repAllCats   = [];
let _repCatFilter = '';
let _savedReports = [];

// ── Period presets ──
function applyPeriodPreset(preset) {
  const n = new Date(), y = n.getFullYear(), m = n.getMonth();
  let from, to;
  if (preset === 'this-month')  { from = new Date(y,m,1);   to = new Date(y,m+1,0); }
  else if (preset === 'last-month')  { from = new Date(y,m-1,1); to = new Date(y,m,0); }
  else if (preset === 'this-year')   { from = new Date(y,0,1);   to = new Date(y,11,31); }
  else if (preset === 'last-year')   { from = new Date(y-1,0,1); to = new Date(y-1,11,31); }
  else if (preset === 'last-3')      { from = new Date(y,m-3,1); to = new Date(y,m+1,0); }
  else if (preset === 'last-6')      { from = new Date(y,m-6,1); to = new Date(y,m+1,0); }
  else { // custom — show date fields
    G('rep-from-wrap').style.display = '';
    G('rep-to-wrap').style.display   = '';
    runReport();
    return;
  }
  G('rep-from').value = from.toISOString().slice(0,10);
  G('rep-to').value   = to.toISOString().slice(0,10);
  G('rep-from-wrap').style.display = 'none';
  G('rep-to-wrap').style.display   = 'none';
  runReport();
}

function onCustomDates() {
  G('rep-period-preset').value = 'custom';
  G('rep-from-wrap').style.display = '';
  G('rep-to-wrap').style.display   = '';
  runReport();
}

async function initReportFilters() {
  // Load saved reports
  try {
    _savedReports = await ff.savedReportsList();
  } catch(e) { _savedReports = []; }
  refreshSavedReportsMenu();

  // Account checkboxes
  const accEl = G('rep-account-checks');
  if (!accEl) return;
  accEl.innerHTML = accounts.filter(a=>!a.hidden).map(a =>
    `<label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;padding:2px 0">
      <input type="checkbox" class="rep-acc-chk" value="${a.id}"> ${esc(a.name)}
    </label>`
  ).join('');

  // Category checkboxes
  const allRows = await ff.reportSummary({ excludeTransfers: false });
  _repAllCats = [...new Set(allRows.map(r=>r.category).filter(Boolean))].sort();
  renderRepCatChecks('');

  // Apply last-used report config, or default to last-month
  const cfg = await ff.overviewConfigGet().catch(()=>null);
  if (cfg?.rep_type) {
    const sel = G('report-type');
    if (sel && !cfg.rep_type.startsWith('saved:')) sel.value = cfg.rep_type;
    const preset = cfg.rep_preset || 'last-month';
    G('rep-period-preset').value = preset;
    if (preset === 'custom') {
      if (cfg.rep_from) G('rep-from').value = cfg.rep_from;
      if (cfg.rep_to)   G('rep-to').value   = cfg.rep_to;
      G('rep-from-wrap').style.display = '';
      G('rep-to-wrap').style.display   = '';
    } else {
      applyPeriodPreset(preset);
    }
    if (cfg.rep_accounts) document.querySelectorAll('.rep-acc-chk').forEach(e => { e.checked = cfg.rep_accounts.includes(parseInt(e.value)); });
    if (cfg.rep_cats)     document.querySelectorAll('.rep-cat-chk').forEach(e => { e.checked = cfg.rep_cats.includes(e.value); });
    if (cfg.rep_excludeTransfers !== undefined) { const chk = G('rep-exclude-transfers'); if (chk) chk.checked = cfg.rep_excludeTransfers; }
  } else {
    G('rep-period-preset').value = 'last-month';
    applyPeriodPreset('last-month');
  }
}

function refreshSavedReportsMenu() {
  const group = G('saved-reports-group');
  if (group) group.innerHTML = _savedReports.map(r =>
    `<option value="saved:${r.id}">${esc(r.name)}</option>`
  ).join('');
  const btn = G('btn-manage-saved');
  if (btn) btn.style.display = _savedReports.length ? '' : 'none';
}

function onReportTypeChange() {
  const type = G('report-type').value;
  if (type.startsWith('saved:')) { loadSavedReport(parseInt(type.replace('saved:',''))); return; }
  const noDate = type === 'net-worth' || type === 'net-worth-history';
  const preset = G('rep-period-preset')?.value || 'last-month';
  const isCustom = preset === 'custom';
  G('rep-period-wrap').style.display = noDate ? 'none' : '';
  G('rep-from-wrap').style.display   = (noDate || !isCustom) ? 'none' : '';
  G('rep-to-wrap').style.display     = (noDate || !isCustom) ? 'none' : '';
  G('rep-adv-filters').style.display = noDate ? 'none' : 'block';
  // Re-apply preset to ensure dates are set correctly
  if (!noDate && !isCustom) applyPeriodPreset(preset);
  else runReport();
}

function renderRepCatChecks(filter) {
  const el = G('rep-cat-checks'); if (!el) return;
  const cats = filter ? _repAllCats.filter(c => norm(c).includes(norm(filter))) : _repAllCats;
  el.innerHTML = cats.map(c =>
    `<label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;padding:2px 0">
      <input type="checkbox" class="rep-cat-chk" value="${esc(c)}"> ${esc(c)}
    </label>`
  ).join('');
}
function filterRepCats(v) { _repCatFilter = v; renderRepCatChecks(v); }
function repCatNone() { document.querySelectorAll('.rep-cat-chk').forEach(e => e.checked=false); }

function getRepFilters() {
  const accountIds = [...document.querySelectorAll('.rep-acc-chk:checked')].map(e=>parseInt(e.value));
  const categories = [...document.querySelectorAll('.rep-cat-chk:checked')].map(e=>e.value);
  const excludeTransfers = G('rep-exclude-transfers')?.checked !== false;
  return { accountIds: accountIds.length ? accountIds : null, categories: categories.length ? categories : null, excludeTransfers };
}

async function loadSavedReport(id) {
  const r = _savedReports.find(x => x.id === id);
  if (!r) return;
  const sel = G('report-type');
  if (sel && r.type) sel.value = r.type;
  if (r.preset && r.preset !== 'custom') {
    G('rep-period-preset').value = r.preset;
    applyPeriodPreset(r.preset);
  } else {
    G('rep-period-preset').value = 'custom';
    G('rep-from-wrap').style.display = '';
    G('rep-to-wrap').style.display   = '';
    if (r.from) G('rep-from').value = r.from;
    if (r.to)   G('rep-to').value   = r.to;
  }
  if (r.accounts) document.querySelectorAll('.rep-acc-chk').forEach(e => { e.checked = r.accounts.includes(parseInt(e.value)); });
  if (r.cats)     document.querySelectorAll('.rep-cat-chk').forEach(e => { e.checked = r.cats.includes(e.value); });
  const chk = G('rep-exclude-transfers');
  if (chk && r.excludeTransfers !== undefined) chk.checked = r.excludeTransfers;
  runReport();
}

function openManageSavedReports() {
  const body = G('manage-saved-body');
  if (!body) return;
  if (!_savedReports.length) { body.innerHTML = '<p style="color:var(--text3);padding:8px 0">Nenhum relatório salvo</p>'; }
  else {
    body.innerHTML = _savedReports.map(r => `
      <div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border)">
        <span style="flex:1;font-size:13px">${esc(r.name)}</span>
        <span style="font-size:11px;color:var(--text3)">${r.type||''}</span>
        <button class="btn xs" onclick="loadSavedReportFromModal(${r.id})">📂 Abrir</button>
        <button class="btn xs" style="color:var(--red)" onclick="deleteSavedReport(${r.id},this)">🗑</button>
      </div>`).join('');
  }
  openModal('modal-manage-saved');
}
function loadSavedReportFromModal(id) { closeModal('modal-manage-saved'); loadSavedReport(id); }
async function deleteSavedReport(id, btn) {
  _savedReports = _savedReports.filter(r => r.id !== id);
  await ff.savedReportsSave(_savedReports);
  refreshSavedReportsMenu();
  btn.closest('div[style*=border-bottom]')?.remove();
  if (!_savedReports.length) G('manage-saved-body').innerHTML = '<p style="color:var(--text3);padding:8px 0">Nenhum relatório salvo</p>';
  toast('Relatório removido');
}

// Build hierarchical tree from flat category rows
function buildTree(rows, categories) {
  let filtered = rows;
  if (categories) {
    filtered = rows.filter(r =>
      categories.includes(r.category) ||
      categories.some(c => r.category.startsWith(c + ':') || c.startsWith(r.category + ':'))
    );
  }
  const tree = {};
  filtered.forEach(r => {
    const parts  = (r.category || '').split(':');
    const parent = parts[0];
    if (!tree[parent]) tree[parent] = { category: parent, expenses: 0, income: 0, children: [] };
    tree[parent].expenses += r.expenses;
    tree[parent].income   += r.income;
    if (parts.length > 1) tree[parent].children.push({ ...r, subName: parts.slice(1).join(':') });
  });
  const parents = Object.values(tree).sort((a,b) => a.category.localeCompare(b.category,'pt-BR'));
  const totalExp = parents.reduce((s,p) => s+p.expenses, 0);
  const totalInc = parents.reduce((s,p) => s+p.income, 0);
  return { parents, totalExp, totalInc };
}

async function runReport() {
  const type = G('report-type').value;
  if (type.startsWith('saved:')) { loadSavedReport(parseInt(type.replace('saved:',''))); return; }
  const from = G('rep-from').value || '';
  const to   = G('rep-to').value   || '';
  const el   = G('report-output');
  if (!el) return;
  const { accountIds, categories, excludeTransfers } = getRepFilters();

  // Persist last-used config
  ff.overviewConfigSave({
    ...(await ff.overviewConfigGet().catch(()=>({}))||{}),
    rep_type: type,
    rep_from: from,
    rep_to:   to,
    rep_preset: G('rep-period-preset')?.value || 'last-month',
    rep_accounts: accountIds,
    rep_cats: categories,
    rep_excludeTransfers: excludeTransfers,
  }).catch(()=>{});

  el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3)">⏳ Carregando…</div>';

  if (type === 'summary' || type === 'detail') {
    const flatRows = await ff.reportSummary({ fromDate:from, toDate:to, accountIds, excludeTransfers });
    const { parents, totalExp, totalInc } = buildTree(flatRows, categories);
    if (!parents.length) { el.innerHTML='<div class="empty"><div class="ei">📊</div><p>Sem dados</p></div>'; return; }

    // Split income vs expense groups (by net)
    const incGroups = parents.filter(p => p.income > p.expenses).sort((a,b)=>a.category.localeCompare(b.category,'pt-BR'));
    const expGroups = parents.filter(p => p.income <= p.expenses).sort((a,b)=>a.category.localeCompare(b.category,'pt-BR'));

    const renderGroup = (p, mode) => {
      const net = p.income - p.expenses;
      const netAbs = Math.abs(net);
      const cls = net >= 0 ? 'color:#16a34a' : 'color:#dc2626';
      const catStyle = `cursor:pointer;text-decoration:underline;text-decoration-color:transparent` +
        `;transition:text-decoration-color .15s` +
        `;onmouseover="this.style.textDecorationColor='currentColor'"` +
        `;onmouseout="this.style.textDecorationColor='transparent'"`;
      let h = '';
      // Parent header row — clickable
      h += `<tr style="background:var(--bg3)" class="rep-cat-row" data-cat="${esc(p.category)}" data-from="${from}" data-to="${to}">
        <td style="padding:6px 14px;font-weight:600;font-size:13px;cursor:pointer" colspan="2">${esc(p.category)} <span style="font-size:10px;color:var(--text3);font-weight:400">▸ ver</span></td>
        <td></td>
      </tr>`;
      // Children (subcategories) — also clickable
      const kids = p.children.sort((a,b)=>a.subName.localeCompare(b.subName,'pt-BR'));
      kids.forEach(c => {
        const cnet = c.income - c.expenses;
        h += `<tr class="rep-cat-row" data-cat="${esc(c.category)}" data-from="${from}" data-to="${to}">
          <td style="padding:4px 14px 4px 28px;font-size:13px;color:var(--text2);cursor:pointer">${esc(c.subName)}</td>
          <td style="padding:4px 14px;text-align:right;font-family:'DM Mono',monospace;font-size:13px;${cnet>=0?'color:#16a34a':'color:#dc2626'}">${fmtBRL(Math.abs(cnet))}</td>
          <td></td>
        </tr>`;
      });
      // If no children, value on same sub-row
      if (!kids.length) {
        h += `<tr class="rep-cat-row" data-cat="${esc(p.category)}" data-from="${from}" data-to="${to}">
          <td style="padding:4px 14px 4px 28px;font-size:13px;color:var(--text2);cursor:pointer">${esc(p.category)}</td>
          <td style="padding:4px 14px;text-align:right;font-family:'DM Mono',monospace;font-size:13px;${cls}">${fmtBRL(netAbs)}</td>
          <td></td>
        </tr>`;
      }
      // Subtotal row
      h += `<tr style="background:var(--bg4)">
        <td style="padding:4px 14px;font-size:12px;color:var(--text3);font-style:italic"></td>
        <td></td>
        <td style="padding:4px 14px;text-align:right;font-family:'DM Mono',monospace;font-size:13px;${cls}">${fmtBRL(netAbs)}</td>
      </tr>`;
      return h;
    };

    let html = `<div class="tbl-card"><div class="tbl-outer">
    <table class="ledger" style="font-size:13px">
    <thead><tr>
      <th style="min-width:220px">Categoria / Subcategoria</th>
      <th class="right" style="min-width:175px">Montante</th>
      <th class="right" style="min-width:175px">Subtotal</th>
    </tr></thead><tbody>`;

    // Income section
    if (incGroups.length) {
      html += `<tr style="background:#dcfce7"><td colspan="3" style="padding:8px 14px;font-weight:700;color:#15803d">📈 Rendimento</td></tr>`;
      let incTotal = 0;
      incGroups.forEach(p => { html += renderGroup(p,'inc'); incTotal += p.income - p.expenses; });
      html += `<tr style="background:#dcfce7;font-weight:700">
        <td style="padding:8px 14px;color:#15803d">Rendimento total</td>
        <td></td>
        <td style="padding:8px 14px;text-align:right;font-family:'DM Mono',monospace;color:#15803d">${fmtBRL(incTotal)}</td>
      </tr>`;
    }

    // Expense section
    if (expGroups.length) {
      html += `<tr style="background:#fee2e2"><td colspan="3" style="padding:8px 14px;font-weight:700;color:#dc2626">📉 Despesas</td></tr>`;
      let expTotal = 0;
      expGroups.forEach(p => { html += renderGroup(p,'exp'); expTotal += p.expenses - p.income; });
      html += `<tr style="background:#fee2e2;font-weight:700">
        <td style="padding:8px 14px;color:#dc2626">Despesas totais</td>
        <td></td>
        <td style="padding:8px 14px;text-align:right;font-family:'DM Mono',monospace;color:#dc2626">${fmtBRL(expTotal)}</td>
      </tr>`;
    }

    // Difference
    const diff = totalInc - totalExp;
    html += `<tr style="background:var(--bg4);border-top:2px solid var(--border2)">
      <td style="padding:10px 14px;font-weight:700;font-size:14px">Diferença:</td>
      <td></td>
      <td style="padding:10px 14px;text-align:right;font-family:'DM Mono',monospace;font-weight:700;font-size:14px;${diff>=0?'color:#15803d':'color:#dc2626'}">${fmtBRL(diff)}</td>
    </tr>`;

    el.innerHTML = html + '</tbody></table></div></div>';

    // Attach click handlers to category rows (safe — no inline JS with colons)
    el.querySelectorAll('.rep-cat-row').forEach(row => {
      row.addEventListener('mouseenter', () => row.style.background = 'var(--accent-lt)');
      row.addEventListener('mouseleave', () => row.style.background = '');
      row.addEventListener('click', () => openCatDetail(row.dataset.cat, row.dataset.from, row.dataset.to));
    });

  } else if (type === 'monthly') {
    let rows = await ff.reportMonthly({ fromDate:from, toDate:to, accountIds, excludeTransfers });
    if (!rows.length) { el.innerHTML='<div class="empty"><div class="ei">📅</div><p>Sem dados</p></div>'; return; }
    const maxV=Math.max(...rows.map(r=>Math.max(r.expenses,r.income)));
    let html='<div class="tbl-card" style="padding:18px"><h3 style="margin-bottom:14px;font-size:14px">Evolução mensal</h3>';
    rows.forEach(r=>{
      html+=`<div style="margin-bottom:10px"><div style="font-size:12px;color:var(--text3);margin-bottom:3px">${r.month}</div>
        <div class="bar-row" style="margin-bottom:2px"><div class="bar-lbl" style="font-size:11px;color:var(--green)">Entradas</div><div class="bar-track"><div class="bar-fill inc" style="width:${maxV>0?r.income/maxV*100:0}%"></div></div><div class="bar-val">${fmtBRL(r.income)}</div></div>
        <div class="bar-row"><div class="bar-lbl" style="font-size:11px;color:var(--red)">Saídas</div><div class="bar-track"><div class="bar-fill exp" style="width:${maxV>0?r.expenses/maxV*100:0}%"></div></div><div class="bar-val">${fmtBRL(r.expenses)}</div></div></div>`;
    });
    el.innerHTML=html+'</div>';

  } else if (type === 'net-worth') {
    const rows=await ff.reportNetWorth({ date:to });
    const groups={};
    rows.forEach(r=>{ if(!groups[r.type]) groups[r.type]=[]; groups[r.type].push(r); });
    let total=0; rows.filter(r=>r.type!=='credit').forEach(r=>total+=toBRL(r.balance,r.currency));
    let html=`<div class="tbl-card"><div class="tbl-header"><h3>Balanço patrimonial</h3><span style="margin-left:auto;font-size:16px;font-weight:700;font-family:'DM Mono',monospace;color:${total>=0?'var(--green)':'var(--red)'}">${fmtBRL(total)}</span></div><div class="tbl-outer"><table class="ledger"><thead><tr><th>Conta</th><th>Moeda</th><th class="right">Saldo</th><th class="right">Em BRL</th></tr></thead><tbody>`;
    Object.entries(groups).sort((a,b)=>(TYPE_ORDER[a[0]]||9)-(TYPE_ORDER[b[0]]||9)).forEach(([type,list])=>{
      const gt=list.reduce((s,r)=>s+toBRL(r.balance,r.currency),0);
      html+=`<tr style="background:var(--bg3)"><td colspan="2" style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text3)">${TYPE_LABELS[type]}</td><td></td><td class="${gt>=0?'amt-inc':'amt-exp'} right">${fmtBRL(gt)}</td></tr>`;
      list.forEach(r=>{ html+=`<tr><td style="padding-left:20px">${esc(r.name)}</td><td style="color:var(--text3);font-size:12px">${r.currency}</td><td class="${r.balance>=0?'amt-inc':'amt-exp'} right">${fmtBRL(r.balance)}</td><td class="right" style="font-size:12px;color:var(--text2)">${r.currency!=='BRL'?fmtBRL(toBRL(r.balance,r.currency)):''}</td></tr>`; });
    });
    el.innerHTML=html+'</tbody></table></div></div>';

  } else if (type === 'net-worth-history') {
    el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text3)">⏳ Calculando evolução patrimonial…</div>';
    const history = await ff.reportNetWorthHistory();
    if (!history.length) { el.innerHTML='<div class="empty"><div class="ei">📈</div><p>Sem dados</p></div>'; return; }
    // Render as canvas chart
    el.innerHTML = `<div class="tbl-card" style="padding:18px">
      <h3 style="font-size:14px;font-weight:600;margin-bottom:16px">Evolução patrimonial</h3>
      <canvas id="nw-history-chart" height="300" style="width:100%;display:block"></canvas>
    </div>`;
    requestAnimationFrame(() => {
      const canvas = G('nw-history-chart');
      if (!canvas) return;
      const months = history.map(h => h.month);
      const values = history.map(h => h.net);
      drawNetWorthChart(canvas, months, values);
    });

  } else if (type === 'expenses-map') {
    let rows=await ff.reportSummary({ fromDate:from, toDate:to, accountIds, excludeTransfers });
    if (categories) rows = rows.filter(r => categories.includes(r.category));
    const expRows=rows.filter(r=>r.expenses>0).sort((a,b)=>b.expenses-a.expenses);
    const total=expRows.reduce((s,r)=>s+r.expenses,0);
    let html='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px">';
    expRows.forEach(r=>{
      const pct=total>0?r.expenses/total*100:0;
      const alpha=Math.max(0.15,Math.min(0.85,pct/20));
      html+=`<div style="background:rgba(220,38,38,${alpha.toFixed(2)});border-radius:8px;padding:14px;border:1px solid #fca5a5">
        <div style="font-size:11px;color:rgba(0,0,0,.6);margin-bottom:4px">${esc(r.category||'Outros')}</div>
        <div style="font-size:16px;font-weight:700;font-family:'DM Mono',monospace;color:#1a2332">${fmtBRL(r.expenses)}</div>
        <div style="font-size:10px;color:rgba(0,0,0,.5);margin-top:2px">${pct.toFixed(1)}% do total</div>
      </div>`;
    });
    el.innerHTML=html+'</div>';

  } else if (type === 'budget') {
    await runBudgetReport(from, to, accountIds, categories, excludeTransfers);
  }
}

function drawNetWorthChart(canvas, months, values) {
  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.parentElement?.offsetWidth - 36 || 800;
  const H   = 300;
  canvas.width  = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W+'px'; canvas.style.height = H+'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0,0,W,H);

  const PAD_L=80, PAD_R=20, PAD_T=20, PAD_B=40;
  const cW=W-PAD_L-PAD_R, cH=H-PAD_T-PAD_B;
  const maxVal=Math.max(...values.map(Math.abs),1);
  const minVal=Math.min(...values);
  const range = Math.max(maxVal - minVal, 1);
  const zero  = PAD_T + cH - ((0 - minVal) / range) * cH;

  // Grid
  ctx.strokeStyle='#e2e8f0'; ctx.lineWidth=1;
  for (let i=0;i<=4;i++) {
    const v = minVal + (range/4)*i;
    const y = PAD_T + cH - ((v - minVal)/range)*cH;
    ctx.beginPath(); ctx.moveTo(PAD_L,y); ctx.lineTo(PAD_L+cW,y); ctx.stroke();
    ctx.fillStyle='#94a3b8'; ctx.font='11px sans-serif'; ctx.textAlign='right';
    ctx.fillText(fmtBRLshort(v), PAD_L-5, y+4);
  }

  // Zero line
  if (minVal < 0) {
    ctx.strokeStyle='#94a3b8'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(PAD_L,zero); ctx.lineTo(PAD_L+cW,zero); ctx.stroke();
  }

  // Fill area
  ctx.beginPath();
  values.forEach((v,i) => {
    const x = PAD_L + (i/(months.length-1||1))*cW;
    const y = PAD_T + cH - ((v-minVal)/range)*cH;
    i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
  });
  const lastX = PAD_L + cW;
  const firstX = PAD_L;
  ctx.lineTo(lastX, Math.min(zero,PAD_T+cH));
  ctx.lineTo(firstX, Math.min(zero,PAD_T+cH));
  ctx.closePath();
  ctx.fillStyle = values[values.length-1] >= 0 ? 'rgba(22,163,74,.12)' : 'rgba(220,38,38,.12)';
  ctx.fill();

  // Line
  ctx.beginPath(); ctx.strokeStyle='#2563eb'; ctx.lineWidth=2;
  values.forEach((v,i) => {
    const x = PAD_L + (i/(months.length-1||1))*cW;
    const y = PAD_T + cH - ((v-minVal)/range)*cH;
    i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
  });
  ctx.stroke();

  // X labels
  const step = Math.max(1, Math.floor(months.length/12));
  ctx.fillStyle='#94a3b8'; ctx.font='10px sans-serif'; ctx.textAlign='center';
  months.forEach((m,i) => {
    if (i%step!==0 && i!==months.length-1) return;
    const x = PAD_L + (i/(months.length-1||1))*cW;
    ctx.fillText(m.slice(0,7), x, H-8);
  });

  // Last value
  const lv = values[values.length-1];
  const lx = PAD_L + cW;
  const ly = PAD_T + cH - ((lv-minVal)/range)*cH;
  ctx.beginPath(); ctx.arc(lx,ly,5,0,2*Math.PI);
  ctx.fillStyle='#2563eb'; ctx.fill();
  ctx.fillStyle='#1a2332'; ctx.font='bold 12px sans-serif'; ctx.textAlign='right';
  ctx.fillText(fmtBRL(lv), lx, ly-10);
}

async function runBudgetReport(from, to, accountIds, categories, excludeTransfers) {
  const el = G('report-output');
  const rows = await ff.reportBudget({ fromDate: from, toDate: to, excludeTransfers });

  // Get months in range
  const months = [...new Set(rows.map(r=>r.month))].sort();
  if (!months.length) { el.innerHTML='<div class="empty"><div class="ei">💰</div><p>Sem dados no período</p></div>'; return; }

  // Get categories (filtered)
  let cats = [...new Set(rows.map(r=>r.category).filter(Boolean))];
  if (categories) cats = cats.filter(c => categories.includes(c));
  // Sort by total expense desc
  cats.sort((a,b) => {
    const ta = rows.filter(r=>r.category===a).reduce((s,r)=>s+r.expenses,0);
    const tb = rows.filter(r=>r.category===b).reduce((s,r)=>s+r.expenses,0);
    return tb-ta;
  });

  // Build budget table: categories vs months
  let html = `<div class="tbl-card">
    <div class="tbl-header">
      <h3>Budget — gastos por categoria e mês</h3>
      <span style="font-size:12px;color:var(--text3);margin-left:8px">${months.length} meses</span>
    </div>
    <div class="tbl-outer">
    <table class="ledger">
    <thead><tr>
      <th style="min-width:180px">Categoria</th>
      ${months.map(m=>`<th class="right" style="min-width:100px">${m}</th>`).join('')}
      <th class="right" style="min-width:110px">Total</th>
      <th class="right" style="min-width:100px">Média/mês</th>
    </tr></thead>
    <tbody>`;

  // Monthly totals row (header)
  const monthTotals = months.map(m => rows.filter(r=>r.month===m).reduce((s,r)=>s+r.expenses,0));
  const grandTotal  = monthTotals.reduce((s,v)=>s+v,0);
  html += `<tr style="background:var(--bg3);font-weight:700">
    <td style="font-size:12px">TOTAL</td>
    ${monthTotals.map(v=>`<td class="amt-exp">${fmtBRL(v)}</td>`).join('')}
    <td class="amt-exp">${fmtBRL(grandTotal)}</td>
    <td class="amt-exp">${fmtBRL(grandTotal/months.length)}</td>
  </tr>`;

  cats.forEach(cat => {
    const catRows    = rows.filter(r=>r.category===cat);
    const catMonths  = months.map(m => { const r=catRows.find(x=>x.month===m); return r?.expenses||0; });
    const catTotal   = catMonths.reduce((s,v)=>s+v,0);
    const catAvg     = catTotal / months.length;
    const maxMonthV  = Math.max(...catMonths,1);

    html += `<tr>
      <td style="font-size:13px">${esc(cat)}</td>
      ${catMonths.map(v => {
        const pct = maxMonthV > 0 ? v/maxMonthV*100 : 0;
        const isHigh = v > catAvg * 1.3 && v > 0;
        const color  = isHigh ? 'var(--red)' : v > 0 ? 'var(--text)' : 'var(--text3)';
        return `<td class="right" style="font-size:12px;font-family:'DM Mono',monospace;color:${color};white-space:nowrap">
          ${v > 0 ? fmtBRL(v) : '—'}
        </td>`;
      }).join('')}
      <td class="amt-exp">${fmtBRL(catTotal)}</td>
      <td class="right" style="font-size:12px;font-family:'DM Mono',monospace;color:var(--text2)">${fmtBRL(catAvg)}</td>
    </tr>`;
  });

  el.innerHTML = html + '</tbody></table></div></div>';
}

// ══ BANK FILE IMPORT ══
let _bankParsed = [];   // holds parsed rows before confirm

// ── Built-in bank/card configs (editable name, icon, sort_order) ──
const BUILTIN_BANKS = [
  { id:'itau',  type:'bank', name:'Itaú',  fileType:'XLSX', sort_order:0,
    logoUrl:'', logoBg:'#EC7000', logoFallback:'IT' },
];
const BUILTIN_CARDS = [
  { id:'btg',      type:'card', name:'BTG',        fileType:'XLSX', sort_order:0,
    logoUrl:'', logoBg:'#003B71', logoFallback:'BT' },
  { id:'xp',       type:'card', name:'XP',          fileType:'CSV',  sort_order:1,
    logoUrl:'', logoBg:'#111111', logoFallback:'XP' },
  { id:'itau_card',type:'card', name:'Itaú (cartão)',fileType:'XLSX', sort_order:2,
    logoUrl:'', logoBg:'#EC7000', logoFallback:'IT' },
];

// Editable overrides stored in _bank_parsers.json under key __builtin__
let _builtinOverrides = {}; // {id: {name, logoUrl, sort_order}}

// Custom parsers loaded from disk
let _customBankParsers = []; // [{id, name, type:'bank'|'card', config:{...}}]

async function initImportPage() {
  const all = await ff.bankParsersList();
  // Separate builtin overrides from custom parsers
  const ovEntry = all.find(p => p.id === '__builtin_overrides__');
  _builtinOverrides = ovEntry?.data || {};
  _customBankParsers = all.filter(p => p.id !== '__builtin_overrides__' && p.type !== 'broker');
  renderImportDropdowns();
  await initBrokerDropdown();
  // Populate broker account selector with investment accounts
  const brokerAccSel = G('broker-account');
  if (brokerAccSel && accounts.length) {
    const invAccounts = accounts.filter(a => a.type === 'investment' || a.type === 'checking');
    brokerAccSel.innerHTML = '<option value="">— Não criar ajuste —</option>' +
      invAccounts.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  }
}

function getBuiltinDefs(list) {
  return list
    .map(b => {
      const ov = _builtinOverrides[b.id] || {};
      return { ...b, name: ov.name || b.name, logoUrl: ov.logoUrl || b.logoUrl, sort_order: ov.sort_order ?? b.sort_order };
    })
    .sort((a,b) => a.sort_order - b.sort_order);
}

function bankLogoHtml(p, size=24) {
  const bg  = p.logoBg || '#888';
  const fb  = p.logoFallback || (p.name||'?').slice(0,2).toUpperCase();
  const url = p.logoUrl;
  const fs  = Math.round(size * 0.4);
  if (url) {
    // External URL: show img with initials fallback
    return `<span style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:4px;overflow:hidden;background:${bg};flex-shrink:0;pointer-events:none">
      <img src="${url}" width="${size}" height="${size}" style="object-fit:contain;pointer-events:none"
        onerror="this.style.display='none';this.nextSibling.style.display='inline-flex'">
      <span style="display:none;color:#fff;font-size:${fs}px;font-weight:700;width:100%;height:100%;align-items:center;justify-content:center;pointer-events:none">${fb}</span>
    </span>`;
  }
  // No URL: just colored initials badge
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:4px;background:${bg};flex-shrink:0;pointer-events:none;color:#fff;font-size:${fs}px;font-weight:700">${fb}</span>`;
}

function ddItemHtml(p, type, isBuiltin) {
  const logo = bankLogoHtml(p, 24);
  // Broker items call pickBroker; bank/card items call pickImport
  const clickFn = type === 'broker' ? `pickBroker('${p.id}')` : `pickImport('${p.id}','${type}')`;
  const editBtn = `<button class="btn-icon" style="font-size:11px;color:var(--text3);margin-left:4px" title="Editar" onclick="event.stopPropagation();openBankEdit('${p.id}','${type}',${isBuiltin})">✎</button>`;
  const delBtn  = isBuiltin ? '' : `<button class="btn-icon" style="font-size:11px;color:var(--text3)" title="Remover" onclick="event.stopPropagation();deleteCustomParser('${p.id}')">✕</button>`;
  return `<div class="import-dd-item" style="justify-content:space-between" onclick="${clickFn}">
    <span style="display:flex;align-items:center;gap:8px;flex:1;pointer-events:none">
      ${logo}
      <span style="font-weight:500">${esc(p.name)}</span>
      <span style="color:var(--text3);font-size:11px">${p.fileType||p.config?.fileType||'CSV'}</span>
    </span>
    <span style="display:flex;gap:2px" onclick="event.stopPropagation()">${editBtn}${delBtn}</span>
  </div>`;
}

function renderImportDropdowns() {
  // Built-in banks
  const bbEl = G('import-dd-bank-builtin');
  if (bbEl) bbEl.innerHTML = getBuiltinDefs(BUILTIN_BANKS).map(p => ddItemHtml(p,'bank',true)).join('');

  // Built-in cards
  const bcEl = G('import-dd-card-builtin');
  if (bcEl) bcEl.innerHTML = getBuiltinDefs(BUILTIN_CARDS).map(p => ddItemHtml(p,'card',true)).join('');

  // Custom bank items
  const bankContainer = G('import-dd-bank-custom');
  if (bankContainer) {
    bankContainer.innerHTML = _customBankParsers.filter(p => p.type === 'bank')
      .map(p => ddItemHtml({...p, fileType: p.config?.fileType}, 'bank', false)).join('');
  }

  // Custom card items
  const cardContainer = G('import-dd-card-custom');
  if (cardContainer) {
    cardContainer.innerHTML = _customBankParsers.filter(p => p.type === 'card')
      .map(p => ddItemHtml({...p, fileType: p.config?.fileType}, 'card', false)).join('');
  }
}

async function deleteCustomParser(id) {
  if (!await showConfirmDialog('Remover configuração?', '', 'Remover', true)) return;
  await ff.bankParserDelete({ id });
  _customBankParsers = _customBankParsers.filter(p => p.id !== id);
  renderImportDropdowns();
}

// ── Edit dialog for built-in and custom banks ──
function openBankEdit(id, type, isBuiltin) {
  // Close all dropdowns
  ['bank','card','broker'].forEach(t => {
    const dd = G(`import-dd-${t}`); if (dd) dd.style.display = 'none';
    const ar = G(`import-dd-${t}-arrow`); if (ar) ar.textContent = '▾';
  });

  let current;
  if (isBuiltin) {
    const allBuiltin = [...BUILTIN_BANKS, ...BUILTIN_CARDS, ...BUILTIN_BROKERS];
    const base = allBuiltin.find(b => b.id === id);
    if (!base) return;
    const ov = _builtinOverrides[id] || {};
    current = { ...base, name: ov.name || base.name, logoUrl: ov.logoUrl || base.logoUrl, sort_order: ov.sort_order ?? base.sort_order };
  } else {
    current = (_customBankParsers||[]).find(p => p.id === id)
           || (_customBrokerParsers||[]).find(p => p.id === id);
    if (!current) return;
  }

  // All items of same type for sort_order reference
  const allSameType = isBuiltin
    ? getBuiltinDefs(type === 'broker' ? BUILTIN_BROKERS : type === 'bank' ? BUILTIN_BANKS : BUILTIN_CARDS)
    : (type === 'broker' ? _customBrokerParsers : _customBankParsers).filter(p => p.type === type);

  const posOptions = allSameType.map((p,i) => `<option value="${i}" ${(current.sort_order ?? 0) === i ? 'selected' : ''}>${i+1}ª posição</option>`).join('');

  G('custom-parser-title').textContent = `Editar — ${current.name}`;
  G('custom-parser-body').innerHTML = `
    <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1;min-width:200px">
        <div class="field">
          <label class="lbl">Nome exibido</label>
          <input class="inp" id="edit-bank-name" type="text" value="${esc(current.name)}" style="max-width:260px">
        </div>
        <div class="field">
          <label class="lbl">URL do ícone (imagem)</label>
          <input class="inp" id="edit-bank-logo" type="text" value="${esc(current.logoUrl||'')}" placeholder="https://…/logo.png" style="max-width:320px" oninput="previewEditLogo()">
          <div style="font-size:11px;color:var(--text3);margin-top:3px">Pode usar qualquer URL pública de imagem, ou deixar em branco para usar as iniciais.</div>
        </div>
        <div class="field">
          <label class="lbl">Posição no menu</label>
          <select class="inp" id="edit-bank-order" style="max-width:160px">${posOptions}</select>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:8px">
        <div style="font-size:11px;color:var(--text3)">Prévia do ícone</div>
        <div id="edit-logo-preview">${bankLogoHtml(current, 48)}</div>
      </div>
    </div>`;

  G('custom-parser-footer').innerHTML = `
    <button class="btn" onclick="closeModal('modal-custom-parser')">Cancelar</button>
    <button class="btn primary" onclick="saveBankEdit('${id}','${type}',${isBuiltin})">Salvar</button>`;

  openModal('modal-custom-parser');
}

function previewEditLogo() {
  const url = G('edit-bank-logo').value.trim();
  const name = G('edit-bank-name').value.trim();
  const preview = G('edit-logo-preview');
  if (!preview) return;
  const p = { logoUrl: url, logoBg: '#888', logoFallback: name.slice(0,2).toUpperCase() };
  preview.innerHTML = bankLogoHtml(p, 48);
}

async function saveBankEdit(id, type, isBuiltin) {
  const name       = G('edit-bank-name').value.trim();
  const logoUrl    = G('edit-bank-logo').value.trim();
  const sort_order = parseInt(G('edit-bank-order').value);

  if (!name) { toast('Informe um nome'); return; }

  if (isBuiltin) {
    _builtinOverrides[id] = { name, logoUrl, sort_order };
    await ff.bankParserSave({ id: '__builtin_overrides__', data: _builtinOverrides });
  } else {
    const allCustom = [...(_customBankParsers||[]), ...(_customBrokerParsers||[])];
    const parser = allCustom.find(p => p.id === id);
    if (parser) {
      parser.name = name;
      parser.logoUrl = logoUrl;
      parser.sort_order = sort_order;
      await ff.bankParserSave(parser);
      const all = await ff.bankParsersList();
      _customBankParsers   = all.filter(p => p.id !== '__builtin_overrides__' && p.type !== 'broker');
      _customBrokerParsers = all.filter(p => p.type === 'broker');
    }
  }
  renderImportDropdowns();
  renderBrokerDropdown();
  closeModal('modal-custom-parser');
  toast('Configuração salva');
}

function toggleImportDropdown(type) {
  const dd = G(`import-dd-${type}`);
  if (!dd) return;
  const arrow = G(`import-dd-${type}-arrow`);
  const isOpen = dd.style.display !== 'none';

  // Close all dropdowns first
  ['bank','card'].forEach(t => {
    const d = G(`import-dd-${t}`);
    if (d) d.style.display = 'none';
    const a = G(`import-dd-${t}-arrow`);
    if (a) a.textContent = '▾';
  });

  if (!isOpen) {
    // Position below the trigger button using fixed coords
    const btn = G(`import-dd-${type}-wrap`)?.querySelector('button');
    if (btn) {
      const rect = btn.getBoundingClientRect();
      dd.style.top  = (rect.bottom + 4) + 'px';
      dd.style.left = rect.left + 'px';
    }
    dd.style.display = 'block';
    if (arrow) arrow.textContent = '▴';
  }
}

// Close dropdowns when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('#import-dd-bank-wrap') && !e.target.closest('#import-dd-card-wrap')) {
    ['bank','card'].forEach(t => {
      const dd = G(`import-dd-${t}`);
      const arrow = G(`import-dd-${t}-arrow`);
      if (dd) { dd.style.display = 'none'; }
      if (arrow) arrow.textContent = '▾';
    });
  }
});

function pickImport(bankId, type) {
  // Hide broker section when using bank/card import
  const bs = G('broker-section'); if (bs) bs.style.display = 'none';
  // Restore bank fields
  const bankFields2 = G('bank-account')?.closest('.field-row');
  if (bankFields2) bankFields2.style.display = '';
  // Close dropdown
  toggleImportDropdown('__close__');
  ['bank','card','broker'].forEach(t => {
    const dd = G(`import-dd-${t}`);
    if (dd) dd.style.display = 'none';
    const ar = G(`import-dd-${t}-arrow`);
    if (ar) ar.textContent = '▾';
  });

  if (bankId === 'outro_banco' || bankId === 'outro_cartao') {
    openCustomParserWizard(bankId === 'outro_cartao' ? 'card' : 'bank');
    return;
  }

  // Custom parser
  const custom = _customBankParsers.find(p => p.id === bankId);
  if (custom) {
    selBank = bankId;
    window._selBank = bankId;
    const label = G('bank-selected-label');
    if (label) label.textContent = `Selecionado: ${custom.name}`;
    G('btg-warn').style.display = 'none';
    G('bank-file-trigger').style.display = 'flex';
    G('bank-file-input').accept = custom.config.fileType === 'CSV' ? '.csv,.CSV' : '.xls,.xlsx,.XLS,.XLSX,.ofx,.OFX,.pdf,.PDF';
    cancelBankImport();
    return;
  }

  // Built-in parsers
  selBank = bankId;
  window._selBank = bankId;

  const allBuiltins = [...BUILTIN_BANKS, ...BUILTIN_CARDS];
  const builtinDef = allBuiltins.find(b => b.id === bankId);
  const builtinName = builtinDef ? (_builtinOverrides[bankId]?.name || builtinDef.name) : bankId;
  const label = G('bank-selected-label');
  if (label) label.innerHTML = `<span style="display:flex;align-items:center;gap:8px">Selecionado: ${builtinDef ? bankLogoHtml({...builtinDef,...(_builtinOverrides[bankId]||{})},18) : ''} <strong>${esc(builtinName)}</strong></span>`;

  G('btg-warn').style.display = bankId === 'btg' ? 'block' : 'none';
  G('bank-file-input').accept = bankId === 'xp' ? '.csv,.CSV' : '.xls,.xlsx,.XLS,.XLSX';
  G('bank-file-trigger').style.display = 'flex';

  const bankSel = G('bank-account');
  if (bankSel) {
    const def = (window._importDefaults || {})[bankId];
    if (def) bankSel.value = def;
  }
  cancelBankImport();
}

function triggerBankFile() {
  if (!selBank) { toast('Selecione um banco ou cartão primeiro'); return; }
  G('bank-file-input').click();
}

async function onBankFileSelected(event) {
  const file = event.target.files[0];
  if (!file) return;
  G('bank-file-name').textContent = file.name;
  const buffer = await file.arrayBuffer();

  // Ensure XLSX is loaded
  if (typeof XLSX === 'undefined') {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  try {
    let rows;
    const custom = _customBankParsers.find(p => p.id === selBank);
    if (custom) {
      rows = parseCustomBank(buffer, custom.config);
    } else {
      rows = parseBankFile(buffer);
    }

    if (!rows || rows.length === 0) {
      G('bank-result').innerHTML = '<div class="warn-box">⚠️ Nenhuma transação encontrada no arquivo.</div>';
      return;
    }

    _bankParsed = rows;
    renderBankPreview(rows);
  } catch(e) {
    G('bank-result').innerHTML = `<div class="warn-box">❌ Erro ao ler o arquivo: ${esc(e.message)}</div>`;
  }
  event.target.value = '';
}

function parseBankFile(buffer) {
  if (selBank === 'xp') return parseBankXP(buffer);
  if (selBank === 'btg') return parseBankBTG(buffer);
  if (selBank === 'itau_card') return parseBankItauCard(buffer);
  return parseBankItau(buffer);
}

function renderBankPreview(rows) {
  const dateFrom = G('bank-date-from').value;
  const filtered = dateFrom ? rows.filter(r => r.date >= dateFrom) : rows;
  const preview = G('bank-preview');
  if (!preview) return;

  // Restore original table structure in case it was replaced by edit table
  const tbl = preview.querySelector('table.ledger');
  if (tbl) {
    const thead = tbl.querySelector('thead tr');
    if (thead) thead.innerHTML = '<th>Data</th><th>Descrição</th><th class="right">Valor</th>';
  }
  const tblOuter = preview.querySelector('.tbl-outer');
  if (tblOuter) tblOuter.style.maxHeight = '200px';

  const titleEl = G('bank-preview-title');
  const countEl = G('bank-preview-count');
  const bodyEl  = G('bank-preview-body');
  if (titleEl) titleEl.textContent = `Prévia — ${filtered.length} transações`;
  if (countEl) countEl.textContent = `${filtered.length} de ${rows.length} transações${dateFrom ? ` (filtrado a partir de ${dateFrom})` : ''}`;
  if (bodyEl) bodyEl.innerHTML = filtered.slice(0, 50).map(r =>
    `<tr><td>${r.date}</td><td>${esc(r.memo||r.desc||'')}</td><td class="${r.amount<0?'amt-exp':'amt-inc'} right">${fmtBRL(r.amount)}</td></tr>`
  ).join('');

  // Restore footer buttons
  const footer = preview.querySelector('div[style*="margin-top:10px"], .import-footer');
  if (footer) footer.innerHTML = `
    <button class="btn primary" onclick="confirmBankImport()">✓ Confirmar importação</button>
    <button class="btn" onclick="cancelBankImport()">Cancelar</button>
    <span id="bank-preview-count" style="font-size:12px;color:var(--text3)"></span>`;

  preview.style.display = 'block';
  if (G('bank-result')) G('bank-result').innerHTML = '';
}

function cancelBankImport() {
  _bankParsed = [];
  G('bank-preview').style.display = 'none';
  G('bank-result').innerHTML = '';
  G('bank-file-name').textContent = '';
}

// ── Import helpers ──
function detectParcela(memo) {
  if (!memo) return null;
  const m = memo.match(/parcela\s+(\d+)\s*[\/de]+\s*(\d+)/i)
         || memo.match(/(\d+)\s*\/\s*(\d+)/);
  if (m) { const p=parseInt(m[1]),t=parseInt(m[2]); if(p>0&&t>1&&p<=t) return {parcel:p,total:t}; }
  return null;
}
function shiftMonths(isoDate, months) {
  const [y,mo,d] = isoDate.split('-').map(Number);
  const dt = new Date(y, mo-1+months, d);
  if (dt.getMonth() !== (mo-1+months)%12) dt.setDate(0);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

let _pendingImport = null; // {rows, parcelInstallments, accountId, checkDailySaldo}

async function confirmBankImport() {
  if (_licStatus?.status === 'payment_required') {
    toast('⚠️ Licença necessária para importar lançamentos. Acesse Configurações → Licença.');
    return;
  }
  const accountId = parseInt(G('bank-account').value);
  if (!accountId) { toast('Selecione uma conta de destino'); return; }
  if (!_bankParsed.length) { toast('Nenhum dado para importar'); return; }

  const dateFrom = G('bank-date-from').value;
  const isCardImport = selBank !== 'itau' && selBank !== 'itau_extrato';

  // Determine import month (most common) for installment shifting
  const dateCounts = {};
  _bankParsed.forEach(r => {
    const iso = r.date.includes('-') ? r.date : toISOClient(r.date);
    if (iso) { const ym = iso.slice(0,7); dateCounts[ym] = (dateCounts[ym]||0)+1; }
  });
  const importMonth = Object.entries(dateCounts).sort((a,b)=>b[1]-a[1])[0]?.[0];

  const rows = [];
  const parcelInstallments = [];

  _bankParsed.forEach(r => {
    const memo = r.memo || r.desc || '';
    const parcela = isCardImport ? detectParcela(memo) : null;
    if (parcela) {
      const isoOrig = r.date.includes('-') ? r.date : toISOClient(r.date);
      if (parcela.parcel === 1 && isoOrig) {
        rows.push({...r, memo});
        for (let p = 2; p <= parcela.total; p++) {
          parcelInstallments.push({
            date: shiftMonths(isoOrig, p-1),
            amount: r.amount,
            memo: memo.replace(/parcela\s+\d+/i,`Parcela ${p}`).replace(/\b1\s*[\/de]+\s*\d+/,`${p}/${parcela.total}`),
            category: r.category||'',
          });
        }
      } else if (isoOrig && importMonth) {
        const shifted = shiftMonths(isoOrig, parcela.parcel-1);
        rows.push({...r, date: shifted, memo});
      } else {
        rows.push({...r, memo});
      }
    } else {
      rows.push({...r, memo});
    }
  });

  if (window._importDefaults) window._importDefaults[selBank] = String(accountId);

  // Normalise dates to ISO, apply date filter
  const normalised = rows
    .map(r => ({...r, dateISO: r.date.includes('-') ? r.date.slice(0,10) : toISOClient(r.date)}))
    .filter(r => r.dateISO && (!dateFrom || r.dateISO >= dateFrom));

  // Apply ML suggestions to memo/category
  const mlRules = await ff.mlList();
  const withML = normalised.map(r => {
    let sugMemo = r.memo, sugCat = r.category||'';
    for (const rule of mlRules) {
      const memoNorm = norm(r.memo);
      if (memoNorm.includes(norm(rule.pattern||rule.memo||''))) {
        sugMemo = rule.memo || sugMemo;
        sugCat  = rule.category || sugCat;
        break;
      }
    }
    return {...r, sugMemo, sugCat};
  });

  const checkDailySaldo = selBank === 'itau' && rows.some(r => r.saldo != null);
  _pendingImport = { rows: withML, parcelInstallments, accountId, checkDailySaldo };

  // Step 1: check for duplicates FIRST, before editing
  const rowsForDupCheck = withML.map(r => ({
    date: r.dateISO.split('-').reverse().join('/'),
    amount: r.amount, memo: r.memo, category: r.category||'', saldo: r.saldo??null,
  }));
  G('bank-result').innerHTML = '<div class="info-box">⏳ Verificando duplicatas…</div>';
  try {
    const dupResult = await ff.bankImport({ accountId, rows: rowsForDupCheck, checkDailySaldo: false, skipIds: [], dryRun: true });
    G('bank-result').innerHTML = '';
    if (dupResult.needsConfirmation) {
      // Show dup resolution BEFORE edit table
      showDupResolutionUI(dupResult.potentialDups, withML, parcelInstallments, accountId, checkDailySaldo);
    } else {
      // No dups — go straight to edit table
      renderImportEditTable(withML);
    }
  } catch(e) {
    G('bank-result').innerHTML = '';
    renderImportEditTable(withML); // fallback: skip dup check, proceed to edit
  }
}

function renderImportEditTable(rows) {
  if (!rows || rows.length === 0) {
    toast('Nenhuma transação para importar após filtrar duplicatas.');
    cancelBankImport();
    return;
  }

  const mlBadge = `<span style="font-size:9px;background:var(--accent-bg);color:var(--accent);border-radius:3px;padding:1px 4px;margin-left:4px" title="Sugestão ML">🧠</span>`;

  const tableRows = rows.map((r, i) => {
    const hasSug = r.sugMemo !== r.memo || r.sugCat;
    const amtCls = r.amount < 0 ? 'amt-exp' : 'amt-inc';
    return `<tr>
      <td style="white-space:nowrap;font-size:12px;padding:5px 8px;vertical-align:middle">${r.dateISO}</td>
      <td style="font-size:11px;color:var(--text3);padding:4px 8px;vertical-align:middle;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.desc||r.memo||'')}">${esc(r.desc||r.memo||'')}</td>
      <td style="padding:3px 4px;vertical-align:middle">
        <div style="display:flex;align-items:center;gap:4px">
          <input class="inp import-memo-inp" data-idx="${i}" value="${esc(r.sugMemo)}"
            style="flex:1;font-size:12px;padding:3px 6px;min-width:130px">
          ${hasSug ? mlBadge : ''}
        </div>
      </td>
      <td style="padding:3px 4px;vertical-align:middle">
        <div style="display:flex;align-items:center;gap:2px">
          <input class="inp import-cat-inp" data-idx="${i}" value="${esc(r.sugCat)}"
            placeholder="Categoria" autocomplete="off"
            style="flex:1;font-size:12px;padding:3px 6px;min-width:100px"
            oninput="openGlobalCatDrop(this)"
            onfocus="openGlobalCatDrop(this)"
            id="import-cat-${i}">
          <button type="button" tabindex="-1"
            style="padding:2px 5px;font-size:10px;line-height:1;background:var(--bg3);border:1px solid var(--border);border-radius:4px;cursor:pointer;flex-shrink:0;color:var(--text2)"
            onmousedown="event.preventDefault();openGlobalCatDrop(this.previousElementSibling)">▾</button>
        </div>
      </td>
      <td class="${amtCls} right" style="font-size:12px;padding:5px 8px;white-space:nowrap;font-family:'DM Mono',monospace;vertical-align:middle">${fmtBRL(r.amount)}</td>
    </tr>`;
  }).join('');

  const preview = G('bank-preview');

  // Rebuild preview HTML from scratch — safe after dup UI replaced it
  preview.innerHTML = `
    <div class="tbl-card">
      <div class="tbl-header">
        <h3 id="bank-preview-title">${rows.length} transação(ões) — revise e confirme</h3>
      </div>
      <div class="tbl-outer" style="max-height:calc(100vh - 360px)">
        <table class="ledger">
          <thead><tr>
            <th>Data</th><th>Descrição original</th><th>Memorando</th><th>Categoria</th><th>Ativo imob.</th><th>Tipo mov.</th><th class="right">Valor</th>
          </tr></thead>
          <tbody id="bank-preview-body">${tableRows}</tbody>
        </table>
      </div>
    </div>
    <div class="import-footer" style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap">
      <button class="btn primary" onclick="doImportFromTable()">✓ Confirmar importação</button>
      <button class="btn" onclick="cancelBankImport()">Cancelar</button>
      <span style="font-size:12px;color:var(--text3)">${rows.length} lançamento(s) · 🧠 = sugerido pelo ML</span>
    </div>`;

  preview.style.display = 'block';
  if (G('bank-result')) G('bank-result').innerHTML = '';
}

async function doImportFromTable() {
  if (!_pendingImport) return;
  const { rows, parcelInstallments, accountId, checkDailySaldo } = _pendingImport;

  // Read edited memo/category from table inputs
  const memoInputs = G('bank-preview-body').querySelectorAll('.import-memo-inp');
  const catInputs  = G('bank-preview-body').querySelectorAll('.import-cat-inp');
  const finalRows = rows.map((r, i) => ({
    ...r,
    memo:     memoInputs[i]?.value || r.memo,
    category: catInputs[i]?.value  || r.sugCat || '',
  }));

  // Rebuild parcelInstallments using user-edited memo/category from finalRows
  // Each finalRow that is parcel 1/N has corresponding future installments
  const updatedInstallments = parcelInstallments.map(inst => {
    // Find the matching first-parcel row by amount and similar memo
    const match = finalRows.find(r => {
      if (Math.abs(r.amount - inst.amount) > 0.01) return false;
      // Both should share the same base text (before the parcel number)
      const stripParcel = s => (s||'').replace(/\s*\d+\s*\/\s*\d+/g,'').replace(/\s*parcela\s*\d+/gi,'').trim().toLowerCase();
      return stripParcel(r.memo) === stripParcel(inst.memo) ||
             stripParcel(r.desc||r.memo) === stripParcel(inst.memo);
    });
    if (!match) return inst; // no match found, keep original

    // Build installment memo: take user memo, replace parcel fraction
    const userMemo = match.memo || inst.memo;
    const fracMatch = inst.memo.match(/(\d+)\s*\/\s*(\d+)/);
    let newMemo = userMemo;
    if (fracMatch) {
      // Replace "1/N" in user memo with "p/N"
      newMemo = userMemo.replace(/\d+\s*\/\s*\d+/, fracMatch[0]);
      // If user memo doesn't have a fraction, append it
      if (!newMemo.includes(fracMatch[0])) {
        newMemo = userMemo.replace(/\s+$/, '') + ' ' + fracMatch[0];
      }
    }
    return {
      ...inst,
      memo:     newMemo,
      category: match.category || inst.category || '',
    };
  });

  // Collect pat asset linkages from the table
  const patAssetInputs = G('bank-preview-body')?.querySelectorAll('.import-pat-asset-inp');
  const patTypeInputs  = G('bank-preview-body')?.querySelectorAll('.import-pat-type-inp');
  const patLinks = finalRows.map((r, i) => ({
    assetId:  parseInt(patAssetInputs?.[i]?.value || '0'),
    txType:   patTypeInputs?.[i]?.value || 'aluguel',
    month:    (r.dateISO || '').slice(0, 7),
    amount:   Math.abs(r.amount),
    memo:     r.memo || '',
  })).filter(p => p.assetId && p.month);

  // ── Round 2: memo+category duplicates (recurring placeholders with variable amount) ──
  try {
    const memoDupResult = await ff.bankCheckMemoDups({
      accountId,
      rows: finalRows.map(r => ({ dateISO: r.dateISO, memo: r.memo, category: r.category || '' })),
    });
    if (memoDupResult?.matches?.length > 0) {
      showMemoDupUI(memoDupResult.matches, finalRows, updatedInstallments, accountId, checkDailySaldo, patLinks);
      return; // user decides; finishMemoDupImport continues the flow
    }
  } catch(e) { /* on error, proceed without round-2 check */ }

  await finishImportWithPatLinks(finalRows, updatedInstallments, accountId, checkDailySaldo, patLinks);
}

// Shared tail of the import flow (called directly or after memo-dup resolution)
async function finishImportWithPatLinks(finalRows, updatedInstallments, accountId, checkDailySaldo, patLinks) {
  await doImport(finalRows, updatedInstallments, accountId, checkDailySaldo);

  for (const p of (patLinks || [])) {
    await ff.patTxSave({
      id: null, assetId: p.assetId, month: p.month,
      tx_type: p.txType, total_value: p.amount, notes: p.memo || null,
    }).catch(() => {});
  }
  if (patLinks?.length) {
    _pat.txAll = await ff.patTxAll().catch(() => _pat.txAll);
    if (currentPage === 'patrimonio') refreshPatrimonioTable();
  }
}

// ── Round-2 dup resolution UI: same memo+category, variable amount ──
function showMemoDupUI(matches, finalRows, updatedInstallments, accountId, checkDailySaldo, patLinks) {
  const dupMap = {};
  matches.forEach(m => { dupMap[m.rowIndex] = m.existing || []; });

  const preview = G('bank-preview');
  const fmtDate = iso => (iso || '').split('-').reverse().join('/');

  preview.innerHTML = `
    <div style="margin-bottom:10px">
      <div style="font-size:14px;font-weight:700;margin-bottom:4px">
        🔁 ${matches.length} lançamento(s) futuro(s) correspondente(s)
      </div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:10px">
        Estas linhas têm o <strong>mesmo memorando e categoria</strong> de lançamentos futuros já registrados
        (ex: recorrências com valor variável), com até 7 dias de diferença.
        <br><strong>🔄 Substituir</strong>: apaga o lançamento futuro e importa o valor real (recomendado)
        &nbsp;·&nbsp; <strong>✅ Manter ambos</strong> &nbsp;·&nbsp; <strong>🚫 Pular</strong>: mantém o futuro, descarta a importação.
      </div>

      <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:12px">
        <div style="display:grid;grid-template-columns:1fr 1fr 150px;background:var(--bg4);border-bottom:1px solid var(--border);font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase">
          <div style="padding:8px 10px;border-right:1px solid var(--border2)">🆕 Importando (valor real)</div>
          <div style="padding:8px 10px;border-right:1px solid var(--border2);background:#eff6ff">📅 Lançamento futuro existente</div>
          <div style="padding:8px 10px;text-align:center">Ação</div>
        </div>
        ${matches.map(m => {
          const r  = finalRows[m.rowIndex];
          const ex = m.existing[0];
          const amtCls = v => v < 0 ? 'color:#dc2626' : 'color:#16a34a';
          return `<div style="display:grid;grid-template-columns:1fr 1fr 150px;border-bottom:1px solid var(--border)">
            <div style="padding:7px 10px;border-right:1px solid var(--border2);font-size:12px">
              <div style="color:var(--text3);font-size:10px">${fmtDate(r.dateISO)}</div>
              <div style="font-weight:500">${esc(r.memo || '')}</div>
              <div style="${amtCls(r.amount)};font-family:'DM Mono',monospace">${fmtBRL(r.amount)}</div>
            </div>
            <div style="padding:7px 10px;border-right:1px solid var(--border2);font-size:12px;background:#f8fafc">
              <div style="color:var(--text3);font-size:10px">${fmtDate(ex.date)} · não conferido</div>
              <div style="color:#1d4ed8">${esc(ex.memo || '')}</div>
              <div style="${amtCls(ex.amount)};font-family:'DM Mono',monospace">${fmtBRL(ex.amount)}</div>
            </div>
            <div style="padding:6px 8px;display:flex;flex-direction:column;gap:3px;justify-content:center;font-size:11px">
              <label style="display:flex;align-items:center;gap:4px;cursor:pointer;color:#1d4ed8;font-weight:500">
                <input type="radio" name="mdup-${m.rowIndex}" value="replace" checked> 🔄 Substituir
              </label>
              <label style="display:flex;align-items:center;gap:4px;cursor:pointer;color:#16a34a">
                <input type="radio" name="mdup-${m.rowIndex}" value="both"> ✅ Manter ambos
              </label>
              <label style="display:flex;align-items:center;gap:4px;cursor:pointer;color:#dc2626">
                <input type="radio" name="mdup-${m.rowIndex}" value="skip"> 🚫 Pular
              </label>
            </div>
          </div>`;
        }).join('')}
      </div>

      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn primary" onclick="confirmMemoDupImport()">✓ Confirmar e importar</button>
        <button class="btn" onclick="cancelBankImport()">Cancelar</button>
      </div>
    </div>`;

  preview._memoDup = { matches, finalRows, updatedInstallments, accountId, checkDailySaldo, patLinks };
  preview.style.display = 'block';
  preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function confirmMemoDupImport() {
  const preview = G('bank-preview');
  const ctx = preview?._memoDup;
  if (!ctx) return;
  const { matches, finalRows, updatedInstallments, accountId, checkDailySaldo, patLinks } = ctx;

  const skipIdx = new Set();
  for (const m of matches) {
    const action = document.querySelector(`input[name="mdup-${m.rowIndex}"]:checked`)?.value || 'replace';
    if (action === 'replace') {
      // Delete the existing future placeholder(s), import the real one
      for (const ex of m.existing) {
        try { await ff.deleteTx(ex.id); } catch(e) {}
      }
    } else if (action === 'skip') {
      skipIdx.add(m.rowIndex);
    }
    // 'both': nothing to do — import alongside the placeholder
  }

  const rowsToImport = finalRows.filter((_, i) => !skipIdx.has(i));
  preview._memoDup = null;
  await finishImportWithPatLinks(rowsToImport, updatedInstallments, accountId, checkDailySaldo, patLinks);
}

async function doImport(finalRows, parcelInstallments, accountId, checkDailySaldo) {
  G('bank-result').innerHTML = '<div class="info-box">⏳ Importando…</div>';
  try {
    // Separate transfer rows from regular rows
    const transferRows = [];
    const regularRows  = [];
    for (const r of finalRows) {
      const tfMatch = (r.category||'').match(/^⇄ Transferência: (.+)$/);
      if (tfMatch) {
        const destName = tfMatch[1];
        const destAcc = accounts.find(a => a.name === destName);
        if (destAcc) {
          transferRows.push({ ...r, toAccountId: destAcc.id });
        } else {
          regularRows.push(r); // dest account not found, import as regular
        }
      } else {
        regularRows.push(r);
      }
    }

    // Create transfer pairs for transfer rows
    let transferCount = 0;
    for (const tr of transferRows) {
      try {
        await ff.transfer({
          fromAccountId: accountId,
          toAccountId:   tr.toAccountId,
          date:          tr.dateISO,
          amount:        Math.abs(tr.amount),
          memo:          tr.memo || 'Transferência importada',
        });
        transferCount++;
      } catch(e) { console.error('Transfer import error:', e); }
    }

    const rowsForBackend = regularRows.map(r => ({
      date: r.dateISO.split('-').reverse().join('/'), // backend expects DD/MM/YYYY
      amount: r.amount, memo: r.memo, category: r.category||'', saldo: r.saldo??null,
    }));
    const result = rowsForBackend.length > 0
      ? await ff.bankImport({ accountId, rows: rowsForBackend, checkDailySaldo, skipIds: [] })
      : { inserted: 0, skipped: 0 };
    if (transferCount > 0) {
      result.inserted = (result.inserted || 0); // transfers counted separately
    }

    if (result.needsConfirmation && result.potentialDups?.length > 0) {
      // Shouldn't happen (dups resolved before edit), but handle defensively
      toast(`⚠️ ${result.potentialDups.length} duplicata(s) ainda detectada(s) — verifique o resultado`);
    }

    // Future installments (memo/category already updated in doImportFromTable)
    let installCount = 0;
    for (const inst of (parcelInstallments||[])) {
      try {
        await ff.bankImport({ accountId,
          rows: [{ date: inst.date.split('-').reverse().join('/'),
                   amount: inst.amount,
                   memo: inst.memo || '',
                   category: inst.category || '' }],
          checkDailySaldo: false, skipIds: [] });
        installCount++;
      } catch(e) { /* skip */ }
    }

    // Learn from user's choices — keyword=original bank desc, memo=human memo, category
    for (const r of finalRows) {
      if (r.category || r.memo) {
        const keyword = r.desc || r.origDesc || r.memo || '';
        if (keyword) {
          try {
            await ff.mlLearn({
              desc:     keyword,
              memo:     r.memo || keyword,
              category: r.category || '',
              amount:   r.amount || 0,
            });
          } catch(e) { /* skip */ }
        }
      }
    }

    let msg = `✅ <strong>${(result.inserted||0) + transferCount} lançamentos importados</strong>${transferCount>0?` (${transferCount} transferência(s))`:''}`;
    if (installCount) msg += `<br>📅 ${installCount} parcelas futuras criadas.`;
    if (result.dailyMismatches?.length) msg += `<br>⚠️ Divergências de saldo em ${result.dailyMismatches.length} dia(s).`;
    G('bank-result').innerHTML = `<div class="info-box" style="line-height:1.8">${msg}</div>`;
    cancelBankImport();
    await loadAccounts();
    if (currentPage === 'account') refreshAccount();
    toast(`${(result.inserted||0)+transferCount} lançamentos importados${installCount?` + ${installCount} parcelas`:''}${transferCount?` (${transferCount} transferência(s))`:''}`);    _pendingImport = null;
  } catch(e) {
    G('bank-result').innerHTML = `<div class="warn-box">❌ Erro: ${esc(e.message)}</div>`;
  }
}

function showDupResolutionUI(potentialDups, finalRows, parcelInstallments, accountId, checkDailySaldo) {
  // Build a map: rowIndex → existing records from DB
  const dupMap = {};
  potentialDups.forEach(d => { dupMap[d.rowIndex] = d.existing || []; });

  const preview = G('bank-preview');

  // Replace the entire preview content with a custom dup-resolution panel
  preview.innerHTML = `
    <div style="margin-bottom:10px">
      <div style="font-size:14px;font-weight:700;margin-bottom:4px">
        ⚠️ ${potentialDups.length} possível(is) duplicata(s) encontrada(s)
      </div>
      <div style="font-size:12px;color:var(--text2);margin-bottom:10px">
        Para cada linha marcada em amarelo, o Cruzeiro encontrou um lançamento existente com mesma data e valor.
        <br><strong>✅ Marque "Importar" para inserir</strong> mesmo assim &nbsp;·&nbsp; <strong>🚫 Marque "Pular"</strong> para descartar (é uma duplicata de fato).
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0;border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:12px">
        <!-- Header -->
        <div style="display:grid;grid-template-columns:36px 1fr 1fr auto;background:var(--bg4);border-bottom:1px solid var(--border);font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;padding:0;grid-column:1/-1">
          <div style="padding:8px;border-right:1px solid var(--border)"></div>
          <div style="padding:8px 10px;border-right:1px solid var(--border2);background:var(--bg4)">🆕 Registro novo (do arquivo)</div>
          <div style="padding:8px 10px;background:#fffbeb">⚠️ Já existe no banco</div>
          <div style="padding:8px 10px;min-width:120px;text-align:center">Ação</div>
        </div>
        <!-- Rows -->
        <div id="dup-rows-container" style="grid-column:1/-1">
        ${finalRows.map((r, i) => {
          const exList = dupMap[i];
          const isDup  = !!exList;
          const amtCls = r.amount < 0 ? 'color:#dc2626' : 'color:#16a34a';
          const amtStr = fmtBRL(r.amount);
          const exStr  = exList?.map(e => `"${esc(e.memo)}"`).join(', ') || '';
          const rowBg  = isDup ? 'background:#fffbeb' : '';
          return `<div style="display:grid;grid-template-columns:36px 1fr 1fr auto;border-bottom:1px solid var(--border);${rowBg}" data-idx="${i}">
            <!-- Checkbox column -->
            <div style="padding:8px 6px;display:flex;align-items:center;border-right:1px solid var(--border)">
              <input type="checkbox" class="dup-select" data-idx="${i}" ${!isDup?'checked disabled style="opacity:0.3"':'checked'}>
            </div>
            <!-- New record -->
            <div style="padding:7px 10px;border-right:1px solid var(--border2);font-size:12px">
              <div style="color:var(--text3);font-size:10px">${r.dateISO}</div>
              <div style="font-weight:500">${esc(r.memo||r.desc||'')}</div>
              <div style="${amtCls};font-family:'DM Mono',monospace;font-size:12px">${amtStr}</div>
            </div>
            <!-- Existing record -->
            <div style="padding:7px 10px;font-size:12px;${isDup?'':'color:var(--text3)'}">
              ${isDup
                ? `<div style="color:var(--text3);font-size:10px">${r.dateISO} · mesmo valor</div>
                   <div style="color:#b45309">${exStr}</div>
                   <div style="color:#b45309;font-family:'DM Mono',monospace;font-size:12px">${amtStr}</div>`
                : '<span style="font-size:11px">—</span>'}
            </div>
            <!-- Action toggle -->
            <div style="padding:6px 8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-width:120px">
              ${isDup ? `
                <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;color:#16a34a;font-weight:500">
                  <input type="radio" name="dup-action-${i}" value="import" class="dup-action" data-idx="${i}"> ✅ Importar
                </label>
                <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;color:#dc2626;font-weight:500">
                  <input type="radio" name="dup-action-${i}" value="skip" class="dup-action" data-idx="${i}" checked> 🚫 Pular
                </label>` : ''}
            </div>
          </div>`;
        }).join('')}
        </div>
      </div>

      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn primary" onclick="confirmDupAndImport()">✓ Confirmar e importar</button>
        <button class="btn" onclick="cancelBankImport()">Cancelar</button>
        <span style="font-size:12px;color:var(--text3)">
          ${potentialDups.length} duplicata(s) · por padrão marcadas para <strong>Pular</strong>
        </span>
      </div>
    </div>`;

  preview._dup = { finalRows, parcelInstallments, accountId, checkDailySaldo, dupMap };
  preview.style.display = 'block';
  G('bank-result').innerHTML = '';
}

async function confirmDupAndImport() {
  const preview = G('bank-preview');
  const { finalRows, parcelInstallments, accountId, checkDailySaldo, dupMap } = preview._dup || {};
  if (!finalRows) return;

  // Build list of rows to keep: non-dups always included, dups only if "import" radio selected
  const selectedRows = finalRows.filter((r, i) => {
    if (!dupMap[i]) return true; // not a dup — always keep
    const radios = preview.querySelectorAll(`input[name="dup-action-${i}"]`);
    const action = [...radios].find(rb => rb.checked)?.value;
    return action === 'import';
  });

  // Update pending import with only the selected (non-discarded) rows
  _pendingImport = { rows: selectedRows, parcelInstallments, accountId, checkDailySaldo };

  // renderImportEditTable rebuilds preview.innerHTML from scratch — no need to clear first
  renderImportEditTable(selectedRows);
}

// ── Global date/value parsing helpers (used by all parsers) ──
function pDate(v) {
  if (!v && v !== 0) return null;
  if (v instanceof Date) return v.toISOString().slice(0,10);
  const s = String(v).trim();
  // DD/MM/YYYY or DD/MM/YY
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m1) {
    const [,d,mo,y] = m1;
    const yr = y.length===2 ? (parseInt(y)<50?'20':'19')+y : y;
    return `${yr}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  // YYYY-MM-DD
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return s.slice(0,10);
  // Excel serial number
  if (/^\d+(\.\d+)?$/.test(s)) {
    const serial = parseFloat(s);
    if (serial > 40000 && serial < 60000) {
      const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
      return d.toISOString().slice(0,10);
    }
  }
  return null;
}
function pVal(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/R\$\s*/g,'').trim();
  // Parentheses = negative: (1.234,56) → -1234.56
  const isNeg = s.startsWith('(') && s.endsWith(')');
  s = s.replace(/[()]/g,'').trim();
  // Handle Brazilian format: 1.234,56
  let n;
  if (/^-?[\d.]+,[\d]{2}$/.test(s)) n = parseFloat(s.replace(/\./g,'').replace(',','.'));
  else n = parseFloat(s.replace(',','.')) || 0;
  return isNeg ? -Math.abs(n) : n;
}
function pDateBTG(v) {
  if (typeof v === 'number' && v > 40000) {
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toISOString().slice(0,10);
  }
  return pDate(v);
}
function toISOClient(dmy) {
  if (!dmy) return null;
  const s = String(dmy).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const [,d,mo,y] = m;
  const yr = y.length===2 ? (parseInt(y)<50?'20':'19')+y : y;
  return `${yr}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

// ── Built-in bank parsers ──
function parseBankItau(buffer) {
  const wb = XLSX.read(buffer, { type:'array', cellDates:true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:'', raw:true });
  const res = [];
  let hdr = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].map(c => norm(String(c)));
    if (r.some(c => c === 'data') && r.some(c => c.includes('lancamento') || c.includes('historico') || c.includes('descri'))) { hdr = i; break; }
  }
  if (hdr < 0) hdr = 8;
  const headers = rows[hdr].map(c => norm(String(c)));
  const di = headers.findIndex(h => h === 'data' || h.startsWith('data'));
  const li = headers.findIndex(h => h.includes('lancamento') || h.includes('lancamentos') || h.includes('historico') || h.includes('descri') || h.includes('memo'));
  const vi = headers.findIndex(h => h.includes('valor') && !h.includes('saldo'));
  const si = headers.findIndex(h => h.includes('saldo'));
  if (di < 0 || li < 0 || vi < 0) return []; // couldn't identify columns
  const SKIP = ['saldo total','saldo anterior','lancamentos futuros','saidas futuras','saldo inicial','limite'];
  for (let i = hdr + 1; i < rows.length; i++) {
    const row = rows[i];
    const rawDesc = String(row[li] || '').trim();
    if (!rawDesc) continue;
    const nd = norm(rawDesc);
    if (SKIP.some(s => nd.includes(s))) continue;
    const date = pDate(row[di]);
    if (!date) continue;
    const amount = pVal(row[vi]);
    const saldo  = si >= 0 ? pVal(row[si]) : null;
    res.push({ date, desc: rawDesc, memo: rawDesc, amount, saldo, category: '' });
  }
  return res;
}

function parseBankXP(buffer) {
  // Try UTF-8 first, fall back to latin1 (XP sometimes exports latin1)
  let text;
  try { text = new TextDecoder('utf-8').decode(buffer).replace(/^\uFEFF/, ''); }
  catch(e) { text = new TextDecoder('latin1').decode(buffer); }

  // Auto-detect delimiter: ; or ,
  const firstLine = text.split(/\r?\n/)[0] || '';
  const sep = (firstLine.split(';').length >= firstLine.split(',').length) ? ';' : ',';
  const rows = text.split(/\r?\n/).filter(l => l.trim()).map(l => l.split(sep));

  // Detect header row and column positions
  let hdrIdx = 0;
  let dateCol = 0, descCol = 1, valCol = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const r = rows[i].map(c => norm(String(c)));
    const di = r.findIndex(c => c === 'data' || c.startsWith('data'));
    const li = r.findIndex(c => c.includes('lancamento') || c.includes('descri') || c.includes('historico'));
    const vi = r.findIndex(c => c.includes('valor') || c.includes('montante'));
    if (di >= 0 && li >= 0 && vi >= 0) {
      hdrIdx = i + 1; dateCol = di; descCol = li; valCol = vi; break;
    }
  }
  if (valCol < 0) {
    // Fallback: assume col 3 for value (original behavior)
    valCol = 3;
  }

  const res = [];
  const SKIP = ['pagamentos validos', 'pagamento valido', 'total', 'saldo'];
  for (let i = hdrIdx; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < Math.max(dateCol, descCol, valCol) + 1) continue;
    const rawDate = String(row[dateCol]||'').trim();
    const rawDesc = String(row[descCol]||'').trim();
    const rawVal  = String(row[valCol]||'').trim();
    if (!rawDate || !rawDesc) continue;
    if (SKIP.some(s => norm(rawDesc).startsWith(s))) continue;
    const date = pDate(rawDate);
    if (!date) continue;
    const num = pVal(rawVal);
    if (num === 0 && !rawVal) continue;
    // XP: positive = despesa (saída), invert to negative for Cruzeiro
    res.push({ date, desc: rawDesc, memo: rawDesc, amount: -num, saldo: null, category: '' });
  }
  return res;
}

function parseBankBTG(buffer) {
  const wb = XLSX.read(buffer, { type:'array', cellDates:false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:'', raw:true });
  const res = [];
  // Find all header rows (BTG files can have multiple sections)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const r0 = norm(String(row[0]||'')), r1 = norm(String(row[1]||''));
    const r3 = norm(String(row[3]||'')), r2 = norm(String(row[2]||''));
    const isHeader = r0 === 'data' &&
      (r1.includes('descri') || r1.includes('lancamento') || r1.includes('historico')) &&
      (r3.includes('valor') || r2.includes('valor'));
    const valCol = r3.includes('valor') ? 3 : r2.includes('valor') ? 2 : 3;
    if (isHeader) {
      i++;
      while (i < rows.length) {
        const r = rows[i];
        const dateVal = r[0], descVal = String(r[1]||'').trim();
        const valVal = r[valCol];
        // Stop at next section header or empty block
        const rn0 = norm(String(dateVal||''));
        if (rn0 === 'data') { i--; break; } // new header section
        if ((dateVal === null || dateVal === undefined || dateVal === '') && !descVal) { i++; continue; }
        const date = pDateBTG(dateVal) || pDate(String(dateVal||'').trim());
        if (!date || !descVal) { i++; continue; }
        const rawVal = typeof valVal === 'number' ? valVal : pVal(String(valVal||''));
        // BTG: positive in file = despesa, invert
        res.push({ date, desc: descVal, memo: descVal, amount: -rawVal, saldo: null, category: '' });
        i++;
      }
    }
  }
  return res;
}

function parseBankItauCard(buffer) {
  // Itaú fatura XLS: header on row 24 (index 23), date col A(0), desc col B(1), value col D(3)
  // Values are positive = despesa → invert to negative
  const wb = XLSX.read(buffer, { type:'array', cellDates:true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:'', raw:true });
  const res = [];
  let hdr = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i].map(c => norm(String(c)));
    if (r[0] === 'data' && (r[1].includes('lancamento') || r[1].includes('descri'))) { hdr = i; break; }
  }
  if (hdr < 0) hdr = 23; // fallback to row 24 (0-indexed 23)
  const SKIP_NORMS = ['total', 'encargos', 'nao existem', 'limite', 'juros', 'retirada', 'pagamento efetuado', 'emitido em'];
  for (let i = hdr + 1; i < rows.length; i++) {
    const row = rows[i];
    const rawDesc = String(row[1] || '').trim();
    if (!rawDesc) continue;
    const nd = norm(rawDesc);
    if (SKIP_NORMS.some(s => nd.startsWith(s))) continue;
    const rawDate = row[0];
    const date = pDate(rawDate);
    if (!date) continue;
    const rawVal = row[3];
    if (rawVal == null || rawVal === '') continue;
    const amount = -(typeof rawVal === 'number' ? rawVal : pVal(rawVal)); // invert: positive in file = despesa
    res.push({ date, desc: rawDesc, memo: rawDesc, amount, saldo: null, category: '' });
  }
  return res;
}

// ══ BROKER (CORRETORA) PARSERS ══

const BUILTIN_BROKERS = [
  { id:'btg_broker', type:'broker', name:'BTG Pactual', fileType:'XLSX',
    logoUrl:'', logoBg:'#003B71', logoFallback:'BT' },
  { id:'xp_broker',  type:'broker', name:'XP Investimentos', fileType:'XLSX (2 arquivos)',
    logoUrl:'', logoBg:'#111111', logoFallback:'XP' },
];

let _customBrokerParsers = [];

async function initBrokerDropdown() {
  const all = await ff.bankParsersList();
  const ovEntry = all.find(p => p.id === '__builtin_overrides__');
  // Merge overrides (don't overwrite if initImportPage already loaded them)
  if (ovEntry?.data) Object.assign(_builtinOverrides, ovEntry.data);
  _customBrokerParsers = all.filter(p => p.type === 'broker' && p.id !== '__builtin_overrides__');
  renderBrokerDropdown();
}

function renderBrokerDropdown() {
  const builtin = G('import-dd-broker-builtin');
  if (builtin) builtin.innerHTML = BUILTIN_BROKERS.map(p => {
    const ov = _builtinOverrides[p.id] || {};
    return ddItemHtml({ ...p, name: ov.name||p.name, logoUrl: ov.logoUrl||p.logoUrl, sort_order: ov.sort_order??p.sort_order }, 'broker', true);
  }).sort((a,b) => 0).join(''); // already sorted by getBuiltinDefs logic

  const custom = G('import-dd-broker-custom');
  if (custom) custom.innerHTML = _customBrokerParsers.map(p =>
    ddItemHtml({...p, fileType: p.config?.fileType}, 'broker', false)).join('');
}

function toggleBrokerDropdown() {
  const dd = G('import-dd-broker');
  if (!dd) return;
  const isOpen = dd.style.display !== 'none';
  // Close all import dropdowns
  ['bank','card','broker'].forEach(t => {
    const d = G(`import-dd-${t}`); if (d) d.style.display = 'none';
    const a = G(`import-dd-${t}-arrow`); if (a) a.textContent = '▾';
  });
  if (!isOpen) {
    const btn = G('import-dd-broker-wrap')?.querySelector('button');
    if (btn) {
      const rect = btn.getBoundingClientRect();
      dd.style.top  = (rect.bottom + 4) + 'px';
      dd.style.left = rect.left + 'px';
    }
    dd.style.display = 'block';
    const ar = G('import-dd-broker-arrow'); if (ar) ar.textContent = '▴';
  }
}

// Close broker dropdown on outside click (extend existing listener)
document.addEventListener('click', e => {
  if (!e.target.closest('#import-dd-broker-wrap')) {
    const dd = G('import-dd-broker'); if (dd) dd.style.display = 'none';
    const ar = G('import-dd-broker-arrow'); if (ar) ar.textContent = '▾';
  }
});

let _brokerBuffer = null;
let _selectedBroker = null;

async function pickBroker(brokerId) {
  try {
    // Close all dropdowns
    ['bank','card','broker'].forEach(t => {
      const d = G(`import-dd-${t}`); if (d) d.style.display = 'none';
      const a = G(`import-dd-${t}-arrow`); if (a) a.textContent = '▾';
    });

    if (brokerId === 'outra_corretora') {
      openCustomParserWizard('broker');
      return;
    }

    _selectedBroker = brokerId;
    _xpBuffers = {}; // reset XP two-file state

    const def = BUILTIN_BROKERS.find(b => b.id === brokerId)
             || (_customBrokerParsers||[]).find(p => p.id === brokerId);
    const name = def?.name || brokerId;

    // Show broker section FIRST before anything else
    const bs = G('broker-section');
    if (bs) bs.style.display = '';

    // Hide bank/card fields
    const bankFieldRow = G('bank-account')?.closest('.field-row');
    if (bankFieldRow) bankFieldRow.style.display = 'none';
    if (G('bank-file-trigger')) G('bank-file-trigger').style.display = 'none';
    if (G('bank-selected-label')) G('bank-selected-label').innerHTML = '';
    if (G('btg-warn')) G('btg-warn').style.display = 'none';
    cancelBankImport();

    // Update broker label
    const lbl = G('broker-selected-label');
    if (lbl) {
      const logo = def ? bankLogoHtml(def, 18) : '';
      lbl.innerHTML = `<span style="display:flex;align-items:center;gap:8px">Selecionado: ${logo} <strong>${esc(name)}</strong></span>`;
    }

    // Show file trigger
    if (G('broker-file-trigger')) G('broker-file-trigger').style.display = 'flex';
    if (G('broker-result')) G('broker-result').innerHTML = '';
    if (G('broker-preview')) G('broker-preview').style.display = 'none';
    if (G('broker-file-name')) G('broker-file-name').textContent = '';

    // Load existing inv_assets for name mapping
    await loadInvAssetsList();

    // Restore preferred account for this broker
    try {
      const pref = await ff.brokerAccountPrefGet({ broker: brokerId });
      const sel = G('broker-account');
      if (sel && pref) sel.value = String(pref);
    } catch(e) {}

    // XP hint
    if (brokerId === 'xp_broker' && G('broker-result')) {
      G('broker-result').innerHTML = '<div class="info-box" style="font-size:12px">📁 XP requer dois arquivos. Selecione primeiro <strong>qualquer um</strong> dos dois (Extrato ou PosicaoDetalhadaHistorica).</div>';
    }
  } catch(e) {
    console.error('pickBroker error:', e);
    toast('Erro ao selecionar corretora: ' + e.message);
  }
}

function triggerBrokerFile() {
  G('broker-file-input').click();
}

async function onBrokerFileSelected(event) {
  const file = event.target.files[0];
  if (!file) return;
  G('broker-file-name').textContent = file.name;

  if (typeof XLSX === 'undefined') {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
  }

  _brokerBuffer = await file.arrayBuffer();

  try {
    let parsed;
    if (_selectedBroker === 'btg_broker') {
      G('broker-result').innerHTML = '<div class="info-box">⏳ Lendo extrato…</div>';
      parsed = parseBTGBroker(_brokerBuffer);
    } else if (_selectedBroker === 'xp_broker') {
      // XP needs two files — showXPBrokerWizard handles display and parsing
      G('broker-result').innerHTML = '';
      showXPBrokerWizard(_brokerBuffer, file.name);
      return;
    } else {
      const custom = _customBrokerParsers.find(p => p.id === _selectedBroker);
      if (custom) parsed = parseCustomBroker(_brokerBuffer, custom.config);
      else throw new Error('Corretora não reconhecida');
    }

    G('broker-result').innerHTML = '';
    renderBrokerPreview(parsed);
  } catch(e) {
    G('broker-result').innerHTML = `<div class="warn-box">❌ Erro ao ler o extrato: ${esc(e.message)}</div>`;
    console.error(e);
  }
  event.target.value = '';
}

function parseBTGBroker(buffer) {
  const wb = XLSX.read(buffer, { type:'array', cellDates:true });

  // ── 1. Month from Capa ──
  let month = null;
  const capa = wb.Sheets['Capa'];
  if (capa) {
    const capaRows = XLSX.utils.sheet_to_json(capa, { header:1, defval:'', raw:false });
    for (const row of capaRows) {
      for (const cell of row) {
        const m = String(cell).match(/Período de \d{2}\/\d{2}\/\d{2,4} a \d{2}\/(\d{2})\/(\d{2,4})/);
        if (m) { const y = m[2].length===2?'20'+m[2]:m[2]; month=`${y}-${m[1].padStart(2,'0')}`; break; }
      }
      if (month) break;
    }
  }
  if (!month) throw new Error('Não foi possível identificar o mês do extrato na aba Capa.');

  const result = { month, assets: [], caixaValue: null, broker: 'BTG' };

  // ── Flow-type classifier ──
  // Returns: 'external' | 'income' | 'ignore' | null
  function classifyBTGFlow(desc) {
    const d = norm(String(desc || ''));
    // Ignore terms
    if (d.includes('come cota') || d.includes('come-cota')) return 'ignore';
    if (d.includes('deposito de cota') || d.includes('depósito de cota')) return 'ignore';
    if (d.includes('retirada de cota')) return 'external'; // explicit per user spec
    // External capital flows (compra/venda/aporte/resgate)
    const externalTerms = [
      'resgate','aplicacao','aporte','compra','contribuicao','venda','amortizacao',
    ];
    for (const t of externalTerms) { if (d.includes(t)) return 'external'; }
    // Income flows (rendimento/juros/cupom)
    const incomeTerms = ['juros', 'rendimento', 'cupom', 'dividend', 'provent',
      'juros s/capital', 'jcp', 'recebimento'];
    for (const t of incomeTerms) { if (d.includes(t)) return 'income'; }
    return null; // unknown — use sign fallback
  }
  const isDate = v => v instanceof Date || (typeof v==='string' && /^\d{4}-\d{2}-\d{2}/.test(v));
  const toMonth = v => {
    if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,'0')}`;
    const m = String(v).match(/^(\d{4})-(\d{2})/);
    return m ? `${m[1]}-${m[2]}` : null;
  };
  const toISOMonth = v => {
    if (!v) return null;
    if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,'0')}`;
    const s = String(v);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}`;
    return null;
  };
  const toNum = v => { if (typeof v==='number') return v; const n=parseFloat(String(v||'').replace(/[^\d.,-]/g,'').replace(',','.')); return isNaN(n)?null:n; };

  // ── 2. Fundos ──
  const fundosWs = wb.Sheets['Fundos'];
  if (fundosWs) {
    const rows = XLSX.utils.sheet_to_json(fundosWs, { header:1, defval:null, raw:true });
    // Posições section ends at "Total em fundos"
    const posEndIdx = rows.findIndex(r => norm(String(r[1]||'')).startsWith('total em fund'));

    let currentName = null;
    for (let i=0; i<(posEndIdx>0?posEndIdx:rows.length); i++) {
      const colB = rows[i][1];
      const colI = rows[i][8]; // Saldo Líquido col I = index 8
      if (!colB) continue;
      const nb = norm(String(colB));
      if (nb.startsWith('total') || nb.startsWith('data ref') || nb.startsWith('fundo') ||
          nb.startsWith('detalhamento') || nb.startsWith('posicao') || nb.startsWith('rentabilidade')) continue;
      // Asset row: string in colB that is NOT a date
      if (typeof colB==='string' && !isDate(colB)) {
        currentName = colB.trim();
      } else if (currentName && isDate(colB) && typeof colI==='number') {
        // Value row: date in colB, saldo líquido in colI
        if (!result.assets.find(a => a.name===currentName)) {
          result.assets.push({ name:currentName, category:'fundos', inv_type:'Fundo', broker:'BTG', valor:colI, movimentacoes:[] });
        }
        currentName = null;
      }
    }

    // Movimentações — only non-come-cotas
    const movStartIdx = rows.findIndex(r => norm(String(r[1]||'')).startsWith('movimenta'));
    if (movStartIdx >= 0) {
      let mvAsset = null;
      for (let i=movStartIdx+1; i<rows.length; i++) {
        const colB = rows[i][1], colC = rows[i][2], colI = rows[i][8];
        const nb = norm(String(colB||''));
        if (nb.startsWith('movimenta') && String(colB).includes('>')) {
          // Extract asset name after "Movimentação > "
          mvAsset = String(colB).split('>').pop().trim();
        } else if (mvAsset && isDate(colB) && typeof colI==='number' && colI!==0) {
          const txDesc = String(colC||'');
          const flowType = classifyBTGFlow(txDesc);
          if (flowType === 'ignore') continue;
          const target = result.assets.find(a => norm(a.name).startsWith(norm(mvAsset).slice(0,15)));
          if (target) {
            // Fundos: col I is always the value (positive). Direction from flow_type.
            // External outflow (resgate = money back to investor = positive)
            // External inflow (aplicação/aporte = money leaving investor = negative)
            let amount;
            if (flowType === 'external') {
              const isOutflow = norm(txDesc).includes('resgate') || norm(txDesc).includes('venda');
              amount = isOutflow ? colI : -colI;
            } else if (flowType === 'income') {
              amount = colI; // income always positive
            } else {
              // fallback: resgates are positive (inflow to investor)
              const isResgate = norm(txDesc).includes('resgate');
              amount = isResgate ? colI : -colI;
            }
            target.movimentacoes.push({ amount, type: txDesc, flow_type: flowType || 'external' });
          }
        }
      }
    }
  }

  // ── 3. Renda Fixa ──
  const rfWs = wb.Sheets['Renda Fixa'];
  if (rfWs) {
    const rows = XLSX.utils.sheet_to_json(rfWs, { header:1, defval:null, raw:true });
    // Only parse Posições section (before "Posições Detalhadas")
    const posDetIdx = rows.findIndex(r => norm(String(r[1]||'')).startsWith('posicoes detalha'));
    const posRows = posDetIdx > 0 ? rows.slice(0, posDetIdx) : rows;

    let currentType = '';
    const SKIP_RF = ['total','emissor','ativo','posicoes','detalhamento','movimenta','rentabilidade'];
    for (const row of posRows) {
      const colB = row[1]; // Emissor
      const colC = row[2]; // Ativo (código)
      const colD = row[3]; // Emissão date
      const colE = row[4]; // Vencimento date
      const colF = row[5]; // Liquidez (Sim/Não)
      const colG = row[6]; // Dias carência
      const colO = row[14]; // Saldo Líquido

      const nb = norm(String(colB||''));
      // Section header "Posição > CDB" etc
      if (nb.startsWith('posicao') && String(colB||'').includes('>')) {
        currentType = String(colB).split('>').pop().trim().replace(/TESOURO DIRETO - /i,'');
        continue;
      }
      if (SKIP_RF.some(s => nb.startsWith(s))) continue;
      if (!colB || !colC) continue;

      const saldo = toNum(colO);
      if (saldo == null) continue;

      const code = String(colC).trim();
      const vencISO = toISOMonth(colE);
      const liqRaw = norm(String(colF||''));
      const liquidity = liqRaw === 'sim' ? 'dias' : 'vencimento';
      const liqDays = liqRaw === 'sim' ? (parseInt(colG)||null) : null;

      result.assets.push({
        name: code, code, category: 'renda_fixa', inv_type: currentType,
        broker: 'BTG', maturity_month: vencISO,
        liquidity, liquidity_days: liqDays, valor: saldo, movimentacoes: [],
      });
    }

    // Movimentações Renda Fixa
    // Section at end of file (after Posições Detalhadas)
    // Cols: B=date(1), C="Emissor / Ativo"(2) e.g. "EDIFICATTO / CRI-25E0002401", D=tipo(3), J=valor líquido(9)
    const movRfIdx = rows.findIndex((r,i) => i > 50 && norm(String(r[1]||'')).startsWith('movimenta'));
    if (movRfIdx >= 0) {
      for (let i=movRfIdx+1; i<rows.length; i++) {
        const row = rows[i];
        const colB=row[1], colC=row[2], colD=row[3], colJ=row[9];
        if (!isDate(colB)) continue;
        const descN = norm(String(colD||''));
        if (descN.includes('come') || descN.startsWith('total')) continue;
        // Extract asset code from "Emissor / CODE" format
        const emAsset = String(colC||'');
        const codePart = emAsset.includes('/') ? emAsset.split('/').pop().trim() : emAsset.trim();
        const target = result.assets.find(a => a.code===codePart || norm(a.name).includes(norm(codePart)));
        if (!target) continue;
        const valJ = typeof colJ==='number' ? colJ : (colJ==='-'?null:toNum(colJ));
        if (!valJ) continue;
        const flowType = classifyBTGFlow(String(colD||''));
        if (flowType === 'ignore') continue;
        // Renda Fixa: juros/cupom = income (positive); compra/amortização = external
        let amount;
        if (flowType === 'income') {
          amount = valJ; // income is positive
        } else if (flowType === 'external') {
          // compra = negative (money out), venda/resgate/amort = positive (money in)
          const isOut = norm(String(colD||'')).includes('compra') || norm(String(colD||'')).includes('aplicacao') || norm(String(colD||'')).includes('aporte');
          amount = isOut ? -valJ : valJ;
        } else {
          const isEntrada = descN.includes('juros') || descN.includes('amort') || descN.includes('resgate') || descN.includes('vencimento') || descN.includes('rendimento');
          amount = isEntrada ? valJ : -valJ;
        }
        target.movimentacoes.push({ amount, type: String(colD||''), flow_type: flowType || 'external' });
      }
    }
  }

  // ── 4. Previdência ──
  const prevWs = wb.Sheets['Previdência Individual'];
  if (prevWs) {
    const rows = XLSX.utils.sheet_to_json(prevWs, { header:1, defval:null, raw:true });
    const SKIP_P = ['total','n° cert','n cert','fundo','produto','plano','posicao','rentabilidade',
      'posicoes abertas','aliquota','regime','data de inicio','None'];
    let inPosicao = false;
    for (const row of rows) {
      const colB = row[1]; // Fundo name
      const colC = row[2]; // CNPJ
      const colG = row[6]; // Saldo Bruto
      const nb = norm(String(colB||''));
      if (nb.startsWith('posicao')) { inPosicao = true; continue; }
      if (nb.startsWith('rentabilidade') || nb.startsWith('posicoes abertas')) { inPosicao = false; continue; }
      if (!inPosicao) continue;
      if (SKIP_P.some(s => nb.startsWith(s))) continue;
      if (!colB || typeof colG!=='number') continue;
      const cnpj = String(colC||'').trim();
      result.assets.push({
        name: String(colB).trim(), category: 'previdencia',
        inv_type: 'PGBL', broker: 'BTG', valor: colG, movimentacoes: [],
        notes: cnpj ? `CNPJ: ${cnpj}` : undefined,
      });
    }

    // Movimentações Previdência
    // Header: Data(B), Transação(C), Qtde(D), Valor Cota(E), Valor Bruto(F), IR(G), Valor Líquido(H)
    const movPrevIdx = rows.findIndex(r => norm(String(r[1]||'')).startsWith('movimenta'));
    if (movPrevIdx >= 0) {
      let mvPlan = null;
      for (let i=movPrevIdx+1; i<rows.length; i++) {
        const row = rows[i];
        const colB=row[1], colC=row[2], colH=row[7];
        const nb = norm(String(colB||''));
        // Sub-section header e.g. "Movimentação > 342074/ACS..."
        if (nb.startsWith('movimenta') && String(colB).includes('>')) { mvPlan = String(colB); continue; }
        if (!isDate(colB)) continue;
        const txDesc = String(colC||'');
        const flowType = classifyBTGFlow(txDesc);
        if (flowType === 'ignore') continue;
        const val = typeof colH==='number' ? colH : toNum(colH);
        if (!val) continue;
        // Contribuição = capital outflow (money leaving investor)
        const isOut = norm(txDesc).includes('contribui') || norm(txDesc).includes('aplicacao') || norm(txDesc).includes('aporte');
        const amount = isOut ? -val : val;
        const prevAssets = result.assets.filter(a => a.category === 'previdencia');
        prevAssets.forEach(a => a.movimentacoes.push({ amount, type: txDesc, flow_type: flowType || 'external' }));
      }
    }
  }

  // ── 5. Renda Variável ──
  const rvWs = wb.Sheets['Renda Variavel'];
  if (rvWs) {
    const rows = XLSX.utils.sheet_to_json(rvWs, { header:1, defval:null, raw:true });
    let currentSubType = 'ETF';
    const SKIP_RV = ['total','codigo','posicao','movimenta','tipo','data','None'];
    const movStartRV = rows.findIndex(r => norm(String(r[1]||'')).startsWith('movimenta'));

    let saldoBrutoCol = 6; // default for ETF
    for (let i=0; i<(movStartRV>0?movStartRV:rows.length); i++) {
      const row = rows[i];
      const colB=row[1], colC=row[2], colD=row[3];
      const nb = norm(String(colB||''));

      // Section header
      if (nb.startsWith('posicao') && String(colB).includes('>')) {
        const sec = norm(String(colB).split('>').pop());
        if (sec.includes('etf')) currentSubType = 'ETF';
        else if (sec.includes('listado') || sec.includes('fii')) currentSubType = 'FII';
        else if (sec.includes('acoes') || sec.includes('acao')) currentSubType = 'Ações';
        continue;
      }

      // Header row: find "Saldo Bruto" column dynamically
      if (nb === 'codigo') {
        saldoBrutoCol = row.findIndex((v,idx) => idx>0 && norm(String(v||'')).startsWith('saldo bruto'));
        if (saldoBrutoCol < 0) saldoBrutoCol = 6;
        continue;
      }

      if (SKIP_RV.some(s => nb.startsWith(s))) continue;

      const code = String(colB||'').trim();
      const name = String(colC||code).trim();
      const saldo = typeof row[saldoBrutoCol]==='number' ? row[saldoBrutoCol] : null;
      if (!code || code.length < 4 || code.length > 8 || saldo == null || saldo <= 0) continue;
      if (norm(code).startsWith('total')) continue;

      result.assets.push({
        name, code, category: 'renda_variavel', inv_type: currentSubType,
        broker: 'BTG', valor: saldo, movimentacoes: [],
      });
    }

    // Movimentações RV
    if (movStartRV >= 0) {
      for (let i=movStartRV+1; i<rows.length; i++) {
        const row=rows[i];
        const colB=row[1], colC=row[2], colD=row[3], colJ=row[9];
        if (!isDate(colB)) continue;
        if (!colD || typeof colJ!=='number' || colJ===0) continue;
        const descN = norm(String(colC||''));
        if (descN.includes('come')) continue;
        const code = String(colD||'').trim();
        const target = result.assets.find(a => a.code===code);
        if (!target) continue;
        const flowType = classifyBTGFlow(String(colC||''));
        if (flowType === 'ignore') continue;
        // RV: RENDIMENTO/DIVIDENDOS/PROVENTOS = income; COMPRA/VENDA = external
        let amount;
        if (flowType === 'income') {
          amount = colJ; // income positive
        } else if (flowType === 'external') {
          const isOut = norm(String(colC||'')).includes('compra') || norm(String(colC||'')).includes('subscri') || norm(String(colC||'')).includes('aporte');
          amount = isOut ? -colJ : colJ;
        } else {
          const isEntrada = descN.includes('rendimento') || descN.includes('dividend') || descN.includes('provent') || descN.includes('amort');
          amount = isEntrada ? colJ : -colJ;
        }
        target.movimentacoes.push({ amount, type: String(colC||''), flow_type: flowType || 'income' });
      }
    }
  }

  // ── 6. Conta Corrente ──
  const ccWs = wb.Sheets['Conta Corrente'];
  if (ccWs) {
    const rows = XLSX.utils.sheet_to_json(ccWs, { header:1, defval:null, raw:true });
    for (const row of rows.slice(0, 15)) {
      if (isDate(row[1]) && typeof row[2]==='number' && row[2]>0) {
        result.caixaValue = row[2]; break;
      }
    }
  }

  // ── 7. Total líquido from Sumário ──
  const sumWs = wb.Sheets['Sumario'];
  if (sumWs) {
    const rows = XLSX.utils.sheet_to_json(sumWs, { header:1, defval:null, raw:true });
    for (const row of rows) {
      if (norm(String(row[1]||''))==='total' && typeof row[5]==='number') {
        result.totalLiquido = row[5]; break;
      }
    }
  }

  return result;
}

// ── XP two-file state ──
let _xpBuffers = {};

function showXPBrokerWizard(buffer, fileName) {
  const isExtrato = fileName.toLowerCase().startsWith('extrato');
  const fileKey   = isExtrato ? 'extrato' : 'posicao';
  const otherLabel = isExtrato
    ? 'PosicaoDetalhadaHistorica_....xlsx'
    : 'Extrato_....xlsx';

  _xpBuffers[fileKey] = { buf: buffer, name: fileName };

  // Show partial info about what was loaded
  let partialHtml = '';
  try {
    const wb = XLSX.read(buffer, { type:'array', cellDates:true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!isExtrato) {
      const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:null, raw:false });
      const row1 = (rows[0]||[]);
      let monthFound = '';
      for (const cell of row1) {
        const m = String(cell||'').match(/Data da Posição Histórica:\s*(\d{2})\/(\d{2})\/(\d{4})/i)
                || String(cell||'').match(/Data da Posicao Historica:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
        if (m) { monthFound = fmtMonth(`${m[3]}-${m[2]}`); break; }
      }
      let assetCount = 0;
      for (const row of rows.slice(5)) {
        const g = String(row[6]||'');
        if (g.startsWith('R$') && parseFloat(g.replace(/[^0-9,]/g,'').replace(',','.')) > 0) assetCount++;
      }
      partialHtml = `<br>📋 <strong>${assetCount} ativos</strong> · mês: <strong>${monthFound||'?'}</strong>`;
    } else {
      const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:null, raw:true });
      let count = 0;
      for (let i=14; i<rows.length; i++) {
        const d = rows[i][1];
        if (d instanceof Date || (typeof d==='number' && d>40000)) count++;
      }
      partialHtml = `<br>📊 <strong>${count} movimentações</strong> encontradas no período`;
    }
  } catch(e) {}

  if (_xpBuffers.posicao && _xpBuffers.extrato) {
    G('broker-result').innerHTML = '<div class="info-box">⏳ Combinando os dois arquivos…</div>';
    setTimeout(() => {
      try {
        const parsed = parseXPBroker(_xpBuffers.posicao.buf, _xpBuffers.extrato.buf);
        _xpBuffers = {};
        G('broker-result').innerHTML = '';
        renderBrokerPreview(parsed);
      } catch(e) {
        G('broker-result').innerHTML = `<div class="warn-box">❌ Erro: ${esc(e.message)}</div>`;
        _xpBuffers = {};
      }
    }, 50);
    return;
  }

  G('broker-result').innerHTML = `
    <div class="info-box">
      ✅ <strong>${esc(fileName)}</strong> carregado.${partialHtml}
    </div>
    <div style="margin-top:10px;padding:12px 14px;background:var(--bg3);border:1px solid var(--accent);border-radius:8px;font-size:13px">
      📁 Agora selecione o <strong>segundo arquivo</strong>:<br>
      <span style="color:var(--text3);font-size:12px">${otherLabel}</span>
    </div>`;
}

function parseXPBroker(posicaoBuffer, extratoBuffer) {
  const wbPos = XLSX.read(posicaoBuffer, { type:'array', cellDates:true });
  const wsPos = wbPos.Sheets[wbPos.SheetNames[0]];
  const posRows = XLSX.utils.sheet_to_json(wsPos, { header:1, defval:null, raw:false });

  // Extract month from row 1 col F: "... Data da Posição Histórica: 30/04/2026"
  let month = null;
  const row1 = posRows[0] || [];
  for (const cell of row1) {
    if (!cell) continue;
    const m = String(cell).match(/Data da Posi[çc][aã]o Hist[oó]rica:\s*(\d{2})\/(\d{2})\/(\d{4})/i);
    if (m) { month = `${m[3]}-${m[2]}`; break; }
  }
  if (!month) throw new Error('Não foi possível identificar a data da posição histórica no arquivo XP.');

  // Parse R$ values
  const parseBRL = v => {
    if (!v) return null;
    const s = String(v).replace(/R\$\s*/,'').replace(/\./g,'').replace(',','.').trim();
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  };

  // Section category mapping
  const CAT_MAP = {
    'alternativo': 'fundos',   'multimercado': 'fundos',
    'pos-fixado': 'fundos',    'pre-fixado': 'renda_fixa',
    'renda fixa': 'renda_fixa','acoes': 'renda_variavel',
    'listado': 'fundos',       'fii': 'fundos',
    'acoesfundos': 'fundos',   'cdi': 'fundos',
  };
  const TYPE_MAP = {
    'alternativo': 'FIP', 'multimercado': 'Fundo Multimercado',
    'pos-fixado': 'Fundo de Renda Fixa', 'listado': 'FII',
    'pre-fixado': 'Fundo de Renda Fixa',
  };

  const assets = [];
  let currentCat = 'fundos', currentType = 'Fundo de Renda Fixa';

  const SKIP = ['fundos de investimentos','seu patrimônio','posição','% alocação',
    'valor aplicado','valor líquido','rentabilidade'];

  for (const row of posRows) {
    const colA = row[0] ? String(row[0]).trim() : '';
    const colG = row[6];
    if (!colA) continue;

    const nA = colA.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');

    // Section header: contains "% |"
    if (colA.includes('%') && colA.includes('|')) {
      const label = nA.split('|').pop().trim();
      for (const [k, v] of Object.entries(CAT_MAP)) {
        if (label.includes(k)) { currentCat = v; currentType = TYPE_MAP[k] || currentType; break; }
      }
      continue;
    }

    // Skip header/total rows
    if (SKIP.some(s => nA.startsWith(s.normalize('NFD').replace(/[̀-ͯ]/g,'')))) continue;

    const valor = parseBRL(colG);
    if (valor == null || valor <= 0) continue;

    assets.push({
      name: colA, category: currentCat, inv_type: currentType,
      broker: 'XP', valor, movimentacoes:[],
    });
  }

  // Parse extrato for movimentações in the same month
  // Use raw:true WITHOUT cellDates — dates come as Excel serial numbers, no timezone issues
  const wbExt = XLSX.read(extratoBuffer, { type:'array' });
  const wsExt = wbExt.Sheets[wbExt.SheetNames[0]];
  const extRows = XLSX.utils.sheet_to_json(wsExt, { header:1, defval:null, raw:true });

  const normA = s => (s||'').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();

  // Convert Excel serial to YYYY-MM (no timezone: serial 46128 = 2026-04-16 always)
  const serialToMonth = serial => {
    if (!serial || typeof serial !== 'number' || serial < 40000) return null;
    // Excel serial: days since 1899-12-30
    const totalDays = Math.floor(serial);
    // Use date math: epoch 1970-01-01 = serial 25569
    const ms = (totalDays - 25569) * 86400 * 1000;
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
  };

  // Find header row (col B = 'Movimentação')
  let dataStart = 14;
  for (let i = 0; i < Math.min(extRows.length, 20); i++) {
    if (normA(String(extRows[i][1]||'')).includes('movimenta')) { dataStart = i + 1; break; }
  }

  const IGNORE_XP = ['irrf', 'ted bco', 'come cotas', 'come-cotas', 'retirada em c/c', 'saldo'];
  const PREFIXES_XP = [
    'RENDIMENTO FUNDO FECHADO BALCÃO',
    'Devolução Tx de Distr',
    'ADIANTAMENTO RESGATE',
    'Amortização de fundo',
    'INTEGRALIZAÇÃO DE COTAS CETIP',
    'RESGATE',
  ];

  for (let ri = dataStart; ri < extRows.length; ri++) {
    const row = extRows[ri];

    // Col B (index 1) = date as Excel serial number
    const rowMonth = serialToMonth(row[1]);
    if (!rowMonth) continue;
    if (rowMonth !== month) continue; // filter to posição month only

    const descVal = row[3];  // col D = description
    const amtVal  = row[5];  // col F = value
    if (!descVal || amtVal == null) continue;

    const desc  = String(descVal).trim();
    const descN = normA(desc);
    if (IGNORE_XP.some(t => descN.includes(t))) continue;

    // Extract asset name after transaction type prefix
    let assetName = desc;
    for (const prefix of PREFIXES_XP) {
      if (desc.toUpperCase().startsWith(prefix.toUpperCase())) {
        assetName = desc.slice(prefix.length).replace(/^\s+/, '').trim();
        break;
      }
    }

    const amount = typeof amtVal === 'number' ? amtVal
      : parseFloat(String(amtVal).replace(',','.'));
    if (isNaN(amount) || amount === 0) continue;

    // Fuzzy name match against posição assets
    const nExt = normA(assetName);
    let target = null;
    for (const len of [35, 25, 15, 10]) {
      const pfx = nExt.slice(0, len).trim();
      if (!pfx) continue;
      target = assets.find(a => {
        const nA = normA(a.name);
        return nA.startsWith(pfx) || pfx.startsWith(nA.slice(0, Math.max(len-5, 8)));
      });
      if (target) break;
    }

    if (target) {
      target.movimentacoes.push({ amount, type: desc });
      if (desc.toUpperCase().includes('RESGATE') && !desc.toUpperCase().includes('ADIANTAMENTO') && amount > 0) {
        if (target.valor && Math.abs(amount - target.valor) / target.valor < 0.1) {
          target.liquidacaoTotal = true;
        }
      }
    }
  }

  return { month, assets, caixaValue: null, broker: 'XP' };
}

function parseCustomBroker(buffer, config) {
  throw new Error('Parser personalizado ainda não configurado para esta corretora.');
}

// Load existing inv_assets for name mapping dropdown
let _invAssetsList = [];
let _brokerMappings = {}; // {broker: {originalName: mappedName}}
async function loadInvAssetsList() {
  try { _invAssetsList = await ff.invAssetsList() || []; } catch(e) { _invAssetsList = []; }
  try { _brokerMappings = await ff.brokerMappingsGet() || {}; } catch(e) { _brokerMappings = {}; }
}

function renderBrokerPreview(parsed) {
  const { month, assets, caixaValue, broker } = parsed;
  const preview = G('broker-preview');
  if (!preview) return;
  // Preserve scroll position of the page before re-rendering
  const pageEl = document.querySelector('.page.active, #page-import');
  const savedScroll = pageEl ? pageEl.scrollTop : window.scrollY;

  const totalAtivos = assets.length;
  const totalMovs = assets.reduce((s,a) => s + (a.movimentacoes||[]).length, 0);

  const catLabel = c => ({ fundos:'Fundos', renda_fixa:'Renda Fixa', tesouro:'Tesouro Dir.', previdencia:'Previdência', renda_variavel:'Renda Variável', valor_em_caixa:'Caixa' }[c] || c);

  const existingNames = _invAssetsList.map(a => a.name);

  // Global broker name drop (reuse global-cat-drop pattern)
  let _brokerDropActiveInput = null;
  window._openBrokerNameDrop = function(inp) {
    _brokerDropActiveInput = inp;
    const drop = G('global-cat-drop');
    if (!drop) return;
    const q = inp.value || '', nq = norm(q);
    const hits = nq
      ? existingNames.filter(n => norm(n).includes(nq))
      : existingNames;
    drop.innerHTML = hits.length
      ? hits.map(n => `<div class="cat-opt" onmousedown="window._pickBrokerName('${esc2(n)}')">${esc(n)}</div>`).join('')
      : '<div class="cat-opt" style="color:var(--text3)">Nenhum ativo cadastrado</div>';
    const rect = inp.getBoundingClientRect();
    drop.style.top   = (rect.bottom + 2) + 'px';
    drop.style.left  = rect.left + 'px';
    drop.style.width = Math.max(rect.width, 240) + 'px';
    drop.style.display = 'block';
  };
  window._pickBrokerName = function(val) {
    const clean = val.replace(/&#39;/g,"'").replace(/&amp;/g,'&');
    if (_brokerDropActiveInput) _brokerDropActiveInput.value = clean;
    const drop = G('global-cat-drop');
    if (drop) drop.style.display = 'none';
  };

  // Load flow-type memory for this broker (persisted in localStorage)
  const flowMemKey = `broker_flow_memory_${parsed.broker}`;
  let _flowMemory = {};
  try { _flowMemory = JSON.parse(localStorage.getItem(flowMemKey) || '{}'); } catch(e) {}

  // Apply memorized flow_type to movimentacoes that have no classification
  parsed.assets.forEach(a => {
    (a.movimentacoes || []).forEach(mov => {
      if (!mov.flow_type) {
        const memKey = norm(String(mov.type || ''));
        if (_flowMemory[memKey]) mov.flow_type = _flowMemory[memKey];
      }
    });
  });

  // Handler to reclassify an unknown flow and memorize the term
  window._reclassifyBrokerFlow = function(assetIdx, globalMovIdx, newType) {
    const a = parsed.assets[assetIdx];
    const mov = (a.movimentacoes||[])[globalMovIdx];
    if (!mov) return;
    mov.flow_type = newType;
    // Memorize by term so future imports are pre-classified
    const memKey = norm(String(mov.type || ''));
    if (newType === 'ignore') {
      // For ignore, only memorize if user explicitly chose it (not auto-classified)
      _flowMemory[memKey] = newType;
    } else {
      _flowMemory[memKey] = newType;
    }
    try { localStorage.setItem(flowMemKey, JSON.stringify(_flowMemory)); } catch(e) {}
    renderBrokerPreview(parsed);
  };

  function buildFlowCells(a, idx) {
    const extMovs = (a.movimentacoes||[]).filter(m => m.flow_type === 'external');
    const incMovs = (a.movimentacoes||[]).filter(m => m.flow_type === 'income');
    const extTotal = extMovs.reduce((s,m) => s + m.amount, 0);
    const incTotal = incMovs.reduce((s,m) => s + m.amount, 0);
    const allMovs  = (a.movimentacoes||[]).filter(m => m.flow_type !== 'ignore');

    const fmtV = v => v
      ? `<span class="${v>0?'amt-inc':'amt-exp'}" style="font-family:'DM Mono',monospace;font-size:11px">${fmtBRL(v)}</span>`
      : '<span style="color:var(--text3)">—</span>';

    // One reclassify row per movimentação (including already-classified ones)
    let movHtml = '';
    allMovs.forEach((mov, j) => {
      // globalIdx is the index within ALL movimentacoes (not just unknowns)
      const globalIdx = (a.movimentacoes||[]).indexOf(mov);
      const ft = mov.flow_type;
      const isUnk = !ft;
      const icon = isUnk ? '❓' : ft === 'external' ? '📥' : '💰';
      const labelColor = isUnk ? '#d97706' : ft === 'external' ? 'var(--accent)' : 'var(--green)';
      const activeExt  = ft === 'external';
      const activeInc  = ft === 'income';

      movHtml += `<div style="font-size:10px;color:${labelColor};margin-top:3px;display:flex;align-items:center;gap:3px;flex-wrap:wrap">
        <span title="${esc(String(mov.type||''))}" style="max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${icon} ${esc(String(mov.type||'').slice(0,24))}</span>
        <span style="font-family:'DM Mono',monospace;color:var(--text1)">${fmtBRL(mov.amount)}</span>
        <button class="btn xs" style="padding:1px 4px;font-size:9px;${activeExt?'background:var(--accent);color:#fff;border-color:var(--accent)':'border-color:var(--accent);color:var(--accent)'}"
          onclick="window._reclassifyBrokerFlow(${idx},${globalIdx},'external')" style="white-space:nowrap">📥 Ext</button>
        <button class="btn xs" style="padding:1px 4px;font-size:9px;${activeInc?'background:var(--green);color:#fff;border-color:var(--green)':'border-color:var(--green);color:var(--green)'}"
          onclick="window._reclassifyBrokerFlow(${idx},${globalIdx},'income')">💰 Rend</button>
        <button class="btn xs" style="padding:1px 4px;font-size:9px;border-color:var(--red);color:var(--red)"
          onclick="window._reclassifyBrokerFlow(${idx},${globalIdx},'ignore')">🚫</button>
      </div>`;
    });

    const hasMovs = allMovs.length > 0;
    return { extCell: fmtV(extTotal || 0), incCell: fmtV(incTotal || 0), unkHtml: hasMovs ? movHtml : '' };
  }

  let rows = assets.map((a, i) => {
    const liqLabel = a.liquidacaoTotal ? ' 🔴' : '';
    const vencLabel = a.maturity_month
      ? `<span style="color:var(--text3);font-size:10px">${a.maturity_month}</span>` : '—';
    const brokerMap = _brokerMappings[parsed.broker] || {};
    const learned = brokerMap[a.name];
    const prefill = learned || '';
    const borderStyle = learned ? 'border-color:var(--accent)' : '';
    const nameInput = `<div style="display:flex;align-items:center;gap:2px">
      <input class="inp broker-name-inp" data-idx="${i}"
        value="${esc(prefill)}" placeholder="Selecione ou crie…"
        style="flex:1;font-size:11px;padding:2px 5px;min-width:120px;${borderStyle}"
        oninput="window._openBrokerNameDrop(this)" onfocus="window._openBrokerNameDrop(this)" autocomplete="off">
      <button type="button" tabindex="-1"
        style="padding:2px 4px;font-size:9px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;cursor:pointer"
        onmousedown="event.preventDefault();window._openBrokerNameDrop(this.previousElementSibling)">▾</button>
    </div>`;
    const CAT_OPTIONS = ['fundos','renda_fixa','tesouro','previdencia','renda_variavel','valor_em_caixa']
      .map(c => `<option value="${c}" ${a.category===c?'selected':''}>${catLabel(c)}</option>`).join('');
    const { extCell, incCell, unkHtml } = buildFlowCells(a, i);
    const unkRow = unkHtml ? `<tr style="background:var(--bg3)">
      <td colspan="6" style="padding:0 4px"></td>
      <td style="padding:3px 8px 5px 8px">${unkHtml}</td>
    </tr>` : '';
    return `<tr>
      <td style="font-size:11px;padding:4px 6px;min-width:150px">
        <div style="font-size:10px;color:var(--text3);margin-bottom:2px">${esc(a.name)}</div>
        ${nameInput}
      </td>
      <td style="padding:3px 4px">
        <select class="broker-cat-sel inp" data-idx="${i}" style="font-size:11px;padding:2px 4px;min-width:90px">
          ${CAT_OPTIONS}
        </select>
      </td>
      <td style="padding:3px 4px">
        <input class="broker-type-inp inp" data-idx="${i}" value="${esc(a.inv_type||'')}"
          style="font-size:11px;padding:2px 5px;min-width:70px">
      </td>
      <td style="font-size:11px;padding:4px 6px;text-align:center">${vencLabel}</td>
      <td style="text-align:center;font-size:11px;padding:4px 8px;font-family:'DM Mono',monospace;white-space:nowrap;color:var(--green)">${a.valor!=null?fmtBRL(a.valor):'—'}</td>
      <td style="text-align:center;font-size:11px;padding:4px 8px">${extCell}</td>
      <td style="text-align:center;font-size:11px;padding:4px 8px">${incCell}</td>
      <td style="font-size:11px;padding:4px 8px;text-align:right">${incCell}</td>
    </tr>${unkRow}`;
  }).join('');

  if (caixaValue) {
    rows += `<tr style="background:var(--bg3)">
      <td style="font-size:11px;padding:4px 6px" colspan="4">Valores em Caixa (${broker})</td>
      <td class="amt-inc right" style="font-size:11px;padding:4px 8px;font-family:'DM Mono',monospace">${fmtBRL(caixaValue)}</td>
      <td></td><td></td>
    </tr>`;
  }

  const hasUnknowns = parsed.assets.some(a => (a.movimentacoes||[]).some(m => !m.flow_type));
  const warnHtml = hasUnknowns
    ? `<div style="background:#fef3c7;border:1px solid #fde68a;border-radius:6px;padding:8px 12px;font-size:12px;color:#92400e;margin-bottom:8px">
        ⚠️ Movimentações com tipo não identificado (❓) precisam ser classificadas. Sua escolha será lembrada automaticamente nas próximas importações.
       </div>` : '';

  preview.innerHTML = `
    <div class="tbl-card">
      <div class="tbl-header" style="flex-wrap:wrap;gap:4px">
        <h3>${totalAtivos} ativo(s) — ${fmtMonth(month)} · ${broker}</h3>
        <span style="font-size:12px;color:var(--text3)">
          ${totalMovs} movimentação(ões) &nbsp;·&nbsp;
          <span style="color:var(--accent)">📥 Ext = Aporte/Resgate</span> &nbsp;·&nbsp;
          <span style="color:var(--green)">💰 Rend = Rendimento/Custo</span>
        </span>
      </div>
      ${warnHtml}
      <div class="tbl-outer" style="max-height:420px;overflow-x:auto">
        <table class="ledger" style="min-width:720px">
          <thead><tr>
            <th>Extrato → Nome no Cruzeiro</th>
            <th>Categoria</th><th>Tipo</th>
            <th style="text-align:center">Vencimento</th>
            <th style="text-align:center;white-space:nowrap">Saldo líquido</th>
            <th style="text-align:center;color:var(--accent);white-space:nowrap">📥 Ext</th>
            <th style="text-align:center;color:var(--green);white-space:nowrap">💰 Rend</th>
            <th style="text-align:center;white-space:nowrap">❓ Reclassificar</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap">
      <button class="btn primary" onclick="confirmBrokerImport()">✓ Importar para Patrimônio</button>
      <button class="btn" onclick="cancelBrokerImport()">Cancelar</button>
      <span style="font-size:12px;color:var(--text3)">Os dados serão salvos em Patrimônio → Investimentos Financeiros</span>
    </div>`;  preview.style.display = 'block';
  if (G('broker-result')) G('broker-result').innerHTML = '';
  preview._parsed = parsed;
  // Restore scroll position after re-render
  requestAnimationFrame(() => {
    if (typeof pageEl !== 'undefined' && pageEl) pageEl.scrollTop = savedScroll;
  });
}

function cancelBrokerImport() {
  const preview = G('broker-preview');
  if (preview) { preview.style.display = 'none'; preview._parsed = null; }
  G('broker-result').innerHTML = '';
  G('broker-file-name').textContent = '';
  _brokerBuffer = null;
}

async function confirmBrokerImport() {
  if (_licStatus?.status === 'payment_required') {
    toast('⚠️ Licença necessária para importar dados. Acesse Configurações → Licença.');
    return;
  }
  const preview = G('broker-preview');
  const parsed = preview?._parsed;
  if (!parsed) return;

  // Read edited names from preview table — user may have remapped assets
  const nameInputs = preview.querySelectorAll('.broker-name-inp');
  const catSelects  = preview.querySelectorAll('.broker-cat-sel');
  const typeInputs  = preview.querySelectorAll('.broker-type-inp');

  nameInputs.forEach((inp, i) => {
    if (parsed.assets[i]) {
      const newName = inp.value.trim();
      const origName = parsed.assets[i].name;
      if (newName) {
        ff.brokerMappingLearn({ broker: parsed.broker, original: origName, mapped: newName }).catch(() => {});
        parsed.assets[i].name = newName;
      } else {
        parsed.assets[i]._skip = true;
      }
      // Read edited category and type
      if (catSelects[i]) parsed.assets[i]._editedCategory = catSelects[i].value || null;
      if (typeInputs[i]) parsed.assets[i]._editedType = typeInputs[i].value.trim() || null;
    }
  });
  parsed.assets = parsed.assets.filter(a => !a._skip);
  // Apply edited category/type only for NEW assets (not existing ones)
  parsed.assets.forEach(a => {
    if (a._editedCategory) a.category = a._editedCategory;
    if (a._editedType)     a.inv_type  = a._editedType;
  });

  const btn = preview.querySelector('.btn.primary');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Importando…'; }

  const brokerAccountId = parseInt(G('broker-account')?.value) || null;
  // Persist account preference for this broker
  if (brokerAccountId && parsed.broker) {
    ff.brokerAccountPrefSet({ broker: _selectedBroker, accountId: brokerAccountId }).catch(() => {});
  }

  try {
    const result = await ff.brokerSaveParsed({
      month:      parsed.month,
      assets:     parsed.assets,
      caixaValue: parsed.caixaValue,
      broker:     parsed.broker,
    });

    let adjMsg = '';
    // Create balance adjustment transaction if account selected and totalLiquido available
    if (brokerAccountId && parsed.totalLiquido != null) {
      try {
        const adjResult = await ff.brokerCreateAdjustment({
          accountId: brokerAccountId,
          month: parsed.month,
          totalLiquido: parsed.totalLiquido,
          broker: parsed.broker,
        });
        adjMsg = adjResult.inserted
          ? `<br>💰 Ajuste de saldo criado: ${fmtBRL(adjResult.amount)} na conta ${esc(adjResult.accountName)}`
          : `<br>ℹ️ Saldo já atualizado (sem variação)`;
      } catch(e2) {
        adjMsg = `<br>⚠️ Ajuste de saldo não criado: ${esc(e2.message)}`;
      }
    } else if (brokerAccountId && parsed.totalLiquido == null) {
      adjMsg = '<br>ℹ️ Total líquido não encontrado no extrato — ajuste não criado';
    }

    G('broker-result').innerHTML = `<div class="info-box" style="line-height:1.8">
      ✅ <strong>Importação concluída — ${parsed.broker} · ${fmtMonth(parsed.month)}</strong><br>
      • ${result.createdAssets} ativo(s) criado(s)<br>
      • ${result.updatedAssets} ativo(s) atualizado(s)<br>
      • ${result.txInserted} transação(ões) registrada(s)${adjMsg}
    </div>`;
    cancelBrokerImport();
    if (currentPage === 'patrimonio') await refreshPatrimonio();
    toast(`✅ ${result.txInserted} registros importados`);
    // Learn ML mappings from this broker import
    try {
      const mlItems = parsed.assets
        .filter(a => a.name && a.category)
        .map(a => ({ desc: a._origName || a.name, memo: a.name, category: a.category, amount: a.valor || 0 }));
      if (mlItems.length) await ff.brokerMlLearn({ items: mlItems }).catch(() => {});
    } catch(e) {}
  } catch(e) {
    G('broker-result').innerHTML = `<div class="warn-box">❌ Erro: ${esc(e.message)}</div>`;
    if (btn) { btn.disabled = false; btn.textContent = '✓ Importar para Patrimônio'; }
  }
}

// ── Custom parser: run with config ──
function parseCustomBank(buffer, config) {
  const { fileType, dateCol, descCol, amountCol, headerRow, delimiter, dateFormat, invertSign } = config;
  let rows = [];

  if (fileType === 'CSV') {
    const text = new TextDecoder(config.encoding||'utf-8').decode(buffer).replace(/^\uFEFF/, '');
    const sep = delimiter || ';';
    rows = text.split(/\r?\n/).filter(l => l.trim()).map(l => l.split(sep));
  } else if (fileType === 'OFX') {
    return parseOFX(buffer);
  } else {
    const wb = XLSX.read(buffer, { type:'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:'', raw:true });
  }

  const startRow = (headerRow || 1); // 1-based
  const dC = (dateCol  || 0); // 0-based col index or letter
  const lC = (descCol  || 1);
  const vC = (amountCol|| 2);
  const colIdx = c => typeof c === 'string' ? c.toUpperCase().charCodeAt(0) - 65 : c;
  const res = [];

  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];
    const rawDate = String(row[colIdx(dC)]||'').trim();
    const rawDesc = String(row[colIdx(lC)]||'').trim();
    const rawVal  = row[colIdx(vC)];
    if (!rawDate || !rawDesc) continue;
    const date = pDate(rawDate);
    if (!date) continue;
    let amount = typeof rawVal === 'number' ? rawVal : pVal(rawVal);
    if (invertSign) amount = -amount;
    res.push({ date, desc: rawDesc, memo: rawDesc, amount, saldo: null, category: '' });
  }
  return res;
}

function parseOFX(buffer) {
  const text = new TextDecoder('latin1').decode(buffer);
  const res = [];
  const txRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/g;
  let m;
  while ((m = txRegex.exec(text)) !== null) {
    const block = m[1];
    const get = tag => { const r = new RegExp(`<${tag}>([^<\r\n]+)`,'i').exec(block); return r?r[1].trim():''; };
    const dateRaw = get('DTPOSTED');
    const amount  = parseFloat(get('TRNAMT').replace(',','.')) || 0;
    const memo    = get('MEMO') || get('NAME') || '';
    if (!dateRaw || !amount) continue;
    const y = dateRaw.slice(0,4), mo = dateRaw.slice(4,6), d = dateRaw.slice(6,8);
    const date = `${y}-${mo}-${d}`;
    res.push({ date, desc: memo, memo, amount, saldo: null, category: '' });
  }
  return res;
}

// ══ CUSTOM PARSER WIZARD ══
let _wizardBuffer = null;
let _wizardType   = 'bank'; // 'bank' | 'card'
let _wizardParsed = [];

async function openCustomParserWizard(type) {
  _wizardType = type;
  _wizardBuffer = null;
  _wizardParsed = [];

  const isCard = type === 'card';
  G('custom-parser-title').textContent = isCard ? '➕ Configurar novo cartão de crédito' : '➕ Configurar novo banco';
  openModal('modal-custom-parser');
  renderWizardStep1();
}

function renderWizardStep1() {
  G('custom-parser-body').innerHTML = `
    <p style="font-size:13px;color:var(--text2);margin:0 0 14px">
      Selecione o arquivo de extrato/fatura para o Cruzeiro tentar identificar o formato automaticamente.
      Formatos suportados: <strong>CSV, XLSX, XLS, OFX, PDF</strong>
    </p>
    <div style="display:flex;gap:8px;align-items:center">
      <button class="btn primary" onclick="document.getElementById('wizard-file-input').click()">📂 Selecionar arquivo</button>
      <span id="wizard-file-name" style="font-size:12px;color:var(--text3)"></span>
    </div>
    <input type="file" id="wizard-file-input" style="display:none"
      accept=".csv,.CSV,.xls,.xlsx,.XLS,.XLSX,.ofx,.OFX,.pdf,.PDF"
      onchange="onWizardFileSelected(event)">
    <div id="wizard-step1-result" style="margin-top:12px"></div>`;
  G('custom-parser-footer').innerHTML = `
    <button class="btn" onclick="closeModal('modal-custom-parser')">Cancelar</button>`;
}

async function onWizardFileSelected(event) {
  const file = event.target.files[0];
  if (!file) return;
  G('wizard-file-name').textContent = file.name;
  const result = G('wizard-step1-result');
  result.innerHTML = '<div class="info-box">⏳ Analisando arquivo…</div>';

  if (typeof XLSX === 'undefined') {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
  }

  _wizardBuffer = await file.arrayBuffer();
  const ext = file.name.split('.').pop().toLowerCase();
  let autoConfig = null;
  let autoRows = [];

  try {
    // OFX — most structured, try first
    if (ext === 'ofx') {
      autoRows = parseOFX(_wizardBuffer);
      if (autoRows.length > 0) autoConfig = { fileType:'OFX' };
    }

    // Try XLSX/XLS
    if (!autoConfig && ['xlsx','xls'].includes(ext)) {
      const candidate = autoDetectXLSX(_wizardBuffer);
      if (candidate && candidate.rows.length > 0) { autoConfig = candidate.config; autoRows = candidate.rows; }
    }

    // Try CSV
    if (!autoConfig && ext === 'csv') {
      const candidate = autoDetectCSV(_wizardBuffer);
      if (candidate && candidate.rows.length > 0) { autoConfig = candidate.config; autoRows = candidate.rows; }
    }

  } catch(e) { /* fall through to manual */ }

  event.target.value = '';

  if (autoConfig && autoRows.length > 0) {
    _wizardParsed = autoRows;
    renderWizardAutoResult(autoConfig, autoRows);
  } else {
    renderWizardManualConfig(ext);
  }
}

function autoDetectXLSX(buffer) {
  const wb = XLSX.read(buffer, { type:'array', cellDates:true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header:1, defval:'', raw:true });

  // Find header row: look for row with 'data'/'date' and 'valor'/'amount' and 'descri'/'memo'
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const r = rows[i].map(c => norm(String(c)));
    const di = r.findIndex(c => c === 'data' || c.startsWith('data'));
    const li = r.findIndex(c => c.includes('descri') || c.includes('histor') || c.includes('memo') || c.includes('lancam'));
    const vi = r.findIndex(c => c.includes('valor') && !c.includes('saldo'));
    if (di >= 0 && li >= 0 && vi >= 0) {
      const config = { fileType:'XLSX', headerRow: i+1, dateCol: di, descCol: li, amountCol: vi };
      const testRows = [];
      for (let j = i+1; j < rows.length; j++) {
        const row = rows[j];
        const rawDate = String(row[di]||'').trim();
        const rawDesc = String(row[li]||'').trim();
        if (!rawDate || !rawDesc) continue;
        const date = pDate(rawDate) || (row[di] instanceof Date ? row[di].toISOString().slice(0,10) : null);
        if (!date) continue;
        const amount = typeof row[vi] === 'number' ? row[vi] : pVal(row[vi]);
        testRows.push({ date, desc: rawDesc, memo: rawDesc, amount, saldo: null, category:'' });
      }
      if (testRows.length > 0) return { config, rows: testRows };
    }
  }
  return null;
}

function autoDetectCSV(buffer) {
  const text = new TextDecoder('utf-8').decode(buffer).replace(/^\uFEFF/,'');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const delimiters = [';', ',', '\t', '|'];

  for (const sep of delimiters) {
    const rows = lines.map(l => l.split(sep));
    if (rows[0].length < 3) continue;
    const header = rows[0].map(c => norm(String(c)));
    const di = header.findIndex(c => c === 'data' || c.startsWith('data'));
    const li = header.findIndex(c => c.includes('descri') || c.includes('histor') || c.includes('memo') || c.includes('lancam'));
    const vi = header.findIndex(c => c.includes('valor') && !c.includes('saldo'));
    if (di >= 0 && li >= 0 && vi >= 0) {
      const testRows = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const rawDate = String(row[di]||'').trim();
        const rawDesc = String(row[li]||'').trim();
        if (!rawDate || !rawDesc) continue;
        const date = pDate(rawDate);
        if (!date) continue;
        const amount = pVal(row[vi]);
        testRows.push({ date, desc: rawDesc, memo: rawDesc, amount, saldo: null, category:'' });
      }
      if (testRows.length > 0) return { config: { fileType:'CSV', delimiter: sep, headerRow: 1, dateCol: di, descCol: li, amountCol: vi }, rows: testRows };
    }
  }
  return null;
}

function renderWizardAutoResult(config, rows) {
  const body = G('custom-parser-body');
  const preview = rows.slice(0,8).map(r =>
    `<tr><td>${r.date}</td><td>${esc(r.memo)}</td><td class="${r.amount<0?'amt-exp':'amt-inc'} right">${fmtBRL(r.amount)}</td></tr>`
  ).join('');

  body.innerHTML = `
    <div class="info-box" style="margin-bottom:12px">
      ✅ <strong>${rows.length} transações encontradas automaticamente.</strong> Confira a prévia abaixo.
    </div>
    <div class="tbl-outer" style="max-height:180px;margin-bottom:14px">
      <table class="ledger"><thead><tr><th>Data</th><th>Descrição</th><th class="right">Valor</th></tr></thead>
      <tbody>${preview}</tbody></table>
    </div>
    <div class="field">
      <label class="lbl">Nome deste ${_wizardType === 'card' ? 'cartão' : 'banco'} (para a lista)</label>
      <input class="inp" id="wizard-parser-name" type="text" placeholder="Ex: Nubank, Inter, Santander…" style="max-width:300px">
    </div>`;

  G('custom-parser-footer').innerHTML = `
    <button class="btn" onclick="renderWizardManualConfig('${config.fileType?.toLowerCase()||'xlsx'}')">⚙ Ajustar manualmente</button>
    <button class="btn" onclick="closeModal('modal-custom-parser')">Cancelar</button>
    <button class="btn primary" onclick="saveWizardParser(${JSON.stringify(config).replace(/"/g,'&quot;')})">✓ Funcionou! Salvar</button>`;
}

function renderWizardManualConfig(ext) {
  G('custom-parser-body').innerHTML = `
    <div class="warn-box" style="margin-bottom:12px">
      ⚠️ Não foi possível detectar automaticamente. Informe onde estão os dados:
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
      <div class="field" style="margin:0">
        <label class="lbl">Formato do arquivo</label>
        <select class="inp" id="wiz-filetype">
          <option value="CSV"${ext==='csv'?' selected':''}>CSV</option>
          <option value="XLSX"${['xlsx','xls'].includes(ext)?' selected':''}>Excel (XLSX/XLS)</option>
          <option value="OFX"${ext==='ofx'?' selected':''}>OFX</option>
        </select>
      </div>
      <div class="field" style="margin:0" id="wiz-delimiter-wrap">
        <label class="lbl">Separador (CSV)</label>
        <select class="inp" id="wiz-delimiter">
          <option value=";">Ponto e vírgula (;)</option>
          <option value=",">, Vírgula (,)</option>
          <option value="&#9;">Tab</option>
        </select>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">
      <div class="field" style="margin:0">
        <label class="lbl">Linha do cabeçalho</label>
        <input class="inp" id="wiz-headerrow" type="number" value="1" min="1" max="50">
      </div>
      <div class="field" style="margin:0">
        <label class="lbl">Coluna de data (A=0)</label>
        <input class="inp" id="wiz-datecol" type="number" value="0" min="0" max="50">
      </div>
      <div class="field" style="margin:0">
        <label class="lbl">Coluna de descrição</label>
        <input class="inp" id="wiz-desccol" type="number" value="1" min="0" max="50">
      </div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px">
      <div class="field" style="margin:0">
        <label class="lbl">Coluna de valor</label>
        <input class="inp" id="wiz-amtcol" type="number" value="2" min="0" max="50">
      </div>
      <div class="field" style="margin:0">
        <label class="lbl">Inverter sinal?</label>
        <select class="inp" id="wiz-invert">
          <option value="0">Não</option>
          <option value="1">Sim</option>
        </select>
      </div>
    </div>
    <div class="field" style="margin-bottom:12px">
      <label class="lbl">Nome deste ${_wizardType === 'card' ? 'cartão' : 'banco'}</label>
      <input class="inp" id="wizard-parser-name" type="text" placeholder="Ex: Nubank, Inter…" style="max-width:300px">
    </div>
    <div id="wizard-manual-result"></div>`;

  G('custom-parser-footer').innerHTML = `
    <button class="btn" onclick="closeModal('modal-custom-parser')">Cancelar</button>
    <button class="btn" onclick="testManualWizard()">🔍 Testar</button>
    <button class="btn primary" id="wiz-save-btn" style="display:none" onclick="saveManualWizard()">✓ Funcionou! Salvar</button>`;
}

async function testManualWizard() {
  if (!_wizardBuffer) { toast('Selecione um arquivo primeiro'); return; }
  const config = {
    fileType:   G('wiz-filetype').value,
    delimiter:  G('wiz-delimiter').value,
    headerRow:  parseInt(G('wiz-headerrow').value) - 1, // convert to 0-based
    dateCol:    parseInt(G('wiz-datecol').value),
    descCol:    parseInt(G('wiz-desccol').value),
    amountCol:  parseInt(G('wiz-amtcol').value),
    invertSign: G('wiz-invert').value === '1',
  };
  const result = G('wizard-manual-result');
  try {
    const rows = parseCustomBank(_wizardBuffer, config);
    if (!rows.length) {
      result.innerHTML = '<div class="warn-box">⚠️ Nenhuma transação encontrada com essas configurações. Tente ajustar as colunas.</div>';
      G('wiz-save-btn').style.display = 'none';
      return;
    }
    _wizardParsed = rows;
    const preview = rows.slice(0,5).map(r =>
      `<tr><td>${r.date}</td><td>${esc(r.memo)}</td><td class="${r.amount<0?'amt-exp':'amt-inc'} right">${fmtBRL(r.amount)}</td></tr>`
    ).join('');
    result.innerHTML = `
      <div class="info-box" style="margin-bottom:8px">✅ ${rows.length} transações encontradas:</div>
      <div class="tbl-outer" style="max-height:140px">
        <table class="ledger"><thead><tr><th>Data</th><th>Descrição</th><th class="right">Valor</th></tr></thead>
        <tbody>${preview}</tbody></table>
      </div>`;
    G('wiz-save-btn').style.display = '';
  } catch(e) {
    result.innerHTML = `<div class="warn-box">❌ Erro: ${esc(e.message)}</div>`;
    G('wiz-save-btn').style.display = 'none';
  }
}

async function saveManualWizard() {
  const config = {
    fileType:   G('wiz-filetype').value,
    delimiter:  G('wiz-delimiter').value,
    headerRow:  parseInt(G('wiz-headerrow').value) - 1,
    dateCol:    parseInt(G('wiz-datecol').value),
    descCol:    parseInt(G('wiz-desccol').value),
    amountCol:  parseInt(G('wiz-amtcol').value),
    invertSign: G('wiz-invert').value === '1',
  };
  await saveWizardParser(config);
}

async function saveWizardParser(config) {
  const nameEl = G('wizard-parser-name');
  const name = nameEl?.value?.trim();
  if (!name) { toast('Dê um nome a este banco/cartão'); nameEl?.focus(); return; }

  const id = `custom_${Date.now()}`;
  const parser = { id, name, type: _wizardType, config };
  await ff.bankParserSave(parser);
  _customBankParsers = await ff.bankParsersList();
  renderImportDropdowns();
  closeModal('modal-custom-parser');
  toast(`✅ "${name}" adicionado à lista`);

  // Auto-select and show file trigger
  pickImport(id, _wizardType);
  if (_wizardParsed.length > 0) {
    _bankParsed = _wizardParsed;
    renderBankPreview(_wizardParsed);
  }
}


// ══ FINANCIAL FILE IMPORT (QIF / OFX / QFX / QBO / CSV) ══
async function importFinancialFile() {
  const res = await ff.openFile({
    filters:[{ name:'Arquivo financeiro', extensions:['qif','ofx','qfx','qbo','csv','QIF','OFX','QFX','QBO','CSV'] }]
  });
  if (!res) return;
  const text = res.text || res;  // new format returns {text,path}, old returns string
  const filePath = res.path || '';
  const ext = filePath.split('.').pop().toLowerCase();
  const fileName = filePath.split(/[/\\]/).pop();

  const nameEl = G('qif-file-name');
  if (nameEl) nameEl.textContent = fileName;

  const btn = document.querySelector('[onclick="importFinancialFile()"]');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Processando…'; }
  G('qif-result').innerHTML = '<div class="info-box">⏳ Processando — aguarde…</div>';

  try {
    const result = await ff.financialImport({ text, ext });
    const fmt = { qif:'QIF', ofx:'OFX', qfx:'QFX', qbo:'QBO', csv:'CSV' }[ext] || ext.toUpperCase();
    let msg = `✅ <strong>${result.count.toLocaleString('pt-BR')} lançamentos importados</strong> (${fmt}).`;
    if (result.duplicates) msg += `<br>⏭ ${result.duplicates} duplicata(s) ignorada(s).`;
    if (result.skipped)    msg += `<br>⚠️ ${result.skipped} lançamento(s) ignorado(s).`;
    if (result.unknownAccounts?.length) {
      msg += `<br>❓ Conta(s) não encontrada(s): <em>${result.unknownAccounts.join(', ')}</em>`;
      msg += `<br><span style="font-size:11px;color:var(--text3)">Os nomes das contas devem ser idênticos aos do arquivo de origem.</span>`;
    }
    G('qif-result').innerHTML = `<div class="info-box" style="line-height:1.9">${msg}</div>`;
    await loadAccounts();
    if (currentPage === 'account') refreshAccount();
    toast(`${result.count.toLocaleString('pt-BR')} lançamentos importados`);
  } catch(e) {
    G('qif-result').innerHTML = `<div class="warn-box">❌ Erro: ${esc(e.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📂 Selecionar arquivo'; }
  }
}
// Keep importQIF as alias for backward compatibility
const importQIF = importFinancialFile;

// ══ ML ══
async function refreshML() {
  const rules=await ff.mlList();
  const count=rules.length, uses=rules.reduce((s,r)=>s+r.count,0), hi=rules.filter(r=>r.count>=5).length;
  G('ml-stats').innerHTML=`
    <div class="stat-card"><div class="stat-lbl">Regras</div><div class="stat-val accent">${count}</div></div>
    <div class="stat-card"><div class="stat-lbl">Usos totais</div><div class="stat-val accent">${uses}</div></div>
    <div class="stat-card"><div class="stat-lbl">Alta confiança</div><div class="stat-val green">${hi}</div></div>`;
  const groups={hi:rules.filter(r=>r.count>=5),mid:rules.filter(r=>r.count>=2&&r.count<5),low:rules.filter(r=>r.count<2)};
  const labels={hi:['Alta confiança','#16a34a'],mid:['Média','#d97706'],low:['Baixa — revisar','#dc2626']};
  let html='';
  Object.entries(groups).forEach(([k,[lbl,color]])=>{
    if (!groups[k].length) return;
    html+=`<div style="margin-bottom:16px"><div style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block"></span><strong style="font-size:13px">${lbl}</strong><span style="font-size:12px;color:var(--text3)">${groups[k].length} regra${groups[k].length>1?'s':''}</span></div>
    <div class="tbl-card"><div class="tbl-outer"><table class="ledger"><thead><tr><th>Palavra-chave</th><th>Memorando</th><th>Categoria</th><th class="center">Usos</th><th class="right">Valor médio</th></tr></thead><tbody>
    ${groups[k].slice(0,20).map(r=>{
      const mean=r.n_val>0?fmtBRL(r.sum_val/r.n_val):'—';
      return `<tr><td style="font-family:'DM Mono',monospace;font-size:12px;color:var(--text2)">${esc(r.keyword)}</td><td style="font-size:13px">${esc(r.memo||'—')}</td><td style="font-size:13px">${esc(r.category||'—')}</td><td class="center">${r.count}</td><td class="right" style="font-family:'DM Mono',monospace">${mean}</td></tr>`;
    }).join('')}
    </tbody></table></div></div></div>`;
  });
  G('ml-groups').innerHTML=html||'<div class="empty"><div class="ei">🧠</div><p>Nenhuma regra ainda</p></div>';
}
async function clearML(){ if(!await showConfirmDialog('Apagar todo aprendizado?', 'Esta ação não pode ser desfeita.', 'Apagar', true)) return; await ff.mlClear(); toast('Apagado'); refreshML(); }
async function exportML(){ const r=await ff.mlExport(); await ff.saveFile({ defaultPath:'regras_ml.json', content:JSON.stringify(r,null,2) }); toast('Exportado'); }
async function importML(ev){ const f=ev.target.files[0]; if(!f) return; const t=await f.text(); try { await ff.mlImport(JSON.parse(t)); toast('Importado'); refreshML(); } catch(e){ toast('Erro no arquivo'); } }

async function trainMLHistory() {
  const btn = G('btn-train-ml');
  const res = G('ml-train-result');
  btn.disabled = true;
  btn.textContent = '⏳ Treinando…';
  res.innerHTML = '<div class="info-box">⏳ Processando histórico — pode demorar alguns segundos…</div>';
  try {
    const result = await ff.mlTrainHistory();
    res.innerHTML = `<div class="info-box">✅ <strong>${result.trained.toLocaleString('pt-BR')} lançamentos</strong> usados para treinar o ML (de ${result.total.toLocaleString('pt-BR')} com categoria preenchida).</div>`;
    refreshML();
    toast('ML treinado com sucesso!');
  } catch(e) {
    res.innerHTML = `<div class="warn-box">❌ Erro: ${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🧠 Treinar com histórico';
  }
}

// ══ OPENING BALANCES ══
async function openOpeningBalances() {
  const accs = await ff.listAccounts();
  const visible = accs.filter(a => !a.hidden);

  // Get current balances
  const balances = {};
  await Promise.all(visible.map(async a => {
    balances[a.id] = await ff.getBalance(a.id);
  }));

  const typeOrder = { bank:0, credit:1, cash:2, investment:3 };
  const typeLabels = { bank:'Contas bancárias', credit:'Cartões de crédito', cash:'Caixa', investment:'Investimentos' };
  const groups = {};
  visible.forEach(a => { if (!groups[a.type]) groups[a.type]=[]; groups[a.type].push(a); });

  let html = '';
  Object.entries(groups).sort((a,b)=>(typeOrder[a[0]]||9)-(typeOrder[b[0]]||9)).forEach(([type,list]) => {
    html += `<div style="font-size:11px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin:14px 0 8px">${typeLabels[type]||type}</div>`;
    list.forEach(a => {
      const bal = balances[a.id] || 0;
      html += `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="flex:1;font-size:13px">${esc(a.name)}</span>
        <span style="font-size:12px;color:var(--text3);width:110px;text-align:right">Atual: ${fmtBRL(bal)}</span>
        <input type="number" class="inp" step="0.01"
          id="ob-${a.id}" placeholder="Saldo correto"
          style="width:160px;padding:5px 8px;font-size:13px"
          title="Deixe em branco se já estiver correto">
      </div>`;
    });
  });

  G('opening-balance-fields').innerHTML = html;
  G('opening-balance-fields').querySelectorAll('input[type="number"]').forEach(setupCurrencyInput);
  openModal('modal-opening-balance');
}

async function saveOpeningBalances() {
  const today = todayStr();
  const accs  = await ff.listAccounts();
  let adjustCount = 0;

  for (const a of accs) {
    const inp = G('ob-' + a.id);
    if (!inp || inp.value.trim() === '') continue;
    const target  = inp.rawValue ? inp.rawValue() : parseFloat(inp.value);
    if (isNaN(target)) continue;
    const current = await ff.getBalance(a.id);
    const diff    = target - current;
    if (Math.abs(diff) < 0.01) continue;

    await ff.createTx({
      account_id: a.id,
      date:       today,
      category:   'Categoria',
      memo:       'Ajuste de saldo inicial',
      amount:     diff,
      cleared:    1,
    });
    adjustCount++;
  }

  closeModal('modal-opening-balance');
  await loadAccounts();
  if (currentPage === 'account') refreshAccount();
  if (currentPage === 'overview') refreshOverview();
  toast(adjustCount > 0 ? `${adjustCount} ajuste(s) aplicado(s)` : 'Nenhum ajuste necessário');
}
function openRecurringModal(editRec){
  G('trend-cat-modal')?.remove();
  closeGlobalSearch();
  const isEdit = !!editRec;
  if (G('rec-modal-title')) G('rec-modal-title').textContent = isEdit ? 'Editar recorrência' : 'Nova recorrência';
  if (G('rec-editing-id')) G('rec-editing-id').value = isEdit ? editRec.id : '';
  G('rec-account').value  = isEdit ? editRec.account_id : (accounts[0]?.id||'');
  G('rec-memo').value     = isEdit ? (editRec.memo||'') : '';
  G('rec-category').value = isEdit ? (editRec.category||'') : '';
  G('rec-freq').value     = isEdit ? (editRec.frequency||'monthly') : 'monthly';
  setupCurrencyInput(G('rec-expense'));
  G('rec-expense').setValue?.(null);
  setupCurrencyInput(G('rec-income'));
  G('rec-income').setValue?.(null);
  if (isEdit) {
    if (editRec.amount < 0) G('rec-expense').setValue?.(Math.abs(editRec.amount));
    else G('rec-income').setValue?.(editRec.amount);
  }
  G('rec-next').value = isEdit ? (editRec.next_date||todayStr()) : todayStr();
  if (G('rec-end')) G('rec-end').value = isEdit ? (editRec.end_date||'') : '';
  // Populate transfer-to dropdown
  const trSel = G('rec-transfer-to');
  if (trSel) {
    trSel.innerHTML = accounts.map(a=>`<option value="${a.id}">${esc(a.name)}</option>`).join('');
    if (isEdit && editRec.transfer_to_account_id) trSel.value = String(editRec.transfer_to_account_id);
  }
  // Show/hide transfer row based on category
  _updateRecTransferRow();
  // Hook category input to toggle row live
  const catInp = G('rec-category');
  if (catInp && !catInp._recTransferHooked) {
    catInp._recTransferHooked = true;
    catInp.addEventListener('input', _updateRecTransferRow);
    catInp.addEventListener('change', _updateRecTransferRow);
  }
  openModal('modal-recurring');
}
function _updateRecTransferRow() {
  const cat = (G('rec-category')?.value||'').trim();
  const isTransfer = /^transferên/i.test(cat);
  if (G('rec-transfer-row')) G('rec-transfer-row').style.display = isTransfer ? '' : 'none';
}
async function saveRecurring(){
  const editingId = G('rec-editing-id')?.value ? parseInt(G('rec-editing-id').value) : null;
  const account_id = parseInt(G('rec-account').value);
  const memo       = G('rec-memo').value.trim();
  const category   = G('rec-category').value.trim();
  const expVal     = G('rec-expense').rawValue ? G('rec-expense').rawValue() : parseFloat(G('rec-expense').value)||0;
  const incVal     = G('rec-income').rawValue ? G('rec-income').rawValue() : parseFloat(G('rec-income').value)||0;
  const amount     = expVal>0?-expVal:incVal;
  const frequency  = G('rec-freq').value;
  const next_date  = G('rec-next').value;
  const end_date   = G('rec-end')?.value || null;
  const isTransfer = /^transferên/i.test(category);
  const transfer_to_account_id = isTransfer ? (parseInt(G('rec-transfer-to')?.value)||null) : null;
  if (!memo){ toast('Informe o memorando'); return; }
  if (amount===0){ toast('Informe o valor (despesa ou receita)'); return; }
  if (!next_date){ toast('Informe a data inicial'); return; }
  if (isTransfer && (!transfer_to_account_id || transfer_to_account_id === account_id)) { toast('Selecione uma conta destino diferente da origem'); return; }
  closeModal('modal-recurring');
  if (editingId) {
    const result = await ff.updateRecurring({ id:editingId, account_id, memo, category, amount, frequency, next_date, end_date, transfer_to_account_id });
    const n = result?.generated ?? 0;
    toast(`Recorrência atualizada — ${n} lançamentos futuros regenerados`);
  } else {
    if (_licStatus?.status === 'payment_required') {
    toast('⚠️ Licença necessária para criar recorrências. Acesse Configurações → Licença.');
    return;
  }
  const result = await ff.createRecurring({ account_id, memo, category, amount, frequency, next_date, end_date, transfer_to_account_id });
    const n = result?.generated ?? 0;
    const endMsg = end_date ? ` até ${fmtDate(end_date)}` : ' (indefinida, 5 anos à frente)';
    toast(`Recorrência criada — ${n} lançamentos gerados${endMsg}`);
  }
  await loadAccounts();
  if (currentPage === 'account' && currentAccountId === account_id) refreshAccount();
  refreshRecurring();
}

let _recSortCol = 'memo';
let _recSortDir = 'asc';

async function refreshRecurring(){
  const list = await ff.listRecurring();
  if (!list.length){ G('recurring-list').innerHTML='<div class="empty"><div class="ei"><svg width="48" height="48" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="color:var(--text3)"><path d="M13 8A5 5 0 0 1 3 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><polyline points="1.5,6.5 3,8 4.5,6.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M3 8A5 5 0 0 1 13 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><polyline points="11.5,9.8 13,8 14.5,9.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg></div><p>Sem recorrências</p></div>'; return; }
  const freqLbl = { weekly:'Semanal', biweekly:'Quinzenal', monthly:'Mensal', bimonthly:'Bimestral', quarterly:'Trimestral', yearly:'Anual' };

  // Sort
  const cols = { conta: r=>accounts.find(a=>a.id===r.account_id)?.name||'', memo: r=>r.memo||'', category: r=>r.category||'', frequency: r=>r.frequency||'', next_date: r=>r.next_date||'', end_date: r=>r.end_date||'z', amount: r=>Math.abs(r.amount) };
  const sorted = [...list].sort((a,b) => {
    const fn = cols[_recSortCol] || cols.memo;
    const av = fn(a), bv = fn(b);
    const cmp = typeof av === 'number' ? av-bv : (av+'').localeCompare(bv+'','pt-BR');
    return _recSortDir === 'asc' ? cmp : -cmp;
  });

  function thSort(col, label) {
    const active = _recSortCol === col;
    const arrow = active ? (_recSortDir==='asc'?' ↑':' ↓') : '';
    return `<th style="cursor:pointer;user-select:none${active?';color:var(--accent)':''}" onclick="sortRecurring('${col}')">${label}${arrow}</th>`;
  }

  let html = `<div class="tbl-card"><div class="tbl-outer"><table class="ledger"><thead><tr>
    ${thSort('conta','Conta')}${thSort('memo','Memorando')}${thSort('category','Categoria')}${thSort('frequency','Frequência')}${thSort('next_date','Próxima')}${thSort('end_date','Término')}
    <th class="right" style="cursor:pointer;user-select:none${_recSortCol==='amount'?';color:var(--accent)':''}" onclick="sortRecurring('amount')">Despesa${_recSortCol==='amount'?(_recSortDir==='asc'?' ↑':' ↓'):''}  </th>
    <th class="right">Receita</th><th></th></tr></thead><tbody>`;

  sorted.forEach(r => {
    const acc = accounts.find(a=>a.id===r.account_id);
    const exp = r.amount<0?fmtBRL(Math.abs(r.amount)):'';
    const inc = r.amount>=0?fmtBRL(r.amount):'';
    const recJson = esc2(JSON.stringify(r));
    html += `<tr>
      <td style="font-size:13px">${esc(acc?.name||'?')}</td>
      <td>${esc(r.memo)}</td>
      <td style="font-size:12px">${esc(r.category)}</td>
      <td style="font-size:12px;color:var(--text2)">${freqLbl[r.frequency]||r.frequency}</td>
      <td style="font-size:12px;color:var(--text2)">${fmtDate(r.next_date)}</td>
      <td style="font-size:12px;color:var(--text3)">${r.end_date?fmtDate(r.end_date):'Indefinida'}</td>
      <td class="amt-exp">${exp}</td><td class="amt-inc">${inc}</td>
      <td class="center" style="white-space:nowrap">
        <button class="btn-icon" onclick='editRecurring(${r.id})' title="Editar">✎</button>
        <button class="btn-icon" onclick="deleteRecurring(${r.id})" title="Excluir" style="color:var(--red)">🗑</button>
      </td>
    </tr>`;
  });
  G('recurring-list').innerHTML = html+'</tbody></table></div></div>';
}
function sortRecurring(col) {
  if (_recSortCol === col) _recSortDir = _recSortDir === 'asc' ? 'desc' : 'asc';
  else { _recSortCol = col; _recSortDir = 'asc'; }
  refreshRecurring();
}
async function editRecurring(id) {
  const list = await ff.listRecurring();
  const rec = list.find(r=>r.id===id);
  if (!rec) return;
  openRecurringModal(rec);
}
async function deleteRecurring(id){
  if(!await showConfirmDialog('Remover recorrência?', 'Seus lançamentos futuros não conciliados serão removidos.', 'Remover', true)) return;
  await ff.deleteRecurring(id);
  await loadAccounts();
  refreshRecurring();
  toast('Recorrência removida');
}

// ══ CATEGORY DROPDOWN ══
let _catKb={};
let _globalCatActiveInput = null; // currently focused cat input

function openCatDrop(inputId, dropId) {
  // For import table: use the global fixed dropdown
  const isImport = inputId && inputId.startsWith('import-cat-');
  if (isImport) {
    openGlobalCatDrop(G(inputId));
    return;
  }
  // Original behavior for other cat dropdowns
  const q=G(inputId)?.value||'', nq=norm(q), drop=G(dropId); if(!drop) return;
  let html='';
  if (!nq) {
    const seen=new Set();
    CATS_RAW.forEach(c=>{ const top=c.split(':')[0]; if(!seen.has(top)){seen.add(top);html+=`<div class="cat-section">${esc(top)}</div>`;} if(c.includes(':')) html+=`<div class="cat-opt" onmousedown="pickCat('${inputId}','${dropId}','${esc2(c)}')">${esc(c.split(':').slice(1).join(':'))}</div>`; else html+=`<div class="cat-opt" onmousedown="pickCat('${inputId}','${dropId}','${esc2(c)}')">${esc(c)}</div>`; });
  } else {
    const hits=CATS_RAW.filter(c=>norm(c).includes(nq));
    if (!hits.length) html='<div class="cat-opt" style="color:var(--text3);cursor:default">Sem resultado</div>';
    else hits.forEach(c=>{ html+=`<div class="cat-opt" onmousedown="pickCat('${inputId}','${dropId}','${esc2(c)}')">${esc(c)}</div>`; });
  }
  drop.innerHTML=html; drop.style.display='block'; _catKb[dropId]=-1;
}

let _globalCatKbIdx = -1;

function openGlobalCatDrop(inputEl) {
  if (!inputEl) return;
  _globalCatActiveInput = inputEl;
  _globalCatKbIdx = -1;
  const drop = G('global-cat-drop');
  if (!drop) return;
  const q = inputEl.value || '', nq = norm(q);
  // Build transfer category options from existing accounts
  const transferOpts = accounts
    .filter(a => !a.hidden)
    .map(a => `⇄ Transferência: ${a.name}`);

  let html = '';
  if (!nq) {
    html += `<div class="cat-section">Transferências</div>`;
    transferOpts.forEach(t => {
      html += `<div class="cat-opt" style="color:var(--accent)" onmousedown="pickGlobalCat('${esc2(t)}')">${esc(t)}</div>`;
    });
    const seen = new Set();
    CATS_RAW.forEach(c => {
      const top = c.split(':')[0];
      if (!seen.has(top)) { seen.add(top); html += `<div class="cat-section">${esc(top)}</div>`; }
      html += `<div class="cat-opt" onmousedown="pickGlobalCat('${esc2(c)}')">${esc(c)}</div>`;
    });
  } else {
    const tfHits = transferOpts.filter(t => norm(t).includes(nq));
    tfHits.forEach(t => {
      html += `<div class="cat-opt" style="color:var(--accent)" onmousedown="pickGlobalCat('${esc2(t)}')">${esc(t)}</div>`;
    });
    const hits = CATS_RAW.filter(c => norm(c).includes(nq));
    if (!hits.length && !tfHits.length) html = `<div class="cat-opt" style="color:var(--text3);cursor:default">Sem resultado</div>`;
    else hits.forEach(c => { html += `<div class="cat-opt" onmousedown="pickGlobalCat('${esc2(c)}')">${esc(c)}</div>`; });
  }
  drop.innerHTML = html;
  const rect = inputEl.getBoundingClientRect();
  drop.style.top  = (rect.bottom + 2) + 'px';
  drop.style.left = rect.left + 'px';
  drop.style.width = Math.max(rect.width, 260) + 'px';
  drop.style.display = 'block';

  // Attach keyboard handler — remove first to prevent duplicates
  inputEl.removeEventListener('keydown', globalCatKeydown);
  inputEl.addEventListener('keydown', globalCatKeydown);

  // Close dropdown on blur (e.g. Tab moving focus away without selecting)
  // Use setTimeout so mousedown on a cat-opt fires before blur closes the list
  inputEl.removeEventListener('blur', _globalCatBlurHandler);
  inputEl.addEventListener('blur', _globalCatBlurHandler);
}

function _globalCatBlurHandler() {
  setTimeout(() => {
    const drop = G('global-cat-drop');
    // Only close if focus has moved away from both the input and the dropdown
    if (drop && drop.style.display !== 'none') {
      const active = document.activeElement;
      if (!drop.contains(active) && active !== _globalCatActiveInput) {
        drop.style.display = 'none';
        _globalCatKbIdx = -1;
      }
    }
  }, 120);
}

function globalCatKeydown(e) {
  const drop = G('global-cat-drop');
  if (!drop || drop.style.display === 'none') return;
  const opts = [...drop.querySelectorAll('.cat-opt')].filter(o => !o.style.cursor || o.style.cursor !== 'default');
  if (!opts.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _globalCatKbIdx = Math.min(_globalCatKbIdx + 1, opts.length - 1);
    opts.forEach(o => o.classList.remove('kb-active'));
    opts[_globalCatKbIdx].classList.add('kb-active');
    opts[_globalCatKbIdx].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _globalCatKbIdx = Math.max(_globalCatKbIdx - 1, 0);
    opts.forEach(o => o.classList.remove('kb-active'));
    opts[_globalCatKbIdx].classList.add('kb-active');
    opts[_globalCatKbIdx].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    if (_globalCatKbIdx >= 0) {
      // Item selected via keyboard navigation — pick it
      e.preventDefault();
      e.stopPropagation();
      const chosen = opts[_globalCatKbIdx];
      if (chosen) {
        const m = chosen.getAttribute('onmousedown')?.match(/pickGlobalCat\('(.+?)'\)/);
        if (m) pickGlobalCat(m[1]);
        else { if (_globalCatActiveInput) _globalCatActiveInput.value = chosen.textContent; drop.style.display = 'none'; }
      }
    } else {
      // Tab/Enter without navigation — just close the dropdown
      drop.style.display = 'none';
      _globalCatKbIdx = -1;
      // For Tab, let the browser move focus normally (don't preventDefault)
    }
  } else if (e.key === 'Escape') {
    drop.style.display = 'none';
    _globalCatKbIdx = -1;
  }
}

function pickGlobalCat(val) {
  const clean = val.replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const drop = G('global-cat-drop');
  if (drop) drop.style.display = 'none';
  _globalCatKbIdx = -1;

  // Detect transfer category → open transfer modal instead
  const tfMatch = clean.match(/^⇄ Transferência: (.+)$/);
  if (tfMatch) {
    const destName = tfMatch[1];
    const destAcc = accounts.find(a => a.name === destName);
    // Set the input to show the transfer label (for display only)
    if (_globalCatActiveInput) {
      _globalCatActiveInput.value = clean;
      _globalCatActiveInput.dataset.isTransfer = '1';
      _globalCatActiveInput.dataset.transferDest = destAcc?.id || '';
    }
    // Open transfer modal pre-filled
    openTransferFromCat(destAcc);
    return;
  }

  if (_globalCatActiveInput) {
    _globalCatActiveInput.value = clean;
    _globalCatActiveInput.dataset.isTransfer = '';
    _globalCatActiveInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// Open transfer modal pre-filled from a category selection context
function openTransferFromCat(destAcc) {
  setupCurrencyInput(G('tr-amount'));
  G('tr-amount').setValue?.(null);
  G('tr-memo').value = '';
  G('tr-date').value = todayStr();

  // Determine source account: current account context OR the tx-account field
  const srcId = currentAccountId || parseInt(G('tx-account')?.value) || null;

  // Pre-select accounts
  const fromSel = G('tr-from');
  const toSel   = G('tr-to');
  if (fromSel && srcId)   fromSel.value = String(srcId);
  if (toSel   && destAcc) toSel.value   = String(destAcc.id);

  // Pre-fill date/memo/amount from the active new-tx form if values exist
  const txDate = G('tx-date')?.value;
  const txMemo = G('tx-memo')?.value;
  const txExp  = G('tx-expense')?.rawValue?.() || 0;
  const txInc  = G('tx-income')?.rawValue?.()  || 0;
  const txAmt  = txExp > 0 ? txExp : txInc;
  if (txDate) G('tr-date').value = txDate;
  if (txMemo) G('tr-memo').value = txMemo;
  if (txAmt > 0) G('tr-amount').setValue?.(txAmt);

  // Also try inline edit row (overrides form values if found)
  const inp = _globalCatActiveInput;
  if (inp) {
    const row = inp.closest('tr[data-id]');
    if (row) {
      const txId = parseInt(row.dataset.id);
      const tx = window._lastTxs?.find(t => t.id === txId);
      if (tx) {
        G('tr-amount').setValue?.(Math.abs(tx.amount));
        G('tr-date').value = tx.date || todayStr();
        G('tr-memo').value = tx.memo || '';
      }
      // Store origin tx id for deletion after save
      let hidField = G('tr-origin-tx-id');
      if (!hidField) {
        hidField = document.createElement('input');
        hidField.type = 'hidden'; hidField.id = 'tr-origin-tx-id';
        G('modal-transfer')?.appendChild(hidField);
      }
      hidField.value = row.dataset.id || '';
    }
  }

  openModal('modal-transfer');
}

function swapTransferAccounts() {
  const fromSel = G('tr-from');
  const toSel   = G('tr-to');
  if (!fromSel || !toSel) return;
  const tmp = fromSel.value;
  fromSel.value = toSel.value;
  toSel.value   = tmp;
}

// Close global cat drop on outside click
document.addEventListener('mousedown', e => {
  const drop = G('global-cat-drop');
  if (drop && drop.style.display !== 'none') {
    if (!drop.contains(e.target) && e.target !== _globalCatActiveInput) {
      drop.style.display = 'none';
      _globalCatKbIdx = -1;
    }
  }
});

function closeCatDrop(id){ setTimeout(()=>{ const d=G(id); if(d) d.style.display='none'; },180); }
function pickCat(inp,drop,val){ G(inp).value=val.replace(/&#39;/g,"'").replace(/&amp;/g,'&'); G(drop).style.display='none'; }
function catKey(e,dropId,inputId){
  const drop=G(dropId); if(!drop||drop.style.display!=='block') return;
  const opts=drop.querySelectorAll('.cat-opt'); if(!opts.length) return;
  if(e.key==='Escape'){drop.style.display='none';return;}
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){
    e.preventDefault();
    const cur=_catKb[dropId]??-1;
    const next=e.key==='ArrowDown'?(cur+1)%opts.length:cur<=0?opts.length-1:cur-1;
    opts.forEach(o=>o.classList.remove('kb-active')); opts[next].classList.add('kb-active'); opts[next].scrollIntoView({block:'nearest'}); _catKb[dropId]=next;
  }
  if(e.key==='Enter'||e.key==='Tab'){
    const cur=_catKb[dropId];
    if(cur>=0&&opts[cur]){e.preventDefault();e.stopPropagation();opts[cur].dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));_catKb[dropId]=-1;}
  }
}

// ══ MODALS ══
// ── Custom confirm dialog (replaces window.confirm to avoid Electron UI freeze) ──
let _confirmResolve = null;
function showConfirmDialog(title, detail = '', okLabel = 'Confirmar', danger = false) {
  return new Promise(resolve => {
    _confirmResolve = resolve;
    const el = G('modal-confirm');
    if (!el) { resolve(true); return; }
    G('modal-confirm-title').textContent  = title;
    G('modal-confirm-detail').textContent = detail;
    const okBtn = G('modal-confirm-ok');
    okBtn.textContent = okLabel;
    okBtn.className = danger ? 'btn danger' : 'btn primary';
    el.classList.add('open');
    // Focus the cancel button for safety
    setTimeout(() => G('modal-confirm-cancel')?.focus(), 50);
  });
}
function confirmDialogResolve(result) {
  closeModal('modal-confirm');
  if (_confirmResolve) { _confirmResolve(result); _confirmResolve = null; }
}
document.addEventListener('keydown', e => {
  if (!G('modal-confirm')?.classList.contains('open')) return;
  if (e.key === 'Escape') { e.preventDefault(); confirmDialogResolve(false); }
  if (e.key === 'Enter')  { e.preventDefault(); confirmDialogResolve(true);  }
});

function openModal(id){ G(id)?.classList.add('open'); }
function closeModal(id){
  const el = G(id);
  if (!el) return;
  // Blur only elements strictly inside this modal
  const focused = el.querySelector(':focus');
  if (focused) focused.blur();
  el.classList.remove('open');
  // Never call document.body.focus() — it freezes subsequent input
}
document.addEventListener('click',e=>{ if(e.target.classList.contains('overlay')) closeModal(e.target.id); });






// ══ LANGUAGE / I18N ENGINE ══

const STRINGS = {
  // ── Navigation ──
  nav_overview:         { pt: 'Visão Geral',      en: 'Overview' },
  nav_import:           { pt: 'Importar',          en: 'Import' },
  nav_search:           { pt: 'Busca avançada',    en: 'Advanced Search' },
  nav_goals:            { pt: 'Metas',             en: 'Goals' },
  nav_budget:           { pt: 'Orçamento',         en: 'Budget' },
  nav_recurring:        { pt: 'Recorrências',      en: 'Recurring' },
  nav_evolucao:         { pt: 'Evolução',          en: 'Evolution' },
  nav_patrimonio:       { pt: 'Patrimônio',        en: 'Net Worth' },
  nav_categories:       { pt: 'Categorias',        en: 'Categories' },
  nav_ml:               { pt: 'Aprendizado ML',    en: 'ML Learning' },
  nav_backup:           { pt: 'Configurações',     en: 'Settings' },
  nav_reports:          { pt: 'Relatórios',        en: 'Reports' },

  // ── Page titles ──
  page_overview:        { pt: 'Visão Geral',       en: 'Overview' },
  page_import:          { pt: 'Importar',           en: 'Import' },
  page_search:          { pt: 'Busca avançada',    en: 'Advanced Search' },
  page_goals:           { pt: 'Metas',             en: 'Goals' },
  page_budget:          { pt: 'Orçamento',         en: 'Budget' },
  page_recurring:       { pt: 'Recorrências',      en: 'Recurring' },
  page_evolucao:        { pt: 'Evolução',          en: 'Evolution' },
  page_patrimonio:      { pt: 'Patrimônio',        en: 'Net Worth' },
  page_categories:      { pt: 'Categorias',        en: 'Categories' },
  page_ml:              { pt: 'Aprendizado ML',    en: 'ML Learning' },
  page_backup:          { pt: 'Configurações',     en: 'Settings' },
  page_returns:         { pt: 'Rentabilidade',     en: 'Returns' },

  // ── Tour ──
  btn_next:             { pt: 'Próximo',           en: 'Next' },
  btn_back:             { pt: 'Voltar',            en: 'Back' },
  tour_finish:          { pt: 'Concluir',          en: 'Finish' },
  tour_step_of:         { pt: 'Passo',             en: 'Step' },
  tour_of:              { pt: 'de',                en: 'of' },

  // ── Context menu ──
  ctx_duplicate:        { pt: 'Duplicar',          en: 'Duplicate' },
  ctx_duplicate_today:  { pt: 'Duplicar com data de hoje', en: 'Duplicate with today\'s date' },
  ctx_mark_cleared:     { pt: 'Marcar como conferida',     en: 'Mark as cleared' },
  ctx_unmark_cleared:   { pt: 'Desmarcar conferida',       en: 'Unmark cleared' },
  ctx_create_recurring: { pt: 'Criar recorrência',         en: 'Create recurring' },
  ctx_delete:           { pt: 'Excluir',                   en: 'Delete' },

  // ── Transfer modal ──
  transfer_title:       { pt: 'Nova transferência',        en: 'New transfer' },
  transfer_from:        { pt: 'De',                        en: 'From' },
  transfer_to:          { pt: 'Para',                      en: 'To' },

  // ── Transaction modal ──
  tx_memo:              { pt: 'Memorando',                 en: 'Memo' },
  search_placeholder:   { pt: 'Buscar lançamentos…',      en: 'Search transactions…' },

  // ── Account table columns ──
  col_date:             { pt: 'Data',          en: 'Date' },
  col_memo:             { pt: 'Memorando',     en: 'Memo' },
  col_category:         { pt: 'Categoria',     en: 'Category' },
  col_expense:          { pt: 'Despesa',       en: 'Expense' },
  col_income:           { pt: 'Receita',       en: 'Income' },
  col_balance:          { pt: 'Saldo',         en: 'Balance' },

  // ── Buttons ──
  btn_save:             { pt: 'Salvar',        en: 'Save' },
  btn_cancel:           { pt: 'Cancelar',      en: 'Cancel' },
  btn_confirm:          { pt: 'Confirmar',     en: 'Confirm' },
  btn_delete:           { pt: 'Excluir',       en: 'Delete' },
  btn_close:            { pt: 'Fechar',        en: 'Close' },
  btn_new:              { pt: 'Novo',          en: 'New' },
  btn_edit:             { pt: 'Editar',        en: 'Edit' },
  btn_import:           { pt: 'Importar',      en: 'Import' },
  btn_export:           { pt: 'Exportar',      en: 'Export' },
  btn_add:              { pt: 'Adicionar',     en: 'Add' },
  btn_update:           { pt: 'Atualizar',     en: 'Update' },
  btn_generate:         { pt: 'Gerar',         en: 'Generate' },

  // ── Overview ──
  lbl_income:           { pt: 'Receitas',      en: 'Income' },
  lbl_expenses:         { pt: 'Despesas',      en: 'Expenses' },
  lbl_balance:          { pt: 'Saldo',         en: 'Balance' },
  lbl_net_worth:        { pt: 'Patrimônio',    en: 'Net Worth' },
  lbl_month:            { pt: 'Mês',           en: 'Month' },

  // ── Import ──
  lbl_bank_statement:   { pt: 'Extrato bancário',         en: 'Bank statement' },
  lbl_card_statement:   { pt: 'Fatura de cartão',         en: 'Card statement' },
  lbl_broker_statement: { pt: 'Extrato de corretora',     en: 'Broker statement' },
  lbl_confirm_import:   { pt: 'Confirmar importação',     en: 'Confirm import' },
  lbl_cancel_import:    { pt: 'Cancelar',                 en: 'Cancel' },
  lbl_duplicates:       { pt: 'Duplicatas detectadas',    en: 'Duplicates detected' },

  // ── Net Worth ──
  lbl_fixed_assets:     { pt: 'Patrimônio imobilizado',   en: 'Fixed assets' },
  lbl_investments:      { pt: 'Investimentos financeiros', en: 'Financial investments' },
  lbl_debt:             { pt: 'Saldo devedor',            en: 'Outstanding balance' },
  lbl_financing:        { pt: 'Financiamento',            en: 'Financing' },
  lbl_projection:       { pt: 'Projeção',                 en: 'Projection' },
  lbl_irr_nominal:      { pt: 'TIR Nominal',              en: 'Nominal IRR' },
  lbl_irr_real:         { pt: 'TIR Real',                 en: 'Real IRR' },
  lbl_gain_loss:        { pt: 'Ganho/Perda',              en: 'Gain/Loss' },
  lbl_cash_flow:        { pt: 'Fluxo de caixa',          en: 'Cash flow' },
  lbl_benchmark:        { pt: 'Benchmark',                en: 'Benchmark' },
  lbl_hidden:           { pt: 'Oculto',                   en: 'Hidden' },
  lbl_financed:         { pt: 'Financiado',               en: 'Financed' },
  lbl_sold:             { pt: 'Encerrado',                en: 'Closed' },

  // ── Financing ──
  lbl_amort_system:     { pt: 'Sistema de amortização',   en: 'Amortization system' },
  lbl_correction_index: { pt: 'Índice de correção',       en: 'Correction index' },
  lbl_annual_rate:      { pt: 'Taxa de juros nominal (% a.a.)', en: 'Nominal interest rate (% p.a.)' },
  lbl_principal:        { pt: 'Valor financiado (R$)',    en: 'Financed amount (R$)' },
  lbl_installments:     { pt: 'Nº de parcelas mensais',   en: 'Number of monthly installments' },
  lbl_first_payment:    { pt: 'Primeira parcela',         en: 'First payment' },
  lbl_balloon:          { pt: 'Entrada / chaves (R$)',    en: 'Down payment / keys (R$)' },
  lbl_asset_value:      { pt: 'Valor total do imóvel/ativo (R$)', en: 'Total asset value (R$)' },
  lbl_generate_schedule:{ pt: '⚙️ Gerar cronograma',      en: '⚙️ Generate schedule' },
  lbl_update_indexes:   { pt: '📡 Atualizar índices (TR/IGP-M/INCC)', en: '📡 Update indexes (TR/IGP-M/INCC)' },
  lbl_proj_warning:     { pt: '⚠️ As parcelas futuras são uma projeção em valores constantes (sem correção monetária futura), calculada para referência. O saldo devedor só será reduzido conforme o registro de parcelas pagas nas contas bancárias.',
                          en: '⚠️ Future installments are a projection in constant values (no future monetary correction), for reference only. The outstanding balance only decreases when paid installments are recorded in bank accounts.' },

  // ── Budget ──
  lbl_budget_limit:     { pt: 'Limite mensal',    en: 'Monthly limit' },
  lbl_budget_alert:     { pt: 'Alerta em',        en: 'Alert at' },
  lbl_over_budget:      { pt: 'Acima do limite',  en: 'Over limit' },
  lbl_within_budget:    { pt: 'Dentro do orçamento', en: 'Within budget' },

  // ── Goals ──
  lbl_goal_target:      { pt: 'Valor-alvo',          en: 'Target amount' },
  lbl_goal_monthly:     { pt: 'Economia mensal',     en: 'Monthly savings' },
  lbl_goal_emergency:   { pt: 'Reserva de emergência', en: 'Emergency fund' },
  lbl_goal_deadline:    { pt: 'Prazo',               en: 'Deadline' },
  lbl_goal_progress:    { pt: 'Progresso',           en: 'Progress' },

  // ── Settings ──
  lbl_language:         { pt: 'Idioma',              en: 'Language' },
  lbl_password:         { pt: 'Senha',               en: 'Password' },
  lbl_data_folder:      { pt: 'Pasta de dados',      en: 'Data folder' },
  lbl_backup:           { pt: 'Backup',              en: 'Backup' },
  lbl_restore:          { pt: 'Restaurar backup',    en: 'Restore backup' },
  lbl_change_folder:    { pt: 'Alterar pasta',       en: 'Change folder' },
  lbl_current_password: { pt: 'Senha atual',         en: 'Current password' },
  lbl_new_password:     { pt: 'Nova senha',          en: 'New password' },
  lbl_confirm_password: { pt: 'Confirmar senha',     en: 'Confirm password' },
  lbl_recovery_email:   { pt: 'Email de recuperação', en: 'Recovery email' },
  lbl_save_password:    { pt: 'Salvar senha',        en: 'Save password' },
  lbl_forgot_password:  { pt: 'Esqueci minha senha', en: 'Forgot password' },

  // ── Recurring ──
  lbl_frequency:        { pt: 'Frequência',          en: 'Frequency' },
  lbl_daily:            { pt: 'Diária',              en: 'Daily' },
  lbl_weekly:           { pt: 'Semanal',             en: 'Weekly' },
  lbl_biweekly:         { pt: 'Quinzenal',           en: 'Biweekly' },
  lbl_monthly:          { pt: 'Mensal',              en: 'Monthly' },
  lbl_annual:           { pt: 'Anual',               en: 'Annual' },

  // ── Common labels ──
  lbl_account:          { pt: 'Conta',               en: 'Account' },
  lbl_date:             { pt: 'Data',                en: 'Date' },
  lbl_amount:           { pt: 'Valor',               en: 'Amount' },
  lbl_category:         { pt: 'Categoria',           en: 'Category' },
  lbl_memo:             { pt: 'Memorando',           en: 'Memo' },
  lbl_description:      { pt: 'Descrição',           en: 'Description' },
  lbl_type:             { pt: 'Tipo',                en: 'Type' },
  lbl_status:           { pt: 'Status',              en: 'Status' },
  lbl_total:            { pt: 'Total',               en: 'Total' },
  lbl_new_transaction:  { pt: '+ Novo lançamento',   en: '+ New transaction' },
  lbl_new_account:      { pt: '+ Conta',             en: '+ Account' },
  lbl_transfer:         { pt: 'Transferência',       en: 'Transfer' },
  lbl_expense:          { pt: 'Despesa',             en: 'Expense' },
  lbl_income:           { pt: 'Receita',             en: 'Income' },
  lbl_cleared:          { pt: 'Conferido',           en: 'Cleared' },
  lbl_uncleared:        { pt: 'Não conferido',       en: 'Uncleared' },
  lbl_period:           { pt: 'Período',             en: 'Period' },
  lbl_search:           { pt: 'Buscar',              en: 'Search' },
  lbl_filter:           { pt: 'Filtrar',             en: 'Filter' },
  lbl_name:             { pt: 'Nome',                en: 'Name' },
  lbl_value:            { pt: 'Valor',               en: 'Value' },
  lbl_notes:            { pt: 'Observações',         en: 'Notes' },

  // ── Account types ──
  acct_bank:            { pt: 'Corrente',            en: 'Checking' },
  acct_savings:         { pt: 'Poupança',            en: 'Savings' },
  acct_credit:          { pt: 'Cartão de crédito',   en: 'Credit card' },
  acct_investment:      { pt: 'Investimento',        en: 'Investment' },
  acct_cash:            { pt: 'Dinheiro',            en: 'Cash' },
  acct_other:           { pt: 'Outro',               en: 'Other' },

  // ── Pat transaction types ──
  pat_rent:             { pt: 'Aluguel recebido',        en: 'Rent received' },
  pat_dividend:         { pt: 'Dividendo',               en: 'Dividend' },
  pat_jcp:              { pt: 'JCP',                     en: 'Interest on equity' },
  pat_contribution:     { pt: 'Aporte de capital',       en: 'Capital contribution' },
  pat_reduction:        { pt: 'Redução de capital',      en: 'Capital reduction' },
  pat_purchase:         { pt: 'Compra / Entrada',        en: 'Purchase / Entry' },
  pat_expense:          { pt: 'Despesa do ativo',        en: 'Asset expense' },
  pat_installment:      { pt: 'Parcela de financiamento', en: 'Financing installment' },
  pat_sale:             { pt: 'Venda',                   en: 'Sale' },

  // ── Toast / feedback messages ──
  msg_saved:            { pt: 'Salvo com sucesso',       en: 'Saved successfully' },
  msg_deleted:          { pt: 'Excluído',                en: 'Deleted' },
  msg_error:            { pt: 'Ocorreu um erro',         en: 'An error occurred' },
  msg_updated:          { pt: 'Atualizado',              en: 'Updated' },
  msg_imported:         { pt: 'Importado com sucesso',   en: 'Imported successfully' },
  msg_tx_created:       { pt: 'Lançamento criado',       en: 'Transaction created' },
  msg_tx_updated:       { pt: 'Lançamento atualizado',   en: 'Transaction updated' },
  msg_lang_pt:          { pt: '✅ Idioma alterado para Português', en: '✅ Language changed to English' },
  msg_indexes_updated:  { pt: '✅ Índices atualizados',  en: '✅ Indexes updated' },

  // ── Months ──
  month_jan:  { pt: 'Janeiro',   en: 'January' },
  month_feb:  { pt: 'Fevereiro', en: 'February' },
  month_mar:  { pt: 'Março',     en: 'March' },
  month_apr:  { pt: 'Abril',     en: 'April' },
  month_may:  { pt: 'Maio',      en: 'May' },
  month_jun:  { pt: 'Junho',     en: 'June' },
  month_jul:  { pt: 'Julho',     en: 'July' },
  month_aug:  { pt: 'Agosto',    en: 'August' },
  month_sep:  { pt: 'Setembro',  en: 'September' },
  month_oct:  { pt: 'Outubro',   en: 'October' },
  month_nov:  { pt: 'Novembro',  en: 'November' },
  month_dec:  { pt: 'Dezembro',  en: 'December' },
};

// ── Core translation function ──
function t(key) {
  const lang = window._lang || 'pt';
  const entry = STRINGS[key];
  if (!entry) return key; // fallback: return key itself
  return entry[lang] || entry['pt'] || key;
}

// ── Apply lang to DOM nodes directly (for JS-rendered content) ──
// Build reverse-lookup: PT string → {key, en}
let _ptToKey = null;
function buildPtLookup() {
  if (_ptToKey) return _ptToKey;
  _ptToKey = {};
  for (const [key, vals] of Object.entries(STRINGS)) {
    if (vals.pt) _ptToKey[vals.pt] = { key, en: vals.en || vals.pt };
  }
  return _ptToKey;
}

function setLanguage(lang) {
  const supported = ['pt','en','es'];
  window._lang = supported.includes(lang) ? lang : 'pt';
  _ptToKey = null; // reset cache on lang change
}

async function initLanguage() {
  try {
    const s = await ff.settingsGet();
    if (s?.language) {
      setLanguage(s.language);
    } else {
      const sys = navigator.language?.slice(0,2) || 'pt';
      setLanguage(['pt','en','es'].includes(sys) ? sys : 'pt');
    }
  } catch(e) { setLanguage('pt'); }
  applyTranslations();
}

async function changeLanguage(lang) {
  setLanguage(lang);
  try { await ff.settingsSave({ language: lang }); } catch(e) {}
  applyTranslations();
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
  const cur = G('lang-current');
  if (cur) cur.textContent = { pt:'Português selecionado', en:'English selected', es:'Español seleccionado' }[lang] || '';
  renderSidebar();
  if (currentPage) {
    const titles = {
      overview: t('page_overview'), reports: t('nav_reports'), import: t('page_import'),
      ml: t('page_ml'), recurring: t('page_recurring'), evolucao: t('page_evolucao'),
      patrimonio: t('page_patrimonio'), search: t('page_search'),
      goals: t('page_goals'), budget: t('page_budget'), categories: t('page_categories'),
      backup: t('page_backup'),
      aposentadoria: '🏖️ Aposentadoria',
    };
    if (G('page-title')) G('page-title').textContent = titles[currentPage] || currentPage;
  }
  toast(t('msg_lang_pt'));
}

function applyTranslations() {
  const lang = window._lang || 'pt';

  // 1. Elements with data-i18n attribute
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    const attr = el.dataset.i18nAttr || 'textContent';
    const val = t(key);
    if (attr === 'textContent') el.textContent = val;
    else if (attr === 'placeholder') el.placeholder = val;
    else if (attr === 'title') el.title = val;
  });

  // 2. Context menu items
  const ctxItems = {
    'ctx-item-duplicate':  t('ctx_duplicate'),
    'ctx-item-dup-today':  t('ctx_duplicate_today'),
    'ctx-item-cleared':    t('ctx_mark_cleared'),
    'ctx-item-uncleared':  t('ctx_unmark_cleared'),
    'ctx-item-recurring':  t('ctx_create_recurring'),
    'ctx-item-delete':     t('ctx_delete'),
  };
  Object.entries(ctxItems).forEach(([id, text]) => { const el=G(id); if(el) el.textContent=text; });

  // 3. Language button state
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
  const cur = G('lang-current');
  if (cur) cur.textContent = { pt:'Português selecionado', en:'English selected', es:'Español seleccionado' }[lang] || '';

  // 4. If EN: walk key DOM nodes and translate known PT strings
  if (lang !== 'pt') translateDOMStrings(lang);
}

// Walk visible text nodes and replace known PT strings with translations
function translateDOMStrings(lang) {
  const lookup = buildPtLookup();
  // Translate specific high-traffic elements by ID/class
  const targets = [
    'sidebar', 'page-title', 'import-page', 'page-overview',
    'page-budget', 'page-goals', 'page-recurring', 'page-backup',
    'page-evolucao', 'page-patrimonio', 'page-search', 'page-categories',
  ];
  targets.forEach(id => {
    const el = G(id);
    if (!el) return;
    translateNode(el, lookup, lang);
  });
}

function translateNode(root, lookup, lang) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      // Skip script/style/input nodes
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (['SCRIPT','STYLE','INPUT','TEXTAREA'].includes(tag)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const nodes = [];
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  nodes.forEach(n => {
    const text = n.textContent.trim();
    if (text.length < 2) return;
    const entry = lookup[text];
    if (entry && entry[lang]) n.textContent = n.textContent.replace(text, entry[lang]);
  });
}


// ══ TOUR DE BOAS-VINDAS (Etapa 6) ══
const TOUR_STEPS = [
  {
    icon: '👋',
    title: 'Bem-vindo ao Cruzeiro!',
    subtitle: 'Seu app de gestão financeira pessoal',
    body: `O Cruzeiro ajuda você a <strong>controlar gastos</strong>, acompanhar investimentos e gerir seu patrimônio — com seus dados <strong>100% privados no seu computador</strong>, nunca enviados para a nuvem.<br><br>
      Este tour apresenta todas as funcionalidades. Clique em <strong>Próximo</strong> para começar.`,
    target: null,
    page: 'overview',
    position: 'center',
  },
  {
    icon: '🏠',
    title: 'Visão Geral',
    subtitle: 'Seu painel financeiro mensal',
    body: `A <strong>Visão Geral</strong> mostra um resumo do mês: receitas, despesas, saldo líquido e gráficos de gastos por categoria.<br><br>
      Use o seletor de mês para navegar no histórico. Os gráficos se atualizam automaticamente conforme você registra lançamentos.`,
    target: '[data-page="overview"]',
    page: 'overview',
    position: 'right',
  },
  {
    icon: '🏦',
    title: 'Contas e lançamentos',
    subtitle: 'Registre todas as suas movimentações',
    body: `Clique em qualquer conta na barra lateral para ver seus lançamentos.<br><br>
      <strong>Dicas rápidas:</strong><br>
      • Duplo clique em qualquer campo para editar em linha<br>
      • <kbd>Tab</kbd> navega entre campos, <kbd>Del</kbd> exclui selecionados<br>
      • <kbd>Shift+clique</kbd> seleciona múltiplos lançamentos<br>
      • Alterne entre <strong>tabela e gráfico</strong> de saldo — inclusive com <strong>projeção futura</strong> baseada em recorrências.`,
    target: '#sidebar-accounts',
    page: 'overview',
    position: 'right',
  },
  {
    icon: '📥',
    title: 'Importar extratos',
    subtitle: 'Sem precisar digitar tudo manualmente',
    body: `Importe extratos de bancos e corretoras:<br><br>
      • <strong>Bancos:</strong> Itaú, BTG, XP e outros<br>
      • <strong>Corretoras:</strong> BTG Pactual, XP Investimentos<br><br>
      Na importação de corretoras, cada movimentação é classificada automaticamente como <strong>📥 Aporte/Resgate</strong> (fluxo externo de capital) ou <strong>💰 Rendimento/Custo</strong> (retorno do ativo). Você pode reclassificar qualquer item antes de confirmar, e o app memoriza suas correções para as próximas importações.`,
    target: '[data-page="import"]',
    page: 'import',
    position: 'right',
  },
  {
    icon: '💹',
    title: 'Investimentos — fluxos separados',
    subtitle: 'A distinção que garante cálculos corretos',
    body: `O Cruzeiro separa dois tipos de movimentação nos investimentos:<br><br>
      <strong>📥 Aporte/Resgate</strong> — compra, aporte, venda, amortização.<br>
      São fluxos <em>externos</em>: dinheiro que entra ou sai da sua carteira. <strong>Não representam performance</strong> — apenas mudam o tamanho do investimento.<br><br>
      <strong>💰 Rendimento/Custo</strong> — dividendo, juros, JCP, cupom, taxa.<br>
      São o <em>retorno real</em> gerado pelo ativo. <strong>Compõem a TIR e o TWR.</strong><br><br>
      Sem essa separação, um aporte de R$50.000 seria interpretado como "rendimento", distorcendo todos os cálculos de retorno.`,
    target: '[data-page="patrimonio"]',
    page: 'patrimonio',
    position: 'right',
  },
  {
    icon: '📊',
    title: 'TIR, TWR e benchmarks',
    subtitle: 'Meça o retorno real dos seus investimentos',
    body: `Para cada ativo o Cruzeiro calcula:<br><br>
      • <strong>TIR nominal</strong> — taxa interna de retorno em valores correntes<br>
      • <strong>TIR real</strong> — ajustada pelo IPCA (retorno acima da inflação)<br>
      • <strong>Ganho/Perda em R$</strong> — resultado absoluto<br>
      • <strong>Benchmark</strong> — diferença vs CDI ou IBOVESPA<br><br>
      O gráfico <strong>TWR</strong> (Time-Weighted Return) mostra o retorno puro da gestão, eliminando o efeito de aportes e resgates — a mesma metodologia usada por fundos de investimento.`,
    target: '[data-page="patrimonio"]',
    page: 'patrimonio',
    position: 'right',
  },
  {
    icon: '🏛️',
    title: 'Patrimônio — Bens imobilizados',
    subtitle: 'Imóveis, veículos e participações societárias',
    body: `Cadastre bens físicos e acompanhe valorização com correção por IPCA, IGP-M, INCC ou TR.<br><br>
      Cada ativo tem <strong>fluxo de caixa nominal e real</strong> com <strong>TIR automática</strong>. Vincule lançamentos bancários (aluguéis, dividendos, parcelas de financiamento…) ao ativo — eles são contabilizados automaticamente.<br><br>
      Para bens financiados, gere um <strong>cronograma completo</strong>: SAC, PRICE, SAM ou Planta — o saldo devedor reduz automaticamente quando você registra parcelas pagas.`,
    target: '[data-page="patrimonio"]',
    page: 'patrimonio',
    position: 'right',
  },
  {
    icon: '🏖️',
    title: 'Planejamento de Aposentadoria',
    subtitle: 'Projete sua independência financeira',
    body: `A aba <strong>Aposentadoria</strong> calcula quanto você precisa poupar por mês para alcançar sua meta:<br><br>
      • Defina uma <strong>meta de patrimônio</strong> ou <strong>renda mensal desejada</strong><br>
      • Informe sua idade atual e a desejada para aposentar<br>
      • O app busca automaticamente as <strong>taxas do Boletim Focus (BCB)</strong> para projeções realistas<br>
      • Compare a poupança <strong>necessária vs realizada</strong> mês a mês<br><br>
      Visualize em <strong>tabela</strong> (com % da meta por ano) ou <strong>gráficos</strong> de evolução patrimonial e poupança.`,
    target: '[data-page="aposentadoria"]',
    page: 'aposentadoria',
    position: 'right',
  },
  {
    icon: '🎯',
    title: 'Metas financeiras',
    subtitle: 'Planeje objetivos de curto e médio prazo',
    body: `Três tipos de meta:<br><br>
      <strong>💰 Valor-alvo</strong> — "Quero juntar R$ 50.000"<br>
      <strong>📅 Economia mensal</strong> — "Quero poupar R$ 2.000/mês"<br>
      <strong>🛡️ Reserva de emergência</strong> — "Quero 6 meses de gastos guardados"<br><br>
      O Cruzeiro calcula automaticamente quando você vai atingir cada meta.`,
    target: '[data-page="goals"]',
    page: 'goals',
    position: 'right',
  },
  {
    icon: '💰',
    title: 'Orçamento e Evolução',
    subtitle: 'Controle gastos e acompanhe tendências',
    body: `<strong>Orçamento:</strong> defina limites mensais por categoria. A barra muda de cor conforme você se aproxima:<br>
      🟢 Dentro → 🟡 Atenção (80%) → 🔴 Acima do limite<br><br>
      <strong>Evolução:</strong> visualize receitas e despesas ao longo do tempo, por categoria ou em resumo, em tabela ou gráficos. Filtre os anos e categorias que quiser analisar.`,
    target: '[data-page="budget"]',
    page: 'budget',
    position: 'right',
  },
  {
    icon: '🔄',
    title: 'Recorrências',
    subtitle: 'Lançamentos automáticos — e projeção de saldo',
    body: `Cadastre contas fixas e receitas recorrentes (aluguel, salário, mensalidades…).<br><br>
      O Cruzeiro gera lançamentos <strong>automaticamente</strong> no dia configurado. Ao editar o valor de uma recorrência, a mudança <strong>só afeta lançamentos futuros</strong> — os passados ficam intactos.<br><br>
      As recorrências alimentam também o <strong>gráfico de projeção de saldo</strong> nas contas.`,
    target: '[data-page="recurring"]',
    page: 'recurring',
    position: 'right',
  },
  {
    icon: '🔐',
    title: 'Segurança dos dados',
    subtitle: 'Criptografia AES-256-GCM',
    body: `Ao definir uma senha, o banco de dados é <strong>criptografado com AES-256-GCM</strong> — o padrão bancário. Sem a senha, o arquivo é completamente ilegível.<br><br>
      A recuperação de senha funciona via <strong>código enviado por email</strong>, sem comprometer a segurança. Um backup de emergência local também é criado automaticamente.<br><br>
      Seus dados ficam <strong>100% no seu computador</strong> — nunca em servidores externos.`,
    target: '[data-page="backup"]',
    page: 'backup',
    position: 'right',
  },
  {
    icon: '⚙️',
    title: 'Configurações e exportação',
    subtitle: 'Controle total sobre seus dados',
    body: `Na aba <strong>Configurações</strong> você pode:<br><br>
      • 🔐 Definir senha com criptografia AES-256<br>
      • 📁 Escolher onde salvar os dados (ex: Dropbox para sincronizar entre computadores)<br>
      • 💾 Fazer e restaurar backups manuais<br>
      • 📤 <strong>Exportar todos os dados</strong> em JSON ou CSV — para backup ou migração para outro app<br>
      • 🔑 Gerenciar sua licença`,
    target: '[data-page="backup"]',
    page: 'backup',
    position: 'right',
  },
  {
    icon: '🔑',
    title: 'Licença — gratuito para quem precisa',
    subtitle: 'Uma política justa e transparente',
    body: `O Cruzeiro é <strong>gratuito por 6 meses</strong> para todos.<br><br>
      Após esse período, permanece <strong>100% gratuito</strong> se você se enquadrar em qualquer um destes critérios:<br>
      • Renda média nos últimos 3 meses <strong>abaixo de R$3.000/mês</strong><br>
      • Despesa média nos últimos 3 meses <strong>abaixo de R$5.000/mês</strong><br>
      • Patrimônio total registrado <strong>abaixo de R$100.000</strong><br><br>
      Para os demais, a licença anual custa <strong>R$79/ano</strong> — menos de R$7/mês para ter controle completo das suas finanças.`,
    target: '[data-page="backup"]',
    page: 'backup',
    position: 'right',
    isLast: true,
  },
]

let _tourStep = 0;
let _tourHighlightEl = null;

async function startTour() {
  _tourStep = 0;
  G('tour-overlay').style.display = 'block';
  await tourShowStep(_tourStep);
}

async function tourNext() {
  _tourStep++;
  if (_tourStep >= TOUR_STEPS.length) {
    await tourFinish();
  } else {
    await tourShowStep(_tourStep);
  }
}

async function tourBack() {
  if (_tourStep > 0) {
    _tourStep--;
    await tourShowStep(_tourStep);
  }
}

async function tourSkip() {
  const msg = { pt:'Tem certeza que deseja pular o tour? Você pode acessá-lo novamente em Configurações.', en:'Are you sure you want to skip the tour? You can restart it in Settings.', es:'¿Seguro que deseas omitir el tour? Puedes reiniciarlo en Configuración.' };
  if (confirm(msg[_lang] || msg.pt)) {
    await tourFinish();
  }
}

async function tourFinish() {
  tourClearHighlight();
  G('tour-overlay').style.display = 'none';
  try { await ff.settingsSetTourDone(); } catch(e) {}
  toast('✅ Tour concluído! Bem-vindo ao Cruzeiro.');
}

async function tourShowStep(idx) {
  const step = TOUR_STEPS[idx];
  if (!step) return;

  // Navigate to the step's page
  if (step.page && step.page !== currentPage) {
    await goPage(step.page);
    await new Promise(r => setTimeout(r, 400)); // wait for page render
  }

  // Update card content
  G('tour-step-icon').textContent    = step.icon;
  G('tour-step-title').textContent   = step.title;
  G('tour-step-subtitle').textContent = `${t('tour_step_of')} ${idx + 1} ${t('tour_of')} ${TOUR_STEPS.length}`;
  G('tour-step-body').innerHTML      = step.body;

  // Dots
  const dots = TOUR_STEPS.map((_, i) =>
    `<div class="tour-dot ${i === idx ? 'active' : ''}"></div>`).join('');
  G('tour-dots').innerHTML = dots;

  // Buttons
  G('tour-back').style.display = idx > 0 ? '' : 'none';
  G('tour-back').textContent = `‹ ${t('btn_back')}`;
  G('tour-next').textContent = step.isLast ? t('tour_finish') : `${t('btn_next')} →`;
  // Show manual button on last step
  let manBtn = G('tour-manual-btn');
  if (step.isLast) {
    if (!manBtn) {
      manBtn = document.createElement('button');
      manBtn.id = 'tour-manual-btn';
      manBtn.className = 'btn';
      manBtn.textContent = '📖 Abrir manual';
      manBtn.onclick = openManual;
      manBtn.style.cssText = 'font-size:12px;padding:6px 12px';
      G('tour-footer')?.insertBefore(manBtn, G('tour-skip'));
    }
  } else if (manBtn) {
    manBtn.remove();
  }

  // Highlight target element
  tourClearHighlight();
  if (step.target) {
    const el = document.querySelector(step.target);
    if (el) {
      el.classList.add('tour-highlight');
      _tourHighlightEl = el;
      tourPositionSpotlight(el);
      tourPositionCard(el, step.position || 'right');
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      G('tour-spotlight').style.display = 'none';
      tourPositionCardCenter();
    }
  } else {
    G('tour-spotlight').style.display = 'none';
    tourPositionCardCenter();
  }
}

function tourPositionSpotlight(el) {
  const sp = G('tour-spotlight');
  const rect = el.getBoundingClientRect();
  const pad = 8;
  sp.style.display = 'block';
  sp.style.left   = (rect.left   - pad) + 'px';
  sp.style.top    = (rect.top    - pad) + 'px';
  sp.style.width  = (rect.width  + pad*2) + 'px';
  sp.style.height = (rect.height + pad*2) + 'px';
}

function tourPositionCard(targetEl, position) {
  const card = G('tour-card');
  const rect = targetEl.getBoundingClientRect();
  const cw = 360, ch = card.offsetHeight || 280;
  const vw = window.innerWidth, vh = window.innerHeight;
  const margin = 16;

  let left, top;

  if (position === 'right' && rect.right + cw + margin < vw) {
    left = rect.right + margin;
    top  = Math.max(margin, Math.min(rect.top, vh - ch - margin));
  } else if (position === 'left' && rect.left - cw - margin > 0) {
    left = rect.left - cw - margin;
    top  = Math.max(margin, Math.min(rect.top, vh - ch - margin));
  } else if (position === 'bottom' || rect.top < vh / 2) {
    left = Math.max(margin, Math.min(rect.left, vw - cw - margin));
    top  = rect.bottom + margin;
  } else {
    // above
    left = Math.max(margin, Math.min(rect.left, vw - cw - margin));
    top  = rect.top - ch - margin;
  }
  // clamp
  left = Math.max(margin, Math.min(left, vw - cw - margin));
  top  = Math.max(margin, Math.min(top, vh - ch - margin));

  card.style.left = left + 'px';
  card.style.top  = top  + 'px';
}

function tourPositionCardCenter() {
  const card = G('tour-card');
  card.style.left = '50%';
  card.style.top  = '50%';
  card.style.transform = 'translate(-50%,-50%)';
  setTimeout(() => card.style.transform = '', 10);
}

function tourClearHighlight() {
  if (_tourHighlightEl) {
    _tourHighlightEl.classList.remove('tour-highlight');
    _tourHighlightEl = null;
  }
  G('tour-spotlight').style.display = 'none';
}

async function openManual() {
  try {
    const result = await ff.manualOpen({ lang: _lang || 'pt' });
    if (!result?.ok) toast('Manual não encontrado. Verifique a instalação.');
  } catch(e) {
    toast('Erro ao abrir manual: ' + e.message);
  }
}

async function checkFirstRun() {
  try {
    const s = await ff.settingsGet();
    if (!s.tourDone) {
      await startTour();
    }
  } catch(e) {}
}


// ══ RENTABILIDADE & BENCHMARKS (Etapa 7) ══
let _benchmarks = { cdi: {}, ibov: {}, lastUpdate: null };
let _returnsChart = null;

// ── Fetch benchmarks: CDI (BCB série 12, since 2000) + IBOV (Yahoo Finance) ──
async function fetchBenchmarks(silent = false) {
  const btn = G('btn-fetch-benchmarks');
  if (btn && !silent) { btn.disabled = true; btn.textContent = '⏳ Buscando…'; }
  try {
    const result = await ff.benchmarksFetchAll();
    if (!result.cdi && !result.ibov) {
      const err = [result.cdiError, result.ibovError].filter(Boolean).join(' | ');
      throw new Error(err || 'Sem dados retornados');
    }
    if (result.cdi  && Object.keys(result.cdi).length)  _benchmarks.cdi  = result.cdi;
    if (result.ibov && Object.keys(result.ibov).length) _benchmarks.ibov = result.ibov;
    if (result.cdiError)  console.warn('[CDI error]', result.cdiError);
    if (result.ibovError) console.warn('[IBOV error]', result.ibovError);

    _benchmarks.lastUpdate = new Date().toLocaleDateString('pt-BR');
    // Persist to dedicated file
    try { await ff.benchmarksSave({ cdi: _benchmarks.cdi, ibov: _benchmarks.ibov, lastUpdate: _benchmarks.lastUpdate }); } catch(e) {}

    if (!silent) {
      const cdiMonths  = Object.keys(_benchmarks.cdi  || {}).length;
      const ibovMonths = Object.keys(_benchmarks.ibov || {}).length;
      toast(`✅ CDI (${cdiMonths} meses) e IBOVESPA (${ibovMonths} meses) atualizados`);
      if (G('benchmarks-last-update')) G('benchmarks-last-update').textContent = `Atualizado: ${_benchmarks.lastUpdate}`;
      await refreshReturns();
    } else {
      if (G('benchmarks-last-update')) G('benchmarks-last-update').textContent = `Atualizado: ${_benchmarks.lastUpdate}`;
      refreshPatrimonioTable();
    }
  } catch(e) {
    if (!silent) toast('⚠️ Erro ao buscar benchmarks: ' + e.message);
    else console.warn('[benchmarks auto-fetch]', e.message);
    console.error('[benchmarks]', e);
  } finally {
    if (btn && !silent) { btn.disabled = false; btn.textContent = '🔄 Atualizar CDI/IBOV'; }
  }
}

// ── Load cached benchmarks from dedicated file ──
async function loadBenchmarks() {
  try {
    const fromFile = await ff.benchmarksGet().catch(() => null);
    if (fromFile?.cdi && Object.keys(fromFile.cdi).length) {
      _benchmarks = fromFile;
      if (_benchmarks.lastUpdate && G('benchmarks-last-update'))
        G('benchmarks-last-update').textContent = `Atualizado: ${_benchmarks.lastUpdate}`;
    }
  } catch(e) {}
}

// ── Compute cumulative return for a series of monthly rates ──
function cumulativeReturn(monthlyRates, months) {
  let cum = 1;
  for (const m of months) {
    const r = monthlyRates[m] ?? 0;
    cum *= (1 + r);
  }
  return cum - 1;
}

// ── Annualize a total return over N months ──
function annualizedReturn(totalRet, months) {
  if (months <= 0) return 0;
  return Math.pow(1 + totalRet, 12 / months) - 1;
}

// ── Main refresh ──
async function refreshReturns() {
  if (!_inv?.assets?.length) {
    _inv.assets = await ff.invAssetsList().catch(() => []);
    _inv.txAll  = await ff.invTxAll().catch(() => []);
  }

  // Ensure benchmarks loaded
  if (!Object.keys(_benchmarks.cdi).length) await loadBenchmarks();

  const periodMonths = parseInt(G('returns-period')?.value || '12');

  // Build sorted month list
  const allMonths = [...new Set(_inv.txAll.map(t => t.month))].sort();
  const today = new Date();
  const curM = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`;

  // Period filter
  let periodStart = null;
  if (periodMonths > 0) {
    const d = new Date(today);
    d.setMonth(d.getMonth() - periodMonths);
    periodStart = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  } else {
    periodStart = allMonths[0] || curM;
  }

  // Months in the analysis window
  const windowMonths = allMonths.filter(m => m >= periodStart && m <= curM);
  if (!windowMonths.length && allMonths.length) windowMonths.push(...allMonths.slice(-3));

  // ── Per-asset calculation ──
  const assetReturns = _inv.assets
    .filter(a => !a.hidden)
    .map(a => {
      const txs = _inv.txAll.filter(t => t.asset_id === a.id);
      // Latest value
      const latestAtu = txs.filter(t => t.tx_type === 'atualizacao' && t.month <= curM)
                           .sort((a,b) => a.month < b.month ? 1 : -1)[0];
      const currentValue = latestAtu?.total_value ?? 0;
      // Total invested (sum of aportes)
      const totalInvested = txs
        .filter(t => t.tx_type === 'aporte')
        .reduce((s, t) => s + Math.abs(t.total_value), 0);
      // Gain/Loss
      const gain = currentValue - totalInvested;
      const totalRet = totalInvested > 0 ? gain / totalInvested : 0;
      // Find first month with data
      const firstMonth = txs.map(t => t.month).sort()[0] || curM;
      const monthsHeld = Math.max(1, windowMonths.filter(m => m >= firstMonth).length);
      const annRet = annualizedReturn(totalRet, monthsHeld);
      // CDI comparison (period CDI)
      const periodCDI = cumulativeReturn(_benchmarks.cdi, windowMonths.filter(m => m >= firstMonth));
      const vsCDI = totalRet - periodCDI;

      return { ...a, currentValue, totalInvested, gain, totalRet, annRet, vsCDI, monthsHeld, firstMonth };
    })
    .filter(a => a.currentValue > 0 || a.totalInvested > 0)
    .sort((a, b) => b.totalRet - a.totalRet);

  // ── Portfolio total ──
  const portValue    = assetReturns.reduce((s, a) => s + a.currentValue, 0);
  const portInvested = assetReturns.reduce((s, a) => s + a.totalInvested, 0);
  const portGain     = portValue - portInvested;
  const portRet      = portInvested > 0 ? portGain / portInvested : 0;
  const portAnn      = annualizedReturn(portRet, windowMonths.length);

  // CDI and IBOV for the period
  const periodCDI  = cumulativeReturn(_benchmarks.cdi, windowMonths);
  const periodIBOV = cumulativeReturn(_benchmarks.ibov, windowMonths);

  // ── Summary cards ──
  const summaryEl = G('returns-summary');
  if (summaryEl) {
    const pctFmt = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
    const cards = [
      { label: 'Carteira (período)', val: pctFmt(portRet), cls: portRet >= 0 ? 'green' : 'red' },
      { label: 'Carteira (a.a.)', val: pctFmt(portAnn), cls: portAnn >= 0 ? 'green' : 'red' },
      { label: `CDI (${windowMonths.length}m)`, val: Object.keys(_benchmarks.cdi).length ? pctFmt(periodCDI) : '—', cls: '' },
      { label: `IBOVESPA (${windowMonths.length}m)`, val: Object.keys(_benchmarks.ibov).length ? pctFmt(periodIBOV) : '—', cls: '' },
      { label: 'vs CDI', val: Object.keys(_benchmarks.cdi).length ? pctFmt(portRet - periodCDI) : '—',
        cls: portRet >= periodCDI ? 'green' : 'red' },
    ];
    summaryEl.innerHTML = cards.map(c => `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);padding:14px 18px;min-width:140px;flex:1">
        <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">${c.label}</div>
        <div style="font-size:20px;font-weight:700;margin-top:4px;color:${c.cls==='green'?'var(--green)':c.cls==='red'?'var(--red)':'var(--text)'}">${c.val}</div>
      </div>`).join('');
  }

  // ── Chart ──
  renderReturnsChart(windowMonths, portInvested, portRet, periodCDI, periodIBOV);

  // ── Per-asset table ──
  const tbody = G('returns-assets-body');
  if (tbody) {
    if (!assetReturns.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text3);padding:32px">Nenhum ativo com dados suficientes</td></tr>';
    } else {
      const catLabel = c => ({ fundos:'Fundos', renda_fixa:'Renda Fixa', tesouro:'Tesouro', previdencia:'Previdência', renda_variavel:'Renda Variável', valor_em_caixa:'Caixa' }[c] || c);
      tbody.innerHTML = assetReturns.map((a, i) => {
        const pctFmt = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
        const gainCls = a.gain >= 0 ? 'amt-inc' : 'amt-exp';
        const retCls  = a.totalRet >= 0 ? 'amt-inc' : 'amt-exp';
        const vsCls   = a.vsCDI >= 0 ? 'amt-inc' : 'amt-exp';
        const stripe  = i % 2 === 1 ? 'background:var(--bg3)' : '';
        return `<tr style="${stripe}">
          <td style="font-size:13px;padding:8px 12px;font-weight:500">${esc(a.name)}</td>
          <td style="font-size:11px;padding:8px 12px;color:var(--text3)">${catLabel(a.category)}</td>
          <td class="amt-inc right" style="font-size:12px;padding:8px 12px;font-family:'DM Mono',monospace">${fmtBRL(a.currentValue)}</td>
          <td class="right" style="font-size:12px;padding:8px 12px;font-family:'DM Mono',monospace;color:var(--text3)">${a.totalInvested > 0 ? fmtBRL(a.totalInvested) : '—'}</td>
          <td class="${gainCls} right" style="font-size:12px;padding:8px 12px;font-family:'DM Mono',monospace">${a.gain !== 0 ? (a.gain >= 0 ? '+' : '') + fmtBRL(a.gain) : '—'}</td>
          <td class="${retCls} right" style="font-size:12px;padding:8px 12px;font-weight:600">${a.totalInvested > 0 ? pctFmt(a.totalRet) : '—'}</td>
          <td class="${retCls} right" style="font-size:12px;padding:8px 12px">${a.totalInvested > 0 ? pctFmt(a.annRet) : '—'}</td>
          <td class="${vsCls} right" style="font-size:12px;padding:8px 12px">${a.totalInvested > 0 && Object.keys(_benchmarks.cdi).length ? pctFmt(a.vsCDI) : '—'}</td>
        </tr>`;
      }).join('');
    }
  }
}

function renderReturnsChart(months, portInvested, portRet, cdiRet, ibovRet) {
  const canvas = G('returns-chart');
  if (!canvas) return;

  // Build cumulative series month by month
  // We approximate portfolio monthly return by evenly distributing total return
  // (a more precise approach would require monthly valuation data)
  const portMonthly = {};
  const cdiCumSeries = [];
  const ibovCumSeries = [];
  const portCumSeries = [];

  // Build CDI and IBOV cumulative from start
  let cdiCum = 1, ibovCum = 1, portCum = 1;

  // Approximate portfolio monthly return from tx data
  const txByMonth = {};
  (_inv.txAll || []).forEach(t => {
    if (!txByMonth[t.month]) txByMonth[t.month] = [];
    txByMonth[t.month].push(t);
  });

  // Use actual atualizacao values to get monthly portfolio value
  const portValueByMonth = {};
  (_inv.assets || []).filter(a => !a.hidden).forEach(a => {
    const txs = (_inv.txAll || []).filter(t => t.asset_id === a.id && t.tx_type === 'atualizacao');
    txs.forEach(t => {
      portValueByMonth[t.month] = (portValueByMonth[t.month] || 0) + t.total_value;
    });
  });

  const labels = months.filter(m => portValueByMonth[m] !== undefined || _benchmarks.cdi[m] !== undefined);
  let prevPortVal = null;

  const cdiSeries = [], ibovSeries = [], portSeries = [];
  let cumCDI = 1, cumIBOV = 1, cumPort = 1;

  for (const m of labels) {
    const cdiR  = _benchmarks.cdi[m]  ?? 0;
    const ibovR = _benchmarks.ibov[m] ?? 0;
    cumCDI  *= (1 + cdiR);
    cumIBOV *= (1 + ibovR);

    const portVal = portValueByMonth[m];
    if (portVal !== undefined && prevPortVal !== null && prevPortVal > 0) {
      const portR = (portVal - prevPortVal) / prevPortVal;
      cumPort *= (1 + portR);
    }
    if (portVal !== undefined) prevPortVal = portVal;

    cdiSeries.push(((cumCDI - 1) * 100).toFixed(2));
    ibovSeries.push(((cumIBOV - 1) * 100).toFixed(2));
    portSeries.push(prevPortVal !== null ? ((cumPort - 1) * 100).toFixed(2) : null);
  }

  // Destroy existing chart
  if (_returnsChart) { _returnsChart.destroy(); _returnsChart = null; }

  const ctx = canvas.getContext('2d');
  if (typeof Chart === 'undefined') return;

  const shortLabels = labels.map(m => {
    const [y, mo] = m.split('-');
    return ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][parseInt(mo)-1] + '/' + y.slice(2);
  });

  _returnsChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: shortLabels,
      datasets: [
        {
          label: 'Carteira',
          data: portSeries,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,.08)',
          borderWidth: 2.5,
          pointRadius: 3,
          tension: 0.3,
          fill: false,
        },
        {
          label: 'CDI',
          data: cdiSeries,
          borderColor: '#16a34a',
          borderWidth: 2,
          borderDash: [5,4],
          pointRadius: 0,
          tension: 0.1,
          fill: false,
        },
        {
          label: 'IBOVESPA',
          data: ibovSeries,
          borderColor: '#f59e0b',
          borderWidth: 2,
          borderDash: [3,3],
          pointRadius: 0,
          tension: 0.1,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y >= 0 ? '+' : ''}${parseFloat(ctx.parsed.y).toFixed(2)}%`,
          },
        },
      },
      scales: {
        y: {
          ticks: { callback: v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%', font: { size: 11 } },
          grid: { color: 'rgba(0,0,0,.06)' },
        },
        x: { ticks: { font: { size: 10 }, maxRotation: 45 } },
      },
    },
  });

  // Legend
  const legendEl = G('returns-chart-legend');
  if (legendEl) {
    legendEl.innerHTML = [
      { color:'#2563eb', label:'Carteira', dash:false },
      { color:'#16a34a', label:'CDI', dash:true },
      { color:'#f59e0b', label:'IBOVESPA', dash:true },
    ].map(l => `<div style="display:flex;align-items:center;gap:5px">
      <svg width="24" height="12"><line x1="0" y1="6" x2="24" y2="6" stroke="${l.color}" stroke-width="2.5" ${l.dash?'stroke-dasharray="5 4"':''}/></svg>
      <span style="color:var(--text2)">${l.label}</span>
    </div>`).join('');
  }
}

// ══ METAS FINANCEIRAS (Etapa 5) ══
let _goals = [];
let _goalColor = '#2563eb';

async function refreshGoals() {
  _goals = await ff.goalList().catch(() => []);

  // Fetch context data for calculations
  const [avgExp, avgSav] = await Promise.all([
    ff.goalAvgExpenses().catch(() => 0),
    ff.goalAvgSavings().catch(() => 0),
  ]);

  // Fetch account balances for linked accounts
  const linkedIds = [...new Set(_goals.filter(g=>g.account_id).map(g=>g.account_id))];
  const balMap = {};
  for (const aid of linkedIds) {
    balMap[aid] = await ff.goalAccountBalance({ accountId: aid }).catch(() => 0);
  }

  const listEl = G('goals-list');
  if (!listEl) return;

  if (!_goals.length) {
    listEl.innerHTML = `<div class="info-box" style="text-align:center;padding:40px">
      <div style="font-size:40px;margin-bottom:10px">🎯</div>
      <div style="font-weight:600;font-size:15px;margin-bottom:6px">Nenhuma meta definida ainda</div>
      <div style="font-size:13px;color:var(--text3);margin-bottom:16px">Crie sua primeira meta e acompanhe o progresso</div>
      <button class="btn primary" onclick="openGoalModal()">+ Criar primeira meta</button>
    </div>`;
    return;
  }

  listEl.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px">` +
    _goals.map(g => renderGoalCard(g, balMap, avgExp, avgSav)).join('') +
    `</div>`;
}

function renderGoalCard(g, balMap, avgExp, avgSav) {
  const color = g.color || '#2563eb';
  let progress = 0, progressLabel = '', statusLine = '', targetLabel = '';

  if (g.type === 'target') {
    const target = g.target_amount || 0;
    const current = g.account_id ? (balMap[g.account_id] || 0) : 0;
    progress = target > 0 ? Math.min((current / target) * 100, 100) : 0;
    targetLabel = `Meta: ${fmtBRL(target)}`;
    progressLabel = `${fmtBRL(current)} de ${fmtBRL(target)}`;
    const rem = target - current;
    if (rem <= 0) {
      statusLine = `<span style="color:var(--green);font-weight:600">✅ Meta atingida!</span>`;
    } else if (avgSav > 0) {
      const monthsLeft = Math.ceil(rem / avgSav);
      const eta = new Date();
      eta.setMonth(eta.getMonth() + monthsLeft);
      const etaStr = eta.toLocaleDateString('pt-BR', { month:'long', year:'numeric' });
      statusLine = `Faltam ${fmtBRL(rem)} · Previsão: <strong>${etaStr}</strong> (${monthsLeft} meses)`;
    } else {
      statusLine = `Faltam ${fmtBRL(rem)}`;
    }
    if (g.deadline) {
      const dl = new Date(g.deadline + 'T00:00:00');
      const today = new Date();
      const daysLeft = Math.ceil((dl - today) / 86400000);
      const dlStr = dl.toLocaleDateString('pt-BR', { day:'numeric', month:'short', year:'numeric' });
      const dlColor = daysLeft < 30 ? 'var(--red)' : daysLeft < 90 ? 'var(--warn)' : 'var(--text3)';
      statusLine += `<br><span style="color:${dlColor};font-size:11px">📅 Prazo: ${dlStr} (${daysLeft > 0 ? daysLeft + ' dias' : 'vencido'})</span>`;
    }

  } else if (g.type === 'monthly') {
    const target = g.monthly_amount || 0;
    progress = target > 0 && avgSav > 0 ? Math.min((avgSav / target) * 100, 100) : 0;
    targetLabel = `Meta mensal: ${fmtBRL(target)}`;
    progressLabel = avgSav > 0 ? `Média atual: ${fmtBRL(avgSav)}/mês` : 'Calculando média…';
    if (avgSav <= 0) {
      statusLine = `<span style="color:var(--text3)">Sem dados suficientes de poupança ainda</span>`;
    } else if (avgSav >= target) {
      statusLine = `<span style="color:var(--green);font-weight:600">✅ Você está poupando acima da meta!</span>`;
    } else {
      const diff = target - avgSav;
      statusLine = `Precisa poupar mais ${fmtBRL(diff)}/mês para atingir a meta`;
    }

  } else if (g.type === 'emergency') {
    const months = g.emergency_months || 6;
    const target = avgExp * months;
    const current = g.account_id ? (balMap[g.account_id] || 0) : 0;
    progress = target > 0 ? Math.min((current / target) * 100, 100) : 0;
    targetLabel = `${months} meses de gastos · Meta: ${fmtBRL(target)}`;
    progressLabel = `${fmtBRL(current)} de ${fmtBRL(target)}`;
    const rem = target - current;
    if (rem <= 0) {
      statusLine = `<span style="color:var(--green);font-weight:600">✅ Reserva completa!</span>`;
    } else if (avgSav > 0) {
      const monthsLeft = Math.ceil(rem / avgSav);
      statusLine = `Faltam ${fmtBRL(rem)} · ${monthsLeft} meses para completar (poupando ${fmtBRL(avgSav)}/mês)`;
    } else {
      statusLine = `Faltam ${fmtBRL(rem)} para completar a reserva`;
    }
  }

  const pct = progress.toFixed(0);
  const barW = progress.toFixed(1);
  const barColor = progress >= 100 ? '#16a34a' : progress >= 80 ? color : color;

  return `<div style="background:var(--bg2);border:1px solid var(--border);border-radius:12px;overflow:hidden;display:flex;flex-direction:column">
    <!-- Header strip -->
    <div style="background:${color};padding:14px 16px;display:flex;align-items:center;gap:10px">
      <span style="font-size:28px;line-height:1">${g.icon||'🎯'}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:700;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.name)}</div>
        <div style="font-size:11px;color:rgba(255,255,255,.75);margin-top:1px">${targetLabel}</div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0">
        <button class="btn-icon" style="color:#fff;opacity:.8" onclick="openGoalModal(${g.id})" title="Editar">✎</button>
        <button class="btn-icon" style="color:#fff;opacity:.8" onclick="deleteGoal(${g.id})" title="Excluir">✕</button>
      </div>
    </div>
    <!-- Progress area -->
    <div style="padding:14px 16px;flex:1">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:13px;color:var(--text2)">${progressLabel}</span>
        <span style="font-size:18px;font-weight:700;color:${color}">${pct}%</span>
      </div>
      <div style="background:var(--bg4);border-radius:99px;height:10px;overflow:hidden;margin-bottom:10px">
        <div style="height:100%;width:${barW}%;background:${barColor};border-radius:99px;transition:width .6s ease"></div>
      </div>
      <div style="font-size:12px;color:var(--text2);line-height:1.6">${statusLine}</div>
      ${g.account_id ? `<div style="font-size:11px;color:var(--text3);margin-top:6px">
        📊 Vinculada a: <strong>${esc(accounts.find(a=>a.id===g.account_id)?.name||'Conta')}</strong>
      </div>` : ''}
    </div>
  </div>`;
}

async function openGoalModal(id) {
  G('goal-edit-id').value = id || '';
  G('goal-modal-title').textContent = id ? 'Editar meta' : 'Nova meta financeira';
  _goalColor = '#2563eb';

  // Populate account select
  const accSel = G('goal-account');
  if (accSel) {
    accSel.innerHTML = '<option value="">Nenhuma</option>' +
      accounts.filter(a=>!a.hidden).map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  }

  // Reset currency inputs
  ['goal-target','goal-monthly'].forEach(id => {
    const el = G(id); if (el) { setupCurrencyInput(el); el.setValue?.(null); }
  });

  if (id) {
    const g = _goals.find(x => x.id === id);
    if (g) {
      G('goal-icon').value  = g.icon || '🎯';
      G('goal-name').value  = g.name;
      G('goal-type').value  = g.type;
      if (g.account_id) G('goal-account').value = String(g.account_id);
      if (g.target_amount)    G('goal-target').setValue?.(g.target_amount);
      if (g.monthly_amount)   G('goal-monthly').setValue?.(g.monthly_amount);
      if (g.emergency_months) G('goal-emergency-months').value = g.emergency_months;
      if (g.deadline)         G('goal-deadline').value = g.deadline;
      _goalColor = g.color || '#2563eb';
    }
  } else {
    G('goal-icon').value  = '🎯';
    G('goal-name').value  = '';
    G('goal-type').value  = 'target';
    G('goal-deadline').value = '';
    G('goal-emergency-months').value = 6;
    G('goal-account').value = '';
  }

  // Update color picker
  document.querySelectorAll('.goal-color-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === _goalColor);
  });
  onGoalTypeChange();

  // Emergency: show avg expenses ref
  const avgExp = await ff.goalAvgExpenses().catch(() => 0);
  const refEl = G('goal-emergency-ref');
  if (refEl && avgExp > 0) {
    refEl.textContent = `Gasto médio mensal (últimos 3 meses): ${fmtBRL(avgExp)}`;
  }

  openModal('modal-goal');
  setTimeout(() => G('goal-name')?.focus(), 80);
}

function onGoalTypeChange() {
  const type = G('goal-type')?.value;
  G('goal-fields-target').style.display    = type === 'target'    ? '' : 'none';
  G('goal-fields-monthly').style.display   = type === 'monthly'   ? '' : 'none';
  G('goal-fields-emergency').style.display = type === 'emergency' ? '' : 'none';
}

function pickGoalColor(btn) {
  document.querySelectorAll('.goal-color-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  _goalColor = btn.dataset.color;
}

async function saveGoal() {
  const id   = parseInt(G('goal-edit-id').value) || null;
  const name = G('goal-name').value.trim();
  const type = G('goal-type').value;
  const icon = G('goal-icon').value.trim() || '🎯';

  if (!name) { toast('Informe o nome da meta'); return; }

  const d = {
    id, name, type, icon, color: _goalColor,
    account_id: parseInt(G('goal-account').value) || null,
    deadline:   G('goal-deadline')?.value || null,
  };

  if (type === 'target') {
    const el = G('goal-target');
    d.target_amount = el?.rawValue ? el.rawValue() : parseFloat(el?.value) || 0;
    if (!d.target_amount) { toast('Informe o valor-alvo'); return; }
  } else if (type === 'monthly') {
    const el = G('goal-monthly');
    d.monthly_amount = el?.rawValue ? el.rawValue() : parseFloat(el?.value) || 0;
    if (!d.monthly_amount) { toast('Informe o valor mensal'); return; }
  } else if (type === 'emergency') {
    d.emergency_months = parseInt(G('goal-emergency-months').value) || 6;
  }

  await ff.goalSave(d);
  closeModal('modal-goal');
  toast(`✅ Meta "${name}" salva`);
  await refreshGoals();
}

async function deleteGoal(id) {
  const g = _goals.find(x => x.id === id);
  if (!g || !await showConfirmDialog(`Excluir meta "${g.name}"?`, '', 'Excluir', true)) return;
  await ff.goalDelete({ id });
  toast('Meta excluída');
  await refreshGoals();
}

// ══ BUDGET / ORÇAMENTO (Etapa 4) ══
let _budgets   = [];  // [{id, category, monthly_limit, alert_pct}]
let _budgetMonth = '';

async function refreshBudget() {
  // Set default month to current
  const el = G('budget-month');
  if (!el) return;
  const now = new Date();
  const curM = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  if (!el.value) el.value = curM;
  _budgetMonth = el.value || curM;

  _budgets = await ff.budgetList().catch(() => []);
  const actuals = await ff.budgetActuals({ month: _budgetMonth }).catch(() => []);

  // Build a map: category → {spent, received}
  const actMap = {};
  actuals.forEach(a => { actMap[a.category] = { spent: a.spent||0, received: a.received||0 }; });

  // Summary cards
  const totalBudgeted = _budgets.reduce((s,b) => s + b.monthly_limit, 0);
  const totalSpent    = _budgets.reduce((s,b) => s + (actMap[b.category]?.spent||0), 0);
  const remaining     = totalBudgeted - totalSpent;
  const overBudget    = _budgets.filter(b => (actMap[b.category]?.spent||0) > b.monthly_limit).length;

  const summaryEl = G('budget-summary-cards');
  if (summaryEl) {
    summaryEl.innerHTML = [
      { label:'Total orçado', val: fmtBRL(totalBudgeted), cls:'' },
      { label:'Total gasto', val: fmtBRL(totalSpent), cls: totalSpent > totalBudgeted ? 'red' : '' },
      { label:'Saldo disponível', val: fmtBRL(remaining), cls: remaining < 0 ? 'red' : 'green' },
      { label:'Categorias acima do limite', val: overBudget, cls: overBudget > 0 ? 'red' : 'green' },
    ].map(c => `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);padding:14px 18px;min-width:160px;flex:1">
        <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">${c.label}</div>
        <div style="font-size:20px;font-weight:700;margin-top:4px;color:${c.cls==='red'?'var(--red)':c.cls==='green'?'var(--green)':'var(--text)'}">${c.val}</div>
      </div>`).join('');
  }

  // Budget rows
  const listEl = G('budget-list');
  if (!listEl) return;

  if (!_budgets.length) {
    listEl.innerHTML = `<div class="info-box" style="text-align:center;padding:32px">
      <div style="font-size:32px;margin-bottom:8px">💰</div>
      <div style="font-weight:600;margin-bottom:6px">Nenhuma meta definida</div>
      <div style="font-size:13px;color:var(--text3)">Clique em "+ Nova meta" para começar</div>
    </div>`;
  } else {
    listEl.innerHTML = `<div class="tbl-card"><div class="tbl-outer">
      <table class="ledger"><thead><tr>
        <th>Categoria</th>
        <th class="right">Gasto</th>
        <th class="right">Limite</th>
        <th class="right">Saldo</th>
        <th>Progresso</th>
        <th class="center">Alerta</th>
        <th></th>
      </tr></thead><tbody>` +
      _budgets.map((b, i) => {
        const actual  = actMap[b.category]?.spent || 0;
        const pct     = b.monthly_limit > 0 ? Math.min((actual / b.monthly_limit) * 100, 100) : 0;
        const over    = actual > b.monthly_limit;
        const warn    = pct >= (b.alert_pct || 80) && !over;
        const rem     = b.monthly_limit - actual;
        const barClr  = over ? 'var(--red)' : warn ? 'var(--warn)' : 'var(--green)';
        const remClr  = over ? 'var(--red)' : rem < b.monthly_limit * 0.2 ? 'var(--warn)' : 'var(--green)';
        const stripe  = i % 2 === 1 ? 'background:var(--bg3)' : '';
        return `<tr style="${stripe}">
          <td style="font-size:13px;padding:10px 14px;font-weight:500">${esc(b.category)}</td>
          <td class="right" style="font-family:'DM Mono',monospace;font-size:13px;padding:10px 14px;color:${over?'var(--red)':'var(--text)'}">${fmtBRL(actual)}</td>
          <td class="right" style="font-family:'DM Mono',monospace;font-size:13px;padding:10px 14px;color:var(--text3)">${fmtBRL(b.monthly_limit)}</td>
          <td class="right" style="font-family:'DM Mono',monospace;font-size:13px;padding:10px 14px;color:${remClr}">${rem >= 0 ? fmtBRL(rem) : '−'+fmtBRL(-rem)}</td>
          <td style="padding:10px 14px;min-width:140px">
            <div style="background:var(--bg4);border-radius:99px;height:8px;overflow:hidden">
              <div style="height:100%;width:${pct.toFixed(1)}%;background:${barClr};border-radius:99px;transition:width .4s"></div>
            </div>
            <div style="font-size:10px;color:var(--text3);margin-top:3px">${pct.toFixed(0)}%${over?' ⚠️ Acima do limite':''}</div>
          </td>
          <td class="center" style="font-size:12px;color:var(--text3);padding:10px 8px">${b.alert_pct||80}%</td>
          <td class="center" style="padding:10px 8px;white-space:nowrap">
            <button class="btn-icon" title="Editar" onclick="openBudgetModal(${b.id})">✎</button>
            <button class="btn-icon" title="Excluir" style="color:var(--red)" onclick="deleteBudget(${b.id})">✕</button>
          </td>
        </tr>`;
      }).join('') +
      '</tbody></table></div></div>';
  }

  // Show categories with spending but no budget (suggestion area)
  const budgetedCats = new Set(_budgets.map(b => b.category));
  const unbudgeted = actuals
    .filter(a => !budgetedCats.has(a.category) && a.spent > 0 && a.category &&
      a.category !== 'Transferência' && a.category !== 'Transferências')
    .sort((a,b) => b.spent - a.spent)
    .slice(0, 8);

  const uncatEl = G('budget-uncategorized');
  if (uncatEl) {
    if (unbudgeted.length) {
      uncatEl.innerHTML = `<div style="margin-bottom:8px;font-size:13px;font-weight:600;color:var(--text2)">
        Categorias sem meta este mês — clique para adicionar:</div>` +
        `<div style="display:flex;flex-wrap:wrap;gap:8px">` +
        unbudgeted.map(a => `
          <button class="btn" onclick="openBudgetModal(null,'${esc2(a.category)}')"
            style="font-size:12px;display:flex;align-items:center;gap:6px">
            ${esc(a.category)}
            <span style="color:var(--red);font-family:'DM Mono',monospace">${fmtBRL(a.spent)}</span>
          </button>`).join('') +
        `</div>`;
    } else {
      uncatEl.innerHTML = '';
    }
  }
}

function openBudgetModal(id, prefillCat) {
  G('budget-edit-id').value = id || '';
  G('budget-alert').value = 80;
  setupCurrencyInput(G('budget-limit'));

  if (id) {
    const b = _budgets.find(x => x.id === id);
    if (b) {
      G('budget-modal-title').textContent = 'Editar meta';
      G('budget-cat').value   = b.category;
      G('budget-limit').setValue?.(b.monthly_limit);
      G('budget-alert').value = b.alert_pct || 80;
    }
  } else {
    G('budget-modal-title').textContent = 'Nova meta de orçamento';
    G('budget-cat').value = prefillCat || '';
    G('budget-limit').setValue?.(null);
  }
  openModal('modal-budget');
  setTimeout(() => {
    if (!G('budget-cat').value) G('budget-cat').focus();
    else G('budget-limit').focus();
  }, 80);
}

async function saveBudget() {
  const id       = parseInt(G('budget-edit-id').value) || null;
  const category = G('budget-cat').value.trim();
  const limit    = G('budget-limit').rawValue ? G('budget-limit').rawValue()
                 : parseFloat(G('budget-limit').value) || 0;
  const alertPct = parseInt(G('budget-alert').value) || 80;

  if (!category) { toast('Informe a categoria'); return; }
  if (!limit || limit <= 0) { toast('Informe um limite maior que zero'); return; }

  await ff.budgetSave({ id, category, monthly_limit: limit, alert_pct: alertPct });
  closeModal('modal-budget');
  toast(`✅ Meta "${category}" salva`);
  await refreshBudget();
}

async function deleteBudget(id) {
  const b = _budgets.find(x => x.id === id);
  if (!b) return;
  if (!await showConfirmDialog(`Excluir meta de "${b.category}"?`, '', 'Excluir', true)) return;
  await ff.budgetDelete({ id });
  toast('Meta excluída');
  await refreshBudget();
}

// ══ ADVANCED SEARCH (Etapa 3) ══
let _advState = {
  results: [], total: 0, page: 0, pageSize: 50,
  sortCol: 'date', sortDir: -1,  // -1=desc, 1=asc
};
let _advTimer = null;

function initSearchPage() {
  // Populate account filter
  const sel = G('adv-account');
  if (sel) {
    sel.innerHTML = '<option value="">Todas as contas</option>' +
      accounts.filter(a=>!a.hidden).map(a =>
        `<option value="${a.id}">${esc(a.name)}</option>`).join('');
  }
  // Run last search or show empty state
  if (_advState.total > 0) renderAdvResults();
}

function scheduleAdvSearch() {
  clearTimeout(_advTimer);
  _advTimer = setTimeout(runAdvSearch, 300);
}

async function runAdvSearch() {
  _advState.page = 0; // reset to first page on new search
  await _execAdvSearch();
}

async function advPage(dir) {
  const maxPage = Math.ceil(_advState.total / _advState.pageSize) - 1;
  _advState.page = Math.max(0, Math.min(_advState.page + dir, maxPage));
  await _execAdvSearch();
}

function advSort(col) {
  if (_advState.sortCol === col) {
    _advState.sortDir *= -1;
  } else {
    _advState.sortCol = col;
    _advState.sortDir = col === 'amount' ? -1 : -1;
  }
  // Sort locally (already have the page loaded)
  _advState.results.sort((a, b) => {
    let va = a[col], vb = b[col];
    if (col === 'amount') { va = Math.abs(va); vb = Math.abs(vb); }
    if (typeof va === 'string') return _advState.sortDir * va.localeCompare(vb, 'pt-BR');
    return _advState.sortDir * (va - vb);
  });
  renderAdvResults();
}

async function _execAdvSearch() {
  const query    = G('adv-query')?.value?.trim() || '';
  const accountId= parseInt(G('adv-account')?.value) || null;
  const type     = G('adv-type')?.value || '';
  const clearedV = G('adv-cleared')?.value;
  const dateFrom = G('adv-from')?.value || '';
  const dateTo   = G('adv-to')?.value || '';
  const category = G('adv-category')?.value?.trim() || '';

  // Require at least one filter
  if (!query && !accountId && !type && clearedV==='' && !dateFrom && !dateTo && !category) {
    G('adv-results-body').innerHTML =
      '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:32px">Use os filtros acima para buscar transações</td></tr>';
    G('search-results-count').textContent = '';
    G('adv-page-info').textContent = '';
    return;
  }

  G('adv-results-body').innerHTML =
    '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">⏳ Buscando…</td></tr>';

  const cleared = clearedV === '1' ? 1 : clearedV === '0' ? 0 : undefined;
  const res = await ff.searchGlobal({
    query, accountId, category, type,
    cleared: cleared !== undefined ? cleared : null,
    dateFrom, dateTo,
    limit: _advState.pageSize,
    offset: _advState.page * _advState.pageSize,
  });

  _advState.results = res.rows || res; // handle both new and old format
  _advState.total   = res.total ?? _advState.results.length;

  // Sort locally
  _advState.results.sort((a, b) => {
    let va = a[_advState.sortCol], vb = b[_advState.sortCol];
    if (_advState.sortCol === 'amount') { va = Math.abs(va); vb = Math.abs(vb); }
    if (typeof va === 'string') return _advState.sortDir * va.localeCompare(vb, 'pt-BR');
    return _advState.sortDir * (va - vb);
  });

  renderAdvResults();
}

function renderAdvResults() {
  const { results, total, page, pageSize } = _advState;
  const tbody = G('adv-results-body');
  const countEl = G('search-results-count');
  const pageInfo = G('adv-page-info');

  // Update sort indicators
  ['date','account_name','memo','category','amount'].forEach(col => {
    const el = G(`adv-sort-${col}`);
    if (el) el.textContent = _advState.sortCol === col ? (_advState.sortDir === 1 ? ' ↑' : ' ↓') : '';
  });

  if (!results.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:32px">Nenhum resultado encontrado</td></tr>';
    countEl.textContent = '';
    if (pageInfo) pageInfo.textContent = '';
    if (G('adv-prev')) G('adv-prev').disabled = true;
    if (G('adv-next')) G('adv-next').disabled = true;
    return;
  }

  countEl.textContent = `${total} resultado(s)`;
  const start = page * pageSize + 1;
  const end   = Math.min((page + 1) * pageSize, total);
  if (pageInfo) pageInfo.textContent = `${start}–${end} de ${total}`;
  if (G('adv-prev')) G('adv-prev').disabled = page === 0;
  if (G('adv-next')) G('adv-next').disabled = end >= total;

  let stripe = false;
  tbody.innerHTML = results.map((t, i) => {
    stripe = !stripe;
    const isTransfer = !!t.transfer_id;
    const amtCls = t.amount < 0 && !isTransfer ? 'amt-exp' :
                   t.amount > 0 && !isTransfer ? 'amt-inc' : '';
    const amtStr = fmtBRL(Math.abs(t.amount));
    const sign   = isTransfer ? '⇄ ' : t.amount < 0 ? '−' : '+';
    const rowBg  = stripe ? '' : 'background:var(--bg3)';
    const clearedIcon = t.cleared ? '✅' : '○';
    return `<tr style="${rowBg};cursor:pointer" onclick="advJumpToTx(${t.account_id},${t.id})"
      onmouseenter="this.style.background='var(--accent-bg)'" onmouseleave="this.style.background='${stripe?'':'var(--bg3)'}'">
      <td style="white-space:nowrap;font-size:12px;padding:6px 10px">${fmtDate(t.date)}</td>
      <td style="font-size:12px;padding:6px 10px;color:var(--text3);white-space:nowrap">${esc(t.account_name)}</td>
      <td style="font-size:13px;padding:6px 10px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          title="${esc(t.memo)}">${esc(t.memo||'—')}</td>
      <td style="font-size:11px;padding:6px 10px;color:var(--text3)">${esc(t.category||'—')}</td>
      <td class="${amtCls} right" style="font-size:13px;padding:6px 10px;font-family:'DM Mono',monospace;white-space:nowrap">
        ${sign}${amtStr}</td>
      <td class="center" style="padding:6px 8px">
        <span onclick="event.stopPropagation();advToggleCleared(${t.id},${!t.cleared},this)"
          style="cursor:pointer;font-size:15px;user-select:none">${clearedIcon}</span>
      </td>
    </tr>`;
  }).join('');
}

async function advJumpToTx(accountId, txId) {
  await openAccount(accountId);
  setTimeout(() => {
    const row = document.querySelector(`tr[data-id="${txId}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.style.outline = '2px solid var(--accent)';
      row.style.transition = 'outline 0.5s';
      setTimeout(() => { row.style.outline = ''; }, 2000);
    }
  }, 500);
}

async function advToggleCleared(id, val, span) {
  await ff.inlineUpdate({ id, field: 'cleared', value: val ? 1 : 0 });
  span.textContent = val ? '✅' : '○';
  // Update local results
  const tx = _advState.results.find(t => t.id === id);
  if (tx) tx.cleared = val ? 1 : 0;
  await loadAccounts();
}

function clearAdvSearch() {
  G('adv-query').value    = '';
  G('adv-account').value  = '';
  G('adv-type').value     = '';
  G('adv-cleared').value  = '';
  G('adv-from').value     = '';
  G('adv-to').value       = '';
  G('adv-category').value = '';
  _advState = { results: [], total: 0, page: 0, pageSize: 50, sortCol: 'date', sortDir: -1 };
  G('adv-results-body').innerHTML =
    '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:32px">Use os filtros acima para buscar transações</td></tr>';
  G('search-results-count').textContent = '';
  G('adv-page-info').textContent = '';
}

// ══ GLOBAL SEARCH ══
let _gsTimer = null;
function onGlobalSearch(q) {
  clearTimeout(_gsTimer);
  const box = G('global-search-results');
  if (!q || q.length < 2) { box.style.display='none'; return; }
  // Show quick preview results
  _gsTimer = setTimeout(async () => {
    const res = await ff.searchGlobal({ query: q, limit: 8 });
    const results = res.rows || res;
    if (!results.length) { box.style.display='none'; return; }
    box.innerHTML = results.map(t => {
      const amtCls = t.amount < 0 ? 'amt-exp' : 'amt-inc';
      return `<div class="gsearch-item" onclick="jumpToTx(${t.account_id},${t.id})">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.memo||t.category)}</div>
          <div class="gsearch-acc">${esc(t.account_name)} · ${fmtDate(t.date)} · ${esc(t.category)}</div>
        </div>
        <div class="${amtCls}" style="text-align:right;flex-shrink:0;font-family:'DM Mono',monospace;font-size:12px">${fmtBRL(Math.abs(t.amount))}</div>
      </div>`;
    }).join('') +
    `<div class="gsearch-item" style="justify-content:center;color:var(--accent);font-size:12px"
        onclick="openAdvSearchWith(this.dataset.q)" data-q="${esc(q)}">
      Ver todos os resultados →
    </div>`;
    box.style.display = 'block';
  }, 250);
}

function openAdvSearchWith(q) {
  G('global-search-results').style.display = 'none';
  G('global-search-input').value = '';
  const query = String(q || '').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"');
  goPage('search');
  setTimeout(() => {
    if (G('adv-query')) G('adv-query').value = query;
    runAdvSearch();
  }, 80);
}

async function jumpToTx(accountId, txId) {
  G('global-search-results').style.display = 'none';
  G('global-search-input').value = '';
  await openAccount(accountId);
  // Highlight the row after render
  setTimeout(() => {
    const row = document.querySelector(`tr[data-id="${txId}"]`);
    if (row) {
      row.scrollIntoView({ block:'center' });
      row.style.outline = '2px solid var(--accent)';
      setTimeout(() => row.style.outline = '', 2000);
    }
  }, 400);
}

function closeGlobalSearch() {
  G('global-search-results').style.display = 'none';
}

document.addEventListener('click', e => {
  if (!G('global-search-results')?.contains(e.target) &&
      e.target !== G('global-search-input')) {
    closeGlobalSearch();
  }
});

// ══ UNDO ══
async function refreshUndoBtn() {
  const desc = await ff.undoPeek();
  const btn  = G('undo-btn');
  if (!btn) return;
  if (desc) { btn.style.display='inline-flex'; btn.title=`Desfazer: ${desc} (Ctrl+Z)`; }
  else btn.style.display='none';
}

async function doUndo() {
  const result = await ff.undoApply();
  if (!result.ok) { toast('Nada para desfazer'); return; }
  toast(`↩ Desfeito: ${result.description}`);
  await loadAccounts();
  if (currentPage === 'account') refreshAccount();
  if (currentPage === 'overview') refreshOverview();
  refreshUndoBtn();
}

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
    e.preventDefault(); doUndo();
  }
});

// ══ INLINE EDIT ══
// ── Inline editing with Tab navigation and all-field support ──
const EDITABLE_COLS = ['date','memo','category','expense','income'];

function makeInlineEdit(txId, field, currentValue, displayValue) {
  const display = displayValue != null && displayValue !== '' ? displayValue : '—';
  return `<span class="cell-editable"
    ondblclick="startInlineEdit(event,${txId},'${field}',this)"
    data-txid="${txId}" data-field="${field}" data-val="${esc(String(currentValue??''))}"
    title="Duplo clique para editar">${esc(String(display))}</span>`;
}

// Navigate to adjacent editable cell via Tab/Shift+Tab
function inlineTabNav(txId, field, direction) {
  // Navigate within the same row first, then to adjacent rows
  const tbody = G('acct-tbody');
  if (!tbody) return;
  // Get visible editable columns in order
  const editableCols = ['date','memo','category','expense','income'];
  const curRow = tbody.querySelector(`tr[data-id="${txId}"]`);
  if (!curRow) return;
  // All editable spans in DOM order (across all rows)
  const allSpans = [...tbody.querySelectorAll('span.cell-editable')];
  const cur = allSpans.find(s => s.dataset.txid == txId && s.dataset.field === field);
  if (!cur) return;
  const idx = allSpans.indexOf(cur);
  const next = allSpans[idx + direction];
  if (next) {
    next.scrollIntoView({ block: 'nearest' });
    next.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  }
}

async function startInlineEdit(e, txId, field, span) {
  e.stopPropagation();
  e.preventDefault();
  const rawVal = span.dataset.val ?? span.textContent;
  let input;

  const finish = async (input, newVal, originalSpan) => {
    const orig = rawVal;
    const displayVal = field === 'date' ? fmtDate(newVal) :
                       (field === 'expense' || field === 'income') ? (newVal ? fmtBRL(parseFloat(newVal)) : '') : newVal;
    const newSpan = makeInlineDone(txId, field, newVal, displayVal || '—');
    input.replaceWith ? input.replaceWith(newSpan) : (input.parentNode?.replaceWith?.(newSpan));
    if (String(newVal) !== String(orig) && newVal !== '') {
      await commitInlineEdit(txId, field, newVal);
    }
  };

  if (field === 'category') {
    input = document.createElement('input');
    input.className = 'cell-edit-input';
    input.value = rawVal === '—' ? '' : rawVal;
    input.autocomplete = 'off';
    span.replaceWith(input);
    input.focus(); input.select();
    input.addEventListener('input', () => openGlobalCatDrop(input));
    input.addEventListener('focus', () => openGlobalCatDrop(input));
    input.addEventListener('blur', () => setTimeout(async () => {
      const val = input.value.trim();
      await finish(input, val, span);
    }, 200));
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Tab') {
        ev.preventDefault(); ev.stopPropagation();
        const val = input.value.trim();
        finish(input, val, span).then(() => inlineTabNav(txId, field, ev.shiftKey ? -1 : 1));
      }
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      if (ev.key === 'Escape') { input.replaceWith(span); G('global-cat-drop').style.display='none'; }
    });

  } else if (field === 'date') {
    input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-edit-input';
    input.placeholder = 'DD/MM/YYYY';
    input.style.width = '96px';
    // Show in DD/MM/YYYY format for editing
    if (rawVal && rawVal.match(/^\d{4}-\d{2}-\d{2}/)) {
      const [y,m,d] = rawVal.split('-');
      input.value = `${d}/${m}/${y}`;
    } else {
      input.value = rawVal || '';
    }
    span.replaceWith(input);
    input.focus(); input.select();
    const done = async () => {
      const v = input.value.trim();
      // Parse DD/MM/YYYY → YYYY-MM-DD
      const pm = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!pm) { input.replaceWith(span); return; }
      const iso = `${pm[3]}-${pm[2].padStart(2,'0')}-${pm[1].padStart(2,'0')}`;
      await finish(input, iso, span);
    };
    input.addEventListener('blur', done);
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Tab') { ev.preventDefault(); done().then(() => inlineTabNav(txId, field, ev.shiftKey ? -1 : 1)); }
      if (ev.key === 'Enter') { ev.preventDefault(); done(); }
      if (ev.key === 'Escape') { input.replaceWith(span); }
    });

  } else if (field === 'expense' || field === 'income') {
    // Monetary field — show amount without sign
    input = document.createElement('input');
    input.type = 'text';
    input.className = 'cell-edit-input';
    input.style.textAlign = 'right';
    setupCurrencyInput(input);
    const numVal = parseFloat(rawVal) || 0;
    if (numVal !== 0) input.setValue(numVal);
    span.replaceWith(input);
    input.focus();
    const counterField = field === 'expense' ? 'income' : 'expense';
    const done = async () => {
      const val = input.rawValue ? input.rawValue() : parseFloat(input.value) || 0;
      if (val > 0) {
        // Zero out the other field visually in the same row
        const row = G('acct-tbody').querySelector(`tr[data-id="${txId}"]`);
        const counterSpan = row?.querySelector(`span.cell-editable[data-field="${counterField}"]`);
        if (counterSpan) { counterSpan.textContent = ''; counterSpan.dataset.val = '0'; }
      }
      await finish(input, val, span);
    };
    input.addEventListener('blur', done);
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Tab') { ev.preventDefault(); done().then(() => inlineTabNav(txId, field, ev.shiftKey ? -1 : 1)); }
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      if (ev.key === 'Escape') { input.replaceWith(span); }
    });

  } else {
    // memo and other text fields
    input = document.createElement('input');
    input.className = 'cell-edit-input';
    input.value = rawVal === '—' ? '' : rawVal;
    span.replaceWith(input);
    input.focus(); input.select();
    const done = async () => {
      const val = input.value.trim();
      await finish(input, val, span);
    };
    input.addEventListener('blur', done);
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Tab') { ev.preventDefault(); done().then(() => inlineTabNav(txId, field, ev.shiftKey ? -1 : 1)); }
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      if (ev.key === 'Escape') { input.replaceWith(span); }
    });
  }
}

function makeInlineDone(txId, field, rawVal, displayVal) {
  const s = document.createElement('span');
  s.className = 'cell-editable';
  s.title = 'Duplo clique para editar';
  s.dataset.txid = txId;
  s.dataset.field = field;
  s.dataset.val = rawVal ?? '';
  s.textContent = displayVal ?? rawVal ?? '—';
  s.ondblclick = (e) => startInlineEdit(e, txId, field, s);
  return s;
}

async function commitInlineEdit(txId, field, value) {
  let actualField = field, actualValue = value;
  // expense/income map to 'amount' with sign
  if (field === 'expense') {
    actualField = 'amount';
    const v = parseFloat(value) || 0;
    actualValue = v > 0 ? -v : 0; // expense = negative; 0 means user cleared it
  }
  if (field === 'income') {
    actualField = 'amount';
    actualValue = parseFloat(value) || 0; // income = positive
  }
  await ff.inlineUpdate({ id: txId, field: actualField, value: actualValue });
  refreshUndoBtn();
  await loadAccounts();
  // Always re-render to update running balances and transfer pair changes
  refreshAccount();
  if (currentPage === 'overview') refreshOverview();
}

// ══ BACKUP ══
async function refreshBackup() {
  // Load settings state
  const settings = await ff.settingsGet().catch(()=>({}));
  const dirEl = G('settings-data-dir');
  const clearBtn = G('settings-clear-dir-btn');
  if (dirEl) dirEl.textContent = settings.dataDir || 'Pasta padrão do sistema';
  if (clearBtn) clearBtn.style.display = settings.dataDir ? '' : 'none';

  // Password state
  const pwCurrentRow = G('settings-pw-current-row');
  const removePwBtn  = G('settings-remove-pw-btn');
  const pwNewLabel   = G('settings-pw-new-label');
  if (pwCurrentRow) pwCurrentRow.style.display = settings.hasPassword ? '' : 'none';
  if (removePwBtn)  removePwBtn.style.display  = settings.hasPassword ? '' : 'none';
  // Show masked recovery email if already set
  const emailHint = G('settings-pw-email-current');
  if (emailHint) {
    emailHint.textContent = settings.recoveryEmailMasked
      ? `Email cadastrado: ${settings.recoveryEmailMasked} — deixe em branco para manter`
      : '';
  }
  if (pwNewLabel)   pwNewLabel.textContent      = settings.hasPassword ? 'Nova senha' : 'Definir senha';

  // Backup list
  const list = await ff.backupList();
  const count = list.length;
  const latest = list[0];
  const totalSize = list.reduce((s,b) => s+b.size, 0);

  if (!list.length) {
    G('backup-list').innerHTML = '<tr><td colspan="3" class="empty"><p>Nenhum backup ainda</p></td></tr>';
    return;
  }

  G('backup-list').innerHTML = list.map(b => {
    const label = b.name.replace('cruzeiro_data_','').replace('.db','')
      .replace('T',' ').replace(/-(\d{2})-(\d{2})-(\d{3})/,'.$1:$2').slice(0,19);
    const size = (b.size/1024).toFixed(0) + ' KB';
    return `<tr>
      <td style="font-size:13px;font-family:'DM Mono',monospace">${esc(label)}</td>
      <td class="right" style="font-size:12px;color:var(--text3)">${size}</td>
      <td class="center">
        <button class="btn xs danger" onclick="restoreBackup('${esc(b.path)}')">⬆ Restaurar</button>
      </td>
    </tr>`;
  }).join('');
}

async function pickDataDir() {
  const result = await ff.settingsSetDataDir();
  if (result.ok) {
    toast(`✅ Pasta de dados alterada para: ${result.dir}`);
    refreshBackup();
  }
}

async function clearDataDir() {
  await ff.settingsClearDataDir();
  toast('✅ Usando pasta padrão do sistema');
  refreshBackup();
}

async function savePassword() {
  const current  = G('settings-pw-current')?.value || '';
  const newPw    = G('settings-pw-new')?.value || '';
  const confirm  = G('settings-pw-confirm')?.value || '';
  const email    = G('settings-pw-email')?.value?.trim() || '';
  const statusEl = G('settings-pw-status');

  if (newPw && newPw !== confirm) {
    statusEl.innerHTML = '<span style="color:var(--red)">❌ As senhas não conferem</span>';
    return;
  }
  if (newPw && newPw.length < 4) {
    statusEl.innerHTML = '<span style="color:var(--red)">❌ Senha muito curta (mín. 4 caracteres)</span>';
    return;
  }
  // Only require email if there isn't one already stored
  if (newPw && !email) {
    const existing = await ff.settingsGet().catch(() => null);
    if (!existing?.recoveryEmail) {
      statusEl.innerHTML = '<span style="color:var(--red)">❌ Informe um email de recuperação</span>';
      return;
    }
  }

  const result = await ff.settingsSetPassword({ current, newPassword: newPw, email });
  if (!result.ok) {
    statusEl.innerHTML = `<span style="color:var(--red)">❌ ${esc(result.error)}</span>`;
    return;
  }
  G('settings-pw-current').value = '';
  G('settings-pw-new').value     = '';
  G('settings-pw-confirm').value = '';
  statusEl.innerHTML = '<span style="color:#16a34a">✅ Senha salva com sucesso</span>';
  setTimeout(() => { if(statusEl) statusEl.innerHTML=''; }, 3000);
  refreshBackup();
}

async function removePassword() {
  const current = G('settings-pw-current')?.value || '';
  const result = await ff.settingsSetPassword({ current, newPassword: '' });
  if (!result.ok) {
    G('settings-pw-status').innerHTML = `<span style="color:var(--red)">❌ ${esc(result.error)}</span>`;
    return;
  }
  G('settings-pw-status').innerHTML = '<span style="color:#16a34a">✅ Senha removida</span>';
  setTimeout(() => { if(G('settings-pw-status')) G('settings-pw-status').innerHTML=''; }, 3000);
  refreshBackup();
}

async function doManualBackup() {
  const result = await ff.backupNow();
  if (result.ok) { toast('💾 Backup criado com sucesso!'); refreshBackup(); }
  else toast('❌ Erro ao criar backup');
}

async function restoreBackup(backupPath) {
  const result = await ff.backupRestore(backupPath.replace(/&#39;/g,"'"));
  if (!result.ok) return;
  toast('✅ Backup restaurado! Recarregando…');
  setTimeout(() => location.reload(), 1500);
}

async function openBackupFolder() {
  await ff.backupFolder();
}
function fmtBRL(v){ return (v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'}); }
function fmtBRLshort(v){ const abs=Math.abs(v||0),sign=v<0?'-':''; if(abs>=1e6) return sign+(abs/1e6).toFixed(1)+'M'; if(abs>=1e3) return sign+(abs/1e3).toFixed(1)+'k'; return sign+abs.toFixed(0); }
function fmtDate(s){ if(!s) return ''; const [y,m,d]=s.split('-'); return `${d}/${m}/${y}`; }
function todayStr(){ return new Date().toISOString().slice(0,10); }
function norm(s){ return (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim(); }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function esc2(s){ return String(s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
function G(id){ return document.getElementById(id); }
function toast(msg,dur=2500){ const t=G('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),dur); }

// ── Currency input formatter ──────────────────────────────────────────────
// Turns a plain <input type="text"> into a live R$ formatted field.
// rawValue() returns the numeric float for use in calculations.
function setupCurrencyInput(el) {
  if (!el || el.dataset.currencySetup) return;
  el.dataset.currencySetup = '1';
  el.type = 'text';
  el.autocomplete = 'off';

  // Try to evaluate a simple math expression (only + - * /) and return cents
  function evalMathExpr(str) {
    // Clean: accept digits, commas, dots, +, -, *, /, spaces, parentheses
    const clean = str.replace(/R\$\s*/g, '').replace(/\./g, '').replace(/,/g, '.').trim();
    // Only allow safe chars
    if (!/^[\d\s\+\-\*\/\.\(\)]+$/.test(clean)) return null;
    try {
      // eslint-disable-next-line no-new-func
      const val = Function('"use strict"; return (' + clean + ')')();
      if (typeof val === 'number' && isFinite(val) && val >= 0) return Math.round(val * 100);
    } catch(e) {}
    return null;
  }

  function format(cents) {
    if (isNaN(cents) || cents === '') return 'R$ 0,00';
    const n = Math.abs(parseInt(cents, 10));
    const s = String(n).padStart(3, '0');
    const dec = s.slice(-2);
    let int = s.slice(0, -2).replace(/^0+/, '') || '0';
    int = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return 'R$\u00a0' + int + ',' + dec;
  }

  function toCents(val) {
    return parseInt(val.replace(/\D/g, ''), 10) || 0;
  }

  // Whether the current value looks like a math expression (contains operators)
  function isMathMode() { return /[+\-*/]/.test(el.value.replace(/^R\$\s*/, '').replace(/^\s*-?\s*/, '')); }

  el.addEventListener('focus', () => {
    if (el.value === '' || el.value === 'R$\u00a00,00') el.value = 'R$\u00a00,00';
    setTimeout(() => el.setSelectionRange(el.value.length, el.value.length), 0);
  });

  el.addEventListener('input', () => {
    // If value contains math operators, leave raw (don't reformat)
    const raw = el.value;
    const hasMath = /[+\-*/]/.test(raw.replace(/^R\$[\s\u00a0]*/, ''));
    if (hasMath) return; // let user type freely
    const cents = toCents(raw);
    const formatted = format(cents);
    el.value = formatted;
    el.setSelectionRange(formatted.length, formatted.length);
  });

  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === '=') && isMathMode()) {
      e.preventDefault();
      e.stopPropagation();
      const result = evalMathExpr(el.value);
      if (result !== null) {
        el.value = format(result);
        el.setSelectionRange(el.value.length, el.value.length);
      } else {
        el.value = format(toCents(el.value));
      }
    }
  });

  el.addEventListener('blur', () => {
    // On blur, evaluate any math expression
    if (isMathMode()) {
      const result = evalMathExpr(el.value);
      if (result !== null) { el.value = result === 0 ? '' : format(result); return; }
    }
    const cents = toCents(el.value);
    el.value = cents === 0 ? '' : format(cents);
  });

  // Helper attached to the element
  el.rawValue = () => {
    if (isMathMode()) {
      const result = evalMathExpr(el.value);
      if (result !== null) return result / 100;
    }
    return toCents(el.value) / 100;
  };
  el.setValue = (num) => {
    if (num == null || num === '' || isNaN(num)) { el.value = ''; return; }
    el.value = format(Math.round(parseFloat(num) * 100));
  };

  // Set initial value if already has one
  if (el.value && el.value !== '') {
    const num = parseFloat(el.value);
    if (!isNaN(num)) el.setValue(num);
  }
}

// Apply to an element by id, return its rawValue
function currencyVal(id) {
  const el = G(id);
  return el?.rawValue ? el.rawValue() : (parseFloat(el?.value?.replace(/[^\d,]/g, '').replace(',', '.')) || 0);
}

// ══ SCROLL TO TODAY in account view ══
function scrollToToday() {
  const today = todayStr();
  const rows  = [...(G('acct-tbody')?.querySelectorAll('tr[data-id]') || [])];
  let target  = null;
  for (const row of rows) {
    const id = parseInt(row.dataset.id);
    const tx = window._lastTxs?.find(t => t.id === id);
    if (tx && tx.date <= today) target = row;
    else if (tx && tx.date > today) break;
  }
  if (target) target.scrollIntoView({ block:'center', behavior:'smooth' });
  else if (rows.length) rows[rows.length-1].scrollIntoView({ block:'end' });
}

// ══ SAVE REPORT ══
function openSaveReportModal() {
  G('save-report-name').value = '';
  openModal('modal-save-report');
  setTimeout(() => G('save-report-name')?.focus(), 100);
}
async function confirmSaveReport() {
  const name = G('save-report-name').value.trim();
  if (!name) { toast('Digite um nome'); return; }
  const { accountIds, categories, excludeTransfers } = getRepFilters();
  const config = {
    id: Date.now(), name,
    type:   G('report-type').value,
    from:   G('rep-from').value,
    to:     G('rep-to').value,
    preset: G('rep-period-preset')?.value || 'custom',
    accounts: accountIds, cats: categories, excludeTransfers,
  };
  _savedReports = _savedReports.filter(r => r.name !== name);
  _savedReports.push(config);
  await ff.savedReportsSave(_savedReports);
  refreshSavedReportsMenu();
  closeModal('modal-save-report');
  toast(`"${name}" salvo!`);
}

// ══ EXPORTS ══
async function exportReportCSV() {
  const from = G('rep-from').value;
  const to   = G('rep-to').value;
  const { accountIds, categories, excludeTransfers } = getRepFilters();
  const flatRows = await ff.reportSummary({ fromDate:from, toDate:to, accountIds, excludeTransfers });
  const { parents } = buildTree(flatRows, categories);

  const periodLabel = (from && to)
    ? `${from.split('-').reverse().join('/')} para ${to.split('-').reverse().join('/')}`
    : 'Completo';

  // Moneyspire format: comma decimal for values, dot for subtotals
  const fmtN   = v => (v<0?'-':'') + Math.abs(v).toFixed(2).replace('.', ',');
  const fmtSub = v => (v<0?'-':'') + Math.abs(v).toFixed(2);

  let csv = 'Intervalo de datas,Categoria,Subcategoria,Montante\r\n';
  parents.forEach(p => {
    const net = p.income - p.expenses;
    if (!p.children.length) {
      csv += `"${periodLabel}","${p.category}","${p.category}","${fmtN(net)}"\r\n`;
    } else {
      p.children.sort((a,b)=>a.subName.localeCompare(b.subName,'pt-BR')).forEach(c => {
        const cnet = c.income - c.expenses;
        csv += `"${periodLabel}","${p.category}","${c.subName}","${fmtN(cnet)}"\r\n`;
      });
    }
    csv += `,Subtotal,,"${fmtSub(net)}"\r\n`;
  });

  const saved = await ff.saveFile({ defaultPath:`exportacao_${from||'completo'}.csv`, content: csv });
  if (saved) toast('CSV exportado!');
}

async function exportReportExcel() {
  const from = G('rep-from').value;
  const to   = G('rep-to').value;
  const { accountIds, categories, excludeTransfers } = getRepFilters();
  const flatRows = await ff.reportSummary({ fromDate:from, toDate:to, accountIds, excludeTransfers });
  const { parents, totalExp, totalInc } = buildTree(flatRows, categories);

  const wb = XLSX.utils.book_new();
  const sheetRows = [['Categoria','Subcategoria','Montante','Subtotal']];
  parents.forEach(p => {
    const net = p.income - p.expenses;
    if (!p.children.length) {
      sheetRows.push([p.category, p.category, net, '']);
    } else {
      p.children.sort((a,b)=>a.subName.localeCompare(b.subName,'pt-BR')).forEach(c => {
        sheetRows.push([p.category, c.subName, c.income-c.expenses, '']);
      });
    }
    sheetRows.push(['', 'Subtotal', '', net]);
  });
  sheetRows.push(['', 'Rendimento total', '', totalInc]);
  sheetRows.push(['', 'Despesas totais',  '', -totalExp]);
  sheetRows.push(['', 'Diferença',        '', totalInc-totalExp]);
  const ws = XLSX.utils.aoa_to_sheet(sheetRows);
  ws['!cols'] = [{wch:25},{wch:25},{wch:16},{wch:16}];
  XLSX.utils.book_append_sheet(wb, ws, 'Resumo');
  XLSX.writeFile(wb, `relatorio_${from||'completo'}.xlsx`);
  toast('Excel exportado!');
}

async function exportReportPDF() {
  const el = G('report-output');
  if (!el?.innerHTML?.trim()) { toast('Gere um relatório primeiro'); return; }
  const from = G('rep-from').value;
  const to   = G('rep-to').value;
  const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
  <title>Cruzeiro — Relatório</title>
  <style>
    body{font-family:'Segoe UI',Arial,sans-serif;font-size:12px;color:#1a2332;margin:28px 36px}
    h1{font-size:16px;text-align:center;text-decoration:underline;margin-bottom:4px}
    .sub{text-align:center;font-size:12px;color:#666;margin-bottom:18px}
    table{width:100%;border-collapse:collapse}
    th{font-size:10px;color:#666;text-transform:uppercase;padding:6px 10px;border-bottom:1px solid #ccc;text-align:left}
    td{padding:5px 10px;border-bottom:1px solid #eee}
    .right{text-align:right}
    .green{color:#15803d}.red{color:#dc2626}
  </style></head><body>
  <h1>Resumo das receitas e despesas</h1>
  <div class="sub">${from ? fmtDate(from)+' para '+fmtDate(to) : 'Período completo'}</div>
  ${el.innerHTML}
  </body></html>`;
  const saved = await ff.saveFile({ defaultPath:`relatorio_${from||'completo'}.html`, content: html });
  if (saved) toast('Salvo como HTML — Ctrl+P no navegador para PDF');
}

// ══ EVOLUÇÃO ══
let _ev = {
  ipca: {},
  catConfig:     [], // [{cat,mode}] — Resumo
  catConfigCats: [], // [{cat,mode}] — Por Categoria
  allCats: [],
};

// ── Config ──
async function saveEvConfig() {
  const cfg = await ff.overviewConfigGet().catch(()=>({})) || {};
  Object.assign(cfg, {
    ev_catConfig:     _ev.catConfig,
    ev_catConfigCats: _ev.catConfigCats,
    ev_view:    G('ev-view-categories')?.classList.contains('primary') ? 'categories' : 'summary',
    ev_display: G('ev-display-charts')?.classList.contains('primary') ? 'charts' : 'table',
    ev_year:    G('ev-year')?.value,
    ev_ipca:    G('ev-ipca')?.checked,
    ev_ma:      G('ev-ma')?.checked,
  });
  await ff.overviewConfigSave(cfg).catch(()=>{});
}

async function loadEvolucaoConfig() {
  const ipca = await ff.evolucaoIpcaGet().catch(()=>({}));
  _ev.ipca = Object.fromEntries(Object.entries(ipca).filter(([k,v])=>parseInt(k)>=2000&&v>0&&v<1));
  const cfg = await ff.overviewConfigGet().catch(()=>null);
  if (!cfg) return;
  if (cfg.ev_catConfig?.length)      _ev.catConfig     = cfg.ev_catConfig;
  if (cfg.ev_catConfigCats?.length)  _ev.catConfigCats = cfg.ev_catConfigCats;
  if (cfg.ev_view)    evSetView(cfg.ev_view);
  if (cfg.ev_display) evSetDisplay(cfg.ev_display);
  if (cfg.ev_year    && G('ev-year'))    G('ev-year').value    = cfg.ev_year;
  if (cfg.ev_ipca    === false && G('ev-ipca')) G('ev-ipca').checked = false;
  if (cfg.ev_ma      === false && G('ev-ma'))   G('ev-ma').checked   = false;
}

function evSetView(val) {
  // Update hidden state via button active classes (replaces select value)
  ['summary','categories'].forEach(v => {
    const btn = G('ev-view-' + v);
    if (btn) { btn.classList.toggle('primary', v === val); }
  });
  saveEvConfig(); refreshEvolucao();
}
function evSetDisplay(val) {
  ['table','charts'].forEach(v => {
    const btn = G('ev-display-' + v);
    if (btn) { btn.classList.toggle('primary', v === val); }
  });
  saveEvConfig(); refreshEvolucao();
}
function onEvViewChange()    { saveEvConfig(); refreshEvolucao(); }
function onEvDisplayChange() { saveEvConfig(); refreshEvolucao(); }

// ── IPCA ──
function inflateAnnual(value, fromYear, refYear) {
  if (!value || fromYear > refYear) return value || 0;
  let f = 1;
  for (let y = fromYear; y <= refYear; y++) {
    const rate = _ev.ipca[String(y)] ?? _ev.ipca[y] ?? 0;
    if (rate > 0) f *= (1 + rate);
  }
  return value * f;
}
function inflateMonth(value, fromMonth, refYear) {
  return inflateAnnual(value, parseInt(fromMonth.slice(0,4)), refYear);
}
function movAvg12(arr, i) {
  const w = arr.slice(Math.max(0,i-11),i+1).filter(v=>v!==0&&!isNaN(v));
  return w.length ? w.reduce((s,v)=>s+v,0)/w.length : 0;
}

// ── Data ──
async function getEvolucaoData() {
  const excl = [..._excludedCats];
  const [sumRows, catRows] = await Promise.all([
    ff.evolucaoSummary({ excludedCats: excl }),
    ff.evolucaoByCat({ excludedCats: excl }),
  ]);
  _ev.allCats = [...new Set(catRows.map(r=>r.category))].sort();

  // byCategory — filtered by catConfigCats for "Por Categoria" view
  const allowedCats = buildAllowedCats(_ev.catConfigCats);
  const byCategory = {};
  catRows.forEach(r => {
    if (allowedCats && !allowedCats.has(r.category)) return;
    if (!byCategory[r.month]) byCategory[r.month] = {};
    byCategory[r.month][r.category] = { income: r.income||0, expenses: r.expenses||0 };
  });

  // summary — from full catRows, filtered by catConfig (Resumo)
  const allowedSummary = buildAllowedCats(_ev.catConfig);
  const byCatFull = {};
  catRows.forEach(r => {
    if (!byCatFull[r.month]) byCatFull[r.month] = {};
    byCatFull[r.month][r.category] = { income: r.income||0, expenses: r.expenses||0 };
  });

  return { byCategory, byCatFull };
}

// ── Allowed cats set ──
function buildAllowedCats(config) {
  if (!config?.length) return null;
  const modeOf = {};
  config.forEach(({cat,mode}) => modeOf[cat] = mode);
  const allowed = new Set();
  config.forEach(({cat,mode}) => {
    if (mode === 'excluded') return;
    if (mode === 'consolidated') {
      _ev.allCats.forEach(c => {
        if ((c===cat||c.startsWith(cat+':')) && modeOf[c]!=='excluded') allowed.add(c);
      });
      allowed.add(cat);
    } else if (mode !== 'in-total') {
      allowed.add(cat);
    } else {
      allowed.add(cat); // in-total: include in data but buildCatColumns won't make a column
    }
  });
  return allowed;
}

// ── Summary from byCategory ──
function computeSummaryFromByCat(months, byCatFull) {
  const modeOf = {};
  _ev.catConfig.forEach(({cat,mode}) => modeOf[cat] = mode);
  const summary = {};
  months.forEach(m => {
    let inc = 0, exp = 0;
    const mo = byCatFull[m] || {};
    Object.entries(mo).forEach(([cat,d]) => {
      if (modeOf[cat] === 'excluded') return;
      if (_ev.catConfig.length && modeOf[cat] === undefined) return;
      const net = (d.income||0)-(d.expenses||0);
      if (net > 0) inc += net;
      else         exp += Math.abs(net);
    });
    summary[m] = { income: inc, expenses: exp };
  });
  return summary;
}

// ── Cat columns for "Por Categoria" ──
function buildCatColumns(byCategory, months) {
  const config = _ev.catConfigCats.length ? _ev.catConfigCats
    : _ev.allCats.slice(0,10).map(c=>({cat:c,mode:'self'}));
  const modeOf = {};
  config.forEach(({cat,mode}) => modeOf[cat] = mode);
  return config
    .filter(({mode}) => mode !== 'excluded' && mode !== 'in-total')
    .map(({cat,mode}) => {
      const label = mode==='consolidated' ? `${cat} (total)` : cat;
      const values = months.map(m => {
        const mo = byCategory[m] || {};
        let inc=0, exp=0;
        if (mode==='consolidated') {
          Object.entries(mo).forEach(([k,d]) => {
            if ((k===cat||k.startsWith(cat+':'))&&modeOf[k]!=='excluded') {
              inc+=d.income||0; exp+=d.expenses||0;
            }
          });
        } else {
          const d=mo[cat]; if(d){inc=d.income||0;exp=d.expenses||0;}
        }
        return { inc, exp, net: exp-inc };
      });
      return { cat, mode, label, values };
    });
}

// ── Refresh ──
async function refreshEvolucao() {
  const view    = G('ev-view-categories')?.classList.contains('primary') ? 'categories' : 'summary';
  const display = G('ev-display-charts')?.classList.contains('primary') ? 'charts' : 'table';
  const useIPCA = G('ev-ipca')?.checked  !== false;
  const useMA   = G('ev-ma')?.checked    !== false;
  const selYear = G('ev-year')?.value    || 'all';

  // IPCA status
  const currentYear = new Date().getFullYear();
  const ipcaYears = Object.keys(_ev.ipca).map(Number).filter(y=>y<currentYear).sort((a,b)=>a-b);
  const refYear   = ipcaYears.length ? ipcaYears[ipcaYears.length-1] : null;
  const statusEl  = G('ev-ipca-status');
  if (statusEl) {
    if (ipcaYears.length) {
      statusEl.style.display='block';
      statusEl.textContent=`IPCA carregado: ${ipcaYears[0]}–${refYear} — valores em R$ de dez/${refYear}`;
    } else if (useIPCA) {
      statusEl.style.display='block';
      statusEl.textContent='⚠ IPCA não carregado — clique em "📡 Atualizar IPCA"';
    } else {
      statusEl.style.display='none';
    }
  }
  if (G('ev-ipca-note')) G('ev-ipca-note').textContent = useIPCA&&refYear ? `R$ de ${refYear}` : '';

  const { byCategory, byCatFull } = await getEvolucaoData();
  const now2 = new Date();
  const curM2 = `${now2.getFullYear()}-${String(now2.getMonth()+1).padStart(2,'0')}`;
  const allMonths = [...new Set([...Object.keys(byCategory),...Object.keys(byCatFull)])]
    .filter(m => m <= curM2).sort();

  if (!allMonths.length) {
    if (G('ev-tbody')) G('ev-tbody').innerHTML='<tr><td colspan="20" class="empty" style="padding:2rem">Sem dados</td></tr>';
    return;
  }

  // Year selector
  const years = [...new Set(allMonths.map(m=>m.slice(0,4)))].sort();
  const evYear = G('ev-year');
  if (evYear) {
    const cur = evYear.value;
    evYear.innerHTML = '<option value="all">Todos os anos</option>'+
      years.map(y=>`<option value="${y}" ${y===cur?'selected':''}>${y}</option>`).join('');
    if (cur && years.includes(cur)) evYear.value = cur;
  }

  const months = selYear==='all' ? allMonths : allMonths.filter(m=>m.startsWith(selYear));
  const corr = (v,m) => useIPCA&&refYear ? inflateMonth(v,m,refYear) : (v||0);

  // Show/hide panels
  G('ev-table-view').style.display  = display==='table'  ? '' : 'none';
  G('ev-chart-view').style.display  = display==='charts' ? '' : 'none';

  const summary = computeSummaryFromByCat(months, byCatFull);

  // Store IPCA-corrected MA12 lucro globally for Aposentadoria tab
  // Uses ALL months (not filtered by year selector)
  {
    const allSummary = computeSummaryFromByCat(allMonths, byCatFull);
    const allInc = allMonths.map(m => corr(allSummary[m]?.income   || 0, m));
    const allExp = allMonths.map(m => corr(allSummary[m]?.expenses || 0, m));
    const allLuc = allInc.map((v,i) => v - allExp[i]);
    const allMA12 = allMonths.map((_,i) => movAvg12(allLuc, i));
    window._evMA12LucroByMonth = {};
    allMonths.forEach((m, i) => { window._evMA12LucroByMonth[m] = allMA12[i]; });
  }

  if (display==='table') {
    if (view==='summary')    renderEvSummaryTable(months, summary, corr, useMA);
    else                     renderEvCatTable(months, byCategory, corr, useMA);
  } else {
    if (view==='summary')    renderEvSummaryCharts(months, summary, corr, useMA);
    else                     renderEvCatCharts(months, byCategory, corr, useMA);
  }
}

// ── Tabela Resumo ──
function renderEvSummaryTable(months, summary, corr, useMA) {
  if (G('ev-table-title')) G('ev-table-title').textContent = 'Resumo mensal';
  const inc = months.map(m=>corr(summary[m]?.income||0,m));
  const exp = months.map(m=>corr(summary[m]?.expenses||0,m));
  const luc = inc.map((v,i)=>v-exp[i]);
  const dI  = months.map((_,i)=>useMA?movAvg12(inc,i):inc[i]);
  const dE  = months.map((_,i)=>useMA?movAvg12(exp,i):exp[i]);
  const dL  = months.map((_,i)=>useMA?movAvg12(luc,i):luc[i]);
  const maL = useMA ? 'Média 12m' : 'Média';

  G('ev-thead').innerHTML=`<tr>
    <th style="position:sticky;left:0;background:var(--bg2);z-index:2;min-width:80px">Mês</th>
    <th class="right" style="min-width:200px">Renda</th>
    <th class="right" style="min-width:200px">${maL} Renda</th>
    <th class="right" style="min-width:200px">Renda Acum.</th>
    <th class="right" style="min-width:200px">Despesa</th>
    <th class="right" style="min-width:200px">${maL} Desp.</th>
    <th class="right" style="min-width:200px">Despesa Acum.</th>
    <th class="right" style="min-width:200px">Lucro</th>
    <th class="right" style="min-width:200px">${maL} Lucro</th>
    <th class="right" style="min-width:200px">Lucro Acum.</th>
    <th class="right" style="min-width:90px">% Lucro</th>
  </tr>`;

  const byYear = {};
  months.forEach((m,i)=>{const y=m.slice(0,4);if(!byYear[y])byYear[y]=[];byYear[y].push(i);});

  let html='';
  Object.keys(byYear).sort().reverse().forEach(year=>{
    const idxs=byYear[year];
    let aI=0,aE=0,aL=0;
    const cum={};
    [...idxs].forEach(i=>{aI+=inc[i];aE+=exp[i];aL+=luc[i];cum[i]={aI,aE,aL};});
    const aPct=aI>0?(aL/aI*100):0;
    html+=`<tr style="background:var(--bg4);border-top:2px solid var(--border2);font-weight:700">
      <td style="position:sticky;left:0;background:var(--bg4);font-size:13px">${year}</td>
      <td class="amt-inc right">${fmtBRL(aI)}</td><td class="right" style="color:var(--text3)">—</td><td class="right" style="color:var(--text3)">—</td>
      <td class="amt-exp right">${fmtBRL(aE)}</td><td class="right" style="color:var(--text3)">—</td><td class="right" style="color:var(--text3)">—</td>
      <td class="${aL>=0?'amt-inc':'amt-exp'} right">${fmtBRL(aL)}</td><td class="right" style="color:var(--text3)">—</td><td class="right" style="color:var(--text3)">—</td>
      <td class="right" style="color:var(--text2)">${aPct.toFixed(1)}%</td>
    </tr>`;
    [...idxs].reverse().forEach(i=>{
      const m=months[i];
      const mn=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][parseInt(m.slice(5))-1];
      const {aI:cI,aE:cE,aL:cL}=cum[i];
      const mPct=cI>0?(cL/cI*100):0;
      html+=`<tr class="ev-sum-row" data-month="${m}" style="cursor:pointer">
        <td style="position:sticky;left:0;background:var(--bg2);font-size:12px;color:var(--text2);padding-left:12px">${mn}</td>
        <td class="amt-inc right ev-cell" data-type="income"   style="font-size:12px">${fmtBRL(inc[i])}</td>
        <td class="right" style="font-size:12px;color:var(--text2)">${fmtBRL(dI[i])}</td>
        <td class="right" style="font-size:12px;color:var(--text2)">${fmtBRL(cI)}</td>
        <td class="amt-exp right ev-cell" data-type="expenses" style="font-size:12px">${fmtBRL(exp[i])}</td>
        <td class="right" style="font-size:12px;color:var(--text2)">${fmtBRL(dE[i])}</td>
        <td class="right" style="font-size:12px;color:var(--text2)">${fmtBRL(cE)}</td>
        <td class="${luc[i]>=0?'amt-inc':'amt-exp'} right ev-cell" data-type="all" style="font-size:12px">${fmtBRL(luc[i])}</td>
        <td class="right" style="font-size:12px;color:var(--text2)">${fmtBRL(dL[i])}</td>
        <td class="${cL>=0?'amt-inc':'amt-exp'} right" style="font-size:12px">${fmtBRL(cL)}</td>
        <td class="right" style="font-size:12px;color:var(--text2)">${mPct.toFixed(1)}%</td>
      </tr>`;
    });
  });
  G('ev-tbody').innerHTML=html;

  G('ev-tbody').querySelectorAll('.ev-sum-row').forEach(row=>{
    row.addEventListener('mouseenter',()=>row.style.background='var(--accent-lt)');
    row.addEventListener('mouseleave',()=>row.style.background='');
    row.addEventListener('click',e=>{
      const type=e.target.closest('.ev-cell')?.dataset.type||'all';
      openEvDetailModal(row.dataset.month,type,null);
    });
  });
}

// ── Tabela Por Categoria ──
function renderEvCatTable(months, byCategory, corr, useMA) {
  if (G('ev-table-title')) G('ev-table-title').textContent = 'Por categoria';
  const columns = buildCatColumns(byCategory, months);

  if (!columns.length) {
    G('ev-thead').innerHTML='';
    G('ev-tbody').innerHTML='<tr><td class="empty" style="padding:2rem">Clique em 🏷 Cat. Categorias para selecionar</td></tr>';
    return;
  }

  const catValues = columns.map(col=>months.map((m,i)=>corr(col.values[i].net,m)));

  G('ev-thead').innerHTML=`<tr>
    <th style="position:sticky;left:0;background:var(--bg2);z-index:2;min-width:80px">Mês</th>
    ${columns.map(c=>`<th class="right" style="min-width:200px;font-size:11px;white-space:nowrap">${esc(c.label)}</th>`).join('')}
  </tr>`;

  const byYear={};
  months.forEach((m,i)=>{const y=m.slice(0,4);if(!byYear[y])byYear[y]=[];byYear[y].push(i);});

  let html='';
  Object.keys(byYear).sort().reverse().forEach(year=>{
    const idxs=byYear[year];
    const yearTotals=columns.map((_,ci)=>idxs.reduce((s,i)=>s+catValues[ci][i],0));
    html+=`<tr style="background:var(--bg4);border-top:2px solid var(--border2);font-weight:700">
      <td style="position:sticky;left:0;background:var(--bg4);font-size:13px">${year}</td>
      ${yearTotals.map(v=>`<td class="${v>0?'amt-exp':v<0?'amt-inc':''} right" style="font-size:12px">${v?fmtBRL(Math.abs(v)):''}</td>`).join('')}
    </tr>`;
    [...idxs].reverse().forEach(i=>{
      const m=months[i];
      const mn=['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][parseInt(m.slice(5))-1];
      html+=`<tr class="ev-cat-row" data-month="${m}" style="cursor:pointer">
        <td style="position:sticky;left:0;background:var(--bg2);font-size:12px;color:var(--text2);padding-left:12px">${mn}</td>
        ${columns.map((col,ci)=>{
          const v=catValues[ci][i];
          if(!v) return `<td class="right" style="color:var(--text3);font-size:12px">—</td>`;
          const cls=v>0?'amt-exp':'amt-inc';
          return `<td class="${cls} right ev-cat-cell" data-cat="${esc(col.cat)}" data-mode="${col.mode}" style="font-size:12px">${fmtBRL(Math.abs(v))}</td>`;
        }).join('')}
      </tr>`;
    });
  });
  G('ev-tbody').innerHTML=html;

  G('ev-tbody').querySelectorAll('.ev-cat-row').forEach(row=>{
    row.addEventListener('mouseenter',()=>row.style.background='var(--accent-lt)');
    row.addEventListener('mouseleave',()=>row.style.background='');
    row.querySelectorAll('.ev-cat-cell').forEach(cell=>{
      cell.addEventListener('click',()=>openEvDetailModalCat(row.dataset.month,cell.dataset.cat,cell.dataset.mode));
    });
  });
}

// ── Modal detalhes — Resumo ──
async function openEvDetailModal(month, type, category) {
  const [y,mo] = month.split('-').map(Number);
  const lastDay = new Date(y,mo,0).getDate();
  const from = `${month}-01`, to = `${month}-${String(lastDay).padStart(2,'0')}`;

  let title = type==='income'?`Receitas — ${month}`:type==='expenses'?`Despesas — ${month}`:`Todas — ${month}`;
  if (category) title = `${category} — ${month}`;
  G('cat-detail-title').textContent = title;
  G('cat-detail-period').textContent = 'Carregando…';
  G('cat-detail-body').innerHTML = '';
  openModal('modal-cat-detail');

  // Build cats filter from catConfig
  let cats = null;
  if (category) {
    const found = _ev.allCats.filter(c=>c===category||c.startsWith(category+':'));
    cats = found.length ? found : [category];
  } else if (_ev.catConfig.length) {
    const modeOf = {};
    _ev.catConfig.forEach(({cat,mode})=>modeOf[cat]=mode);
    const allowed = new Set();
    _ev.catConfig.forEach(({cat,mode})=>{
      if (mode==='excluded') return;
      if (mode==='consolidated') {
        _ev.allCats.forEach(c=>{if((c===cat||c.startsWith(cat+':'))&&modeOf[c]!=='excluded')allowed.add(c);});
        allowed.add(cat);
      } else allowed.add(cat);
    });
    cats = allowed.size ? [...allowed] : null;
  }

  let result;
  try { result = await ff.categoryDetail({ category: cats, fromDate: from, toDate: to }); }
  catch(e) { G('cat-detail-period').textContent='Erro'; G('cat-detail-body').innerHTML=`<div class="empty" style="padding:2rem"><p>${esc(e.message)}</p></div>`; return; }

  let rows = result.rows.filter(r=>r.is_transfer===0&&r.category&&r.category.trim());
  if (type==='income')   rows = rows.filter(r=>r.amount>0);
  if (type==='expenses') rows = rows.filter(r=>r.amount<0);

  G('cat-detail-period').textContent = `${rows.length} transação${rows.length!==1?'ões':''}`;
  if (!rows.length) { G('cat-detail-body').innerHTML='<div class="empty" style="padding:2rem"><p>Sem transações</p></div>'; return; }
  const total = rows.reduce((s,r)=>s+r.amount,0);
  G('cat-detail-body').innerHTML = evDetailTable(rows, title, total);
}

// ── Modal detalhes — Por Categoria ──
async function openEvDetailModalCat(month, cat, mode) {
  const [y,mo] = month.split('-').map(Number);
  const lastDay = new Date(y,mo,0).getDate();
  const from = `${month}-01`, to = `${month}-${String(lastDay).padStart(2,'0')}`;
  const modeOf = {};
  _ev.catConfigCats.forEach(({cat:c,mode:md})=>modeOf[c]=md);
  let cats;
  if (mode==='consolidated') {
    cats = _ev.allCats.filter(c=>(c===cat||c.startsWith(cat+':'))&&modeOf[c]!=='excluded');
    if (!cats.length) cats = [cat];
  } else cats = [cat];

  const title = `${cat}${mode==='consolidated'?' (total)':''} — ${month}`;
  G('cat-detail-title').textContent = title;
  G('cat-detail-period').textContent = 'Carregando…';
  G('cat-detail-body').innerHTML = '';
  openModal('modal-cat-detail');

  let result;
  try { result = await ff.categoryDetail({ category: cats, fromDate: from, toDate: to }); }
  catch(e) { G('cat-detail-period').textContent='Erro'; G('cat-detail-body').innerHTML=`<div class="empty" style="padding:2rem"><p>${esc(e.message)}</p></div>`; return; }

  const rows = result.rows.filter(r=>r.is_transfer===0&&r.category&&r.category.trim());
  const total = rows.reduce((s,r)=>s+r.amount,0);
  G('cat-detail-period').textContent = `${rows.length} transação${rows.length!==1?'ões':''}`;
  if (!rows.length) { G('cat-detail-body').innerHTML='<div class="empty" style="padding:2rem"><p>Sem transações</p></div>'; return; }
  G('cat-detail-body').innerHTML = evDetailTable(rows, title, total);
}

function evDetailTable(rows, title, total) {
  let html=`<table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="border-bottom:2px solid var(--border2)">
      <th style="padding:8px 14px;text-align:left;font-size:11px;color:var(--text3);text-transform:uppercase">Data</th>
      <th style="padding:8px 14px;text-align:left;font-size:11px;color:var(--text3);text-transform:uppercase">Memorando</th>
      <th style="padding:8px 14px;text-align:left;font-size:11px;color:var(--text3);text-transform:uppercase">Categoria</th>
      <th style="padding:8px 14px;text-align:left;font-size:11px;color:var(--text3);text-transform:uppercase">Conta</th>
      <th style="padding:8px 14px;text-align:right;font-size:11px;color:var(--text3);text-transform:uppercase">Montante</th>
    </tr></thead><tbody>`;
  rows.forEach(r=>{
    html+=`<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:6px 14px;white-space:nowrap">${fmtDate(r.date)}</td>
      <td style="padding:6px 14px">${esc(r.memo)}</td>
      <td style="padding:6px 14px;font-size:12px;color:var(--text2)">${esc(r.category)}</td>
      <td style="padding:6px 14px;font-size:12px;color:var(--text2)">${esc(r.account_name)}</td>
      <td style="padding:6px 14px;text-align:right;font-family:'DM Mono',monospace;${r.amount>=0?'color:#16a34a':'color:#dc2626'}">${fmtBRL(r.amount)}</td>
    </tr>`;
  });
  html+=`</tbody></table>
    <div style="padding:12px 14px;border-top:1px solid var(--border2);display:flex;justify-content:space-between">
      <span style="font-size:13px;font-weight:600">${esc(title)}</span>
      <strong style="font-family:'DM Mono',monospace;${total>=0?'color:#16a34a':'color:#dc2626'}">${fmtBRL(total)}</strong>
    </div>`;
  return html;
}

// ── Gráficos Resumo ──
function renderEvSummaryCharts(months, summary, corr, useMA) {
  const inc = months.map(m=>corr(summary[m]?.income||0,m));
  const exp = months.map(m=>corr(summary[m]?.expenses||0,m));
  const luc = inc.map((v,i)=>v-exp[i]);
  const dI=months.map((_,i)=>useMA?movAvg12(inc,i):inc[i]);
  const dE=months.map((_,i)=>useMA?movAvg12(exp,i):exp[i]);
  const dL=months.map((_,i)=>useMA?movAvg12(luc,i):luc[i]);
  const yT={};
  months.forEach((m,i)=>{const y=m.slice(0,4);if(!yT[y])yT[y]={inc:0,exp:0,luc:0};yT[y].inc+=inc[i];yT[y].exp+=exp[i];yT[y].luc+=luc[i];});
  const years=[...new Set(months.map(m=>m.slice(0,4)))].sort();
  const container=G('ev-charts-container'); container.innerHTML='';
  const grid=document.createElement('div'); grid.style.cssText='display:grid;grid-template-columns:repeat(3,1fr);gap:14px'; container.appendChild(grid);
  const charts=[
    {title:'Despesas mensais',data:dE,color:'#dc2626',type:'line',labels:months},
    {title:'Renda mensal',data:dI,color:'#16a34a',type:'line',labels:months},
    {title:'Lucro mensal',data:dL,color:'#2563eb',type:'line',labels:months},
    {title:'Despesas anuais',data:years.map(y=>yT[y]?.exp||0),color:'#dc2626',type:'bar',labels:years},
    {title:'Renda anual',data:years.map(y=>yT[y]?.inc||0),color:'#16a34a',type:'bar',labels:years},
    {title:'Lucro anual',data:years.map(y=>yT[y]?.luc||0),color:'#2563eb',type:'bar',labels:years},
    {title:'% Lucro anual',data:years.map(y=>{const t=yT[y];return t?.inc>0?(t.luc/t.inc*100):0;}),color:'#7c3aed',type:'bar',labels:years,isPct:true},
  ];
  charts.forEach(c=>{
    const wrap=document.createElement('div');
    wrap.style.cssText='background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px';
    wrap.innerHTML=`<h4 style="margin:0 0 12px;font-size:13px;color:var(--text2)">${c.title}</h4><canvas height="160" style="width:100%;display:block"></canvas>`;
    grid.appendChild(wrap);
    const canvas=wrap.querySelector('canvas');
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      if(c.type==='line') drawEvLine(canvas,c.labels,c.data,c.color,c.isPct);
      else drawEvBar(canvas,c.labels,c.data,c.color,c.isPct);
    }));
  });
}

// ── Gráficos Por Categoria ──
function renderEvCatCharts(months, byCategory, corr, useMA) {
  const columns=buildCatColumns(byCategory,months);
  const container=G('ev-charts-container'); container.innerHTML='';
  if(!columns.length){container.innerHTML='<div class="empty" style="padding:2rem"><p>Clique em 🏷 Cat. Categorias para selecionar</p></div>';return;}
  const grid=document.createElement('div'); grid.style.cssText='display:grid;grid-template-columns:repeat(3,1fr);gap:14px'; container.appendChild(grid);
  const COLORS=['#dc2626','#d97706','#7c3aed','#0891b2','#db2777','#65a30d','#ea580c','#059669','#2563eb','#9333ea'];
  columns.forEach((col,ci)=>{
    const rawNet=months.map((m,i)=>corr(col.values[i].net,m));
    const isIncome=rawNet.filter(v=>v!==0).reduce((s,v)=>s+v,0)<0;
    const raw=rawNet.map(v=>isIncome?-v:v);
    const disp=months.map((_,i)=>useMA?movAvg12(raw,i):raw[i]);
    const firstNZ=disp.findIndex(v=>v!==0); const start=firstNZ<0?0:firstNZ;
    const color=isIncome?'#16a34a':COLORS[ci%COLORS.length];
    const wrap=document.createElement('div');
    wrap.style.cssText='background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px';
    wrap.innerHTML=`<h4 style="margin:0 0 12px;font-size:13px;color:${color}">${esc(col.label)} ${isIncome?'📈':'📉'}</h4><canvas height="160" style="width:100%;display:block"></canvas>`;
    grid.appendChild(wrap);
    const canvas=wrap.querySelector('canvas');
    requestAnimationFrame(()=>requestAnimationFrame(()=>drawEvLine(canvas,months.slice(start),disp.slice(start),color)));
  });
}

// ── Funções de desenho ──
function drawEvLine(canvas,labels,values,color,isPct=false){
  const dpr=window.devicePixelRatio||1;
  const W=(canvas.parentElement?.clientWidth||800)-32,H=160;
  canvas.width=W*dpr;canvas.height=H*dpr;canvas.style.width=W+'px';canvas.style.height=H+'px';
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const PL=75,PR=20,PT=10,PB=32,cW=W-PL-PR,cH=H-PT-PB;
  const minV=Math.min(...values,0),maxV=Math.max(...values.map(Math.abs),1),range=Math.max(maxV-minV,1);
  const xOf=i=>PL+(i/(labels.length-1||1))*cW;
  const yOf=v=>PT+cH-((v-minV)/range)*cH;
  const fmt=v=>isPct?v.toFixed(1)+'%':fmtBRLshort(v);
  function draw(hI){
    ctx.clearRect(0,0,W,H);
    for(let n=0;n<=4;n++){const v=minV+(range/4)*n,y=yOf(v);ctx.strokeStyle='#e2e8f0';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(PL,y);ctx.lineTo(PL+cW,y);ctx.stroke();ctx.fillStyle='#94a3b8';ctx.font='10px sans-serif';ctx.textAlign='right';ctx.fillText(fmt(v),PL-4,y+4);}
    if(minV<0){const zy=yOf(0);ctx.strokeStyle='#94a3b8';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(PL,zy);ctx.lineTo(PL+cW,zy);ctx.stroke();}
    const step=Math.max(1,Math.floor(labels.length/10));
    ctx.fillStyle='#94a3b8';ctx.font='9px sans-serif';ctx.textAlign='center';
    labels.forEach((l,i)=>{if(i%step!==0&&i!==labels.length-1)return;ctx.fillText(l,xOf(i),H-PB+14);});
    ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=2;
    values.forEach((v,i)=>i===0?ctx.moveTo(xOf(i),yOf(v)):ctx.lineTo(xOf(i),yOf(v)));ctx.stroke();
    if(hI!==undefined){
      const hx=xOf(hI),hy=yOf(values[hI]);
      ctx.strokeStyle='rgba(0,0,0,.15)';ctx.lineWidth=1;ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(hx,PT);ctx.lineTo(hx,PT+cH);ctx.stroke();ctx.setLineDash([]);
      ctx.beginPath();ctx.arc(hx,hy,5,0,2*Math.PI);ctx.fillStyle=color;ctx.fill();ctx.strokeStyle='#fff';ctx.lineWidth=2;ctx.stroke();
      const lbl=`${labels[hI]}: ${fmt(values[hI])}`;ctx.font='bold 10px sans-serif';const tw=ctx.measureText(lbl).width+12;
      let tx=hx+10;if(tx+tw>W-PR)tx=hx-tw-10;const ty=Math.max(PT+4,hy-24);
      ctx.fillStyle='rgba(26,35,50,.88)';ctx.beginPath();ctx.roundRect(tx,ty,tw,18,4);ctx.fill();ctx.fillStyle='#fff';ctx.textAlign='left';ctx.fillText(lbl,tx+6,ty+13);
    }
  }
  draw();
  canvas.onmousemove=e=>{const rect=canvas.getBoundingClientRect(),mx=e.clientX-rect.left;if(mx<PL||mx>PL+cW){draw();return;}draw(Math.max(0,Math.min(labels.length-1,Math.round((mx-PL)/(cW/(labels.length-1||1))))));};
  canvas.onmouseleave=()=>draw();
}

function drawEvBar(canvas,labels,values,color,isPct=false){
  const dpr=window.devicePixelRatio||1;
  const W=(canvas.parentElement?.clientWidth||800)-32,H=160;
  canvas.width=W*dpr;canvas.height=H*dpr;canvas.style.width=W+'px';canvas.style.height=H+'px';
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const PL=75,PR=20,PT=10,PB=32,cW=W-PL-PR,cH=H-PT-PB;
  const minV=Math.min(...values,0),maxV=Math.max(...values.map(Math.abs),1),range=Math.max(maxV-minV,1);
  const yOf=v=>PT+cH-((v-minV)/range)*cH;
  const fmt=v=>isPct?v.toFixed(1)+'%':fmtBRLshort(v);
  ctx.clearRect(0,0,W,H);
  for(let n=0;n<=4;n++){const v=minV+(range/4)*n,y=yOf(v);ctx.strokeStyle='#e2e8f0';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(PL,y);ctx.lineTo(PL+cW,y);ctx.stroke();ctx.fillStyle='#94a3b8';ctx.font='10px sans-serif';ctx.textAlign='right';ctx.fillText(fmt(v),PL-4,y+4);}
  if(minV<0){const zy=yOf(0);ctx.strokeStyle='#94a3b8';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(PL,zy);ctx.lineTo(PL+cW,zy);ctx.stroke();}
  labels.forEach((l,i)=>{
    const x=PL+(i+0.5)*(cW/labels.length)-Math.max(4,Math.floor(cW/labels.length*0.7))/2;
    const bW=Math.max(4,Math.floor(cW/labels.length*0.7));
    const v=values[i],y=yOf(v),zy=yOf(0);
    const bColor=v>=0?color:'#ef4444';
    ctx.fillStyle=bColor+'cc';ctx.fillRect(x,Math.min(y,zy),bW,Math.abs(y-zy)||1);
    ctx.strokeStyle=bColor;ctx.strokeRect(x,Math.min(y,zy),bW,Math.abs(y-zy)||1);
    ctx.fillStyle='#94a3b8';ctx.font='9px sans-serif';ctx.textAlign='center';ctx.fillText(l,PL+(i+0.5)*(cW/labels.length),H-PB+14);
    if(v!==0){ctx.fillStyle=bColor;ctx.font='bold 9px sans-serif';ctx.fillText(fmt(v),PL+(i+0.5)*(cW/labels.length),Math.min(y,zy)-3);}
  });
}

// ── Seletor de categorias ──
function openEvCatSelector(context) {
  const isSummary = context !== 'categories';
  const configKey = isSummary ? 'catConfig' : 'catConfigCats';
  const title = isSummary ? 'Categorias — Resumo' : 'Categorias — Por Categoria';
  G('ev-cat-modal')?.remove();
  if (!_ev.allCats.length) { toast('Abra a aba Evolução primeiro para carregar as categorias'); return; }

  const parents = {};
  _ev.allCats.forEach(c=>{const p=c.split(':')[0];if(!parents[p])parents[p]=[];if(c.includes(':'))parents[p].push(c);});
  const cfgMap = {};
  _ev[configKey].forEach(({cat,mode})=>cfgMap[cat]=mode);

  let rows='';
  Object.entries(parents).sort(([a],[b])=>a.localeCompare(b,'pt-BR')).forEach(([parent,subs])=>{
    const hasSubs=subs.length>0;
    const pMode=cfgMap[parent]||(hasSubs?'consolidated':'self');
    rows+=`<div style="border-bottom:1px solid var(--border);padding:7px 10px;background:var(--bg3);display:flex;align-items:center;gap:8px">
      <span style="flex:1;font-size:13px;font-weight:600">${esc(parent)}</span>
      <select class="evc-sel inp" data-cat="${esc(parent)}" style="font-size:11px;padding:3px 6px;width:auto;height:auto">
        ${hasSubs?`<option value="consolidated" ${pMode==='consolidated'?'selected':''}>📊 Total consolidado</option><option value="self" ${pMode==='self'?'selected':''}>📋 Só coluna própria</option>`:`<option value="self" ${pMode==='self'?'selected':''}>📋 Incluir</option>`}
        <option value="excluded" ${pMode==='excluded'?'selected':''}>✗ Excluir tudo</option>
      </select></div>`;
    subs.sort().forEach(sub=>{
      const sMode=cfgMap[sub]||'in-total';
      rows+=`<div style="padding:5px 10px 5px 30px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
        <span style="flex:1;font-size:12px;color:var(--text2)">${esc(sub.split(':').slice(1).join(':'))}</span>
        <select class="evc-sel inp" data-cat="${esc(sub)}" style="font-size:11px;padding:3px 6px;width:auto;height:auto">
          <option value="self" ${sMode==='self'?'selected':''}>📋 Coluna + no total</option>
          <option value="in-total" ${sMode==='in-total'?'selected':''}>⊂ Só no total</option>
          <option value="excluded" ${sMode==='excluded'?'selected':''}>✗ Excluir de tudo</option>
        </select></div>`;
    });
  });

  const panel=document.createElement('div');
  panel.id='ev-cat-modal';
  panel.style.cssText='position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--bg2);border:1px solid var(--border2);border-radius:12px;z-index:500;width:640px;max-height:85vh;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.18)';
  panel.innerHTML=`
    <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
      <strong style="flex:1;font-size:14px">${title}</strong>
      <button class="btn xs" id="evc-all-in">Todas (consolid.)</button>
      <button class="btn xs" id="evc-all-exc">Excluir todas</button>
      <button class="btn-icon" onclick="G('ev-cat-modal').remove()">✕</button>
    </div>
    <div style="padding:6px 10px;font-size:11px;color:var(--text3);background:var(--bg3);border-bottom:1px solid var(--border)">
      ${isSummary?'Define quais categorias entram no cálculo de Renda, Despesa e Lucro.':'Define quais categorias aparecem na tabela e gráficos de Por Categoria.'}
    </div>
    <div style="overflow-y:auto;flex:1">${rows}</div>
    <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
      <button class="btn" onclick="G('ev-cat-modal').remove()">Cancelar</button>
      <button class="btn primary" id="evc-apply">Aplicar</button>
    </div>`;
  document.body.appendChild(panel);

  G('evc-all-in').onclick=()=>{panel.querySelectorAll('.evc-sel').forEach(e=>{const isP=!e.dataset.cat.includes(':');e.value=isP?'consolidated':'in-total';});};
  G('evc-all-exc').onclick=()=>panel.querySelectorAll('.evc-sel').forEach(e=>e.value='excluded');
  G('evc-apply').onclick=()=>{
    const newConfig=[];
    panel.querySelectorAll('.evc-sel').forEach(sel=>newConfig.push({cat:sel.dataset.cat,mode:sel.value}));
    _ev[configKey]=newConfig;
    G('ev-cat-modal').remove();
    saveEvConfig();
    refreshEvolucao();
  };
}

// ── Atualizar IPCA ──
async function fetchIPCA() {
  toast('⏳ Buscando IPCA do Banco Central…');
  const result = await ff.evolucaoIpcaFetch();
  if (result.ok) {
    _ev.ipca = {};
    Object.entries(result.data).forEach(([k,v])=>{const y=parseInt(k);if(y>=2000&&v>0&&v<1)_ev.ipca[y]=v;});
    await ff.evolucaoIpcaSave(_ev.ipca);
    const years=Object.keys(_ev.ipca).sort();
    toast(`✅ IPCA: ${years[0]}–${years[years.length-1]} (${years.length} anos)`);
    refreshEvolucao();
  } else {
    toast(`❌ Erro IPCA: ${result.error}`);
  }
}

// ── Category Types ──
let _catTypes = {};
async function loadCatTypes() {
  try { _catTypes = await ff.catTypesGet()||{}; } catch(e) { _catTypes={}; }
}
function getCatType(cat) {
  if (_catTypes[cat]) return _catTypes[cat];
  const kws=['salário','salario','renda','rendimento','honorário','honorario','juros','reembolso','auxílio','auxilio','resgate','dividendo','bolsa','presentes'];
  return kws.some(k=>cat.toLowerCase().includes(k)) ? 'income' : 'expense';
}
async function openCatTypesConfig() {
  await loadCatTypes();
  const rows = await ff.reportSummary({ excludeTransfers: false });
  const accountNames = new Set((accounts||[]).map(a=>a.name));
  const transferCats = new Set(['Transferência','Transferências','Transferencia','Transferencias']);
  const allCats = [...new Set(rows.map(r=>r.category).filter(c=>c&&c.trim()&&!accountNames.has(c)&&!transferCats.has(c)))].sort();
  let html='<div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">';
  allCats.forEach(cat=>{
    const type=_catTypes[cat]||getCatType(cat);
    html+=`<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--border)">
      <span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(cat)}">${esc(cat)}</span>
      <select class="ct-sel inp" data-cat="${esc(cat)}" style="font-size:11px;padding:2px 4px;width:auto;height:auto">
        <option value="income"  ${type==='income' ?'selected':''}>📈 Receita</option>
        <option value="expense" ${type==='expense'?'selected':''}>📉 Despesa</option>
      </select></div>`;
  });
  html+='</div>';
  G('cat-types-body').innerHTML=html;
  openModal('modal-cat-types');
}
async function saveCatTypes() {
  const newTypes={};
  document.querySelectorAll('.ct-sel').forEach(sel=>{newTypes[sel.dataset.cat]=sel.value;});
  _catTypes=newTypes;
  await ff.catTypesSave(_catTypes);
  closeModal('modal-cat-types');
  toast('✅ Tipos de categoria salvos');
  refreshOverview();
}

// ── Overview cards (same logic as Evolução) ──
async function computeOverviewMonthSummary(fromDate, toDate) {
  const excl=[..._excludedCats];
  const month=fromDate.slice(0,7);
  const catRows=await ff.evolucaoByCat({excludedCats:excl});
  if (!_ev.allCats.length) _ev.allCats=[...new Set(catRows.map(r=>r.category))].sort();
  const byCatFull={};
  catRows.forEach(r=>{if(!byCatFull[r.month])byCatFull[r.month]={};byCatFull[r.month][r.category]={income:r.income||0,expenses:r.expenses||0};});
  const summary=computeSummaryFromByCat([month],byCatFull);
  return summary[month]||{income:0,expenses:0};
}

// ══ PATRIMÔNIO ══
const TIR_TOOLTIP = 'Taxa Interna de Retorno anualizada (real, ajustada pelo IPCA)';

// ── Patrimônio chart state ──
let _patView = 'table'; // 'table' | 'chart'
let _patCharts = {}; // { total, imob, inv, asset }

function patSetView(view) {
  _patView = view;
  const tableWrap = G('pat-view-table-wrap');
  const chartWrap = G('pat-view-chart-wrap');
  const btnTable  = G('pat-view-table');
  const btnChart  = G('pat-view-chart');
  if (!tableWrap || !chartWrap) return;
  if (view === 'chart') {
    tableWrap.style.display = 'none';
    chartWrap.style.display = '';
    btnTable.classList.remove('primary');
    btnChart.classList.add('primary');
    refreshPatrimonioChart();
  } else {
    tableWrap.style.display = '';
    chartWrap.style.display = 'none';
    btnTable.classList.add('primary');
    btnChart.classList.remove('primary');
  }
}

function patDestroyCharts() {
  Object.values(_patCharts).forEach(c => { try { c.destroy(); } catch(e) {} });
  _patCharts = {};
}

function patMakeChart(canvasId, datasets, labels, yLabel) {
  const canvas = G(canvasId);
  if (!canvas || typeof Chart === 'undefined') return null;
  const shortLabels = labels.map(m => {
    const [y, mo] = m.split('-');
    return ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][parseInt(mo)-1] + '/' + y.slice(2);
  });
  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: shortLabels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.parsed.y;
              if (v == null) return null;
              return ` ${ctx.dataset.label}: ${yLabel === 'BRL' ? fmtBRL(v) : v.toFixed(1) + '%'}`;
            }
          }
        }
      },
      scales: {
        x: { ticks: { font: { size: 10 }, maxTicksLimit: 18 }, grid: { display: false } },
        y: {
          ticks: {
            font: { size: 10 },
            callback: v => yLabel === 'BRL' ? 'R$' + (v >= 1e6 ? (v/1e6).toFixed(1)+'M' : v >= 1e3 ? (v/1e3).toFixed(0)+'k' : v.toFixed(0)) : v.toFixed(1)+'%'
          }
        }
      }
    }
  });
}

function patLegendHtml(datasets) {
  return datasets.map(d =>
    `<span style="display:flex;align-items:center;gap:5px">
      <span style="width:20px;height:3px;background:${d.borderColor};display:inline-block;border-radius:2px${d.borderDash?';border-top:2px dashed '+d.borderColor+';background:transparent':''}"></span>
      <span style="color:var(--text2)">${d.label}</span>
    </span>`
  ).join('');
}

function refreshPatrimonioChart() {
  if (typeof Chart === 'undefined') return;
  patDestroyCharts();

  const now = new Date();
  const curM = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

  // ── Build month list (all months with any data, up to curM) ──
  const monthSet = new Set([curM]);
  _pat.historyAll.forEach(h => { if (h.month <= curM) monthSet.add(h.month); });
  _pat.accountBalances.forEach(a => a.history.forEach(h => { if (h.month <= curM) monthSet.add(h.month); }));
  _inv.txAll.forEach(t => { const m = t.month.slice(0,7); if (m <= curM) monthSet.add(m); });
  const months = [...monthSet].sort();

  // ── Asset value by month (imobilizado) ──
  const histMap = {};
  _pat.historyAll.forEach(h => {
    if (!histMap[h.asset_id]) histMap[h.asset_id] = {};
    histMap[h.asset_id][h.month] = h.value;
  });
  const imobByMonth = {};
  months.forEach(m => {
    let t = 0;
    _pat.assets.forEach(a => { const v = histMap[a.id]?.[m]; if (v != null) t += v; });
    imobByMonth[m] = t;
  });

  // ── Account balances by month ──
  const accByMonth = {};
  months.forEach(m => {
    let t = 0;
    _pat.accountBalances.forEach(a => {
      const up = a.history.filter(h => h.month <= m);
      if (up.length) t += up[up.length-1].balance;
    });
    accByMonth[m] = t;
  });

  // ── Investment total by month ──
  const { totals: invByMonth } = calcInvTotalByMonth(months);

  // ── Helper: trim leading months where all values are null/zero ──
  function trimLeading(monthArr, ...seriesArrs) {
    let start = 0;
    for (let i = 0; i < monthArr.length; i++) {
      if (seriesArrs.some(s => s[i] != null && s[i] !== 0)) { start = i; break; }
    }
    return {
      months: monthArr.slice(start),
      series: seriesArrs.map(s => s.slice(start)),
    };
  }

  // ── 1. Total patrimônio — only start when imobilizado OR investimentos have data ──
  const firstRealM = months.find(m => (imobByMonth[m]||0) > 0 || (invByMonth[m]||0) > 0);
  const totalRaw = months.map(m => {
    if (!firstRealM || m < firstRealM) return null;
    const v = (imobByMonth[m]||0) + (accByMonth[m]||0) + (invByMonth[m]||0);
    return v > 0 ? v : null;
  });
  const trimTotal = trimLeading(months, totalRaw);
  const totalDs = [{
    label: 'Total Patrimônio',
    data: trimTotal.series[0],
    borderColor: 'var(--accent)',
    backgroundColor: 'rgba(99,102,241,.08)',
    borderWidth: 2.5,
    pointRadius: 2,
    tension: 0.3,
    fill: true,
    spanGaps: false,
  }];
  _patCharts.total = patMakeChart('pat-chart-total', totalDs, trimTotal.months, 'BRL');

  // ── 2. Patrimônio imobilizado — only months with data ──
  const imobRaw = months.map(m => imobByMonth[m] > 0 ? imobByMonth[m] : null);
  const trimImob = trimLeading(months, imobRaw);
  const imobDs = [{
    label: 'Imobilizado',
    data: trimImob.series[0],
    borderColor: '#f59e0b',
    backgroundColor: 'rgba(245,158,11,.08)',
    borderWidth: 2.5,
    pointRadius: 2,
    tension: 0.3,
    fill: true,
    spanGaps: false,
  }];
  _patCharts.imob = patMakeChart('pat-chart-imob', imobDs, trimImob.months, 'BRL');

  // ── 3. Investimentos vs benchmarks — TWR por ativo, agregado ──
  // Estratégia: calcular TWR individualmente para cada ativo (apenas entre meses
  // consecutivos com atualizacao), depois agregar multiplicando os fatores mensais.
  // Fluxos de capital externo excluem __auto_purchase__ (é sintético, não real).
  const CAPITAL_FLOW_TYPES = new Set(Object.keys(INV_TX_EXTERNAL));

  // Para cada ativo: { month -> value } apenas de atualizacao reais
  // e { month -> extCap } de fluxos de capital reais (excluindo __auto_purchase__)
  // Types that represent external capital (in or out) — not returns
  // compra/aporte: capital entering  (+)
  // venda: capital leaving, but amortizacao IS a return (principal repayment counts as yield)
  // dividendo/juros: income received — ARE return, include in numerator
  // taxa: cost — IS return (negative), include in numerator
  function buildAssetTWR(assetId) {
    const valByM = {};
    _inv.txAll.filter(t => t.asset_id === assetId && t.tx_type === 'atualizacao')
      .forEach(t => {
        const m = t.month.slice(0,7);
        // Include zeroed valuations (e.g. 'Zeragem na venda') — value=0 is a valid endpoint
        valByM[m] = t.total_value;
      });

    // Separate inflows (compra/aporte) from outflows (venda/amortizacao)
    // This is critical for Modified Dietz: outflows must be ADDED to ending value,
    // not subtracted. Combining them into cashIn was the source of the bug.
    const inflowByM  = {}; // money invested (compra/aporte) — positive
    const outflowByM = {}; // proceeds received (venda/amortizacao) — positive
    _inv.txAll.filter(t => t.asset_id === assetId
        && (t.tx_type in INV_TX_EXTERNAL)
        && t.notes !== '__auto_purchase__')
      .forEach(t => {
        const m = t.month.slice(0,7);
        if (t.tx_type === 'compra' || t.tx_type === 'aporte') {
          inflowByM[m]  = (inflowByM[m]  || 0) + t.total_value;
        } else { // venda, amortizacao
          outflowByM[m] = (outflowByM[m] || 0) + t.total_value;
        }
      });

    // Income flows — dividendo, juros, jcp, cupom, taxa
    const incomeByM = {};
    _inv.txAll.filter(t => t.asset_id === assetId && (t.tx_type in INV_TX_INCOME))
      .forEach(t => {
        const m = t.month.slice(0,7);
        const sign = INV_TX_INCOME[t.tx_type]?.sign ?? 1;
        incomeByM[m] = (incomeByM[m] || 0) + sign * t.total_value;
      });

    // Modified Dietz sub-period return.
    // For gaps (no intermediate atualizacao), interpolate values using compound growth
    // between the two known endpoints. This handles illiquid/closed-end funds that only
    // have a purchase price and a final sale/mark — e.g. private equity, closed funds.
    const factors = {};
    const valMonths = Object.keys(valByM).sort();

    // Helper: expand a segment [prevM → curM] with intermediate interpolated values
    // accounting for any inflows/outflows in the intermediate months
    function expandSegment(prevM, curM, vPrevKnown, vCurKnown) {
      // Collect all months in this segment
      const segMonths = [];
      let m = prevM;
      while (m <= curM) {
        segMonths.push(m);
        const [y, mo] = m.split('-').map(Number);
        m = mo === 12 ? `${y+1}-01` : `${y}-${String(mo+1).padStart(2,'0')}`;
      }
      if (segMonths.length < 2) return;

      const n = segMonths.length - 1; // number of sub-periods
      // Compound monthly growth rate assuming no flows in between
      // Adjusted: if there are inflows/outflows in intermediate months, apply them
      // but approximate by distributing the residual growth equally
      const totalInflow  = segMonths.slice(1).reduce((s, m) => s + (inflowByM[m]  || 0), 0);
      const totalOutflow = segMonths.slice(1).reduce((s, m) => s + (outflowByM[m] || 0), 0);
      const totalIncome  = segMonths.slice(1).reduce((s, m) => s + (incomeByM[m]  || 0), 0);

      // Net return over the segment: compute what the "pure" ending value would be
      // if we add back outflows and subtract inflows (Modified Dietz at segment level)
      const adjEnd = vCurKnown + totalOutflow + totalIncome - totalInflow;
      const segReturn = vPrevKnown > 0 ? adjEnd / vPrevKnown - 1 : 0;

      // Monthly compound rate for the segment
      const monthlyRate = n > 0 ? Math.pow(1 + segReturn, 1/n) - 1 : 0;

      // Generate interpolated values and compute per-month factors
      let runVal = vPrevKnown;
      for (let i = 1; i <= n; i++) {
        const mCur  = segMonths[i];
        const mPrev = segMonths[i-1];
        // Interpolated value (compound growth, adjusted for any flows this month)
        const inflow  = inflowByM[mCur]  ?? 0;
        const outflow = outflowByM[mCur] ?? 0;
        const income  = incomeByM[mCur]  ?? 0;
        // If this is the final known month, use the actual value
        const vCur = (mCur === curM) ? vCurKnown : runVal * (1 + monthlyRate) + inflow - outflow;
        const denom = runVal + inflow;
        if (denom > 0) {
          const r = (vCur + outflow + income - runVal - inflow) / denom;
          if (isFinite(r) && Math.abs(r) < 5) factors[mCur] = r;
        }
        runVal = vCur;
      }
    }

    for (let i = 1; i < valMonths.length; i++) {
      const m    = valMonths[i];
      const prev = valMonths[i-1];
      const [py, pmo] = prev.split('-').map(Number);
      const expNext = pmo === 12 ? `${py+1}-01` : `${py}-${String(pmo+1).padStart(2,'0')}`;

      if (m === expNext) {
        // Consecutive months — exact Modified Dietz
        const vPrev   = valByM[prev];
        const vCur    = valByM[m];
        const inflow  = inflowByM[m]  ?? 0;
        const outflow = outflowByM[m] ?? 0;
        const income  = incomeByM[m]  ?? 0;
        const denom   = vPrev + inflow;
        if (denom > 0) {
          const r = (vCur + outflow + income - vPrev - inflow) / denom;
          if (isFinite(r) && Math.abs(r) < 5) factors[m] = r;
        }
      } else {
        // Gap — interpolate compound growth across the missing months
        // Only interpolate if both endpoints have positive values
        const vPrev = valByM[prev];
        const vCur  = valByM[m];
        if (vPrev > 0 && (vCur > 0 || outflowByM[m])) {
          expandSegment(prev, m, vPrev, vCur);
        }
      }
    }
    return factors;
  }

  // Aggregate: collect all months that have at least one asset with a factor
  const allFactors = {}; // { month -> weighted avg factor across assets }
  const allValByM  = {}; // { month -> total portfolio value }
  _inv.assets.forEach(a => {
    _inv.txAll.filter(t => t.asset_id === a.id && t.tx_type === 'atualizacao')
      .forEach(t => {
        const m = t.month.slice(0,7);
        allValByM[m] = (allValByM[m] || 0) + t.total_value;
      });
  });

  _inv.assets.forEach(a => {
    // Exclude cash accounts from investment performance calculations
    if (a.category === 'valor_em_caixa' || a.category === 'caixa') return;
    const factors = buildAssetTWR(a.id);
    Object.entries(factors).forEach(([m, r]) => {
      const prevM = (() => {
        const [y, mo] = m.split('-').map(Number);
        return mo === 1 ? `${y-1}-12` : `${y}-${String(mo-1).padStart(2,'0')}`;
      })();
      // Weight by prev-month value (correct reduce: sum all atualizacao values)
      const aVal = _inv.txAll.filter(t => t.asset_id === a.id && t.tx_type === 'atualizacao'
        && t.month.slice(0,7) === prevM).reduce((s,t) => s + t.total_value, 0);
      if (!allFactors[m]) allFactors[m] = { sumRW: 0, sumW: 0 };
      // Use weight=1 if no prev value (new asset starting this month)
      const weight = aVal > 0 ? aVal : 1;
      allFactors[m].sumRW += r * weight;
      allFactors[m].sumW  += weight;
    });
  });

  // Build chart series from aggregated factors
  const twrMonths = Object.keys(allFactors).sort();
  if (twrMonths.length > 1) {
    // Find first and last month with data
    const allValMonths = Object.keys(allValByM).filter(m => allValByM[m] > 0).sort();
    const firstInvM = allValMonths[0] || twrMonths[0];

    // Build full monthly series from firstInvM using benchmark months
    const chartMonthSet = new Set([firstInvM, ...twrMonths]);
    Object.keys(_benchmarks.cdi).forEach(m => { if (m >= firstInvM && m <= curM) chartMonthSet.add(m); });
    const chartMonths = [...chartMonthSet].filter(m => m >= firstInvM && m <= curM).sort();

    let cumInv = 1, cumCDI = 1, cumIBOV = 1;
    const invRetSeries = [], cdiSeries = [], ibovSeries = [];

    chartMonths.forEach(m => {
      // Apply TWR factor for this month if available
      if (allFactors[m] && allFactors[m].sumW > 0) {
        const wAvgR = allFactors[m].sumRW / allFactors[m].sumW;
        cumInv *= (1 + wAvgR);
      }
      cumCDI  *= (1 + (_benchmarks.cdi[m]  ?? 0));
      cumIBOV *= (1 + (_benchmarks.ibov[m] ?? 0));
      invRetSeries.push(parseFloat(((cumInv  - 1) * 100).toFixed(2)));
      cdiSeries.push   (parseFloat(((cumCDI  - 1) * 100).toFixed(2)));
      ibovSeries.push  (parseFloat(((cumIBOV - 1) * 100).toFixed(2)));
    });

    // Cache for use by patRenderInvChart() with period selector
    _pat._allFactors = allFactors;
    _pat._allValByM  = allValByM;
    _pat._chartCurM  = curM;
  }

  // ── 4. Asset selector ──
  patPopulateAssetSel();
  // Render investment chart with period selector
  patRenderInvChart();
}

function patPopulateAssetSel() {
  const sel = G('pat-chart-asset-sel');
  if (!sel) return;
  const showHidden = G('pat-chart-show-hidden')?.checked;
  const prev = sel.value;
  const assets = _inv.assets.filter(a => showHidden || !a.hidden);
  sel.innerHTML = '<option value="">— Selecione um ativo —</option>' +
    assets.map(a => `<option value="${a.id}" ${a.id==prev?'selected':''}>${esc(a.name)}</option>`).join('');
  if (prev && assets.find(a => String(a.id) === prev)) patRenderAssetChart();
}

function patRenderInvChart() {
  // Handle custom period date range visibility
  const periodSel = G('pat-chart-inv-period');
  const customDiv = G('pat-chart-inv-custom');
  if (periodSel && customDiv) {
    customDiv.style.display = periodSel.value === 'custom' ? 'flex' : 'none';
  }

  if (_patCharts.inv) { try { _patCharts.inv.destroy(); } catch(e) {} _patCharts.inv = null; }

  // Use the correctly computed allFactors cached by the main chart build
  const allFactors = _pat._allFactors;
  const allValByM  = _pat._allValByM;
  const curM       = _pat._chartCurM;
  if (!allFactors || !allValByM || !curM) return;

  const now = new Date();
  const period = periodSel?.value || '12';
  let fromM = null;

  if (period === '0') {
    fromM = null;
  } else if (period === 'thisyear') {
    fromM = `${now.getFullYear()}-01`;
  } else if (period === 'custom') {
    fromM = G('pat-chart-inv-from')?.value || null;
  } else {
    const n = parseInt(period);
    if (!isNaN(n)) {
      const d = new Date(now.getFullYear(), now.getMonth() - n + 1, 1);
      fromM = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    }
  }
  const toM = period === 'custom' ? (G('pat-chart-inv-to')?.value || curM) : curM;

  const allValMonths = Object.keys(allValByM).filter(m => allValByM[m] > 0).sort();
  if (!allValMonths.length) return;

  // Determine the effective start month for the period
  const absFirst = allValMonths[0];
  const effectiveFrom = fromM ? (fromM > absFirst ? fromM : absFirst) : absFirst;

  // Build chart month set spanning effectiveFrom..toM
  const chartMonthSet = new Set();
  chartMonthSet.add(effectiveFrom);
  Object.keys(allFactors).forEach(m => { if (m >= effectiveFrom && m <= toM) chartMonthSet.add(m); });
  Object.keys((_benchmarks||{}).cdi || {}).forEach(m => { if (m >= effectiveFrom && m <= toM) chartMonthSet.add(m); });
  const chartMonths = [...chartMonthSet].sort();

  if (chartMonths.length < 2) return;

  // For period-sliced charts, reset cumulative returns to 1.0 at the start of the period
  // by finding the cumulative factor up to effectiveFrom and dividing subsequent months
  // Simpler: just accumulate from effectiveFrom treating it as base=0%
  let cumInv = 1, cumCDI = 1, cumIBOV = 1;
  const invRetSeries = [], cdiSeries = [], ibovSeries = [];

  chartMonths.forEach(m => {
    if (m > effectiveFrom && allFactors[m] && allFactors[m].sumW > 0) {
      cumInv *= (1 + allFactors[m].sumRW / allFactors[m].sumW);
    }
    if (m > effectiveFrom) {
      cumCDI  *= (1 + ((_benchmarks||{}).cdi?.[m]  ?? 0));
      cumIBOV *= (1 + ((_benchmarks||{}).ibov?.[m] ?? 0));
    }
    invRetSeries.push(parseFloat(((cumInv  - 1) * 100).toFixed(2)));
    cdiSeries.push   (parseFloat(((cumCDI  - 1) * 100).toFixed(2)));
    ibovSeries.push  (parseFloat(((cumIBOV - 1) * 100).toFixed(2)));
  });

  const invDs = [
    { label: 'Investimentos', data: invRetSeries, borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,.08)', borderWidth: 2.5, pointRadius: 2, tension: 0.3, fill: false },
    { label: 'CDI',           data: cdiSeries,    borderColor: '#16a34a', borderWidth: 2, borderDash: [5,4], pointRadius: 0, tension: 0.1, fill: false },
    { label: 'IBOVESPA',      data: ibovSeries,   borderColor: '#f59e0b', borderWidth: 2, borderDash: [3,3], pointRadius: 0, tension: 0.1, fill: false },
  ];
  _patCharts.inv = patMakeChart('pat-chart-inv', invDs, chartMonths, 'PCT');
  const leg = G('pat-chart-inv-legend');
  if (leg) leg.innerHTML = patLegendHtml(invDs);
}

function patRenderAssetChart() {
  if (_patCharts.asset) { try { _patCharts.asset.destroy(); } catch(e) {} _patCharts.asset = null; }
  const sel = G('pat-chart-asset-sel');
  if (!sel?.value) return;
  const assetId = parseInt(sel.value);
  const a = _inv.assets.find(x => x.id === assetId);
  if (!a) return;

  const now = new Date();
  const todayM = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  // For closed assets, stop at their closing month
  const curM = a.closed_month && a.closed_month < todayM ? a.closed_month : todayM;

  // Get valuation transactions for this asset
  const txs = _inv.txAll.filter(t => t.asset_id === assetId && t.tx_type === 'atualizacao');
  if (!txs.length) return;

  const valByMonth = {};
  txs.forEach(t => { valByMonth[t.month.slice(0,7)] = t.total_value; });

  // External capital: compra/aporte (in), venda (out) — not amortizacao/juros/dividendo
  const assetInflow2  = {}; // compra/aporte — money invested
  const assetOutflow2 = {}; // venda/amortizacao — proceeds received
  _inv.txAll.filter(t => t.asset_id === assetId
      && (t.tx_type in INV_TX_EXTERNAL)
      && t.notes !== '__auto_purchase__')
    .forEach(t => {
      const m = t.month.slice(0,7);
      if (t.tx_type === 'compra' || t.tx_type === 'aporte') {
        assetInflow2[m]  = (assetInflow2[m]  || 0) + t.total_value;
      } else {
        assetOutflow2[m] = (assetOutflow2[m] || 0) + t.total_value;
      }
    });

  // Income flows (dividendo, juros, jcp, cupom, taxa)
  const assetIncome2 = {};
  _inv.txAll.filter(t => t.asset_id === assetId && (t.tx_type in INV_TX_INCOME))
    .forEach(t => {
      const m = t.month.slice(0,7);
      const sign = INV_TX_INCOME[t.tx_type]?.sign ?? 1;
      assetIncome2[m] = (assetIncome2[m] || 0) + sign * t.total_value;
    });

    // Only use months with a real valuation > 0
  // Include months with value=0 if they have an outflow (sold/zeroed asset)
  const dataMonths = Object.keys(valByMonth).filter(m => {
    if (m > curM) return false;
    if (valByMonth[m] > 0) return true;
    // Zero value — only include if it has an outflow (venda/zeragem)
    return (assetOutflow2[m] ?? 0) > 0;
  }).sort();
  if (!dataMonths.length) return;

  // Build full month range for benchmark (CDI months from firstM to curM)
  const firstM = dataMonths[0];
  const bmkMonthSet = new Set(dataMonths);
  Object.keys(_benchmarks.cdi).forEach(m => { if (m >= firstM && m <= curM) bmkMonthSet.add(m); });
  const chartMonths = [...bmkMonthSet].sort();

  let cumCDI = 1, cumIBOV = 1, cumAsset = 1;
  let prevVal = valByMonth[firstM];
  let prevDataM = firstM;
  const assetSeries = [], cdiSeries = [], ibovSeries = [];

  // Pre-compute interpolated monthly rates for gap segments in the individual chart
  // Same logic as buildAssetTWR — fills gaps with compound growth interpolation
  const assetFactors2 = {};
  for (let i = 1; i < dataMonths.length; i++) {
    const mCur  = dataMonths[i];
    const mPrev = dataMonths[i-1];
    const [py, pmo] = mPrev.split('-').map(Number);
    const expNext = pmo === 12 ? `${py+1}-01` : `${py}-${String(pmo+1).padStart(2,'0')}`;

    if (mCur === expNext) {
      // Consecutive — exact Modified Dietz
      const vp = valByMonth[mPrev], vc = valByMonth[mCur];
      const inf = assetInflow2[mCur] ?? 0, out = assetOutflow2[mCur] ?? 0, inc = assetIncome2[mCur] ?? 0;
      const d = vp + inf;
      if (d > 0) {
        const r = (vc + out + inc - vp - inf) / d;
        if (isFinite(r) && Math.abs(r) < 5) assetFactors2[mCur] = r;
      }
    } else {
      // Gap — interpolate compound growth between the two known valuations
      const vp = valByMonth[mPrev], vc = valByMonth[mCur];
      if (vp > 0 && vc >= 0) {
        // Build list of all months in the gap
        const gapMonths = [];
        let gm = mPrev;
        while (gm <= mCur) {
          gapMonths.push(gm);
          const [gy, gmo] = gm.split('-').map(Number);
          gm = gmo === 12 ? `${gy+1}-01` : `${gy}-${String(gmo+1).padStart(2,'0')}`;
        }
        const n = gapMonths.length - 1;
        const totIn  = gapMonths.slice(1).reduce((s, m) => s + (assetInflow2[m]  || 0), 0);
        const totOut = gapMonths.slice(1).reduce((s, m) => s + (assetOutflow2[m] || 0), 0);
        const totInc = gapMonths.slice(1).reduce((s, m) => s + (assetIncome2[m]  || 0), 0);
        const adjEnd = vc + totOut + totInc - totIn;
        const segRet = adjEnd / vp - 1;
        const mr = Math.pow(1 + segRet, 1/n) - 1;
        let runVal = vp;
        for (let j = 1; j <= n; j++) {
          const gc = gapMonths[j], gp = gapMonths[j-1];
          const inf = assetInflow2[gc] ?? 0, out = assetOutflow2[gc] ?? 0, inc = assetIncome2[gc] ?? 0;
          const vc2 = (gc === mCur) ? vc : runVal * (1 + mr) + inf - out;
          const d = runVal + inf;
          if (d > 0) {
            const r = (vc2 + out + inc - runVal - inf) / d;
            if (isFinite(r) && Math.abs(r) < 5) assetFactors2[gc] = r;
          }
          runVal = vc2;
        }
      }
    }
  }

  chartMonths.forEach(m => {
    cumCDI  *= (1 + (_benchmarks.cdi[m]  ?? 0));
    cumIBOV *= (1 + (_benchmarks.ibov[m] ?? 0));

    if (assetFactors2[m] !== undefined) {
      cumAsset *= (1 + assetFactors2[m]);
    }

    assetSeries.push(parseFloat(((cumAsset - 1) * 100).toFixed(2)));
    cdiSeries.push  (parseFloat(((cumCDI   - 1) * 100).toFixed(2)));
    ibovSeries.push (parseFloat(((cumIBOV  - 1) * 100).toFixed(2)));
  });

  const bmkName = a.benchmark === 'ibov' ? 'IBOVESPA' : 'CDI';
  const bmkSeries = a.benchmark === 'ibov' ? ibovSeries : cdiSeries;
  const bmkColor  = a.benchmark === 'ibov' ? '#f59e0b' : '#16a34a';

  const datasets = [
    { label: a.name, data: assetSeries, borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,.08)', borderWidth: 2.5, pointRadius: 2, tension: 0.3, fill: false },
    { label: bmkName, data: bmkSeries, borderColor: bmkColor, borderWidth: 2, borderDash: [5,4], pointRadius: 0, tension: 0.1, fill: false },
  ];
  if (a.benchmark !== 'ibov') {
    datasets.push({ label: 'IBOVESPA', data: ibovSeries, borderColor: '#f59e0b', borderWidth: 1.5, borderDash: [3,3], pointRadius: 0, tension: 0.1, fill: false });
  }

  _patCharts.asset = patMakeChart('pat-chart-asset', datasets, chartMonths, 'PCT');
  const leg = G('pat-chart-asset-legend');
  if (leg) leg.innerHTML = patLegendHtml(datasets);
}

let _pat = {
  ipcaMonthly: {},  // {"2024-01": 0.0042, ...}
  assets: [],
  historyAll: [],
  accountBalances: [],
  financing: {},    // {assetId: [{month, installment, paid}]}
  txAll: [],        // pat_transactions for all assets
  currentMonth: '',
};

// Sign convention for pat_transactions (from investor's cash perspective)
const PAT_TX_CASH = {
  compra:                 { label: '🟢 Compra',                   sign: -1 },
  aporte:                 { label: '➕ Aporte de capital',         sign: -1 },
  despesa:                { label: '📋 Despesa do ativo',          sign: -1 },
  parcela_financiamento:  { label: '🏦 Parcela de financiamento',  sign: -1 },
  reducao:                { label: '📉 Redução de capital',        sign: +1 },
  aluguel:                { label: '🏠 Aluguel recebido',          sign: +1 },
  dividendo:              { label: '💰 Dividendo',                 sign: +1 },
  jcp:                    { label: '💵 JCP',                       sign: +1 },
  venda:                  { label: '🔴 Venda',                     sign: +1 },
};

const PAT_ASSET_TYPES = {
  imovel:'🏠 Imóvel', veiculo:'🚗 Veículo', barco:'⛵ Barco',
  clube:'🏌️ Clube', societario:'🏢 Societário', outro:'📦 Outro',
};
const PAT_TRENDS = {
  minus2x:'📉📉 −2× IPCA', minus1x:'📉 −1× IPCA', stable:'➡️ Estável',
  plus1x:'📈 +1× IPCA', plus2x:'📈📈 +2× IPCA'
};

// ── Startup ──
async function initPatrimonio() {
  _pat.ipcaMonthly = await ff.patIpcaMonthlyGet().catch(()=>({}));
  updatePatIpcaStatus();
}

function updatePatIpcaStatus() {
  const keys = Object.keys(_pat.ipcaMonthly).sort();
  const el = G('pat-ipca-status');
  if (!el) return;
  if (keys.length) {
    el.textContent = `IPCA mensal: ${keys[0]} a ${keys[keys.length-1]} (${keys.length} meses)`;
  } else {
    el.textContent = 'IPCA mensal não carregado — clique em "📡 Atualizar IPCA mensal"';
  }
}

async function patFetchIPCA() {
  toast('⏳ Buscando IPCA mensal do BCB…');
  const result = await ff.patIpcaMonthlyFetch();
  if (result.ok) {
    _pat.ipcaMonthly = result.data;
    await ff.patIpcaMonthlySave(_pat.ipcaMonthly);
    updatePatIpcaStatus();
    toast('⏳ Projetando valores futuros…');
    const proj = await ff.patAutoProject({ ipcaMonthly: _pat.ipcaMonthly });
    const msg = proj.projected > 0
      ? `✅ IPCA atualizado. ${proj.projected} valores futuros projetados.`
      : `✅ IPCA atualizado. Nenhum valor futuro a projetar ainda (insira um ativo com valor inicial).`;
    toast(msg);
    refreshPatrimonio();
  } else {
    toast(`❌ Erro: ${result.error}`);
  }
}

// ── Main refresh ──
async function refreshPatrimonio() {
  try {
  _pat.assets          = await ff.patAssetsList();
  _pat.txAll           = await ff.patTxAll().catch(() => []);
  _pat.historyAll      = await ff.patHistoryAll();
  _pat.accountBalances = await ff.patAccountBalances();
  // Load financing installments for all financed assets
  _pat.financing = {};
  for (const a of _pat.assets) {
    if (a.financed) {
      const rows = await ff.patFinancingGet({ assetId: a.id });
      _pat.financing[a.id] = rows;
    }
  }
  await refreshInvestimentos();

  // Build month selector: all months with any data (including inv transactions)
  const now = new Date();
  const curM = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const monthSet = new Set([curM]);
  _pat.historyAll.forEach(h => monthSet.add(h.month));
  _pat.accountBalances.forEach(a => a.history.forEach(h => monthSet.add(h.month)));
  _inv.txAll.forEach(t => { const m = t.month.slice(0,7); if (m <= curM) monthSet.add(m); });

  const months = [...monthSet].sort();
  const selEl = G('pat-month');
  if (selEl) {
    const cur = selEl.value || curM;
    selEl.innerHTML = months.map(m => `<option value="${m}" ${m===cur?'selected':''}>${fmtMonth(m)}</option>`).join('');
    if (!selEl.value) selEl.value = curM;
    _pat.currentMonth = selEl.value;
  } else {
    _pat.currentMonth = curM;
  }

  refreshPatrimonioTable();
  if (_patView === 'chart') refreshPatrimonioChart();
  } catch(e) {
    console.error('[refreshPatrimonio]', e);
    const container = G('pat-all-tables');
    if (container) container.innerHTML = `<div style="padding:24px;color:#dc2626;font-family:monospace;white-space:pre-wrap"><strong>Erro em refreshPatrimonio:</strong>\n${e.stack || e.message}</div>`;
  }
}

function fmtMonth(ym) {
  const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const [y,m] = ym.split('-');
  return `${months[parseInt(m)-1]}/${y}`;
}

function refreshPatrimonioTable() {
  try {
  const now = new Date();
  const curM = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const showHidden = G('pat-show-hidden')?.checked;

  // IPCA cumulative from month m to curM (used for real flow rows)
  const ipcaCumFn2 = m => {
    let cum = 1, cur = m;
    while (cur < curM) {
      const [y,mo] = cur.split('-').map(Number);
      const next = mo===12 ? `${y+1}-01` : `${y}-${String(mo+1).padStart(2,'0')}`;
      cum *= (1 + (_pat.ipcaMonthly[next] ?? 0));
      cur = next;
    }
    return cum;
  };

  // All months from data (no future) — including inv transaction months
  const monthSet = new Set([curM]);
  _pat.historyAll.forEach(h => { if (h.month <= curM) monthSet.add(h.month); });
  _pat.accountBalances.forEach(a => a.history.forEach(h => { if (h.month <= curM) monthSet.add(h.month); }));
  _inv.txAll.forEach(t => { const m = t.month.slice(0,7); if (m <= curM) monthSet.add(m); });
  const months = [...monthSet].sort();
  const COL_W = 130;

  // histMap
  const histMap = {};
  _pat.historyAll.forEach(h => {
    if (!histMap[h.asset_id]) histMap[h.asset_id] = {};
    histMap[h.asset_id][h.month] = { value: h.value, manual: h.manual };
  });

  // ALL assets (including hidden) for totals
  let totalAssets = 0;
  _pat.assets.forEach(a => { const e = histMap[a.id]?.[curM]; if (e) totalAssets += e.value; });
  let totalAccounts = 0;
  _pat.accountBalances.forEach(a => {
    const up = a.history.filter(h => h.month <= curM);
    if (up.length) totalAccounts += up[up.length-1].balance;
  });

  // Investment total — calculated properly below after invTotalByMonth is built
  // (placeholder — will be overwritten after full calculation)
  const grandTotal_placeholder = totalAssets + totalAccounts;
  G('pat-cards').innerHTML = `
    <div class="stat-card"><div class="stat-lbl">🏠 Imobilizado</div><div class="stat-val green">${fmtBRL(totalAssets)}</div><div class="stat-sub">${fmtMonth(curM)}</div></div>
    <div class="stat-card"><div class="stat-lbl">🏦 Contas</div><div class="stat-val green">${fmtBRL(totalAccounts)}</div><div class="stat-sub">${fmtMonth(curM)}</div></div>
    <div class="stat-card" id="pat-card-inv"><div class="stat-lbl">📈 Investimentos</div><div class="stat-val green">…</div><div class="stat-sub">${fmtMonth(curM)}</div></div>
    <div class="stat-card" id="pat-card-total"><div class="stat-lbl">📊 Total Patrimônio</div><div class="stat-val accent" style="font-size:22px">…</div><div class="stat-sub">${fmtMonth(curM)}</div></div>`;

  // Shared month header
  const monthHeader = months.map(m =>
    `<th class="right" style="min-width:${COL_W}px;white-space:nowrap;font-size:11px;padding:6px 10px${m===curM?';background:var(--accent-lt);color:var(--accent)':''}">${fmtMonth(m)}</th>`
  ).join('');

  const STICKY  = 'position:sticky;z-index:2;background:inherit';
  const STICKY3 = 'position:sticky;z-index:3;background:var(--bg3)';
  const STICKY4 = 'position:sticky;z-index:3;background:var(--bg4)';

  // Row stripe helper
  const stripe = i => i%2===0 ? 'var(--bg2)' : 'var(--bg3)';

  // ── IPCA row ──
  const ipcaRow = `<tr style="background:var(--bg4);border-bottom:1px solid var(--border2)">
    <td style="${STICKY};left:0;min-width:460px;font-size:11px;color:var(--text3);font-weight:600;padding:5px 12px" colspan="4">📊 IPCA mensal</td>
    ${months.map(m => {
      const r = _pat.ipcaMonthly[m];
      return `<td class="right" style="font-size:11px;color:var(--text3);padding:5px 10px${m===curM?';background:var(--accent-lt)':''}">${r!=null?(r*100).toFixed(2)+'%':'—'}</td>`;
    }).join('')}
    <td style="${STICKY};right:0;min-width:60px;background:var(--bg4)"></td>
  </tr>`;

  // ── Imobilizado ──
  const visibleAssets = _pat.assets.filter(a => showHidden || !a.hidden);
  const assetTotalByMonth = {};
  months.forEach(m => { assetTotalByMonth[m] = 0; });
  // Totals use ALL assets (including hidden)
  const debtByMonth = {};  // kept for reference (not used in display directly)
  const curM_debt = curM;

  // debtByAsset[assetId][month] = remaining debt (negative)
  // Uses balance_end from schedule if available (more accurate: SAC/PRICE breakdown)
  // Falls back to simple: financing_total − sum of installments paid
  const debtByAsset     = {}; // { assetId: { month: value } }
  const debtProjByAsset = {}; // { assetId: { month: bool } } — true = projected
  _pat.assets.forEach(a => {
    months.forEach(m => {
      const v = histMap[a.id]?.[m]?.value;
      if (v != null) assetTotalByMonth[m] += v;
    });
    if (a.financed && _pat.financing[a.id]?.length) {
      const fins = _pat.financing[a.id].sort((x,y) => x.month.localeCompare(y.month));
      const firstInstMonth = fins[0].month;
      debtByAsset[a.id]     = {};
      debtProjByAsset[a.id] = {};
      months.forEach(m => {
        if (m < firstInstMonth) return;
        // Find the last schedule row at or before m
        const rowsUpTo = fins.filter(r => r.month.slice(0,7) <= m);
        if (!rowsUpTo.length) return;
        const lastRow = rowsUpTo[rowsUpTo.length - 1];
        let balance;
        if (lastRow.balance_end != null) {
          // Use balance_end directly — most accurate
          balance = lastRow.balance_end;
        } else {
          // Fallback: financing_total − paid
          const total = a.financing_total || 0;
          const paid  = rowsUpTo.reduce((s, r) => s + r.installment, 0);
          balance = Math.max(0, total - paid);
        }
        if (balance > 0.01) {
          debtByAsset[a.id][m]     = -balance;
          // Mark as projection if the last real payment before m was projected
          const lastPaid = rowsUpTo.filter(r => r.is_projection === 0 || r.paid === 1);
          const isProjM  = lastRow.is_projection === 1 && m > (lastPaid.at(-1)?.month || '');
          debtProjByAsset[a.id][m] = isProjM;
        }
      });
    }
  });

  let assetRows = '';
  visibleAssets.forEach((a, ri) => {
    const bg = stripe(ri);
    assetRows += `<tr draggable="true" style="background:${bg};height:38px;cursor:grab"
      ondragstart="patDragStart(event,${a.id},'asset')"
      ondragend="patDragEnd(event)"
      ondragover="patDragOver(event,${a.id},'asset')"
      ondragleave="patDragLeave(event)"
      ondrop="patDrop(event,${a.id},'asset')">
      <td style="${STICKY};left:0;min-width:160px;max-width:160px;font-size:12px;font-weight:500;padding:6px 12px;overflow:hidden;background:${bg}" title="${esc(a.name)}">
        <div style="display:flex;align-items:center;gap:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          <span style="color:var(--text3);font-size:13px">⠿</span>
          <span>${esc(a.name)}</span>
          ${a.sold_month?`<span style="font-size:9px;color:#dc2626">vendido ${fmtMonth(a.sold_month)}</span>`:''}
          ${a.hidden?`<span style="font-size:9px;color:var(--text3)">oculto</span>`:''}
        </div>
        <div id="pat-pnl-${a.id}" style="font-size:10px;margin-top:2px;color:var(--text3)"></div>
      </td>
      <td style="${STICKY};left:200px;min-width:80px;max-width:80px;font-size:11px;color:var(--text3);background:${bg}">${PAT_ASSET_TYPES[a.asset_type]||a.asset_type}${a.financed?'<span style="color:#dc2626;font-size:9px;margin-left:3px">🏦</span>':''}</td>
      <td style="${STICKY};left:280px;min-width:90px;max-width:90px;font-size:11px;color:var(--text3);background:${bg}"></td>
      <td style="${STICKY};left:370px;min-width:90px;max-width:90px;font-size:11px;color:var(--text3);background:${bg}">${PAT_TRENDS[a.trend]||a.trend}</td>
      ${months.map(m => {
        const e = histMap[a.id]?.[m];
        const v = e?.value ?? null;
        const isCur = m === curM;
        const cellBg = isCur ? 'var(--accent-lt)' : bg;
        const afterSale = a.sold_month && m > a.sold_month;
        if (v === null) return `<td class="right" style="color:var(--text3);font-size:12px;padding:6px 10px;background:${cellBg}">—</td>`;
        const clickable = !afterSale ? `onclick="patInlineEdit(this,${a.id},'${m}',${v})" title="Clique para editar" style="cursor:pointer"` : '';
        return `<td class="right" style="font-size:12px;padding:6px 10px;background:${cellBg}${afterSale?';opacity:.35':''}" ${clickable}>
          <span style="font-family:'DM Mono',monospace">${fmtBRL(v)}</span>${e?.manual?'<span style="color:var(--accent);font-size:9px"> ✎</span>':''}
        </td>`;
      }).join('')}
      <td style="text-align:center;${STICKY};right:0;min-width:60px;background:${bg}">
        <button class="btn-icon" onclick="openPatAssetModal(${a.id})" title="Editar">✎</button>
        <button class="btn-icon" onclick="deletePatAsset(${a.id})" style="color:var(--red)" title="Excluir">✕</button>
      </td>
    </tr>`;
    // ── Debt row immediately below parent asset, same stripe bg ──
    if (a.financed && debtByAsset[a.id]) {
      const debtMap = debtByAsset[a.id];
      const debtProjMap = debtProjByAsset[a.id] || {};
      const dCells = months.map(m => {
        const v = debtMap[m];
        const isProj = debtProjMap[m];
        const cellBg = m === curM ? 'var(--accent-lt)' : bg;
        if (v == null) return `<td class="right" style="color:var(--text3);font-size:11px;padding:4px 10px;background:${cellBg}">—</td>`;
        const projStyle = isProj ? ';opacity:.65;font-style:italic' : '';
        const projTip   = isProj ? ' title="Projeção (valor constante, sem correção futura)"' : '';
        return `<td class="amt-exp right"${projTip} style="font-size:11px;padding:4px 10px;background:${cellBg};font-family:'DM Mono',monospace${projStyle}">${fmtBRL(v)}${isProj ? '<span style="font-size:8px;margin-left:2px;color:#f59e0b">~</span>' : ''}</td>`;
      }).join('');
      // Build installment flow cells (parcelas pagas e projetadas)
      const finRows = (_pat.financing[a.id] || []).sort((x,y) => x.month.localeCompare(y.month));
      const installByMonth = {};
      const installProjByMonth = {};
      finRows.forEach(r => {
        const m = r.month.slice(0,7);
        installByMonth[m]     = r.installment;
        installProjByMonth[m] = r.is_projection === 1;
      });
      const iCells = months.map(m => {
        const v = installByMonth[m];
        const isProj = installProjByMonth[m];
        const cellBg = m === curM ? 'var(--accent-lt)' : bg;
        if (!v) return `<td class="right" style="color:var(--text3);font-size:11px;padding:3px 8px;background:${cellBg}">—</td>`;
        const projStyle = isProj ? ';opacity:.65;font-style:italic' : '';
        const projTip   = isProj ? ' title="Projeção"' : ' title="Parcela registrada"';
        return `<td class="amt-exp right"${projTip} style="font-size:11px;padding:3px 8px;background:${cellBg};font-family:'DM Mono',monospace${projStyle}">-${fmtBRL(v)}${isProj?'<span style="font-size:8px;color:#f59e0b;margin-left:1px">~</span>':''}</td>`;
      }).join('');

      assetRows += `<tr style="background:${bg}">
        <td style="${STICKY};left:0;min-width:160px;max-width:160px;font-size:11px;padding:3px 12px 4px 24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:${bg}">
          <span style="color:#dc2626;margin-right:4px">🏦</span><span style="color:#dc2626">Saldo devedor</span>
        </td>
        <td style="${STICKY};left:200px;min-width:80px;max-width:80px;font-size:10px;color:#dc2626;background:${bg}">Financiamento</td>
        <td style="${STICKY};left:280px;min-width:90px;max-width:90px;background:${bg}"></td>
        <td style="${STICKY};left:370px;min-width:90px;max-width:90px;background:${bg}"></td>
        ${dCells}
        <td style="${STICKY};right:0;min-width:60px;background:${bg}"></td>
      </tr>
      <tr style="background:${bg}">
        <td style="${STICKY};left:0;font-size:10px;color:#dc2626;padding:2px 12px 2px 24px;background:${bg}" colspan="4">📅 Parcelas (pagas e projetadas)</td>
        ${iCells}
        <td style="background:${bg};${STICKY};right:0;min-width:60px"></td>
      </tr>`;
      months.forEach(m => { if (debtMap[m] != null) assetTotalByMonth[m] += debtMap[m]; });
    }

    // ── Cash flow rows for this pat asset (if transactions exist) ──
    const aTxs = _pat.txAll.filter(t => t.asset_id === a.id);
    if (aTxs.length) {
      const patNetCash = {};
      aTxs.forEach(t => {
        const m = t.month.slice(0,7);
        patNetCash[m] = (patNetCash[m] || 0) + (PAT_TX_CASH[t.tx_type]?.sign ?? 1) * t.total_value;
      });
      const endM = a.sold_month || curM;
      const histEntries = months.filter(m => m <= endM && histMap[a.id]?.[m]?.value != null);
      const latestPatVal = histEntries.length ? histMap[a.id][histEntries[histEntries.length-1]].value : 0;

      // Next month after endM — hypothetical sale for IRR (same as inv_assets)
      const [ey, emo] = endM.split('-').map(Number);
      const nextM = emo === 12 ? `${ey+1}-01` : `${ey}-${String(emo+1).padStart(2,'0')}`;

      // TIR: include hypothetical sale at nextM (value of asset as if sold then)
      const firstTxM = Object.keys(patNetCash).sort()[0];
      let patIrrNom = null, patIrrReal = null;
      if (firstTxM && latestPatVal > 0) {
        // Use months up to and including nextM
        const irrMs = [];
        let bm = firstTxM;
        while (bm <= nextM) {
          irrMs.push(bm);
          const [y2,mo2] = bm.split('-').map(Number);
          bm = mo2===12 ? `${y2+1}-01` : `${y2}-${String(mo2+1).padStart(2,'0')}`;
        }
        const nomFlows  = irrMs.map(m => patNetCash[m] ?? 0);
        const realFlows = irrMs.map(m => (patNetCash[m] ?? 0) * ipcaCumFn2(m));
        // Add hypothetical sale at nextM
        nomFlows[nomFlows.length-1]  += latestPatVal;
        realFlows[realFlows.length-1] += latestPatVal;
        patIrrNom  = calcIRR(nomFlows);
        patIrrReal = calcIRR(realFlows);
      }

      // P&L
      const patPnl = Object.values(patNetCash).reduce((s,v) => s+v, 0) + latestPatVal;
      const patPnlLabel = patPnl >= 0 ? `▲ ${fmtBRL(patPnl)}` : `▼ ${fmtBRL(Math.abs(patPnl))}`;
      const patPnlColor = patPnl >= 0 ? '#16a34a' : '#dc2626';

      // Inject P&L into the asset name subtitle div
      const pnlDiv = document.getElementById(`pat-pnl-${a.id}`);
      if (pnlDiv) {
        const tirNomStr  = patIrrNom  !== null ? `TIR: ${(patIrrNom*100).toFixed(1)}% a.a.` : '';
        const tirRealStr = patIrrReal !== null ? ` | Real: ${(patIrrReal*100).toFixed(1)}%` : '';
        pnlDiv.innerHTML =
          `<span style="color:${patPnlColor}">${patPnlLabel}</span>` +
          (tirNomStr ? `<span style="color:${patIrrNom>=0?'#16a34a':'#dc2626'};margin-left:8px" title="${TIR_TOOLTIP}">${tirNomStr}${tirRealStr}</span>` : '');
      }

      // TIR row between asset row and flow rows — stacked lines to avoid wide columns
      const tirLine1 = patIrrNom !== null
        ? `<span style="color:${patIrrNom>=0?'#16a34a':'#dc2626'}" title="${TIR_TOOLTIP}">TIR nominal: ${(patIrrNom*100).toFixed(1)}% a.a.</span>`
        + (patIrrReal !== null ? `  <span style="color:${patIrrReal>=0?'#16a34a':'#dc2626'};margin-left:10px">TIR real: ${(patIrrReal*100).toFixed(1)}% a.a.</span>` : '')
        : '';
      const tirLine2 = `<span style="color:${patPnlColor}">Ganho/Perda: ${patPnlLabel}</span>`;
      const tirCell = `<div style="line-height:1.6">${tirLine1 ? tirLine1 + '<br>' : ''}${tirLine2}</div>`;

      const patNomCells = months.map(m => {
        const cf = patNetCash[m] ?? 0;
        const cellBg = m === curM ? 'var(--accent-lt)' : bg;
        if (!cf) return `<td class="right" style="font-size:11px;padding:3px 8px;background:${cellBg};color:var(--text3)">—</td>`;
        const cls = cf >= 0 ? 'amt-inc' : 'amt-exp';
        return `<td class="${cls} right" style="font-size:11px;padding:3px 8px;background:${cellBg};font-family:'DM Mono',monospace">${fmtBRL(cf)}</td>`;
      }).join('');

      const patRealCells = months.map(m => {
        const cf = patNetCash[m] ?? 0;
        const cellBg = m === curM ? 'var(--accent-lt)' : bg;
        if (!cf) return `<td class="right" style="font-size:11px;padding:3px 8px;background:${cellBg};color:var(--text3)">—</td>`;
        const real = cf * ipcaCumFn2(m);
        const cls = real >= 0 ? 'amt-inc' : 'amt-exp';
        return `<td class="${cls} right" style="font-size:11px;padding:3px 8px;background:${cellBg};font-family:'DM Mono',monospace;font-style:italic">${fmtBRL(real)}</td>`;
      }).join('');

      assetRows += `
      ${tirCell ? `<tr style="background:${bg}">
        <td style="${STICKY};left:0;font-size:10px;color:var(--text3);padding:2px 12px;background:${bg}" colspan="4">${tirCell}</td>
        ${months.map(m => `<td style="background:${m===curM?'var(--accent-lt)':bg}"></td>`).join('')}
        <td style="background:${bg};${STICKY};right:0;min-width:60px"></td>
      </tr>` : ''}
      <tr style="background:${bg}">
        <td style="${STICKY};left:0;font-size:10px;color:var(--text3);padding:2px 12px;background:${bg}" colspan="4">📊 Fluxo nominal</td>
        ${patNomCells}
        <td style="background:${bg};${STICKY};right:0;min-width:60px"></td>
      </tr>
      <tr style="background:${bg}">
        <td style="${STICKY};left:0;font-size:10px;color:var(--text3);padding:2px 12px;background:${bg}" colspan="4">📈 Fluxo real (IPCA)</td>
        ${patRealCells}
        <td style="background:${bg};${STICKY};right:0;min-width:60px"></td>
      </tr>`;
    }
  });



  const assetTotalRowCells = months.map(m => {
    const cellBg3 = m === curM ? ';background:var(--accent-lt)' : '';
    const v = assetTotalByMonth[m];
    const cls = v < 0 ? 'amt-exp' : 'amt-inc';
    return '<td class="' + cls + ' right" style="font-size:12px;font-family:DM Mono,monospace;padding:6px 10px' + cellBg3 + '">' + fmtBRL(v) + '</td>';
  }).join('');
  const assetTotalRow = `<tr style="font-weight:700;background:var(--bg4);border-top:2px solid var(--border2);border-bottom:2px solid var(--border2)">
    <td style="${STICKY4};left:0;min-width:400px;font-size:12px;padding:8px 12px" colspan="4">Total Imobilizado</td>
    ${assetTotalRowCells}
    <td style="${STICKY4};right:0;min-width:60px"></td>
  </tr>`;

  // ── Contas ──
  const accTotalByMonth = {};
  months.forEach(m => { accTotalByMonth[m] = 0; });

  let accRows = '';
  _pat.accountBalances.forEach((a, ri) => {
    const bg = stripe(ri);
    accRows += `<tr style="background:${bg};height:38px">
      <td style="${STICKY};left:0;min-width:400px;font-size:12px;padding:6px 12px;background:${bg}" colspan="4">
        ${esc(a.name)}
      </td>
      ${months.map(m => {
        const up = a.history.filter(h => h.month <= m);
        const bal = up.length ? up[up.length-1].balance : null;
        if (bal !== null) accTotalByMonth[m] += bal;
        const isCur = m === curM;
        const bg2 = isCur ? 'var(--accent-lt)' : bg;
        if (bal === null) return `<td class="right" style="color:var(--text3);font-size:12px;padding:6px 10px;background:${bg2}">—</td>`;
        const cls = bal >= 0 ? 'amt-inc' : 'amt-exp';
        return `<td class="${cls} right" style="font-size:12px;font-family:'DM Mono',monospace;padding:6px 10px;background:${bg2}">${fmtBRL(bal)}</td>`;
      }).join('')}
      <td style="${STICKY};right:0;min-width:60px;background:${bg}"></td>
    </tr>`;
  });

  const accTotalRow = `<tr style="font-weight:700;background:var(--bg4);border-top:2px solid var(--border2);border-bottom:2px solid var(--border2)">
    <td style="${STICKY4};left:0;min-width:400px;font-size:12px;padding:8px 12px" colspan="4">Total Contas</td>
    ${months.map(m => `<td class="amt-inc right" style="font-size:12px;font-family:'DM Mono',monospace;padding:6px 10px${m===curM?';background:var(--accent-lt)':''}">${fmtBRL(accTotalByMonth[m])}</td>`).join('')}
    <td style="${STICKY4};right:0;min-width:60px"></td>
  </tr>`;

  // ── Total geral ──
  const grandTotalRow = `<tr style="font-weight:700;font-size:14px;background:var(--accent-bg);border-top:2px solid var(--accent)">
    <td style="${STICKY4.replace('bg3','accent-bg')};left:0;min-width:350px;padding:10px 12px;color:var(--accent)" colspan="4">📊 Total Patrimônio</td>
    ${months.map(m => {
      const v = assetTotalByMonth[m] + accTotalByMonth[m];
      const isCur = m === curM;
      return `<td class="right" style="font-family:'DM Mono',monospace;padding:8px 10px;color:var(--accent)${isCur?';background:var(--accent-lt)':''}">${fmtBRL(v)}</td>`;
    }).join('')}
    <td style="${STICKY4.replace('bg3','accent-bg')};right:0;min-width:60px"></td>
  </tr>`;

  // ── Render all in single container ──
  const container = G('pat-all-tables');
  if (!container) return;

  const spacer = `<tbody><tr style="height:12px;background:var(--bg)"><td colspan="${months.length+4}"></td></tr></tbody>`;
  const { totals: invTotalByMonth, netCashByMonth: invNetCashByMonth, extFlowByMonth: invExtFlowByMonth, incFlowByMonth: invIncFlowByMonth } = calcInvTotalByMonth(months);
  let totalInv = invTotalByMonth[curM] || 0;

  // Update investment and total cards with correct values
  const grandTotal = totalAssets + totalAccounts + totalInv;
  if (G('pat-card-inv'))   G('pat-card-inv').innerHTML   = `<div class="stat-lbl">📈 Investimentos</div><div class="stat-val green">${fmtBRL(totalInv)}</div><div class="stat-sub">${fmtMonth(curM)}</div>`;
  if (G('pat-card-total')) G('pat-card-total').innerHTML = `<div class="stat-lbl">📊 Total Patrimônio</div><div class="stat-val accent" style="font-size:22px">${fmtBRL(grandTotal)}</div><div class="stat-sub">${fmtMonth(curM)}</div>`;

  // Store for use by overview
  window._patGrandTotal = { value: grandTotal, month: curM };

  // Grand TIR for all investments
  const hasTotCash = Object.keys(invNetCashByMonth).length > 0;
  const totLatestVal = invTotalByMonth[curM] || 0;
  let grandIrr = null;
  if (hasTotCash && totLatestVal > 0) {
    const ipcaCum = m => {
      let cum = 1, cur = m;
      while (cur < curM) {
        const [y,mo] = cur.split('-').map(Number);
        const next = mo===12 ? `${y+1}-01` : `${y}-${String(mo+1).padStart(2,'0')}`;
        cum *= (1 + (_pat.ipcaMonthly[next] ?? 0));
        cur = next;
      }
      return cum;
    };
    const firstM = Object.keys(invNetCashByMonth).sort()[0];
    const irrMs = months.filter(m => m >= firstM);
    const realFlows = irrMs.map(m => (invNetCashByMonth[m] ?? 0) * ipcaCum(m));
    realFlows.push(totLatestVal);
    grandIrr = calcIRR(realFlows);
  }
  const grandIrrLabel = grandIrr !== null ? ` — TIR: ${(grandIrr*100).toFixed(1)}% a.a.` : '';
  const grandIrrColor = grandIrr !== null ? (grandIrr >= 0 ? '#16a34a' : '#dc2626') : 'var(--text3)';

  // Ganho/Perda total: soma simples do fluxo nominal + valor atual
  const _grandFlowSum = Object.values(invNetCashByMonth).reduce((s, v) => s + v, 0);
  const grandGanho = Object.keys(invNetCashByMonth).length > 0 ? _grandFlowSum + totLatestVal : null;
  const grandGanhoLabel = grandGanho !== null
    ? `${grandGanho >= 0 ? '▲' : '▼'} ${fmtBRL(Math.abs(grandGanho))}`
    : '';
  const grandGanhoColor = grandGanho !== null ? (grandGanho >= 0 ? '#16a34a' : '#dc2626') : 'var(--text3)';

  const showReal2 = _inv.showRealFlow;
  const totNomFlowCells = months.map(m => {
    const cf = invNetCashByMonth[m] ?? 0;
    const isCur = m === curM;
    const bg4 = isCur ? 'var(--accent-lt)' : 'var(--bg4)';
    if (!cf) return `<td class="right" style="font-size:11px;padding:3px 8px;background:${bg4};color:var(--text3)">—</td>`;
    const cls = cf >= 0 ? 'amt-inc' : 'amt-exp';
    return `<td class="${cls} right" style="font-size:11px;padding:3px 8px;background:${bg4};font-family:'DM Mono',monospace">${fmtBRL(cf)}</td>`;
  }).join('');
  const totRealFlowCells = months.map(m => {
    const cf = invNetCashByMonth[m] ?? 0;
    const isCur = m === curM;
    const bg4 = isCur ? 'var(--accent-lt)' : 'var(--bg4)';
    if (!cf) return `<td class="right" style="font-size:11px;padding:3px 8px;background:${bg4};color:var(--text3)">—</td>`;
    const real = cf * ipcaCumFn2(m);
    const cls = real >= 0 ? 'amt-inc' : 'amt-exp';
    return `<td class="${cls} right" style="font-size:11px;padding:3px 8px;background:${bg4};font-family:'DM Mono',monospace;font-style:italic">${fmtBRL(real)}</td>`;
  }).join('');

  // Also include inv in grand total
  const invTotalRow = `<tbody>
  <tr style="font-weight:700;background:var(--bg4);border-top:2px solid var(--border2)">
    <td style="${STICKY4};left:0;min-width:350px;font-size:12px;padding:8px 12px" colspan="4">
      Total Investimentos
      ${grandIrrLabel ? `<span style="font-weight:400;font-size:11px;color:${grandIrrColor}" title="${TIR_TOOLTIP}">${grandIrrLabel}</span>` : ''}
      ${grandGanhoLabel ? `<span style="font-weight:700;font-size:11px;color:${grandGanhoColor};margin-left:4px" title="Ganho/Perda: valor atual menos capital investido líquido">${grandGanhoLabel}</span>` : ''}
    </td>
    ${months.map(m => `<td class="amt-inc right" style="font-size:12px;font-family:'DM Mono',monospace;padding:6px 10px${m===curM?';background:var(--accent-lt)':''}">${fmtBRL(invTotalByMonth[m]||0)}</td>`).join('')}
    <td class="amt-inc right" style="font-size:12px;background:var(--bg3)">—</td>
    <td style="${STICKY4};right:0;min-width:60px"></td>
  </tr>
  <tr style="background:var(--bg4)">
    <td style="${STICKY4};left:0;font-size:10px;color:var(--text3);padding:2px 12px;background:var(--bg4)" colspan="4">📊 Fluxo nominal</td>
    ${totNomFlowCells}
    <td style="min-width:0;max-width:0;padding:0;border:none;overflow:hidden"></td>
    <td style="${STICKY4};right:0;min-width:60px;background:var(--bg4)"></td>
  </tr>
  ${showReal2 ? `<tr style="background:var(--bg4)">
    <td style="${STICKY4};left:0;font-size:10px;color:var(--text3);padding:2px 12px;background:var(--bg4)" colspan="4">📈 Fluxo real (IPCA)</td>
    ${totRealFlowCells}
    <td style="min-width:0;max-width:0;padding:0;border:none;overflow:hidden"></td>
    <td style="${STICKY4};right:0;min-width:60px;background:var(--bg4)"></td>
  </tr>` : ''}
  <tr style="height:4px;background:var(--border2)"><td colspan="${months.length+5}"></td></tr>
  </tbody>`;

  // Extra projection column header
  const projHeader = `<th style="min-width:0;max-width:0;padding:0;border:none;overflow:hidden"></th>`;

  // Real flow toggle button
  const realFlowToggle = `<button class="btn xs" onclick="_inv.showRealFlow=!_inv.showRealFlow;refreshPatrimonioTable()" style="font-size:10px;margin-left:8px">${_inv.showRealFlow?'▲ Ocultar':'▼ Fluxo real'} IPCA</button>`;

  // inv rows
  const invRows = buildInvRows(months, curM, STICKY, COL_W, stripe, showHidden);

  // Store monthly totals for use by Aposentadoria tab
  window._patTotalByMonth = {};
  window._invTotalByMonth  = {};
  window._assetTotalByMonth = {};
  months.forEach(m => {
    window._patTotalByMonth[m]   = assetTotalByMonth[m] + accTotalByMonth[m] + (invTotalByMonth[m]||0);
    window._invTotalByMonth[m]   = invTotalByMonth[m]   || 0;
    window._assetTotalByMonth[m] = assetTotalByMonth[m] || 0;
  });

  // Update grand total to include investments
  const grandTotalRow2 = `<tbody><tr style="font-weight:700;font-size:14px;background:var(--accent-bg);border-top:2px solid var(--accent)">
    <td style="position:sticky;z-index:3;background:var(--accent-bg);left:0;min-width:350px;padding:10px 12px;color:var(--accent)" colspan="4">📊 Total Patrimônio</td>
    ${months.map(m => {
      const v = assetTotalByMonth[m] + accTotalByMonth[m] + (invTotalByMonth[m]||0);
      const isCur = m === curM;
      return `<td class="right" style="font-family:'DM Mono',monospace;padding:8px 10px;color:var(--accent)${isCur?';background:var(--accent-lt)':''}">${fmtBRL(v)}</td>`;
    }).join('')}
    <td style="background:var(--accent-bg)"></td>
    <td style="position:sticky;z-index:3;background:var(--accent-bg);right:0;min-width:60px"></td>
  </tr></tbody>`;

  container.innerHTML = `
    <table style="border-collapse:collapse;font-size:13px;width:max-content;min-width:100%">
      <!-- HEADER + IPCA -->
      <thead style="position:sticky;top:0;z-index:10">
        <tr style="background:var(--bg3)">
          <th style="${STICKY3};left:0;min-width:200px;text-align:left;padding:8px 12px">Ativo</th>
          <th style="${STICKY3};left:200px;min-width:80px;text-align:left;font-size:11px">Código</th>
          <th style="${STICKY3};left:280px;min-width:90px;text-align:left;font-size:11px">Cat.</th>
          <th style="${STICKY3};left:370px;min-width:90px;text-align:left;font-size:11px">Tipo/Tend.</th>
          ${monthHeader}
          <th style="${STICKY3};right:0;min-width:60px"></th>
        </tr>
        ${ipcaRow}
      </thead>

      <!-- 1. IMOBILIZADO -->
      <tbody>
        <tr style="background:var(--bg3)">
          <td style="${STICKY3};left:0;min-width:400px;font-weight:700;padding:10px 12px;font-size:13px" colspan="4">🏠 Patrimônio Imobilizado</td>
          ${months.map(m=>`<td style="min-width:${COL_W}px${m===curM?';background:var(--accent-lt)':''}"></td>`).join('')}
          <td style="${STICKY3};right:0;min-width:60px;text-align:right">
            <button class="btn xs primary" onclick="openPatAssetModal()" style="font-size:10px">+ Novo</button>
          </td>
        </tr>
        ${assetRows || `<tr><td colspan="${months.length+5}" class="empty" style="padding:1.5rem">Nenhum ativo.</td></tr>`}
      </tbody>
      <tbody>${assetTotalRow}</tbody>
      ${spacer}

      <!-- 3. CONTAS -->
      <tbody>
        <tr style="background:var(--bg3)">
          <td style="${STICKY3};left:0;min-width:400px;font-weight:700;padding:10px 12px;font-size:13px" colspan="4">🏦 Contas Bancárias</td>
          ${months.map(m=>`<td style="min-width:${COL_W}px${m===curM?';background:var(--accent-lt)':''}"></td>`).join('')}
          <td style="${STICKY3};right:0;min-width:60px;text-align:right">
            <button class="btn xs" onclick="openPatAccountsModal()" style="font-size:10px">⚙</button>
          </td>
        </tr>
        ${accRows || `<tr><td colspan="${months.length+5}" class="empty" style="padding:1.5rem">Nenhuma conta.</td></tr>`}
      </tbody>
      <tbody>${accTotalRow}</tbody>
      ${spacer}

      <!-- 5. INVESTIMENTOS -->
      <tbody>
        <tr style="background:var(--bg3)">
          <td style="${STICKY3};left:0;min-width:400px;font-weight:700;padding:10px 12px;font-size:13px" colspan="4">
            📈 Investimentos Financeiros ${realFlowToggle}
          </td>
          ${months.map(m=>`<td style="min-width:${COL_W}px${m===curM?';background:var(--accent-lt)':''}"></td>`).join('')}
          <td style="${STICKY3};right:0;min-width:60px;text-align:right">
            <button class="btn xs primary" onclick="openInvAssetModal()" style="font-size:10px">+ Novo</button>
          </td>
        </tr>
        ${invRows || `<tr><td colspan="${months.length+5}" class="empty" style="padding:1.5rem">Nenhum investimento.</td></tr>`}
      </tbody>
      ${invTotalRow}
      ${spacer}

      <!-- 7. TOTAL PATRIMÔNIO -->
      ${grandTotalRow2}
    </table>`;
  // Scroll to rightmost (latest month)
  setTimeout(() => {
    const sc = G('pat-scroll-container');
    if (sc) sc.scrollLeft = sc.scrollWidth;
  }, 80);
  } catch(e) {
    console.error('[refreshPatrimonioTable]', e);
    const container = G('pat-all-tables');
    if (container) container.innerHTML = `<div style="padding:24px;color:#dc2626;font-family:monospace;white-space:pre-wrap"><strong>Erro ao renderizar Patrimônio:</strong>\n${e.stack || e.message}</div>`;
    const cards = G('pat-cards');
    if (cards) cards.innerHTML = '';
  }
}

// Drag-to-reorder for assets and accounts
let _patDragOver = null; // track current drag-over row to clean up

function patDragStart(e, id, type) {
  e.stopPropagation();
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('application/pat-drag', JSON.stringify({ id, type }));
  setTimeout(() => { e.target.style.opacity = '0.4'; }, 0);
}
function patDragEnd(e) {
  e.target.style.opacity = '';
  if (_patDragOver) { _patDragOver.style.borderTop = ''; _patDragOver = null; }
}
function patDragOver(e, targetId, type) {
  // Only handle if same type
  try {
    const data = JSON.parse(e.dataTransfer.getData('application/pat-drag') || 'null');
    if (data && data.type !== type) return;
  } catch(err) {}
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer.dropEffect = 'move';
  const row = e.currentTarget;
  if (_patDragOver && _patDragOver !== row) { _patDragOver.style.borderTop = ''; }
  row.style.borderTop = '3px solid var(--accent)';
  _patDragOver = row;
}
function patDragLeave(e) {
  // Only clear if leaving the <tr> entirely (not just moving to a child)
  if (!e.currentTarget.contains(e.relatedTarget)) {
    e.currentTarget.style.borderTop = '';
    if (_patDragOver === e.currentTarget) _patDragOver = null;
  }
}
async function patDrop(e, targetId, type) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.style.borderTop = '';
  _patDragOver = null;

  let fromId, fromType;
  try {
    const data = JSON.parse(e.dataTransfer.getData('application/pat-drag'));
    fromId   = data.id;
    fromType = data.type;
  } catch(err) { return; }

  if (!fromId || fromType !== type || fromId === targetId) return;

  if (type === 'asset') {
    const fromIdx = _pat.assets.findIndex(a => a.id === fromId);
    const toIdx   = _pat.assets.findIndex(a => a.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = _pat.assets.splice(fromIdx, 1);
    _pat.assets.splice(toIdx, 0, moved);
    for (let i = 0; i < _pat.assets.length; i++) {
      await ff.patAssetSave({ ..._pat.assets[i], sort_order: i });
    }
    _pat.assets = await ff.patAssetsList();
  } else if (type === 'inv') {
    const fromIdx = _inv.assets.findIndex(a => a.id === fromId);
    const toIdx   = _inv.assets.findIndex(a => a.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = _inv.assets.splice(fromIdx, 1);
    _inv.assets.splice(toIdx, 0, moved);
    for (let i = 0; i < _inv.assets.length; i++) {
      await ff.invAssetSave({ ..._inv.assets[i], sort_order: i });
    }
    _inv.assets = await ff.invAssetsList();
  } else {
    const list = _pat.accountBalances;
    const fromIdx = list.findIndex(a => a.account_id === fromId);
    const toIdx   = list.findIndex(a => a.account_id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    await ff.patAccountsSet({ accountIds: list.map(a => a.account_id) });
    _pat.accountBalances = await ff.patAccountBalances();
  }
  refreshPatrimonioTable();
}
let _patInlineActive = false; // guard against re-entrant refreshes during inline edit

async function patInlineEdit(td, assetId, month, currentValue) {
  if (td.querySelector('input')) return;
  const orig = td.innerHTML;
  td.innerHTML = `<input type="number" step="0.01" value="${currentValue}"
    style="width:110px;text-align:right;font-size:12px" onclick="event.stopPropagation()">`;
  const inp = td.querySelector('input');
  inp.focus(); inp.select();
  let committed = false;

  async function commit() {
    if (committed) return;
    committed = true;
    _patInlineActive = false;
    const v = parseFloat(inp.value.replace(',','.'));
    if (!isNaN(v) && v !== currentValue) {
      // Don't write to td after commit — td may be detached
      await ff.patHistorySet({ assetId, month, value: v, manual: true });
      toast(`✅ Valor de ${fmtMonth(month)} atualizado`);
      if (Object.keys(_pat.ipcaMonthly).length) {
        await ff.patAutoProject({ ipcaMonthly: _pat.ipcaMonthly }).catch(() => {});
      }
      _pat.historyAll = await ff.patHistoryAll();
      refreshPatrimonioTable();
    } else {
      if (td.isConnected) td.innerHTML = orig;
    }
  }

  _patInlineActive = true;
  inp.addEventListener('blur', commit, { once: true });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { inp.blur(); }
    if (e.key === 'Escape') {
      committed = true;
      _patInlineActive = false;
      if (td.isConnected) td.innerHTML = orig;
    }
  });
}

async function commitPatValue(displayEl, inputEl) {
  const assetId = parseInt(inputEl.dataset.asset);
  const month   = inputEl.dataset.month;
  const rawVal  = parseFloat(inputEl.value.replace(',','.'));

  inputEl.style.display = 'none';
  displayEl.style.display = '';

  if (isNaN(rawVal)) return;

  await ff.patHistorySet({ assetId, month, value: rawVal, manual: true });
  toast(`✅ Valor de ${fmtMonth(month)} atualizado`);
  // Reload history so subsequent months use this as base
  _pat.historyAll = await ff.patHistoryAll();
  // Re-project from this point forward
  if (Object.keys(_pat.ipcaMonthly).length) {
    await ff.patAutoProject({ ipcaMonthly: _pat.ipcaMonthly });
    _pat.historyAll = await ff.patHistoryAll();
  }
  refreshPatrimonioTable();
}

// ── Asset modal ──
// ── Pat asset modal — transaction helpers ──
let _patTxRows = []; // working copy while modal is open

function patTxTypeLabel(type) {
  return (PAT_TX_CASH[type]?.label) || type;
}

function patTxRenderTable() {
  const tbody = G('pat-tx-table');
  if (!tbody) return;
  tbody.innerHTML = _patTxRows.map((row, i) => {
    const movSign = row.total_value !== '' && row.total_value != null
      ? (PAT_TX_CASH[row.tx_type]?.sign ?? 1) * parseFloat(row.total_value || 0) : null;
    const movFmt  = movSign !== null ? fmtBRL(movSign) : '';
    const movColor = movSign === null ? 'var(--text3)' : movSign < 0 ? '#dc2626' : '#16a34a';
    const histVal = row.hist_value != null && row.hist_value !== '' ? row.hist_value : '';
    return `<div style="display:grid;grid-template-columns:110px 1fr 140px 140px 36px;align-items:center;padding:5px 10px;border-bottom:1px solid var(--border);gap:4px">
      <div style="display:flex;gap:3px">
        <input class="inp" style="width:42px;font-size:12px;padding:3px 4px" type="number" min="1" max="12" value="${row.month ? row.month.slice(5,7).replace(/^0/,'') : ''}" placeholder="Mês" onchange="patTxUpdateRow(${i},'mo',this.value)">
        <input class="inp" style="width:52px;font-size:12px;padding:3px 4px" type="number" min="2000" value="${row.month ? row.month.slice(0,4) : ''}" placeholder="Ano" onchange="patTxUpdateRow(${i},'yr',this.value)">
      </div>
      <select class="inp" style="font-size:11px;padding:3px 4px" onchange="patTxUpdateRow(${i},'type',this.value)">
        ${Object.entries(PAT_TX_CASH).map(([v,d]) => `<option value="${v}" ${row.tx_type===v?'selected':''}>${d.label}</option>`).join('')}
      </select>
      <input class="inp" style="font-size:12px;padding:3px 4px;text-align:right" type="number" step="0.01" value="${histVal}" placeholder="Auto (IPCA)" title="Valor do ativo neste mês (deixe vazio para cálculo automático)" onchange="patTxUpdateRow(${i},'hist',this.value)">
      <input class="inp" style="font-size:12px;padding:3px 4px;text-align:right" type="number" step="0.01" value="${row.total_value ?? ''}" placeholder="Movim." onchange="patTxUpdateRow(${i},'val',this.value)">
      <button class="btn-icon" style="color:#dc2626;font-size:15px;padding:0 4px" onclick="patTxDeleteRow(${i})">×</button>
    </div>`;
  }).join('') || `<div style="padding:14px;text-align:center;color:var(--text3);font-size:12px">Nenhuma movimentação registrada. Use "+ Adicionar linha" para começar.</div>`;
}

function patTxUpdateRow(i, field, val) {
  const row = _patTxRows[i];
  if (!row) return;
  if (field === 'mo') {
    const mo = String(parseInt(val)||1).padStart(2,'0');
    const yr = row.month ? row.month.slice(0,4) : new Date().getFullYear();
    row.month = `${yr}-${mo}`;
  } else if (field === 'yr') {
    const mo = row.month ? row.month.slice(5,7) : '01';
    row.month = `${val}-${mo}`;
  } else if (field === 'type') {
    row.tx_type = val;
  } else if (field === 'val') {
    row.total_value = val !== '' ? parseFloat(val) : null;
  } else if (field === 'hist') {
    row.hist_value = val !== '' ? parseFloat(val) : null;
  }
  patTxRenderTable();
}

function patTxNextMonth() {
  // Return month after the last registered row, or current month if none
  if (_patTxRows.length) {
    const last = [..._patTxRows].sort((a,b) => (a.month||'').localeCompare(b.month||''));
    const lastM = last[last.length-1].month;
    if (lastM) {
      const [y, mo] = lastM.split('-').map(Number);
      return mo === 12 ? `${y+1}-01` : `${y}-${String(mo+1).padStart(2,'0')}`;
    }
  }
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
}

function patTxAddRow() {
  _patTxRows.push({ id: null, month: patTxNextMonth(), tx_type: 'aluguel', total_value: null, hist_value: null });
  patTxRenderTable();
  // Scroll to bottom
  const tb = G('pat-tx-table');
  if (tb) tb.scrollTop = tb.scrollHeight;
}

function patTxRepeatLast() {
  if (!_patTxRows.length) return;
  const sorted = [..._patTxRows].sort((a,b) => (a.month||'').localeCompare(b.month||''));
  const last = sorted[sorted.length-1];
  _patTxRows.push({
    id: null,
    month: patTxNextMonth(),
    tx_type: last.tx_type,
    total_value: last.total_value,
    hist_value: null, // don't copy hist_value — each month has its own position
  });
  patTxRenderTable();
  const tb = G('pat-tx-table');
  if (tb) tb.scrollTop = tb.scrollHeight;
}

async function patTxDeleteRow(i) {
  const row = _patTxRows[i];
  if (row.id) {
    const assetId = parseInt(G('pat-asset-id').value);
    await ff.patTxDelete({ id: row.id, assetId, month: row.month, tx_type: row.tx_type, total_value: row.total_value });
  }
  _patTxRows.splice(i, 1);
  patTxRenderTable();
}

async function openPatAssetModal(id) {
  const now = new Date();
  const curY = now.getFullYear();
  const curMo = now.getMonth() + 1;

  // Default to current month
  G('pat-asset-month-m').value = curMo;
  G('pat-asset-month-y').value = curY;

  G('pat-asset-id').value    = id || '';
  G('pat-asset-name').value  = '';
  G('pat-asset-type').value  = 'imovel';
  G('pat-asset-trend').value = 'plus1x';
  G('pat-asset-sold-m').value = '';
  G('pat-asset-sold-y').value = '';
  setupCurrencyInput(G('pat-asset-value'));
  G('pat-asset-value').setValue(null);
  setupCurrencyInput(G('pat-asset-sold-value'));
  G('pat-asset-sold-value').setValue(null);
  G('pat-asset-hidden').checked = false;
  G('pat-financed-check').checked = false;
  // Reset contract fields
  if (G('fin-system'))       G('fin-system').value       = 'SAC';
  if (G('fin-index'))        G('fin-index').value        = 'none';
  if (G('fin-rate'))         G('fin-rate').value         = '';
  if (G('fin-principal'))    G('fin-principal').value    = '';
  if (G('fin-installments')) G('fin-installments').value = '';
  if (G('fin-first-m'))      G('fin-first-m').value      = '';
  if (G('fin-first-y'))      G('fin-first-y').value      = '';
  if (G('fin-balloon'))      G('fin-balloon').value      = '';
  if (G('fin-extra-month'))  G('fin-extra-month').value  = '';
  if (G('fin-extra-value'))  G('fin-extra-value').value  = '';
  if (G('fin-schedule-preview')) G('fin-schedule-preview').style.display = 'none';
  if (G('fin-schedule-summary')) G('fin-schedule-summary').textContent = '';
  if (G('fin-asset-value')) { const el = G('fin-asset-value'); if (el.setValue) el.setValue(null); else el.value = ''; }
  patToggleFinancingSection();
  G('pat-asset-modal-title').textContent = id ? 'Editar ativo' : 'Novo ativo imobilizado';

  if (id) {
    const a = _pat.assets.find(a => a.id === id);
    if (a) {
      G('pat-asset-name').value  = a.name;
      G('pat-asset-type').value  = a.asset_type;
      G('pat-asset-trend').value = a.trend;
      G('pat-asset-hidden').checked = !!a.hidden;
      if (a.sold_month) {
        const [sy, sm] = a.sold_month.split('-').map(Number);
        G('pat-asset-sold-y').value = sy;
        G('pat-asset-sold-m').value = sm;
      }
      if (a.sold_value) G('pat-asset-sold-value').setValue(a.sold_value);
      G('pat-financed-check').checked = !!a.financed;
      patToggleFinancingSection();
      if (a.financed) {
        G('pat-financed-check').checked = true;
        patToggleFinancingSection();
      }
      const entries = _pat.historyAll
        .filter(h => h.asset_id === id)
        .sort((a,b) => a.month.localeCompare(b.month));
      const first = entries.find(h => h.manual) || entries[0];
      if (first) {
        const [fy, fm] = first.month.split('-').map(Number);
        G('pat-asset-month-y').value = fy;
        G('pat-asset-month-m').value = fm;
        G('pat-asset-value').setValue(first.value);
      }
    }
  }
  // Load financing contract if financed
  _finSchedule = [];
  if (id) {
    const contract = await ff.patFinancingContractGet({ assetId: id }).catch(() => null);
    if (contract) {
      await new Promise(r => setTimeout(r, 20)); // ensure DOM visible
      setupFinancingInputs(); // ensure formatters are attached before setting values
      if (G('fin-system'))      G('fin-system').value      = contract.system;
      if (G('fin-index'))       G('fin-index').value       = contract.index_type;
      if (G('fin-rate'))        { const r = G('fin-rate');        if(r.setValue) r.setValue(contract.annual_rate); else r.value = contract.annual_rate; }
      if (G('fin-principal'))   { const p = G('fin-principal');   if(p.setValue) p.setValue(contract.principal);   else p.value = contract.principal; }
      if (G('fin-installments'))G('fin-installments').value= contract.n_installments;
      const [fy, fm] = (contract.first_month||'').split('-');
      if (G('fin-first-m'))     G('fin-first-m').value     = parseInt(fm)||'';
      if (G('fin-first-y'))     G('fin-first-y').value     = parseInt(fy)||'';
      if (G('fin-balloon'))     G('fin-balloon').value     = contract.balloon_at_keys||'';
      if (G('fin-extra-month')) G('fin-extra-month').value = contract.extra_annual_month||'';
      if (G('fin-extra-value')) G('fin-extra-value').value = contract.extra_annual_value||'';
      // Load asset value from existing compra transaction
      const compraT = _pat.txAll.find(t => t.asset_id === id && t.tx_type === 'compra');
      if (compraT && G('fin-asset-value')) {
        setupCurrencyInput(G('fin-asset-value'));
        G('fin-asset-value').setValue(compraT.total_value);
      }
      // Load schedule for preview
      const schedule = _pat.financing[id] || [];
      if (schedule.length) { _finSchedule = schedule; patRenderSchedulePreview(schedule); }
    }
  }

  // Load existing transactions, merging hist values from pat_history
  _patTxRows = [];
  if (id) {
    const txs = await ff.patTxList({ assetId: id }).catch(() => []);
    const hist = _pat.historyAll.filter(h => h.asset_id === id && h.manual);
    const histByMonth = {};
    hist.forEach(h => { histByMonth[h.month] = h.value; });
    // Build rows: one per transaction, with hist_value from the same month if manual
    const months_seen = new Set();
    _patTxRows = txs.map(t => {
      const m = t.month.slice(0,7);
      months_seen.add(m);
      return { ...t, month: m, hist_value: histByMonth[m] ?? null };
    });
    // Also add rows for manual history months that have no transaction (value-only edits)
    hist.forEach(h => {
      const m = h.month.slice(0,7);
      if (!months_seen.has(m)) {
        _patTxRows.push({ id: null, month: m, tx_type: 'aluguel', total_value: null, hist_value: h.value });
      }
    });
    _patTxRows.sort((a,b) => a.month.localeCompare(b.month));
  }
  patTxRenderTable();

  openModal('modal-pat-asset');
}

async function savePatAsset() {
  // Read ALL values from DOM FIRST, before any async operations
  const id     = G('pat-asset-id').value ? parseInt(G('pat-asset-id').value) : null;
  const name   = G('pat-asset-name').value.trim();
  const type   = G('pat-asset-type').value;
  const trend  = G('pat-asset-trend').value;
  const val    = G('pat-asset-value').rawValue ? G('pat-asset-value').rawValue() : parseFloat((G('pat-asset-value').value||'').replace(',','.'));
  const mo     = parseInt(G('pat-asset-month-m')?.value);
  const yr     = parseInt(G('pat-asset-month-y')?.value);
  const month  = (mo >= 1 && mo <= 12 && yr >= 2000) ? `${yr}-${String(mo).padStart(2,'0')}` : null;
  const hidden = G('pat-asset-hidden')?.checked || false;
  const financed = G('pat-financed-check')?.checked || false;
  // financing_total now comes from fin-principal field
  const financing_total = financed ? (readFinField('fin-principal')||null) : null;
  const financingRows = []; // legacy — no longer used (contract system handles schedule)
  const soldM  = parseInt(G('pat-asset-sold-m')?.value);
  const soldY  = parseInt(G('pat-asset-sold-y')?.value);
  const soldMonth = (soldM >= 1 && soldM <= 12 && soldY >= 2000) ? `${soldY}-${String(soldM).padStart(2,'0')}` : null;
  const soldValueEl = G('pat-asset-sold-value'); const soldValue = soldValueEl?.rawValue ? (soldValueEl.rawValue()||null) : (parseFloat(soldValueEl?.value)||null);

  if (!name) { toast('Informe o nome do ativo'); return; }

  // Close modal AFTER reading values
  closeModal('modal-pat-asset');

  // 1. Save asset record
  const result = await ff.patAssetSave({ id, name, asset_type: type, trend, sold_month: soldMonth, sold_value: soldValue, hidden, financed, financing_total });
  const assetId = result.id;

  // 2a. Save financing installments; set asset value = financing_total at first installment month
  // Save financing contract if financed and contract fields are filled
  if (financed) {
    const fn = parseInt(G('fin-installments')?.value||'0');
    const fp = readFinField('fin-principal');
    const fm2 = parseInt(G('fin-first-m')?.value||'0');
    const fy2 = parseInt(G('fin-first-y')?.value||'0');
    if (fn > 0 && fp > 0 && fm2 && fy2) {
      const contract = {
        system:           G('fin-system')?.value || 'SAC',
        index_type:       G('fin-index')?.value  || 'none',
        annual_rate:      readFinField('fin-rate'),
        principal:        fp,
        n_installments:   fn,
        first_month:      `${fy2}-${String(fm2).padStart(2,'0')}`,
        balloon_at_keys:  readFinField('fin-balloon') || null,
        extra_annual_month: parseInt(G('fin-extra-month')?.value||'0')||null,
        extra_annual_value: readFinField('fin-extra-value') || null,
      };
      await ff.patFinancingContractSave({ assetId, contract });

      // Register full asset value + purchase transaction if fin-asset-value is set
      const assetVal = readFinField('fin-asset-value');
      if (assetVal > 0 && contract.first_month) {
        // Set pat_history for first month = full asset value
        await ff.patHistorySet({ assetId, month: contract.first_month, value: assetVal, manual: true });
        // Create a "compra" pat_transaction for the full asset value
        const existingCompra = _pat.txAll.find(t => t.asset_id === assetId && t.tx_type === 'compra');
        await ff.patTxSave({
          id: existingCompra?.id || null,
          assetId, month: contract.first_month,
          tx_type: 'compra', total_value: assetVal,
          notes: 'Valor de aquisição do ativo',
        });
      }
    }
  }

  // Legacy installment save removed — contract system handles schedule

  // 2b. Save initial value as manual entry (if provided, for non-financed assets)
  if (!financed && !isNaN(val) && val > 0 && month) {
    await ff.patHistorySet({ assetId, month, value: val, manual: true });
  }

  // 3a. Save pat_transactions rows + manual hist_value overrides
  for (const row of _patTxRows) {
    if (!row.month) continue;
    // Save transaction if there's a value
    if (row.total_value != null && row.total_value !== '') {
      await ff.patTxSave({
        id: row.id || null,
        assetId,
        month: row.month,
        tx_type: row.tx_type,
        total_value: parseFloat(row.total_value),
        notes: row.notes || null,
      });
    }
    // Save manual hist_value if provided (overrides IPCA auto-calculation)
    if (row.hist_value != null && row.hist_value !== '') {
      await ff.patHistorySet({ assetId, month: row.month, value: parseFloat(row.hist_value), manual: true });
    }
  }

  // 3. Clear any previous manual sale entries, then save the new one
  // This handles the case where soldMonth was changed (e.g. March → April)
  await ff.patHistoryClearManualSale({ assetId, keepMonth: soldMonth || null });
  if (soldMonth && soldValue) {
    await ff.patHistorySet({ assetId, month: soldMonth, value: soldValue, manual: true });
  }

  // 4. Project forward (always run if IPCA data available)
  if (Object.keys(_pat.ipcaMonthly).length) {
    await ff.patAutoProject({ ipcaMonthly: _pat.ipcaMonthly });
  }

  // 5. Full reload from DB then render
  await refreshPatrimonio();
  toast(`✅ Ativo ${id ? 'atualizado' : 'criado'}`);
}

// ── Financing section helpers ──
function onFinSystemChange() {
  const sys = G('fin-system')?.value;
  // Hide rate field for PLANTA (no interest)
  const rateField = G('fin-rate')?.closest('.field');
  if (rateField) rateField.style.display = sys === 'PLANTA' ? 'none' : '';
}

function setupFinancingInputs() {
  document.querySelectorAll('.fin-currency').forEach(el => setupCurrencyInput(el));
  document.querySelectorAll('.fin-percent').forEach(el => setupPercentInput(el));
}

function setupPercentInput(el) {
  if (!el || el.dataset.pctSetup) return;
  el.dataset.pctSetup = '1';
  el.autocomplete = 'off';
  function fmt(v) { return isFinite(v) && v > 0 ? v.toFixed(4).replace('.',',').replace(/,?0+$/,'') + '%' : ''; }
  function parse(s) { return parseFloat(s.replace('%','').replace(',','.')) || 0; }
  el.rawValue = () => parse(el.value);
  el.setValue = v => { el.value = v != null && v > 0 ? fmt(v) : ''; };
  el.addEventListener('blur', () => { const v = parse(el.value); el.value = v > 0 ? fmt(v) : ''; });
  el.addEventListener('focus', () => { el.value = el.value.replace('%','').trim(); setTimeout(() => el.select(), 0); });
}

function setupFinancingInputs() {
  // Must run AFTER section is visible (offsetParent check)
  document.querySelectorAll('#pat-financing-section .fin-currency').forEach(el => setupCurrencyInput(el));
  document.querySelectorAll('#pat-financing-section .fin-percent').forEach(el => setupPercentInput(el));
}

function patToggleFinancingSection() {
  const checked = G('pat-financed-check')?.checked;
  G('pat-financing-section').style.display     = checked ? '' : 'none';
  G('pat-initial-value-section').style.display = checked ? 'none' : '';
  // Setup formatters after making section visible
  if (checked) setTimeout(setupFinancingInputs, 0);
}

function patFinancingRowHtml(){}  // legacy stub (replaced by contract system)

let _finSchedule = []; // generated schedule for preview

function readFinField(id) {
  const el = G(id);
  if (!el) return 0;
  if (el.rawValue) return el.rawValue() || 0;
  return parseFloat(el.value.replace(/[R$\u00a0\s.]/g,'').replace(',','.')) || 0;
}

async function patGenerateSchedule() {
  const system      = G('fin-system')?.value || 'SAC';
  const index_type  = G('fin-index')?.value  || 'none';
  const annual_rate = readFinField('fin-rate');
  const principal   = readFinField('fin-principal');
  const n           = parseInt(G('fin-installments')?.value || '0');
  const fm          = parseInt(G('fin-first-m')?.value || '0');
  const fy          = parseInt(G('fin-first-y')?.value || '0');
  const balloon     = readFinField('fin-balloon') || 0;
  const extraMonth  = parseInt(G('fin-extra-month')?.value || '0') || null;
  const extraValue  = readFinField('fin-extra-value') || null;

  if (!principal || !n || !fm || !fy) { toast('Preencha valor financiado, nº de parcelas e primeira parcela'); return; }
  const first_month = `${fy}-${String(fm).padStart(2,'0')}`;

  // Call backend schedule generation
  const assetId = parseInt(G('pat-asset-id')?.value || '0');
  const contract = { system, index_type, annual_rate, principal, n_installments: n,
    first_month, balloon_at_keys: balloon, extra_annual_month: extraMonth, extra_annual_value: extraValue };

  if (assetId) {
    const result = await ff.patFinancingContractSave({ assetId, contract });
    _finSchedule = result?.schedule || [];
  } else {
    // Preview only (asset not yet saved) — use a local calculation
    _finSchedule = _localGenerateSchedule(contract);
  }

  patRenderSchedulePreview(_finSchedule);
  const totalInstall = _finSchedule.reduce((s,r) => s+r.installment, 0);
  G('fin-schedule-summary').textContent =
    `${_finSchedule.length} parcelas — Total: ${fmtBRL(totalInstall)} — Saldo final: ${fmtBRL(_finSchedule.at(-1)?.balance_end ?? 0)}`;
}

function _localGenerateSchedule({ system, annual_rate, principal, n_installments, first_month, balloon_at_keys, extra_annual_month, extra_annual_value }) {
  const r = (annual_rate / 100) / 12;
  let remaining = principal - (balloon_at_keys || 0);
  let priceInst = 0;
  if (system === 'PRICE' || system === 'SAM') {
    priceInst = r > 0
      ? remaining * r * Math.pow(1+r, n_installments) / (Math.pow(1+r, n_installments) - 1)
      : remaining / n_installments;
  }
  let balance = remaining;
  let cur = first_month;
  const rows = [];
  if (system === 'PLANTA') {
    const monthlyInst = remaining / n_installments;
    for (let i = 0; i < n_installments && balance > 0.01; i++) {
      const extra = (extra_annual_month && extra_annual_value && parseInt(cur.split('-')[1]) === extra_annual_month) ? extra_annual_value : 0;
      balance = Math.max(0, balance - monthlyInst - extra);
      rows.push({ month: cur, installment: Math.round((monthlyInst+extra)*100)/100,
        principal: Math.round((monthlyInst+extra)*100)/100, interest: 0,
        correction: 0, balance_end: Math.round(balance*100)/100, is_projection: 1 });
      const [y, m] = cur.split('-').map(Number);
      cur = m===12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,'0')}`;
    }
    return rows;
  }
  for (let i = 0; i < n_installments && balance > 0.01; i++) {
    const interest = balance * r;
    let amort, install;
    if (system === 'SAC') { amort = remaining / n_installments; install = amort + interest; }
    else if (system === 'PRICE') { install = priceInst; amort = install - interest; }
    else { const si = remaining/n_installments+interest; install=(si+priceInst)/2; amort=install-interest; }
    const extra = (extra_annual_month && extra_annual_value && parseInt(cur.split('-')[1]) === extra_annual_month) ? extra_annual_value : 0;
    balance = Math.max(0, balance - amort - extra);
    rows.push({ month: cur, installment: Math.round((install+extra)*100)/100,
      principal: Math.round((amort+extra)*100)/100, interest: Math.round(interest*100)/100,
      correction: 0, balance_end: Math.round(balance*100)/100, is_projection: 1 });
    const [y, m] = cur.split('-').map(Number);
    cur = m===12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,'0')}`;
  }
  return rows;
}

function patRenderSchedulePreview(schedule) {
  const preview = G('fin-schedule-preview');
  const body    = G('fin-schedule-body');
  if (!preview || !body || !schedule.length) return;
  const curM = new Date().toISOString().slice(0,7);
  const rows = schedule.slice(0, 6); // show first 6 as preview
  body.innerHTML = rows.map(r => {
    const isPast = r.month <= curM && r.is_projection === 0;
    const isFut  = r.is_projection === 1 && r.month > curM;
    const color  = isPast ? 'var(--text1)' : 'var(--text3)';
    return `<div style="display:grid;grid-template-columns:90px 100px 90px 90px 90px 90px;padding:4px 10px;border-bottom:1px solid var(--border);color:${color}">
      <span>${fmtMonth(r.month)}</span>
      <span class="right" style="font-family:'DM Mono',monospace">${fmtBRL(r.installment)}</span>
      <span class="right" style="font-family:'DM Mono',monospace">${fmtBRL(r.principal)}</span>
      <span class="right" style="font-family:'DM Mono',monospace">${fmtBRL(r.interest)}</span>
      <span class="right" style="font-family:'DM Mono',monospace">${fmtBRL(r.balance_end)}</span>
      <span class="right" style="font-size:9px">${isFut ? '📊 proj.' : isPast ? '✅ pago' : '⏳ pend.'}</span>
    </div>`;
  }).join('');
  if (schedule.length > 6) body.innerHTML += `<div style="padding:6px 10px;color:var(--text3);font-size:11px">... e mais ${schedule.length - 6} parcelas</div>`;
  preview.style.display = '';
}

function patCollectFinancingRows() {
  // Legacy: return schedule rows for old save path (no longer used for new contracts)
  return _finSchedule.map(r => ({ month: r.month, installment: r.installment }));
}

async function deletePatAsset(id) {
  const a = _pat.assets.find(a=>a.id===id);
  const ok = await showConfirmDialog(`Excluir "${a?.name}"?`, 'Todo o histórico será removido. Esta ação não pode ser desfeita.', 'Excluir', true);
  if (!ok) return;
  await ff.patAssetDelete({ id });
  toast('Ativo removido');
  refreshPatrimonio();
}

// ── Account selection modal ──
// ── Account selection + ordering modal ──
// State: list of {id, name, type, included} in current order
let _patAccModalList = [];

async function openPatAccountsModal() {
  const accs = await ff.patAccountsGet(); // [{id,name,type,included,sort_order}]

  // Build ordered list: included (sorted by sort_order) first, then non-included
  const included    = accs.filter(a => a.included).sort((a,b) => a.sort_order - b.sort_order);
  const notIncluded = accs.filter(a => !a.included);
  _patAccModalList  = [...included, ...notIncluded].map(a => ({ ...a }));

  renderPatAccModal();
  openModal('modal-pat-accounts');
}

function renderPatAccModal() {
  const typeLabels = { bank:'Conta Bancária', credit:'Cartão', cash:'Caixa', investment:'Investimento', other:'Outro' };
  const container  = G('pat-accounts-selector');
  if (!container) return;

  container.innerHTML = _patAccModalList.map((a, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:6px;margin-bottom:4px;background:${a.included?'var(--accent-bg)':'var(--bg3)'};border:1px solid ${a.included?'var(--accent)':'var(--border)'}">
      <input type="checkbox" id="pac-${a.id}" ${a.included?'checked':''} onchange="patAccToggle(${i})">
      <label for="pac-${a.id}" style="flex:1;font-size:13px;cursor:pointer">
        ${esc(a.name)}
        <span style="font-size:10px;color:var(--text3);margin-left:4px">${typeLabels[a.type]||a.type}</span>
      </label>
      <div style="display:flex;flex-direction:column;gap:2px">
        <button class="btn-icon" style="font-size:10px;padding:1px 5px;line-height:1" onclick="patAccMove(${i},-1)" ${i===0?'disabled':''}>▲</button>
        <button class="btn-icon" style="font-size:10px;padding:1px 5px;line-height:1" onclick="patAccMove(${i},+1)" ${i===_patAccModalList.length-1?'disabled':''}>▼</button>
      </div>
    </div>`).join('');
}

function patAccToggle(i) {
  _patAccModalList[i].included = !_patAccModalList[i].included;
  renderPatAccModal();
}

function patAccMove(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= _patAccModalList.length) return;
  [_patAccModalList[i], _patAccModalList[j]] = [_patAccModalList[j], _patAccModalList[i]];
  renderPatAccModal();
}

async function savePatAccounts() {
  const includedIds = _patAccModalList
    .filter(a => a.included)
    .map(a => parseInt(a.id));  // ensure integers
  await ff.patAccountsSet({ accountIds: includedIds });
  closeModal('modal-pat-accounts');
  toast(`Contas atualizadas (${includedIds.length} selecionadas)`);
  // Full reload to reflect new order
  _pat.accountBalances = await ff.patAccountBalances();
  refreshPatrimonioTable();
}

// ══ PATRIMÔNIO: IMPORT FROM EXCEL ══
let _patImportData = null; // parsed data waiting for confirmation

function openPatImportModal() {
  G('pat-import-preview').innerHTML = '';
  G('pat-import-confirm-btn').style.display = 'none';
  G('pat-import-file').value = '';
  _patImportData = null;
  openModal('modal-pat-import');
}

function triggerPatImportFile() {
  G('pat-import-file').click();
}

async function onPatImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  G('pat-import-preview').innerHTML = '<div class="info-box">⏳ Lendo arquivo…</div>';
  G('pat-import-confirm-btn').style.display = 'none';

  try {
    const buffer = await file.arrayBuffer();
    const XLSX = await getXLSX();
    const wb = XLSX.read(buffer, { type: 'array', cellDates: true });

    const sheetName = wb.SheetNames.find(n => n.toLowerCase().includes('patrim'));
    if (!sheetName) {
      G('pat-import-preview').innerHTML = '<div class="warn-box">❌ Aba "Patrimônio" não encontrada.</div>';
      return;
    }

    const ws = wb.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    // Row 0 (Excel row 1): dates start at col 5
    const dateCols = [];
    for (let c = 5; c < (raw[0]?.length || 0); c++) {
      const v = raw[0][c];
      if (!v) continue;
      let dt = v instanceof Date ? v : null;
      if (!dt && typeof v === 'number') {
        // Excel serial date
        dt = new Date(Math.round((v - 25569) * 86400 * 1000));
      }
      if (dt && !isNaN(dt)) {
        const month = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
        if (month >= '2000-01') dateCols.push({ col: c, month });
      }
    }

    if (!dateCols.length) {
      G('pat-import-preview').innerHTML = '<div class="warn-box">❌ Nenhuma coluna de data encontrada.</div>';
      return;
    }

    // Rows 12-19 (0-indexed) = Excel rows 13-20 = individual assets
    // Row 11 = "PATRIMÔNIO IMOBILIZADO" total (skip)
    // Row 10 = section header (skip)
    const ASSET_ROWS = [12, 13, 14, 15, 16, 17, 18, 19];
    // Known asset type hints by keywords
    const typeHints = (name) => {
      const n = name.toLowerCase();
      if (n.includes('casa') || n.includes('apart') || n.includes('imóv') || n.includes('imovel')) return 'imovel';
      if (n.includes('carro') || n.includes('veículo') || n.includes('veiculo') ||
          n.includes('jeep') || n.includes('audi') || n.includes('compass') ||
          n.includes('sorento') || n.includes('azera') || n.includes('dolphin')) return 'veiculo';
      if (n.includes('barco') || n.includes('lancha')) return 'barco';
      if (n.includes('clube') || n.includes('título') || n.includes('titulo')) return 'clube';
      if (n.includes('societário') || n.includes('societario') || n.includes('empresa')) return 'societario';
      return 'outro';
    };

    const parsedAssets = [];
    for (const r of ASSET_ROWS) {
      if (r >= raw.length) continue;
      const label = raw[r]?.[0];
      // Skip empty rows, section headers, total rows
      if (!label || typeof label !== 'string') continue;
      const name = String(label).trim();
      if (!name || name.toUpperCase().includes('PATRIMÔNIO') || name.toUpperCase().includes('TOTAL')) continue;

      // Extract values for this row
      const history = dateCols
        .map(({ col, month }) => ({ month, value: raw[r][col] }))
        .filter(e => typeof e.value === 'number' && isFinite(e.value) && e.value > 0);

      if (!history.length) continue; // skip rows with no numeric data

      parsedAssets.push({
        name,
        asset_type: typeHints(name),
        trend: 'stable', // user can adjust after import
        history,
      });
    }

    if (!parsedAssets.length) {
      G('pat-import-preview').innerHTML = '<div class="warn-box">❌ Nenhum ativo encontrado nas linhas 13-20.</div>';
      return;
    }

    _patImportData = parsedAssets;
    const totalEntries = parsedAssets.reduce((s,a) => s + a.history.length, 0);

    let html = `<div style="margin-bottom:10px;font-size:13px"><strong>${parsedAssets.length} ativo(s) identificado(s):</strong></div>`;
    parsedAssets.forEach(a => {
      const existing = _pat.assets.find(pa => pa.name.toLowerCase() === a.name.toLowerCase());
      const badge = existing
        ? '<span style="font-size:10px;background:var(--accent-bg);color:var(--accent);padding:1px 5px;border-radius:3px">já cadastrado</span>'
        : '<span style="font-size:10px;background:#dcfce7;color:#16a34a;padding:1px 5px;border-radius:3px">será criado</span>';
      html += `<div style="background:var(--bg3);border-radius:6px;padding:8px 12px;margin-bottom:6px;font-size:12px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:2px">
          <strong>${esc(a.name)}</strong> ${badge}
          <span style="color:var(--text3);font-size:11px">${PAT_ASSET_TYPES[a.asset_type]||a.asset_type}</span>
        </div>
        <div style="color:var(--text3)">${a.history.length} meses (${a.history[0]?.month} → ${a.history[a.history.length-1]?.month})</div>
      </div>`;
    });
    html += `<div class="info-box" style="margin-top:8px;font-size:12px">
      Total: ${totalEntries} valores. Ativos inexistentes serão criados automaticamente com tendência "Estável" — ajuste depois se necessário.
    </div>`;
    G('pat-import-preview').innerHTML = html;
    G('pat-import-confirm-btn').style.display = '';

  } catch(e) {
    G('pat-import-preview').innerHTML = `<div class="warn-box">❌ Erro: ${esc(e.message)}</div>`;
  }
}

async function confirmPatImport() {
  if (!_patImportData) return;
  G('pat-import-confirm-btn').disabled = true;
  G('pat-import-preview').innerHTML = '<div class="info-box">⏳ Importando…</div>';

  try {
    const result = await ff.patImportHistoryFull({ assets: _patImportData });
    G('pat-import-preview').innerHTML = `<div class="info-box">
      ✅ Importação concluída!<br>
      ${result.importedAssets > 0 ? `${result.importedAssets} ativo(s) criado(s)<br>` : ''}
      ${result.importedValues} valores históricos importados.
    </div>`;
    G('pat-import-confirm-btn').style.display = 'none';
    _patImportData = null;
    toast(`✅ ${result.importedValues} valores históricos importados`);
    await refreshPatrimonio();
  } catch(e) {
    G('pat-import-preview').innerHTML = `<div class="warn-box">❌ Erro: ${esc(e.message)}</div>`;
    G('pat-import-confirm-btn').disabled = false;
  }
}

function getXLSX() {
  return new Promise(resolve => {
    if (window.XLSX) { resolve(window.XLSX); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    document.head.appendChild(s);
  });
}

// ══ INVESTIMENTOS FINANCEIROS ══

const INV_CATEGORIES = {
  renda_fixa:     { label: 'Renda Fixa',      types: ['CDB','CRA','CRI','LCI','LCA','Debênture','LF','Poupança'] },
  fundos:         { label: 'Fundos',           types: ['Fundo Renda Fixa','Fundo de Ações','Fundo Multimercado','Fundo Cambial','FII','ETF'] },
  tesouro:        { label: 'Tesouro Direto',   types: ['Tesouro IPCA+','Renda+','Tesouro Prefixado','Tesouro Educa+','Tesouro SELIC'] },
  previdencia:    { label: 'Previdência',      types: ['PGBL','VGBL'] },
  renda_variavel: { label: 'Renda Variável',   types: ['Ações','ETF','BDR','Criptoativo','Contrato Futuro','Opções','Fiagro'] },
  private_equity: { label: 'Private Equity',   types: ['Private Equity'] },
  caixa:          { label: 'Valor em Caixa',   types: ['Conta Corrente','Conta Remunerada','Outros'] },
  valor_em_caixa: { label: 'Valor em Caixa',   types: ['Conta Corrente','Conta Remunerada','Outros'] },
};

// Canonical category order for display (valor_em_caixa always last)
const INV_CAT_ORDER = ['renda_fixa','tesouro','previdencia','fundos','renda_variavel','private_equity','caixa','valor_em_caixa'];

// Cash transactions — affect the cash flow line
// External capital flows — money in/out of the portfolio (distort TWR if not separated)
const INV_TX_EXTERNAL = {
  compra:      { label: '🟢 Compra / Aporte inicial', sign: -1 },
  aporte:      { label: '➕ Aporte adicional',         sign: -1 },
  venda:       { label: '🔴 Venda (parcial)',          sign: +1 },
  amortizacao: { label: '📉 Amortização / Resgate',   sign: +1 },
};

// Income/cost flows — returns generated by the asset (compose the return, not capital)
const INV_TX_INCOME = {
  dividendo:   { label: '💰 Dividendo / Distribuição', sign: +1 },
  juros:       { label: '💵 Juros / Rendimento',       sign: +1 },
  taxa:        { label: '📋 Taxa / Custo',             sign: -1 },
  jcp:         { label: '🏦 JCP',                      sign: +1 },
  cupom:       { label: '🎫 Cupom',                    sign: +1 },
};

// Legacy alias — keeps backward compatibility with all existing code
const INV_TX_CASH = { ...INV_TX_EXTERNAL, ...INV_TX_INCOME };

// Valuation transactions — update asset value only, no cash impact
const INV_TX_VALUATION = {
  atualizacao: { label: '📊 Atualização de valor' },
  cota:        { label: '📈 Cota/NAV atualizado' },
  incorporacao:{ label: '🔄 Incorporação/Capitalização' },
  correcao:    { label: '📐 Correção monetária' },
};

// Combined for display/detail
const INV_TX_TYPES = { ...INV_TX_CASH, ...INV_TX_VALUATION };

let _inv = { assets: [], txAll: [], showRealFlow: false };

async function refreshInvestimentos() {
  _inv.assets = await ff.invAssetsList();
  _inv.txAll  = await ff.invTxAll();
}

// ── Helpers ──
function invUpdateTypes() {
  const cat  = G('inv-category')?.value;
  const sel  = G('inv-type');
  if (!sel || !cat) return;
  const types = INV_CATEGORIES[cat]?.types || [];
  const cur   = sel.value;
  sel.innerHTML = types.map(t => `<option value="${t}" ${t===cur?'selected':''}>${t}</option>`).join('');
}

async function invLoadBrokers() {
  try {
    const brokers = await ff.invBrokersList();
    const dl = G('inv-broker-list');
    if (dl) dl.innerHTML = brokers.map(b => `<option value="${esc(b)}">`).join('');
  } catch(e) {}
}

function invToggleLiqDays() {
  const isDias = G('inv-liq-dias')?.checked;
  const daysEl = G('inv-liq-days');
  if (daysEl) daysEl.disabled = !isDias;
  invUpdateLiqLabel();
}

function invUpdateLiqLabel() {
  const isDias = G('inv-liq-dias')?.checked;
  const days   = parseInt(G('inv-liq-days')?.value) || 0;
  const matM   = parseInt(G('inv-mat-m')?.value);
  const matY   = parseInt(G('inv-mat-y')?.value);
  const lbl    = G('inv-liq-label');
  if (!lbl) return;
  if (!isDias) {
    if (matM && matY) {
      lbl.textContent = `→ Disponível em ${fmtMonth(`${matY}-${String(matM).padStart(2,'0')}`)}`;
    } else lbl.textContent = '';
  } else {
    if (days > 0) {
      const d = new Date();
      d.setDate(d.getDate() + days);
      lbl.textContent = `→ Disponível em ~${d.toLocaleDateString('pt-BR')}`;
    } else lbl.textContent = '';
  }
}

// ── Evaluate formula string like "+500-30" → number ──
function evalFormula(str) {
  if (!str || !str.toString().trim()) return null;
  const s = str.toString().trim();
  // If plain number, parse directly
  if (/^-?\d+([.,]\d+)?$/.test(s)) return parseFloat(s.replace(',','.'));
  // Evaluate simple formula: allow digits, dots, commas, +, -, spaces
  const safe = s.replace(/,/g,'.').replace(/[^0-9+\-. ]/g,'');
  try {
    // eslint-disable-next-line no-new-func
    const result = Function('"use strict"; return (' + safe + ')')();
    return isFinite(result) ? Math.round(result * 100) / 100 : null;
  } catch(e) { return null; }
}

// Build a row in the history table
function invHistoryRowHtml(month, value, external, income, idx) {
  const valStr = value    != null ? value.toString()    : '';
  const extStr = external != null ? external.toString() : '';
  const incStr = income   != null ? income.toString()   : '';
  const isOdd  = idx % 2;
  const [y, m] = month.split('-');
  const inputStyle = "font-size:12px;padding:4px 6px;text-align:right;background:transparent;border:1px solid transparent;font-family:'DM Mono',monospace;width:100%";
  const focusOn  = "this.style.borderColor='var(--accent)';this.style.background='var(--bg2)'";
  const focusOff = "this.style.borderColor='transparent';this.style.background='transparent'";
  return `<div style="display:grid;grid-template-columns:100px 1fr 1fr 1fr 32px;align-items:center;gap:2px;padding:5px 8px;font-size:12px;background:${isOdd?'var(--bg3)':'var(--bg2)'};border-bottom:1px solid var(--border)" data-month="${month}">
    <div style="display:flex;gap:3px">
      <input class="inp inv-hist-mo" type="number" min="1" max="12" value="${parseInt(m)}"
        style="width:40px;font-size:11px;padding:3px 4px;text-align:center"
        onchange="invUpdateRowMonth(this)" title="Mês">
      <input class="inp inv-hist-yr" type="number" min="2000" max="2100" value="${parseInt(y)}"
        style="width:54px;font-size:11px;padding:3px 4px;text-align:center"
        onchange="invUpdateRowMonth(this)" title="Ano">
    </div>
    <input class="inp inv-hist-value" type="text" value="${valStr}"
      placeholder="Valor total"
      title="Valor total do ativo no final do mês"
      style="${inputStyle}"
      onfocus="${focusOn}" onblur="${focusOff}">
    <input class="inp inv-hist-external" type="text" value="${extStr}"
      placeholder="Ex: -5000"
      title="Aportes/resgates externos (compra, aporte, venda, amortização). Negativo = saída; Positivo = entrada."
      style="${inputStyle};color:var(--accent)"
      onfocus="${focusOn}" onblur="${focusOff}">
    <input class="inp inv-hist-income" type="text" value="${incStr}"
      placeholder="Ex: +200"
      title="Rendimentos/custos do ativo (dividendo, juros, JCP, taxa). Positivo = recebido; Negativo = custo."
      style="${inputStyle};color:var(--green)"
      onfocus="${focusOn}" onblur="${focusOff}">
    <button class="btn-icon" style="color:var(--red);font-size:11px" onclick="this.closest('[data-month]').remove()">✕</button>
  </div>`;
}

// Update data-month when user changes month/year inputs
function invUpdateRowMonth(inp) {
  const row = inp.closest('[data-month]');
  if (!row) return;
  const mo = row.querySelector('.inv-hist-mo')?.value;
  const yr = row.querySelector('.inv-hist-yr')?.value;
  if (mo && yr) row.dataset.month = `${yr}-${String(mo).padStart(2,'0')}`;
}

// Populate the history table from existing transactions
function renderInvHistoryTable(txs) {
  const container = G('inv-history-table');
  if (!container) return;

  // Exclude auto-generated sale/zeroing txs — these are re-created on save from the Venda fields
  const AUTO_NOTES = ['Venda registrada na saída', 'Zeragem na venda'];
  const displayTxs = txs.filter(t => !AUTO_NOTES.includes(t.notes));

  // Group by month: value = last valuation; external = capital flows; income = return flows
  const byMonth = {};
  displayTxs.forEach(t => {
    if (!byMonth[t.month]) byMonth[t.month] = { value: null, external: 0, income: 0, hasExternal: false, hasIncome: false };
    if (t.tx_type in INV_TX_VALUATION) {
      byMonth[t.month].value = t.total_value;
    } else if (t.tx_type in INV_TX_EXTERNAL) {
      byMonth[t.month].external += (INV_TX_EXTERNAL[t.tx_type]?.sign ?? 1) * t.total_value;
      byMonth[t.month].hasExternal = true;
    } else if (t.tx_type in INV_TX_INCOME) {
      byMonth[t.month].income += (INV_TX_INCOME[t.tx_type]?.sign ?? 1) * t.total_value;
      byMonth[t.month].hasIncome = true;
    } else if (t.tx_type in INV_TX_CASH) {
      // Legacy: classify by sign convention
      const sign = INV_TX_CASH[t.tx_type]?.sign ?? 1;
      byMonth[t.month].external += sign * t.total_value;
      byMonth[t.month].hasExternal = true;
    }
  });

  const months = Object.keys(byMonth).sort();
  // Preserve sticky header (first child), replace only data rows
  const header = container.querySelector('[style*="sticky"]') || container.firstElementChild;
  // Remove all data rows (keep header)
  [...container.querySelectorAll('[data-month]')].forEach(el => el.remove());
  const emptyMsg = container.querySelector('.inv-empty-msg');
  if (emptyMsg) emptyMsg.remove();

  if (!months.length) {
    const msg = document.createElement('div');
    msg.className = 'inv-empty-msg';
    msg.style.cssText = 'padding:12px;font-size:12px;color:var(--text3)';
    msg.textContent = 'Nenhum dado. Clique em "+ Adicionar mês".';
    container.appendChild(msg);
    return;
  }

  const rowsHtml = months.map((m, i) => {
    const d = byMonth[m];
    const extStr = d.hasExternal ? d.external.toFixed(2) : '';
    const incStr = d.hasIncome  ? d.income.toFixed(2)   : '';
    return invHistoryRowHtml(m, d.value === 0 ? null : d.value, extStr, incStr, i);
  }).join('');
  container.insertAdjacentHTML('beforeend', rowsHtml);
}

function invAddHistoryRow() {
  const container = G('inv-history-table');
  if (!container) return;
  // Remove empty message if present
  const emptyMsg = container.querySelector('.inv-empty-msg');
  if (emptyMsg) emptyMsg.remove();
  // Default: next month after last row, or current month
  const existing = [...container.querySelectorAll('[data-month]')].map(el => el.dataset.month).sort();
  let nextM;
  if (existing.length) {
    const last = existing[existing.length - 1];
    const [y, m] = last.split('-').map(Number);
    nextM = m === 12 ? `${y+1}-01` : `${y}-${String(m+1).padStart(2,'0')}`;
  } else {
    const now = new Date();
    nextM = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  }
  // Don't duplicate
  if (container.querySelector(`[data-month="${nextM}"]`)) return;
  const idx = container.querySelectorAll('[data-month]').length;
  container.insertAdjacentHTML('beforeend', invHistoryRowHtml(nextM, null, null, null, idx));
  container.lastElementChild.scrollIntoView({ behavior:'smooth', block:'nearest' });
}

// ── Importação histórica da planilha Excel ──────────────────────────────────
function openInvHistoryImportModal() {
  const existing = document.getElementById('inv-history-import-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'inv-history-import-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal" style="max-width:520px;width:96%">
      <div class="modal-header">
        <h3 style="margin:0;font-size:15px">📥 Importar histórico da planilha Excel</h3>
        <button class="btn-icon" onclick="const _m=document.getElementById('inv-history-import-modal');_m?.querySelector(':focus')?.blur();_m?.remove();setTimeout(()=>{document.activeElement?.blur();document.body.focus()},0)">✕</button>
      </div>
      <div class="modal-body" style="padding:16px">
        <p style="margin:0 0 12px;font-size:13px;color:var(--text2)">
          Selecione a planilha <strong>Finanças.xlsx</strong>. Os dados da aba <em>Patrimônio</em>
          serão lidos e os ativos serão criados automaticamente com todo o histórico de valores e movimentações.
        </p>
        <p style="margin:0 0 14px;font-size:12px;color:var(--text3)">
          ⚠️ Se um ativo com o mesmo nome já existir no Cruzeiro, suas transações serão substituídas.
        </p>
        <div style="margin-bottom:14px">
          <label style="font-size:12px;font-weight:600;display:block;margin-bottom:6px">Arquivo .xlsx</label>
          <input type="file" id="inv-import-file-input" accept=".xlsx,.xls"
            style="font-size:12px;width:100%;padding:6px;border:1px solid var(--border);border-radius:6px;background:var(--bg2);color:var(--text1)">
        </div>
        <div id="inv-import-progress" style="display:none;margin-bottom:12px">
          <div style="font-size:12px;color:var(--text2);margin-bottom:6px" id="inv-import-status">Lendo arquivo...</div>
          <div style="background:var(--bg3);border-radius:4px;height:6px;overflow:hidden">
            <div id="inv-import-bar" style="height:100%;background:var(--accent);width:0%;transition:width 0.3s"></div>
          </div>
        </div>
        <div id="inv-import-result" style="display:none;padding:10px;border-radius:6px;font-size:12px;margin-bottom:12px"></div>
      </div>
      <div class="modal-footer" style="padding:12px 16px;display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" onclick="const _m=document.getElementById('inv-history-import-modal');_m?.querySelector(':focus')?.blur();_m?.remove();setTimeout(()=>{document.activeElement?.blur();document.body.focus()},0)">Cancelar</button>
        <button class="btn primary" id="inv-import-btn" onclick="runInvHistoryImport()">📥 Importar</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

async function runInvHistoryImport() {
  const fileInput = document.getElementById('inv-import-file-input');
  if (!fileInput.files.length) { toast('Selecione um arquivo .xlsx primeiro.'); return; }

  const btn      = document.getElementById('inv-import-btn');
  const progress = document.getElementById('inv-import-progress');
  const status   = document.getElementById('inv-import-status');
  const bar      = document.getElementById('inv-import-bar');
  const result   = document.getElementById('inv-import-result');

  btn.disabled = true;
  progress.style.display = 'block';
  result.style.display = 'none';

  try {
    // 1. Read file as ArrayBuffer
    status.textContent = 'Lendo arquivo...';
    bar.style.width = '10%';
    const buf = await fileInput.files[0].arrayBuffer();

    // 2. Parse with SheetJS (already available in the app via CDN or bundled)
    status.textContent = 'Interpretando planilha...';
    bar.style.width = '25%';

    // Load SheetJS dynamically if not already loaded
    if (typeof XLSX === 'undefined') {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const ws = wb.Sheets['Patrimônio'];
    if (!ws) throw new Error('Aba "Patrimônio" não encontrada na planilha.');

    status.textContent = 'Extraindo ativos...';
    bar.style.width = '40%';

    // 3. Build date map: col index -> "YYYY-MM-DD"
    // Col F = 5 (0-based), Col CJ = 87 (0-based)
    const COL_F  = 5;
    const COL_CJ = 87;
    const dateMap = {}; // colIdx -> "YYYY-MM-DD"
    for (let c = COL_F; c <= COL_CJ; c++) {
      const addr = XLSX.utils.encode_cell({ r: 0, c });
      const cell = ws[addr];
      if (cell && cell.t === 'd') {
        const d = cell.v instanceof Date ? cell.v : new Date(cell.v);
        dateMap[c] = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      } else if (cell && cell.w) {
        // Try to parse formatted date string
        const d = new Date(cell.w);
        if (!isNaN(d)) dateMap[c] = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      }
    }

    // Helper: get cell value (number) or null
    const cellVal = (r, c) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) return null;
      if (cell.t === 'n') return cell.v;
      if (cell.t === 's') { const n = parseFloat(cell.v); return isNaN(n) ? null : n; }
      return null;
    };
    const cellStr = (r, c) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) return '';
      return String(cell.v || '').trim();
    };
    const cellBold = (r, c) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      return cell && cell.s && cell.s.font && cell.s.font.bold;
    };
    const cellDate = (r, c) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) return null;
      if (cell.t === 'd') {
        const d = cell.v instanceof Date ? cell.v : new Date(cell.v);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
      }
      return null;
    };

    // Range definitions (1-based rows, convert to 0-based)
    const RANGES = [
      { start: 56, end: 103,  categoria: 'renda_fixa',      tipo: 'CDB'                  },
      { start: 112, end: 151, categoria: 'tesouro',          tipo: 'Tesouro IPCA+'        },
      { start: 160, end: 167, categoria: 'previdencia',      tipo: 'PGBL'                 },
      { start: 176, end: 247, categoria: 'fundos',           tipo: 'Fundo de Renda Fixa'  },
      { start: 256, end: 286, categoria: 'fundos',           tipo: 'FII'                  },
      { start: 288, end: 292, categoria: 'renda_variavel',   tipo: 'Ações'                },
      { start: 293, end: 304, categoria: 'fundos',           tipo: 'FII'                  },
      { start: 305, end: 306, categoria: 'renda_variavel',   tipo: 'Ações'                },
    ];

    const assets = [];

    for (const range of RANGES) {
      for (let row1 = range.start; row1 <= range.end; row1++) {
        const r = row1 - 1; // 0-based
        const nameCell = ws[XLSX.utils.encode_cell({ r, c: 0 })];
        if (!nameCell) continue;
        const name = String(nameCell.v || '').trim();
        if (!name) continue;
        // Bold check via style (may not always work with SheetJS in browser, fallback: check row below is "Aportes")
        const isBold = cellBold(r, 0);
        const rowBelow = cellStr(r + 1, 0);
        const isAssetRow = isBold || rowBelow === 'Aportes';
        if (!isAssetRow) continue;

        const broker       = cellStr(r, 1);
        const maturityRaw  = cellDate(r, 2);

        // Collect valores (row r) and aportes (row r+1)
        const valores  = {};
        const aportes  = {};
        for (let c = COL_F; c <= COL_CJ; c++) {
          const dateStr = dateMap[c];
          if (!dateStr) continue;
          const v = cellVal(r, c);
          if (v != null && v !== 0) valores[dateStr] = v;
          const a = cellVal(r + 1, c);
          // Invert: positive in sheet = saída (compra) → negative in FF = aporte positivo
          if (a != null && a !== 0) aportes[dateStr] = -a;
        }

        assets.push({ name, broker, maturity_month: maturityRaw, categoria: range.categoria, tipo: range.tipo, valores, aportes });
      }
    }

    // Special case: linha 318 = valor em caixa (só valores, sem aportes separados)
    {
      const r = 317; // 0-based
      const broker = cellStr(r, 1);
      const valores = {};
      for (let c = COL_F; c <= COL_CJ; c++) {
        const dateStr = dateMap[c];
        if (!dateStr) continue;
        const v = cellVal(r, c);
        if (v != null && v !== 0) valores[dateStr] = v;
      }
      assets.push({ name: 'Valores em Caixa', broker, maturity_month: null, categoria: 'valor_em_caixa', tipo: 'Caixa', valores, aportes: {} });
    }

    status.textContent = `Encontrados ${assets.length} ativos. Salvando no banco...`;
    bar.style.width = '65%';

    // 4. Send to main process
    const res = await ff.invBulkImportHistory({ assets });

    bar.style.width = '100%';
    status.textContent = 'Concluído!';

    result.style.display = 'block';
    result.style.background = 'var(--green-bg, #d4edda)';
    result.style.color = 'var(--green-text, #155724)';
    result.innerHTML = `
      ✅ <strong>Importação concluída!</strong><br>
      • ${res.createdAssets} ativo(s) criado(s)<br>
      • ${res.updatedAssets} ativo(s) atualizado(s)<br>
      • ${res.createdTx} transações importadas
    `;

    const doneBtn = document.getElementById('inv-import-btn');
    doneBtn.textContent = '✓ Feito';
    doneBtn.onclick = () => document.getElementById('inv-history-import-modal').remove();
    doneBtn.disabled = false;
    await refreshPatrimonioTable();

  } catch (err) {
    console.error('Erro na importação:', err);
    bar.style.width = '100%';
    bar.style.background = 'var(--red, #dc3545)';
    result.style.display = 'block';
    result.style.background = 'var(--red-bg, #f8d7da)';
    result.style.color = 'var(--red-text, #721c24)';
    result.innerHTML = `❌ <strong>Erro:</strong> ${err.message}`;
    btn.disabled = false;
  }
}

async function openInvAssetModal(id) {
  const now = new Date();
  G('inv-asset-id').value = id || '';
  G('inv-name').value = '';
  G('inv-code').value = '';
  G('inv-category').value = 'renda_fixa';
  invUpdateTypes();
  G('inv-notes').value   = '';
  G('inv-broker').value  = '';
  G('inv-mat-m').value   = '';
  G('inv-mat-y').value   = '';
  if (G('inv-liq-venc'))  { G('inv-liq-venc').checked = true; }
  if (G('inv-liq-dias'))  { G('inv-liq-dias').checked = false; }
  if (G('inv-liq-days'))  { G('inv-liq-days').value = ''; G('inv-liq-days').disabled = true; }
  if (G('inv-liq-label')) { G('inv-liq-label').textContent = ''; }
  G('inv-sold-m').value   = '';
  G('inv-sold-y').value   = '';
  setupCurrencyInput(G('inv-sold-value'));
  G('inv-sold-value').setValue(null);
  G('inv-hidden').checked = false;
  if (G('inv-benchmark')) G('inv-benchmark').value = 'cdi';
  G('inv-asset-modal-title').textContent = id ? 'Editar investimento' : 'Novo investimento';
  await invLoadBrokers();

  if (id) {
    const a = _inv.assets.find(a => a.id === id);
    if (a) {
      G('inv-name').value     = a.name;
      G('inv-code').value     = a.code || '';
      G('inv-category').value = a.category;
      invUpdateTypes();
      G('inv-type').value     = a.inv_type;
      G('inv-notes').value    = a.notes || '';
      G('inv-broker').value   = a.broker || '';
      if (a.maturity_month) {
        const [my, mm] = a.maturity_month.split('-').map(Number);
        G('inv-mat-y').value = my; G('inv-mat-m').value = mm;
      }
      if (a.liquidity === 'dias' && G('inv-liq-dias')) {
        G('inv-liq-dias').checked = true;
        G('inv-liq-days').value = a.liquidity_days || '';
        G('inv-liq-days').disabled = false;
      }
      invUpdateLiqLabel();
      // Venda / saída
      if (a.closed_month) {
        const [sy, sm] = a.closed_month.split('-').map(Number);
        G('inv-sold-y').value = sy;
        G('inv-sold-m').value = sm;
      }
      if (a.hidden) G('inv-hidden').checked = true;
      if (G('inv-benchmark')) G('inv-benchmark').value = a.benchmark || 'cdi';
      const txs = await ff.invTxList({ assetId: id });
      // Pre-fill sold value from existing venda transaction
      const vendaTx = [...txs].reverse().find(t => t.tx_type === 'venda' && t.notes === 'Venda registrada na saída');
      if (vendaTx) G('inv-sold-value').setValue(vendaTx.total_value);
      renderInvHistoryTable(txs);
    }
  } else {
    G('inv-history-table').innerHTML = invHistoryRowHtml(
      `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`, null, null, null, 0
    );
  }
  openModal('modal-inv-asset');
}

async function invCloseAsset() {
  const id = parseInt(G('inv-asset-id').value);
  if (!id) return;
  // Find last month with data to use as close month
  const rows = G('inv-history-table')?.querySelectorAll('[data-month]') || [];
  const months = [...rows].map(r => r.dataset.month).sort();
  const closedMonth = months[months.length - 1] || null;
  if (!closedMonth) { toast('Adicione pelo menos um mês de dados antes de encerrar'); return; }
  if (!await showConfirmDialog(`Encerrar este ativo em ${fmtMonth(closedMonth)}?`, 'O ativo será marcado como encerrado nesta data.', 'Encerrar', true)) return;
  const a = _inv.assets.find(a => a.id === id);
  await ff.invAssetSave({ ...a, closed_month: closedMonth });
  toast(`✅ Ativo encerrado em ${fmtMonth(closedMonth)}`);
  closeModal('modal-inv-asset');
  await refreshInvestimentos();
  refreshPatrimonioTable();
}

async function saveInvAsset() {
  // Read ALL values from DOM FIRST
  const id       = G('inv-asset-id').value ? parseInt(G('inv-asset-id').value) : null;
  const name     = G('inv-name').value.trim();
  const code     = G('inv-code').value.trim() || null;
  const category = G('inv-category').value;
  const inv_type = G('inv-type').value;
  const notes    = G('inv-notes').value.trim() || null;
  const broker   = G('inv-broker').value.trim() || null;
  const matM     = parseInt(G('inv-mat-m')?.value);
  const matY     = parseInt(G('inv-mat-y')?.value);
  const maturity_month = (matM >= 1 && matM <= 12 && matY >= 2000) ? `${matY}-${String(matM).padStart(2,'0')}` : null;
  const isDias   = G('inv-liq-dias')?.checked;
  const liquidity      = isDias ? 'dias' : 'vencimento';
  const liquidity_days = isDias ? (parseInt(G('inv-liq-days')?.value) || null) : null;
  const soldM    = parseInt(G('inv-sold-m')?.value);
  const soldY    = parseInt(G('inv-sold-y')?.value);
  const invSoldEl = G('inv-sold-value'); const soldValue = invSoldEl?.rawValue ? (invSoldEl.rawValue()||null) : (parseFloat(invSoldEl?.value)||null);
  const closed_month = (soldM >= 1 && soldM <= 12 && soldY >= 2000) ? `${soldY}-${String(soldM).padStart(2,'0')}` : null;
  const hidden    = G('inv-hidden')?.checked ? 1 : 0;
  const benchmark = G('inv-benchmark')?.value || 'cdi';

  // Read all history rows before closing modal
  const rows = [...document.querySelectorAll('#inv-history-table [data-month]')].map(row => {
    const mo = row.querySelector('.inv-hist-mo')?.value;
    const yr = row.querySelector('.inv-hist-yr')?.value;
    const month = (mo && yr) ? `${yr}-${String(mo).padStart(2,'0')}` : row.dataset.month;
    return {
      month,
      valueStr:    row.querySelector('.inv-hist-value')?.value?.trim()    || '',
      externalStr: row.querySelector('.inv-hist-external')?.value?.trim() || '',
      incomeStr:   row.querySelector('.inv-hist-income')?.value?.trim()   || '',
      // Legacy: if old single-column format was in use, fall back to it
      cashStr:     row.querySelector('.inv-hist-cash')?.value?.trim()     || '',
    };
  }).filter(r => r.month);

  if (!name) { toast('Informe o nome do ativo'); return; }

  closeModal('modal-inv-asset');

  try {
    // 1. Save asset record
    const existing = id ? _inv.assets.find(a => a.id === id) : null;
    const result = await ff.invAssetSave({
      id, name, code, category, inv_type,
      sort_order:    existing?.sort_order ?? _inv.assets.length,
      closed_month,
      hidden,
      notes, broker, maturity_month, liquidity, liquidity_days, benchmark,
    });
    const assetId = result?.id;
    if (!assetId) throw new Error('Asset ID não retornado pelo servidor');

    // 2. Delete all existing transactions for this asset
    const existingTxs = await ff.invTxList({ assetId });
    for (const t of existingTxs) {
      await ff.invTxDelete({ id: t.id });
    }

    // 3. Save each row sequentially
    let savedRows = 0;
    for (const row of rows) {
      const { month, valueStr, externalStr, incomeStr, cashStr } = row;
      if (!month) continue;
      const value    = valueStr ? parseFloat(valueStr.replace(',','.')) : null;
      const external = externalStr ? evalFormula(externalStr) : null;
      const income   = incomeStr   ? evalFormula(incomeStr)   : null;
      // Legacy fallback: if only old cashStr is present, route by sign
      const legacyCash = (!externalStr && !incomeStr && cashStr) ? evalFormula(cashStr) : null;

      if (value != null && isFinite(value) && value > 0) {
        await ff.invTxSave({
          id: null, asset_id: assetId, month,
          tx_type: 'atualizacao', qty: null, unit_value: null, total_value: value, notes: null
        });
        savedRows++;
      }
      // External capital flow (compra if negative, venda if positive)
      if (external != null && external !== 0) {
        const txType = external < 0 ? 'compra' : 'venda';
        await ff.invTxSave({
          id: null, asset_id: assetId, month,
          tx_type: txType, qty: null, unit_value: null, total_value: Math.abs(external), notes: null
        });
        savedRows++;
      }
      // Income / cost flow (dividendo if positive, taxa if negative)
      if (income != null && income !== 0) {
        const txType = income > 0 ? 'dividendo' : 'taxa';
        await ff.invTxSave({
          id: null, asset_id: assetId, month,
          tx_type: txType, qty: null, unit_value: null, total_value: Math.abs(income), notes: null
        });
        savedRows++;
      }
      // Legacy single-column fallback
      if (legacyCash != null && legacyCash !== 0) {
        const txType = legacyCash < 0 ? 'compra' : 'dividendo';
        await ff.invTxSave({
          id: null, asset_id: assetId, month,
          tx_type: txType, qty: null, unit_value: null, total_value: Math.abs(legacyCash), notes: null
        });
        savedRows++;
      }
    }

    // 4. If a sale value was provided, insert venda transaction + zero valuation on closed_month
    if (soldValue != null && closed_month) {
      await ff.invTxSave({
        id: null, asset_id: assetId, month: closed_month,
        tx_type: 'venda', qty: null, unit_value: null, total_value: soldValue, notes: 'Venda registrada na saída'
      });
      // Zero out the asset value in the sale month so it shows 0, not negative
      await ff.invTxSave({
        id: null, asset_id: assetId, month: closed_month,
        tx_type: 'atualizacao', qty: null, unit_value: null, total_value: 0, notes: 'Zeragem na venda'
      });
      savedRows++;
    }

    // 5. Auto-insert purchase if no significant negative flow in first month
    const purchaseCheck = await ff.invEnsurePurchase({ assetId });
    if (purchaseCheck?.inserted) {
      console.log(`[auto-purchase] Inserted for asset ${assetId}: ${purchaseCheck.month} = ${purchaseCheck.value}`);
    }

    // 6. Full reload from DB then render
    await refreshPatrimonio();
    toast(`✅ Investimento ${id ? 'atualizado' : 'criado'} (${savedRows} registros)`);
  } catch(e) {
    toast(`❌ Erro ao salvar: ${e.message}`);
    console.error('saveInvAsset error:', e);
  }
}

// ── Detail modal ──
async function openInvDetail(assetId) {
  const a = _inv.assets.find(a => a.id === assetId);
  if (!a) return;
  const txs = await ff.invTxList({ assetId });
  G('inv-detail-title').textContent = `${a.name}${a.code ? ` (${a.code})` : ''}`;

  const cat = INV_CATEGORIES[a.category]?.label || a.category;
  const liqLabel = a.liquidity === 'dias'
    ? `D+${a.liquidity_days || 0} dias`
    : a.maturity_month ? `No vencimento (${fmtMonth(a.maturity_month)})` : 'No vencimento';
  let html = `<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px">
    <div><div style="font-size:11px;color:var(--text3)">Categoria</div><div style="font-size:13px">${cat}</div></div>
    <div><div style="font-size:11px;color:var(--text3)">Tipo</div><div style="font-size:13px">${a.inv_type}</div></div>
    <div><div style="font-size:11px;color:var(--text3)">Status</div><div style="font-size:13px">${a.closed_month?`Encerrado ${fmtMonth(a.closed_month)}`:'Ativo'}</div></div>
    ${a.broker?`<div><div style="font-size:11px;color:var(--text3)">Corretora</div><div style="font-size:13px">${esc(a.broker)}</div></div>`:''}
    ${a.maturity_month?`<div><div style="font-size:11px;color:var(--text3)">Vencimento</div><div style="font-size:13px">${fmtMonth(a.maturity_month)}</div></div>`:''}
    <div><div style="font-size:11px;color:var(--text3)">Liquidez</div><div style="font-size:13px">${liqLabel}</div></div>
    ${a.notes?`<div style="grid-column:1/-1"><div style="font-size:11px;color:var(--text3)">Notas</div><div style="font-size:13px">${esc(a.notes)}</div></div>`:''}
  </div>`;

  html += `<table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr style="border-bottom:2px solid var(--border2)">
      <th style="padding:6px 10px;text-align:left">Tipo</th>
      <th style="padding:6px 10px;text-align:left">Mês</th>
      <th style="padding:6px 10px;text-align:right">Qtd</th>
      <th style="padding:6px 10px;text-align:right">Valor unit.</th>
      <th style="padding:6px 10px;text-align:right">Total</th>
    </tr></thead><tbody>`;

  let totalFlow = 0;
  txs.forEach(t => {
    const sign = INV_TX_TYPES[t.tx_type]?.sign ?? 1;
    const signedTotal = sign * t.total_value;
    totalFlow += signedTotal;
    const label = INV_TX_TYPES[t.tx_type]?.label || t.tx_type;
    const cls = signedTotal >= 0 ? 'amt-inc' : 'amt-exp';
    html += `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:5px 10px">${label}</td>
      <td style="padding:5px 10px;color:var(--text2)">${fmtMonth(t.month)}</td>
      <td class="right" style="padding:5px 10px;color:var(--text2)">${t.qty ? t.qty.toLocaleString('pt-BR',{maximumFractionDigits:4}) : '—'}</td>
      <td class="right" style="padding:5px 10px;color:var(--text2)">${t.unit_value ? fmtBRL(t.unit_value) : '—'}</td>
      <td class="${cls} right" style="padding:5px 10px;font-family:'DM Mono',monospace">${fmtBRL(t.total_value)}</td>
    </tr>`;
  });

  const lclTotal = totalFlow >= 0 ? 'amt-inc' : 'amt-exp';
  html += `</tbody><tfoot><tr style="border-top:2px solid var(--border2);font-weight:700">
    <td colspan="4" style="padding:7px 10px">Resultado (entradas − saídas)</td>
    <td class="${lclTotal} right" style="padding:7px 10px;font-family:'DM Mono',monospace">${fmtBRL(totalFlow)}</td>
  </tr></tfoot></table>`;

  G('inv-detail-body').innerHTML = html;
  openModal('modal-inv-detail');
}

async function deleteInvAsset(id) {
  const a = _inv.assets.find(a => a.id === id);
  if (!await showConfirmDialog(`Excluir "${a?.name}"?`, 'Todas as movimentações serão removidas. Esta ação não pode ser desfeita.', 'Excluir', true)) return;
  await ff.invAssetDelete({ id });
  toast('Investimento removido');
  await refreshInvestimentos();
  refreshPatrimonioTable();
}

// ── IRR calculation (XIRR monthly → annual) ──
function calcIRR(cashflows) {
  // Newton-Raphson monthly IRR, then annualize
  if (!cashflows.length) return null;
  let rate = 0.01;
  for (let iter = 0; iter < 200; iter++) {
    let npv = 0, dnpv = 0;
    cashflows.forEach((cf, i) => {
      npv  += cf / Math.pow(1 + rate, i);
      dnpv -= i * cf / Math.pow(1 + rate, i + 1);
    });
    if (Math.abs(dnpv) < 1e-10) break;
    const newRate = rate - npv / dnpv;
    if (Math.abs(newRate - rate) < 1e-8) { rate = newRate; break; }
    rate = newRate;
  }
  if (!isFinite(rate) || rate <= -1) return null;
  return Math.pow(1 + rate, 12) - 1; // annualize
}

// ── Build inv rows for the patrimônio table ──
function buildInvRows(months, curM, STICKY, COL_W, stripe, showHidden) {
  if (!_inv.assets.length) return '';

  const showReal = _inv.showRealFlow;
  const visibleAssets = _inv.assets.filter(a => showHidden || !a.hidden);
  if (!visibleAssets.length) return '';

  // Group transactions by asset and month
  const txByAsset = {};
  _inv.txAll.forEach(t => {
    const tm = t.month.slice(0,7); // normalize YYYY-MM-DD → YYYY-MM
    if (!txByAsset[t.asset_id]) txByAsset[t.asset_id] = {};
    if (!txByAsset[t.asset_id][tm]) txByAsset[t.asset_id][tm] = [];
    txByAsset[t.asset_id][tm].push(t);
  });

  // IPCA cumulative from a month to curM
  function ipcaCumulative(fromMonth) {
    let cum = 1;
    let m = fromMonth;
    while (m < curM) {
      const [y, mo] = m.split('-').map(Number);
      const next = mo === 12 ? `${y+1}-01` : `${y}-${String(mo+1).padStart(2,'0')}`;
      const rate = _pat.ipcaMonthly[next] ?? 0;
      cum *= (1 + rate);
      m = next;
    }
    return cum;
  }

  const now = new Date();
  const nextM = (() => {
    const d = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  })();

  // Group visible assets by category (for rendering rows)
  const byCategory = {};
  visibleAssets.forEach(a => {
    const cat = a.category || 'renda_fixa';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(a);
  });
  // Group ALL assets by category (including hidden) — for correct subtotal P&L
  const byCategoryAll = {};
  _inv.assets.forEach(a => {
    const cat = a.category || 'renda_fixa';
    if (!byCategoryAll[cat]) byCategoryAll[cat] = [];
    byCategoryAll[cat].push(a);
  });
  const catKeys = INV_CAT_ORDER.filter(k => byCategory[k]);
  // Any unknown categories at the end
  Object.keys(byCategory).forEach(k => { if (!INV_CAT_ORDER.includes(k)) catKeys.push(k); });

  // Helper: build a category subtotal row (value + optional cash flow rows)
  function buildCatSubtotalRow(catKey, catAssets, allMonths, txByAsset2, curM2, STICKY2, COL_W2, stripe2, ipcaCumFn, showReal2, nextM2) {
    const catLabel = INV_CATEGORIES[catKey]?.label || catKey;
    const catTotalByMonth = {};
    const catNetCashByMonth = {};

    catAssets.forEach(a => {
      const txs = txByAsset2[a.id] || {};
      const txMonths = [...new Set(Object.keys(txs))].sort();
      if (!txMonths.length) return;

      let running2 = 0;
      const bv = {};
      txMonths.forEach(m2 => {
        let cd = 0, lv = null;
        (txs[m2] || []).forEach(t => {
          if (t.tx_type in INV_TX_CASH) {
            if (t.tx_type in INV_TX_EXTERNAL && INV_TX_EXTERNAL[t.tx_type].sign < 0) cd += t.total_value;
            if (['venda','amortizacao'].includes(t.tx_type)) cd -= t.total_value;
            const sign = INV_TX_CASH[t.tx_type]?.sign ?? 1;
            if (!catNetCashByMonth[m2]) catNetCashByMonth[m2] = 0;
            catNetCashByMonth[m2] += sign * t.total_value;
          } else if (t.tx_type in INV_TX_VALUATION) {
            lv = t.total_value;
          }
        });
        running2 += cd;
        if (lv !== null) running2 = lv;
        bv[m2] = running2;
      });

      let lastVal2 = 0;
      allMonths
        .filter(m2 => m2 >= txMonths[0] && m2 <= (a.closed_month || allMonths[allMonths.length-1]))
        .forEach(m2 => {
          if (bv[m2] !== undefined) lastVal2 = bv[m2];
          catTotalByMonth[m2] = (catTotalByMonth[m2] || 0) + lastVal2;
        });
    });

    const latestCatVal = catTotalByMonth[curM2] || 0;
    const hasCatCash = Object.keys(catNetCashByMonth).length > 0;

    // TIR for this category
    let catIrr = null;
    if (hasCatCash && latestCatVal > 0) {
      const irrMs = allMonths.filter(m2 => {
        const firstCashM = Object.keys(catNetCashByMonth).sort()[0];
        return m2 >= firstCashM;
      });
      const realFlows2 = irrMs.map(m2 => (catNetCashByMonth[m2] ?? 0) * ipcaCumFn(m2));
      realFlows2.push(latestCatVal);
      catIrr = calcIRR(realFlows2);
    }

    const irrLabel2 = catIrr !== null ? `TIR: ${(catIrr*100).toFixed(1)}% a.a.` : '';
    const irrColor2 = catIrr !== null ? (catIrr >= 0 ? '#16a34a' : '#dc2626') : 'var(--text3)';

    // Ganho/Perda por categoria: soma simples do fluxo nominal + valor atual
    const _catFlowSum = Object.values(catNetCashByMonth).reduce((s, v) => s + v, 0);
    const catGanho2 = Object.keys(catNetCashByMonth).length > 0 ? _catFlowSum + latestCatVal : null;
    const catGanhoLabel2 = catGanho2 !== null
      ? `${catGanho2 >= 0 ? '▲' : '▼'} ${fmtBRL(Math.abs(catGanho2))}`
      : '';
    const catGanhoColor2 = catGanho2 !== null ? (catGanho2 >= 0 ? '#16a34a' : '#dc2626') : 'var(--text3)';

    const BG_SUB = 'var(--bg4)';
    const valueCells2 = allMonths.map(m2 => {
      const v = catTotalByMonth[m2];
      const isCur = m2 === curM2;
      const cellBg = isCur ? 'var(--accent-lt)' : BG_SUB;
      if (!v) return `<td style="padding:5px 8px;background:${cellBg}"></td>`;
      return `<td class="amt-inc right" style="font-weight:600;font-size:12px;padding:5px 8px;background:${cellBg};font-family:'DM Mono',monospace">${fmtBRL(v)}</td>`;
    }).join('');

    const nomFlowCells2 = allMonths.map(m2 => {
      const cf = catNetCashByMonth[m2] ?? 0;
      const isCur = m2 === curM2;
      const cellBg = isCur ? 'var(--accent-lt)' : BG_SUB;
      if (!cf) return `<td class="right" style="font-size:11px;padding:3px 8px;background:${cellBg};color:var(--text3)">—</td>`;
      const cls = cf >= 0 ? 'amt-inc' : 'amt-exp';
      return `<td class="${cls} right" style="font-size:11px;padding:3px 8px;background:${cellBg};font-family:'DM Mono',monospace">${fmtBRL(cf)}</td>`;
    }).join('');

    const realFlowCells2 = allMonths.map(m2 => {
      const cf = catNetCashByMonth[m2] ?? 0;
      const isCur = m2 === curM2;
      const cellBg = isCur ? 'var(--accent-lt)' : BG_SUB;
      if (!cf) return `<td class="right" style="font-size:11px;padding:3px 8px;background:${cellBg};color:var(--text3)">—</td>`;
      const real = cf * ipcaCumFn(m2);
      const cls = real >= 0 ? 'amt-inc' : 'amt-exp';
      return `<td class="${cls} right" style="font-size:11px;padding:3px 8px;background:${cellBg};font-family:'DM Mono',monospace;font-style:italic">${fmtBRL(real)}</td>`;
    }).join('');

    const projVal2 = `<td style="min-width:0;max-width:0;padding:0;border:none;overflow:hidden"></td>`;
    const projNom2 = `<td style="min-width:0;max-width:0;padding:0;border:none;overflow:hidden"></td>`;
    const projReal2= `<td style="min-width:0;max-width:0;padding:0;border:none;overflow:hidden"></td>`;
    const editEmpty= `<td style="${STICKY2};right:0;min-width:60px;background:${BG_SUB}"></td>`;

    const _cgkSub = 'cat-' + catKey;
    const _isCollapsed = _pat.collapsed && _pat.collapsed[_cgkSub];
    const _toggleIcon = _isCollapsed ? '▶' : '▼';
    return `
      <tr style="background:${BG_SUB};border-top:2px solid var(--border2);cursor:pointer"
          onclick="patToggleCatCollapse('${_cgkSub}')">
        <td style="${STICKY2};left:0;min-width:350px;padding:7px 12px;background:${BG_SUB}" colspan="4">
          <span style="font-size:11px;color:var(--text3);margin-right:5px;user-select:none">${_toggleIcon}</span>
          <span style="font-size:12px;font-weight:700;color:var(--text1)">${catLabel}</span>
          ${irrLabel2 ? `<span style="font-size:11px;color:${irrColor2};margin-left:8px" title="${TIR_TOOLTIP}">${irrLabel2}</span>` : ''}
          ${catGanhoLabel2 ? `<span style="font-size:11px;font-weight:700;color:${catGanhoColor2};margin-left:6px" title="Ganho/Perda absoluto">${catGanhoLabel2}</span>` : ''}
        </td>
        ${valueCells2}${projVal2}${editEmpty}
      </tr>
      <tr style="background:${BG_SUB}">
        <td style="${STICKY2};left:0;font-size:10px;color:var(--text3);padding:2px 12px;background:${BG_SUB}" colspan="4">📊 Fluxo nominal</td>
        ${nomFlowCells2}${projNom2}${editEmpty}
      </tr>
      ${showReal2 ? `<tr style="background:${BG_SUB}">
        <td style="${STICKY2};left:0;font-size:10px;color:var(--text3);padding:2px 12px;background:${BG_SUB}" colspan="4">📈 Fluxo real (IPCA)</td>
        ${realFlowCells2}${projReal2}${editEmpty}
      </tr>` : ''}`;
  }

  let rows = '';
  let globalRi = 0; // global stripe index across all categories
  catKeys.forEach(catKey => {
    const catAssets = byCategory[catKey];
    catAssets.forEach(a => {
    const isCashAsset = a.category === 'valor_em_caixa' || a.category === 'caixa';
    const bg = stripe(globalRi);
    globalRi++;
    const cat = INV_CATEGORIES[a.category]?.label || a.category;
    const txs = txByAsset[a.id] || {};

    // Build cumulative book value and cash flows per month
    const monthlyNetCash  = {}; // all cash flows combined (for IRR/flow line)
    const monthlyExtFlow  = {}; // external capital only (compra/aporte/venda/amortizacao)
    const monthlyIncFlow  = {}; // income/cost only (dividendo/juros/taxa etc.)
    const bookValue       = {}; // cumulative asset value
    let running = 0;

    const txMonths = [...new Set(Object.keys(txs))].sort();

    txMonths.forEach(m => {
      // Step 1: apply cash transactions to running value
      let cashDelta = 0;
      let lastValuation = null;

      (txs[m] || []).forEach(t => {
        if (t.tx_type in INV_TX_EXTERNAL) {
          const sign = INV_TX_EXTERNAL[t.tx_type].sign;
          cashDelta += sign < 0 ? t.total_value : -t.total_value;
          if (!monthlyNetCash[m]) monthlyNetCash[m] = 0;
          monthlyNetCash[m] += sign * t.total_value;
          if (!monthlyExtFlow[m]) monthlyExtFlow[m] = 0;
          monthlyExtFlow[m] += sign * t.total_value;
        } else if (t.tx_type in INV_TX_INCOME) {
          const sign = INV_TX_INCOME[t.tx_type].sign;
          if (!monthlyNetCash[m]) monthlyNetCash[m] = 0;
          monthlyNetCash[m] += sign * t.total_value;
          if (!monthlyIncFlow[m]) monthlyIncFlow[m] = 0;
          monthlyIncFlow[m] += sign * t.total_value;
        } else if (t.tx_type in INV_TX_VALUATION) {
          lastValuation = t.total_value;
        }
      });

      // bookValue only comes from real valuations (atualizacao)
      // cashDelta does NOT contribute to displayed asset value
      if (lastValuation !== null) {
        running = lastValuation;
        bookValue[m] = running;
      }
    });

    // Propagate book value to all months up to curM
    const allM = months.filter(m => m >= (txMonths[0] || curM) && m <= (a.closed_month || curM));
    let lastVal = 0;
    allM.forEach(m => {
      if (bookValue[m] !== undefined) lastVal = bookValue[m];
      else bookValue[m] = lastVal;
    });

    // Latest value (for IRR projection)
    const latestVal = bookValue[curM] ?? lastVal;

    // Only compute IRR and P&L when there are actual cash flows
    const hasCashFlows = Object.keys(monthlyNetCash).length > 0;

    // Build IRR cashflow: sign convention — outflows negative
    // Use only months where the asset is active (from first tx to curM), no leading zeros
    let irr = null;      // real (IPCA-adjusted), shown as TIR label
    let irrNominal = null; // nominal, used for benchmark comparison and nomRetLabel
    if (hasCashFlows) {
      const firstM = txMonths[0];
      const activeMonths = months.filter(m => m >= firstM);
      // Real cashflows (IPCA-adjusted to curM)
      const realFlows = activeMonths.map(m => {
        const cf = monthlyNetCash[m] ?? 0;
        return cf * ipcaCumulative(m);
      });
      realFlows[realFlows.length - 1] += latestVal; // add current value at final period
      irr = calcIRR(realFlows);
      // Nominal cashflows (no IPCA adjustment)
      const nomFlows = activeMonths.map(m => monthlyNetCash[m] ?? 0);
      nomFlows[nomFlows.length - 1] += latestVal; // add current value at final period
      irrNominal = calcIRR(nomFlows);
    }
    const irrColor = (irr === null || isCashAsset) ? 'var(--text3)' : irr >= 0 ? '#16a34a' : '#dc2626';
    const irrLabel = isCashAsset ? '' : irr !== null ? `TIR: ${(irr*100).toFixed(1)}% a.a.` : 'TIR: —';

    // P&L = soma simples do fluxo nominal + valor atual (os sinais já estão corretos)
    let pnlLabel = '', pnlColor = 'var(--text3)';
    if (hasCashFlows) {
      const pnl = Object.values(monthlyNetCash).reduce((s, v) => s + v, 0) + latestVal;
      pnlLabel = pnl >= 0 ? `▲ ${fmtBRL(pnl)}` : `▼ ${fmtBRL(Math.abs(pnl))}`;
      pnlColor = pnl >= 0 ? '#16a34a' : '#dc2626';
    }

    // Benchmark label: compare nominal TIR vs CDI/IBOV (same nominal base)
    let bmkLabel = '';
    if (a.benchmark && a.benchmark !== 'nenhum' && irrNominal !== null && txMonths.length) {
      const bmkData = a.benchmark === 'ibov' ? _benchmarks.ibov : _benchmarks.cdi;
      const firstCashM = txMonths[0];
      // Accumulate monthly benchmark rates over the asset's active period
      const bmkRates = [];
      let bm = firstCashM;
      while (bm <= curM) {
        if (bmkData[bm] != null) bmkRates.push(bmkData[bm]);
        const [y, mo] = bm.split('-').map(Number);
        bm = mo === 12 ? `${y+1}-01` : `${y}-${String(mo+1).padStart(2,'0')}`;
      }
      if (bmkRates.length >= 1) {
        // Annualize from the average monthly rate (consistent with IRR annualization)
        const avgMonthlyRate = bmkRates.reduce((a, r) => a + r, 0) / bmkRates.length;
        const bmkAnn = Math.pow(1 + avgMonthlyRate, 12) - 1;
        const diff = irrNominal - bmkAnn;
        const sign = diff >= 0 ? '+' : '';
        const col  = diff >= 0 ? '#16a34a' : '#dc2626';
        const name = a.benchmark === 'ibov' ? 'IBOV' : 'CDI';
        bmkLabel = ` <span style="color:${col};font-size:10px">${sign}${(diff*100).toFixed(1)}% a.a. vs ${name}</span>`;
      }
    }

    // nomRetLabel: annualized nominal return (CAGR) shown next to "Fluxo nominal" row
    // Uses the already-computed nominal IRR for consistency
    function nomRetLabel(netCash, latVal, cM) {
      if (irrNominal === null) return '';
      const col = irrNominal >= 0 ? '#16a34a' : '#dc2626';
      const sign = irrNominal >= 0 ? '+' : '';
      return ` <span style="color:${col};font-size:9px">(${sign}${(irrNominal*100).toFixed(1)}% a.a. nominal)</span>`;
    }

    const nameCell = `<td style="${STICKY};left:0;min-width:200px;max-width:200px;font-size:12px;font-weight:500;padding:4px 12px;background:${bg};overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(a.name)}">
      <span style="cursor:pointer;color:var(--accent)" onclick="openInvDetail(${a.id})">${esc(a.name)}</span>
      <div style="display:flex;gap:8px;font-size:10px;margin-top:1px;flex-wrap:wrap">
        ${a.broker ? `<span style="color:var(--text3)">${esc(a.broker)}</span>` : ''}
        <span style="color:${pnlColor}">${pnlLabel}</span>
        <span style="color:${irrColor}" title="${TIR_TOOLTIP}">${irrLabel}</span>${bmkLabel}
      </div>
    </td>`;
    const codeCell  = `<td style="${STICKY};left:200px;min-width:80px;max-width:80px;font-size:11px;color:var(--text3);padding:4px 6px;background:${bg}">${esc(a.code||'—')}</td>`;
    const catCell   = `<td style="${STICKY};left:280px;min-width:90px;max-width:90px;font-size:11px;color:var(--text3);padding:4px 6px;background:${bg}">${cat}</td>`;
    const typeCell  = `<td style="${STICKY};left:370px;min-width:90px;max-width:90px;font-size:11px;color:var(--text3);padding:4px 6px;background:${bg}">${esc(a.inv_type)}</td>`;

    // Value row
    const valueCells = months.map(m => {
      const v = bookValue[m];
      const isCur = m === curM;
      const cellBg = isCur ? 'var(--accent-lt)' : bg;
      if (v === undefined || v === 0) return `<td class="right" style="font-size:12px;padding:4px 8px;background:${cellBg};color:var(--text3)">—</td>`;
      return `<td class="right" style="font-size:12px;padding:4px 8px;background:${cellBg};font-family:'DM Mono',monospace">${fmtBRL(v)}</td>`;
    }).join('');
    const projValueCell = `<td style="min-width:0;max-width:0;padding:0;border:none;overflow:hidden"></td>`;

    // Nominal flow row
    // External capital flow row
    const extFlowCells = months.map(m => {
      const cf = monthlyExtFlow[m] ?? 0;
      const isCur = m === curM;
      const cellBg = isCur ? 'var(--accent-lt)' : bg;
      if (!cf) return `<td class="right" style="font-size:11px;padding:3px 8px;background:${cellBg};color:var(--text3)">—</td>`;
      const cls = cf >= 0 ? 'amt-inc' : 'amt-exp';
      return `<td class="${cls} right" style="font-size:11px;padding:3px 8px;background:${cellBg};font-family:'DM Mono',monospace">${fmtBRL(cf)}</td>`;
    }).join('');

    // Income/cost flow row
    const incFlowCells = months.map(m => {
      const cf = monthlyIncFlow[m] ?? 0;
      const isCur = m === curM;
      const cellBg = isCur ? 'var(--accent-lt)' : bg;
      if (!cf) return `<td class="right" style="font-size:11px;padding:3px 8px;background:${cellBg};color:var(--text3)">—</td>`;
      const cls = cf >= 0 ? 'amt-inc' : 'amt-exp';
      return `<td class="${cls} right" style="font-size:11px;padding:3px 8px;background:${cellBg};font-family:'DM Mono',monospace">${fmtBRL(cf)}</td>`;
    }).join('');

    // Combined nominal flow cells (for total row — kept for IRR label)
    const nomFlowCells = months.map(m => {
      const cf = monthlyNetCash[m] ?? 0;
      const isCur = m === curM;
      const cellBg = isCur ? 'var(--accent-lt)' : bg;
      if (!cf) return `<td class="right" style="font-size:11px;padding:3px 8px;background:${cellBg};color:var(--text3)">—</td>`;
      const cls = cf >= 0 ? 'amt-inc' : 'amt-exp';
      return `<td class="${cls} right" style="font-size:11px;padding:3px 8px;background:${cellBg};font-family:'DM Mono',monospace">${fmtBRL(cf)}</td>`;
    }).join('');
    const projFlowCell = `<td style="min-width:0;max-width:0;padding:0;border:none;overflow:hidden"></td>`;

    // Real flow row (IPCA-adjusted, combined)
    const realFlowCells = months.map(m => {
      const cf = monthlyNetCash[m] ?? 0;
      const isCur = m === curM;
      const cellBg = isCur ? 'var(--accent-lt)' : bg;
      if (!cf) return `<td class="right" style="font-size:11px;padding:3px 8px;background:${cellBg};color:var(--text3)">—</td>`;
      const real = cf * ipcaCumulative(m);
      const cls = real >= 0 ? 'amt-inc' : 'amt-exp';
      return `<td class="${cls} right" style="font-size:11px;padding:3px 8px;background:${cellBg};font-family:'DM Mono',monospace;font-style:italic">${fmtBRL(real)}</td>`;
    }).join('');
    const projRealCell = `<td style="min-width:0;max-width:0;padding:0;border:none;overflow:hidden"></td>`;

    const editCell = `<td style="text-align:center;${STICKY};right:0;min-width:60px;background:${bg}">
      <button class="btn-icon" onclick="openInvAssetModal(${a.id})" title="Editar">✎</button>
      <button class="btn-icon" onclick="deleteInvAsset(${a.id})" style="color:var(--red)" title="Excluir">✕</button>
    </td>`;
    const editCellSub = `<td style="${STICKY};right:0;min-width:60px;background:${bg}"></td>`;

    const _cgk = 'cat-'+catKey;
    const _cgh = (_pat.collapsed && _pat.collapsed[_cgk]) ? 'display:none;' : '';
    rows += `
      <tr draggable="true" data-group="${_cgk}" style="background:${bg};height:36px;cursor:grab;${_cgh}"
        ondragstart="patDragStart(event,${a.id},'inv')"
        ondragend="patDragEnd(event)"
        ondragover="patDragOver(event,${a.id},'inv')"
        ondragleave="patDragLeave(event)"
        ondrop="patDrop(event,${a.id},'inv')">
        ${nameCell}${codeCell}${catCell}${typeCell}
        ${valueCells}${projValueCell}${editCell}
      </tr>
      <tr data-group="${_cgk}" style="background:${bg};${_cgh}">
        <td style="${STICKY};left:0;font-size:10px;color:var(--accent);padding:2px 12px;background:${bg}" colspan="4">📥 Aporte/Resgate</td>
        ${extFlowCells}${projFlowCell}${editCellSub}
      </tr>
      <tr data-group="${_cgk}" style="background:${bg};${_cgh}">
        <td style="${STICKY};left:0;font-size:10px;color:var(--green);padding:2px 12px;background:${bg}" colspan="4">💰 Rendimento/Custo${nomRetLabel(monthlyNetCash, latestVal, curM)}</td>
        ${incFlowCells}${projFlowCell}${editCellSub}
      </tr>
      ${showReal ? `<tr data-group="${_cgk}" style="background:${bg};${_cgh}">
        <td style="${STICKY};left:0;font-size:10px;color:var(--text3);padding:2px 12px;background:${bg}" colspan="4">📈 Fluxo real total (IPCA)</td>
        ${realFlowCells}${projRealCell}${editCellSub}
      </tr>` : ''}`;
    }); // end catAssets.forEach

    // Category subtotal row
    // Skip subtotal for cash categories
    if (!['caixa','valor_em_caixa'].includes(catKey)) {
      rows += buildCatSubtotalRow(catKey, byCategoryAll[catKey] || catAssets, months, txByAsset, curM, STICKY, COL_W, stripe, ipcaCumulative, showReal, nextM);
    }
  }); // end catKeys.forEach

  return rows;
}

function patToggleCatCollapse(cgk) {
  if (!_pat.collapsed) _pat.collapsed = {};
  _pat.collapsed[cgk] = !_pat.collapsed[cgk];
  // Toggle visibility of all rows with this data-group
  document.querySelectorAll(`tr[data-group="${cgk}"]`).forEach(row => {
    row.style.display = _pat.collapsed[cgk] ? 'none' : '';
  });
  // Update the toggle icon in the header row
  const headerTd = document.querySelector(`tr[onclick*="${cgk}"] td`);
  if (headerTd) {
    const iconSpan = headerTd.querySelector('span:first-child');
    if (iconSpan) iconSpan.textContent = _pat.collapsed[cgk] ? '▶' : '▼';
  }
}

// ── Total investimentos por mês (returns {totals, netCashByMonth}) ──
function calcInvTotalByMonth(months) {
  const totals          = {};
  const netCashByMonth  = {}; // all cash flows combined (for IRR)
  const extFlowByMonth  = {}; // external capital only (compra/aporte/venda/amortizacao)
  const incFlowByMonth  = {}; // income/cost only (dividendo/juros/taxa etc.)
  months.forEach(m => { totals[m] = 0; });

  const txByAsset = {};
  _inv.txAll.forEach(t => {
    const tm = t.month.slice(0,7);
    if (!txByAsset[t.asset_id]) txByAsset[t.asset_id] = {};
    if (!txByAsset[t.asset_id][tm]) txByAsset[t.asset_id][tm] = [];
    txByAsset[t.asset_id][tm].push(t);
  });

  _inv.assets.forEach(a => {
    // Exclude cash accounts from financial investment totals
    if (a.category === 'valor_em_caixa' || a.category === 'caixa') return;
    const txs = txByAsset[a.id] || {};
    const txMonths = [...new Set(Object.keys(txs))].sort();
    if (!txMonths.length) return;

    // Track asset value (from atualizacao only) and cash flows separately
    const valByM    = {}; // month -> asset value (from atualizacao)
    const cashDeltaByM = {}; // month -> net external cash delta

    txMonths.forEach(m => {
      let cashDelta = 0;
      (txs[m] || []).forEach(t => {
        if (t.tx_type in INV_TX_EXTERNAL) {
          const sign = INV_TX_EXTERNAL[t.tx_type].sign;
          cashDelta += sign < 0 ? t.total_value : -t.total_value;
          netCashByMonth[m] = (netCashByMonth[m] || 0) + sign * t.total_value;
          extFlowByMonth[m] = (extFlowByMonth[m] || 0) + sign * t.total_value;
        } else if (t.tx_type in INV_TX_INCOME) {
          const sign = INV_TX_INCOME[t.tx_type].sign;
          netCashByMonth[m] = (netCashByMonth[m] || 0) + sign * t.total_value;
          incFlowByMonth[m] = (incFlowByMonth[m] || 0) + sign * t.total_value;
        } else if (t.tx_type in INV_TX_VALUATION) {
          valByM[m] = t.total_value; // actual asset value — the only thing that goes into totals
        }
      });
      if (cashDelta !== 0) cashDeltaByM[m] = (cashDeltaByM[m] || 0) + cashDelta;
    });

    // totals: use only real valuations (atualizacao), carry forward the last known value
    // Never use cashDelta as a proxy for asset value — that distorts the portfolio total
    const valMonthsSorted = Object.keys(valByM).sort();
    if (!valMonthsSorted.length) return; // no valuations = don't include in portfolio total

    let lastVal = 0;
    months
      .filter(m => m >= valMonthsSorted[0] && m <= (a.closed_month || months[months.length-1]))
      .forEach(m => {
        if (valByM[m] !== undefined) lastVal = valByM[m];
        totals[m] += lastVal;
      });
  });
  return { totals, netCashByMonth, extFlowByMonth, incFlowByMonth };
}

// ══ APOSENTADORIA ══════════════════════════════════════════════════════════

const APOS_STORAGE_KEY = 'cruzeiro_apos_config';

let _aposView = 'table';
let _aposChart1 = null, _aposChart2 = null;
let _aposFocusData = null;

function aposSaveConfig() {
  const cfg = {
    goalType:   document.querySelector('input[name="apos-goal-type"]:checked')?.value || 'patrimonio',
    goalValue:  G('apos-goal-value')?.dataset.raw || '',
    ageNow:     G('apos-age-now')?.value || '',
    ageRet:     G('apos-age-ret')?.value || '',
    patAtual:   G('apos-patrimonio-atual')?.dataset.raw || '',
    rateReal:   G('apos-rate-real')?.value || '',
    rateInfl:   G('apos-rate-infl')?.value || '',

  };
  try { localStorage.setItem(APOS_STORAGE_KEY, JSON.stringify(cfg)); } catch(e) {}
}

function aposLoadConfig() {
  try {
    const cfg = JSON.parse(localStorage.getItem(APOS_STORAGE_KEY) || '{}');
    if (cfg.goalType) {
      const r = document.querySelector(`input[name="apos-goal-type"][value="${cfg.goalType}"]`);
      if (r) r.checked = true;
    }
    if (cfg.goalValue) {
      const inp = G('apos-goal-value');
      if (inp) { inp.value = parseFloat(cfg.goalValue).toLocaleString('pt-BR',{minimumFractionDigits:2}); inp.dataset.raw = cfg.goalValue; }
    }
    if (cfg.ageNow)   G('apos-age-now').value  = cfg.ageNow;
    if (cfg.ageRet)   G('apos-age-ret').value  = cfg.ageRet;
    if (cfg.patAtual) {
      const inp = G('apos-patrimonio-atual');
      if (inp) { inp.value = parseFloat(cfg.patAtual).toLocaleString('pt-BR',{minimumFractionDigits:2}); inp.dataset.raw = cfg.patAtual; }
    }
    if (cfg.rateReal) G('apos-rate-real').value = cfg.rateReal;
    if (cfg.rateInfl) G('apos-rate-infl').value = cfg.rateInfl;

  } catch(e) {}
}

function focusDate() {
  // Focus is published weekly (Fridays). Go back up to 14 days to find the last release.
  const d = new Date();
  d.setDate(d.getDate() - 3); // start 3 days ago
  return d.toISOString().slice(0,10);
}

// Fetch Focus BCB — tries multiple endpoints and date ranges
async function fetchFocusWithRetry(indicator) {
  const enc = encodeURIComponent;

  // Strategy 1: ExpectativasMercadoAnuais with date filter, going back up to 21 days
  const base = 'https://olinda.bcb.gov.br/olinda/servico/Expectativas/versao/v1/odata/';
  for (let daysBack = 2; daysBack <= 21; daysBack++) {
    const d = new Date();
    d.setDate(d.getDate() - daysBack);
    const date = d.toISOString().slice(0,10);
    try {
      const url = `${base}ExpectativaMercadoAnuais(Indicador=@I,Data=@D)?@I=${enc("'"+indicator+"'")}&@D=${enc("'"+date+"'")}&$top=1&$orderby=Data%20desc&$format=json&$select=Indicador,Data,Mediana`;
      const r = await fetch(url);
      if (!r.ok) continue;
      const data = await r.json();
      if (data?.value?.length > 0) return data;
    } catch(e) { continue; }
  }

  // Strategy 2: No date filter — just get the most recent entry
  try {
    const url = `${base}ExpectativaMercadoAnuais?$filter=Indicador%20eq%20'${enc(indicator)}'&$top=1&$orderby=Data%20desc&$format=json&$select=Indicador,Data,Mediana`;
    const r = await fetch(url);
    if (r.ok) {
      const data = await r.json();
      if (data?.value?.length > 0) return data;
    }
  } catch(e) {}

  return null;
}

async function aposUpdateFocus() {
  const hint = G('apos-focus-hint');
  if (hint) hint.textContent = '📡 Buscando Boletim Focus (BCB)…';
  try {
    // Try multiple dates going back to find the most recent Focus release
    const [d1, d2] = await Promise.all([
      fetchFocusWithRetry('IPCA'),
      fetchFocusWithRetry('Selic'),
    ]);
    const ipca  = parseFloat(d1?.value?.[0]?.Mediana);
    const selic = parseFloat(d2?.value?.[0]?.Mediana);
    if (!isNaN(ipca) && !isNaN(selic)) {
      _aposFocusData = { ipca, selic };
      const realRate = ((1 + selic/100) / (1 + ipca/100) - 1) * 100;
      if (hint) hint.textContent = `Focus BCB: Selic ${selic.toFixed(1)}% · IPCA ${ipca.toFixed(1)}% → retorno real estimado: ${realRate.toFixed(1)}% a.a.`;
      if (!G('apos-rate-real')?.value) G('apos-rate-real').value = Math.max(2, realRate - 2).toFixed(1);
      if (!G('apos-rate-infl')?.value) G('apos-rate-infl').value = ipca.toFixed(1);
      aposCalc();
    } else {
      if (hint) hint.textContent = 'Focus: sem dados disponíveis para a data solicitada';
    }
  } catch(e) {
    if (hint) hint.textContent = `Focus: erro — ${e.message}`;
  }
}

async function aposPullPatrimonio() {
  try {
    // Use the grand total from patrimônio tab if available (most accurate)
    let total = 0;
    if (window._patGrandTotal && typeof window._patGrandTotal.value === 'number' && window._patGrandTotal.value > 0) {
      total = window._patGrandTotal.value;
    } else {
      // Fallback: sum account balances
      total = accounts.reduce((s, a) => s + (a.balance || 0), 0);
    }
    const inp = G('apos-patrimonio-atual');
    if (inp) {
      inp.value = Math.max(0, total).toLocaleString('pt-BR',{minimumFractionDigits:2});
      inp.dataset.raw = Math.max(0, total).toString();
      aposCalc();
    }
  } catch(e) { toast('Erro ao buscar patrimônio: ' + e.message); }
}

function aposParseInput(id) {
  const el = G(id);
  if (!el) return 0;
  let v = el.value
    .replace(/R\$[ \s]*/g, '')  // remove "R$" and spaces/nbsp
    .trim();

  // Detect Brazilian format: if ends with ,dd (exactly 2 decimal digits after comma)
  // e.g. "20.000,00" → remove dots → "20000,00" → replace comma → "20000.00"
  if (/,\d{2}$/.test(v)) {
    v = v.replace(/\./g, '').replace(',', '.');
  } else {
    // Plain number or dot-as-decimal: remove any comma thousand-seps only
    v = v.replace(/,/g, '');
  }

  const parsed = parseFloat(v);
  return isNaN(parsed) ? 0 : parsed;
}

async function aposGetRealizedSavings() {
  const months = {};
  try {
    // report:monthly returns [{month, income, expenses}]
    const rows = await ff.reportMonthly({
      fromDate: '2000-01-01',
      toDate: new Date().toISOString().slice(0,10),
      excludeTransfers: true,
    });
    (rows || []).forEach(row => {
      if (row.month) months[row.month] = (row.income || 0) - (row.expenses || 0);
    });
  } catch(e) { console.error('aposGetRealizedSavings:', e); }
  return months;
}

async function aposCalc() {
  aposSaveConfig();

  const goalType = document.querySelector('input[name="apos-goal-type"]:checked')?.value || 'patrimonio';
  const goalRaw  = aposParseInput('apos-goal-value');
  const ageNow   = parseInt(G('apos-age-now')?.value  || '0');
  const ageRet   = parseInt(G('apos-age-ret')?.value  || '0');
  const patAtual = aposParseInput('apos-patrimonio-atual');
  const rateReal = (parseFloat(G('apos-rate-real')?.value) || 4) / 100;

  // Update labels
  const lbl = G('apos-goal-label');
  if (lbl) lbl.textContent = goalType === 'patrimonio' ? '💰 Patrimônio desejado (R$)' : '💸 Renda mensal desejada (R$)';
  const ghint = G('apos-goal-hint');
  if (ghint) ghint.textContent = goalType === 'patrimonio'
    ? 'Patrimônio líquido total a acumular (em R$ de hoje)'
    : 'Renda mensal sustentável em R$ de hoje (regra dos juros reais)';

  if (!goalRaw || !ageNow || !ageRet || ageRet <= ageNow) {
    const missing = [];
    if (!goalRaw) missing.push('meta');
    if (!ageNow)  missing.push('idade atual');
    if (!ageRet || ageRet <= ageNow) missing.push('idade na aposentadoria (maior que atual)');
    G('apos-kpis').innerHTML = `<div style="color:var(--text3);font-size:13px;padding:12px">Preencha: ${missing.join(', ')}.</div>`;
    if (G('apos-table-body')) G('apos-table-body').innerHTML = '';
    return;
  }

  // ── Meta em patrimônio ──────────────────────────────────────────────
  const metaPatrimonio = goalType === 'patrimonio'
    ? goalRaw
    : (goalRaw * 12) / Math.max(0.01, rateReal);

  const curYear    = new Date().getFullYear();
  const yearsTotal = ageRet - ageNow;
  const retYear    = curYear + yearsTotal;

  // ── Patrimônio real por ano (de _patTotalByMonth) ───────────────────
  // Exclude years that only have bank account data (no investments or fixed assets)
  // Those years show in _patTotalByMonth but inv+asset totals are zero
  const patByMonth = window._patTotalByMonth || {};
  const invByMonth  = window._invTotalByMonth  || {};   // populated by refreshInvTable
  const assetByMonth = window._assetTotalByMonth || {};  // populated by refreshInvTable

  const patByYear = {};
  Object.entries(patByMonth).forEach(([m, v]) => {
    const y = parseInt(m.slice(0,4));
    // Only include months where there's some investment or fixed asset data
    const hasNonBank = (invByMonth[m] || 0) + (assetByMonth[m] || 0) > 0;
    if (!hasNonBank) return;
    // Keep December if available, else last available month
    if (!patByYear[y] || m.slice(5,7) === '12') patByYear[y] = { val: v, month: m };
  });

  // ── Poupança realizada por ano (de _evMA12LucroByMonth) ─────────────
  // Read the IPCA-corrected MA12 lucro at December of each year
  const evMA12 = window._evMA12LucroByMonth || {};
  const savingsByYear = {};
  Object.entries(evMA12).forEach(([m, v]) => {
    const y = parseInt(m.slice(0,4));
    if (!savingsByYear[y] || m.slice(5,7) === '12') savingsByYear[y] = v;
  });

  // avgSavings: most recent year's December MA12 lucro (already IPCA-corrected)
  const pastYears = Object.keys(savingsByYear).map(Number).filter(y => y < curYear).sort((a,b)=>b-a);
  const avgSavings = pastYears.length ? savingsByYear[pastYears[0]] : 0;

  // ── PMT calculation ─────────────────────────────────────────────────
  // Find the MINIMUM monthly saving needed so that, saving exactly that amount each month
  // at rateReal, you reach metaPatrimonio exactly at retYear.
  // Formula: PMT = (FV - PV*(1+r)^n) * r / ((1+r)^n - 1)
  // where FV = metaPatrimonio, PV = patAtual, r = monthly real rate, n = months until retirement
  const rM     = Math.pow(1 + rateReal, 1/12) - 1;
  const n      = yearsTotal * 12;
  const pvGrown = patAtual * Math.pow(1 + rateReal, yearsTotal);
  const needPMT = pvGrown >= metaPatrimonio ? 0
    : (metaPatrimonio - pvGrown) * rM / (Math.pow(1 + rM, n) - 1);
  // FV of monthly PMT contributions over one year (monthly compounding)
  // = PMT * ((1+rM)^12 - 1) / rM
  const annuityPerYear = needPMT > 0 ? needPMT * (Math.pow(1 + rM, 12) - 1) / rM : 0;

  // ── Build table rows ─────────────────────────────────────────────────
  // Historical: start from first year with patrimônio data
  // Future: project forward from patAtual using needPMT (not avgSavings)
  const patHistYears = Object.keys(patByYear).map(Number).sort();
  const firstPatYear = patHistYears.length ? patHistYears[0] : curYear;

  const rows = [];
  let projPat = patAtual;

  for (let year = firstPatYear; year <= retYear; year++) {
    const age        = ageNow + (year - curYear);
    const isPast     = year < curYear;
    const isCur      = year === curYear;
    const isFuture   = year > curYear;
    const isRetired  = age >= ageRet;

    // Patrimônio real: only from patByYear (excludes bank-only years)
    const patRealVal  = patByYear[year]?.val ?? null;
    const patReal     = (isPast && patRealVal != null) ? patRealVal
                      : isCur ? patAtual : null;

    // Poupança realizada: December MA12 IPCA-corrected from Evolução
    const savingReal  = (isPast || isCur) ? (savingsByYear[year] ?? null) : null;

    // Poupança necessária: needPMT for future pre-retirement years
    const savingNeeded = (!isRetired && !isPast) ? needPMT : null;

    // For the retirement year: projPat currently holds value BEFORE final accumulation
    // The display value should be the final accumulated value
    // We pre-compute it for the retirement year display
    let projPatDisplay = projPat;
    if (age === ageRet && !isPast) {
      projPatDisplay = projPat * (1 + rateReal) + annuityPerYear;
    }

    const displayPat = patReal ?? (isFuture || isCur ? projPatDisplay : null);
    const pctMeta = displayPat != null ? displayPat / metaPatrimonio : null;

    rows.push({
      year, age, isPast, isCur, isFuture, isRetired,
      patReal,
      projPat: (isFuture || (isCur && patReal == null)) ? projPatDisplay : null,
      savingReal, savingNeeded, pctMeta,
    });

    // Advance projPat for next year
    if (isPast) {
      projPat = patRealVal != null ? patRealVal : projPat * (1 + rateReal) + annuityPerYear;
    } else if (!isRetired) {
      // Future pre-retirement: grow with monthly-compounded contributions
      projPat = projPat * (1 + rateReal) + annuityPerYear;
    } else if (age === ageRet) {
      // Retirement year: apply the final year of accumulation to land exactly on the goal
      projPat = projPat * (1 + rateReal) + annuityPerYear;
    } else {
      // Post-retirement: sustain with withdrawals
      projPat = projPat * (1 + rateReal) - metaPatrimonio * rateReal;
    }
  }

  renderAposKPIs({ needPMT, metaPatrimonio, goalType, goalRaw, rateReal, yearsTotal, pvGrown, avgSavings });
  if (_aposView === 'table') renderAposTable(rows);
  else renderAposCharts(rows, metaPatrimonio);
}


function renderAposKPIs({ needPMT, metaPatrimonio, goalType, goalRaw, rateReal, yearsTotal, pvGrown, avgSavings }) {
  const reached = pvGrown >= metaPatrimonio;
  const kpis = [
    { icon:'🎯', label: goalType==='patrimonio' ? 'Meta de patrimônio' : 'Patrimônio necessário',
      value: fmtBRL(metaPatrimonio),
      sub: goalType==='renda' ? `para sustentar renda de ${fmtBRL(goalRaw)}/mês` : '' },
    { icon:'📅', label:'Anos até a aposentadoria', value:`${yearsTotal} anos`, sub:'' },
    { icon:'💵', label:'Poupança mensal necessária',
      value: reached ? '🎉 Meta já alcançável!' : fmtBRL(needPMT)+'/mês',
      sub: reached ? 'Patrimônio atual já projeta superar a meta' : `retorno real ${(rateReal*100).toFixed(1)}% a.a.`,
      accent: !reached && needPMT > 0 },
    { icon:'💰', label:'Poupança média mensal (Evolução)',
      value: fmtBRL(avgSavings)+'/mês',
      sub: 'Média usada para projetar o futuro' },
  ];
  G('apos-kpis').innerHTML = kpis.map(k => `
    <div style="background:${k.accent?'var(--accent-lt)':'var(--bg2)'};border:1px solid ${k.accent?'var(--accent)':'var(--border)'};border-radius:10px;padding:14px 16px">
      <div style="font-size:22px;margin-bottom:4px">${k.icon}</div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:4px">${k.label}</div>
      <div style="font-size:15px;font-weight:700;color:${k.accent?'var(--accent)':'var(--text1)'}">${k.value}</div>
      ${k.sub?`<div style="font-size:11px;color:var(--text3);margin-top:2px">${k.sub}</div>`:''}
    </div>`).join('');
}

function renderAposTable(rows) {
  const tbody = G('apos-table-body');
  if (!tbody) return;

  // Update header — merged patrimônio column
  const thead = G('apos-table')?.querySelector('thead tr');
  if (thead) thead.innerHTML = `
    <th>Ano</th><th>Idade</th>
    <th class="right">Poupança realizada/mês<br><span style="font-size:10px;font-weight:400;color:var(--text3)">Média 12m Lucro (dez)</span></th>
    <th class="right">Poupança necessária/mês<br><span style="font-size:10px;font-weight:400;color:var(--text3)">anos futuros</span></th>
    <th class="right">Patrimônio real / projetado<br><span style="font-size:10px;font-weight:400;color:var(--text3)">real = dados históricos · projetado = futuro</span></th>
    <th class="right">% da meta</th>`;

  tbody.innerHTML = rows.map(r => {
    let rowStyle = r.isCur ? 'background:var(--bg3);font-weight:700'
                 : r.isPast ? 'opacity:0.75' : '';
    if (r.isRetired) rowStyle = 'background:rgba(37,99,235,0.06)';

    const pct      = r.pctMeta;
    const pctColor = pct>=1?'color:var(--green)' : pct>=0.75?'color:var(--accent)' : pct>=0.5?'color:#f59e0b':'color:var(--red)';
    const barW     = Math.min(80, Math.round(Math.min(pct,1)*80));
    const barClr   = pct>=1?'var(--green)':pct>=0.5?'var(--accent)':'var(--red)';
    const bar      = `<div style="display:inline-block;width:${barW}px;height:4px;background:${barClr};border-radius:2px;vertical-align:middle;margin-left:4px"></div>`;

    const yearLabel = `${r.year}${r.isRetired?' 🏖️':r.isCur?' ◀':''}`;
    const mono      = `font-family:'DM Mono',monospace`;

    // Poupança realizada (passado = média 12m dez; futuro = blank)
    const savReal = r.savingReal != null
      ? `<span class="${r.savingReal>=0?'amt-inc':'amt-exp'}">${fmtBRL(r.savingReal)}</span>` : '—';

    // Poupança necessária (futuro apenas)
    const savNeed = r.savingNeeded != null ? fmtBRL(r.savingNeeded) : '—';

    // Patrimônio: real (passado/corrente) ou projetado (futuro) in same column
    let patCell;
    if (r.patReal != null) {
      patCell = fmtBRL(r.patReal); // historical real data
    } else if (r.projPat != null) {
      patCell = `<span style="color:var(--accent)">${fmtBRL(r.projPat)}</span>`; // projected
    } else {
      patCell = '—';
    }

    return `<tr style="${rowStyle}">
      <td style="font-size:12px;padding:5px 8px">${yearLabel}</td>
      <td style="font-size:12px;padding:5px 8px;text-align:center">${r.age}</td>
      <td class="right" style="font-size:12px;padding:5px 8px;${mono}">${savReal}</td>
      <td class="right" style="font-size:12px;padding:5px 8px;${mono}">${savNeed}</td>
      <td class="right" style="font-size:12px;padding:5px 8px;${mono}">${patCell}</td>
      <td class="right" style="font-size:12px;padding:5px 8px;${pctColor};font-weight:600">${(pct*100).toFixed(0)}%${bar}</td>
    </tr>`;
  }).join('');
}

function renderAposCharts(rows, metaPatrimonio) {
  // Chart 1 (patrimônio vs meta): start only from first year with real patrimônio data
  const firstPatIdx = rows.findIndex(r => r.patReal != null);
  const patRows  = firstPatIdx >= 0 ? rows.slice(firstPatIdx) : rows;

  // Chart 2 (savings): use all rows that have either savingReal or savingNeeded
  const savRows  = rows.filter(r => r.savingReal != null || r.savingNeeded != null);

  const labels   = patRows.map(r => r.year.toString());
  const patReal  = patRows.map(r => r.patReal  != null ? Math.round(r.patReal)  : null);
  const patProj  = patRows.map(r => r.projPat  != null ? Math.round(r.projPat)  : null);
  const metaLine = patRows.map(() => Math.round(metaPatrimonio));
  const poupNec  = patRows.map(r => r.savingNeeded != null ? Math.round(r.savingNeeded) : null);
  const poupReal = patRows.map(r => r.savingReal   != null ? Math.round(r.savingReal)   : null);

  if (_aposChart1) { try{_aposChart1.destroy();}catch(e){} _aposChart1=null; }
  if (_aposChart2) { try{_aposChart2.destroy();}catch(e){} _aposChart2=null; }

  const fmtY = v => v==null?'':('R$'+(Math.abs(v)>=1e6?(v/1e6).toFixed(1)+'M':Math.abs(v)>=1e3?(v/1e3).toFixed(0)+'k':v));

  const ctx1 = G('apos-chart')?.getContext('2d');
  if (ctx1) _aposChart1 = new Chart(ctx1, {
    type: 'line',
    data: { labels, datasets: [
      { label:'Patrimônio real', data:patReal, borderColor:'#2563eb', backgroundColor:'rgba(37,99,235,.1)',
        fill:true, tension:0.3, borderWidth:2.5, pointRadius:3, spanGaps:false },
      { label:'Patrimônio projetado', data:patProj, borderColor:'#2563eb', borderDash:[5,4],
        backgroundColor:'rgba(37,99,235,.04)', fill:true, tension:0.3, borderWidth:2, pointRadius:2, spanGaps:false },
      { label:'Meta', data:metaLine, borderColor:'#dc2626', borderDash:[6,3],
        borderWidth:2, pointRadius:0, fill:false },
    ]},
    options: { responsive:true,
      plugins:{ legend:{position:'top'}, title:{display:true,text:'Patrimônio real e projetado vs meta'} },
      scales:{ y:{ ticks:{ callback:fmtY } } } }
  });

  const ctx2 = G('apos-chart2')?.getContext('2d');
  if (ctx2) _aposChart2 = new Chart(ctx2, {
    type: 'bar',
    data: { labels, datasets: [
      { label:'Necessária/mês', data:poupNec, backgroundColor:'rgba(37,99,235,.4)',
        borderColor:'#2563eb', borderWidth:1 },
      { label:'Realizada/mês (Média 12m)', data:poupReal, type:'line',
        borderColor:'#16a34a', backgroundColor:'rgba(22,163,74,.15)',
        tension:0.3, pointRadius:4, fill:false, borderWidth:2.5, spanGaps:false },
    ]},
    options: { responsive:true,
      plugins:{ legend:{position:'top'}, title:{display:true,text:'Poupança mensal: necessária vs realizada'} },
      scales:{ y:{ ticks:{ callback:v=>'R$'+(Math.abs(v)>=1e3?(v/1e3).toFixed(0)+'k':v) } } } }
  });
}

function aposTglView(view) {
  _aposView = view;
  G('apos-table-view').style.display = view==='table' ? '' : 'none';
  G('apos-chart-view').style.display = view==='chart' ? '' : 'none';
  G('apos-view-table').style.cssText += `;border-color:${view==='table'?'var(--accent)':'var(--border)'};color:${view==='table'?'var(--accent)':'var(--text2)'}`;
  G('apos-view-chart').style.cssText += `;border-color:${view==='chart'?'var(--accent)':'var(--border)'};color:${view==='chart'?'var(--accent)':'var(--text2)'}`;
  aposCalc();
}

// Compute IPCA-corrected MA12 lucro without any DOM changes (used by Aposentadoria tab)
async function computeEvMA12LucroData() {
  try {
    const { byCatFull } = await getEvolucaoData();
    const now2 = new Date();
    const curM2 = `${now2.getFullYear()}-${String(now2.getMonth()+1).padStart(2,'0')}`;
    const allMonths = [...new Set(Object.keys(byCatFull))].filter(m => m <= curM2).sort();
    if (!allMonths.length) return;

    // Determine IPCA ref year (same logic as refreshEvolucao)
    const ipcaYears = Object.keys(_ev.ipca||{}).map(Number).filter(y => y < now2.getFullYear()).sort((a,b)=>a-b);
    const refYear   = ipcaYears.length ? ipcaYears[ipcaYears.length-1] : null;
    const useIPCA   = G('ev-ipca')?.checked !== false;
    const corr = (v, m) => useIPCA && refYear ? inflateMonth(v, m, refYear) : (v || 0);

    const allSummary = computeSummaryFromByCat(allMonths, byCatFull);
    const allInc = allMonths.map(m => corr(allSummary[m]?.income   || 0, m));
    const allExp = allMonths.map(m => corr(allSummary[m]?.expenses || 0, m));
    const allLuc = allInc.map((v, i) => v - allExp[i]);
    const allMA12 = allMonths.map((_, i) => movAvg12(allLuc, i));

    window._evMA12LucroByMonth = {};
    allMonths.forEach((m, i) => { window._evMA12LucroByMonth[m] = allMA12[i]; });
  } catch(e) { console.error('computeEvMA12LucroData:', e); }
}

async function aposInit() {
  aposLoadConfig();
  // Ensure patrimônio tab data is loaded so _patTotalByMonth is available
  if (!window._patTotalByMonth || Object.keys(window._patTotalByMonth).length === 0) {
    try { await refreshPatrimonio(); } catch(e) {}
  }
  // Ensure evolução IPCA-corrected MA12 data is available (data-only, no DOM changes)
  if (!window._evMA12LucroByMonth || Object.keys(window._evMA12LucroByMonth).length === 0) {
    try { await computeEvMA12LucroData(); } catch(e) {}
  }
  aposCalc();
  // Also update Focus in background
  if (!_aposFocusData) aposUpdateFocus().catch(() => {});
}

// ══ ACCOUNT CHART ══════════════════════════════════════════════════════════

let _acctView = 'table';   // 'table' | 'chart'
let _acctChart = null;

function acctSetView(view) {
  _acctView = view;
  const tableView = G('acct-table-view');
  const chartView = G('acct-chart-view');
  const btnTable  = G('acct-view-table');
  const btnChart  = G('acct-view-chart');
  if (!tableView || !chartView) return;

  tableView.style.display = view === 'table' ? '' : 'none';
  chartView.style.display = view === 'chart' ? '' : 'none';

  if (btnTable) {
    btnTable.style.background = view === 'table' ? 'var(--accent)' : 'var(--bg2)';
    btnTable.style.color      = view === 'table' ? '#fff' : 'var(--text2)';
  }
  if (btnChart) {
    btnChart.style.background = view === 'chart' ? 'var(--accent)' : 'var(--bg2)';
    btnChart.style.color      = view === 'chart' ? '#fff' : 'var(--text2)';
  }

  if (view === 'chart') refreshAccountChart();
}

async function refreshAccountChart() {
  if (!currentAccountId) return;
  const canvas = G('acct-chart-canvas');
  if (!canvas) return;

  const acc = accounts.find(a => a.id === currentAccountId);
  const projMonths     = parseInt(G('acct-proj-months')?.value || '3');
  const inclRecurring  = G('acct-proj-recurring')?.checked !== false;
  const inclFuture     = G('acct-proj-future')?.checked !== false;

  // Fetch all transactions for this account (no date limit for chart)
  const allTxs = await ff.listTx({ accountId: currentAccountId, sortBy: 'date', order: 'asc' });

  const today = new Date();
  today.setHours(0,0,0,0);
  const todayStr2 = today.toISOString().slice(0,10);

  // Build daily balance series from all past transactions
  const dailyBalance = {};
  let running = 0;

  // Sort all transactions chronologically
  const sorted = [...allTxs].sort((a,b) => a.date.localeCompare(b.date) || a.id - b.id);

  // Find earliest date
  const firstDate = sorted.length ? sorted[0].date : todayStr2;

  sorted.forEach(tx => {
    if (!inclFuture && tx.date > todayStr2) return;
    running += tx.amount;
    dailyBalance[tx.date] = running;
  });

  // Build series: one point per day from firstDate to today
  const seriesDates = [];
  const seriesVals  = [];
  let lastBal = 0;
  const start = new Date(firstDate);
  const end   = new Date(today);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().slice(0,10);
    if (dailyBalance[ds] !== undefined) lastBal = dailyBalance[ds];
    seriesDates.push(ds);
    seriesVals.push(parseFloat(lastBal.toFixed(2)));
  }

  // ── Projection ──
  const projDates = [];
  const projVals  = [];
  const projToday = new Date(today);

  if (projMonths > 0) {
    // Get recurring transactions for this account
    let recurringTxs = [];
    if (inclRecurring) {
      try {
        const allRecurring = await ff.listRecurring();
        recurringTxs = (allRecurring || []).filter(r => r.account_id === currentAccountId && !r.paused);
      } catch(e) {}
    }

    // Get already-scheduled future transactions (date > today)
    const futureTxs = inclFuture
      ? sorted.filter(t => t.date > todayStr2)
      : [];

    const projEndDate = new Date(today);
    projEndDate.setMonth(projEndDate.getMonth() + projMonths);

    // Build projection day by day
    let projBal = lastBal;
    const projDailyDelta = {};

    // Add future scheduled transactions
    futureTxs.forEach(tx => {
      projDailyDelta[tx.date] = (projDailyDelta[tx.date] || 0) + tx.amount;
    });

    // Add recurring projections
    if (inclRecurring) {
      recurringTxs.forEach(rec => {
        const freqDays = {
          'daily': 1, 'weekly': 7, 'biweekly': 14, 'monthly': null, 'annual': null
        }[rec.frequency];

        let cur = new Date(Math.max(new Date(rec.next_date), today));
        const endRec = rec.end_date ? new Date(rec.end_date) : projEndDate;

        while (cur <= projEndDate && cur <= endRec) {
          const ds = cur.toISOString().slice(0,10);
          if (ds > todayStr2) {
            projDailyDelta[ds] = (projDailyDelta[ds] || 0) + rec.amount;
          }
          if (freqDays) {
            cur.setDate(cur.getDate() + freqDays);
          } else if (rec.frequency === 'monthly') {
            cur.setMonth(cur.getMonth() + 1);
          } else if (rec.frequency === 'annual') {
            cur.setFullYear(cur.getFullYear() + 1);
          } else {
            break;
          }
        }
      });
    }

    for (let d = new Date(today); d <= projEndDate; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().slice(0,10);
      projBal += projDailyDelta[ds] || 0;
      projDates.push(ds);
      projVals.push(parseFloat(projBal.toFixed(2)));
    }
  }

  // ── Downsample to weekly points for readability ──
  function downsample(dates, vals, maxPoints = 200) {
    if (dates.length <= maxPoints) return { dates, vals };
    const step = Math.ceil(dates.length / maxPoints);
    const od = [], ov = [];
    for (let i = 0; i < dates.length; i += step) {
      od.push(dates[i]); ov.push(vals[i]);
    }
    // Always include last point
    if (od[od.length-1] !== dates[dates.length-1]) {
      od.push(dates[dates.length-1]); ov.push(vals[vals.length-1]);
    }
    return { dates: od, vals: ov };
  }

  const hist = downsample(seriesDates, seriesVals);
  const proj = downsample(projDates, projVals);

  // ── Chart ──
  if (_acctChart) { try { _acctChart.destroy(); } catch(e) {} _acctChart = null; }

  const allLabels = [...hist.dates, ...proj.dates.slice(1)];
  const histData  = [...hist.vals, ...Array(proj.dates.length > 1 ? proj.dates.length - 1 : 0).fill(null)];
  const projData  = [...Array(hist.dates.length - 1).fill(null), hist.vals[hist.vals.length-1], ...proj.vals.slice(1)];

  const currentBal = seriesVals[seriesVals.length - 1] || 0;
  const zeroLine   = allLabels.map(() => 0);

  const ctx = canvas.getContext('2d');
  _acctChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: allLabels,
      datasets: [
        {
          label: 'Saldo histórico',
          data: histData,
          borderColor: currentBal >= 0 ? '#2563eb' : '#dc2626',
          backgroundColor: currentBal >= 0 ? 'rgba(37,99,235,0.08)' : 'rgba(220,38,38,0.08)',
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: true,
          tension: 0.2,
        },
        ...(projMonths > 0 ? [{
          label: `Projeção (+${projMonths}m)`,
          data: projData,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,0.06)',
          borderWidth: 2,
          borderDash: [6, 4],
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: true,
          tension: 0.2,
        }] : []),
        {
          label: 'Zero',
          data: zeroLine,
          borderColor: 'rgba(100,100,100,0.3)',
          borderWidth: 1,
          borderDash: [2, 2],
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => {
              const d = new Date(items[0].label + 'T12:00:00');
              return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'short', year:'numeric' });
            },
            label: item => {
              if (item.dataset.label === 'Zero') return null;
              const v = item.raw;
              if (v === null) return null;
              return `${item.dataset.label}: ${fmtBRL(v)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 10,
            callback: function(val, idx) {
              const label = this.getLabelForValue(val);
              const d = new Date(label + 'T12:00:00');
              return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'short' });
            },
            font: { size: 10 },
          },
          grid: { color: 'rgba(128,128,128,0.1)' },
        },
        y: {
          ticks: {
            callback: v => {
              if (Math.abs(v) >= 1e6) return 'R$' + (v/1e6).toFixed(1) + 'M';
              if (Math.abs(v) >= 1e3) return 'R$' + (v/1e3).toFixed(0) + 'k';
              return 'R$' + v.toFixed(0);
            },
            font: { size: 10 },
          },
          grid: { color: 'rgba(128,128,128,0.1)' },
        },
      },
    },
  });

  // Legend
  const legend = G('acct-chart-legend');
  if (legend) {
    const endProj = projVals[projVals.length - 1];
    const diff    = projMonths > 0 ? endProj - currentBal : null;
    legend.innerHTML = [
      `<span>● Saldo atual: <strong>${fmtBRL(currentBal)}</strong></span>`,
      projMonths > 0 && diff !== null
        ? `<span>◆ Projeção em ${projMonths}m: <strong class="${diff>=0?'amt-inc':'amt-exp'}">${fmtBRL(endProj)}</strong> (${diff>=0?'+':''}${fmtBRL(diff)})</span>`
        : '',
      seriesDates.length > 0
        ? `<span style="color:var(--text3)">${seriesDates[0]} → ${seriesDates[seriesDates.length-1]}</span>`
        : '',
    ].filter(Boolean).join('  ·  ');
  }
}

// ══ LICENSING ══════════════════════════════════════════════════════════════

let _licStatus = null;

async function checkLicense() {
  try {
    _licStatus = await ff.licenseStatus();
  } catch(e) {
    _licStatus = { status: 'trial', daysLeft: 999 };
  }

  const modal = G('modal-license');
  if (!modal) return;

  const { status, reason, daysLeft, avgIncome, avgExpense, totalWealth } = _licStatus;

  // Update UI sections
  G('lic-trial-banner').style.display    = status === 'trial'           ? '' : 'none';
  G('lic-social-banner').style.display   = status === 'free_social'     ? '' : 'none';
  G('lic-payment-section').style.display = status === 'payment_required'? '' : 'none';
  G('lic-licensed-section').style.display= status === 'licensed'        ? '' : 'none';

  if (status === 'trial') {
    G('lic-trial-days').textContent = `${daysLeft} dias restantes do período gratuito de 6 meses.`;
  }
  if (status === 'payment_required') {
    G('lic-payment-reason').textContent = reason;
  }
  if (status === 'licensed') {
    const s = await ff.settingsGet().catch(()=>({}));
    G('lic-licensed-email').textContent = `Email: ${s.licenseEmail || '—'}`;
  }

  G('lic-message').innerHTML = '';

  // payment_required: show a persistent non-blocking banner (modal still accessible via Settings)
  // Do NOT block navigation — only block transaction creation (enforced in saveTx/import)
  const payBanner = G('lic-payment-banner');
  if (payBanner) payBanner.style.display = status === 'payment_required' ? '' : 'none';

  // Show modal non-blockingly on first visit or trial nearing end
  if (status === 'trial' && daysLeft <= 30) {
    G('lic-continue-btn').style.display = '';
    modal.style.display = 'flex'; modal.classList.add('open');
  }
}

async function licActivate() {
  const code  = G('lic-code-inp')?.value?.trim();
  const email = G('lic-email-inp')?.value?.trim();
  const errEl = G('lic-error');
  if (!code || !email) { errEl.textContent = 'Preencha email e código.'; return; }
  try {
    const r = await ff.licenseActivate(code, email);
    if (r.ok) {
      toast('✅ Licença ativada com sucesso!');
      await checkLicense();
      closeModal('modal-license');
    } else {
      errEl.textContent = r.error || 'Código inválido.';
    }
  } catch(e) { errEl.textContent = 'Erro ao verificar código.'; }
}

async function licDeactivate() {
  if (!await showConfirmDialog('Remover licença?', 'O app voltará ao período de avaliação.', 'Remover', true)) return;
  await ff.licenseDeactivate();
  await checkLicense();
}

function licContinue() {
  const m = G('modal-license');
  if (m) { m.style.display = 'none'; m.classList.remove('open'); }
}

function licBuy() {
  // Replace with your actual purchase URL when available
  require('electron').shell.openExternal('https://cruzeiro.app/comprar');
}

function showLicenseModal() { openLicenseModal(); } // alias used by payment banner
function openLicenseModal() {
  checkLicense().then(() => {
    const _lm = G('modal-license');
    if (_lm) { _lm.style.display = 'flex'; _lm.classList.add('open'); }
  });
}

// ══ DATA EXPORT ════════════════════════════════════════════════════════════

async function exportData() {
  try {
    const result = await ff.exportData();
    if (!result?.ok) { toast('Erro ao exportar dados'); return; }

    // Build export object
    const exportObj = {
      exportVersion: 1,
      exportDate: new Date().toISOString(),
      appVersion: '4.0',
      data: result.data,
    };

    // Trigger download via hidden link
    const json = JSON.stringify(exportObj, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href     = url;
    a.download = `cruzeiro-export-${date}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`✅ Exportado: cruzeiro-export-${date}.json`);
  } catch(e) {
    toast('Erro ao exportar: ' + e.message);
  }
}

async function exportCSV() {
  try {
    const result = await ff.exportData();
    if (!result?.ok) return;

    const txs = result.data.transactions || [];
    const header = ['Data', 'Conta', 'Categoria', 'Memorando', 'Valor', 'Conferido', 'Transferência'];
    const rows = txs.map(t => [
      t.date, t.account_name || '', t.category || '',
      (t.memo || '').replace(/,/g, ';'),
      t.amount.toFixed(2).replace('.', ','),
      t.cleared ? 'Sim' : 'Não',
      t.transfer_id ? 'Sim' : 'Não',
    ]);

    const csv = [header, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }); // BOM for Excel
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href     = url;
    a.download = `cruzeiro-lancamentos-${date}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`✅ CSV exportado: cruzeiro-lancamentos-${date}.csv`);
  } catch(e) {
    toast('Erro ao exportar CSV: ' + e.message);
  }
}

async function exportQIF() {
  try {
    const result = await ff.exportData();
    if (!result?.ok) return;

    const txs  = result.data.transactions || [];
    const accs = result.data.accounts     || [];

    // Group transactions by account
    const byAccount = {};
    txs.forEach(t => {
      const key = t.account_name || String(t.account_id);
      if (!byAccount[key]) byAccount[key] = { type: t.account_type || 'Bank', txs: [] };
      byAccount[key].txs.push(t);
    });

    // QIF account type map
    const qifType = type => ({
      bank: 'Bank', credit: 'CCard', investment: 'Invst', cash: 'Cash'
    })[type] || 'Bank';

    let qif = '';
    Object.entries(byAccount).forEach(([accName, { type, txs: aTxs }]) => {
      qif += `!Account
N${accName}
T${qifType(type)}
^
`;
      qif += `!Type:${qifType(type)}
`;
      aTxs.sort((a, b) => a.date.localeCompare(b.date)).forEach(t => {
        // QIF date format: MM/DD/YYYY
        const [y, mo, d] = t.date.split('-');
        const qDate = `${mo}/${d}/${y}`;
        const amount = t.amount.toFixed(2);
        const cleared = t.cleared ? 'X' : '';
        qif += `D${qDate}
`;
        qif += `T${amount}
`;
        if (cleared) qif += `C${cleared}
`;
        if (t.memo)     qif += `M${t.memo}
`;
        if (t.category) qif += `L${t.category}
`;
        if (t.payee)    qif += `P${t.payee}
`;
        qif += `^
`;
      });
    });

    const blob = new Blob([qif], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href     = url;
    a.download = `cruzeiro-export-${date}.qif`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`✅ QIF exportado: cruzeiro-export-${date}.qif`);
  } catch(e) {
    toast('Erro ao exportar QIF: ' + e.message);
  }
}

// ══ INV TRANSACTION RECLASSIFY PANEL ═══════════════════════════════════════

async function openInvReclassifyPanel() {
  const assetId = parseInt(G('inv-asset-id')?.value);
  if (!assetId) { toast('Salve o ativo primeiro'); return; }

  const panel = G('inv-reclassify-panel');
  const list  = G('inv-reclassify-list');
  if (!panel || !list) return;

  panel.style.display = '';

  // Load all non-valuation transactions for this asset
  const txs = await ff.invTxList({ assetId });
  const cash = txs.filter(t => !(t.tx_type === 'atualizacao') && t.notes !== '__auto_purchase__');

  if (!cash.length) {
    list.innerHTML = '<div style="color:var(--text3);padding:8px">Nenhuma movimentação encontrada para este ativo.</div>';
    return;
  }

  const TYPE_LABELS = {
    compra: '🟢 Compra',      aporte: '➕ Aporte',
    venda:  '🔴 Venda',       amortizacao: '📉 Amortização',
    dividendo: '💰 Dividendo', juros: '💵 Juros',
    jcp: '🏦 JCP',            cupom: '🎫 Cupom',
    taxa: '📋 Taxa',
  };
  const IS_EXT = new Set(['compra','aporte','venda','amortizacao']);
  const IS_INC = new Set(['dividendo','juros','jcp','cupom','taxa']);

  // Group by month for display
  const byMonth = {};
  cash.forEach(t => {
    const m = t.month.slice(0,7);
    if (!byMonth[m]) byMonth[m] = [];
    byMonth[m].push(t);
  });

  list.innerHTML = Object.entries(byMonth).sort(([a],[b]) => a.localeCompare(b)).map(([m, txList]) => {
    const rows = txList.map(t => {
      const isExt = IS_EXT.has(t.tx_type);
      const isInc = IS_INC.has(t.tx_type);
      const currentColor = isExt ? 'var(--accent)' : isInc ? 'var(--green)' : 'var(--text3)';
      const label = TYPE_LABELS[t.tx_type] || t.tx_type;

      // Reclassify buttons — show the OTHER category's options
      const extOptions = ['compra','aporte','venda','amortizacao']
        .map(type => `<button class="btn xs" style="padding:1px 4px;font-size:9px;${t.tx_type===type?'background:var(--accent);color:#fff;':''}border-color:var(--accent);color:var(--accent)"
          onclick="invReclassifyTx(${t.id},'${type}',this)">${TYPE_LABELS[type]}</button>`)
        .join('');
      const incOptions = ['dividendo','juros','jcp','cupom','taxa']
        .map(type => `<button class="btn xs" style="padding:1px 4px;font-size:9px;${t.tx_type===type?'background:var(--green);color:#fff;':''}border-color:var(--green);color:var(--green)"
          onclick="invReclassifyTx(${t.id},'${type}',this)">${TYPE_LABELS[type]}</button>`)
        .join('');

      return `<div style="display:flex;align-items:flex-start;gap:6px;padding:5px 8px;border-bottom:1px solid var(--border);flex-wrap:wrap" id="inv-reclass-row-${t.id}">
        <span style="min-width:70px;color:${currentColor};font-weight:600">${label}</span>
        <span style="min-width:100px;font-family:'DM Mono',monospace;color:var(--text1)">${fmtBRL(t.total_value)}</span>
        <span style="color:var(--text3);font-size:10px;margin-right:4px">→</span>
        <div style="display:flex;gap:2px;flex-wrap:wrap">
          <span style="font-size:9px;color:var(--accent);align-self:center;margin-right:2px">📥</span>${extOptions}
          <span style="font-size:9px;color:var(--green);align-self:center;margin-left:4px;margin-right:2px">💰</span>${incOptions}
        </div>
      </div>`;
    }).join('');

    return `<div style="background:var(--bg3);padding:4px 8px;font-size:10px;font-weight:700;color:var(--text3);border-bottom:1px solid var(--border)">${m}</div>${rows}`;
  }).join('');
}

async function invReclassifyTx(txId, newType, btnEl) {
  try {
    const r = await ff.invTxReclassify({ id: txId, new_tx_type: newType });
    if (!r.ok) { toast('Erro: ' + r.error); return; }

    // Update the row UI — highlight the active button
    const row = G(`inv-reclass-row-${txId}`);
    if (row) {
      const IS_EXT = new Set(['compra','aporte','venda','amortizacao']);
      const IS_INC = new Set(['dividendo','juros','jcp','cupom','taxa']);
      const color = IS_EXT.has(newType) ? 'var(--accent)' : IS_INC.has(newType) ? 'var(--green)' : 'var(--text3)';
      const TYPE_LABELS = { compra:'🟢 Compra', aporte:'➕ Aporte', venda:'🔴 Venda', amortizacao:'📉 Amortização',
        dividendo:'💰 Dividendo', juros:'💵 Juros', jcp:'🏦 JCP', cupom:'🎫 Cupom', taxa:'📋 Taxa' };
      row.querySelector('span').textContent = TYPE_LABELS[newType] || newType;
      row.querySelector('span').style.color = color;
      // Reset all buttons, highlight active
      row.querySelectorAll('button').forEach(b => {
        const bType = b.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
        if (bType === newType) {
          b.style.background = color; b.style.color = '#fff';
        } else {
          b.style.background = ''; b.style.color = '';
        }
      });
    }

    toast(`✅ Reclassificado para ${newType}`);

    // Reload inv data and refresh the patrimônio table
    await ff.invTxAll().then(txs => { _inv.txAll = txs; }).catch(() => {});
    if (currentPage === 'patrimonio') refreshPatrimonioTable();

  } catch(e) {
    toast('Erro ao reclassificar: ' + e.message);
  }
}
