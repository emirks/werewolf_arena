import { useState, useEffect } from 'react';
import { useLiveKit } from './hooks/useLiveKit';
import { GameRoom } from './components/GameRoom';
import { LiveKitRoom } from '@livekit/components-react';
import './App.css';

function App() {
  const [playerName, setPlayerName] = useState('');
  const [playerRole, setPlayerRole] = useState('villager');
  const [gameStarted, setGameStarted] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  
  const {
    room,
    roomName,
    isConnecting,
    error: liveKitError,
    connect,
    startGame
  } = useLiveKit('', playerName);

  const handleJoin = async (e) => {
    e.preventDefault();
    setError('');
    
    if (!playerName.trim()) {
      setError('Please enter your name');
      return;
    }
    
    try {
      setStatus('Connecting to room...');
      await connect();
      setStatus('Connected to room');
    } catch (err) {
      console.error('Failed to join room:', err);
      setError(`Failed to join room: ${err.message}`);
      setStatus('');
    }
  };
  
  const handleStartGame = async () => {
    if (!room) return;
    
    try {
      setStatus('Starting game...');
      await startGame(roomName, playerName, playerRole);
      setGameStarted(true);
      setStatus('Game started!');
    } catch (err) {
      console.error('Failed to start game:', err);
      setError(`Failed to start game: ${err.message}`);
      setStatus('');
    }
  };

  // Show game UI once connected and game is started
  if (gameStarted && room) {
    return (
      <div className="app-container">
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
            playerRole={playerRole}
          />
        </LiveKitRoom>
      </div>
    );
  }
  
  // Show start game button if connected but game not started
  if (room) {
    return (
      <div className="app-container">
        <div className="setup-panel">
          <h1>🐺 Werewolf Game</h1>
          <div className="game-info">
            <p>Connected to room: <strong>{roomName}</strong></p>
            <p>Your name: <strong>{playerName}</strong></p>
            <div className="form-group">
              <label htmlFor="playerRole">Your Role:</label>
              <select 
                id="playerRole"
                value={playerRole}
                onChange={(e) => setPlayerRole(e.target.value)}
                className="form-control"
              >
                <option value="villager">Villager</option>
                <option value="werewolf">Werewolf</option>
                <option value="seer">Seer</option>
              </select>
            </div>
          </div>
          
          <button 
            onClick={handleStartGame}
            disabled={isConnecting}
            className="btn btn-primary"
          >
            {isConnecting ? 'Starting...' : 'Start Game'}
          </button>
          
          {status && <p className="status">{status}</p>}
          {error && <p className="error">{error}</p>}
        </div>
      </div>
    );
  }
  
  // Show join form if not connected
  return (
    <div className="app-container">
      <div className="setup-panel">
        <h1>🐺 Werewolf Game</h1>
        <form onSubmit={handleJoin}>
          <div className="form-group">
            <label htmlFor="playerName">Your Name:</label>
            <input
              id="playerName"
              type="text"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              required
              placeholder="Enter your name"
              className="form-control"
            />
          </div>
          
          <button 
            type="submit" 
            className="btn btn-primary"
            disabled={isConnecting}
          >
            {isConnecting ? 'Joining...' : 'Join Room'}
          </button>
          
          {status && <p className="status">{status}</p>}
          {error && <p className="error">{error}</p>}
          {liveKitError && <p className="error">{liveKitError}</p>}
        </form>
      </div>
    </div>
  );
}

export default App;
