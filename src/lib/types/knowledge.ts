export interface KnowledgeEntry {
  id: string;
  category:
    | "crop_rule"
    | "render_fix"
    | "style_pattern"
    | "matching_rule"
    | "user_preference"
    | "verification_lesson"
    | "coordinate_fix"
    | "repetition_fix";
  content: Record<string, unknown>;
  confidence: number;
  times_applied: number;
  tags: string[];
  created_at?: string;
  updated_at?: string;
}

export interface KnowledgeBase {
  entries: KnowledgeEntry[];
}
