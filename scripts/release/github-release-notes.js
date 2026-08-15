export function extractChangelogEntry(changelogText, version) {
  if (typeof changelogText !== "string" || !changelogText.trim()) return null;

  const lines = changelogText.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (headingIndex < 0) return null;

  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      endIndex = index;
      break;
    }
  }

  const entry = lines.slice(headingIndex + 1, endIndex).join("\n").trim();
  return entry || null;
}

export function buildReleaseBody(changes) {
  const lines = [
    "## Published packages",
    "",
  ];

  for (const change of changes) {
    lines.push(`- \`${change.name}@${change.version}\``);
  }

  const packagesWithNotes = changes.filter((change) => change.notes);
  if (packagesWithNotes.length > 0) {
    lines.push("", "## Package notes", "");
    for (const change of packagesWithNotes) {
      lines.push(
        `### \`${change.name}@${change.version}\``,
        "",
        change.notes,
        "",
      );
    }
  }

  return lines.join("\n").trim();
}
