#!/usr/bin/env node
// Builds the static /stories section from content/stories/*.md.
//
//   node scripts/build-stories.mjs
//
// Output (all committed, the server has no build step):
//   stories/index.html, stories/<slug>/index.html, stories/category/<slug>/index.html,
//   stories/images/<slug>/*-{480,960,1600}.webp (+ *-og.jpg for heroes),
//   stories/feed.xml, stories/sitemap.xml, stories/redirect-map.csv
// It also syncs partials/header.html and partials/footer.html into index.html.
//
// The build is deterministic: running it twice produces no diff.

import fs from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { marked } from 'marked';
import * as cheerio from 'cheerio';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = path.join(ROOT, 'content/stories');
const OUT_DIR = path.join(ROOT, 'stories');
const SITE = 'https://nanni.ai';
const BASE = '/stories/';
const IMAGE_WIDTHS = [480, 960, 1600];
const OLD_BLOG_PAGE_SIZE = 10;

const APP_STORE_URL = 'https://apps.apple.com/us/app/nanni-ai-your-baby-translator/id6446214576';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.acousticReport&hl=en_IN&gl=NG';

const DISCLAIMER =
  'This article is for general information only and isn’t a substitute for professional medical advice. ' +
  'Always talk to your pediatrician or another qualified healthcare provider about any questions or concerns about your child’s health.';

const DEFAULT_CTA = {
  heading: 'Understand your baby better with Nanni AI',
  text: 'Translate your baby’s cries, track feeds, sleep and diapers, and ask Nanni any parenting question. Free on iPhone and Android.',
};

// Old URL forms of the blog, for the redirect map.
const OLD_BLOG_ROOTS = ['https://nanni.ai/ask-Nanni-blog', 'https://nanni.ai/our-blog', 'https://ubenwa.ai/our-blog'];
const OLD_JUNK_PAGES = ['404-not-found-nanni', 'blog-2'];
const OLD_SLUG_ALIASES = {
  'baby-led-vs-parent-led-sleep-training-how-to-use-the-cry-it-out-method-ferber-method-and-no-cry-method':
    'baby-vs-parent-led-sleep-cry-it-out-ferber-and-no-cry-methods',
};

// ---------------------------------------------------------------------------
// Helpers

