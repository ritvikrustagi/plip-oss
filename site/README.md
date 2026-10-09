# Jade — company site

A standalone static site: the company story for anyone who lands on it (investors
included), plus a case studies page we add to one class at a time.

Three pages, no build step, no dependencies.

```
site/
  index.html         the landing page
  case-studies.html  one <section class="band case-study"> per write-up
  about.html         what we believe, how we work, the team
  styles.css         all of it — design tokens live at the top
  site.js            sticky header, mobile menu, quote scroller, fade-in
  icon.svg           favicon
```

## Run it

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

## Deploy it

Point any static host at this folder — Vercel, Netlify, Cloudflare Pages or
GitHub Pages. Nothing to compile. Most hosts strip the `.html` for you; if yours
doesn't, rename the files into folders (`about/index.html`).

The folder is self-contained, so it can move into its own repo whenever that's
tidier than living here.

## Before it goes live

Search for these and replace with the real thing. Each one is marked with a
`PLACEHOLDER` comment in the source.

| Where | What to replace |
|---|---|
| `index.html` — hero stats | 4,800 / 71% / 120+ |
| `index.html` — "In classroom pilots with" | Real schools and partners (Aristotle puts Stanford here; we should name pilot schools once they say yes) |
| `index.html` — "Where we are" | The four stat tiles and the five rows under them |
| `index.html` — "Wall of love" | Real quotes, with permission and attribution |
| `index.html` — FAQ | Check the pricing and subject answers still match reality |
| `case-studies.html` | Both write-ups. Every figure in there is illustrative. |
| `about.html` | Real names, roles, founding year, stage |
| all pages | `ishan@jadestudy.com` if enquiries should go elsewhere |
| all pages | `og:url` / `canonical` if this lands on another domain |

Add a `share.png` (1200×630) next to `index.html` and the `og:image` tags have
something to point at.

## Adding a case study

Copy one `<section class="band case-study">` block in `case-studies.html`, change
the `id`, the `Case 0N` label, the heading, the four `.stat` tiles, the `.facts`
rows and the closing quote. Alternate `class="band sage torn"` and
`class="band torn"` so the stripes keep going. Nothing else needs to change.

Keep a **What didn't work** row in every one. It's the row teachers and investors
both read first, and it's why the rest is believable.

## Design notes

The structure and texture follow heyaristotle.com — full-bleed illustrated hero,
torn-paper bands, pastel feature cards, a dark closing band, a big wordmark in the
footer — with Jade's own green instead of Aristotle's umber.

| | |
|---|---|
| paper | `#FDFDFB` |
| ink | `#1F241F` |
| jade (accent, buttons) | `#1B3A2D` / `#2F6450` |
| lime (highlighter) | `#D5EB9C` |
| card tints | sage `#E7EEDD`, sky `#DDECEE`, sun `#FFF2C7`, lavender `#ECE7EF`, apricot `#FFE4D4`, leaf `#EAEEB6` |
| display | Newsreader — headings, figures, the wordmark |
| body | Mulish — the same body face Aristotle uses |

Italics carry the emphasis in headings; there is no bold display type anywhere.

**Torn edges.** A band gets `class="band torn"` and draws its torn edge on its
*top* only, overhanging the band above. Because it comes later in the document it
always paints on top, so a band's bottom edge is really the next band's top edge.
Every band that opens a new colour needs `torn` — including the footer.

**The artwork is CSS and SVG, not illustration.** The hero landscape, the trees and
the product mockups are all drawn in the page. That keeps it sharp at any size and
costs nothing to load, but it is the obvious place to spend money later: Aristotle's
painted hero and collage stickers are most of why their site feels expensive.
