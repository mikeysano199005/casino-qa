// Aviator web client — renders the server-authoritative round and places real bets.
const $ = (s) => document.querySelector(s);
const fmt = (paise) => '₹' + (Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── state ───────────────────────────────────────────────────────────────────
let clockOffset = 0;                 // serverTime - localTime
const now = () => Date.now() + clockOffset;
let phase = 'waiting';
let startTime = null;                // server ms when flight started
let bettingEndsAt = null;
let crashAt = null;                  // revealed only on crash
let myBet = null;                    // { stake, cashedOut, cashOutAt, payout }
let betVal = 10;                     // rupees in panel 0
let trail = [];
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
    clockOffset = d.serverTime - Date.now();
    const prevPhase = phase;
    phase = d.phase;
    startTime = d.startTime;
    bettingEndsAt = d.bettingEndsAt;
    crashAt = d.crashAt;
    if (d.history) renderHistory(d.history);
    if (d.viewers != null) $('#viewerCount').textContent = d.viewers;

    if (phase === 'betting' && prevPhase !== 'betting') {
      trail = []; myBet = null;
      $('#flewAway').classList.add('hidden');
      $('#multiplier').classList.add('hidden');
    }
    if (phase === 'flying') {
      $('#flewAway').classList.add('hidden');
      $('#multiplier').classList.remove('hidden');
    }
    if (phase === 'crashed') {
      $('#crashMult').textContent = (crashAt || 0).toFixed(2) + 'x';
      $('#flewAway').classList.remove('hidden');
      $('#multiplier').classList.add('hidden');
      refreshBalance(); // reflect any loss
    }
    updateAction();
  });
  es.addEventListener('sync', (e) => { const d = JSON.parse(e.data); clockOffset = d.serverTime - Date.now(); });
  es.addEventListener('bets', (e) => renderBets(JSON.parse(e.data)));
  es.addEventListener('you', (e) => { myBet = JSON.parse(e.data).bet; updateAction(); });
  es.onerror = () => {/* browser auto-reconnects */};
}

// ── canvas ────────────────────────────────────────────────────────────────────
const canvas = $('#game');
const ctx = canvas.getContext('2d');
const gameArea = $('#gameArea');
let raysCanvas = null;
const originX = () => canvas.width * 0.35;
const originY = () => canvas.height * 0.55;

function resizeCanvas() {
  const rect = gameArea.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width));
  canvas.height = Math.max(1, Math.floor(rect.height));

  // Pre-render faint rays once to an offscreen canvas.
  raysCanvas = document.createElement('canvas');
  raysCanvas.width = canvas.width; raysCanvas.height = canvas.height;
  const rc = raysCanvas.getContext('2d');
  rc.strokeStyle = 'rgba(255,255,255,0.022)';
  rc.lineWidth = 90;
  const ox = originX(), oy = originY(), len = canvas.width * 1.8, n = 28;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    rc.beginPath(); rc.moveTo(ox, oy);
    rc.lineTo(ox + Math.cos(a) * len, oy + Math.sin(a) * len);
    rc.stroke();
  }
}
window.addEventListener('load', resizeCanvas);
window.addEventListener('resize', resizeCanvas);

// Soft radial glow + the faint rays — drawn every frame as the background.
function drawBackground() {
  const ox = originX(), oy = originY();
  const glow = ctx.createRadialGradient(ox, oy, 0, ox, oy, 120);
  glow.addColorStop(0, 'rgba(255,255,255,0.06)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.beginPath(); ctx.arc(ox, oy, 120, 0, Math.PI * 2); ctx.fill();
  if (raysCanvas) ctx.drawImage(raysCanvas, 0, 0);
}

const lerp = (a, b, t) => a + (b - a) * t;

function planePos(progress) {
  const sx = canvas.width * 0.05, sy = canvas.height * 0.88;
  const ex = canvas.width * 0.72, ey = canvas.height * 0.22;
  return { x: lerp(sx, ex, progress), y: lerp(sy, ey, progress * progress) };
}

function drawPlane(x, y, crashed) {
  const s = 42;
  ctx.save();
  ctx.translate(x, y);
  if (crashed) ctx.rotate(0.5);
  // body
  ctx.beginPath();
  ctx.moveTo(s * 0.6, 0); ctx.lineTo(s * -0.3, s * -0.18); ctx.lineTo(s * -0.3, s * 0.18); ctx.closePath();
  ctx.fillStyle = crashed ? '#c03030' : '#e84242'; ctx.fill();
  // wings
  ctx.fillStyle = crashed ? '#a02020' : '#c03030';
  ctx.beginPath();
  ctx.moveTo(s * -0.05, s * -0.18); ctx.lineTo(s * -0.35, s * -0.45); ctx.lineTo(s * -0.55, s * -0.22); ctx.lineTo(s * -0.3, s * -0.08); ctx.closePath(); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(s * -0.05, s * 0.18); ctx.lineTo(s * -0.35, s * 0.45); ctx.lineTo(s * -0.55, s * 0.22); ctx.lineTo(s * -0.3, s * 0.08); ctx.closePath(); ctx.fill();
  ctx.restore();
}

function drawTrail() {
  if (trail.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(trail[0].x, trail[0].y);
  for (const p of trail) ctx.lineTo(p.x, p.y);
  ctx.strokeStyle = '#e84242'; ctx.lineWidth = 2.5; ctx.stroke();
  // gradient fill under the trail
  ctx.lineTo(trail[trail.length - 1].x, canvas.height);
  ctx.lineTo(trail[0].x, canvas.height);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, 'rgba(232,66,66,0)');
  g.addColorStop(1, 'rgba(232,66,66,0.18)');
  ctx.fillStyle = g; ctx.fill();
}

function frame() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBackground();

  if (phase === 'flying' && startTime) {
    const elapsed = now() - startTime;
    let mult = Math.pow(1.07, elapsed / 1000);
    if (crashAt && mult > crashAt) mult = crashAt;
    const progress = Math.min(1, elapsed / 8000);
    const p = planePos(progress);
    trail.push(p);
    if (trail.length > 120) trail.shift();
    drawTrail();
    drawPlane(p.x, p.y, false);
    $('#multiplier').textContent = mult.toFixed(2) + 'x';
    if (myBet && !myBet.cashedOut)
      $('#p0sub').textContent = fmt(Math.floor(Number(myBet.stake) * mult)) + ' @ ' + mult.toFixed(2) + 'x';
  } else if (phase === 'crashed') {
    drawTrail();
    const p = trail.length ? trail[trail.length - 1] : planePos(0.5);
    drawPlane(p.x, p.y, true);
  }
  // betting / waiting: background only (no plane, no trail)

  if (phase === 'betting') {
    const secs = bettingEndsAt ? Math.max(0, Math.ceil((bettingEndsAt - now()) / 1000)) : 0;
    const b = $('#statusBanner'); b.className = 'banner wait'; b.textContent = `Place your bets — ${secs}s`; b.classList.remove('hidden');
  } else {
    $('#statusBanner').classList.add('hidden');
  }

  requestAnimationFrame(frame);
}

