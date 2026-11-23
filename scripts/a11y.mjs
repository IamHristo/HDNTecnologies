#!/usr/bin/env node
// Browser checks for the built site (_site/): axe-core WCAG 2.2 AA scans, keyboard focus visibility,
// 320px reflow, reduced motion, console/CSP errors and third-party requests.
// Usage: node scripts/a11y.mjs [_site]   (requires: npx playwright install chromium)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";

const DIST = path.resolve(process.argv[2] ?? "_site");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".xml": "application/xml", ".txt": "text/plain; charset=utf-8" };

// Minimal static server that mimics GitHub Pages (directory index, root 404.html).
function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
      if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      if (!fs.existsSync(file)) {
        res.writeHead(404, { "content-type": TYPES[".html"] });
        return res.end(fs.readFileSync(path.join(root, "404.html")));
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const sitemap = fs.readFileSync(path.join(DIST, "sitemap.xml"), "utf8");
const pages = [...sitemap.matchAll(/<loc>https:\/\/hdntechnologies\.com([^<]*)<\/loc>/g)].map((m) => m[1]);
pages.push("/this-page-does-not-exist/at/depth/");

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 360, height: 780 },
];
const SCHEMES = ["light", "dark"];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

const failures = [];
const fail = (where, msg) => failures.push(`${where}: ${msg}`);

const server = await serve(DIST);
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

try {
  for (const vp of VIEWPORTS) {
    for (const scheme of SCHEMES) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: scheme,
      });
      for (const p of pages) {
        const where = `${p} [${vp.name}, ${scheme}]`;
        const page = await context.newPage();
        page.on("console", (msg) => {
          if (msg.type() !== "error") return;
          // The 404 test page is *expected* to return status 404 for the document itself.
          const isOwn404 = msg.location().url === origin + p && /status of 404/.test(msg.text());
          if (!isOwn404) fail(where, `console error: ${msg.text()}`);
        });
        page.on("pageerror", (err) => fail(where, `page error: ${err.message}`));
        page.on("request", (req) => {
          if (!req.url().startsWith(origin)) fail(where, `third-party request: ${req.url()}`);
        });

        await page.goto(origin + p, { waitUntil: "load" });

        // Open every disclosure so collapsed content is scanned too.
        await page.evaluate(() => document.querySelectorAll("details").forEach((d) => { d.open = true; }));

        const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
        for (const v of axe.violations) {
          const targets = v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ");
          fail(where, `axe ${v.impact} ${v.id}: ${v.help} -> ${targets}`);
        }

        // Reflow: no horizontal scrolling.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 0) fail(where, `horizontal overflow of ${overflow}px`);

        await page.close();
      }
      await context.close();
    }
  }

  // Keyboard: every Tab stop must be visible and show a focus indicator; first stop is the skip link.
  const kbContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  for (const p of pages) {
    const page = await kbContext.newPage();
    await page.goto(origin + p, { waitUntil: "load" });
    const seen = new Set();
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press("Tab");
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          key: el.outerHTML.slice(0, 80),
          cls: el.className,
          visible: r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && Number(cs.opacity) > 0,
          indicator: cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2,
        };
      });
      if (!info || seen.has(info.key)) break;
      seen.add(info.key);
      if (i === 0 && !String(info.cls).includes("skip-link")) fail(`${p} [keyboard]`, "first Tab stop is not the skip link");
      if (!info.visible) fail(`${p} [keyboard]`, `focused element is not visible: ${info.key}`);
      if (!info.indicator) fail(`${p} [keyboard]`, `no visible focus indicator: ${info.key}`);
    }
    if (seen.size < 3) fail(`${p} [keyboard]`, `only ${seen.size} focusable elements reached`);
    await page.close();
  }
  await kbContext.close();

  // Reduced motion: smooth scrolling and transitions are disabled.
  const rmContext = await browser.newContext({ reducedMotion: "reduce" });
  const rmPage = await rmContext.newPage();
  await rmPage.goto(origin + "/", { waitUntil: "load" });
  const rm = await rmPage.evaluate(() => ({
    scroll: getComputedStyle(document.documentElement).scrollBehavior,
    transition: getComputedStyle(document.querySelector(".btn")).transitionDuration,
  }));
  if (rm.scroll !== "auto") fail("/ [reduced motion]", `scroll-behavior is ${rm.scroll}`);
  if (!rm.transition.split(",").every((d) => parseFloat(d) <= 0.001)) fail("/ [reduced motion]", `transition-duration is ${rm.transition}`);
  await rmContext.close();

  // WCAG 1.4.10 reflow at 320 CSS px.
  const narrow = await browser.newContext({ viewport: { width: 320, height: 640 } });
  for (const p of pages) {
    const page = await narrow.newPage();
    await page.goto(origin + p, { waitUntil: "load" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) fail(`${p} [320px]`, `horizontal overflow of ${overflow}px`);
    await page.close();
  }
  await narrow.close();
} finally {
  await browser.close();
  server.close();
}

const runs = pages.length * VIEWPORTS.length * SCHEMES.length;
if (failures.length) {
  console.error(`a11y: ${failures.length} problem(s) across ${runs} page/viewport/scheme runs:\n  - ${[...new Set(failures)].join("\n  - ")}`);
  process.exit(1);
}
console.log(`a11y: OK – ${pages.length} pages x ${VIEWPORTS.length} viewports x ${SCHEMES.length} colour schemes (axe ${AXE_TAGS.join(", ")}), keyboard, 320px reflow, reduced motion`);
