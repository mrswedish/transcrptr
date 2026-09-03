import forms from "@tailwindcss/forms";
import typography from "@tailwindcss/typography";
import containerQueries from "@tailwindcss/container-queries";

/** @type {import('tailwindcss').Config} */
export default {
  // Skanna BÅDE html och js — main.js bygger klasser dynamiskt (REC_PILL-konstanterna,
  // syncWasapiVisual, modellistan, syncPickButtons m.fl.). Utan js här purgas de bort.
  content: ["./src/**/*.{html,js}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Region Jönköpings läns profilfärg, via CSS-variabler (definierade i
        // input.css). Variabeln byter värde i mörkt läge — därför behöver de ~77
        // primary-användningarna i markup INGEN egen dark:-variant.
        primary: "rgb(var(--c-primary) / <alpha-value>)",
        "primary-hover": "rgb(var(--c-primary-hover) / <alpha-value>)",
        "background-light": "#fcfcfc",
        "background-dark": "#0e1116",
        surface: "#ffffff",
        "surface-dark": "#161b22",
        // Semantisk inspelningsfärg — skild från accenten så "spelar in" förblir
        // entydigt även när profilrödan används i knappar och länkar.
        rec: "rgb(var(--c-rec) / <alpha-value>)",
      },
      fontFamily: {
        display: ["Inter", "sans-serif"],
      },
      borderRadius: {
        DEFAULT: "1rem",
      },
    },
  },
  plugins: [forms, typography, containerQueries],
};
