import { useState } from 'react';
import '../styles/GameUI.css';

/**
 * Player Grid Component for voting and target selection
 */
const PlayerGrid = ({ 
  players, 
  playerName, 
  onPlayerSelect, 
  selectedPlayer, 
  filterFn = () => true,
  showRole = false,
  title = "Select a player",
  disabled = false 
}) => {
  const selectablePlayers = players.filter(filterFn);
  
  return (
    <div className="player-grid">
      <h4 className="grid-title">{title}</h4>
      <div className="players-grid-container">
        {selectablePlayers.map((player) => {
          const playerId = player.id || player.name;
          const isSelected = selectedPlayer === playerId;
          const isSelf = playerId === playerName;
          
          return (
            <button
              key={playerId}
              className={`player-grid-item ${isSelected ? 'selected' : ''} ${isSelf ? 'self' : ''} ${!player.isAlive ? 'dead' : ''}`}
              onClick={() => !disabled && !isSelf && onPlayerSelect(playerId)}
              disabled={disabled || isSelf || !player.isAlive}
            >
              <div className="player-avatar">
                {player.isAlive ? '😊' : '💀'}
              </div>
              <div className="player-info">
                <div className="player-name">
                  {player.name || playerId}
                  {isSelf && ' (You)'}
                </div>
                {showRole && player.role && (
                  <div className="player-role">{player.role}</div>
                )}
                {!player.isAlive && (
                  <div className="player-status">Eliminated</div>
                )}
              </div>
              {isSelected && <div className="selection-indicator">✓</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
};

/**
 * Separate components for better modularity
 */
const DebateStatus = ({ debate, playerName }) => {
  const { current_speaker, current_turn, turns_left, max_turns } = debate;
  
  return (
    <div className="debate-status">
      <div className="debate-header">
        <h3>💬 Debate Phase</h3>
      </div>
      <div className="turn-info">
        <div className="turn-counter">
          <span className="turn-number">Turn {current_turn || 0}/{max_turns || 8}</span>
          <span className="turns-remaining">{turns_left || 0} turns remaining</span>
        </div>
        <div className="progress-bar">
          <div 
            className="progress-fill" 
            style={{ width: `${((current_turn || 0) / (max_turns || 8)) * 100}%` }}
          ></div>
        </div>
      </div>
      
      {current_speaker && (
        <div className="current-speaker">
          {current_speaker === playerName ? (
            <span className="you-speaking">🎤 You are speaking</span>
          ) : (
            <span className="other-speaking">🎤 {current_speaker} is speaking</span>
          )}
        </div>
      )}
    </div>
  );
};

const SpeakingPrompt = ({ interaction, playerName }) => {
  const { can_speak, speaking_prompt } = interaction;
  
  if (!can_speak) return null;
  
  return (
    <div className="speaking-prompt">
      <div className="pulse-animation"></div>
      <div className="speaking-message">
        <h3>🎤 You can speak now!</h3>
        <p>{speaking_prompt || 'Share your thoughts with the village'}</p>
        <small>Speak into your microphone</small>
      </div>
    </div>
  );
};

const VotingInterface = ({ voting, players, playerName, onVote }) => {
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  
  if (!voting.active) return null;
  
  const hasVoted = voting.voted_player !== null;
  
  const handlePlayerSelect = (playerId) => {
    if (!hasVoted) {
      setSelectedPlayer(playerId);
    }
  };
  
  const handleVoteConfirm = () => {
    if (selectedPlayer && !hasVoted) {
      onVote(selectedPlayer);
    }
  };
  
  const filterPlayers = (player) => {
    const playerId = player.id || player.name;
    return player.isAlive && playerId !== playerName;
  };
  
  return (
    <div className="voting-interface">
      <div className="voting-header">
        <h3>🗳️ Voting Phase</h3>
        <p>Select a player to eliminate from the game</p>
        {hasVoted && (
          <div className="vote-status">
            ✅ You voted for <strong>{voting.voted_player}</strong>
          </div>
        )}
      </div>
      
      <PlayerGrid
        players={players}
        playerName={playerName}
        onPlayerSelect={handlePlayerSelect}
        selectedPlayer={selectedPlayer}
        filterFn={filterPlayers}
        title="Who do you want to eliminate?"
        disabled={hasVoted}
      />
      
      {selectedPlayer && !hasVoted && (
        <div className="vote-actions">
          <button 
            className="confirm-vote-button"
            onClick={handleVoteConfirm}
          >
            Vote to eliminate {selectedPlayer}
          </button>
          <button 
            className="cancel-vote-button"
            onClick={() => setSelectedPlayer(null)}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};

const VotingResults = ({ voting, players }) => {
  if (!voting.results) return null;
  
  const voteCount = {};
  const votes = voting.results.vote_counts || voting.results;
  
  Object.entries(votes).forEach(([voter, target]) => {
    voteCount[target] = (voteCount[target] || 0) + 1;
  });
  
  return (
    <div className="voting-results">
      <h4>📊 Voting Results</h4>
      <div className="vote-counts">
        {Object.entries(voteCount)
          .sort(([,a], [,b]) => b - a)
          .map(([player, count]) => (
            <div key={player} className="vote-count">
              <span className="player-name">{player}</span>
              <span className="count">{count} vote{count !== 1 ? 's' : ''}</span>
            </div>
          ))}
      </div>
      {voting.results.most_voted && (
        <div className="vote-result">
          <strong>{voting.results.most_voted}</strong> received the most votes
        </div>
      )}
    </div>
  );
};

const TargetSelection = ({ targetSelection, players, playerName, onTargetSelection }) => {
  const [selectedTarget, setSelectedTarget] = useState(null);
  
  if (!targetSelection.active) return null;
  
  const handleTargetSelect = (playerId) => {
    setSelectedTarget(playerId);
  };
  
  const handleTargetConfirm = () => {
    if (selectedTarget) {
      onTargetSelection(selectedTarget);
      setSelectedTarget(null);
    }
  };
  
  const filterPlayers = (player) => {
    const playerId = player.id || player.name;
    return targetSelection.options?.includes(playerId) || targetSelection.options?.includes(player.name);
  };
  
  return (
    <div className="target-selection">
      <div className="target-header">
        <h3>{getActionIcon(targetSelection.action)} {targetSelection.prompt}</h3>
      </div>
      
      <PlayerGrid
        players={players}
        playerName={playerName}
        onPlayerSelect={handleTargetSelect}
        selectedPlayer={selectedTarget}
        filterFn={filterPlayers}
        title={`Choose target for ${targetSelection.action}`}
      />
      
      {selectedTarget && (
        <div className="target-actions">
          <button 
            className="confirm-target-button"
            onClick={handleTargetConfirm}
          >
            {getActionText(targetSelection.action)} {selectedTarget}
          </button>
          <button 
            className="cancel-target-button"
            onClick={() => setSelectedTarget(null)}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};

const getActionIcon = (action) => {
  switch (action) {
    case 'eliminate': return '🔪';
    case 'investigate': return '🔍';
    case 'protect': return '🛡️';
    default: return '👆';
  }
};

const getActionText = (action) => {
  switch (action) {
    case 'eliminate': return 'Eliminate';
    case 'investigate': return 'Investigate';
    case 'protect': return 'Protect';
    default: return 'Select';
  }
};

const PhaseUI = ({ phase, players, currentPlayer, gameState }) => {
  switch (phase) {
    case 'lobby':
      return (
        <div className="phase-ui">
          <h3>🏠 Waiting for game to start...</h3>
          <div className="player-list">
            <h4>Players in lobby ({players.length}):</h4>
            <div className="lobby-players">
              {players.map((player) => (
                <div key={player.id || player.name} className="lobby-player">
                  <span className="player-name">
                    {player.name || player.id}
                  </span>
                  {(player.id === currentPlayer?.id || player.name === currentPlayer?.name) && (
                    <span className="host-indicator">👑</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      );

    case 'day':
      return (
        <div className="phase-ui">
          <h3>☀️ Day Phase</h3>
          <p>Discuss and debate to find the werewolves</p>
        </div>
      );

    case 'voting':
      return (
        <div className="phase-ui">
          <h3>🗳️ Voting Phase</h3>
          <p>Time to vote! Select who you believe is a werewolf</p>
        </div>
      );

    case 'night':
      const isWerewolf = currentPlayer?.role === 'Werewolf';
      const isSeer = currentPlayer?.role === 'Seer';
      const isDoctor = currentPlayer?.role === 'Doctor';

      return (
        <div className="phase-ui">
          <h3>🌙 Night Phase</h3>
          {isWerewolf && <p>🐺 Choose your target for elimination</p>}
          {isSeer && <p>🔍 Choose someone to investigate</p>}
          {isDoctor && <p>🛡️ Choose someone to protect</p>}
          {!isWerewolf && !isSeer && !isDoctor && <p>💤 Sleep tight, villager</p>}
        </div>
      );

    case 'end':
      return (
        <div className="phase-ui">
          <h3>🎯 Game Over</h3>
          <p>The {gameState.winner} win!</p>
          <div className="player-roles">
            <h4>Final Roles:</h4>
            <div className="final-players">
              {players.map((player) => (
                <div key={player.id || player.name} className="final-player">
                  <span className="player-name">{player.name || player.id}</span>
                  <span className="player-role">{player.role}</span>
                  {!player.isAlive && <span className="death-indicator">💀</span>}
                </div>
              ))}
            </div>
          </div>
          <button
            className="action-button"
            onClick={() => window.location.reload()}
          >
            🔄 Play Again
          </button>
        </div>
      );

    default:
      return null;
  }
};

const GameLog = ({ logs }) => (
  <div className="game-log">
    <h4>📋 Game Log</h4>
    <div className="log-entries">
      {logs?.slice(-5).map((log, index) => (
        <div key={index} className="log-entry">
          {log}
        </div>
      ))}
    </div>
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
    targetSelection = {},
    interaction = {},
    logs = []
  } = gameState;

  return (
    <div className="game-ui">
      <div className="game-info">
        <div className="phase-badge">{phase.toUpperCase()}</div>
        <div className="round-info">Round {gameState.round || 1}</div>
      </div>

      {/* Show debate status during day phase */}
      {phase === 'day' && (
        <DebateStatus debate={debate} playerName={playerName} />
      )}

      {/* Show speaking prompt when user can speak */}
      <SpeakingPrompt interaction={interaction} playerName={playerName} />

      {/* Show target selection for night actions */}
      <TargetSelection 
        targetSelection={targetSelection}
        players={players}
        playerName={playerName}
        onTargetSelection={onTargetSelection} 
      />

      {/* Show voting interface during voting */}
      {(phase === 'voting' || voting.active) && (
        <VotingInterface 
          voting={voting}
          players={players}
          playerName={playerName}
          onVote={onVote}
        />
      )}

      {/* Show voting results */}
      <VotingResults voting={voting} players={players} />

      {/* Phase-specific UI */}
      <PhaseUI 
        phase={phase}
        players={players}
        currentPlayer={currentPlayer}
        gameState={gameState}
      />

      {/* Game log */}
      <GameLog logs={logs} />
    </div>
  );
};
