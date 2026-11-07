import { placements, type CampaignReview, type CampaignVersion, type Placement } from "./workflow";

export function readFinalObject(reply: string): unknown {
  // A completed run can preface its manifest with a short status line or a code fence.
  const start = reply.search(/^\s*\{/m);
  if (start < 0) return null;
  const source = reply.slice(start).trimStart();
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) {
      try { return JSON.parse(source.slice(0, index + 1)); } catch { return null; }
    }
  }
  return null;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, field: string) {
  if (typeof value !== "string") throw new Error(`Invalid campaign field ${field}.`);
  return value.trim();
}

export function variantKey(market: string, version: string, placement?: string) {
  const creative = `${market.trim().toLowerCase()}:${version.trim().toLowerCase()}`;
  return placement ? `${creative}:${placement.trim().toLowerCase()}` : creative;
}

export function safeSlug(value: string) {
  return value.normalize("NFKD").replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 64) || "campaign";
}

export function campaignResult(input: unknown, runId: string, photo: string, requirePlacements = false): CampaignReview {
  if (!record(input) || !Array.isArray(input.versions) || !Array.isArray(input.calendar_flags) || !record(input.package)) {
    throw new Error("The agent did not return the campaign manifest.");
  }
  const campaign = text(input.campaign, "campaign");
  const summary = text(input.summary, "summary");
  if (!summary || input.run_id !== runId) throw new Error("The campaign summary or run ID is missing or incorrect.");
  const launch = text(input.launch_date, "launch_date");
  if (launch && !/^\d{4}-\d{2}-\d{2}$/.test(launch)) throw new Error("The launch date must use YYYY-MM-DD.");
  const seen = new Set<string>();
  const versions = input.versions.map((raw): CampaignVersion => {
    if (!record(raw)) throw new Error("Invalid campaign version.");
    const market = text(raw.market, "market").toUpperCase();
    const version = text(raw.version, "version").toUpperCase();
    const placement = raw.placement as Placement | undefined;
    if ((placement !== undefined || requirePlacements) && (typeof placement !== "string" || !Object.hasOwn(placements, placement))) {
      throw new Error(`Unknown placement for ${market} ${version}.`);
    }
    const key = variantKey(market, version, placement);
    if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(market) || !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(version) || seen.has(key)) {
      throw new Error("Market, version, and placement must uniquely identify each file.");
    }
    seen.add(key);
    const route = raw.route;
    const check = raw.brand_check === "passed" ? "pass" : raw.brand_check;
    const irony = raw.irony_confidence;
    if ((route !== "TRAVELS" && route !== "ADAPT" && route !== "HOLD") ||
        (check !== "pass" && check !== "fixed" && check !== "flagged") ||
        (irony !== "high" && irony !== "medium" && irony !== "low" && irony !== "n/a") ||
        !Array.isArray(raw.detail_callouts) || !raw.detail_callouts.every((item) => typeof item === "string")) {
      throw new Error(`Invalid review decision for ${market} ${version}.`);
    }
    const brand = safeSlug(campaign.split(/\s+[–—-]\s+/)[0]);
    const id = placement ? `${market}_${version}_${placement}` : `${market}_${version}`;
    const fileName = `${brand}_${id}.png`;
    const size = text(raw.size, "size");
    if (placement ? size !== placements[placement].size : (size && !/^\d{1,5}x\d{1,5}$/.test(size)) || (route !== "HOLD" && !size)) {
      throw new Error(`Invalid output size for ${market} ${version}.`);
    }
    return {
      id, market, version, placement, file_name: fileName, zip_path: `social/${market}/${fileName}`,
      size, headline: text(raw.headline, "headline"), body: text(raw.body, "body"), cta: text(raw.cta, "cta"),
      detail_callouts: raw.detail_callouts, english_back_translation: text(raw.english_back_translation, "english_back_translation"),
      irony_confidence: irony, brand_check: check, brand_check_note: text(raw.brand_check_note, "brand_check_note"),
      route, route_reason: text(raw.route_reason, "route_reason"), approval: "pending", in_package: false,
    };
  });
  if (requirePlacements) {
    for (const { market, version } of versions) {
      if (Object.keys(placements).some((placement) => !seen.has(variantKey(market, version, placement)))) {
        throw new Error(`The manifest is missing a requested placement for ${market} ${version}.`);
      }
    }
  }
  return {
    campaign, run_id: runId, source_image: photo, launch_date: launch,
    calendar_flags: input.calendar_flags.filter((value): value is string | Record<string, unknown> => typeof value === "string" || record(value)),
    summary, versions, package: { zip_file: "", approved_count: 0, held_or_rejected: [], contents: [] },
  };
}
