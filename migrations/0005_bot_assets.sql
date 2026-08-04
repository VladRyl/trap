CREATE TABLE IF NOT EXISTS bot_assets (
  asset_key TEXT PRIMARY KEY,
  telegram_file_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
