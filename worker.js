import gameHtml from "./trap.html";

const SESSION_TTL = 60 * 60 * 24 * 30;
const MINI_APP_AUTH_MAX_AGE = 60 * 60 * 24;
const LIFE_PACKS = { 10: 1, 50: 7, 100: 15 };
const LIFE_BALANCE_VERSION = 2;
const TERMS_VERSION = 1;
const TERMS_TEXT = `TRAP TERMS & REFUND POLICY (version 1)

1. TRAP is a digital game. Life packs are digital goods sold only for Telegram Stars.
2. Purchased lives are credited after Telegram confirms a successful payment. Unused purchased lives remain attached to your Telegram account.
3. Launch-period refund policy: you may request a full refund through /paysupport. Refunds are processed by the bot operator. Telegram is not responsible for support or refunds.
4. When a purchase is refunded, any unused lives from that purchase may be removed from your paid-life reserve. A refund can also be granted after lives were used, at the operator's discretion.
5. Game progress, support messages, payment identifiers and refund records are stored against your Telegram user ID to operate the game, prevent duplicate delivery and provide support.
6. The service is provided as-is. Availability and game balance may change.

By purchasing a life pack, you confirm that you accept these terms. For general help use /support. For payment or refund help use /paysupport.`;
let schemaReady;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS players (
    user_id INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    progress_json TEXT NOT NULL,
    payment_version INTEGER NOT NULL DEFAULT 0,
    best_level INTEGER NOT NULL DEFAULT 0,
    best_deaths INTEGER NOT NULL DEFAULT 2147483647,
    best_score INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    chat_id INTEGER,
    message_id INTEGER,
    inline_message_id TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES players(user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  `CREATE TABLE IF NOT EXISTS invoices (
    payload TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    stars INTEGER NOT NULL,
    lives INTEGER NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES players(user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS payments (
    telegram_charge_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    payload TEXT NOT NULL,
    stars INTEGER NOT NULL,
    lives INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES players(user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS terms_acceptances (
    user_id INTEGER PRIMARY KEY,
    version INTEGER NOT NULL,
    accepted_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES players(user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    user_chat_id INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('support', 'payment')),
    status TEXT NOT NULL DEFAULT 'open',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES players(user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_support_tickets_user_status ON support_tickets(user_id, status, id)`,
  `CREATE TABLE IF NOT EXISTS support_messages (
    admin_message_id INTEGER PRIMARY KEY,
    ticket_id INTEGER NOT NULL,
    user_message_id INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(ticket_id) REFERENCES support_tickets(id)
  )`,
  `CREATE TABLE IF NOT EXISTS refunds (
    telegram_charge_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    stars INTEGER NOT NULL,
    lives INTEGER NOT NULL,
    requested_by INTEGER NOT NULL,
    status TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    requested_at INTEGER NOT NULL,
    completed_at INTEGER,
    error TEXT,
    FOREIGN KEY(telegram_charge_id) REFERENCES payments(telegram_charge_id)
  )`,
];

function now() {
  return Math.floor(Date.now() / 1000);
}

async function hmacSha256(key, value) {
  const encoder = new TextEncoder();
  const rawKey = typeof key === "string" ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey("raw", rawKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(value)));
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function validateMiniAppInitData(env, raw) {
  if (!env.BOT_TOKEN || typeof raw !== "string" || !raw || raw.length > 16_384) return null;
  const params = new URLSearchParams(raw);
  const receivedHash = String(params.get("hash") || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(receivedHash)) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = await hmacSha256("WebAppData", env.BOT_TOKEN);
  const expectedHash = bytesToHex(await hmacSha256(secretKey, dataCheckString));
  if (!safeEqual(expectedHash, receivedHash)) return null;
  const authDate = clampInt(params.get("auth_date"), 1, Number.MAX_SAFE_INTEGER);
  if (authDate > now() + 300 || now() - authDate > MINI_APP_AUTH_MAX_AGE) return null;
  try {
    const user = JSON.parse(params.get("user") || "null");
    if (!user || user.is_bot || !Number.isSafeInteger(Number(user.id)) || Number(user.id) < 1) return null;
    return { user, authDate };
  } catch {
    return null;
  }
}

function clampInt(value, lo, hi, fallback = 0) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.max(lo, Math.min(hi, number)) : fallback;
}

function defaultProgress() {
  return {
    level: 0,
    checkpoint: 0,
    deaths: 0,
    lives: 3,
    paidLives: 0,
    lifeBalanceVersion: LIFE_BALANCE_VERSION,
    coins: 0,
    got: [],
    bonusLives: [],
    hiddenOn: false,
    reqKnown: false,
    flags: {},
    screen: "level_start",
    completed: false,
  };
}

