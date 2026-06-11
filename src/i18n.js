// ══ Cruzeiro i18n — Internationalization ══
// Supported: pt (Portuguese), en (English), es (Spanish)

const TRANSLATIONS = {

  // ── Navigation ──
  nav_overview:     { pt:'Visão Geral',       en:'Overview',          es:'Resumen' },
  nav_reports:      { pt:'Relatórios',          en:'Reports',           es:'Informes' },
  nav_import:       { pt:'Importar',           en:'Import',            es:'Importar' },
  nav_search:       { pt:'Busca avançada',     en:'Advanced Search',   es:'Búsqueda avanzada' },
  nav_returns:      { pt:'Rentabilidade',      en:'Returns',           es:'Rentabilidad' },
  nav_goals:        { pt:'Metas',              en:'Goals',             es:'Metas' },
  nav_budget:       { pt:'Orçamento',          en:'Budget',            es:'Presupuesto' },
  nav_patrimonio:   { pt:'Patrimônio',         en:'Net Worth',         es:'Patrimonio' },
  nav_evolucao:     { pt:'Evolução',           en:'Evolution',         es:'Evolución' },
  nav_recurring:    { pt:'Recorrências',       en:'Recurring',         es:'Recurrentes' },
  nav_ml:           { pt:'Aprendizado ML',     en:'ML Learning',       es:'Aprendizaje ML' },
  nav_categories:   { pt:'Categorias',         en:'Categories',        es:'Categorías' },
  nav_backup:       { pt:'Configurações',      en:'Settings',          es:'Configuración' },

  // ── Common actions ──
  btn_save:         { pt:'Salvar',             en:'Save',              es:'Guardar' },
  btn_cancel:       { pt:'Cancelar',           en:'Cancel',            es:'Cancelar' },
  btn_delete:       { pt:'Excluir',            en:'Delete',            es:'Eliminar' },
  btn_edit:         { pt:'Editar',             en:'Edit',              es:'Editar' },
  btn_close:        { pt:'Fechar',             en:'Close',             es:'Cerrar' },
  btn_add:          { pt:'Adicionar',          en:'Add',               es:'Agregar' },
  btn_new:          { pt:'Novo',               en:'New',               es:'Nuevo' },
  btn_confirm:      { pt:'Confirmar',          en:'Confirm',           es:'Confirmar' },
  btn_import:       { pt:'Importar',           en:'Import',            es:'Importar' },
  btn_export:       { pt:'Exportar',           en:'Export',            es:'Exportar' },
  btn_back:         { pt:'Voltar',             en:'Back',              es:'Volver' },
  btn_next:         { pt:'Próximo',            en:'Next',              es:'Siguiente' },
  btn_finish:       { pt:'Concluir',           en:'Finish',            es:'Finalizar' },
  btn_update:       { pt:'Atualizar',          en:'Update',            es:'Actualizar' },

  // ── Page titles ──
  page_overview:    { pt:'Visão Geral',        en:'Overview',          es:'Resumen' },
  page_import:      { pt:'Importar',           en:'Import',            es:'Importar' },
  page_search:      { pt:'Busca avançada',     en:'Advanced Search',   es:'Búsqueda avanzada' },
  page_returns:     { pt:'Rentabilidade',      en:'Returns',           es:'Rentabilidad' },
  page_goals:       { pt:'Metas financeiras',  en:'Financial Goals',   es:'Metas financieras' },
  page_budget:      { pt:'Orçamento',          en:'Budget',            es:'Presupuesto' },
  page_patrimonio:  { pt:'Patrimônio',         en:'Net Worth',         es:'Patrimonio' },
  page_evolucao:    { pt:'Evolução',           en:'Evolution',         es:'Evolución' },
  page_recurring:   { pt:'Recorrências',       en:'Recurring',         es:'Recurrentes' },
  page_ml:          { pt:'Aprendizado ML',     en:'ML Learning',       es:'Aprendizaje ML' },
  page_categories:  { pt:'Categorias',         en:'Categories',        es:'Categorías' },
  page_backup:      { pt:'Configurações e Backup', en:'Settings & Backup', es:'Configuración y Backup' },

  // ── Transaction modal ──
  tx_new:           { pt:'Novo lançamento',    en:'New transaction',   es:'Nueva transacción' },
  tx_edit:          { pt:'Editar lançamento',  en:'Edit transaction',  es:'Editar transacción' },
  tx_account:       { pt:'Conta',              en:'Account',           es:'Cuenta' },
  tx_date:          { pt:'Data',               en:'Date',              es:'Fecha' },
  tx_memo:          { pt:'Memorando',          en:'Memo',              es:'Descripción' },
  tx_category:      { pt:'Categoria',          en:'Category',          es:'Categoría' },
  tx_expense:       { pt:'Despesa',            en:'Expense',           es:'Gasto' },
  tx_income:        { pt:'Receita',            en:'Income',            es:'Ingreso' },

  // ── Account types ──
  acc_checking:     { pt:'Conta corrente',     en:'Checking',          es:'Cuenta corriente' },
  acc_savings:      { pt:'Poupança',           en:'Savings',           es:'Ahorros' },
  acc_credit:       { pt:'Cartão de crédito',  en:'Credit card',       es:'Tarjeta de crédito' },
  acc_investment:   { pt:'Investimentos',      en:'Investments',       es:'Inversiones' },
  acc_cash:         { pt:'Dinheiro',           en:'Cash',              es:'Efectivo' },
  acc_other:        { pt:'Outro',              en:'Other',             es:'Otro' },

  // ── Transfer ──
  transfer_title:   { pt:'Transferência entre contas', en:'Transfer between accounts', es:'Transferencia entre cuentas' },
  transfer_from:    { pt:'De (origem)',         en:'From',              es:'De (origen)' },
  transfer_to:      { pt:'Para (destino)',      en:'To',                es:'A (destino)' },
  transfer_amount:  { pt:'Valor',              en:'Amount',            es:'Monto' },
  transfer_memo:    { pt:'Memorando (opcional)',en:'Memo (optional)',   es:'Descripción (opcional)' },
  transfer_save:    { pt:'Registrar',          en:'Register',          es:'Registrar' },

  // ── Import ──
  import_bank:      { pt:'Extrato bancário',   en:'Bank statement',    es:'Extracto bancario' },
  import_card:      { pt:'Fatura de cartão',   en:'Card statement',    es:'Estado de tarjeta' },
  import_broker:    { pt:'Extrato de corretora',en:'Broker statement', es:'Estado de corredora' },
  import_other:     { pt:'Outro banco…',       en:'Other bank…',       es:'Otro banco…' },
  import_dest:      { pt:'Conta de destino',   en:'Destination account',es:'Cuenta destino' },
  import_from_date: { pt:'A partir de (opcional)',en:'From date (optional)',es:'Desde (opcional)' },
  import_select_file:{ pt:'Selecionar arquivo',en:'Select file',       es:'Seleccionar archivo' },
  import_confirm:   { pt:'✓ Confirmar importação', en:'✓ Confirm import', es:'✓ Confirmar importación' },

  // ── Search ──
  search_placeholder:{ pt:'Buscar em memo, categoria, valor…', en:'Search memo, category, amount…', es:'Buscar en memo, categoría, monto…' },
  search_all_accounts:{ pt:'Todas as contas',  en:'All accounts',      es:'Todas las cuentas' },
  search_type_all:  { pt:'Todos',              en:'All',               es:'Todos' },
  search_type_income:{ pt:'Receitas',          en:'Income',            es:'Ingresos' },
  search_type_expense:{ pt:'Despesas',         en:'Expenses',          es:'Gastos' },
  search_type_transfer:{ pt:'Transferências',  en:'Transfers',         es:'Transferencias' },
  search_cleared_all:{ pt:'Todos',             en:'All',               es:'Todos' },
  search_cleared_yes:{ pt:'✅ Conferidos',      en:'✅ Cleared',         es:'✅ Confirmados' },
  search_cleared_no: { pt:'○ Não conferidos',  en:'○ Uncleared',       es:'○ Sin confirmar' },
  search_no_results: { pt:'Nenhum resultado encontrado', en:'No results found', es:'Sin resultados' },
  search_use_filters:{ pt:'Use os filtros acima para buscar transações', en:'Use the filters above to search transactions', es:'Use los filtros para buscar transacciones' },

  // ── Budget ──
  budget_new:       { pt:'Nova meta',          en:'New budget',        es:'Nuevo presupuesto' },
  budget_category:  { pt:'Categoria',          en:'Category',          es:'Categoría' },
  budget_limit:     { pt:'Limite mensal (R$)', en:'Monthly limit',     es:'Límite mensual' },
  budget_alert:     { pt:'Alerta ao atingir (%)', en:'Alert threshold (%)', es:'Alerta al alcanzar (%)' },
  budget_total_budgeted: { pt:'Total orçado',  en:'Total budgeted',    es:'Total presupuestado' },
  budget_total_spent:    { pt:'Total gasto',   en:'Total spent',       es:'Total gastado' },
  budget_available:      { pt:'Saldo disponível', en:'Available balance', es:'Saldo disponible' },
  budget_over:           { pt:'Categorias acima do limite', en:'Over-budget categories', es:'Categorías sobre el límite' },

  // ── Goals ──
  goal_new:         { pt:'Nova meta financeira', en:'New financial goal', es:'Nueva meta financiera' },
  goal_name:        { pt:'Nome da meta',        en:'Goal name',         es:'Nombre de la meta' },
  goal_type_target: { pt:'💰 Valor-alvo (economizar X reais)', en:'💰 Target amount (save X)', es:'💰 Monto objetivo' },
  goal_type_monthly:{ pt:'📅 Economia mensal (poupar X por mês)', en:'📅 Monthly savings goal', es:'📅 Ahorro mensual' },
  goal_type_emergency:{ pt:'🛡️ Reserva de emergência (N meses de gastos)', en:'🛡️ Emergency fund (N months expenses)', es:'🛡️ Fondo de emergencia' },
  goal_account_linked:{ pt:'Conta vinculada (rastrear saldo)', en:'Linked account (track balance)', es:'Cuenta vinculada' },

  // ── Settings / Backup ──
  settings_language:{ pt:'Idioma / Language / Idioma', en:'Language', es:'Idioma' },
  settings_password:{ pt:'Senha',              en:'Password',          es:'Contraseña' },
  settings_set_password:{ pt:'Definir senha',  en:'Set password',      es:'Establecer contraseña' },
  settings_data_dir:{ pt:'Pasta de dados',     en:'Data directory',    es:'Carpeta de datos' },
  settings_backup:  { pt:'Backup',             en:'Backup',            es:'Backup' },
  settings_restore: { pt:'Restaurar',          en:'Restore',           es:'Restaurar' },
  settings_tour:    { pt:'Tour de boas-vindas',en:'Welcome tour',      es:'Tour de bienvenida' },
  settings_restart_tour:{ pt:'▶ Reiniciar tour', en:'▶ Restart tour',  es:'▶ Reiniciar tour' },

  // ── Context menu ──
  ctx_duplicate:    { pt:'📋 Duplicar transação', en:'📋 Duplicate transaction', es:'📋 Duplicar transacción' },
  ctx_duplicate_today:{ pt:'📋 Duplicar com data de hoje', en:'📋 Duplicate with today\'s date', es:'📋 Duplicar con fecha de hoy' },
  ctx_mark_cleared: { pt:'✅ Marcar como conferida', en:'✅ Mark as cleared', es:'✅ Marcar como confirmada' },
  ctx_unmark_cleared:{ pt:'○ Marcar como não conferida', en:'○ Mark as uncleared', es:'○ Marcar como no confirmada' },
  ctx_create_recurring:{ pt:'🔄 Criar recorrência', en:'🔄 Create recurring', es:'🔄 Crear recurrente' },
  ctx_delete:       { pt:'🗑 Excluir',          en:'🗑 Delete',          es:'🗑 Eliminar' },

  // ── Returns ──
  returns_update:   { pt:'🔄 Atualizar CDI/IBOV', en:'🔄 Update CDI/IBOV', es:'🔄 Actualizar CDI/IBOV' },
  returns_period:   { pt:'Evolução comparativa', en:'Comparative evolution', es:'Evolución comparativa' },
  returns_portfolio:{ pt:'Carteira',            en:'Portfolio',         es:'Cartera' },
  returns_annual:   { pt:'Carteira (a.a.)',      en:'Portfolio (p.a.)',  es:'Cartera (anual)' },
  returns_vs_cdi:   { pt:'vs CDI',              en:'vs CDI',            es:'vs CDI' },
  returns_asset:    { pt:'Ativo',               en:'Asset',             es:'Activo' },
  returns_current_value:{ pt:'Valor atual',     en:'Current value',     es:'Valor actual' },
  returns_invested: { pt:'Aporte total',        en:'Total invested',    es:'Total invertido' },
  returns_gain:     { pt:'Ganho/Perda',         en:'Gain/Loss',         es:'Ganancia/Pérdida' },
  returns_total_ret:{ pt:'Rent. total',         en:'Total return',      es:'Rendimiento total' },
  returns_ann_ret:  { pt:'Rent. a.a.',          en:'Annual return',     es:'Rendimiento anual' },

  // ── Misc ──
  lbl_month:        { pt:'Mês',                 en:'Month',             es:'Mes' },
  lbl_date:         { pt:'Data',                en:'Date',              es:'Fecha' },
  lbl_balance:      { pt:'Saldo',               en:'Balance',           es:'Saldo' },
  lbl_amount:       { pt:'Valor',               en:'Amount',            es:'Monto' },
  lbl_description:  { pt:'Descrição',           en:'Description',       es:'Descripción' },
  lbl_name:         { pt:'Nome',                en:'Name',              es:'Nombre' },
  lbl_type:         { pt:'Tipo',                en:'Type',              es:'Tipo' },
  lbl_status:       { pt:'Status',              en:'Status',            es:'Estado' },
  lbl_frequency:    { pt:'Frequência',          en:'Frequency',         es:'Frecuencia' },
  lbl_none:         { pt:'Nenhuma',             en:'None',              es:'Ninguna' },
  lbl_optional:     { pt:'(opcional)',           en:'(optional)',        es:'(opcional)' },
  lbl_loading:      { pt:'Carregando…',         en:'Loading…',          es:'Cargando…' },
  lbl_no_data:      { pt:'Sem dados',           en:'No data',           es:'Sin datos' },
  lbl_all:          { pt:'Todos',               en:'All',               es:'Todos' },
  freq_monthly:     { pt:'Mensal',              en:'Monthly',           es:'Mensual' },
  freq_weekly:      { pt:'Semanal',             en:'Weekly',            es:'Semanal' },
  freq_yearly:      { pt:'Anual',               en:'Annual',            es:'Anual' },
  freq_biweekly:    { pt:'Quinzenal',           en:'Biweekly',          es:'Quincenal' },

  // ── Tour ──
  tour_welcome_title:{ pt:'Bem-vindo ao Cruzeiro!', en:'Welcome to Cruzeiro!', es:'¡Bienvenido a Cruzeiro!' },
  tour_skip:        { pt:'Pular tour',          en:'Skip tour',         es:'Omitir tour' },
  tour_finish:      { pt:'✓ Concluir',          en:'✓ Finish',          es:'✓ Finalizar' },
  tour_step_of:     { pt:'Passo',               en:'Step',              es:'Paso' },
  tour_of:          { pt:'de',                  en:'of',                es:'de' },

  // ── Number/date formats ──
  fmt_currency:     { pt:'R$',                  en:'$',                 es:'$' },
  fmt_date:         { pt:'DD/MM/AAAA',           en:'MM/DD/YYYY',        es:'DD/MM/AAAA' },
  fmt_decimal_sep:  { pt:',',                   en:'.',                 es:',' },
  fmt_thousands_sep:{ pt:'.',                   en:',',                 es:'.' },
};

// Active language (default: pt)
let _lang = 'pt';

function setLanguage(lang) {
  if (!['pt','en','es'].includes(lang)) lang = 'pt';
  _lang = lang;
  document.documentElement.lang = lang;
}

function t(key, fallback) {
  const entry = TRANSLATIONS[key];
  if (!entry) return fallback || key;
  return entry[_lang] || entry['pt'] || fallback || key;
}

// Expose globally
if (typeof window !== 'undefined') {
  window.t = t;
  window.setLanguage = setLanguage;
  window.TRANSLATIONS = TRANSLATIONS;
}
if (typeof module !== 'undefined') module.exports = { t, setLanguage, TRANSLATIONS };
