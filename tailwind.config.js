/** @type {import('tailwindcss').Config} */
export default {
  content: ['./client/index.html', './client/src/**/*.{js,jsx,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      // Every key reads a CSS variable from client/src/styles/tokens.css, so
      // one class works in both themes (`text-faint`, `bg-accent-strong`,
      // `rounded-card`, `z-modal`). Table and rules: docs/ui-tokens.md.
      colors: {
        bg: 'var(--bg)',
        surface: {
          DEFAULT: 'var(--surface)',
          1: 'var(--surface)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
        },
        border: { DEFAULT: 'var(--border)', soft: 'var(--border-soft)' },
        fg: 'var(--text)',
        muted: 'var(--muted)',
        faint: 'var(--faint)',
        accent: {
          DEFAULT: 'var(--accent)',
          strong: 'var(--accent-strong)',
          soft: 'var(--accent-soft)',
          text: 'var(--accent-text)',
        },
        'on-accent': 'var(--on-accent)',
        'bubble-user': 'var(--bubble-user)',
        link: 'var(--link)',
        danger: { DEFAULT: 'var(--danger)', soft: 'var(--danger-soft)' },
        success: { DEFAULT: 'var(--success)', soft: 'var(--success-soft)' },
        warning: { DEFAULT: 'var(--warning)', soft: 'var(--warning-soft)' },
        info: { DEFAULT: 'var(--info)', soft: 'var(--info-soft)' },
        disabled: { DEFAULT: 'var(--disabled-bg)', text: 'var(--disabled-text)' },
        'focus-ring': 'var(--focus-ring)',
        scrim: 'var(--scrim)',
        // Deprecated alias kept only for the 3 gradient stops in
        // VoiceOverlay.jsx (`from-lava`, `to-lava`); use `accent` instead.
        lava: 'var(--accent)',
      },
      fontSize: {
        caption: ['var(--font-size-caption)', { lineHeight: 'var(--line-height-caption)' }],
        label: ['var(--font-size-label)', { lineHeight: 'var(--line-height-label)' }],
        body: ['var(--font-size-body)', { lineHeight: 'var(--line-height-body)' }],
        title: ['var(--font-size-title)', { lineHeight: 'var(--line-height-title)' }],
        heading: ['var(--font-size-heading)', { lineHeight: 'var(--line-height-heading)' }],
        display: ['var(--font-size-display)', { lineHeight: 'var(--line-height-display)' }],
      },
      spacing: {
        'in-group': 'var(--space-in-group)',
        'between-groups': 'var(--space-between-groups)',
        section: 'var(--space-section)',
      },
      borderRadius: {
        card: 'var(--radius-card)',
        control: 'var(--radius-control)',
        badge: 'var(--radius-badge)',
        pill: 'var(--radius-pill)',
      },
      boxShadow: {
        raised: 'var(--shadow-raised)',
        overlay: 'var(--shadow-overlay)',
        modal: 'var(--shadow-modal)',
      },
      zIndex: {
        raised: 'var(--z-raised)',
        sticky: 'var(--z-sticky)',
        drawer: 'var(--z-drawer)',
        dropdown: 'var(--z-dropdown)',
        modal: 'var(--z-modal)',
        'modal-nested': 'var(--z-modal-nested)',
        studio: 'var(--z-studio)',
        editor: 'var(--z-editor)',
        popover: 'var(--z-popover)',
        fullscreen: 'var(--z-fullscreen)',
        dialog: 'var(--z-dialog)',
        toast: 'var(--z-toast)',
      },
      transitionDuration: {
        fast: 'var(--duration-fast)',
        base: 'var(--duration-base)',
        slow: 'var(--duration-slow)',
      },
      transitionTimingFunction: {
        standard: 'var(--ease-standard)',
        emphasized: 'var(--ease-emphasized)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-ring': {
          '0%': { transform: 'scale(0.9)', opacity: '0.7' },
          '70%': { transform: 'scale(1.6)', opacity: '0' },
          '100%': { opacity: '0' },
        },
        shimmer: {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(12px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.25s ease-out',
        'pulse-ring': 'pulse-ring 1.5s cubic-bezier(0.4,0,0.6,1) infinite',
        shimmer: 'shimmer 2s linear infinite',
        'slide-in-right': 'slide-in-right 0.2s ease-out',
      },
    },
  },
  plugins: [],
}
