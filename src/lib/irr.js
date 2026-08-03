// ─────────────────────────────────────────────────────────────
// irr.js — TIR (Taxa Interna de Retorno) por Newton-Raphson mensal,
// depois anualizada. Função pura, sem dependência de DOM ou de banco.
//
// Compartilhada entre o renderer (aba Patrimônio, cálculo ao vivo pra
// exibição) e o processo principal (sync-push.js, cálculo em segundo
// plano pro sync com o mobile) — existe UMA implementação só, pra não
// os dois lados divergirem com o tempo. Carregado via <script> no
// index.html (define window.calcIRR) e via require() no main process.
// ─────────────────────────────────────────────────────────────
(function (root) {
  function calcIRR(cashflows) {
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
    const annual = Math.pow(1 + rate, 12) - 1;
    // Trava de sanidade: um fluxo de caixa inconsistente (ex.: um bug de
    // importação duplicando/invertendo movimentações) pode fazer o
    // Newton-Raphson divergir pra uma taxa astronômica mas ainda "finita"
    // (passa no isFinite acima) — ex.: TIR "9.97e+118% a.a." reportado
    // pelo usuário. Nenhum investimento real tem TIR de milhares de % a.a.;
    // um resultado assim indica não-convergência, não um retorno de
    // verdade, então é melhor não mostrar nada a mostrar um número absurdo.
    if (!isFinite(annual) || Math.abs(annual) > 1000) return null;
    return annual;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { calcIRR };
  } else {
    root.calcIRR = calcIRR;
  }
})(typeof window !== 'undefined' ? window : this);
