import { useEffect, useState } from 'react';
import { Storage, type PairedState } from '@/lib/storage';
import { PairView } from './PairView';
import { StatusView } from './StatusView';
import './popup.css';

export function App() {
  const [state, setState] = useState<PairedState | undefined>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Storage.getPairing().then((p) => {
      setState(p);
      setLoading(false);
    });
  }, []);

  if (loading) return null;
  if (!state) return <PairView onPaired={() => Storage.getPairing().then(setState)} />;
  return (
    <StatusView
      state={state}
      onUnpair={() => Storage.clearPairing().then(() => setState(undefined))}
    />
  );
}
