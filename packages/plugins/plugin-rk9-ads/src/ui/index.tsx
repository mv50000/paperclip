/**
 * Operator UI (A12, RK9-518), the only writer of src/ui/** (G13). Every
 * manifest UI slot resolves to an export here. Views and actions go through
 * the host bridge (usePluginAction, views via view-data.ts); there is no activate,
 * resume or unpause control: an ad goes ACTIVE only through the Telegram gate (G1).
 */
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";

export { AdsPage } from "./AdsPage.js";
export { AdsWidget } from "./AdsWidget.js";
export { SettingsPage } from "./SettingsPage.js";

export function SidebarLink(_props: PluginSidebarProps) {
  const hostNavigation = useHostNavigation();
  return <a {...hostNavigation.linkProps("/ads")}>Mainonta</a>;
}