function sanitizeProgress(raw) {
  raw = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const progress = defaultProgress();
  progress.level = clampInt(raw.level, 0, 9);
  progress.checkpoint = clampInt(raw.checkpoint, 0, 30);
  progress.deaths = clampInt(raw.deaths, 0, 10_000_000);
  const rawLives = clampInt(raw.lives, 0, 999);
  const rawPaidLives = clampInt(raw.paidLives, 0, 999);
  const separateBalances = clampInt(raw.lifeBalanceVersion, 0, LIFE_BALANCE_VERSION) >= LIFE_BALANCE_VERSION;
  progress.lives = separateBalances || rawPaidLives > rawLives ? rawLives : Math.max(0, rawLives - rawPaidLives);
  progress.paidLives = rawPaidLives;
  progress.lifeBalanceVersion = LIFE_BALANCE_VERSION;
  progress.coins = clampInt(raw.coins, 0, 100);
  progress.hiddenOn = Boolean(raw.hiddenOn);
  progress.reqKnown = Boolean(raw.reqKnown);
  progress.completed = Boolean(raw.completed);
  progress.screen = ["playing", "level_start", "level_complete", "game_complete", "game_over"].includes(raw.screen)
    ? raw.screen
    : "playing";
  progress.got = (Array.isArray(raw.got) ? raw.got : []).slice(0, 100).map((value) => String(value).slice(0, 80));
  progress.bonusLives = [...new Set((Array.isArray(raw.bonusLives) ? raw.bonusLives : []).map((value) => clampInt(value, 0, 9)))].sort((a, b) => a - b);
  const flags = raw.flags && typeof raw.flags === "object" && !Array.isArray(raw.flags) ? raw.flags : {};
  progress.flags = Object.fromEntries(Object.entries(flags).slice(0, 30).map(([key, value]) => [String(key).slice(0, 40), Boolean(value)]));
  return progress;
}

function parseProgress(value) {
  try {
    const raw = JSON.parse(value);
    const isObject = raw && typeof raw === "object" && !Array.isArray(raw);
    return {
      progress: sanitizeProgress(raw),
      hasPaidLives: Boolean(isObject && Object.prototype.hasOwnProperty.call(raw, "paidLives")),
      legacyLives: clampInt(isObject ? raw.lives : 3, 0, 999, 3),
      needsLifeBalanceMigration: !isObject || clampInt(raw.lifeBalanceVersion, 0, LIFE_BALANCE_VERSION) < LIFE_BALANCE_VERSION,
    };
  } catch {
    return { progress: defaultProgress(), hasPaidLives: false, legacyLives: 3, needsLifeBalanceMigration: true };
  }
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "Authorization, Content-Type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "cache-control": "no-store",
  };
}

function json(payload, status = 200) {
  return Response.json(payload, { status, headers: corsHeaders() });
}

async function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = env.DB.batch(SCHEMA.map((statement) => env.DB.prepare(statement))).catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  await schemaReady;
}

async function telegram(env, method, params = {}) {
  if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(`Telegram ${method}: ${payload.description || response.status}`);
  return payload.result;
}

async function ensurePlayer(env, user) {
  const userId = clampInt(user.id, 1, Number.MAX_SAFE_INTEGER);
  await env.DB.prepare(
    `INSERT INTO players(user_id, first_name, username, progress_json, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       first_name=excluded.first_name,
       username=excluded.username,
       updated_at=excluded.updated_at`,
  ).bind(userId, String(user.first_name || "").slice(0, 128), String(user.username || "").slice(0, 128), JSON.stringify(defaultProgress()), now()).run();
  return userId;
}

async function getPlayer(env, userId) {
  const row = await env.DB.prepare("SELECT * FROM players WHERE user_id=?").bind(userId).first();
  if (!row) return null;
  const parsed = parseProgress(row.progress_json);
  if (parsed.needsLifeBalanceMigration) {
    if (!parsed.hasPaidLives) {
      const purchases = await env.DB.prepare("SELECT COALESCE(SUM(lives), 0) AS lives FROM payments WHERE user_id=?")
        .bind(userId).first();
      parsed.progress.paidLives = Math.min(parsed.legacyLives, clampInt(purchases?.lives, 0, 999));
      parsed.progress.lives = Math.max(0, parsed.legacyLives - parsed.progress.paidLives);
    }
    await env.DB.prepare("UPDATE players SET progress_json=? WHERE user_id=?")
      .bind(JSON.stringify(parsed.progress), userId).run();
  }
  return {
    user_id: Number(row.user_id),
    first_name: row.first_name,
    username: row.username,
    progress: parsed.progress,
    payment_version: Number(row.payment_version),
    best_level: Number(row.best_level),
    best_deaths: Number(row.best_deaths),
    best_score: Number(row.best_score),
    updated_at: Number(row.updated_at),
  };
}

