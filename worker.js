import gameHtml from "./trap.html";

const SESSION_TTL = 60 * 60 * 24 * 30;
const MINI_APP_AUTH_MAX_AGE = 60 * 60 * 24;
const LIFE_PACKS = { 10: 1, 50: 7, 100: 15 };
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
  progress.lives = clampInt(raw.lives, 0, 999);
  progress.paidLives = clampInt(raw.paidLives, 0, progress.lives);
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
    return {
      progress: sanitizeProgress(raw),
      needsPaidLivesMigration: !raw || typeof raw !== "object" || !Object.prototype.hasOwnProperty.call(raw, "paidLives"),
    };
  } catch {
    return { progress: defaultProgress(), needsPaidLivesMigration: true };
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
  if (parsed.needsPaidLivesMigration) {
    const purchases = await env.DB.prepare("SELECT COALESCE(SUM(lives), 0) AS lives FROM payments WHERE user_id=?")
      .bind(userId).first();
    parsed.progress.paidLives = Math.min(parsed.progress.lives, clampInt(purchases?.lives, 0, 999));
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

async function validatePreCheckout(env, query) {
  const invoice = await env.DB.prepare("SELECT * FROM invoices WHERE payload=?").bind(query.invoice_payload || "").first();
  if (!invoice || Number(invoice.consumed)) return [false, "This life pack is no longer available. Please create a new one."];
  if (Number(invoice.user_id) !== Number(query.from?.id)) return [false, "This invoice belongs to another player."];
  if (query.currency !== "XTR" || Number(query.total_amount) !== Number(invoice.stars)) return [false, "The invoice amount is invalid."];
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
  progress.lives = clampInt(progress.lives + Number(invoice.lives), 0, 999);
  progress.paidLives = clampInt(progress.paidLives + Number(invoice.lives), 0, progress.lives);
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
  const chatId = message.chat.id;
  await ensurePlayer(env, message.from || { id: chatId, first_name: "Player" });
  const text = String(message.text || "").trim().toLowerCase();
  if (text.startsWith("/start") || text.startsWith("/play")) {
    await sendPlayButton(env, chatId, origin);
  } else if (text.startsWith("/score") || text.startsWith("/scores")) {
    await sendPlayButton(env, chatId, origin, "🏆 Open TRAP and tap SCORES.");
  } else if (text) {
    await sendPlayButton(env, chatId, origin);
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
      : Math.min(progress.lives, current.progress.paidLives);
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
  if (url.pathname === "/api/invoice" && request.method === "POST") {
    const stars = clampInt(body.stars, 0, 1000);
    if (!LIFE_PACKS[stars]) return json({ ok: false, error: "invalid life pack" }, 400);
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
    fresh.lives = clampInt(fresh.lives + fresh.paidLives, 0, 999);
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