const esc = (s = '') =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const slugify = (s) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const asUtc = (iso) => new Date(`${iso}Z`);
const formatDate = (iso) =>
  asUtc(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const rfc822 = (iso) => asUtc(iso).toUTCString();

async function writeIfChanged(file, content) {
  try {
    if ((await fs.readFile(file, 'utf8')) === content) return false;
  } catch {}
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return true;
}

function plainText(md) {
  return md
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_>`|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Images: WebP sizes from the local original, plus an Open Graph JPEG for heroes.

const imageCache = new Map();

async function processImage(src, { og = false } = {}) {
  const key = `${src}|${og}`;
  if (imageCache.has(key)) return imageCache.get(key);
  if (!src.startsWith(`${BASE}images/`)) throw new Error(`Image outside ${BASE}images/: ${src}`);

  const file = path.join(ROOT, src);
  if (!existsSync(file)) throw new Error(`Missing image ${src}`);
  const meta = await sharp(file).metadata();
  const { dir, name } = path.parse(file);
  const srcMtime = statSync(file).mtimeMs;
  const fresh = (out) => existsSync(out) && statSync(out).mtimeMs >= srcMtime;

  let widths = IMAGE_WIDTHS.filter((w) => w <= meta.width);
  if (!widths.length) widths = [meta.width];
  const variants = [];
  for (const w of widths) {
    const out = path.join(dir, `${name}-${w}.webp`);
    if (!fresh(out)) await sharp(file).rotate().resize({ width: w }).webp({ quality: 78, effort: 5 }).toFile(out);
    variants.push({ w, url: `${path.posix.dirname(src)}/${name}-${w}.webp` });
  }

  let ogUrl;
  if (og) {
    const out = path.join(dir, `${name}-og.jpg`);
    if (!fresh(out)) {
      await sharp(file)
        .rotate()
        .resize({ width: 1200, height: 630, fit: 'cover' })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 80, mozjpeg: true })
        .toFile(out);
    }
    ogUrl = `${path.posix.dirname(src)}/${name}-og.jpg`;
  }

  const info = { src, width: meta.width, height: meta.height, variants, ogUrl };
  imageCache.set(key, info);
  return info;
}

function pictureHtml(img, { alt, sizes, eager = false, className = '', displayWidth = null }) {
  const width = displayWidth ? Math.min(displayWidth, img.width) : img.width;
  const height = Math.round((img.height * width) / img.width);
  const srcset = img.variants.map((v) => `${v.url} ${v.w}w`).join(', ');
  const loading = eager ? 'fetchpriority="high"' : 'loading="lazy"';
  return (
    `<picture><source type="image/webp" srcset="${srcset}" sizes="${sizes}">` +
    `<img src="${img.src}" alt="${esc(alt)}" width="${width}" height="${height}" ${loading} decoding="async"${className ? ` class="${className}"` : ''}></picture>`
  );
}

// ---------------------------------------------------------------------------
// Content

async function loadContent() {
  const categories = JSON.parse(await fs.readFile(path.join(CONTENT_DIR, '_categories.json'), 'utf8'));
  const tags = JSON.parse(await fs.readFile(path.join(CONTENT_DIR, '_tags.json'), 'utf8'));
  const files = (await fs.readdir(CONTENT_DIR)).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort();

  const posts = [];
  for (const f of files) {
    const { data, content } = matter(await fs.readFile(path.join(CONTENT_DIR, f), 'utf8'));
    for (const key of ['title', 'slug', 'date', 'categories', 'hero_image']) {
      if (!data[key]) throw new Error(`${f}: missing front matter "${key}"`);
    }
    if (`${data.slug}.md` !== f) throw new Error(`${f}: slug "${data.slug}" doesn't match the file name`);
    posts.push({ ...data, updated: data.updated || data.date, body: content, url: `${BASE}${data.slug}/` });
  }
  posts.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));

  const catBySlug = new Map(categories.map((c) => [c.slug, c]));
  for (const p of posts) {
    for (const c of p.categories) if (!catBySlug.has(c)) throw new Error(`${p.slug}: unknown category "${c}"`);
    p.primaryCategory = catBySlug.get(p.categories[0]);
  }

  // A category page lists its own posts and those of its subcategories, like WordPress did.
  const descendants = (slug) => [slug, ...categories.filter((c) => c.parent === slug).flatMap((c) => descendants(c.slug))];
  for (const c of categories) {
    const family = new Set(descendants(c.slug));
    c.posts = posts.filter((p) => p.categories.some((s) => family.has(s)));
    c.url = `${BASE}category/${c.slug}/`;
  }
  const usedCategories = categories.filter((c) => c.posts.length).sort((a, b) => a.name.localeCompare(b.name));

  return { posts, categories, usedCategories, catBySlug, tags };
}

async function renderBody(post) {
  const html = marked.parse(post.body, { gfm: true });
  const $ = cheerio.load(html, null, false);

  // Heading ids and table of contents.
  const used = new Set();
  const toc = [];
  $('h2, h3, h4').each((_, el) => {
    let id = slugify($(el).text()) || 'section';
    while (used.has(id)) id += '-x';
    used.add(id);
    $(el).attr('id', id);
    if (el.tagName === 'h2') toc.push({ id, text: $(el).text().trim() });
  });

  // Responsive images.
  for (const el of $('img').toArray()) {
    const $img = $(el);
    const src = $img.attr('src');
    if (!src?.startsWith(`${BASE}images/`)) continue;
    const info = await processImage(src);
    const displayWidth = Number($img.attr('width')) || null;
    const sizes = displayWidth ? `${Math.min(displayWidth, info.width)}px` : '(min-width: 760px) 720px, 100vw';
    $img.replaceWith(
      pictureHtml(info, { alt: $img.attr('alt') || '', sizes, displayWidth, className: displayWidth ? 'is-inline' : '' })
    );
  }
  $('p').each((_, el) => {
    const $p = $(el);
    if ($p.children().length === 1 && $p.children('picture').length && !$p.text().trim()) {
      $p.replaceWith(`<figure>${$p.html()}</figure>`);
    } else {
      // Images that share a paragraph with text (app logos in the roundups) get their own figure.
      $p.children('picture').each((_, pic) => {
        $p.before(`<figure>${$.html(pic)}</figure>`);
        $(pic).remove();
      });
    }
  });

  // Links: external ones open in a new tab.
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (/^https?:\/\//.test(href) && !href.startsWith(SITE)) {
      $(el).attr('target', '_blank').attr('rel', 'noopener');
    }
  });

  $('table').each((_, el) => {
    $(el).wrap('<div class="table-wrap"></div>');
  });

  // App CTA: where the author marked it, otherwise before the sources, otherwise at the end.
  const cta = ctaHtml(post);
  const marker = $.root()
    .contents()
    .filter((_, n) => n.type === 'comment' && n.data.trim() === 'app-cta');
  if (marker.length) {
    marker.first().replaceWith(cta);
    marker.slice(1).remove();
  } else {
    const sources = $('h2')
      .filter((_, el) => /^(sources|references)$/i.test($(el).text().trim()))
      .first();
    if (sources.length) sources.before(cta);
    else $.root().append(cta);
  }

  return { html: $.html(), toc };
}

