import { useState, useEffect } from 'react';
import { useLiveKit } from './hooks/useLiveKit';
import { GameRoom } from './components/GameRoom';
import { LiveKitRoom } from '@livekit/components-react';
import './App.css';

function App() {
  const [playerName, setPlayerName] = useState('');
  const [roomIdInput, setRoomIdInput] = useState('');
  const [customRoomName, setCustomRoomName] = useState('');
  const [gameStarted, setGameStarted] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [currentView, setCurrentView] = useState('home');
  const [isReady, setIsReady] = useState(false);
  
  const {
    room,
    roomId,
    roomName,
    isCreator,
    isConnecting,
    error: liveKitError,
    roomPlayers,
    allReady,
    createNewRoom,
    joinExistingRoom,
    setPlayerReady,
    startGame,
    toggleMute,
    disconnect
  } = useLiveKit(playerName);

  const handleCreateRoom = async (e) => {
    e.preventDefault();
    setError('');
    
    if (!playerName.trim()) {
      setError('Please enter your name');
      return;
    }
    
    try {
      setStatus('Creating room...');
      await createNewRoom(customRoomName || `${playerName}'s Game`);
      setCurrentView('waiting');
      setStatus('Room created! Share the Room ID with other players.');
    } catch (err) {
      console.error('Failed to create room:', err);
      setError(`Failed to create room: ${err.message}`);
      setStatus('');
    }
  };

  const handleJoinRoom = async (e) => {
    e.preventDefault();
    setError('');
    
    if (!playerName.trim()) {
      setError('Please enter your name');
      return;
    }
    
    if (!roomIdInput.trim()) {
      setError('Please enter a room ID');
      return;
    }
    
    try {
      setStatus('Joining room...');
      await joinExistingRoom(roomIdInput);
      setCurrentView('waiting');
      setStatus('Joined room successfully!');
    } catch (err) {
      console.error('Failed to join room:', err);
      setError(`Failed to join room: ${err.message}`);
      setStatus('');
    }
  };
  
  const handleToggleReady = async () => {
    try {
      const newReadyState = !isReady;
      await setPlayerReady(newReadyState);
      setIsReady(newReadyState);
    } catch (err) {
      console.error('Failed to set ready status:', err);
      setError(`Failed to set ready status: ${err.message}`);
    }
  };

  const handleStartGame = async () => {
    if (!isCreator || !allReady) return;
    
    try {
      setStatus('Starting game...');
      const gameData = await startGame();
      setGameStarted(true);
      setCurrentView('game');
      setStatus('Game started!');
    } catch (err) {
      console.error('Failed to start game:', err);
      setError(`Failed to start game: ${err.message}`);
      setStatus('');
    }
  };

  const handleBackToHome = () => {
    disconnect();
    setCurrentView('home');
    setGameStarted(false);
    setIsReady(false);
    setStatus('');
    setError('');
  };

  const copyRoomId = () => {
    navigator.clipboard.writeText(roomId);
    setStatus('Room ID copied to clipboard!');
    setTimeout(() => setStatus(''), 3000);
  };

  // Show game UI once connected and game is started
  if (currentView === 'game' && gameStarted && room) {
    return (
      <div className="app-container game-mode">
        <LiveKitRoom
          token={room.localParticipant.jwt}
          serverUrl={room.sid ? `wss://${room.sid.split('@')[1]}` : ''}
          connect={true}
          audio={true}
          video={false}
        >
          <GameRoom 
            roomName={roomName} 
            room={room}
            playerName={playerName}
            onLeave={handleBackToHome}
          />
        </LiveKitRoom>
      </div>
    );
  }
  
  // Show waiting room if connected but game not started
  if (currentView === 'waiting' && room) {
    return (
      <div className="app-container">
        <div className="setup-panel waiting-room">
          <div className="waiting-room-header">
            <h1>🐺 Werewolf Game</h1>
            <div className="room-info">
              <div className="room-id">
                <h3>Room ID: <span>{roomId}</span></h3>
                <button onClick={copyRoomId} className="btn-icon" aria-label="Copy room ID">
                  <svg viewBox="0 0 24 24" width="24" height="24">
                    <path fill="currentColor" d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>
                  </svg>
                </button>
              </div>
              <p>Share this Room ID with other players</p>
            </div>
          </div>

          <div className="players-section">
            <h3>Players ({Object.keys(roomPlayers).length})</h3>
            <div className="players-list">
              {Object.entries(roomPlayers).map(([name, info]) => (
                <div key={name} className={`player-card ${info.ready ? 'ready' : ''}`}>
                  <span className="player-name">{name} {name === playerName && '(You)'}</span>
                  <span className="player-status">{info.ready ? '✓ Ready' : 'Not Ready'}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="room-controls">
            <button 
              onClick={handleToggleReady}
              className={`btn ${isReady ? 'btn-success' : 'btn-secondary'}`}
            >
              {isReady ? '✓ Ready' : 'Mark as Ready'}
            </button>

            {isCreator && (
              <button 
                onClick={handleStartGame}
                disabled={!allReady || isConnecting}
                className="btn btn-primary"
              >
                {isConnecting ? 'Starting...' : 'Start Game'}
              </button>
            )}

            <button onClick={handleBackToHome} className="btn btn-outline">
              Leave Room
            </button>
          </div>

          {status && <div className="status-message success">{status}</div>}
          {error && <div className="status-message error">{error}</div>}
        </div>
      </div>
    );
  }
  
  // Show home screen for creating or joining rooms
  return (
    <div className="app-container">
      <div className="setup-panel home">
        <div className="home-header">
          <h1>🐺 Werewolf Game</h1>
          <p className="subtitle">Join the village and uncover the werewolves among us</p>
        </div>
        
        <div className="name-input-section">
          <div className="form-group">
            <label htmlFor="playerName">Your Name</label>
            <input
              id="playerName"
              type="text"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              placeholder="Enter your name"
              className="form-control"
              maxLength={20}
            />
          </div>
        </div>

        <div className="room-options">
          <div className="create-room-section">
            <h2>Create New Room</h2>
            <form onSubmit={handleCreateRoom}>
              <div className="form-group">
                <label htmlFor="customRoomName">Room Name (optional)</label>
                <input
                  id="customRoomName"
                  type="text"
                  value={customRoomName}
                  onChange={(e) => setCustomRoomName(e.target.value)}
                  placeholder="My Werewolf Game"
                  className="form-control"
                  maxLength={30}
                />
              </div>
              <button 
                type="submit" 
                className="btn btn-primary btn-large"
                disabled={isConnecting || !playerName.trim()}
              >
                {isConnecting ? 'Creating...' : 'Create Room'}
              </button>
            </form>
          </div>

          <div className="divider">
            <span>or</span>
          </div>

          <div className="join-room-section">
            <h2>Join Existing Room</h2>
            <form onSubmit={handleJoinRoom}>
              <div className="form-group">
                <label htmlFor="roomId">Room ID</label>
                <input
                  id="roomId"
                  type="text"
                  value={roomIdInput}
                  onChange={(e) => setRoomIdInput(e.target.value.toUpperCase())}
                  placeholder="Enter 6-character Room ID"
                  className="form-control"
                  maxLength={6}
                />
              </div>
              <button 
                type="submit" 
                className="btn btn-primary btn-large"
                disabled={isConnecting || !playerName.trim() || !roomIdInput.trim()}
              >
                {isConnecting ? 'Joining...' : 'Join Room'}
              </button>
            </form>
          </div>
        </div>
        
        {status && <div className="status-message success">{status}</div>}
        {error && <div className="status-message error">{error}</div>}
        {liveKitError && <div className="status-message error">{liveKitError}</div>}
      </div>
    </div>
  );
}

export default App;