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

const GameLog = ({ logs }) => (
  <div className="game-log">
    <h3>Game Events</h3>
    <div className="log-entries">
      {logs?.slice(-5).map((log, index) => (
        <div key={index} className="log-entry">
          {log}
        </div>
      ))}
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
    logs = []
  } = gameState;

  return (
    <div className="game-ui">
      <GameStatusHeader gameState={gameState} />
      
      <div className="game-ui-content">
        <PlayersList players={players} currentPlayer={currentPlayer} />
        
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
