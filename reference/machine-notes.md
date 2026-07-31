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
