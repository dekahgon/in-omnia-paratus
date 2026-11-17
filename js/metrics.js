/* Measurements of the network on screen, following
   Mac Carron & Kenna (2012), "Universal properties of mythological networks", EPL 99, 28002.

   The network is unweighted: two characters are linked if they share at least one movie.
   MN.computeMetrics(graph) returns every value; a value is null when the network is too small
   (or too uniform) for it to be calculated, and is then shown as "—". */
(function () {
  const MN = (window.MN = window.MN || {});

  const RUNS = 500; // repetitions for random attacks (and for ties in targeted attacks)
  const ATTACK_SHARE = 0.05; // 5% of the characters, rounded up
  const MIN_DEGREE_VALUES = 5; // different degree values needed to fit the degree distribution

  // ======================================================================
  // graph helpers
  // ======================================================================

  // nodes: array of ids; edges: [{source, target}] (ids or node objects)
  function makeGraph(nodes, edges) {
    const idx = new Map(nodes.map((id, i) => [id, i]));
    const adj = nodes.map(() => new Set());
    let m = 0;
    for (const e of edges) {
      const a = idx.get(typeof e.source === 'object' ? e.source.id : e.source);
      const b = idx.get(typeof e.target === 'object' ? e.target.id : e.target);
      if (a == null || b == null || a === b || adj[a].has(b)) continue;
      adj[a].add(b);
      adj[b].add(a);
      m++;
    }
    return { n: nodes.length, m, adj, deg: adj.map((s) => s.size) };
  }

  // breadth-first search from s: number of steps to every node (-1 = unreachable or removed)
  function bfs(G, s, alive) {
    const dist = new Int32Array(G.n).fill(-1);
    dist[s] = 0;
    const queue = [s];
    for (let q = 0; q < queue.length; q++) {
      const u = queue[q];
      for (const v of G.adj[u]) {
        if (dist[v] < 0 && (!alive || alive[v])) {
          dist[v] = dist[u] + 1;
          queue.push(v);
        }
      }
    }
    return dist;
  }

  // the largest component, as a list of node indices (alive: optional mask of the nodes kept)
  function largestComponent(G, alive) {
    const seen = new Uint8Array(G.n);
    let best = [];
    for (let s = 0; s < G.n; s++) {
      if (seen[s] || (alive && !alive[s])) continue;
      const comp = [s];
      seen[s] = 1;
      for (let q = 0; q < comp.length; q++)
        for (const v of G.adj[comp[q]])
          if (!seen[v] && (!alive || alive[v])) {
            seen[v] = 1;
            comp.push(v);
          }
      if (comp.length > best.length) best = comp;
    }
    return best;
  }

  function seededRandom(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) {
      h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // picks `count` different items of `list` at random
  function sample(list, count, rnd) {
    const a = list.slice();
    for (let i = 0; i < count; i++) {
      const j = i + Math.floor(rnd() * (a.length - i));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, count);
  }

  // ======================================================================
  // measures
  // ======================================================================

  // diameter and average path length inside the largest component
  function paths(G, comp) {
    if (comp.length < 2) return { diameter: null, avgPath: null };
    const alive = new Uint8Array(G.n);
    comp.forEach((v) => (alive[v] = 1));
    let sum = 0, max = 0;
    for (const s of comp) {
      const d = bfs(G, s, alive);
      for (const t of comp) if (t !== s) { sum += d[t]; if (d[t] > max) max = d[t]; }
    }
    return { diameter: max, avgPath: sum / (comp.length * (comp.length - 1)) };
  }

  // eq.(1): C_i = 2 n_i / (k_i (k_i - 1)); characters with fewer than 2 co-stars count as 0
  function clusteringPerNode(G) {
    return G.adj.map((nb) => {
      const list = [...nb];
      const k = list.length;
      if (k < 2) return 0;
      let links = 0;
      for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) if (G.adj[list[a]].has(list[b])) links++;
      return (2 * links) / (k * (k - 1));
    });
  }

  // mean clustering coefficient per degree, for k >= 2 (fig. 1 of the paper)
  function hierarchy(G, Ci) {
    const by = new Map();
    G.deg.forEach((k, i) => {
      if (k < 2) return;
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(Ci[i]);
    });
    return [...by.entries()]
      .map(([k, cs]) => ({ k, value: cs.reduce((a, b) => a + b, 0) / cs.length, count: cs.length }))
      .sort((a, b) => a.k - b.k);
  }

  // ---------- degree distribution ----------

  // weighted linear least squares: rows X (arrays), targets y, weights w
  function wls(X, y, w) {
    const p = X[0].length;
    const A = Array.from({ length: p }, () => new Array(p).fill(0));
    const b = new Array(p).fill(0);
    X.forEach((row, i) => {
      for (let r = 0; r < p; r++) {
        b[r] += w[i] * row[r] * y[i];
        for (let c = 0; c < p; c++) A[r][c] += w[i] * row[r] * row[c];
      }
    });
    const inv = invert(A);
    if (!inv) return null;
    const beta = inv.map((row) => row.reduce((s, v, c) => s + v * b[c], 0));
    const chi2 = X.reduce((s, row, i) => {
      const fit = row.reduce((t, v, c) => t + v * beta[c], 0);
      return s + w[i] * (y[i] - fit) ** 2;
    }, 0);
    return { beta, err: inv.map((row, i) => Math.sqrt(Math.max(0, row[i]))), chi2 };
  }

  function invert(M) {
    const n = M.length;
    const a = M.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < n; c++) {
      let piv = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[piv][c])) piv = r;
      if (Math.abs(a[piv][c]) < 1e-12) return null;
      [a[c], a[piv]] = [a[piv], a[c]];
      const d = a[c][c];
      for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = a[r][c];
        for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
      }
    }
    return a.map((row) => row.slice(n));
  }

  // Fits the cumulative degree distribution P(k) (share of characters with at least k co-stars)
  // with a power law, a truncated power law and an exponential, as in fig. 2 of the paper.
  // Each model is linear in ln P, so it is fitted by weighted least squares on ln P with
  // the counting error of each point (sigma of ln P = 1 / sqrt(number of characters with degree >= k)).
  // The model with the lowest chi^2 per degree of freedom wins.
  function degreeFit(G) {
    const ks = [...new Set(G.deg.filter((k) => k >= 1))].sort((a, b) => a - b);
    if (ks.length < MIN_DEGREE_VALUES) return null;
    const pts = ks.map((k) => {
      const count = G.deg.filter((d) => d >= k).length;
      return { k, y: Math.log(count / G.n), w: count };
    });
    const y = pts.map((p) => p.y), w = pts.map((p) => p.w);
    const fits = [];

    const pl = wls(pts.map((p) => [1, Math.log(p.k)]), y, w);
    if (pl) fits.push({ model: 'power law', chi2df: pl.chi2 / (pts.length - 2), params: [{ name: 'γ', value: 1 - pl.beta[1], err: pl.err[1] }] });

    const ex = wls(pts.map((p) => [1, p.k]), y, w);
    if (ex && ex.beta[1] < 0) {
      const b = ex.beta[1];
      fits.push({ model: 'exponential', chi2df: ex.chi2 / (pts.length - 2), params: [{ name: 'κ', value: -1 / b, err: ex.err[1] / (b * b) }] });
    }

    const tr = wls(pts.map((p) => [1, Math.log(p.k), p.k]), y, w);
    if (tr && tr.beta[2] < 0) {
      const b = tr.beta[2];
      fits.push({
        model: 'truncated power law',
        chi2df: tr.chi2 / (pts.length - 3),
        params: [
          { name: 'τ', value: 1 - tr.beta[1], err: tr.err[1] },
          { name: 'k*', value: -1 / b, err: tr.err[2] / (b * b) },
        ],
      });
    }
    if (!fits.length) return null;
    fits.sort((a, b) => a.chi2df - b.chi2df);
    return Object.assign({}, fits[0], { all: fits, points: pts.map((p) => ({ k: p.k, P: Math.exp(p.y) })) });
  }

  // ---------- attacks ----------

  // eq.(4): betweenness centrality (Brandes' algorithm), normalised by 2 / ((N-1)(N-2)) over pairs i<j
  function betweenness(G) {
    const n = G.n;
    const cb = new Float64Array(n);
    for (let s = 0; s < n; s++) {
      const stack = [];
      const preds = Array.from({ length: n }, () => []);
      const sigma = new Float64Array(n);
      const dist = new Int32Array(n).fill(-1);
      sigma[s] = 1;
      dist[s] = 0;
      const queue = [s];
      for (let q = 0; q < queue.length; q++) {
        const v = queue[q];
        stack.push(v);
        for (const w of G.adj[v]) {
          if (dist[w] < 0) {
            dist[w] = dist[v] + 1;
            queue.push(w);
          }
          if (dist[w] === dist[v] + 1) {
            sigma[w] += sigma[v];
            preds[w].push(v);
          }
        }
      }
      const delta = new Float64Array(n);
      while (stack.length) {
        const w = stack.pop();
        for (const v of preds[w]) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
        if (w !== s) cb[w] += delta[w];
      }
    }
    // every unordered pair was counted twice (once from each end)
    const norm = n > 2 ? 2 / ((n - 1) * (n - 2)) : 0;
    return Array.from(cb, (v) => (v / 2) * norm);
  }

  function gcWithout(G, removed) {
    const alive = new Uint8Array(G.n).fill(1);
    removed.forEach((v) => (alive[v] = 0));
    return largestComponent(G, alive).length;
  }

  // Removes the top 5% by betweenness (calculated once). When characters tie at the cut-off,
  // the result is averaged over RUNS random choices among the tied characters.
  function targetedAttack(G, count, rnd) {
    const g = betweenness(G);
    const order = g.map((v, i) => i).sort((a, b) => g[b] - g[a]);
    const cut = g[order[count - 1]];
    const eps = 1e-9;
    const sure = order.filter((i) => g[i] > cut + eps);
    const tied = order.filter((i) => Math.abs(g[i] - cut) <= eps);
    const need = count - sure.length;
    if (tied.length === need) return { size: gcWithout(G, [...sure, ...tied]) };
    let sum = 0;
    for (let r = 0; r < RUNS; r++) sum += gcWithout(G, [...sure, ...sample(tied, need, rnd)]);
    return { size: sum / RUNS };
  }

  // Removes 5% of the characters at random, RUNS times, and averages the largest component.
  function randomAttack(G, count, rnd) {
    const all = Array.from({ length: G.n }, (_, i) => i);
    let sum = 0;
    for (let r = 0; r < RUNS; r++) sum += gcWithout(G, sample(all, count, rnd));
    return { size: sum / RUNS };
  }

  // ---------- assortativity (inside the largest component) ----------

  // Newman's degree assortativity: Pearson correlation of the degrees at the two ends of each link
  function assortativity(G, comp) {
    const inComp = new Uint8Array(G.n);
    comp.forEach((v) => (inComp[v] = 1));
    let L = 0, sjk = 0, sHalf = 0, sSq = 0;
    for (const u of comp)
      for (const v of G.adj[u]) {
        if (v < u || !inComp[v]) continue;
        const j = G.deg[u], k = G.deg[v];
        L++;
        sjk += j * k;
        sHalf += (j + k) / 2;
        sSq += (j * j + k * k) / 2;
      }
    if (!L) return null;
    const mean = sHalf / L;
    const den = sSq / L - mean * mean;
    if (den < 1e-12) return null; // every character has the same degree: undefined
    return (sjk / L - mean * mean) / den;
  }

  // average degree of the neighbours of characters with degree k (fig. 3 of the paper)
  function knn(G, comp) {
    const by = new Map();
    for (const u of comp) {
      const k = G.deg[u];
      if (k < 1) continue;
      let s = 0;
      for (const v of G.adj[u]) s += G.deg[v];
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(s / k);
    }
    return [...by.entries()]
      .map(([k, vs]) => ({ k, value: vs.reduce((a, b) => a + b, 0) / vs.length, count: vs.length }))
      .sort((a, b) => a.k - b.k);
  }

  // ======================================================================
  // everything at once
  // ======================================================================

  MN.computeMetrics = function (graph) {
    const nodes = [...graph.nodes].sort();
    const G = makeGraph(nodes, graph.edges);
    const N = G.n;
    const out = { N: N || null };
    if (!N) return Object.assign(out, { empty: true, missing: [] });

    const signature = nodes.join(',') + '#' + graph.edges.map((e) => e.id || e.source + '|' + e.target).sort().join(',');
    const rnd = seededRandom(signature);

    const avgK = (2 * G.m) / N;
    out.avgK = avgK;

    const comp = largestComponent(G);
    const p = paths(G, comp);
    out.diameter = p.diameter;
    out.avgPath = p.avgPath;
    out.lRand = avgK > 1 && N > 1 ? Math.log(N) / Math.log(avgK) : null;

    const Ci = clusteringPerNode(G);
    out.C = Ci.reduce((a, b) => a + b, 0) / N;
    out.CRand = avgK / N;
    out.hier = hierarchy(G, Ci);

    out.fit = degreeFit(G);

    out.gc = { size: comp.length, pct: (100 * comp.length) / N };

    const count = Math.ceil(ATTACK_SHARE * N);
    if (N >= 3 && G.m > 0 && count < N) {
      const t = targetedAttack(G, count, rnd);
      const r = randomAttack(G, count, rnd);
      out.targeted = { size: t.size, pct: (100 * t.size) / N, from: out.gc.pct };
      out.random = { size: r.size, pct: (100 * r.size) / N, from: out.gc.pct };
    } else {
      out.targeted = out.random = null;
    }

    out.r = assortativity(G, comp);
    out.knn = knn(G, comp);

    // values in the tree that could not be calculated
    out.missing = ['avgK', 'diameter', 'avgPath', 'lRand', 'C', 'CRand', 'fit', 'targeted', 'random', 'r'].filter((k) => out[k] == null);
    return out;
  };

  // exposed for testing
  MN._metricsInternals = { makeGraph, betweenness, degreeFit, assortativity, largestComponent };

  // ======================================================================
  // the [measurements] tree: labels and hover texts
  //   gc: shows "(only for largest component)"; desc: a sentence or two; tex: LaTeX formula
  // ======================================================================

  MN.MEASURE_TREE = [
    {
      group: 'basic network',
      items: [
        {
          key: 'N',
          label: 'number of nodes',
          desc: 'The number of characters currently shown, including those with no co-stars.',
          tex: 'N',
        },
        {
          key: 'avgK',
          label: 'average degree (⟨k⟩)',
          desc: 'The average number of co-stars each character has. Two characters who share at least one movie form one link; L is the total number of links.',
          tex: '\\langle k \\rangle = \\frac{2L}{N}',
        },
        {
          key: 'diameter',
          label: 'diameter (ℓ<sub>max</sub>)',
          gc: true,
          desc: 'The longest of all shortest paths: how many links you have to walk to get between the two characters who are furthest apart.',
          tex: '\\ell_{max} = \\max_{i,j}\\, d_{ij}',
        },
      ],
    },
    {
      group: 'small world measurements',
      items: [
        {
          key: 'avgPath',
          label: 'average path length (ℓ)',
          gc: true,
          desc: 'The average number of links separating two characters along the shortest route between them. N<sub>c</sub> is the number of characters in the largest component and d<sub>ij</sub> the number of links on the shortest path from i to j.',
          tex: '\\ell = \\frac{1}{N_c(N_c-1)} \\sum_{i \\neq j} d_{ij}',
        },
        {
          key: 'lRand',
          label: 'random path length (ℓ<sub>rand</sub>)',
          desc: 'The average path length expected in a random network with the same number of characters and the same average degree. If ℓ ≈ ℓ<sub>rand</sub>, the network passes the first test for a small world.',
          tex: '\\ell_{rand} = \\frac{\\ln N}{\\ln \\langle k \\rangle}',
        },
        {
          key: 'C',
          label: 'avg. clustering coefficient (C)',
          desc: 'For each character, the share of pairs of their co-stars who have also appeared together, averaged over all characters. Characters with fewer than two co-stars count as 0.',
          tex: 'C_i = \\frac{2n_i}{k_i(k_i-1)}, \\qquad C = \\frac{1}{N}\\sum_i C_i',
        },
        {
          key: 'CRand',
          label: 'random clustering coefficient (C<sub>rand</sub>)',
          desc: 'The clustering expected in a random network with the same number of characters and the same average degree. If C ≫ C<sub>rand</sub> and ℓ ≈ ℓ<sub>rand</sub>, the network is a small world.',
          tex: 'C_{rand} = \\frac{\\langle k \\rangle}{N}',
        },
      ],
    },
    {
      group: 'hierarchical clustering',
      items: [
        {
          plot: 'hier',
          label: 'click to open plot',
          desc: 'For each number of co-stars k, the average clustering of the characters with that many co-stars, on log–log axes. In a hierarchical network, characters with few co-stars sit in tight groups and the well-connected characters link those groups together, so the points fall roughly along the dashed 1/k line.',
          tex: '\\bar{C}(k) \\sim \\frac{1}{k}',
        },
      ],
    },
    {
      group: 'degree distribution',
      items: [
        {
          key: 'fitModel',
          label: 'best fit model',
          desc: 'Which curve best describes how co-stars are spread among characters. Each model is fitted to P(k), the share of characters with at least k co-stars, and the one with the lowest χ²/df is chosen.',
          tex: '\\begin{gathered}\\text{power law: } P(k) \\sim k^{1-\\gamma} \\\\ \\text{truncated: } P(k) \\sim k^{1-\\tau} e^{-k/k^*} \\\\ \\text{exponential: } P(k) \\sim e^{-k/\\kappa}\\end{gathered}',
        },
        {
          key: 'fitParams',
          label: 'estimated parameters',
          desc: 'The values of the winning curve, with their uncertainty and the quality of the fit (χ²/df, closer to 0 is better). For a power law, a γ between 2 and 3 means the network is scale free.',
          tex: '\\text{scale free: } 2 < \\gamma \\le 3',
        },
      ],
    },
    {
      group: 'largest component',
      items: [
        {
          key: 'gcSize',
          label: 'size',
          desc: 'The number of characters in the largest connected group, where every character can reach every other through a chain of co-stars, and its share of all characters shown.',
          tex: 'G_c, \\qquad \\frac{G_c}{N} \\times 100\\%',
        },
      ],
    },
    {
      group: 'targeted attacks',
      items: [
        {
          key: 'targeted',
          label: 'largest component decreases to',
          desc: 'What happens if the most important characters disappear. Betweenness centrality g<sub>l</sub> counts how many shortest paths between other characters pass through character l. It is calculated once, the top 5% of characters (rounded up) are removed, and the largest component is measured again.',
          tex: 'g_l = \\frac{2}{(N-1)(N-2)} \\sum_{i<j} \\frac{\\sigma_l(i,j)}{\\sigma(i,j)}',
        },
      ],
    },
    {
      group: 'random attacks',
      items: [
        {
          key: 'random',
          label: 'largest component decreases to',
          desc: 'What happens if characters disappear by chance. 5% of characters (rounded up) are removed at random and the largest component is measured. This is repeated 500 times and averaged.',
          tex: '\\langle G_c \\rangle = \\frac{1}{500}\\sum_{s=1}^{500} G_c^{(s)}',
        },
      ],
    },
    {
      group: 'assortativity',
      items: [
        {
          key: 'r',
          label: 'assortativity coefficient (r)',
          gc: true,
          desc: 'Do well-connected characters tend to appear with other well-connected characters? r is the correlation between the numbers of co-stars at the two ends of every link. Positive means assortative, which is typical of real social networks. Negative means disassortative: the hubs mostly link to minor characters, which is typical of fiction.',
        },
        {
          plot: 'knn',
          label: 'click to open plot',
          gc: true,
          desc: 'For each number of co-stars k, the average number of co-stars of those characters’ neighbours. A rising trend means assortative; a falling trend means disassortative.',
        },
      ],
    },
  ];

  // text shown after each label
  MN.formatMeasure = function (key, v) {
    const dash = '—';
    const num = (x, d = 2) => (x == null || !isFinite(x) ? dash : x.toFixed(d));
    const amount = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
    switch (key) {
      case 'N':
        return v.N == null ? dash : String(v.N);
      case 'diameter':
        return v.diameter == null ? dash : String(v.diameter);
      case 'avgK': case 'avgPath': case 'lRand': case 'C': case 'CRand': case 'r':
        return num(v[key]);
      case 'fitModel':
        return v.fit ? v.fit.model : dash;
      case 'fitParams':
        if (!v.fit) return dash;
        return (
          v.fit.params.map((p) => `${p.name} = ${p.value.toFixed(2)} ± ${p.err.toFixed(2)}`).join(', ') +
          ` (χ²/df = ${v.fit.chi2df.toFixed(2)})`
        );
      case 'gcSize':
        return v.gc ? `${v.gc.size} (${v.gc.pct.toFixed(1)}%)` : dash;
      case 'targeted': case 'random': {
        const a = v[key];
        return a ? `${amount(a.size)} (${a.pct.toFixed(1)}% of N, from ${a.from.toFixed(1)}%)` : dash;
      }
    }
    return dash;
  };
})();
