CREATE TABLE IF NOT EXISTS terms_acceptances (
  user_id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES players(user_id)
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  user_chat_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('support', 'payment')),
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES players(user_id)
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user_status
  ON support_tickets(user_id, status, id);

CREATE TABLE IF NOT EXISTS support_messages (
  admin_message_id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL,
  user_message_id INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(ticket_id) REFERENCES support_tickets(id)
);

CREATE TABLE IF NOT EXISTS refunds (
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
);