async function createSessionForUser(env, user, details = {}) {
  const userId = await ensurePlayer(env, user);
  const token = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id=? OR expires_at < ?").bind(userId, now()),
    env.DB.prepare(
      `INSERT INTO sessions(token, user_id, chat_id, message_id, inline_message_id, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(token, userId, details.chatId ?? null, details.messageId ?? null, details.inlineMessageId ?? null, now() + SESSION_TTL, now()),
  ]);
  return token;
}

async function createSession(env, query) {
  const message = query.message || {};
  return createSessionForUser(env, query.from, {
    chatId: message.chat?.id ?? null,
    messageId: message.message_id ?? null,
    inlineMessageId: query.inline_message_id ?? null,
  });
}

function requestToken(request, url, body) {
  const authorization = request.headers.get("authorization") || "";
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return url.searchParams.get("token") || String(body?.token || "");
}

async function getSession(env, token) {
  if (!token || token.length > 200) return null;
  return env.DB.prepare("SELECT * FROM sessions WHERE token=? AND expires_at>=?").bind(token, now()).first();
}

function scoreValue(level, deaths) {
  return clampInt(level, 1, 10, 1) * 10_000 + (9_999 - clampInt(deaths, 0, 9_999));
}

function displayName(row) {
  const firstName = String(row.first_name || "").trim();
  const username = String(row.username || "").trim();
  return (firstName || (username ? `@${username}` : "Player")).slice(0, 40);
}

async function leaderboardForUser(env, userId) {
  const { results } = await env.DB.prepare(
    `SELECT user_id, first_name, username, best_level, best_deaths, updated_at
     FROM players WHERE best_level > 0
     ORDER BY best_level DESC, best_deaths ASC, updated_at ASC, user_id ASC LIMIT 20`,
  ).all();
  const me = await env.DB.prepare(
    "SELECT user_id, first_name, username, best_level, best_deaths, updated_at FROM players WHERE user_id=?",
  ).bind(userId).first();
  let rank = null;
  if (me && Number(me.best_level) > 0) {
    const rankRow = await env.DB.prepare(
      `SELECT COUNT(*) + 1 AS rank FROM players WHERE best_level > 0 AND (
       best_level > ? OR (best_level = ? AND best_deaths < ?) OR
       (best_level = ? AND best_deaths = ? AND updated_at < ?) OR
       (best_level = ? AND best_deaths = ? AND updated_at = ? AND user_id < ?))`,
    ).bind(me.best_level, me.best_level, me.best_deaths, me.best_level, me.best_deaths, me.updated_at, me.best_level, me.best_deaths, me.updated_at, me.user_id).first();
    rank = Number(rankRow.rank);
  }
  return {
    players: results.map((row, index) => ({
      rank: index + 1,
      name: displayName(row),
      level: Number(row.best_level),
      deaths: Number(row.best_deaths),
      is_me: Number(row.user_id) === userId,
    })),
    me: me && Number(me.best_level) > 0 ? {
      rank,
      name: displayName(me),
      level: Number(me.best_level),
      deaths: Number(me.best_deaths),
    } : null,
  };
}

async function createInvoice(env, userId, stars, chatId, delivery = "link") {
  const lives = LIFE_PACKS[stars];
  if (!lives) return null;
  const payload = `life_${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO invoices(payload, user_id, stars, lives, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(payload, userId, stars, lives, now()).run();
  const invoice = {
    title: `${lives} life${lives === 1 ? "" : "s"} for TRAP`,
    description: `Continue from your saved checkpoint with ${lives} extra life${lives === 1 ? "" : "s"}.`,
    payload,
    currency: "XTR",
    prices: [{ label: `${lives} extra life${lives === 1 ? "" : "s"}`, amount: stars }],
  };
  if (delivery === "chat" && chatId != null) {
    await telegram(env, "sendInvoice", { chat_id: Number(chatId), ...invoice });
    return { delivery: "chat" };
  }
  return { delivery: "link", invoice_url: await telegram(env, "createInvoiceLink", invoice) };
}

async function hasAcceptedTerms(env, userId) {
  const row = await env.DB.prepare("SELECT version FROM terms_acceptances WHERE user_id=?").bind(userId).first();
  return Number(row?.version || 0) >= TERMS_VERSION;
}

async function acceptTerms(env, userId) {
  await env.DB.prepare(
    `INSERT INTO terms_acceptances(user_id, version, accepted_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET version=excluded.version, accepted_at=excluded.accepted_at`,
  ).bind(userId, TERMS_VERSION, now()).run();
}

async function validatePreCheckout(env, query) {
  const invoice = await env.DB.prepare("SELECT * FROM invoices WHERE payload=?").bind(query.invoice_payload || "").first();
  if (!invoice || Number(invoice.consumed)) return [false, "This life pack is no longer available. Please create a new one."];
  if (Number(invoice.user_id) !== Number(query.from?.id)) return [false, "This invoice belongs to another player."];
  if (query.currency !== "XTR" || Number(query.total_amount) !== Number(invoice.stars)) return [false, "The invoice amount is invalid."];
  if (!(await hasAcceptedTerms(env, Number(invoice.user_id)))) return [false, "Please accept the TRAP terms in the game before purchasing."];
  return [true, undefined];
}

async function applySuccessfulPayment(env, message) {
  const payment = message.successful_payment || {};
  const chargeId = String(payment.telegram_payment_charge_id || "");
  if (!chargeId) return;
  const duplicate = await env.DB.prepare("SELECT 1 AS found FROM payments WHERE telegram_charge_id=?").bind(chargeId).first();
  if (duplicate) return;
  const invoice = await env.DB.prepare("SELECT * FROM invoices WHERE payload=?").bind(payment.invoice_payload || "").first();
  if (!invoice || Number(invoice.consumed) || payment.currency !== "XTR" || Number(payment.total_amount) !== Number(invoice.stars)) return;
  const player = await getPlayer(env, Number(invoice.user_id));
  if (!player) return;
  const progress = player.progress;
  progress.paidLives = clampInt(progress.paidLives + Number(invoice.lives), 0, 999);
  progress.screen = "level_start";
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO payments(telegram_charge_id, user_id, payload, stars, lives, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(chargeId, invoice.user_id, invoice.payload, invoice.stars, invoice.lives, now()),
    env.DB.prepare("UPDATE invoices SET consumed=1 WHERE payload=? AND consumed=0").bind(invoice.payload),
    env.DB.prepare("UPDATE players SET progress_json=?, payment_version=payment_version+1, updated_at=? WHERE user_id=?")
      .bind(JSON.stringify(progress), now(), invoice.user_id),
  ]);
  await telegram(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `❤️ Payment received: +${invoice.lives} lives. Open the game to continue from your checkpoint.`,
  });
}

async function sendPlayButton(env, chatId, origin, text = "TRAP is ready.") {
  const gameUrl = new URL("/game", env.PUBLIC_BASE_URL || origin);
  if (String(env.GAME_BETA || "0") === "1") gameUrl.searchParams.set("beta", "1");
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [[{ text: "▶ PLAY", web_app: { url: gameUrl.toString() } }]],
    },
  });
}

