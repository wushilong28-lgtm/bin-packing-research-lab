# Bin Packing Research Lab

An interactive, browser-only research lab with a basic bin-count experiment and a separate Green Bin Packing cost experiment.

The [public demo](https://wushilong28-lgtm.github.io/bin-packing-research-lab/) shows the last published version. The local working copy may contain newer, unpublished changes.

## Basic experiment (`index.html`)

There are unlimited bins of capacity 1. Jobs arrive in order, with independent true sizes $a_i$ from the selected bounded distribution. The selected placement algorithm uses the size available to its model. If no eligible bin fits, it opens a new bin. The reference cost is the number of bins used; optional feedback adds a penalty to Model 2.

- **Model 1: true sizes.** The browser packs jobs using $a_i$.
- **Model 2: reported sizes.** First calculate perceived size $z_i=\mathrm{clip}(a_i+\varepsilon_i,0,1)$. One user chooses Hard with the history-adjusted probability described below, or with the base $g_0(z_i)$ when feedback is off. Simple mode reports $\min(t_s,z_i)$; Hard mode reports $\max(t_l,z_i)$. The browser packs using only these reported sizes. True sizes do not directly affect mode selection or placement in this model.

Both models share the same true jobs and arrival order within each trial. With FF/BF/NF/RF selected, both use that algorithm. With 双层 FF/BF selected, Model 1 uses ordinary FF/BF on true sizes, while Model 2 uses the two-layer algorithm below. An additional ordinary FF/BF reference on the identical reported sequence isolates the placement effect. Random Fit makes independent placement choices for each model. Trials are independent. The charts show mean bin counts, 5th–95th percentile ranges, and paired differences in bin counts between the models.
The first-trial job table shows the first 100 jobs in six compact columns: job, true → perceived → reported sizes, mode, quality status, Model 2 bin and View. Each job expands inline to show λ, base and adjusted probabilities, the uniform draw, feedback, quality history and both model bins.

### Optional feedback objective

The basic page has a Feedback switch and a nonnegative quality-penalty coefficient $c$ (default 1). The local page starts with feedback on; the programmatic interface defaults to feedback off. For each Model 2 job, $b_j=1$ in Simple mode and $b_j=0$ in Hard mode:

$$\alpha_j=b_j\max(z_j-t_s,0)c,\qquad J_2=B_2+\sum_j\alpha_j.$$

Feedback uses perceived size $z_j$ after judgment error and clipping. It is not true size $a_j$. The objective comparison reports mean feedback, mean Model 2 objective and the paired difference versus Model 1's true-size reference $J_1=B_1$. All totals include every job, beyond the first 100 displayed.

With feedback on, Simple outcomes update the user's empirical quality rate and affect future mode draws. Switching feedback off removes this update and all penalties, so the mode uses $g_0(z)$ and $q=0$. Setting $c=0$ removes penalties but retains quality observations and probability feedback. Rerun after changing settings.

### Data distribution (static page)

True-size sampling is separate from the existing judgment-error distribution. Choices are Uniform(min, max), Gaussian conditional on [0,1], Beta(α,β), Exponential(rate) conditional on [0,1], and a two-cluster mixture of truncated Gaussians. Gaussian parameters refer to the underlying, untruncated Gaussian; rejected samples are redrawn, not clipped. One user draws every job independently from the same selected distribution.

A first-trial histogram includes all N true sizes before judgment error. An optional integer seed reproduces a run. Independent streams for job sampling, probability-mode draws, and each model's Random Fit preserve the same exogenous jobs when changing λ, the feedback switch, c or placement algorithm with a fixed seed. Exogenous job/perception/mode-uniform inputs are generated before packing so placement randomness cannot alter them. Trial streams differ; a blank seed uses fresh randomness.

### One user and probability-based quality feedback

The static page now models exactly one user submitting all N jobs sequentially. The editable feedback sensitivity is λ in [0,1], default 0.5. The base probability g₀(z) is always configurable.

With feedback on, each job draws Hard with

$$g(z,t)=g_0(z)+\lambda q_{t-1}(1-g_0(z)).$$

Otherwise it draws Simple. The decision uses only the perceived size through g₀(z), λ, and **past** quality history. It does not inspect the merchant's private s/h, the current standardized report, or actual size. There is no personal-cost comparison, θ grid, user-group setting, learning-rate parameter or initial-rate input.

After choosing a mode, the merchant creates r=min(s,z) for Simple or r=max(h,z) for Hard. The packer places that report before the new outcome updates the history. A perceived-quality shortfall occurs when z>r. Only observed Simple jobs enter q:

$$q=\frac{\#\text{failed Simple submissions}}{\#\text{observed Simple submissions}}.$$

Successful Simple jobs count in the denominator. Hard provides no counterfactual Simple observation and leaves q unchanged. With no observations, q=0; each independent trial starts fresh.

The feedback switch controls both history-based behavior and objective penalties:

- **On:** use the adjusted probability, observe Simple outcomes, and evaluate α=c max(z-r,0).
- **Off:** use g₀(z) directly, keep q=0, and set every α=0.
- **λ=0 with feedback on:** use g₀(z), but still record quality outcomes and penalties.
- **c=0 with feedback on:** penalties are zero, while quality history and probability adjustments remain active.

The objective remains J₂=B₂+Σα; Model 1 uses true-size bin count J₁=B₁. α uses perceived size z, not true a, and equals c max(z-s,0) for Simple and zero for Hard. The coefficient c weights the quality penalty only; it does not enter the probability decision.

Results show Hard share, the mean final q across independent trials, base/adjusted probability and past-q curves, and one user's first-trial history. Charts pool at most 60 consecutive-submission groups and clearly label these averages. The first 100 jobs retain the compact six-column view; View expands λ, g₀(z), adjusted Hard probability, the uniform draw, α, history before/after placement and both model bins. Totals cover all N jobs.

This is a stochastic behavioral model. It does not claim personal-cost minimization or convergence. For λ=1,q=1, Hard probability can be 1 and no new Simple feedback arrives. For λ<1 and g₀(z)<1, Simple retains positive probability. Historical q is a selected-sample frequency, not a calibrated prediction for the next job.

## Placement algorithms

- **First Fit:** Scan bins in opening order and use the first one with enough remaining capacity.
- **Best Fit:** Use the fitting bin that leaves the least unused capacity, breaking ties by opening order.
- **Next Fit:** Try only the current bin; open a new bin when the job does not fit, and never revisit older bins.
- **Random Fit:** Choose uniformly at random among all fitting open bins; open a new bin when none fits.
- **双层 FF / 双层 BF (two-layer FF/BF):** Require `0 < s < 0.5 < h < 1` and `s + h = 1`. With `K>0`, an arriving threshold Simple (reported size exactly `s`, including equality before standardization) first checks existing ordinary bins containing Hard. If any fits, FF chooses the oldest eligible Hard bin and BF chooses the eligible Hard bin with least remaining capacity (ties by opening order). Only if none fits does it open a reserved singleton, up to `K` unmatched Simple bins (default 10, integer 0–5000); overflow goes to ordinary FF/BF. An arriving threshold Hard (reported size exactly `h`) first matches the oldest reserved Simple, filling its bin exactly. Hard never opens a reservation: without a match it goes into the ordinary FF/BF pool, where other fitting ordinary jobs may share its bin. Nonthreshold jobs also use ordinary FF/BF. Nearby unstandardized sizes are not treated as threshold atoms. The check of existing Hard bins also applies when reservations are full. It is a placement decision for the arriving Simple, not migration: existing jobs never move and ordinary bins never become reservations. Unmatched Simple reservations count toward the final bin count; there is no final repacking. `K=0` exactly recovers ordinary FF/BF, with no special priority for Hard bins.

The complementary-bounds button explicitly sets `h=1-s`; choosing an algorithm alone does not change thresholds. Invalid bounds are rejected before simulation. The pairing results show ordinary FF/BF versus two-layer packing on the same reports, reserved-layer matched pairs, threshold Simple placements into existing ordinary Hard bins, unmatched Simple reservations, Simple overflow arrivals and ordinary bins. Counts and all totals include every job. The job View panel identifies the route at arrival, including a Simple placed into an existing Hard bin before reservation; an opened Simple reservation may match a later threshold Hard.

For fixed reports and mode draws, placement cannot change quality history or penalties in this model. The same-reports comparison therefore has identical feedback costs; its objective improvement equals its bin saving. Reservation is a candidate heuristic, not a guarantee of improvement over ordinary FF/BF.

## Settings

- Jobs per trial: 500–5000; trials: 1–300. Static experiment: exactly one user, λ in [0,1], optional feedback.
- Base Hard-mode probability $g_0(z)$: choose a preset or enter an expression such as `1-z`, `z^2`, or `1/(1+exp(-12*(z-0.5)))`. The expression must yield a finite value in $[0,1]$ for all $z\in[0,1]$.
- Judgment error: none, normal, uniform, Laplace, symmetric triangular, Cauchy, centered exponential, or two-point.
- Simple-mode upper bound $t_s$, Hard-mode lower bound $t_l$, and error scale.

## Green experiment (`green.html`)

The Green page starts with the same reporting pipeline: true size $a_i$, perceived size $z_i=\mathrm{clip}(a_i+\varepsilon_i,0,1)$, Hard mode selected with probability $g(z_i)$ (Simple otherwise), and final reported size $r_i$. **All Green placement decisions and all Green costs use only $r_i$.** True-size bin loads, including any actual load above 1, are not checked or charged.

Bins have reported capacity 1. Let $G\in[0,1]$ be the green fill level, $\beta>0$ the price per unit of reported fill above it, and $B$ the number of bins opened. For reported bin loads $L_j$, the objective is

$$C = B + \beta\sum_j\max(0,L_j-G).$$

The threshold parameter $\tau\in[0,1-G]$ gives an effective packing capacity $G+\tau$. Each threshold algorithm normally places a reported item only where the resulting load is at most $G+\tau$. A single reported item larger than $G+\tau$ occupies its own bin, up to the physical reported capacity 1. The page compares threshold First Fit, Best Fit, Next Fit, Worst Fit, and Harmonic with 10 size classes. It also shows full-capacity First Fit as a reference. All algorithms process the same reported sequence within each trial, and a user-set seed makes trials reproducible. Reported item sizes may be zero after clipping or a zero Simple cap; those still count as arrivals.

The page reports mean total cost, opening cost, black-space cost, bin count, and black-space volume per trial. For the original known-size threshold formulation, see Bibbens et al., *Green Bin Packing* (arXiv:2510.26968). Applying it to reported sizes is this lab's extension.
The first-trial job table shows the first 100 reports and the bin chosen by a selectable algorithm.

## Dynamic Green experiment (`dynamic-green.html`)

This separate local page adds arrivals and departures without changing the two existing experiments. Each job has a true size $a$, a true duration $D$, and an arrival time. The size estimate $z$ uses the existing additive-error model. The duration estimate uses an independent uniform relative error, $\widetilde D=D(1+\varepsilon_D)$ with $\varepsilon_D\sim\mathrm{Uniform}(-\delta,\delta)$. The Hard probability is the weighted average $(1-\lambda)g_s(z)+\lambda g_t(\widetilde D)$, where $g_t$ is a configurable increasing logistic curve. One mode is drawn, then the Simple caps or Hard floors create both final reports. Jobs leave at arrival plus **reported duration**, and only reported size determines bin occupancy and Green charges. True values are retained for inspection but do not override reported departure or capacity.

The page compares one-dimensional adaptations of algorithms in Lee and Tang, *Evaluation of Dynamic Vector Bin Packing for Virtual Machine Placement*: non-clairvoyant First Fit, Most Recently Used, Next Fit, Round Robin Next Fit, and Best Fit; and clairvoyant Classify by Departure Time, Nearest Remaining Time, Prioritized NRT, Greedy, and Classify by Duration. Non-clairvoyant placement cannot inspect duration. Clairvoyant placement can inspect the job's reported departure. The paper's original problem is multidimensional and minimizes bin usage time; its competitive guarantees do not apply to this thresholded Green-cost extension.

With $B(t)$ active bins and reported load $L_j(t)$, the dynamic objective is $\int [B(t)+\beta\sum_j\max(0,L_j(t)-G)]\,dt$. Departures happen before simultaneous arrivals. Empty bins close and jobs never move. The page reports mean cost, bin-hours, black-space-hours, peak bins, a first-trial timeline, and a sample of job reports and placements.
The sample table shows the first 100 jobs of the first trial, including both size and duration reporting steps and the selected algorithm's bin assignments.

## Run locally

Keep the web files together and serve them with any static HTTP server, for example:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000/` for the basic page, `http://localhost:8000/green.html` for the static Green page, or `http://localhost:8000/dynamic-green.html` for the dynamic Green page. The experiments run entirely in the browser; they do not upload jobs or results. You can also open the HTML files directly on your computer.

## Files

- `index.html`: page structure and text.
- `styles.css`: layout and styles.
- `probability.js`: probability-expression parser and validation. It does not evaluate user-supplied JavaScript.
- `app.js`: single-user sampling, causal probability-feedback submissions, placement algorithms, and charts.
- `static-behavior.js`: bounded distributions, λ validation and one user's Simple-quality history.
- `green.html`: separate Green Bin Packing experiment page.
- `green-core.js`: seeded reporting, threshold placement, and cost calculation.
- `green.js`: Green page form, comparison, and display.
- `tests/green-core.test.js`: deterministic reporting, placement, and cost checks (`node --test tests/green-core.test.js`).
- `dynamic-green.html`, `dynamic-green.css`, `dynamic-green.js`: the separate dynamic experiment page.
- `dynamic-green-core.js`: seeded sampling, departure events, paper-inspired placement rules, and time-integrated costs.
- `tests/dynamic-green-core.test.js`, `tests/dynamic-page.test.js`: dynamic model and local page checks (`node --test tests/*.test.js`).
