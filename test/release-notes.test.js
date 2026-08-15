import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReleaseBody,
  extractChangelogEntry,
} from "../scripts/release/github-release-notes.js";

test("extractChangelogEntry selects only the requested Changesets entry", () => {
  const changelog = `# packages

## 0.2.0

### Minor Changes

- Add segment streaming with detailed context.

## 0.1.1

### Patch Changes

- Fix navigation state.
`;

  assert.equal(
    extractChangelogEntry(changelog, "0.2.0"),
    "### Minor Changes\n\n- Add segment streaming with detailed context.",
  );
  assert.equal(extractChangelogEntry(changelog, "9.9.9"), null);
});

test("buildReleaseBody combines published workspaces and their explanatory notes", () => {
  const body = buildReleaseBody([
    {
      name: "evolit",
      version: "0.2.0",
      notes: "### Minor Changes\n\n- Add segment streaming with detailed context.",
    },
    {
      name: "@evolit/adapter",
      version: "0.1.0",
      notes: "### Patch Changes\n\n- Add the adapter contract.",
    },
  ]);

  assert.match(body, /`evolit@0\.2\.0`/);
  assert.match(body, /`@evolit\/adapter@0\.1\.0`/);
  assert.match(body, /## Package notes/);
  assert.match(body, /Add segment streaming with detailed context\./);
  assert.match(body, /Add the adapter contract\./);
});
