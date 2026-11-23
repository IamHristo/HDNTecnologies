#!/usr/bin/env node
// Zero-dependency guard for the built site (_site/). Fails CI if the output would leak internal
// files, load third-party resources, run scripts, or break the static security baseline.
import fs from "node:fs";
import path from "node:path";

const DIST = path.resolve(process.argv[2] ?? "_site");
const SITE_ORIGIN = "https://hdntechnologies.com";
const errors = [];
const fail = (file, msg) => errors.push(`${path.relative(DIST, file) || "."}: ${msg}`);

if (!fs.existsSync(DIST)) {
  console.error(`verify-dist: ${DIST} does not exist – run the build first.`);
  process.exit(1);
}

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
const files = walk(DIST);
const rel = (f) => path.relative(DIST, f).split(path.sep).join("/");

// 1. Nothing internal may be published.
const forbidden = [/^README\.md$/i, /^\.vscode\//, /^\.github\//, /^\.git\//, /^node_modules\//, /^src\//,
  /^package(-lock)?\.json$/, /^eleventy\.config\./, /^scripts\//, /\.njk$/, /\.11tydata\.js$/, /^\.env/];
for (const f of files) {
  if (forbidden.some((re) => re.test(rel(f)))) fail(f, "internal file must not be published");
}

// 2. Required public files.
for (const req of ["index.html", "404.html", "robots.txt", "sitemap.xml", "llms.txt", "CNAME"]) {
  if (!fs.existsSync(path.join(DIST, req))) errors.push(`${req}: required file is missing`);
}

// 3. HTML rules.
const isExternal = (url) => /^(https?:)?\/\//i.test(url) && !url.startsWith(SITE_ORIGIN);
for (const f of files.filter((x) => x.endsWith(".html"))) {
  const html = fs.readFileSync(f, "utf8");

  if (!/<meta http-equiv="Content-Security-Policy" content="[^"]*default-src 'none'/.test(html)) {
    fail(f, "missing strict Content-Security-Policy meta tag");
  }
  if (!/<html lang="[a-z]{2}(-[A-Z]{2})?">/.test(html)) fail(f, "missing or invalid <html lang>");

  for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
    if (!/type="application\/ld\+json"/i.test(m[1])) fail(f, `executable <script> is not allowed: ${m[0]}`);
  }
  if (/\son[a-z]+\s*=/i.test(html.replace(/<script[\s\S]*?<\/script>/gi, ""))) fail(f, "inline event handler attribute");
  if (/\sstyle\s*=/i.test(html)) fail(f, "inline style attribute (blocked by CSP style-src 'self')");
  if (/<style\b/i.test(html)) fail(f, "inline <style> element (blocked by CSP style-src 'self')");
  if (/(href|src|action)\s*=\s*"\s*javascript:/i.test(html)) fail(f, "javascript: URL");
  if (/href\s*=\s*"(#)?"/i.test(html)) fail(f, 'empty or "#" link');

  // Resource-loading attributes must be same-origin.
  for (const m of html.matchAll(/<(img|script|iframe|source|video|audio|embed|object)\b[^>]*\s(?:src|srcset|data)="([^"]+)"/gi)) {
    if (isExternal(m[2])) fail(f, `third-party resource: ${m[2]}`);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const relAttr = (tag.match(/\srel="([^"]+)"/i) ?? [])[1] ?? "";
    const href = (tag.match(/\shref="([^"]+)"/i) ?? [])[1] ?? "";
    if (/stylesheet|icon|preload|modulepreload|prefetch|manifest/i.test(relAttr) && isExternal(href)) {
      fail(f, `third-party <link rel="${relAttr}">: ${href}`);
    }
  }

  // Outbound links must not leak the opener or referrer.
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const tag = m[0];
    const href = (tag.match(/\shref="([^"]+)"/i) ?? [])[1] ?? "";
    if (isExternal(href) && !/\srel="[^"]*noopener[^"]*noreferrer|\srel="[^"]*noreferrer[^"]*noopener/i.test(tag)) {
      fail(f, `external link without rel="noopener noreferrer": ${href}`);
    }
    if (/target="_blank"/i.test(tag) && !/noopener/i.test(tag)) fail(f, `target=_blank without noopener: ${href}`);
  }

  // Every same-origin asset referenced by the page must exist in the build.
  const refs = [
    ...[...html.matchAll(/<(?:img|source)\b[^>]*\ssrc="([^"]+)"/gi)].map((r) => r[1]),
    ...[...html.matchAll(/<link\b[^>]*\shref="([^"]+)"/gi)].map((r) => r[1]),
    ...[...html.matchAll(/<meta\b[^>]*property="og:image"[^>]*content="([^"]+)"/gi)].map((r) => r[1]),
  ];
  for (const ref of refs) {
    if (isExternal(ref) || /^(mailto:|#|data:)/.test(ref)) continue;
    const local = ref.replace(SITE_ORIGIN, "").split(/[?#]/)[0];
    const target = path.join(DIST, local, local.endsWith("/") ? "index.html" : "");
    if (!fs.existsSync(target)) fail(f, `referenced file does not exist: ${ref}`);
  }

  // JSON-LD blocks must be valid JSON; their same-origin image URLs must exist.
  for (const m of html.matchAll(/https:\/\/hdntechnologies\.com(\/assets\/[^"\s]+)/g)) {
    if (!fs.existsSync(path.join(DIST, m[1]))) fail(f, `structured-data asset does not exist: ${m[1]}`);
  }
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    try { JSON.parse(m[1]); } catch (e) { fail(f, `invalid JSON-LD: ${e.message}`); }
  }
}

// 4. CSS must not pull anything from other origins (fonts, @import, images).
for (const f of files.filter((x) => x.endsWith(".css"))) {
  const css = fs.readFileSync(f, "utf8");
  for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)|@import\s+["']([^"']+)["']/gi)) {
    const url = m[1] ?? m[2];
    if (isExternal(url)) fail(f, `third-party CSS resource: ${url}`);
  }
}

// Helpers for page-level checks below.
const htmlFiles = files.filter((x) => x.endsWith(".html"));
const pageFor = (urlPath) => {
  const clean = urlPath.replace(SITE_ORIGIN, "").split(/[?#]/)[0] || "/";
  return path.join(DIST, clean, clean.endsWith("/") ? "index.html" : "");
};
const urlFor = (file) => {
  const r = rel(file);
  if (r === "404.html") return null;
  return `${SITE_ORIGIN}/${r.replace(/index\.html$/, "")}`;
};
const idsCache = new Map();
const idsOf = (file) => {
  if (!idsCache.has(file)) {
    const html = fs.readFileSync(file, "utf8");
    idsCache.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  return idsCache.get(file);
};

// 6. Internal links (and their #fragments) must resolve.
for (const f of htmlFiles) {
  const html = fs.readFileSync(f, "utf8");
  for (const m of html.matchAll(/<a\b[^>]*\shref="([^"]+)"/gi)) {
    const href = m[1];
    if (/^(mailto:|tel:)/.test(href) || isExternal(href)) continue;
    const [p, frag] = href.split("#");
    const target = p ? pageFor(p) : f;
    if (!fs.existsSync(target)) { fail(f, `broken internal link: ${href}`); continue; }
    if (frag && !idsOf(target).has(frag)) fail(f, `link target #${frag} not found: ${href}`);
  }
  // aria-labelledby / aria-describedby / label[for] must point at existing ids on the same page.
  for (const m of html.matchAll(/\s(?:aria-labelledby|aria-describedby|aria-controls|for)="([^"]+)"/g)) {
    for (const id of m[1].split(/\s+/)) {
      if (!idsOf(f).has(id)) fail(f, `reference to missing id "${id}"`);
    }
  }
  // Duplicate ids.
  const all = [...html.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]);
  const dupes = all.filter((id, i) => all.indexOf(id) !== i);
  if (dupes.length) fail(f, `duplicate id(s): ${[...new Set(dupes)].join(", ")}`);
}

// 7. hreflang clusters must be reciprocal and self-referencing; canonical must point to itself.
const hreflangOf = (file) =>
  [...fs.readFileSync(file, "utf8").matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)]
    .map((m) => ({ lang: m[1], href: m[2] }));
for (const f of htmlFiles) {
  const self = urlFor(f);
  if (!self) continue;
  const html = fs.readFileSync(f, "utf8");
  const canonical = (html.match(/<link rel="canonical" href="([^"]+)">/) ?? [])[1];
  if (canonical && canonical !== self) fail(f, `canonical ${canonical} does not match page URL ${self}`);
  const alts = hreflangOf(f);
  if (!alts.length) continue;
  if (!alts.some((a) => a.href === self && a.lang !== "x-default")) fail(f, "hreflang set does not include the page itself");
  if (!alts.some((a) => a.lang === "x-default")) fail(f, "hreflang set has no x-default");
  for (const a of alts) {
    const target = pageFor(a.href);
    if (!fs.existsSync(target)) { fail(f, `hreflang target missing: ${a.href}`); continue; }
    if (!hreflangOf(target).some((b) => b.href === self)) fail(f, `hreflang not reciprocal: ${a.href} does not link back`);
  }
}

// 8. security.txt (RFC 9116): required fields and an Expires date in the future, at most a year ahead.
const securityTxt = path.join(DIST, ".well-known", "security.txt");
if (!fs.existsSync(securityTxt)) {
  errors.push(".well-known/security.txt: required file is missing");
} else {
  const txt = fs.readFileSync(securityTxt, "utf8");
  if (!/^Contact: (mailto:|https:)/m.test(txt)) fail(securityTxt, "missing Contact field");
  const expires = Date.parse((txt.match(/^Expires: (.+)$/m) ?? [])[1] ?? "");
  const now = Date.now();
  if (Number.isNaN(expires)) fail(securityTxt, "missing or invalid Expires field");
  else if (expires <= now) fail(securityTxt, "Expires date is in the past – renew it");
  else if (expires - now > 366 * 24 * 3600 * 1000) fail(securityTxt, "Expires date is more than a year ahead (RFC 9116 recommends < 1 year)");
}

// 5. Sitemap URLs must exist in the build.
const sitemap = path.join(DIST, "sitemap.xml");
if (fs.existsSync(sitemap)) {
  for (const m of fs.readFileSync(sitemap, "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const urlPath = m[1].replace(SITE_ORIGIN, "");
    const target = path.join(DIST, urlPath, urlPath.endsWith("/") ? "index.html" : "");
    if (!fs.existsSync(target)) fail(sitemap, `sitemap URL has no page: ${m[1]}`);
  }
}

if (errors.length) {
  console.error(`verify-dist: ${errors.length} problem(s) found:\n  - ${errors.join("\n  - ")}`);
  process.exit(1);
}
console.log(`verify-dist: OK (${files.length} files checked in ${path.relative(process.cwd(), DIST) || DIST})`);
