import { addColumnIfMissing } from "../columns.mjs";

// Adds the v21 columns on every open (never in the rebuilt DDLs): the origin of a job and the integrations of a project.
export function migrateV21Columns(db) {
  addColumnIfMissing(db, "jobs", "origin", "TEXT");
  addColumnIfMissing(db, "projects", "integrations", "TEXT");
}
