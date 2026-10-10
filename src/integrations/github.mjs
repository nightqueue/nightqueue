import { ghAccountStatus, ghBin } from "../host/gh.mjs";

export const github = {
  kind: "github",
  label: "GitHub",
  description: "Clones, pushes and opens the pull requests of every job through the machine's authenticated gh.",
  card: { order: 3 },
  ambient: {
    status: (env) => ghAccountStatus({ env }),
    connect: (env) => ({ bin: ghBin(env), args: ["auth", "login", "--web"] }),
    command: "gh auth login --web",
    hint: "nightqueue uses the machine's authenticated gh; run `gh auth login`",
  },
};
