import { useState } from 'react';
import '../styles/GameUI.css';

export const GameUI = ({ 
  gameState, 
  onVote, 
  onAction, 
  playerName, 
  currentTurn, 
  maxTurns, 
  canSpeak, 
  isVoting, 
  onVoteSubmit, 
  votedPlayer 
}) => {
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const { 
    phase, 
    players = [], 
    currentPlayer = {},
    currentSpeaker,
    voting = {}
  } = gameState;
  
  // Calculate remaining turns if maxTurns is provided in props or gameState
  const remainingTurns = (gameState.maxTurns || maxTurns || 5) - (currentTurn || 1) + 1;
  
  const handlePlayerSelect = (playerId) => {
    setSelectedPlayer(playerId === selectedPlayer ? null : playerId);
  };

  const handleVote = () => {
    if (selectedPlayer) {
      onVote(selectedPlayer);
      setSelectedPlayer(null);
    }
  };

  const handleAction = (action) => {
    if (selectedPlayer) {
      onAction(action, selectedPlayer);
      setSelectedPlayer(null);
    }
  };

  const renderPhaseUI = () => {
    switch (phase) {
      case 'lobby':
        return (
          <div className="phase-ui">
            <h3>Waiting for game to start...</h3>
            <div className="player-list">
              <h4>Players in lobby:</h4>
              <ul>
                {players.map((player) => (
                  <li key={player.id}>
                    {player.name} {player.id === currentPlayer?.id && '👑'}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        );
      
      case 'day':
        return (
          <div className="phase-ui">
            <h3>Day Phase</h3>
            <p>Discuss and vote to eliminate a player</p>
            
            <div className="player-selection">
              {players.map((player) => (
                <button
                  key={player.id}
                  className={`player-button ${selectedPlayer === player.id ? 'selected' : ''}`}
                  onClick={() => handlePlayerSelect(player.id)}
                  disabled={player.id === playerName} // Can't select self
                >
                  {player.name}
                  {player.isAlive ? '' : ' (Dead)'}
                </button>
              ))}
            </div>
            
            <button 
              className="action-button"
              onClick={handleVote}
              disabled={!selectedPlayer}
            >
              Vote to Eliminate
            </button>
          </div>
        );
      
      case 'night':
        const isWerewolf = currentPlayer?.role === 'werewolf';
        const isSeer = currentPlayer?.role === 'seer';
        
        return (
          <div className="phase-ui">
            <h3>Night Phase</h3>
            <p>Werewolves, choose your target. Villagers, close your eyes.</p>
            
            {currentPlayer?.isAlive ? (
              <>
                <div className="player-selection">
                  {players
                    .filter(player => 
                      (isWerewolf && player.role !== 'werewolf' && player.isAlive) ||
                      (isSeer && player.isAlive)
                    )
                    .map((player) => (
                      <button
                        key={player.id}
                        className={`player-button ${selectedPlayer === player.id ? 'selected' : ''}`}
                        onClick={() => handlePlayerSelect(player.id)}
                      >
                        {isSeer ? '🔍 ' : ''}
                        {player.name}
                      </button>
                    ))}
                </div>
                
                <button 
                  className="action-button"
                  onClick={() => handleAction(isSeer ? 'inspect' : 'kill')}
                  disabled={!selectedPlayer}
                >
                  {isSeer ? 'Inspect Player' : 'Select Target'}
                </button>
              </>
            ) : (
              <p>You are dead. Wait for the next game.</p>
            )}
          </div>
        );
      
      case 'end':
        return (
          <div className="phase-ui">
            <h3>Game Over</h3>
            <p>The {gameState.winningTeam} win!</p>
            <div className="player-roles">
              <h4>Player Roles:</h4>
              <ul>
                {players.map((player) => (
                  <li key={player.id}>
                    {player.name}: {player.role}
                  </li>
                ))}
              </ul>
            </div>
            <button 
              className="action-button"
              onClick={() => window.location.reload()}
            >
              Play Again
            </button>
          </div>
        );
      
      default:
        return null;
    }
  };

  return (
    <div className="game-ui">
      <div className="game-info">
        <div className="phase-badge">{phase.toUpperCase()}</div>
        
        {/* Show turn information for day phase */}
        {phase === 'day' && (
          <div className="turn-info">
            <div className="turn-counter">
              Turn: {currentTurn || 1}/{gameState.maxTurns || maxTurns || 5} • 
              {remainingTurns} turn{remainingTurns !== 1 ? 's' : ''} remaining
            </div>
            
            {/* Show current speaker */}
            {currentSpeaker && (
              <div className="current-speaker">
                {currentSpeaker === playerName ? (
                  <span className="you-speaking">Your turn to speak</span>
                ) : (
                  <span>{currentSpeaker} is speaking...</span>
                )}
              </div>
            )}
          </div>
        )}
        
        {/* Show voting status */}
        {voting.isActive && (
          <div className="voting-status">
            Voting in progress... {Object.keys(voting.votes || {}).length}/{players.filter(p => p.isAlive).length} votes
          </div>
        )}
      </div>

      {canSpeak && (
        <div className="speaking-prompt">
          <div className="pulse-animation"></div>
          <div className="speaking-message">
            <h3>You can speak now!</h3>
            <p>Share your thoughts with the village</p>
          </div>
        </div>
      )}

      {renderPhaseUI()}

      {isVoting && (
        <div className="vote-results">
          <h3>Voting in Progress</h3>
          <div className="voting-grid">
            {players.filter(p => p.isAlive).map(player => (
              <div key={player.id} className="vote-slot">
                <div className="player-vote">
                  {votedPlayer === player.id ? '✅' : '⬜'}
                </div>
                <div className="player-name">{player.name}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="game-log">
        <h4>Game Log</h4>
        <div className="log-entries">
          {gameState.logs?.map((log, index) => (
            <div key={index} className="log-entry">
              {log}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
