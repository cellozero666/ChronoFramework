/**
 * Explicit network gate (CORE_FIX_2 CF2-4): live-upstream skill
 * verification, split OUT of the default and black-box gates.
 *
 * Runs only with CHRONO_NETWORK=1 (`npm run test:network`): fetches
 * the pinned Karpathy Guidelines source from the canonical upstream
 * with a bounded timeout and proves it still matches the release
 * pin (hash, name, MIT license) via the SAME `verifySkillRelease`
 * production check the hermetic gate applies to its local fixture.
 * A pin drift fails here — never silently in the hermetic suite.
 *
 * Without the flag this file runs a single placeholder asserting
 * the gate is off (the BLACKBOX pattern — no .skip markers, so the
 * clean gate stays green).
 */
import { describe, it, expect } from "vitest";
import { SKILL_RELEASE, hashSkillSource, skillRawSourceUrl, verifySkillRelease } from "@chrono/domain";
import { defaultFetchSkillSource } from "./index.js";

const NETWORK = process.env["CHRONO_NETWORK"] === "1";

if (!NETWORK) {
  describe("Live skill upstream verification (explicit network gate)", () => {
    it("runs on demand via npm run test:network (CHRONO_NETWORK=1)", () => {
      expect(NETWORK).toBe(false);
    });
  });
} else {
  const NETWORK_TIMEOUT = 60000;

  describe("Live skill upstream verification (explicit network gate)", () => {
    it("fetches the pinned source and proves it matches the release pin", async () => {
      const url = skillRawSourceUrl();
      expect(url).toContain(SKILL_RELEASE.pinnedCommit);
      const fetched = await defaultFetchSkillSource(url);
      expect(hashSkillSource(fetched)).toBe(SKILL_RELEASE.sourceHash);
      const canonical = verifySkillRelease(fetched);
      expect(typeof canonical).toBe("string");
      expect(canonical.length).toBeGreaterThan(0);
    }, NETWORK_TIMEOUT);
  });
}
