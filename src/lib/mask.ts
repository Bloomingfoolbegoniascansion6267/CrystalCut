import type { ManualMaskRecipe, MaskMode } from "../types";

export type SelectionSource = "automatic" | "sam" | "manual";

export const selectionSourceForMode = (mode: MaskMode): SelectionSource => {
  if (mode === "sam") return "sam";
  if (mode === "manual") return "manual";
  return "automatic";
};

export const isMaskRecipeReady = (recipe: ManualMaskRecipe | null | undefined): boolean => {
  if (!recipe || (recipe.mode !== "manual" && recipe.mode !== "sam")) return true;
  return recipe.strokes.some((stroke) => stroke.mode === "keep" && stroke.points.length > 0);
};
