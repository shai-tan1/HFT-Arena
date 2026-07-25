/**
 * Solo — practice drills and free play.
 *
 * Drills run on a FIXED seed, which is what makes the per-drill leaderboard
 * mean anything: everyone traded the same market, so the ranking is about
 * execution rather than who drew the friendly tape. Free play rerolls the seed,
 * because there the goal is reps, and a memorised price path is not reps.
 */

import { useEffect, useState } from 'react';
import { useMatch } from '@/state/match';
import { api, type DrillListItem, type ScenarioListItem } from '@/lib/api';
import { formatMoney } from '@shared/protocol';

const SKILL_LABEL: Record<string, string> = {
  fundamentals: 'Fundamentals',
  passive_execution: 'Passive execution',
  directional: 'Directional',
  risk: 'Risk',
  tape_reading: 'Tape reading',
};

export function Solo() {
  const startSolo = useMatch((s) => s.startSolo);
  const [drills, setDrills] = useState<DrillListItem[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioListItem[]>([]);
  const [tab, setTab] = useState<'drills' | 'free'>('drills');
  const [speed, setSpeed] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.drills(), api.scenarios()])
      .then(([d, s]) => { setDrills(d.drills); setScenarios(s.scenarios); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="page">
      <h1 className="page-title">Practice</h1>
      <p className="page-sub">
        No opponent, no rating. The same engine, the same fills, and a scenario
        built to punish one specific bad habit at a time.
      </p>

      <div className="tabs tabs-lg">
        <button className={tab === 'drills' ? 'tab on' : 'tab'} onClick={() => setTab('drills')}>
          Drills
        </button>
        <button className={tab === 'free' ? 'tab on' : 'tab'} onClick={() => setTab('free')}>
          Free play
        </button>
      </div>

      {loading && <p className="dim">Loading…</p>}

      {tab === 'drills' && (
        <div className="drill-grid">
          {drills.map((d) => (
            <div key={d.slug} className={`panel drill ${d.locked ? 'drill-locked' : ''}`}>
              <div className="panel-body">
                <div className="drill-top">
                  <span className="chip chip-violet">{SKILL_LABEL[d.skillTag] ?? d.skillTag}</span>
                  <span className="drill-diff" title={`Difficulty ${d.difficulty} of 10`}>
                    {'◆'.repeat(Math.ceil(d.difficulty / 2))}
                    <span className="faint">{'◆'.repeat(5 - Math.ceil(d.difficulty / 2))}</span>
                  </span>
                </div>

                <h3 className="drill-title">{d.title}</h3>
                <div className="drill-sub faint">{d.subtitle}</div>
                <p className="drill-desc dim">{d.description}</p>

                <div className="drill-objs">
                  {d.objectives.map((o) => (
                    <div key={o.id} className="drill-obj">
                      <span className="obj-dot" />{o.label}
                    </div>
                  ))}
                </div>

                <div className="drill-foot">
                  <Stars n={d.bestStars} />
                  <span className="faint">
                    {d.attempts > 0
                      ? `Best ${formatMoney(d.bestPnl ?? 0, { sign: (d.bestPnl ?? 0) > 0 })} · ${d.attempts} run${d.attempts === 1 ? '' : 's'}`
                      : 'Not attempted'}
                  </span>
                </div>

                <div className="drill-meta faint">
                  {Math.round(d.durationMs / 1000)}s · {d.scenarioLabel} · {d.xpReward} XP
                </div>

                <button
                  className="btn btn-primary btn-block"
                  disabled={d.locked}
                  onClick={() => startSolo({ drillSlug: d.slug })}
                >
                  {d.locked ? `Unlocks at level ${d.unlockLevel}` : d.attempts > 0 ? 'Run again' : 'Start drill'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'free' && (
        <>
          <div className="panel free-controls">
            <div className="panel-body row gap-16">
              <div className="stack gap-4">
                <span className="label">Speed</span>
                <div className="ticket-seg" style={{ width: 210 }}>
                  {[1, 2, 3].map((s) => (
                    <button key={s} className={speed === s ? 'seg on' : 'seg'} onClick={() => setSpeed(s)}>
                      {s}×
                    </button>
                  ))}
                </div>
              </div>
              <p className="faint" style={{ maxWidth: 460, margin: 0 }}>
                Faster clock, same market. Useful for grinding reps through a long
                scenario — and a fair warning that at 3× the tape moves faster
                than your hands will at first.
              </p>
            </div>
          </div>

          <div className="scenario-grid">
            {scenarios.map((s) => (
              <div key={s.id} className="panel scenario">
                <div className="panel-body">
                  <div className="drill-top">
                    <span className="chip">{s.instrument}</span>
                    <span className="drill-diff">
                      {'◆'.repeat(Math.ceil(s.difficulty / 2))}
                      <span className="faint">{'◆'.repeat(5 - Math.ceil(s.difficulty / 2))}</span>
                    </span>
                  </div>
                  <h3 className="drill-title">{s.label}</h3>
                  <div className="regime-timeline">
                    {s.timeline.map((seg, i) => (
                      <div
                        key={i}
                        className={`seg-block seg-${seg.regime}`}
                        style={{ flex: seg.durationMs }}
                        title={`${seg.regime} — ${Math.round(seg.durationMs / 1000)}s`}
                      >
                        <span>{seg.regime}</span>
                      </div>
                    ))}
                  </div>
                  <div className="drill-meta faint">
                    {Math.round(s.durationMs / 1000)}s · {s.agentCount} synthetic traders · random seed
                  </div>
                  <button
                    className="btn btn-block"
                    onClick={() => startSolo({ scenarioId: s.id, speed })}
                  >
                    Trade this
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Stars({ n }: { n: number }) {
  return (
    <span className="stars" title={`${n} of 3 stars`}>
      {[0, 1, 2].map((i) => (
        <span key={i} className={i < n ? 'star on' : 'star'}>★</span>
      ))}
    </span>
  );
}
