# Milestone 02 — Actual sink

Status: not started
Last updated: 2026-08-16
Depends on: [architecture.md](./architecture.md), [01-read-email.md](./01-read-email.md)

## Goal

Write parsed transactions into Actual Budget, idempotently, against a disposable local
server. No production budget is touched at any point in this milestone.

```
Gmail → Parse → Normalize → Actual
```

This is architecture.md §9 step 3, and the first step that needs a native toolchain.
`markProcessed` and Gmail labelling stay out — they belong to §4's ordering guarantee,
which only becomes meaningful once the CLI exists.

### Done when

```bash
docker compose -f docker/compose.yaml up -d
npm run check              # typecheck + lint + offline tests, no Docker needed
npm run test:integration   # real Actual server, throwaway budget
```

and:

- Running the importer twice produces **one** transaction, not two.
- `npm run check` still passes with Docker stopped and no credentials present.
- No code under `adapters/parser.ts` changed.

---

## 0. Prerequisites

### Native toolchain

```bash
npm i @actual-app/api
```

This is the first dependency needing a compiler — `better-sqlite3` builds on install.
Fine on darwin; architecture.md §1 chose npm precisely so `buildNpmPackage` handles it
on the NixOS side. Confirm what actually got pulled:

```bash
npm ls better-sqlite3
```

architecture.md §1 assumes it arrives via the local budget cache but has never verified
it against the dep tree. Do that here and record the answer.

### Local server

See §1. One-time budget creation in the UI, then the sync id goes in `.env.test`.

---

## 1. Local Actual server

`docker/compose.yaml`. Dev-only infrastructure, kept out of the repo root because
deployment is NixOS — nothing here ships.

```yaml
services:
  actual:
    image: actualbudget/actual-server:25.10.0   # PIN — see below
    container_name: mail-bean-actual
    ports:
      - "5006:5006"
    volumes:
      - actual-data:/data
    environment:
      ACTUAL_UPLOAD_FILE_SYNC_SIZE_LIMIT_MB: 20
    restart: unless-stopped

volumes:
  actual-data:
```

**The image tag above is a placeholder and has not been verified.** Set it to whatever
release you actually pull — check the tag list on Docker Hub or the GitHub releases page
— and never leave it on `latest`. Pinned means the integration suite fails for a reason
you changed, not a reason upstream changed overnight. Bump it deliberately; an upstream
break in the sink is exactly the news this milestone exists to surface, and it is only
useful news if it arrives when you are looking.

**Named volume, persisted.** The budget survives `down`/`up`, so the sync id in
`.env.test` stays valid and setup is genuinely one-time. The tradeoff is that state
accumulates across runs — see §3 for why that does *not* leak into the tests.

Nuking it is one command when you want a clean slate:

```bash
docker compose -f docker/compose.yaml down -v
```

### One-time budget setup

1. `docker compose -f docker/compose.yaml up -d`
2. Open `http://localhost:5006`, set a server password.
3. Create a budget file. Name it something unmistakable — `mail-bean-test`.
4. **Do not enable end-to-end encryption.**
5. Settings → Advanced → copy the **Sync ID**.
6. Create the accounts the parsers emit — one per `sourceAccount`, currently `yucho`
   and `smbc`. Type `checking` is fine; the sink does not care.
7. Put the values in `.env.test` (gitignored, same shape as `.env.dist`):

```
MAIL_BEAN_ACTUAL_SERVER_URL=http://localhost:5006
MAIL_BEAN_ACTUAL_SYNC_ID=<sync id from step 5>
MAIL_BEAN_ACTUAL_PASSWORD=<password from step 2>
MAIL_BEAN_ACTUAL_DATA_DIR=<per-run temp dir; see §3>
```

`MAIL_BEAN_ACTUAL_E2E_PASSWORD` stays unset. architecture.md §7 already requires
`config.ts` to treat an empty value as absent, since `cp .env.dist .env` yields one.

**Known gap from skipping encryption:** `downloadBudget` takes a separate E2E password,
and that branch will be entirely untested. If the production server has E2E enabled, the
first real run exercises that code path for the first time. Either confirm production is
unencrypted, or accept it as a deliberate hole and test it by hand once before pointing
`run` at production.

---

## 2. The sink

| File | Contents |
|---|---|
| `adapters/sink/actual.ts` | `init` → `downloadBudget` → `importTransactions` → `shutdown` |
| `ports.ts` | Define `Sink` and `WriteResult` — first time either exists |

`Sink` is a function type per architecture.md §2. It is the one port with a single
implementation, which §2 now explicitly permits: constructing the real one needs a
compiler, a server and a credential, so without a seam there is no way to test anything
upstream of it.

### `importTransactions`, not `addTransactions`

**This is the whole milestone.** `@actual-app/api` exposes both, and only
`importTransactions` deduplicates on `imported_id`. `addTransactions` inserts
unconditionally.

