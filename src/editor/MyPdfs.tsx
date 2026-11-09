import { useCallback, useEffect, useRef, useState } from 'react';
import { supported } from '../library/client';
import { addUserPdf, syncUserPdfs, editKalams, listUserPdfs, nameKalams, onUserChange, removeUserPdf, renameUserPdf, userKalams, type UserKalam, type UserPdf } from '../library/user';
import { LibImage } from './LibImage';

/** PDFs of kalams added on this device: upload one, and its kalams are found,
 * split into verses and searchable from every search box, like Zikre Husain. */
export function MyPdfs() {
  const [pdfs, setPdfs] = useState<(UserPdf & { count: number; named: number })[]>([]);
  const [reading, setReading] = useState<{ name: string; done: number; total: number } | null>(null);
  const [naming, setNaming] = useState<UserPdf | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const list = await listUserPdfs();
    setPdfs(await Promise.all(list.map(async (p) => {
      const ks = await userKalams(p.key);
      return { ...p, count: ks.length, named: ks.filter((k) => k.title).length };
    })));
  }, []);
  useEffect(() => { void refresh(); return onUserChange(() => void refresh()); }, [refresh]);
  // PDFs added on your other devices come here (and this device's go there).
  useEffect(() => { if (supported) void syncUserPdfs(); }, []);

  const add = async (file: File) => {
    setReading({ name: file.name, done: 0, total: 0 });
    try {
      const pdf = await addUserPdf(file, (done, total) => setReading({ name: file.name, done, total }));
      setNaming(pdf);
    } catch (e) {
      alert(`Could not add ${file.name}: ${(e as Error).message}`);
    } finally {
      setReading(null);
    }
  };

  if (!supported) return null;
  return (
    <section className="section my-pdfs">
      <h2>Your kalam PDFs</h2>
      <p className="hint">
        Add PDFs of kalams (several at once if you like): their kalams are found and split into verses, and they show up in every search box above, on
        every device you use. Give them English names to find them by name (until then, search the PDF's name).
      </p>
      {pdfs.map((p) => (
        <div className="pdf-row" key={p.key}>
          <div className="pdf-text">
            <b>{p.name}</b>
            <small>
              {p.count} kalam{p.count === 1 ? '' : 's'} · {p.named ? `${p.named} named` : 'not named yet'}
            </small>
          </div>
          <button className="ghost" onClick={() => setNaming(p)}>
            Name kalams
          </button>
          <button
            className="ghost"
            title="Remove this PDF from this device (kalams already in a booklet stay)"
            onClick={() => confirm(`Remove “${p.name}” from this device? Kalams already added to a booklet stay.`) && void removeUserPdf(p.key)}
          >
            ✕
          </button>
        </div>
      ))}
      {reading && (
        <div className="block pending">
          <span className="spinner" /> Reading {reading.name}… {reading.total ? `page ${reading.done} of ${reading.total}` : ''}
        </div>
      )}
      <button className="add" disabled={!!reading} onClick={() => input.current?.click()}>
        + Add PDFs of kalams
      </button>
      <input
        ref={input}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          // Several at once: read one after another, the last one opens for naming.
          void files.reduce((done, file) => done.then(() => add(file)), Promise.resolve());
        }}
      />
      {naming && <NameKalams pdf={naming} onClose={() => setNaming(null)} />}
    </section>
  );
}

/** Each kalam the PDF was split into: its opening, a name for the search, and
 * fixes for the split (join with the one before, or not a kalam). */
function NameKalams({ pdf, onClose }: { pdf: UserPdf; onClose: () => void }) {
  const [kalams, setKalams] = useState<UserKalam[] | null>(null);
  const [titles, setTitles] = useState<string[]>([]);
  const [name, setName] = useState(pdf.name);
  // Previews are made again after a join or removal (the kalams renumber).
  const [round, setRound] = useState(0);
  // The kalam whose verses are open to choose where to split it.
  const [splitting, setSplitting] = useState<number | null>(null);

  const load = useCallback(async () => {
    const ks = await userKalams(pdf.key);
    setKalams(ks);
    setTitles(ks.map((k) => k.title));
  }, [pdf.key]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    await nameKalams(pdf.key, titles.map((t) => t.trim()));
    if (name.trim() && name.trim() !== pdf.name) await renameUserPdf(pdf.key, name.trim());
    onClose();
  };
  const edit = async (n: number, what: 'join' | 'remove' | 'split', at?: number) => {
    // Names typed so far are kept, following their kalams.
    await nameKalams(pdf.key, titles.map((t) => t.trim()));
    await editKalams(pdf.key, n, what, at);
    setSplitting(null);
    setRound((r) => r + 1);
    await load();
  };

  return (
    <div className="verse-backdrop shown" onMouseDown={onClose}>
      <aside className="verse-sheet name-sheet" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={`Name the kalams of ${pdf.name}`}>
        <header className="verse-head">
          <div>
            <input className="pdf-name" value={name} onChange={(e) => setName(e.target.value)} aria-label="PDF name" />
            <small>
              {kalams ? `${kalams.length} kalam${kalams.length === 1 ? '' : 's'} found` : 'Loading…'} · type each one's first words in English letters, as you would search
              for it
            </small>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <ol className="name-list">
          {kalams?.map((k, i) => (
            <li key={`${round}:${i}`}>
              <span className="verse-no">{i + 1}</span>
              <div className="name-body">
                <LibImage key={`${round}:t${i}`} className="name-title" source={pdf.key} n={i} what="title" />
                <input
                  value={titles[i] ?? ''}
                  placeholder={`Name (e.g. Ya Husain …) · ${k.v} verse${k.v === 1 ? '' : 's'}, page ${k.pages[0] + 1}${k.pages[1] > k.pages[0] ? `–${k.pages[1] + 1}` : ''}`}
                  onChange={(e) => setTitles((t) => Object.assign([...t], { [i]: e.target.value }))}
                />
                {splitting === i && (
                  <ol className="split-list">
                    {Array.from({ length: k.v }, (_, v) => (
                      <li key={v}>
                        {v > 0 && (
                          <button className="ghost" onClick={() => void edit(i, 'split', v)}>
                            ✂ New kalam from here
                          </button>
                        )}
                        <LibImage key={`${round}:${i}:${v}`} source={pdf.key} n={i} what={[v, v]} alt={`Verse ${v + 1}`} />
                      </li>
                    ))}
                  </ol>
                )}
              </div>
              <div className="name-tools">
                {i > 0 && (
                  <button className="ghost" title="This is the rest of the kalam above: join them" onClick={() => void edit(i, 'join')}>
                    ↥ Join above
                  </button>
                )}
                {k.v > 1 && (
                  <button className={`ghost${splitting === i ? ' on' : ''}`} title="Two kalams in one: choose where the second starts" onClick={() => setSplitting(splitting === i ? null : i)}>
                    ✂ Split…
                  </button>
                )}
                <button className="ghost" title="Not a kalam (a heading, an index…): leave it out" onClick={() => void edit(i, 'remove')}>
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ol>
        <footer className="verse-foot">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => void save()}>
            Save names
          </button>
        </footer>
      </aside>
    </div>
  );
}
