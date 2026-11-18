// Likely — frontend (vanilla JS, no build step)

// ---------- Utilities ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString();
const coin = '<i class="coin"></i>';

function ago(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24); if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString();
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e; }
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = msg;
  $('#toasts').append(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 2800);
}

function floater(fromEl, html) {
  const r = fromEl.getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'floater';
  el.innerHTML = html;
  el.style.left = `${r.left + r.width / 2}px`;
  el.style.top = `${r.top - 6}px`;
  document.body.append(el);
  setTimeout(() => el.remove(), 1400);
}

const avatar = (u, size = '') =>
  `<span class="avatar ${size}" style="background:${esc(u.avatar_color)}">${esc((u.display_name || u.username || '?')[0])}</span>`;

const icons = {
  home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="3"/><path d="M3 10h18M16 15h2"/><path d="M6 6V5a2 2 0 0 1 2-2h9"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8M10 20a2 2 0 0 0 4 0"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 21s-8.5-5.1-8.5-11.4A4.6 4.6 0 0 1 12 6.9a4.6 4.6 0 0 1 8.5 2.7C20.5 15.9 12 21 12 21z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13"/></svg>',
};

// ---------- State ----------
const state = {
  me: null,
  sort: 'new',
  posts: new Map(),     // id -> post
  openComments: new Set(),
  composer: { potOn: true, reward: 50, target: 10, duration: 1440 },
  offset: 0,
  hasMore: false,
  feedUser: null,
};

async function loadMe() {
  try { state.me = (await api('/me')).user; } catch { state.me = null; }
  renderChrome();
}

// ---------- Chrome: nav + rail ----------
function navItems() {
  const unread = state.me?.unread || 0;
  return [
    { href: '#/', key: 'home', label: 'Home', icon: icons.home },
    { href: '#/leaderboard', key: 'leaderboard', label: 'Leaderboard', icon: icons.trophy },
    { href: '#/wallet', key: 'wallet', label: 'Wallet', icon: icons.wallet, auth: true },
    { href: '#/notifications', key: 'notifications', label: 'Alerts', icon: icons.bell, auth: true, badge: unread },
    { href: state.me ? `#/u/${state.me.username}` : '#/login', key: 'profile', label: 'Profile', icon: icons.user },
  ];
}

function currentKey() {
  const h = location.hash;
  if (h.startsWith('#/leaderboard')) return 'leaderboard';
  if (h.startsWith('#/wallet')) return 'wallet';
  if (h.startsWith('#/notifications')) return 'notifications';
  if (state.me && h === `#/u/${state.me.username}`) return 'profile';
  if (h === '' || h === '#/' || h === '#') return 'home';
  return '';
}

function renderChrome() {
  const key = currentKey();
  const link = (i) => `<a href="${i.href}" class="${i.key === key ? 'active' : ''}" ${i.auth && !state.me ? 'data-action="need-login"' : ''}>
      ${i.icon}<span class="lbl">${i.label}</span>${i.badge ? `<span class="badge">${i.badge > 99 ? '99+' : i.badge}</span>` : ''}</a>`;
  $('#nav').innerHTML = navItems().map(link).join('') +
    (state.me ? `<a href="#" data-action="logout" class="muted"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3"/></svg><span class="lbl">Log out</span></a>` : '');
  $('#bottom-nav').innerHTML = navItems().map(link).join('');
  renderRail();
}

async function renderRail() {
  const me = state.me;
  const dailyReady = me && Date.now() >= me.daily_ready_at;
  const walletCard = me ? `
    <div class="card wallet-card">
      <div class="label">Your balance</div>
      <div class="amount">${coin}<span>${fmt(me.coins)}</span></div>
      <div class="sub">${me.open_tickets} live ticket${me.open_tickets === 1 ? '' : 's'} waiting for a reveal</div>
      <button class="btn btn-gold btn-block" data-action="daily" ${dailyReady ? '' : 'disabled'}>
        ${dailyReady ? `Claim daily +${me.daily_bonus}` : `Next bonus in ${countdown(me.daily_ready_at)}`}
      </button>
    </div>` : `
    <div class="card card-pad">
      <h3>Every like is a ticket 🎟️</h3>
      <p class="muted" style="margin:0 0 14px;font-size:14px">Join free and get <b>500 coins</b>. Like posts with a pot for a chance to win them.</p>
      <button class="btn btn-primary btn-block" data-action="need-login">Join Likely</button>
    </div>`;

  $('#rail').innerHTML = walletCard + `
    <div class="card card-pad how">
      <h3>How it works</h3>
      <ol>
        <li>Posters lock a <b>coin pot</b> and choose <b>how many likes</b> unlock it.</li>
        <li>Every like gets a <b>numbered ticket</b> — plus a 1-in-5 chance at an instant drop.</li>
        <li>At the target, the sealed lucky ticket is <b>revealed</b>. One liker takes the whole pot.</li>
        <li>Every pot has a <b>timer</b>. If time runs out first, one of the people who liked it <b>still wins</b>.</li>
      </ol>
    </div>
    <div class="card card-pad" id="rail-lb"><h3>Top winners</h3><div class="muted" style="font-size:14px">Loading…</div></div>`;

  try {
    const { winners } = await api('/leaderboard');
    const el = $('#rail-lb');
    if (el) el.innerHTML = '<h3>Top winners</h3>' + (winners.length ? winners.slice(0, 5).map((w, i) => rankRow(w, i, `${coin}${fmt(w.total)}`)).join('') : '<div class="muted" style="font-size:14px">No winners yet — be the first.</div>');
  } catch {}
}

