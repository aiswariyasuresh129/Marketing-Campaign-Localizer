# Campaign Localizer: design spec

Website design guidelines for Codex and the team. Version of November 7, 2026, by Geetika Arikatala and Katie Graves. Work in progress. The Word version, "Website design guidelines - editorial direction.docx", holds the same spec plus the reference images and Geetika's shopper research.

## For Codex: read this first

- **What you are building:** the web front end of the Campaign Localizer. Fashion art directors use it to review the campaign assets an agent generates. Follow this spec for layout, color, type and movement.
- **How to read it:** MUST and NEVER are rules. Values marked *proposal* are starting points; change them only in the tokens block.
- **Pictures:** render only the brand's uploaded key art and the deliverables the agent publishes. The reference comps in section 9 are direction only; they are not in this repo and are never imported.
- **When unsure:** ask before adding a component, color or motion that is not in this spec.

## 1. Non-negotiable rules

- **MUST** render only two kinds of image: the key art the art director uploads, and the deliverables the agent publishes. Load them from the URLs the backend returns.
- **MUST** show every deliverable exactly as made: native aspect ratio, `object-fit: contain`, true color.
- **NEVER** crop, resize to fill, filter, desaturate, add grain to or recolor a deliverable or the key art.
- **NEVER** place text, labels or panels over the product, a face or the deliverable's own copy.
- **NEVER** import or display the reference comps.
- **NEVER** process images or call models in the browser. The browser uploads files, shows agent events and sends approvals; the API key stays on the server.
- **MUST** keep the editorial look (type, color, panels, motion) around the deliverables only. Inside each frame, the brand's own guidelines rule.

## 2. Design tokens

Paste into the root stylesheet. The fonts are free Google Fonts stand-ins: Archivo has a width axis for the condensed capitals, and Noto Sans JP covers Japanese.

```css
/* proposal: Campaign Localizer design tokens */
@import url("https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&family=Noto+Sans+JP:wght@400;700&display=swap");

:root {
  --color-ground: #FFFFFF;   /* page */
  --color-paper:  #ECEBE7;   /* spread field */
  --color-panel:  #F3F2F0;   /* framed panels, asset frames */
  --color-ink:    #111111;   /* text, buttons */
  --color-red:    #C8191B;   /* accent: failures, red block, focus */
  --color-muted:  #6B6660;   /* Unchanged label, secondary notes only */

  --font: "Archivo", "Helvetica Neue", Arial, sans-serif;
  --font-ja: "Noto Sans JP", "Hiragino Sans", sans-serif;
  --display-stretch: 72%;    /* condensed */
  --display-weight: 800;
  --display-tracking: -0.02em;
  --display-leading: 0.92;

  --size-label: 16px;        /* corner labels, filters, statuses */
  --size-text: 17px;         /* running text, line-height 1.5 */
  --size-lead: 24px;
  --size-heading: clamp(32px, 4vw, 56px);
  --size-display: clamp(48px, 7vw, 112px);

  --margin: clamp(16px, 2.6vw, 40px);
  --section-gap: clamp(96px, 12vw, 200px);
  --panel-pad: 28px;
  --radius: 0;
}
```

| Pair | Contrast | Use |
|---|---|---|
| Ink on ground, paper or panel | 18.9, 15.8, 16.9 to 1 | All text |
| Red on ground, paper or panel | 5.8, 4.9, 5.2 to 1 | Accent text at any size |
| Muted on ground, paper or panel | 5.7, 4.8, 5.1 to 1 | Secondary notes only |
| White on ink, white on red | 18.9, 5.8 to 1 | Button text |

- **NEVER** use gradients, drop shadows, rounded corners, glass or blur, icons in tinted squares, or thin divider lines. Separate surfaces with a step in tone: ground, paper, panel.

## 3. Typography

