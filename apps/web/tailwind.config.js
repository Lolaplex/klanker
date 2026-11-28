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
        main: "rgb(var(--bg-main-rgb) / <alpha-value>)",
        surface: "rgb(var(--bg-surface-rgb) / <alpha-value>)",
        elevated: "rgb(var(--bg-elevated-rgb) / <alpha-value>)",
        hover: "rgb(var(--bg-hover-rgb) / <alpha-value>)",
        subtle: "rgb(var(--border-subtle-rgb) / <alpha-value>)",
        strong: "rgb(var(--border-strong-rgb) / <alpha-value>)",
        ink: {
          DEFAULT: "rgb(var(--ink-primary-rgb) / <alpha-value>)",
          primary: "rgb(var(--ink-primary-rgb) / <alpha-value>)",
          secondary: "rgb(var(--ink-secondary-rgb) / <alpha-value>)",
          muted: "rgb(var(--ink-muted-rgb) / <alpha-value>)",
          dim: "rgb(var(--ink-dim-rgb) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--accent-rgb) / <alpha-value>)",
          ink: "rgb(var(--accent-ink-rgb) / <alpha-value>)",
          hover: "rgb(var(--accent-hover-rgb) / <alpha-value>)",
        },
        danger: "rgb(var(--danger-rgb) / <alpha-value>)",
        warn: "rgb(var(--warn-rgb) / <alpha-value>)",
        success: "rgb(var(--success-rgb) / <alpha-value>)",
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
