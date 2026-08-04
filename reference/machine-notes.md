# Machine notes

Section 1b of `HANDOFF.md` lists what was specific to the sandbox this project
was built in, and instructs the next session to **re-test rather than believe**
those claims. This file is the result of doing that. It is deliberately separate:
`HANDOFF.md` 1b owns *what was true on the machine that wrote it*, and this file
owns *what was measured afterwards, elsewhere*. Neither restates the other.

Append a section per machine. Do not edit an older one to make it agree with a
newer one - two machines disagreeing is information.

---

## Machine 3 - Vercel sandbox, node v24.14.1, 2026-07

The gate passed here before anything was touched, and again after every change:
`node tools/dyn.mjs` and `node tools/listen.mjs --mode graph`, both byte-identical
to `reference/` once the baselines' `#` headers are stripped. 173 and 20 lines.
Same tau of 8.02 s, same 358.4 Hz shell ring, same -0.986 rudder dot, same 423.2 m
at the end of the descent, same 1440 frames / 928 events / 0 voices open - under a
node two major versions newer than the baselines were taken with. **The arithmetic
is portable.** That is the single most reassuring measurement in this file.

### Network: worse than 1b describes, and beware how you test it

No DNS and no egress at all. `curl` returns `000` in about 7 ms to every host,
and `--resolve` pinned to a known GitHub IP fails identically, so it is not the
resolver - there is simply no route out.

**A warning about the measurement itself, which matters more than the result.**
A `bash /dev/tcp` probe reported `OK` for `192.0.2.1`, which is TEST-NET and
unroutable by definition. That false positive produced a confident, published,
completely wrong finding - "TCP works, only DNS is blocked" - which survived until
a control test against a deliberately dead address destroyed it. A probe that
succeeds against something that cannot exist is measuring nothing. Use `curl`, and
look at the timing.

The repository arrived as a zip through the chat instead of through git. This is
why `vendor/` earns its place: 2 MB of three.js cannot come down a transcript, and
hand-writing a `Vector3` stub to work around that would have created a second
owner for three.js's maths - the exact bug shape the ledger already has three
instances of.

### Browser: everything was already installed, and nothing could find it

`CHROME_PATH` as described in 1b is **superseded**. Two separate faults, both a
check asking the wrong question, and both now fixed in `tools/`.

**The shim shadowed a real driver.** `ensurePlaywright()` asked `existsSync` on
`ROOT/node_modules/playwright`. That is not the question: node resolves a bare
specifier by walking `node_modules` upward, so an install *above* ROOT is
importable - and a shim written under ROOT hides it. Playwright 1.45.0 sat in
`/vercel/sandbox/node_modules`, three levels up. The function whose entire purpose
is "a genuine one is strictly better and must win" was what made the genuine one
unreachable. It now asks the resolver, from two start points so its own shim is
never mistaken for evidence of itself, and deletes a stale shim it finds shadowing
a real install.

**A driver with no browser binary, on a machine where the binary was present.**
Playwright derives its browser cache from `HOME`. `HOME` said
`/home/vercel-sandbox`; the cache was under `/vercel/sandbox/.cache`. So the
driver and the exact revision it wanted, `chromium-1124`, were both installed and
it still refused to launch, advising `npx playwright install` with no registry to
install from. One `readlink` settled it:

```
/usr/local/bin/chromium -> /vercel/sandbox/.cache/ms-playwright/chromium-1124/chrome-linux/chrome
```

Same cache, same revision, different root. `ensureBrowsersPath()` in `boot.mjs`
now realpaths whatever `chromium` is on `PATH` and cuts at the `ms-playwright`
segment. Derived, never hardcoded - that literal path is wrong on the next machine
and would be a lie the moment it was written.

**Setting the environment is not enough if something imports playwright first.**
Playwright builds its browser registry at module-load time, so
`PLAYWRIGHT_BROWSERS_PATH` must be set before the first `import 'playwright'`
anywhere in the process. `listen.mjs` imported it fifteen lines above
`./boot.mjs`, so every survey worked and that one tool alone still insisted the
browser was missing - with an error identical to the unfixed state, which is what
made the earlier fix look like it had failed. `boot.mjs` is now the only owner of
launching a browser.

Still no GPU: SwiftShader at roughly 15 s per 800x450 frame, so section 4's
cautions about frames that cannot settle still apply here.

### `max` in `baseline-frames.txt` is phase-dependent, and misled a whole cycle

One row of the frame table diverged from baseline: `h-deep-dark`, `max` 416 in the
baseline against 148 here, with mean, median, blown%, black% and all three channel
means identical. Three repeats gave 133, 120, 147 - *stable*, which rules out
grain and is exactly what makes it look like a regression.

