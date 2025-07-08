/**
 * API utility functions for communicating with the FastAPI backend
 */

/**
 * Join a room and get LiveKit connection details
 * @param {string} playerName - Name of the player joining
 * @returns {Promise<{url: string, token: string, room_name: string}>} LiveKit connection details
 */
export const joinRoom = async (playerName) => {
  try {
    const response = await fetch('/join-room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player_name: playerName })
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || 'Failed to join room');
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error joining room:', error);
    throw error;
  }
};

/**
 * Start a new game in the specified room
 * @param {string} roomName - Name of the room to start the game in
 * @param {string} playerName - Name of the player starting the game
 * @param {string} playerRole - Role of the player
 * @returns {Promise<Object>} Initial game state
 */
export const startGameSession = async (roomName, playerName, playerRole) => {
  try {
    console.log('Starting game session...');
    console.log('Room name:', roomName);
    console.log('Player name:', playerName);
    console.log('Player role:', playerRole);
    const response = await fetch('/start-game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_name: roomName,
        player_name: playerName,
        player_role: playerRole
      })
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || 'Failed to start game');
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error starting game:', error);
    throw error;
  }
};