import { useState } from 'react';
import '../styles/GameUI.css';

const GameStatusHeader = ({ gameState }) => {
  const { phase, round, currentPlayer } = gameState;
  
  return (
    <div className="game-status">
      <div className="status-item">
        <span className="status-label">Round</span>
        <span className="status-value">{round || 1}</span>
      </div>
      <div className="status-item">
        <span className="status-label">Phase</span>
        <span className={`status-value phase-${phase}`}>{phase.charAt(0).toUpperCase() + phase.slice(1)}</span>
      </div>
    </div>
  );
};

const DebateStatus = ({ debate, playerName }) => {
  const { current_speaker, current_turn, turns_left, max_turns } = debate;
  const progress = ((current_turn || 0) / (max_turns || 8)) * 100;
  
  return (
    <div className="debate-status">
      <div className="debate-info">
        <h3>Discussion Phase</h3>
        <div className="turn-info">
          <span>Turn {current_turn || 0} of {max_turns || 8}</span>
          <span className="turns-remaining">{turns_left || 0} remaining</span>
        </div>
      </div>
      
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${progress}%` }}></div>
      </div>
      
      {current_speaker && (
        <div className="current-speaker">
          <span className="speaker-label">Speaking:</span>
          <span className={`speaker-name ${current_speaker === playerName ? 'you' : ''}`}>
            {current_speaker === playerName ? 'You' : current_speaker}
          </span>
        </div>
      )}
    </div>
  );
};

const PlayersList = ({ players, currentPlayer }) => (
  <div className="players-list">
    <h3>Players ({players.filter(p => p.isAlive).length} alive)</h3>
    <div className="players-grid">
      {players.map((player) => (
        <div 
          key={player.id || player.name} 
          className={`player-item ${!player.isAlive ? 'eliminated' : ''} ${(player.id === currentPlayer?.id || player.name === currentPlayer?.name) ? 'self' : ''}`}
        >
          <div className={`status-dot ${player.isAlive ? 'alive' : 'dead'}`}></div>
          <span className="player-name">
            {player.name || player.id}
            {(player.id === currentPlayer?.id || player.name === currentPlayer?.name) && ' (You)'}
          </span>
          {!player.isAlive && <span className="eliminated-tag">Eliminated</span>}
        </div>
      ))}
    </div>
  </div>
);

const VotingInterface = ({ voting, players, playerName, onVote }) => {
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  
  if (!voting.active) return null;
  
  const hasVoted = voting.voted_player !== null;
  const alivePlayers = players.filter(p => p.isAlive && p.name !== playerName);
  
  return (
    <div className="voting-interface">
      <div className="section-header">
        <h3>Elimination Vote</h3>
        <p>Select a player to eliminate</p>
      </div>
      
      {hasVoted ? (
        <div className="vote-confirmation">
          <div className="vote-status">
            <span className="check-icon">✓</span>
            <span>Vote submitted for <strong>{voting.voted_player}</strong></span>
          </div>
        </div>
      ) : (
        <div className="voting-grid">
          {alivePlayers.map(player => (
            <button
              key={player.id || player.name}
              className={`vote-button ${selectedPlayer === (player.id || player.name) ? 'selected' : ''}`}
              onClick={() => {
                setSelectedPlayer(player.id || player.name);
                onVote(player.id || player.name);
              }}
            >
              <span className="player-name">{player.name || player.id}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const SpeakingPrompt = ({ interaction }) => {
  if (!interaction?.can_speak) return null;

  return (
    <div className="speaking-prompt">
      <div className="mic-icon">
        <div className="pulse-ring"></div>
        <svg viewBox="0 0 24 24" width="24" height="24">
          <path fill="currentColor" d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5z"/>
          <path fill="currentColor" d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
        </svg>
      </div>
      <div className="prompt-content">
        <h3>You can speak now!</h3>
        <p>{interaction.speaking_prompt || 'Share your thoughts with the village'}</p>
      </div>
    </div>
  );
};

const GameLog = ({ logs }) => (
  <div className="game-log">
    <h3>Game Events</h3>
    <div className="log-entries">
      {logs?.slice(-5).map((log, index) => {
        const isAction = log.includes('killed') || log.includes('eliminated') || log.includes('protected');
        const isAnnouncement = log.includes('Phase') || log.includes('Round');
        const isVote = log.includes('voted');
        
        return (
          <div 
            key={index} 
            className={`log-entry ${isAction ? 'action' : ''} ${isAnnouncement ? 'announcement' : ''} ${isVote ? 'vote' : ''}`}
          >
            <span className="log-time">{new Date().toLocaleTimeString()}</span>
            <span className="log-text">{log}</span>
          </div>
        );
      })}
    </div>
  </div>
);

const PhaseInfo = ({ phase, currentPlayer }) => (
  <div className="phase-info">
    {phase === 'lobby' && (
      <div className="phase-content waiting">
        <h3>Waiting for Game to Start</h3>
        <p>All players are joining the game...</p>
      </div>
    )}
    {phase === 'day' && (
      <div className="phase-content day">
        <h3>Day Phase</h3>
        <p>Players are discussing to find the werewolves</p>
      </div>
    )}
    {phase === 'night' && (
      <div className="phase-content night">
        <h3>Night Phase</h3>
        {currentPlayer.role === 'Werewolf' && <p>Choose your target for elimination</p>}
        {currentPlayer.role === 'Seer' && <p>Choose someone to investigate</p>}
        {currentPlayer.role === 'Doctor' && <p>Choose someone to protect</p>}
        {!['Werewolf', 'Seer', 'Doctor'].includes(currentPlayer.role) && (
          <p>The village sleeps while special roles take action</p>
        )}
      </div>
    )}
  </div>
);

export const GameUI = ({
  gameState,
  onVote,
  onTargetSelection,
  playerName,
  sendMessage
}) => {
  const {
    phase,
    players = [],
    currentPlayer = {},
    debate = {},
    voting = {},
    logs = [],
    interaction = {}
  } = gameState;

  return (
    <div className="game-ui">
      <GameStatusHeader gameState={gameState} />
      
      <div className="game-ui-content">
        <PlayersList players={players} currentPlayer={currentPlayer} />
        
        {/* Show speaking prompt at the top when active */}
        <SpeakingPrompt interaction={interaction} />
        
        {phase === 'day' && (
          <DebateStatus debate={debate} playerName={playerName} />
        )}
        
        {(phase === 'voting' || voting.active) && (
          <VotingInterface 
            voting={voting}
            players={players}
            playerName={playerName}
            onVote={onVote}
          />
        )}
        
        {!voting.active && phase !== 'day' && (
          <PhaseInfo phase={phase} currentPlayer={currentPlayer} />
        )}
        
        <GameLog logs={logs} />
      </div>
    </div>
  );
};