const rankRow = (u, i, val) => `<a class="rank" href="#/u/${esc(u.username)}"><span class="pos">${i + 1}</span>${avatar(u, 'sm')}<span class="nm">${esc(u.display_name)}</span><span class="val">${val}</span></a>`;

function timeLeft(ts) {
  const ms = ts - Date.now();
  if (ms <= 0) return 'Drawing now…';
  const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4), sec = Math.floor((ms % 6e4) / 1e3);
  if (d) return `${d}d ${h}h left`;
  if (h) return `${h}h ${m}m left`;
  return `${m}:${String(sec).padStart(2, '0')} left`;
}
const DURATIONS = [[15, '15 min'], [60, '1 hour'], [360, '6 hours'], [1440, '24 hours'], [4320, '3 days'], [10080, '7 days']];
const durationLabel = (min) => (DURATIONS.find(([m]) => m === min) || [0, `${min} min`])[1];

// Fallback ticket when the deadline hits before the sealed ticket was handed out (mirrors server.js).
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function countdown(ts) {
  const ms = Math.max(0, ts - Date.now());
  const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4);
  return h ? `${h}h ${m}m` : `${m}m`;
}

const mobileTop = () => `
  <div class="mobile-top">
    <a class="logo" href="#/">${$('.logo svg').outerHTML}<span>Likely</span></a>
    ${state.me ? `<a class="coin-pill" href="#/wallet">${coin}${fmt(state.me.coins)}</a>` : `<button class="btn btn-primary btn-sm" data-action="need-login">Join</button>`}
  </div>`;

// ---------- Post rendering ----------
function potBlock(p) {
  if (p.status === 'none') return '';
  if (p.status === 'expired') {
    return `<div class="pot ended"><div class="winner-row"><span class="trophy">⌛</span>
      <div class="txt"><b>${coin} ${fmt(p.reward)} pot expired</b><div class="muted" style="font-size:13px">Nobody liked it in time, so the coins went back to @${esc(p.author.username)}.</div></div></div></div>`;
  }
  if (p.status === 'revealed') {
    const mine = state.me && p.winner.id === state.me.id;
    return `
      <div class="pot revealed">
        <div class="winner-row">
          <span class="trophy">🏆</span>
          ${avatar(p.winner, 'sm')}
          <div class="txt">
            <div>${mine ? '<span class="my-win">You won!</span>' : `<b><a href="#/u/${esc(p.winner.username)}">${esc(p.winner.display_name)}</a></b> won`}
              <b style="color:var(--gold-deep)">${coin} ${fmt(p.reward)}</b></div>
            <div class="muted" style="font-size:13px">${p.end_reason === 'deadline' ? `⌛ Timer ran out at ${fmt(p.final_count)}/${fmt(p.target_likes)} · ` : ''}Lucky ticket #${p.winning_ticket} of ${fmt(p.final_count)} ·
              <button class="seal" data-action="verify" data-id="${p.id}">verify fairness ✓</button></div>
          </div>
        </div>
      </div>`;
  }
  const pct = Math.min(100, (p.like_count / p.target_likes) * 100);
  const left = p.target_likes - p.like_count;
  return `
    <div class="pot">
      <div class="pot-top">
        <span class="pot-amount">${coin}${fmt(p.reward)}</span>
        <span class="pot-label">pot · 1 lucky liker</span>
        <span class="odds">1 in ${fmt(p.target_likes)}</span>
        ${p.deadline ? `<span class="timer ${p.deadline - Date.now() < 36e5 ? 'urgent' : ''}" data-deadline="${p.deadline}">⏳ <span>${timeLeft(p.deadline)}</span></span>` : ''}
      </div>
      <div class="progress"><span style="width:${pct}%"></span></div>
      <div class="pot-meta">
        <span><b>${fmt(p.like_count)}</b> / ${fmt(p.target_likes)} likes · ${left <= 3 ? `<b style="color:var(--like)">${left} to go!</b>` : `${fmt(left)} to reveal`}</span>
        <button class="seal" data-action="verify" data-id="${p.id}" title="The winning ticket was sealed when this post was created">🔒 ${esc(p.commitment.slice(0, 10))}…</button>
      </div>
    </div>`;
}

function likeButton(p) {
  const own = state.me && p.author.id === state.me.id;
  if (p.status === 'open') {
    if (p.liked) return `<span class="ticket">🎟️ Ticket #${p.my_ticket}</span>`;
    if (own) return `<span class="act like" title="You can't win your own pot">${icons.heart}<span>${fmt(p.like_count)}</span></span>`;
    return `<button class="act like cta" data-action="like" data-id="${p.id}">${icons.heart}<span>Like · get ticket</span></button>`;
  }
  return `<button class="act like ${p.liked ? 'on' : ''}" data-action="${p.liked ? 'unlike' : 'like'}" data-id="${p.id}" aria-pressed="${p.liked}">${icons.heart}<span>${fmt(p.like_count)}</span></button>`;
}

