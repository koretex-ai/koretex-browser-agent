import { useState, useEffect, useRef } from 'react';
import { skillStore, BUILT_IN_SKILLS } from '@extension/storage';
import type { CustomSkillRecord } from '@extension/storage';

interface SkillSettingsProps {
  isDarkMode?: boolean;
}

/**
 * Editable draft of a skill — hosts as one comma-separated string.
 * Built-in playbooks appear as drafts too: a pristine built-in is shown
 * read-from-code and never persisted; the moment it's edited it becomes an
 * OVERRIDE (saved to skillStore under the same name, which replaces the
 * built-in at runtime). "Restore built-in" drops the override.
 */
interface SkillDraft {
  name: string;
  hosts: string;
  intent: string;
  guidance: string;
  builtIn: boolean;
  /** Built-in only: true when a stored override exists (or the draft was edited) */
  overridden: boolean;
}

const builtInByName = new Map(BUILT_IN_SKILLS.map(def => [def.name, def]));

const toDraft = (record: Pick<CustomSkillRecord, 'name' | 'hosts' | 'intent' | 'guidance'>): SkillDraft => ({
  name: record.name,
  hosts: record.hosts.join(', '),
  intent: record.intent ?? '',
  guidance: record.guidance,
  builtIn: builtInByName.has(record.name),
  overridden: false,
});

/** Built-ins first (with their stored override, if any), then the user's own skills. */
const buildDrafts = (records: CustomSkillRecord[]): SkillDraft[] => {
  const recordByName = new Map(records.map(record => [record.name, record]));
  const builtIns = BUILT_IN_SKILLS.map(def => {
    const override = recordByName.get(def.name);
    return override ? { ...toDraft(override), overridden: true } : toDraft(def);
  });
  const customs = records.filter(record => !builtInByName.has(record.name)).map(toDraft);
  return [...builtIns, ...customs];
};

const fromDraft = (draft: SkillDraft): Omit<CustomSkillRecord, 'createdAt' | 'updatedAt'> | null => {
  const name = draft.name.trim();
  const guidance = draft.guidance.trim();
  if (!name || !guidance) return null;
  return {
    name,
    hosts: draft.hosts
      .split(',')
      .map(host => host.trim())
      .filter(Boolean),
    intent: draft.intent.trim() || undefined,
    guidance,
  };
};

