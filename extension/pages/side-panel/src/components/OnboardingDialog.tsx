import { useEffect, useState } from 'react';
import { FiSettings, FiClock, FiHelpCircle } from 'react-icons/fi';
import { PiGraduationCapBold, PiBugBold } from 'react-icons/pi';
import { agentMemoryStore } from '@extension/storage';

interface OnboardingDialogProps {
  onClose: () => void;
}

interface OnboardingStep {
  title: string;
  body: JSX.Element;
}

// Inline icon naming a real header control ("the clock icon") so each step
// points at the exact button the user will click later.
const Icon = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <span className="whitespace-nowrap text-white">
    <span className="mx-0.5 inline-flex translate-y-[2px] items-center">{children}</span> {label}
  </span>
);

/**
 * First-run tour. Shown automatically once (onboardingStore flag), and again
 * any time the user clicks the "?" header button.
 *
 * The "Meet your agent" step seeds the AGENT MEMORY (agentMemoryStore): a
 * name and a line about typical use. Both are pinned into every run's
 * strategic prompts and grow over time as the agent distills learnings from
 * completed runs. Saved on ANY exit path (skip included) so a half-filled
 * form is never lost.
 */
const OnboardingDialog = ({ onClose }: OnboardingDialogProps) => {
  const [step, setStep] = useState(0);
  const [agentName, setAgentName] = useState('');
  const [purpose, setPurpose] = useState('');

  // Prefill when the tour is replayed via "?" — the fields edit, not reset
  useEffect(() => {
    agentMemoryStore
      .get()
      .then(memory => {
        setAgentName(memory.agentName);
        setPurpose(memory.purpose);
      })
      .catch(error => console.error('Failed to load agent memory:', error));
  }, []);

  const close = () => {
    agentMemoryStore
      .setIdentity(agentName, purpose)
      .catch(error => console.error('Failed to save agent identity:', error));
    onClose();
  };

  const STEPS: OnboardingStep[] = [
    {
      title: 'Welcome to Koretex',
      body: (
        <>
          <p>
            Type a task the way you would ask a colleague — Koretex drives the page itself: clicking, typing, reading,
            and checking its work after every step.
          </p>
          <p className="mt-2 text-gray-400">
            Try: “Find CTOs in Melbourne on LinkedIn and add them to a Google Sheet.”
          </p>
        </>
      ),
    },
    {
      title: 'Meet your agent',
      body: (
        <>
          <p>
            Give your agent a name and tell it what you’ll mostly use it for. It remembers this — and after every run it
            distills what worked, what didn’t, and what it learned about you, getting sharper and more personal over
            time.
          </p>
          <label className="mt-3 block">
            <span className="text-[11px] uppercase tracking-wide text-gray-500">Agent name</span>
            <input
              type="text"
              value={agentName}
              onChange={e => setAgentName(e.target.value)}
              placeholder="e.g. Scout"
              maxLength={60}
              className="mt-1 w-full rounded-md border border-white/25 bg-black px-2 py-1.5 text-sm text-white placeholder-gray-600 focus:border-white/60 focus:outline-none"
            />
          </label>
          <label className="mt-2 block">
            <span className="text-[11px] uppercase tracking-wide text-gray-500">What will you mostly use it for?</span>
            <textarea
              value={purpose}
              onChange={e => setPurpose(e.target.value)}
              placeholder="e.g. Sales prospecting — finding leads and building lists in Google Sheets"
              rows={2}
              maxLength={500}
              className="mt-1 w-full resize-none rounded-md border border-white/25 bg-black px-2 py-1.5 text-sm text-white placeholder-gray-600 focus:border-white/60 focus:outline-none"
            />
          </label>
          <p className="mt-2 text-gray-400">Optional — you can view and edit everything it learns in Settings.</p>
        </>
      ),
    },
    {
      title: 'Cloud or local — your choice',
      body: (
        <>
          <p>
            Set up in Settings — the{' '}
            <Icon label="gear icon">
              <FiSettings size={14} />
            </Icon>
            , top-right:
          </p>
          <ul className="mt-2 list-disc space-y-1.5 pl-4">
            <li>
              <span className="text-white">Cloud (default):</span> paste an API key from any OpenAI-compatible endpoint
              (OpenRouter out of the box) in the Cloud tab. That’s all you need.
            </li>
            <li>
              <span className="text-white">Local hybrid:</span> Ollama models on your machine read pages and ground
              clicks — configure them in the Local tab.
            </li>
          </ul>
        </>
      ),
    },
    {
      title: 'Skills: taught, not hardcoded',
      body: (
        <>
          <p>
            Skills are site playbooks — the proven route and the traps to avoid. Google Sheets, Gmail, LinkedIn and more
            ship built in; the agent reads the matching one before acting.
          </p>
          <ul className="mt-2 list-disc space-y-1.5 pl-4">
            <li>
              Click the{' '}
              <Icon label="graduation-cap icon">
                <PiGraduationCapBold size={14} />
              </Icon>{' '}
              and do a task yourself once — Koretex turns what it watched into a skill.
            </li>
            <li>After a successful run, accept the “Save as skill” offer to keep what worked.</li>
          </ul>
        </>
      ),
    },
    {
      title: 'Routines: tasks on a timer',
      body: (
        <>
          <p>
            Click the{' '}
            <Icon label="clock icon">
              <FiClock size={14} />
            </Icon>{' '}
            to schedule any task — every morning, every hour. Runs land in chat history as ⏰ sessions.
          </p>
          <p className="mt-2 text-gray-400">Chrome must be running; the window can stay in the background.</p>
        </>
      ),
    },
    {
      title: 'Alpha: expect rough edges',
      body: (
        <>
          <p>
            Not every task lands yet — we ship fixes weekly, and your reports drive them. When something goes wrong,
            click the{' '}
            <Icon label="bug icon">
              <PiBugBold size={14} />
            </Icon>{' '}
            on that chat.
          </p>
          <p className="mt-2 text-gray-400">
            Reports are text-only traces — never screenshots or your API key — and you review before sending.
          </p>
        </>
      ),
    },
  ];

  const last = step === STEPS.length - 1;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 p-3">
      <div className="flex max-h-full w-full flex-col overflow-y-auto rounded-lg border border-white/25 bg-[#0A0A0A] p-4">
        <div className="mb-1 flex items-center gap-2 text-gray-500">
          <FiHelpCircle size={14} />
          <span className="text-[11px] uppercase tracking-wide">
            {step + 1} / {STEPS.length}
          </span>
        </div>
        <div className="mb-2 text-base font-semibold text-white">{STEPS[step].title}</div>
        <div className="text-[13px] leading-relaxed text-gray-300">{STEPS[step].body}</div>

        <div className="mt-4 flex items-center justify-between">
          <div className="flex gap-1.5">
            {STEPS.map((s, i) => (
              <button
                key={s.title}
                type="button"
                aria-label={`Go to step ${i + 1}`}
                onClick={() => setStep(i)}
                className={`size-1.5 rounded-full ${i === step ? 'bg-white' : 'bg-white/25 hover:bg-white/50'}`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {!last && (
              <button
                type="button"
                onClick={close}
                className="rounded-md px-3 py-1 text-sm text-gray-400 hover:text-white">
                Skip
              </button>
            )}
            {step > 0 && (
              <button
                type="button"
                onClick={() => setStep(step - 1)}
                className="rounded-md border border-white/30 px-3 py-1 text-sm text-gray-300 hover:text-white">
                Back
              </button>
            )}
            <button
              type="button"
              onClick={() => (last ? close() : setStep(step + 1))}
              className="rounded-md bg-white px-3 py-1 text-sm font-medium text-black hover:bg-gray-200">
              {last ? 'Get started' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OnboardingDialog;
