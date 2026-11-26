#!/usr/bin/env node
// Joins the per-test videos of one Playwright run into a single captioned
// 1920x1080 video: result card, scenario list, one scene per test, closing card.
//
//   node reel.mjs --report reel-report.json --out reel.mp4 [--title "Feature name"]
//
// Everything drawn comes from the report written by reporter.mjs: titles are test
// titles, captions are test.step names, pass/fail is the run's own status.
// Needs ffmpeg and ffprobe on PATH, and playwright-core (or @playwright/test)
// resolvable from the current folder for drawing the cards.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { cpus, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

const HELP = `Usage: node reel.mjs --report <reel-report.json> --out <video.mp4> [options]

  --title <text>       Feature name on the cards (default: the tests' describe title)
  --speed <n>          Playback speed of the recordings (default 0.5)
  --min-step <sec>     Shortest time one step caption stays on screen (default 2)
  --card <sec>         Time each card stays on screen (default 4)
  --include <regex>    Only tests whose title matches
  --exclude <regex>    Skip tests whose title matches (default: ^seed$)
  --keep-empty-steps   Also show steps that did nothing (preconditions)
  --stills             Draw the cards and captions only, no video (for a quick look)
  --work <dir>         Working folder (default: a new folder in the temp dir)
  --keep-work          Leave the working folder in place
`

function parseArgs(argv) {
  const args = { speed: 0.5, minStep: 2, card: 4, exclude: '^seed$' }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = () => {
      i += 1
      if (argv[i] === undefined) throw new Error(`${flag} needs a value`)
      return argv[i]
    }
    if (flag === '--report') args.report = value()
    else if (flag === '--out') args.out = value()
    else if (flag === '--title') args.title = value()
    else if (flag === '--speed') args.speed = Number(value())
    else if (flag === '--min-step') args.minStep = Number(value())
    else if (flag === '--card') args.card = Number(value())
    else if (flag === '--include') args.include = value()
    else if (flag === '--exclude') args.exclude = value()
    else if (flag === '--work') args.work = value()
    else if (flag === '--keep-empty-steps') args.keepEmpty = true
    else if (flag === '--keep-work') args.keepWork = true
    else if (flag === '--stills') args.stills = true
    else if (flag === '--help' || flag === '-h') args.help = true
    else throw new Error(`Unknown option ${flag}`)
  }
  return args
}

const W = 1920
const H = 1080
const FPS = 30
// The recording keeps its own 16:9 shape inside the frame.
const PANEL = { x: 240, y: 150, w: 1440, h: 810 }

const esc = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// "AS-12 Signing out ends the session" -> id "AS-12", name "Signing out ends the session".
function splitTitle(title) {
  const match = /^([A-Za-z]{1,6}[-_ ]?\d+(?:\.\d+)*)[\s:.-]+(.+)$/.exec(title)
  return match ? { id: match[1], name: match[2] } : { id: '', name: title }
}

function splitStep(title) {
  const match = /^(Given|When|Then|And|But)\b\s*(.*)$/.exec(title)
  return match ? { keyword: match[1], text: match[2] } : { keyword: '', text: title }
}

const CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { width: ${W}px; height: ${H}px; background: #0e1420; color: #eef2f8; overflow: hidden;
    font-family: -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
  .pass { color: #4ade80; } .fail { color: #f87171; }
  .chip { display: inline-block; padding: 6px 16px; border-radius: 999px; font-size: 22px; font-weight: 600;
    background: #1c2536; color: #9fb0c8; margin-right: 10px; }
  .status { padding: 8px 22px; border-radius: 10px; font-size: 28px; font-weight: 800; letter-spacing: 1px; }
  .status.pass { background: #12301f; } .status.fail { background: #3a1616; }
  .head { position: absolute; left: 60px; right: 60px; top: 26px; height: 110px; display: flex;
    align-items: center; gap: 24px; }
  .id { font-size: 34px; font-weight: 800; background: #2563eb; color: #fff; padding: 8px 20px;
    border-radius: 10px; white-space: nowrap; }
  .name { flex: 1; font-size: 34px; font-weight: 700; line-height: 1.2; }
  .count { font-size: 22px; color: #7f8fa8; white-space: nowrap; }
  .panel { position: absolute; left: ${PANEL.x - 4}px; top: ${PANEL.y - 4}px; width: ${PANEL.w + 8}px;
    height: ${PANEL.h + 8}px; border-radius: 6px; background: #000; border: 4px solid #26324a; }
  .panel.fail { border-color: #b91c1c; }
  .cap { position: absolute; left: 60px; right: 60px; top: ${PANEL.y + PANEL.h + 18}px; bottom: 16px;
    display: flex; align-items: center; gap: 22px; }
  .kw { font-size: 30px; font-weight: 800; padding: 6px 18px; border-radius: 8px; background: #1c2536; }
  .kw.Given { color: #93c5fd; } .kw.When { color: #fcd34d; } .kw.Then { color: #4ade80; }
  .kw.And, .kw.But { color: #c4b5fd; }
  .text { flex: 1; font-size: 32px; font-weight: 600; line-height: 1.22; }
  .dots { display: flex; gap: 8px; }
  .dot { width: 14px; height: 14px; border-radius: 50%; background: #2a3650; }
  .dot.on { background: #60a5fa; }
  .tags { position: absolute; left: 60px; top: ${PANEL.y}px; width: 170px; }
  .tags .chip { display: block; margin: 0 0 10px; font-size: 16px; padding: 5px 10px; text-align: center;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .card { position: absolute; inset: 0; padding: 70px 90px; display: flex; flex-direction: column; }
  .card h1 { font-size: 60px; font-weight: 800; }
  .card h2 { font-size: 30px; font-weight: 600; color: #7f8fa8; margin-bottom: 14px; text-transform: uppercase;
    letter-spacing: 3px; }
  .big { font-size: 150px; font-weight: 900; margin: auto 0 10px; line-height: 1; }
  .sub { font-size: 40px; color: #9fb0c8; margin-bottom: auto; }
  .list { margin-top: 30px; flex: 1; display: grid; grid-auto-flow: column; gap: 6px 50px; align-content: start; }
  .row { display: flex; align-items: baseline; gap: 14px; overflow: hidden; }
  .row .rid { font-weight: 800; color: #93c5fd; white-space: nowrap; }
  .row .rname { flex: 1; line-height: 1.25; padding: 0.25em 0; }
  .row .mark { font-weight: 800; white-space: nowrap; }
  .foot { font-size: 22px; color: #7f8fa8; margin-top: 18px; line-height: 1.4; }
`

const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${body}</body></html>`

function introCard(title, scenes) {
  const passed = scenes.filter((s) => s.pass).length
  const all = passed === scenes.length
  return page(`<div class="card"><h2>Test run walkthrough</h2><h1>${esc(title)}</h1>
    <div class="big ${all ? 'pass' : 'fail'}">${passed} of ${scenes.length}</div>
    <div class="sub">scenarios pass</div>
    <div class="foot">Result first. Each scenario follows as it ran in the browser.</div></div>`)
}

function listCard(title, heading, scenes, offset, total, withResult, footnote) {
  const perColumn = Math.ceil(scenes.length / (scenes.length > 9 ? 2 : 1))
  const size = perColumn > 7 ? 26 : 32
  const rows = scenes
    .map((s) => {
      const mark = withResult
        ? `<span class="mark ${s.pass ? 'pass' : 'fail'}">${s.pass ? '✓ pass' : '✗ FAIL'}</span>`
        : ''
      return `<div class="row" style="font-size:${size}px;line-height:${size * 1.75}px">
        <span class="rid">${esc(s.id || String(s.index + 1))}</span><span class="rname">${esc(s.name)}</span>${mark}</div>`
    })
    .join('')
  const range = total > scenes.length ? ` · ${offset + 1}–${offset + scenes.length} of ${total}` : ''
  return page(`<div class="card"><h2>${esc(heading)}${range}</h2><h1 style="font-size:48px">${esc(title)}</h1>
    <div class="list" style="grid-template-rows:repeat(${perColumn}, auto)">${rows}</div>
    ${footnote ? `<div class="foot">${esc(footnote)}</div>` : ''}</div>`)
}

function sceneFrame(scene, total, stepIndex) {
  const step = scene.steps[stepIndex]
  const { keyword, text } = splitStep(step.title)
  const dots = scene.steps.map((_, i) => `<span class="dot ${i <= stepIndex ? 'on' : ''}"></span>`).join('')
  const tags = scene.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join('')
  const size = text.length > 150 ? 22 : text.length > 95 ? 26 : 32
  return page(`<div class="head">
      ${scene.id ? `<span class="id">${esc(scene.id)}</span>` : ''}
      <span class="name">${esc(scene.name)}</span>
      <span class="count">Scenario ${scene.index + 1} of ${total}</span>
      <span class="status ${scene.pass ? 'pass' : 'fail'}">${scene.pass ? '✓ PASS' : '✗ FAIL'}</span>
    </div>
    <div class="tags">${tags}</div>
    <div class="panel ${scene.pass ? '' : 'fail'}"></div>
    <div class="cap">
      ${keyword ? `<span class="kw ${keyword}">${keyword}</span>` : ''}
      <span class="text ${step.failed ? 'fail' : ''}" style="font-size:${size}px">${step.failed ? '✗ ' : ''}${esc(text)}</span>
      <span class="dots">${dots}</span>
    </div>`)
}

function loadChromium() {
  const require = createRequire(join(process.cwd(), 'noop.js'))
  for (const name of ['playwright-core', 'playwright', '@playwright/test']) {
    try {
      return require(name).chromium
    } catch {
      // try the next package name
    }
  }
  throw new Error('playwright-core was not found. Run this from a folder where Playwright is installed.')
}

async function pool(jobs, size) {
  let next = 0
  const workers = Array.from({ length: Math.min(size, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next]
      next += 1
      await job()
    }
  })
  await Promise.all(workers)
}

const ENCODE = ['-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an']

async function ffmpeg(args) {
  try {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 26 })
  } catch (error) {
    throw new Error(`ffmpeg failed: ${error.stderr || error.message}`)
  }
}

async function videoSeconds(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-count_frames', '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames,r_frame_rate', '-of', 'json', file,
  ])
  const stream = JSON.parse(stdout).streams[0]
  const [num, den] = stream.r_frame_rate.split('/').map(Number)
  return Number(stream.nb_read_frames) / (num / den)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.report || !args.out) {
    process.stdout.write(HELP)
    process.exit(args.help ? 0 : 1)
  }

  const report = JSON.parse(readFileSync(resolve(args.report), 'utf8'))
  const include = args.include ? new RegExp(args.include) : null
  const exclude = args.exclude ? new RegExp(args.exclude) : null

  // The last attempt of each test is the one that counts.
  const latest = new Map()
  for (const test of report.tests) {
    const key = `${test.file}:${test.line}`
    if (!latest.has(key) || latest.get(key).retry <= test.retry) latest.set(key, test)
  }
  const tests = [...latest.values()].filter(
    (t) => (!include || include.test(t.title)) && !(exclude && exclude.test(t.title)) && t.status !== 'skipped',
  )
  if (tests.length === 0) throw new Error('No tests left after --include / --exclude.')

  const missing = tests.filter((t) => !t.video || !existsSync(t.video))
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} of ${tests.length} tests have no video file:\n` +
        missing.map((t) => `  ${t.title}`).join('\n') +
        `\nRecord with use.video = 'on' and build the reel before the next run clears the output folder.`,
    )
  }

  const scenes = []
  for (const [index, test] of tests.entries()) {
    const seconds = await videoSeconds(test.video)
    let steps = test.steps.filter((s) => s.depth === 0)
    if (!args.keepEmpty) {
      // A step with no action and no check inside is a stated precondition: nothing to watch.
      const acted = steps.filter((s) => s.children > 0 || s.durationMs >= 5 || s.failed)
      if (acted.length > 0) steps = acted
    }
    if (steps.length === 0) {
      steps = [{ title: test.title, startMs: test.videoStartMs, durationMs: test.durationMs, failed: false }]
    }
    const starts = steps.map((s) => Math.max(0, (s.startMs - test.videoStartMs) / 1000))
    const parts = steps.map((step, i) => {
      const last = i === steps.length - 1
      const from = Math.min(i === 0 ? 0 : starts[i], seconds - 1 / FPS)
      const to = Math.max(from + 1 / FPS, Math.min(last ? seconds : starts[i + 1], seconds))
      return { title: step.title, failed: Boolean(step.failed), from, to }
    })
    scenes.push({
      index,
      ...splitTitle(test.title),
      tags: test.tags,
      pass: test.status === test.expectedStatus,
      video: test.video,
      steps: parts,
    })
  }

  const title = args.title ?? tests.find((t) => t.suite)?.suite ?? 'Playwright run'
  const work = resolve(args.work ?? join(tmpdir(), `scenario-reel-${process.pid}`))
  rmSync(work, { recursive: true, force: true })
  mkdirSync(join(work, 'png'), { recursive: true })
  mkdirSync(join(work, 'clip'), { recursive: true })

  // 1. Draw every card and every caption frame once.
  const pieces = [] // in playing order: { png, clip, seconds, video?, from?, to? }
  const stills = []
  const addStill = (name, html) => {
    stills.push({ file: join(work, 'png', `${name}.png`), html })
    return join(work, 'png', `${name}.png`)
  }
  const PAGE_SIZE = 16
  pieces.push({ png: addStill('000-intro', introCard(title, scenes)), seconds: args.card })
  for (let offset = 0; offset < scenes.length; offset += PAGE_SIZE) {
    const chunk = scenes.slice(offset, offset + PAGE_SIZE)
    pieces.push({
      png: addStill(`001-list-${offset}`, listCard(title, 'Scenarios in this video', chunk, offset, scenes.length, false)),
      seconds: args.card,
    })
  }
  for (const scene of scenes) {
    scene.steps.forEach((step, i) => {
      const name = `s${String(scene.index).padStart(3, '0')}-${String(i).padStart(2, '0')}`
      const played = (step.to - step.from) / args.speed
      pieces.push({
        png: addStill(name, sceneFrame(scene, scenes.length, i)),
        video: scene.video,
        from: step.from,
        to: step.to,
        // Play the step, then hold its last frame so the caption can be read.
        seconds: Math.max(args.minStep, played + 0.6),
      })
    })
  }
  const footnote =
    `Recorded: the browser panels, from this test run. Drawn: titles, captions and pass/fail, copied from the run's report. ` +
    `Playback ${args.speed}x, with each step's last frame held.`
  for (let offset = 0; offset < scenes.length; offset += PAGE_SIZE) {
    const chunk = scenes.slice(offset, offset + PAGE_SIZE)
    pieces.push({
      png: addStill(`999-result-${offset}`, listCard(title, 'Result', chunk, offset, scenes.length, true, footnote)),
      seconds: args.card + 1,
    })
  }

  const chromium = loadChromium()
  const browser = await chromium.launch()
  const tab = await browser.newPage({ viewport: { width: W, height: H } })
  for (const still of stills) {
    await tab.setContent(still.html)
    await tab.screenshot({ path: still.file })
  }
  await browser.close()
  console.log(`drew ${stills.length} frames in ${join(work, 'png')}`)
  if (args.stills) return

  // 2. One clip per piece, all with the same encoding so they join without re-encoding.
  pieces.forEach((piece, i) => {
    piece.clip = join(work, 'clip', `${String(i).padStart(4, '0')}.mp4`)
  })
  const jobs = pieces.map((piece) => async () => {
    const length = piece.seconds.toFixed(3)
    if (!piece.video) {
      await ffmpeg(['-loop', '1', '-t', length, '-i', piece.png, '-vf', `fps=${FPS},format=yuv420p`, ...ENCODE, piece.clip])
      return
    }
    const filter =
      `[1:v]fps=${FPS},trim=start=${piece.from.toFixed(3)}:end=${piece.to.toFixed(3)},` +
      `setpts=(PTS-STARTPTS)/${args.speed},fps=${FPS},` +
      `scale=${PANEL.w}:${PANEL.h}:force_original_aspect_ratio=decrease,` +
      `pad=${PANEL.w}:${PANEL.h}:(ow-iw)/2:(oh-ih)/2:black,` +
      `tpad=stop_mode=clone:stop_duration=${length}[v];` +
      `[0:v][v]overlay=${PANEL.x}:${PANEL.y},format=yuv420p[out]`
    await ffmpeg([
      '-loop', '1', '-i', piece.png, '-i', piece.video,
      '-filter_complex', filter, '-map', '[out]', '-t', length, ...ENCODE, piece.clip,
    ])
  })
  await pool(jobs, Math.max(2, Math.min(6, cpus().length - 2)))

  // 3. Join.
  const listFile = join(work, 'clips.txt')
  writeFileSync(listFile, pieces.map((p) => `file '${p.clip.replace(/'/g, "'\\''")}'`).join('\n'))
  const out = resolve(args.out)
  mkdirSync(resolve(out, '..'), { recursive: true })
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', out])

  const expected = pieces.reduce((sum, p) => sum + Math.round(p.seconds * FPS) / FPS, 0)
  const actual = await videoSeconds(out)
  const passed = scenes.filter((s) => s.pass).length
  console.log(`${passed} of ${scenes.length} scenarios pass`)
  console.log(`wrote ${out}: ${actual.toFixed(1)} s (expected ${expected.toFixed(1)} s), ${scenes.length} scenes, ${pieces.length} clips`)
  if (Math.abs(actual - expected) > 1) {
    console.log('WARNING: the length differs from the plan by more than 1 s. Check the clips.')
    process.exitCode = 2
  }
  if (!args.keepWork && !args.work) rmSync(work, { recursive: true, force: true })
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
