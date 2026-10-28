# Bin Packing Research Lab

An interactive, browser-only research lab with a basic bin-count experiment and a separate Green Bin Packing cost experiment.

The [hosted demo](https://bin-packing-ff-lab.wushilong28.chatgpt.site/) may still show an earlier version than this repository.

## Basic experiment (`index.html`)

There are unlimited bins of capacity 1. Jobs arrive in order, with independent true sizes $a_i\sim\mathrm{Uniform}(0,1)$. The selected placement algorithm uses the size available to its model. If no eligible bin fits, it opens a new bin. The objective is the number of bins used.

- **Model 1: true sizes.** The browser packs jobs using $a_i$.
- **Model 2: reported sizes.** First calculate perceived size $z_i=\mathrm{clip}(a_i+\varepsilon_i,0,1)$. A job chooses Hard mode with probability $g(z_i)$ and Simple mode otherwise. Simple mode reports $\min(t_s,z_i)$; Hard mode reports $\max(t_l,z_i)$. The browser packs using only these reported sizes. True sizes do not directly affect mode selection or placement in this model.

Both models use the same algorithm and, within each trial, the same true jobs and arrival order. Random Fit makes independent random placement choices for each model. Trials are independent. The charts show mean bin counts, 5th–95th percentile ranges, and paired differences in bin counts between the models.
The first-trial job table shows the first 100 true sizes, perceptions, Hard probabilities, modes, reports, and actual bin assignments in both models.

### Optional feedback objective

The basic page has a Feedback switch (off by default) and a nonnegative coefficient $c$ (default 1). For each Model 2 job, $b_j=1$ in Simple mode and $b_j=0$ in Hard mode, and

$$\alpha_j=b_j\max(z_j-t_s,0)c,\qquad J_2=B_2+\sum_j\alpha_j.$$

Here $X_j$ in the research feedback formula means the **perceived size $z_j$ after judgment error and clipping**, which is used for mode selection. It is not the true size $a_j$ or the final min/max report. Feedback only applies to Simple jobs whose perceived size exceeds the Simple cap. When the switch is off, all feedback is zero. A coefficient of zero also gives zero feedback.

The objective comparison reports mean feedback, mean Model 2 objective, and paired objective difference versus Model 1's true-size reference $J_1=B_1$ (zero feedback). Totals use every job in each trial; the first 100 preview rows additionally show $b_j$ and $\alpha_j$. Feedback is a scoring term and does not change mode sampling or bin placement. Rerun the experiment after changing its settings.

## Placement algorithms

- **First Fit:** Scan bins in opening order and use the first one with enough remaining capacity.
- **Best Fit:** Use the fitting bin that leaves the least unused capacity, breaking ties by opening order.
- **Next Fit:** Try only the current bin; open a new bin when the job does not fit, and never revisit older bins.
- **Random Fit:** Choose uniformly at random among all fitting open bins; open a new bin when none fits.

## Settings

- Jobs per trial: 500–5000; trials: 1–300.
- Hard-mode probability $g(z)$: choose a preset or enter an expression such as `1-z`, `z^2`, or `1/(1+exp(-12*(z-0.5)))`. The expression must yield a finite value in $[0,1]$ for all $z\in[0,1]$.
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
- `app.js`: sampling, error distributions, placement algorithms, and charts.
- `green.html`: separate Green Bin Packing experiment page.
- `green-core.js`: seeded reporting, threshold placement, and cost calculation.
- `green.js`: Green page form, comparison, and display.
- `tests/green-core.test.js`: deterministic reporting, placement, and cost checks (`node --test tests/green-core.test.js`).
- `dynamic-green.html`, `dynamic-green.css`, `dynamic-green.js`: the separate dynamic experiment page.
- `dynamic-green-core.js`: seeded sampling, departure events, paper-inspired placement rules, and time-integrated costs.
- `tests/dynamic-green-core.test.js`, `tests/dynamic-page.test.js`: dynamic model and local page checks (`node --test tests/*.test.js`).
