/**
 * 雲林品德農精靈大富翁 － GitHub Pages ⇄ Google 試算表 串接腳本
 * 放在 index.html 同一資料夾，並在 </body> 前加入：<script src="sheets-sync.js"></script>
 */
(function () {
  'use strict';

  // ====== 設定區 ======
  const GAS_URL = 'https://script.google.com/macros/s/AKfycbxCXgbGelshVPC2OqaOTznMXKo-cvNuqI-V-fguwu04qWnLQ3gtggpS-rM7Dhb6qEKa2w/exec';
  const TOKEN = '';              // 若 Code.gs 有設定 ACCESS_TOKEN，請填相同的字串
  const SAVE_KEY = 'yunlin_character_monopoly_farm_v2';
  // ====================

  const configured = /^https:\/\/script\.google\.com\/.+\/exec/.test(GAS_URL);
  const getCode = () => (safeLS.getItem('cloudClassCode') || '').trim();
  const autoOn = () => safeLS.getItem('cloudAuto') === '1';

  async function gasPost(action, payload) {
    const r = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // 不觸發 CORS 預檢
      body: JSON.stringify(Object.assign({ action, token: TOKEN }, payload))
    });
    return r.json();
  }
  async function gasGet(action, params) {
    const q = new URLSearchParams(Object.assign({ action, token: TOKEN }, params || {}));
    const r = await fetch(GAS_URL + '?' + q.toString());
    return r.json();
  }
  const toast = (m, t, d) => (typeof showAIToast === 'function' ? showAIToast(m, t || 'info', d || 2500) : console.log(m));

  /* ---------- 1. Gemini 代理：「目前帳號的 Gemini」在 GitHub 上沒有金鑰，改走 GAS ---------- */
  const nativeFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    try {
      const u = String(url);
      const m = u.match(/generativelanguage\.googleapis\.com\/v1beta\/models\/([^:]+):generateContent\?key=(.*)$/);
      if (configured && m && m[2] === '') {
        return gasPost('gemini', { model: m[1].replace('-preview-09-2025', ''), body: JSON.parse(opts.body) }).then(res => {
          if (!res.ok) return new Response(JSON.stringify({ error: { message: res.error } }), { status: 500 });
          return new Response(res.text, { status: res.status, headers: { 'Content-Type': 'application/json' } });
        });
      }
    } catch (e) { /* 失敗就走原本流程 */ }
    return nativeFetch(url, opts);
  };

  /* ---------- 2. 存檔 / 讀檔 ---------- */
  async function cloudSave(silent) {
    const code = getCode();
    if (!code) { if (!silent) toast('請先輸入班級代碼', 'error'); return; }
    if (typeof gameState === 'undefined' || !gameState.players) { if (!silent) toast('目前沒有進行中的遊戲可存檔', 'error'); return; }
    try {
      const res = await gasPost('save', { code, state: gameState });
      if (!res.ok) throw new Error(res.error);
      if (!silent) toast('已存到雲端試算表 ☁️', 'success');
    } catch (e) { toast('雲端存檔失敗：' + e.message, 'error', 4000); }
  }

  async function cloudLoad() {
    const code = getCode();
    if (!code) { toast('請先輸入班級代碼', 'error'); return; }
    toast('讀取雲端存檔中…', 'loading');
    try {
      const res = await gasGet('load', { code });
      if (!res.ok) throw new Error(res.error);
      const s = res.state;
      if (!s.players || !s.board) throw new Error('存檔格式不正確');
      if (gameTimerInterval) { clearInterval(gameTimerInterval); gameTimerInterval = null; }
      s.players = s.players.map(p => Object.assign({}, p, { announcedBankruptcy: false }));
      setupScreen.classList.add('hidden');
      gameScreen.classList.remove('hidden');
      initGame(s);
      toast('已從雲端載入進度', 'success');
    } catch (e) { toast('讀取失敗：' + e.message, 'error', 4000); }
  }

  // 本機每次存檔時，若開啟「自動雲端存檔」就延遲 3 秒同步
  let timer = null;
  const origSet = safeLS.setItem.bind(safeLS);
  safeLS.setItem = function (k, v) {
    origSet(k, v);
    if (k === SAVE_KEY && configured && autoOn() && getCode()) {
      clearTimeout(timer);
      timer = setTimeout(() => cloudSave(true), 3000);
    }
  };

  /* ---------- 3. 成績紀錄 ---------- */
  function logResult() {
    if (!configured) return;
    try {
      const code = getCode() || '(未填)';
      const rows = gameState.players.map(p => {
        const props = gameState.board.filter(s => s.ownerId === p.id);
        const val = props.reduce((a, s) => a + s.price * 0.9, 0);
        const sp = FARM_SPRITES.find(x => x.emoji === p.emoji);
        return { name: p.name, sprite: sp ? sp.name : p.emoji, money: p.money, total: Math.round(p.money + val), n: props.length };
      }).sort((a, b) => b.total - a.total);
      const now = new Date().toLocaleString('zh-TW');
      gasPost('result', {
        rows: rows.map((r, i) => [now, code, gameState.gameTitle, i + 1, r.name, r.sprite, r.money, r.total, r.n])
      }).then(res => { if (res.ok) toast('成績已記錄到試算表', 'success'); });
    } catch (e) { console.warn('成績記錄失敗', e); }
  }
  const origEnd = window.endGame;
  window.endGame = function (isSilent) {
    const already = gameState && gameState.isGameOver;
    const r = origEnd.apply(this, arguments);
    if (!isSilent && !already) logResult();
    return r;
  };

  /* ---------- 4. 雲端題庫 ---------- */
  async function cloudQuiz() {
    toast('載入雲端題庫中…', 'loading');
    try {
      const res = await gasGet('quiz');
      if (!res.ok) throw new Error(res.error);
      let n = 0;
      Object.entries(res.banks).forEach(([name, list]) => {
        gameState.quizzes[name] = list;
        gameState.availableQuizIndices[name] = list.map((_, i) => i);
        if (!gameState.activeQuizBanks.includes(name)) gameState.activeQuizBanks.push(name);
        n++;
      });
      renderQuizBankSelection();
      toast(`已載入 ${n} 個雲端題庫`, 'success');
    } catch (e) { toast('載入題庫失敗：' + e.message, 'error', 4000); }
  }

  /* ---------- 5. 介面：右上角「雲端」面板 ---------- */
  function buildUI() {
    const css = document.createElement('style');
    css.textContent = `
      #cloud-fab{position:fixed;top:10px;right:10px;z-index:60;border:none;border-radius:999px;padding:8px 14px;font-weight:800;font-size:.85rem;color:#fff;cursor:pointer;
        background:linear-gradient(135deg,#8fcdff,#c6a6ff);box-shadow:0 6px 14px -4px rgba(120,90,150,.45)}
      #cloud-panel{position:fixed;top:52px;right:10px;z-index:60;width:260px;background:#fff;border:2px solid #e6d9ff;border-radius:18px;padding:14px;
        box-shadow:0 18px 40px -12px rgba(120,90,150,.45);display:none;font-size:.85rem;color:#5b4a6b}
      #cloud-panel.open{display:block}
      #cloud-panel input[type=text]{width:100%;border:2px solid #e6d9ff;border-radius:10px;padding:6px 10px;margin:4px 0 8px}
      #cloud-panel button{width:100%;border:none;border-radius:10px;padding:7px;margin-top:6px;font-weight:700;cursor:pointer;background:#f1ecf8;color:#4b2e7a}
      #cloud-panel button:hover{filter:brightness(.96)}
      #cloud-panel .warn{color:#d9376e;font-size:.75rem;margin-top:6px}`;
    document.head.appendChild(css);

    const fab = document.createElement('button');
    fab.id = 'cloud-fab'; fab.textContent = '☁️ 雲端';
    const panel = document.createElement('div');
    panel.id = 'cloud-panel';
    panel.innerHTML = `
      <b>Google 試算表雲端</b>
      <label style="display:block;margin-top:8px">班級代碼（存檔名稱）</label>
      <input type="text" id="cloud-code" placeholder="例如：301">
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="cloud-auto"> 自動雲端存檔</label>
      <button id="cloud-save">⬆️ 存到雲端</button>
      <button id="cloud-load">⬇️ 從雲端讀取進度</button>
      <button id="cloud-quiz">📚 載入雲端題庫</button>
      ${configured ? '' : '<div class="warn">尚未設定 GAS_URL（sheets-sync.js 最上方）</div>'}`;
    document.body.append(fab, panel);

    const codeEl = panel.querySelector('#cloud-code'), autoEl = panel.querySelector('#cloud-auto');
    codeEl.value = getCode(); autoEl.checked = autoOn();
    codeEl.addEventListener('input', () => safeLS.setItem('cloudClassCode', codeEl.value.trim()));
    autoEl.addEventListener('change', () => safeLS.setItem('cloudAuto', autoEl.checked ? '1' : '0'));
    fab.onclick = () => panel.classList.toggle('open');
    panel.querySelector('#cloud-save').onclick = () => cloudSave(false);
    panel.querySelector('#cloud-load').onclick = cloudLoad;
    panel.querySelector('#cloud-quiz').onclick = cloudQuiz;
  }
  buildUI();
})();
