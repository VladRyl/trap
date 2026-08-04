#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Telegram game bot + lightweight game backend for TRAP.

Features:
  • /start and /play send the Telegram HTML5 game;
  • each game launch gets an authenticated random session token;
  • SQLite saves: level, checkpoint, deaths, lives and collected coins;
  • in-game leaderboard: best level + fewest deaths;
  • Telegram Stars life packs with createInvoiceLink;
  • serves the game HTML itself at /game (optional but convenient);
  • uses only Python's standard library.

Recommended Railway variables:
  BOT_TOKEN=123456:...
  GAME_SHORT_NAME=wcc
  PUBLIC_BASE_URL=https://your-app.up.railway.app
  GAME_FILE=trap_v18_telegram.html
  DB_PATH=/data/trap.sqlite3       # use a mounted persistent volume
  PORT=8080                        # Railway normally supplies this

If the game is hosted elsewhere, set:
  GAME_URL=https://your-static-host/trap_v18_telegram.html
The bot still appends tg_session and api parameters to that URL.

Beta mode without editing the HTML:
  GAME_BETA=1
The launch URL will contain beta=1. Leave it unset for production.
"""

from __future__ import annotations

import json
import os
import secrets
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


def load_dotenv() -> None:
    try:
        with open(".env", "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip("'\"")
                if key and key not in os.environ:
                    os.environ[key] = value
    except FileNotFoundError:
        pass


load_dotenv()

TOKEN = os.getenv("BOT_TOKEN") or "СЮДИ_ТОКЕН_ВІД_BOTFATHER"
GAME_SHORT_NAME = os.getenv("GAME_SHORT_NAME") or "trap_game"
PUBLIC_BASE_URL = (os.getenv("PUBLIC_BASE_URL") or "").rstrip("/")
GAME_URL = (os.getenv("GAME_URL") or "").strip()
GAME_FILE = Path(os.getenv("GAME_FILE") or "trap.html")
if not GAME_FILE.is_absolute():
    GAME_FILE = Path(__file__).resolve().parent / GAME_FILE
DB_PATH = os.getenv("DB_PATH") or "trap.sqlite3"
PORT = int(os.getenv("PORT") or "8080")
GAME_BETA = (os.getenv("GAME_BETA") or "0").strip().lower() in {
    "1", "true", "yes", "on"
}
SESSION_TTL = 60 * 60 * 24 * 30

# Balanced progression: larger packs give a modest discount.
LIFE_PACKS: dict[int, int] = {10: 1, 50: 7, 100: 15}
LIFE_BALANCE_VERSION = 2
API = f"https://api.telegram.org/bot{TOKEN}/"
DB_LOCK = threading.RLock()


def now() -> int:
    return int(time.time())


def default_progress() -> dict[str, Any]:
    return {
        "level": 0,
        "checkpoint": 0,
        "deaths": 0,
        "lives": 3,
        "paidLives": 0,
        "lifeBalanceVersion": LIFE_BALANCE_VERSION,
        "coins": 0,
        "got": [],
        "bonusLives": [],
        "hiddenOn": False,
        "reqKnown": False,
        "flags": {},
        "screen": "level_start",
        "completed": False,
    }


def db_connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    return con


def init_db() -> None:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with DB_LOCK, db_connect() as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS players (
                user_id INTEGER PRIMARY KEY,
                first_name TEXT NOT NULL DEFAULT '',
                username TEXT NOT NULL DEFAULT '',
                progress_json TEXT NOT NULL,
                payment_version INTEGER NOT NULL DEFAULT 0,
                best_level INTEGER NOT NULL DEFAULT 0,
                best_deaths INTEGER NOT NULL DEFAULT 2147483647,
                best_score INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                chat_id INTEGER,
                message_id INTEGER,
                inline_message_id TEXT,
                expires_at INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES players(user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

            CREATE TABLE IF NOT EXISTS invoices (
                payload TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                stars INTEGER NOT NULL,
                lives INTEGER NOT NULL,
                consumed INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES players(user_id)
            );

            CREATE TABLE IF NOT EXISTS payments (
                telegram_charge_id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                payload TEXT NOT NULL,
                stars INTEGER NOT NULL,
                lives INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(user_id) REFERENCES players(user_id)
            );
            """
        )


