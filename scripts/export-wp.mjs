#!/usr/bin/env node
// One-off export: WordPress (nanni.ai/ask-Nanni-blog) → content/stories/*.md
// plus local copies of every image the posts actually use.
//
//   node scripts/export-wp.mjs
//
// Metadata (title, dates, categories, Yoast SEO, featured image) comes from the REST API.
// The post body comes from the published page, because the posts are built with Pagelayer
// and the REST `content.rendered` drops parts of them (intro paragraphs, images, the
// "Sources" link lists).
//
// Requests are sent one at a time with a delay, because the host returns 503 on bursts.
// Writes content/stories/<slug>.md, stories/images/<slug>/* (originals; the build makes
// the WebP sizes), and content/stories/_export-report.json (content edits made in cleanup).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import sharp from 'sharp';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://nanni.ai/ask-Nanni-blog/wp-json/wp/v2';
const CONTENT_DIR = path.join(ROOT, 'content/stories');
const IMAGE_DIR = path.join(ROOT, 'stories/images');
const DELAY_MS = 300;
const MAX_ORIGINAL_WIDTH = 1600;

// Old links inside posts that point at slugs which no longer exist on WordPress.
const SLUG_ALIASES = {
  'baby-led-vs-parent-led-sleep-training-how-to-use-the-cry-it-out-method-ferber-method-and-no-cry-method':
    'baby-vs-parent-led-sleep-cry-it-out-ferber-and-no-cry-methods',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function politeFetch(url, { as = 'json' } = {}) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await sleep(DELAY_MS);
    const res = await fetch(url, { headers: { 'User-Agent': 'nanni-stories-export/1.0' } });
    if (res.ok) {
      const body = as === 'binary' ? Buffer.from(await res.arrayBuffer()) : as === 'text' ? await res.text() : await res.json();
      return { res, body };
    }
    if (res.status === 503 || res.status === 429) {
      await sleep(2000 * attempt);
      continue;
    }
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  throw new Error(`Gave up after retries: ${url}`);
}

async function fetchAll(endpoint) {
  const items = [];
  for (let page = 1; ; page++) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const { res, body } = await politeFetch(`${API}/${endpoint}${sep}per_page=100&page=${page}`);
    items.push(...body);
    const totalPages = Number(res.headers.get('x-wp-totalpages') || 1);
    if (page >= totalPages) return items;
  }
}

const decodeEntities = (s) => cheerio.load(`<p>${s}</p>`)('p').text();

