# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/chainsighthq/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/chainsighthq/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies the edits AI models write — unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls — to a tree of files, with 3-tier fuzzy line matching and all-or-nothing atomic writes. Practice score 100/100.

Built for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) ($100 in USDC).

## Run it

```sh
node main.ts [options] [PATCH]
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=h6yg6dhk&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`. It implements SPEC.md sections 1 to 10: the command line, the output, safe paths, format detection, JSON edits, the all-or-nothing write, unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8) and line matching at three tiers (section 5). Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set: keep them.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what main.ts did (its exit code, its stdout and the files left in the directory).
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## The four patch formats

1. **Unified diff** — often with wrong line numbers; mend re-anchors hunks with 3-tier fuzzy matching.
2. **SEARCH/REPLACE blocks** (`<<<<<<< SEARCH ... ======= ... >>>>>>> REPLACE`).
3. **V4A patches** (`*** Begin Patch ... *** End Patch`).
4. **JSON tool calls** (array or JSON Lines: `create` / `str_replace` / `insert`).

Line matching runs in three tiers: tier 0 exact, tier 1 ignoring trailing whitespace, tier 2 ignoring leading and trailing whitespace with re-indentation. Every edit is atomic — all files change or none do.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It passes when the exit code, everything written to stdout and every file afterwards are exactly what SPEC.md says. stderr is never compared, so write what you like there. Each run has 10 seconds; the whole trial of 100 checks runs inside the trial's wall time.

## What makes a good entry

The checks are written the way models get edits wrong: wrong line numbers, drifted whitespace and indentation, blank context lines without their leading space, prose and code fences around the patch, CRLF files, files without a final line break, blocks that occur twice. Read SPEC.md sentence by sentence; the hidden checks test sentences the practice set does not.