export const SkillSettings = ({ isDarkMode = false }: SkillSettingsProps) => {
  const [drafts, setDrafts] = useState<SkillDraft[]>([]);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    skillStore.getAll().then(records => setDrafts(buildDrafts(records)));
  }, []);

  // Editing a pristine built-in turns it into an override draft
  const updateDraft = (index: number, patch: Partial<SkillDraft>) => {
    setDrafts(prev =>
      prev.map((draft, i) => (i === index ? { ...draft, ...patch, overridden: draft.builtIn || draft.overridden } : draft)),
    );
  };

  const restoreBuiltIn = (index: number) => {
    setDrafts(prev =>
      prev.map((draft, i) => {
        if (i !== index) return draft;
        const def = builtInByName.get(draft.name);
        return def ? toDraft(def) : draft;
      }),
    );
  };

  const handleSave = async () => {
    setError('');
    const records: CustomSkillRecord[] = [];
    const seen = new Set<string>();
    // Preserve bookkeeping (createdAt, taught-skill source) across saves
    const existingByName = new Map((await skillStore.getAll()).map(record => [record.name, record]));
    for (const draft of drafts) {
      // A pristine built-in lives in code, not storage — nothing to persist
      if (draft.builtIn && !draft.overridden) continue;
      const record = fromDraft(draft);
      if (!record) {
        if (draft.name.trim() || draft.guidance.trim()) {
          setError('Every skill needs both a name and playbook text.');
          return;
        }
        continue; // fully empty row — drop silently
      }
      if (seen.has(record.name)) {
        setError(`Two skills share the name "${record.name}" — names must be unique.`);
        return;
      }
      if (record.intent) {
        try {
          new RegExp(record.intent, 'i');
        } catch {
          setError(`"${record.name}": the task-match pattern is not a valid regular expression.`);
          return;
        }
      }
      seen.add(record.name);
      const now = Date.now();
      const existing = existingByName.get(record.name);
      records.push({
        ...record,
        source: existing?.source,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
    }
    await skillStore.replaceAll(records);
    setDrafts(buildDrafts(records));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleExport = async () => {
    const records = await skillStore.getAll();
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'browser-skills.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async (file: File) => {
    setError('');
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!Array.isArray(parsed)) throw new Error('the file is not a JSON array of skills');
      const incoming = parsed
        .map(entry => entry as Partial<CustomSkillRecord>)
        .filter(entry => typeof entry.name === 'string' && typeof entry.guidance === 'string')
        .map(entry => ({
          name: entry.name!.trim(),
          hosts: Array.isArray(entry.hosts) ? entry.hosts.map(String) : [],
          intent: typeof entry.intent === 'string' ? entry.intent : undefined,
          guidance: entry.guidance!,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
          updatedAt: Date.now(),
        }));
      if (!incoming.length) throw new Error('no valid skills found in the file');
      // Merge by name — imported skills win
      const existing = await skillStore.getAll();
      const incomingNames = new Set(incoming.map(skill => skill.name));
      const merged = [...existing.filter(skill => !incomingNames.has(skill.name)), ...incoming];
      await skillStore.replaceAll(merged);
      setDrafts(buildDrafts(merged));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (cause) {
      setError(`Import failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  const inputClass = `w-full rounded-md border p-2 text-sm ${
    isDarkMode ? 'border-[#3D3D3D]/50 bg-[#141414] text-gray-200' : 'border-gray-300 bg-white text-gray-800'
  }`;
  const labelClass = `mb-1 block text-xs font-medium ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`;
  const smallButtonClass = `rounded-md border px-2 py-1 text-xs transition-colors ${
    isDarkMode ? 'border-[#3D3D3D]/50 text-gray-400 hover:text-gray-200' : 'border-gray-300 text-gray-500 hover:text-gray-700'
  }`;
  const badgeClass = `rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
    isDarkMode ? 'border-[#3D3D3D]/60 text-[#E8E8E8]' : 'border-gray-300 text-gray-500'
  }`;
  const editedBadgeClass = `rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
    isDarkMode ? 'border-amber-500/60 text-amber-400' : 'border-amber-400 text-amber-600'
  }`;

  return (
    <div className={`border-t pt-6 ${isDarkMode ? 'border-[#3D3D3D]/40' : 'border-gray-200'}`}>
      <h2 className={`mb-1 text-lg font-semibold ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
        Site playbooks (skills)
      </h2>
      <p className={`mb-4 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
        A skill teaches the agent how a site actually works: the direct route to common operations and the traps to
        avoid. It is advice, not a script — the agent still judges every step from the live page. Built-in playbooks
        ship with the extension and are marked below; you can edit them like any other skill — your edit is saved as a
        local override, and &quot;Restore built-in&quot; returns to the shipped version.
      </p>

      <div className="space-y-2">
        {drafts.map((draft, index) => (
          <div
            key={index}
            className={`rounded-lg border ${isDarkMode ? 'border-[#3D3D3D]/40 bg-[#0F0F0F]' : 'border-gray-200 bg-gray-50'}`}>
            <button
              type="button"
              onClick={() => setExpandedIndex(expandedIndex === index ? null : index)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
              <span className="flex min-w-0 items-center gap-2">
                <span className={`truncate text-sm font-medium ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                  {draft.name || '(unnamed skill)'}
                </span>
                {draft.builtIn && <span className={badgeClass}>built-in</span>}
                {draft.builtIn && draft.overridden && <span className={editedBadgeClass}>edited</span>}
              </span>
              <span className={`flex shrink-0 items-center gap-2 text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                {draft.hosts && <span className="max-w-[220px] truncate">{draft.hosts}</span>}
                <span>{expandedIndex === index ? '▾' : '▸'}</span>
              </span>
            </button>
            {expandedIndex === index && (
              <div className={`border-t p-3 ${isDarkMode ? 'border-[#3D3D3D]/30' : 'border-gray-200'}`}>
                <div className="mb-2">
                  <label className={labelClass}>
                    Name{draft.builtIn && ' (fixed — this is what ties your edit to the built-in it replaces)'}
                  </label>
                  <input
                    type="text"
                    value={draft.name}
                    onChange={e => updateDraft(index, { name: e.target.value })}
                    placeholder="e.g. notion"
                    disabled={draft.builtIn}
                    className={`${inputClass} ${draft.builtIn ? 'opacity-60' : ''}`}
                  />
                </div>
                <div className="mb-2">
                  <label className={labelClass}>Sites (comma-separated URL fragments that switch it on)</label>
                  <input
                    type="text"
                    value={draft.hosts}
                    onChange={e => updateDraft(index, { hosts: e.target.value })}
                    placeholder="e.g. notion.so, notion.site"
                    className={inputClass}
                  />
                </div>
                <div className="mb-2">
                  <label className={labelClass}>
                    Task match (optional pattern tested against your request — activates the skill before the site is
                    open)
                  </label>
                  <input
                    type="text"
                    value={draft.intent}
                    onChange={e => updateDraft(index, { intent: e.target.value })}
                    placeholder="e.g. notion|wiki page"
                    className={inputClass}
                  />
                </div>
                <div className="mb-2">
                  <label className={labelClass}>
                    Playbook (what the agent should know — routes, steps, traps; the FIRST line should state the
                    skill&apos;s purpose)
                  </label>
                  <textarea
                    value={draft.guidance}
                    onChange={e => updateDraft(index, { guidance: e.target.value })}
                    rows={draft.builtIn ? 10 : 5}
                    placeholder={'Find X on site.com — use when the user asks for X.\nStart at https://...\nNever click ... — use ... instead.'}
                    className={inputClass}
                  />
                </div>
                {draft.builtIn ? (
                  draft.overridden ? (
                    <button type="button" onClick={() => restoreBuiltIn(index)} className={smallButtonClass}>
                      Restore built-in
                    </button>
                  ) : (
                    <p className={`text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                      Shipped with the extension — editing any field saves your version as a local override.
                    </p>
                  )
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setDrafts(prev => prev.filter((_, i) => i !== index));
                      setExpandedIndex(null);
                    }}
                    className={smallButtonClass}>
                    Delete skill
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setDrafts(prev => [...prev, { name: '', hosts: '', intent: '', guidance: '', builtIn: false, overridden: false }]);
            setExpandedIndex(drafts.length);
          }}
          className={smallButtonClass}>
          + Add skill
        </button>
        <button
          type="button"
          onClick={handleSave}
          className="rounded-md bg-[#E8E8E8] px-3 py-1 text-sm font-medium text-[#000000] transition-colors hover:bg-[#FFFFFF]">
          Save skills
        </button>
        <button type="button" onClick={handleExport} className={smallButtonClass}>
          Export
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()} className={smallButtonClass}>
          Import
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0];
            if (file) handleImport(file);
            e.target.value = '';
          }}
        />
        {saved && <span className="text-sm text-[#E8E8E8]">Saved</span>}
      </div>
      {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
    </div>
  );
};