// ---------------------------------------------------------------------------
// Templates

const icon = {
  search:
    '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  link: '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
  whatsapp:
    '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2c0 1.3.9 2.5 1 2.7.2.2 1.9 2.9 4.6 4 1.7.7 2.4.8 3.2.7.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z"/></svg>',
  facebook:
    '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M14 8V6.5c0-.7.5-1 1-1h2V2h-3c-3 0-4 2-4 4.3V8H8v3.5h2V22h4V11.5h2.7L17 8h-3Z"/></svg>',
  x: '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.8 2H21l-7 8 8.2 12h-6.4l-5-7.3L4.9 22H1.7l7.5-8.6L1.4 2H8l4.5 6.6L17.8 2Zm-1.1 18h1.8L7.4 3.9H5.5L16.7 20Z"/></svg>',
  arrowLeft:
    '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 12H5m6-6-6 6 6 6"/></svg>',
  arrowRight:
    '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>',
  info: '<svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></svg>',
};

function storeButtons() {
  return `<div class="story-cta__buttons">
            <a href="${APP_STORE_URL}" target="_blank" rel="noopener" class="btn btn-primary btn-lg fw-bold"><img src="/landing-img/apple-icon.svg" alt="" width="21" height="24"> App Store</a>
            <a href="${PLAY_STORE_URL}" target="_blank" rel="noopener" class="btn btn-primary btn-lg fw-bold"><img src="/landing-img/google-play-icon.svg" alt="" width="21" height="24"> Google Play</a>
          </div>`;
}

function ctaHtml(post) {
  const heading = post.cta_heading || DEFAULT_CTA.heading;
  const text = post.cta_text || DEFAULT_CTA.text;
  return `<aside class="story-cta" aria-label="Download the Nanni AI app">
          <img class="story-cta__icon" src="${BASE}assets/nanni-app-icon.webp" alt="" width="64" height="64" loading="lazy">
          <div class="story-cta__content">
            <p class="story-cta__heading">${esc(heading)}</p>
            <p class="story-cta__text">${esc(text)}</p>
            ${storeButtons()}
          </div>
        </aside>`;
}

async function cardHtml(post, { headingLevel = 3, featured = false, hidden = false } = {}) {
  const img = await processImage(post.hero_image, { og: true });
  const sizes = featured ? '(min-width: 992px) 560px, 100vw' : '(min-width: 992px) 360px, (min-width: 640px) 50vw, 100vw';
  const search = `${post.title} ${post.excerpt || ''} ${post.categories.join(' ')}`.toLowerCase();
  const h = `h${headingLevel}`;
  return `<li class="story-card${featured ? ' story-card--featured' : ''}" data-cats="${esc(post.categories.join(' '))}" data-search="${esc(search)}"${hidden ? ' data-featured hidden' : ''}>
            <div class="story-card__media">${pictureHtml(img, { alt: post.hero_alt || '', sizes, eager: featured })}</div>
            <div class="story-card__body">
              <span class="chip chip--static">${esc(post.primaryCategory.name)}</span>
              <${h} class="story-card__title"><a href="${post.url}">${esc(post.title)}</a></${h}>
              <p class="story-card__excerpt">${esc(post.excerpt || '')}</p>
              <p class="story-card__meta"><time datetime="${post.date}">${formatDate(post.date)}</time> · ${post.reading_minutes} min read</p>
            </div>
          </li>`;
}

