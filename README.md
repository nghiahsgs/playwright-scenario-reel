# playwright-scenario-reel

An agent skill that joins the per-test videos of one Playwright run into a single captioned walkthrough video:
a result card, the scenario list, one scene per test with its Given/When/Then steps as captions, and a closing card.

Needs `ffmpeg`, `ffprobe`, Node 18+ and a project with Playwright installed.

## Install

```bash
npx skills add nghiahsgs/playwright-scenario-reel
```

Or copy `skills/playwright-scenario-reel/` into your agent's skills folder.

## Use without an agent

```bash
PW_SLOWMO=120 REEL_REPORT=/tmp/reel-report.json \
  npx playwright test --workers=1 --reporter=list,skills/playwright-scenario-reel/scripts/reporter.mjs
node skills/playwright-scenario-reel/scripts/reel.mjs --report /tmp/reel-report.json --out reel.mp4
```

See [SKILL.md](skills/playwright-scenario-reel/SKILL.md) for the steps and the limits.
