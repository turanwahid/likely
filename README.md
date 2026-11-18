# Likely 🎟️

The social app where **every like is a lottery ticket**.

- A poster locks a **coin pot** and picks **how many likes** reveal it (e.g. 200 coins at 50 likes).
- Every like on an open pot gets a numbered **ticket** (+ a 1-in-5 chance at an instant 1–10 coin drop).
- When the post hits its target, the **lucky ticket is revealed** and one liker wins the whole pot.
- **Provably fair:** the winning ticket is picked when the post is created and only its SHA-256 hash is shown. On reveal, the ticket number + seed are published and the browser re-checks the hash.

## Run

Needs Node 22.13+ (no `npm install` — zero dependencies, uses built-in `node:sqlite`).

```bash
npm start            # http://localhost:3000  (PORT=3210 npm start for another port)
npm run reset        # wipe the database (demo data re-seeds on next start)
```

Demo accounts: `maya`, `leo`, `sam`, `nova`, `kai` — password `demo1234`.

## Rules

| Rule | Why |
|---|---|
| New users get 500 coins, +50 daily bonus | keeps the economy moving |
| Pot coins are taken from the poster up front (escrow) | the prize always exists |
| You can't like your own open pot | no self-winning |
| Tickets on an open pot can't be unliked | ticket numbers stay fixed |
| A pot can only be cancelled (refunded) before its first like | no rug-pulls |
| Every pot has a timer (15 min – 7 days, default 24h) | no pot hangs forever |
| Timer runs out with likes → one liker still wins | liking is never wasted |
| Timer runs out with zero likes → poster is refunded | no coins lost |

**Deadline draw:** if the sealed ticket was handed out, it wins. If time ran out before that ticket number was reached, a backup ticket is computed from the same sealed seed: `sha256(seed + ":fallback") mod likes + 1`. Every liker still has exactly a 1-in-N chance, and the "verify fairness" dialog re-checks both steps in the browser.

## Photos

- Add a photo with the 📷 button, drag-and-drop onto the composer, or paste from the clipboard. Photo-only posts are allowed.
- The browser shrinks photos to 1600px WebP before uploading (GIFs are sent as-is to keep animation). Max 5 MB, 30 uploads/hour per user.
- The server checks the file's real bytes (JPEG/PNG/GIF/WebP only — no SVG), stores it in `data/uploads/` under a random name, and only lets the uploader attach it to one post.
- Files are deleted with their post; photos picked but never posted are cleaned up after 24h.

## Stack

- `server.js` — Node `http` + `node:sqlite`, JSON API, cookie sessions (scrypt passwords), Server-Sent Events for live updates
- `public/` — vanilla JS single-page app, no build step, light/dark mode, mobile layout

Coins are virtual. Paying out real money for random rewards would fall under gambling/sweepstakes law — get legal advice before doing that.
