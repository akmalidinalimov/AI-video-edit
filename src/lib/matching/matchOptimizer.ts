import type { MatchResult, BRollCatalogEntry } from "@/lib/types/project";

export interface OptimizationResult {
  matches: MatchResult[];
  changes: { segmentId: string; from: string; to: string; reason: string }[];
}

export function optimizeMatches(
  matches: MatchResult[],
  brollCatalog: BRollCatalogEntry[]
): OptimizationResult {
  const optimized = [...matches.map((m) => ({ ...m }))];
  const changes: OptimizationResult["changes"] = [];

  // Rule 1: No same B-roll more than 2x in a row
  for (let i = 2; i < optimized.length; i++) {
    const curr = optimized[i];
    const prev1 = optimized[i - 1];
    const prev2 = optimized[i - 2];

    if (
      curr.selected_broll !== "NONE" &&
      curr.selected_broll === prev1.selected_broll &&
      curr.selected_broll === prev2.selected_broll
    ) {
      const alt = findAlternative(curr, optimized, brollCatalog, i);
      if (alt) {
        const oldBroll = curr.selected_broll;
        curr.selected_broll = alt.id;
        curr.match_reason = `Swapped to avoid 3x repeat — ${alt.content_summary}`;
        curr.match_score = Math.max(curr.match_score * 0.85, 0.3);
        changes.push({
          segmentId: curr.segment_id,
          from: oldBroll,
          to: alt.id,
          reason: "Avoided 3 consecutive uses of same B-roll",
        });
      }
    }
  }

  // Rule 2: If a B-roll is used in >60% of segments, redistribute
  const usageCounts = new Map<string, number>();
  for (const m of optimized) {
    if (m.selected_broll !== "NONE") {
      usageCounts.set(m.selected_broll, (usageCounts.get(m.selected_broll) ?? 0) + 1);
    }
  }

  const matchedCount = optimized.filter((m) => m.selected_broll !== "NONE").length;
  const threshold = Math.max(matchedCount * 0.6, 3);

  for (const [brollId, count] of usageCounts) {
    if (count > threshold) {
      // Find segments using this B-roll with lowest match scores and swap them
      const segments = optimized
        .filter((m) => m.selected_broll === brollId)
        .sort((a, b) => a.match_score - b.match_score);

      const toSwap = segments.slice(0, count - Math.floor(threshold));
      for (const seg of toSwap) {
        const alt = findAlternative(seg, optimized, brollCatalog, optimized.indexOf(seg));
        if (alt) {
          const oldBroll = seg.selected_broll;
          seg.selected_broll = alt.id;
          seg.match_reason = `Redistributed for variety — ${alt.content_summary}`;
          seg.match_score = Math.max(seg.match_score * 0.8, 0.25);
          changes.push({
            segmentId: seg.segment_id,
            from: oldBroll,
            to: alt.id,
            reason: `Reduced overuse of ${oldBroll} (was used ${count}x)`,
          });
        }
      }
    }
  }

  // Rule 3: Boost weak matches (<0.3) by trying alternatives
  for (const match of optimized) {
    if (match.selected_broll !== "NONE" && match.match_score < 0.3 && match.alternative_brolls.length > 0) {
      const altId = match.alternative_brolls[0];
      const altEntry = brollCatalog.find((b) => b.id === altId);
      if (altEntry && altEntry.quality_score > 5) {
        const oldBroll = match.selected_broll;
        match.selected_broll = altId;
        match.match_reason = `Upgraded weak match — ${altEntry.content_summary}`;
        match.match_score = Math.min(match.match_score + 0.15, 0.5);
        changes.push({
          segmentId: match.segment_id,
          from: oldBroll,
          to: altId,
          reason: "Upgraded weak match using alternative",
        });
      }
    }
  }

  return { matches: optimized, changes };
}

function findAlternative(
  match: MatchResult,
  allMatches: MatchResult[],
  catalog: BRollCatalogEntry[],
  currentIndex: number
): BRollCatalogEntry | null {
  // Try alternatives listed in the match first
  for (const altId of match.alternative_brolls) {
    const entry = catalog.find((b) => b.id === altId);
    if (!entry) continue;

    // Don't use if the neighbors are already using this
    const neighbors = [
      allMatches[currentIndex - 1]?.selected_broll,
      allMatches[currentIndex + 1]?.selected_broll,
    ];
    if (!neighbors.includes(altId)) return entry;
  }

  // Try any B-roll not used by neighbors
  const neighborBrolls = new Set([
    allMatches[currentIndex - 1]?.selected_broll,
    allMatches[currentIndex + 1]?.selected_broll,
    match.selected_broll,
  ]);

  const candidate = catalog
    .filter((b) => !neighborBrolls.has(b.id))
    .sort((a, b) => b.quality_score - a.quality_score)[0];

  return candidate ?? null;
}
