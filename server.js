// Likely — a social app where every like is a lottery ticket.
// Zero dependencies: Node's built-in http, crypto and sqlite.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'likely.db');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DB_PATH), 'uploads');
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;   // 5 MB (the browser shrinks photos before sending)
const UPLOADS_PER_HOUR = 30;
const ORPHAN_UPLOAD_TTL = 24 * 60 * 60 * 1000; // picked but never posted -> deleted after a day

// ---- Game economy -------------------------------------------------------
const SIGNUP_BONUS = 500;      // coins every new account starts with
const DAILY_BONUS = 50;        // claimable once every 24h
const DAILY_COOLDOWN = 24 * 60 * 60 * 1000;
const MIN_POT = 10;
const MIN_TARGET = 2;
const MIN_DURATION = 5;               // minutes
const MAX_DURATION = 7 * 24 * 60;     // 7 days
const DEFAULT_DURATION = 24 * 60;     // 24h
const MAX_TARGET = 10_000;
const DROP_CHANCE = 0.2;       // chance a like on an open pot gives an instant bonus
const DROP_MIN = 1, DROP_MAX = 10;
const COLORS = ['#ff4d6d', '#f77f00', '#fcbf49', '#2ec4b6', '#3a86ff', '#8338ec', '#ff006e', '#06d6a0', '#118ab2', '#ef476f'];