function configuredId(value, allowNegative = false) {
  const id = Number.parseInt(String(value || ""), 10);
  if (!Number.isSafeInteger(id) || id === 0 || (!allowNegative && id < 0)) return null;
  return id;
}

function commandName(message) {
  const first = String(message.text || "").trim().split(/\s+/, 1)[0].toLowerCase();
  return first.replace(/@[^\s]+$/, "");
}

function supportPlayerLabel(user) {
  const username = String(user?.username || "").trim();
  return `Player: ${displayName(user || {})} (${username ? `@${username}` : "no username"}):`;
}

function labeledSupportText(message, limit) {
  const label = supportPlayerLabel(message.from);
  const body = String(message.text || message.caption || "").trim();
  const text = body ? `${label}\n${body}` : label;
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function supportsCopiedCaption(message) {
  return Boolean(message.animation || message.audio || message.document || message.photo || message.video || message.voice);
}

async function supportTicketForUser(env, userId) {
  return env.DB.prepare(
    "SELECT * FROM support_tickets WHERE user_id=? AND status='open' ORDER BY id DESC LIMIT 1",
  ).bind(userId).first();
}

async function startSupportTicket(env, message, kind) {
  const supportChatId = configuredId(env.SUPPORT_CHAT_ID, true);
  if (!supportChatId) {
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: "Support is not configured yet. Please try again later.",
    });
    return;
  }
  const userId = Number(message.from.id);
  let ticket = await supportTicketForUser(env, userId);
  let created = false;
  if (!ticket) {
    const result = await env.DB.prepare(
      `INSERT INTO support_tickets(user_id, user_chat_id, kind, status, created_at, updated_at)
       VALUES (?, ?, ?, 'open', ?, ?)`,
    ).bind(userId, Number(message.chat.id), kind, now(), now()).run();
    ticket = await env.DB.prepare("SELECT * FROM support_tickets WHERE id=?").bind(result.meta.last_row_id).first();
    created = true;
  } else if (kind === "payment" && ticket.kind !== "payment") {
    await env.DB.prepare("UPDATE support_tickets SET kind='payment', updated_at=? WHERE id=?")
      .bind(now(), ticket.id).run();
    ticket.kind = "payment";
  }
  if (created) {
    const username = message.from.username ? `@${message.from.username}` : "no username";
    const header = await telegram(env, "sendMessage", {
      chat_id: supportChatId,
      text: `🛟 ${kind === "payment" ? "PAYMENT" : "GENERAL"} TICKET #${ticket.id}\n` +
        `Player: ${displayName(message.from)} (${username})\nUser ID: ${userId}\n\n` +
        "Reply to a relayed message to answer anonymously. Reply /refund to refund the latest purchase, or /close to close the ticket.",
    });
    await env.DB.prepare(
      "INSERT OR REPLACE INTO support_messages(admin_message_id, ticket_id, user_message_id, created_at) VALUES (?, ?, NULL, ?)",
    ).bind(header.message_id, ticket.id, now()).run();
  }
  await telegram(env, "sendMessage", {
    chat_id: message.chat.id,
    text: `${kind === "payment" ? "Payment support" : "Support"} ticket #${ticket.id} is open. Send your message, photo or receipt here. It will be forwarded privately. Use /done when finished.`,
  });
}

