| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| AUD-04 | `vuln-lib` (synthetic fixture) | `inspector.Session#post('Runtime.evaluate', {includeCommandLineAPI:true})` is an unmodeled eval surface | false NOT_AFFECTED — see below | Open |

## AUD-04 — `inspector.Session#post('Runtime.evaluate', {includeCommandLineAPI:true})` is an unmodeled eval surface

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** B
**Proof family affected:** A
**Severity:** Critical
**Fix lane:** C — capability flow and resolution

`inspector` (and `node:inspector`, `inspector/promises`) is entirely absent from the builtin/capability table, so a `Runtime.evaluate` call with `includeCommandLineAPI` (which hands the evaluated string a working `require`) never widens the closure. Family A certifies the package absent although Node's own `require` inside the evaluated string loads and calls it.

Full reproduction: `docs/audits/2026-09-independent-audit.md § 4, "AUD-04"`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task BL-097, 2026-10-19): a second route, measured.**
BL-097's independent audit (round 2, F-1) found that the inspector
surface is wider than `Runtime.evaluate`: `Debugger.evaluateOnCallFrame`
on the `Debugger.paused` event a `debugger;` statement raises runs its
expression in the paused frame -- the module wrapper's, with its own
`require` and `module`, and with no `includeCommandLineAPI`. Measured
against real Node v22.11.0: `const s = new (require("inspector").Session)();
s.connect(); s.on("Debugger.paused", (m) => { s.post("Debugger.evaluateOnCallFrame",
{ callFrameId: m.params.callFrames[0].callFrameId, expression:
"module.paths.shift()" }, () => {}); s.post("Debugger.resume"); });
s.post("Debugger.enable"); debugger;` in BL-097's oracle setup makes Node
call the target while the analyzer answers `NOT_AFFECTED` (family B), on
BL-097's base `670a839` and its branch alike. The loader classifier has no
`inspector` entry at all. C-4's fix must cover the inspector session as a
whole (every method that evaluates code, `Runtime.evaluate`,
`Runtime.compileScript` / `runScript`, `Debugger.evaluateOnCallFrame`,
`Debugger.setBreakpoint` conditions and the like), not `Runtime.evaluate`
alone.

---

