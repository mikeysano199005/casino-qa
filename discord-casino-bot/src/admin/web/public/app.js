// Vanilla SPA for the casino admin panel. Talks to /api/admin/* (cookie auth).
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
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (d) => d ? new Date(d).toLocaleString() : '—';

function toast(msg, type = 'ok') {
  const t = document.createElement('div');
  t.className = `card px-4 py-2 text-sm ${type === 'err' ? 'border-red-600 text-red-300' : 'border-green-600 text-green-300'}`;
  t.textContent = msg;
  document.getElementById('toast').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}
const ok  = (m) => toast(m, 'ok');
const err = (m) => toast(m, 'err');

// ── nav / routing ───────────────────────────────────────────────────────────
const SECTIONS = [
  ['overview', '📊 Overview'],
  ['channels', '🔧 Channels & Config'],
  ['withdrawals', '💸 Withdrawals'],
  ['users', '👤 Users'],
  ['deposits', '💰 Deposits'],
  ['transactions', '📒 Transactions'],
  ['presets', '🎛️ Presets'],
  ['promos', '🎟️ Promos'],
];

function renderNav(active) {
  document.getElementById('nav').innerHTML = SECTIONS.map(([id, label]) =>
    `<a href="#${id}" class="nav-btn ${id === active ? 'active' : ''}">${label}</a>`).join('');
}

const ROUTES = {};
function route() {
  const id = (location.hash.slice(1) || 'overview').split('/')[0];
  renderNav(id);
  view.innerHTML = '<div class="text-gray-500">Loading…</div>';
  (ROUTES[id] || ROUTES.overview)().catch(e => { view.innerHTML = `<div class="text-red-400">Error: ${esc(e.message)}</div>`; });
}
window.addEventListener('hashchange', route);