async function relaySupportMessage(env, message, ticket) {
  const supportChatId = configuredId(env.SUPPORT_CHAT_ID, true);
  if (!supportChatId) return false;
  try {
    const relayedMessageIds = [];
    if (message.text) {
      const relayed = await telegram(env, "sendMessage", {
        chat_id: supportChatId,
        text: labeledSupportText(message, 4096),
      });
      relayedMessageIds.push(relayed.message_id);
    } else if (supportsCopiedCaption(message)) {
      const copied = await telegram(env, "copyMessage", {
        chat_id: supportChatId,
        from_chat_id: message.chat.id,
        message_id: message.message_id,
        caption: labeledSupportText(message, 1024),
      });
      relayedMessageIds.push(copied.message_id);
    } else {
      const label = await telegram(env, "sendMessage", {
        chat_id: supportChatId,
        text: supportPlayerLabel(message.from),
      });
      const copied = await telegram(env, "copyMessage", {
        chat_id: supportChatId,
        from_chat_id: message.chat.id,
        message_id: message.message_id,
      });
      relayedMessageIds.push(label.message_id, copied.message_id);
    }
    await env.DB.batch([
      ...relayedMessageIds.map((adminMessageId) => env.DB.prepare(
        "INSERT OR REPLACE INTO support_messages(admin_message_id, ticket_id, user_message_id, created_at) VALUES (?, ?, ?, ?)",
      ).bind(adminMessageId, ticket.id, message.message_id, now())),
      env.DB.prepare("UPDATE support_tickets SET updated_at=? WHERE id=?").bind(now(), ticket.id),
    ]);
    await telegram(env, "sendMessage", { chat_id: message.chat.id, text: `✅ Sent to support · ticket #${ticket.id}` });
  } catch (error) {
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: "I could not forward that message. Please send it as text, photo or document.",
    });
    console.error(error);
  }
  return true;
}

async function closeSupportTicket(env, ticket, notifyUser = true) {
  await env.DB.prepare("UPDATE support_tickets SET status='closed', updated_at=? WHERE id=?")
    .bind(now(), ticket.id).run();
  if (notifyUser) {
    await telegram(env, "sendMessage", {
      chat_id: Number(ticket.user_chat_id),
      text: `Support ticket #${ticket.id} is closed. Use /support or /paysupport to open a new one.`,
    });
  }
}

