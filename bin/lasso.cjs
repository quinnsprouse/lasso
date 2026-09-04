#!/usr/bin/env node
"use strict"
// Launcher: the published artifact is the bundled dist. The rename script
// renames this file when the CLI gets its real name; it keeps loading ../dist/bin.cjs.
require("../dist/bin.cjs")