- **MUST** set headlines, corner labels, filters, statuses and the red block in `var(--font)` at `var(--display-stretch)`, `var(--display-weight)`, uppercase, tracking `var(--display-tracking)`, leading `var(--display-leading)`.
- **MUST** set running text, captions, back-translations and rule checks in sentence case at `var(--size-text)`, weight 400, line-height 1.5, in `var(--color-ink)`.
- **MUST** set Japanese with `lang="ja"`, `var(--font-ja)` and `line-break: strict`.
- **MUST** justify the red block with `text-align: justify` and `text-align-last: right`, and keep it under 60 words.
- **NEVER** use more than five type sizes on a screen, or a typeface other than the two above.

## 4. Components

| Component | Spec | States |
|---|---|---|
| Spread | Two columns, 50/50, full height of the first screen. Left: paper field with the key art inset at about 60% width. Right: the hero deliverable, edge to edge, `object-fit: contain` on paper | Empty (upload prompt), loading, filled |
| Panel | Panel color on the white page, padding `var(--panel-pad)`, `var(--section-gap)` between panels | Default |
| Corner labels | Inside a panel: up to three labels across the top (left, center, right) and two in the bottom corners, at `var(--size-label)`. Real values only: campaign, market, season, counts, codes | Text only |
| Red block | Accent-colored justified capitals; may run up to the edge of a frame, never over its content | Static; holds the live narration while the agent runs |
| Right list | Right-aligned list at `var(--size-label)`, meeting a deliverable on its right | Empty: one line saying nothing is there yet |
| Asset frame | Panel-colored frame holding one deliverable or private draft at native aspect ratio; market and version top left and right; status and channel in the bottom corners | Empty, loading, passed, fixed, editorial review, preview unavailable, unchanged, approved, sent back, handed off |
| Kit field | Asset frames scattered on white inside the page; see section 6 | Partial, complete, filtered |
| Focus view | One asset at 60% of the viewport width in the center; caption and copy with a visible Edit copy button beside their heading, followed by back-translation, reasons and rule checks | Open, editing, closing |
| Grid view | Rows by market, columns by version, equal frames | Same as the field |
| Filter bar | Bottom center: Market, Channel, Version, each value with a small count, for example `US 12 / Japan 12` | Active value in ink, others muted |
| Review notes panel | Neutral counts for approval-ready assets and editorial review. Expand notes by asset for reasons. Keep rule IDs and PDF pages in the asset detail. Separate actual review issues from editorial notes. | Zero shows "No outstanding review notes" |
| Buttons | Flat ink fill, white text, square corners, 44px minimum height; red is reserved for alerts | Default, hover (red), focus (3px red outline), pressed, disabled |

## 5. Screens by agent step

The agent runs Ingest, Classify, Parse, Match, Act and Log, then waits for approval, then hands off.

| Agent step | Screen state | Design |
|---|---|---|
| Ingest | Upload: key art, brief, brand guidelines PDF, markets, launch date | Spread with the key art on paper; the form in a panel beside it; a plain progress line while files upload |
| Classify | Each version matched to each market | Empty asset frames appear in the field, each labeled Travels, Adapt or Hold |
| Parse | Anything the agent is unsure of | Add a neutral editorial note with a one-line reason. Show the private draft when the source and rules permit it. |
| Match | Assets made earlier from the same inputs | Labeled Unchanged in muted color |
| Act | Assets being made, checked and fixed | The red block shows the agent's one-line narration; each deliverable settles into its frame when published; fixed assets read Fixed by agent |
| Log | The finished kit | The field comes to rest; the review notes show approval-ready and editorial review counts |
| Approve or redo | One asset at a time | Focus view; after a decision the asset returns to its frame with its new label |
| Hand off | Approved files | A panel with a right list of files by team (site, social, email), then the confirmation that teams were notified |

### Status labels

