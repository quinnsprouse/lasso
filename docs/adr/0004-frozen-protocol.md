# The output protocol is frozen additively

Agents and models cache invocation patterns, so command names, flags, exit codes, error codes, and envelope fields never change after 1.0 — only additions are allowed, and `schemaVersion` exists so a breaking protocol could ship behind `--output-version`. Plans must stay deterministic for identical state and input, because confirmation replays the planner and compares tokens.
