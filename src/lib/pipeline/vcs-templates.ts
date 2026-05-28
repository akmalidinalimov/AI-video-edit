/**
 * Virtual Coordination System (VCS) Templates
 *
 * Canonical, version-controlled coordinate templates for video layouts.
 * These are the SINGLE SOURCE OF TRUTH for element positioning.
 *
 * RULES:
 * - Never recalculate coordinates from Gemini analysis at render time
 * - Always reference a VCS template by ID
 * - The editing plan picks a template, the renderer executes it
 * - If a new layout style is needed, add a new template here
 *
 * Coordinate system:
 * - Origin (0,0) = top-left
 * - X increases rightward
 * - Y increases downward
 * - All values in pixels
 */

// ════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CircleDef {
  /** Center X of the circle */
  cx: number;
  /** Center Y of the circle */
  cy: number;
  /** Radius in pixels */
  radius: number;
}

export interface BorderDef {
  /** Border width in pixels */
  width: number;
  /** Border color as FFmpeg color string (e.g. "0xFFFFFF@0.6") */
  color: string;
}

export interface TextSlot {
  /** Slot ID for referencing in the editing plan */
  id: string;
  /** Anchor point (text is centered on this point) */
  anchor: { x: number; y: number };
  /** Maximum width before wrapping */
  maxWidth: number;
  /** Default font size */
  defaultFontSize: number;
  /** Default font color (FFmpeg hex) */
  defaultFontColor: string;
  /** Default font file path */
  defaultFont: string;
  /** Optional: background box */
  defaultBgColor?: string;
  /** Optional: box border padding */
  defaultBgPadding?: number;
}

export interface LayoutVariant {
  /** Layout variant ID (e.g. "rect_pip", "circle_pip") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Where the A-roll appears */
  aroll: {
    /** Bounding box on canvas */
    region: Rect;
    /** Shape of the A-roll area */
    shape: "rectangle" | "circle";
    /** Circle definition (only if shape=circle) */
    circle?: CircleDef;
    /** Border around the A-roll */
    border?: BorderDef;
    /** Face center in source video (for crop calculation) */
    faceCropCenter: { x: number; y: number };
  };
  /** Where the B-roll appears */
  broll: {
    /** Bounding box on canvas (full canvas if B-roll is background) */
    region: Rect;
    /** Whether B-roll fills the entire canvas behind other elements */
    isBackground: boolean;
  };
  /** Where the header/overlay zone is */
  headerZone?: {
    /** Bounding box of the black header region */
    region: Rect;
    /** Text slots available in this zone */
    textSlots: TextSlot[];
  };
  /** Safe area for any dynamic text overlays */
  textSafeArea: Rect;
}

export interface VCSTemplate {
  /** Template ID — used in editing plans to reference this template */
  id: string;
  /** Version for tracking changes */
  version: number;
  /** Human-readable name */
  name: string;
  /** Canvas dimensions */
  canvas: { width: number; height: number };
  /** Frame rate */
  fps: number;
  /** Aspect ratio label */
  aspectRatio: "9:16" | "16:9" | "1:1" | "4:5";
  /** Available layout variants within this template */
  layouts: Record<string, LayoutVariant>;
  /** Global styles that apply across all layouts */
  globalStyles: {
    /** Default font for body text */
    defaultFont: string;
    /** Default font for headlines */
    headlineFont: string;
    /** Default font for bold text */
    boldFont: string;
  };
}

// ════════════════════════════════════════════════════════════
// FONT PATHS (platform-aware via fonts.ts)
// ════════════════════════════════════════════════════════════

import { FONT_ALIASES } from "./fonts";

const FONTS = {
  arial: FONT_ALIASES.arial,
  arialBold: FONT_ALIASES.arialBold,
  georgiaProBoldItalic: FONT_ALIASES.georgiaProBoldItalic,
} as const;

