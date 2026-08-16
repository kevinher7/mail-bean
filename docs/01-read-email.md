# Milestone 01 — Read email, dry-run

Status: **done in substance, via a different route than planned.** See "What actually
happened" below. Next milestone: [02-actual-sink.md](./02-actual-sink.md).
Last updated: 2026-08-16
Depends on: [architecture.md](./architecture.md)

## Goal

Read real mail from Gmail, parse it into normalized transactions, print them to stdout.
Write nothing anywhere.

```
Gmail → Parse → Normalize → JSON on stdout
```

Originally this said *CSV*. The CSV sink has been dropped project-wide — see
architecture.md §5 and Rejected alternatives. JSON is what every read-only command emits
now.

This deliberately stops short of the Actual sink. That is the riskiest seam (§1) and
the only dependency needing a compiler, so **this entire milestone builds without a
native toolchain.** Do not install `@actual-app/api` yet — that is milestone 02.

### Done when

```bash
npm run dev               # real Gmail, transactions to stdout
npm run check             # typecheck + lint + tests all green
```

and:

- No message is labelled. No transaction reaches Actual.
- `npm test` passes offline, with no credentials, on synthetic fixtures only.

---

## What actually happened

The build order was inverted. §3 (Gmail source) was built before §1 (contract) and §2
(offline slice), so the milestone completed from the other end.

| Planned | Actual |
|---|---|
| §1 `domain/*`, `ports.ts`, `dedup.test.ts` | **not built.** `Transaction` is a plain type inside `adapters/parser.ts`. `dedup.ts` is no longer needed — `dedupId` is now a template string, not a hash. |
| §2 `maildir` source, sink, `parsers/registry.ts`, `pipeline.ts` | **not built.** Parsers are a sender-keyed regex table in `adapters/parser.ts`. |
| §2 golden harness | **built** — `tests/parser.test.ts`, two fixtures, two goldens. |
| §3 `config.ts`, Gmail adapter, driver | **built** — `config.ts`, `adapters/gmail.ts`, `src/index.ts`. |

What this bought: real mail exercised the parsers immediately, and the regex-per-issuer
shape survived contact with both issuers' encodings before any abstraction was committed
to. What it cost: §2's dependency rule has never been enforced against anything, because
none of the layers it names exist; and the milestone's headline proof — *swapping the
source changes no line under `parsers/`* — **has not been demonstrated**, because there
is only one source. That proof moves to architecture.md §9 step 5.

The two remaining pieces of this milestone (`maildir` source, `replay`) are deliberately
deferred until after the Actual sink, so that the contract gets extracted with two real
consumers instead of one.

---

## 0. Prerequisites — start these first

Both have external latency and gate everything below.

### Google Cloud

Manual console work. See architecture.md §7 for why this is not Terraform.

1. Create project, enable the Gmail API.
2. OAuth consent screen, type **External**.
3. **Set publishing status to Production** — do this *before* generating a refresh
   token. In Testing the token expires in 7 days and the whole flow gets redone.
4. Create a **Desktop app** OAuth client (loopback redirect, no hosted callback).
5. Download `client_secret`, put the values in a local `.env` (see `.env.dist`).

### Fixtures

3–5 real emails per issuer, two issuers minimum (§9 — one issuer does not prove the
registry earns its keep).

Save via **Show original → Download Original**, keeping headers intact, then run
`scripts/scrub-fixture.py` to turn one into a committable fixture:

```bash
scripts/scrub-fixture.py ~/mail-bean-originals/foo.eml tests/fixtures/smbc-debit-02.eml
```

It drops everything that identifies the recipient — the `Received` chain, SPF/DKIM/ARC
results, the `Return-Path`/`Errors-To` VERP tokens, `Delivered-To` — replaces `To:` with
`user@example.com`, blanks the recipient-scoped serial in `Message-ID`, and overwrites
the addressee name in the body with a placeholder.

**Transaction values are deliberately kept**: amounts, merchants, approval numbers.
They are not sensitive on their own, and the goldens are only worth reviewing if they
hold what the parser will really see.

Every substitution is **length-preserving**, and the script verifies that against the
source before writing. That constraint is the point — the fixtures exist to exercise
ISO-2022-JP and quoted-printable, the issuers wrap QP at 76 columns, and SMBC's mail
even splits an `ESC ( B` sequence across a soft line break. Decode-and-reencode would
re-wrap by the encoder's own rules and quietly destroy the thing under test.

