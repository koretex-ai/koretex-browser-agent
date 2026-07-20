import '@src/Options.css';
import { useState } from 'react';
import { withErrorBoundary, withSuspense } from '@extension/shared';
import { ModelSettings } from './components/ModelSettings';
import { SkillSettings } from './components/SkillSettings';
import type { ModelSettingsSection } from './components/ModelSettings';

const TABS = [
  { id: 'cloud', label: 'Cloud' },
  { id: 'local', label: 'Local models' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'skills', label: 'Skills' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const Options = () => {
  // Always-dark theme keyed to the logo
  const isDarkMode = true;
  // Cloud first: cloud-only is the default mode, and the API key that lives
  // there is the one thing a fresh install must enter
  const [tab, setTab] = useState<TabId>('cloud');

  return (
    <div className="flex min-h-screen justify-center bg-[#000000] text-gray-200">
      <main className="m-8 w-full max-w-xl rounded-xl border border-[#3D3D3D]/40 bg-[#0A0A0A]/80 p-8 backdrop-blur-sm">
        <h1 className="mb-4 flex items-center gap-3 text-xl font-bold text-gray-200">
          <img src="/icon-128.png" alt="Koretex Browser Agent" className="size-8 rounded" />
          Settings
        </h1>

        <nav className="mb-6 flex gap-1 border-b border-[#3D3D3D]/40">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                tab === id ? 'border-[#E8E8E8] text-[#FFFFFF]' : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}>
              {label}
            </button>
          ))}
        </nav>

        {/* ModelSettings stays mounted across tab switches so unsaved edits
            survive; only the Skills tab swaps the content out entirely. */}
        <div className={tab === 'skills' ? 'hidden' : ''}>
          <ModelSettings isDarkMode={isDarkMode} section={tab === 'skills' ? 'cloud' : (tab as ModelSettingsSection)} />
        </div>
        <div className={tab === 'skills' ? '' : 'hidden'}>
          <SkillSettings isDarkMode={isDarkMode} />
        </div>
      </main>
    </div>
  );
};

export default withErrorBoundary(withSuspense(Options, <div>Loading...</div>), <div>Error Occurred</div>);
