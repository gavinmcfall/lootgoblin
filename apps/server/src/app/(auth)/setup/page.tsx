'use client';
import { useEffect, useState } from 'react';
import { AdminStep } from './steps/AdminStep';
import { LibraryStep } from './steps/LibraryStep';
import { ExtensionPairStep } from './steps/ExtensionPairStep';

type Step = 'admin' | 'library' | 'extension';

const STEPS: Step[] = ['admin', 'library', 'extension'];

export default function SetupPage() {
  const [step, setStep] = useState<Step>('admin');

  // Preserve step across refresh via URL hash
  useEffect(() => {
    const hash = window.location.hash.replace('#', '') as Step;
    if (STEPS.includes(hash)) setStep(hash);
  }, []);

  useEffect(() => {
    window.location.hash = step;
  }, [step]);

  function advance(next: Step | 'done') {
    if (next === 'done') {
      window.location.hash = '';
      window.location.href = '/';
    } else {
      setStep(next);
    }
  }

  return (
    <main className="mx-auto mt-20 max-w-md space-y-6 p-8">
      <div className="flex items-center justify-center gap-2 text-[10px] uppercase tracking-wider">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <span className={step === s ? 'text-emerald-300' : 'text-slate-500'}>{s}</span>
            {i < STEPS.length - 1 && <span className="text-slate-700">→</span>}
          </div>
        ))}
      </div>
      {step === 'admin' && <AdminStep onDone={() => advance('library')} />}
      {step === 'library' && <LibraryStep onDone={() => advance('extension')} onSkip={() => advance('extension')} />}
      {step === 'extension' && <ExtensionPairStep onDone={() => advance('done')} />}
    </main>
  );
}
