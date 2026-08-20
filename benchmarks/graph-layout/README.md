# Graph Layout Benchmark Findings

## CTX-0411

At commit `35296b4`, the default matrix is not bounded by topology mutation.
It runs two workloads, four node counts, four layout arms, six trials, 30
regular ticks, and up to 500 post-append settling ticks. The settling loop is
the dominant cost and can exceed the headed runner budget before the result is
posted.

The diagnostic command below isolated the largest default count with one
trial and one regular tick:

```bash
RUN_TIMEOUT=120 RUN_EXTEND=180 ./benchmarks/run-browsers.sh graph-layout 8272 \
  --viewport 1280x720 \
  --param counts=3000 --param ticks=1 --param trials=1 \
  --param settleCap=500 --param uaMemoryTimeoutMs=250 \
  chrome firefox
```

At 3000 nodes, append mutation was `0.125-2.015 ms`, while settling took
`0.84-8.12 s` per arm in one trial. The slowest arms were `d3-force-3d` on
mixed-sparse (`7.14 s` Chrome, `8.12 s` Firefox). The other arms also executed
285-300 settling ticks, so the issue is matrix multiplication of settling
work, not a single `ForceLayout2D.appendGraph` defect.

The requested N=7 run at 1000 nodes was also bounded but not complete:

```bash
RUN_TIMEOUT=120 RUN_EXTEND=180 ./benchmarks/run-browsers.sh graph-layout 8273 \
  --viewport 1280x720 --iterations 7 \
  --param counts=1000 --param ticks=30 --param trials=1 \
  --param settleCap=500 --param uaMemoryTimeoutMs=250 \
  --keep-going chrome firefox
```

Run ID `20260820T134539Z-1d095c` produced seven Firefox iterations and six
Chrome iterations. Chrome iteration 3 reached the full `120 s + 180 s`
extension and timed out. This is a reproducible limitation of the complete
1000-node matrix under the current headed-runner budget.

## Bounded N=7 baseline

The complete reduced baseline retains both workloads, all four layout arms,
30 regular ticks, the 500-tick settling cap, and one trial, reducing only the
node count to 500:

```bash
RUN_TIMEOUT=120 RUN_EXTEND=180 ./benchmarks/run-browsers.sh graph-layout 8274 \
  --viewport 1280x720 --iterations 7 \
  --param counts=500 --param ticks=30 --param trials=1 \
  --param settleCap=500 --param uaMemoryTimeoutMs=250 \
  --keep-going chrome firefox
```

Run ID `20260820T135641Z-1a6d54` completed all seven iterations for both
engines. The runner measured refresh cadence at `240.04 Hz` for Chrome and
`240.64 Hz` for Firefox on the 240 Hz panel. Representative aggregate medians
from the runner output are:

| Workload     | Layout          | Chrome settle median | Firefox settle median |
| ------------ | --------------- | -------------------: | --------------------: |
| star-hub     | d3-force-3d     |            804.04 ms |            1006.20 ms |
| star-hub     | vecto-force     |           244.745 ms |             264.42 ms |
| star-hub     | d3-force-2d     |           694.405 ms |            1013.66 ms |
| star-hub     | force-layout-2d |            567.45 ms |             603.64 ms |
| mixed-sparse | vecto-force     |            249.43 ms |             240.14 ms |
| mixed-sparse | d3-force-2d     |           710.535 ms |            1020.40 ms |
| mixed-sparse | force-layout-2d |            585.51 ms |             561.24 ms |
| mixed-sparse | d3-force-3d     |           958.755 ms |            1293.74 ms |

The `500`-node workload is the current complete N=7 baseline for this host.
Results are intentionally kept in the ignored `benchmarks/graph-layout/results`
directory; the run ID above identifies the generated history and aggregate
files. No production graph-layout code was changed.
