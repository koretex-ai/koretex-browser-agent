import '@src/Options.css';
import { withErrorBoundary, withSuspense } from '@extension/shared';
import { ModelSettings } from './components/ModelSettings';
import { SkillSettings } from './components/SkillSettings';

const Options = () => {
  // Always-dark theme keyed to the logo
  const isDarkMode = true;

  return (
    <div className="flex min-h-screen justify-center bg-[#0A150F] text-gray-200">
      <main className="m-8 w-full max-w-xl rounded-xl border border-[#1F7A4A]/40 bg-[#0E1D14]/80 p-8 backdrop-blur-sm">
        <h1 className="mb-6 flex items-center gap-3 text-xl font-bold text-gray-200">
          <img src="/icon-128.png" alt="Local Browser Use" className="size-8 rounded" />
          Settings
        </h1>
        <ModelSettings isDarkMode={isDarkMode} />
        <SkillSettings isDarkMode={isDarkMode} />
      </main>
    </div>
  );
};

export default withErrorBoundary(withSuspense(Options, <div>Loading...</div>), <div>Error Occurred</div>);
