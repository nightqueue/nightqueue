import { UserError } from "../config/errors.mjs";
import { runReflectWorker } from "../hooks/reflect-worker.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

const USAGE = "nightshift reflect [--transcript <path>] [--session <id>]";

// Summary line of one reflection run.
function formatResult(result) {
  const counts = `saved=${result.saved} merged=${result.merged} violations=${result.violations} memories=${result.memories}`;
  return result.skipped ? `${counts} skipped=${result.skipped}` : counts;
}

// Runs `nightshift reflect`: extracts the lessons of a transcript now, in the foreground.
export async function run(argv, ctx) {
  const { values, positionals } = parseCommand(argv, {
    transcript: { type: "string" },
    session: { type: "string" },
  });
  checkArgs(positionals, { max: 0, usage: USAGE });
  if (!values.transcript) throw new UserError(`\`nightshift reflect\` requires --transcript <path>; usage: ${USAGE}`);
  const result = await runReflectWorker(
    { transcriptPath: values.transcript, cwd: process.cwd(), sessionId: values.session ?? "manual" },
    { env: ctx.env, log: ctx.err },
  );
  ctx.out(formatResult(result));
}