function layout({ title, description, canonical, ogImage, ogType = 'website', jsonLd = [], extraHead = '', body, header, footer }) {
  const ld = jsonLd.map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('\n      ');
  return `<!doctype html>
<html lang="en">
   <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${esc(title)}</title>
      <meta name="description" content="${esc(description)}">
      <link rel="canonical" href="${canonical}">
      <meta name="robots" content="index, follow, max-image-preview:large">
      <meta property="og:site_name" content="Nanni AI">
      <meta property="og:locale" content="en_US">
      <meta property="og:type" content="${ogType}">
      <meta property="og:title" content="${esc(title)}">
      <meta property="og:description" content="${esc(description)}">
      <meta property="og:url" content="${canonical}">
      <meta property="og:image" content="${ogImage}">
      <meta property="og:image:width" content="1200">
      <meta property="og:image:height" content="630">
      <meta name="twitter:card" content="summary_large_image">
      <meta name="twitter:site" content="@ubenwa_ai">
      <meta name="twitter:title" content="${esc(title)}">
      <meta name="twitter:description" content="${esc(description)}">
      <meta name="twitter:image" content="${ogImage}">
      ${extraHead}<link rel="alternate" type="application/rss+xml" title="Nanni Stories" href="${BASE}feed.xml">
      <link rel="apple-touch-icon" sizes="180x180" href="/landing-img/apple-touch-icon.png">
      <link rel="icon" type="image/png" sizes="32x32" href="/landing-img/favicon-32x32.png">
      <link rel="icon" type="image/png" sizes="16x16" href="/landing-img/favicon-16x16.png">
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Sofia+Sans+Semi+Condensed:ital,wght@0,1..1000;1,1..1000&display=swap">
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Protest+Riot&display=swap">
      <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet"
         integrity="sha384-T3c6CoIi6uLrA9TneNEoa7RxnatzjcDSCmG1MXxSR1GAsXEV/Dwwykc2MPK8M2HN" crossorigin="anonymous">
      <link rel="stylesheet" href="/landing-styles.css">
      <link rel="stylesheet" href="${BASE}assets/stories.css">
      ${ld}
      <!-- Google Tag Manager -->
      <script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
         new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
         j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
         'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
         })(window,document,'script','dataLayer','GTM-TKGNP9CL');
      </script>
      <!-- End Google Tag Manager -->
   </head>
   <body class="stories-page">
      <!-- Google Tag Manager (noscript) -->
      <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-TKGNP9CL"
         height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
      <!-- End Google Tag Manager (noscript) -->
      <a class="skip-link" href="#main">Skip to content</a>
      <!-- partial:header -->
${header}      <!-- /partial:header -->
      <main id="main" class="stories">
${body}
      </main>
      <!-- partial:footer -->
${footer}      <!-- /partial:footer -->
      <script src="https://kit.fontawesome.com/b205ced3f3.js" crossorigin="anonymous" defer></script>
      <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"
         integrity="sha384-C6RzsynM9kWDrMNeT87bh95OGNyZPhcTNXj1NW7RuBCsyN/o0jlpcV8Qyq46cDfL"
         crossorigin="anonymous" defer></script>
      <script src="${BASE}assets/stories.js" defer></script>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.3.1/jquery.min.js" defer></script>
      <script src="/js/gtranslate.js" defer></script>
      <script src="https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit" defer></script>
   </body>
</html>
`;
}

const organization = {
  '@type': 'Organization',
  name: 'Ubenwa',
  url: 'https://ubenwa.ai',
  logo: { '@type': 'ImageObject', url: `${SITE}/landing-img/android-chrome-512x512.png` },
};

function breadcrumbLd(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: `${SITE}${it.url}` })),
  };
}

