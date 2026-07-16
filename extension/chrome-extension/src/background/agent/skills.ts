/**
 * SKILLS — small, named playbooks of site knowledge: how a site actually
 * works, the canonical route to common operations, and the known traps.
 *
 * A skill is a PRIOR for the navigator, not a script: it is pinned into the
 * NEXT/REVIEW prompts when relevant (same mechanism as ACTIVE STRATEGY), and
 * the navigator still judges every step from the live screenshot — if the
 * page contradicts a skill, the page wins. This is where site lore lives
 * (house rule: prompts carry general reasoning directives, never
 * site-specific patches).
 *
 * Every line in these playbooks is knowledge PAID FOR by a live run — the
 * traps are real failures, the routes are what strategic reviews eventually
 * discovered. Adding a skill should follow the same rule: validated
 * knowledge only, no speculation.
 *
 * Triggering is deterministic and cheap: a skill applies when the current
 * tab's host+path contains one of its `hosts` substrings, OR the objective
 * matches its `intent` — the latter lets a skill fire BEFORE the site is
 * open (so the navigator goes straight to the right URL instead of
 * rediscovering it).
 */

export interface Skill {
  name: string;
  /** Substrings matched against the current tab's host+path */
  hosts: string[];
  /** Matched against the objective — fires the skill before the site is open */
  intent?: RegExp;
  /** The playbook text pinned into navigator/strategist prompts */
  guidance: string;
}

export const SKILLS: Skill[] = [
  {
    name: 'google-sheets',
    hosts: ['docs.google.com/spreadsheets', 'sheets.google.com'],
    intent: /spreadsheet|\bsheets?\b/i,
    guidance: [
      'Create a new spreadsheet by navigating DIRECTLY to https://docs.google.com/spreadsheets/create — never click the "Blank spreadsheet" card on the Sheets home page (its visible label is not the clickable element; those clicks miss).',
      'The grid is a canvas: type with type_focused into the SELECTED cell. A fresh sheet opens with A1 already selected — type immediately, no click needed. Tab moves one column right; Enter commits and moves to the next row. Write multi-row data as ONE type_focused step: one line per row, tab-separated columns.',
      'Never press select-all in the grid — it selects every CELL (the Name Box left of the formula bar shows "1:1000") and typing lands nowhere; press Escape if that happens. To clear cells, select them and press Delete.',
      'The grid is invisible to text extraction — verify what was written from the screenshot. Rename the file via the "Untitled spreadsheet" title box at the top.',
    ].join('\n'),
  },
  {
    name: 'google-docs',
    hosts: ['docs.google.com/document'],
    intent: /\bgoogle docs?\b|\bdocument\b/i,
    guidance: [
      'Create a new document by navigating DIRECTLY to https://docs.google.com/document/create.',
      'The page is a canvas editor: it focuses itself when opened — type_focused immediately; clicking around first can steal focus. Text renders literally (never markup). Separate fields with " — ", not tabs. The document title is the separate "Untitled document" box at the top-left, not the page body.',
      'The canvas is invisible to text extraction — verify what was written from the screenshot.',
    ].join('\n'),
  },
  {
    name: 'x.com',
    hosts: ['x.com/', 'twitter.com/'],
    intent: /\bx\.com\b|\btwitter\b|\btweet\b/i,
    guidance: [
      'The HOME feed composer is INLINE: on a successful post it CLEARS and stays open — it never closes. Proof of posting is the "Your post was sent" toast and/or the post appearing at the top of the feed.',
      'Composers are contenteditable: click to focus, then type_focused. Ctrl+Enter (Cmd+Enter on Mac) submits and sidesteps the ambiguous Post buttons — the nav-sidebar "Post" and the composer submit "Post" share a label; if clicking, describe the target by place ("the Post button inside the composer").',
      'To act on an existing post (delete, etc.): open the post\'s own page, then use the ··· menu ON THE POST — not the nav sidebar "More". A deletion shows "Your post was deleted".',
      'Page-text extraction on x.com returns garbled fragments and UI junk — capture small sets with collect (read from the screenshot) instead of extract.',
    ].join('\n'),
  },
  {
    name: 'linkedin',
    hosts: ['linkedin.com'],
    intent: /linkedin/i,
    guidance: [
      'Find people with a pre-constructed search URL instead of the search bar and filter UI: https://www.linkedin.com/search/results/people/?keywords=<role keywords>&network=%5B%22S%22%5D (network S = 2nd-degree; add geoUrn for location). The URL route bypasses both the flaky search-bar clicks and the gated filters.',
      'Several search filters (Seniority among them) are Sales-Navigator-gated: the toggle visibly reverts on apply and an upsell appears. Never fight a reverting control — encode the constraint as keywords in the URL instead.',
      'Search for concrete job titles ("Head of Data", "VP Engineering"), never class phrases like "decision maker" — literal class phrases match headline self-labelers, not the people meant.',
    ].join('\n'),
  },
];

/**
 * The playbooks applicable to this turn, matched against the live tab's
 * host+path and the objective text.
 */
export function applicableSkills(objective: string, urlPath: string): Skill[] {
  return SKILLS.filter(
    skill =>
      skill.hosts.some(host => urlPath.includes(host)) || (skill.intent ? skill.intent.test(objective) : false),
  );
}

/** Render the applicable playbooks as prompt text — empty string when none. */
export function skillsFor(objective: string, urlPath: string): string {
  return applicableSkills(objective, urlPath)
    .map(skill => `● ${skill.name}\n${skill.guidance}`)
    .join('\n\n');
}
