CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  event_name TEXT NOT NULL,
  event_key TEXT UNIQUE,
  level INTEGER,
  value INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES players(user_id)
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_name_time
  ON analytics_events(event_name, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_time
  ON analytics_events(user_id, created_at);

CREATE TABLE IF NOT EXISTS player_acquisition (
  user_id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  start_param TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES players(user_id)
);
CREATE INDEX IF NOT EXISTS idx_player_acquisition_source
  ON player_acquisition(source, created_at);

CREATE TABLE IF NOT EXISTS referral_codes (
  code TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES players(user_id)
);

CREATE TABLE IF NOT EXISTS referrals (
  referred_user_id INTEGER PRIMARY KEY,
  referrer_user_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  qualified_at INTEGER,
  reward_granted_at INTEGER,
  reward_token TEXT UNIQUE,
  FOREIGN KEY(referred_user_id) REFERENCES players(user_id),
  FOREIGN KEY(referrer_user_id) REFERENCES players(user_id),
  FOREIGN KEY(code) REFERENCES referral_codes(code),
  CHECK(referred_user_id <> referrer_user_id)
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer
  ON referrals(referrer_user_id, qualified_at);
