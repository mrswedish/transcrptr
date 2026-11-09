import forms from "@tailwindcss/forms";

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
        "background-light": "#F6F5F2",
        "background-dark": "#14181B",
        surface: "#FFFFFF",
        "surface-dark": "#1C2125",
        // Varm neutral skala (ersätter Tailwinds blåaktiga slate): linje 200, dämpad text 500.
        slate: {
          50: "#F6F5F2", 100: "#EFEDE8", 200: "#DEDCD6", 300: "#C4C1BA",
          400: "#6B7177", 500: "#5A6067", 600: "#484E54", 700: "#343A40",
          800: "#2C3338", 900: "#1C2125", 950: "#14181B",
        },
        // Semantisk inspelningsfärg — skild från accenten så "spelar in" förblir
        // entydigt även när profilrödan används i knappar och länkar.
        rec: "rgb(var(--c-rec) / <alpha-value>)",
      },
      fontFamily: {
        display: ["Inter", "sans-serif"],
      },
      // 8 px på kontroller, 12 px på paneler — inget annat.
      borderRadius: {
        DEFAULT: "0.5rem", md: "0.5rem", lg: "0.5rem",
        xl: "0.75rem", "2xl": "0.75rem", "3xl": "0.75rem",
      },
      // Skillnad med linje och ton, inte skugga eller oskärpa.
      boxShadow: {
        DEFAULT: "none", sm: "none", md: "none", lg: "none", xl: "none", "2xl": "none",
      },
      fontSize: { xs: ["0.8125rem", "1.25rem"] },  // minsta text 13 px
    },
  },
  plugins: [forms],
};