function localName(url) {
  const base = decodeURIComponent(new URL(url).pathname.split('/').pop());
  const ext = path.extname(base).toLowerCase();
  const stem = path
    .basename(base, path.extname(base))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${stem}${ext === '.jpeg' ? '.jpg' : ext}`;
}

// Pick the largest candidate from an <img> (WP thumbnails are named -300x300 etc).
function largestSrc($img) {
  const srcset = $img.attr('srcset');
  let best = $img.attr('src');
  if (srcset) {
    let bestW = 0;
    for (const part of srcset.split(',')) {
      const m = part.trim().match(/^(.*)\s+(\d+)w$/);
      if (m && Number(m[2]) > bestW) {
        bestW = Number(m[2]);
        best = m[1].trim();
      }
    }
  }
  return best;
}

function oldBlogPath(href) {
  try {
    const u = new URL(href, 'https://nanni.ai');
    if (!/(^|\.)(nanni|ubenwa)\.ai$/.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/(?:ask-Nanni-blog|our-blog)(\/.*)?$/i);
    return m ? m[1] || '/' : null;
  } catch {
    return null;
  }
}

function rewriteOldLink(href, slugs, catSlugs) {
  const p = oldBlogPath(href);
  if (p === null) return null;
  let m = p.match(/^\/\d{4}\/\d{2}\/\d{2}\/([^/]+)\/?$/) || p.match(/^\/([^/]+)\/?$/);
  if (m) {
    const slug = SLUG_ALIASES[m[1]] || m[1];
    if (slugs.has(slug)) return `/stories/${slug}/`;
  }
  m = p.match(/^\/category\/(?:.*\/)?([^/]+)\/?$/);
  if (m && catSlugs.has(m[1])) return `/stories/category/${m[1]}/`;
  return '/stories/';
}

// Turn the Pagelayer page body into plain HTML that the generic cleanup understands.
function pagelayerToHtml(pageHtml, ctx) {
  const $ = cheerio.load(pageHtml);
  const $c = $('.entry-content').not('.ast-related-post-excerpt').first();
  if (!$c.length) throw new Error(`No .entry-content on ${ctx.slug}`);

  $c.find('style, script, noscript').remove();
  $c.find('.addtoany_share_save_container, .a2a_kit, .pagelayer-wp_a2a_share_save_widget, .pagelayer-post_props, .pagelayer-social').remove();
  $c.find('.pagelayer-btn').each((_, el) => {
    ctx.edits.push(`Removed “${$(el).text().trim()}” button (replaced by the app-download CTA)`);
    $(el).remove();
  });
  $c.find('.ml-form-embedContainer, .textwidget').each((_, el) => {
    if (/ml-form|mailerlite/i.test($.html(el))) ctx.edits.push('Removed MailerLite newsletter signup embed (replaced by the app-download CTA)');
    $(el).remove();
  });
  $c.find('.mailpoet_form, [class*="mailpoet_form_popup"]').each((_, el) => {
    ctx.edits.push('Removed MailPoet newsletter signup form (replaced by the app-download CTA)');
    $(el).remove();
  });
  $c.find('p').each((_, el) => {
    if (/^Connect with us on Social Media$/i.test($(el).text().trim())) {
      ctx.edits.push('Removed “Connect with us on Social Media” label (its icon links were Pagelayer widgets)');
      $(el).remove();
    }
  });

  // Images with captions → <figure>.
  $c.find('.pagelayer-image').each((_, el) => {
    const $img = $(el).find('img').first();
    const caption = $(el).find('.pagelayer-image-caption').text().trim();
    $(el).replaceWith(caption ? `<figure>${$.html($img)}<figcaption>${caption}</figcaption></figure>` : `<p>${$.html($img)}</p>`);
  });

  // Accordions (used for "Sources") → heading + list of links.
  $c.find('.pagelayer-accordion_item').each((_, el) => {
    const title = $(el).find('.pagelayer-accordion-title').first().text().trim();
    const items = $(el)
      .find('.pagelayer-list-li, li')
      .toArray()
      .map((li) => {
        const $a = $(li).find('a[href]').first();
        const text = $(li).text().replace(/\s+/g, ' ').trim();
        return $a.length ? `<li><a href="${$a.attr('href')}">${text}</a></li>` : `<li>${text}</li>`;
      });
    const body = items.length ? `<ul>${items.join('')}</ul>` : $(el).find('.pagelayer-accordion-panel').html();
    $(el).replaceWith(`<h6 data-section>${title}</h6>${body}`);
  });
  $c.find('.pagelayer-list-li').each((_, el) => {
    const $a = $(el).find('a[href]').first();
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    $(el).replaceWith($a.length ? `<li><a href="${$a.attr('href')}">${text}</a></li>` : `<li>${text}</li>`);
  });

  return $c.html();
}

function cleanHtml(html, ctx) {
  const { edits } = ctx;

  // MailerLite embeds and other block-attribute junk leaked into the content as JSON
  // text: {“title”:””,”content”:”<style>…<form>…</form><script>…”}
  html = html.replace(/\{&#8220;title&#8221;[\s\S]*?&#82(?:20|21);\}/g, (m) => {
    if (/mailerlite|ml-form/i.test(m)) edits.push('Removed MailerLite newsletter signup embed (replaced by the app-download CTA)');
    else edits.push('Removed leftover block attribute text {“title”:””}');
    return '';
  });

  const $ = cheerio.load(html, null, false);

  $('style, script, noscript, form, input, button, iframe').each((_, el) => {
    edits.push(`Removed <${el.tagName}> element`);
    $(el).remove();
  });

  // Inline “Interested in tracking …?” promos become the app-download CTA.
  $('p').each((_, el) => {
    const $p = $(el);
    const strong = $p.find('strong, b').first().text().trim();
    if (/^Interested in\b/i.test(strong) && !ctx.cta) {
      const rest = $p.text().replace(strong, '').replace(/\s+/g, ' ').trim();
      ctx.cta = { heading: strong, text: rest };
      $p.replaceWith('<p>@@APPCTA@@</p>');
      edits.push(`Replaced inline promo “${strong}” with the app-download CTA box`);
    }
  });

  // The per-post disclaimer is now part of the post template.
  $('p').each((_, el) => {
    if (/^The information provided on this site is intended for informational purposes only/i.test($(el).text().trim())) {
      $(el).remove();
      edits.push('Removed in-body medical disclaimer (the template adds a standard one)');
    }
  });

  // Keep bold/italic expressed through inline styles, then unwrap presentational wrappers.
  $('span, font').each((_, el) => {
    const style = $(el).attr('style') || '';
    if (/font-weight:\s*(bold|[6-9]00)/i.test(style) && $(el).text().trim()) $(el).wrapInner('<strong></strong>');
    if (/font-style:\s*italic/i.test(style) && $(el).text().trim()) $(el).wrapInner('<em></em>');
  });
  // Unwrap layout/presentational wrappers.
  for (let i = 0; i < 5; i++) {
    $('div, span, font, section').each((_, el) => {
      $(el).replaceWith($(el).contents());
    });
  }

  // Strip WP classes, inline styles and other attributes.
  $('*').each((_, el) => {
    const keep = {
      a: ['href'],
      img: ['src', 'srcset', 'alt', 'width', 'height'],
      h6: ['data-section'],
      ol: ['start'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan'],
    }[el.tagName] || [];
    for (const name of Object.keys(el.attribs || {})) {
      if (!keep.includes(name)) $(el).removeAttr(name);
    }
  });

  // Headings that only wrap an image are not headings.
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const $h = $(el);
    if (!$h.text().replace(/ /g, ' ').trim()) {
      if ($h.find('img').length) $h.replaceWith(`<p>${$h.html()}</p>`);
      else $h.remove();
      return;
    }
    $h.find('strong, b, em, i').each((_, inner) => $(inner).replaceWith($(inner).contents()));
    $h.find('br').remove();
  });

  // Hand-made tables of contents are replaced by the generated one.
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    if (/^(article content|table of contents|contents)$/i.test($(el).text().trim())) {
      const $list = $(el).nextAll('ul, ol').first();
      if ($list.length && $list.find('a[href^="#"]').length === $list.find('a').length) $list.remove();
      $(el).remove();
      edits.push('Removed hand-made “Article Content” list (replaced by the generated table of contents; its anchor was broken)');
    }
  });

  // Normalise heading levels so the body starts at H2 (the page title is the H1).
  // The section level is the highest level used at least twice; one-off headings above it
  // (a stray H2/H3 in a post of H4 sections) become sections too. Lower levels follow on.
  const $heads = $('h1, h2, h3, h4, h5, h6').not('[data-section]');
  const counts = {};
  $heads.each((_, el) => (counts[el.tagName[1]] = (counts[el.tagName[1]] || 0) + 1));
  const levels = Object.keys(counts).map(Number).sort();
  const sectionLevel = levels.find((l) => counts[l] >= 2) ?? levels[0];
  const levelMap = {};
  for (const l of levels) levelMap[l] = l <= sectionLevel ? 2 : Math.min(2 + levels.filter((x) => x > sectionLevel && x <= l).length, 6);
  $heads.each((_, el) => {
    el.tagName = `h${levelMap[Number(el.tagName[1])]}`;
  });
  $('h6[data-section]').each((_, el) => {
    el.tagName = 'h2';
    $(el).removeAttr('data-section');
  });
  if (levels.some((l) => levelMap[l] !== l)) edits.push(`Normalised heading levels (${levels.map((l) => `H${l}→H${levelMap[l]}`).join(', ')})`);

  // Links: unwrap anchors around headings, drop empty ones, merge split ones, tidy hrefs.
  $('a').each((_, el) => {
    const $a = $(el);
    if ($a.find('h1, h2, h3, h4, h5, h6, p').length) $a.replaceWith($a.contents());
    else if (!$a.text().trim() && !$a.find('img').length) $a.remove();
  });
  $('a[href]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href').trim().replace(/(%20)+$/i, '');
    if (href !== $a.attr('href')) edits.push(`Fixed trailing space in link ${href}`);
    $a.attr('href', href);
  });
  // Links split in two by the editor (same href, adjacent) are merged.
  $('a[href]').each((_, el) => {
    let next = el.nextSibling;
    while (next && next.type === 'text' && !next.data.trim()) next = next.nextSibling;
    if (next && next.type === 'tag' && next.tagName === 'a' && $(next).attr('href') === $(el).attr('href')) {
      $(next).prepend($(el).contents());
      $(el).remove();
    }
  });
  // URL-as-text links that were broken across lines show the clean URL.
  $('a[href]').each((_, el) => {
    const $a = $(el);
    const text = $a.text().replace(/\s+/g, '');
    if (/^https?:\/\//.test(text) && $a.html() !== $a.attr('href')) $a.text($a.attr('href'));
  });

  // Rewrite links to the old blog.
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const to = rewriteOldLink(href, ctx.slugs, ctx.catSlugs);
    if (to) {
      $(el).attr('href', to);
      edits.push(`Rewrote link ${href} → ${to}`);
    }
  });

  // Images → local copies.
  $('img').each((_, el) => {
    const $img = $(el);
    const src = largestSrc($img);
    if (!src) return $img.remove();
    const name = localName(src);
    ctx.images.push({ url: src, name });
    const width = Number($img.attr('width')) || null;
    $img.attr('src', `/stories/images/${ctx.slug}/${name}`);
    $img.removeAttr('srcset');
    $img.removeAttr('height');
    if (width) $img.attr('width', String(width));
    if (!$img.attr('alt')) $img.attr('alt', '');
  });

  // Empty paragraphs and stray <br>s at the end of blocks.
  $('p, li').each((_, el) => {
    const $el = $(el);
    while ($el.contents().last().is('br') || ($el.contents().last()[0]?.type === 'text' && !$el.contents().last().text().trim() && $el.contents().length > 1)) {
      $el.contents().last().remove();
    }
  });
  $('p').each((_, el) => {
    const $p = $(el);
    if (!$p.text().replace(/ /g, ' ').trim() && !$p.find('img').length) $p.remove();
  });
  $('h1, h2, h3, h4, h5, h6, ul, ol').each((_, el) => {
    if (!$(el).text().trim() && !$(el).find('img').length) $(el).remove();
  });

  return $.html();
}

function toMarkdown(html) {
  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    codeBlockStyle: 'fenced',
  });
  td.use(gfm);
  td.keep(['sup', 'sub', 'figure']);
  td.addRule('img', {
    filter: 'img',
    replacement: (_, node) => {
      const alt = (node.getAttribute('alt') || '').replace(/[\[\]]/g, '');
      const width = node.getAttribute('width');
      const src = node.getAttribute('src');
      return width
        ? `\n\n<img src="${src}" alt="${alt.replace(/"/g, '&quot;')}" width="${width}">\n\n`
        : `![${alt}](${src})`;
    },
  });
  let md = td.turndown(html);
  md = md
    .replace(/ /g, ' ')
    .replace(/(\w)\*\*\*\*(\w)/g, '$1$2')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/^ (?![-*+]|\d+\.)/gm, '')
    .replace(/^\s*@@APPCTA@@\s*$/m, '<!-- app-cta -->')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return `${md}\n`;
}

