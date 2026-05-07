import { EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { q } from '../db/index.js';
import { applyTx, logAudit } from '../repo.js';
import { fmt } from '../util/money.js';
import { logAuditMsg } from './logs.js';
import { handleUserPanelInteraction } from './userPanel.js';

const adminIds = () => (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const isAdmin = (id) => adminIds().includes(id);

export async function handleAdminInteraction(i) {
  // Withdrawal approve/reject buttons
  if (i.isButton() && i.customId.startsWith('wd:')) {
    if (!isAdmin(i.user.id)) return i.reply({ ephemeral: true, content: 'Not authorised.' });
    const [, action, wid] = i.customId.split(':');
    if (action === 'approve') return approveWithdraw(i, wid);
    if (action === 'reject')  return openRejectModal(i, wid);
  }
  if (i.isModalSubmit() && i.customId.startsWith('wd:rejectmodal:')) {
    if (!isAdmin(i.user.id)) return i.reply({ ephemeral: true, content: 'Not authorised.' });
    const wid = i.customId.split(':')[2];
    return rejectWithdraw(i, wid, i.fields.getTextInputValue('note'));
  }
  // Admin-panel buttons
  if (i.isButton() && i.customId.startsWith('admin:')) {
    if (!isAdmin(i.user.id)) return i.reply({ ephemeral: true, content: 'Not authorised.' });
    const [, action, ...rest] = i.customId.split(':');
    if (action === 'preset')        return openPresetMenu(i);
    if (action === 'setpreset')     return setPreset(i, rest[0], rest[1]);
    if (action === 'pendingwd')     return listPendingWithdraws(i);
    if (action === 'kpis')          return showKPIs(i);
    if (action === 'promos')        return listPromos(i);
    if (action === 'newpromo')      return openPromoModal(i);
    if (action === 'delpromo')      return deletePromo(i, rest[0]);
  }
  if (i.isModalSubmit() && i.customId === 'admin:newpromomodal') {
    if (!isAdmin(i.user.id)) return i.reply({ ephemeral: true, content: 'Not authorised.' });
    return createPromo(i);
  }
  // Delegate userpanel interactions
  if (i.customId.startsWith('userpanel:')) return handleUserPanelInteraction(i);
}

async function approveWithdraw(i, wid) {
  const { rows } = await q(`SELECT * FROM withdrawals WHERE id=$1`, [wid]);
  const w = rows[0];
  if (!w || w.status !== 'pending') return i.reply({ ephemeral: true, content: 'Already settled.' });
  // burn the locked funds (paid out manually offline)
  await applyTx({
    userId: w.user_id, type: 'withdraw', amount: -BigInt(w.amount), lockDelta: -BigInt(w.amount),
    ref: w.id, meta: { method: w.upi_id ? 'upi' : 'bank' },
  });
  await q(`UPDATE withdrawals SET status='paid', admin_id=$1, settled_at=now() WHERE id=$2`, [i.user.id, wid]);
  await logAudit(i.user.id, 'withdraw_approved', wid, null, { amount: w.amount });
  await i.update({ components: [], embeds: [...i.message.embeds.map(e => EmbedBuilder.from(e).setColor(Colors.Green).setTitle('✅ Approved'))] });
  // log to history
  const histChan = i.client.channels.cache.get(process.env.CH_WITHDRAW_HISTORY);
  if (histChan) histChan.send(`✅ Approved withdraw **${fmt(BigInt(w.amount))}** by <@${i.user.id}>`);
  // DM user
  try { const u = await i.client.users.fetch((await q(`SELECT discord_id FROM users WHERE id=$1`, [w.user_id])).rows[0].discord_id);
    u.send(`✅ Your withdraw of ${fmt(BigInt(w.amount))} has been approved and paid out.`); } catch {}
}

function openRejectModal(i, wid) {
  const m = new ModalBuilder().setCustomId(`wd:rejectmodal:${wid}`).setTitle('Reject reason');
  m.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('note').setLabel('Reason')
      .setStyle(TextInputStyle.Paragraph).setRequired(true)));
  return i.showModal(m);
}

async function rejectWithdraw(i, wid, note) {
  const { rows } = await q(`SELECT * FROM withdrawals WHERE id=$1`, [wid]);
  const w = rows[0];
  if (!w || w.status !== 'pending') return i.reply({ ephemeral: true, content: 'Already settled.' });
  // refund: release lock back to available
  await applyTx({ userId: w.user_id, type: 'refund', amount: 0n,
    lockDelta: -BigInt(w.amount), ref: w.id, meta: { kind: 'withdraw_reject', note } });
  await q(`UPDATE withdrawals SET status='rejected', admin_id=$1, admin_note=$2, settled_at=now() WHERE id=$3`,
    [i.user.id, note, wid]);
  await logAudit(i.user.id, 'withdraw_rejected', wid, null, { amount: w.amount, note });
  await i.reply({ ephemeral: true, content: 'Rejected and refunded.' });
  const histChan = i.client.channels.cache.get(process.env.CH_WITHDRAW_HISTORY);
  if (histChan) histChan.send(`❌ Rejected withdraw **${fmt(BigInt(w.amount))}** by <@${i.user.id}> — ${note}`);
  try { const u = await i.client.users.fetch((await q(`SELECT discord_id FROM users WHERE id=$1`, [w.user_id])).rows[0].discord_id);
    u.send(`❌ Your withdraw was rejected: ${note}\nFunds returned to wallet.`); } catch {}
}

