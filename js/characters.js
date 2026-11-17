/* Characters and movies page: a grid of every character (hover = their movies),
   then every movie with its characters, in the same card style as the network page. */
(async function () {
  const D = await MN.loadData();
  const facesEl = document.getElementById('faces');
  const moviesEl = document.getElementById('movies');
  const tip = document.getElementById('tip');

  // ---------- hover box (same look as on the network page) ----------
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.classList.add('show');
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
  const hideTip = () => tip.classList.remove('show');

  // ---------- characters grid (alphabetical by name) ----------
  const chars = [...D.chars].sort((a, b) => a.name.localeCompare(b.name));
  facesEl.innerHTML = chars
    .map((c) => {
      const alias = c.alias && c.alias.trim().toLowerCase() !== c.name.trim().toLowerCase() ? c.alias : '';
      return `<div class="face" data-id="${MN.esc(c.id)}">
        <img src="${MN.esc(MN.faceUrl(c))}" alt="${MN.esc(MN.displayName(c))}" loading="lazy">
        <div class="fname">${MN.esc(c.name)}</div>
        ${alias ? `<div class="falias">(${MN.esc(alias)})</div>` : ''}
      </div>`;
    })
    .join('');
  facesEl.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => {
      const c = D.charsById.get(img.closest('.face').dataset.id);
      const full = MN.fullImageUrl(c);
      if (img.getAttribute('src') !== full) img.setAttribute('src', full);
    }, { once: true });
  });

  facesEl.addEventListener('mouseover', (ev) => {
    const face = ev.target.closest('.face');
    if (!face) return;
    const c = D.charsById.get(face.dataset.id);
    const movies = D.charMovies.get(c.id).map((mid) => D.moviesById.get(mid));
    const lines = movies.length
      ? movies.map((m) => `<div class="movie-line">${MN.esc(m.title)} (${m.year})</div>`).join('')
      : '<div>(no movies)</div>';
    const img = face.querySelector('img').getBoundingClientRect();
    showTip(`<div class="tip-name"><b>${MN.esc(MN.displayName(c))}</b></div>${lines}`, img.left + img.width / 2, img.top - 1);
  });
  facesEl.addEventListener('mouseout', (ev) => {
    const face = ev.target.closest('.face');
    if (face && !face.contains(ev.relatedTarget)) hideTip();
  });
  window.addEventListener('scroll', hideTip, { passive: true });

  // ---------- movies with their characters (release order) ----------
  moviesEl.innerHTML = D.movies
    .map((m) => {
      const tags = D.cast
        .get(m.id)
        .map((cid) => `<span class="tag">${MN.esc(MN.displayName(D.charsById.get(cid)))}</span>`)
        .join('');
      return `<div class="movie-box">
        <div class="title">${MN.esc(m.title)}</div>
        <div class="date">${MN.fmtDate(m.date)} · phase ${m.phase}</div>
        <div class="tags">${tags || '<span class="empty-note">(no characters)</span>'}</div>
      </div>`;
    })
    .join('');
})();
