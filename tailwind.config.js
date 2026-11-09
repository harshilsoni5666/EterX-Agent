module.exports = {
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ["Segoe UI", "-apple-system", "BlinkMacSystemFont", "Arial", "sans-serif"],
        mono: ["var(--font-mono)"],
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic": "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
      },
      colors: {
        eterx: {
          bg: "#050505",
          surface: "#111111",
          border: "#242424",
          muted: "#6B6966",
          text: "#E8E6E3",
          accent: "#E2765A",
        },
      },
      animation: {
        "spin-slow": "spin 2s linear infinite",
      },
    },
  },
  plugins: [],
};
