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
 * The built-in playbook DATA lives in `@extension/storage` (builtins.ts) so
 * the options page can render and override it; this module compiles it into
 * runtime skills and owns all triggering/rendering logic. Every line in the
 * built-in playbooks is knowledge PAID FOR by a live run — the traps are
 * real failures, the routes are what strategic reviews eventually
 * discovered. Adding a skill should follow the same rule: validated
 * knowledge only, no speculation.
 *
 * Triggering is deterministic and cheap: a skill applies when the current
 * tab's host+path contains one of its `hosts` substrings, OR the objective
 * matches its `intent` — the latter lets a skill fire BEFORE the site is
 * open (so the navigator goes straight to the right URL instead of
 * rediscovering it).
 */

import { BUILT_IN_SKILLS } from '@extension/storage';
import type { CustomSkillRecord } from '@extension/storage';

export interface Skill {
  name: string;
  /** Substrings matched against the current tab's host+path */
  hosts: string[];
  /** Matched against the objective — fires the skill before the site is open */
  intent?: RegExp;
  /** The playbook text pinned into navigator/strategist prompts */
  guidance: string;
}

/** The serializable fields a skill compiles from — built-in defs and stored custom records both fit. */
type SkillRecordLike = Pick<CustomSkillRecord, 'name' | 'hosts' | 'intent' | 'guidance'>;

/**
 * Compile serializable skill records (built-in defs or skillStore records)
 * into runtime skills. Records missing a name or guidance are skipped; an
 * invalid intent regex degrades the skill to host-only triggering rather
 * than breaking the run.
 */
export function compileCustomSkills(records: SkillRecordLike[]): Skill[] {
  const compiled: Skill[] = [];
  for (const record of records) {
    const name = (record.name ?? '').trim();
    const guidance = (record.guidance ?? '').trim();
    if (!name || !guidance) continue;
    let intent: RegExp | undefined;
    const intentSource = (record.intent ?? '').trim();
    if (intentSource) {
      try {
        intent = new RegExp(intentSource, 'i');
      } catch {
        intent = undefined;
      }
    }
    compiled.push({ name, hosts: (record.hosts ?? []).map(host => host.trim()).filter(Boolean), intent, guidance });
  }
  return compiled;
}

/** The shipped playbooks, compiled from the shared serializable definitions. */
export const SKILLS: Skill[] = compileCustomSkills(BUILT_IN_SKILLS);

/**
 * Built-in playbooks plus the user's custom ones. A custom skill sharing a
 * built-in's name REPLACES it — users can correct our lore, not just extend.
 */
export function allSkills(custom: CustomSkillRecord[]): Skill[] {
  const compiled = compileCustomSkills(custom);
  const overridden = new Set(compiled.map(skill => skill.name));
  return [...SKILLS.filter(skill => !overridden.has(skill.name)), ...compiled];
}

/**
 * The playbooks applicable to this turn, matched against the live tab's
 * host+path and the objective text.
 */
export function applicableSkills(objective: string, urlPath: string, skills: Skill[] = SKILLS): Skill[] {
  return skills.filter(
    skill =>
      skill.hosts.some(host => urlPath.includes(host)) || (skill.intent ? skill.intent.test(objective) : false),
  );
}

/** Render playbooks as prompt text — empty string when none. */
export function renderSkills(skills: Skill[]): string {
  return skills.map(skill => `● ${skill.name}\n${skill.guidance}`).join('\n\n');
}

/**
 * One-line index of playbooks NOT currently in force. The full text of a
 * skill pins only when its site/task trigger fires — but a site-triggered
 * skill can never fire if the navigator doesn't know to GO to its site
 * (live failure: a birdeye.so skill never activated because the navigator
 * improvised a different token site). The catalog closes that loop: the
 * navigator always sees what exists and where.
 */
export function skillCatalog(skills: Skill[], activeNames: Set<string>): string {
  return skills
    .filter(skill => !activeNames.has(skill.name))
    .map(skill => {
      const summary = skill.guidance.split('\n')[0].slice(0, 100);
      const sites = skill.hosts.length ? ` — sites: ${skill.hosts.join(', ')}` : '';
      return `· ${skill.name}${sites} — ${summary}`;
    })
    .join('\n')
    .slice(0, 1600);
}
