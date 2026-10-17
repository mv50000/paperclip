/**
 * Manifest-side feature list. Pure data: imported by src/manifest.ts, which the
 * host loads in its own process.
 */
import { brandDeclarations } from "./brand/declarations.js";
import { creativesDeclarations } from "./creatives/declarations.js";
import { gateDeclarations } from "./gate/declarations.js";
import { insightsDeclarations } from "./insights/declarations.js";
import { rulesDeclarations } from "./rules/declarations.js";
import { smokeDeclarations } from "./smoke/declarations.js";
import { spendGuardDeclarations } from "./spend-guard/declarations.js";
import { telegramDeclarations } from "./telegram/declarations.js";
import type { FeatureDeclarations } from "./types.js";
import { uiDeclarations } from "./ui/declarations.js";

export const FEATURE_DECLARATIONS: readonly FeatureDeclarations[] = [
  smokeDeclarations,
  telegramDeclarations,
  spendGuardDeclarations,
  brandDeclarations,
  creativesDeclarations,
  gateDeclarations,
  insightsDeclarations,
  rulesDeclarations,
  uiDeclarations,
];
