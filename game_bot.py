#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Бот ігрової платформи Telegram для «Білого комірця».

Що робить:
  • на /start і /play надсилає в чат картку гри з кнопкою «Play …»;
  • коли гравець тисне «Play», відповідає Telegram'у адресою гри —
    і комікс відкривається всередині месенджера;
  • підтримує інлайн-режим (@твій_бот у будь-якому чаті → поділитися грою),
    якщо увімкнеш його в @BotFather командою /setinline.

Як запустити:
  1. Заповни три константи нижче (TOKEN, GAME_SHORT_NAME, GAME_URL).
  2. python3 wcc_game_bot.py
  Жодних бібліотек ставити не треба — тільки стандартна бібліотека Python 3.

Скрипт працює через long polling, тож йому НЕ потрібен сервер із білою
адресою: можна ганяти хоч на домашньому ноутбуці. Але поки скрипт не
запущений, кнопка «Play» крутитиме вічний прогрес-бар — для постійної
роботи закинь його на будь-який дешевий VPS або безкоштовний
PythonAnywhere/Railway.
"""

import json
import os
import time
import urllib.parse
import urllib.request
# Завантажуємо змінні з .env файлу, якщо він є (корисно для Docker та інших запусків)
def load_dotenv():
    try:
        with open(".env", "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip("'\"")
                    if k and k not in os.environ:
                        os.environ[k] = v
    except FileNotFoundError:
        pass

load_dotenv()

# ── НАЛАШТУВАННЯ ──────────────────────────────────────────────────────────────
# Можна заповнити прямо тут АБО задати через змінні оточення
# (BOT_TOKEN, GAME_SHORT_NAME, GAME_URL) — зручно для Railway.
TOKEN = os.getenv("BOT_TOKEN") or "СЮДИ_ТОКЕН_ВІД_BOTFATHER"
GAME_SHORT_NAME = os.getenv("GAME_SHORT_NAME") or "wcc"
GAME_URL = os.getenv("GAME_URL") or "https://ТВІЙ-ХОСТИНГ/bilyj-komirets-tg.html"
# ──────────────────────────────────────────────────────────────────────────────

API = f"https://api.telegram.org/bot{TOKEN}/"


def call(method: str, **params):
    """Виклик методу Bot API. Повертає поле result або None у разі помилки."""
    data = urllib.parse.urlencode(
        {k: (json.dumps(v) if isinstance(v, (dict, list)) else v)
         for k, v in params.items() if v is not None}
    ).encode()
    req = urllib.request.Request(API + method, data=data)
    try:
        with urllib.request.urlopen(req, timeout=65) as resp:
            payload = json.load(resp)
    except Exception as e:  # мережевий збій — не падаємо, просто повідомляємо
        print(f"[!] {method}: {e}")
        return None
    if not payload.get("ok"):
        print(f"[!] {method}: {payload}")
        return None
    return payload["result"]


def handle_message(msg: dict):
    chat_id = msg["chat"]["id"]
    text = (msg.get("text") or "").strip().lower()
    if text.startswith("/start") or text.startswith("/play"):
        call("sendGame", chat_id=chat_id, game_short_name=GAME_SHORT_NAME)
    elif text:
        call(
            "sendMessage",
            chat_id=chat_id,
            text="Надішли /play, щоб відкрити «Білий комірець» 🕵️",
        )
        call("sendGame", chat_id=chat_id, game_short_name=GAME_SHORT_NAME)


def handle_callback(q: dict):
    """Гравець натиснув «Play» — віддаємо адресу гри."""
    if q.get("game_short_name") == GAME_SHORT_NAME:
        call("answerCallbackQuery", callback_query_id=q["id"], url=GAME_URL)
    else:
        call(
            "answerCallbackQuery",
            callback_query_id=q["id"],
            text="Ця гра тут недоступна.",
        )


def handle_inline(q: dict):
    """@твій_бот у будь-якому чаті → картка гри (потрібен /setinline)."""
    call(
        "answerInlineQuery",
        inline_query_id=q["id"],
        results=[{"type": "game", "id": "1", "game_short_name": GAME_SHORT_NAME}],
        cache_time=0,
    )


def main():
    if not TOKEN or ":" not in TOKEN or any(ord(c) > 127 for c in TOKEN) or "СЮДИ_ТОКЕН" in TOKEN:
        raise SystemExit("Помилка: Токен не налаштовано або він має неправильний формат (наприклад, містить кирилицю чи плейсхолдери). Перевірте файл .env або змінні оточення.")
    me = call("getMe")
    if not me:
        raise SystemExit("Токен не працює — перевір TOKEN у налаштуваннях.")
    print(f"Бот @{me['username']} запущено. Гра: {GAME_SHORT_NAME} → {GAME_URL}")
    print("Зупинити: Ctrl+C")

    offset = None
    while True:
        updates = call("getUpdates", offset=offset, timeout=50,
                       allowed_updates=["message", "callback_query", "inline_query"])
        if updates is None:
            time.sleep(3)
            continue
        for upd in updates:
            offset = upd["update_id"] + 1
            try:
                if "message" in upd:
                    handle_message(upd["message"])
                elif "callback_query" in upd:
                    handle_callback(upd["callback_query"])
                elif "inline_query" in upd:
                    handle_inline(upd["inline_query"])
            except Exception as e:
                print(f"[!] обробка апдейту: {e}")


if __name__ == "__main__":
    main()
