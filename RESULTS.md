# Local runner results — github-core-clone-01

Server: single-process Node 22 stdlib-only TypeScript (`main.ts` starter
lifecycle unchanged, `app.ts` the whole forge). Run with the kit's local
runner (`sdk/run.ts`) against a freshly started server on an ephemeral port,
`MAKEFUN_SHOP_TOKEN=dummy-token`, same token for the runner.

## Conformance (no --perf), 2026-11-20

- **120 / 120 checks passed**
- git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5,
  graphql 20/20, mcp 15/15
- columns: feature 600, agent 200, perf 0 (not run), **score 800**

## Conformance + perf, fresh server each run, 2026-11-20

| run | feature | agent | perf | score | passed |
|-----|---------|-------|------|-------|--------|
| run4 | 600 | 200 | 189 | **989** | 120/120 |
| run5 | 600 | 200 | 190 | **990** | 120/120 |

Perf workloads (p50, run4 / run5):

| workload | ops | p50 run4 | p50 run5 | points run4 | points run5 |
|----------|-----|----------|----------|-------------|-------------|
| push | 200 sequential 1 KiB pushes | 378 ms | 349 ms | 50 | 50 |
| clone | 50 concurrent depth-1 clones of a 200-commit repo | 105 ms | 107 ms | 42 | 42 |
| read | 2,000 sequential GET issue | 729 ms | 675 ms | 49 | 50 |
| write | 200 sequential POST issues | 96 ms | 96 ms | 48 | 48 |

## Determinism

Pass bits identical across run4 and run5 (120/120 both). Perf differed by
1 point (read 49 vs 50) — timing noise only. State is deterministic by
design: fixed epoch 2025-01-01T00:00:00Z for all git author/committer dates,
fixed identity `ada iversen <adaiversen@example.invalid>`, sequential
deterministic ids; no wall clock is stored in state.

## Caveats

- Local perf points are calibrated against the kit's local reference; the
  sealed grading env may calibrate differently, so the 189–190 local perf
  points are indicative, not a promise.
- A runner run against a server that already served a previous run fails
  checks that create same-named repos (state pollution). Always start a
  fresh server per runner run; the grading env does this by design.
- No submission has been made. A public GitHub repo owned by Afgil
  (@afgil-ainudin) is still required before submit; see the parent
  orchestrator for the steps.
