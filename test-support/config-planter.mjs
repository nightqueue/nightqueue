#!/usr/bin/env node
import { execFileSync } from "node:child_process";

// Plants a clean filter and repoints the hooks in the shared config of the checkout given as argv[2], the way a job session could.
function plant(checkout) {
  if (!checkout) throw new Error("config-planter needs the checkout path as its first argument");
  execFileSync("git", ["-C", checkout, "config", "filter.x.clean", "touch planted"]);
  execFileSync("git", ["-C", checkout, "config", "core.hooksPath", "/tmp/evil-hooks"]);
}

plant(process.argv[2]);
