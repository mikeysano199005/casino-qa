# Discord Casino Bot — Setup & Deployment

A complete Discord-based casino: 6 games, wallet, Cashfree deposits, manual UPI/Bank withdrawals, admin server with approve/reject + presets, full audit logging, anti-fraud, and a Cashfree webhook server. **No slash commands** — every interaction is buttons + modals + ephemeral replies.

> ⚠️ Real-money gambling has serious legal requirements (licensing, KYC/AML, age-gating, responsible-gaming controls). You are responsible for compliance in your jurisdiction.

---

## 1. Prerequisites

- **Node.js 20+**
- A **Postgres 14+** database. Free options: Neon, Supabase Postgres, Railway, Render.
- A **Discord bot token** with the `bot` scope and **Administrator** (or at minimum: View Channels, Send Messages, Embed Links, Manage Messages, Read Message History).
  - Get one at https://discord.com/developers → New Application → Bot → Reset Token.
  - Invite URL template: `https://discord.com/oauth2/authorize?client_id=<APP_ID>&permissions=8&scope=bot`
- A **Cashfree** merchant account (sandbox is fine for testing).
- A **public HTTPS URL** for the webhook (use [ngrok](https://ngrok.com) locally, or deploy on Railway/Render/Fly).

---

## 2. Discord setup

You need **two servers** (or two categories — but the design assumes two guilds):

**Main server** — public — create these 5 channels and copy the IDs:
`#play  #wallet  #chat  #account  #support`

**Admin server** — private, invite only your team — create these 11 channels:
`#admin-panel  #withdraw-requests  #withdraw-history  #deposit-logs  #payment-errors  #bet-logs  #round-logs  #alerts  #suspicious  #audit-log  #bot-status`

Invite the **same bot** into both servers.

> Tip: enable Developer Mode in Discord (User Settings → Advanced) to right-click → Copy Channel ID.

---

## 3. Install & migrate

```bash
git clone <this folder>
cd discord-casino-bot
cp .env.example .env       # fill all values
npm install
npm run migrate            # creates tables + apply_transaction()
```

---

## 4. Run

```bash
npm start
```

On boot, the bot:
- Posts the wallet/play/account/support panels in the main channels.
- Posts the admin panel in `#admin-panel`.
- Starts the **Colour Prediction** and **Crash** round loops in `#play`.
- Starts the **Cashfree webhook server** on `WEBHOOK_PORT` (default `8787`).

For 24/7: use `pm2`, `systemd`, or Docker.

```bash
npm i -g pm2
pm2 start src/index.js --name casino
pm2 save
```

---

## 5. Cashfree configuration

In your Cashfree merchant dashboard:

- Webhook URL: `https://<your-public-host>/cashfree/webhook`
- Webhook secret: paste the same value as `CASHFREE_WEBHOOK_SECRET` in `.env`.
- Enable webhook events: `PAYMENT_SUCCESS_WEBHOOK`, `PAYMENT_FAILED_WEBHOOK`.

The webhook handler:
1. Verifies HMAC-SHA256 signature using `timestamp + body` → base64.
2. Looks up the deposit row (idempotent — refuses duplicate credit).
3. Verifies `payment_amount` matches the original order amount.
4. Only credits on `SUCCESS`.
5. Posts a record in `#deposit-logs`.

Failures get logged in `#payment-errors`.

---

## 6. Withdrawals

User flow (in `#wallet`): tap **Withdraw** → modal asks amount + UPI / Bank → bot **locks** the funds (moves available → locked) and posts an embed with **Approve** / **Reject** buttons in the admin server's `#withdraw-requests`.

Admin flow:
- **Approve** → bot debits the locked balance permanently and DM's the user. You then pay them out manually via UPI/IMPS — the bot does not auto-payout.
- **Reject** → opens a modal for a reason → refunds the locked balance back to available, DM's the user with the reason.

Every action goes through the atomic `apply_transaction()` Postgres function so balances stay consistent under concurrency.

---

## 7. Game presets

Admin panel → **Presets** → choose scope (`global`, `colour`, `crash`, `mines`, `dice`, `blackjack`, `slots`) and mode:

| Mode | Behaviour |
|---|---|
| **house** | Pure HMAC RNG (provably fair commit-reveal) |
| **low** | ~90% of rounds favour the side with the most user money / give the player free reveals |
| **medium** | 50/50 mix |
| **high** | ~95% of rounds the house wins (lowest-payout outcome / forces near-miss) |

Every preset change is recorded in `preset_history` and posted in `#audit-log`.

---

## 8. Anti-fraud

- **Token-bucket rate limit** — `MAX_BETS_PER_SECOND` per Discord user.
- **Withdraw cooldown** — `WITHDRAW_COOLDOWN_HOURS` between approved withdrawals.
- `fraud_signals` table for any custom alert you push in.

---

## 9. Database schema

See `migrations/001_init.sql`. Highlights:
- All money is **BIGINT paise** (no floats anywhere).
- `wallets.available + wallets.locked` is the user's total.
- `apply_transaction(user, type, amount, lockDelta, ref, meta)` does **`SELECT … FOR UPDATE`** + balance check + insert into `transactions` ledger in a single atomic call. Concurrent bets, deposits, and withdrawals can never double-spend.

---

## 10. File structure

```
discord-casino-bot/
├── migrations/001_init.sql
├── src/
│   ├── index.js                bot entry + interaction router
│   ├── repo.js                 db helpers
│   ├── cashfree.js             webhook server
│   ├── db/
│   │   ├── index.js            pg pool
│   │   └── migrate.js          run migrations
│   ├── util/
│   │   ├── money.js            paise math
│   │   ├── fairness.js         commit-reveal HMAC RNG
│   │   └── rateLimit.js        token bucket
│   ├── discord/
│   │   ├── embeds.js
│   │   └── buttons.js
│   ├── channels/
│   │   ├── play.js             game launcher
│   │   ├── wallet.js           deposit/withdraw/history
│   │   ├── account.js          profile + daily reward
│   │   └── support.js          rules
│   ├── games/
│   │   ├── outcome.js          preset-aware chooser
│   │   ├── colour.js           round loop 25s
│   │   ├── crash.js            multiplier loop
│   │   ├── mines.js            5x5 grid sessions
│   │   ├── dice.js             instant under/over
│   │   ├── blackjack.js        per-user session
│   │   └── slots.js            reels + paytable
│   └── admin/
│       ├── adminPanel.js       approve/reject + presets + KPIs
│       └── logs.js             channel-routed loggers
├── .env.example
├── package.json
└── README.md
```

---

## 11. Deploying on Railway / Render

1. Push this repo to GitHub.
2. Create a new **Web Service** (Node) pointing at this repo. Build = `npm install`, Start = `npm start`.
3. Attach a Postgres add-on; copy the connection string into `DATABASE_URL`.
4. Add all env vars from `.env.example`.
5. Public URL of the service → set as `PUBLIC_BASE_URL` and use it in Cashfree dashboard.
6. Run the migration once: `npm run migrate` (Railway lets you SSH; on Render use a one-off job).

---

## 12. Operating notes

- The bot posts **fresh panel messages on every boot**. To avoid clutter, delete old panel messages in each channel after a redeploy or assign each panel its own dedicated channel and clear the channel.
- Crash multiplier edits roughly once per 1.5s to respect Discord's per-channel edit rate limit.
- All player-private replies use `ephemeral: true` so the channel stays clean.

Good luck and play responsibly.
