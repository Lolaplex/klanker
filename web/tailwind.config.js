/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#000000",
          surface: "#0a0a0a",
          card: "#121212",
          muted: "#181818",
          border: "#262626",
        },
        ink: {
          DEFAULT: "#ffffff",
          muted: "#a3a3a3",
          subtle: "#737373",
          dim: "#525252",
        },
      },
      fontFamily: {
        mono: [
          "Geist Mono",
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
}
