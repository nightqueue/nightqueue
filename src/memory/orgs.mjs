// The two tables that still own rows by org name, which a rename must follow inside the transaction that renames the org.
export const ORG_TABLES = ["decisions", "roadmap_items"];

// Rewrites the org of every decision and roadmap item an org rename moves; it runs inside the caller's transaction.
export function renameOrgRows(db, oldName, newName) {
  for (const table of ORG_TABLES) {
    db.prepare(`UPDATE ${table} SET org = ? WHERE scope = 'org' AND org = ?`).run(newName, oldName);
  }
}