function postCard(p) {
  const own = state.me && p.author.id === state.me.id;
  const canDelete = own && !(p.status === 'open' && p.like_count > 0);
  return `
    <article class="card post ${p.status === 'open' ? 'pot-open' : ''}" data-post="${p.id}">
      <div class="post-head">
        <a href="#/u/${esc(p.author.username)}">${avatar(p.author)}</a>
        <div class="who">
          <a class="name" href="#/u/${esc(p.author.username)}">${esc(p.author.display_name)}</a>
          <div class="handle">@${esc(p.author.username)} · <a href="#/p/${p.id}">${ago(p.created_at)}</a></div>
        </div>
        ${canDelete ? `<button class="act menu" data-action="delete" data-id="${p.id}" title="${p.status === 'open' ? 'Cancel pot & refund' : 'Delete post'}">${icons.trash}</button>` : ''}
      </div>
      <p class="post-body">${esc(p.body)}</p>
      ${p.image_url ? `<button class="post-img" data-action="lightbox" data-src="${esc(p.image_url)}" aria-label="View photo"><img src="${esc(p.image_url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.remove()"></button>` : ''}
      ${potBlock(p)}
      <div class="post-actions">
        ${likeButton(p)}
        <button class="act" data-action="comments" data-id="${p.id}">${icons.comment}<span>${fmt(p.comment_count)}</span></button>
        <button class="act" data-action="share" data-id="${p.id}" title="Copy link">${icons.share}</button>
        ${p.status === 'open' && p.liked ? `<span class="muted" style="margin-left:auto;font-size:13px">locked in until reveal</span>` : ''}
      </div>
      <div class="comments-slot"></div>
    </article>`;
}

function upsertPost(p, { pop = false } = {}) {
  state.posts.set(p.id, p);
  const el = document.querySelector(`[data-post="${p.id}"]`);
  if (!el) return;
  const wasOpen = state.openComments.has(p.id);
  const tmp = document.createElement('div');
  tmp.innerHTML = postCard(p).trim();
  const fresh = tmp.firstElementChild;
  el.replaceWith(fresh);
  if (pop) fresh.querySelector('.act.like')?.classList.add('pop');
  if (wasOpen) loadComments(p.id);
}

async function refreshPost(id) {
  try { const { post } = await api(`/posts/${id}`); upsertPost(post); }
  catch (e) { if (e.status === 404) document.querySelector(`[data-post="${id}"]`)?.remove(); }
}

// ---------- Composer ----------
function composer() {
  if (!state.me) return '';
  const c = state.composer;
  return `
    <form class="card composer" id="composer">
      <div class="composer-row">
        ${avatar(state.me)}
        <div style="flex:1;min-width:0">
          <textarea name="body" maxlength="500" rows="2" placeholder="What's happening? Add a pot to get way more likes…"></textarea>
          <div class="img-preview hidden" id="img-preview"></div>
          <input class="img-input hidden" name="image_url" type="url" placeholder="Image link (https://…)" />
          <input type="file" id="photo-file" accept="image/jpeg,image/png,image/gif,image/webp" hidden />
        </div>
      </div>
      <div class="pot-builder ${c.potOn ? '' : 'hidden'}" id="pot-builder">
        <div class="fields">
          <div><label for="reward">Reward pot (coins)</label><input id="reward" name="reward" type="number" min="10" step="5" value="${c.reward}" /></div>
          <div><label for="target">Reveal at (likes)</label><input id="target" name="target" type="number" min="2" max="10000" value="${c.target}" /></div>
          <div><label for="duration">Ends in</label><select id="duration" name="duration">${DURATIONS.map(([m, l]) => `<option value="${m}" ${m === c.duration ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        </div>
        <div class="pot-summary" id="pot-summary"></div>
      </div>
      <div class="composer-actions">
        <button type="button" class="chip-toggle ${c.potOn ? 'on' : ''}" data-action="toggle-pot">🎁 Reward pot</button>
        <button type="button" class="chip-toggle" data-action="pick-photo">📷 Photo</button>
        <button type="button" class="chip-toggle" data-action="toggle-img" title="Use an image link instead">🔗</button>
        <span class="char-count" id="char-count">0/500</span>
        <button class="btn btn-primary" type="submit">Post</button>
      </div>
    </form>`;
}

function updatePotSummary() {
  const f = $('#composer'); if (!f) return;
  const reward = Math.floor(Number(f.reward.value) || 0);
  const target = Math.floor(Number(f.target.value) || 0);
  const duration = Number(f.duration.value);
  state.composer.reward = reward; state.composer.target = target; state.composer.duration = duration;
  const bal = state.me.coins;
  const el = $('#pot-summary');
  if (reward > bal) el.innerHTML = `<b style="color:var(--like)">Not enough coins</b> — you have ${fmt(bal)}.`;
  else if (reward < 10) el.innerHTML = `Minimum pot is <b>10 coins</b>.`;
  else if (target < 2) el.innerHTML = `Reveal needs at least <b>2 likes</b>.`;
  else el.innerHTML = `One of the first <b>${fmt(target)}</b> likers wins <b>${fmt(reward)} coins</b> · odds <b>1 in ${fmt(target)}</b>.
    If it doesn't reach ${fmt(target)} likes within <b>${durationLabel(duration)}</b>, one of the people who liked it still wins (or you get a refund if nobody did). ${fmt(bal - reward)} left in your wallet.`;
}

// ---------- Photo uploads ----------
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_PHOTO_SIDE = 1600;

// Shrink big photos in the browser before uploading: faster for the user, lighter for the server.
// GIFs are sent untouched so animations survive.
async function preparePhoto(file) {
  if (file.type === 'image/gif') return file;
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= 1.5 * 1024 * 1024) { bmp.close(); return file; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const toBlob = (type) => new Promise((res) => canvas.toBlob(res, type, 0.85));
  let blob = await toBlob('image/webp');
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg'); // older Safari
  return blob.size < file.size ? blob : file;
}

function uploadBlob(blob, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', '/api/uploads');
    xhr.setRequestHeader('Content-Type', blob.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
      xhr.status < 300 ? resolve(data) : reject(new Error(data.error || 'Upload failed'));
    };
    xhr.onerror = () => reject(new Error('Network error while uploading'));
    xhr.onabort = () => reject(new Error('aborted'));
    xhr.send(blob);
  });
  return { promise, abort: () => xhr.abort() };
}

