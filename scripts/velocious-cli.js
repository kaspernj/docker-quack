#!/usr/bin/env node

import fs from "node:fs/promises"
import {glob} from "glob"

/**
 * Node 20 compatibility shim for Velocious CLI usage of fs.promises.glob.
 * @returns {void}
 */
function ensureFsGlob() {
  if (typeof fs.glob == "function") {
    return
  }

  fs.glob = async function * fsGlobShim(pattern) {
    const matches = await glob(pattern)

    for (const match of matches) {
      yield match
    }
  }
}

ensureFsGlob()
await import("velocious/build/bin/velocious.js")
