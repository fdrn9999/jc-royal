-- Whether a showdown hand was face up for the table (false: mucked). Existing rows stay NULL and read as went_to_showdown,
-- so nothing is rewritten and the column is added in constant time.
ALTER TABLE `hand_players` ADD `shown` integer;