function renderPhotoPreview() {
  const box = $('#img-preview'); if (!box) return;
  const up = state.composer.upload;
  box.classList.toggle('hidden', !up);
  if (!up) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <img src="${up.preview}" alt="Selected photo" />
    ${up.status === 'uploading' ? `<div class="up-progress"><span style="width:${Math.round(up.progress * 100)}%"></span></div>` : ''}
    ${up.status === 'error' ? `<div class="up-error">${esc(up.error)} <button type="button" class="btn btn-sm" data-action="retry-photo">Retry</button></div>` : ''}
    <button type="button" class="up-remove" data-action="remove-photo" aria-label="Remove photo">✕</button>`;
}

async function addPhoto(file) {
  if (!state.me) return needLogin();
  if (!file) return;
  if (!PHOTO_TYPES.includes(file.type)) return toast('Use a JPEG, PNG, GIF or WebP image', 'err');
  clearPhoto();
  const $img = $('#composer [name=image_url]'); if ($img) { $img.value = ''; $img.classList.add('hidden'); }
  const up = state.composer.upload = { status: 'uploading', progress: 0, preview: URL.createObjectURL(file), file };
  renderPhotoPreview();
  try {
    const blob = await preparePhoto(file);
    if (state.composer.upload !== up) return; // removed while shrinking
    if (blob.size > MAX_PHOTO_BYTES) throw new Error('Image is too large (max 5 MB)');
    const job = uploadBlob(blob, (p) => {
      up.progress = p;
      const bar = $('#img-preview .up-progress span'); if (bar) bar.style.width = `${Math.round(p * 100)}%`;
    });
    up.abort = job.abort;
    const { url } = await job.promise;
    if (state.composer.upload !== up) return;
    up.url = url; up.status = 'done';
  } catch (e) {
    if (state.composer.upload !== up || e.message === 'aborted') return;
    up.status = 'error'; up.error = e.message;
  }
  renderPhotoPreview();
}

function clearPhoto() {
  const up = state.composer.upload;
  if (up) { up.abort?.(); URL.revokeObjectURL(up.preview); }
  state.composer.upload = null;
  renderPhotoPreview();
}

function lightbox(src) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop lightbox" data-action="close-modal"><img src="${esc(src)}" alt="" referrerpolicy="no-referrer" />
    <button class="btn btn-sm close" data-action="close-modal" aria-label="Close">✕</button></div>`;
}

async function submitPost(form) {
  const body = form.body.value.trim();
  const up = state.composer.upload;
  if (up?.status === 'uploading') { toast('Hang on — your photo is still uploading'); return; }
  if (up?.status === 'error') { toast('Remove the failed photo or try again', 'err'); return; }
  const image_url = up?.url || form.image_url.value.trim();
  if (!body && !image_url) { form.body.focus(); return; }
  const payload = { body, image_url };
  if (state.composer.potOn) { payload.reward = state.composer.reward; payload.target_likes = state.composer.target; payload.duration_minutes = state.composer.duration; }
  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  try {
    const { post } = await api('/posts', { method: 'POST', body: payload });
    form.reset(); $('#char-count').textContent = '0/500';
    clearPhoto();
    state.posts.set(post.id, post);
    if (state.sort === 'new' && !document.querySelector(`[data-post="${post.id}"]`)) $('#feed')?.insertAdjacentHTML('afterbegin', postCard(post));
    toast(post.reward ? `Posted with a ${fmt(post.reward)}-coin pot 🎁` : 'Posted!');
    await loadMe();
    updatePotSummary();
  } catch (e) { toast(esc(e.message), 'err'); }
  finally { btn.disabled = false; }
}

