# mail-bean — Architecture & Decisions

Status: Gmail source and a first parser working end to end against fixtures;
contract not yet extracted into `domain/` (see §9)
Last updated: 2026-08-16
Upstream issue: [kevinher7/nixos#150](https://github.com/kevinher7/nixos/issues/150)

## Purpose

Japanese banks and card issuers offer no reliable automatic sync, but the transaction
data already arrives by email. `mail-bean` reads bank/card notification emails from
Gmail, parses them into normalized transactions, and pushes them into a self-hosted
Actual Budget instance.

```
Gmail → Parse → Normalize → (optional) Classify → Actual Budget
```

The core value is the parse → normalized transaction engine. Everything downstream
depends only on the normalized shape, never on a specific email format or budgeting app.

---

## 1. Stack

| Decision | Choice |
|---|---|
| Language | TypeScript on Node |
| Package manager | **npm** |
| Modules | ESM (`"type": "module"`, `moduleResolution: "nodenext"`) |
| Test runner | vitest |
| Dev execution | `tsx` |
| Linter | **oxlint** + `oxlint-tsgolint` for type-aware rules |
| Formatter | none yet |

**TypeScript 7 (the native compiler) is what forces oxlint.** The `typescript@7`
package ships no JS compiler API — `lib/` contains only `tsc.js` and `version.cjs` —
so every linter built on that API is unusable: `typescript-eslint` peers
`typescript >=4.8.4 <6.1.0`, and `dependency-cruiser` reports
`missing-typescript-transpiler` and cruises 0 modules. oxlint has its own parser and
is version-independent; `oxlint-tsgolint` bundles its own Go checker, so type-aware
rules work against TS 7 with no `typescript` peer at all. Revisit if those projects
ship TS 7 support — the constraint is theirs, not ours.

**Why Node over Python:** the sink is the riskiest integration point, and
`@actual-app/api` is the official Actual client — same code the app itself runs. The
Python alternative (`actualpy`) is a community reimplementation that can lag Actual
server releases, which would make every server upgrade a gamble.

**Why npm over pnpm:** `buildNpmPackage` runs `npm rebuild` automatically with
`npm_config_nodedir` set, so the one native dependency builds itself. nixpkgs'
`pnpm.configHook` does neither (verified against the hook scripts in nixpkgs 26.11) —
it would require a manual `preBuild` rebuild step, `fetcherVersion` management, and
`onlyBuiltDependencies` to work around pnpm 10 blocking postinstall scripts.
Reversible later via `pnpm import`.

`moduleResolution: "nodenext"` is required by the `@actual-app/api` typings; the legacy
`"node"` resolver is unsupported.

### Runtime dependencies

| Package | Purpose | Native code | Status |
|---|---|---|---|
| `@stricli/core` | CLI | no | not yet installed |
| `@googleapis/gmail` | Gmail | no | installed |
| `@actual-app/api` | sink | **yes** — better-sqlite3 | next step |
| `mailparser` | MIME + ISO-2022-JP decoding | no | installed |
| `zod` | config + parser output validation | no | installed, not yet used |

Only `@actual-app/api` requires a compiler. Confirm the exact native dep with
`npm ls better-sqlite3` after the first install — the assumption is that it is pulled
in for the local budget cache, but this has not been verified against the dep tree.

---

## 2. Architecture — ports and adapters

Four seams, each with two or more real implementations. That test is what qualifies
something as a port; anything with a single implementation (config, logging, clock)
stays a plain module.

| Port | Implementations |
|---|---|
| `MailSource` | `gmail`, `maildir` |
| `Parser` | one per issuer, dispatched by a registry |
| `Sink` | `actual` — **one implementation**, see below |
| `Classifier` | `openai` (local LLM), `null` (default) |

`Sink` is the exception to the two-implementations rule. The CSV sink was dropped
(see Rejected alternatives), leaving `actual` alone. It stays a seam anyway because it
is the only component that needs a native compiler, a server and a credential to
construct — so the alternative to a fake is that no pipeline test can run at all. The
rule is therefore: **two or more real implementations, *or* a single implementation
whose construction is too expensive to reach from a test.** Nothing else in the system
qualifies under the second clause.

### The dependency rule

```
domain/      imports nothing
ports.ts     imports domain
pipeline.ts  imports ports only
parsers/     imports domain          — never imports adapters
adapters/    imports ports + domain
wiring.ts    imports adapters        — the only place adapters are constructed
commands/    imports wiring + pipeline
```

**`pipeline.ts`, `ports.ts`, `domain/` and `parsers/` must not import from `adapters/`,
`commands/`, or `wiring.ts`.** This constraint *is* the architecture; the folder names
are incidental.

Enforced with oxlint `no-restricted-imports` inside `overrides` in `.oxlintrc.json`,
one entry per layer, strictest last. Note the options are *not* merged when two
overrides set the same rule — the later one replaces the earlier wholesale, so each
entry must be self-contained. `excludeFiles` lets the base entry deny by default so a
new top-level file is covered without being listed.

Two alternatives do not work here: `import/no-restricted-paths` does not exist in
oxlint, and `dependency-cruiser` cannot parse TS 7 (see §1). Nested per-directory
`.oxlintrc.json` files do work, but silently drop the root's `rules` and `categories`
unless each one repeats `extends` — a correctness rule quietly falls from `error` to
`warning`. Prefer `overrides` in the single root config.

The overrides are added as the directories appear, not up front; they guard nothing
while `domain/` and `parsers/` are empty.

The payoff is concrete: the `maildir` source runs source → parse → normalize offline
with no credentials and no network, emitting JSON. Only the final write to Actual is
unreachable that way, and that is what the fake `Sink` covers. This is also what makes
the repo's "synthetic fixtures only" privacy commitment achievable.

### Why parsers are not under `adapters/`

Strictly, a parser is an adapter — it translates an external representation into the
domain, and `Parser` lives in `ports.ts` alongside the others. But parsers behave
differently from the other adapters: they are all live simultaneously and selected
per-message by a registry (dispatch, not swap), they carry the thickest domain
knowledge in the system, and they are the component that changes most often.
They get a top-level directory because they are the core value, not because they are a
different kind of thing.

Putting parsers under the mail adapter would be wrong — it implies parsing depends on
transport, and it does not. `GmailSource` and `MaildirSource` feed an identical parser set.

### TypeScript style

Ports with a single job are **function types**, not interfaces. Adapters are factory
functions returning closures. No classes, no `implements`, no `new` outside `wiring.ts`.

```ts
export type Sink = (txns: Transaction[], opts?: { dryRun?: boolean }) => Promise<WriteResult>;
export type Classifier = (t: Transaction, cats: string[]) => Promise<string | null>;

export interface MailSource {          // two methods that must travel together
  fetchUnprocessed(limit?: number): AsyncIterable<RawEmail>;
  markProcessed(email: RawEmail): Promise<void>;
}

export interface Parser {
  readonly id: string;
  matches(e: RawEmail): boolean;
  parse(e: RawEmail): Transaction[];
}
```

Fakes in tests are then object literals and one-line functions — no mocking library.

---

## 3. The transaction contract

The central boundary. Every parser emits it; every sink consumes it.

```ts
export const Transaction = z.object({
  date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time:          z.string().regex(/^\d{2}:\d{2}:\d{2}$/), // JST, as printed in the mail
  amount:        z.number().int(),      // minor units, signed, negative = outflow
  currency:      z.literal("JPY"),
  sourceAccount: z.string(),            // logical name, NOT an Actual UUID
  payee:         z.string(),
  dedupId:       z.string(),
  memo:          z.string().optional(),
  category:      z.string().optional(),
});
```

- **Integer minor units.** Never floats.
- **`sourceAccount` is a logical name.** The logical → Actual UUID mapping lives in
  operator config (`accountMap`), not in any parser. *(Resolves the issue's
  "where does account-routing config live" question.)*
- **`RawEmail.body` is already decoded UTF-8.** Encoding handling (ISO-2022-JP,
  Shift_JIS) belongs to the mail adapter, so no parser ever sees an encoding.
- **`time` is carried but not sent to Actual**, which stores a date only. It is kept
  because both issuers print it, it costs nothing, and it is the tiebreaker a human
  needs when two identical charges land on the same day.
- **There is no `rawRef`.** It was specified as "the Gmail message id, for audit",
  implemented, and then removed unused — nothing ever read it, and §3 deliberately keeps
  the message id out of the identity path anyway, so no sink was ever going to. It also
  cannot be produced by the `maildir` source, so it made goldens depend on which source
  ran. If a message pointer is wanted later, the thing to store is the RFC 5322
  `Message-ID` header, not the API id: it is searchable from the Gmail UI as
  `rfc822msgid:<value>`, it survives export, and `maildir` can produce it too. The place
  it will actually earn its keep is the *unparsed* mail path (exit code 1, §6), which
  holds the `RawEmail` already and needs no field on `Transaction`.

### Idempotency

`dedupId` is passed to Actual as `imported_id`, which Actual dedups on per account.

```ts
`${sourceAccount}-${approvalNumber}`   // e.g. "smbc-471570"
```

**This replaces the original content hash** (`sha256([parserId, date, amount, payeeRaw,
seq].join("\0")).slice(0, 32)`). Both issuers print an issuer-assigned approval number
(承認番号) in the notification mail, and every parser must already capture it to
recognise the mail at all. Using it directly is better than hashing the content:

- **It is the issuer's own identity for the authorization**, not a guess derived from
  fields that happen to look distinct. Two genuinely separate charges at the same shop,
  for the same amount, on the same day carry different approval numbers.
- **It dissolves the `seq` problem.** `seq` existed only to break ties the content hash
  could not, and its counting strategy — per batch, per day, persisted? — was an open
  question with no good answer. There is nothing left to count.
- **Still not keyed on the Gmail message id** — a re-delivered mail must not import
  twice. That property is preserved.
- It is human-readable in Actual's import view, which a 32-char hash is not.

The `sourceAccount` prefix namespaces it, since two issuers can independently mint the
same approval number.

**Open risk:** approval numbers are ~6 digits and are not guaranteed unique over time —
an issuer may recycle them. A collision would silently drop a real transaction. If that
is ever observed, prefix with the date (`smbc-2026-08-14-471570`) rather than returning
to a content hash. Not doing it pre-emptively because it makes every existing id
change, and no recycling has been seen yet.

---

## 4. Ordering guarantee

Inside the pipeline: **push to the sink first, apply the Gmail label only after the
sink confirms.**

Labeling first means a sink failure loses the transaction permanently. Writing first
means at worst a re-import on the next run, which `imported_id` absorbs. At-least-once,
never at-most-once.

This is why `MailSource` exposes `markProcessed` as a separate method rather than
folding it into iteration.

### State

There is none. The Gmail query is the cursor:

```
-label:mail-bean/processed from:(info@rakuten-card.co.jp OR ...)
```

Labeled messages leave the result set. No database, no last-seen timestamp, nothing to
get out of sync, and re-running is always safe.

---

## 5. CLI

**`@stricli/core`** (Bloomberg). Zero runtime deps, dual ESM/CJS, actively maintained.

Chosen because it is the only option surveyed with genuine bidirectional flag type
inference: the flags type is declared on the implementation function and the parser
spec is type-checked against it. `commander`'s `.opts<T>()` is a cast you maintain by
hand; `citty` terminates its inference with an index signature so typos type-check.
`clipanion` has been in RC since 2024; `@oclif/core` pulls 18 deps and is still CJS;
`yargs` pulls 6 plus separate `@types`.

Node's builtin `util.parseArgs` was considered and rejected: it is a fine parser but has
no command routing or help generation, which is 150–200 untyped hand-written lines at
six subcommands.

### Commands

| Command | Purpose | Needs credentials |
|---|---|---|
| `run` | fetch, parse, push, label | yes |
| `run --dry-run` | real Gmail, JSON out, writes nothing | Gmail only |
| `replay <dir>` | `.eml` directory → JSON on stdout, fully offline | no |
| `parse <file.eml>` | one file → JSON on stdout | no |
| `auth` | one-time OAuth consent, prints refresh token | no |
| `accounts` | list Actual account names + UUIDs | Actual only |

Convention: data to stdout, structured JSONL events to stderr.

`--dry-run`, `replay` and `parse` all emit the same thing — the normalized
`Transaction[]` as JSON — so there is one output format to learn and one to test.
Piping to `jq` covers every case CSV was wanted for, and unlike CSV it survives an
optional field being added without breaking anyone's column offsets.

**`scanner: { caseStyle: "allow-kebab-for-camel" }` is required** — Stricli matches flag
names exactly by default, so a `dryRun` flag would only accept `--dryRun`.

### Composition root

Two distinct contexts. Do not merge them:

- **`AppContext`** (Stricli) — *ambient*: stdout/stderr, env, clock, resolved config,
  abort signal. Cheap, no I/O, built once in `src/index.ts`, arrives as `this`.
- **`Deps`** (pipeline) — *expensive and flag-dependent*: Gmail client, Actual
  connection. Built per-command inside the impl, **after** flags are known, because the
  object graph differs by flag.

Rule: if constructing it can fail or do I/O, it belongs in `Deps`. Putting `GmailSource`
on the ambient context would force `parse foo.eml` to construct an OAuth client.

`wiring.ts` exports one `buildXDeps(ctx, opts)` per command returning
`{ deps, close() }`. Handlers never nest constructors and always run `close()` in a
`finally` — which is what guarantees `@actual-app/api`'s `shutdown()` runs and the
SQLite handle is released.

---

## 6. Deployment

**systemd oneshot + timer. Not a long-running daemon.**

| | |
|---|---|
| `Type` | `oneshot` |
| `ExecStart` | `mail-bean run` |
| `OnCalendar` | `*:0/20` |
| `Persistent` | `true` — a missed run fires after boot |
| `RandomizedDelaySec` | `2m` |

Push-based delivery was rejected: Gmail `watch` requires a Cloud Pub/Sub topic plus a
public HTTPS endpoint or pull subscriber, and the registration expires every 7 days.
IMAP IDLE requires a persistent connection with reconnect backoff and re-IDLE every
~29 minutes. Neither is worth it — the latency saved is minutes on a budgeting tool.

Oneshot is also strictly more robust: no memory growth, no reconnect state machine, no
Node process holding a SQLite handle open for weeks, and a crash costs exactly one tick.

If a resident mode is ever wanted, `run --watch` is a sleep loop around the same
pipeline. Nothing here forecloses it.

### Process hygiene

- **Never call `process.exit()`; set `process.exitCode`.** Under systemd, stdout is a
  pipe to journald and pipe writes are asynchronous — `exit()` truncates unflushed
  output. It looks fine in a terminal, where TTY stdout is synchronous. Stricli already
  sets `exitCode` rather than exiting.
- **The `SIGTERM` handler only calls `ac.abort()`** (synchronous). The pipeline observes
  `signal.aborted` between messages; the existing `finally` performs async cleanup.
- **`TimeoutStopSec` must exceed worst-case `shutdown()`** or systemd `SIGKILL`s
  mid-write.
- **Leave Node's default `--unhandled-rejections=throw` alone.** For a batch job, loud
  failure beats a silent zero exit that makes the timer look healthy.
- **`auth` must check `process.stdout.isTTY`** and exit 78 immediately, so it can never
  hang on a consent URL under the timer.

### Exit codes

| Code | Meaning | systemd |
|---|---|---|
| 0 | success | — |
| 1 | partial failure, some messages unparsed | alert, retry next tick |
| 75 | `EX_TEMPFAIL` — Actual/network unreachable | `Restart=on-failure` |
| 78 | `EX_CONFIG` — missing creds, dead token | `RestartPreventExitStatus=78` |

---

## 7. Secrets

### Gmail OAuth

- Scope: **`gmail.modify`** — `readonly` cannot write labels.
- Credential type: **Desktop app**, for the loopback redirect (no hosted callback).
- Publishing status: **Production (unverified)**. In *Testing*, refresh tokens expire
  every 7 days, which breaks the service weekly. Production-unverified costs one
  "Google hasn't verified this app" screen, once.
- The consent URL needs **both `access_type=offline` and `prompt=consent`** — without
  the latter, a repeat authorization returns no `refresh_token` and no explanation.

### Provisioning the Google Cloud project

**Manual, in the console. Deliberately not automated.** The Terraform google provider
has no resource for the OAuth consent screen or for a non-IAP OAuth 2.0 client — open
requests since 2020 ([#6074], [#16452]) — and publishing status has no API at all.
`google_iap_brand`/`google_iap_client` exist but are IAP-only and want an org, which a
personal Google account does not have.

So of the §9 prerequisites, exactly one resource is codifiable:

```hcl
resource "google_project_service" "required" {
  for_each           = toset(["gmail.googleapis.com"])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
```

Everything that matters — consent screen, Desktop-type client, Testing → Production,
downloading `client_secret` — is console work. Automating one API enablement is not
worth a provider, a state file and an auth path, so the click path is written down
instead and run once.

**If it is ever codified, it goes in the `infra` repo** (personal Terraform, currently
AWS-only, aws-vault + direnv). That widens it to multi-cloud and needs a second auth
path, since aws-vault gives nothing for GCP. Not `my-infra`.

[#6074]: https://github.com/hashicorp/terraform-provider-google/issues/6074
[#16452]: https://github.com/hashicorp/terraform-provider-google/issues/16452

### sops layout

The durable secret and the derived one are split, which is only possible because the
service is oneshot:

| Value | Storage | Rotates |
|---|---|---|
| `client_id`, sync id | plain module option (not secret) | no |
| `client_secret`, `refresh_token` | sops | rarely |
| Actual password, E2E key | sops | rarely |
| `access_token` | **memory, per run** | every run |

The process lives ~5 seconds, so it exchanges refresh → access on each run and never
writes anything back. `/run/secrets` being read-only is therefore a non-issue, and the
auth path needs no state directory at all.

Uses the existing repo convention — `sops.templates."mail-bean.env"` with
`config.sops.placeholder.*`, consumed via `EnvironmentFile` (see
`modules/services/nginx-proxy.nix`).

### Variable names

The nixos sops template and `config.ts` must agree on these exactly. `.env.dist` in
this repo is the committed reference copy, with fake values of the right shape; `.env`
is the local-development stand-in for `EnvironmentFile` and is gitignored.

| Variable | Secret |
|---|---|
| `MAIL_BEAN_GOOGLE_CLIENT_ID` | no |
| `MAIL_BEAN_GOOGLE_CLIENT_SECRET` | yes |
| `MAIL_BEAN_GOOGLE_REFRESH_TOKEN` | yes |
| `MAIL_BEAN_ACTUAL_SERVER_URL` | no |
| `MAIL_BEAN_ACTUAL_SYNC_ID` | no |
| `MAIL_BEAN_ACTUAL_PASSWORD` | yes |
| `MAIL_BEAN_ACTUAL_E2E_PASSWORD` | yes — only if E2E is enabled |
| `MAIL_BEAN_ACTUAL_DATA_DIR` | no — local budget cache, gitignored |
| `MAIL_BEAN_ACCOUNT_MAP` | no — §3's `accountMap`, JSON |

`MAIL_BEAN_ACCOUNT_MAP` as JSON-in-env is provisional: it is awkward to hand-edit and
malforms silently. A gitignored `accounts.json` may age better. Decide when `config.ts`
is written. `config.ts` should also treat an empty `MAIL_BEAN_ACTUAL_E2E_PASSWORD` as
absent, since `cp .env.dist .env` yields a non-empty one.

**`DynamicUser = true` and sops `owner =` do not compose** (sops needs the uid at
activation; DynamicUser allocates at start). Declare a static `users.users.mail-bean`,
matching the pihole/acme pattern. Alternative: `LoadCredential=`, which also keeps
secrets out of `/proc/PID/environ`.

### Why not a cloud secret store

Considered and rejected: having the server pull secrets at runtime, either out of the
Terraform S3 backend or from a managed store.

- **Terraform state is not a secret store.** It is one plaintext blob per root, with no
  per-secret access control, no rotation semantics, and no versioning meant for
  credentials. Granting the server read on it grants read on everything else in that
  root.
- **It does not remove a secret, it adds one.** The service runs on self-hosted NixOS,
  so there is no cloud metadata identity to federate from. Reaching AWS would need a
  long-lived access key on the box — a durable secret, protected with sops. Circular.
  Keyless federation (GCP SA → OIDC → `AssumeRoleWithWebIdentity`) only works for a
  workload running on the cloud provider, which §6 argues against.
- **It adds a failure mode per run.** §6's oneshot lives ~5 seconds and fires every 20
  minutes. A network round-trip in front of that is a new `EX_TEMPFAIL` (75) path on
  every tick, for something sops already does at activation with no network at all.

sops stays. Revisit only if mail-bean ever runs on a cloud provider with a workload
identity, and even then, use that provider's secret manager — never the state file.

### Token death

Refresh tokens die on: Testing-status expiry (7d), user revocation, 6 months unused, or
more than 100 tokens issued for the same client. Google returns `invalid_grant`.
Catch it specifically → exit 78 with a `re-run mail-bean auth` hint. Paired with
`RestartPreventExitStatus=78`, this produces one clear journal line instead of a timer
failing silently every 20 minutes for a week.

This is the only routine maintenance the service should ever need.

---

## 8. Layout

```
mail-bean/
├── docs/architecture.md
├── package.json
├── tsconfig.json         # typecheck, src + tests, noEmit
├── tsconfig.build.json   # emit src only, keeps tests out of dist/
├── .oxlintrc.json
├── .env.dist             # committed reference; .env is gitignored
├── LICENSE
├── flake.nix
├── bin/mail-bean.js      # shebang + `await import('../dist/index.js')`
├── src/
│   ├── index.ts          # entry: shebang, signal handling, run()
│   ├── app.ts            # command registry
│   ├── context.ts        # AppContext (ambient seam)
│   ├── config.ts         # env → Config value object
│   ├── wiring.ts         # composition root
│   ├── ports.ts
│   ├── pipeline.ts
│   ├── domain/{transaction,email,dedup}.ts
│   ├── parsers/{registry,rakuten}.ts
│   ├── adapters/
│   │   ├── mail/{gmail,maildir}.ts
│   │   ├── sink/actual.ts
│   │   └── classifier/{openai,null}.ts
│   └── commands/         # <name>.ts (spec) + <name>.impl.ts (handler, lazy-loaded)
└── tests/
    ├── fixtures/*.eml    # synthetic only
    ├── goldens/*.json    # committed, reviewable; regenerated with `vitest -u`
    └── parsers/*.test.ts
```

**Goldens are only ever rewritten by an explicit `vitest -u`.** A normal `vitest run`
never touches an existing golden; it fails on any diff. The one implicit write is a
*missing* golden being created on first run, and even that fails instead of writing when
`CI` is set — which is why goldens are committed. The workflow is therefore `-u`, read
the diff, then commit: the assertion is not "the suite went green", it is "the change
was reviewed".

One file per command with an explicit hand-written registry in `app.ts`. Auto-discovery
was rejected: it degrades the registry from a type-checked object literal to a runtime
record, breaks bundling, and buys only third-party plugin support that a personal tool
will never need. Revisit at ~25 commands.

`.gitignore` excludes `node_modules/`, `dist/`, `.env`, `*.token.json`, and `.actual/`
(the local budget cache, which holds real financial data).

`*.token.json` guards a file this design says should never exist — §7 keeps the
access token in memory and the refresh token in sops. It is there because Google's
own `googleapis` quickstarts write credentials to `token.json` in the CWD, and a
debugging session should not be able to commit a live refresh token. If one ever
legitimately appears, something has drifted from §7.

Unsanitized real emails are kept outside the repo entirely rather than in a gitignored
scratch directory.

---

## 9. Build order

**This order was not followed, and the revision below is descriptive, not aspirational.**
What actually happened: the Gmail source and two parsers were built first, directly under
`adapters/`, with no `domain/`, no `ports.ts` and no `pipeline.ts`. That inverted steps 1
and 4 of the original plan. It worked out — real mail proved the parsers early, and the
regex-per-issuer shape survived contact — but it means the dependency rule in §2 has
never been enforced against anything, because none of the layers it names exist yet.

1. ~~**Contract first**~~ — *superseded.* Toolchain is done. `domain/*` and `ports.ts`
   were never extracted; `Transaction` currently lives as a plain type inside
   `adapters/parser.ts`. `dedup.test.ts` is no longer needed at all — §3's `dedupId` is
   now a template string over a field the parser already captures, not a hash with its
   own module.
2. **Parsers + Gmail source + golden harness** — *done.* Two issuers (yucho, smbc),
   scrubbed fixtures, committed goldens, `npm run check` green.
3. **Actual sink** ← *next.* Against a throwaway budget file first. Populate `accountMap`
   once `accounts` can read the UUIDs back. This is the first step needing a native
   toolchain. See `docs/02-actual-sink.md`.
4. **Extract the seams** — `domain/`, `ports.ts`, `pipeline.ts`, `parsers/registry.ts`,
   and the oxlint `no-restricted-imports` overrides that enforce §2. Deliberately *after*
   the sink: the sink is the second real consumer of `Transaction`, and extracting a
   contract with one consumer is guessing. Adding the third issuer is the trigger for
   `parsers/registry.ts` specifically.
5. **`maildir` source + `replay`** — the offline path. *The parsers must not change by a
   single line.* If they do, something has leaked across a seam. This is now the step
   that tests §2's central claim, since the Gmail source came first.
6. **CLI** (`@stricli/core`), then `flake.nix`, nixos module, timer.
7. **Classifier** last, off by default.

### Prerequisites with external latency

- Google Cloud project, Gmail API enabled, Desktop credentials, publishing status set
  to Production. Console work — see §7 "Provisioning the Google Cloud project" for why
  this is not Terraform.
- Fixtures: 3–5 real emails per issuer, saved via "Show original" with headers intact,
  then hand-scrubbed of amounts/merchants/card digits — **changing nothing structural**,
  so the fixture still exercises the real encoding and whitespace. Originals stay
  outside the repo.
- Two issuers for v1. One is not enough to prove the registry earns its keep.
- From Actual: sync ID (Settings → Advanced), and whether E2E encryption is enabled.

---

## 10. Open questions

- **Authorization vs. settlement emails for the same purchase.** Current lean: v1
  ingests only the immediate 利用通知 (auth) mail per issuer and the registry drops
  settlement/statement mail. Reconciling both is a matching problem not worth solving
  in v1; Actual's own reconciliation UI covers the remainder.
- ~~**Duplicate-purchase collisions.**~~ *Resolved* by keying `dedupId` on the issuer's
  approval number instead of a content hash — see §3. The residual risk is approval-number
  recycling, which is recorded there.
- **Category list source for the classifier.** Lean: read it live from Actual over the
  existing sink connection, so there is one source of truth and no drift.
- **Where the source-assigned message id gets attached, if it ever does.** §3 removed
  `rawRef` from the contract. The open part is the unparsed-mail path: exit code 1 says
  "some messages unparsed" but nothing yet says *which*, and that is where a
  `rfc822msgid:` pointer belongs.
- **`sourceAccount` is `string` in the schema but a union in the parser.** The
  implementation has `"yucho" | "smbc"` with a `TODO: Make into enum`. Widening to
  `string` at the contract is probably right — `accountMap` is operator config and a new
  issuer should not require a type change — but the two disagree today.

---

## Rejected alternatives

| Option | Why not |
|---|---|
| Python + `actualpy` | Community reimplementation; lags Actual releases. Sink is the riskiest seam. |
| Hybrid Python parse + Node sink | Best of both, but two toolchains in one flake is more nix work than either pure option. |
| pnpm | `pnpm.configHook` does no native rebuild; requires manual `preBuild`, `fetcherVersion`, `onlyBuiltDependencies`. |
| Long-running daemon / Pub/Sub / IMAP IDLE | Infrastructure and reconnect logic for latency that does not matter. |
| `commander`, `cac`, `citty`, `clipanion`, `oclif`, `yargs` | See §5. |
| `util.parseArgs` | No routing or help generation; 150–200 untyped lines at six commands. |
| Auto-discovered commands | See §8. |
| Classes + `implements` for ports | Structural typing makes it ceremony; function types and factories are leaner. |
| A database for processed state | The Gmail label already is the state. |
| A `csv` sink | Dropped. It existed to give `Sink` a second implementation and to make `--dry-run`/`replay` printable, but JSON on stdout does both jobs with no sink, no column ordering to bikeshed, and no breakage when an optional field is added. `jq` covers the spreadsheet case. See §5. |
| `rawRef` on `Transaction` | Written, never read, and unproducible by the `maildir` source. See §3. |
| `seq` in `dedupId` | Made unnecessary by keying on the issuer's approval number. See §3. |
| `typescript-eslint`, `dependency-cruiser` | Neither supports TypeScript 7. See §1. |
| Nested per-directory `.oxlintrc.json` | Silently drops the root's `rules` and `categories` without `extends`. See §2. |
| `rimraf` in the build script | POSIX `rm -rf` is enough; deployment is NixOS, development is darwin. |
| `tsc -b --clean` | Only deletes outputs of files that still exist, so renamed and deleted sources leave stale output behind — the exact case cleaning is for. |
| Terraforming the GCP OAuth setup | No provider support for the consent screen, non-IAP clients, or publishing status. See §7. |
| Secrets pulled from the Terraform S3 state | State is not a secret store, and the server would need a durable AWS key to read it. See §7. |
| Cross-cloud IAM federation for secret delivery | Needs a cloud workload identity; the service is self-hosted. See §7. |
| `my-infra` for mail-bean's cloud resources | `infra` is the chosen home, even though it is AWS-only today. |
