---
name: playwright-scenario-reel
description: Join the per-test videos of one Playwright run into a single captioned walkthrough video (result card, scenario list, one scene per test with its Given/When/Then steps as captions, closing card). Use when someone has many short Playwright recordings and wants one video that is easy to watch, for a demo, a pull request or a team update.
---

# Playwright scenario reel

Turns N short test recordings into one 1920x1080 **reel**: verdict first, then each scenario as it ran, then the result list.
ffmpeg cuts and joins; one HTML page draws each card and caption; Playwright screenshots it. No other dependency.

Every drawn word comes from the run: titles are test titles, captions are `test.step` names, pass/fail is the run's status.
`scripts/reporter.mjs` records them; `scripts/reel.mjs` draws them. Type nothing by hand.

## Steps

1. **Check the tests can be filmed.** Each scenario is one test, and each Given/When/Then line is its own
   `test.step('<line>', ...)`. Tests without steps still work: the scene shows the test title as its only caption.
   Done when you have named the Playwright config and the tests that go in the reel.

2. **Record the run with the reporter.** Video must be on for this run, and slow motion makes clicks visible. If the config
   has neither, add them as opt-in settings so the normal run stays fast:

   ```ts
   use: {
     video: { mode: 'on', size: { width: 1280, height: 720 } },
     viewport: { width: 1280, height: 720 },
     launchOptions: { slowMo: Number(process.env.PW_SLOWMO ?? 0) },
   }
   ```

   ```bash
   PW_SLOWMO=120 REEL_REPORT=<scratch>/reel-report.json \
     npx playwright test -c <config> --workers=1 --reporter=list,<skill>/scripts/reporter.mjs
   ```

   Record the same tests the team runs; a separate script written for the video proves nothing.
   Done when the reporter prints `reel report: ... (N tests)` and N is the number of scenarios you named in step 1.

3. **Build the reel straight away**, from the folder where Playwright is installed. Playwright clears its output folder on
   the next run, and the report points at the videos inside it.

   ```bash
   node <skill>/scripts/reel.mjs --report <scratch>/reel-report.json --out <out>/<feature>-reel.mp4
   ```

   Write `<out>` outside Playwright's `outputDir`. `--stills --work <dir>` draws only the cards and captions for a quick
   look; `--help` lists the pacing options (`--speed`, `--min-step`, `--card`) and `--include` / `--exclude`.
   Done when it prints `X of N scenarios pass` and `wrote ... (expected ...)` with the two lengths equal.

4. **Watch it before you hand it over.** Pull frames and read them:

   ```bash
   ffmpeg -ss <t> -i <reel.mp4> -frames:v 1 frame.jpg
   ```

   Done when you have checked, on frames you opened: the first card shows the verdict; every scenario id appears, in
   order; captions fit their bar; a typed password shows as dots; and nothing on screen is private data. Report what you
   checked and what you did not (for example: not watched end to end by a person).

## Rules

- **A failed scenario is shown as failed.** The reel draws the run's own status; a red scene stays in.
- **Test data only on screen.** The recording shows whatever the browser showed. Record against seeded or synthetic data.
- **Keep recordings, frames and reels out of git** unless the user asks for one to be committed.

## What it does with each test

- Steps that did nothing (no action, no check, under 5 ms) are stated preconditions and are left out;
  `--keep-empty-steps` shows them.
- Each step plays at `--speed` (default 0.5x), then its last frame holds until the caption has been up `--min-step` seconds.
- An id at the start of the title (`AS-12 ...`, `S2.1 ...`) becomes the badge; tags become chips.
- Tests named `seed` are left out by default. Only the last retry of a test is used.

## Limits

- One recording per test, the first page only; a test that opens a second page shows the first.
- No zoom on the clicked element, no cursor dot, no before/after comparison, no sound.
- Captions are the step names as written. Long ones shrink; rewrite the step name if it does not read well.
