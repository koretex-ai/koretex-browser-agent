/**
 * BUILT-IN SKILLS (site playbooks) — the shipped lore, in the same
 * serializable shape as user-defined skills (`intent` is a regex SOURCE
 * string, compiled case-insensitively by the agent at load time).
 *
 * The data lives here, in the storage package, so BOTH consumers can import
 * it: the agent (chrome-extension) compiles it into runtime skills, and the
 * options page renders it alongside custom skills — a built-in the user
 * edits is saved to skillStore under the same name, which REPLACES the
 * built-in at runtime (see allSkills in the agent).
 *
 * Every line in these playbooks is knowledge PAID FOR by a live run — the
 * traps are real failures, the routes are what strategic reviews eventually
 * discovered. Adding to them should follow the same rule: validated
 * knowledge only, no speculation.
 */

/** A built-in playbook: CustomSkillRecord minus the storage bookkeeping. */
export interface BuiltInSkillDef {
  name: string;
  /** Host/path substrings that trigger the skill when the tab matches */
  hosts: string[];
  /** Optional regex source (case-insensitive) matched against the objective */
  intent?: string;
  /** The playbook text pinned into the navigator's prompt when triggered */
  guidance: string;
}

export const BUILT_IN_SKILLS: BuiltInSkillDef[] = [
  {
    name: 'google-sheets',
    hosts: ['docs.google.com/spreadsheets', 'sheets.google.com'],
    intent: 'spreadsheet|\\bsheets?\\b',
    guidance: [
      // --- Creating ---
      'Create a new spreadsheet by navigating DIRECTLY to https://docs.google.com/spreadsheets/create — never click the "Blank spreadsheet" card on the Sheets home page (its visible label is not the clickable element; those clicks miss).',
      // Account facts (u/N ordering, avatar menu) validated on the Gmail run
      // 2026-07-18; the wrong-account trap paid for on Sheets 2026-07-19.
      "MULTIPLE SIGNED-IN ACCOUNTS: the URL path picks the account — /spreadsheets/u/0/, /u/1/, /u/2/… map to the signed-in accounts in order, and a bare /spreadsheets/create silently uses the DEFAULT account (live failure 2026-07-19: the objective named an account, the sheet was created under whichever account was default). When the objective names an account, verify BEFORE creating: open https://docs.google.com/spreadsheets/ and click the account avatar in the top-right corner — the menu shows the active account's email at the top and the other signed-in accounts below it. If it is the wrong account, switch by clicking the intended account in that menu (or try /u/N variants until the avatar menu shows the right address), RE-VERIFY the address, and only then create the sheet — keep the same /u/N prefix on the create URL (https://docs.google.com/spreadsheets/u/N/create). Never create or write under an unverified account when the objective names one.",
      // --- The grid's two states: the mental model everything else follows from ---
      'The grid is a canvas where a cell is in one of TWO states: SELECTED (blue outline, no cursor — typing starts a fresh edit) or EDITING (text cursor blinking inside the cell). While ANY cell is EDITING, every keystroke lands in that cell — even after clicking the title box or a menu, focus can stay with the cell. Key semantics: Enter COMMITS the edit and moves down one row; Tab COMMITS and moves right one column; Escape CANCELS the edit and reverts the cell to its last committed value (everything typed in the current edit session is lost — it never deletes committed data).',
      // --- Writing data ---
      'THE SHEET LIVES IN ITS OWN TAB for the whole run: to return to it after working on another site, navigate to its exact URL — the runtime switches to the existing tab with the sheet still open exactly as left (no reload). NEVER go via the Sheets home page to "find" the document again, and never create a second spreadsheet when the run already made one (live failure 2026-07-20: a reload landed on home and spawned a duplicate Untitled spreadsheet).',
      'A fresh sheet opens with A1 already selected — type immediately, no click needed. Write multi-row data as ONE type_focused step: one line per row, tab-separated columns, header row first.',
      'ROWS COLLECTED EARLIER IN THE RUN must be written with "textFrom":"collected" (only the header row goes in "text") — never retype collected rows by hand: the journal shows a truncated digest of the collection, so a hand-typed write silently drops every item not visible in it (live failure 2026-07-19: 13 collected contacts, 9 hand-typed rows reached the sheet).',
      'COLLECT FIRST, WRITE ONCE: gather the full dataset (scrolling/paginating on the source site — the collection store holds it all), then make ONE writing trip to the sheet. Alternating between the source site and the sheet wastes steps. If a write must be redone or checkpointed, remember "textFrom":"collected" inserts the ENTIRE collection — clear the previously written rows first (see FIXING WRONG DATA), or the sheet gets duplicate rows.',
      'COMMIT AFTER EVERY GRID WRITE: a type_focused write leaves the LAST cell still in EDIT MODE (the final line carries no trailing Enter). The step immediately after any grid write MUST be pressing Enter — before renaming, opening a menu, or judging the task done. Pressing Enter on an already-committed cell is harmless (selection just moves down), so always do it. Live failure: renaming while the last cell was mid-edit typed the sheet title INTO that cell ("astro.build" became "astro.buildHacker News Latest Articles…").',
      'Data destined for a sheet must be collected as one ROW per item — each item one line with tab-separated fields ("Name<TAB>Title<TAB>Location"). Fields collected as separate items stack vertically in column A when written.',
      'VALUES STARTING WITH "@" (or "=" / "+"): never type them into a cell raw. "@" opens the people-mention dropdown and the Enter that commits the row inserts a CONTACT CHIP in place of your text, then pops a "share with this person?" dialog (live failure: "@Alisvolatprop12" became the user\'s contact "Sean Qian"); "=" and "+" start a formula. Prefix such values with an apostrophe — type \'@handle — the apostrophe forces literal text and never displays. This applies at COLLECTION time: collected items are written into the sheet verbatim, so record any field starting with @/=/+ already apostrophe-prefixed ("\'@handle", not "@handle"). If a mention dropdown ("No results found") is open, press Escape before Enter; a share dialog appearing after a write means a chip got inserted — dismiss it, then clear and re-type those cells.',
      // --- Verifying what was written ---
      'The grid is invisible to text extraction — verify what was written from the screenshot. Text CLIPPED at a column boundary is a DISPLAY artifact, NOT data loss: the full value is stored in the cell. The FORMULA BAR (above the grid, right of "fx") shows the complete committed value of the selected cell — that is the source of truth for any single cell. Never judge data as truncated from clipped rendering, and never spend steps widening columns, wrapping text, or otherwise reformatting — column width is cosmetic and outside the objective unless the user explicitly asked for formatting.',
      'Sheets auto-saves continuously — there is no Save button and no save step. Once the data is committed (and the sheet renamed, if the objective asked for a name), the write is delivered.',
      // --- Renaming ---
      'Write the DATA FIRST and rename LAST, and only start a rename once the grid is committed (no cell shows a text cursor — see COMMIT rule above). RENAME MECHANICS: use ONE "type" step TARGETING the title box (the input showing "Untitled spreadsheet") — a targeted type focuses the box and REPLACES its content — then press Enter and CHECK the title on the screenshot. NEVER rename by clicking and then typing into "whatever is focused": the title box does not reliably hold focus or selection, so blind typing either prepends to the old title ("<name>Untitled spreadsheet") or, after an Escape, lands in a GRID CELL (live failures 2026-07-16, 2026-07-19, 2026-07-20).',
      "IF TITLE TEXT ENDS UP INSIDE A CELL (rename attempted while focus was on the grid): press Escape — it discards that cell's whole uncommitted edit including the polluted text — then retype that one cell's correct value if it held data, press Enter to commit, and only then rename. Note Escape puts focus on the GRID, never back in the title box.",
      'BEFORE JUDGING THE TASK DONE: scan the grid below the data for a stray row holding the intended sheet TITLE — a failed rename can COMMIT the title text as a data row (live failure 2026-07-20: the title shipped as row 6 of the deliverable). If present: click that cell, press Delete, then finish. A failed rename is cosmetic; title text inside the data is not.',
      // --- Selection and repair ---
      'Never press select-all in the grid — it selects every CELL (the Name Box left of the formula bar shows "1:1000") and typing lands nowhere; press Escape if that happens. To clear cells, select them and press Delete.',
      'FIXING WRONG DATA: never nudge it cell by cell. Escape only cancels an in-progress edit — it NEVER deletes committed data. Clear first: select the used range (click the top-left cell, Shift+click the bottom-right used cell) and press Delete, CONFIRM the grid is empty on the screenshot, then re-type everything in ONE type_focused step, and press Enter to commit the last cell.',
    ].join('\n'),
  },
  {
    name: 'google-docs',
    hosts: ['docs.google.com/document'],
    intent: '\\bgoogle docs?\\b|\\bdocument\\b',
    guidance: [
      'Create a new document by navigating DIRECTLY to https://docs.google.com/document/create.',
      "MULTIPLE SIGNED-IN ACCOUNTS: the URL path picks the account — /document/u/0/, /u/1/, /u/2/… map to the signed-in accounts in order, and a bare /document/create silently uses the DEFAULT account. When the objective names an account, verify BEFORE creating: open https://docs.google.com/document/ and click the account avatar in the top-right corner — the menu shows the active account's email at the top. If it is the wrong account, switch by clicking the intended account in that menu (or try /u/N variants until the avatar menu shows the right address), RE-VERIFY, and only then create via https://docs.google.com/document/u/N/create. Never create or write under an unverified account when the objective names one.",
      'THE DOCUMENT LIVES IN ITS OWN TAB for the whole run: to return to it, navigate to its exact URL — the runtime switches to the existing tab with the document open as left (no reload). Never go via the Docs home page to "find" it again, and never create a second document when the run already made one.',
      'Write the BODY FIRST and rename LAST. Renaming focuses the "Untitled document" title box and it KEEPS keyboard focus until Enter commits it — body text typed right after renaming lands in the title instead (live run: the first body line was appended to the title). RENAME MECHANICS: use ONE "type" step TARGETING the title box (the input showing "Untitled document") — a targeted type focuses it and REPLACES its content — then press Enter and CHECK the title on the screenshot; never rename by blind focused typing (it prepends to the old title).',
      'The page is a canvas editor: it focuses itself when opened — type_focused immediately; clicking around first can steal focus. Text renders literally (never markup). Separate fields with " — ", not tabs. The document title is the separate "Untitled document" box at the top-left, not the page body.',
      'The canvas is invisible to text extraction — verify what was written from the screenshot.',
    ].join('\n'),
  },
  {
    name: 'x.com',
    hosts: ['x.com/', 'twitter.com/'],
    intent: '\\bx\\.com\\b|\\btwitter\\b|\\btweet\\b',
    guidance: [
      'The HOME feed composer is INLINE: on a successful post it CLEARS and stays open — it never closes. Proof of posting is the "Your post was sent" toast and/or the post appearing at the top of the feed.',
      'Composers are contenteditable: click to focus, then type_focused. Ctrl+Enter (Cmd+Enter on Mac) submits and sidesteps the ambiguous Post buttons — the nav-sidebar "Post" and the composer submit "Post" share a label; if clicking, describe the target by place ("the Post button inside the composer").',
      'To act on an existing post (delete, etc.): open the post\'s own page, then use the ··· menu ON THE POST — not the nav sidebar "More". A deletion shows "Your post was deleted".',
      'Page-text extraction on x.com returns garbled fragments and UI junk — capture small sets with collect (read from the screenshot) instead of extract.',
    ].join('\n'),
  },
  {
    name: 'whatsapp',
    hosts: ['web.whatsapp.com'],
    intent: 'whatsapp',
    guidance: [
      'Open a conversation via the "New chat" button (pencil icon), NOT the main "Search or start a new chat" box — clicks on the main search box do not visibly focus it (live run 2026-07-18: three attempts, no focus).',
      'In the New chat panel: type the contact name into "Search name or number", then press ArrowDown to HIGHLIGHT the first result, then Enter to open it. Keyboard is the reliable route: clicking a contact row often does NOT open the chat (live run: four clicks did nothing), and Enter without a highlighted result also does nothing when the results have several sections (live run 2026-07-18: three "Kinjal" results, Enter alone failed).',
      'The chat is open when the right panel shows the contact\'s name in the header and a "Type a message" box at the bottom (the "Download WhatsApp" placeholder means no chat is open).',
      'The message box is a rich composer: type the message into "Type a message", verify the composer shows EXACTLY the intended text on the screenshot, then press Enter to SEND (sending is the side effect — mark the Enter, not the typing). Proof of sending: the message bubble appears in the conversation thread and the composer is empty.',
    ].join('\n'),
  },
  {
    name: 'linkedin',
    hosts: ['linkedin.com'],
    intent: 'linkedin',
    guidance: [
      'Find people with a pre-constructed search URL instead of the search bar and filter UI: https://www.linkedin.com/search/results/people/?keywords=<role keywords>. The URL route bypasses both the flaky search-bar clicks and the gated filters.',
      'CONNECTION DEGREE: add a network parameter ONLY when the objective constrains it — &network=%5B%221%22%5D for 1st-degree, %5B%22S%22%5D for 2nd. When the objective says nothing about connections, OMIT the parameter and search all of LinkedIn (live failure 2026-07-20: a leftover 2nd-degree filter needlessly shrank the candidate pool for a plain "find people" task).',
      'geoUrn IDs are opaque numbers — NEVER invent one (invented IDs resolve to random towns and return no results). Omit geoUrn and put the city name in the keywords instead, then check the location chip on the results page; only reuse a geoUrn you have actually seen in a URL.',
      'Several search filters (Seniority among them) are Sales-Navigator-gated: the toggle visibly reverts on apply and an upsell appears. Never fight a reverting control — encode the constraint as keywords in the URL instead.',
      'Search for concrete job titles ("Head of Data", "VP Engineering"), never class phrases like "decision maker" — literal class phrases match headline self-labelers, not the people meant.',
    ].join('\n'),
  },
  // PROVISIONAL (2026-07-18, added on user request ahead of a validation
  // run): written from stable, well-known Gmail UI facts, not yet paid for
  // by a live run — trim/correct it against the first real send.
  {
    name: 'gmail',
    hosts: ['mail.google.com'],
    intent: 'gmail|\\be-?mail\\b',
    guidance: [
      'Send an email in Gmail on mail.google.com. Start compose by clicking the "Compose" button (top-left); a compose card opens in the bottom-right with a "To recipients" field, a "Subject" input, and a rich-text "Message Body" area.',
      "MULTIPLE SIGNED-IN ACCOUNTS: the URL path picks the account — /mail/u/0/, /mail/u/1/, /mail/u/2/… map to the signed-in accounts in order. When the objective names the FROM address, verify the active account BEFORE composing: click the account avatar in the top-right corner — the menu that opens shows the active account's email address at the top and lists the other signed-in accounts below it.",
      'If the active account is the wrong one, switch by clicking the intended account in that avatar menu (or navigate to the next /u/N until the avatar menu shows the right address — live run 2026-07-18: /u/2 was a different account than intended; /u/0 was correct). Re-verify the address after switching; never compose from an unverified account when the objective names one.',
      'Fill the fields IN ORDER, one step each: type the address into the To field and press Enter to commit it into a recipient CHIP (an uncommitted typed address can be lost when focus moves); then type into "Subject"; then type the message into "Message Body".',
      'The body is a rich contenteditable: Enter inside it makes a NEW LINE — it never sends (unlike WhatsApp). Text renders literally; never type markup.',
      'SEND by clicking the "Send" button at the bottom-left of the compose card (this is the side effect — mark it sideEffect: true). Proof of sending: the compose card closes and a "Message sent" toast appears at the bottom-left.',
      'If the address is misspelled or unknown, Gmail shows an error dialog on Send instead of sending — a still-open compose card after clicking Send means it did NOT send; read the page for the error.',
    ].join('\n'),
  },
];