// ── Overview ────────────────────────────────────────────────────────────────
ROUTES.overview = async () => {
  const [k, audit] = await Promise.all([api('/kpis'), api('/audit')]);
  const card = (label, value, sub = '') => `<div class="card p-4"><div class="text-gray-400 text-xs">${label}</div>
    <div class="text-2xl font-bold mt-1">${value}</div><div class="text-xs text-gray-500">${sub}</div></div>`;
  view.innerHTML = `
    <h1 class="text-xl font-bold mb-4">Overview</h1>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
      ${card('Users', k.users, `+${k.new_users} in 24h`)}
      ${card('Deposits 24h', fmt(k.dep24))}
      ${card('Withdrawals 24h', fmt(k.wd24))}
      ${card('GGR 24h', fmt(k.ggr24))}
      ${card('Pending withdrawals', k.pending_wd)}
      ${card('Live game sessions', k.live_sessions)}
    </div>
    <h2 class="font-semibold mb-2">Recent audit log</h2>
    <div class="card p-3 overflow-auto"><table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
    <tbody>${audit.map(a => `<tr><td>${ago(a.created_at)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td class="text-gray-400">${esc(a.target)}</td></tr>`).join('') || '<tr><td colspan=4 class="text-gray-500">No entries</td></tr>'}</tbody></table></div>`;
};

// ── Channels & Config ─────────────────────────────────────────────────────────
ROUTES.channels = async () => {
  const { channels, config } = await api('/settings');
  const applyTag = { live: '<span class="pill src-db">live</span>', panel: '<span class="pill src-env">re-post</span>', restart: '<span class="pill src-env">restart</span>' };
  const groups = {};
  for (const c of channels) (groups[c.group] ??= []).push(c);

  const field = (d) => `<div class="grid grid-cols-12 gap-2 items-center py-1">
      <label class="col-span-4 text-sm">${esc(d.label)} <span class="text-gray-600 text-xs">${d.key}</span></label>
      <div class="col-span-6"><input data-key="${d.key}" value="${esc(d.value)}" placeholder="(env default)" /></div>
      <div class="col-span-2 text-right text-xs">
        <span class="pill ${d.source === 'db' ? 'src-db' : 'src-env'}">${d.source}</span>
        ${d.apply ? (applyTag[d.apply] || '') : ''}
      </div></div>`;

  view.innerHTML = `
    <div class="flex items-center justify-between mb-4">
      <h1 class="text-xl font-bold">Channels &amp; Config</h1>
      <div class="space-x-2">
        <button id="save" class="btn btn-primary">💾 Save</button>
        <button id="resync" class="btn btn-ghost" title="Re-post static panels with new channel IDs">🔁 Re-post panels</button>
        <button id="restart" class="btn btn-red" title="Restart the bot so loop channels & all changes apply">⟳ Apply &amp; Restart</button>
      </div>
    </div>
    <p class="text-xs text-gray-500 mb-3">Leave a field blank to use the <code>.env</code> default. <b>live</b> = takes effect immediately • <b>re-post</b> = click Re-post panels • <b>restart</b> = click Apply &amp; Restart.</p>
    ${Object.entries(groups).map(([g, items]) => `<div class="card p-4 mb-4"><div class="font-semibold mb-2 text-blue-300">${g} channels</div>${items.map(field).join('')}</div>`).join('')}
    <div class="card p-4 mb-4"><div class="font-semibold mb-2 text-blue-300">Economy</div>${config.map(field).join('')}</div>`;

  const collect = () => {
    const values = {};
    view.querySelectorAll('input[data-key]').forEach(i => { values[i.dataset.key] = i.value.trim(); });
    return values;
  };
  document.getElementById('save').onclick = async () => {
    try { const r = await api('/settings', { method: 'PUT', body: { values: collect() } }); ok(`Saved ${r.saved.length} setting(s)`); route(); }
    catch (e) { err(e.message); }
  };
  document.getElementById('resync').onclick = async () => {
    try { await api('/settings/resync-panels', { method: 'POST' }); ok('Panels re-posted to current channels'); }
    catch (e) { err(e.message); }
  };
  document.getElementById('restart').onclick = async () => {
    if (!confirm('Save current values first if needed. Restart the bot now?')) return;
    try { await api('/settings/restart', { method: 'POST' }); ok('Restarting… reconnect in ~15s'); }
    catch (e) { err(e.message); }
  };
};

// ── Withdrawals ───────────────────────────────────────────────────────────────
ROUTES.withdrawals = async () => {
  const rows = await api('/withdrawals?status=pending');
  view.innerHTML = `<h1 class="text-xl font-bold mb-4">Pending withdrawals</h1>
    <div class="card p-3 overflow-auto"><table><thead><tr><th>User</th><th>Amount</th><th>Method</th><th>Details</th><th>When</th><th></th></tr></thead>
    <tbody>${rows.map(w => {
      const method = w.upi_id ? `UPI` : 'Bank';
      const details = w.upi_id ? esc(w.upi_id) : esc(JSON.stringify(w.bank_details || {}));
      return `<tr>
        <td>${esc(w.username)}<div class="text-gray-500 text-xs">${esc(w.discord_id)}</div></td>
        <td class="font-semibold">${fmt(w.amount)}</td>
        <td>${method}</td><td class="text-gray-400 text-xs">${details}</td>
        <td>${ago(w.created_at)}</td>
        <td class="text-right whitespace-nowrap">
          <button class="btn btn-green" data-approve="${w.id}">Approve</button>
          <button class="btn btn-red" data-reject="${w.id}">Reject</button>
        </td></tr>`;
    }).join('') || '<tr><td colspan=6 class="text-gray-500">No pending withdrawals</td></tr>'}</tbody></table></div>`;

  view.querySelectorAll('[data-approve]').forEach(b => b.onclick = async () => {
    if (!confirm('Approve this withdrawal? Funds will be burned (paid offline).')) return;
    try { await api(`/withdrawals/${b.dataset.approve}/approve`, { method: 'POST' }); ok('Approved'); route(); }
    catch (e) { err(e.message); }
  });
  view.querySelectorAll('[data-reject]').forEach(b => b.onclick = async () => {
    const note = prompt('Rejection reason (sent to the user):');
    if (note === null) return;
    try { await api(`/withdrawals/${b.dataset.reject}/reject`, { method: 'POST', body: { note } }); ok('Rejected & refunded'); route(); }
    catch (e) { err(e.message); }
  });
};

// ── Users ────────────────────────────────────────────────────────────────────
ROUTES.users = async () => {
  view.innerHTML = `<h1 class="text-xl font-bold mb-4">Users</h1>
    <div class="flex gap-2 mb-3 max-w-md"><input id="usearch" placeholder="Search by Discord ID or username" /><button id="ugo" class="btn btn-primary">Search</button></div>
    <div id="ulist" class="card p-3 overflow-auto"></div><div id="udetail" class="mt-4"></div>`;
  const list = async () => {
    const q = document.getElementById('usearch').value.trim();
    const rows = await api('/users?search=' + encodeURIComponent(q));
    document.getElementById('ulist').innerHTML = `<table><thead><tr><th>Username</th><th>Discord</th><th>Status</th><th>VIP</th><th>Available</th><th></th></tr></thead>
      <tbody>${rows.map(u => `<tr><td>${esc(u.username)}</td><td class="text-gray-500 text-xs">${esc(u.discord_id)}</td>
        <td>${u.status}</td><td>${u.vip_tier}</td><td>${fmt(u.available)}</td>
        <td class="text-right"><button class="btn btn-ghost" data-open="${esc(u.discord_id)}">Open</button></td></tr>`).join('') || '<tr><td colspan=6 class="text-gray-500">No users</td></tr>'}</tbody></table>`;
    document.getElementById('ulist').querySelectorAll('[data-open]').forEach(b => b.onclick = () => openUser(b.dataset.open));
  };
  document.getElementById('ugo').onclick = list;
  document.getElementById('usearch').addEventListener('keydown', e => { if (e.key === 'Enter') list(); });
  await list();
};

async function openUser(discordId) {
  const u = await api('/users/' + encodeURIComponent(discordId));
  const d = document.getElementById('udetail');
  const f = (label, val) => `<div><div class="text-xs text-gray-500">${label}</div><div class="font-semibold">${val}</div></div>`;
  d.innerHTML = `<div class="card p-4">
    <div class="flex justify-between items-start mb-3">
      <div><div class="text-lg font-bold">${esc(u.username)}</div><div class="text-xs text-gray-500">${esc(u.discord_id)} • ${esc(u.id)}</div></div>
      <div class="text-right"><span class="pill ${u.status === 'banned' ? 'src-env text-red-300' : 'src-db'}">${u.status}</span></div>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
      ${f('Available', fmt(u.available))}${f('Locked', fmt(u.locked))}${f('Bonus locked', fmt(u.bonus_balance))}${f('Wager needed', fmt(u.wager_pending))}
      ${f('Deposited', fmt(u.total_deposited))}${f('Withdrawn', fmt(u.total_withdrawn))}${f('Wagered', fmt(u.total_wagered))}${f('Bets / net', `${u.bets} • ${fmt(u.net)}`)}
      ${f('VIP tier', u.vip_tier)}${f('User preset', u.user_preset || 'game default')}${f('CD override', u.withdraw_cooldown_hours != null ? u.withdraw_cooldown_hours + 'h' : 'global')}${f('Joined', ago(u.created_at))}
    </div>
    <div class="flex flex-wrap gap-2">
      <button class="btn btn-green" data-act="credit">💸 Credit</button>
      <button class="btn btn-red" data-act="debit">📤 Debit</button>
      <button class="btn btn-ghost" data-act="ban">${u.status === 'banned' ? '✅ Unban' : '🚫 Ban'}</button>
      <button class="btn btn-ghost" data-act="vip">⭐ Set VIP</button>
      <button class="btn btn-ghost" data-act="preset">🎯 User preset</button>
      <button class="btn btn-ghost" data-act="cooldown">⏱️ Set cooldown</button>
      <button class="btn btn-ghost" data-act="resetcd">🔓 Reset CD</button>
      <button class="btn btn-ghost" data-act="bets">📜 Bet history</button>
    </div>
    <div id="ubets" class="mt-4"></div>
  </div>`;

  const act = async (name) => {
    try {
      if (name === 'credit' || name === 'debit') {
        const amt = prompt(`${name} amount in ₹:`); if (!amt) return;
        const reason = prompt('Reason (audit log):') || 'web admin';
        await api(`/users/${u.id}/${name}`, { method: 'POST', body: { amountRupees: amt, reason } });
      } else if (name === 'ban') {
        await api(`/users/${u.id}/ban`, { method: 'POST' });
      } else if (name === 'vip') {
        const tier = prompt('VIP tier 0=None 1=Bronze 2=Silver 3=Gold 4=Platinum:'); if (tier === null) return;
        await api(`/users/${u.id}/vip`, { method: 'POST', body: { tier } });
      } else if (name === 'preset') {
        const preset = prompt('Preset (house/low/medium/high/extreme) or "clear":'); if (preset === null) return;
        await api(`/users/${u.id}/preset`, { method: 'POST', body: { preset } });
      } else if (name === 'cooldown') {
        const hours = prompt('Cooldown hours (0 = none, blank = global default):');
        if (hours === null) return;
        await api(`/users/${u.id}/cooldown`, { method: 'POST', body: { hours: hours.trim() === '' ? null : Number(hours) } });
      } else if (name === 'resetcd') {
        await api(`/users/${u.id}/reset-cooldown`, { method: 'POST' });
      }
      ok('Done'); openUser(discordId);
    } catch (e) { err(e.data?.error || e.message); }
  };
  d.querySelectorAll('[data-act]').forEach(b => b.onclick = () => b.dataset.act === 'bets' ? showBets(u.id, 0) : act(b.dataset.act));
}

async function showBets(userId, page) {
  const { bets, hasNext } = await api(`/users/${userId}/bets?page=${page}`);
  document.getElementById('ubets').innerHTML = `<table><thead><tr><th>Game</th><th>Stake</th><th>Payout</th><th>Result</th><th>When</th></tr></thead>
    <tbody>${bets.map(b => `<tr><td>${esc(b.game)}</td><td>${fmt(b.stake)}</td><td>${fmt(b.payout)}</td><td>${b.result}</td><td>${ago(b.settled_at)}</td></tr>`).join('') || '<tr><td colspan=5 class="text-gray-500">No bets</td></tr>'}</tbody></table>
    <div class="mt-2 space-x-2"><button class="btn btn-ghost" ${page === 0 ? 'disabled' : ''} id="bprev">◀ Prev</button><button class="btn btn-ghost" ${hasNext ? '' : 'disabled'} id="bnext">Next ▶</button></div>`;
  const p = document.getElementById('bprev'); if (p) p.onclick = () => showBets(userId, page - 1);
  const n = document.getElementById('bnext'); if (n) n.onclick = () => showBets(userId, page + 1);
}

// ── Deposits ────────────────────────────────────────────────────────────────
ROUTES.deposits = async () => {
  const rows = await api('/deposits');
  view.innerHTML = `<h1 class="text-xl font-bold mb-4">Deposits</h1>
    <div class="card p-3 overflow-auto"><table><thead><tr><th>User</th><th>Amount</th><th>Status</th><th>Order ID</th><th>Created</th><th>Credited</th></tr></thead>
    <tbody>${rows.map(d => `<tr><td>${esc(d.username || '—')}<div class="text-gray-500 text-xs">${esc(d.discord_id || '')}</div></td>
      <td>${fmt(d.amount)}</td><td>${d.status}</td><td class="text-xs text-gray-400">${esc(d.cashfree_order_id)}</td>
      <td>${ago(d.created_at)}</td><td>${ago(d.credited_at)}</td></tr>`).join('') || '<tr><td colspan=6 class="text-gray-500">No deposits</td></tr>'}</tbody></table></div>`;
};

// ── Transactions ──────────────────────────────────────────────────────────────
ROUTES.transactions = async () => {
  const rows = await api('/transactions');
  view.innerHTML = `<h1 class="text-xl font-bold mb-4">Transactions</h1>
    <div class="card p-3 overflow-auto"><table><thead><tr><th>When</th><th>Type</th><th>Amount</th><th>Balance after</th><th>Status</th></tr></thead>
    <tbody>${rows.map(t => `<tr><td>${ago(t.created_at)}</td><td>${esc(t.type)}</td><td>${fmt(t.amount)}</td><td>${fmt(t.balance_after)}</td><td>${esc(t.status || '')}</td></tr>`).join('') || '<tr><td colspan=5 class="text-gray-500">No transactions</td></tr>'}</tbody></table></div>`;
};

// ── Presets ──────────────────────────────────────────────────────────────────
ROUTES.presets = async () => {
  const data = await api('/presets');
  const GAMES = ['global', 'colour', 'crash', 'mines', 'dice', 'blackjack', 'slots', 'matka'];
  const MODES = ['house', 'low', 'medium', 'high', 'extreme', 'prediction'];
  const cur = Object.fromEntries(data.presets.map(p => [p.scope, p.mode]));
  const al = data.amountLimits || {};
  view.innerHTML = `<h1 class="text-xl font-bold mb-4">Presets</h1>
    <div class="card p-4 mb-4"><div class="font-semibold mb-3 text-blue-300">Outcome presets</div>
      ${GAMES.map(g => `<div class="grid grid-cols-12 items-center gap-2 py-1">
        <div class="col-span-3 text-sm">${g}</div>
        <div class="col-span-9"><select data-scope="${g}">${MODES.map(m => `<option ${cur[g] === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div></div>`).join('')}
    </div>
    <div class="card p-4 mb-4"><div class="font-semibold mb-3 text-blue-300">Amount-based presets
      <button id="amtToggle" class="btn ${al.enabled ? 'btn-green' : 'btn-ghost'} ml-2">${al.enabled ? 'Enabled' : 'Disabled'}</button></div>
      <div class="grid grid-cols-12 gap-2 items-end">
        <div class="col-span-3"><div class="text-xs text-gray-500">Medium preset</div><select id="medPreset">${MODES.map(m => `<option ${al.medium_preset === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
        <div class="col-span-3"><div class="text-xs text-gray-500">Hard threshold (₹)</div><input id="hardAmt" value="${al.hard_min != null ? (al.hard_min / 100) : ''}" /></div>
        <div class="col-span-3"><div class="text-xs text-gray-500">Hard preset</div><select id="hardPreset">${MODES.map(m => `<option ${al.hard_preset === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
        <div class="col-span-3"><button id="saveMed" class="btn btn-primary w-full">Save medium</button></div>
        <div class="col-span-3 col-start-10"><button id="saveHard" class="btn btn-primary w-full">Save hard</button></div>
      </div>
    </div>
    <div class="card p-4"><div class="font-semibold mb-2 text-blue-300">Matka VIP predictions</div>
      <button id="predToggle" class="btn ${data.predictionEnabled ? 'btn-green' : 'btn-ghost'}">${data.predictionEnabled ? 'ON' : 'OFF'}</button></div>`;

  view.querySelectorAll('select[data-scope]').forEach(s => s.onchange = async () => {
    try { await api('/presets', { method: 'PUT', body: { scope: s.dataset.scope, mode: s.value } }); ok(`${s.dataset.scope} → ${s.value}`); }
    catch (e) { err(e.message); }
  });
  document.getElementById('amtToggle').onclick = async () => { await api('/amount-limits/toggle', { method: 'POST' }); route(); };
  document.getElementById('saveMed').onclick = async () => {
    try { await api('/amount-limits', { method: 'PUT', body: { tier: 'medium', preset: document.getElementById('medPreset').value } }); ok('Saved'); }
    catch (e) { err(e.data?.error || e.message); }
  };
  document.getElementById('saveHard').onclick = async () => {
    try { await api('/amount-limits', { method: 'PUT', body: { tier: 'hard', preset: document.getElementById('hardPreset').value, amountRupees: document.getElementById('hardAmt').value } }); ok('Saved'); }
    catch (e) { err(e.data?.error || e.message); }
  };
  document.getElementById('predToggle').onclick = async () => { await api('/prediction/toggle', { method: 'POST' }); route(); };
};

// ── Promos ───────────────────────────────────────────────────────────────────
ROUTES.promos = async () => {
  const rows = await api('/promos');
  view.innerHTML = `<h1 class="text-xl font-bold mb-4">Promo codes</h1>
    <div class="card p-4 mb-4"><div class="font-semibold mb-2 text-blue-300">Create code</div>
      <div class="grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
        <div><div class="text-xs text-gray-500">Code</div><input id="pc" placeholder="WELCOME100" /></div>
        <div><div class="text-xs text-gray-500">Bonus (₹)</div><input id="pa" /></div>
        <div><div class="text-xs text-gray-500">Wager ×</div><input id="pw" value="5" /></div>
        <div><div class="text-xs text-gray-500">Max uses</div><input id="pm" value="100" /></div>
        <div><div class="text-xs text-gray-500">Expiry (days)</div><input id="pe" placeholder="never" /></div>
      </div>
      <button id="pcreate" class="btn btn-green mt-3">➕ Create</button>
    </div>
    <div class="card p-3 overflow-auto"><table><thead><tr><th>Code</th><th>Bonus</th><th>Wager</th><th>Uses</th><th>Active</th><th>Expires</th><th></th></tr></thead>
    <tbody>${rows.map(p => `<tr><td class="font-mono">${esc(p.code)}</td><td>${fmt(p.bonus_amount)}</td><td>${p.wager_mult}×</td>
      <td>${p.uses_count}/${p.max_uses}</td><td>${p.active ? '✅' : '❌'}</td><td>${p.expires_at ? ago(p.expires_at) : 'never'}</td>
      <td class="text-right">${p.active ? `<button class="btn btn-red" data-del="${p.id}">Disable</button>` : ''}</td></tr>`).join('') || '<tr><td colspan=7 class="text-gray-500">No codes</td></tr>'}</tbody></table></div>`;

  document.getElementById('pcreate').onclick = async () => {
    try {
      await api('/promos', { method: 'POST', body: {
        code: document.getElementById('pc').value, amountRupees: document.getElementById('pa').value,
        wager: document.getElementById('pw').value, maxuses: document.getElementById('pm').value,
        expiryDays: document.getElementById('pe').value,
      } });
      ok('Promo created'); route();
    } catch (e) { err(e.data?.error || e.message); }
  };
  view.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Disable this promo code?')) return;
    try { await api('/promos/' + b.dataset.del, { method: 'DELETE' }); ok('Disabled'); route(); }
    catch (e) { err(e.message); }
  });
};

route();
