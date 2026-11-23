import fs from "node:fs";
import path from "node:path";

const SRC = "src";
const DATA_DIR = path.join(SRC, "_data");
const I18N_DIR = path.join(DATA_DIR, "i18n");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** Collect every leaf path of a nested object/array, e.g. "home.hero.title" or "home.facts.items.0". */
function leafPaths(value, prefix = "") {
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) =>
      leafPaths(child, prefix ? `${prefix}.${key}` : key),
    );
  }
  return [prefix];
}

/**
 * Load locales, page paths and translation strings, and fail the build if any
 * enabled locale is missing (or has extra) keys compared to the default locale.
 * A non-default page must never silently fall back to English.
 */
function loadI18n() {
  const locales = readJson(path.join(DATA_DIR, "locales.json"));
  const pages = readJson(path.join(DATA_DIR, "pages.json"));
  const defaults = locales.filter((l) => l.isDefault);
  if (defaults.length !== 1) {
    throw new Error(`locales.json must mark exactly one locale as isDefault (found ${defaults.length}).`);
  }
  const defaultLocale = defaults[0];

  const strings = {};
  for (const locale of locales) {
    const file = path.join(I18N_DIR, `${locale.code}.json`);
    if (!fs.existsSync(file)) {
      throw new Error(`Locale "${locale.code}" is enabled in locales.json but ${file} does not exist.`);
    }
    strings[locale.code] = readJson(file);
  }

  const reference = new Set(leafPaths(strings[defaultLocale.code]));
  for (const locale of locales) {
    if (locale.code === defaultLocale.code) continue;
    const keys = new Set(leafPaths(strings[locale.code]));
    const missing = [...reference].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !reference.has(k));
    if (missing.length || extra.length) {
      throw new Error(
        `Translation "${locale.code}" does not match "${defaultLocale.code}".\n` +
          (missing.length ? `  Missing keys:\n    ${missing.join("\n    ")}\n` : "") +
          (extra.length ? `  Extra keys:\n    ${extra.join("\n    ")}\n` : ""),
      );
    }
  }

  const site = readJson(path.join(DATA_DIR, "site.json"));
  return { locales, pages, strings, defaultLocale, site };
}

/**
 * Build the schema.org JSON-LD graph for a page in one locale. All text comes from the same
 * translation strings that render the visible page, so structured data always matches the content.
 */
function structuredData(i18n, pageKey, lang) {
  const { site, strings, locales, pages } = i18n;
  const s = strings[lang];
  const locale = locales.find((l) => l.code === lang);
  const urlOf = (key) => `${site.url}${locale.prefix}${pages[key]}`;
  const orgId = `${site.url}/#organization`;
  const siteId = `${site.url}/#website`;
  const pageUrl = urlOf(pageKey);

  const areaServed = [
    { "@type": "Country", name: "Bulgaria", sameAs: "https://www.wikidata.org/wiki/Q219" },
    { "@type": "AdministrativeArea", name: "European Union", sameAs: "https://www.wikidata.org/wiki/Q458" },
  ];

  const organization = {
    "@type": ["Organization", "ProfessionalService"],
    "@id": orgId,
    name: site.brand,
    legalName: site.legalName,
    alternateName: site.legalNameLatin,
    url: `${site.url}/`,
    logo: { "@type": "ImageObject", url: `${site.url}${site.logo}`, width: 512, height: 512 },
    image: `${site.url}${site.ogImage}`,
    description: s.home.description,
    email: site.email,
    foundingDate: site.foundingDate,
    vatID: site.vatId,
    identifier: { "@type": "PropertyValue", propertyID: "EIK", value: site.eik },
    address: {
      "@type": "PostalAddress",
      addressLocality: site.locality,
      addressRegion: site.locality,
      postalCode: site.postalCode,
      addressCountry: site.countryCode,
    },
    areaServed,
    knowsAbout: site.knowsAbout,
    knowsLanguage: site.workingLanguages,
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "sales",
      email: site.email,
      availableLanguage: site.workingLanguages,
    },
    sameAs: [site.linkedin, site.commercialRegisterUrl],
  };

  const website = {
    "@type": "WebSite",
    "@id": siteId,
    url: `${site.url}/`,
    name: site.brand,
    inLanguage: locales.map((l) => l.hreflang),
    publisher: { "@id": orgId },
  };

  const webpage = {
    "@type": "WebPage",
    "@id": `${pageUrl}#webpage`,
    url: pageUrl,
    // The visible page heading, not the <title> (which carries the brand suffix).
    name: pageKey === "home" ? s.home.hero.title : s[pageKey].heading,
    description: s[pageKey].description,
    inLanguage: locale.hreflang,
    isPartOf: { "@id": siteId },
    about: { "@id": orgId },
  };

  const graph = [organization, website, webpage];

  if (pageKey === "services") {
    for (const item of s.services.items) {
      graph.push({
        "@type": "Service",
        "@id": `${pageUrl}#service-${item.id}`,
        url: `${pageUrl}#service-${item.id}`,
        name: item.title,
        serviceType: item.title,
        description: item.summary,
        provider: { "@id": orgId },
        areaServed,
      });
    }
  }

  if (pageKey === "caseTeleservice") {
    const c = s.caseTeleservice;
    graph.push({
      "@type": "Article",
      "@id": `${pageUrl}#article`,
      headline: c.heading,
      description: c.description,
      inLanguage: locale.hreflang,
      image: `${site.url}${site.ogImage}`,
      author: { "@id": orgId },
      publisher: { "@id": orgId },
      mainEntityOfPage: { "@id": `${pageUrl}#webpage` },
      about: s.services.items.map((item) => ({ "@id": `${urlOf("services")}#service-${item.id}` })),
      // Emitted only once a real publication date is recorded in site.json; never invented.
      ...(site.casePublished ? { datePublished: site.casePublished } : {}),
    });
  }

  if (pageKey === "home") {
    graph.push({
      "@type": "FAQPage",
      "@id": `${pageUrl}#faq`,
      inLanguage: locale.hreflang,
      isPartOf: { "@id": `${pageUrl}#webpage` },
      mainEntity: s.home.faq.items.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    });
  } else {
    const breadcrumbId = `${pageUrl}#breadcrumb`;
    webpage.breadcrumb = { "@id": breadcrumbId };
    graph.push({
      "@type": "BreadcrumbList",
      "@id": breadcrumbId,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: s.common.breadcrumbHome, item: urlOf("home") },
        { "@type": "ListItem", position: 2, name: s[pageKey].heading, item: pageUrl },
      ],
    });
  }

  // Escape "<" so the JSON can never close the surrounding <script> element.
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }, null, 2).replace(/</g, "\\u003c");
}

