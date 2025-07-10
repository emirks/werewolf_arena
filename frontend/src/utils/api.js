/**
 * API utility functions for communicating with the FastAPI backend
 */

const API_URL = 'http://localhost:8000';

/**
 * Create a new room
 * @param {string} roomName - Name of the room to create
 * @param {string} creatorName - Name of the player creating the room
 * @returns {Promise<{room_id: string, room_name: string, creator: string}>} Room creation details
 */
export const createRoom = async (roomName, creatorName) => {
  try {
    const response = await fetch(`${API_URL}/create-room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        room_name: roomName, 
        creator_name: creatorName 
      })
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || 'Failed to create room');
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error creating room:', error);
    throw error;
  }
};

/**
 * Join a room using room ID and get LiveKit connection details
 * @param {string} roomId - ID of the room to join
 * @param {string} playerName - Name of the player joining
 * @returns {Promise<{url: string, token: string, room_name: string, room_id: string, players: string[]}>} LiveKit connection details
 */
export const joinRoom = async (roomId, playerName) => {
  try {
    const response = await fetch(`${API_URL}/join-room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        room_id: roomId, 
        player_name: playerName 
      })
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || 'Failed to join room');
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error joining room:', error);
    throw error;
  }
};

/**
 * Set player ready status in a room
 * @param {string} roomId - ID of the room
 * @param {string} playerName - Name of the player
 * @param {boolean} isReady - Ready status
 * @returns {Promise<Object>} Updated room status
 */
export const setReady = async (roomId, playerName, isReady) => {
  try {
    const response = await fetch(`${API_URL}/set-ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_id: roomId,
        player_name: playerName,
        is_ready: isReady
      })
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || 'Failed to set ready status');
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error setting ready status:', error);
    throw error;
  }
};

/**
 * Get current room status including players and ready states
 * @param {string} roomId - ID of the room
 * @returns {Promise<Object>} Room status
 */
export const getRoomStatus = async (roomId) => {
  try {
    const response = await fetch(`${API_URL}/room-status/${roomId}`);
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || 'Failed to get room status');
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error getting room status:', error);
    throw error;
  }
};

/**
 * Start a new game in the specified room
 * @param {string} roomId - ID of the room to start the game in
 * @param {string[]} playerNames - Names of all players in the room
 * @returns {Promise<Object>} Initial game state
 */
export const startGameSession = async (roomId, playerNames) => {
  try {
    const response = await fetch(`${API_URL}/start-game`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        room_id: roomId,
        player_names: playerNames
      })
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || 'Failed to start game');
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error starting game:', error);
    throw error;
  }
};