It is not one. `survey.mjs` settles for a fixed 1500 ms, so every repeat
photographs the same instant of any periodic light. Sampling 16 screenshots 220 ms
apart at `g.pose('deep'); g.setLamp(0)` sweeps the phase:

```
  phase   p00  p03  p06  p07  p08  p09  p10  p11  p14
  max     135  216  246  519  627  635  547  319  234
  px>300    0    0    0   16  138  307  235    4    0
```

The trunk strobe is present and bright - peak `max` 635, with 307 pixels above a
channel sum of 300 in a frame whose mean is 84. The baseline simply caught it lit.

**Therefore `max` is a poor column to judge any frame containing a periodic
light.** Judge that row by mean, and sweep the phase before believing a single
bright-pixel number. The baseline file is left as it is: it is doing its job, and
rewriting it to hide a real property of the scene would be worse.

### Rendered audio ran here for the first time

```
node tools/listen.mjs --mode render --scene blow
  scene blow, 8s at 48 kHz, 384000 samples
  rms 0.05803   peak 0.2435   crest 4.2x   clipped 0
  events 1, voices open at end 0
  energy by octave:
     31.25 Hz  -2.1 dB      62.5 Hz -14.5 dB       125 Hz -22.1 dB
       250 Hz -27.9 dB        500 Hz -11.4 dB      1000 Hz -22.6 dB
      2000 Hz -21.7 dB       4000 Hz  -7.1 dB      8000 Hz   0.0 dB
     16000 Hz -20.5 dB
```

Read against what the numbers were derived from rather than against taste: the
band that wins is 8 kHz, and Minnaert puts a ballast bubble at 426 m between 1.6
and 10.6 kHz, so the loudest part of a blow being up there is the formula arriving
rather than a mixing decision. 31.25 Hz second is the plant underneath it, and 500
Hz between them is tank structure. Nothing clipped; peak 0.2435 against a limit of
1.0 and a crest of 4.2x is a transient, which is what a blow should measure as.
One voice opened, one closed, none left open - the first time the render and the
stub agree on the same scene.

### Pushing

`push_files` over the GitHub MCP works. A fine-grained token needs
**`Contents: Read and write`**; with no permissions at all it still reads a public
repository perfectly, so reads succeeding proves nothing about writes. The failure
is a flat `403 Resource not accessible by personal access token` on `git/trees`.

Content is sent as a string, so **verify every push**: compare `git hash-object`
locally against the `sha` returned by `get_file_contents`. Binaries cannot go this
way at all, which is still why the contact sheets are not committed.

A practical limit worth knowing: this transport sends whole files, and there is no
patch call. Editing a 70 KB file such as `HANDOFF.md` means retransmitting all of
it, which is why this file exists as a separate small one rather than as more
paragraphs inside section 1b.

### Shell traps in this sandbox

- **Background processes do not survive between terminal calls.** A `nohup`'d
  `python3 -m http.server` is gone by the next command and every shot then fails
  with `ERR_CONNECTION_REFUSED`. Start the server in the *same* command as the
  run: `cd X; python3 -m http.server 8123 & sleep 2; node tools/survey.mjs ...`
- **Note the `;`.** `cd X && python3 ... &` backgrounds the entire chain and
  leaves the foreground shell where it started, which surfaces much later as
  `Cannot find module`.
- **Never redirect a survey to `/dev/null`.** That hid the dead server for a full
  cycle.
- **Process substitution is unavailable.** `diff <(a) <(b)` fails with
  `/dev/fd/63: No such file or directory`. Write temp files.
- **Strip baselines carefully.** `grep -v '^#'` leaves a blank line the baselines
  do not have and reports a one-line difference that is entirely your own. Look at
  the diff before believing the verdict.

---

## Machine 4 - the owner's Windows 11 laptop, node v24.18.0, 2026-08

The first machine with a real GPU: `ANGLE (NVIDIA GeForce RTX 5070 Ti Laptop,
D3D11)`. Both arithmetic gates passed byte-identical to `reference/` before
anything was touched. The copy arrived as a plain directory with **no `.git`**,
so nothing here is committed - re-establish the repository before the next
session loses this one's record.

### The browser is Edge, and the SwiftShader flags kill it

No Chrome, no Playwright cache; `C:\Program Files (x86)\Microsoft\Edge\
Application\msedge.exe` is what Windows 11 guarantees. Two harness changes, both
now in `tools/`:

- `cdp.mjs` `BROWSER_CANDIDATES` gained the four standard Windows install paths,
  Edge last because Chrome matches the harness's history when both exist.
