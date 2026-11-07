"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { variantKey } from "@/lib/campaign-result";
import { needsEditorialReview, placements, type CampaignVersion, type Job } from "@/lib/workflow";

export type ReviewAsset = {
  id: string;
  market: string;
  version: string;
  channel: string;
  size: string;
  label: string;
  status: string;
  editorialReview?: boolean;
  route?: string;
  reason?: string;
  ruleNote?: string;
  url?: string;
  record?: CampaignVersion;
};

export function reviewAssets(job: Job): ReviewAsset[] {
  if (job.status === "running") return Object.entries(job.progressAssets ?? {}).map(([key, asset]) => {
    const channel = placements[asset.placement].label;
    const editorialReview = asset.route === "HOLD";
    const canShow = editorialReview ? asset.draftOnly && asset.artifactDraftOnly : !asset.artifactDraftOnly;
    const status = editorialReview ? "Editorial review"
      : asset.unchanged ? "Unchanged" : asset.artifactId && canShow ? "Preview ready" : asset.route ?? "In progress";
    return { ...asset, channel, status, editorialReview, id: `live:${key}`, label: `${asset.market} / ${asset.version} / ${channel}`,
      url: asset.artifactId && canShow ? `/api/jobs?id=${job.id}&preview=${encodeURIComponent(`live:${key}`)}&artifact=${encodeURIComponent(asset.artifactId)}` : undefined };
  });
  return (job.campaign?.versions ?? []).map((record) => {
    const { id, market, version, placement, size, route } = record;
    const channel = placement ? placements[placement].label : Object.values(placements).find((format) => format.size === size)?.label ?? size;
    const artifactId = job.previews?.[id];
    const unchanged = job.progressAssets?.[variantKey(market, version, placement)]?.unchanged;
    const editorialReview = needsEditorialReview(record);
    const status = record.in_package ? "Handed off"
      : record.approval === "approved" ? "Approved"
      : record.approval === "rejected" ? "Sent back"
      : editorialReview ? "Editorial review"
      : !artifactId ? "Preview unavailable"
      : unchanged ? "Unchanged"
      : record.brand_check === "fixed" ? "Fixed by agent" : "Passed";
    return { id, market, version, channel, size, label: `${market} / ${version} / ${channel}`,
      status, route, editorialReview, reason: status === "Preview unavailable" ? "A verified preview couldn’t be loaded for this asset." : record.route_reason, ruleNote: record.brand_check_note, record,
      url: artifactId ? `/api/jobs?id=${job.id}&preview=${encodeURIComponent(id)}&artifact=${encodeURIComponent(artifactId)}` : undefined };
  });
}

export function AssetImage({ src, alt, size }: { src: string; alt: string; size?: string }) {
  const [width, height] = size?.split("x").map(Number) ?? [];
  // Serve the exact source bytes and verified previews without Next's image optimizer.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} width={width || undefined} height={height || undefined} decoding="async" />;
}

