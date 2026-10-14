import { registerPlaceholders } from "../placeholders.js";
import type { FeatureRuntime } from "../types.js";
import { spendGuardDeclarations } from "./declarations.js";

export function register(runtime: FeatureRuntime): void {
  registerPlaceholders(runtime, spendGuardDeclarations);
}
