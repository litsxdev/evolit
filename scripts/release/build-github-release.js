import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReleaseBody,
  extractChangelogEntry,
} from "./github-release-notes.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const requestedRef = process.argv.find((argument) => argument.startsWith("--ref="));
const releaseRef = requestedRef ? requestedRef.slice("--ref=".length) : "HEAD";
const previousRef = `${releaseRef}^`;

function readTextAtRef(ref, filePath) {
  return execFileSync("git", ["show", `${ref}:${filePath}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function readJsonAtRef(ref, filePath) {
  return JSON.parse(readTextAtRef(ref, filePath));
}

function readReleaseText(filePath) {
  if (releaseRef === "HEAD") {
    return fs.readFileSync(path.join(repoRoot, filePath), "utf8");
  }
  return readTextAtRef(releaseRef, filePath);
}

function getPublicPackageDirectories() {
  const packagesRoot = path.join(repoRoot, "packages");
  return fs.readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
    .filter((packageDir) => {
      const manifestPath = path.join(repoRoot, packageDir, "package.json");
      if (!fs.existsSync(manifestPath)) return false;
      return !JSON.parse(fs.readFileSync(manifestPath, "utf8")).private;
    })
    .sort();
}

function getChangedPackages() {
  const changes = [];
  for (const packageDir of getPublicPackageDirectories()) {
    const packageJsonPath = `${packageDir}/package.json`;
    const changelogPath = `${packageDir}/CHANGELOG.md`;
    const currentPackage = releaseRef === "HEAD"
      ? JSON.parse(fs.readFileSync(path.join(repoRoot, packageJsonPath), "utf8"))
      : readJsonAtRef(releaseRef, packageJsonPath);
    const previousPackage = readJsonAtRef(previousRef, packageJsonPath);
    if (currentPackage.version === previousPackage.version) continue;

    let changelogText = null;
    try {
      changelogText = readReleaseText(changelogPath);
    } catch {
      // A changelog is optional, but explanatory notes are included whenever
      // Changesets generated one for the package.
    }

    changes.push({
      name: currentPackage.name,
      version: currentPackage.version,
      packageDir,
      tagName: `${currentPackage.name}@${currentPackage.version}`,
      notes: extractChangelogEntry(changelogText, currentPackage.version),
    });
  }
  return changes;
}

const releaseCommitSha = execFileSync("git", ["rev-parse", releaseRef], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
const releaseDate = execFileSync("git", ["show", "-s", "--format=%cs", releaseRef], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();
const changes = getChangedPackages();
const shortSha = releaseCommitSha.slice(0, 7);

const release = {
  tagName: `release-${shortSha}`,
  targetCommitish: releaseCommitSha,
  name: `Evolit release ${releaseDate}`,
  releaseDate,
  body: buildReleaseBody(changes),
  packages: changes.map(({ name, version, packageDir, tagName }) => ({
    name,
    version,
    packageDir,
    tagName,
  })),
};

process.stdout.write(`${JSON.stringify(release, null, 2)}\n`);
