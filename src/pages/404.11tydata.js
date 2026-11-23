// The global 404 page renders in the default locale and lists the other enabled languages below.
export default {
  eleventyComputed: {
    locale: (data) => data.locales.find((l) => l.isDefault),
  },
};
