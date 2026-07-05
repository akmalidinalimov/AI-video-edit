"use client";

/**
 * StyleCard — visualizes the decoded, content-free StyleProfile 2.0 so a human can
 * judge whether the reference's STYLE was captured correctly (B1 validation surface).
 * This is the "decode" readout; it does not yet drive the render (B1 step 4).
 */
import type { ReactNode } from "react";
import type { StyleProfile } from "@/lib/style-profile/style-profile";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, ShieldCheck } from "lucide-react";

function Swatch({ color }: { color: string }) {
  return (
    <span
      className="inline-block size-4 rounded-full border border-black/10"
      style={{ backgroundColor: color }}
      title={color}
    />
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}

export function StyleCard({ profile: p }: { profile: StyleProfile }) {
  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-bold">Decoded Style — StyleProfile 2.0</h3>
          <div className="flex items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-green-600">
              <CheckCircle2 className="size-3" /> schema-valid
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-green-600">
              <ShieldCheck className="size-3" /> content-free
            </span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Duration" value={`${p.reference_meta.duration_s.toFixed(1)}s`} />
          <Stat label="Aspect" value={p.reference_meta.aspect_ratio} />
          <Stat label="Pacing" value={`${p.pacing.pacing_class} · ${p.pacing.asl_s.toFixed(1)}s ASL`} />
          <Stat label="Cuts / min" value={p.pacing.cuts_per_minute.toFixed(1)} />
        </div>

        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Color · {p.color.temperature}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {p.color.dominant_palette.length ? (
              p.color.dominant_palette.map((c, i) => <Swatch key={i} color={c} />)
            ) : (
              <span className="text-xs text-muted-foreground">no palette detected</span>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Layout patterns</div>
          <div className="flex flex-wrap gap-2">
            {p.layout.patterns.map((pat, i) => (
              <span key={i} className="rounded-md bg-muted px-2 py-1 text-xs">
                {pat.role}
                {pat.aroll ? ` · ${pat.aroll.shape}` : ""} · {Math.round(pat.weight * 100)}%
              </span>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label="Captions"
            value={p.captions.present ? `${p.captions.font_class} ${p.captions.font_weight}` : "none"}
          />
          <Stat label="Caption case" value={p.captions.text_transform} />
          <Stat
            label="Caption colors"
            value={
              <span className="flex items-center gap-1">
                <Swatch color={p.captions.fill_color} />
                <Swatch color={p.captions.highlight_color} />
              </span>
            }
          />
          <Stat label="Transitions" value={p.transitions.dominant.join(", ")} />
        </div>

        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat
            label="Motion graphics"
            value={p.motion_graphics.uses ? `${p.motion_graphics.elements.length} element(s)` : "none"}
          />
          <Stat label="Music" value={p.audio.music.present ? p.audio.music.genre || "yes" : "none"} />
          <Stat label="Structure" value={p.narrative.structure_class} />
          <Stat label="B-roll role" value={p.narrative.broll_role} />
        </div>

        <p className="text-[11px] text-muted-foreground">
          Content-free style DNA decoded from the reference (shadow output — not yet driving the render; B1 step 3).
        </p>
      </CardContent>
    </Card>
  );
}
