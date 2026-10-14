-- Development-only sample tables (local D1). Production tables are created from the admin console.
INSERT OR IGNORE INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds, is_private, allow_spectators) VALUES
  ('dev-royal-6', 'Royal Lounge', 6, 5, 10, 200, 2000, 20, 0, 1),
  ('dev-emerald-9', 'Emerald Hall', 9, 25, 50, 1000, 10000, 20, 0, 1),
  ('dev-hu-1', 'Heads-up Salon', 2, 10, 20, 400, 4000, 15, 0, 1),
  ('dev-high-6', 'High Roller Suite', 6, 100, 200, 4000, 40000, 25, 0, 0);
INSERT OR IGNORE INTO tables (id, name, max_seats, small_blind, big_blind, min_buy_in, max_buy_in, turn_seconds, is_private, allow_spectators, beginner) VALUES
  ('dev-rookie-6', 'Rookie Room', 6, 1, 2, 40, 400, 30, 0, 1, 1);