// ---------- Views ----------
async function viewFeed() {
  const tabs = [['new', 'Latest'], ['ending', '⏳ Ending soon'], ['closing', '🔥 Almost there'], ['pots', '💰 Biggest pots']];
  $('#main').innerHTML = `
    ${mobileTop()}
    ${composer()}
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${state.sort === k ? 'active' : ''}" data-action="sort" data-sort="${k}">${l}</button>`).join('')}</div>
    <div class="feed" id="feed"><div class="skeleton"></div><div class="skeleton"></div></div>
    <div id="more" style="text-align:center;margin-top:16px"></div>`;
  if (state.me) { updatePotSummary(); renderPhotoPreview(); }
  state.feedUser = null;
  await loadFeed(true);
}

async function loadFeed(reset) {
  if (reset) state.offset = 0;
  const params = new URLSearchParams({ sort: state.sort, offset: state.offset });
  if (state.feedUser) params.set('user', state.feedUser);
  const { posts } = await api('/posts?' + params);
  const feed = $('#feed'); if (!feed) return;
  if (reset) feed.innerHTML = '';
  posts.forEach((p) => state.posts.set(p.id, p));
  feed.insertAdjacentHTML('beforeend', posts.map(postCard).join(''));
  state.offset += posts.length;
  state.hasMore = posts.length === 20;
  if (!feed.children.length) {
    feed.innerHTML = `<div class="card empty"><div class="big">${state.sort === 'new' ? '🫙' : '🎁'}</div>${state.sort === 'new' ? 'Nothing here yet.' : 'No open pots right now — start one!'}</div>`;
  }
  $('#more').innerHTML = state.hasMore ? '<button class="btn" data-action="more">Load more</button>' : '';
}

async function viewPost(id) {
  $('#main').innerHTML = `${mobileTop()}<a href="#/" class="btn btn-ghost btn-sm" style="margin-bottom:10px">← Back</a><div class="feed" id="feed"><div class="skeleton"></div></div>`;
  try {
    const { post } = await api(`/posts/${id}`);
    state.posts.set(post.id, post);
    $('#feed').innerHTML = postCard(post);
    state.openComments.add(post.id);
    loadComments(post.id);
  } catch (e) { $('#feed').innerHTML = `<div class="card empty"><div class="big">🤷</div>${esc(e.message)}</div>`; }
}

async function viewProfile(username) {
  $('#main').innerHTML = `${mobileTop()}<div class="skeleton" style="height:140px;margin-bottom:16px"></div>`;
  try {
    const { user, stats } = await api(`/users/${encodeURIComponent(username)}`);
    const isMe = state.me && state.me.id === user.id;
    $('#main').innerHTML = `
      ${mobileTop()}
      <div class="card profile-head">
        ${avatar(user, 'lg')}
        <div>
          <h2>${esc(user.display_name)}</h2>
          <div class="muted">@${esc(user.username)} · joined ${new Date(user.created_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</div>
          ${user.bio ? `<p style="margin:8px 0 0">${esc(user.bio)}</p>` : ''}
          ${isMe ? `<div style="margin-top:10px"><button class="btn btn-sm" data-action="logout">Log out</button></div>` : ''}
        </div>
      </div>
      <div class="stats">
        <div class="card stat"><div class="n">${fmt(stats.wins)}</div><div class="l">Pots won</div></div>
        <div class="card stat"><div class="n" style="color:var(--gold-deep)">${fmt(stats.total_won)}</div><div class="l">Coins won</div></div>
        <div class="card stat"><div class="n">${fmt(stats.likes_given)}</div><div class="l">Likes given</div></div>
        <div class="card stat"><div class="n">${fmt(stats.total_given)}</div><div class="l">Coins gifted</div></div>
      </div>
      <h3 style="margin:0 0 12px">Posts <span class="muted">${fmt(stats.posts)}</span></h3>
      <div class="feed" id="feed"></div>
      <div id="more" style="text-align:center;margin-top:16px"></div>`;
    state.sort = 'new';
    state.feedUser = user.username;
    await loadFeed(true);
  } catch (e) { $('#main').innerHTML = `${mobileTop()}<div class="card empty"><div class="big">🤷</div>${esc(e.message)}</div>`; }
}

async function viewLeaderboard() {
  $('#main').innerHTML = `${mobileTop()}<h1 class="page-title">Leaderboard</h1><div class="skeleton"></div>`;
  const { winners, givers, likers } = await api('/leaderboard');
  const board = (title, sub, rows, val) => `
    <div class="card card-pad"><h3>${title}</h3><div class="muted" style="font-size:13px;margin:-8px 0 8px">${sub}</div>
      ${rows.length ? rows.map((r, i) => rankRow(r, i, val(r))).join('') : '<div class="muted">Nobody yet.</div>'}</div>`;
  $('#main').innerHTML = `${mobileTop()}<h1 class="page-title">Leaderboard</h1>
    <div class="lb-grid">
      ${board('🏆 Luckiest', 'Most coins won from pots', winners, (r) => `${coin}${fmt(r.total)}`)}
      ${board('💝 Most generous', 'Most coins put into pots', givers, (r) => `${coin}${fmt(r.total)}`)}
      ${board('❤️ Top likers', 'Most likes given', likers, (r) => `${fmt(r.total)} likes`)}
    </div>`;
}

const TX = {
  signup: ['👋', 'Welcome bonus'], daily: ['📅', 'Daily bonus'], pot: ['🎁', 'Funded a pot'],
  refund: ['↩️', 'Pot refunded'], win: ['🏆', 'Won a pot'], drop: ['✨', 'Lucky drop'],
};

async function viewWallet() {
  if (!state.me) return needLogin();
  $('#main').innerHTML = `${mobileTop()}<h1 class="page-title">Wallet</h1><div class="skeleton"></div>`;
  const { coins, transactions } = await api('/wallet');
  $('#main').innerHTML = `${mobileTop()}<h1 class="page-title">Wallet</h1>
    <div class="card wallet-card" style="margin-bottom:16px">
      <div class="label">Balance</div>
      <div class="amount">${coin}${fmt(coins)}</div>
      <div class="sub">Coins are virtual and only for fun inside Likely.</div>
    </div>
    <div class="card list">
      ${transactions.map((t) => `
        <a class="list-item" ${t.post_id ? `href="#/p/${t.post_id}"` : ''}>
          <span class="ico">${TX[t.kind]?.[0] || '•'}</span>
          <div class="grow"><div style="font-weight:600">${TX[t.kind]?.[1] || esc(t.kind)}</div><div class="time">${esc(t.note)} · ${ago(t.created_at)}</div></div>
          <span class="${t.amount >= 0 ? 'amt-pos' : 'amt-neg'}">${t.amount >= 0 ? '+' : '−'}${fmt(Math.abs(t.amount))}</span>
        </a>`).join('') || '<div class="empty">No transactions yet.</div>'}
    </div>`;
}

const NOTIF_ICON = { expired: '⌛', win: '🏆', revealed: '🎉', result: '🎟️', close: '🔥', comment: '💬', welcome: '👋' };

async function viewNotifications() {
  if (!state.me) return needLogin();
  $('#main').innerHTML = `${mobileTop()}<h1 class="page-title">Alerts</h1><div class="skeleton"></div>`;
  const { notifications } = await api('/notifications');
  $('#main').innerHTML = `${mobileTop()}<h1 class="page-title">Alerts</h1>
    <div class="card list">
      ${notifications.map((n) => `
        <a class="list-item ${n.is_read ? '' : 'unread'}" ${n.post_id ? `href="#/p/${n.post_id}"` : ''}>
          <span class="ico">${NOTIF_ICON[n.kind] || '🔔'}</span>
          <div class="grow"><div>${esc(n.message)}</div><div class="time">${ago(n.created_at)}</div></div>
        </a>`).join('') || '<div class="empty"><div class="big">🔕</div>No alerts yet.</div>'}
    </div>`;
  if (state.me.unread) { await api('/notifications/read', { method: 'POST' }); state.me.unread = 0; renderChrome(); }
}

// ---------- Comments ----------
async function loadComments(id) {
  const card = document.querySelector(`[data-post="${id}"]`); if (!card) return;
  const slot = card.querySelector('.comments-slot');
  const { comments } = await api(`/posts/${id}/comments`);
  slot.innerHTML = `
    <div class="comments">
      ${comments.map((c) => `<div class="comment">${avatar(c, 'sm')}<div class="bubble"><b><a href="#/u/${esc(c.username)}">${esc(c.display_name)}</a></b>${esc(c.body)}<div class="time muted" style="font-size:11px">${ago(c.created_at)}</div></div></div>`).join('')}
      ${state.me ? `<form class="comment-form" data-comment-form="${id}"><input name="body" maxlength="300" placeholder="Write a comment…" autocomplete="off"/><button class="btn btn-sm btn-primary">Send</button></form>`
        : `<button class="btn btn-sm" data-action="need-login">Log in to comment</button>`}
    </div>`;
}

// ---------- Modals ----------
function openModal(html, { onClose } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="card modal" role="dialog" aria-modal="true">
    <button class="btn btn-ghost btn-sm close" data-action="close-modal" aria-label="Close">✕</button>${html}</div></div>`;
  root._onClose = onClose;
  root.querySelector('input')?.focus();
}
function closeModal() { const r = $('#modal-root'); r.innerHTML = ''; r._onClose?.(); r._onClose = null; }

function needLogin(mode = 'signup') {
  openModal(`
    <h2>${mode === 'signup' ? 'Join Likely' : 'Welcome back'}</h2>
    <p class="muted" style="margin:0">Every like you give is a ticket to win coins.</p>
    <div class="seg"><button data-action="auth-mode" data-mode="signup" class="${mode === 'signup' ? 'active' : ''}">Sign up</button><button data-action="auth-mode" data-mode="login" class="${mode === 'login' ? 'active' : ''}">Log in</button></div>
    <form id="auth-form" data-mode="${mode}">
      ${mode === 'signup' ? `<div class="field"><label for="dn">Display name</label><input id="dn" name="display_name" maxlength="40" autocomplete="name" /></div>` : ''}
      <div class="field"><label for="un">Username</label><input id="un" name="username" required autocomplete="username" autocapitalize="off" /></div>
      <div class="field"><label for="pw">Password</label><input id="pw" name="password" type="password" required minlength="6" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" /></div>
      <div class="form-error" id="auth-error"></div>
      <button class="btn btn-primary btn-block" style="margin-top:8px">${mode === 'signup' ? 'Create account · get 500 coins' : 'Log in'}</button>
    </form>
    <div class="hint">Just exploring? Log in as a demo user: <b>maya</b>, <b>leo</b>, <b>sam</b>, <b>nova</b> or <b>kai</b> — password <b>demo1234</b>.</div>`);
}

async function submitAuth(form) {
  const mode = form.dataset.mode;
  const data = Object.fromEntries(new FormData(form));
  try {
    await api(mode === 'signup' ? '/signup' : '/login', { method: 'POST', body: data });
    closeModal();
    await loadMe();
    toast(mode === 'signup' ? `Welcome! ${coin} 500 coins added` : `Hey ${esc(state.me.display_name)} 👋`, mode === 'signup' ? 'gold' : '');
    reconnectStream();
    route();
  } catch (e) { $('#auth-error').textContent = e.message; }
}

async function verifyModal(id) {
  const p = state.posts.get(id); if (!p) return;
  if (p.status !== 'revealed') {
    if (p.status === 'expired') return;
    openModal(`<h2>🔒 Sealed pot</h2>
      <p class="muted">When this post was created, the server secretly picked the winning ticket number and published only its fingerprint (SHA-256 hash):</p>
      <div class="mono">${esc(p.commitment)}</div>
      <p class="muted">At ${fmt(p.target_likes)} likes${p.deadline ? ' (or when the timer runs out)' : ''} the ticket number and secret seed are revealed. Anyone can hash them and check they match — so the winner can't be changed after people start liking.</p>`);
    return;
  }
  const hash = await sha256Hex(`${p.proof.slot}:${p.proof.seed}`);
  const ok = hash === p.commitment;
  const n = p.final_count;
  let drawHtml;
  if (p.proof.slot <= n) {
    drawHtml = `<p class="muted">${fmt(n)} tickets were handed out, so sealed ticket <b>#${p.proof.slot}</b> wins.</p>`;
  } else {
    const fb = (parseInt((await sha256Hex(`${p.proof.seed}:fallback`)).slice(0, 12), 16) % n) + 1;
    drawHtml = `<p class="muted">The timer ran out after only ${fmt(n)} tickets, before sealed ticket #${p.proof.slot} was handed out.
      Backup draw from the same seed: <code>sha256(seed + ":fallback") mod ${fmt(n)} + 1</code> = <b>#${fb}</b>
      ${fb === p.winning_ticket ? '<span class="verify-ok">✓</span>' : '<b style="color:var(--like)">✗</b>'}</p>`;
  }
  openModal(`<h2>Fairness proof</h2>
    <p class="muted" style="margin-top:0">Sealed hash published when the post went live:</p>
    <div class="mono">${esc(p.commitment)}</div>
    <p class="muted">Revealed ticket <b>#${p.proof.slot}</b> with seed:</p>
    <div class="mono">${esc(p.proof.seed)}</div>
    <p class="muted">Your browser just computed <code>sha256("${p.proof.slot}:${esc(p.proof.seed.slice(0, 6))}…")</code>:</p>
    <div class="mono">${hash}</div>
    <p class="${ok ? 'verify-ok' : ''}" style="${ok ? '' : 'color:var(--like);font-weight:700'}">${ok ? '✓ Hash matches the sealed value.' : '✗ Mismatch!'}</p>
    ${drawHtml}`);
}

function winModal(post) {
  confetti();
  openModal(`<div class="win-modal">
    <div style="font-size:48px">🎉</div>
    <h2>You held the lucky ticket!</h2>
    <div class="big">${coin}+${fmt(post.reward)}</div>
    <p class="muted">Ticket #${post.proof?.slot ?? ''} on @${esc(post.author.username)}'s post. Keep liking — every pot is another chance.</p>
    <button class="btn btn-gold btn-block" data-action="close-modal">Collect & keep liking</button></div>`);
}

// ---------- Confetti ----------
function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = $('#confetti'), ctx = c.getContext('2d');
  const dpr = devicePixelRatio || 1;
  c.width = innerWidth * dpr; c.height = innerHeight * dpr; ctx.scale(dpr, dpr);
  const colors = ['#ff3d68', '#ffc233', '#6d4aff', '#14a06b', '#3a86ff', '#ff9f1c'];
  const parts = Array.from({ length: 180 }, () => ({
    x: innerWidth / 2 + (Math.random() - .5) * 200, y: innerHeight / 2.5,
    vx: (Math.random() - .5) * 16, vy: Math.random() * -16 - 4,
    s: 5 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - .5) * .3,
    c: colors[(Math.random() * colors.length) | 0],
  }));
  const start = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += .45; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
    }
    if (t - start < 3500) requestAnimationFrame(frame); else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })(start);
}

