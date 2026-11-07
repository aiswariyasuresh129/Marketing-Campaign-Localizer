export const steps = [
  { id: "ingest", title: "Ingest", description: "Read source files and identify campaign rules." },
  { id: "classify", title: "Classify", description: "Check markets, launch dates, and routing." },
  { id: "parse", title: "Parse", description: "Build and assess a plan for each asset." },
  { id: "match", title: "Match", description: "Check for previously completed assets." },
  { id: "act", title: "Act", description: "Render, check, and publish eligible files." },
  { id: "log", title: "Log", description: "Record decisions and outcomes." },
] as const;

export const inputTypes = ".docx,.pdf,.png,.jpg,.jpeg,.gif,.webp";
export const supportedFile = (name: string) => /\.(docx|pdf|png|jpe?g|gif|webp)$/i.test(name);
export const photoFile = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);

export type StepId = (typeof steps)[number]["id"];
export type StepStatus = "pending" | "running" | "completed" | "blocked" | "skipped";

export type Review = {
  summary: string;
  blockers: string[];
  approvals: string[];
  artifacts: string[];
};

export const placements = {
  instagram_feed: { label: "Instagram Feed", size: "1080x1080" },
  instagram_story: { label: "Instagram Story", size: "1080x1920" },
  website_banner: { label: "Website Banner", size: "1920x600" },
} as const;

export type Placement = keyof typeof placements;
export type ReviewOptions = { markets: string[]; launchDate: string };
export type ProgressAsset = {
  market: string;
  version: string;
  placement: Placement;
  size: string;
  route?: CampaignVersion["route"];
  reason?: string;
  ruleNote?: string;
  artifactId?: string;
  draftOnly?: boolean;
  artifactDraftOnly?: boolean;
  unchanged?: boolean;
};
export type CampaignCopy = Pick<CampaignVersion, "headline" | "body" | "cta" | "detail_callouts">;

export type CampaignVersion = {
  id: string;
  market: string;
  version: string;
  placement?: Placement;
  file_name: string;
  zip_path: string;
  size: string;
  headline: string;
  body: string;
  cta: string;
  detail_callouts: string[];
  english_back_translation: string;
  irony_confidence: "high" | "medium" | "low" | "n/a";
  brand_check: "pass" | "fixed" | "flagged";
  brand_check_note: string;
  route: "TRAVELS" | "ADAPT" | "HOLD";
  route_reason: string;
  approval: "pending" | "approved" | "rejected";
  in_package: boolean;
};

export function needsEditorialReview(version: CampaignVersion) {
  return version.route === "HOLD" || version.brand_check === "flagged";
}

export type CampaignReview = {
  campaign: string;
  run_id: string;
  source_image: string;
  launch_date: string;
  calendar_flags: (string | Record<string, unknown>)[];
  summary: string;
  versions: CampaignVersion[];
  package: { zip_file: string; approved_count: number; held_or_rejected: string[]; contents: string[] };
};

export type Job = {
  id: string;
  files: string[];
  status: "running" | "finished" | "failed";
  activity: string;
  steps: Record<StepId, StepStatus>;
  activeStep?: StepId | null;
  sessionId?: string;
  review?: Review;
  report?: string;
  error?: string;
  photo?: string;
  campaign?: CampaignReview;
  previews?: Record<string, string>;
  revisionError?: string;
  options?: ReviewOptions;
  sourceAvailable?: boolean;
  progressAssets?: Record<string, ProgressAsset>;
};

export type Submission = { id: string; status: "running" | "finished"; jobs: Job[] };