// ════════════════════════════════════════════════════════════
// TEMPLATE: 9×16 VERTICAL (1080×1920)
// ════════════════════════════════════════════════════════════
//
// This template was derived from the reference video IMG_6018.MOV
// and validated through multiple render iterations.
//
// Two layout variants:
//   1. "rect_header" — Rectangle A-roll with black header + headlines
//      Used for opening/hook segments (typically sentence 1)
//
//   2. "circle_pip" — Circle PIP overlaid on full-screen B-roll
//      Used for body/demonstration segments (sentences 2+)
//
// ┌──────────────────────────┐
// │  RECT_HEADER LAYOUT:     │
// │ ┌────────────────────┐   │
// │ │  Black header      │   │ 0-220px   Headlines zone
// │ │  "2026 yil SMM"    │   │
// │ │  "kerak emas!"     │   │
// │ ├────────────────────┤   │
// │ │                    │   │ 333-960px  A-roll (face camera)
// │ │   A-ROLL (rect)    │   │
// │ │                    │   │
// │ ├────────────────────┤   │
// │ │                    │   │ 960-1920px B-roll (screen rec)
// │ │   B-ROLL           │   │
// │ │                    │   │
// │ └────────────────────┘   │
// └──────────────────────────┘
//
// ┌──────────────────────────┐
// │  CIRCLE_PIP LAYOUT:      │
// │         ┌─────┐          │
// │         │ PIP │ ←circle  │ top-right area
// │         └─────┘          │
// │ ┌────────────────────┐   │
// │ │                    │   │
// │ │   B-ROLL (full)    │   │ full 1080×1920
// │ │                    │   │
// │ │                    │   │
// │ │                    │   │
// │ └────────────────────┘   │
// └──────────────────────────┘

export const VCS_VERTICAL_9x16: VCSTemplate = {
  id: "vertical_9x16_v1",
  version: 1,
  name: "9×16 Vertical — Standard",
  canvas: { width: 1080, height: 1920 },
  fps: 30,
  aspectRatio: "9:16",

  layouts: {
    // ── Layout 1: Rectangle A-roll with header ──
    rect_header: {
      id: "rect_header",
      name: "Rectangle PIP with Header",
      aroll: {
        region: { x: 0, y: 333, width: 1080, height: 627 },
        shape: "rectangle",
        faceCropCenter: { x: 940, y: 350 },  // in 1920×1080 source
      },
      broll: {
        region: { x: 0, y: 718, width: 1080, height: 1202 },
        isBackground: false,
      },
      headerZone: {
        region: { x: 0, y: 0, width: 1080, height: 220 },
        textSlots: [
          {
            id: "headline_primary",
            anchor: { x: 340, y: 100 },
            maxWidth: 600,
            defaultFontSize: 50,
            defaultFontColor: "0xFDD835",
            defaultFont: FONTS.georgiaProBoldItalic,
          },
          {
            id: "headline_secondary",
            anchor: { x: 540, y: 170 },
            maxWidth: 940,
            defaultFontSize: 45,
            defaultFontColor: "0xFFFFFF",
            defaultFont: FONTS.arialBold,
            defaultBgColor: "0xE91E63",
            defaultBgPadding: 10,
          },
        ],
      },
      textSafeArea: { x: 40, y: 10, width: 1000, height: 200 },
    },

    // ── Layout 2: Circle PIP on full-screen B-roll ──
    circle_pip: {
      id: "circle_pip",
      name: "Circle PIP Overlay",
      aroll: {
        region: { x: 544, y: 175, width: 426, height: 426 },
        shape: "circle",
        circle: {
          cx: 544 + 213,  // 757
          cy: 175 + 213,  // 388
          radius: 213,
        },
        border: {
          width: 4,
          color: "0xFFFFFF@0.6",
        },
        faceCropCenter: { x: 940, y: 350 },
      },
      broll: {
        region: { x: 0, y: 0, width: 1080, height: 1920 },
        isBackground: true,
      },
      textSafeArea: { x: 40, y: 620, width: 1000, height: 1260 },
    },
  },

  globalStyles: {
    defaultFont: FONTS.arial,
    headlineFont: FONTS.georgiaProBoldItalic,
    boldFont: FONTS.arialBold,
  },
};

// ════════════════════════════════════════════════════════════
// TEMPLATE: 16×9 HORIZONTAL (1920×1080)
// ════════════════════════════════════════════════════════════
//
// Standard horizontal format for YouTube, desktop content.
// Two layout variants mirror the vertical template's concepts.
//
// ┌──────────────────────────────────────────┐
// │  SPLIT LAYOUT:                            │
// │ ┌──────────────┬─────────────────────┐   │
// │ │              │                     │   │
// │ │  A-ROLL      │     B-ROLL          │   │
// │ │  (left)      │     (right)         │   │
// │ │  640×1080    │     1280×1080       │   │
// │ │              │                     │   │
// │ └──────────────┴─────────────────────┘   │
// └──────────────────────────────────────────┘
//
// ┌──────────────────────────────────────────┐
// │  CIRCLE_PIP LAYOUT:                       │
// │ ┌────────────────────────────────────┐   │
// │ │  ┌─────┐                          │   │
// │ │  │ PIP │  B-ROLL (full 1920×1080)  │   │
// │ │  └─────┘                          │   │
// │ │                                    │   │
// │ └────────────────────────────────────┘   │
// └──────────────────────────────────────────┘