function seed(id: string) {
  return Array.from(id).reduce((hash, char) => (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0, 0);
}

function Tile({ asset, onOpen, index }: { asset: ReviewAsset; onOpen: (asset: ReviewAsset, origin: HTMLButtonElement) => void; index: number }) {
  const hash = seed(asset.id);
  const [width, height] = asset.size.split("x").map(Number);
  const longSide = 120 + hash % 101;
  const style = {
    "--tile-size": `${Math.round(longSide * Math.min(1, width / height))}px`,
    "--tile-offset": `${(hash >>> 8) % 43}px`,
    "--tile-align": ["start", "center", "end"][(hash >>> 16) % 3],
    "--entry-delay": `${Math.min(index, 8) * 60}ms`,
  } as CSSProperties;
  return <div className="tile-slot" data-tile={asset.id} style={style}>
    <button type="button" className="tile" onClick={(event) => onOpen(asset, event.currentTarget)} aria-label={`Inspect ${asset.label}, ${asset.status}`}>
      <span className="corners label"><span>{asset.market}</span><span>Version {asset.version}</span></span>
      <span className="tile-image" style={{ aspectRatio: `${width} / ${height}` }}>
        {asset.url && <span className="tile-arrival" key={asset.url}><AssetImage src={asset.url} alt={asset.label} size={asset.size} /></span>}
      </span>
      <span className="corners label"><span data-status={asset.status}>{asset.status}</span><span>{asset.channel}</span></span>
    </button>
  </div>;
}

const categories = [
  { key: "market", label: "Market" }, { key: "channel", label: "Channel" }, { key: "version", label: "Version" },
] as const;
type Filters = Partial<Record<(typeof categories)[number]["key"], string>>;

export function Gallery({ assets, onOpen, campaign, summary, running }: {
  assets: ReviewAsset[]; onOpen: (asset: ReviewAsset, origin: HTMLButtonElement) => void; campaign?: string; summary?: string; running: boolean;
}) {
  const [filters, setFilters] = useState<Filters>({});
  const [grid, setGrid] = useState(false);
  const [info, setInfo] = useState(false);
  const section = useRef<HTMLElement>(null);
  const infoButton = useRef<HTMLButtonElement>(null);
  const previous = useRef<Map<string, DOMRect>>(new Map());
  const filtered = assets.filter((asset) => categories.every(({ key }) => !filters[key] || asset[key] === filters[key]));
  const markets = [...new Set(filtered.map(({ market }) => market))].sort();
  const versions = [...new Set(filtered.map(({ version }) => version))].sort();
  const hero = filtered.find(({ url }) => url);
  const showInfo = info && assets.length > 0;
  const kitSummary = summary || "Review the available previews and editorial notes.";
  const infoLine = `${campaign || "Campaign kit"}. ${markets.join(" / ") || "No markets in view"}.`;
  const tiles = () => Array.from(section.current?.querySelectorAll<HTMLElement>("[data-tile]") ?? []);
  const remember = () => { previous.current = new Map(tiles().map((tile) => [tile.dataset.tile!, tile.getBoundingClientRect()])); };
  useLayoutEffect(() => {
    if (!previous.current.size) return;
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const tile of Array.from(section.current?.querySelectorAll<HTMLElement>("[data-tile]") ?? [])) {
        const old = previous.current.get(tile.dataset.tile!);
        if (!old) {
          tile.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 250 });
          continue;
        }
        const next = tile.getBoundingClientRect();
        const x = old.left - next.left;
        const y = old.top - next.top;
        if (x || y) tile.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }],
          { duration: 500, easing: "cubic-bezier(.2,.7,.2,1)" });
      }
    }
    previous.current.clear();
  }, [filters, grid]);

  return <section className="section kit" ref={section} aria-labelledby="kit-title"
    onKeyDown={(event) => { if (showInfo && event.key === "Escape") { setInfo(false); infoButton.current?.focus(); } }}>
    <div className="kit-header">
      <div><p className="label">{assets.length} assets / {assets.filter(({ status }) => status === "Passed").length} passed /
        {" "}{assets.filter(({ status }) => status === "Fixed by agent").length} fixed</p>
        <h2 id="kit-title">Campaign kit</h2></div>
      {!!assets.length && <div className="actions">
        <button type="button" className="secondary" aria-pressed={grid && !showInfo} onClick={() => { remember(); setGrid(true); setInfo(false); }}>Grid</button>
        <button type="button" className="secondary" aria-pressed={!grid && !showInfo} onClick={() => { remember(); setGrid(false); setInfo(false); }}>Field</button>
        <button type="button" className="secondary" aria-pressed={showInfo} ref={infoButton} onClick={() => setInfo(!showInfo)}>Info</button>
      </div>}
    </div>
    {showInfo ? <div className="kit-info panel">
      <div><p className="info-statement">{infoLine.split(" ").map((word, index) =>
        <span key={index} style={{ animationDelay: `${index * 80}ms` }}>{word}{" "}</span>)}</p><p>{kitSummary}</p></div>
      {hero?.url && <button className="hero-image" type="button" onClick={(event) => onOpen(hero, event.currentTarget)} aria-label={`Inspect ${hero.label}`}>
        <AssetImage src={hero.url} alt={hero.label} size={hero.size} /></button>}
    </div> : !filtered.length ? <p className="panel kit-empty">{assets.length ? "No assets match these filters."
      : running ? "Frames appear as the agent records routing decisions." : "No asset plans were returned for this photo."}</p>
      : grid ? <div className="kit-grid">
        {markets.map((market) => <section key={market}>
          <h3 className="label">{market}</h3>
          <div className="market-row" style={{ gridTemplateColumns: `repeat(${versions.length}, minmax(0, 1fr))` }}>
            {versions.map((version) => <div key={version} className="grid-cell">
              {filtered.filter((asset) => asset.market === market && asset.version === version)
                .map((asset, index) => <Tile asset={asset} onOpen={onOpen} key={asset.id} index={index} />)}
            </div>)}
          </div>
        </section>)}
      </div> : <div className="kit-field">
        {filtered.map((asset, index) => <Tile asset={asset} onOpen={onOpen} key={asset.id} index={index} />)}
      </div>}
    {!showInfo && !!assets.length && <div className="filter-bar" aria-label="Filter campaign kit">
      {categories.map(({ key, label }) => {
        const values = [...new Set(assets.map((asset) => asset[key]))].sort();
        return <fieldset key={key}><legend className="label">{label}</legend>
          <div className="filter-values">
            <button className="filter-button label" type="button" aria-pressed={!filters[key]}
              onClick={() => { remember(); setFilters((current) => ({ ...current, [key]: undefined })); }}>All {assets.length}</button>
            {values.map((value) => <button key={value} className="filter-button label" type="button" aria-pressed={filters[key] === value}
              onClick={() => { remember(); setFilters((current) => ({ ...current, [key]: value })); }}>
              {value} {assets.filter((asset) => asset[key] === value).length}
            </button>)}
          </div>
        </fieldset>;
      })}
    </div>}
  </section>;
}
