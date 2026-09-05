import { existsSync } from "node:fs";
import { configPath, secretsPath } from "../config/paths.mjs";
import { emptyConfig, emptySecrets } from "../config/schema.mjs";
import { ensureHome } from "../config/store.mjs";
import { checkArgs, parseCommand } from "./args.mjs";

// Cria um arquivo da estrutura apenas quando ele ainda nao existe.
function ensureFile({ path, create, createdMessage, existsMessage, out }) {
  if (existsSync(path)) {
    out(existsMessage);
    return;
  }
  create();
  out(createdMessage);
}

// Cria a estrutura de configuracao sem alterar nada do que ja existe.
export async function run(argv, ctx) {
  const { positionals } = parseCommand(argv);
  checkArgs(positionals, { max: 0, usage: "shift setup" });
  const home = ensureHome(ctx.env);
  ctx.out(home.created ? `created ${home.path} (0700)` : `${home.path} already exists`);
  const config = emptyConfig();
  ensureFile({
    path: configPath(ctx.env),
    create: () => ctx.saveConfig(config, ctx.env),
    createdMessage: `created config.json (org \`${config.defaultOrg}\`)`,
    existsMessage: "config.json already exists",
    out: ctx.out,
  });
  ensureFile({
    path: secretsPath(ctx.env),
    create: () => ctx.saveSecrets(emptySecrets(), ctx.env),
    createdMessage: "created secrets.json (0600)",
    existsMessage: "secrets.json already exists",
    out: ctx.out,
  });
}