architecture.md §3 maps `dedupId` → `imported_id`, and §4's ordering guarantee
("push to the sink first, label only after the sink confirms") is *entirely* load-bearing
on that dedup working — the guarantee is at-least-once, and at-least-once is only safe
because a re-import is a no-op. Pick the wrong function and every retry silently
duplicates real financial data.

Verify it empirically before building anything on top. That is §3's headline test.

### `accountMap`

`sourceAccount` is a logical name (`"smbc"`), never an Actual UUID — architecture.md §3.
The sink resolves logical → UUID through operator config.

The local test budget's UUIDs differ from production's, which is the first real proof
that this indirection was the right call. **The integration test must call
`getAccounts()` and resolve by name at runtime, never hardcode a UUID** — hardcoding
would silently bind the suite to one budget file and break on `down -v`.

Whether `MAIL_BEAN_ACCOUNT_MAP` stays JSON-in-env is still open (architecture.md §7 calls
it provisional). This milestone is where it gets exercised, so decide it here.

### `WriteResult`

Referenced by `Sink` since architecture.md §2 was written, never defined. Minimum it has
to answer: how many transactions were sent, how many Actual actually created, and which
were dropped as duplicates. That third number is what makes a re-run legible instead of
mysterious.

---

## 3. Test strategy

Two suites, two configs, one of them opt-in.

| | `npm test` | `npm run test:integration` |
|---|---|---|
| Runs in `npm run check` | yes | **no** |
| Needs Docker | no | yes |
| Needs credentials | no | `.env.test` |
| Covers | parsers (goldens), pipeline logic via a fake `Sink` | the real Actual adapter |
| Speed | ~150ms | seconds |

```jsonc
// package.json
"test": "vitest run",
"test:integration": "vitest run -c vitest.integration.config.ts",
"check": "npm run typecheck && npm run lint && npm test"
```

Two small config files rather than `test.projects`: the suites differ only in which
files they collect, and `projects` exists for genuinely different *configurations*.

```ts
// vitest.config.ts — the default suite excludes integration
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/.git/**", "**/*.integration.test.ts"],
  },
});
```

```ts
// vitest.integration.config.ts
export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    testTimeout: 30_000,
  },
});
```

Note the default `exclude` must be restated in full — the CLI and config `exclude`
replace the defaults rather than appending, and dropping `**/node_modules/**` would
collect the world. This is also the point where 01's "you don't need a `vitest.config.ts`"
advice expires; it was true for one suite.

`testTimeout` is raised only for the integration config. The default 5s is ample for the
parsers and too tight for a budget download.

### The assertion that matters

```
import N transactions  → N created
import the same N again → 0 created, N skipped as duplicates
```

Everything else in the sink is plumbing. This one property is what §4's ordering
guarantee rests on, and it cannot be verified against a fake — a fake would just
reimplement whatever you assumed, which is the assumption under test.

### Isolation

**Fresh `dataDir` per run** via `mkdtemp`, torn down after. The persisted Docker volume
holds the *server's* state; the `dataDir` is the client-side budget cache, and reusing it
across runs makes dedup results depend on run order — a suite that passes for the wrong
reason. `.actual/` is already gitignored; a temp dir keeps it out of the tree entirely.

Because the volume persists, transactions accumulate in the test budget across runs.
Either scope assertions to a date range the fixtures own, or reset with `down -v` when it
gets noisy. Do **not** make the test delete-all-then-import — that hides exactly the
duplicate-detection behaviour being tested.

---

## Things that will bite

**`shutdown()` in a `finally`, or vitest hangs.** `@actual-app/api` holds a SQLite handle
and a sync worker; without shutdown the worker never exits and the run appears to pass
then stall forever. This is the same constraint architecture.md §5 puts on `close()`,
arriving early.

**`importTransactions` vs `addTransactions`.** Repeated because getting it wrong
duplicates real money and the failure is silent.

**Never point the integration suite at the production server.** The isolation here is
`.env.test` versus `.env` — one typo apart. Consider having the sink refuse to run when
`NODE_ENV=test` and `serverURL` is not localhost.

**Do not wire `markProcessed` yet.** Unchanged from 01: labelling before the CLI exists
consumes messages with no operator-visible confirmation that anything was written.

---

## Out of scope

`@stricli/core` and the real `run` command, `markProcessed` and labelling, the `maildir`
source and `replay`, extracting `domain/`/`ports.ts`/`pipeline.ts` beyond the two types
this milestone needs, the classifier, `flake.nix`, the nixos module and timer.

The seam extraction is deliberately after this milestone — architecture.md §9 step 4.
The sink is the second real consumer of `Transaction`, and a contract drawn with one
consumer is a guess.

---

## Open decisions

- **`WriteResult` shape.** Must be defined here. See §2.
- **`MAIL_BEAN_ACCOUNT_MAP` as JSON-in-env.** Provisional since architecture.md §7; this
  is the milestone that exercises it.
- **E2E encryption.** Skipped deliberately. Untested branch recorded in §1.
- **Image tag.** Placeholder in §1 — pin it for real on first pull.
- **`RawEmail` shape.** Carried from 01, not blocking here.