// ---------- Actions ----------
async function like(id, btn) {
  if (!state.me) return needLogin();
  btn.disabled = true;
  try {
    const r = await api(`/posts/${id}/like`, { method: 'POST' });
    upsertPost(r.post, { pop: true });
    const anchor = document.querySelector(`[data-post="${id}"] .post-actions`) || btn;
    if (r.ticket) toast(`🎟️ Ticket #${r.ticket} — you're in the draw!`);
    if (r.drop) { floater(anchor.firstElementChild || anchor, `+${r.drop} ${coin}`); toast(`✨ Lucky drop! +${r.drop} coins`, 'gold'); }
    if (r.won) { if (!$('.win-modal')) winModal(r.post); }
    else if (r.revealed) toast(`Reveal! @${esc(r.post.winner.username)} won this one. Keep liking!`);
    loadMe();
  } catch (e) { toast(esc(e.message), 'err'); btn.disabled = false; }
}

async function unlike(id) {
  try { const r = await api(`/posts/${id}/like`, { method: 'DELETE' }); upsertPost(r.post); }
  catch (e) { toast(esc(e.message), 'err'); }
}

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) {
    if (ev.target.classList.contains('modal-backdrop')) closeModal();
    return;
  }
  const a = el.dataset.action, id = Number(el.dataset.id);
  if (el.tagName === 'A') ev.preventDefault();
  switch (a) {
    case 'like': return like(id, el);
    case 'unlike': return unlike(id);
    case 'need-login': return needLogin();
    case 'auth-mode': return needLogin(el.dataset.mode);
    case 'close-modal': return closeModal();
    case 'verify': return verifyModal(id);
    case 'logout':
      await api('/logout', { method: 'POST' }); state.me = null; renderChrome(); reconnectStream(); location.hash = '#/'; route(); return;
    case 'daily':
      try { const r = await api('/daily', { method: 'POST' }); toast(`📅 +${r.amount} coins — see you tomorrow!`, 'gold'); floater(el, `+${r.amount} ${coin}`); loadMe(); }
      catch (e) { toast(esc(e.message), 'err'); }
      return;
    case 'sort': state.sort = el.dataset.sort; document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === el)); return loadFeed(true);
    case 'more': return loadFeed(false);
    case 'compose-focus':
      if (!state.me) return needLogin();
      if (currentKey() !== 'home') { location.hash = '#/'; setTimeout(() => $('#composer textarea')?.focus(), 200); }
      else $('#composer textarea')?.focus();
      return;
    case 'toggle-pot':
      state.composer.potOn = !state.composer.potOn;
      el.classList.toggle('on', state.composer.potOn);
      $('#pot-builder').classList.toggle('hidden', !state.composer.potOn);
      return;
    case 'pick-photo': return $('#photo-file')?.click();
    case 'remove-photo': return clearPhoto();
    case 'retry-photo': return addPhoto(state.composer.upload?.file);
    case 'lightbox': return lightbox(el.dataset.src);
    case 'toggle-img': {
      const inp = $('#composer [name=image_url]'); inp.classList.toggle('hidden'); el.classList.toggle('on');
      if (!inp.classList.contains('hidden')) { clearPhoto(); inp.focus(); } else inp.value = '';
      return;
    }
    case 'comments':
      if (state.openComments.has(id)) { state.openComments.delete(id); document.querySelector(`[data-post="${id}"] .comments-slot`).innerHTML = ''; }
      else { state.openComments.add(id); loadComments(id); }
      return;
    case 'share':
      try { await navigator.clipboard.writeText(`${location.origin}/#/p/${id}`); toast('Link copied 🔗'); } catch { toast('Copy failed', 'err'); }
      return;
    case 'delete': {
      const p = state.posts.get(id);
      if (!confirm(p?.status === 'open' ? `Cancel this pot? Your ${p.reward} coins will be refunded.` : 'Delete this post?')) return;
      try { await api(`/posts/${id}`, { method: 'DELETE' }); document.querySelector(`[data-post="${id}"]`)?.remove(); toast(p?.status === 'open' ? 'Pot cancelled and refunded' : 'Deleted'); loadMe(); }
      catch (e) { toast(esc(e.message), 'err'); }
      return;
    }
  }
});

