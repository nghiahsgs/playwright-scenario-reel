// Playwright reporter: writes one JSON file with, for every test, its result,
// its video path and the start time of every step. reel.mjs draws from this
// file only, so every caption and every pass/fail on screen comes from the run.
//
//   npx playwright test --reporter=list,<path>/reporter.mjs
//
// Output: $REEL_REPORT, or the `outputFile` reporter option, or reel-report.json
// in the Playwright config's folder.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

function flatten(steps, startMs, depth, out) {
  for (const step of steps) {
    out.push({
      title: step.title,
      category: step.category,
      depth,
      startMs: step.startTime.getTime() - startMs,
      durationMs: Math.max(0, step.duration),
      children: step.steps.length,
      failed: Boolean(step.error),
    })
    flatten(step.steps, startMs, depth + 1, out)
  }
  return out
}

export default class ReelReporter {
  constructor(options = {}) {
    this.options = options
    this.tests = []
  }

  onBegin(config) {
    this.rootDir = config.configFile ? dirname(config.configFile) : config.rootDir
  }

  onTestEnd(test, result) {
    const startMs = result.startTime.getTime()
    const steps = flatten(result.steps, startMs, 0, [])
    // The recording starts when the page is created, not when the test starts.
    const pageFixture =
      steps.find((s) => s.category === 'fixture' && /\bpage\b/i.test(s.title)) ??
      steps.find((s) => s.category === 'fixture' && /\bcontext\b/i.test(s.title))
    const video = result.attachments.find((a) => a.name === 'video' && a.path)
    this.tests.push({
      title: test.title,
      suite: test.parent?.title ?? '',
      file: test.location.file,
      line: test.location.line,
      tags: test.tags ?? [],
      status: result.status,
      expectedStatus: test.expectedStatus,
      retry: result.retry,
      durationMs: result.duration,
      videoStartMs: pageFixture ? pageFixture.startMs : 0,
      video: video ? video.path : null,
      error: result.error?.message?.split('\n')[0] ?? null,
      steps: steps.filter((s) => s.category === 'test.step'),
    })
  }

  onEnd() {
    const out = resolve(
      this.rootDir ?? process.cwd(),
      process.env.REEL_REPORT ?? this.options.outputFile ?? 'reel-report.json',
    )
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify({ version: 1, tests: this.tests }, null, 2))
    console.log(`reel report: ${out} (${this.tests.length} tests)`)
  }
}
