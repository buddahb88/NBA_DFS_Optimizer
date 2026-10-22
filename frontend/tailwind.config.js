// Theme tokens are CSS variables (space-separated RGB channels) defined in
// src/styles/theme.css so Tailwind opacity modifiers (bg-surface/50) work and
// dark/light can be swapped at runtime by toggling the `dark` class on <html>.
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Legacy names kept so existing pages render unchanged.
        primary: '#1e40af',
        secondary: '#64748b',
        success: '#10b981',
        warning: '#f59e0b',
        danger: '#ef4444',

        // Surfaces & text
        canvas: token('canvas'), // app background
        surface: {
          DEFAULT: token('surface'), // cards, panels
          raised: token('surface-raised'), // hover rows, popovers
          sunken: token('surface-sunken'), // inputs, table header
        },
        line: {
          DEFAULT: token('line'),
          strong: token('line-strong'),
        },
        fg: {
          DEFAULT: token('fg'),
          muted: token('fg-muted'),
          subtle: token('fg-subtle'),
          inverted: token('fg-inverted'),
        },

        // Brand / interactive
        accent: {
          DEFAULT: token('accent'),
          hover: token('accent-hover'),
          fg: token('accent-fg'),
          soft: token('accent-soft'),
        },

        // Semantic: value / ownership / leverage signals
        positive: { DEFAULT: token('positive'), soft: token('positive-soft') },
        negative: { DEFAULT: token('negative'), soft: token('negative-soft') },
        caution: { DEFAULT: token('caution'), soft: token('caution-soft') },
        info: { DEFAULT: token('info'), soft: token('info-soft') },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        DEFAULT: '0.375rem',
      },
      boxShadow: {
        pop: '0 8px 24px -4px rgb(0 0 0 / 0.35), 0 2px 6px -2px rgb(0 0 0 / 0.25)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'scale-in': {
          from: { opacity: '0', transform: 'scale(0.97)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        'slide-in-left': { from: { transform: 'translateX(-100%)' }, to: { transform: 'translateX(0)' } },
        'slide-in-right': { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'scale-in': 'scale-in 140ms ease-out',
        'slide-in-left': 'slide-in-left 180ms ease-out',
        'slide-in-right': 'slide-in-right 180ms ease-out',
      },
    },
  },
  plugins: [],
}