async function listingPage(ctx, { category = null }) {
  const { usedCategories } = ctx;
  const posts = category ? category.posts : ctx.posts;
  const [latest] = posts;
  const latestImg = await processImage(latest.hero_image, { og: true });
  const title = category ? `${category.name} | Nanni Stories` : 'Stories: tips and guides for new parents | Nanni AI';
  const h1 = category ? esc(category.name) : 'Stories for <span class="stories-hero__accent">new parents</span>';
  const intro = category
    ? `${posts.length} ${posts.length === 1 ? 'story' : 'stories'} about ${esc(category.name.toLowerCase())} from the Nanni AI team.`
    : 'Practical, research-backed guides on cries, sleep, feeding and your baby’s first year, from the team behind Nanni AI.';
  const description = category
    ? `Nanni AI stories about ${category.name.toLowerCase()}: practical, research-backed guides for new parents.`
    : 'Practical, research-backed guides for new parents on baby cries, sleep, feeding, health and development, from the team behind Nanni AI.';
  const canonical = `${SITE}${category ? category.url : BASE}`;

  const chips = [
    `<li><a class="chip" href="${BASE}" data-filter=""${category ? '' : ' aria-current="page"'}>All stories</a></li>`,
    ...usedCategories.map(
      (c) =>
        `<li><a class="chip" href="${c.url}" data-filter="${c.slug}"${category?.slug === c.slug ? ' aria-current="page"' : ''}>${esc(c.name)}</a></li>`
    ),
  ].join('\n              ');

  const cards = [];
  for (const [i, p] of posts.entries()) cards.push(await cardHtml(p, { hidden: i === 0 }));

  const breadcrumbs = [{ name: 'Stories', url: BASE }];
  if (category) breadcrumbs.push({ name: category.name, url: category.url });

  const body = `        <header class="stories-hero">
          <div class="container stories-container">
            ${category ? `<nav class="breadcrumbs" aria-label="Breadcrumb"><ol><li><a href="${BASE}">Stories</a></li><li><span aria-current="page">${esc(category.name)}</span></li></ol></nav>` : '<p class="stories-hero__eyebrow">Nanni AI Stories</p>'}
            <h1 class="stories-hero__title">${h1}</h1>
            <p class="stories-hero__intro">${intro}</p>
          </div>
        </header>
        <div class="container stories-container" data-stories${category ? ` data-category="${category.slug}"` : ' data-all'}>
          <section class="featured" aria-labelledby="featured-title" data-featured-section>
            <article class="featured-card">
              <div class="featured-card__media">${pictureHtml(latestImg, { alt: latest.hero_alt || '', sizes: '(min-width: 992px) 600px, 100vw', eager: true })}</div>
              <div class="featured-card__body">
                <p class="featured-card__label">Latest story</p>
                <span class="chip chip--static">${esc(latest.primaryCategory.name)}</span>
                <h2 class="featured-card__title" id="featured-title"><a href="${latest.url}">${esc(latest.title)}</a></h2>
                <p class="featured-card__excerpt">${esc(latest.excerpt || '')}</p>
                <p class="story-card__meta"><time datetime="${latest.date}">${formatDate(latest.date)}</time> · ${latest.reading_minutes} min read</p>
              </div>
            </article>
          </section>
          <section class="stories-browse" aria-labelledby="browse-title">
            <h2 class="stories-browse__title" id="browse-title">${category ? `All ${esc(category.name.toLowerCase())} stories` : 'Browse all stories'}</h2>
            <div class="stories-tools">
              <nav aria-label="Story categories">
                <ul class="chip-list">
              ${chips}
                </ul>
              </nav>
              <div class="stories-search" data-search-box hidden>
                <label class="visually-hidden" for="story-search">Search stories</label>
                ${icon.search}
                <input type="search" id="story-search" placeholder="Search stories" autocomplete="off">
              </div>
            </div>
            <p class="stories-count" data-count aria-live="polite"></p>
            <ul class="story-grid" role="list">
          ${cards.join('\n          ')}
            </ul>
            <p class="stories-empty" data-empty hidden>No stories match your search. Try another word or <a href="${BASE}">browse all stories</a>.</p>
          </section>
        </div>`;

  const jsonLd = category
    ? [breadcrumbLd(breadcrumbs)]
    : [
        {
          '@context': 'https://schema.org',
          '@type': 'Blog',
          name: 'Nanni Stories',
          url: `${SITE}${BASE}`,
          description,
          publisher: organization,
        },
      ];

  return layout({ title, description, canonical, ogImage: `${SITE}${latestImg.ogUrl}`, jsonLd, body, header: ctx.header, footer: ctx.footer });
}