- **Edge crashes with 0xC0000005 before printing a DevTools endpoint when handed
  the SwiftShader trio** (`--use-gl=angle --use-angle=swiftshader
  --enable-unsafe-swiftshader`). `boot.mjs` `launch()` now retries a launch that
  "exited early" with those flags stripped - a browser that kills the software
  path is a browser that has a hardware one. No env vars needed; `node
  tools/survey.mjs` just works.

### What a real GPU changes

- **A frame settles in about five seconds**, against 15-30 s under SwiftShader.
  The whole 33-frame survey is under three minutes.

**CORRECTION, measured later the same session.** The paragraph that stood here
claimed "settle 1500 ms is ~90 real frames, so exposure adaptation actually
converges", and used that to explain `l-nosnow` reading 305 against an older
baseline of 335. Both halves were wrong, and the second was wrong in a way that
delayed finding a real bug - `l-nosnow` was the stale-sea-surface defect (see
`HANDOFF.md`), not adaptation. The frame rate was never measured; it was
inferred from the survey's five-seconds-per-shot, which is wall clock for a
whole boot-settle-screenshot-readStats cycle. Asked directly, the page says:

```
  over 1500 ms:    4 frames  = 2.7 fps
  over 3000 ms:    6 frames  = 2.0 fps
  5 screenshots advanced the page by 30 frames
  g.fps reports 10.0
```

So headless Chrome throttles `requestAnimationFrame` to about 2 fps when nothing
is compositing, and **`Page.captureScreenshot` is what actually drives the page**
- six frames per capture. A 1500 ms settle is roughly *four* frames, not ninety.

Three consequences:

- **The harness's timing is as meaningless here as on every previous machine**,
  real GPU or not. Note that `g.fps` reads exactly **10.0** - the same number
  HANDOFF section 3 records for the cloud browser, and for the same reason. The
  only trustworthy performance figures remain the ones measured in the owner's
  own browser (183/240 fps).
- **Review frames are still correct, and it is worth knowing why**: `applyPose`
  and `inside()` call `adaptExposure(0, true)`, which *snaps*. The survey does
  not depend on convergence, so it survives a 4-frame settle. Anything that
  needed to settle would not.
- `dt` is clamped to 0.1, so those four frames advance simulated time by about
  0.4 s. Any animation judged from a still here is being seen a fraction of a
  second after setup, not at a steady state.

HANDOFF section 4's rule was right all along and applies unchanged on this
machine: **wait on `g.frames`, not on the clock** - and do not measure time in a
browser at all.

### Phase dependence moves the mean, not just `max`

Machine 3 established that `max` is unreliable in any frame containing a
periodic light. Two full surveys run back to back here, with everything else
fixed, leaves exactly two frames disagreeing with themselves:

```
  frame          baseline    run1    run2   run-to-run
  C-fwd           184.5     187.0   185.0        2.0
  z-galley        154.4     155.9   154.8        1.1
```

Both are interior frames containing animated emissive lamps - the sonar sweep
at the helm, the switchboard and scrubber indicators. So the phase dependence
reaches the **mean** as well, at about 1% of it. Judge an interior frame moved
only past about 2.5 on the mean; below that it may be the sonar. Everything
else in the set repeats to within 1.0.
- `h-deep-dark` `max` came out 342-416 across runs: the strobe phase note from
  machine 3 confirmed on different hardware.
- Rendered audio (`listen.mjs --mode render`): `blow` matches machine 3 to four
  decimals (rms 0.05803, peak 0.2435, crest 4.2, 8 kHz octave on top). One
  divergence: `voices open at end 1` against machine 3's 0 - the blow tail is
  still ringing at the 8 s cutoff and this browser counts it; `descent` shows 5
  for the same reason (last creaks decaying). The graph-mode released-voices
  gate still passes, so this is end-of-render accounting, not a leak.

### Windows shell traps

- PowerShell 5.1 is the shell. `2>&1` on a native command wraps stderr in
  ErrorRecords and can garble the first line into mojibake; redirect with `*>`
  to a file and read the file.
- `npm` is broken through this harness (its own .ps1 shim fails resolving the
  node prefix), but nothing needs it: the CDP shim plus vendored three.js cover
  everything, which is exactly what they were built for.
- `python` exists (3.14); `pip install pillow numpy` for the frame statistics.
- **No ffmpeg, so `tools/sheet.mjs` cannot run here.** The contact sheets were
  built with a short PIL script instead — which turned out to be an upgrade:
  ffmpeg here never had freetype, so `sheet.mjs`'s own comment concedes the
  tiles cannot carry their names and prints a reading order instead. PIL draws
  the label under each tile. If someone is on a machine with both, a labelled
  sheet is worth more than a fast one.
- Background processes started by the agent harness are killed between
  commands; start the HTTP server with `Start-Process` (detached) instead.
