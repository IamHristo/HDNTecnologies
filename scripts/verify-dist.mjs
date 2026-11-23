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
for (const req of ["index.html", "404.html", "robots.txt", "sitemap.xml", "CNAME"]) {
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

  // JSON-LD blocks must be valid JSON.
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