async function finalizeRefund(env, payment, requestedBy, reason = "") {
  const existing = await env.DB.prepare("SELECT status FROM refunds WHERE telegram_charge_id=?")
    .bind(payment.telegram_charge_id).first();
  if (existing?.status === "completed") return { alreadyCompleted: true, removedLives: 0 };
  const player = await getPlayer(env, Number(payment.user_id));
  const progress = player?.progress || defaultProgress();
  const removedLives = Math.min(progress.paidLives, Number(payment.lives));
  progress.paidLives -= removedLives;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO refunds(telegram_charge_id, user_id, stars, lives, requested_by, status, reason, requested_at, completed_at, error)
       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, NULL)
       ON CONFLICT(telegram_charge_id) DO UPDATE SET status='completed', reason=excluded.reason,
         completed_at=excluded.completed_at, error=NULL`,
    ).bind(payment.telegram_charge_id, payment.user_id, payment.stars, payment.lives, requestedBy, reason, now(), now()),
    env.DB.prepare("UPDATE players SET progress_json=?, payment_version=payment_version+1, updated_at=? WHERE user_id=?")
      .bind(JSON.stringify(progress), now(), payment.user_id),
  ]);
  return { alreadyCompleted: false, removedLives };
}

async function refundPayment(env, userId, requestedBy, chargeId = "", reason = "Support refund") {
  const payment = chargeId
    ? await env.DB.prepare("SELECT * FROM payments WHERE user_id=? AND telegram_charge_id=?").bind(userId, chargeId).first()
    : await env.DB.prepare(
      `SELECT p.* FROM payments p LEFT JOIN refunds r ON r.telegram_charge_id=p.telegram_charge_id AND r.status='completed'
       WHERE p.user_id=? AND r.telegram_charge_id IS NULL ORDER BY p.created_at DESC LIMIT 1`,
    ).bind(userId).first();
  if (!payment) throw new Error("No refundable payment was found for this player.");
  const prior = await env.DB.prepare("SELECT status FROM refunds WHERE telegram_charge_id=?")
    .bind(payment.telegram_charge_id).first();
  if (prior?.status === "completed") throw new Error("This payment has already been refunded.");
  if (prior?.status === "pending") throw new Error("This refund is already being processed.");
  const lock = prior?.status === "failed"
    ? await env.DB.prepare(
      `UPDATE refunds SET requested_by=?, status='pending', reason=?, requested_at=?, error=NULL
       WHERE telegram_charge_id=? AND status='failed'`,
    ).bind(requestedBy, reason, now(), payment.telegram_charge_id).run()
    : await env.DB.prepare(
      `INSERT OR IGNORE INTO refunds(telegram_charge_id, user_id, stars, lives, requested_by, status, reason, requested_at, error)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL)`,
    ).bind(payment.telegram_charge_id, payment.user_id, payment.stars, payment.lives, requestedBy, reason, now()).run();
  if (Number(lock.meta.changes) !== 1) throw new Error("This refund is already being processed or completed.");
  try {
    await telegram(env, "refundStarPayment", {
      user_id: Number(payment.user_id),
      telegram_payment_charge_id: payment.telegram_charge_id,
    });
  } catch (error) {
    if (!String(error.message || error).toUpperCase().includes("CHARGE_ALREADY_REFUNDED")) {
      await env.DB.prepare("UPDATE refunds SET status='failed', error=? WHERE telegram_charge_id=?")
        .bind(String(error.message || error).slice(0, 500), payment.telegram_charge_id).run();
      throw error;
    }
  }
  return { payment, ...(await finalizeRefund(env, payment, requestedBy, reason)) };
}

async function applyRefundedPaymentUpdate(env, message) {
  const refunded = message.refunded_payment || {};
  const chargeId = String(refunded.telegram_payment_charge_id || "");
  if (!chargeId) return;
  const payment = await env.DB.prepare("SELECT * FROM payments WHERE telegram_charge_id=?").bind(chargeId).first();
  if (!payment) return;
  await finalizeRefund(env, payment, 0, "Telegram refunded payment update");
}

async function handleSupportAdminReply(env, message) {
  const supportChatId = configuredId(env.SUPPORT_CHAT_ID, true);
  if (!supportChatId || Number(message.chat.id) !== supportChatId || !message.reply_to_message) return false;
  const mapping = await env.DB.prepare(
    `SELECT t.* FROM support_messages m JOIN support_tickets t ON t.id=m.ticket_id
     WHERE m.admin_message_id=? ORDER BY t.id DESC LIMIT 1`,
  ).bind(message.reply_to_message.message_id).first();
  if (!mapping) return false;
  const adminId = configuredId(env.ADMIN_USER_ID);
  if (!adminId || Number(message.from?.id) !== adminId) {
    await telegram(env, "sendMessage", { chat_id: supportChatId, text: "⛔ Only the configured administrator can answer support tickets." });
    return true;
  }
  const command = commandName(message);
  if (command === "/refund") {
    const chargeId = String(message.text || "").trim().split(/\s+/, 2)[1] || "";
    try {
      const result = await refundPayment(env, Number(mapping.user_id), adminId, chargeId, `Support ticket #${mapping.id}`);
      await telegram(env, "sendMessage", {
        chat_id: Number(mapping.user_chat_id),
        text: `⭐ Refund completed: ${result.payment.stars} Stars. ${result.removedLives ? `${result.removedLives} unused paid lives were removed.` : "No unused paid lives remained."}`,
      });
      await telegram(env, "sendMessage", {
        chat_id: supportChatId,
        text: `✅ Refunded ${result.payment.stars} Stars for ticket #${mapping.id}. Charge: ${result.payment.telegram_charge_id}`,
      });
    } catch (error) {
      await telegram(env, "sendMessage", { chat_id: supportChatId, text: `❌ Refund failed: ${String(error.message || error).slice(0, 800)}` });
    }
    return true;
  }
  if (command === "/close") {
    await closeSupportTicket(env, mapping, true);
    await telegram(env, "sendMessage", { chat_id: supportChatId, text: `✅ Ticket #${mapping.id} closed.` });
    return true;
  }
  await telegram(env, "copyMessage", {
    chat_id: Number(mapping.user_chat_id),
    from_chat_id: supportChatId,
    message_id: message.message_id,
  });
  await env.DB.prepare("UPDATE support_tickets SET updated_at=? WHERE id=?").bind(now(), mapping.id).run();
  return true;
}