export async function postAdminPanel(channel) {
  await channel.send({
    embeds: [new EmbedBuilder().setColor(Colors.DarkGold).setTitle('🛡️ Admin Panel')],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('admin:kpis').setLabel('📊 KPIs').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('admin:pendingwd').setLabel('💸 Withdrawals').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('admin:preset').setLabel('🎛️ Presets').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('userpanel:lookup').setLabel('👤 User Lookup').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('admin:promos').setLabel('🎟️ Promo Codes').setStyle(ButtonStyle.Success),
    )],
  });
}

async function openPresetMenu(i) {
  const games = ['global', 'colour', 'crash', 'mines', 'dice', 'blackjack', 'slots'];
  const modes = ['house', 'low', 'medium', 'high'];
  const makeRows = (list) => list.map(g =>
    new ActionRowBuilder().addComponents(
      ...modes.map(m => new ButtonBuilder()
        .setCustomId(`admin:setpreset:${g}:${m}`).setLabel(`${g}:${m}`)
        .setStyle(m === 'house' ? ButtonStyle.Secondary : m === 'low' ? ButtonStyle.Success : m === 'medium' ? ButtonStyle.Primary : ButtonStyle.Danger))
    )
  );
  // Discord max 5 action rows per message — split across two replies
  await i.reply({ ephemeral: true, content: 'Presets (1/2):', components: makeRows(games.slice(0, 5)) });
  if (games.length > 5) {
    await i.followUp({ ephemeral: true, content: 'Presets (2/2):', components: makeRows(games.slice(5)) });
  }
}

async function setPreset(i, scope, mode) {
  const { rows: prev } = await q(`SELECT mode FROM presets WHERE scope=$1`, [scope]);
  await q(
    `INSERT INTO presets(scope,mode,updated_by) VALUES($1,$2,$3)
     ON CONFLICT(scope) DO UPDATE SET mode=EXCLUDED.mode, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [scope, mode, i.user.id]
  );
  await q(`INSERT INTO preset_history(scope,old_mode,new_mode,changed_by) VALUES($1,$2,$3,$4)`,
    [scope, prev[0]?.mode || null, mode, i.user.id]);
  await logAudit(i.user.id, 'preset_change', scope, prev[0] || null, { mode });
  logAuditMsg(i.client, `Preset **${scope}** → **${mode}** by <@${i.user.id}>`);
  await i.reply({ ephemeral: true, content: `✅ ${scope} → ${mode}` });
}

async function listPendingWithdraws(i) {
  const { rows } = await q(`SELECT w.*, u.discord_id, u.username FROM withdrawals w
    JOIN users u ON u.id=w.user_id WHERE w.status='pending' ORDER BY w.created_at LIMIT 10`);
  if (!rows.length) return i.reply({ ephemeral: true, content: 'No pending withdrawals.' });
  const lines = rows.map(r => `• \`${r.id.slice(0,8)}\` — <@${r.discord_id}> — ${fmt(BigInt(r.amount))}`);
  await i.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(Colors.Orange)
    .setTitle('Pending withdrawals').setDescription(lines.join('\n'))] });
}

async function showKPIs(i) {
  const { rows: [k] } = await q(`SELECT
    (SELECT COUNT(*) FROM users) AS users,
    (SELECT COALESCE(SUM(amount),0)    FROM transactions WHERE type='deposit'  AND created_at > now() - interval '24 hours') AS dep24,
    (SELECT COALESCE(SUM(-amount),0)   FROM transactions WHERE type='withdraw' AND created_at > now() - interval '24 hours') AS wd24,
    (SELECT COALESCE(SUM(stake::bigint - payout::bigint),0) FROM bets         WHERE settled_at > now() - interval '24 hours') AS ggr24,
    (SELECT COUNT(*) FROM withdrawals WHERE status='pending') AS pending_wd
  `);
  await i.reply({ ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('📊 KPIs (24h)').addFields(
      { name: 'Users',         value: String(k.users),       inline: true },
      { name: 'Deposits 24h',  value: fmt(BigInt(k.dep24)),  inline: true },
      { name: 'Withdraws 24h', value: fmt(BigInt(k.wd24)),   inline: true },
      { name: 'GGR 24h',       value: fmt(BigInt(k.ggr24)),  inline: true },
      { name: 'Pending WD',    value: String(k.pending_wd),  inline: true },
    )] });
}

// ─── Promo code management ───────────────────────────────────────────

