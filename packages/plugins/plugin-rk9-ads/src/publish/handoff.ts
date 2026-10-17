/**
 * Publication -> spend gate hand-off (G15, A8 RK9-514).
 *
 * The publish service calls `onPublished` exactly once per publication, after
 * its PAUSED ad exists and the row says `published`. The service itself never
 * activates anything. The activation gate (A9, RK9-517) implements this hook:
 * it opens the Telegram approval for the ad. Until then it is a no-op.
 */

export interface PublishedPublication {
  publicationId: string;
  companyId: string;
  brandCode: string;
  adName: string;
  adId: string;
  adsetId: string;
  campaignId: string | null;
  creativeId: string;
  finalUrl: string;
  publishedAt: string;
}

export type OnPublishedHook = (publication: PublishedPublication) => Promise<void>;

/** Default hook: no-op until A9 (RK9-517) supplies the gate. */
export const onPublished: OnPublishedHook = async () => undefined;
