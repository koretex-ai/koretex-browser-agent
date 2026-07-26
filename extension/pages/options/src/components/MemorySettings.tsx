import { useState, useEffect } from 'react';
import { agentMemoryStore, MEMORY_MAX_CHARS } from '@extension/storage';

interface MemorySettingsProps {
  isDarkMode?: boolean;
}

/**
 * The agent's long-term memory, fully visible and editable: the identity the
 * user set at onboarding (name + typical use) and the learnings the agent
 * distills after every run. Users can correct or prune what the agent
 * believes — the same "users can correct our lore" stance as skills.
 */
export const MemorySettings = ({ isDarkMode = false }: MemorySettingsProps) => {
  void isDarkMode; // options page is always dark; prop kept for parity
  const [agentName, setAgentName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [learnings, setLearnings] = useState('');
  const [runCount, setRunCount] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    agentMemoryStore.get().then(memory => {
      setAgentName(memory.agentName);
      setPurpose(memory.purpose);
      setLearnings(memory.learnings);
      setRunCount(memory.runCount);
      setUpdatedAt(memory.updatedAt);
    });
  }, []);

  const save = async () => {
    await agentMemoryStore.setIdentity(agentName, purpose);
    await agentMemoryStore.setLearnings(learnings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const clearLearnings = async () => {
    await agentMemoryStore.clearLearnings();
    setLearnings('');
    setRunCount(0);
    setUpdatedAt(Date.now());
  };

  const inputClass =
    'mt-1 w-full rounded-md border border-[#3D3D3D]/60 bg-black px-2 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:border-gray-400 focus:outline-none';

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">
        The agent’s long-term memory: who it is, what you use it for, and what it has learned from past runs — what
        works, what fails, and your preferences. It’s pinned into every task and rewritten after each run (capped at{' '}
        {MEMORY_MAX_CHARS} characters). Edit anything below; the agent treats your edits as ground truth.
      </p>

      <label className="block">
        <span className="text-[11px] uppercase tracking-wide text-gray-500">Agent name</span>
        <input
          type="text"
          value={agentName}
          maxLength={60}
          onChange={e => setAgentName(e.target.value)}
          className={inputClass}
        />
      </label>

      <label className="block">
        <span className="text-[11px] uppercase tracking-wide text-gray-500">Typical use</span>
        <textarea
          value={purpose}
          rows={2}
          maxLength={500}
          onChange={e => setPurpose(e.target.value)}
          className={`${inputClass} resize-none`}
        />
      </label>

      <label className="block">
        <span className="text-[11px] uppercase tracking-wide text-gray-500">
          Learnings{runCount > 0 ? ` — distilled from ${runCount} run${runCount === 1 ? '' : 's'}` : ''}
          {updatedAt > 0 ? `, updated ${new Date(updatedAt).toLocaleString()}` : ''}
        </span>
        <textarea
          value={learnings}
          rows={12}
          maxLength={MEMORY_MAX_CHARS}
          onChange={e => setLearnings(e.target.value)}
          placeholder="Nothing learned yet — this fills in as the agent completes runs."
          className={`${inputClass} font-mono text-[12px] leading-relaxed`}
        />
        <span className="mt-1 block text-right text-[11px] text-gray-600">
          {learnings.length} / {MEMORY_MAX_CHARS}
        </span>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          className="rounded-md bg-white px-4 py-1.5 text-sm font-medium text-black hover:bg-gray-200">
          Save
        </button>
        <button
          type="button"
          onClick={clearLearnings}
          className="rounded-md border border-[#3D3D3D]/60 px-4 py-1.5 text-sm text-gray-400 hover:text-white">
          Forget learnings
        </button>
        {saved && <span className="text-sm text-green-400">Saved</span>}
      </div>
    </div>
  );
};