// ---- Database -----------------------------------------------------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    pass_hash TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    avatar_color TEXT NOT NULL,
    coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
    last_daily INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  -- status: 'none' (plain post), 'open' (pot waiting for likes), 'revealed' (winner picked)
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    image_url TEXT,
    reward INTEGER NOT NULL DEFAULT 0,
    target_likes INTEGER,
    like_count INTEGER NOT NULL DEFAULT 0,
    lucky_slot INTEGER,          -- SECRET until revealed
    seed TEXT,                   -- SECRET until revealed
    commitment TEXT,             -- sha256("<lucky_slot>:<seed>"), public from the start
    status TEXT NOT NULL DEFAULT 'none',
    winner_id INTEGER REFERENCES users(id),
    revealed_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS posts_user ON posts(user_id);
  CREATE INDEX IF NOT EXISTS posts_status ON posts(status);

  CREATE TABLE IF NOT EXISTS likes (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL,       -- ticket number (1-based order of the like)
    created_at INTEGER NOT NULL,
    PRIMARY KEY (post_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS likes_slot ON likes(post_id, slot);

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount INTEGER NOT NULL,
    kind TEXT NOT NULL,          -- signup | daily | pot | refund | win | drop
    post_id INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tx_user ON transactions(user_id);

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    post_id INTEGER,
    message TEXT NOT NULL,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS notif_user ON notifications(user_id, is_read);

  CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL UNIQUE,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    post_id INTEGER,              -- NULL until attached to a post
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS uploads_post ON uploads(post_id);
`);

const q = (sql) => db.prepare(sql);

// Migrations for databases created before pot deadlines existed.
{
  const cols = new Set(q('PRAGMA table_info(posts)').all().map((c) => c.name));
  for (const [name, type] of [['deadline', 'INTEGER'], ['winning_slot', 'INTEGER'], ['final_count', 'INTEGER'], ['end_reason', 'TEXT']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE posts ADD COLUMN ${name} ${type}`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS posts_deadline ON posts(status, deadline)');
}
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

const now = () => Date.now();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ---- Wallet & notifications --------------------------------------------
function moveCoins(userId, amount, kind, postId = null, note = '') {
  if (amount < 0) {
    const r = q('UPDATE users SET coins = coins + ? WHERE id = ? AND coins >= ?').run(amount, userId, -amount);
    if (r.changes === 0) fail(400, 'Not enough coins');
  } else {
    q('UPDATE users SET coins = coins + ? WHERE id = ?').run(amount, userId);
  }
  q('INSERT INTO transactions (user_id, amount, kind, post_id, note, created_at) VALUES (?,?,?,?,?,?)')
    .run(userId, amount, kind, postId, note, now());
}

function notify(userId, kind, message, postId = null) {
  q('INSERT INTO notifications (user_id, kind, post_id, message, created_at) VALUES (?,?,?,?,?)')
    .run(userId, kind, postId, message, now());
  sendTo(userId, { type: 'notification' });
}

// ---- Auth ---------------------------------------------------------------
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function checkPassword(password, salt, hash) {
  const test = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
}

function createUser(username, password, displayName) {
  username = String(username || '').trim().toLowerCase();
  displayName = String(displayName || '').trim() || username;
  if (!/^[a-z0-9_]{3,20}$/.test(username)) fail(400, 'Username must be 3–20 letters, numbers or _');
  if (String(password || '').length < 6) fail(400, 'Password must be at least 6 characters');
  if (displayName.length > 40) fail(400, 'Display name is too long');
  if (q('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, 'That username is taken');
  const { salt, hash } = hashPassword(String(password));
  const color = COLORS[crypto.randomInt(COLORS.length)];
  return tx(() => {
    const r = q(`INSERT INTO users (username, display_name, pass_hash, pass_salt, avatar_color, created_at)
                 VALUES (?,?,?,?,?,?)`).run(username, displayName, hash, salt, color, now());
    const id = Number(r.lastInsertRowid);
    moveCoins(id, SIGNUP_BONUS, 'signup', null, 'Welcome bonus');
    notify(id, 'welcome', `Welcome to Likely! Here are ${SIGNUP_BONUS} coins to start. Like posts with a 🎁 pot for a chance to win.`);
    return id;
  });
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  q('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?,?,?)').run(sha256(token), userId, now());
  return token;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function currentUser(req) {
  const token = parseCookies(req).likely_session;
  if (!token) return null;
  return q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(token)) || null;
}

const sessionCookie = (token, maxAge) =>
  `likely_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

function publicUser(u) {
  return { id: u.id, username: u.username, display_name: u.display_name, avatar_color: u.avatar_color, bio: u.bio };
}

// ---- Posts --------------------------------------------------------------
const POST_SELECT = `
  SELECT p.*, u.username, u.display_name, u.avatar_color,
         w.username AS w_username, w.display_name AS w_display_name, w.avatar_color AS w_color,
         (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS comment_count,
         l.slot AS my_slot
  FROM posts p
  JOIN users u ON u.id = p.user_id
  LEFT JOIN users w ON w.id = p.winner_id
  LEFT JOIN likes l ON l.post_id = p.id AND l.user_id = ?`;

// Never leak lucky_slot / seed before the reveal.
function postView(p) {
  const revealed = p.status === 'revealed';
  return {
    id: p.id,
    body: p.body,
    image_url: p.image_url,
    created_at: p.created_at,
    author: { id: p.user_id, username: p.username, display_name: p.display_name, avatar_color: p.avatar_color },
    like_count: p.like_count,
    comment_count: p.comment_count,
    liked: p.my_slot != null,
    my_ticket: p.my_slot ?? null,
    reward: p.reward,
    target_likes: p.target_likes,
    status: p.status,
    commitment: p.commitment,
    winner: revealed ? { id: p.winner_id, username: p.w_username, display_name: p.w_display_name, avatar_color: p.w_color } : null,
    proof: revealed ? { slot: p.lucky_slot, seed: p.seed } : null,
    winning_ticket: revealed ? (p.winning_slot ?? p.lucky_slot) : null,
    final_count: p.final_count ?? (revealed ? p.target_likes : null),
    end_reason: p.end_reason ?? (revealed ? 'target' : null),
    deadline: p.deadline,
    revealed_at: p.revealed_at,
  };
}

function getPost(id, viewerId) {
  const p = q(`${POST_SELECT} WHERE p.id = ?`).get(viewerId || 0, id);
  return p ? postView(p) : null;
}

function listPosts({ sort = 'new', username, offset = 0, viewerId }) {
  const where = [];
  const params = [viewerId || 0];
  if (username) { where.push('u.username = ?'); params.push(username); }
  let order = 'p.id DESC';
  if (sort === 'closing') { where.push(`p.status = 'open'`); order = '(p.target_likes - p.like_count) ASC, p.reward DESC'; }
  if (sort === 'pots') { where.push(`p.status = 'open'`); order = 'p.reward DESC, p.id DESC'; }
  if (sort === 'ending') { where.push(`p.status = 'open' AND p.deadline IS NOT NULL`); order = 'p.deadline ASC'; }
  const sql = `${POST_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT 20 OFFSET ?`;
  params.push(Math.max(0, Number(offset) || 0));
  return q(sql).all(...params).map(postView);
}

const UPLOAD_PATH_RE = /^\/uploads\/([a-f0-9]{32}\.(?:jpg|png|gif|webp))$/;

// Returns { image, uploadFile } — uploadFile is set when the image is one of the user's own uploads.
function cleanImageUrl(url, userId) {
  url = String(url || '').trim();
  if (!url) return { image: null, uploadFile: null };
  const m = url.match(UPLOAD_PATH_RE);
  if (m) {
    const up = q('SELECT user_id, post_id FROM uploads WHERE filename = ?').get(m[1]);
    if (!up || up.user_id !== userId) fail(400, 'That upload was not found — try adding the photo again');
    if (up.post_id != null) fail(400, 'That photo is already used in another post');
    return { image: url, uploadFile: m[1] };
  }
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw 0;
    return { image: u.toString().slice(0, 1000), uploadFile: null };
  } catch { fail(400, 'Image must be an uploaded photo or an http(s) URL'); }
}

function createPost(userId, { body, image_url, reward = 0, target_likes, duration_minutes }) {
  body = String(body || '').trim();
  const { image, uploadFile } = cleanImageUrl(image_url, userId);
  if (!body && !image) fail(400, 'Write something or add a photo first');
  if (body.length > 500) fail(400, 'Posts are limited to 500 characters');
  reward = Math.floor(Number(reward) || 0);
  if (reward < 0) fail(400, 'Reward cannot be negative');

  let target = null, slot = null, seed = null, commitment = null, status = 'none';
  if (reward > 0) {
    if (reward < MIN_POT) fail(400, `Minimum pot is ${MIN_POT} coins`);
    target = Math.floor(Number(target_likes));
    if (!(target >= MIN_TARGET && target <= MAX_TARGET)) fail(400, `Likes to reveal must be between ${MIN_TARGET} and ${MAX_TARGET}`);
    // Pick the winning ticket NOW and publish only its hash, so nobody (not even the poster) can change it later.
    slot = crypto.randomInt(1, target + 1);
    seed = crypto.randomBytes(16).toString('hex');
    commitment = sha256(`${slot}:${seed}`);
    status = 'open';
  }
  let deadline = null;
  if (status === 'open') {
    const minutes = Math.floor(Number(duration_minutes ?? DEFAULT_DURATION));
    if (!(minutes >= MIN_DURATION && minutes <= MAX_DURATION)) fail(400, 'Pot duration must be between 5 minutes and 7 days');
    deadline = now() + minutes * 60_000;
  }

  const id = tx(() => {
    const r = q(`INSERT INTO posts (user_id, body, image_url, reward, target_likes, lucky_slot, seed, commitment, status, deadline, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(userId, body, image, reward, target, slot, seed, commitment, status, deadline, now());
    const postId = Number(r.lastInsertRowid);
    if (reward > 0) moveCoins(userId, -reward, 'pot', postId, `Funded a pot (reveals at ${target} likes)`);
    if (uploadFile) q('UPDATE uploads SET post_id = ? WHERE filename = ?').run(postId, uploadFile);
    return postId;
  });
  broadcast({ type: 'post_new', id });
  return id;
}

function likePost(userId, postId) {
  const result = tx(() => {
    const p = q('SELECT * FROM posts WHERE id = ?').get(postId);
    if (!p) fail(404, 'Post not found');
    if (p.status === 'open' && p.user_id === userId) fail(400, "You can't take a ticket in your own pot");
    if (q('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?').get(postId, userId)) fail(409, 'You already liked this');

    const slotRow = q('SELECT COALESCE(MAX(slot), 0) + 1 AS next FROM likes WHERE post_id = ?').get(postId);
    const slot = slotRow.next;
    q('INSERT INTO likes (post_id, user_id, slot, created_at) VALUES (?,?,?,?)').run(postId, userId, slot, now());
    q('UPDATE posts SET like_count = like_count + 1 WHERE id = ?').run(postId);

    const out = { ticket: null, drop: 0, revealed: false, won: false };
    if (p.status === 'open') {
      out.ticket = slot;
      if (Math.random() < DROP_CHANCE) {
        out.drop = crypto.randomInt(DROP_MIN, DROP_MAX + 1);
        moveCoins(userId, out.drop, 'drop', postId, 'Lucky drop for liking');
      }
      if (slot >= p.target_likes) {
        const winnerId = settle(p, 'target');
        out.revealed = true;
        out.won = winnerId === userId;
      } else {
        const liker = q('SELECT username FROM users WHERE id = ?').get(userId);
        const left = p.target_likes - slot;
        if (left <= 3 && left > 0) notify(p.user_id, 'close', `@${liker.username} liked your pot — only ${left} like${left > 1 ? 's' : ''} until the reveal!`, postId);
      }
    }
    return out;
  });
  broadcast({ type: 'post_update', id: postId });
  return result;
}

// A pot ends when it hits its target OR its deadline passes.
// The sealed ticket wins if someone holds it. If the deadline hit before that ticket was given out,
// a backup ticket is derived from the same sealed seed — so every liker still had exactly a 1-in-N chance,
// and the result stays verifiable from the published seed.
function fallbackSlot(seed, n) {
  return (parseInt(sha256(`${seed}:fallback`).slice(0, 12), 16) % n) + 1;
}

function settle(p, reason) {
  const n = q('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(p.id).n;
  const poster = q('SELECT username FROM users WHERE id = ?').get(p.user_id);

  if (n === 0) {
    q(`UPDATE posts SET status = 'expired', final_count = 0, end_reason = ?, revealed_at = ? WHERE id = ?`).run(reason, now(), p.id);
    moveCoins(p.user_id, p.reward, 'refund', p.id, 'Pot expired with no likes');
    notify(p.user_id, 'expired', `Your ${p.reward}-coin pot ended with no likes, so the coins went back to your wallet.`, p.id);
    broadcast({ type: 'post_update', id: p.id });
    return null;
  }

  const slot = p.lucky_slot <= n ? p.lucky_slot : fallbackSlot(p.seed, n);
  const winner = q(`SELECT l.user_id, u.username FROM likes l JOIN users u ON u.id = l.user_id
                    WHERE l.post_id = ? AND l.slot = ?`).get(p.id, slot);
  if (!winner) fail(500, 'Winning ticket missing');
  q(`UPDATE posts SET status = 'revealed', winner_id = ?, winning_slot = ?, final_count = ?, end_reason = ?, revealed_at = ? WHERE id = ?`)
    .run(winner.user_id, slot, n, reason, now(), p.id);
  moveCoins(winner.user_id, p.reward, 'win', p.id, `Won ticket #${slot}${reason === 'deadline' ? ' (deadline draw)' : ''}`);

  const how = reason === 'deadline' ? `the timer ran out at ${n} like${n > 1 ? 's' : ''}` : 'it hit its target';
  notify(winner.user_id, 'win', `🎉 You won ${p.reward} coins on @${poster.username}'s post with ticket #${slot}!`, p.id);
  notify(p.user_id, 'revealed', `Your ${p.reward}-coin pot ended because ${how}. @${winner.username} held the lucky ticket #${slot}.`, p.id);
  const others = q('SELECT user_id FROM likes WHERE post_id = ? AND user_id != ?').all(p.id, winner.user_id);
  for (const o of others) {
    notify(o.user_id, 'result', `Results are in on @${poster.username}'s pot: @${winner.username} won ${p.reward} coins. Keep liking — the next one could be yours!`, p.id);
  }
  broadcast({ type: 'reveal', id: p.id, winner_id: winner.user_id, winner: winner.username, reward: p.reward });
  return winner.user_id;
}

// Settle every open pot whose deadline has passed. Runs on a timer and before each API request.
function settleDue() {
  const due = q(`SELECT id FROM posts WHERE status = 'open' AND deadline IS NOT NULL AND deadline <= ?`).all(now());
  for (const { id } of due) {
    try {
      tx(() => {
        const p = q('SELECT * FROM posts WHERE id = ?').get(id);
        if (p.status === 'open') settle(p, 'deadline');
      });
    } catch (e) { console.error('settle failed', id, e); }
  }
}
setInterval(settleDue, 5_000);

function unlikePost(userId, postId) {
  tx(() => {
    const p = q('SELECT status FROM posts WHERE id = ?').get(postId);
    if (!p) fail(404, 'Post not found');
    if (p.status === 'open') fail(400, 'Tickets in an open pot are locked until the reveal');
    const r = q('DELETE FROM likes WHERE post_id = ? AND user_id = ?').run(postId, userId);
    if (r.changes) q('UPDATE posts SET like_count = like_count - 1 WHERE id = ?').run(postId);
  });
  broadcast({ type: 'post_update', id: postId });
}

function deletePost(userId, postId) {
  tx(() => {
    const p = q('SELECT * FROM posts WHERE id = ?').get(postId);
    if (!p) fail(404, 'Post not found');
    if (p.user_id !== userId) fail(403, 'Not your post');
    if (p.status === 'open' && p.like_count > 0) fail(400, 'People already hold tickets — this pot must run to the reveal');
    if (p.status === 'open') moveCoins(userId, p.reward, 'refund', null, 'Pot cancelled before any likes');
    q('DELETE FROM posts WHERE id = ?').run(postId);
  });
  removeUploads(q('SELECT filename FROM uploads WHERE post_id = ?').all(postId));
  broadcast({ type: 'post_delete', id: postId });
}

// ---- Uploads ------------------------------------------------------------
// Identify the real file type from its first bytes — never trust the client's Content-Type or filename.
// SVG is deliberately not accepted (it can carry scripts).
function sniffImage(buf) {
  const ascii = (a, b) => buf.subarray(a, b).toString('latin1');
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length > 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return { mime: 'image/gif', ext: 'gif' };
  if (buf.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

function saveUpload(userId, buf) {
  if (!buf.length) fail(400, 'Empty file');
  const recent = q('SELECT COUNT(*) AS n FROM uploads WHERE user_id = ? AND created_at > ?').get(userId, now() - 3_600_000).n;
  if (recent >= UPLOADS_PER_HOUR) fail(429, 'Upload limit reached — try again in a bit');
  const type = sniffImage(buf);
  if (!type) fail(415, 'Only JPEG, PNG, GIF or WebP images are allowed');
  const filename = `${crypto.randomBytes(16).toString('hex')}.${type.ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf, { flag: 'wx' });
  q('INSERT INTO uploads (user_id, filename, mime, size, created_at) VALUES (?,?,?,?,?)').run(userId, filename, type.mime, buf.length, now());
  return { url: `/uploads/${filename}`, size: buf.length, mime: type.mime };
}

function removeUploads(rows) {
  for (const { filename } of rows) {
    fs.rm(path.join(UPLOAD_DIR, filename), { force: true }, () => {});
    q('DELETE FROM uploads WHERE filename = ?').run(filename);
  }
}

// Photos that were picked in the composer but never posted.
function cleanOrphanUploads() {
  removeUploads(q('SELECT filename FROM uploads WHERE post_id IS NULL AND created_at < ?').all(now() - ORPHAN_UPLOAD_TTL));
  // Posts removed by other means (e.g. account deletion cascades).
  removeUploads(q('SELECT filename FROM uploads WHERE post_id IS NOT NULL AND post_id NOT IN (SELECT id FROM posts)').all());
}
setInterval(cleanOrphanUploads, 60 * 60 * 1000);

// ---- Real-time (Server-Sent Events) ------------------------------------
const streams = new Set(); // { res, userId }
function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const s of streams) s.res.write(data);
}
function sendTo(userId, event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const s of streams) if (s.userId === userId) s.res.write(data);
}
setInterval(() => { for (const s of streams) s.res.write(': ping\n\n'); }, 25_000).unref();

// ---- HTTP plumbing ------------------------------------------------------
function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    if (!(req.headers['content-type'] || '').startsWith('image/')) return reject(new HttpError(415, 'Expected an image'));
    if (Number(req.headers['content-length']) > limit) return reject(new HttpError(413, 'Image is too large (max 5 MB)'));
    let size = 0, tooBig = false; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) tooBig = true; else chunks.push(c); });
    req.on('end', () => tooBig ? reject(new HttpError(413, 'Image is too large (max 5 MB)')) : resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return resolve({});
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(new HttpError(413, 'Request too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      if (!(req.headers['content-type'] || '').includes('application/json')) return reject(new HttpError(415, 'Expected JSON'));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, ...opts });
const requireUser = (ctx) => ctx.user || fail(401, 'Please log in first');

// Auth
route('POST', /^\/api\/signup$/, ({ body }) => {
  const id = createUser(body.username, body.password, body.display_name);
  return { status: 201, body: { ok: true }, headers: { 'Set-Cookie': sessionCookie(createSession(id), 60 * 60 * 24 * 30) } };
});
route('POST', /^\/api\/login$/, ({ body }) => {
  const u = q('SELECT * FROM users WHERE username = ?').get(String(body.username || '').trim().toLowerCase());
  if (!u || !checkPassword(String(body.password || ''), u.pass_salt, u.pass_hash)) fail(401, 'Wrong username or password');
  return { body: { ok: true }, headers: { 'Set-Cookie': sessionCookie(createSession(u.id), 60 * 60 * 24 * 30) } };
});
route('POST', /^\/api\/logout$/, ({ req }) => {
  const token = parseCookies(req).likely_session;
  if (token) q('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  return { body: { ok: true }, headers: { 'Set-Cookie': sessionCookie('', 0) } };
});

route('GET', /^\/api\/me$/, ({ user }) => {
  if (!user) return { body: { user: null } };
  const unread = q('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(user.id).n;
  const tickets = q(`SELECT COUNT(*) AS n FROM likes l JOIN posts p ON p.id = l.post_id WHERE l.user_id = ? AND p.status = 'open'`).get(user.id).n;
  return { body: { user: { ...publicUser(user), coins: user.coins, unread, open_tickets: tickets,
    daily_ready_at: user.last_daily + DAILY_COOLDOWN, daily_bonus: DAILY_BONUS } } };
});

route('POST', /^\/api\/daily$/, ({ user }) => {
  requireUser({ user });
  if (now() < user.last_daily + DAILY_COOLDOWN) fail(429, 'Daily bonus already claimed — come back later');
  tx(() => {
    q('UPDATE users SET last_daily = ? WHERE id = ?').run(now(), user.id);
    moveCoins(user.id, DAILY_BONUS, 'daily', null, 'Daily bonus');
  });
  return { body: { ok: true, amount: DAILY_BONUS } };
});

// Posts
route('GET', /^\/api\/posts$/, ({ url, user }) => ({
  body: { posts: listPosts({ sort: url.searchParams.get('sort'), username: url.searchParams.get('user'), offset: url.searchParams.get('offset'), viewerId: user?.id }) },
}));
route('POST', /^\/api\/posts$/, ({ user, body }) => {
  requireUser({ user });
  const id = createPost(user.id, body);
  return { status: 201, body: { post: getPost(id, user.id) } };
});
route('GET', /^\/api\/posts\/(\d+)$/, ({ params, user }) => {
  const p = getPost(Number(params[0]), user?.id);
  if (!p) fail(404, 'Post not found');
  return { body: { post: p } };
});
route('DELETE', /^\/api\/posts\/(\d+)$/, ({ params, user }) => {
  requireUser({ user });
  deletePost(user.id, Number(params[0]));
  return { body: { ok: true } };
});
route('POST', /^\/api\/posts\/(\d+)\/like$/, ({ params, user }) => {
  requireUser({ user });
  const id = Number(params[0]);
  const result = likePost(user.id, id);
  return { body: { ...result, post: getPost(id, user.id) } };
});
route('DELETE', /^\/api\/posts\/(\d+)\/like$/, ({ params, user }) => {
  requireUser({ user });
  const id = Number(params[0]);
  unlikePost(user.id, id);
  return { body: { post: getPost(id, user.id) } };
});
route('GET', /^\/api\/posts\/(\d+)\/comments$/, ({ params }) => ({
  body: { comments: q(`SELECT c.id, c.body, c.created_at, u.username, u.display_name, u.avatar_color
                       FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.id ASC LIMIT 200`).all(Number(params[0])) },
}));
route('POST', /^\/api\/posts\/(\d+)\/comments$/, ({ params, user, body }) => {
  requireUser({ user });
  const postId = Number(params[0]);
  const text = String(body.body || '').trim();
  if (!text) fail(400, 'Comment is empty');
  if (text.length > 300) fail(400, 'Comments are limited to 300 characters');
  const p = q('SELECT user_id FROM posts WHERE id = ?').get(postId);
  if (!p) fail(404, 'Post not found');
  q('INSERT INTO comments (post_id, user_id, body, created_at) VALUES (?,?,?,?)').run(postId, user.id, text, now());
  if (p.user_id !== user.id) notify(p.user_id, 'comment', `@${user.username} commented: "${text.slice(0, 60)}"`, postId);
  broadcast({ type: 'post_update', id: postId });
  return { status: 201, body: { ok: true } };
});

// Uploads (raw image bytes in the body; Content-Type must be image/* which also blocks cross-site form posts)
route('POST', /^\/api\/uploads$/, ({ user, body }) => {
  requireUser({ user });
  return { status: 201, body: saveUpload(user.id, body) };
}, { raw: true });

// People
route('GET', /^\/api\/users\/([a-z0-9_]+)$/, ({ params }) => {
  const u = q('SELECT * FROM users WHERE username = ?').get(params[0]);
  if (!u) fail(404, 'User not found');
  const stat = (sql) => q(sql).get(u.id).n;
  return { body: { user: { ...publicUser(u), created_at: u.created_at }, stats: {
    posts: stat('SELECT COUNT(*) AS n FROM posts WHERE user_id = ?'),
    likes_given: stat('SELECT COUNT(*) AS n FROM likes WHERE user_id = ?'),
    wins: stat(`SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND kind = 'win'`),
    total_won: stat(`SELECT COALESCE(SUM(amount), 0) AS n FROM transactions WHERE user_id = ? AND kind = 'win'`),
    total_given: stat(`SELECT COALESCE(-SUM(amount), 0) AS n FROM transactions WHERE user_id = ? AND kind = 'pot'`),
  } } };
});

route('GET', /^\/api\/leaderboard$/, () => ({
  body: {
    winners: q(`SELECT u.username, u.display_name, u.avatar_color, SUM(t.amount) AS total, COUNT(*) AS count
                FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.kind = 'win'
                GROUP BY u.id ORDER BY total DESC LIMIT 10`).all(),
    givers: q(`SELECT u.username, u.display_name, u.avatar_color, -SUM(t.amount) AS total, COUNT(*) AS count
               FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.kind = 'pot'
               GROUP BY u.id ORDER BY total DESC LIMIT 10`).all(),
    likers: q(`SELECT u.username, u.display_name, u.avatar_color, COUNT(*) AS total
               FROM likes l JOIN users u ON u.id = l.user_id GROUP BY u.id ORDER BY total DESC LIMIT 10`).all(),
  },
}));

route('GET', /^\/api\/wallet$/, ({ user }) => {
  requireUser({ user });
  return { body: { coins: user.coins, transactions: q('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(user.id) } };
});

route('GET', /^\/api\/notifications$/, ({ user }) => {
  requireUser({ user });
  return { body: { notifications: q('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(user.id) } };
});
route('POST', /^\/api\/notifications\/read$/, ({ user }) => {
  requireUser({ user });
  q('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(user.id);
  return { body: { ok: true } };
});

// ---- Static files -------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveUpload(res, pathname) {
  const m = pathname.match(UPLOAD_PATH_RE);
  const file = m && path.join(UPLOAD_DIR, m[1]);
  if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  const types = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  res.writeHead(200, {
    'Content-Type': types[path.extname(file).slice(1)],
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  fs.createReadStream(file).pipe(res);
}

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, decodeURIComponent(pathname)));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/uploads/')) return serveUpload(res, url.pathname);
    if (url.pathname === '/api/stream') {
      const user = currentUser(req);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      const s = { res, userId: user?.id ?? null };
      streams.add(s);
      req.on('close', () => streams.delete(s));
      return;
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

    settleDue();
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (!m) continue;
      const body = r.raw ? await readRaw(req, MAX_UPLOAD_BYTES) : await readJson(req);
      const out = r.handler({ req, url, body, params: m.slice(1), user: currentUser(req) });
      return send(res, out.status || 200, out.body, out.headers);
    }
    fail(404, 'Not found');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Something went wrong' });
  }
});

// ---- Demo data (first run only) ----------------------------------------
function seed() {
  if (q('SELECT COUNT(*) AS n FROM users').get().n > 0) return;
  console.log('Seeding demo data…');
  const ids = {};
  for (const [u, name] of [['maya', 'Maya Chen'], ['leo', 'Leo Martins'], ['sam', 'Sam Okafor'], ['nova', 'Nova Reyes'], ['kai', 'Kai Larsen']]) {
    ids[u] = createUser(u, 'demo1234', name);
    q('UPDATE users SET coins = coins + 1500 WHERE id = ?').run(ids[u]);
  }
  q(`UPDATE users SET bio = 'Photographer. Chasing golden hour.' WHERE username = 'maya'`).run();
  q(`UPDATE users SET bio = 'Indie dev shipping tiny apps.' WHERE username = 'leo'`).run();

  // A finished pot so the feed shows a reveal right away.
  const done = createPost(ids.maya, { body: 'First pot ever on Likely! 100 coins to one lucky liker when this hits 3 likes 💛', reward: 100, target_likes: 3 });
  likePost(ids.leo, done); likePost(ids.sam, done); likePost(ids.nova, done);

  createPost(ids.sam, { body: 'Hot take: pineapple belongs on pizza 🍍 Fight me in the comments.' });
  const p1 = createPost(ids.nova, { body: 'Quick one ⚡ 60 coins, reveals at 4 likes. Who’s feeling lucky?', reward: 60, target_likes: 4, duration_minutes: 30 });
  likePost(ids.kai, p1); likePost(ids.sam, p1);
  const p2 = createPost(ids.leo, { body: 'Just shipped my first app 🚀 Celebrating with a 500 coin pot — one lucky liker takes it all when we reach 10 likes.', reward: 500, target_likes: 10, duration_minutes: 3 * 24 * 60 });
  likePost(ids.maya, p2); likePost(ids.kai, p2); likePost(ids.nova, p2);
  createPost(ids.maya, { body: 'Golden hour from the rooftop tonight 🌅', image_url: 'https://picsum.photos/seed/likely-sunset/900/560', reward: 200, target_likes: 6 });
  createPost(ids.kai, { body: 'Coffee #3 of the day. Is that a problem? ☕', reward: 25, target_likes: 2, duration_minutes: 15 });
}
seed();
cleanOrphanUploads();

server.listen(PORT, () => console.log(`Likely is running → http://localhost:${PORT}`));
