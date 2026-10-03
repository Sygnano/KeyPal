// Sets the app's version everywhere it is written:
//   pnpm bump patch|fix   1.0.1 -> 1.0.2
//   pnpm bump minor       1.0.1 -> 1.1.0
//   pnpm bump major       1.0.1 -> 2.0.0
//   pnpm bump 1.2.0-rc.1  any version, typed in full
//   pnpm bump             asks (in a terminal)
//
// The release workflow requires package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml to
// agree, and Cargo.lock's entry for kboard-companion follows Cargo.toml (CI's `--locked` builds
// fail otherwise). Each file is edited in place, as text, so its formatting and line endings are
// kept. Nothing is committed: pushing the bumped version to main is what starts a release.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;
const USAGE = "usage: pnpm bump patch|fix|minor|major|<major.minor.patch>, e.g. pnpm bump minor or pnpm bump 1.0.1";

// Each pattern captures the text before the version; the first match is the one replaced.
const files = [
  ["package.json", /^(\s*"version":\s*")[^"]+(?=")/m],
  ["src-tauri/tauri.conf.json", /^(\s*"version":\s*")[^"]+(?=")/m],
  ["src-tauri/Cargo.toml", /^(\[package\][^[]*?\nversion = ")[^"]+(?=")/],
  ["src-tauri/Cargo.lock", /(\nname = "kboard-companion"\r?\nversion = ")[^"]+(?=")/],
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Read and check them all before writing any, so a failure leaves nothing half bumped.
const current = files.map(([path, pattern]) => {
  const text = readFileSync(join(root, path), "utf8");
  const match = text.match(pattern);
  if (!match) fail(`no version found in ${path}`);
  return { path, pattern, text, old: match[0].slice(match[1].length) };
});
const from = current[0].old;

// Semver: a pre-release bumps to its own release (1.1.0-rc.1 + minor = 1.1.0), as npm does.
function next(kind) {
  const m = from.match(VERSION);
  if (!m) fail(`package.json's version ${from} isn't major.minor.patch: give the new one in full`);
  const [major, minor, patch] = m.slice(1, 4).map(Number);
  const pre = Boolean(m[4]);
  switch (kind) {
    case "patch":
    case "fix":
      return pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
    case "minor":
      return pre && patch === 0 ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`;
    case "major":
      return pre && minor === 0 && patch === 0 ? `${major}.0.0` : `${major + 1}.0.0`;
  }
  return VERSION.test(kind) ? kind : null;
}

async function ask() {
  if (!process.stdin.isTTY) fail(USAGE);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`Current version: ${from}`);
  console.log(`  patch → ${next("patch")}\n  minor → ${next("minor")}\n  major → ${next("major")}`);
  const answer = (await rl.question("New version (patch, minor, major or a version): ")).trim();
  rl.close();
  return answer;
}

const arg = process.argv[2] ?? (await ask());
const version = next(arg);
if (!version) fail(`not a version or bump kind: ${arg}\n${USAGE}`);

const others = current.filter((f) => f.old !== from);
for (const f of others) console.warn(`note: ${f.path} had ${f.old}, not ${from}`);

for (const { path, pattern, text, old } of current) {
  writeFileSync(join(root, path), text.replace(pattern, `$1${version}`));
  console.log(`${path}: ${old} -> ${version}`);
}