| Status from the agent | Label text | Style |
|---|---|---|
| `CREATED` | Passed | Ink |
| `FIXED` | Fixed by agent | Ink, with the rule ID |
| `HELD`, `FLAGGED` | Editorial review | Ink on paper. Show a private draft when available and explain what to check in the asset detail. |
| `FAILED` | Preview unavailable or Review interrupted | Red for technical issues, with a rerun action for an interrupted review |
| `SKIPPED` | Unchanged | Muted |
| `APPROVED` | Approved | Ink fill, white text |
| `REDO` | Sent back | Ink outline |
| `HANDED_OFF` | Handed off | Ink, with the team name |

### Fields the screens display

From each asset record: `asset_key`, `version`, `market`, `language`, `channel`, `route`, `status`, `headline`, `caption`, `back_translation`, `change_reason`, `rule_results` (rule ID, pass or fail, PDF page), `confidence` and the artifact URL.

## 6. Kit field and movement

Adapted from reference comp 2 (section 9). All values are proposals.

| Moment | Behavior | Timing |
|---|---|---|
| Layout | Frames 120 to 220px on the long side, by aspect ratio. Positions are pseudo-random but seeded by `asset_key`, so a frame keeps its place between renders. No overlap except in focus. Phone: one column | None |
| Arrive | Each frame fades and rises 16px into place when its deliverable is published | 400ms ease-out, 60ms stagger |
| Hover | The frame lifts 4px and shows market, version and channel | 150ms ease-out |
| Select | The asset scales to the center into the focus view; its nearest neighbors stack slightly behind it; the rest of the field dims to 30% opacity | 450ms `cubic-bezier(.2,.7,.2,1)` |
| Decide | After Approve or Redo the asset returns to its frame; the label changes when the agent confirms | 450ms, same curve |
| Filter | Non-matching frames fade out; the rest move to new seeded positions (FLIP transforms) | Fade 250ms, move 500ms |
| Info | The field fades out; a statement in display type fades in a few words at a time beside one deliverable: the campaign, its markets and what needs the art director; reverses on exit | Crossfade 400ms, 80ms per word |
| Grid view | Frames move into rows by market and columns by version | 500ms |

- **MUST** animate only `transform` and `opacity`.
- **MUST** honor `prefers-reduced-motion`: no movement, instant state changes, same content.
- **MUST** make every action keyboard-reachable; Escape closes the focus view and the Info view.

## 7. Accessibility

- Alt text for every deliverable comes from its record, for example "Japan, version B, Instagram feed".
- Visible focus: 3px red outline with 3px offset.
- Color is never the only signal: every status carries text.
- Japanese copy carries `lang="ja"` so screen readers switch voice.

## 8. Acceptance checks

1. No image on any screen comes from anywhere but the key art upload or the agent's published deliverables.
2. Every deliverable keeps its native aspect ratio and color; no CSS filter, `object-fit: cover` or crop is applied to it.
3. No text or label overlaps a deliverable's product, faces or copy at 1440, 768 or 390px wide.
4. Only the six color tokens appear; no gradients, shadows, rounded corners or divider lines.
5. A screen uses at most five type sizes; headlines and labels are condensed capitals; running text is sentence case at 16px or more.
6. The field looks finished with zero, some and all deliverables published.
7. Reduced motion removes all movement; Escape and Tab work everywhere.
8. Japanese text breaks correctly with `line-break: strict`.

## 9. Reference comps (described, not included)

The comps set direction for layout, color and movement only. They are not in this repo and must never be imported or shown.

- **Comp 1, editorial layout.** Take the paper and white grounds, the half-and-half spread, red justified condensed capitals, framed panels with corner labels and the right-aligned list. Its photographs are mood only.
- **Comp 2, presentation and movement.** A 15-second animation: a field of small images on white with one large in focus; a filter change re-scatters the field; switching to Info fades the field out and a statement in, a few words at a time, beside one picture; it fades back to the field; the next image comes forward with its neighbors stacked behind it. Take the field and the movement; its photographs are not used.
- **Test key art.** In our test run the brand is KHAITE and the key art is the Medium Olivia Hobo in Rouge Noir Suede and Midnight Suede. In use, every picture comes from the brand using the tool.
