/**
 * Play — matchmaking and private lobbies.
 *
 * Two ways in, and they are deliberately different products:
 *   - Ranked queue: the ladder. Fresh seed every match so it cannot be
 *     memorised, mid-difficulty scenario pool so variance does not swamp skill.
 *   - Private lobby: a six-character code you read out loud to a friend. No
 *     rating at stake, and the host picks the scenario.
 */

import { useEffect, useState } from 'react';
import { useMatch } from '@/state/match';
import { useSession } from '@/state/session';
import { api, type ScenarioListItem } from '@/lib/api';

export function Play() {
  const { phase, queue, lobby } = useMatch();
  const joinQueue = useMatch((s) => s.joinQueue);
  const leaveQueue = useMatch((s) => s.leaveQueue);
  const createLobby = useMatch((s) => s.createLobby);
  const joinLobby = useMatch((s) => s.joinLobby);
  const leaveLobby = useMatch((s) => s.leaveLobby);
  const setReady = useMatch((s) => s.setReady);
  const user = useSession((s) => s.user);

  const [code, setCode] = useState('');
  const [scenarios, setScenarios] = useState<ScenarioListItem[]>([]);
  const [lobbyScenario, setLobbyScenario] = useState(2);
  const [lobbyMinutes, setLobbyMinutes] = useState(3);
  const [ready, setReadyLocal] = useState(false);

  useEffect(() => {
    api.scenarios().then((r) => setScenarios(r.scenarios)).catch(() => {});
  }, []);

  if (phase === 'queued') {
    const waited = queue ? Math.floor(queue.waitedMs / 1000) : 0;
    return (
      <div className="page narrow">
        <div className="panel searching">
          <div className="radar"><span /><span /><span /></div>
          <h2>Searching for an opponent</h2>
          <p className="dim">
            {queue
              ? `Rating band ±${queue.bandWidth} · ${queue.playersSearching} searching`
              : 'Joining the queue…'}
          </p>
          <div className="num searching-timer">{waited}s</div>
          <p className="faint searching-note">
            The band widens 25 points every second. Your rating is {user?.elo ?? '—'}.
          </p>
          <button className="btn" onClick={leaveQueue}>Cancel</button>
        </div>
      </div>
    );
  }

  if (phase === 'lobby' && lobby) {
    const everyoneReady = lobby.members.length === 2 && lobby.members.every((m) => m.ready);
    return (
      <div className="page narrow">
        <div className="panel">
          <div className="panel-head"><span>Private lobby</span></div>
          <div className="panel-body stack gap-16">
            <div className="lobby-code">
              <span className="label">Room code</span>
              <div className="code num">{lobby.code}</div>
              <button
                className="btn btn-sm"
                onClick={() => navigator.clipboard?.writeText(lobby.code)}
              >Copy</button>
            </div>

            <div className="lobby-meta">
              <span className="chip chip-violet">{lobby.scenarioLabel}</span>
              <span className="chip">{Math.round(lobby.durationMs / 60000)} min</span>
            </div>

            <div className="stack gap-8">
              {lobby.members.map((m) => (
                <div key={m.handle} className="lobby-member">
                  <span className="lm-name">
                    {m.handle} {m.isHost && <span className="chip chip-gold">HOST</span>}
                  </span>
                  <span className="chip chip-cyan">{m.elo}</span>
                  <span className={m.ready ? 'chip chip-bid' : 'chip'}>
                    {m.ready ? 'READY' : 'WAITING'}
                  </span>
                </div>
              ))}
              {lobby.members.length < 2 && (
                <div className="lobby-member lobby-empty">
                  <span className="dim pulsing">Waiting for a second player…</span>
                </div>
              )}
            </div>

            <div className="row gap-8">
              <button
                className={ready ? 'btn btn-block' : 'btn btn-primary btn-block'}
                onClick={() => { setReadyLocal(!ready); setReady(!ready); }}
              >
                {ready ? 'Not ready' : 'Ready up'}
              </button>
              <button className="btn btn-block" onClick={leaveLobby}>Leave</button>
            </div>
            {everyoneReady && <p className="dim">Both ready — starting…</p>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <h1 className="page-title">Arena</h1>
      <p className="page-sub">
        Same market, same seed, same clock. The only difference is what you do with it.
      </p>

      <div className="mode-grid">
        <div className="panel mode-card mode-ranked">
          <div className="panel-body">
            <span className="chip chip-cyan">Ranked</span>
            <h2>Ladder match</h2>
            <p className="dim">
              Five minutes, mid-difficulty scenario pool, fresh seed. Your rating
              moves. Provisional players move faster — the K-factor decays over
              your first twenty matches so you reach your real rating quickly.
            </p>
            <ul className="mode-facts">
              <li>5 minutes</li>
              <li>Rating at stake</li>
              <li>Rerolled seed every match</li>
            </ul>
            <button className="btn btn-primary btn-block btn-lg" onClick={() => joinQueue('ranked_pvp')}>
              Find ranked match
            </button>
          </div>
        </div>

        <div className="panel mode-card">
          <div className="panel-body">
            <span className="chip chip-violet">Casual</span>
            <h2>Unranked match</h2>
            <p className="dim">
              Three minutes against whoever is queueing. Nothing at stake, same
              engine, same fills. The place to try a strategy you have not
              earned confidence in yet.
            </p>
            <ul className="mode-facts">
              <li>3 minutes</li>
              <li>No rating change</li>
              <li>Same matching rules</li>
            </ul>
            <button className="btn btn-block btn-lg" onClick={() => joinQueue('casual_pvp')}>
              Find casual match
            </button>
          </div>
        </div>

        <div className="panel mode-card">
          <div className="panel-body">
            <span className="chip chip-gold">Private</span>
            <h2>Play a friend</h2>
            <p className="dim">
              Create a room and send them the code, or paste theirs. You pick the
              scenario and the clock.
            </p>

            <div className="stack gap-8 lobby-form">
              <label className="label">Scenario</label>
              <select value={lobbyScenario} onChange={(e) => setLobbyScenario(Number(e.target.value))}>
                {scenarios.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label} — difficulty {s.difficulty}/10
                  </option>
                ))}
              </select>

              <label className="label">Match length</label>
              <select value={lobbyMinutes} onChange={(e) => setLobbyMinutes(Number(e.target.value))}>
                {[1, 2, 3, 5, 10].map((m) => (
                  <option key={m} value={m}>{m} minute{m === 1 ? '' : 's'}</option>
                ))}
              </select>

              <button
                className="btn btn-primary btn-block"
                onClick={() => createLobby(lobbyMinutes * 60_000, lobbyScenario)}
              >
                Create room
              </button>

              <div className="divider" />

              <label className="label">Join with a code</label>
              <div className="row gap-8">
                <input
                  value={code}
                  maxLength={6}
                  placeholder="ABC123"
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && joinLobby(code)}
                />
                <button
                  className="btn"
                  disabled={code.length !== 6}
                  onClick={() => joinLobby(code)}
                >Join</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
