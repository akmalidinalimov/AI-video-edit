import type { ARollClipAnalysis, SpeakerConsistency } from "@/lib/types/project";

export function checkSpeakerConsistency(clips: ARollClipAnalysis[]): SpeakerConsistency {
  const perClip = clips.map((c) => ({
    clipId: c.fileId,
    facePosition: c.analysis.speaker
      ? {
          x: c.analysis.speaker.face_position.x_center,
          y: c.analysis.speaker.face_position.y_center,
          size: c.analysis.speaker.face_position.face_size,
        }
      : null,
  }));

  const withFace = perClip.filter((c) => c.facePosition !== null);

  if (withFace.length < 2) {
    return {
      isSameSpeaker: true,
      confidence: 1,
      details: withFace.length === 0
        ? "No face detected in any clip"
        : "Only one clip has face data — assuming same speaker",
      perClip,
    };
  }

  // Compare face positions: if size and position are roughly similar, likely same speaker
  // Face size within 40% tolerance, position within 30% of frame
  const sizes = withFace.map((c) => c.facePosition!.size);
  const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  const sizeVariance = sizes.every((s) => Math.abs(s - avgSize) / avgSize < 0.4);

  const xPositions = withFace.map((c) => c.facePosition!.x);
  const yPositions = withFace.map((c) => c.facePosition!.y);
  const avgX = xPositions.reduce((a, b) => a + b, 0) / xPositions.length;
  const avgY = yPositions.reduce((a, b) => a + b, 0) / yPositions.length;
  const positionConsistent = xPositions.every((x) => Math.abs(x - avgX) < 300) &&
    yPositions.every((y) => Math.abs(y - avgY) < 300);

  // Language consistency — same speaker usually uses same language
  const languages = clips.map((c) => c.analysis.language);
  const languageConsistent = new Set(languages).size <= 2;

  const checks = [sizeVariance, positionConsistent, languageConsistent];
  const passed = checks.filter(Boolean).length;
  const confidence = passed / checks.length;

  const issues: string[] = [];
  if (!sizeVariance) issues.push("face size varies significantly between clips");
  if (!positionConsistent) issues.push("face position differs between clips");
  if (!languageConsistent) issues.push("different languages detected across clips");

  return {
    isSameSpeaker: confidence >= 0.66,
    confidence,
    details: issues.length === 0
      ? "Same speaker detected across all clips — consistent face position and language"
      : `Potential issues: ${issues.join(", ")}`,
    perClip,
  };
}