document.addEventListener('submit', async (ev) => {
  const f = ev.target;
  if (f.id === 'composer') { ev.preventDefault(); return submitPost(f); }
  if (f.id === 'auth-form') { ev.preventDefault(); return submitAuth(f); }
  if (f.dataset.commentForm) {
    ev.preventDefault();
    const id = Number(f.dataset.commentForm), body = f.body.value.trim();
    if (!body) return;
    try { await api(`/posts/${id}/comments`, { method: 'POST', body: { body } }); state.openComments.add(id); }
    catch (e) { toast(esc(e.message), 'err'); }
  }
});

document.addEventListener('input', (ev) => {
  if (ev.target.closest('#composer')) {
    if (ev.target.name === 'body') $('#char-count').textContent = `${ev.target.value.length}/500`;
    if (['reward', 'target', 'duration'].includes(ev.target.name)) updatePotSummary();
  }
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeModal(); });
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'photo-file') { addPhoto(ev.target.files[0]); ev.target.value = ''; }
});
document.addEventListener('paste', (ev) => {
  if (!ev.target.closest?.('#composer')) return;
  const file = [...(ev.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
  if (file) { ev.preventDefault(); addPhoto(file); }
});
document.addEventListener('dragover', (ev) => {
  const c = ev.target.closest?.('#composer');
  if (c && ev.dataTransfer?.types.includes('Files')) { ev.preventDefault(); c.classList.add('dragging'); }
});
document.addEventListener('dragleave', (ev) => { if (ev.target.id === 'composer') ev.target.classList.remove('dragging'); });
document.addEventListener('drop', (ev) => {
  const c = ev.target.closest?.('#composer');
  if (!c) return;
  ev.preventDefault(); c.classList.remove('dragging');
  addPhoto([...ev.dataTransfer.files].find((f) => f.type.startsWith('image/')));
});

// ---------- Real-time ----------
let stream;
function reconnectStream() {
  stream?.close();
  stream = new EventSource('/api/stream');
  stream.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'post_update' && state.posts.has(ev.id)) refreshPost(ev.id);
    if (ev.type === 'post_delete') document.querySelector(`[data-post="${ev.id}"]`)?.remove();
    if (ev.type === 'post_new' && currentKey() === 'home' && state.sort === 'new' && !document.querySelector(`[data-post="${ev.id}"]`)) {
      api(`/posts/${ev.id}`).then(({ post }) => {
        if (document.querySelector(`[data-post="${post.id}"]`)) return;
        state.posts.set(post.id, post);
        $('#feed')?.insertAdjacentHTML('afterbegin', postCard(post));
        $('#feed .empty')?.remove();
      }).catch(() => {});
    }
    if (ev.type === 'reveal') {
      if (state.posts.has(ev.id)) refreshPost(ev.id);
      // The winner might not be the one who clicked the final like — tell them anywhere in the app.
      if (state.me && ev.winner_id === state.me.id && !$('.win-modal')) {
        api(`/posts/${ev.id}`).then(({ post }) => { if (!$('.win-modal')) winModal(post); });
      }
      renderRail();
    }
    if (ev.type === 'notification') loadMe();
  };
}

// ---------- Router ----------
function route() {
  const h = location.hash.replace(/^#/, '') || '/';
  renderChrome();
  window.scrollTo(0, 0);
  let m;
  if (h === '/' ) return viewFeed();
  if (h === '/login') { location.replace('#/'); return needLogin('login'); }
  if (h === '/leaderboard') return viewLeaderboard();
  if (h === '/wallet') return viewWallet();
  if (h === '/notifications') return viewNotifications();
  if ((m = h.match(/^\/u\/([a-z0-9_]+)$/))) return viewProfile(m[1]);
  if ((m = h.match(/^\/p\/(\d+)$/))) return viewPost(Number(m[1]));
  return viewFeed();
}
window.addEventListener('hashchange', route);
setInterval(() => { if (state.me) renderRail(); }, 60_000);
setInterval(() => {
  for (const el of document.querySelectorAll('[data-deadline]')) {
    const dl = Number(el.dataset.deadline);
    el.firstElementChild.textContent = timeLeft(dl);
    el.classList.toggle('urgent', dl - Date.now() < 36e5);
  }
}, 1000);

await loadMe();
reconnectStream();
route();
