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
        primary: "#2DD4BF",
        "background-light": "#F8FAFC",
        "background-dark": "#0F172A",
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
