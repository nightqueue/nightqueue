#!/usr/bin/env node
// The `claude` of the studio demo: it commits the files its plan names in the worktree it runs in, prints the planned
// stream-json of that job and exits. It never reaches the network nor the real Claude configuration.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const plan = JSON.parse(readFileSync(process.env.NIGHTQUEUE_DEMO_PLAN, "utf8"));
const job = plan.jobs[String(process.env.NIGHTQUEUE_JOB_ID ?? "")];
if (!job) {
  process.stderr.write(`studio demo claude: no plan for job ${process.env.NIGHTQUEUE_JOB_ID}\n`);
  process.exit(97);
}

const GIT_IDENTITY = ["-c", "user.name=nightqueue", "-c", "user.email=nightqueue@example.invalid", "-c", "commit.gpgsign=false"];
for (const file of job.files ?? []) {
  const path = join(process.cwd(), file.path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, file.content);
  execFileSync("git", [...GIT_IDENTITY, "add", file.path], { cwd: process.cwd() });
}
if (job.files?.length) execFileSync("git", [...GIT_IDENTITY, "commit", "-q", "-m", job.commitMessage ?? "feat: the change of the job"], { cwd: process.cwd() });

process.stdout.write(job.stream);
process.exitCode = 0;
