import forms from "@tailwindcss/forms";

/** @type {import('tailwindcss').Config} */
export default {
  // Skanna BÅDE html och js — main.js bygger klasser dynamiskt (modellistan, kvalitetsvalen m.fl.).
  content: ["./src/**/*.{html,js}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Semantiska färger via CSS-variabler (input.css). Variabeln byter värde i mörkt
        // läge, så markupen behöver inga dark:-varianter.
        paper: "rgb(var(--c-paper) / <alpha-value>)",     // skrivbordet bakom pappret
        sheet: "rgb(var(--c-sheet) / <alpha-value>)",     // pappret: paneler, fält, text
        ink: "rgb(var(--c-ink) / <alpha-value>)",         // brödtext
        muted: "rgb(var(--c-muted) / <alpha-value>)",     // hjälptext, ≥ 4,5:1
        line: "rgb(var(--c-line) / <alpha-value>)",       // 1 px linjer i stället för skuggor
        control: "rgb(var(--c-control) / <alpha-value>)", // kanter på fält och spår: minst 3:1 mot underlaget (WCAG 1.4.11)
        tone: "rgb(var(--c-tone) / <alpha-value>)",       // markerad rad, hover
        primary: "rgb(var(--c-primary) / <alpha-value>)",
        "primary-hover": "rgb(var(--c-primary-hover) / <alpha-value>)",
        // Röd används bara för inspelning/stopp och för destruktiva val.
        rec: "rgb(var(--c-rec) / <alpha-value>)",
        warn: "rgb(var(--c-warn) / <alpha-value>)",
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', '"Segoe UI"', "system-ui", "sans-serif"],
        serif: ['"IBM Plex Serif"', "Georgia", "serif"],
        mono: ['"IBM Plex Mono"', "Consolas", "monospace"],
      },
      // Rektangulärt: 3 px på kontroller, 4 px på paneler. Inget runt.
      borderRadius: {
        DEFAULT: "3px", sm: "2px", md: "3px", lg: "4px",
        xl: "4px", "2xl": "4px", "3xl": "4px",
      },
      boxShadow: {
        DEFAULT: "none", sm: "none", md: "none", lg: "none", xl: "none", "2xl": "none",
      },
      fontSize: { xs: ["0.8125rem", "1.25rem"] },  // minsta text 13 px
    },
  },
  plugins: [forms],
};
