import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";

export async function GET() {
  try {
    const data = await readFile(
      join(process.cwd(), "test-results.json"),
      "utf-8"
    );
    const results = JSON.parse(data);

    const styleProfile = buildStyleProfile(results.reference);

    const arollAnalysis = {
      ...results.aroll,
      silence_regions: results.aroll.silence_regions ?? [],
      speech_ratio: results.aroll.speech_ratio ?? 1,
      clip_summary: results.aroll.clip_summary ?? "",
      audio_quality: results.aroll.audio_quality ?? {
        overall_level: "good",
        background_noise: "none",
        volume_consistency: "consistent",
        estimated_db: -14,
        issues: [],
      },
    };

    return NextResponse.json({
      styleProfile,
      arollAnalysis,
      brollCatalog: [
        {
          id: "broll_demo_1",
          fileId: "IMG_6163.MP4",
          ...results.broll,
        },
      ],
      passes: results.reference,
    });
  } catch {
    return NextResponse.json(
      { error: "No test results found. Run test-pipeline.mjs first." },
      { status: 404 }
    );
  }
}

function buildStyleProfile(ref: Record<string, unknown>) {
  const pass1 = ref.pass1 as Record<string, unknown>;
  const pass2 = ref.pass2 as Record<string, unknown>;
  const pass4 = ref.pass4 as Record<string, unknown>;
  const pass3 = ref.pass3 as Record<string, unknown>;

  const p1Segments = pass1.segments as Array<Record<string, unknown>>;
  const p2Segments = (pass2.segments || []) as Array<Record<string, unknown>>;
  const editingRhythm = pass1.editing_rhythm as Record<string, unknown>;
  const p4Rhythm = (pass4 as Record<string, unknown>).editing_rhythm as Record<string, unknown>;
  const colorGrade = pass4.color_grade as Record<string, unknown>;
  const pipStyle = pass4.pip_style as Record<string, unknown>;

  const segments = p1Segments.map((seg) => {
    const visual = p2Segments.find(
      (s) => s.id === seg.id
    );
    return {
      id: seg.id,
      start: seg.start,
      end: seg.end,
      layout: seg.layout,
      aroll: visual?.aroll || undefined,
      broll: visual?.broll || undefined,
      text_overlays: (visual?.text_overlays as unknown[]) || [],
      other_elements: (visual?.other_elements as unknown[]) || [],
      transition_in: seg.transition_in,
      transition_out: "none",
      description: seg.description,
    };
  });

  return {
    version: "2.0",
    source: {
      duration: pass1.duration,
      fps: pass1.fps,
      resolution: pass1.resolution,
    },
    segments,
    color_grade: colorGrade,
    pip_style: pipStyle,
    editing_rhythm: {
      ...editingRhythm,
      cut_frequency: p4Rhythm?.cut_frequency,
      transition_preference: p4Rhythm?.transition_preference,
    },
    transcription: (pass3 as Record<string, unknown>).transcription,
  };
}
