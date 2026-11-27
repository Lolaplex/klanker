/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      // Semantic monochrome tokens (klanker#170 U16): every color reads
      // a CSS custom property so [data-theme="light"] inverts the whole
      // app without a single class change. Flat keys produce the exact
      // utility names the design system specifies (bg-main, bg-surface,
      // bg-elevated, bg-hover, border-subtle, border-strong, text-ink-*,
      // bg-accent, text-accent-ink).
      colors: {
        main: "var(--bg-main)",
        surface: "var(--bg-surface)",
        elevated: "var(--bg-elevated)",
        hover: "var(--bg-hover)",
        subtle: "var(--border-subtle)",
        strong: "var(--border-strong)",
        ink: {
          DEFAULT: "var(--ink-primary)",
          primary: "var(--ink-primary)",
          secondary: "var(--ink-secondary)",
          muted: "var(--ink-muted)",
          dim: "var(--ink-dim)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          ink: "var(--accent-ink)",
          hover: "var(--accent-hover)",
        },
        danger: "var(--danger)",
        warn: "var(--warn)",
        success: "var(--success)",
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
