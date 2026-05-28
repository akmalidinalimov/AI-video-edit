import type { TimelineDefinition } from "./timeline";

/** A single edit operation parsed from natural language */
export interface EditCommand {
  type:
    | "swap_broll"
    | "resize_pip"
    | "move_pip"
    | "change_layout"
    | "update_caption_style"
    | "change_transition"
    | "toggle_hook"
    | "adjust_timing"
    | "change_color_grade"
    | "update_text"
    | "toggle_layer"
    | "adjust_speed";
  segmentId?: string; // null = apply globally
  params: Record<string, unknown>;
  description: string;
}

/** Result of applying edit commands to a timeline */
export interface EditResult {
  timeline: TimelineDefinition;
  appliedCommands: EditCommand[];
  failedCommands: { command: EditCommand; reason: string }[];
  summary: string;
}

/** Chat message with optional edit context */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
  commands?: EditCommand[];
  applied?: boolean;
}

/** Style template for saving/loading */
export interface StyleTemplate {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  styleProfile: Record<string, unknown>;
  thumbnail?: string;
  tags: string[];
}

/** Export job tracking */
export interface ExportJob {
  id: string;
  status: "preparing" | "rendering" | "encoding" | "complete" | "error";
  format: "9:16" | "1:1" | "16:9";
  progress: number;
  framesRendered?: number;
  totalFrames?: number;
  outputUrl?: string;
  fileSize?: number;
  error?: string;
  startedAt: Date;
}

/** Timeline version for iteration history */
export interface TimelineVersion {
  id: string;
  label: string;
  timeline: TimelineDefinition;
  createdAt: Date;
  editSummary: string;
}
