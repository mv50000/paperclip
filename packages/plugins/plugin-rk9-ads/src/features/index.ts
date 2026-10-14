/**
 * Worker-side feature list. `ui` has no worker part: its slots are served by
 * the UI bundle.
 */
import { register as registerCreatives } from "./creatives/register.js";
import { register as registerGate } from "./gate/register.js";
import { register as registerInsights } from "./insights/register.js";
import { register as registerRules } from "./rules/register.js";
import { register as registerSmoke } from "./smoke/register.js";
import { register as registerSpendGuard } from "./spend-guard/register.js";
import { register as registerTelegram } from "./telegram/register.js";
import type { FeatureModule } from "./types.js";

export const FEATURES: readonly FeatureModule[] = [
  { key: "smoke", register: registerSmoke },
  { key: "telegram", register: registerTelegram },
  { key: "spend-guard", register: registerSpendGuard },
  { key: "creatives", register: registerCreatives },
  { key: "gate", register: registerGate },
  { key: "insights", register: registerInsights },
  { key: "rules", register: registerRules },
];
