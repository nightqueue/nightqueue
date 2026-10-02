import { UserError } from "../config/errors.mjs";
import { ensureHome } from "../config/store.mjs";
import { checkArgs, parseCommand } from "./args.mjs";
import { guardIdleRuntime } from "./install-guard.mjs";
import { migrateSchemaStep, setupRuntime } from "./install-steps.mjs";
import { makeReport } from "./report.mjs";
import { migrateHomeSchema } from "./schema-migrate.mjs";
import { finish, registerHost } from "./setup.mjs";

const USAGE = "nightqueue update [<version>] [--from <dir>] [--force]";

const VERSION_SHAPE = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

// Version the user asked the registry for, refusing anything that would reach npm as another package or as a flag.
function wantedVersion(positionals, from) {
  const asked = (positionals[0] ?? "").trim();
  if (!asked) return undefined;
  if (typeof from === "string" && from.trim()) {
    throw new UserError(`\`--from\` installs a local source, so it cannot be combined with a version; usage: ${USAGE}`);
  }
  if (!VERSION_SHAPE.test(asked)) throw new UserError(`\`${asked}\` is not a version or a tag; usage: ${USAGE}`);
  return asked;
}

// Runs the internal `update --schema-only` step: the database migration alone, which takes no version, source nor `--force`.
async function schemaOnly(values, positionals, ctx) {
  if (positionals.length || values.from !== undefined || values.force !== undefined) {
    throw new UserError("`--schema-only` migrates the database alone and takes no version, `--from` nor `--force`; usage: nightqueue update --schema-only");
  }
  await migrateHomeSchema(ctx);
  return 0;
}

// Runs `nightqueue update`: reinstalls the runtime, migrates the database with it, and re-points the host at it, never touching config or secrets; a runtime that could not be reinstalled or a database that could not be migrated is an exit code.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, {
    from: { type: "string" },
    force: { type: "boolean" },
    "schema-only": { type: "boolean" },
  });
  if (values["schema-only"] === true) return await schemaOnly(values, positionals, ctx);
  checkArgs(positionals, { max: 1, usage: USAGE });
  const version = wantedVersion(positionals, values.from);
  await guardIdleRuntime(ctx, { force: values.force });
  const report = makeReport(ctx);
  ensureHome(ctx.env);
  const ready = setupRuntime(ctx, report, { from: values.from, force: true, version });
  const schemaOk = migrateSchemaStep(ctx, report, { ready });
  registerHost(ctx, report, { ready });
  const code = finish(ctx, report);
  return ready && schemaOk ? code : 1;
}