async function handleTelegramUpdate(env, update, origin) {
  if (update.pre_checkout_query) {
    const [ok, error] = await validatePreCheckout(env, update.pre_checkout_query);
    await telegram(env, "answerPreCheckoutQuery", {
      pre_checkout_query_id: update.pre_checkout_query.id,
      ok,
      error_message: error,
    });
    return;
  }
  if (update.callback_query) {
    const query = update.callback_query;
    if (query.game_short_name === (env.GAME_SHORT_NAME || "trap_game")) {
      const token = await createSession(env, query);
      const gameUrl = new URL("/game", env.PUBLIC_BASE_URL || origin);
      gameUrl.searchParams.set("tg_session", token);
      gameUrl.searchParams.set("api", env.PUBLIC_BASE_URL || origin);
      if (String(env.GAME_BETA || "0") === "1") gameUrl.searchParams.set("beta", "1");
      await telegram(env, "answerCallbackQuery", { callback_query_id: query.id, url: gameUrl.toString() });
    } else {
      await telegram(env, "answerCallbackQuery", { callback_query_id: query.id, text: "This game is unavailable." });
    }
    return;
  }
  if (update.inline_query) {
    await telegram(env, "answerInlineQuery", {
      inline_query_id: update.inline_query.id,
      results: [{ type: "game", id: "1", game_short_name: env.GAME_SHORT_NAME || "trap_game" }],
      cache_time: 0,
    });
    return;
  }
  const message = update.message;
  if (!message) return;
  if (message.successful_payment) {
    await applySuccessfulPayment(env, message);
    return;
  }
  if (message.refunded_payment) {
    await applyRefundedPaymentUpdate(env, message);
    return;
  }
  if (await handleSupportAdminReply(env, message)) return;
  const chatId = message.chat.id;
  const userId = await ensurePlayer(env, message.from || { id: chatId, first_name: "Player" });
  const text = String(message.text || "").trim();
  const lowerText = text.toLowerCase();
  const command = commandName(message);
  if (command === "/terms" || lowerText.startsWith("/start terms")) {
    await telegram(env, "sendMessage", { chat_id: chatId, text: TERMS_TEXT });
  } else if (command === "/support" || command === "/paysupport") {
    await startSupportTicket(env, message, command === "/paysupport" ? "payment" : "support");
  } else if (command === "/done") {
    const ticket = await supportTicketForUser(env, userId);
    if (ticket) await closeSupportTicket(env, ticket, true);
    else await telegram(env, "sendMessage", { chat_id: chatId, text: "You do not have an open support ticket." });
  } else if (command === "/myid" || command === "/chatid") {
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: `Your user ID: ${userId}\nThis chat ID: ${chatId}`,
    });
  } else if (command === "/start" || command === "/play") {
    await sendPlayButton(env, chatId, origin);
  } else if (command === "/score" || command === "/scores") {
    await sendPlayButton(env, chatId, origin, "🏆 Open TRAP and tap SCORES.");
  } else {
    const ticket = await supportTicketForUser(env, userId);
    if (ticket) await relaySupportMessage(env, message, ticket);
    else if (text) await sendPlayButton(env, chatId, origin, "Use /support for help or /paysupport for payments and refunds.");
  }
}

