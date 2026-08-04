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
