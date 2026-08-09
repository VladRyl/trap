CREATE TABLE IF NOT EXISTS ad_rewards (
  reward_key TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  block_id TEXT NOT NULL,
  level INTEGER NOT NULL,
  checkpoint INTEGER NOT NULL,
  deaths INTEGER NOT NULL,
  lives INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  granted_at INTEGER,
  FOREIGN KEY(user_id) REFERENCES players(user_id)
);

CREATE INDEX IF NOT EXISTS idx_ad_rewards_user_created
  ON ad_rewards(user_id, created_at);
