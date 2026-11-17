/* Network page: graph, timeline, measurements and editing mode. */
(async function () {
  const D = await MN.loadData();
  let st = MN.freshState(D);
  let current = null; // derived network currently on screen (full state)
  let shownGraph = null; // graph actually drawn (differs from `current` during play)
  let editingMovie = null;
  let playTimers = [];

  const R = 20; // node radius
  const EXT_ICON =
    '<svg class="ext" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M5 2H2v8h8V7"/><path d="M7 1.5h3.5V5"/><path d="M10.5 1.5 5.5 6.5"/></svg>';

  // ======================================================================
  // hover boxes
  // ======================================================================
  const tip = document.getElementById('tip');
  let hideTimer = null;

  function showTip(html, x, y, url) {
    clearTimeout(hideTimer);
    tip.innerHTML = html;
    tip.classList.add('show');
    tip.classList.toggle('clickable', !!url);
    tip.onclick = url ? () => window.open(url, '_blank', 'noopener') : null;
    tip.style.left = '0px';
    tip.style.top = '0px';
    const b = tip.getBoundingClientRect();
    const gap = 11;
    const above = y - b.height - gap >= 4;
    const top = above ? y - b.height - gap : y + gap;
    const left = Math.max(6, Math.min(window.innerWidth - b.width - 6, x - b.width / 2));
    tip.classList.toggle('below', !above);
    tip.style.setProperty('--px', Math.max(12, Math.min(b.width - 12, x - left)) + 'px');
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function hideTipSoon(ms = 220) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => tip.classList.remove('show'), ms);
  }
  function hideTipNow() {
    clearTimeout(hideTimer);
    tip.classList.remove('show');
  }
  tip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  tip.addEventListener('mouseleave', () => hideTipSoon(120));

  // ======================================================================
  // graph
  // ======================================================================
  const area = document.getElementById('graph-area');
  const svg = d3.select('#graph');
  svg.append('defs')
    .append('clipPath')
    .attr('id', 'face-clip')
    .attr('clipPathUnits', 'objectBoundingBox')
    .append('circle')
    .attr('cx', 0.5)
    .attr('cy', 0.5)
    .attr('r', 0.5);
  const gZoom = svg.append('g');
  const gLinks = gZoom.append('g');
  const gHits = gZoom.append('g');
  const gNodes = gZoom.append('g');

  // zoom: mouse wheel / trackpad, drag the background to move around, or the buttons
  let zt = d3.zoomIdentity;
  const zoom = d3
    .zoom()
    .scaleExtent([0.5, 6])
    .on('zoom', (ev) => {
      zt = ev.transform;
      gZoom.attr('transform', zt);
      if (ev.sourceEvent) hideTipNow();
    });
  svg.call(zoom).on('dblclick.zoom', null);
  document.getElementById('zoom-in').addEventListener('click', () => zoom.scaleBy(svg, 1.5));
  document.getElementById('zoom-out').addEventListener('click', () => zoom.scaleBy(svg, 1 / 1.5));
  document.getElementById('zoom-reset').addEventListener('click', () => zoom.transform(svg, d3.zoomIdentity));

  const nodeObjs = new Map(); // id -> persistent {id, x, y, vx, vy}
  let W = area.clientWidth, H = area.clientHeight;
  let hovered = null;
  const pickedIds = []; // characters selected in [characters add/remove]

  const M = 10; // margin between nodes and the edge of the network area
  const clampX = (x) => Math.max(R + M, Math.min(W - R - M, x));
  const clampY = (y) => Math.max(R + M, Math.min(H - R - M, y));
  // keep nodes off the zoom / clustering controls (bottom-left)
  const ctrlEl = area.querySelector('.zoom-ctrl');
  const tooFewBox = area.querySelector('.too-few');
  const keepOffControls = (n) => {
    const cw = ctrlEl.offsetLeft + ctrlEl.offsetWidth + R + 6, ct = ctrlEl.offsetTop - R - 6;
    if (n.x < cw && n.y > ct) {
      if (cw - n.x < n.y - ct) n.x = cw; else n.y = ct;
    }
    // and off the "too few characters" message (bottom-right) when it is shown
    if (!tooFewBox.hidden) {
      const fl = tooFewBox.offsetLeft - R - 6, ft = tooFewBox.offsetTop - R - 6;
      if (n.x > fl && n.y > ft) {
        if (n.x - fl < n.y - ft) n.x = fl; else n.y = ft;
      }
    }
  };

  // [clustering] slider: 0 = spread out, 1 = tightly clustered (layout only)
  const linkDistance = (t) => 150 - 110 * t;
  const chargeStrength = (t) => -(420 - 340 * t);
  const clusterInput = document.getElementById('cluster');
  let clusterT = +clusterInput.value / 100;

  const sim = d3
    .forceSimulation()
    .velocityDecay(0.4)
    .alphaDecay(0.045) // settles about twice as fast as d3's default
    .force('link', d3.forceLink().id((d) => d.id).distance(linkDistance(clusterT)))
    .force('charge', d3.forceManyBody().strength(chargeStrength(clusterT)).distanceMax(450))
    .force('collide', d3.forceCollide(R + 7))
    .force('x', d3.forceX(W / 2).strength(0.06))
    .force('y', d3.forceY(H / 2).strength(0.08))
    .on('tick', ticked)
    .stop();

  clusterInput.addEventListener('input', () => {
    clusterT = +clusterInput.value / 100;
    sim.force('link').distance(linkDistance(clusterT));
    sim.force('charge').strength(chargeStrength(clusterT));
    sim.alpha(0.5).restart();
  });

  function ticked() {
    for (const n of sim.nodes()) {
      n.x = clampX(n.x);
      n.y = clampY(n.y);
      if (n.fx == null) keepOffControls(n);
    }
    // an edge shared by several selected phases is split into equal parts, one per phase colour
    gLinks
      .selectAll('line')
      .attr('x1', (d) => d.l.source.x + ((d.l.target.x - d.l.source.x) * d.i) / d.k)
      .attr('y1', (d) => d.l.source.y + ((d.l.target.y - d.l.source.y) * d.i) / d.k)
      .attr('x2', (d) => d.l.source.x + ((d.l.target.x - d.l.source.x) * (d.i + 1)) / d.k)
      .attr('y2', (d) => d.l.source.y + ((d.l.target.y - d.l.source.y) * (d.i + 1)) / d.k);
    gHits.selectAll('line').attr('x1', (d) => d.source.x).attr('y1', (d) => d.source.y).attr('x2', (d) => d.target.x).attr('y2', (d) => d.target.y);
    gNodes.selectAll('g.node').attr('transform', (d) => `translate(${d.x},${d.y})`);
  }

  // Draws a graph. Existing nodes keep their positions; new ones start near their neighbours.
  function draw(graph, { alpha = 0.25, settle = false, frozen = false } = {}) {
    shownGraph = graph;
    const onScreen = new Set(sim.nodes().map((n) => n.id));
    const nodes = graph.nodes.map((id) => {
      let o = nodeObjs.get(id);
      if (!o) nodeObjs.set(id, (o = { id }));
      if (!onScreen.has(id) && !frozen) {
        const nb = [...(graph.neighbors.get(id) || [])].map((x) => nodeObjs.get(x)).filter((p) => p && onScreen.has(p.id));
        if (nb.length) {
          o.x = d3.mean(nb, (p) => p.x) + (Math.random() - 0.5) * 50;
          o.y = d3.mean(nb, (p) => p.y) + (Math.random() - 0.5) * 50;
        } else if (o.x == null) {
          o.x = W / 2 + (Math.random() - 0.5) * W * 0.6;
          o.y = H / 2 + (Math.random() - 0.5) * H * 0.6;
        }
        o.vx = o.vy = 0;
      }
      o.x = clampX(o.x);
      o.y = clampY(o.y);
      return o;
    });
    const links = graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, movies: e.movies, colors: MN.edgeColors(D, st, e) }));

    gLinks
      .selectAll('g.link-g')
      .data(links, (d) => d.id)
      .join('g')
      .attr('class', 'link-g')
      .selectAll('line')
      .data((d) => d.colors.map((c, i) => ({ l: d, i, k: d.colors.length, c })))
      .join('line')
      .attr('class', 'link')
      .attr('stroke', (d) => d.c)
      .attr('stroke-width', MN.EDGE_WIDTH);

    gHits
      .selectAll('line')
      .data(links, (d) => d.id)
      .join('line')
      .attr('class', 'link-hit')
      .on('mouseenter mousemove', (ev, d) => {
        if (dragging) return;
        const lines = d.movies
          .map((mid) => D.moviesById.get(mid))
          .map((m) => `<div class="movie-line">${MN.esc(m.title)} (${m.year})</div>`)
          .join('');
        showTip(lines, ev.clientX, ev.clientY - 2);
      })
      .on('mouseleave', () => hideTipSoon(80));

    const sel = gNodes
      .selectAll('g.node')
      .data(nodes, (d) => d.id)
      .join((enter) => {
        const g = enter.append('g').attr('class', 'node');
        g.append('circle').attr('class', 'node-ring').attr('r', R);
        g.append('image')
          .attr('x', -R)
          .attr('y', -R)
          .attr('width', 2 * R)
          .attr('height', 2 * R)
          .attr('clip-path', 'url(#face-clip)')
          .attr('href', (d) => MN.faceUrl(D.charsById.get(d.id)))
          .on('error', function (ev, d) {
            const full = MN.fullImageUrl(D.charsById.get(d.id));
            if (this.getAttribute('href') !== full) this.setAttribute('href', full);
          });
        g.append('circle').attr('class', 'node-ring').attr('r', R).attr('fill', 'none').style('fill', 'none');
        g.append('circle').attr('class', 'pick-ring').attr('r', R + 3);
        return g;
      });

    sel.on('mouseenter', (ev, d) => {
      if (dragging) return;
      hovered = d.id;
      applyHighlight();
      const c = D.charsById.get(d.id);
      const box = area.getBoundingClientRect();
      showTip(
        `<span class="tip-name">${MN.esc(MN.displayName(c))}</span>${EXT_ICON}`,
        box.left + zt.applyX(d.x),
        box.top + zt.applyY(d.y) - R * zt.k - 1,
        c.url
      );
    })
      .on('click', (ev, d) => {
        if (ev.defaultPrevented) return; // was a drag
        charSearch.pickFromNetwork(d.id);
      })
      .on('mouseleave', () => {
        hovered = null;
        applyHighlight();
        hideTipSoon();
      })
      .call(dragBehaviour)
      .classed('picked', (d) => pickedIds.includes(d.id));

    sim.nodes(nodes);
    sim.force('link').links(links);
    if (frozen) {
      sim.stop();
      ticked();
    } else if (settle) {
      sim.alpha(1);
      for (let i = 0; i < 320; i++) sim.tick();
      sim.stop();
      ticked();
    } else {
      sim.alpha(alpha).restart();
    }
    applyHighlight();
  }

  function applyHighlight() {
    if (!hovered || !shownGraph || !shownGraph.neighbors.has(hovered)) {
      gNodes.selectAll('g.node').classed('faded', false);
      gLinks.selectAll('line').classed('faded', false);
      return;
    }
    const keep = new Set([hovered, ...shownGraph.neighbors.get(hovered)]);
    gNodes.selectAll('g.node').classed('faded', (d) => !keep.has(d.id));
    gLinks.selectAll('line').classed('faded', (d) => d.l.source.id !== hovered && d.l.target.id !== hovered);
  }

  let dragging = false;
  const dragBehaviour = d3
    .drag()
    .on('start', (ev, d) => {
      dragging = true;
      hideTipNow();
      if (!ev.active) sim.alphaTarget(0.15).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on('drag', (ev, d) => {
      d.fx = clampX(ev.x);
      d.fy = clampY(ev.y);
    })
    .on('end', (ev, d) => {
      dragging = false;
      if (!ev.active) sim.alphaTarget(0);
      d.x = d.fx;
      d.y = d.fy;
      d.fx = null;
      d.fy = null;
    });

  new ResizeObserver(() => {
    const nw = area.clientWidth, nh = area.clientHeight;
    if (!nw || !nh || (nw === W && nh === H)) return;
    W = nw;
    H = nh;
    sim.force('x').x(W / 2);
    sim.force('y').y(H / 2);
    for (const n of sim.nodes()) { n.x = clampX(n.x); n.y = clampY(n.y); }
    ticked();
    sim.alpha(0.1).restart();
    drawSlider();
  }).observe(area);

  // ======================================================================
  // timeline
  // ======================================================================
  const slider = d3.select('#slider');
  const SP = 14; // horizontal padding inside the slider
  const yearX = (y) => {
    const w = slider.node().clientWidth;
    return SP + ((y - D.minYear) / Math.max(1, D.maxYear - D.minYear)) * (w - 2 * SP);
  };
  const xYear = (x) => {
    const w = slider.node().clientWidth;
    const t = (x - SP) / (w - 2 * SP);
    return Math.max(D.minYear, Math.min(D.maxYear, Math.round(D.minYear + t * (D.maxYear - D.minYear))));
  };
  const starPath = (() => {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 4.4 : 10.5, a = (Math.PI / 5) * i - Math.PI / 2;
      pts.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return 'M' + pts.map((p) => p.map((v) => v.toFixed(2)).join(',')).join('L') + 'Z';
  })();

  slider.append('defs').html(
    '<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#000" stroke-width="1"/></pattern>'
  );
  const TRACK_Y = 20, TRACK_H = 10;
  const sTrack = slider.append('rect').attr('y', TRACK_Y).attr('height', TRACK_H).attr('fill', '#fff').attr('stroke', '#000').attr('stroke-width', 1).attr('shape-rendering', 'crispEdges');
  const sHatch = slider.append('rect').attr('y', TRACK_Y).attr('height', TRACK_H).attr('fill', 'url(#hatch)').attr('stroke', '#000').attr('stroke-width', 1).attr('shape-rendering', 'crispEdges');
  const sMin = slider.append('text').attr('y', 50).text(D.minYear);
  const sMax = slider.append('text').attr('y', 50).attr('text-anchor', 'end').text(D.maxYear);
  const sYear0 = slider.append('text').attr('y', 9).attr('text-anchor', 'middle');
  const sYear1 = slider.append('text').attr('y', 9).attr('text-anchor', 'middle');
  const blue = slider.append('path').attr('class', 'star').attr('d', starPath).attr('fill', '#0000EE');
  const red = slider.append('path').attr('class', 'star').attr('d', starPath).attr('fill', '#E00000');

  function drawSlider() {
    const w = slider.node().clientWidth;
    sTrack.attr('x', SP).attr('width', Math.max(0, w - 2 * SP));
    sMin.attr('x', SP - 6);
    sMax.attr('x', w - SP + 6);
    const x0 = yearX(st.y0), x1 = yearX(st.y1);
    sHatch.attr('x', x0).attr('width', Math.max(0, x1 - x0));
    blue.attr('transform', `translate(${x0},${TRACK_Y + TRACK_H / 2})`);
    red.attr('transform', `translate(${x1},${TRACK_Y + TRACK_H / 2})`);
    // year above each star (hidden at the ends, where the 2008 / 2026 labels already show it)
    const lab = (y) => (y === D.minYear || y === D.maxYear ? '' : y);
    if (st.y0 === st.y1) {
      sYear0.attr('x', x0).text(st.y0);
      sYear1.text('');
    } else {
      const close = x1 - x0 < 44;
      sYear0.attr('x', x0 - (close ? 18 : 0)).text(lab(st.y0));
      sYear1.attr('x', x1 + (close ? 18 : 0)).text(lab(st.y1));
    }
  }

  // drag the stars
  let dragStar = null, dragStartX = 0;
  slider.on('pointerdown', (ev) => {
    const [x] = d3.pointer(ev);
    const x0 = yearX(st.y0), x1 = yearX(st.y1);
    const d0 = Math.abs(x - x0), d1 = Math.abs(x - x1);
    if (Math.min(d0, d1) > 16) return;
    dragStar = d0 === d1 ? 'tie' : d0 < d1 ? 'blue' : 'red';
    dragStartX = x;
    slider.node().setPointerCapture(ev.pointerId);
  });
  slider.on('pointermove', (ev) => {
    if (!dragStar) return;
    const [x] = d3.pointer(ev);
    if (dragStar === 'tie') {
      if (Math.abs(x - dragStartX) < 2) return;
      dragStar = x < dragStartX ? 'blue' : 'red';
    }
    const y = xYear(x);
    let y0 = st.y0, y1 = st.y1;
    if (dragStar === 'blue') y0 = Math.min(y, st.y1);
    else y1 = Math.max(y, st.y0);
    if (y0 !== st.y0 || y1 !== st.y1 || st.phases.size) {
      st.y0 = y0;
      st.y1 = y1;
      st.phases = new Set(); // moving a star clears the phases
      st.colored = false;
      update();
    }
  });
  const endStarDrag = () => (dragStar = null);
  slider.on('pointerup', endStarDrag).on('pointercancel', endStarDrag);

  // phases: each click adds a phase on top of the ones shown (edges in the phase colour);
  // clicking a shown phase again takes it away. When the colours were dropped (by [clear],
  // [reset] or adding / removing a movie), a click starts a new selection with that phase.
  const phasesEl = document.getElementById('phases');
  phasesEl.innerHTML = D.phases.map((p) => `<button class="tbtn" data-phase="${p}">[${p}]</button>`).join('');
  phasesEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-phase]');
    if (!b) return;
    const p = +b.dataset.phase;
    if (!st.colored || !st.phases.size) {
      st.phases = new Set([p]);
      st.colored = true;
    } else if (st.phases.has(p)) {
      st.phases.delete(p);
    } else {
      st.phases.add(p);
    }
    st.cleared = false;
    if (st.phases.size) {
      const ys = D.movies.filter((m) => st.phases.has(m.phase)).map((m) => m.year);
      st.y0 = Math.min(...ys);
      st.y1 = Math.max(...ys);
    } else {
      st.colored = false;
      st.y0 = D.minYear;
      st.y1 = D.maxYear;
    }
    update();
  });

  // play
  document.getElementById('play').addEventListener('click', play);
  function stopPlay() {
    playTimers.forEach(clearTimeout);
    playTimers = [];
  }
  function play() {
    stopPlay();
    hideTipNow();
    const full = MN.derive(D, st);
    const empty = { nodes: [], edges: [], neighbors: new Map() };
    draw(empty);
    renderMetrics(empty);
    const frames = full.active.map((_, k) => {
      if (k === full.active.length - 1) return full;
      return MN.buildGraph(D, full.active.slice(0, k + 1), full.castOf);
    });
    if (!frames.length) frames.push(full);
    frames.forEach((g, k) => {
      playTimers.push(
        setTimeout(() => {
          draw(g, { alpha: 0.2 });
          renderMetrics(g);
          if (k === frames.length - 1) playTimers = [];
        }, 200 + k * 450)
      );
    });
  }

  // reset timeline: whole range, full network
  document.getElementById('treset').addEventListener('click', () => {
    st.y0 = D.minYear;
    st.y1 = D.maxYear;
    st.phases = new Set();
    st.colored = false;
    MN.clearEdits(st);
    editingMovie = null;
    update();
  });

  // ======================================================================
  // measurements
  // ======================================================================
  const measuresEl = document.getElementById('measures');
  const spinEl = document.getElementById('m-spin');
  const tooFewEl = document.getElementById('too-few');
  let lastVals = null;

  // formulas: KaTeX (bundled in js/vendor/katex), rendered once and cached
  const texCache = new Map();
  function tex(src) {
    if (!texCache.has(src)) {
      let html;
      try {
        html = window.katex ? katex.renderToString(src, { displayMode: true, throwOnError: false }) : MN.esc(src);
      } catch (e) {
        html = MN.esc(src);
      }
      texCache.set(src, html);
    }
    return texCache.get(src);
  }

  measuresEl.innerHTML = MN.MEASURE_TREE.map(
    (g, gi) =>
      `<li><span class="glabel">${g.group}</span><ul>${g.items
        .map((it, ii) =>
          it.plot
            ? `<li><button class="tbtn label" data-g="${gi}" data-i="${ii}" data-plot="${it.plot}">[${it.label}]</button></li>`
            : `<li><span class="label" data-g="${gi}" data-i="${ii}">${it.label}</span>: <span class="val" data-key="${it.key}">—</span></li>`
        )
        .join('')}</ul></li>`
  ).join('');

  measuresEl.querySelectorAll('.label').forEach((el) => {
    el.addEventListener('mouseenter', () => {
      const it = MN.MEASURE_TREE[+el.dataset.g].items[+el.dataset.i];
      const r = el.getBoundingClientRect();
      const html =
        '<div class="mtip">' +
        (it.gc ? '<div class="tip-note">(only for largest component)</div>' : '') +
        `<div>${it.desc}</div>` +
        (it.tex ? `<div class="formula">${tex(it.tex)}</div>` : '') +
        '</div>';
      showTip(html, r.left + Math.min(r.width / 2, 40), r.top - 1);
    });
    el.addEventListener('mouseleave', () => hideTipSoon(60));
  });
  measuresEl.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-plot]');
    if (b) {
      hideTipNow();
      openPlot(b.dataset.plot);
    }
  });

  // The measurements are calculated just after the network is drawn, with a small
  // spinner next to [measurements] while they run. Older requests are dropped.
  let metricsToken = 0;
  function renderMetrics(graph) {
    renderRanking(graph);
    const token = ++metricsToken;
    spinEl.hidden = false;
    setTimeout(() => {
      if (token !== metricsToken) return;
      let vals;
      try {
        vals = MN.computeMetrics(graph);
      } catch (e) {
        console.error(e);
        vals = { missing: [] };
      }
      if (token !== metricsToken) return;
      lastVals = vals;
      measuresEl.querySelectorAll('.val[data-key]').forEach((el) => {
        el.textContent = MN.formatMeasure(el.dataset.key, vals);
      });
      tooFewEl.hidden = !(vals.N && vals.missing.length);
      spinEl.hidden = true;
      if (!modal.hidden && modal.dataset.plot) openPlot(modal.dataset.plot); // keep an open plot up to date
    }, 30);
  }

  // ======================================================================
  // pop-ups: the two plots and the paper's summary table
  // ======================================================================
  const modal = document.getElementById('modal');
  const modalBody = document.getElementById('modal-body');
  function openModal(html, plot, wide) {
    modalBody.innerHTML = html;
    modal.dataset.plot = plot || '';
    modal.querySelector('.modal').classList.toggle('wide', !!wide);
    modal.hidden = false;
  }
  function closeModal() {
    modal.hidden = true;
    modal.dataset.plot = '';
  }
  document.getElementById('modal-x').addEventListener('click', closeModal);
  modal.addEventListener('mousedown', (ev) => { if (ev.target === modal) closeModal(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !modal.hidden) closeModal(); });

  const PLOTS = {
    hier: {
      title: 'mean clustering coefficient per degree, C̄(k), vs k',
      ylabel: 'C̄(k)',
      gc: false,
      note:
        'What to look for: do the points go down as k grows, roughly parallel to the dashed line? If so, the network is hierarchical. This is a visual check only, as in the paper. Characters with fewer than 2 co-stars (and degrees whose average clustering is 0) are left out, because a log scale can’t show 0.',
      points: (v) => (v.hier || []).filter((p) => p.value > 0),
      guide: () => (k) => 1 / k, // the power law 1/k
    },
    knn: {
      title: 'average degree of the neighbours, k<sub>nn</sub>, vs k',
      ylabel: 'k<tspan baseline-shift="sub" font-size="9">nn</tspan>(k)',
      gc: true,
      note:
        'What to look for: does the dashed trend line go up or down? Going up means characters with many co-stars tend to appear with other well-connected characters (assortative). Going down means the network is disassortative.',
      points: (v) => (v.knn || []).filter((p) => p.value > 0),
      guide: (pts) => {
        // least-squares trend line on the log–log plot
        const xs = pts.map((p) => Math.log(p.k)), ys = pts.map((p) => Math.log(p.value));
        const mx = d3.mean(xs), my = d3.mean(ys);
        const sxx = d3.sum(xs, (x) => (x - mx) ** 2);
        if (sxx === 0) return null;
        const b = d3.sum(xs, (x, i) => (x - mx) * (ys[i] - my)) / sxx;
        return (k) => Math.exp(my + b * (Math.log(k) - mx));
      },
    },
  };

  function openPlot(kind) {
    const P = PLOTS[kind];
    const v = lastVals || {};
    const pts = P.points(v);
    let html = `<div class="modal-title">${P.title}</div>`;
    html += P.gc ? '<div class="tip-note">(only for largest component)</div>' : '';
    html += `<div class="modal-note">${P.note}</div>`;
    if (pts.length < 2) {
      html += '<div class="modal-empty">this network has too few characters to draw this plot</div>';
      openModal(html, kind);
      return;
    }
    html += '<svg class="plot" id="plot-svg"></svg>';
    openModal(html, kind);

    const Wd = 560, Ht = 360, m = { t: 14, r: 18, b: 44, l: 58 };
    const svgP = d3.select('#plot-svg').attr('viewBox', `0 0 ${Wd} ${Ht}`).attr('width', Wd).attr('height', Ht);
    const guide = P.guide(pts);
    const kMin = d3.min(pts, (p) => p.k), kMax = d3.max(pts, (p) => p.k);
    const k0 = kMin / 1.3, k1 = kMax * 1.3;
    let ys = pts.map((p) => p.value);
    if (guide) ys = ys.concat([guide(k0), guide(k1)]);
    const x = d3.scaleLog().domain([k0, k1]).range([m.l, Wd - m.r]);
    const y = d3.scaleLog().domain([d3.min(ys) / 1.3, d3.max(ys) * 1.3]).range([Ht - m.b, m.t]);
    // log axes: label 1, 2, 5, 10, 20… (every tick when the axis spans less than a factor of 10)
    const fmtFor = (scale) => {
      const [a, b] = scale.domain();
      const all = b / a < 10;
      return (d) => {
        const lead = +d.toExponential().charAt(0);
        return all || lead === 1 || lead === 2 || lead === 5 ? d3.format('~g')(+d.toPrecision(3)) : '';
      };
    };
    svgP.append('g').attr('class', 'axis').attr('transform', `translate(0,${Ht - m.b})`).call(d3.axisBottom(x).ticks(6, fmtFor(x)));
    svgP.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6, fmtFor(y)));
    svgP.append('text').attr('class', 'axis-label').attr('x', (m.l + Wd - m.r) / 2).attr('y', Ht - 8).attr('text-anchor', 'middle').text('k (number of co-stars)');
    svgP.append('text').attr('class', 'axis-label').attr('transform', `translate(16,${(m.t + Ht - m.b) / 2}) rotate(-90)`).attr('text-anchor', 'middle').html(P.ylabel);
    if (guide) {
      const ks = d3.range(0, 41).map((i) => k0 * Math.pow(k1 / k0, i / 40));
      svgP.append('path').attr('class', 'guide').attr('d', d3.line().x((k) => x(k)).y((k) => y(guide(k)))(ks));
    }
    svgP
      .append('g')
      .selectAll('circle')
      .data(pts)
      .join('circle')
      .attr('class', 'pt')
      .attr('cx', (p) => x(p.k))
      .attr('cy', (p) => y(p.value))
      .attr('r', 4)
      .on('mouseenter', (ev, p) => {
        showTip(`k = ${p.k}: ${p.value.toFixed(2)} (${p.count} character${p.count === 1 ? '' : 's'})`, ev.clientX, ev.clientY - 6);
      })
      .on('mouseleave', () => hideTipSoon(60));
  }

  // the paper's table 2, for reference only (no verdict for the network on screen)
  document.getElementById('compare').addEventListener('click', () => {
    const rows = [
      ['Small world', 'Yes', 'Yes', 'Yes'],
      ['Hierarchy', 'Yes', 'Yes', 'Yes'],
      ['p(k)', 'Power law', 'Power law', 'Exp.'],
      ['Scale free', 'Yes', 'Yes', 'No'],
      ['G<sub>c</sub>', '&lt; 90%', '&lt; 90%', '&gt; 90%'],
      ['TA', 'Vulnerable', 'Vulnerable', 'Robust'],
      ['RA', 'Robust', 'Robust', 'Robust'],
      ['Assortative', 'Yes', 'Yes', 'No'],
    ];
    openModal(
      `<div class="modal-title">compare with the paper</div>
      <div class="modal-note">Summary of the properties of real social networks, mythological networks and fictional networks (Marvel comics included), from Mac Carron &amp; Kenna (2012), table 2.</div>
      <table class="paper-table">
        <thead><tr><th></th><th>Social</th><th>Myth (friendly)</th><th>Fiction</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><th>${r[0]}</th>${r.slice(1).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
      <div class="modal-note small">Small world: ℓ ≈ ℓ<sub>rand</sub> and C ≫ C<sub>rand</sub>. Hierarchy: C(k) ∼ 1/k. Scale free: a power-law degree distribution with γ ≤ 3. G<sub>c</sub>: share of the characters in the largest component. TA and RA: resilience to targeted and random attacks.</div>
      <div class="modal-note small">Source: P. Mac Carron and R. Kenna, “Universal properties of mythological networks”, <i>EPL</i> 99, 28002 (2012).</div>`
    );
  });

  // ======================================================================
  // [most connected]: the five highest numbers of connections (co-stars, not movies)
  // ======================================================================
  const rankingEl = document.getElementById('ranking');

  function renderRanking(graph) {
    const byDegree = new Map();
    for (const id of graph.nodes) {
      const k = (graph.neighbors.get(id) || new Set()).size;
      if (!byDegree.has(k)) byDegree.set(k, []);
      byDegree.get(k).push(id);
    }
    const levels = [...byDegree.keys()].sort((a, b) => b - a).slice(0, 5);
    if (!levels.length) {
      rankingEl.innerHTML = '<div class="empty-note">no characters in the network</div>';
      return;
    }
    rankingEl.innerHTML = levels
      .map((k) => {
        const faces = byDegree
          .get(k)
          .map((id) => D.charsById.get(id))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => `<img src="${MN.esc(MN.faceUrl(c))}" data-id="${MN.esc(c.id)}" alt="${MN.esc(MN.displayName(c))}">`)
          .join('');
        return `<div class="rank-box"><span class="rank-num">${MN.numberWords(k)}</span><span class="rank-faces">${faces}</span></div>`;
      })
      .join('');
    rankingEl.querySelectorAll('img').forEach((img) => {
      img.addEventListener('error', () => {
        const full = MN.fullImageUrl(D.charsById.get(img.dataset.id));
        if (img.getAttribute('src') !== full) img.setAttribute('src', full);
      }, { once: true });
    });
  }

  rankingEl.addEventListener('mouseover', (ev) => {
    const img = ev.target.closest('img[data-id]');
    if (!img) return;
    const c = D.charsById.get(img.dataset.id);
    const r = img.getBoundingClientRect();
    showTip(`<span class="tip-name">${MN.esc(MN.displayName(c))}</span>${EXT_ICON}`, r.left + r.width / 2, r.top - 1, c.url);
  });
  rankingEl.addEventListener('mouseout', (ev) => {
    if (ev.target.closest('img[data-id]')) hideTipSoon();
  });

  // ======================================================================
  // editing mode
  // ======================================================================
  document.getElementById('ereset').addEventListener('click', () => {
    MN.clearEdits(st);
    st.colored = false; // [reset] drops the phase colours
    editingMovie = null;
    update();
  });

  document.getElementById('erandom').addEventListener('click', () => {
    // characters of the current period (selected timeline / phase)
    const base = MN.derive(D, Object.assign(MN.deserializeState({}), { y0: st.y0, y1: st.y1, phases: new Set(st.phases) }));
    const pool = d3.shuffle([...base.visible]);
    const N = pool.length;
    if (!N) return;
    const lo = Math.min(N, 5);
    const size = lo + Math.floor(Math.random() * (N - lo + 1));
    const keep = new Set(pool.slice(0, size));
    MN.clearEdits(st);
    pool.forEach((c) => { if (!keep.has(c)) st.removedChars.add(c); });
    editingMovie = null;
    update();
  });

  document.getElementById('eclear').addEventListener('click', () => {
    MN.clearEdits(st);
    st.cleared = true;
    st.phases = new Set(); // [clear] drops the phase colours
    st.colored = false;
    editingMovie = null;
    update();
  });

  const saveBtn = document.getElementById('esave');
  saveBtn.addEventListener('click', () => {
    const positions = {};
    for (const n of sim.nodes()) positions[n.id] = [+(n.x / W).toFixed(4), +(n.y / H).toFixed(4)];
    const num = MN.addSave({ state: MN.serializeState(st), positions, area: [W, H] });
    saveBtn.textContent = num ? `[saved as #${num}]` : '[could not save]';
    setTimeout(() => (saveBtn.textContent = '[save]'), 1800);
  });

  // ---------- search boxes ----------
  function setupSearch(rootId, cfg) {
    const root = document.getElementById(rootId);
    const input = root.querySelector('input');
    const results = root.querySelector('.results');
    const addBtn = root.querySelector('[data-act="add"]');
    const remBtn = root.querySelector('[data-act="remove"]');
    let selIndex = -1;
    let list = [];

    const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

    function exact() {
      const q = norm(input.value);
      return q ? cfg.items().find((it) => norm(cfg.label(it)) === q || cfg.alt(it).some((a) => norm(a) === q)) : null;
    }
    function refreshButtons() {
      const it = exact();
      if (!it) {
        addBtn.disabled = remBtn.disabled = true;
        return;
      }
      const inNet = cfg.inNetwork(it);
      addBtn.disabled = inNet;
      remBtn.disabled = !inNet;
    }
    function renderResults() {
      const q = norm(input.value);
      if (!q) {
        results.classList.remove('open');
        return;
      }
      list = cfg.items().filter((it) => [cfg.label(it), ...cfg.alt(it)].some((s) => norm(s).includes(q)));
      selIndex = -1;
      results.innerHTML = list.length
        ? list
            .map(
              (it, i) =>
                `<div class="result" data-i="${i}"><div class="r1">${MN.esc(cfg.line1(it))}</div><div class="r2">${MN.esc(cfg.line2(it))}</div></div>`
            )
            .join('')
        : '<div class="no-result">no results</div>';
      results.classList.add('open');
    }
    function choose(i) {
      input.value = cfg.label(list[i]);
      results.classList.remove('open');
      refreshButtons();
    }
    input.addEventListener('input', () => {
      renderResults();
      refreshButtons();
    });
    input.addEventListener('focus', () => input.value && renderResults());
    input.addEventListener('keydown', (ev) => {
      const items = results.querySelectorAll('.result');
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (!items.length) return;
        ev.preventDefault();
        selIndex = (selIndex + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle('sel', i === selIndex));
        items[selIndex].scrollIntoView({ block: 'nearest' });
      } else if (ev.key === 'Enter') {
        if (results.classList.contains('open') && list.length) choose(selIndex >= 0 ? selIndex : 0);
      } else if (ev.key === 'Escape') {
        results.classList.remove('open');
      }
    });
    results.addEventListener('mousedown', (ev) => {
      const r = ev.target.closest('.result');
      if (!r) return;
      ev.preventDefault();
      choose(+r.dataset.i);
    });
    input.addEventListener('blur', () => setTimeout(() => results.classList.remove('open'), 100));
    addBtn.addEventListener('click', () => {
      const it = exact();
      if (it) { cfg.add(it); update(); }
    });
    remBtn.addEventListener('click', () => {
      const it = exact();
      if (it) { cfg.remove(it); update(); }
    });
    return { refreshButtons };
  }

  const movieSearch = setupSearch('movie-search', {
    items: () => D.movies,
    label: (m) => m.title,
    alt: () => [],
    line1: (m) => `${m.title} (${m.year})`,
    line2: (m) => D.cast.get(m.id).map((c) => MN.displayName(D.charsById.get(c))).join(', '),
    inNetwork: (m) => current.active.includes(m.id),
    add: (m) => {
      st.colored = false; // adding or removing a movie drops the phase colours
      st.removedMovies.delete(m.id);
      if (!current.base.has(m.id)) st.addedMovies.add(m.id);
    },
    remove: (m) => {
      st.colored = false;
      st.addedMovies.delete(m.id);
      if (current.base.has(m.id)) st.removedMovies.add(m.id);
      if (editingMovie === m.id) editingMovie = null;
    },
  });

  // Characters: several can be selected at once (from the search results or by clicking
  // their picture in the network), then added or removed together.
  const charSearch = (function () {
    const root = document.getElementById('char-search');
    const input = root.querySelector('input');
    const chipsEl = root.querySelector('.chips');
    const results = root.querySelector('.results');
    const addBtn = root.querySelector('[data-act="add"]');
    const remBtn = root.querySelector('[data-act="remove"]');
    const picked = pickedIds; // character ids, in selection order
    let list = [];
    let selIndex = -1;

    const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const inNet = (id) => current.visible.has(id);

    function refresh() {
      chipsEl.innerHTML = picked
        .map((id) => `<span class="chip">${MN.esc(MN.displayName(D.charsById.get(id)))}<span class="x" data-unpick="${id}" title="unselect">×</span></span>`)
        .join('');
      input.placeholder = picked.length ? '' : 'search characters, or click their pictures';
      addBtn.disabled = !picked.some((id) => !inNet(id));
      remBtn.disabled = !picked.some((id) => inNet(id));
      gNodes.selectAll('g.node').classed('picked', (d) => picked.includes(d.id));
    }
    function toggle(id) {
      const i = picked.indexOf(id);
      if (i >= 0) picked.splice(i, 1);
      else picked.push(id);
      refresh();
    }
    function renderResults() {
      const q = norm(input.value);
      if (!q) {
        results.classList.remove('open');
        return;
      }
      list = D.chars.filter((c) => [MN.displayName(c), c.name, c.alias].some((s) => s && norm(s).includes(q)));
      selIndex = -1;
      results.innerHTML = list.length
        ? list
            .map((c, i) => {
              const movies = D.charMovies.get(c.id).map((m) => D.moviesById.get(m).title).join(', ') || '(no movies)';
              const mark = picked.includes(c.id) ? '[x] ' : '[ ] ';
              return `<div class="result" data-i="${i}"><div class="r1">${mark}${MN.esc(MN.displayName(c))}</div><div class="r2">${MN.esc(movies)}</div></div>`;
            })
            .join('')
        : '<div class="no-result">no results</div>';
      results.classList.add('open');
    }
    function choose(i) {
      toggle(list[i].id);
      input.value = '';
      results.classList.remove('open');
      input.focus();
    }

    input.addEventListener('input', renderResults);
    input.addEventListener('focus', () => input.value && renderResults());
    input.addEventListener('blur', () => setTimeout(() => results.classList.remove('open'), 100));
    input.addEventListener('keydown', (ev) => {
      const items = results.querySelectorAll('.result');
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (!items.length) return;
        ev.preventDefault();
        selIndex = (selIndex + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((el, i) => el.classList.toggle('sel', i === selIndex));
        items[selIndex].scrollIntoView({ block: 'nearest' });
      } else if (ev.key === 'Enter') {
        if (results.classList.contains('open') && list.length) choose(selIndex >= 0 ? selIndex : 0);
      } else if (ev.key === 'Escape') {
        results.classList.remove('open');
      } else if (ev.key === 'Backspace' && !input.value && picked.length) {
        picked.pop();
        refresh();
      }
    });
    results.addEventListener('mousedown', (ev) => {
      const r = ev.target.closest('.result');
      if (!r) return;
      ev.preventDefault();
      choose(+r.dataset.i);
    });
    chipsEl.addEventListener('click', (ev) => {
      const x = ev.target.closest('[data-unpick]');
      if (x) toggle(x.dataset.unpick);
    });
    root.querySelector('.chipbox').addEventListener('mousedown', (ev) => {
      if (ev.target.classList.contains('chipbox') || ev.target === chipsEl) {
        ev.preventDefault();
        input.focus();
      }
    });
    addBtn.addEventListener('click', () => {
      for (const id of picked.filter((id) => !inNet(id))) {
        st.removedChars.delete(id);
        st.addedChars.add(id);
      }
      picked.length = 0;
      update();
    });
    remBtn.addEventListener('click', () => {
      for (const id of picked.filter((id) => inNet(id))) {
        st.addedChars.delete(id);
        st.removedChars.add(id);
      }
      picked.length = 0;
      update();
    });

    return {
      refreshButtons: refresh,
      pickFromNetwork(id) {
        toggle(id);
        root.scrollIntoView({ block: 'nearest' });
      },
    };
  })();

  // ---------- (currently shown) ----------
  const shownEl = document.getElementById('shown');

  function renderShown() {
    if (editingMovie && !current.active.includes(editingMovie)) editingMovie = null;
    if (!current.active.length) {
      shownEl.innerHTML = st.cleared
        ? '<div class="empty-note">the network is empty. add movies with [movies add/remove] above.</div>'
        : '<div class="empty-note">no movies in the network</div>';
      return;
    }
    shownEl.innerHTML = current.active
      .map((mid) => {
        const m = D.moviesById.get(mid);
        const ed = editingMovie === mid;
        const on = current.castOf(mid).map((c) => {
          const name = MN.esc(MN.displayName(D.charsById.get(c)));
          return `<span class="tag">${name}${ed ? `<span class="x" data-rm="${c}" title="remove from this movie">×</span>` : ''}</span>`;
        });
        const off = ed
          ? current.removedFrom(mid).map((c) => {
              const name = MN.esc(MN.displayName(D.charsById.get(c)));
              return `<span class="tag off">${name}<span class="x" data-add="${c}" title="put back in this movie">+</span></span>`;
            })
          : [];
        return `<div class="movie-box${ed ? ' editing' : ''}" data-mid="${mid}">
          <div class="title">${MN.esc(m.title)}</div>
          <div class="date">${MN.fmtDate(m.date)}</div>
          ${ed ? '<div class="edit-note">editing: × removes a character from this movie, + puts them back. double click to finish.</div>' : ''}
          <div class="tags">${on.join('') || (ed ? '' : '<span class="empty-note">(no characters)</span>')}${off.join('')}</div>
        </div>`;
      })
      .join('');
  }

  shownEl.addEventListener('dblclick', (ev) => {
    const box = ev.target.closest('.movie-box');
    if (!box) return;
    window.getSelection().removeAllRanges();
    editingMovie = editingMovie === box.dataset.mid ? null : box.dataset.mid;
    renderShown();
  });
  shownEl.addEventListener('click', (ev) => {
    const x = ev.target.closest('.x');
    if (!x) return;
    const mid = x.closest('.movie-box').dataset.mid;
    if (x.dataset.rm) {
      (st.castEdits[mid] = st.castEdits[mid] || new Set()).add(x.dataset.rm);
    } else if (x.dataset.add) {
      st.castEdits[mid].delete(x.dataset.add);
      if (!st.castEdits[mid].size) delete st.castEdits[mid];
    }
    update();
  });

  // ======================================================================
  // update cycle
  // ======================================================================
  function update(opts = {}) {
    stopPlay();
    current = MN.derive(D, st);
    draw(current, opts);
    document.getElementById('empty-net').hidden = current.nodes.length > 0;
    drawSlider();
    phasesEl.querySelectorAll('[data-phase]').forEach((b) => {
      const p = +b.dataset.phase;
      const on = st.colored && st.phases.has(p);
      b.classList.toggle('on', on);
      b.style.color = on ? MN.PHASE_COLORS[p] || '' : '';
    });
    renderMetrics(current);
    movieSearch.refreshButtons();
    charSearch.refreshButtons();
    renderShown();
  }

  // ---------- how to use this website (shown when arriving from the landing page) ----------
  const HOW_TO = [
    ['the network', [
      'Drag a character to move it. Hover over a character to see their name and light up their co-stars; click the name box to open their Wikipedia page.',
      'Hover over a line to see the movies two characters share.',
      'Zoom with the mouse wheel / trackpad or [+] [−]; drag the background to move around; [reset zoom] brings back the whole network.',
      '[clustering] spreads the characters out or pulls them together. It only changes the drawing, not the measurements.',
    ]],
    ['timeline and phases', [
      'Drag the blue star (start) and the red star (end) to choose the years shown.',
      '▷ adds the movies one by one, in release order. ↻ goes back to the whole timeline.',
      'Click a phase [1]–[6] to show it, with its lines in the phase colour. Click more phases to add them on top; a line split in two colours means the pair met in both phases. Click a phase again to take it away.',
      'The colours stay while you edit characters; [clear], [reset] or adding / removing a movie turns them off.',
    ]],
    ['measurements', [
      'All values are for the network on screen.',
      'Hover over any name for a short explanation and the formula.',
      '[click to open plot] opens the hierarchical clustering and assortativity plots; [compare with the paper] opens the paper’s summary table.',
      '— means the network has too few characters for that calculation.',
      '[most connected] shows the characters with the most co-stars; hover over a face to see who it is.',
    ]],
    ['editing mode', [
      '[reset]: all the movies and characters of the chosen years. [random]: a random group of them. [clear]: an empty network to build from scratch. [save]: keeps the network on the saved networks page.',
      'Movies: type a title, pick it from the list, then [add] or [remove].',
      'Characters: type names or click their pictures in the network to select several at once (shown as blue tags; × unselects one), then [add] or [remove] them all together.',
      '(currently shown) lists the movies on screen. Double click a movie to edit its cast: × takes a character out of that movie only, + puts them back. Double click again to finish.',
    ]],
    ['the other pages', [
      'saved networks: your saved networks (in this browser only). Click one to open it again, [delete] to remove it.',
      'characters and movies: every character (hover over a picture to see their movies) and every movie with its characters.',
      'data collection: how the data was gathered, and a download of the data files.',
    ]],
  ];
  function showHowTo() {
    openModal(
      `<div class="modal-title">how to use this website</div>
      <div class="howto">${HOW_TO.map(([h, items]) => `<section><div class="howto-h">${h}</div><ul>${items.map((t) => `<li>${t}</li>`).join('')}</ul></section>`).join('')}</div>`,
      '',
      true
    );
  }

  // ---------- open a saved network (from the Saved networks page) ----------
  const openNum = +new URLSearchParams(location.search).get('open');
  const save = openNum ? MN.readSaves().find((s) => s.num === openNum) : null;
  if (save) {
    st = MN.deserializeState(save.state);
    for (const [id, [fx, fy]] of Object.entries(save.positions || {})) nodeObjs.set(id, { id, x: fx * W, y: fy * H });
    current = MN.derive(D, st);
    const allPlaced = current.nodes.every((id) => nodeObjs.has(id));
    update(allPlaced ? { frozen: true } : { alpha: 0.2 });
    history.replaceState(null, '', location.pathname);
  } else {
    update({ settle: true });
  }
  // the "?" in the menu opens it again (without reloading when already on this page)
  document.querySelector('.help-link').addEventListener('click', (ev) => {
    ev.preventDefault();
    showHowTo();
  });
  if (new URLSearchParams(location.search).has('intro')) {
    showHowTo();
    history.replaceState(null, '', location.pathname);
  }
})();
