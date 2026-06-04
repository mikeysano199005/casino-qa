// Aviator web client — renders the server-authoritative round and places real bets.
const $ = (s) => document.querySelector(s);
const fmt = (paise) => '₹' + (Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── state ───────────────────────────────────────────────────────────────────
let clockOffset = 0;                 // serverTime - localTime
let clockInit = false;
const now = () => Date.now() + clockOffset;
// Low-pass the offset so latency jitter doesn't make the multiplier jump.
function syncClock(serverTime) {
  const target = serverTime - Date.now();
  if (!clockInit) { clockOffset = target; clockInit = true; }
  else clockOffset += (target - clockOffset) * 0.2;
}
let phase = 'waiting';
let startTime = null;                // server ms when flight started
let bettingEndsAt = null;
let crashAt = null;                  // revealed only on crash
const myBets = { 0: null, 1: null }; // per-slot bet { stake, slot, auto, cashedOut, cashOutAt, payout }
let betVal = 10;                     // rupees in panel 0
const GROWTH = 1.12;                 // multiplier growth per second (must match the server engine)
let lastProgress = 0.5;              // plane position at the moment of crash
const AVATAR_COLORS = ['#e84242', '#4da6ff', '#5ecf4e', '#d46bff', '#e8a23a', '#3ac6c6', '#c64fa0'];

// ── balance ─────────────────────────────────────────────────────────────────
function setBalance(paise) { $('#balance').textContent = fmt(paise); }
async function refreshBalance() {
  try { const r = await fetch('/api/play/me'); const d = await r.json(); if (d.balance != null) setBalance(d.balance); } catch {}
}

// ── toast ───────────────────────────────────────────────────────────────────
function toast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:#18181e;border:1px solid #2a2a30;color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:99';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
const ERRS = {
  betting_closed: 'Betting is closed — wait for the next round',
  already_bet: 'You already have a bet this round',
  insufficient_balance: '💸 Insufficient balance',
  maintenance: '🚧 Games are paused for maintenance',
  account_suspended: '🚫 Your account is suspended',
  no_bet: 'No active bet', not_flying: 'Round not running', crashed: 'Too late — it crashed',
};
const errMsg = (e) => ERRS[e] || (String(e || '').startsWith('bet_range_') ? `Bet ${e.split('_').slice(2).map(n => '₹' + n).join('–')}` : 'Something went wrong');

// ── top history ───────────────────────────────────────────────────────────────
function renderHistory(hist) {
  const bar = $('#topbar');
  bar.innerHTML = '';
  for (const v of hist.slice(0, 30)) {
    const span = document.createElement('span');
    span.className = 'hpill ' + (v < 2 ? 'h-blue' : v < 5 ? 'h-green' : 'h-purple');
    span.textContent = v.toFixed(2) + 'x';
    bar.appendChild(span);
  }
}

// ── sidebar bets ──────────────────────────────────────────────────────────────
function renderBets(bets) {
  $('#betCount').textContent = `${bets.length} Bets`;
  const list = $('#betList');
  list.innerHTML = '';
  for (const b of bets) {
    const row = document.createElement('div');
    row.className = 'bet-row';
    const color = AVATAR_COLORS[(b.name.charCodeAt(0) || 0) % AVATAR_COLORS.length];
    const won = b.cashedOut;
    row.innerHTML = `<div class="avatar" style="background:${color}">${(b.name[0] || '?').toUpperCase()}</div>
      <div class="bet-user">${b.name}</div>
      ${won ? `<div class="bet-mult">${b.cashOutAt.toFixed(2)}x</div><div class="bet-amt bet-win">${fmt(b.payout)}</div>`
            : `<div class="bet-amt">${fmt(b.stake)}</div>`}`;
    list.appendChild(row);
  }
}

// ── SSE ───────────────────────────────────────────────────────────────────────
function connect() {
  const es = new EventSource('/api/play/stream');
  es.addEventListener('state', (e) => {
    const d = JSON.parse(e.data);
    syncClock(d.serverTime);
    const prevPhase = phase;
    phase = d.phase;
    startTime = d.startTime;
    bettingEndsAt = d.bettingEndsAt;
    crashAt = d.crashAt;
    if (d.history) renderHistory(d.history);
    if (d.viewers != null) $('#viewerCount').textContent = d.viewers;
    if (d.roundId && d.roundId !== currentRoundId) { lastRoundId = currentRoundId; currentRoundId = d.roundId; }

    if (phase === 'betting' && prevPhase !== 'betting') {
      myBets[0] = null; myBets[1] = null;
      $('#flewAway').classList.add('hidden');
      $('#multiplier').classList.add('hidden');
    }
    if (phase === 'flying') {
      $('#flewAway').classList.add('hidden');
      $('#multiplier').classList.remove('hidden');
    }
    if (phase === 'crashed' && prevPhase !== 'crashed') {
      $('#crashMult').textContent = (crashAt || 0).toFixed(2) + 'x';
      $('#flewAway').classList.remove('hidden');
      $('#multiplier').classList.add('hidden');
      sfx('crash');
      refreshBalance(); // reflect any loss
    }
    updateAllActions();
  });
  es.addEventListener('sync', (e) => {
    const d = JSON.parse(e.data);
    syncClock(d.serverTime);
    // Hard-align to the server's authoritative multiplier if we've drifted.
    if (phase === 'flying' && startTime && d.mult) {
      const localMult = Math.pow(GROWTH, (now() - startTime) / 1000);
      if (Math.abs(localMult - d.mult) > 0.05) {
        const targetElapsed = Math.log(d.mult) / Math.log(GROWTH) * 1000;
        const desiredOffset = startTime + targetElapsed - Date.now();
        clockOffset += (desiredOffset - clockOffset) * 0.3;
      }
    }
  });
  es.addEventListener('bets', (e) => renderBets(JSON.parse(e.data)));
  es.addEventListener('you', (e) => { const b = JSON.parse(e.data).bets || {}; myBets[0] = b[0] || null; myBets[1] = b[1] || null; updateAllActions(); });
  es.onerror = () => {/* browser auto-reconnects */};
}

// ── canvas ────────────────────────────────────────────────────────────────────
const canvas = $('#game');
const ctx = canvas.getContext('2d');
const gameArea = $('#gameArea');

// Red Aviator plane as an inline SVG image (nose points right). Self-contained.
const PLANE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 64">
  <path d="M16 31 L3 12 L24 29 Z" fill="#b01d1d"/>
  <path d="M42 35 L20 58 L46 41 L60 37 Z" fill="#9c1818"/>
  <path d="M42 29 L26 6 L50 25 L62 30 Z" fill="#cf2323"/>
  <path d="M12 32 Q42 17 80 29 Q87 32 80 35 Q42 47 12 35 Z" fill="#e62929"/>
  <ellipse cx="52" cy="29" rx="11" ry="4.2" fill="#7c1414"/>
  <g stroke="#fff" stroke-width="2.6" stroke-linecap="round">
    <line x1="45" y1="26.5" x2="54" y2="35.5"/><line x1="54" y1="26.5" x2="45" y2="35.5"/>
  </g>
  <circle cx="82" cy="32" r="4.2" fill="#222"/>
  <g fill="#1c1c1c"><ellipse cx="86" cy="19" rx="3" ry="12.5"/><ellipse cx="86" cy="45" rx="3" ry="12.5"/></g>
</svg>`;
const planeImg = new Image();
let planeReady = false;
planeImg.onload = () => { planeReady = true; };
planeImg.src = 'data:image/svg+xml;base64,' + btoa(PLANE_SVG);

let raysCanvas = null;
let rayAngle = 0;
const SUN_X = () => canvas.width * 0.46;
const SUN_Y = () => canvas.height * 0.52;

function resizeCanvas() {
  const rect = gameArea.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width));
  canvas.height = Math.max(1, Math.floor(rect.height));

  // Pre-render the dark sunburst wedges once (the rotating-ray backdrop).
  const R = Math.hypot(canvas.width, canvas.height);
  raysCanvas = document.createElement('canvas');
  raysCanvas.width = raysCanvas.height = R * 2;
  const rc = raysCanvas.getContext('2d');
  const c = R; // center of the offscreen square
  const n = 24;
  rc.fillStyle = 'rgba(0,0,0,0.28)';
  for (let i = 0; i < n; i += 2) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    rc.beginPath(); rc.moveTo(c, c); rc.arc(c, c, R, a0, a1); rc.closePath(); rc.fill();
  }
}
window.addEventListener('load', resizeCanvas);
window.addEventListener('resize', resizeCanvas);

// Background: dark base + slowly rotating sunburst + soft purple glow behind the number.
function drawBackground() {
  ctx.fillStyle = '#0a0a12';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (raysCanvas) {
    rayAngle += 0.0008;
    ctx.save();
    ctx.translate(SUN_X(), SUN_Y());
    ctx.rotate(rayAngle);
    ctx.drawImage(raysCanvas, -raysCanvas.width / 2, -raysCanvas.height / 2);
    ctx.restore();
  }
  const cx = canvas.width * 0.45, cy = canvas.height * 0.5, r = Math.max(canvas.width, canvas.height) * 0.55;
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  glow.addColorStop(0, 'rgba(120,70,210,0.22)');
  glow.addColorStop(0.55, 'rgba(70,40,130,0.10)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, canvas.width, canvas.height);
}

const lerp = (a, b, t) => a + (b - a) * t;

// The flight path: origin bottom-left → upper-right. Y uses a power curve so it
// stays low then sweeps up steeply (the classic Aviator arc).
function curvePoint(t) {
  const sx = canvas.width * 0.04, sy = canvas.height * 0.90;
  const ex = canvas.width * 0.90, ey = canvas.height * 0.16;
  return { x: lerp(sx, ex, t), y: lerp(sy, ey, Math.pow(t, 2.1)) };
}
function planeAngle(progress) {
  const a = curvePoint(Math.max(0, progress - 0.02)), b = curvePoint(progress);
  return Math.atan2(b.y - a.y, b.x - a.x);
}
// Draws the FULL curve from the origin to the current progress, with the red
// gradient fill beneath it. Returns the tip (where the plane sits).
function drawCurve(progress, crashed) {
  const steps = 70, pts = [];
  for (let i = 0; i <= steps; i++) pts.push(curvePoint(progress * i / steps));
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts) ctx.lineTo(p.x, p.y);
  ctx.lineTo(pts[pts.length - 1].x, canvas.height);
  ctx.lineTo(pts[0].x, canvas.height);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, 'rgba(232,55,55,0.22)');
  g.addColorStop(1, 'rgba(150,20,20,0.45)');
  ctx.fillStyle = g; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (const p of pts) ctx.lineTo(p.x, p.y);
  ctx.strokeStyle = crashed ? '#9b2222' : '#ff3b3b';
  ctx.lineWidth = 4; ctx.lineJoin = 'round'; ctx.stroke();
  return pts[pts.length - 1];
}

function drawPlane(x, y, crashed, angle) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(crashed ? 0.4 : (angle || 0));
  if (crashed) ctx.globalAlpha = 0.85;
  if (planeReady) {
    const w = 96, h = w * (64 / 100);
    ctx.drawImage(planeImg, -w * 0.55, -h * 0.5, w, h); // nose near the curve tip
  } else {
    const s = 46; // fallback triangle until the image loads
    ctx.beginPath();
    ctx.moveTo(s * 0.6, 0); ctx.lineTo(s * -0.3, s * -0.18); ctx.lineTo(s * -0.3, s * 0.18); ctx.closePath();
    ctx.fillStyle = '#e84242'; ctx.fill();
  }
  ctx.restore();
}

function frame() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBackground();

  if (phase === 'flying' && startTime) {
    const elapsed = now() - startTime;
    const es = elapsed / 1000;
    let mult = Math.pow(GROWTH, es);
    if (crashAt && mult > crashAt) mult = crashAt;
    // Plane shoots up fast, then hovers near the top-right (real Aviator feel).
    const progress = Math.min(0.95, 1 - Math.exp(-es / 0.9));
    lastProgress = progress;
    const tip = drawCurve(progress, false);
    drawPlane(tip.x, tip.y, false, planeAngle(progress));
    $('#multiplier').textContent = mult.toFixed(2) + 'x';
    for (const p of panels) {
      const bet = myBets[p.slot];
      if (bet && !bet.cashedOut) p.sub.textContent = fmt(Math.floor(Number(bet.stake) * mult)) + ' @ ' + mult.toFixed(2) + 'x';
    }
  } else if (phase === 'crashed') {
    const tip = drawCurve(lastProgress, true);
    drawPlane(tip.x, tip.y, true, 0);
  }
  // betting / waiting: background only (no plane, no curve)

  if (phase === 'betting') {
    const secs = bettingEndsAt ? Math.max(0, Math.ceil((bettingEndsAt - now()) / 1000)) : 0;
    const b = $('#statusBanner'); b.className = 'banner wait'; b.textContent = `Place your bets — ${secs}s`; b.classList.remove('hidden');
  } else {
    $('#statusBanner').classList.add('hidden');
  }

  requestAnimationFrame(frame);
}

// ── sounds + confetti ──────────────────────────────────────────────────────────
let actx = null;
function sfx(kind) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain();
    o.connect(g); g.connect(actx.destination);
    const f = { bet: 320, cash: 720, crash: 130 }[kind] || 440;
    o.frequency.value = f; o.type = kind === 'crash' ? 'sawtooth' : 'sine';
    g.gain.setValueAtTime(0.0001, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, actx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, actx.currentTime + 0.25);
    o.start(); o.stop(actx.currentTime + 0.26);
  } catch {}
}
function confetti() {
  const c = document.createElement('div'); c.className = 'confetti';
  for (let i = 0; i < 40; i++) {
    const p = document.createElement('i');
    p.style.left = Math.random() * 100 + '%';
    p.style.background = ['#e84242', '#2dc44e', '#4da6ff', '#e8a23a', '#d46bff'][i % 5];
    p.style.animationDelay = (Math.random() * 0.3) + 's';
    c.appendChild(p);
  }
  document.body.appendChild(c);
  setTimeout(() => c.remove(), 2200);
}

// ── two-slot bet panels (slot 0 + slot 1), with auto-cashout ───────────────────
const panels = [0, 1].map(slot => {
  const el = document.querySelector(`.bet-panel[data-panel="${slot}"]`);
  el.classList.remove('visual');
  return { slot, el, action: el.querySelector('.action'), main: el.querySelector('.action-main'), sub: el.querySelector('.action-sub'), amount: el.querySelector('.amount'), val: 10, autoOn: false, autoVal: 2.0 };
});

function updateAction(slot) {
  const p = panels[slot], bet = myBets[slot];
  p.action.classList.remove('cashout');
  if (phase === 'betting' && !bet) { p.action.disabled = false; p.main.textContent = 'Bet'; p.sub.textContent = p.val.toFixed(2) + ' ₹'; }
  else if (phase === 'betting' && bet) { p.action.disabled = true; p.main.textContent = 'Bet placed ✓'; p.sub.textContent = fmt(bet.stake); }
  else if (phase === 'flying' && bet && !bet.cashedOut) { p.action.disabled = false; p.action.classList.add('cashout'); p.main.textContent = 'Cash Out'; p.sub.textContent = fmt(bet.stake); }
  else if (bet && bet.cashedOut) { p.action.disabled = true; p.main.textContent = `Cashed @ ${bet.cashOutAt.toFixed(2)}x`; p.sub.textContent = fmt(bet.payout || 0); }
  else { p.action.disabled = true; p.main.textContent = 'Bet'; p.sub.textContent = p.val.toFixed(2) + ' ₹'; }
}
const updateAllActions = () => { updateAction(0); updateAction(1); };

async function doBet(slot) {
  const p = panels[slot];
  const body = { amount: p.val, slot };
  if (p.autoOn && p.autoVal > 1) body.auto = p.autoVal;
  try {
    const r = await fetch('/api/play/bet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok || !d.ok) return toast(errMsg(d.error));
    myBets[slot] = d.bet; setBalance(d.balance); updateAction(slot); sfx('bet');
  } catch { toast('Network error'); }
}
async function doCashout(slot) {
  try {
    const r = await fetch('/api/play/cashout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slot }) });
    const d = await r.json();
    if (!r.ok || !d.ok) return toast(errMsg(d.error));
    myBets[slot] = { ...myBets[slot], cashedOut: true, cashOutAt: d.multiplier, payout: d.payout };
    setBalance(d.balance); updateAction(slot); sfx('cash'); confetti();
    toast(`Cashed out @ ${d.multiplier.toFixed(2)}x → ${fmt(d.payout)}`);
  } catch { toast('Network error'); }
}

function wirePanel(p) {
  const setVal = (v) => { v = Math.max(1, Math.round(v * 100) / 100); p.val = v; p.amount.value = v.toFixed(2); if (!myBets[p.slot] || phase !== 'flying') p.sub.textContent = v.toFixed(2) + ' ₹'; };
  p.el.querySelector('[data-act="dec"]').onclick = () => setVal(p.val - 1);
  p.el.querySelector('[data-act="inc"]').onclick = () => setVal(p.val + 1);
  p.el.querySelectorAll('.quick button').forEach(b => b.onclick = () => setVal(Number(b.dataset.q)));
  p.amount.onchange = () => setVal(parseFloat(p.amount.value || '1'));
  // auto-cashout row (shown when the "Auto" tab is active)
  const autoRow = document.createElement('div'); autoRow.className = 'auto-row hidden';
  autoRow.innerHTML = `<span>Auto cashout ×</span><input class="auto-in" type="number" step="0.1" min="1.1" value="2.0" />`;
  p.el.querySelector('.panel-body').insertBefore(autoRow, p.action);
  const autoIn = autoRow.querySelector('.auto-in');
  autoIn.oninput = () => { p.autoVal = Number(autoIn.value) || 2; };
  p.el.querySelectorAll('.ptab').forEach(t => t.onclick = () => {
    p.el.querySelectorAll('.ptab').forEach(x => x.classList.remove('active')); t.classList.add('active');
    p.autoOn = t.textContent.trim() === 'Auto'; autoRow.classList.toggle('hidden', !p.autoOn);
  });
  p.action.addEventListener('click', () => {
    if (phase === 'flying' && myBets[p.slot] && !myBets[p.slot].cashedOut) return doCashout(p.slot);
    if (phase === 'betting' && !myBets[p.slot]) return doBet(p.slot);
  });
  setVal(p.val);
}
panels.forEach(wirePanel);
document.querySelectorAll('#sidebar .tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('#sidebar .tab').forEach(x => x.classList.remove('active')); t.classList.add('active');
});

// ── Cashier + Account sheet ─────────────────────────────────────────────────────
const sheet = $('#sheet');
function closeSheet() { sheet.classList.add('hidden'); sheet.innerHTML = ''; }
function openSheet(title, body) {
  sheet.innerHTML = `<div class="sheet-panel"><div class="sheet-head"><div class="sheet-title">${title}</div><button class="sheet-close" data-x>×</button></div><div id="sheetBody">${body}</div></div>`;
  sheet.classList.remove('hidden');
  sheet.onclick = (e) => { if (e.target === sheet) closeSheet(); };
  sheet.querySelector('[data-x]').onclick = closeSheet;
}
async function papi(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'failed'), { data: d });
  return d;
}

function openCashier(tab) {
  openSheet('Cashier', `
    <div class="seg"><button data-t="deposit" class="${tab !== 'withdraw' ? 'active' : ''}">Deposit</button><button data-t="withdraw" class="${tab === 'withdraw' ? 'active' : ''}">Withdraw</button></div>
    <div id="cashBody"></div>`);
  const render = (t) => {
    sheet.querySelectorAll('.seg button').forEach(b => b.classList.toggle('active', b.dataset.t === t));
    document.getElementById('cashBody').innerHTML = t === 'deposit' ? depositForm() : withdrawForm();
    t === 'deposit' ? wireDeposit() : wireWithdraw();
  };
  sheet.querySelectorAll('.seg button').forEach(b => b.onclick = () => render(b.dataset.t));
  render(tab === 'withdraw' ? 'withdraw' : 'deposit');
}
function depositForm() {
  return `<div class="note">Add money via UPI. Your wallet is credited automatically after payment.</div>
    <div class="fld"><label>Amount (₹)</label><input id="depAmt" type="number" value="200" /></div>
    <div class="chips">${[100, 200, 500, 1000].map(v => `<button data-d="${v}">${v}</button>`).join('')}</div>
    <button class="big-btn" id="depGo">Pay via UPI</button>`;
}
function wireDeposit() {
  sheet.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { document.getElementById('depAmt').value = b.dataset.d; });
  document.getElementById('depGo').onclick = async () => {
    const amount = Number(document.getElementById('depAmt').value);
    try { const d = await papi('/api/play/deposit', { method: 'POST', body: { amount } }); toast('Opening payment…'); window.open(d.payUrl, '_blank'); }
    catch (e) { toast(e.data?.min ? `Deposit ₹${e.data.min}–₹${e.data.max}` : 'Deposit failed'); }
  };
}
function withdrawForm() {
  return `<div class="note">Requests are reviewed before payout. Bonus funds need wagering first.</div>
    <div class="seg" id="wm"><button data-m="upi" class="active">UPI</button><button data-m="bank">Bank</button></div>
    <div class="fld"><label>Amount (₹)</label><input id="wAmt" type="number" value="500" /></div>
    <div id="wFields"></div>
    <button class="big-btn alt" id="wGo">Request withdrawal</button>`;
}
function wireWithdraw() {
  let method = 'upi';
  const fields = () => {
    document.getElementById('wFields').innerHTML = method === 'upi'
      ? `<div class="fld"><label>UPI ID</label><input id="wUpi" placeholder="name@bank" /></div>`
      : `<div class="fld"><label>Account holder name</label><input id="wName" /></div>
         <div class="fld"><label>Account number</label><input id="wAcc" /></div>
         <div class="fld"><label>IFSC</label><input id="wIfsc" /></div>
         <div class="fld"><label>Phone</label><input id="wPhone" /></div>`;
  };
  sheet.querySelectorAll('#wm button').forEach(b => b.onclick = () => {
    method = b.dataset.m; sheet.querySelectorAll('#wm button').forEach(x => x.classList.toggle('active', x === b)); fields();
  });
  fields();
  document.getElementById('wGo').onclick = async () => {
    const amount = Number(document.getElementById('wAmt').value);
    const body = { amount, method };
    if (method === 'upi') body.upi = document.getElementById('wUpi').value.trim();
    else body.bank = { name: document.getElementById('wName').value.trim(), acc: document.getElementById('wAcc').value.trim(), ifsc: document.getElementById('wIfsc').value.trim(), phone: document.getElementById('wPhone').value.trim() };
    try { await papi('/api/play/withdraw', { method: 'POST', body }); toast('✅ Withdrawal requested'); closeSheet(); refreshBalance(); }
    catch (e) {
      const m = { min: `Minimum withdraw ₹${e.data?.min}`, cooldown: 'On cooldown — try later', wagering: `Wager more first (withdrawable ${fmt(e.data?.withdrawable || 0)})`, insufficient: 'Insufficient balance', upi_required: 'Enter your UPI ID', bank_required: 'Fill all bank fields' };
      toast(m[e.data?.error] || 'Withdrawal failed');
    }
  };
}

async function openAccount() {
  openSheet('Account', '<div class="muted">Loading…</div>');
  try {
    const a = await papi('/api/play/account');
    const w = a.wallet;
    const stat = (k, v) => `<div class="stat-row"><span class="k">${k}</span><span>${v}</span></div>`;
    const hist = await papi('/api/play/history?page=0').catch(() => ({ bets: [] }));
    document.getElementById('sheetBody').innerHTML = `
      <div class="stat-card">
        ${stat('Available', fmt(w.available))}${stat('Withdrawable', fmt(w.withdrawable))}
        ${stat('Bonus (locked)', fmt(w.bonus_balance))}${stat('Wager needed', fmt(w.wager_pending))}
        ${stat('Deposited', fmt(w.total_deposited))}${stat('Withdrawn', fmt(w.total_withdrawn))}${stat('Wagered', fmt(w.total_wagered))}
      </div>
      <button class="big-btn" id="dailyBtn" ${a.dailyAvailable ? '' : 'disabled'}>${a.dailyAvailable ? '🎁 Claim daily reward' : 'Daily reward claimed'}</button>
      <div class="stat-card" style="margin-top:12px">
        <div class="stat-row"><span class="k">Referral code</span><span><b>${esc(a.referral_code || '—')}</b></span></div>
        <div class="stat-row"><span class="k">Referrals</span><span>${a.referrals} • earned ${fmt(a.referral_earned)}</span></div>
        ${a.referred ? '' : `<div class="fld" style="margin-top:8px"><label>Enter a referral code</label><input id="refIn" placeholder="CODE" /></div><button class="big-btn alt" id="refGo">Apply code</button>`}
      </div>
      <div class="stat-card">
        <div class="fld"><label>Redeem a promo code</label><input id="promoIn" placeholder="WELCOME100" /></div>
        <button class="big-btn alt" id="promoGo">Redeem</button>
      </div>
      <div class="sheet-title" style="font-size:14px;margin:6px 0">Recent bets</div>
      <table class="acct-table"><tbody>${(hist.bets || []).map(b => `<tr><td>${esc(b.game)}</td><td>${fmt(b.stake)}</td><td style="color:${b.result === 'win' ? '#2dc44e' : '#e84242'}">${b.result === 'win' ? '+' + fmt(b.payout) : '−' + fmt(b.stake)}</td></tr>`).join('') || '<tr><td class="muted">No bets yet</td></tr>'}</tbody></table>`;

    const daily = document.getElementById('dailyBtn');
    if (daily && a.dailyAvailable) daily.onclick = async () => { try { const d = await papi('/api/play/daily', { method: 'POST' }); setBalance(d.balance); toast('🎁 Daily reward claimed'); openAccount(); } catch { toast('Already claimed'); } };
    const refGo = document.getElementById('refGo');
    if (refGo) refGo.onclick = async () => { try { await papi('/api/play/refcode', { method: 'POST', body: { code: document.getElementById('refIn').value } }); toast('✅ Referral applied'); openAccount(); } catch { toast('Invalid code'); } };
    document.getElementById('promoGo').onclick = async () => { try { const d = await papi('/api/play/redeem', { method: 'POST', body: { code: document.getElementById('promoIn').value } }); setBalance(d.balance); toast(`✅ Bonus ${fmt(d.bonus)} added`); openAccount(); } catch (e) { toast({ invalid: 'Invalid code', expired: 'Code expired', already_used: 'Already redeemed' }[e.data?.error] || 'Redeem failed'); } };
  } catch { document.getElementById('sheetBody').innerHTML = '<div class="muted">Could not load account.</div>'; }
}

$('#btnDeposit').onclick = () => openCashier('deposit');
$('#btnWithdraw').onclick = () => openCashier('withdraw');
$('#btnAccount').onclick = openAccount;

// ── Games lobby + Dice + Slots ──────────────────────────────────────────────────
function openLobby() {
  openSheet('Games', `<div class="lobby-grid">
    <div class="lobby-card" data-g="aviator"><div class="lobby-emoji">✈</div><div class="lobby-name">Aviator</div></div>
    <div class="lobby-card" data-g="dice"><div class="lobby-emoji">🎲</div><div class="lobby-name">Dice</div></div>
    <div class="lobby-card" data-g="slots"><div class="lobby-emoji">🎰</div><div class="lobby-name">Slots</div></div>
    <div class="lobby-card" data-g="mines"><div class="lobby-emoji">💣</div><div class="lobby-name">Mines</div></div>
    <div class="lobby-card" data-g="colour"><div class="lobby-emoji">🎨</div><div class="lobby-name">Colour</div></div>
  </div>`);
  sheet.querySelectorAll('[data-g]').forEach(c => c.onclick = () => {
    const g = c.dataset.g;
    if (g === 'aviator') return closeSheet();
    if (g === 'dice') return openDice();
    if (g === 'slots') return openSlots();
    if (g === 'mines') return openMines();
    if (g === 'colour') return openColour();
  });
}

function openDice() {
  openSheet('🎲 Dice', `
    <div class="dice-result" id="diceRes">—</div>
    <div class="dice-track"><div class="dice-fill" id="diceFill"></div><div class="dice-marker" id="diceMark"></div></div>
    <div class="stat-row"><span class="k">Win chance</span><span id="diceChance">49%</span></div>
    <div class="stat-row"><span class="k">Payout</span><span id="dicePay">1.98×</span></div>
    <div class="seg" id="diceSide"><button data-s="UNDER" class="active">Roll Under</button><button data-s="OVER">Roll Over</button></div>
    <div class="fld"><label>Target: <span id="diceTval">50</span></label><input id="diceTarget" type="range" min="2" max="98" value="50" style="width:100%" /></div>
    <div class="fld"><label>Bet (₹)</label><input id="diceAmt" type="number" value="10" /></div>
    <div class="chips">${[10, 20, 50, 100].map(v => `<button data-da="${v}">${v}</button>`).join('')}</div>
    <button class="big-btn" id="diceRoll">Roll</button>`);

  let side = 'UNDER';
  const upd = () => {
    const t = Number(document.getElementById('diceTarget').value);
    document.getElementById('diceTval').textContent = t;
    const chance = side === 'UNDER' ? (t - 1) : (99 - t);
    document.getElementById('diceChance').textContent = chance + '%';
    document.getElementById('dicePay').textContent = (0.97 / (chance / 100)).toFixed(2) + '×';
    const fill = document.getElementById('diceFill');
    fill.style.background = side === 'UNDER' ? '#2dc44e' : '#e84242';
    fill.style.left = side === 'UNDER' ? '0' : t + '%';
    fill.style.right = side === 'UNDER' ? (100 - t) + '%' : '0';
    fill.style.width = ''; // use left/right
  };
  document.getElementById('diceTarget').oninput = upd;
  sheet.querySelectorAll('#diceSide button').forEach(b => b.onclick = () => { side = b.dataset.s; sheet.querySelectorAll('#diceSide button').forEach(x => x.classList.toggle('active', x === b)); upd(); });
  sheet.querySelectorAll('[data-da]').forEach(b => b.onclick = () => { document.getElementById('diceAmt').value = b.dataset.da; });
  upd();

  document.getElementById('diceRoll').onclick = async () => {
    const amount = Number(document.getElementById('diceAmt').value);
    const target = Number(document.getElementById('diceTarget').value);
    try {
      const d = await papi('/api/play/dice', { method: 'POST', body: { amount, side, target } });
      setBalance(d.balance);
      const res = document.getElementById('diceRes');
      res.textContent = d.roll;
      res.className = 'dice-result ' + (d.win ? 'win-flash' : 'lose-flash');
      document.getElementById('diceMark').style.left = d.roll + '%';
      toast(d.win ? `🎉 Win ${fmt(d.payout)} (${d.roll})` : `Lost — rolled ${d.roll}`);
    } catch (e) { toast(diceErr(e)); }
  };
}
const diceErr = (e) => ({ insufficient: '💸 Insufficient balance', maintenance: '🚧 Games paused', bet_range: `Bet ₹${e.data?.min}–₹${e.data?.max}`, bad_target: 'Pick target 2–98', suspended: '🚫 Account suspended' }[e.data?.error] || 'Failed');

function openSlots() {
  openSheet('🎰 Slots', `
    <div class="reels"><div class="reel" id="r0">🎰</div><div class="reel" id="r1">🎰</div><div class="reel" id="r2">🎰</div></div>
    <div class="dice-result" id="slotRes" style="font-size:18px">Spin to play</div>
    <div class="fld"><label>Bet (₹)</label><input id="slotAmt" type="number" value="10" /></div>
    <div class="chips">${[10, 20, 50, 100].map(v => `<button data-sa="${v}">${v}</button>`).join('')}</div>
    <button class="big-btn alt" id="slotSpin">Spin</button>
    <div class="note" id="slotPay"></div>`);
  papi('/api/play/slots/symbols').then(syms => {
    document.getElementById('slotPay').textContent = 'Match 3: ' + syms.map(s => `${s.symbol}×${s.pay}`).join('  ');
  }).catch(() => {});
  sheet.querySelectorAll('[data-sa]').forEach(b => b.onclick = () => { document.getElementById('slotAmt').value = b.dataset.sa; });
  document.getElementById('slotSpin').onclick = async () => {
    const amount = Number(document.getElementById('slotAmt').value);
    const reels = ['r0', 'r1', 'r2'].map(id => document.getElementById(id));
    const spin = setInterval(() => reels.forEach(r => r.textContent = ['🍒', '🍋', '🔔', '⭐', '💎', '7️⃣', '🎰'][Math.floor(Math.random() * 7)]), 80);
    try {
      const d = await papi('/api/play/slots', { method: 'POST', body: { amount } });
      setTimeout(() => {
        clearInterval(spin);
        reels.forEach((r, i) => r.textContent = d.reels[i]);
        setBalance(d.balance);
        const res = document.getElementById('slotRes');
        res.textContent = d.win ? `🎉 WIN ${fmt(d.payout)} (${d.mult}×)` : 'No match';
        res.className = 'dice-result ' + (d.win ? 'win-flash' : 'lose-flash');
        res.style.fontSize = '18px';
      }, 600);
    } catch (e) { clearInterval(spin); toast(diceErr(e)); }
  };
}

function openMines() {
  openSheet('💣 Mines', `
    <div class="stat-row"><span class="k">Multiplier</span><span id="mMult">1.00×</span></div>
    <div class="stat-row"><span class="k">Cash out</span><span id="mCash">—</span></div>
    <div class="mines-grid" id="mGrid"></div>
    <div id="mSetup">
      <div class="fld"><label>Mines: <span id="mNval">3</span></label><input id="mN" type="range" min="1" max="19" value="3" style="width:100%" /></div>
      <div class="fld"><label>Bet (₹)</label><input id="mAmt" type="number" value="10" /></div>
      <div class="chips">${[10, 20, 50, 100].map(v => `<button data-ma="${v}">${v}</button>`).join('')}</div>
      <button class="big-btn" id="mStart">Start game</button>
    </div>
    <button class="big-btn alt hidden" id="mCashBtn">Cash out</button>`);

  const grid = document.getElementById('mGrid');
  const drawGrid = (revealed = [], disabled = false, bombs = null) => {
    grid.innerHTML = '';
    for (let i = 0; i < 20; i++) {
      const t = document.createElement('div');
      const isGem = revealed.includes(i);
      const isBomb = bombs && bombs.includes(i);
      t.className = 'mtile' + (isGem ? ' gem done' : '') + (isBomb ? ' bomb done' : '') + (disabled ? ' done' : '');
      t.textContent = isGem ? '💎' : isBomb ? '💣' : '';
      if (!disabled && !isGem) t.onclick = () => reveal(i);
      grid.appendChild(t);
    }
  };
  const setActive = (active) => {
    document.getElementById('mSetup').classList.toggle('hidden', active);
    document.getElementById('mCashBtn').classList.toggle('hidden', !active);
  };
  const upd = (mult, next) => {
    document.getElementById('mMult').textContent = Number(mult).toFixed(2) + '×';
    if (next != null) document.getElementById('mCash').textContent = 'next ' + Number(next).toFixed(2) + '×';
  };
  document.getElementById('mN').oninput = (e) => document.getElementById('mNval').textContent = e.target.value;
  sheet.querySelectorAll('[data-ma]').forEach(b => b.onclick = () => document.getElementById('mAmt').value = b.dataset.ma);
  drawGrid();

  async function reveal(idx) {
    try {
      const d = await papi('/api/play/mines/reveal', { method: 'POST', body: { idx } });
      if (d.bomb) { drawGrid([], true, d.bombs); setBalance(d.balance); upd(0); setActive(false); toast('💥 Boom! Bet lost'); return; }
      drawGrid(d.revealed); upd(d.multiplier, d.next);
    } catch (e) { toast(diceErr(e)); }
  }
  document.getElementById('mStart').onclick = async () => {
    const amount = Number(document.getElementById('mAmt').value);
    const mines = Number(document.getElementById('mN').value);
    try {
      const d = await papi('/api/play/mines/start', { method: 'POST', body: { amount, mines } });
      setBalance(d.balance); setActive(true); drawGrid([]); upd(1, null);
      document.getElementById('mCash').textContent = '—';
    } catch (e) { toast({ active_game: 'Finish your current mines game first', ...{} }[e.data?.error] || diceErr(e)); }
  };
  document.getElementById('mCashBtn').onclick = async () => {
    try { const d = await papi('/api/play/mines/cashout', { method: 'POST' }); setBalance(d.balance); drawGrid([], true, d.bombs); setActive(false); toast(`💰 Cashed out ${fmt(d.payout)} (${Number(d.multiplier).toFixed(2)}×)`); }
    catch (e) { toast({ no_gems: 'Reveal at least one tile first' }[e.data?.error] || 'Cash out failed'); }
  };

  // resume an in-progress game if one exists
  papi('/api/play/mines/state').then(st => {
    if (st.active) { setActive(true); drawGrid(st.revealed); upd(st.multiplier, st.next); }
  }).catch(() => {});
}

let colourES = null;
function openColour() {
  openSheet('🎨 Colour', `
    <div class="col-timer" id="colTimer">—</div>
    <div class="col-winner hidden" id="colWinner"></div>
    <div class="col-hist" id="colHist"></div>
    <div class="col-pads" id="colPads">
      <div class="col-pad green" data-k="green">Green<small>2×</small></div>
      <div class="col-pad violet" data-k="violet">Violet<small>8×</small></div>
      <div class="col-pad red" data-k="red">Red<small>2×</small></div>
    </div>
    <div class="stat-row"><span class="k">Your bet</span><span id="colYou">none</span></div>
    <div class="fld"><label>Bet (₹)</label><input id="colAmt" type="number" value="10" /></div>
    <div class="chips">${[10, 20, 50, 100].map(v => `<button data-ca="${v}">${v}</button>`).join('')}</div>`);
  sheet.querySelectorAll('[data-ca]').forEach(b => b.onclick = () => document.getElementById('colAmt').value = b.dataset.ca);

  let offset = 0, phase = 'betting', endsAt = 0, myBet = null;
  const cnow = () => Date.now() + offset;
  const renderHist = (h) => { document.getElementById('colHist').innerHTML = h.map(w => `<div class="col-dot col-${w}"></div>`).join(''); };
  const setYou = () => document.getElementById('colYou').textContent = myBet ? `${fmt(myBet.stake)} on ${myBet.key}` : 'none';

  sheet.querySelectorAll('.col-pad').forEach(p => p.onclick = async () => {
    if (phase !== 'betting' || myBet) return;
    const amount = Number(document.getElementById('colAmt').value);
    try { const d = await papi('/api/play/colour/bet', { method: 'POST', body: { amount, key: p.dataset.k } }); setBalance(d.balance); }
    catch (e) { toast({ betting_closed: 'Betting closed', already_bet: 'Already bet this round', insufficient: '💸 Insufficient', maintenance: '🚧 Paused' }[e.data?.error] || 'Bet failed'); }
  });

  if (colourES) colourES.close();
  colourES = new EventSource('/api/play/colour/stream');
  colourES.addEventListener('state', (e) => {
    const d = JSON.parse(e.data); offset = d.serverTime - Date.now(); phase = d.phase; endsAt = d.bettingEndsAt;
    if (d.history) renderHist(d.history);
    const win = document.getElementById('colWinner');
    if (phase === 'result' && d.winner) { win.textContent = `Winner: ${d.winner.toUpperCase()}`; win.className = 'col-winner col-' + d.winner; win.classList.remove('hidden'); myBet = null; setYou(); }
    else { win.classList.add('hidden'); }
    document.getElementById('colPads').classList.toggle('disabled', phase !== 'betting');
  });
  colourES.addEventListener('sync', (e) => { offset = JSON.parse(e.data).serverTime - Date.now(); });
  colourES.addEventListener('you', (e) => { myBet = JSON.parse(e.data).bet; setYou(); });
  colourES.addEventListener('wallet', (e) => setBalance(JSON.parse(e.data).balance));

  const tmr = setInterval(() => {
    if (!sheet.querySelector('#colTimer')) { clearInterval(tmr); if (colourES) { colourES.close(); colourES = null; } return; }
    document.getElementById('colTimer').textContent = phase === 'betting' ? Math.max(0, Math.ceil((endsAt - cnow()) / 1000)) + 's' : '⏳';
  }, 200);
}

$('#btnGames').onclick = openLobby;

// ── Provably-fair verify ────────────────────────────────────────────────────────
let currentRoundId = null, lastRoundId = null;
async function openVerify() {
  openSheet('🔒 Provably fair', '<div class="muted">Loading…</div>');
  const card = async (id, label) => {
    if (!id) return `<div class="stat-card"><b>${label}</b><div class="muted">none yet</div></div>`;
    try {
      const r = await papi('/api/play/round/' + id);
      const w = r.outcome ? (r.outcome.crashAt ? r.outcome.crashAt + '×' : (r.outcome.winner || '')) : '';
      return `<div class="stat-card"><b>${label}</b>
        <div class="stat-row"><span class="k">Round</span><span style="font-size:11px">${esc(id)}</span></div>
        <div class="stat-row"><span class="k">Seed hash</span><span style="font-size:10px;word-break:break-all">${esc(r.server_seed_hash || '')}</span></div>
        ${r.server_seed ? `<div class="stat-row"><span class="k">Revealed seed</span><span style="font-size:10px;word-break:break-all">${esc(r.server_seed)}</span></div>` : '<div class="muted">Seed reveals after the round ends.</div>'}
        ${w ? `<div class="stat-row"><span class="k">Outcome</span><span>${esc(w)}</span></div>` : ''}</div>`;
    } catch { return `<div class="stat-card"><b>${label}</b><div class="muted">unavailable</div></div>`; }
  };
  document.getElementById('sheetBody').innerHTML = `<div class="note">Each round's seed is hashed and shown before it starts, then revealed after — so outcomes can't be changed mid-round.</div>` + (await card(lastRoundId, 'Last finished round')) + (await card(currentRoundId, 'Current round'));
}
const fairBtn = document.getElementById('btnFair');
if (fairBtn) fairBtn.onclick = openVerify;

// ── boot ──────────────────────────────────────────────────────────────────────
resizeCanvas();
refreshBalance();
connect();
updateAllActions();
requestAnimationFrame(frame);
