/**
 * MotionPreview — one composition that can render ANY registered motion component
 * by id, validating its input against the component's zod contract first.
 * This is the harness for previews + golden renders; new components need no Root edit.
 * Spec: docs/MOTION-GRAPHICS-AND-LEARNING-SPEC.md §2.6
 */
import React from "react";
import { AbsoluteFill } from "remotion";
import { getComponent } from "./registry";
import { resolveTokens } from "./tokens";

export interface MotionPreviewProps {
  componentId: string;
  input: unknown;
}

const ErrorCard: React.FC<{ msg: string }> = ({ msg }) => (
  <AbsoluteFill style={{ backgroundColor: "#2A0E0E", alignItems: "center", justifyContent: "center", padding: 80 }}>
    <div style={{ color: "#FF8080", fontFamily: "monospace", fontSize: 40, textAlign: "center", lineHeight: 1.4 }}>{msg}</div>
  </AbsoluteFill>
);

export const MotionPreview: React.FC<MotionPreviewProps> = ({ componentId, input }) => {
  const comp = getComponent(componentId);
  if (!comp) return <ErrorCard msg={`Unknown component: ${componentId}`} />;

  // Fall back to the component's own sample when no input is supplied — lets any
  // component be golden-rendered by passing just { componentId }.
  const raw = input === undefined || input === null ? comp.defaults() : input;
  const parsed = comp.inputSchema.safeParse(raw);
  if (!parsed.success) {
    return <ErrorCard msg={`Invalid input for ${componentId}\n${parsed.error.issues[0]?.path?.join(".")}: ${parsed.error.issues[0]?.message ?? "schema error"}`} />;
  }

  const data = parsed.data;
  const tokens = resolveTokens(data.style);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Render = comp.Render as React.FC<{ input: any }>;

  return (
    <AbsoluteFill style={{ backgroundColor: tokens.bg }}>
      <Render input={data} />
    </AbsoluteFill>
  );
};
