import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        'surface-hi': 'var(--surface-hi)',
        hairline: 'var(--hairline)',
        'hairline-strong': 'var(--hairline-strong)',

        // Text
        fg: 'var(--fg)',
        'fg-muted': 'var(--fg-muted)',
        'fg-faint': 'var(--fg-faint)',
        'fg-ghost': 'var(--fg-ghost)',

        // Accent (hue swappable via data-accent on <html>)
        accent: 'var(--accent)',
        'accent-soft': 'var(--accent-soft)',
        'accent-edge': 'var(--accent-edge)',
        'accent-ink': 'var(--accent-ink)',
        'accent-deep': 'var(--accent-deep)',

        // Semantics
        running: 'var(--running)',
        'running-bg': 'var(--running-bg)',
        success: 'var(--success)',
        'success-bg': 'var(--success-bg)',
        danger: 'var(--danger)',
        'danger-bg': 'var(--danger-bg)',
        info: 'var(--info)',
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        serif: ['var(--font-serif)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-md)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
      },
      letterSpacing: {
        tightish: '-0.005em',
      },
    },
  },
  plugins: [],
} satisfies Config;
