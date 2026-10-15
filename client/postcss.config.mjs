/**
 * Tailwind v4's PostCSS plugin. It only acts on stylesheets that import
 * Tailwind — today that is src/app/tailwind.css alone — so globals.css,
 * admin.css, portal.css and desk.css pass through untouched.
 */
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