function shareLinks(post) {
  const url = `${SITE}${post.url}`;
  const u = encodeURIComponent(url);
  const t = encodeURIComponent(post.title);
  return `<div class="story-share">
            <p class="story-share__label" id="share-label">Share this story</p>
            <ul class="story-share__list" aria-labelledby="share-label">
              <li><a class="share-link" href="${url}" data-copy>${icon.link}<span>Copy link</span></a></li>
              <li><a class="share-link" href="https://wa.me/?text=${t}%20${u}" target="_blank" rel="noopener">${icon.whatsapp}<span>WhatsApp</span></a></li>
              <li><a class="share-link" href="https://www.facebook.com/sharer/sharer.php?u=${u}" target="_blank" rel="noopener">${icon.facebook}<span>Facebook</span></a></li>
              <li><a class="share-link" href="https://x.com/intent/post?url=${u}&amp;text=${t}" target="_blank" rel="noopener">${icon.x}<span>X</span></a></li>
            </ul>
            <p class="visually-hidden" role="status" data-copy-status></p>
          </div>`;
}

function relatedPosts(post, posts) {
  return posts
    .filter((p) => p.slug !== post.slug)
    .map((p) => ({ p, shared: p.categories.filter((c) => post.categories.includes(c)).length }))
    .sort((a, b) => b.shared - a.shared || b.p.date.localeCompare(a.p.date))
    .slice(0, 3)
    .map((x) => x.p);
}

async function postPage(ctx, post, index) {
  const { posts, catBySlug } = ctx;
  const hero = await processImage(post.hero_image, { og: true });
  const { html, toc } = await renderBody(post);
  const hasToc = toc.length >= 3;
  const newer = posts[index - 1];
  const older = posts[index + 1];
  const related = relatedPosts(post, posts);
  const relatedCards = [];
  for (const p of related) relatedCards.push(await cardHtml(p));

  const cat = post.primaryCategory;
  const canonical = `${SITE}${post.url}`;
  const title = `${post.seo_title || post.title} | Nanni Stories`;
  const description = post.seo_description || post.excerpt || '';
  const breadcrumbs = [
    { name: 'Stories', url: BASE },
    { name: cat.name, url: cat.url },
    { name: post.title, url: post.url },
  ];

  const tocHtml = hasToc
    ? `<aside class="story-toc">
            <details open>
              <summary>On this page</summary>
              <nav aria-label="Table of contents">
                <ol>
                  ${toc.map((t) => `<li><a href="#${t.id}">${esc(t.text)}</a></li>`).join('\n                  ')}
                </ol>
              </nav>
            </details>
          </aside>`
    : '';

  const prevNext = [
    older
      ? `<a class="prevnext__link prevnext__link--prev" href="${older.url}" rel="prev"><span class="prevnext__dir">${icon.arrowLeft} Previous story</span><span class="prevnext__title">${esc(older.title)}</span></a>`
      : '',
    newer
      ? `<a class="prevnext__link prevnext__link--next" href="${newer.url}" rel="next"><span class="prevnext__dir">Next story ${icon.arrowRight}</span><span class="prevnext__title">${esc(newer.title)}</span></a>`
      : '',
  ].join('\n            ');

  const body = `        <article class="story">
          <header class="story-header container stories-container">
            <nav class="breadcrumbs" aria-label="Breadcrumb">
              <ol>
                <li><a href="${BASE}">Stories</a></li>
                <li><a href="${cat.url}">${esc(cat.name)}</a></li>
              </ol>
            </nav>
            <ul class="chip-list chip-list--compact">
              ${post.categories.map((s) => `<li><a class="chip" href="${catBySlug.get(s).url}">${esc(catBySlug.get(s).name)}</a></li>`).join('\n              ')}
            </ul>
            <h1 class="story-title">${esc(post.title)}</h1>
            <p class="story-meta"><span>By the Nanni AI team at Ubenwa</span> <span aria-hidden="true">·</span> <time datetime="${post.date}">${formatDate(post.date)}</time> <span aria-hidden="true">·</span> <span>${post.reading_minutes} min read</span></p>
            <figure class="story-hero">
              ${pictureHtml(hero, { alt: post.hero_alt || '', sizes: '(min-width: 1200px) 1040px, 100vw', eager: true })}
            </figure>
          </header>
          <div class="story-layout container stories-container${hasToc ? ' has-toc' : ''}">
          ${tocHtml}
          <div class="story-main">
            <div class="story-body">
${html}
            </div>
            <aside class="story-disclaimer" aria-label="Medical disclaimer">
              ${icon.info}
              <p>${esc(DISCLAIMER)}</p>
            </aside>
            ${shareLinks(post)}
          </div>
          </div>
        </article>
        <div class="container stories-container">
          <nav class="prevnext" aria-label="More stories">
            ${prevNext}
          </nav>
          <section class="related" aria-labelledby="related-title">
            <h2 class="related__title" id="related-title">Related stories</h2>
            <ul class="story-grid" role="list">
          ${relatedCards.join('\n          ')}
            </ul>
            <p class="related__all"><a href="${BASE}">See all stories ${icon.arrowRight}</a></p>
          </section>
        </div>`;

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description,
      image: [`${SITE}${hero.ogUrl}`, `${SITE}${hero.variants.at(-1).url}`],
      datePublished: post.date,
      dateModified: post.updated,
      author: { '@type': 'Organization', name: 'Ubenwa', url: 'https://ubenwa.ai' },
      publisher: organization,
      mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
      articleSection: cat.name,
      wordCount: plainText(post.body).split(' ').length,
      inLanguage: 'en',
    },
    breadcrumbLd(breadcrumbs),
  ];

  const extraHead = `<meta property="article:published_time" content="${post.date}">
      <meta property="article:modified_time" content="${post.updated}">
      <meta property="article:section" content="${esc(cat.name)}">
      `;

  return layout({
    title,
    description,
    canonical,
    ogImage: `${SITE}${hero.ogUrl}`,
    ogType: 'article',
    jsonLd,
    extraHead,
    body,
    header: ctx.header,
    footer: ctx.footer,
  });
}

