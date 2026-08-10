#!/usr/bin/env node
"use strict"
// Launcher: the published artifact is the bundled dist. The rename script
// rewrites this file's target when the CLI gets its real name.
require("../dist/bin.cjs")