// ── action button (panel 0 only) ──────────────────────────────────────────────
const p0 = document.querySelector('.bet-panel[data-panel="0"]');
const p0action = p0.querySelector('.action');
const p0main = p0action.querySelector('.action-main');
const p0sub = p0action.querySelector('.action-sub');
p0sub.id = 'p0sub';

function updateAction() {
  p0action.classList.remove('cashout');
  if (phase === 'betting' && !myBet) {
    p0action.disabled = false; p0main.textContent = 'Bet'; p0sub.textContent = betVal.toFixed(2) + ' ₹';
  } else if (phase === 'betting' && myBet) {
    p0action.disabled = true; p0main.textContent = 'Bet placed ✓'; p0sub.textContent = fmt(myBet.stake);
  } else if (phase === 'flying' && myBet && !myBet.cashedOut) {
    p0action.disabled = false; p0action.classList.add('cashout'); p0main.textContent = 'Cash Out'; p0sub.textContent = fmt(myBet.stake);
  } else if (myBet && myBet.cashedOut) {
    p0action.disabled = true; p0main.textContent = `Cashed @ ${myBet.cashOutAt.toFixed(2)}x`; p0sub.textContent = fmt(myBet.payout || 0);
  } else {
    p0action.disabled = true; p0main.textContent = 'Bet'; p0sub.textContent = betVal.toFixed(2) + ' ₹';
  }
}

async function doBet() {
  try {
    const r = await fetch('/api/play/bet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: betVal }) });
    const d = await r.json();
    if (!r.ok || !d.ok) return toast(errMsg(d.error));
    myBet = d.bet; setBalance(d.balance); updateAction();
  } catch { toast('Network error'); }
}
async function doCashout() {
  try {
    const r = await fetch('/api/play/cashout', { method: 'POST' });
    const d = await r.json();
    if (!r.ok || !d.ok) return toast(errMsg(d.error));
    myBet = { ...myBet, cashedOut: true, cashOutAt: d.multiplier, payout: d.payout };
    setBalance(d.balance); updateAction();
    toast(`Cashed out @ ${d.multiplier.toFixed(2)}x → ${fmt(d.payout)}`);
  } catch { toast('Network error'); }
}
p0action.addEventListener('click', () => {
  if (phase === 'flying' && myBet && !myBet.cashedOut) return doCashout();
  if (phase === 'betting' && !myBet) return doBet();
});

// ── steppers / quick picks ─────────────────────────────────────────────────────
function wirePanel(panel, functional) {
  const input = panel.querySelector('.amount');
  const sub = panel.querySelector('.action-sub');
  const setVal = (v) => {
    v = Math.max(1, Math.round(v * 100) / 100);
    input.value = v.toFixed(2);
    sub.textContent = v.toFixed(2) + ' ₹';
    if (functional) { betVal = v; if (phase === 'betting' && !myBet) p0sub.textContent = v.toFixed(2) + ' ₹'; }
  };
  panel.querySelector('[data-act="dec"]').onclick = () => setVal(parseFloat(input.value || '1') - 1);
  panel.querySelector('[data-act="inc"]').onclick = () => setVal(parseFloat(input.value || '0') + 1);
  panel.querySelectorAll('.quick button').forEach(b => b.onclick = () => setVal(Number(b.dataset.q)));
  input.onchange = () => setVal(parseFloat(input.value || '1'));
  panel.querySelectorAll('.ptab').forEach((t, i) => t.onclick = () => {
    panel.querySelectorAll('.ptab').forEach(x => x.classList.remove('active')); t.classList.add('active');
  });
}
wirePanel(p0, true);
wirePanel(document.querySelector('.bet-panel[data-panel="1"]'), false);
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active')); t.classList.add('active');
});

// ── boot ──────────────────────────────────────────────────────────────────────
resizeCanvas();
refreshBalance();
connect();
updateAction();
requestAnimationFrame(frame);