Originals never enter the repo.

This is gated on transactions actually arriving in your inbox, so start collecting now.

---

## 1. Contract

architecture.md §9 step 1. No credentials, no network, ~120 lines.

| File | Contents |
|---|---|
| `domain/email.ts` | `RawEmail`. Shape is **undecided** — see Open decisions. |
| `domain/transaction.ts` | The zod schema from §3, verbatim |
| `domain/dedup.ts` | sha256, NUL-separated, sliced to 32 |
| `ports.ts` | The four port types from §2, plus `WriteResult` (**undecided**) |
| `tests/dedup.test.ts` | |

Finishing this clears two failing scripts: `npm test` stops erroring on "no test files
found", and `unicorn(no-empty-file)` stops firing on the empty `src/index.ts`.

It is also the first point where the oxlint `overrides` from §2 guard anything real —
add them when `domain/` exists, not before.

---

## 2. Offline slice + golden harness

architecture.md §9 step 2, with one deliberate divergence (see below).

| File | Contents |
|---|---|
| `adapters/mail/maildir.ts` | Read a directory of `.eml`, decode with `mailparser` — *deferred to §9 step 5* |
| ~~`adapters/sink/csv.ts`~~ | Dropped project-wide; read-only commands emit JSON |
| `parsers/registry.ts` | Dispatch by `matches()` — *deferred; two issuers do not yet need it* |
| `parsers/<issuer>.ts` | *Deferred;* currently a sender-keyed table in `adapters/parser.ts` |
| `pipeline.ts` | *Deferred to §9 step 4* |
| `tests/parser.test.ts` | **Built.** Globs fixtures, one case each, `toMatchFileSnapshot` |
| `tests/fixtures/*.eml` | **Built** — synthetic only, 2 issuers |
| `tests/goldens/*.json` | **Built** — committed, reviewable |

`.eml` is a single message in RFC 5322 MIME form, headers and body as they came off the
wire. `mailparser` handles the MIME structure, RFC 2047 encoded-word headers, and the
ISO-2022-JP / Shift_JIS conversion — which is what lets §3 promise that
`RawEmail.body` is already decoded UTF-8 and no parser ever sees an encoding.

Note the adapter is named `maildir` in §8, but Maildir is a specific Unix format with
`cur/new/tmp`. What is actually wanted is `dir/*.eml`, as §5's `replay <dir>` describes.

### Goldens

Snapshot the normalized `Transaction[]` as JSON. Use `toMatchFileSnapshot` rather than
`toMatchSnapshot` — it writes files at a path you choose, so a parser change shows up as
a reviewable diff instead of being buried in `__snapshots__/`.

**A golden must be a pure function of the email bytes.** Anything else in it — an id
assigned by whichever source delivered the mail, a timestamp, a run counter — makes the
goldens diff for reasons that have nothing to do with the parsers, at exactly the moment
you need them to be trustworthy. This is what killed `rawRef` (architecture.md §3): it
was the Gmail message id, so the same fixture would golden differently depending on
whether the Gmail or the `maildir` source ran, and step 5's whole proof is that swapping
sources changes nothing.

The path taken instead of the original "leave it undefined" advice was to remove the
field from the contract entirely, since nothing ever read it.

```ts
// tests/parser.test.ts — as built
const FIXTURES = new URL("./fixtures/", import.meta.url);
const fixtures = (await readdir(FIXTURES)).filter((f) => f.endsWith(".eml"));

test.for(fixtures)("%s", async (fixture) => {
  const raw = await readFile(new URL(fixture, FIXTURES));
  const transactions = await parseEmailsTransactions([{ id: fixture, raw }]);

  await expect(`${JSON.stringify(transactions, null, 2)}\n`)
    .toMatchFileSnapshot(`./goldens/${fixture}.json`);
});
```

`await` on `toMatchFileSnapshot` is mandatory — without it Vitest degrades the assertion
to `expect.soft` and the test runs on past a mismatch.

Adding an issuer is: drop in a scrubbed `.eml`, `npx vitest run -u`, read the generated
golden, commit. No test code changes. `vitest --watch` is the exploratory loop.

