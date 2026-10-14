/**
 * Placeholder UI (RK9-507). Every manifest UI slot resolves to an export here.
 * The operator UI itself belongs to A12 (RK9-518), the only writer of src/ui/** (G13).
 * Plain text inside host styles until then: no own colours or layout.
 */
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import type {
  PluginCompanySettingsPageProps,
  PluginPageProps,
  PluginSidebarProps,
  PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

const PLACEHOLDER_TEXT = "RK9 Ads: the operator view arrives with RK9-518.";

export function AdsPage(_props: PluginPageProps) {
  return (
    <main>
      <h1>Mainonta</h1>
      <p>{PLACEHOLDER_TEXT}</p>
    </main>
  );
}

export function SidebarLink(_props: PluginSidebarProps) {
  const hostNavigation = useHostNavigation();
  return <a {...hostNavigation.linkProps("/ads")}>Mainonta</a>;
}

export function SettingsPage(_props: PluginCompanySettingsPageProps) {
  return (
    <section>
      <h2>Mainonta</h2>
      <p>Brand config is edited in the plugin config for this company. An empty config keeps the plugin off.</p>
    </section>
  );
}

export function AdsWidget(_props: PluginWidgetProps) {
  return <p>{PLACEHOLDER_TEXT}</p>;
}
