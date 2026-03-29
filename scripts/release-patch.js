#!/usr/bin/env node
import {execSync} from "node:child_process"

/** @param {string} command */
function run(command) {
  execSync(command, {stdio: "inherit"})
}

/** Ensures the release runs from the latest local `master` synced with `origin/master`. */
function ensureLatestMaster() {
  run("git checkout master")
  run("git fetch origin")
  run("git merge origin/master")
}

try {
  execSync("npm whoami", {stdio: "ignore"})
} catch {
  run("npm login")
}

ensureLatestMaster()

// Bump patch version without creating a git tag.
run("npm version patch --no-git-tag-version")

// Install dependencies.
run("npm install")

// Commit version bump and lockfile changes.
run("git add package.json package-lock.json")
run('git commit -m "chore: bump patch version"')

// Push to the current remote/branch.
run("git push origin master")

// Publish to npm (requires correct auth).
run("npm publish")
