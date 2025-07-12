import { useState, useEffect } from 'react';
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
      <h3>Discussion Phase</h3>
      
      {current_speaker && (
        <div className="current-speaker">
          <span className="speaker-label">Now Speaking</span>
          <span className={`speaker-name ${current_speaker === playerName ? 'you' : ''}`}>
            {current_speaker === playerName ? 'You' : current_speaker}
          </span>
        </div>
      )}
      
      <div className="progress-bar-container">
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${progress}%` }}></div>
        </div>
        <div className="turn-info">
          <span>Turn {current_turn || 0}/{max_turns || 8}</span>
          <span>{turns_left || 0} left</span>
        </div>
      </div>
    </div>
  );
};

const VotingModal = ({ isOpen, onClose, players, playerName, onVote, currentVotes }) => {
  if (!isOpen) return null;
  
  const alivePlayers = players.filter(p => p.isAlive && p.name !== playerName);
  
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <h2 className="modal-title">Cast Your Vote</h2>
        <div className="voting-grid">
          {alivePlayers.map(player => (
            <button
              key={player.id || player.name}
              className={`vote-button ${currentVotes[player.name] ? 'has-votes' : ''}`}
              onClick={() => onVote(player.name)}
            >
              <div className="player-info">
                <span className="player-name">{player.name}</span>
                {currentVotes[player.name] && (
                  <span className="vote-count">Votes: {currentVotes[player.name]}</span>
                )}
              </div>
              <div className="vote-progress" style={{
                width: `${(currentVotes[player.name] || 0) / Object.keys(players).length * 100}%`
              }} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

const TargetSelectionModal = ({ isOpen, onClose, players, playerName, onSelect, actionType }) => {
  if (!isOpen) return null;

  const getActionTitle = () => {
    switch (actionType) {
      case 'kill': return 'Select Player to Kill';
      case 'protect': return 'Select Player to Protect';
      case 'investigate': return 'Select Player to Investigate';
      default: return 'Select Target';
    }
  };

  const getActionIcon = () => {
    switch (actionType) {
      case 'kill': return '🐺';
      case 'protect': return '🛡️';
      case 'investigate': return '🔍';
      default: return '👆';
    }
  };

  const alivePlayers = players.filter(p => p.isAlive && p.name !== playerName);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <h2 className="modal-title">{getActionTitle()}</h2>
        <div className="target-selection-grid">
          {alivePlayers.map(player => (
            <button
              key={player.id || player.name}
              className={`target-button ${actionType}`}
              onClick={() => onSelect(player.name)}
            >
              <span className="action-icon">{getActionIcon()}</span>
              <span className="player-name">{player.name}</span>
            </button>
          ))}
        </div>
      </div>
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

const GameEvent = ({ type, message, round }) => {
  const getEventIcon = () => {
    switch (type) {
      case 'kill':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 2C13.1 2 14 2.9 14 4V5H10V4C10 2.9 10.9 2 12 2ZM19 7H5C3.9 7 3 7.9 3 9V20C3 21.1 3.9 22 5 22H19C20.1 22 21 21.1 21 20V9C21 7.9 20.1 7 19 7ZM19 20H5V9H19V20Z" fill="#e74c3c"/></svg>
        );
      case 'vote':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41 0.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" fill="#3498db"/></svg>
        );
      case 'protect':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 2L4 5v6c0 5.55 3.84 10.74 8 12 4.16-1.26 8-6.45 8-12V5l-8-3z" fill="#4ade80"/></svg>
        );
      case 'investigate':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="8" stroke="#fde047" strokeWidth="2" fill="none"/><line x1="21" y1="21" x2="16.65" y2="16.65" stroke="#fde047" strokeWidth="2"/></svg>
        );
      case 'start':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#8a2be2"/><polygon points="10,8 16,12 10,16" fill="#fff"/></svg>
        );
      case 'end':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#fde047"/><rect x="8" y="8" width="8" height="8" fill="#fff"/></svg>
        );
      default:
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#a0a0c0"/></svg>
        );
    }
  };

  return (
    <div className={`game-event ${type}`}>
      <div className="event-icon">{getEventIcon()}</div>
      <div className="event-content">
        <div className="event-message">{message}</div>
        <div className="event-timestamp">Round {round}</div>
      </div>
    </div>
  );
};

const GameAnnouncements = ({ announcements }) => (
  <div className="game-log">
    <h3>Game Announcements</h3>
    <div className="log-entries">
      {announcements?.slice(-5).map((announcement, index) => {
        const type = announcement.type;
        let message = "";
        if (type === "vote") {
          message = announcement.target ? `${announcement.target} was voted out of the game.` : "No one was voted out of the game.";
        } else if (type === "kill") {
          message = announcement.target ? `${announcement.target} was killed during the night.` : "No one was killed during the night.";
        } else if (type === "protect") {
          message = announcement.target ? `${announcement.target} was protected during the night.` : "No one was protected during the night.";
        } else if (type === "investigate") {
          message = announcement.target ? `${announcement.target} was investigated during the night.` : "No one was investigated during the night.";
        } else if (type === "phase") {
          message = announcement.target ? `${announcement.target} was ${announcement.type} during the night.` : `No one was ${announcement.type} during the night.`;
        }
        return (
          <GameEvent
            key={index} 
            type={type}
            message={message}
            round={announcement.round}
          />
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
    interaction = {},
    announcements = []
  } = gameState;

  const [showVoting, setShowVoting] = useState(false);
  const [showTargetSelection, setShowTargetSelection] = useState(false);
  const [targetAction, setTargetAction] = useState(null);

  useEffect(() => {
    setShowVoting(voting.active);
  }, [voting.active]);

  useEffect(() => {
    if (phase === 'night') {
      switch (currentPlayer.role) {
        case 'Werewolf':
          setTargetAction('kill');
          setShowTargetSelection(true);
          break;
        case 'Doctor':
          setTargetAction('protect');
          setShowTargetSelection(true);
          break;
        case 'Seer':
          setTargetAction('investigate');
          setShowTargetSelection(true);
          break;
        default:
          setTargetAction(null);
          setShowTargetSelection(false);
      }
    } else {
      setTargetAction(null);
      setShowTargetSelection(false);
    }
  }, [phase, currentPlayer.role]);

  const handleVote = (playerId) => {
    onVote(playerId);
    setShowVoting(false);
  };

  const handleTargetSelect = (playerId) => {
    onTargetSelection(playerId);
    setShowTargetSelection(false);
  };

  return (
    <div className="game-ui">
      <GameStatusHeader gameState={gameState} />
      
      <div className="game-ui-content">
        {/* <div className="main-panel">
          <PhaseInfo phase={phase} currentPlayer={currentPlayer} />
        </div> */}
        
        <div className="side-panel">
          <div className="sidebar-top-row">
            {phase === 'day' && (
              <DebateStatus debate={debate} playerName={playerName} />
            )}
            <SpeakingPrompt interaction={interaction} />
          </div>
          <GameAnnouncements announcements={announcements} />
        </div>

        <VotingModal
          isOpen={showVoting}
          onClose={() => setShowVoting(false)}
          players={players}
          playerName={playerName}
          onVote={handleVote}
          currentVotes={voting.votes || {}}
        />

        <TargetSelectionModal
          isOpen={showTargetSelection}
          onClose={() => setShowTargetSelection(false)}
          players={players}
          playerName={playerName}
          onSelect={handleTargetSelect}
          actionType={targetAction}
        />
      </div>
    </div>
  );
};
