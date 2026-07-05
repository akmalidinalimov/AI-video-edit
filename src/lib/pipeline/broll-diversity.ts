/**
 * broll-diversity.ts — the "art-director taste" layer for footage variety.
 *
 * Left to itself, the LLM regresses every footage prompt to "a person typing at a
 * laptop." This module hands each footage slot a DISTINCT creative angle — subject,
 * action, setting, composition — drawn from a curated, on-style palette and rotated so
 * no two nearby slots repeat. The prompt engine treats the angle as visual direction
 * (and the cinematography is still the LLM's job), so the same A-roll yields a varied
 * montage instead of laptop after laptop.
 *
 * This is the Phase-2 KB's future home: replace/augment these hardcoded palettes with
 * tagged examples from the visual knowledge base. The interface stays the same.
 *
 * Deterministic (no RNG) so prompts are cacheable and tests are stable.
 */

export interface CreativeAngle {
  subject: string;
  action: string;
  setting: string;
  composition: string;
}

// Realistic, modern, aspirational — and deliberately device-varied (phone, tablet,
// notebook, none) so the laptop cliché can't dominate. Generic enough for any topic.
const SUBJECTS = [
  "a young woman", "a young man", "a man in his 40s", "a woman in her 30s",
  "a university-age student", "an older woman", "a professional in casual wear", "two friends",
];
const ACTIONS = [
  "smiling with quiet delight at her phone", "jotting handwritten notes, then pausing to think",
  "laughing warmly during a video call", "walking with purpose, glancing up hopeful",
  "talking animatedly with someone off-camera", "celebrating a small win with a fist-pump",
  "sipping coffee while reading on a tablet", "looking thoughtfully out a window",
  "high-fiving a friend", "nodding along, absorbed and focused",
];
const SETTINGS = [
  "a sunlit café", "a cozy home kitchen", "a modern co-working space", "a leafy city park",
  "a tidy home desk by a bright window", "a busy street at golden hour", "a minimalist studio",
  "a warm living room", "a rooftop terrace at dusk", "a quiet library nook",
];
const COMPOSITIONS = [
  "medium close-up", "over-the-shoulder shot", "wide establishing shot",
  "low-angle portrait", "close-up on the hands", "eye-level medium shot",
];

/**
 * Assign `count` distinct creative angles. Each dimension advances by 1 per slot; since
 * the lists are different lengths, consecutive slots differ on every dimension and full
 * (subject,action,setting,composition) combos don't repeat until LCM(8,10,10,6)=120 slots
 * — i.e. never for a real video. `seed` shifts the starting point (e.g. per-video variety).
 */
export function assignAngles(count: number, seed = 0): CreativeAngle[] {
  const out: CreativeAngle[] = [];
  for (let i = 0; i < count; i++) {
    const k = i + seed;
    out.push({
      subject: SUBJECTS[mod(k, SUBJECTS.length)],
      action: ACTIONS[mod(k, ACTIONS.length)],
      setting: SETTINGS[mod(k, SETTINGS.length)],
      composition: COMPOSITIONS[mod(k, COMPOSITIONS.length)],
    });
  }
  return out;
}

const mod = (n: number, m: number) => ((n % m) + m) % m;

/** A one-line visual direction for the prompt engine, from an angle. */
export function angleDirection(a: CreativeAngle): string {
  return `${a.composition} of ${a.subject} ${a.action}, in ${a.setting}`;
}
