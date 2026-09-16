import type { Config } from 'tailwindcss';

/**
 * The palette is lifted from the live site (index.html) so the back office looks
 * like it belongs to the same business — but this is a tool, not a brochure:
 * bigger type, flatter surfaces, no motion that costs a receptionist a tap.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        cream: '#FBF6EF',
        oat: { DEFAULT: '#F2E9DC', light: '#F5EDE1', dark: '#EDE0CE' },
        line: { DEFAULT: '#E6D8C4', strong: '#DCC8AC' },
        teal: {
          50: '#EDF7F5',
          100: '#D7EDE9',
          300: '#9FD6CD',
          500: '#5FB8AC',
          600: '#3E9A8E',
          700: '#2A6E66',
          900: '#1C4A45',
        },
        gold: { DEFAULT: '#C08A43', light: '#F0C283', pale: '#F8ECD8', deep: '#9A6D33' },
        ink: { DEFAULT: '#26241F', soft: '#3A362F', muted: '#6E675D' },
        // A warm terracotta rather than a web red: it carries urgency without
        // fighting the candlelit palette.
        alert: { DEFAULT: '#B4472F', deep: '#8E3522', pale: '#FBEBE6', line: '#EFC9BD' },
      },
      fontFamily: {
        serif: ['"Cormorant Garamond"', 'Georgia', '"Times New Roman"', 'serif'],
        sans: ['Jost', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: { DEFAULT: '8px', sheet: '18px' },
      boxShadow: {
        sm: '0 1px 3px rgba(58,40,26,.05)',
        md: '0 6px 20px rgba(58,40,26,.07)',
        lg: '0 18px 44px rgba(58,40,26,.10)',
        sheet: '0 -10px 60px rgba(27,26,23,.18)',
      },
      letterSpacing: { label: '.14em', eyebrow: '.24em' },
    },
  },
  plugins: [],
};

export default config;
