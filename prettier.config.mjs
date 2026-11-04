/** @type {import("prettier").Config & import("prettier-plugin-tailwindcss").PluginOptions} */
const config = {
  plugins: ["prettier-plugin-tailwindcss"],
  // Tailwind v4 reads the theme from the CSS entry point.
  tailwindStylesheet: "./src/app/globals.css",
};

export default config;