// ---------------------------------------------------------------------------
// Feeds, sitemap, redirect map

function feedXml({ posts }) {
  const lastBuild = posts.reduce((m, p) => (p.updated > m ? p.updated : m), '');
  const items = posts
    .map(
      (p) => `    <item>
      <title>${esc(p.title)}</title>
      <link>${SITE}${p.url}</link>
      <guid isPermaLink="true">${SITE}${p.url}</guid>
      <pubDate>${rfc822(p.date)}</pubDate>
      ${p.categories.map((c) => `<category>${esc(c)}</category>`).join('')}
      <description>${esc(p.excerpt || '')}</description>
    </item>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Nanni Stories</title>
    <link>${SITE}${BASE}</link>
    <atom:link href="${SITE}${BASE}feed.xml" rel="self" type="application/rss+xml"/>
    <description>Practical, research-backed guides for new parents from the team behind Nanni AI.</description>
    <language>en</language>
    <lastBuildDate>${rfc822(lastBuild)}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

function sitemapXml({ posts, usedCategories }) {
  const latest = posts.reduce((m, p) => (p.updated > m ? p.updated : m), '');
  const urls = [
    { loc: BASE, lastmod: latest },
    ...usedCategories.map((c) => ({ loc: c.url, lastmod: c.posts.reduce((m, p) => (p.updated > m ? p.updated : m), '') })),
    ...posts.map((p) => ({ loc: p.url, lastmod: p.updated })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE}${u.loc}</loc><lastmod>${u.lastmod.slice(0, 10)}</lastmod></url>`).join('\n')}