const yamlString = (v) => JSON.stringify(v ?? '');
const yamlList = (arr) => `[${arr.map(yamlString).join(', ')}]`;

function frontMatter(fm) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) lines.push(`${k}: ${yamlList(v)}`);
    else if (typeof v === 'number') lines.push(`${k}: ${v}`);
    else lines.push(`${k}: ${yamlString(v)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function excerptFrom(md, fallback) {
  const para = md
    .split(/\n{2,}/)
    .find((b) => !/^(#|<|!\[|- |\d+\. |>)/.test(b.trim()) && b.trim().length > 60);
  const text = (para || fallback || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= 200) return text;
  return `${text.slice(0, 200).replace(/\s+\S*$/, '')}…`;
}

async function download(url, dest) {
  try {
    await fs.access(dest);
    return 'cached';
  } catch {}
  const encoded = encodeURI(decodeURI(url));
  let { body } = await politeFetch(encoded, { as: 'binary' });
  // Originals are only the fallback for browsers without WebP, so cap them at the largest
  // size the pages use instead of committing multi-megabyte camera files and screenshots.
  const meta = await sharp(body).metadata();
  const heavyPng = meta.format === 'png' && body.length > 300_000;
  if (meta.width > MAX_ORIGINAL_WIDTH || heavyPng) {
    body = await sharp(body)
      .rotate()
      .resize({ width: MAX_ORIGINAL_WIDTH, withoutEnlargement: true })
      .toFormat(meta.format, meta.format === 'jpeg' ? { quality: 82, mozjpeg: true } : meta.format === 'png' ? { palette: true, quality: 90, effort: 10 } : {})
      .toBuffer();
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, body);
  return 'downloaded';
}

async function main() {
  console.log('Fetching categories, tags and posts…');
  const categories = (await fetchAll('categories')).sort((a, b) => a.id - b.id);
  const posts = (await fetchAll('posts?_embed&status=publish')).sort((a, b) => a.id - b.id);

  const catById = new Map(categories.map((c) => [c.id, c]));
  const usedCats = categories.filter((c) => c.count > 0);
  const catSlugs = new Set(usedCats.map((c) => c.slug));
  const slugs = new Set(posts.map((p) => p.slug));

  await fs.mkdir(IMAGE_DIR, { recursive: true });
  await fs.mkdir(CONTENT_DIR, { recursive: true });
  const report = {};

  for (const post of posts) {
    const ctx = { slug: post.slug, slugs, catSlugs, edits: [], images: [], cta: null };
    const { body: page } = await politeFetch(post.link, { as: 'text' });
    const body = toMarkdown(cleanHtml(pagelayerToHtml(page, ctx), ctx));

    const leftovers = body.replace(/!?\[[^\]]*\]\([^)]*\)/g, '').match(/\[[^\]\n]*\]/g);
    if (leftovers) ctx.edits.push(`Kept bracketed text: ${leftovers.join(' ')}`);

    // Featured image: embedded media, else Yoast og:image (media can be private).
    const media = post._embedded?.['wp:featuredmedia']?.[0];
    const heroUrl = media?.source_url || post.yoast_head_json?.og_image?.[0]?.url;
    let hero;
    if (heroUrl) {
      const name = localName(heroUrl);
      ctx.images.push({ url: heroUrl, name });
      hero = `/stories/images/${post.slug}/${name}`;
    }

    const cats = post.categories
      .map((id) => catById.get(id))
      .filter((c) => c && c.count > 0)
      .sort((a, b) => (a.parent === 0 ? 0 : 1) - (b.parent === 0 ? 0 : 1));

    const title = decodeEntities(post.title.rendered).trim();
    const yoast = post.yoast_head_json || {};
    const words = body.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    const fm = {
      title,
      slug: post.slug,
      date: post.date,
      updated: post.modified,
      categories: cats.map((c) => c.slug),
      tags: (post._embedded?.['wp:term']?.[1] || []).map((t) => t.slug),
      excerpt: excerptFrom(body, decodeEntities(post.excerpt.rendered)),
      seo_title: (yoast.title || title).replace(/\s+[-–|]\s+Nanni Blog$/i, ''),
      seo_description: yoast.description || yoast.og_description || '',
      hero_image: hero,
      hero_alt: (media?.alt_text || '').trim() || title,
      reading_minutes: Math.max(1, Math.round(words / 220)),
      cta_heading: ctx.cta?.heading,
      cta_text: ctx.cta?.text,
      wp_id: post.id,
      wp_url: post.link,
    };

    for (const img of ctx.images) {
      const status = await download(img.url, path.join(IMAGE_DIR, post.slug, img.name));
      if (status === 'downloaded') console.log(`  ↓ ${post.slug}/${img.name}`);
    }

    await fs.writeFile(path.join(CONTENT_DIR, `${post.slug}.md`), frontMatter(fm) + body);
    report[post.slug] = [...new Set(ctx.edits)];
    console.log(`✓ ${post.slug} (${words} words, ${ctx.images.length} images)`);
  }

  // Category metadata the build needs (names, hierarchy, descriptions).
  // Empty categories are kept so the redirect map can cover their old URLs.
  const catMeta = [...categories]
    .sort((a, b) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug))
    .map((c) => ({
      slug: c.slug,
      name: decodeEntities(c.name),
      parent: c.parent ? catById.get(c.parent)?.slug ?? null : null,
      wp_url: c.link,
    }));
  await fs.writeFile(path.join(CONTENT_DIR, '_categories.json'), `${JSON.stringify(catMeta, null, 2)}\n`);
  const tags = (await fetchAll('tags')).map((t) => ({ slug: t.slug, name: decodeEntities(t.name), wp_url: t.link }));
  await fs.writeFile(path.join(CONTENT_DIR, '_tags.json'), `${JSON.stringify(tags, null, 2)}\n`);
  await fs.writeFile(path.join(CONTENT_DIR, '_export-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Done: ${posts.length} posts, ${catMeta.length} categories.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
