#!/usr/bin/env node
"use strict"
// Launcher: the published artifact is the bundled dist. The rename script
// renames this file when the CLI gets its real name; it keeps loading ../dist/bin.cjs.
// A CLI starts over and over: V8's compile cache (kept by Node in the OS temp
// directory) lets every run after the first skip most of the bundle's compile.
require("node:module").enableCompileCache()
require("../dist/bin.cjs")
