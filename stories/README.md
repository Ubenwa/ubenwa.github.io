# Nanni Stories (`/stories/`)

The static blog at `https://nanni.ai/stories/`. It replaces the old WordPress blog, which gets no new posts. Every page here is generated from Markdown and committed, because the server only serves static files and has no build step.

## How it fits together

```
content/stories/<slug>.md        source of each story: front matter + Markdown body
content/stories/_categories.json category names and hierarchy (from WordPress)
content/stories/_tags.json       WordPress tags (only used for the redirect map)
partials/header.html             shared header, also injected into /index.html
partials/footer.html             shared footer, also injected into /index.html
scripts/export-wp.mjs            one-off: WordPress → content/stories + stories/images
scripts/build-stories.mjs        content/stories → stories/ (deterministic)
stories/                         generated output (upload this folder)
```

You need Node 20 or newer. Run `npm install` once in the repo root.

## Rebuild after an edit

```bash
node scripts/build-stories.mjs
```

The build:

- regenerates every page, `feed.xml`, `sitemap.xml` and `redirect-map.csv`
- creates WebP sizes (480, 960 and 1600 px) for any new image
- syncs the header and footer partials into `/index.html`

Running it twice in a row changes nothing, so a clean `git diff` after a build means everything is up to date.

## Edit a story

1. Open `content/stories/<slug>.md` and change the text. Body text is Markdown, and plain HTML also works.
2. Run `node scripts/build-stories.mjs`.
3. Check the page locally (see below), then commit both the `.md` file and the regenerated `stories/` files.

Front matter fields:

| Field | Purpose |
| --- | --- |
| `title`, `slug` | Page title and URL (`/stories/<slug>/`). The slug must match the file name. |
| `date`, `updated` | Published and last-modified time, used for sorting, the feed and the sitemap. |
| `categories` | Category slugs from `_categories.json`. The first one is used for the breadcrumb. |
| `excerpt` | Card text on the listing pages. |
| `seo_title`, `seo_description` | `<title>` and meta description. If they're empty, the title and excerpt are used. |
| `hero_image`, `hero_alt` | Header image (a file under `/stories/images/<slug>/`) and its alt text. |
| `reading_minutes` | Shown next to the date. |
| `cta_heading`, `cta_text` | Optional custom text for the app-download box. |
| `wp_id`, `wp_url` | Where the story came from on WordPress (reference only). |

Within the body:

- **App-download box:** put `<!-- app-cta -->` on its own line where the box should go. If there's no marker, the box goes before the "Sources" heading, or at the end of the post.
- **Images:** save the file in `stories/images/<slug>/` and reference it as `![Alt text](/stories/images/<slug>/file.jpg)`. To show an image smaller than full width, use `<img src="…" alt="…" width="220">`.
- **Table of contents:** generated automatically from the `##` headings when a post has three or more.
- **Medical disclaimer:** added to every post by the template. The wording is the `DISCLAIMER` constant in `scripts/build-stories.mjs`.

## Add a new story

Copy an existing `.md` file, give it a new slug and file name, set `date`, add the hero image under `stories/images/<new-slug>/`, then build.

## Re-export from WordPress

```bash
node scripts/export-wp.mjs && node scripts/build-stories.mjs
```

- This is only for a full refresh while WordPress is still online.
- It **overwrites** `content/stories/*.md`, so any edits made here since the last export are lost.
- Metadata comes from the WordPress REST API. Post bodies come from the published pages, because the REST content leaves out the Pagelayer-built parts (some intro paragraphs, images and the "Sources" lists).
- Requests go one at a time with a delay, because the host returns 503 errors on bursts.
- Every cleanup edit is logged to `content/stories/_export-report.json`.

## Preview locally

```bash
npx serve .            # from the repo root, then open http://localhost:3000/stories/
```

## Deploy (cPanel)

1. In cPanel File Manager, open `~/public_html/nanni.ai/` and **download a backup of `index.html` first**.
2. Upload these, replacing what's there:
   - the whole `stories/` folder
   - `index.html` (header and footer are injected from the partials, and the Stories nav link and blog cards are new)
   - `landing-img/logo-header.png` (the new lightweight header logo used by both the landing page and stories)
3. You don't need to upload `content/`, `partials/`, `scripts/`, `package.json` or `node_modules/`. They are only used to build.
4. Open `https://nanni.ai/stories/` and one story to check them.

WordPress stays online until the separate redirect effort. `stories/redirect-map.csv` lists every old URL form (posts, categories, tags, pagination, date archives, feed, plus the older blog paths on nanni.ai and ubenwa.ai) with its new URL, ready to turn into redirect rules.

`stories/sitemap.xml` covers all story URLs. It should be referenced from the site's root sitemap or `robots.txt`.