export default function (eleventyConfig) {
  let i18n = loadI18n();
  // Reload translations on every build so `npm run serve` picks up JSON edits.
  eleventyConfig.on("eleventy.before", () => {
    i18n = loadI18n();
  });
  eleventyConfig.addWatchTarget(I18N_DIR);

  eleventyConfig.setNunjucksEnvironmentOptions({
    autoescape: true,
    throwOnUndefined: true,
    trimBlocks: true,
    lstripBlocks: true,
  });

  /** Translate a dotted key for a locale; throws on any missing key. */
  eleventyConfig.addFilter("t", (key, lang) => {
    const value = key.split(".").reduce((node, part) => (node == null ? undefined : node[part]), i18n.strings[lang]);
    if (value === undefined) {
      throw new Error(`Missing translation "${key}" for locale "${lang}".`);
    }
    return value;
  });

  /** Site-relative URL of a page (by key from pages.json) in a given locale. */
  eleventyConfig.addFilter("localeUrl", (pageKey, lang) => {
    const locale = i18n.locales.find((l) => l.code === lang);
    if (!locale) throw new Error(`Unknown locale "${lang}".`);
    if (!(pageKey in i18n.pages)) throw new Error(`Unknown page key "${pageKey}" (see pages.json).`);
    return `${locale.prefix}${i18n.pages[pageKey]}`;
  });

  /** Every locale version of a page, used for hreflang, the sitemap and the language switcher. */
  eleventyConfig.addFilter("alternates", (pageKey) => {
    if (!(pageKey in i18n.pages)) throw new Error(`Unknown page key "${pageKey}" (see pages.json).`);
    return i18n.locales.map((l) => ({ ...l, url: `${l.prefix}${i18n.pages[pageKey]}` }));
  });

  /**
   * mailto: link with a prefilled subject carrying a source tag, e.g. "Project enquiry · ref: hero-en".
   * The site has no analytics, so the tag in the subject is how enquiries are attributed to a link.
   */
  eleventyConfig.addFilter("mailto", (ref, lang) => {
    if (!/^[a-z0-9-]+$/.test(ref)) throw new Error(`Invalid mailto ref "${ref}" (use a-z, 0-9, -).`);
    const subject = `${i18n.strings[lang].home.contact.mailSubject} · ref: ${ref}-${lang}`;
    return `mailto:${i18n.site.email}?subject=${encodeURIComponent(subject)}`;
  });

  /** schema.org JSON-LD for a page; output with `| safe` inside <script type="application/ld+json">. */
  eleventyConfig.addFilter("structuredData", (pageKey, lang) => structuredData(i18n, pageKey, lang));

  eleventyConfig.addGlobalData("build", { year: new Date().getFullYear() });

  // Static files copied as-is to the site root.
  eleventyConfig.addPassthroughCopy({ [`${SRC}/assets`]: "assets" });
  eleventyConfig.addPassthroughCopy({ [`${SRC}/CNAME`]: "CNAME" });
  eleventyConfig.addPassthroughCopy({ [`${SRC}/robots.txt`]: "robots.txt" });
  eleventyConfig.addPassthroughCopy({ [`${SRC}/.well-known/security.txt`]: ".well-known/security.txt" });
  return {
    dir: {
      input: SRC,
      includes: "_includes",
      data: "_data",
      output: "_site",
    },
    templateFormats: ["njk"],
    htmlTemplateEngine: "njk",
  };
}
