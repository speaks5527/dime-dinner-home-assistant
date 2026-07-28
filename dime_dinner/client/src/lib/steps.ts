import type { InstructionGroup } from "@shared/schema";

export interface FlatStep {
  text: string;
  image?: string | null;
  heading?: string | null;
}

/** Flatten grouped instructions into a single ordered list for Cooking Mode. */
export function flattenSteps(groups: InstructionGroup[] | null | undefined): FlatStep[] {
  const flat: FlatStep[] = [];
  for (const group of groups ?? []) {
    for (const step of group.steps ?? []) {
      const text = (step?.text ?? "").trim();
      if (!text) continue;
      flat.push({ text, image: step.image ?? null, heading: group.heading ?? null });
    }
  }
  return flat;
}
