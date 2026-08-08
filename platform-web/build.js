// platform-web/build.js — Vercel build step.
//
// On Vercel, Project Settings has Root Directory set to "platform-web", so
// this script's cwd (__dirname) IS the entire deployment. Its one job: pull
// in the one real dependency that crosses that boundary — core/*.js — plus
// the app icon, as gitignored copies (see platform-web/.gitignore), never a
// second source of truth. Symlinks were considered and rejected: they're
// documented as unreliable on Vercel's Git-based build system.
//
// IMPORTANT Vercel project setting this script depends on: by default,
// Vercel does NOT check out anything outside Root Directory into the build
// container, so ../core would not exist and this script would fail there
// even though it works locally. "Include source files outside of the Root
// Directory in the Build Step" must be enabled in Project Settings > Root
// Directory for ../core and ../icon.png to be reachable at build time.
//
// A plain Node script rather than a shell script, deliberately: shell
// scripts committed from a Windows dev machine lose their executable bit on
// clone (git doesn't track Unix permissions the same way), causing
// "Permission denied" on Vercel's Linux build container unless
// `git update-index --chmod=+x` is remembered on every single commit that
// touches the script. `node build.js` needs no executable bit at all —
// package.json's "build" script just invokes the Node interpreter on it.
const fs = require("fs");
const path = require("path");

const ROOT = __dirname; // platform-web/
const SOURCE_CORE = path.join(ROOT, "..", "core");
const DEST_CORE = path.join(ROOT, "core");
const SOURCE_ICON = path.join(ROOT, "..", "icon.png");
const DEST_ICON = path.join(ROOT, "icon.png");

function fail(message) {
  console.error(`\nBuild failed: ${message}`);
  console.error(
    "If this is happening on Vercel (but not locally), check Project Settings > " +
      'Root Directory > "Include source files outside of the Root Directory in the ' +
      'Build Step" is enabled — without it, ../core and ../icon.png are not present ' +
      "in the build container at all.\n",
  );
  process.exit(1);
}

if (!fs.existsSync(SOURCE_CORE)) {
  fail(`source directory not found: ${SOURCE_CORE}`);
}

fs.mkdirSync(DEST_CORE, { recursive: true });

const coreFiles = fs
  .readdirSync(SOURCE_CORE)
  .filter((f) => f.endsWith(".js"));

if (coreFiles.length === 0) {
  fail(`no .js files found in ${SOURCE_CORE} — nothing to copy`);
}

for (const file of coreFiles) {
  fs.copyFileSync(path.join(SOURCE_CORE, file), path.join(DEST_CORE, file));
  console.log(`copied core/${file}`);
}

if (!fs.existsSync(SOURCE_ICON)) {
  fail(`icon not found: ${SOURCE_ICON}`);
}
fs.copyFileSync(SOURCE_ICON, DEST_ICON);
console.log("copied icon.png");

console.log(
  `\nBuild complete: ${coreFiles.length} core file(s) + icon.png copied into platform-web/.`,
);
