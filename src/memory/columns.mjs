// Tells whether a table carries a column, reading its schema on the given connection.
export function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

// Adds a column when it is missing, tolerating a concurrent process that added it first.
export function addColumnIfMissing(db, table, column, definition) {
  if (hasColumn(db, table, column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    if (!String(err?.message ?? "").includes("duplicate column name")) throw err;
  }
}

// Drops a column when it is present, tolerating a concurrent process that dropped it first.
export function dropColumnIfPresent(db, table, column) {
  if (!hasColumn(db, table, column)) return;
  try {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  } catch (err) {
    if (!/no such column/i.test(String(err?.message ?? ""))) throw err;
  }
}
