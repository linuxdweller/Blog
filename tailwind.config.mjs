/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
  theme: {
    extend: {
      backgroundImage: {
        arrow: "url('/arrow.svg')",
      },
      colors: {
        bg: {
          400: "#F2F1EC",
        },
        fg: {
          200: "#878787",
          300: "#7D7D7D",
          400: "#5B5B5B",
        },
      },
    },
  },
  plugins: [],
};