export const VCS_HORIZONTAL_16x9: VCSTemplate = {
  id: "horizontal_16x9_v1",
  version: 1,
  name: "16×9 Horizontal — Standard",
  canvas: { width: 1920, height: 1080 },
  fps: 30,
  aspectRatio: "16:9",

  layouts: {
    // ── Layout 1: Side-by-side split ──
    split: {
      id: "split",
      name: "Side-by-Side Split",
      aroll: {
        region: { x: 0, y: 0, width: 640, height: 1080 },
        shape: "rectangle",
        faceCropCenter: { x: 940, y: 350 },
      },
      broll: {
        region: { x: 640, y: 0, width: 1280, height: 1080 },
        isBackground: false,
      },
      headerZone: {
        region: { x: 0, y: 0, width: 640, height: 120 },
        textSlots: [
          {
            id: "headline_primary",
            anchor: { x: 320, y: 60 },
            maxWidth: 580,
            defaultFontSize: 36,
            defaultFontColor: "0xFDD835",
            defaultFont: FONTS.georgiaProBoldItalic,
          },
        ],
      },
      textSafeArea: { x: 20, y: 10, width: 600, height: 100 },
    },

    // ── Layout 2: Circle PIP on full-screen B-roll ──
    circle_pip: {
      id: "circle_pip",
      name: "Circle PIP Overlay",
      aroll: {
        region: { x: 40, y: 40, width: 280, height: 280 },
        shape: "circle",
        circle: {
          cx: 40 + 140,  // 180
          cy: 40 + 140,  // 180
          radius: 140,
        },
        border: {
          width: 3,
          color: "0xFFFFFF@0.6",
        },
        faceCropCenter: { x: 940, y: 350 },
      },
      broll: {
        region: { x: 0, y: 0, width: 1920, height: 1080 },
        isBackground: true,
      },
      textSafeArea: { x: 40, y: 340, width: 600, height: 700 },
    },
  },

  globalStyles: {
    defaultFont: FONTS.arial,
    headlineFont: FONTS.georgiaProBoldItalic,
    boldFont: FONTS.arialBold,
  },
};

// ════════════════════════════════════════════════════════════
// TEMPLATE REGISTRY
// ════════════════════════════════════════════════════════════

export const VCS_TEMPLATES: Record<string, VCSTemplate> = {
  "vertical_9x16_v1": VCS_VERTICAL_9x16,
  "horizontal_16x9_v1": VCS_HORIZONTAL_16x9,
};

/**
 * Register a dynamically generated template at runtime.
 * Used by buildEditingPlan() when a template is provided directly
 * (e.g., from generateTemplate()). This makes the template findable
 * by getVCSTemplate() downstream — validation, rendering, etc.
 *
 * Overwrites any existing template with the same ID (safe because
 * dynamic templates use unique auto-generated IDs like "auto_1080x1920_v1").
 */
export function registerDynamicTemplate(template: VCSTemplate): void {
  VCS_TEMPLATES[template.id] = template;
}

/**
 * Get a VCS template by ID.
 * Throws if not found — templates must exist at compile time.
 */
export function getVCSTemplate(templateId: string): VCSTemplate {
  const template = VCS_TEMPLATES[templateId];
  if (!template) {
    throw new Error(
      `VCS template "${templateId}" not found. Available: ${Object.keys(VCS_TEMPLATES).join(", ")}`
    );
  }
  return template;
}

/**
 * Get a specific layout variant from a template.
 * Throws if not found.
 */
export function getLayout(templateId: string, layoutId: string): LayoutVariant {
  const template = getVCSTemplate(templateId);
  const layout = template.layouts[layoutId];
  if (!layout) {
    throw new Error(
      `Layout "${layoutId}" not found in template "${templateId}". Available: ${Object.keys(template.layouts).join(", ")}`
    );
  }
  return layout;
}
