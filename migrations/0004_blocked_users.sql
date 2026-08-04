CREATE TABLE IF NOT EXISTS blocked_users (
  user_id INTEGER PRIMARY KEY,
  blocked_by INTEGER NOT NULL,
  ticket_id INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES players(user_id),
  FOREIGN KEY(ticket_id) REFERENCES support_tickets(id)
);

CREATE INDEX IF NOT EXISTS idx_blocked_users_created
  ON blocked_users(created_at);
