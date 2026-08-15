#!/usr/bin/env python3
"""Turn a real .eml into a committable test fixture.

    scripts/scrub-fixture.py ~/mail-bean-originals/foo.eml tests/fixtures/smbc-debit-02.eml

Removes the delivery metadata (which carries the recipient address and
per-recipient tracking tokens) and the addressee name, while leaving the body
byte-for-byte the same length.

That length constraint is the whole point. These fixtures exist to exercise
ISO-2022-JP and quoted-printable, and the issuers wrap QP at 76 columns --
SMBC's mail even splits an `ESC ( B` escape sequence across a soft line break.
Decoding and re-encoding would re-wrap by the encoder's own rules and quietly
destroy the thing under test, so every substitution here is length-preserving
and the result is checked against the source before it is written.

Transaction values (amounts, merchants, approval numbers) are NOT touched.
"""
import argparse
import collections
import pathlib
import re
import sys

# Everything else is delivery metadata: Received chains, SPF/DKIM/ARC results,
# Return-Path and Errors-To VERP tokens, Delivered-To. None of it affects MIME
# decoding, and all of it identifies the recipient.
KEEP = {
    b"from",
    b"reply-to",
    b"to",
    b"subject",
    b"date",
    b"message-id",
    b"mime-version",
    b"content-type",
    b"content-transfer-encoding",
}

PLACEHOLDER_TO = b"To: user@example.com"

# Halfwidth katakana U+FF61-FF9F encode to a single byte under `ESC ( I`:
# codepoint - 0xFF61 + 0x21. Reads as ﾔﾏﾀﾞﾀﾛｳ, the Japanese placeholder name.
NAME_POOL = "ﾔﾏﾀﾞﾀﾛｳﾔﾏﾀﾞﾀﾛｳ"
NAME_BYTES = bytes(ord(c) - 0xFF61 + 0x21 for c in NAME_POOL)
assert b"=" not in NAME_BYTES, "pool maps onto '=', which QP would have to escape"

ESCAPES = re.compile(rb"=1B\(.|=1B\$.")
QP_UNIT = re.compile(rb"=[0-9A-F]{2}|.", re.S)
KATAKANA_RUN = re.compile(rb"=1B\(I(.*?)=1B\(B", re.S)


def scrub_headers(head: bytes) -> bytes:
    kept: list[bytes] = []
    for line in head.split(b"\r\n"):
        if line[:1] in (b" ", b"\t"):  # folded continuation of the previous header
            if kept:
                kept[-1] += b"\r\n" + line
            continue
        if line.split(b":", 1)[0].lower() in KEEP:
            kept.append(line)

    out = []
    for header in kept:
        name = header.split(b":", 1)[0].lower()
        if name == b"to":
            header = PLACEHOLDER_TO
        elif name == b"message-id":
            # Trailing serial looks recipient-scoped; the rest is a send timestamp.
            header = re.sub(rb"\.\d+@", b".000000@", header)
        out.append(header)
    return b"\r\n".join(out)


def scrub_name(body: bytes) -> bytes:
    """Overwrite `ESC ( I` halfwidth-katakana runs, preserving QP text length."""

    def replace(match: re.Match[bytes]) -> bytes:
        run = match.group(1)
        out = b""
        for i, unit in enumerate(QP_UNIT.findall(run)):
            byte = NAME_BYTES[i % len(NAME_BYTES) : i % len(NAME_BYTES) + 1]
            # A QP-escaped byte stays escaped, a literal stays literal: same width.
            out += (b"=%02X" % byte[0]) if len(unit) == 3 else byte
        assert len(out) == len(run)
        return b"=1B(I" + out + b"=1B(B"

    return KATAKANA_RUN.sub(replace, body)


def check(original: bytes, scrubbed: bytes) -> list[str]:
    """Structural properties that must survive scrubbing."""
    failures = []
    if len(original) != len(scrubbed):
        failures.append(f"body length {len(original)} -> {len(scrubbed)}")
    lengths = lambda b: sorted(len(l) for l in b.split(b"\r\n"))
    if lengths(original) != lengths(scrubbed):
        failures.append("QP line lengths reflowed")
    histogram = lambda b: collections.Counter(ESCAPES.findall(b))
    if histogram(original) != histogram(scrubbed):
        failures.append("escape sequence histogram changed")
    return failures


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", type=pathlib.Path)
    ap.add_argument("dest", type=pathlib.Path)
    args = ap.parse_args()

    raw = args.source.read_bytes()
    if b"\r\n\r\n" not in raw:
        sys.exit("no header/body separator: not an RFC 5322 message?")
    head, body = raw.split(b"\r\n\r\n", 1)

    scrubbed_body = scrub_name(body)
    failures = check(body, scrubbed_body)
    if failures:
        sys.exit("refusing to write, body structure changed:\n  " + "\n  ".join(failures))

    args.dest.parent.mkdir(parents=True, exist_ok=True)
    args.dest.write_bytes(scrub_headers(head) + b"\r\n\r\n" + scrubbed_body)

    # Cheap backstop: the recipient address should be gone from the whole file.
    to = re.search(rb"^To:\s*(\S+)@", head, re.M | re.I)
    if to and to.group(1) in args.dest.read_bytes():
        print(f"WARNING: {to.group(1).decode()} still present in {args.dest}", file=sys.stderr)

    print(f"{args.source.name} -> {args.dest} ({len(raw)} -> {args.dest.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
