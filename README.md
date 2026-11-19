# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Permana61/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Permana61/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node process: git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4 and MCP from its own in-memory store. No git binary, no database, no UI — just `node main.ts`.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own; the flag is harmless there and makes an older local Node work too. There is nothing to install: the program imports `node:http` and its own modules only.

## How it works

- **Lifecycle** (`main.ts`): bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register`, poll `GET $MAKEFUN_ENV_URL/done`, exit 0.
- **Store** (`src/store.ts`): in-memory repos, issues, pull requests, labels and comments, plus the git object store (refs + objects), shared by all four surfaces.
- **Git** (`src/git-objects.ts`, `src/git-http.ts`): pkt-line framing, packfile read/write (zlib, OFS/REF deltas), upload-pack v2 (ls-refs, fetch, shallow/deepen, incremental), receive-pack v0 with report-status and fast-forward enforcement.
- **REST v3** (`src/rest.ts`): repositories, branches, commits, contents, labels, issues, comments, pull requests and squash merges.
- **GraphQL v4** (`src/graphql.ts`): hand-written parser and executor for the documents `gh` and `github-mcp-server` send, plus introspection, `node(id:)` and batched operations.
- **MCP** (`src/mcp.ts`): Streamable HTTP, `server/discover` (revision 2026-07-28), `tools/list` and six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

Practice grade (kit's sealed suite, 3 practice instances): **120/120 conformance, mean score 991/1000** — feature 600, agent 200, perf ~191.

---

<sub>Entered on [make.fun](https://make.fun/?ref=3zcdv8qs&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
