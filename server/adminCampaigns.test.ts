/**
 * Create-campaign idempotency. Until this fix, a double click on "New voucher
 * code" burned two campaign codes: `busy` React state does not read back as
 * true within the same frame, and `CampaignStore.createCampaign` mints a
 * fresh code on every call with no dedupe of its own. `createCampaignIdempotent`
 * is the one place both transports (scripts/api-server.ts and
 * api/admin/campaigns.ts) call, so a replayed `idempotencyKey` short-circuits
 * to the campaign that key already minted instead of validating and minting
 * again.
 *
 * `checkAdminKey` and `AdminAuthGate` are covered in adminAuth.test.ts;
 * `buildCreateInput`'s own validation rules are exercised indirectly here
 * through `createCampaignIdempotent`.
 */

import { describe, expect, it, vi } from "vitest";

import { createCampaignIdempotent, type RawCreateBody } from "./adminCampaigns";
import type { Campaign, CreateCampaignInput } from "./campaignStore";

const VALID_BODY: RawCreateBody = { trialDays: 3, maxRedemptions: 20 };

function fakeCampaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: "campaign-1",
    campaign_code: "PANIK-TRY-ABCDEFGH",
    label: null,
    max_redemptions: 20,
    redemption_count: 0,
    trial_duration_hours: 72,
    claim_window_expires_at: null,
    is_active: true,
    created_at: "2026-08-31T00:00:00.000Z",
    updated_at: "2026-08-31T00:00:00.000Z",
    ...over,
  };
}

describe("createCampaignIdempotent", () => {
  it("mints once and replays the same campaign for a repeated key", async () => {
    const minted = fakeCampaign();
    const createCampaign = vi.fn(async (_input: CreateCampaignInput) => minted);
    const key = `replay-key-${Math.random()}`;

    const first = await createCampaignIdempotent({ ...VALID_BODY, idempotencyKey: key }, { createCampaign });
    const second = await createCampaignIdempotent({ ...VALID_BODY, idempotencyKey: key }, { createCampaign });
    const third = await createCampaignIdempotent({ ...VALID_BODY, idempotencyKey: key }, { createCampaign });

    // Exactly one mint - a double (or triple) submit with the same key never
    // spends a second campaign code.
    expect(createCampaign).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ status: 201, campaign: minted });
    expect(second).toEqual({ status: 200, campaign: minted });
    expect(third).toEqual({ status: 200, campaign: minted });
  });

  it("mints independently for two different keys", async () => {
    const a = fakeCampaign({ id: "a", campaign_code: "PANIK-TRY-AAAAAAAA" });
    const b = fakeCampaign({ id: "b", campaign_code: "PANIK-TRY-BBBBBBBB" });
    const createCampaign = vi.fn().mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    const suffix = Math.random();

    const first = await createCampaignIdempotent(
      { ...VALID_BODY, idempotencyKey: `key-a-${suffix}` },
      { createCampaign },
    );
    const second = await createCampaignIdempotent(
      { ...VALID_BODY, idempotencyKey: `key-b-${suffix}` },
      { createCampaign },
    );

    expect(createCampaign).toHaveBeenCalledTimes(2);
    expect(first.campaign).toEqual(a);
    expect(second.campaign).toEqual(b);
  });

  it("mints again for two calls with no key at all (nothing to be idempotent about)", async () => {
    const createCampaign = vi.fn().mockResolvedValue(fakeCampaign());
    await createCampaignIdempotent(VALID_BODY, { createCampaign });
    await createCampaignIdempotent(VALID_BODY, { createCampaign });
    expect(createCampaign).toHaveBeenCalledTimes(2);
  });

  it("still validates the body and never mints on a validation failure", async () => {
    const createCampaign = vi.fn();
    const key = `bad-input-${Math.random()}`;
    const result = await createCampaignIdempotent(
      { trialDays: 0, maxRedemptions: 20, idempotencyKey: key },
      { createCampaign },
    );
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/trialDays/);
    expect(createCampaign).not.toHaveBeenCalled();
  });
});
