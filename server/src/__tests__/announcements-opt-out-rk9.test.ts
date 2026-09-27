// RK9 Custom (RK9-317): the fork runs with PAPERCLIP_ANNOUNCEMENTS_ENABLED=false, because upstream
// v2026.916 turns the announcement feed on by default and it fetches from pages.paperclip.ing.
// This locks the env → config → feed chain: only the exact value "false" turns the feed off, and a
// disabled feed never calls fetch (doc/upgrade/defaults-hardening.md, "Announcement feed").
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announcementFeedService } from "../services/announcement-feed.js";

const ENV_KEYS = ["PAPERCLIP_CONFIG", "PAPERCLIP_ANNOUNCEMENTS_ENABLED", "PAPERCLIP_DEPLOYMENT_MODE"] as const;
let savedEnv: Record<string, string | undefined> = {};

async function loadAnnouncementsEnabled(value: string | undefined) {
  if (value === undefined) delete process.env.PAPERCLIP_ANNOUNCEMENTS_ENABLED;
  else process.env.PAPERCLIP_ANNOUNCEMENTS_ENABLED = value;
  vi.resetModules();
  const { loadConfig } = await import("../config.js");
  return loadConfig().announcementsEnabled;
}

describe("announcement feed opt-out (RK9-317)", () => {
  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.PAPERCLIP_CONFIG = "/nonexistent/paperclip-config-test/config.json";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("turns the feed off only for the exact value false", async () => {
    expect(await loadAnnouncementsEnabled("false")).toBe(false);
    expect(await loadAnnouncementsEnabled(undefined)).toBe(true);
    expect(await loadAnnouncementsEnabled("0")).toBe(true);
    expect(await loadAnnouncementsEnabled("no")).toBe(true);
  }, 15_000);

  it("never fetches when the config value is false", async () => {
    const fetch = vi.fn();
    const enabled = await loadAnnouncementsEnabled("false");
    const feed = announcementFeedService({ version: "1.0.0", enabled, fetch });
    expect(await feed.current()).toBeNull();
    expect(await feed.image("any")).toBeNull();
    expect(await feed.animation("any")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  }, 15_000);
});
