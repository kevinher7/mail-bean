# Milestone 01 — Read email, dry-run

Status: not started
Last updated: 2026-08-15
Depends on: [architecture.md](./architecture.md)

## Goal

Read real mail from Gmail, run it through the pipeline, print CSV to stdout. Write
nothing anywhere.

```
Gmail → Parse → Normalize → CSV on stdout
```

This deliberately stops short of the Actual sink. That is the riskiest seam (§1) and
the only dependency needing a compiler, so **this entire milestone builds without a
native toolchain.** Do not install `@actual-app/api` yet.

### Done when

```bash
tsx src/scratch.ts        # real Gmail, CSV to stdout
npm run check             # typecheck + lint + tests all green
```

and:

- No message is labelled. No transaction reaches Actual.
- `npm test` passes offline, with no credentials, on synthetic fixtures only.
- Swapping the maildir source for the Gmail one changed **no line under `parsers/`**.
  That last point is the real test — §2's dependency rule is either true here or it
  was never true.

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
| `adapters/mail/maildir.ts` | Read a directory of `.eml`, decode with `mailparser` |
| `adapters/sink/csv.ts` | |
| `parsers/registry.ts` | Dispatch by `matches()` |
| `parsers/<issuer>.ts` | Start with a passthrough that matches everything |
| `pipeline.ts` | |
| `tests/pipeline.golden.test.ts` | |
| `tests/fixtures/*.eml` | Synthetic only |
| `tests/goldens/*.json` | Committed, reviewable |

`.eml` is a single message in RFC 5322 MIME form, headers and body as they came off the
wire. `mailparser` handles the MIME structure, RFC 2047 encoded-word headers, and the
ISO-2022-JP / Shift_JIS conversion — which is what lets §3 promise that
`RawEmail.body` is already decoded UTF-8 and no parser ever sees an encoding.

Note the adapter is named `maildir` in §8, but Maildir is a specific Unix format with
`cur/new/tmp`. What is actually wanted is `dir/*.eml`, as §5's `replay <dir>` describes.

### Goldens

Snapshot the normalized `Transaction[]` as JSON, **not** the CSV. Golden the CSV and a
column reorder breaks every parser test at once, asserting sink formatting inside parser
tests. Test `csv.ts` separately against two or three hand-built transactions.

Use `toMatchFileSnapshot` rather than `toMatchSnapshot` — it writes files at a path you
choose, so a parser change shows up as a reviewable diff instead of being buried in
`__snapshots__/`.

**The offline harness leaves `rawRef` undefined.** §3 defines it as the Gmail message id,
which the maildir source cannot produce, so setting it offline to anything at all —
`Message-ID`, the filename — guarantees the first real `run` rewrites every golden. It is
optional in the schema; leave it unset and the goldens stay valid across the §3 source
swap, which is the one property this milestone is trying to prove.

Nothing extra is needed to make this work: `JSON.stringify` drops undefined-valued keys,
so an unset `rawRef` simply does not appear in the golden. Watch for `exactOptionalPropertyTypes`
here — depending on what zod's `.optional()` infers, an explicit `rawRef: undefined` may
not be assignable where omitting the key is.

```ts
// tests/pipeline.golden.test.ts
const fixtures = (await readdir("tests/fixtures")).filter((n) => n.endsWith(".eml"));

describe("pipeline", () => {
  for (const f of fixtures) {
    it(f, async () => {
      const txns = await collect(makeMaildirSource(`tests/fixtures/${f}`), registry);
      await expect(JSON.stringify(txns, null, 2)).toMatchFileSnapshot(`goldens/${f}.json`);
    });
  }
});
```

First run writes the goldens; eyeball them, then commit. `vitest --watch` is the
exploratory loop.

This step needs no credentials, so it is the work to do **while** the Google Cloud setup
and fixture collection are still in flight.

---

## 3. Gmail source

| File | Contents |
|---|---|
| `config.ts` | env → `Config`, validated with zod. Names in architecture.md §7. |
| `adapters/mail/gmail.ts` | Query from §4, `mailparser` for decoding |
| `src/scratch.ts` | Thin credentialed driver — source + print, nothing else |

Plus a one-off auth flow to obtain the refresh token. The consent URL needs **both**
`access_type=offline` and `prompt=consent`; without the latter a repeat authorization
silently returns no refresh token.

Swap `makeMaildirSource` for `makeGmailSource`. That swap is the milestone.

`src/scratch.ts` is throwaway. It exists because the golden harness cannot cover this
half — tests must stay offline and credential-free, or the property that makes them
valuable is gone and real email ends up in the repo. It is deleted at §9 step 5 when
`commands/run.impl.ts` and `wiring.ts` replace it.

Two consequences while it exists: it constructs adapters directly, which violates §2, so
it needs an `excludeFiles` entry in `.oxlintrc.json`; and `tsconfig.build.json` includes
`src`, so it lands in `dist/` unless excluded there too.

---

## Dependencies

```bash
npm i googleapis mailparser
npm i -D @types/mailparser
```

`googleapis` ships its own typings. `mailparser` does not, hence the separate `@types`.

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

§9 step 2 specifies a throwaway `src/scratch.ts` driving the offline pipeline. This
milestone puts that wiring in `tests/` as a golden harness instead, and keeps only a
thin credentialed driver in `src/scratch.ts` for step 3.

Rationale: the maildir + csv path is already described in §2 as running the whole
pipeline offline with no credentials, which is exactly what makes a good regression
suite. Living in `tests/` also means it needs no dependency-rule exemption and never
reaches `dist/`. The throwaway becomes a permanent asset instead of being deleted.

Fold this back into §9 once it has been proven in practice.

---

## Open decisions

- **`RawEmail` shape.** Undefined in architecture.md beyond "`body` is already decoded
  UTF-8". Minimum: id, from, subject, receivedAt, body.
- **`WriteResult` shape.** Referenced by `Sink` in §2, never defined.
- **`seq` in `dedupId`.** §10 flags the counting strategy as undecided. Not blocking —
  duplicate-purchase collisions cannot occur until something is actually written — but
  the field has to exist in the hash from the start or every id changes later.
- **`MAIL_BEAN_ACCOUNT_MAP` as JSON-in-env.** Provisional, per §7. Not exercised by this
  milestone, since routing to accounts is the sink's problem.
