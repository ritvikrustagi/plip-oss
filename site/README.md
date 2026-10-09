# Jade — company site

A standalone static site: the company story for anyone who lands on it (including
investors), plus a case studies page we add to one class at a time.

Three pages, no build step, no dependencies.

```
site/
  index.html         the landing page
  case-studies.html  one <article class="case-study"> per write-up
  about.html         what we believe, how we work, the team
  styles.css         all of it — design tokens live at the top
  site.js            sticky header, mobile menu, fade-in on scroll
  icon.svg           favicon
```

## Run it

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

## Deploy it

Point any static host at this folder — Vercel, Netlify, Cloudflare Pages or
GitHub Pages. Nothing to compile. To host it under `jadestudy.com/about` and
`/case-studies` rather than `.html` URLs, most hosts strip the extension for you;
if yours doesn't, rename the files into folders (`about/index.html`).

The folder is self-contained, so it can move into its own repo whenever that's
tidier than living here.

## Before it goes live

Search for these and replace with the real thing:

| Where | What to replace |
|---|---|
| `index.html` — "Where we are" | The four `.figure` values (3, 120+, 4,800, 71%) and the five rows under them. Marked with a `PLACEHOLDER NUMBERS` comment. |
| `index.html` — case study cards | The two teaser cards; keep them in step with `case-studies.html`. |
| `case-studies.html` | Both write-ups. Every figure in there is illustrative. |
| `about.html` — "Who we are" | Real names, roles and links. Marked with a `PLACEHOLDER` comment. |
| `about.html` — "The short version" | Founding year, stage, location. |
| all pages | `ishan@jadestudy.com` if demo requests should go somewhere else. |
| all pages | `og:url` / `canonical` if this lands on a domain other than jadestudy.com. |

Add a `share.png` (1200×630) next to `index.html` and the `og:image` tags will
have something to point at.

## Adding a case study

Copy one `<article class="case-study">` block in `case-studies.html`, change the
`id`, the `Case 0N` label, the heading, the `.stats` tiles, the `.facts` rows and
the closing quote. Nothing else needs to change — nav, spacing and the reveal
animation are shared.

Keep a **What didn't work** row in every one. It's the row investors and teachers
both read first, and it's why the rest is believable.

## Design notes

Tokens are at the top of `styles.css` and match jadestudy.com, so the product site
and this one read as one brand:

| | |
|---|---|
| paper | `#FAFBF7` |
| ink | `#193D30` |
| jade | `#32644E` |
| sage | `#E8EEDF` |
| lime | `#D5EB9C` |
| display | Newsreader — headings, figures, the wordmark |
| sans | DM Sans — everything else |

Italics carry the emphasis in headings; there is no bold display type anywhere.
