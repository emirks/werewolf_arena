import { useState, useEffect, useCallback } from 'react';
import { Room, Track } from 'livekit-client';
import { createRoom, joinRoom, setReady, getRoomStatus, startGameSession } from '../utils/api';

export const useLiveKit = (playerName) => {
  const [room, setRoom] = useState(null);
  const [roomId, setRoomId] = useState('');
  const [roomName, setRoomName] = useState('');
  const [isCreator, setIsCreator] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [audioTracks, setAudioTracks] = useState(new Map());
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState(null);
  const [isMuted, setIsMuted] = useState(false);
  const [roomPlayers, setRoomPlayers] = useState({});
  const [allReady, setAllReady] = useState(false);

  // Create a new room
  const createNewRoom = useCallback(async (customRoomName) => {
    if (!playerName || isConnecting) return;

    setIsConnecting(true);
    setError(null);

    try {
      // Create room on backend
      const roomData = await createRoom(customRoomName, playerName);
      
      setRoomId(roomData.room_id);
      setRoomName(roomData.room_name);
      setIsCreator(true);
      
      // Connect to LiveKit room
      await connectToRoom(roomData.room_id, playerName);
      
      return roomData;
    } catch (err) {
      console.error('Error creating room:', err);
      setError(err.message || 'Failed to create room');
      throw err;
    } finally {
      setIsConnecting(false);
    }
  }, [playerName, isConnecting]);

  // Join an existing room
  const joinExistingRoom = useCallback(async (targetRoomId) => {
    if (!playerName || isConnecting) return;

    setIsConnecting(true);
    setError(null);

    try {
      await connectToRoom(targetRoomId, playerName);
      return { room_id: targetRoomId };
    } catch (err) {
      console.error('Error joining room:', err);
      setError(err.message || 'Failed to join room');
      throw err;
    } finally {
      setIsConnecting(false);
    }
  }, [playerName, isConnecting]);

  // Connect to LiveKit room
  const connectToRoom = useCallback(async (targetRoomId, targetPlayerName) => {
    try {
      // Join the room and get LiveKit connection details
      const connectionData = await joinRoom(targetRoomId, targetPlayerName);
      
      setRoomId(connectionData.room_id);
      setRoomName(connectionData.room_name);
      setIsCreator(connectionData.creator === targetPlayerName);
      
      // Create a new LiveKit room
      const newRoom = new Room({
        autoSubscribe: true,
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // Set up event listeners before connecting
      newRoom
        .on('participantConnected', handleParticipantConnected)
        .on('participantDisconnected', handleParticipantDisconnected)
        .on('trackSubscribed', handleTrackSubscribed)
        .on('trackUnsubscribed', handleTrackUnsubscribed)
        .on('disconnected', handleDisconnected)
        .on('reconnecting', () => console.log('Reconnecting to room...'))
        .on('reconnected', () => console.log('Reconnected to room'))
        .on('localTrackPublished', handleLocalTrackPublished)
        .on('localTrackUnpublished', handleLocalTrackUnpublished);

      // Connect to the LiveKit server
      await newRoom.connect(connectionData.url, connectionData.token, {
        autoSubscribe: true,
      });

      // Publish local audio track
      await newRoom.localParticipant.setMicrophoneEnabled(true);
      
      setRoom(newRoom);
      setParticipants(Array.from(newRoom.remoteParticipants.values()));
      
      return newRoom;
    } catch (err) {
      console.error('Error connecting to LiveKit:', err);
      throw err;
    }
  }, []);

  // Set ready status
  const setPlayerReady = useCallback(async (isReady) => {
    if (!roomId || !playerName) return;
    
    try {
      await setReady(roomId, playerName, isReady);
      await updateRoomStatus();
    } catch (error) {
      console.error('Error setting ready status:', error);
      throw error;
    }
  }, [roomId, playerName]);

  // Update room status
  const updateRoomStatus = useCallback(async () => {
    if (!roomId) return;
    
    try {
      const status = await getRoomStatus(roomId);
      setRoomPlayers(status.players);
      setAllReady(status.all_ready);
    } catch (error) {
      console.error('Error updating room status:', error);
    }
  }, [roomId]);

  // Start the game
  const startGame = useCallback(async () => {
    if (!roomId || !isCreator) return;
    
    try {
      const playerNames = Object.keys(roomPlayers);
      const gameState = await startGameSession(roomId, playerNames);
      return gameState;
    } catch (error) {
      console.error('Error starting game:', error);
      throw error;
    }
  }, [roomId, isCreator, roomPlayers]);

  // Disconnect from the room
  const disconnect = useCallback(async () => {
    if (!room) return;
    
    try {
      await room.disconnect();
    } catch (err) {
      console.error('Error disconnecting from room:', err);
    } finally {
      setRoom(null);
      setRoomId('');
      setRoomName('');
      setIsCreator(false);
      setParticipants([]);
      setAudioTracks(new Map());
      setRoomPlayers({});
      setAllReady(false);
    }
  }, [room]);

  // Toggle mute state
  const toggleMute = useCallback(async () => {
    if (!room) return;
    
    try {
      if (isMuted) {
        await room.localParticipant.setMicrophoneEnabled(true);
      } else {
        await room.localParticipant.setMicrophoneEnabled(false);
      }
      setIsMuted(!isMuted);
    } catch (err) {
      console.error('Error toggling mute:', err);
    }
  }, [room, isMuted]);

  // Event handlers
  const handleParticipantConnected = useCallback((participant) => {
    setParticipants((prev) => [...prev, participant]);
  }, []);

  const handleParticipantDisconnected = useCallback((participant) => {
    setParticipants((prev) => prev.filter((p) => p.sid !== participant.sid));
    
    setAudioTracks((prev) => {
      const newTracks = new Map(prev);
      newTracks.delete(participant.sid);
      return newTracks;
    });
  }, []);  

  const handleTrackSubscribed = useCallback((track, publication, participant) => {
    if (track.kind === Track.Kind.Audio) {
      setAudioTracks((prev) => {
        const newTracks = new Map(prev);
        const participantTracks = newTracks.get(participant.sid) || [];
        
        if (!participantTracks.includes(track)) {
          newTracks.set(participant.sid, [...participantTracks, track]);
        }
        
        return newTracks;
      });
    }
  }, []);

  const handleTrackUnsubscribed = useCallback((track, publication, participant) => {
    if (track.kind === Track.Kind.Audio) {
      setAudioTracks((prev) => {
        const newTracks = new Map(prev);
        const participantTracks = newTracks.get(participant.sid) || [];
        
        newTracks.set(
          participant.sid,
          participantTracks.filter((t) => t.sid !== track.sid)
        );
        
        return newTracks;
      });
    }
  }, []);

  const handleLocalTrackPublished = useCallback((publication) => {
    console.log('Local track published:', publication.kind);
  }, []);

  const handleLocalTrackUnpublished = useCallback((publication) => {
    console.log('Local track unpublished:', publication.kind);
  }, []);

  const handleDisconnected = useCallback(() => {
    console.log('Disconnected from room');
    setRoom(null);
    setParticipants([]);
    setAudioTracks(new Map());
  }, []);

  // Poll for room status updates
  useEffect(() => {
    if (!roomId) return;

    const interval = setInterval(updateRoomStatus, 2000); // Poll every 2 seconds
    return () => clearInterval(interval);
  }, [roomId, updateRoomStatus]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (room) {
        room.disconnect().catch(console.error);
      }
    };
  }, [room]);

  return {
    room,
    roomId,
    roomName,
    isCreator,
    participants,
    audioTracks,
    isConnecting,
    error,
    isMuted,
    roomPlayers,
    allReady,
    createNewRoom,
    joinExistingRoom,
    setPlayerReady,
    updateRoomStatus,
    disconnect,
    startGame,
    toggleMute,
  };
};