def call(method: str, **params: Any) -> Any:
    """Call Telegram Bot API. Returns result or None on error."""
    encoded = {
        key: (json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else value)
        for key, value in params.items()
        if value is not None
    }
    data = urllib.parse.urlencode(encoded).encode()
    req = urllib.request.Request(API + method, data=data)
    try:
        with urllib.request.urlopen(req, timeout=65) as resp:
            payload = json.load(resp)
    except Exception as exc:
        print(f"[!] {method}: {exc}")
        return None
    if not payload.get("ok"):
        print(f"[!] {method}: {payload}")
        return None
    return payload["result"]


def ensure_player(user: dict[str, Any]) -> None:
    user_id = int(user["id"])
    with DB_LOCK, db_connect() as con:
        con.execute(
            """
            INSERT INTO players(user_id, first_name, username, progress_json, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                first_name=excluded.first_name,
                username=excluded.username,
                updated_at=excluded.updated_at
            """,
            (
                user_id,
                user.get("first_name", ""),
                user.get("username", ""),
                json.dumps(default_progress(), ensure_ascii=False),
                now(),
            ),
        )


def create_session(q: dict[str, Any]) -> str:
    user = q["from"]
    ensure_player(user)
    token = secrets.token_urlsafe(32)
    message = q.get("message") or {}
    chat = message.get("chat") or {}
    with DB_LOCK, db_connect() as con:
        con.execute("DELETE FROM sessions WHERE expires_at < ?", (now(),))
        con.execute(
            """
            INSERT INTO sessions(token, user_id, chat_id, message_id, inline_message_id, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                token,
                int(user["id"]),
                chat.get("id"),
                message.get("message_id"),
                q.get("inline_message_id"),
                now() + SESSION_TTL,
                now(),
            ),
        )
    return token


def get_session(token: str) -> sqlite3.Row | None:
    if not token or len(token) > 200:
        return None
    with DB_LOCK, db_connect() as con:
        row = con.execute(
            "SELECT * FROM sessions WHERE token=? AND expires_at>=?", (token, now())
        ).fetchone()
    return row


def get_player(user_id: int) -> dict[str, Any]:
    with DB_LOCK, db_connect() as con:
        row = con.execute("SELECT * FROM players WHERE user_id=?", (user_id,)).fetchone()
    if row is None:
        raise KeyError("player not found")
    try:
        raw_progress = json.loads(row["progress_json"])
    except Exception:
        raw_progress = {}
    is_object = isinstance(raw_progress, dict)
    has_paid_lives = is_object and "paidLives" in raw_progress
    legacy_lives = clamp_int(raw_progress.get("lives") if is_object else 3, 0, 999, 3)
    needs_life_balance_migration = (
        not is_object
        or clamp_int(raw_progress.get("lifeBalanceVersion"), 0, LIFE_BALANCE_VERSION) < LIFE_BALANCE_VERSION
    )
    progress = sanitize_progress(raw_progress)
    if needs_life_balance_migration:
        with DB_LOCK, db_connect() as con:
            if not has_paid_lives:
                purchases = con.execute(
                    "SELECT COALESCE(SUM(lives), 0) FROM payments WHERE user_id=?", (user_id,)
                ).fetchone()[0]
                progress["paidLives"] = min(legacy_lives, clamp_int(purchases, 0, 999))
                progress["lives"] = max(0, legacy_lives - progress["paidLives"])
            con.execute(
                "UPDATE players SET progress_json=? WHERE user_id=?",
                (json.dumps(progress, ensure_ascii=False), user_id),
            )
    return {
        "user_id": user_id,
        "first_name": row["first_name"],
        "username": row["username"],
        "progress": progress,
        "payment_version": row["payment_version"],
        "best_level": row["best_level"],
        "best_deaths": row["best_deaths"],
        "best_score": row["best_score"],
        "updated_at": row["updated_at"],
    }


def clamp_int(value: Any, lo: int, hi: int, default: int = 0) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, number))


def sanitize_progress(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raw = {}
    progress = default_progress()
    progress["level"] = clamp_int(raw.get("level"), 0, 9)
    progress["checkpoint"] = clamp_int(raw.get("checkpoint"), 0, 30)
    progress["deaths"] = clamp_int(raw.get("deaths"), 0, 10_000_000)
    raw_lives = clamp_int(raw.get("lives"), 0, 999)
    raw_paid_lives = clamp_int(raw.get("paidLives"), 0, 999)
    separate_balances = (
        clamp_int(raw.get("lifeBalanceVersion"), 0, LIFE_BALANCE_VERSION) >= LIFE_BALANCE_VERSION
    )
    progress["lives"] = (
        raw_lives if separate_balances or raw_paid_lives > raw_lives
        else max(0, raw_lives - raw_paid_lives)
    )
    progress["paidLives"] = raw_paid_lives
    progress["lifeBalanceVersion"] = LIFE_BALANCE_VERSION
    progress["coins"] = clamp_int(raw.get("coins"), 0, 100)
    progress["hiddenOn"] = bool(raw.get("hiddenOn"))
    progress["reqKnown"] = bool(raw.get("reqKnown"))
    progress["completed"] = bool(raw.get("completed"))
    progress["screen"] = raw.get("screen") if raw.get("screen") in {
        "playing", "level_start", "level_complete", "game_complete", "game_over"
    } else "playing"
    got = raw.get("got") if isinstance(raw.get("got"), list) else []
    progress["got"] = [str(x)[:80] for x in got[:100]]
    bonus = raw.get("bonusLives") if isinstance(raw.get("bonusLives"), list) else []
    progress["bonusLives"] = sorted({clamp_int(x, 0, 9) for x in bonus})
    flags = raw.get("flags") if isinstance(raw.get("flags"), dict) else {}
    progress["flags"] = {str(k)[:40]: bool(v) for k, v in list(flags.items())[:30]}
    return progress


def save_progress(user_id: int, raw: Any, payment_version: int) -> tuple[bool, dict[str, Any]]:
    submitted_paid_lives = isinstance(raw, dict) and "paidLives" in raw
    progress = sanitize_progress(raw)
    with DB_LOCK, db_connect() as con:
        current = con.execute(
            "SELECT payment_version, progress_json FROM players WHERE user_id=?", (user_id,)
        ).fetchone()
        if current is None:
            raise KeyError("player not found")
        if int(current["payment_version"]) != int(payment_version):
            return False, get_player(user_id)
        try:
            current_progress = sanitize_progress(json.loads(current["progress_json"]))
        except Exception:
            current_progress = default_progress()
        if submitted_paid_lives:
            progress["paidLives"] = min(progress["paidLives"], current_progress["paidLives"])
        else:
            progress["paidLives"] = current_progress["paidLives"]
        con.execute(
            "UPDATE players SET progress_json=?, updated_at=? WHERE user_id=?",
            (json.dumps(progress, ensure_ascii=False), now(), user_id),
        )
    return True, get_player(user_id)


def score_value(level: int, deaths: int) -> int:
    """Higher level always wins; for the same level fewer deaths is better."""
    level = clamp_int(level, 1, 10, 1)
    deaths = clamp_int(deaths, 0, 9999)
    return level * 10_000 + (9_999 - deaths)


def update_score(session: sqlite3.Row, level: int, deaths: int) -> dict[str, Any]:
    """Store the player's best result for the in-game leaderboard."""
    user_id = int(session["user_id"])
    level = clamp_int(level, 1, 10, 1)
    deaths = clamp_int(deaths, 0, 10_000_000)
    value = score_value(level, deaths)
    with DB_LOCK, db_connect() as con:
        row = con.execute(
            "SELECT best_level, best_deaths, best_score FROM players WHERE user_id=?", (user_id,)
        ).fetchone()
        better = row is None or level > row["best_level"] or (
            level == row["best_level"] and deaths < row["best_deaths"]
        )
        if better:
            con.execute(
                "UPDATE players SET best_level=?, best_deaths=?, best_score=?, updated_at=? WHERE user_id=?",
                (level, deaths, value, now(), user_id),
            )
        else:
            value = int(row["best_score"])
            level = int(row["best_level"])
            deaths = int(row["best_deaths"])
    return {"level": level, "deaths": deaths, "score": value}


def leaderboard(limit: int = 10) -> list[dict[str, Any]]:
    with DB_LOCK, db_connect() as con:
        rows = con.execute(
            """
            SELECT user_id, first_name, username, best_level, best_deaths, best_score
            FROM players WHERE best_level > 0
            ORDER BY best_level DESC, best_deaths ASC, updated_at ASC
            LIMIT ?
            """,
            (clamp_int(limit, 1, 50, 10),),
        ).fetchall()
    return [dict(row) for row in rows]


def display_name(row: sqlite3.Row | dict[str, Any]) -> str:
    first_name = str(row["first_name"] or "").strip()
    username = str(row["username"] or "").strip()
    if first_name:
        return first_name[:40]
    if username:
        return ("@" + username)[:40]
    return "Player"


def leaderboard_for_user(user_id: int, limit: int = 20) -> dict[str, Any]:
    """Return top results plus the current player's own rank."""
    limit = clamp_int(limit, 1, 50, 20)
    with DB_LOCK, db_connect() as con:
        rows = con.execute(
            """
            SELECT user_id, first_name, username, best_level, best_deaths, updated_at
            FROM players
            WHERE best_level > 0
            ORDER BY best_level DESC, best_deaths ASC, updated_at ASC, user_id ASC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
        me = con.execute(
            """
            SELECT user_id, first_name, username, best_level, best_deaths, updated_at
            FROM players WHERE user_id=?
            """,
            (user_id,),
        ).fetchone()
        rank = None
        if me is not None and int(me["best_level"]) > 0:
            rank = int(
                con.execute(
                    """
                    SELECT COUNT(*) + 1
                    FROM players
                    WHERE best_level > 0 AND (
                        best_level > ? OR
                        (best_level = ? AND best_deaths < ?) OR
                        (best_level = ? AND best_deaths = ? AND updated_at < ?) OR
                        (best_level = ? AND best_deaths = ? AND updated_at = ? AND user_id < ?)
                    )
                    """,
                    (
                        me["best_level"],
                        me["best_level"], me["best_deaths"],
                        me["best_level"], me["best_deaths"], me["updated_at"],
                        me["best_level"], me["best_deaths"], me["updated_at"], me["user_id"],
                    ),
                ).fetchone()[0]
            )

    players = []
    for index, row in enumerate(rows, 1):
        players.append(
            {
                "rank": index,
                "name": display_name(row),
                "level": int(row["best_level"]),
                "deaths": int(row["best_deaths"]),
                "is_me": int(row["user_id"]) == user_id,
            }
        )

    me_payload = None
    if me is not None and int(me["best_level"]) > 0:
        me_payload = {
            "rank": rank,
            "name": display_name(me),
            "level": int(me["best_level"]),
            "deaths": int(me["best_deaths"]),
        }
    return {"players": players, "me": me_payload}


def create_invoice(user_id: int, stars: int) -> str | None:
    lives = LIFE_PACKS.get(stars)
    if lives is None:
        return None
    payload = "life_" + secrets.token_urlsafe(24)
    with DB_LOCK, db_connect() as con:
        con.execute(
            "INSERT INTO invoices(payload, user_id, stars, lives, created_at) VALUES (?, ?, ?, ?, ?)",
            (payload, user_id, stars, lives, now()),
        )
    return call(
        "createInvoiceLink",
        title=f"{lives} life{'s' if lives != 1 else ''} for TRAP",
        description=f"Continue from your saved checkpoint with {lives} extra life{'s' if lives != 1 else ''}.",
        payload=payload,
        provider_token="",
        currency="XTR",
        prices=[{"label": f"{lives} extra life{'s' if lives != 1 else ''}", "amount": stars}],
    )


def validate_pre_checkout(q: dict[str, Any]) -> tuple[bool, str | None]:
    payload = q.get("invoice_payload", "")
    with DB_LOCK, db_connect() as con:
        row = con.execute("SELECT * FROM invoices WHERE payload=?", (payload,)).fetchone()
    if row is None or row["consumed"]:
        return False, "This life pack is no longer available. Please create a new one."
    if int(row["user_id"]) != int(q["from"]["id"]):
        return False, "This invoice belongs to another player."
    if q.get("currency") != "XTR" or int(q.get("total_amount", -1)) != int(row["stars"]):
        return False, "The invoice amount is invalid."
    return True, None


def apply_successful_payment(msg: dict[str, Any]) -> None:
    payment = msg.get("successful_payment") or {}
    payload = payment.get("invoice_payload", "")
    charge_id = payment.get("telegram_payment_charge_id", "")
    if not charge_id:
        return
    with DB_LOCK, db_connect() as con:
        invoice = con.execute("SELECT * FROM invoices WHERE payload=?", (payload,)).fetchone()
        if invoice is None or invoice["consumed"]:
            return
        if payment.get("currency") != "XTR" or int(payment.get("total_amount", -1)) != int(invoice["stars"]):
            return
        duplicate = con.execute(
            "SELECT 1 FROM payments WHERE telegram_charge_id=?", (charge_id,)
        ).fetchone()
        if duplicate:
            return
        player = con.execute(
            "SELECT progress_json, payment_version FROM players WHERE user_id=?", (invoice["user_id"],)
        ).fetchone()
        if player is None:
            return
        try:
            progress = sanitize_progress(json.loads(player["progress_json"]))
        except Exception:
            progress = default_progress()
        progress["paidLives"] = clamp_int(
            progress.get("paidLives", 0) + int(invoice["lives"]), 0, 999
        )
        progress["screen"] = "level_start"
        con.execute(
            "INSERT INTO payments(telegram_charge_id, user_id, payload, stars, lives, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (charge_id, invoice["user_id"], payload, invoice["stars"], invoice["lives"], now()),
        )
        con.execute("UPDATE invoices SET consumed=1 WHERE payload=?", (payload,))
        con.execute(
            "UPDATE players SET progress_json=?, payment_version=payment_version+1, updated_at=? WHERE user_id=?",
            (json.dumps(progress, ensure_ascii=False), now(), invoice["user_id"]),
        )
    call(
        "sendMessage",
        chat_id=msg["chat"]["id"],
        text=f"❤️ Payment received: +{invoice['lives']} lives. Open the game to continue from your checkpoint.",
    )


def base_game_url() -> str:
    if GAME_URL:
        return GAME_URL
    if PUBLIC_BASE_URL:
        return PUBLIC_BASE_URL + "/game"
    return "https://YOUR-HOST/game"


def build_launch_url(token: str) -> str:
    url = base_game_url()
    parts = urllib.parse.urlsplit(url)
    query = dict(urllib.parse.parse_qsl(parts.query, keep_blank_values=True))
    query["tg_session"] = token
    if PUBLIC_BASE_URL:
        query["api"] = PUBLIC_BASE_URL
    if GAME_BETA:
        query["beta"] = "1"
    else:
        query.pop("beta", None)
    return urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(query), parts.fragment)
    )


def handle_message(msg: dict[str, Any]) -> None:
    if "successful_payment" in msg:
        apply_successful_payment(msg)
        return
    chat_id = msg["chat"]["id"]
    text = (msg.get("text") or "").strip().lower()
    user = msg.get("from") or {"id": chat_id, "first_name": "Player"}
    ensure_player(user)

    if text.startswith(("/start", "/play")):
        call("sendGame", chat_id=chat_id, game_short_name=GAME_SHORT_NAME)
        return

    if text.startswith(("/score", "/scores")):
        call(
            "sendMessage",
            chat_id=chat_id,
            text="🏆 Scores are now inside the game. Open TRAP and tap SCORES.",
        )
        call("sendGame", chat_id=chat_id, game_short_name=GAME_SHORT_NAME)
        return

    if text:
        call(
            "sendMessage",
            chat_id=chat_id,
            text="Send /play to open TRAP. Saves, scores and the leaderboard are available inside the game.",
        )
        call("sendGame", chat_id=chat_id, game_short_name=GAME_SHORT_NAME)


def handle_callback(q: dict[str, Any]) -> None:
    if q.get("game_short_name") == GAME_SHORT_NAME:
        token = create_session(q)
        call("answerCallbackQuery", callback_query_id=q["id"], url=build_launch_url(token))
    else:
        call("answerCallbackQuery", callback_query_id=q["id"], text="This game is unavailable.")


def handle_inline(q: dict[str, Any]) -> None:
    call(
        "answerInlineQuery",
        inline_query_id=q["id"],
        results=[{"type": "game", "id": "1", "game_short_name": GAME_SHORT_NAME}],
        cache_time=0,
    )


def handle_pre_checkout(q: dict[str, Any]) -> None:
    ok, error = validate_pre_checkout(q)
    call(
        "answerPreCheckoutQuery",
        pre_checkout_query_id=q["id"],
        ok=ok,
        error_message=error,
    )


class GameHTTPHandler(BaseHTTPRequestHandler):
    server_version = "TrapGameBackend/2.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print("[http] " + (fmt % args))

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Cache-Control", "no-store")

    def _json(self, status: int, payload: Any) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        length = clamp_int(self.headers.get("Content-Length", "0"), 0, 128_000)
        if length <= 0:
            return {}
        try:
            value = json.loads(self.rfile.read(length).decode("utf-8"))
            return value if isinstance(value, dict) else {}
        except Exception:
            return {}

    def _token(self, body: dict[str, Any] | None = None) -> str:
        auth = self.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        if query.get("token"):
            return query["token"][0]
        if body and body.get("token"):
            return str(body["token"])
        return ""

    def _session(self, body: dict[str, Any] | None = None) -> sqlite3.Row | None:
        return get_session(self._token(body))

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        if path == "/health":
            self._json(
                200,
                {
                    "ok": True,
                    "time": now(),
                    "beta": GAME_BETA,
                    "game_short_name": GAME_SHORT_NAME,
                    "scores": "in_game",
                },
            )
            return
        if path == "/game":
            try:
                body = GAME_FILE.read_bytes()
            except FileNotFoundError:
                self._json(404, {"ok": False, "error": f"GAME_FILE not found: {GAME_FILE}"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/state":
            session = self._session()
            if session is None:
                self._json(401, {"ok": False, "error": "invalid session"})
                return
            self._json(200, {"ok": True, **get_player(int(session["user_id"]))})
            return
        if path == "/api/leaderboard":
            session = self._session()
            if session is None:
                self._json(401, {"ok": False, "error": "invalid session"})
                return
            payload = leaderboard_for_user(int(session["user_id"]), 20)
            self._json(200, {"ok": True, **payload})
            return
        self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urllib.parse.urlsplit(self.path).path
        body = self._read_json()
        session = self._session(body)
        if session is None:
            self._json(401, {"ok": False, "error": "invalid session"})
            return
        user_id = int(session["user_id"])

        if path == "/api/state":
            ok, player = save_progress(
                user_id,
                body.get("progress"),
                clamp_int(body.get("payment_version"), 0, 1_000_000),
            )
            if not ok:
                self._json(409, {"ok": False, "error": "stale payment state", **player})
            else:
                self._json(200, {"ok": True, **player})
            return

        if path == "/api/score":
            result = update_score(
                session,
                clamp_int(body.get("level"), 1, 10, 1),
                clamp_int(body.get("deaths"), 0, 10_000_000),
            )
            self._json(200, {"ok": True, **result})
            return

        if path == "/api/invoice":
            stars = clamp_int(body.get("stars"), 0, 1000)
            player = get_player(user_id)
            if int(player["progress"].get("lives", 0)) > 0 or int(player["progress"].get("paidLives", 0)) > 0:
                self._json(409, {"ok": False, "error": "life packs are only available when no lives or paid reserve remain"})
                return
            link = create_invoice(user_id, stars)
            if not link:
                self._json(400, {"ok": False, "error": "invalid life pack"})
            else:
                self._json(200, {"ok": True, "invoice_url": link, "stars": stars, "lives": LIFE_PACKS[stars]})
            return

        if path == "/api/reset":
            player = get_player(user_id)
            fresh = default_progress()
            fresh["paidLives"] = int(player["progress"].get("paidLives", 0))
            ok, updated = save_progress(user_id, fresh, player["payment_version"])
            self._json(200 if ok else 409, {"ok": ok, **updated})
            return

        self._json(404, {"ok": False, "error": "not found"})


def start_http_server() -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), GameHTTPHandler)
    thread = threading.Thread(target=server.serve_forever, name="trap-http", daemon=True)
    thread.start()
    print(f"HTTP server: 0.0.0.0:{PORT}")
    return server


def main() -> None:
    if not TOKEN or ":" not in TOKEN or any(ord(c) > 127 for c in TOKEN) or "СЮДИ_ТОКЕН" in TOKEN:
        raise SystemExit("BOT_TOKEN is missing or invalid.")
    init_db()
    me = call("getMe")
    if not me:
        raise SystemExit("The bot token does not work.")
    start_http_server()
    print(f"Bot @{me['username']} started.")
    print(f"Game: {GAME_SHORT_NAME} → {base_game_url()}")
    print(f"Beta mode: {'ON' if GAME_BETA else 'OFF'}")
    print(f"Database: {DB_PATH}")
    if not PUBLIC_BASE_URL:
        print("[!] PUBLIC_BASE_URL is empty: remote saves and Stars links will not work until it is set.")
    print("Stop: Ctrl+C")

    offset = None
    while True:
        updates = call(
            "getUpdates",
            offset=offset,
            timeout=50,
            allowed_updates=["message", "callback_query", "inline_query", "pre_checkout_query"],
        )
        if updates is None:
            time.sleep(3)
            continue
        for update in updates:
            offset = update["update_id"] + 1
            try:
                if "pre_checkout_query" in update:
                    handle_pre_checkout(update["pre_checkout_query"])
                elif "message" in update:
                    handle_message(update["message"])
                elif "callback_query" in update:
                    handle_callback(update["callback_query"])
                elif "inline_query" in update:
                    handle_inline(update["inline_query"])
            except Exception as exc:
                print(f"[!] update handling: {exc}")


if __name__ == "__main__":
    main()
