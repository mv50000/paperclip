import { registerPlaceholders } from "../placeholders.js";
import type { FeatureRuntime } from "../types.js";
import { telegramDeclarations } from "./declarations.js";

export function register(runtime: FeatureRuntime): void {
  registerPlaceholders(runtime, telegramDeclarations);
}
