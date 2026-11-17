/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{js,svelte,ts}", "./v2/**/*.{js,svelte,ts}"],
  theme: {
    extend: {
      colors: {
        // === Obsidian Accent Colors ===
        accent: {
          DEFAULT: "var(--color-accent)",
          h: "var(--accent-h)",
          s: "var(--accent-s)",
          l: "var(--accent-l)",
        },

        // === Obsidian Base Colors (neutral palette) ===
        base: {
          "00": "var(--color-base-00)",
          "05": "var(--color-base-05)",
          10: "var(--color-base-10)",
          20: "var(--color-base-20)",
          25: "var(--color-base-25)",
          30: "var(--color-base-30)",
          35: "var(--color-base-35)",
          40: "var(--color-base-40)",
          50: "var(--color-base-50)",
          60: "var(--color-base-60)",
          70: "var(--color-base-70)",
          100: "var(--color-base-100)",
        },

        // === Obsidian Extended Colors ===
        ob: {
          red: "var(--color-red)",
          orange: "var(--color-orange)",
          yellow: "var(--color-yellow)",
          green: "var(--color-green)",
          cyan: "var(--color-cyan)",
          blue: "var(--color-blue)",
          purple: "var(--color-purple)",
          pink: "var(--color-pink)",
        },

        // === Obsidian Background/Surface Colors ===
        background: {
          primary: "var(--background-primary)",
          "primary-alt": "var(--background-primary-alt)",
          secondary: "var(--background-secondary)",
          "secondary-alt": "var(--background-secondary-alt)",
        },

        // === Obsidian Background Modifiers ===
        "bg-modifier": {
          hover: "var(--background-modifier-hover)",
          "active-hover": "var(--background-modifier-active-hover)",
          border: "var(--background-modifier-border)",
          "border-hover": "var(--background-modifier-border-hover)",
          "border-focus": "var(--background-modifier-border-focus)",
          error: "var(--background-modifier-error)",
          "error-hover": "var(--background-modifier-error-hover)",
          success: "var(--background-modifier-success)",
          message: "var(--background-modifier-message)",
          "form-field": "var(--background-modifier-form-field)",
        },

        // === Obsidian Interactive Colors ===
        interactive: {
          normal: "var(--interactive-normal)",
          hover: "var(--interactive-hover)",
          accent: "var(--interactive-accent)",
          "accent-hover": "var(--interactive-accent-hover)",
        },

        // === Obsidian Text Colors ===
        text: {
          normal: "var(--text-normal)",
          muted: "var(--text-muted)",
          faint: "var(--text-faint)",
          "on-accent": "var(--text-on-accent)",
          "on-accent-inverted": "var(--text-on-accent-inverted)",
          success: "var(--text-success)",
          warning: "var(--text-warning)",
          error: "var(--text-error)",
          accent: "var(--text-accent)",
          "accent-hover": "var(--text-accent-hover)",
          selection: "var(--text-selection)",
          "highlight-bg": "var(--text-highlight-bg)",
        },

        // === Obsidian Code Colors ===
        code: {
          background: "var(--code-background)",
          normal: "var(--code-normal)",
          comment: "var(--code-comment)",
          function: "var(--code-function)",
          important: "var(--code-important)",
          keyword: "var(--code-keyword)",
          operator: "var(--code-operator)",
          property: "var(--code-property)",
          punctuation: "var(--code-punctuation)",
          string: "var(--code-string)",
          tag: "var(--code-tag)",
          value: "var(--code-value)",
        },

        // === Obsidian Icon Colors ===
        icon: {
          DEFAULT: "var(--icon-color)",
          hover: "var(--icon-color-hover)",
          active: "var(--icon-color-active)",
          focused: "var(--icon-color-focused)",
        },
      },

      // === Obsidian Spacing (4px grid) ===
      spacing: {
        // 2px grid (use sparingly)
        "size-2-1": "var(--size-2-1)",
        "size-2-2": "var(--size-2-2)",
        "size-2-3": "var(--size-2-3)",
        // 4px grid (primary)
        "size-4-1": "var(--size-4-1)",
        "size-4-2": "var(--size-4-2)",
        "size-4-3": "var(--size-4-3)",
        "size-4-4": "var(--size-4-4)",
        "size-4-5": "var(--size-4-5)",
        "size-4-6": "var(--size-4-6)",
        "size-4-8": "var(--size-4-8)",
        "size-4-9": "var(--size-4-9)",
        "size-4-12": "var(--size-4-12)",
        "size-4-16": "var(--size-4-16)",
        "size-4-18": "var(--size-4-18)",
        // Icon sizes
        "icon-xs": "var(--icon-xs)",
        "icon-s": "var(--icon-s)",
        "icon-m": "var(--icon-m)",
        "icon-l": "var(--icon-l)",
        "icon-xl": "var(--icon-xl)",
      },

      // === Obsidian Border Radius ===
      borderRadius: {
        "radius-s": "var(--radius-s)",
        "radius-m": "var(--radius-m)",
        "radius-l": "var(--radius-l)",
        "radius-xl": "var(--radius-xl)",
        "clickable-icon": "var(--clickable-icon-radius)",
      },

      // === Obsidian Font Sizes ===
      fontSize: {
        // Relative (for editor)
        "font-smallest": "var(--font-smallest)",
        "font-smaller": "var(--font-smaller)",
        "font-small": "var(--font-small)",
        "font-text": "var(--font-text-size)",
        // Fixed (for UI)
        "ui-smaller": "var(--font-ui-smaller)",
        "ui-small": "var(--font-ui-small)",
        "ui-medium": "var(--font-ui-medium)",
        "ui-large": "var(--font-ui-large)",
        // Icon sizes (for icon font-size)
        "icon-xs": "var(--icon-xs)",
        "icon-s": "var(--icon-s)",
        "icon-m": "var(--icon-m)",
        "icon-l": "var(--icon-l)",
        "icon-xl": "var(--icon-xl)",
      },

      // === Obsidian Font Weights ===
      fontWeight: {
        "ob-thin": "var(--font-thin)",
        "ob-extralight": "var(--font-extralight)",
        "ob-light": "var(--font-light)",
        "ob-normal": "var(--font-normal)",
        "ob-medium": "var(--font-medium)",
        "ob-semibold": "var(--font-semibold)",
        "ob-bold": "var(--font-bold)",
        "ob-extrabold": "var(--font-extrabold)",
        "ob-black": "var(--font-black)",
      },

      // === Obsidian Font Family ===
      fontFamily: {
        interface: "var(--font-interface-theme)",
        text: "var(--font-text-theme)",
        mono: "var(--font-monospace-theme)",
      },

      // === Obsidian Line Heights ===
      lineHeight: {
        "ob-normal": "var(--line-height-normal)",
        "ob-tight": "var(--line-height-tight)",
      },

      // === Obsidian Opacity ===
      opacity: {
        icon: "var(--icon-opacity)",
        "icon-hover": "var(--icon-opacity-hover)",
        "icon-active": "var(--icon-opacity-active)",
      },

      // === Obsidian Stroke Width (for icons) ===
      strokeWidth: {
        "icon-xs": "var(--icon-xs-stroke-width)",
        "icon-s": "var(--icon-s-stroke-width)",
        "icon-m": "var(--icon-m-stroke-width)",
        "icon-l": "var(--icon-l-stroke-width)",
        "icon-xl": "var(--icon-xl-stroke-width)",
      },

      // === Animations ===
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--bits-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--bits-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 200ms ease-out",
        "accordion-up": "accordion-up 200ms ease-in",
      },
    },
  },
  variants: {
    extend: {
      display: ["group-hover"],
    },
  },
  corePlugins: {
    preflight: false,
  },
  // Tailwind generates a utility for every word in the scanned sources that
  // names one, used as a class or not: a TS `static` keyword, `position:
  // static` in a <style> block, an icon named `columns-2`, `!visible` in a
  // condition. Those utilities ship unscoped, and in Obsidian they apply to
  // every plugin's DOM. `.static{position:static}` overrode Excalidraw's
  // `.excalidraw__canvas{position:absolute}` on its `canvas.static` and blanked
  // every drawing while S2B was enabled (#558). These are the generic names S2B
  // never uses as a class; `test/styles/tailwindUtilities.test.ts` fails when a
  // new one starts shipping.
  blocklist: [
    "static", "fixed", "sticky",
    "hidden", "invisible", "collapse", "contents",
    "inline", "inline-block", "flow-root", "list-item", "table", "grid", "container",
    "grow", "shrink", "flex-shrink", "columns-2", "border-collapse", "resize",
    "transform", "transition", "filter", "backdrop-filter", "blur", "invert",
    "ring", "shadow", "outline", "italic", "underline", "lowercase", "antialiased",
    "!block", "!filter", "!ring", "!visible", "!container",
  ],
  // Emit the `--tw-*` defaults only on elements that use a utility needing
  // them, not on `*, ::before, ::after`. A custom property declared on an
  // element gives it its own copy of every inherited custom property (~1300
  // with Obsidian's theme), which WebKit rebuilds on every root variable
  // change — Obsidian mobile sets `--keyboard-height` on the root, and in a
  // long chat that froze the page for ~1.8s on an iPhone before the composer
  // could follow the keyboard.
  experimental: {
    optimizeUniversalDefaults: true,
  },
  plugins: [],
};
