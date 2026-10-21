---
name: Verify Data
description: Verify channel classifications against the web with Google Search grounding and record the corrections as reviewable overrides
---

# Verify the dataset

The keyword classifier is fast, free and deterministic — but it is wrong often
enough to matter. A channel called "Bainju" tells you nothing; "Kaya
Nishikino Ch." could be a VTuber, a singer or a fan account.

This skill verifies uncertain channels against the web and records the answers
as **overrides**, so every correction is reviewable in a diff and can be
undone by deleting one entry.

## Run it

```bash
export GEMINI_API_KEY=...        # https://aistudio.google.com/apikey

npm run data:verify -- --limit 40
npm run data:verify -- --limit 20 --min-confidence 0.85   # stricter
npm run data:verify -- --dry-run                          # show, write nothing
npm run data:verify -- --id UCxxxxxxxxxxxxxxxxxxxxxx       # one channel
```

Then re-apply the corrections:

```bash
npm run data:sync -- --no-search
npm run data:index
npm run data:validate
```

## How it works

`scripts/lib/verify.ts` calls Gemini with **Google Search grounding** —
the model actually looks the channel up rather than answering from memory —
and asks for a structured JSON answer:

| Field | Question |
| --- | --- |
| `kind` | VTuber/VSinger, or a real human artist? |
| `role` | What do they do? |
| `region` | Which language area do they perform in? |
| `gender` | **Only** if the channel states it |
| `isAi` | AI-generated performer or synthesised voice? |
| `isAggregator` | A fan/clip/compilation channel rather than a performer? |
| `confidence` | How sure is the model? |
| `reasoning` | What did it find? |

The grounding metadata is read back, so the **sources the model actually read
are recorded** next to each answer.

## Why grounding, not just a model

A model asked "is 富士葵 a VTuber?" from memory answers from stale priors and
will happily invent a gender. A grounded model reads the agency's roster page
and answers from what it found. That is the difference between a guess and a
verification.

## Why corrections, not direct writes

The verifier never edits a record. It writes an **override** into
`data/overrides.json`:

```jsonc
{
  "UCxxxxxxxxxxxxxxxxxxxxxx": {
    "kind": "real",
    "gender": "female",
    "isAi": false,
    "verifiedBy": "gemini-2.5-flash",
    "verifiedAt": "2026-10-21T04:43:00.000Z",
    "note": "Agency roster lists them as a real singer affiliated with …"
  }
}
```

The normal sync applies those overrides, so:

- `git diff data/overrides.json` shows exactly what changed and why;
- a wrong verification is undone by deleting one entry;
- the override sets `source: "manual"` and `confidence: 1`, so a verified
  record is never overwritten by a later automated refresh.

## Which channels get verified

By default, every channel whose classifier confidence is at or below
`--confidence` (1 = all of them) that:

- is **not** already curated as a seed;
- has **not** already been verified.

They are sorted least-confident-first, so the budget goes to the records that
need it most.

## Confidence thresholds

- `--min-confidence` (default `0.7`) — corrections below this are discarded.
  A wrong correction is worse than none: it silently overrides the
  deterministic classifier.
- Raise it to `0.85` for a conservative pass; lower it to `0.6` to catch more.

## Rules the prompt enforces

- **Never guess a gender from a name or a photo.** Only `female` or `male`
  when the channel or agency states it.
- Aggregators are not performers — they get `hidden: true` and
  `isSinging: false`.
- "Unknown" is a valid, expected answer. The model is told to prefer it over
  a guess.

## Cost

`gemini-2.5-flash` with search grounding is cheap. A run of 40 channels
costs a fraction of a cent on the free tier. The script throttles requests
(`--delay`, default 1200 ms) to stay well inside the rate limits.

## In GitHub Actions

`.github/workflows/verify-data.yml` runs daily and on demand. It needs the
`GEMINI_API_KEY` secret, then re-applies the corrections, rebuilds the index,
validates and commits `data/`.

## Reviewing a verification run

```bash
git diff data/overrides.json
```

Check that the `note` and `verifiedAt` fields explain each change. A
correction whose reasoning is thin is a correction to revert.

## Limitations

- A model can be wrong even when it is grounded. Always review the diff.
- Channels with no web presence stay `unknown` — that is correct behaviour,
  not a bug.
- The verifier does **not** re-verify a channel that already has an
  override. Delete the override entry to force a re-check.
