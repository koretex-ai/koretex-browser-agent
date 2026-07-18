# Privacy Policy — Local Browser Use

**Effective date: July 17, 2026**

Local Browser Use is a Chrome extension that acts as an AI browsing agent: you give it a task in a side-panel chat, and it navigates, reads, and performs actions on web pages on your behalf. This policy describes what data the extension handles, where it goes, and what never leaves your machine.

## The short version

- The extension has **no server of its own**. There is no account, no sign-up, and no analytics or tracking of any kind.
- Data leaves your machine **only** to the AI model provider **you configure** (e.g. OpenRouter, or a local Ollama instance), and only as needed to perform the task you asked for.
- Your API key, chat history, settings, and collected data are stored locally in your browser's extension storage. **We never see any of it.**
- We do not sell, share, or monetize any data. There are no third parties beyond the model provider you choose.

## What is sent to the model provider, and when

The extension supports different engines and modes; what leaves your machine depends on which is active:

**Cloud navigator mode (default when an API key is configured).** To decide each step, the extension sends the model provider: your task text, a screenshot of the active tab, and a compact page digest (URL, page title, visible element labels, a truncated text sample), plus the running task journal. Requests to OpenRouter are sent with no-retention routing (`data_collection: "deny"`), instructing providers not to store or train on the data.

**Cloud-only reading mode (optional).** Full page text may be sent to the configured cloud model for reading/extraction. In this mode a **PII guard** is on by default: detectable identifiers (email addresses, payment-card numbers, SSNs, phone numbers) are replaced with placeholder tokens *before* anything is sent; the mapping from tokens to real values (the vault) never leaves your machine and is discarded when the task ends.

**Local mode (no API key).** All models run locally via Ollama. Nothing is sent to any external service.

**Sensitive sites.** You can flag site patterns as sensitive in the options page. When a task reaches such a site, the run pauses and asks for your explicit approval before any screenshot of that site is sent to a cloud model.

## What stays on your machine

- **API keys** — stored in Chrome extension storage, sent only to the provider they authenticate with.
- **Chat history, task journals, and collected data** — stored locally; you can clear them at any time.
- **Settings and site playbooks (skills)** — stored locally; exported only if you use the Export button yourself.
- **The PII vault** — the token-to-real-value mapping used by the PII guard; per-task, in memory, never transmitted.
- **Credentials** — the agent never fills in, reads, or handles logins, passwords, or payment fields. If a task requires being signed in, you sign in yourself; if a login wall appears mid-task, the run stops and tells you.

## Permissions

- `debugger` — used exclusively for trusted **keyboard** input into canvas-based editors (such as Google Docs and Google Sheets) that ignore synthetic key events. Attached only while a task you started is running; detached when it ends.
- `<all_urls>`, `tabs`, `scripting`, `activeTab` — the agent operates on whatever site *you* direct it to, so it must be able to read page structure and act on the active tab there. It only ever acts on the tab running your task.
- `storage` / `unlimitedStorage` — local chat history and settings.
- `sidePanel` — the chat interface.

## Data retention and deletion

Everything the extension stores lives in your browser's local extension storage. Uninstalling the extension deletes all of it. Requests sent to OpenRouter carry the no-retention flag; for the exact retention behavior of a given model provider, consult that provider's policy (you choose the provider and can change it in the options page).

## Changes

Material changes to this policy will be published at this URL with an updated effective date.

## Contact

Questions about this policy: **getkloutgg@gmail.com**