async function listPromos(i) {
  const { rows } = await q(
    `SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 15`
  );
  const embed = new EmbedBuilder().setColor(Colors.Gold).setTitle('🎟️ Promo Codes');
  if (!rows.length) {
    embed.setDescription('No promo codes yet.');
  } else {
    embed.setDescription(rows.map(p => {
      const status = !p.active ? '~~' : (p.expires_at && new Date(p.expires_at) < new Date() ? '⏰ ' : '✅ ');
      const expiry = p.expires_at ? ` • exp <t:${Math.floor(new Date(p.expires_at).getTime()/1000)}:R>` : '';
      return `${status}\`${p.code}\`~~ — ${fmt(BigInt(p.bonus_amount))} • ${p.wager_mult}× wager • ${p.uses_count}/${p.max_uses} uses${expiry}`;
    }).join('\n').replaceAll('~~\\`', '`').replaceAll('\\`~~', '`')); // cleanup bold formatting
  }

  const lines = rows.map(p => {
    const active = p.active && (!p.expires_at || new Date(p.expires_at) > new Date()) && p.uses_count < p.max_uses;
    return `${active ? '✅' : '❌'} \`${p.code}\` — ${fmt(BigInt(p.bonus_amount))} • ${p.wager_mult}× wager • ${p.uses_count}/${p.max_uses} uses`;
  });

  const components = [];
  if (rows.length) {
    const deactivateRow = new ActionRowBuilder().addComponents(
      ...rows.slice(0, 5).map(p =>
        new ButtonBuilder().setCustomId(`admin:delpromo:${p.id}`)
          .setLabel(`🗑️ ${p.code.slice(0, 10)}`).setStyle(ButtonStyle.Danger).setDisabled(!p.active)
      )
    );
    components.push(deactivateRow);
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('admin:newpromo').setLabel('➕ Create New Code').setStyle(ButtonStyle.Success)
  ));

  await i.reply({ ephemeral: true,
    embeds: [new EmbedBuilder().setColor(Colors.Gold).setTitle('🎟️ Promo Codes')
      .setDescription(lines.join('\n') || 'No codes yet.')],
    components,
  });
}

function openPromoModal(i) {
  const m = new ModalBuilder().setCustomId('admin:newpromomodal').setTitle('Create Promo Code');
  m.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('code').setLabel('Code (e.g. WELCOME100)')
      .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('amount').setLabel('Bonus amount in ₹')
      .setStyle(TextInputStyle.Short).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('wager').setLabel('Wagering multiplier (e.g. 5 = 5× bonus amount)')
      .setStyle(TextInputStyle.Short).setRequired(true).setValue('5')),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('maxuses').setLabel('Max redemptions (0 = unlimited)')
      .setStyle(TextInputStyle.Short).setRequired(true).setValue('100')),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('expiry').setLabel('Expires in days (blank = never)')
      .setStyle(TextInputStyle.Short).setRequired(false)),
  );
  return i.showModal(m);
}

async function createPromo(i) {
  try {
    await i.deferReply({ ephemeral: true });

    const code       = i.fields.getTextInputValue('code').trim().toUpperCase();
    const amount     = Number(i.fields.getTextInputValue('amount'));
    const wager      = Math.max(1, Math.floor(Number(i.fields.getTextInputValue('wager')) || 5));
    const maxuses    = Math.max(1, Math.floor(Number(i.fields.getTextInputValue('maxuses')) || 100));
    const expiryDays = i.fields.getTextInputValue('expiry')?.trim();
    const expiresAt  = expiryDays ? new Date(Date.now() + Number(expiryDays) * 86400_000) : null;

    if (!code || !Number.isFinite(amount) || amount <= 0)
      return i.editReply({ content: 'Invalid code or amount.' });

    const bonus = BigInt(Math.round(amount * 100));

    await q(
      `INSERT INTO promo_codes(code, bonus_amount, wager_mult, max_uses, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [code, String(bonus), Number(wager), Number(maxuses), expiresAt, String(i.user.id)]
    ).catch(e => {
      if (e.message.includes('unique')) throw Object.assign(new Error(`Code \`${code}\` already exists.`), { friendly: true });
      throw e;
    });

    await logAudit(i.user.id, 'promo_created', code, null, { bonus: String(bonus), wager, maxuses }).catch(() => {});

    return i.editReply({
      content: `✅ Promo \`${code}\` created — **${fmt(bonus)}** bonus • ${wager}× wager • ${maxuses} uses${expiresAt ? ` • expires <t:${Math.floor(expiresAt.getTime()/1000)}:R>` : ''}`
    });
  } catch (e) {
    console.error('[createPromo]', e);
    const msg = e.friendly ? e.message : `❌ Error: ${e.message?.slice(0, 200) ?? 'unknown'}`;
    try {
      if (i.deferred) await i.editReply({ content: msg });
      else await i.reply({ ephemeral: true, content: msg });
    } catch {}
  }
}

async function deletePromo(i, promoId) {
  await q(`UPDATE promo_codes SET active = FALSE WHERE id = $1`, [promoId]);
  await logAudit(i.user.id, 'promo_deactivated', promoId, null, {});
  return i.reply({ ephemeral: true, content: '✅ Promo code deactivated.' });
}