This step needs no credentials, so it is the work to do **while** the Google Cloud setup
and fixture collection are still in flight.

---

## 3. Gmail source

| File | Contents |
|---|---|
| `config.ts` | env → `Config`. **Built** — hand-rolled, not yet zod. Names in architecture.md §7. |
| `adapters/gmail.ts` | Query from §4, raw bytes out. **Built** (flat path, not `adapters/mail/`) |
| `src/index.ts` | Thin credentialed driver — fetch, parse, print. **Built** |

Plus a one-off auth flow to obtain the refresh token. The consent URL needs **both**
`access_type=offline` and `prompt=consent`; without the latter a repeat authorization
silently returns no refresh token.

`src/index.ts` is currently playing the role the plan gave `src/scratch.ts` — a
credentialed driver that constructs adapters directly. It exists because the golden
harness cannot cover this half: tests must stay offline and credential-free, or the
property that makes them valuable is gone and real email ends up in the repo. It gets
replaced by `commands/run.impl.ts` + `wiring.ts` at architecture.md §9 step 6.

It violates §2's dependency rule by constructing adapters directly, but no
`excludeFiles` entry is needed yet — the `no-restricted-imports` overrides are only
added once `domain/` and `parsers/` exist.

**Known rough edges in the driver**, to clean up when it is replaced or sooner:
`if (!transactions)` is dead code (`Promise.all` always resolves to an array), and the
`null` entries *inside* that array — one per unrecognised email — are never filtered or
reported. That second one is the exit-code-1 path from architecture.md §6 and is
currently silent.

---

## Dependencies

```bash
npm i @googleapis/gmail mailparser
npm i -D @types/mailparser
```

`@googleapis/gmail` rather than the full `googleapis` — the umbrella package pulls every
Google API's typings, and only Gmail is needed. It ships its own typings; `mailparser`
does not, hence the separate `@types`.

---

## Out of scope

Actual sink, `@stricli/core` and the real `run --dry-run` command, `markProcessed` and
labelling, the classifier, `flake.nix`, the nixos module and timer.

---

## Things that will bite

**Request `gmail.modify` at the first consent**, even though this milestone only reads.
Starting with `readonly` and widening later invalidates the refresh token and forces a
fresh consent. §7 already chose `modify` for this reason.

**Do not wire `markProcessed` into `pipeline.ts` yet.** §4's push-then-label ordering
only applies once something is actually written. Labelling during a dry-run silently
consumes messages that were never imported. Leaving it unwired makes the mistake
impossible rather than merely discouraged.

**Publishing status before refresh token.** Repeated because it costs a full redo.

---

## Divergence from architecture.md

The original plan put a throwaway `src/scratch.ts` in charge of driving the offline
pipeline. This milestone put that wiring in `tests/` as a golden harness instead — which
was the right call and has been folded back into architecture.md §9.

Rationale: the offline path runs the whole parse chain with no credentials, which is
exactly what makes a good regression suite. Living in `tests/` also means it needs no
dependency-rule exemption and never reaches `dist/`. The throwaway becomes a permanent
asset instead of being deleted.

The larger divergence — building the Gmail source before the contract — is recorded
under "What actually happened" above and in architecture.md §9.

---

## Open decisions

- **`RawEmail` shape.** Currently `{ id: string; raw: Buffer }` — raw bytes, decoded by
  the parser via `mailparser`, not by the source. This contradicts architecture.md §3's
  "`RawEmail.body` is already decoded UTF-8, so no parser ever sees an encoding". Decide
  at §9 step 4: either the source decodes and the parser takes text, or §3's promise gets
  rewritten. The current shape is the one that has actually been exercised.
- **`WriteResult` shape.** Referenced by `Sink` in §2, never defined. Milestone 02.
- ~~**`seq` in `dedupId`.**~~ Resolved — `dedupId` is keyed on the issuer's approval
  number, so there is nothing to count. See architecture.md §3.
- **`sourceAccount` typing.** `"yucho" | "smbc"` in the parser, `z.string()` in the
  contract. See architecture.md §10.
- **`MAIL_BEAN_ACCOUNT_MAP` as JSON-in-env.** Provisional, per §7. Not exercised by this
  milestone, since routing to accounts is the sink's problem — milestone 02 decides it.
