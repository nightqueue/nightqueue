import assert from "node:assert/strict";
import { test } from "node:test";
import { addFormProblem, buildAddArgs, clearOrigin, EMPTY_ADD_FORM, effectiveProject } from "../../studio/src/lib/addJobForm.ts";
import { issueDraft } from "../../studio/src/lib/tracker.ts";

const URL = "https://linear.app/acme/issue/MK-42";

const ISSUE = { ref: "MK-42", title: "Fix the signup", team: "MK", state: { name: "Todo", type: "unstarted" }, priority: 2, priorityLabel: "High", labels: [], url: URL, updatedAt: null };

// The drawer form opened from the issue, with the given fields over it.
function issueForm(fields = {}) {
  const draft = issueDraft(ISSUE, "linear");
  return { ...EMPTY_ADD_FORM, text: draft.text, origin: draft.origin, originUrl: draft.originUrl, ...fields };
}

test("a plain Add job defaults to the first project; a job with an origin requires one", () => {
  assert.equal(effectiveProject({ project: "", origin: null }, "alpha"), "alpha");
  assert.equal(effectiveProject({ project: "beta", origin: null }, "alpha"), "beta");
  assert.equal(effectiveProject({ project: "", origin: { kind: "linear", ref: "MK-42" } }, "alpha"), "");
  assert.equal(addFormProblem(issueForm()), "choose a project");
  assert.equal(addFormProblem(issueForm({ project: "beta" })), null);
});

test("buildAddArgs sends the origin only when set and never the origin URL", () => {
  const args = buildAddArgs(issueForm({ project: "beta" }));
  assert.deepEqual(args, { project: "beta", prompt: `Fix the signup\n\n${URL}`, priority: 5, origin: { kind: "linear", ref: "MK-42" } });
  assert.equal("originUrl" in args, false);
  assert.equal("origin" in buildAddArgs({ ...EMPTY_ADD_FORM, project: "beta", text: "x" }), false);
});

test("clearOrigin drops the origin and the prefilled URL line, keeping the title and the typed note", () => {
  const form = issueForm({ text: `${issueForm().text}please add a test` });
  const cleared = clearOrigin(form);
  assert.equal(cleared.text, "Fix the signup\n\nplease add a test");
  assert.equal(cleared.origin, false);
  assert.equal(cleared.originUrl, null);
  assert.equal(buildAddArgs({ ...cleared, project: "beta" }).origin, false);
  assert.equal(clearOrigin(issueForm()).text, "Fix the signup\n\n");
});

test("a cleared chip sends origin false even when the kept title names the issue, and keeps requiring a project", () => {
  const cleared = clearOrigin({ ...issueForm(), text: `Linear MK-9 crash\n\n${URL}\n\n` });
  assert.equal(cleared.text.includes("Linear MK-9 crash"), true);
  assert.equal(cleared.text.includes(URL), false);
  assert.equal(buildAddArgs({ ...cleared, project: "beta" }).origin, false);
  assert.equal(effectiveProject({ project: "", origin: false }, "alpha"), "");
  assert.equal(effectiveProject({ project: "", origin: null }, "alpha"), "alpha");
  assert.equal(Object.hasOwn(buildAddArgs({ ...EMPTY_ADD_FORM, project: "beta", text: "Linear MK-9 crash" }), "origin"), false);
});

test("clearOrigin leaves a text whose URL line is already gone, and keeps another URL the operator typed", () => {
  const edited = issueForm({ text: "Fix the signup\n\nsee https://linear.app/acme/issue/MK-7" });
  assert.equal(clearOrigin(edited).text, "Fix the signup\n\nsee https://linear.app/acme/issue/MK-7");
  const other = issueForm({ text: `Fix the signup\n\n${URL}\n\nhttps://example.com/spec\n` });
  assert.equal(clearOrigin(other).text, "Fix the signup\n\nhttps://example.com/spec\n");
});
