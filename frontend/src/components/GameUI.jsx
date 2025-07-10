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
              <div className="player-status-indicator">
                <div className={`status-dot ${player.isAlive ? 'alive' : 'dead'}`}></div>
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
              {isSelected && <div className="selection-check">✓</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
};

/**
 * Game Status Header
 */
const GameStatusHeader = ({ gameState, playerName }) => {
  const { phase, round, currentPlayer } = gameState;
  
  return (
    <div className="game-status-header">
      <div className="status-item">
        <span className="status-label">Round</span>
        <span className="status-value">{round || 1}</span>
      </div>
      <div className="status-item">
        <span className="status-label">Phase</span>
        <span className={`status-value phase-${phase}`}>{phase.charAt(0).toUpperCase() + phase.slice(1)}</span>
      </div>
      <div className="status-item">
        <span className="status-label">Role</span>
        <span className="status-value">{currentPlayer.role}</span>
      </div>
    </div>
  );
};

/**
 * Debate Status Component
 */
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
      
      <div className="progress-container">
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${progress}%` }}></div>
        </div>
      </div>
      
      {current_speaker && (
        <div className="current-speaker">
          <span className="speaker-label">Speaking:</span>
          <span className={`speaker-name ${current_speaker === playerName ? 'you' : 'other'}`}>
            {current_speaker === playerName ? 'You' : current_speaker}
          </span>
        </div>
      )}
    </div>
  );
};

/**
 * Speaking Prompt
 */
const SpeakingPrompt = ({ interaction }) => {
  const { can_speak, speaking_prompt } = interaction;
  
  if (!can_speak) return null;
  
  return (
    <div className="speaking-prompt">
      <div className="prompt-content">
        <div className="mic-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2c1.1 0 2 .9 2 2v6c0 1.1-.9 2-2 2s-2-.9-2-2V4c0-1.1.9-2 2-2zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H6c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
          </svg>
        </div>
        <div className="prompt-text">
          <h4>You can speak now</h4>
          <p>{speaking_prompt || 'Share your thoughts with the village'}</p>
        </div>
      </div>
    </div>
  );
};

/**
 * Voting Interface
 */
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
      <div className="interface-header">
        <h3>Elimination Vote</h3>
        <p>Select a player to eliminate from the game</p>
        {hasVoted && (
          <div className="vote-status success">
            Vote submitted for <strong>{voting.voted_player}</strong>
          </div>
        )}
      </div>
      
      <PlayerGrid
        players={players}
        playerName={playerName}
        onPlayerSelect={handlePlayerSelect}
        selectedPlayer={selectedPlayer}
        filterFn={filterPlayers}
        title="Who should be eliminated?"
        disabled={hasVoted}
      />
      
      {selectedPlayer && !hasVoted && (
        <div className="action-buttons">
          <button className="btn-primary" onClick={handleVoteConfirm}>
            Vote to eliminate {selectedPlayer}
          </button>
          <button className="btn-secondary" onClick={() => setSelectedPlayer(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * Target Selection for Night Actions
 */
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
  
  const getActionIcon = (action) => {
    switch (action) {
      case 'eliminate':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M9 3V4H4V6H5V19C5 20.1 5.9 21 7 21H17C18.1 21 19 20.1 19 19V6H20V4H15V3H9M7 6H17V19H7V6M9 8V17H11V8H9M13 8V17H15V8H13Z"/>
          </svg>
        );
      case 'investigate':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z"/>
          </svg>
        );
      case 'protect':
        return (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5L12,1M12,7C13.4,7 14.8,8.6 14.8,10V11H15.5C16.4,11 17,11.4 17,12V16C17,16.6 16.6,17 16,17H8C7.4,17 7,16.6 7,16V12C7,11.4 7.4,11 8,11H8.5V10C8.5,8.6 9.6,7 12,7M12,8.2C10.2,8.2 9.8,9.2 9.8,10V11H14.2V10C14.2,9.2 13.8,8.2 12,8.2Z"/>
          </svg>
        );
      default:
        return null;
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
  
  return (
    <div className="target-selection">
      <div className="interface-header">
        <div className="action-title">
          {getActionIcon(targetSelection.action)}
          <h3>{targetSelection.prompt}</h3>
        </div>
      </div>
      
      <PlayerGrid
        players={players}
        playerName={playerName}
        onPlayerSelect={handleTargetSelect}
        selectedPlayer={selectedTarget}
        filterFn={filterPlayers}
        title={`Choose target to ${targetSelection.action}`}
      />
      
      {selectedTarget && (
        <div className="action-buttons">
          <button className="btn-primary" onClick={handleTargetConfirm}>
            {getActionText(targetSelection.action)} {selectedTarget}
          </button>
          <button className="btn-secondary" onClick={() => setSelectedTarget(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * Game Log
 */
const GameLog = ({ logs }) => (
  <div className="game-log">
    <h4>Game Events</h4>
    <div className="log-entries">
      {logs?.slice(-5).map((log, index) => (
        <div key={index} className="log-entry">
          {log}
        </div>
      ))}
    </div>
  </div>
);

/**
 * Players List
 */
const PlayersList = ({ players, currentPlayer }) => (
  <div className="players-list">
    <h4>Players ({players.filter(p => p.isAlive).length} alive)</h4>
    <div className="players-container">
      {players.map((player) => (
        <div key={player.id || player.name} className={`player-item ${!player.isAlive ? 'eliminated' : ''}`}>
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

/**
 * Main Game UI Component
 */
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
      <div className="game-main">
        <div className="left-panel">
          <GameStatusHeader gameState={gameState} playerName={playerName} />
          
          {/* Show debate status during day phase */}
          {phase === 'day' && (
            <DebateStatus debate={debate} playerName={playerName} />
          )}
          
          {/* Show speaking prompt when user can speak */}
          <SpeakingPrompt interaction={interaction} />
          
          <PlayersList players={players} currentPlayer={currentPlayer} />
        </div>

        <div className="center-panel">
          {/* Show voting interface during voting */}
          {(phase === 'voting' || voting.active) && (
            <VotingInterface 
              voting={voting}
              players={players}
              playerName={playerName}
              onVote={onVote}
            />
          )}

          {/* Show target selection for night actions */}
          <TargetSelection 
            targetSelection={targetSelection}
            players={players}
            playerName={playerName}
            onTargetSelection={onTargetSelection} 
          />

          {/* Show phase information when no active interactions */}
          {!voting.active && !targetSelection.active && !interaction.can_speak && (
            <div className="phase-info">
              <div className="phase-content">
                {phase === 'lobby' && (
                  <>
                    <h3>Waiting for Game to Start</h3>
                    <p>All players are joining the game...</p>
                  </>
                )}
                {phase === 'day' && (
                  <>
                    <h3>Day Phase</h3>
                    <p>Players are discussing and debating to find the werewolves</p>
                  </>
                )}
                {phase === 'night' && (
                  <>
                    <h3>Night Phase</h3>
                    {currentPlayer.role === 'Werewolf' && <p>Choose your target for elimination</p>}
                    {currentPlayer.role === 'Seer' && <p>Choose someone to investigate</p>}
                    {currentPlayer.role === 'Doctor' && <p>Choose someone to protect</p>}
                    {!['Werewolf', 'Seer', 'Doctor'].includes(currentPlayer.role) && <p>The village sleeps while special roles take action</p>}
                  </>
                )}
                {phase === 'voting' && (
                  <>
                    <h3>Voting Phase</h3>
                    <p>Time to decide who should be eliminated</p>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="right-panel">
          <GameLog logs={logs} />
        </div>
      </div>
    </div>
  );
};
