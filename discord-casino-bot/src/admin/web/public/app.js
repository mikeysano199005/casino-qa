// Casino admin SPA — clean light theme. Talks to /api/admin/* (cookie auth).
const API = '/api/admin';
const view = document.getElementById('view');

// ── helpers ───────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/admin/login'; throw new Error('unauthorized'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'request failed'), { data });
  return data;
}
const fmt = (paise) => '₹' + (Number(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rupees = (paise) => Number(paise) / 100;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (d) => d ? new Date(d).toLocaleString() : '—';

function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  document.getElementById('toast').appendChild(t);
  setTimeout(() => t.remove(), 3800);
}
const ok = (m) => toast(m, 'ok');
const err = (m) => toast(typeof m === 'string' ? m : (m?.message || 'Error'), 'err');

function statusPill(s) {
  const map = { paid: 'green', success: 'green', active: 'green', approved: 'green',
    pending: 'amber', created: 'amber', rejected: 'red', failed: 'red', banned: 'red', flagged: 'amber' };
  return `<span class="pill pill-${map[s] || 'grey'}">${esc(s)}</span>`;
}

// ── modal ───────────────────────────────────────────────────────────────────
function openModal({ title, help, fields = [], confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modalRoot');
    const fieldHtml = fields.map(f => {
      const lbl = `<span class="lbl">${esc(f.label)}${f.hint ? `<span class="hint"> — ${esc(f.hint)}</span>` : ''}</span>`;
      if (f.type === 'select')
        return `<label class="field">${lbl}<select data-f="${f.name}">${f.options.map(o => `<option value="${esc(o.value)}" ${String(o.value) === String(f.value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
      if (f.type === 'textarea')
        return `<label class="field">${lbl}<textarea data-f="${f.name}" placeholder="${esc(f.placeholder || '')}">${esc(f.value || '')}</textarea></label>`;
      return `<label class="field">${lbl}<input data-f="${f.name}" type="${f.type || 'text'}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}" /></label>`;
    }).join('');
    root.innerHTML = `<div class="modal-overlay"><div class="modal">
      <div class="modal-head"><div class="modal-title">${esc(title)}</div>${help ? `<div class="modal-help">${esc(help)}</div>` : ''}</div>
      ${fields.length ? `<div class="modal-body">${fieldHtml}</div>` : ''}
      <div class="modal-foot"><button class="btn btn-ghost" data-cancel>Cancel</button>
        <button class="btn ${danger ? 'btn-red' : 'btn-primary'}" data-ok>${esc(confirmLabel)}</button></div>
    </div></div>`;
    const close = (val) => { root.innerHTML = ''; resolve(val); };
    root.querySelector('[data-cancel]').onclick = () => close(null);
    root.querySelector('.modal-overlay').onclick = (e) => { if (e.target.classList.contains('modal-overlay')) close(null); };
    root.querySelector('[data-ok]').onclick = () => {
      const values = {};
      root.querySelectorAll('[data-f]').forEach(el => values[el.dataset.f] = el.value.trim());
      close(values);
    };
    const first = root.querySelector('[data-f]'); if (first) first.focus();
  });
}
const confirmModal = (opts) => openModal({ confirmLabel: 'Yes', ...opts, fields: [] }).then(v => v !== null);

// ── CSV export ────────────────────────────────────────────────────────────
function exportCsv(filename, rows) {
  if (!rows.length) return err('Nothing to export');
  const cols = Object.keys(rows[0]);
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...rows.map(r => cols.map(c => escape(r[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
}

// ── nav / routing ───────────────────────────────────────────────────────────
const SECTIONS = [
  { id: 'overview', label: '📊 Overview', group: 'Main' },
  { id: 'withdrawals', label: '💸 Withdrawals', group: 'Money' },
  { id: 'deposits', label: '💰 Deposits', group: 'Money' },
  { id: 'transactions', label: '📒 Transactions', group: 'Money' },
  { id: 'users', label: '👤 Users', group: 'People' },
  { id: 'channels', label: '🔧 Channels & Config', group: 'Setup' },
  { id: 'presets', label: '🎛️ Presets', group: 'Setup' },
  { id: 'gamecontrol', label: '🎯 Game Control', group: 'Setup' },
  { id: 'promos', label: '🎟️ Promos', group: 'Setup' },
  { id: 'announce', label: '📣 Announce', group: 'Tools' },
  { id: 'controls', label: '🛠️ Bot Controls', group: 'Tools' },
];

function renderNav(active) {
  let html = '', lastGroup = '';
  for (const s of SECTIONS) {
    if (s.group !== lastGroup) { html += `<div class="nav-group-title">${s.group}</div>`; lastGroup = s.group; }
    html += `<a href="#${s.id}" class="nav-link ${s.id === active ? 'active' : ''}">${s.label}</a>`;
  }
  document.getElementById('nav').innerHTML = html;
}

let cleanup = null;       // per-route teardown (intervals)
let liveCharts = [];      // Chart.js instances to destroy on nav

function destroyRoute() {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  liveCharts.forEach(c => { try { c.destroy(); } catch {} });
  liveCharts = [];
}

const ROUTES = {};
function route() {
  destroyRoute();
  document.getElementById('sidebar').classList.remove('open');
  const id = (location.hash.slice(1) || 'overview').split('/')[0];
  renderNav(id);
  view.innerHTML = '<div class="muted" style="padding:40px">Loading…</div>';
  (ROUTES[id] || ROUTES.overview)().catch(e => { view.innerHTML = `<div class="card pad" style="color:var(--red)">Error: ${esc(e.message)}</div>`; });
}
window.addEventListener('hashchange', route);
document.getElementById('menuBtn').onclick = () => document.getElementById('sidebar').classList.toggle('open');

function header(title, sub) { return `<h1>${title}</h1>${sub ? `<p class="subtitle">${sub}</p>` : ''}`; }

// ── Overview ────────────────────────────────────────────────────────────────
ROUTES.overview = async () => {
  const render = (k) => {
    const kpi = (id, label, value, sub = '') => `<div class="kpi"><div class="label">${label}</div><div class="value" id="${id}">${value}</div><div class="sub">${sub}</div></div>`;
    return `
      ${header('Overview', '<span class="dot-live"></span>Live snapshot of your casino — updates every 5 seconds.')}
      <div class="grid kpi-grid" style="margin-bottom:18px">
        ${kpi('k-users', 'Total users', k.users, `+${k.new_users} in last 24h`)}
        ${kpi('k-dep', 'Deposits (24h)', fmt(k.dep24))}
        ${kpi('k-wd', 'Withdrawals (24h)', fmt(k.wd24))}
        ${kpi('k-ggr', 'House profit (24h)', fmt(k.ggr24))}
        ${kpi('k-pwd', 'Pending withdrawals', k.pending_wd)}
        ${kpi('k-live', 'Live game sessions', k.live_sessions)}
      </div>
      <div class="two-col">
        <div class="card pad"><h2>Deposits vs Withdrawals (7 days)</h2><div class="chart-box"><canvas id="chartMoney"></canvas></div></div>
        <div class="card pad"><h2>House profit per day</h2><div class="chart-box"><canvas id="chartGgr"></canvas></div></div>
      </div>
      <div class="two-col" style="margin-top:16px">
        <div class="card pad"><h2>🏆 Top players (by wagered)</h2><div id="topPlayers"></div></div>
        <div class="card pad"><h2>💥 Biggest wins</h2><div id="bigWins"></div></div>
      </div>`;
  };
  const k = await api('/kpis');
  view.innerHTML = render(k);

  // charts + tables
  const a = await api('/analytics?days=7');
  const moneyCtx = document.getElementById('chartMoney');
  if (moneyCtx) liveCharts.push(new Chart(moneyCtx, {
    type: 'line',
    data: { labels: a.money.map(r => r.d.slice(5)), datasets: [
      { label: 'Deposits', data: a.money.map(r => rupees(r.dep)), borderColor: '#16a34a', backgroundColor: '#dcfce7', tension: .3, fill: true },
      { label: 'Withdrawals', data: a.money.map(r => rupees(r.wd)), borderColor: '#dc2626', backgroundColor: '#fee2e2', tension: .3, fill: true },
    ] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
  }));
  const ggrCtx = document.getElementById('chartGgr');
  if (ggrCtx) liveCharts.push(new Chart(ggrCtx, {
    type: 'bar',
    data: { labels: a.ggr.map(r => r.d.slice(5)), datasets: [{ label: '₹ profit', data: a.ggr.map(r => rupees(r.ggr)), backgroundColor: '#2563eb' }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } },
  }));
  document.getElementById('topPlayers').innerHTML = `<div class="table-wrap"><table><tbody>${a.topPlayers.map(p => `<tr><td>${esc(p.username)}</td><td style="text-align:right">${fmt(p.total_wagered)}</td></tr>`).join('') || '<tr><td class="empty">No data</td></tr>'}</tbody></table></div>`;
  document.getElementById('bigWins').innerHTML = `<div class="table-wrap"><table><tbody>${a.biggestWins.map(w => `<tr><td>${esc(w.username)}</td><td>${esc(w.game)}</td><td style="text-align:right;color:var(--green)">+${fmt(w.net)}</td></tr>`).join('') || '<tr><td class="empty">No wins yet</td></tr>'}</tbody></table></div>`;

  // auto-refresh KPI numbers
  const tick = async () => {
    try {
      const nk = await api('/kpis');
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
      set('k-users', nk.users); set('k-dep', fmt(nk.dep24)); set('k-wd', fmt(nk.wd24));
      set('k-ggr', fmt(nk.ggr24)); set('k-pwd', nk.pending_wd); set('k-live', nk.live_sessions);
    } catch {}
  };
  const iv = setInterval(tick, 5000);
  cleanup = () => clearInterval(iv);
};

// ── Withdrawals ───────────────────────────────────────────────────────────────
ROUTES.withdrawals = async () => {
  const rows = await api('/withdrawals?status=pending');
  view.innerHTML = `${header('Pending withdrawals', 'Approve to pay out (funds are removed), or reject to refund the player.')}
    <div class="toolbar"><div class="spacer"></div><button class="btn btn-ghost btn-sm" id="csv">⬇ Export CSV</button></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>User</th><th>Amount</th><th>Method</th><th>Details</th><th>When</th><th></th></tr></thead>
    <tbody>${rows.map(w => {
      const details = w.upi_id ? esc(w.upi_id) : esc(Object.values(w.bank_details || {}).join(' • '));
      return `<tr>
        <td><b>${esc(w.username)}</b><div class="muted" style="font-size:11px">${esc(w.discord_id)}</div></td>
        <td><b>${fmt(w.amount)}</b></td><td>${w.upi_id ? '📱 UPI' : '🏦 Bank'}</td>
        <td class="muted">${details}</td><td class="muted">${ago(w.created_at)}</td>
        <td><div class="row-actions"><button class="btn btn-green btn-sm" data-approve="${w.id}">Approve</button><button class="btn btn-red btn-sm" data-reject="${w.id}">Reject</button></div></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="empty">No pending withdrawals 🎉</td></tr>'}</tbody></table></div></div>`;
  document.getElementById('csv').onclick = () => exportCsv('withdrawals.csv', rows);

  view.querySelectorAll('[data-approve]').forEach(b => b.onclick = async () => {
    if (!await confirmModal({ title: 'Approve withdrawal?', help: 'The locked funds will be removed from the player (you pay them out manually offline). This cannot be undone.', confirmLabel: 'Approve & pay out' })) return;
    try { await api(`/withdrawals/${b.dataset.approve}/approve`, { method: 'POST' }); ok('Approved'); route(); } catch (e) { err(e); }
  });
  view.querySelectorAll('[data-reject]').forEach(b => b.onclick = async () => {
    const v = await openModal({ title: 'Reject withdrawal', help: 'The money goes back to the player’s wallet and they get a DM with your reason.', confirmLabel: 'Reject & refund', danger: true, fields: [{ name: 'note', label: 'Reason', type: 'textarea', placeholder: 'e.g. KYC not verified' }] });
    if (!v) return;
    try { await api(`/withdrawals/${b.dataset.reject}/reject`, { method: 'POST', body: { note: v.note } }); ok('Rejected & refunded'); route(); } catch (e) { err(e); }
  });
};

// ── Deposits ────────────────────────────────────────────────────────────────
ROUTES.deposits = async () => {
  const rows = await api('/deposits');
  view.innerHTML = `${header('Deposits', 'All deposit attempts and their status.')}
    <div class="toolbar"><div class="spacer"></div><button class="btn btn-ghost btn-sm" id="csv">⬇ Export CSV</button></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>User</th><th>Amount</th><th>Status</th><th>Order</th><th>Created</th><th>Credited</th></tr></thead>
    <tbody>${rows.map(d => `<tr><td><b>${esc(d.username || '—')}</b><div class="muted" style="font-size:11px">${esc(d.discord_id || '')}</div></td>
      <td>${fmt(d.amount)}</td><td>${statusPill(d.status)}</td><td class="muted" style="font-size:11px">${esc(d.cashfree_order_id)}</td>
      <td class="muted">${ago(d.created_at)}</td><td class="muted">${ago(d.credited_at)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No deposits</td></tr>'}</tbody></table></div></div>`;
  document.getElementById('csv').onclick = () => exportCsv('deposits.csv', rows);
};

// ── Transactions ──────────────────────────────────────────────────────────────
ROUTES.transactions = async () => {
  const rows = await api('/transactions');
  view.innerHTML = `${header('Transactions', 'The full money ledger across all users.')}
    <div class="toolbar"><div class="spacer"></div><button class="btn btn-ghost btn-sm" id="csv">⬇ Export CSV</button></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th>Amount</th><th>Balance after</th><th>Status</th></tr></thead>
    <tbody>${rows.map(t => `<tr><td class="muted">${ago(t.created_at)}</td><td>${esc(t.type)}</td><td>${fmt(t.amount)}</td><td>${fmt(t.balance_after)}</td><td>${statusPill(t.status || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No transactions</td></tr>'}</tbody></table></div></div>`;
  document.getElementById('csv').onclick = () => exportCsv('transactions.csv', rows);
};

// ── Users ────────────────────────────────────────────────────────────────────
ROUTES.users = async () => {
  view.innerHTML = `${header('Users', 'Search a player to view their wallet and manage their account.')}
    <div class="toolbar"><input id="usearch" placeholder="Search by Discord ID or username" style="max-width:340px" />
      <button class="btn btn-primary" id="ugo">Search</button><div class="spacer"></div><button class="btn btn-ghost btn-sm" id="csv">⬇ Export CSV</button></div>
    <div class="card"><div class="table-wrap" id="ulist"></div></div><div id="udetail" style="margin-top:16px"></div>`;
  let current = [];
  const list = async () => {
    const qv = document.getElementById('usearch').value.trim();
    current = await api('/users?search=' + encodeURIComponent(qv));
    document.getElementById('ulist').innerHTML = `<table><thead><tr><th>Username</th><th>Discord ID</th><th>Status</th><th>VIP</th><th>Available</th><th></th></tr></thead>
      <tbody>${current.map(u => `<tr><td><b>${esc(u.username)}</b></td><td class="muted">${esc(u.discord_id)}</td>
        <td>${statusPill(u.status)}</td><td>${u.vip_tier}</td><td>${fmt(u.available)}</td>
        <td><button class="btn btn-ghost btn-sm" data-open="${esc(u.discord_id)}">Open →</button></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No users found</td></tr>'}</tbody></table>`;
    document.getElementById('ulist').querySelectorAll('[data-open]').forEach(b => b.onclick = () => openUser(b.dataset.open));
  };
  document.getElementById('ugo').onclick = list;
  document.getElementById('csv').onclick = () => exportCsv('users.csv', current);
  document.getElementById('usearch').addEventListener('keydown', e => { if (e.key === 'Enter') list(); });
  await list();
};

async function openUser(discordId) {
  const u = await api('/users/' + encodeURIComponent(discordId));
  const tl = await api('/users/' + u.id + '/timeline').catch(() => []);
  const d = document.getElementById('udetail');
  const f = (label, val) => `<div><div class="muted" style="font-size:11px">${label}</div><div style="font-weight:600">${val}</div></div>`;
  d.innerHTML = `<div class="card pad">
    <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:14px">
      <div><div style="font-size:18px;font-weight:700">${esc(u.username)}</div><div class="muted" style="font-size:12px">${esc(u.discord_id)}</div></div>
      <div>${statusPill(u.status)}</div>
    </div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));margin-bottom:16px">
      ${f('Available', fmt(u.available))}${f('Locked', fmt(u.locked))}${f('Bonus locked', fmt(u.bonus_balance))}${f('Wager needed', fmt(u.wager_pending))}
      ${f('Deposited', fmt(u.total_deposited))}${f('Withdrawn', fmt(u.total_withdrawn))}${f('Wagered', fmt(u.total_wagered))}${f('Bets / net', `${u.bets} • ${fmt(u.net)}`)}
      ${f('VIP', u.vip_tier)}${f('Rig (preset)', u.user_preset || 'game default')}${f('Cooldown', u.withdraw_cooldown_hours != null ? u.withdraw_cooldown_hours + 'h' : 'global')}${f('Joined', ago(u.created_at))}
    </div>
    <div class="row-actions" style="margin-bottom:16px">
      <button class="btn btn-green btn-sm" data-act="credit">💸 Credit</button>
      <button class="btn btn-red btn-sm" data-act="debit">📤 Debit</button>
      <button class="btn btn-ghost btn-sm" data-act="ban">${u.status === 'banned' ? '✅ Unban' : '🚫 Ban'}</button>
      <button class="btn btn-ghost btn-sm" data-act="vip">⭐ VIP</button>
      <button class="btn btn-ghost btn-sm" data-act="preset">🎯 Rig outcome</button>
      <button class="btn btn-ghost btn-sm" data-act="cooldown">⏱️ Cooldown</button>
      <button class="btn btn-ghost btn-sm" data-act="resetcd">🔓 Reset CD</button>
    </div>
    <label class="field"><span class="lbl">📝 Private admin notes <span class="hint">— only visible here</span></span>
      <textarea id="unotes" placeholder="Notes about this player…">${esc(u.admin_notes || '')}</textarea></label>
    <button class="btn btn-primary btn-sm" id="saveNotes" style="margin-bottom:18px">Save notes</button>
    <h2>Money timeline</h2>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Type</th><th>Amount</th><th>Balance after</th></tr></thead>
      <tbody>${(tl || []).map(t => `<tr><td class="muted">${ago(t.created_at)}</td><td>${esc(t.type)}</td><td>${fmt(t.amount)}</td><td>${fmt(t.balance_after)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No activity</td></tr>'}</tbody></table></div>
  </div>`;

  document.getElementById('saveNotes').onclick = async () => {
    try { await api(`/users/${u.id}/notes`, { method: 'POST', body: { notes: document.getElementById('unotes').value } }); ok('Notes saved'); } catch (e) { err(e); }
  };

  const act = async (name) => {
    try {
      if (name === 'credit' || name === 'debit') {
        const v = await openModal({ title: name === 'credit' ? 'Credit balance' : 'Debit balance', help: name === 'credit' ? 'Add money to this player’s wallet.' : 'Remove money from this player’s wallet.', confirmLabel: name === 'credit' ? 'Credit' : 'Debit', danger: name === 'debit', fields: [{ name: 'amountRupees', label: 'Amount (₹)', type: 'number' }, { name: 'reason', label: 'Reason', hint: 'shown in audit log' }] });
        if (!v) return;
        await api(`/users/${u.id}/${name}`, { method: 'POST', body: v });
      } else if (name === 'ban') {
        if (!await confirmModal({ title: u.status === 'banned' ? 'Unban user?' : 'Ban user?', help: u.status === 'banned' ? 'They will be able to play again.' : 'They will be blocked from all games and DM’d.', danger: u.status !== 'banned' })) return;
        await api(`/users/${u.id}/ban`, { method: 'POST' });
      } else if (name === 'vip') {
        const v = await openModal({ title: 'Set VIP tier', help: '0 = None, 1 = Bronze, 2 = Silver, 3 = Gold, 4 = Platinum.', confirmLabel: 'Set', fields: [{ name: 'tier', label: 'Tier (0–4)', type: 'select', value: u.vip_tier, options: [0, 1, 2, 3, 4].map(n => ({ value: n, label: ['None', 'Bronze', 'Silver', 'Gold', 'Platinum'][n] })) }] });
        if (!v) return;
        await api(`/users/${u.id}/vip`, { method: 'POST', body: v });
      } else if (name === 'preset') {
        const v = await openModal({ title: 'Rig this player’s outcomes', help: 'Locks every per-bet game (dice, slots, mines, blackjack) to this preset for this user. “Clear” returns them to normal.', confirmLabel: 'Apply', fields: [{ name: 'preset', label: 'Preset', type: 'select', value: u.user_preset || 'clear', options: ['clear', 'house', 'low', 'medium', 'high', 'extreme'].map(p => ({ value: p, label: p === 'clear' ? 'Clear (normal)' : p })) }] });
        if (!v) return;
        await api(`/users/${u.id}/preset`, { method: 'POST', body: v });
      } else if (name === 'cooldown') {
        const v = await openModal({ title: 'Withdraw cooldown', help: 'Hours this player must wait between withdrawals. Blank = global default, 0 = no cooldown.', confirmLabel: 'Set', fields: [{ name: 'hours', label: 'Hours', placeholder: 'blank = default' }] });
        if (!v) return;
        await api(`/users/${u.id}/cooldown`, { method: 'POST', body: { hours: v.hours === '' ? null : Number(v.hours) } });
      } else if (name === 'resetcd') {
        await api(`/users/${u.id}/reset-cooldown`, { method: 'POST' });
      }
      ok('Done'); openUser(discordId);
    } catch (e) { err(e.data?.error || e.message); }
  };
  d.querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act));
}

// ── Channels & Config ─────────────────────────────────────────────────────────
ROUTES.channels = async () => {
  const [{ channels, config }, discord] = await Promise.all([api('/settings'), api('/discord/channels').catch(() => [])]);
  const applyTag = {
    live: '<span class="pill tag-live">applies instantly</span>',
    panel: '<span class="pill tag-repost">needs “Re-post panels”</span>',
    restart: '<span class="pill tag-restart">needs “Restart”</span>',
  };
  const channelOptions = (cur) => {
    let opts = '<option value="">— none —</option>';
    let found = false;
    for (const c of discord) { if (c.id === cur) found = true; opts += `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>#${esc(c.name)} (${c.guild})</option>`; }
    if (cur && !found) opts += `<option value="${esc(cur)}" selected>ID ${esc(cur)} (bot can’t see this)</option>`;
    return opts;
  };
  const groups = {};
  for (const c of channels) (groups[c.group] ??= []).push(c);

  const channelRow = (d) => `<div class="set-row">
    <div><div class="set-label">${esc(d.label)}</div><div class="set-desc">${d.apply ? applyTag[d.apply] : ''}</div></div>
    <div>${discord.length ? `<select data-key="${d.key}">${channelOptions(d.value)}</select>` : `<input data-key="${d.key}" value="${esc(d.value)}" placeholder="channel ID" />`}</div>
    <div class="muted" style="font-size:11px;text-align:right">${d.source === 'db' ? '✅ custom' : 'default'}</div></div>`;

  const configRow = (d) => `<div class="set-row">
    <div><div class="set-label">${esc(d.label)}</div></div>
    <div><input data-key="${d.key}" value="${esc(d.value)}" /></div>
    <div class="muted" style="font-size:11px;text-align:right">${d.source === 'db' ? '✅ custom' : 'default'}</div></div>`;

  view.innerHTML = `${header('Channels &amp; Config', 'Pick which Discord channel each feature posts to, and tune the money limits. Pick from the dropdown — no need to copy IDs.')}
    <div class="toolbar">
      <button class="btn btn-primary" id="save">💾 Save changes</button>
      <button class="btn btn-ghost" id="resync">🔁 Re-post panels</button>
      <button class="btn btn-red" id="restart">⟳ Apply &amp; Restart</button>
    </div>
    ${Object.entries(groups).map(([g, items]) => `<div class="card pad"><h2>${g} channels</h2>${items.map(channelRow).join('')}</div>`).join('')}
    <div class="card pad"><h2>Money limits</h2>${config.map(configRow).join('')}</div>`;

  const collect = () => {
    const values = {};
    view.querySelectorAll('[data-key]').forEach(el => values[el.dataset.key] = el.value.trim());
    return values;
  };
  document.getElementById('save').onclick = async () => {
    try { const r = await api('/settings', { method: 'PUT', body: { values: collect() } }); ok(`Saved ${r.saved.length} change(s)`); route(); } catch (e) { err(e); }
  };
  document.getElementById('resync').onclick = async () => {
    if (!await confirmModal({ title: 'Re-post panels?', help: 'Re-posts the wallet/game/admin panels into their current channels. Use this after changing a panel channel.' })) return;
    try { await api('/settings/resync-panels', { method: 'POST' }); ok('Panels re-posted'); } catch (e) { err(e); }
  };
  document.getElementById('restart').onclick = async () => {
    if (!await confirmModal({ title: 'Restart the bot?', help: 'Saves nothing on its own — save first if needed. The bot reconnects in ~15s and applies all channel changes (including game loops).', danger: true, confirmLabel: 'Restart now' })) return;
    try { await api('/settings/restart', { method: 'POST' }); ok('Restarting… reconnect in ~15s'); } catch (e) { err(e); }
  };
};

// ── Presets ──────────────────────────────────────────────────────────────────
ROUTES.presets = async () => {
  const data = await api('/presets');
  const GAMES = ['global', 'colour', 'crash', 'mines', 'dice', 'blackjack', 'slots', 'matka'];
  const MODES = ['house', 'low', 'medium', 'high', 'extreme', 'prediction'];
  const cur = Object.fromEntries(data.presets.map(p => [p.scope, p.mode]));
  const al = data.amountLimits || {};
  const sel = (g) => `<select data-scope="${g}">${MODES.map(m => `<option ${cur[g] === m ? 'selected' : ''}>${m}</option>`).join('')}</select>`;
  view.innerHTML = `${header('Presets', 'Control how much each game favours the house. “house” = fair, “low” = players win more, “high”/“extreme” = house wins more.')}
    <div class="card pad"><h2>Per-game outcome</h2>
      ${GAMES.map(g => `<div class="set-row"><div class="set-label">${g === 'global' ? '🌐 Global (default)' : g}</div><div>${sel(g)}</div><div></div></div>`).join('')}
    </div>
    <div class="card pad"><h2>Amount-based presets <button class="btn btn-sm ${al.enabled ? 'btn-green' : 'btn-ghost'}" id="amtToggle">${al.enabled ? 'Enabled' : 'Disabled'}</button></h2>
      <p class="subtitle">When on, bigger bets automatically use a tougher preset. Applies to Dice, Mines, Crash.</p>
      <div class="set-row"><div class="set-label">Medium tier preset</div><div><select id="medPreset">${MODES.map(m => `<option ${al.medium_preset === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div><div><button class="btn btn-primary btn-sm" id="saveMed">Save</button></div></div>
      <div class="set-row"><div class="set-label">Hard tier: bets above ₹<input id="hardAmt" style="width:90px;display:inline-block" value="${al.hard_min != null ? (al.hard_min / 100) : ''}" /></div><div><select id="hardPreset">${MODES.map(m => `<option ${al.hard_preset === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div><div><button class="btn btn-primary btn-sm" id="saveHard">Save</button></div></div>
    </div>
    <div class="card pad"><h2>Matka VIP predictions</h2><p class="subtitle">Whether prediction tips are posted each round.</p>
      <button class="btn ${data.predictionEnabled ? 'btn-green' : 'btn-ghost'}" id="predToggle">${data.predictionEnabled ? 'ON' : 'OFF'}</button></div>`;

  view.querySelectorAll('select[data-scope]').forEach(s => s.onchange = async () => {
    try { await api('/presets', { method: 'PUT', body: { scope: s.dataset.scope, mode: s.value } }); ok(`${s.dataset.scope} → ${s.value}`); } catch (e) { err(e); }
  });
  document.getElementById('amtToggle').onclick = async () => { await api('/amount-limits/toggle', { method: 'POST' }); route(); };
  document.getElementById('saveMed').onclick = async () => { try { await api('/amount-limits', { method: 'PUT', body: { tier: 'medium', preset: document.getElementById('medPreset').value } }); ok('Saved'); } catch (e) { err(e.data?.error || e.message); } };
  document.getElementById('saveHard').onclick = async () => { try { await api('/amount-limits', { method: 'PUT', body: { tier: 'hard', preset: document.getElementById('hardPreset').value, amountRupees: document.getElementById('hardAmt').value } }); ok('Saved'); } catch (e) { err(e.data?.error || e.message); } };
  document.getElementById('predToggle').onclick = async () => { await api('/prediction/toggle', { method: 'POST' }); route(); };
};

// ── Game Control ──────────────────────────────────────────────────────────────
ROUTES.gamecontrol = async () => {
  const [overrides, symbols] = await Promise.all([api('/slots-overrides'), api('/symbols').catch(() => [])]);
  view.innerHTML = `${header('Game Control', 'Force a specific slots result for a player. For other games, use “Rig outcome” on the player’s profile.')}
    <div class="card pad"><h2>Force a slots outcome</h2>
      <div class="row-actions">
        <button class="btn btn-green" id="forceWin">🏆 Force WIN</button>
        <button class="btn btn-red" id="forceLose">💀 Force LOSE</button>
        <button class="btn btn-ghost" id="forceSymbol">🎯 Force a symbol</button>
      </div>
    </div>
    <div class="card pad"><h2>Active overrides</h2>
      <div class="table-wrap"><table><thead><tr><th>User</th><th>Effect</th><th></th></tr></thead><tbody id="ovBody">
      ${overrides.map(o => `<tr><td class="muted">${esc(o.discordId)}</td><td>${o.mode === 'symbol' ? `Symbol ${esc(o.symbol)} (${o.pay}×)` : `${o.mode.toUpperCase()} × ${o.remaining} spin(s)`}</td><td><button class="btn btn-ghost btn-sm" data-clear="${esc(o.discordId)}">Clear</button></td></tr>`).join('') || '<tr><td colspan="3" class="empty">No active overrides</td></tr>'}
      </tbody></table></div></div>`;

  const setWinLose = async (mode) => {
    const v = await openModal({ title: `Force ${mode.toUpperCase()}`, help: `The player’s next spins will be forced to ${mode}.`, confirmLabel: 'Apply', fields: [{ name: 'discordId', label: 'Player Discord ID' }, { name: 'count', label: 'Number of spins (1–20)', type: 'number', value: 1 }] });
    if (!v) return;
    try { await api('/slots-overrides', { method: 'POST', body: { discordId: v.discordId, mode, count: v.count } }); ok('Override set'); route(); } catch (e) { err(e.data?.error || e.message); }
  };
  document.getElementById('forceWin').onclick = () => setWinLose('win');
  document.getElementById('forceLose').onclick = () => setWinLose('lose');
  document.getElementById('forceSymbol').onclick = async () => {
    const v = await openModal({ title: 'Force a symbol', help: 'The next spin will land three of this symbol.', confirmLabel: 'Apply', fields: [{ name: 'discordId', label: 'Player Discord ID' }, { name: 'symbolIndex', label: 'Symbol', type: 'select', options: symbols.map(s => ({ value: s.index, label: `${s.symbol} (${s.pay}×)` })) }] });
    if (!v) return;
    try { await api('/slots-overrides', { method: 'POST', body: { discordId: v.discordId, mode: 'symbol', symbolIndex: v.symbolIndex } }); ok('Override set'); route(); } catch (e) { err(e.data?.error || e.message); }
  };
  view.querySelectorAll('[data-clear]').forEach(b => b.onclick = async () => {
    try { await api('/slots-overrides/' + encodeURIComponent(b.dataset.clear), { method: 'DELETE' }); ok('Cleared'); route(); } catch (e) { err(e); }
  });
};

// ── Promos ───────────────────────────────────────────────────────────────────
ROUTES.promos = async () => {
  const rows = await api('/promos');
  view.innerHTML = `${header('Promo codes', 'Bonus codes players can redeem. Wager × is how many times they must bet the bonus before withdrawing.')}
    <div class="toolbar"><button class="btn btn-green" id="create">➕ Create code</button></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Code</th><th>Bonus</th><th>Wager</th><th>Uses</th><th>Active</th><th>Expires</th><th></th></tr></thead>
    <tbody>${rows.map(p => `<tr><td><code>${esc(p.code)}</code></td><td>${fmt(p.bonus_amount)}</td><td>${p.wager_mult}×</td><td>${p.uses_count}/${p.max_uses}</td><td>${p.active ? statusPill('active') : statusPill('rejected')}</td><td class="muted">${p.expires_at ? ago(p.expires_at) : 'never'}</td><td>${p.active ? `<button class="btn btn-red btn-sm" data-del="${p.id}">Disable</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">No codes yet</td></tr>'}</tbody></table></div></div>`;

  document.getElementById('create').onclick = async () => {
    const v = await openModal({ title: 'Create promo code', confirmLabel: 'Create', fields: [
      { name: 'code', label: 'Code', placeholder: 'WELCOME100' },
      { name: 'amountRupees', label: 'Bonus amount (₹)', type: 'number' },
      { name: 'wager', label: 'Wager multiplier', hint: 'e.g. 5 = must bet 5× the bonus', value: '5', type: 'number' },
      { name: 'maxuses', label: 'Max redemptions', value: '100', type: 'number' },
      { name: 'expiryDays', label: 'Expires in days', hint: 'blank = never' },
    ] });
    if (!v) return;
    try { await api('/promos', { method: 'POST', body: v }); ok('Promo created'); route(); } catch (e) { err(e.data?.error === 'duplicate' ? 'That code already exists' : (e.data?.error || e.message)); }
  };
  view.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!await confirmModal({ title: 'Disable this code?', danger: true })) return;
    try { await api('/promos/' + b.dataset.del, { method: 'DELETE' }); ok('Disabled'); route(); } catch (e) { err(e); }
  });
};

// ── Announce ─────────────────────────────────────────────────────────────────
ROUTES.announce = async () => {
  const discord = await api('/discord/channels').catch(() => []);
  view.innerHTML = `${header('Announce', 'Post a message to a channel, or DM it to every player.')}
    <div class="card pad" style="max-width:560px">
      <label class="field"><span class="lbl">Send to</span>
        <select id="target"><option value="all-dm">📩 DM all users</option>${discord.map(c => `<option value="${c.id}">#${esc(c.name)} (${c.guild})</option>`).join('')}</select></label>
      <label class="field"><span class="lbl">Message</span><textarea id="msg" placeholder="Type your announcement…"></textarea></label>
      <button class="btn btn-primary" id="send">📣 Send</button>
    </div>`;
  document.getElementById('send').onclick = async () => {
    const target = document.getElementById('target').value;
    const message = document.getElementById('msg').value.trim();
    if (!message) return err('Write a message first');
    if (target === 'all-dm' && !await confirmModal({ title: 'DM every user?', help: 'This sends a direct message to all registered players. Use sparingly.', danger: true, confirmLabel: 'Send to all' })) return;
    try { const r = await api('/announce', { method: 'POST', body: { target, message } }); ok(r.queued ? `Sending to ${r.queued} users…` : 'Sent'); document.getElementById('msg').value = ''; } catch (e) { err(e.data?.error || e.message); }
  };
};

// ── Bot Controls ──────────────────────────────────────────────────────────────
ROUTES.controls = async () => {
  const m = await api('/maintenance').catch(() => ({ enabled: false }));
  view.innerHTML = `${header('Bot Controls', 'Operational controls for the bot.')}
    <div class="card pad"><h2>Maintenance mode ${m.enabled ? statusPill('active') : '<span class="pill pill-grey">off</span>'}</h2>
      <p class="subtitle">When ON, players can’t play games (they see a “paused” message); wallet & support still work. Admins can still play.</p>
      <button class="btn ${m.enabled ? 'btn-red' : 'btn-green'}" id="maint">${m.enabled ? 'Turn OFF' : 'Turn ON'}</button></div>
    <div class="card pad"><h2>Panels</h2><p class="subtitle">Re-post the wallet/game/admin panels into their current channels.</p>
      <button class="btn btn-ghost" id="resync">🔁 Re-post panels</button></div>
    <div class="card pad"><h2>Restart</h2><p class="subtitle">Restarts the bot (reconnects in ~15s). Applies channel changes that need a restart.</p>
      <button class="btn btn-red" id="restart">⟳ Restart bot</button></div>`;
  document.getElementById('maint').onclick = async () => {
    if (!await confirmModal({ title: m.enabled ? 'Turn off maintenance?' : 'Turn on maintenance?', help: m.enabled ? 'Players can play again.' : 'Players will be blocked from games until you turn it off.', danger: !m.enabled })) return;
    try { const r = await api('/maintenance/toggle', { method: 'POST' }); ok(`Maintenance ${r.enabled ? 'ON' : 'OFF'}`); route(); } catch (e) { err(e); }
  };
  document.getElementById('resync').onclick = async () => { try { await api('/settings/resync-panels', { method: 'POST' }); ok('Panels re-posted'); } catch (e) { err(e); } };
  document.getElementById('restart').onclick = async () => {
    if (!await confirmModal({ title: 'Restart the bot?', danger: true, confirmLabel: 'Restart now' })) return;
    try { await api('/settings/restart', { method: 'POST' }); ok('Restarting… reconnect in ~15s'); } catch (e) { err(e); }
  };
};

route();