</urlset>
`;
}

function redirectMapCsv({ posts, categories, catBySlug, tags }) {
  const rows = [];
  const add = (from, to) => rows.push([from, `${SITE}${to}`]);
  const pages = (n) => Math.ceil(n / OLD_BLOG_PAGE_SIZE);
  const datePath = (iso) => iso.slice(0, 10).replace(/-/g, '/');

  for (const root of OLD_BLOG_ROOTS) {
    add(`${root}/`, BASE);
    for (let n = 2; n <= pages(posts.length); n++) add(`${root}/page/${n}/`, BASE);

    for (const p of posts) add(`${root}/${datePath(p.date)}/${p.slug}/`, p.url);
    for (const [alias, slug] of Object.entries(OLD_SLUG_ALIASES)) {
      const p = posts.find((x) => x.slug === slug);
      add(`${root}/${datePath(p.date)}/${alias}/`, p.url);
    }

    // Categories: old URLs include the parent path (category/feeding-nutrition/tips-tricks/).
    for (const c of categories) {
      const nearest = c.posts.length ? c.url : c.parent && catBySlug.get(c.parent).posts.length ? catBySlug.get(c.parent).url : BASE;
      const oldPath = new URL(c.wp_url).pathname.replace(/^\/ask-Nanni-blog/, '');
      add(`${root}${oldPath}`, nearest);
      for (let n = 2; n <= pages(c.posts.length); n++) add(`${root}${oldPath}page/${n}/`, nearest);
    }
    for (const t of tags) add(`${root}/tag/${t.slug}/`, BASE);

    const archives = new Set();
    for (const p of posts) {
      const [y, m, d] = p.date.slice(0, 10).split('-');
      archives.add(`${y}/`).add(`${y}/${m}/`).add(`${y}/${m}/${d}/`);
    }
    for (const a of [...archives].sort()) add(`${root}/${a}`, BASE);
    for (const slug of OLD_JUNK_PAGES) add(`${root}/${slug}/`, BASE);
    add(`${root}/feed/`, `${BASE}feed.xml`);
  }

  return `old_url,new_url\n${rows.map((r) => r.join(',')).join('\n')}\n`;
}

// ---------------------------------------------------------------------------

async function syncLandingPartials(header, footer) {
  const file = path.join(ROOT, 'index.html');
  let html = await fs.readFile(file, 'utf8');
  for (const [name, content] of [['header', header], ['footer', footer]]) {
    const re = new RegExp(`(<!-- partial:${name} -->\\n)[\\s\\S]*?(\\s*<!-- /partial:${name} -->)`);
    if (!re.test(html)) throw new Error(`index.html is missing the partial:${name} markers`);
    html = html.replace(re, (_, open, close) => `${open}${content.replace(/\n$/, '')}${close}`);
  }
  return writeIfChanged(file, html);
}

async function removeStalePages(posts, usedCategories) {
  const keep = new Set(['images', 'assets', 'category', ...posts.map((p) => p.slug)]);
  for (const entry of await fs.readdir(OUT_DIR, { withFileTypes: true })) {
    if (entry.isDirectory() && !keep.has(entry.name)) await fs.rm(path.join(OUT_DIR, entry.name), { recursive: true });
  }
  const catDir = path.join(OUT_DIR, 'category');
  if (existsSync(catDir)) {
    const cats = new Set(usedCategories.map((c) => c.slug));
    for (const entry of await fs.readdir(catDir)) {
      if (!cats.has(entry)) await fs.rm(path.join(catDir, entry), { recursive: true });
    }
  }
}

async function main() {
  const header = await fs.readFile(path.join(ROOT, 'partials/header.html'), 'utf8');
  const footer = await fs.readFile(path.join(ROOT, 'partials/footer.html'), 'utf8');
  const ctx = { ...(await loadContent()), header, footer };
  const outputs = [];
  const out = (rel, content) => outputs.push([path.join(OUT_DIR, rel), content]);

  out('index.html', await listingPage(ctx, {}));
  for (const c of ctx.usedCategories) out(`category/${c.slug}/index.html`, await listingPage(ctx, { category: c }));
  for (const [i, p] of ctx.posts.entries()) out(`${p.slug}/index.html`, await postPage(ctx, p, i));
  out('feed.xml', feedXml(ctx));
  out('sitemap.xml', sitemapXml(ctx));
  out('redirect-map.csv', redirectMapCsv(ctx));

  await removeStalePages(ctx.posts, ctx.usedCategories);
  let changed = 0;
  for (const [file, content] of outputs) if (await writeIfChanged(file, content)) changed++;
  if (await syncLandingPartials(header, footer)) changed++;

  console.log(`Built ${ctx.posts.length} stories, ${ctx.usedCategories.length} category pages (${changed} files changed).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