async function handleApi(request, env, url) {
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  if (url.pathname === "/api/session/mini-app" && request.method === "POST") {
    const validated = await validateMiniAppInitData(env, body.init_data);
    if (!validated) return json({ ok: false, error: "invalid Telegram Mini App data" }, 401);
    const token = await createSessionForUser(env, validated.user, { chatId: Number(validated.user.id) });
    return json({ ok: true, token, expires_in: SESSION_TTL, user_id: Number(validated.user.id) });
  }
  const session = await getSession(env, requestToken(request, url, body));
  if (!session) return json({ ok: false, error: "invalid session" }, 401);
  const userId = Number(session.user_id);

  if (url.pathname === "/api/state" && request.method === "GET") {
    return json({ ok: true, ...(await getPlayer(env, userId)) });
  }
  if (url.pathname === "/api/state" && request.method === "POST") {
    const current = await getPlayer(env, userId);
    const progress = sanitizeProgress(body.progress);
    const submittedPaidLives = Object.prototype.hasOwnProperty.call(body.progress || {}, "paidLives");
    progress.paidLives = submittedPaidLives
      ? Math.min(progress.paidLives, current.progress.paidLives)
      : current.progress.paidLives;
    const result = await env.DB.prepare(
      "UPDATE players SET progress_json=?, updated_at=? WHERE user_id=? AND payment_version=?",
    ).bind(JSON.stringify(progress), now(), userId, clampInt(body.payment_version, 0, 1_000_000)).run();
    const player = await getPlayer(env, userId);
    return Number(result.meta.changes) === 1
      ? json({ ok: true, ...player })
      : json({ ok: false, error: "stale payment state", ...player }, 409);
  }
  if (url.pathname === "/api/score" && request.method === "POST") {
    let level = clampInt(body.level, 1, 10, 1);
    let deaths = clampInt(body.deaths, 0, 10_000_000);
    const row = await env.DB.prepare("SELECT best_level, best_deaths, best_score FROM players WHERE user_id=?").bind(userId).first();
    if (level > Number(row.best_level) || (level === Number(row.best_level) && deaths < Number(row.best_deaths))) {
      const score = scoreValue(level, deaths);
      await env.DB.prepare("UPDATE players SET best_level=?, best_deaths=?, best_score=?, updated_at=? WHERE user_id=?")
        .bind(level, deaths, score, now(), userId).run();
      return json({ ok: true, level, deaths, score });
    }
    return json({ ok: true, level: Number(row.best_level), deaths: Number(row.best_deaths), score: Number(row.best_score) });
  }
  if (url.pathname === "/api/leaderboard" && request.method === "GET") {
    return json({ ok: true, ...(await leaderboardForUser(env, userId)) });
  }
  if (url.pathname === "/api/terms" && request.method === "GET") {
    return json({ ok: true, version: TERMS_VERSION, accepted: await hasAcceptedTerms(env, userId), text: TERMS_TEXT });
  }
  if (url.pathname === "/api/terms/accept" && request.method === "POST") {
    await acceptTerms(env, userId);
    return json({ ok: true, version: TERMS_VERSION, accepted: true });
  }
  if (url.pathname === "/api/invoice" && request.method === "POST") {
    const stars = clampInt(body.stars, 0, 1000);
    if (!LIFE_PACKS[stars]) return json({ ok: false, error: "invalid life pack" }, 400);
    if (!(await hasAcceptedTerms(env, userId))) {
      return json({ ok: false, error: "accept the TRAP terms before purchasing", code: "terms_not_accepted" }, 403);
    }
    const player = await getPlayer(env, userId);
    if (player.progress.lives > 0 || player.progress.paidLives > 0) {
      return json({ ok: false, error: "life packs are only available when no lives or paid reserve remain" }, 409);
    }
    const requestedDelivery = body.delivery === "chat" ? "chat" : "link";
    const invoice = await createInvoice(env, userId, stars, session.chat_id, requestedDelivery);
    return json({ ok: true, ...invoice, stars, lives: LIFE_PACKS[stars] });
  }
  if (url.pathname === "/api/reset" && request.method === "POST") {
    const player = await getPlayer(env, userId);
    const fresh = defaultProgress();
    fresh.paidLives = player.progress.paidLives;
    const result = await env.DB.prepare("UPDATE players SET progress_json=?, updated_at=? WHERE user_id=? AND payment_version=?")
      .bind(JSON.stringify(fresh), now(), userId, player.payment_version).run();
    const updated = await getPlayer(env, userId);
    return json({ ok: Number(result.meta.changes) === 1, ...updated }, Number(result.meta.changes) === 1 ? 200 : 409);
  }
  return json({ ok: false, error: "not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
      await ensureSchema(env);

      if (url.pathname === "/telegram/webhook" && request.method === "POST") {
        if (!env.WEBHOOK_SECRET || request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
          return json({ ok: false, error: "unauthorized" }, 401);
        }
        const update = await request.json();
        ctx.waitUntil(handleTelegramUpdate(env, update, url.origin).catch((error) => console.error(error)));
        return json({ ok: true });
      }
      if (url.pathname === "/health") {
        return json({ ok: true, service: "trap-game", storage: "d1", telegram_webhook: Boolean(env.BOT_TOKEN && env.WEBHOOK_SECRET) });
      }
      if ((url.pathname === "/" || url.pathname === "/game") && ["GET", "HEAD"].includes(request.method)) {
        if (url.searchParams.has("beta")) {
          url.searchParams.delete("beta");
          return Response.redirect(url.toString(), 302);
        }
        return new Response(request.method === "HEAD" ? null : gameHtml, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-cache, no-store, must-revalidate",
            "x-content-type-options": "nosniff",
            "x-robots-tag": "noindex, nofollow, noarchive",
            "referrer-policy": "no-referrer",
          },
        });
      }
      if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
      return json({ ok: false, error: "not found" }, 404);
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: "internal error" }, 500);
    }
  },
};
